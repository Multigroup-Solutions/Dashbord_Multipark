/**
 * Limitador de pedidos reutilizável (preparação do chat público): por
 * utilizador e/ou IP, por minuto e por dia. O estado vive na BD
 * (ai_rate_limits), por isso funciona em serverless (várias instâncias).
 *
 * Um só statement por janela, atómico:
 *   INSERT … VALUES (…, LAST_INSERT_ID(1))
 *   ON DUPLICATE KEY UPDATE hits = LAST_INSERT_ID(hits + 1)
 * → o `insertId` devolvido é o contador já incrementado.
 *
 * O IP nunca é guardado em claro (hash SHA-256 truncado). Sem BD, cai para
 * um contador em memória (por instância) — nunca deixa passar sem limite.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

export interface RateLimitRule {
  perMinute?: number;
  perDay?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Segundos até a janela que bloqueou abrir de novo (0 se passou). */
  retryAfterSec: number;
  /** Pedidos que ainda cabem na janela mais apertada. */
  remaining: number;
  limitedBy: "minute" | "day" | null;
}

type Window = { kind: "minute" | "day"; limit: number; start: Date; end: Date };

/** Chave de um IP (sem o guardar em claro). PURA. */
export function ipKey(ip: string | null | undefined): string {
  const h = createHash("sha256").update(String(ip ?? "").trim().toLowerCase()).digest("hex").slice(0, 24);
  return `ip:${h}`;
}

export function userKey(userId: number): string {
  return `user:${Math.trunc(userId)}`;
}

/** Janelas (UTC) de um instante. PURA. */
export function windowsFor(rule: RateLimitRule, now: number): Window[] {
  const out: Window[] = [];
  if (rule.perMinute && rule.perMinute > 0) {
    const start = new Date(Math.floor(now / 60_000) * 60_000);
    out.push({ kind: "minute", limit: rule.perMinute, start, end: new Date(start.getTime() + 60_000) });
  }
  if (rule.perDay && rule.perDay > 0) {
    const d = new Date(now);
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    out.push({ kind: "day", limit: rule.perDay, start, end: new Date(start.getTime() + 86_400_000) });
  }
  return out;
}

/** Decisão a partir das contagens (já com este pedido). PURA. */
export function decide(windows: Window[], counts: number[], now: number): RateLimitResult {
  let remaining = Number.POSITIVE_INFINITY;
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    if (counts[i] > w.limit) {
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((w.end.getTime() - now) / 1000)), remaining: 0, limitedBy: w.kind };
    }
    remaining = Math.min(remaining, w.limit - counts[i]);
  }
  return { allowed: true, retryAfterSec: 0, remaining: Number.isFinite(remaining) ? remaining : Number.MAX_SAFE_INTEGER, limitedBy: null };
}

const memCounts = new Map<string, number>();
const fmt = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

export function resetRateLimitMemoryForTests(): void {
  memCounts.clear();
}

async function bump(db: any, key: string, w: Window): Promise<number> {
  const res = await db.execute(sql`
    INSERT INTO ai_rate_limits (bucketKey, windowStart, hits) VALUES (${key}, ${fmt(w.start)}, LAST_INSERT_ID(1))
    ON DUPLICATE KEY UPDATE hits = LAST_INSERT_ID(hits + 1)`);
  const header = Array.isArray(res) ? res[0] : res;
  const n = Number((header as any)?.insertId ?? 0);
  if (n > 0) return n;
  const rows = await db.execute(sql`SELECT hits FROM ai_rate_limits WHERE bucketKey = ${key} AND windowStart = ${fmt(w.start)} LIMIT 1`);
  const r = Array.isArray(rows) ? rows[0] : rows;
  return Number((Array.isArray(r) ? r[0]?.hits : 0) ?? 0) || 1;
}

/**
 * Conta ESTE pedido e diz se passa. `key` = userKey(id) ou ipKey(ip) (ou
 * outra chave estável, ex.: "chat:" + userKey). Nunca lança.
 */
export async function checkRateLimit(key: string, rule: RateLimitRule, now: number = Date.now()): Promise<RateLimitResult> {
  const windows = windowsFor(rule, now);
  if (!windows.length) return decide([], [], now);
  const bucket = key.slice(0, 150);
  const counts: number[] = [];
  let db: any = null;
  try {
    const { getDb } = await import("../../db");
    db = await getDb();
  } catch { db = null; }
  for (const w of windows) {
    const k = `${w.kind}:${bucket}`;
    let n: number;
    try {
      if (!db) throw new Error("sem BD");
      n = await bump(db, k, w);
    } catch {
      const mk = `${k}@${w.start.getTime()}`;
      if (memCounts.size > 10_000) memCounts.clear(); // teto de memória (fallback raro)
      n = (memCounts.get(mk) ?? 0) + 1;
      memCounts.set(mk, n);
    }
    counts.push(n);
  }
  // Limpeza ocasional (≈1% dos pedidos): janelas com mais de 2 dias.
  if (db && Math.random() < 0.01) {
    void db.execute(sql`DELETE FROM ai_rate_limits WHERE windowStart < ${fmt(new Date(now - 2 * 86_400_000))} LIMIT 5000`).catch(() => undefined);
  }
  return decide(windows, counts, now);
}
