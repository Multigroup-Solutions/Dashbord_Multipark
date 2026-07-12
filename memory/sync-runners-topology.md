# Booking Sync Runners — Topology & Dual-Runner Analysis

## Summary
Tracks WHERE the Multipark booking sync actually fires. There are TWO deploy targets
built from the SAME repo but DIFFERENT entrypoints, and the sync runs on BOTH:
1. Railway — long-lived Express server (`dist/index.js` from `server/_core/index.ts`)
   with an in-process `setInterval` every 15 min.
2. Vercel — serverless function (`api/index.js` from `server/_core/api-entry.ts`)
   exposing `/api/cron/*` HTTP endpoints, driven by a GitHub Actions cron.
This file is the authoritative answer to "how many sync runners are firing".

## Related
- (none yet)

## Key facts / evidence
- Two build outputs, two entrypoints:
  - `package.json` `build` → `dist/index.js` (Railway). `build:api` → `api/index.js` (Vercel).
  - `railway.json` startCommand = `node dist/index.js` → runs `server/_core/index.ts`.
  - `vercel.json` routes `/api/(.*)` → `api/index.js` → `server/_core/api-entry.ts`.
- Railway runner: `server/_core/index.ts:93` calls `startBookingSyncScheduler()`.
  - `server/jobs/multiparkBookingSync.ts:905-908`: `setTimeout(runSync,10s)` +
    `setInterval(runSync, 15min)`. UNCONDITIONAL — no env flag gates it. Only guard is
    inside runSync: `isMultiparkConfigured()` (needs MULTIPARK_API_KEY*).
  - Startup log line: `[BookingSync] Scheduler started — runs every 15 minutes`.
    Per-cycle: `[BookingSync] Past window ... → ...` / `[BookingSync] Future window ...`.
- GitHub Actions: `.github/workflows/multipark-cron.yml` — ENABLED, has `on: schedule`.
  - sync-recent cron `4,19,34,49 * * * *` (every 15 min, offset minutes).
  - sync-future `17 */2 * * *`; cleanup `0 3 * * *`; daily-ops `30 3 * * *`;
    email-inbound rides the 15-min schedule.
  - URL = `secrets.APP_URL || 'https://dashbord-multipark.vercel.app'` → **VERCEL**.
  - Auth = `Authorization: Bearer ${CRON_SECRET}`; endpoint checks via `cronAuthOk`.
- The Vercel endpoint exists in the SHIPPED artifact: `api/index.js` contains
  `runRecentCronSync` / `/api/cron/multipark-sync` (7 occurrences). Source:
  `server/_core/api-entry.ts:146` (`/api/cron/multipark-sync`).
- LIVE PROOF (gh run logs, run 27948817511 job 82700260922, 2026-06-22 11:17 UTC):
  resolved `APP_URL: https://dashbord-multipark.vercel.app`, response `HTTP 200`,
  body `{"ok":true,...,"processed":220,"created":24,"updated":172,"errors":[]...}`.
  → The GitHub cron is NOT hitting a void; it drives a REAL Vercel sync.
- gh run list: ~mostly green every ~15 min over 24h. One failure (27943074477) was a
  transient `HTTP 504` on the daily-ops/window (Vercel 60s maxDuration timeout), not a
  misconfiguration.

## Conclusion (2026-06-22)
**TWO real sync runners fire in parallel, both doing real work:**
- Railway `setInterval` (15 min, in-process, writes to the same MySQL DB).
- GitHub Actions → Vercel `/api/cron/multipark-sync` (every 15 min).
They share the same DB; writes are idempotent upserts keyed on `externalId`, so the
duplication is wasteful (double API load on Multipark + double DB churn) but not
data-corrupting. NOTE: this CONTRADICTS the earlier "zero Vercel cron invocations"
premise — the Vercel endpoint is provably returning HTTP 200 with processed>0.
The earlier "zero" reading was likely a wrong log filter / wrong project or function
on the Vercel side, OR runtime-log retention; the GitHub run logs are authoritative.

## Recommendation (NOT APPLIED — user to review)
Keep ONE runner. Two safe options:
1. Keep GitHub→Vercel cron (has alerting/issue-on-failure, auto-recovering window,
   budget clamp). Disable the Railway loop by gating `startBookingSyncScheduler()`
   behind an env flag (e.g. only start if `ENABLE_INPROCESS_SYNC === 'true'`), OR
   simply stop deploying the Railway service if it exists only for the loop.
2. Keep the Railway loop. Disable the GitHub workflow (`on: schedule` removed or
   workflow disabled in Actions UI). Loses the built-in failure alerting.
