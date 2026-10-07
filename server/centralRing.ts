/**
 * Lote 45 — a Central Vodafone toca no dashboard (Jorge, 7 out 2026: "quando
 * a aplicação toca, dê algum input aqui e também toque aqui").
 *
 * A consola de cada pessoa pergunta à dashboard "quem é este número?" quando
 * a chamada entra (39d). Essa pesquisa fica em `central_requests`, na conta da
 * consola dessa pessoa. Aqui:
 *  - `ringForUser`: a chamada a tocar para uma pessoa (regras em `shared/centralRing`),
 *    com quem é (o mesmo `lookupCaller` que respondeu à consola);
 *  - `GET /api/central/ring/stream` (SSE, como o das chamadas do WhatsApp): de 2 em
 *    2 s pergunta a uma leitura PARTILHADA por processo "houve alguma pesquisa
 *    nos últimos segundos?"; só então lê a desta pessoa e manda `ring` com o id.
 *    O cliente pede o `central.myRing` (tRPC) para saber quem é.
 *  - interruptor CENTRAL_RING desligado ou a pessoa sem acesso da consola → 204.
 * Só lê; não escreve nada.
 */
import type { Express, Request, Response } from "express";
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { protectedProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import {
  CALL_STREAM_HARD_STOP_MS, CALL_STREAM_MAX_DB_ERRORS, CALL_STREAM_MAX_MS, CALL_STREAM_PING_MS, CALL_STREAM_RETRY_MS, CALL_STREAM_TICK_MS,
} from "../shared/whatsappCallSignal";
import {
  CENTRAL_RING_FLAG, CENTRAL_RING_SAME_CALL_MS, CENTRAL_RING_STREAM_PATH, CENTRAL_RING_WINDOW_MS, formatRingEvent, pickRing, ringContactHref,
  type RingRequestRow,
} from "../shared/centralRing";
import { parseContactRef } from "../shared/centralSugar";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
/** DATETIME gravado em UTC (texto "AAAA-MM-DD HH:MM:SS" ou Date do mysql2) → ms. */
export function dbUtcMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  const s = String(v ?? "").trim();
  return s ? Date.parse(`${s.replace(" ", "T").slice(0, 19)}Z`) : NaN;
}

/** Quanto para trás se lê: a janela do toque + a da mesma chamada (para achar a 1.ª pesquisa). */
const LOOKBACK_MS = CENTRAL_RING_WINDOW_MS + CENTRAL_RING_SAME_CALL_MS;

/** Interruptor CENTRAL_RING (desligado por omissão). */
export async function centralRingEnabled(): Promise<boolean> {
  const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
  await ensureFeatureFlagOverrides();
  return isFeatureEnabled(CENTRAL_RING_FLAG, { defaultEnabled: automationFlagDefault(CENTRAL_RING_FLAG) });
}

/** A pessoa tem um acesso da consola ativo (Integrações → Central Vodafone)? */
export async function hasCentralAccount(userId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  return rowsOf(await db.execute(sql`SELECT 1 AS x FROM central_accounts WHERE userId = ${userId} AND revokedAt IS NULL LIMIT 1`)).length > 0;
}

export interface CentralRing {
  id: number;
  at: string;
  phone: string;
  ref: string;
  name: string;
  title: string;
  internal: boolean;
  href: string | null;
}

/** A chamada a tocar para esta pessoa (ou null). */
export async function ringForUser(userId: number, now = Date.now()): Promise<CentralRing | null> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  const rows: RingRequestRow[] = rowsOf(await db.execute(sql`SELECT r.id, r.at, r.note FROM central_requests r
      JOIN central_accounts a ON a.id = r.accountId AND a.userId = ${userId} AND a.revokedAt IS NULL
      WHERE r.at >= ${utc(now - LOOKBACK_MS)} AND r.note LIKE 'pesquisa %'
      ORDER BY r.id DESC LIMIT 50`)).map((r) => ({ id: Number(r.id), atMs: dbUtcMs(r.at), note: r.note }));
  const pick = pickRing(rows, now);
  if (!pick) return null;
  const internal = parseContactRef(pick.ref)?.kind === "ext";
  let title = internal ? "Número interno" : "";
  if (!internal) {
    // O mesmo que a consola recebeu (RH → CRM → contactos); falha → fica só o nome da nota.
    const { lookupCaller } = await import("./centralSugar");
    const f = await lookupCaller(pick.phone).catch(() => null);
    if (f && f.id === pick.ref) title = f.title;
  }
  return { id: pick.id, at: new Date(pick.atMs).toISOString(), phone: pick.phone, ref: pick.ref, name: pick.name, title, internal, href: ringContactHref(pick.ref) };
}

