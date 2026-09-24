/**
 * Autenticação partilhada dos crons (/api/cron/*) e do Bearer do webhook
 * Multipark. Comparação em tempo constante (crypto.timingSafeEqual sobre os
 * SHA-256 das duas strings, para o comprimento não vazar) e segredo com trim
 * (um "\n" colado no painel do Vercel não pode deixar os crons todos a 401).
 */
import crypto from "node:crypto";

type EnvLike = Record<string, string | undefined>;

/** Igualdade em tempo constante (também quando os comprimentos diferem). */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a, "utf8").digest();
  const hb = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

/** "Bearer <token>" → token (com trim); qualquer outra coisa → null. */
export function bearerToken(header: unknown): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") return null;
  const m = raw.match(/^\s*Bearer\s+(.+?)\s*$/i);
  return m && m[1] ? m[1] : null;
}

/** O header Authorization traz exatamente o segredo? Sem segredo → nunca. */
export function bearerMatches(authorization: unknown, secret: string | undefined | null): boolean {
  const s = secret?.trim();
  if (!s) return false;
  const token = bearerToken(authorization);
  return token != null && safeEqual(token, s);
}

/** Bearer CRON_SECRET válido? Usado por api-entry, cronRuns e /api/health. */
export function cronAuthOk(authorization: unknown, env: EnvLike = process.env): boolean {
  return bearerMatches(authorization, env.CRON_SECRET);
}
