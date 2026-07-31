# Foto de perfil do colaborador (captura + upload)

## Summary
Tracks how a collaborator's own profile photo gets captured and uploaded: the
`ProfilePhotoPrompt` dialog (shown on login to anyone linked to an employee
without `photoUrl`), the `CameraCapture` selfie component used by the clock-in
flow, and the `rh.uploadMyPhoto` / `rh.uploadPhoto` tRPC mutations behind them.
The profile photo is **obligatory to clock in** — the server enforces it, the
dialog only nudges.

## Key files
- `dashboard/client/src/components/ProfilePhotoPrompt.tsx` — the onboarding dialog
- `dashboard/client/src/components/CameraCapture.tsx` — selfie widget for ponto entrada/saída
- `dashboard/server/routers.ts` — `rh.uploadPhoto` (~L2186, admin, any employee) and
  `rh.uploadMyPhoto` (~L2200, self-service)
- `dashboard/server/storage.ts` — `storagePut`: Vercel Blob when `BLOB_READ_WRITE_TOKEN`
  is set, otherwise local `uploads/`

## Upload contract / limits (measured, not guessed)
- Input is `{ fileBase64: string, mimeType: string }` — **zod validates neither the
  mime nor the size**. The backend does `mimeType.split("/")[1] ?? "jpg"` to build the
  storage key extension, so a junk mime silently becomes a junk file extension
  (`image/svg+xml` → `photo-….svg+xml`). **The client is the only guard.**
- `express.json({ limit: "50mb" })` on both entrypoints
  (`server/_core/index.ts` L53, `server/_core/api-entry.ts` L21) — but the Vercel
  deploy routes `/api/*` to the serverless function `api/index.js` (`vercel.json`),
  which has a hard **~4.5 MB request-body cap**. That, not the 50mb, is the real ceiling.
- RULE: anything uploaded through these mutations must be re-encoded client-side to a
  known mime and kept well under ~4 MB **base64** (≈3 MB raw).

## Related
- `memory/reference.md` — index

## Changelog

### 2026-07-31 — Upload de foto do computador no ProfilePhotoPrompt
**Type**: feature (+ fix)
**Scope**: `dashboard/client/src/components/ProfilePhotoPrompt.tsx` (FE only, no BE change,
no migration)
**What**:
- Added a hidden `<input type="file" accept="image/*">` + "Carregar do computador"
  outline button, shown **both** while the camera preview is live and when the camera
  failed/is unavailable — the previous dead end (camera denied → only "Mais tarde") is gone.
- Selected file is validated client-side (`image/*` only, `image/svg+xml` rejected —
  no reliable intrinsic size and pointless as a profile photo; 15 MB pre-decode cap) and
  then **re-encoded to JPEG** on a canvas at max 1280 px / q 0.85, plus a post-encode
  guard at 4 MB of base64 against the serverless body cap.
- `preview` state became `{ dataUrl, mimeType }` so `confirm()` sends the mime that was
  actually encoded instead of a hardcoded literal; both the camera and the file path feed
  the same state, so Repetir / "Usar esta foto" are unchanged. "Repetir" still returns to
  the camera view (the `[open, preview]` effect restarts `getUserMedia`).
- File input `value` is cleared right after reading the file, so re-picking the same file
  fires `change` again.
- New `cameraFailed` state → placeholder card instead of a black `<video>`; new
  `processingFile` state → spinner on the upload button and buttons disabled while decoding.
**Fixes folded in** (pre-existing bugs found while editing):
- The unmount cleanup `useEffect(() => () => stopCamera(), [])` closed over the **initial**
  `stream` (always `null`), so the camera was never released on unmount. `stopCamera` now
  reads a `streamRef` and is a stable `useCallback`.
- `open` flipping to `false` from the parent (without going through the dialog's own
  `onOpenChange`) left the camera running; the effect now stops it.
- `capture()` guarded against `videoWidth === 0` (would produce a 0×0 canvas).
- Closing the dialog mid-upload is now blocked (`Mais tarde` + overlay dismiss disabled
  while `upload.isPending`).
**Why**: collaborators on desktop have no usable webcam or deny the permission, and the
dialog offered no other path to satisfy an obligation that blocks clock-in.
**Notes**:
- Verified with `./node_modules/.bin/tsc --noEmit` — 0 errors project-wide.
  (`npx tsc` resolves an OLD global TypeScript here and reports 4 bogus tsconfig errors —
  always use the local binary.)
- HEIC/HEIF from iPhone: browsers that can't decode it hit `img.onerror` and get
  "Formato de imagem não suportado. Tenta JPG ou PNG." — acceptable, no polyfill added.
- **Tech debt flagged, NOT fixed**: `CameraCapture.tsx` declares `fileRef` and renders the
  hidden `<input type="file" capture="user">`, and its camera-failure message literally
  says `Usa "Escolher foto"` — but **no button ever calls `fileRef.current?.click()`**.
  On a PDA without a working `getUserMedia` the clock-in selfie is a hard dead end. Same
  one-line fix pattern as this change; needs its own task.
- **Tech debt flagged, NOT fixed**: `rh.uploadMyPhoto` / `rh.uploadPhoto` / `rh.documents.*`
  accept any `mimeType` and any size. Server-side should whitelist the mime and cap the
  decoded buffer; today an authenticated client can push a 45 MB blob through the Railway
  entrypoint.
