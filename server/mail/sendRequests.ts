/**
 * Comunicação — envio sem duplicar (P3 lote 17d). O editor manda um código
 * por envio (`clientRequestId`); o servidor reserva-o ANTES de falar com o
 * Gmail (mail_send_requests, chave única). Carregar outra vez em Enviar —
 * erro depois do envio, rede que caiu, duplo clique — devolve o resultado do
 * primeiro envio; nunca sai um segundo email igual para o cliente.
 *
 *  - "sent": já saiu → devolve a conversa (duplicado, sem enviar).
 *  - "unknown": o Gmail não respondeu (prazo, rede, 5xx) — PODE ter saído →
 *    não se volta a enviar sozinho; a pessoa confirma em "Enviados".
 *  - "failed": o Gmail recusou (4xx) ou falhou antes de enviar → pode tentar.
 *  - "sending": outro pedido com o mesmo código está a meio (ou morreu: ao
 *    fim de SEND_STALE_MS passa a "unknown").
 */
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { db, rowsOf } from "./store";

const busy = () => new TRPCError({ code: "CONFLICT", message: "Este email já está a ser enviado — aguarda uns segundos." });

export type SendRequestStatus = "sending" | "sent" | "unknown" | "failed";

export interface SendRequestRow { userId: number; status: SendRequestStatus; gmailMessageId: string | null; threadId: number | null; updatedAtMs: number | null }

/** Um envio "a meio" há mais do que isto morreu com a função (Vercel 60 s). */
export const SEND_STALE_MS = 3 * 60_000;

/** Código do ecrã → aceite só [A-Za-z0-9-] com 8–64 carateres. PURA. */
export function cleanRequestId(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  return /^[A-Za-z0-9-]{8,64}$/.test(s) ? s : null;
}

export type PriorDecision =
  | { kind: "retry" }
  | { kind: "sent"; threadId: number | null; gmailMessageId: string | null }
  | { kind: "unknown"; threadId: number | null }
  | { kind: "busy" }
  | { kind: "stale" }
  | { kind: "foreign" };

/** O que fazer com um código que já existia. PURA. */
export function decidePrior(row: SendRequestRow, userId: number, nowMs: number): PriorDecision {
  if (row.userId !== userId) return { kind: "foreign" };
  if (row.status === "sent") return { kind: "sent", threadId: row.threadId, gmailMessageId: row.gmailMessageId };
  if (row.status === "unknown") return { kind: "unknown", threadId: row.threadId };
  if (row.status === "failed") return { kind: "retry" };
  return row.updatedAtMs != null && nowMs - row.updatedAtMs > SEND_STALE_MS ? { kind: "stale" } : { kind: "busy" };
}

/**
 * O Gmail RECUSOU de certeza (o email não saiu)? 4xx da API, ou a ligação
 * nem chegou a abrir (DNS, recusada). Prazo, ligação cortada e 5xx → incerto
 * (pode ter saído). PURA.
 */
export function sendFailureIsDefinite(err: unknown): boolean {
  const e = err as any;
  const raw = e?.response?.status ?? e?.status ?? (/^\d{3}$/.test(String(e?.code ?? "")) ? e.code : null);
  const status = raw == null ? NaN : Number(raw);
  if (Number.isFinite(status) && status >= 400 && status < 500) return true;
  if (Number.isFinite(status) && status >= 500) return false;
  const code = String(e?.code ?? e?.cause?.code ?? "");
  return ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(code);
}

const tsMs = (v: unknown): number | null => {
  if (v == null) return null;
  const s = String(v);
  const ms = Date.parse(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : null;
};

async function readRequest(requestId: string): Promise<SendRequestRow | null> {
  const d = await db();
  const r = rowsOf(await d.execute(sql`SELECT userId, status, gmailMessageId, threadId, DATE_FORMAT(updatedAt, '%Y-%m-%d %H:%i:%s') AS updatedAt
    FROM mail_send_requests WHERE requestId = ${requestId} LIMIT 1`))[0];
  if (!r) return null;
  return { userId: Number(r.userId), status: r.status as SendRequestStatus, gmailMessageId: r.gmailMessageId ?? null, threadId: r.threadId != null ? Number(r.threadId) : null, updatedAtMs: tsMs(r.updatedAt) };
}

export type ClaimResult =
  | { go: true }
  | { go: false; outcome: { threadId: number; gmailMessageId: string | null; duplicate?: true; uncertain?: true } };

/**
 * Reserva o código para ESTE envio. `go: true` → pode enviar; senão devolve o
 * resultado do envio anterior com o mesmo código. Lança se outro pedido com o
 * mesmo código ainda está a meio, ou se o código é de outra pessoa.
 */
export async function claimSendRequest(requestId: string, userId: number, nowMs = Date.now()): Promise<ClaimResult> {
  const d = await db();
  const ins = await d.execute(sql`INSERT IGNORE INTO mail_send_requests (requestId, userId, status) VALUES (${requestId}, ${userId}, 'sending')`);
  const head = Array.isArray(ins) ? ins[0] : ins;
  if (Number((head as any)?.affectedRows ?? 0) === 1) return { go: true };
  const row = await readRequest(requestId);
  if (!row) return { go: true };
  const dec = decidePrior(row, userId, nowMs);
  switch (dec.kind) {
    case "foreign": throw new TRPCError({ code: "BAD_REQUEST", message: "Pedido de envio inválido." });
    case "busy": throw busy();
    case "sent": return { go: false, outcome: { threadId: dec.threadId ?? 0, gmailMessageId: dec.gmailMessageId, duplicate: true } };
    case "unknown": return { go: false, outcome: { threadId: dec.threadId ?? 0, gmailMessageId: null, uncertain: true } };
    case "stale":
      await finishSendRequest(requestId, { status: "unknown", errorDetail: "O envio anterior não terminou (função cortada)." });
      return { go: false, outcome: { threadId: row.threadId ?? 0, gmailMessageId: null, uncertain: true } };
    case "retry": {
      // Falhou de certeza antes: volta a reservar (só um pedido ganha).
      const res = await d.execute(sql`UPDATE mail_send_requests SET status = 'sending', errorDetail = NULL WHERE requestId = ${requestId} AND status = 'failed'`);
      const h = Array.isArray(res) ? res[0] : res;
      if (Number((h as any)?.affectedRows ?? 0) === 1) return { go: true };
      throw busy();
    }
  }
}

export async function finishSendRequest(
  requestId: string,
  patch: { status?: SendRequestStatus; gmailMessageId?: string | null; threadId?: number | null; errorDetail?: string | null },
): Promise<void> {
  const sets = [];
  if (patch.status) sets.push(sql`status = ${patch.status}`);
  if (patch.gmailMessageId !== undefined) sets.push(sql`gmailMessageId = ${patch.gmailMessageId}`);
  if (patch.threadId !== undefined) sets.push(sql`threadId = ${patch.threadId}`);
  if (patch.errorDetail !== undefined) sets.push(sql`errorDetail = ${patch.errorDetail ? patch.errorDetail.slice(0, 500) : null}`);
  if (!sets.length) return;
  const d = await db();
  await d.execute(sql`UPDATE mail_send_requests SET ${sql.join(sets, sql`, `)} WHERE requestId = ${requestId}`);
}
