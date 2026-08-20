# Storage backends (S3 / Vercel Blob / filesystem)

## Summary
Tracks `dashboard/server/storage.ts` — the single storage abstraction behind every
upload in the app (`storagePut` / `storageGet` / `storageDelete`, plus the new
`storagePresignPut`). Documents the backend precedence (S3 → Vercel Blob → local
`uploads/`), the env vars each backend needs, the key-vs-URL contract, and what
does **not** happen automatically when the backend changes (existing files are
never migrated).

## Key files
- `dashboard/server/storage.ts` — the abstraction; the ONLY reader of
  `BLOB_READ_WRITE_TOKEN` / `AWS_*` in the repo
- `dashboard/.env.example` — `# === Storage ===` block
- `dashboard/scripts/verify-s3-storage.ts` — E2E check **through** `server/storage.ts`
  (put → anonymous GET → existence probe → anonymous LIST must 403 → presigned PUT →
  delete by URL → delete by key). Run from the dashboard root:
  `./node_modules/.bin/tsx scripts/verify-s3-storage.ts`
- `dashboard/scripts/provision-s3-bucket.ps1` — idempotent infra-as-code for the bucket,
  the IAM uploader, the public-read policy, CORS and lifecycle; ends by printing the env block
- `dashboard/server/_core/api-entry.ts` L34-79 — `POST /api/upload` (multipart) and
  `GET /api/file/<key>`, which 302-redirects to whatever absolute URL `storageGet`
  returns and falls back to serving from disk when the URL is relative/empty
- `dashboard/server/_core/index.ts` L60-95 — the Railway twin of the two routes above
- `api/index.js` — committed esbuild bundle, **stale by design**: `vercel.json`
  `buildCommand` runs `pnpm run build:api` on every deploy, so the tracked file
  exists only for Vercel's serverless detection. Never hand-edit it.

## Contract (unchanged across backends)
- `storagePut(relKey, data, contentType) → { key, url }` — `key` is always the raw
  relative key (leading slashes stripped), `url` is what gets written to the DB.
- `storageGet(relKey) → { key, url }` — **empty `url` means "não existe"**; callers
  (`/api/file/...`) rely on that to fall through to the local disk / 404.
- `storageDelete(keyOrUrl)` — best-effort, **never throws**, warns with
  `[storage] delete falhou: …`.
- `storagePresignPut(relKey, contentType, expiresSeconds = 60) → { key, uploadUrl, url, expiresIn }`
  — **S3-only, throws** when S3 isn't configured. No route wired to it yet.

## Backend precedence
1. **S3** when all four of `AWS_S3_REGION`, `AWS_S3_BUCKET_NAME`, `AWS_S3_ACCESS_KEY`,
   `AWS_S3_SECRET_ACCESS_KEY` are set (partial config = treated as unset). The two
   credential vars fall back to the unprefixed `AWS_ACCESS_KEY` /
   `AWS_SECRET_ACCESS_KEY` — see the env-name rule below.
2. **Vercel Blob** when `BLOB_READ_WRITE_TOKEN` is set.
3. **Local `./uploads`** in dev; hard error on Vercel (`process.env.VERCEL`).

## Env names — RULE
The dashboard's S3 **credentials carry an `AWS_S3_` prefix**
(`AWS_S3_ACCESS_KEY` / `AWS_S3_SECRET_ACCESS_KEY`) because **Vercel reserves the
unprefixed `AWS_ACCESS_KEY` / `AWS_SECRET_ACCESS_KEY` names**. `readS3Env()` resolves
each credential as `AWS_S3_* || AWS_*`, and the four-vars gate runs on the RESOLVED
values, so a machine still using the old names keeps working. Error strings and docs
name only the new primaries.
⚠️ **This divergence is dashboard-only.** `multipark/` and `be-multipark/` keep the
unprefixed convention on purpose — do not "harmonize" them.

## S3 specifics (bucket `dashboard-multipark-bucket`, `eu-west-1`)
- The IAM uploader has only `s3:PutObject/GetObject/DeleteObject` on `<bucket>/*` —
  **never call ListObjects**. `storageGet` uses `HeadObject` (allowed by
  `s3:GetObject`) purely as an existence probe.
- Objects are publicly readable, so the URL is *built*, not fetched:
  `S3_PUBLIC_BASE_URL` if set, else `https://<bucket>.s3.<region>.amazonaws.com`.
  Each key segment is percent-encoded for the URL; the DB key stays raw.
- `s3NormalizeKey` accepts a public URL or a bare key (strips protocol/host/leading
  slash, then `decodeURIComponent` with a fallback for keys containing a literal `%`).
  It deliberately does **not** strip a leading `uploads/` — in S3 that is a real
  folder (`POST /api/upload` writes `uploads/<ts>-<rand>.<ext>`), unlike the local
  backend where `uploads/` is the disk root.
- The AWS SDK is loaded via **dynamic `import()`** inside the S3 branches only, so
  with the AWS envs unset the SDK is never even parsed (no cold-start cost, and
  behaviour is byte-for-byte the previous one). `S3Client` is cached per
  region+access-key.