Preferred: option 1 — the Vercel/GitHub path is the more instrumented, self-healing
one. Either way, verify which target the UI/tRPC traffic is actually served from before
turning anything off (UI is on Vercel per parent's confirmed Vercel API data).

## Follow-up (2026-06-22) — Railway live-state check + gating prep

### 1. Is Railway deployed/running NOW? — CANNOT CONFIRM from here (no access)
- No Railway CLI installed (`railway` → command not found), no `RAILWAY_*` env/token in
  the local shell, no `.railway/` dir in the repo. Only `railway.json` exists (build/deploy
  config, not runtime state). So I CANNOT prove the service is live or read its logs.
- USER MUST CONFIRM via one of:
  - CLI: `railway login` then `railway status` (shows project/service/active deployment),
    then `railway logs` (or `railway logs --deployment`). Grep for the startup line
    `[BookingSync] Scheduler started — runs every 15 minutes` and the per-cycle lines
    `[BookingSync] Past window ... → ...` / `[BookingSync] Future window ...`.
  - Dashboard: railway.app → project → the service → Deployments tab. If the latest
    deployment badge is "Active"/green → service is live. Open it → Logs/Observability,
    search `BookingSync`. Seeing the per-cycle `Past window` line every ~15 min = the
    in-process loop IS firing → 2 runners confirmed live. Seeing nothing / "Removed" /
    "Crashed" / no active deployment → Railway not running → only the Vercel runner fires.
- Note: even if deployed, `runSync` self-skips when `MULTIPARK_API_KEY` is unset there
  (`[BookingSync] Skipped — MULTIPARK_API_KEY not configured`, multiparkBookingSync.ts:865-866).
  So "scheduler started" + "Skipped" each cycle = loop alive but doing no work.

### 2. Does Railway serve MORE than the sync? — YES. Full app server (case "serve more").
Evidence from `server/_core/index.ts` (the `dist/index.js` Railway entrypoint):
- L67-73: mounts the WHOLE tRPC API at `/api/trpc` (`appRouter`) — the dashboard backend.
- L50: `/api/external` REST router (device integrations).
- L48: OAuth routes (`/api/oauth/callback`).
- L54-65: `/api/upload` (multer file upload).
- L46: `/uploads` static.
- L75-79: serves the built frontend (Vite dev / static prod) — the UI itself.
- L88-95 inside `server.listen`: `seedProjectHierarchy()`, `startDailyCollectionScheduler()`,
  AND `startBookingSyncScheduler()` (L93).
- `railway.json` healthcheckPath = `/api/trpc/system.health...` → Railway expects this to be
  a live HTTP server, not a worker.
- CONSEQUENCE: do NOT "just delete the Railway service". The booking `setInterval` is ONE
  line inside a full app server. Correct fix = gate ONLY the scheduler call, leave the rest.

### 3. Gating diff (PREPARED, NOT APPLIED) — behind ENABLE_INPROCESS_SYNC
Chosen point: the call site `server/_core/index.ts:93`, least invasive, server untouched.
Default OFF (so Railway stops duplicating unless flag explicitly set to 'true').
```diff
--- server/_core/index.ts
@@ server.listen(port, () => {  (around L88-95)
     startDailyCollectionScheduler();
-    startBookingSyncScheduler();
+    if (process.env.ENABLE_INPROCESS_SYNC === "true") {
+      startBookingSyncScheduler();
+    } else {
+      console.log("[BookingSync] In-process scheduler disabled (ENABLE_INPROCESS_SYNC != 'true')");
+    }
```
- To RE-ENABLE the Railway loop: set Railway service env var `ENABLE_INPROCESS_SYNC=true`
  (and redeploy/restart). Absent or any other value → loop stays off.
- VERCEL UNAFFECTED: `server/_core/api-entry.ts` never calls `startBookingSyncScheduler()`
  / `setInterval` (grep: only an L169 comment noting the schedulers "só correm no server
  Railway"). Vercel sync is driven by the GitHub cron → `/api/cron/multipark-sync` HTTP
  endpoint, a different entrypoint. The flag does not touch that path.
- Alternative point (NOT chosen): guard inside `startBookingSyncScheduler()` itself
  (multiparkBookingSync.ts:863). Equivalent effect; the call-site guard is clearer and keeps
  the gating decision next to the other scheduler starts.

## Limitations of this investigation
- Could NOT inspect Railway runtime state/logs (no Railway CLI auth/token in env). The
  Railway loop is confirmed ACTIVE *in code* (unconditional setInterval) but I cannot
  prove the Railway service is currently deployed/running or that MULTIPARK_API_KEY is
  set there. If the Railway service is not deployed, only 1 real runner fires.
- Could NOT read Vercel runtime logs directly here; relied on GitHub Actions run logs
  (which capture the Vercel HTTP 200 + JSON body) — strong indirect proof.
- Older gh run `--log` dumps returned empty (gh 2.30 / retention); used the per-job
  `actions/jobs/{id}/logs` API instead, which worked.