// ─── Leitura partilhada por processo ("houve alguma pesquisa?") ─────────────
let probe: { at: number; value: Promise<boolean> } | null = null;
const PROBE_TTL_MS = 2_000;
async function anyRecentSearch(now: number): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  return rowsOf(await db.execute(sql`SELECT 1 AS x FROM central_requests WHERE at >= ${utc(now - CENTRAL_RING_WINDOW_MS)} AND note LIKE 'pesquisa %' LIMIT 1`)).length > 0;
}
export function anyRecentSearchCached(now = Date.now()): Promise<boolean> {
  if (!probe || now - probe.at >= PROBE_TTL_MS) {
    const value = anyRecentSearch(now);
    probe = { at: now, value };
    value.catch(() => { if (probe?.value === value) probe = null; });
  }
  return probe.value;
}

// ─── Stream (SSE) ───────────────────────────────────────────────────────────

/** Mesmo `protectedProcedure` que o resto (sessão, bloqueio de login). */
const streamAuthRouter = router({
  central: router({
    ringScope: protectedProcedure.query(async ({ ctx }) => {
      const enabled = await centralRingEnabled();
      return { enabled: enabled && (await hasCentralAccount(ctx.user.id)), userId: ctx.user.id };
    }),
  }),
});

async function resolveScope(req: Request, res: Response): Promise<{ enabled: boolean; userId: number } | { status: number }> {
  try {
    const { createContext } = await import("./_core/context");
    const ctx = await createContext({ req, res } as any);
    return await streamAuthRouter.createCaller(ctx).central.ringScope();
  } catch (err) {
    if (err instanceof TRPCError && err.code === "UNAUTHORIZED") return { status: 401 };
    if (err instanceof TRPCError && err.code === "FORBIDDEN") return { status: 403 };
    console.warn("[CentralRing] falha a validar a sessão:", String((err as any)?.message ?? err).slice(0, 160));
    return { status: 503 };
  }
}

export async function handleCentralRingStream(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  const auth = await resolveScope(req, res);
  if ("status" in auth) { res.status(auth.status).end(); return; }
  if (!auth.enabled) { res.status(204).end(); return; }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let closed = false;
  res.on("close", () => { closed = true; });
  const hardStop = setTimeout(() => {
    if (closed) return;
    closed = true;
    res.end();
  }, Math.max(0, startedAt + CALL_STREAM_HARD_STOP_MS - Date.now()));
  const write = (chunk: string): void => { if (!closed) res.write(chunk); };
  write(`retry: ${CALL_STREAM_RETRY_MS}\n: ligado\n\n`);

  const endAt = startedAt + CALL_STREAM_MAX_MS;
  let lastPing = Date.now();
  let lastId: number | null = null;
  let dbErrors = 0;
  while (!closed && Date.now() < endAt) {
    try {
      const now = Date.now();
      const ring = (await anyRecentSearchCached(now)) ? await ringForUser(auth.userId, now) : null;
      if (ring && ring.id !== lastId) write(formatRingEvent(ring.id));
      lastId = ring?.id ?? null;
      dbErrors = 0;
    } catch (err: any) {
      dbErrors++;
      if (dbErrors >= CALL_STREAM_MAX_DB_ERRORS) {
        console.warn("[CentralRing] BD indisponível, a fechar o stream:", String(err?.message ?? err).slice(0, 160));
        break;
      }
    }
    if (Date.now() - lastPing >= CALL_STREAM_PING_MS) { write(": ping\n\n"); lastPing = Date.now(); }
    await new Promise((r) => setTimeout(r, Math.max(0, Math.min(CALL_STREAM_TICK_MS, endAt - Date.now()))));
  }
  clearTimeout(hardStop);
  if (!closed) { closed = true; res.end(); }
}

/** Monta a rota nos dois entrypoints (Railway `index.ts` e Vercel `api-entry.ts`). */
export function registerCentralRingStreamRoute(app: Express): void {
  app.get(CENTRAL_RING_STREAM_PATH, (req, res) => {
    handleCentralRingStream(req, res).catch((err) => {
      console.warn("[CentralRing] erro:", String(err?.message ?? err).slice(0, 160));
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
  });
}