## storageDelete call sites (migration surface)
Only **two**, both in `dashboard/server/routers.ts`, both in the *expenses* router,
both passing `invoiceImageKey || invoiceImageUrl` (key preferred, absolute URL as
fallback):
- L1606-1607 `expenses.update` — deletes the previous invoice when a new one is sent
- L1632-1633 `expenses.delete` — deletes the invoice with the expense
⚠️ When the fallback fires on a row whose file lives in **Vercel Blob** while S3 is
active, the delete resolves the blob URL's pathname into an S3 key and no-ops: the
blob object leaks. Harmless but real — a cross-backend GC would have to key off the
URL host, not the configured backend.
Everything else (documents, photos, PDFs, inbound e-mail attachments, generated
images) only ever calls `storagePut` and leaves orphans behind on delete — that is
pre-existing behaviour, not something this change introduced.

## Related
- `memory/profile-photo-upload.md` — the biggest `storagePut` consumer; documents the
  ~4.5 MB Vercel body cap that motivates the presigned-PUT groundwork, and the
  still-open server-side mime/size guard debt
- `memory/reference.md` — index

## Changelog

### 2026-08-20 (b) — Bucket live + rename `AWS_ACCESS_KEY` → `AWS_S3_ACCESS_KEY`
**Type**: fix (env contract) + decision
**Scope**: `server/storage.ts`, `.env`, `.env.example`, `scripts/verify-s3-storage.ts`,
`scripts/provision-s3-bucket.ps1`, `PROJECT.md` (no migration, NOT committed/deployed)
**What**:
- Credentials are now read as `AWS_S3_ACCESS_KEY || AWS_ACCESS_KEY` and
  `AWS_S3_SECRET_ACCESS_KEY || AWS_SECRET_ACCESS_KEY`; the "all four present" gate
  operates on the resolved values, so a half-renamed environment either works fully or
  is cleanly "unconfigured" — never half-configured.
- Renamed the two keys in `.env` (values untouched), `.env.example`, the provision
  script's final echo block, and the verify script's `required` list (the script demands
  the NEW names on purpose — it asserts the production-shaped config).
- `PROJECT.md` swept too: its "AWS S3" row and env sample still advertised a **third,
  entirely dead** naming (`AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_S3_BUCKET`,
  leftovers from the original Barni project — no code ever read them). Replaced with the
  real four names rather than blind-renamed; a naive sed would have produced
  `AWS_S3_ACCESS_KEY_ID`.
**Why**: Jorge renamed the var in Vercel, which reserves the unprefixed `AWS_*` names.
Only the access key was named explicitly, so the secret gets the same
new-primary/legacy-fallback treatment — we don't know which name it has in Vercel and
either one now works.
**Notes**:
- `./node_modules/.bin/tsc --noEmit` → 0 errors.
- `./node_modules/.bin/tsx scripts/verify-s3-storage.ts` → **ALL CHECKS PASSED** (9/9)
  against the live bucket with the renamed `.env`, which also proves the new names are
  the ones actually being read.
- Legacy fallback separately exercised with an ad-hoc script (old names only → S3 still
  engages, real PUT+GET round-trip passed; no credentials at all → `isPresignedUploadAvailable()`
  is `false`).
- `api/index.js` deliberately NOT rebuilt (stale-by-design build artifact).

### 2026-08-20 — Backend S3 no storage.ts (+ presigned PUT)
**Type**: feature
**Scope**: `dashboard/server/storage.ts`, `dashboard/.env.example` (no migration, no
call-site change, NOT committed/deployed)
**What**:
- Added an S3 backend in front of the existing precedence chain, fully env-gated:
  `storagePut` → `PutObjectCommand` with the content type, `storageGet` → `HeadObject`
  probe + built public URL, `storageDelete` → `DeleteObjectCommand` on a normalized key.
- New `storagePresignPut(relKey, contentType, expiresSeconds = 60)` returning
  `{ key, uploadUrl, url, expiresIn }` (expiry clamped to 1…3600 s), plus
  `isPresignedUploadAvailable()`. Groundwork for browser-direct video uploads — **no
  route consumes it yet**.
- `.env.example`: `# === Storage ===` block rewritten with the precedence, the four
  `AWS_*` vars, the optional `S3_PUBLIC_BASE_URL`, and the CORS/PUT requirement. The
  old line claiming "as envs AWS_* … estão MORTAS" is gone — it is now false.
**Why**: videos and documents don't fit Vercel Blob's economics or the ~4.5 MB
serverless body cap; a dedicated bucket + presigned PUT is the only path for large
files. Env names mirror the `multipark` app so one credential set covers both.
**Notes**:
- Verified with `./node_modules/.bin/tsc --noEmit` in `dashboard/` — 0 errors
  project-wide. (`npx tsc` picks up an OLD global TypeScript here — always the local
  binary.)
- **Not migrated**: files already in Vercel Blob stay there and keep working (their
  absolute URLs are in the DB). Setting the AWS envs only changes where *new* uploads
  go. Do not remove `BLOB_READ_WRITE_TOKEN` from the deploy.
- The presigned PUT requires the browser to send the **same** `Content-Type` that was
  signed, or AWS answers 403; the bucket CORS must allow `PUT` from the app origin.
- Bucket CORS/IAM/policy are provisioned outside this repo (by Jorge).
