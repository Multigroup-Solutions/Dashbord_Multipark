/**
 * Email: a mesma leitura de IA para o mesmo pedido (plano MPV F6b, seguimento).
 *
 * Duas cópias do mesmo email (o mesmo Message-ID em contas diferentes) fazem o
 * MESMO pedido à IA: mesmo texto, mesma caixa de entrada. Guarda-se a leitura
 * por um resumo (sha256) do pedido já tapado, em memória deste processo, 30
 * min, no máx. 300. Serve a mesma corrida da sincronização (server/mail/service.ts
 * lê as contas umas a seguir às outras). Entre processos do Vercel (ex.: um push
 * do Gmail de outra conta) não se partilha — para isso teria de ficar numa
 * tabela, e a reserva por mensagem (comms_ai_routing) é por cópia, não por
 * Message-ID; fica assim.
 */
import { createHash } from "node:crypto";
import type { MailRoutingOutput } from "./_core/ai/prompts/comms";

const MAIL_READ_CACHE = new Map<string, { at: number; value: { output: MailRoutingOutput; model?: string } }>();
export const MAIL_READ_CACHE_TTL_MS = 30 * 60_000;
const MAIL_READ_CACHE_MAX = 300;

/** Chave da leitura: sha256 do pedido exato (sistema + texto já tapado). */
export function mailReadCacheKey(system: string, input: string): string {
  return createHash("sha256").update(system).update("\u0000").update(input).digest("hex");
}

export function mailReadCacheGet(key: string, nowMs = Date.now()): { output: MailRoutingOutput; model?: string } | null {
  const e = MAIL_READ_CACHE.get(key);
  if (!e) return null;
  if (nowMs - e.at > MAIL_READ_CACHE_TTL_MS) { MAIL_READ_CACHE.delete(key); return null; }
  return e.value;
}

export function mailReadCacheSet(key: string, value: { output: MailRoutingOutput; model?: string }, nowMs = Date.now()): void {
  if (MAIL_READ_CACHE.size >= MAIL_READ_CACHE_MAX) {
    const oldest = MAIL_READ_CACHE.keys().next().value;
    if (oldest !== undefined) MAIL_READ_CACHE.delete(oldest);
  }
  MAIL_READ_CACHE.set(key, { at: nowMs, value });
}

/** Testes. */
export function clearMailReadCache(): void {
  MAIL_READ_CACHE.clear();
}
