/**
 * "Importar para as Críticas" (Jorge, 15 out 2026): os emails da criticas@
 * ficam só na caixa de correio; "só quando alguém põe que aquilo é uma crítica
 * é que importa para as Críticas". Este é o botão da caixa Críticas da
 * Comunicação — funciona com o interruptor REVIEWS_FROM_EMAIL ligado ou
 * desligado (é uma pessoa a decidir).
 *
 *  - o email ainda não é crítica → cria-a (a mesma leitura do email que o
 *    pipeline usa — `reviewFromEmail`), com quem e quando
 *    (`emailImportedById` / `emailImportedAt`);
 *  - já há uma crítica deste email mas ficou fora das Críticas (entrou sozinha
 *    antes de 15 out 2026) → passa a contar (só essa linha ganha a marca;
 *    nada se apaga e nada se cria em duplicado);
 *  - já está nas Críticas → nada muda.
 * Fica no registo de atividade ("review_email_import"). O rascunho da IA segue
 * as regras de sempre (AI_REVIEW_AUTO_DRAFTS, 14 dias pela data do email).
 *
 * Duas pessoas a carregar ao mesmo tempo: a linha do email (mail_messages) é
 * trancada na transação — a segunda vê a crítica da primeira (nunca duas).
 */
import { sql } from "drizzle-orm";
import { googleReviews, type InsertGoogleReview } from "../drizzle/schema";
import { getDb } from "./db";
import { isEmailOnlyReview } from "../shared/reviewRules";

const rowsOf = (res: any): any[] => (Array.isArray(res?.[0]) ? res[0] : Array.isArray(res) ? res : []);
const nowStr = () => new Date().toISOString().slice(0, 19).replace("T", " ");

export type ReviewImportResult =
  | { status: "created"; reviewId: number; duplicateOf: number | null }
  | { status: "restored"; reviewId: number }
  | { status: "already"; reviewId: number };

export class ReviewImportError extends Error {}

/** O email guardado (mail_messages) → o que a leitura da crítica precisa. */
interface StoredMail {
  id: number; threadId: number; rfcMessageId: string; subject: string; fromName: string | null; fromEmail: string | null;
  bodyText: string; sentAt: string | null;
}

async function loadMail(exec: { execute: (q: any) => Promise<any> }, messageId: number, lock: boolean): Promise<StoredMail | null> {
  const r = rowsOf(await exec.execute(sql`SELECT id, threadId, direction, rfcMessageId, subject, fromName, fromEmail, bodyText, bodyHtml,
      DATE_FORMAT(sentAt, '%Y-%m-%d %H:%i:%s') AS sentAt
    FROM mail_messages WHERE id = ${messageId} LIMIT 1 ${lock ? sql`FOR UPDATE` : sql``}`))[0];
  if (!r) return null;
  if (r.direction !== "in") throw new ReviewImportError("Só um email recebido pode ser importado para as Críticas.");
  const rfc = String(r.rfcMessageId ?? "").trim();
  if (!rfc) throw new ReviewImportError("Este email não tem identificador (Message-ID) — não dá para o importar.");
  let bodyText = String(r.bodyText ?? "");
  if (!bodyText.trim() && r.bodyHtml) {
    const { boundedHtmlToText, INBOUND_HTML_MAX } = await import("./complaintEmail");
    bodyText = boundedHtmlToText(String(r.bodyHtml), INBOUND_HTML_MAX);
  }
  return {
    id: Number(r.id), threadId: Number(r.threadId), rfcMessageId: rfc.slice(0, 100), subject: String(r.subject ?? ""),
    fromName: r.fromName ?? null, fromEmail: r.fromEmail ?? null, bodyText: bodyText.slice(0, 20000), sentAt: r.sentAt ?? null,
  };
}

/**
 * Importa UM email (mail_messages.id) para as Críticas, por decisão de uma
 * pessoa (`userId`). O acesso (caixa Críticas, poder agir, editar Críticas)
 * verifica-se antes (server/mail/inbox.ts).
 */
export async function importMailMessageAsReview(messageId: number, userId: number): Promise<ReviewImportResult> {
  const db = await getDb();
  if (!db) throw new ReviewImportError("Base de dados indisponível.");
  type Inner = ReviewImportResult & { followUp?: { id: number; sourceEmailDate: string | null; messageId: string; duplicateOf: number | null } };
  const out: Inner = await db.transaction(async (tx: any) => {
    const mail = await loadMail(tx, messageId, true);
    if (!mail) throw new ReviewImportError("Email não encontrado.");
    const existing = rowsOf(await tx.execute(sql`SELECT id, sourceEmailId, googleReviewKey, emailImportedAt FROM google_reviews
      WHERE sourceEmailId = ${mail.rfcMessageId} ORDER BY id LIMIT 1`))[0];
    if (existing) {
      const id = Number(existing.id);
      if (!isEmailOnlyReview(existing)) return { status: "already", reviewId: id };
      // Entrou sozinha antes (fora das Críticas): só esta linha passa a contar.
      await tx.execute(sql`UPDATE google_reviews SET emailImportedAt = ${nowStr()}, emailImportedById = ${userId}
        WHERE id = ${id} AND emailImportedAt IS NULL AND googleReviewKey IS NULL`);
      return { status: "restored", reviewId: id };
    }
    const { parseInboundBody } = await import("./emailParse");
    const { clientSignalEmail, isGenericSenderName } = await import("./complaintEmail");
    const { reviewFromEmail } = await import("./jobs/emailInboundSync");
    const parsed = parseInboundBody(mail.bodyText);
    // O mesmo nome de cliente que o pipeline usa (o do corpo; senão o remetente externo com nome próprio).
    const senderEmail = clientSignalEmail(mail.fromEmail ?? undefined);
    const senderName = senderEmail && !isGenericSenderName(mail.fromName ?? undefined) ? mail.fromName?.trim() : undefined;
    const bodyName = parsed.clientName && !isGenericSenderName(parsed.clientName) ? parsed.clientName.trim() : undefined;
    const routed = await reviewFromEmail(parsed, {
      subject: mail.subject, bodyText: mail.bodyText, messageId: mail.rfcMessageId, receivedAt: mail.sentAt, fromEmail: mail.fromEmail ?? undefined,
      clientName: bodyName || senderName || "Desconhecido", desc: `${mail.subject}\n\n${mail.bodyText}`.trim().slice(0, 5000),
    }, {
      manualBy: userId,
      // Dentro da transação (a 2.ª pessoa espera e vê esta); o registo e a IA só depois de gravar.
      insert: async (data: InsertGoogleReview) => {
        const res = await tx.insert(googleReviews).values(data);
        return Number(res?.[0]?.insertId ?? 0) || undefined;
      },
      deferFollowUps: true,
    });
    if (routed.targetModule !== "review" || !routed.createdId) throw new ReviewImportError("Não foi possível criar a crítica a partir deste email.");
    // O email fica com o caminho dele (→ criticas) e o Message-ID fica reservado (inbound_emails): uma 2.ª cópia
    // do mesmo email (outra conta, nova tentativa) liga-se a esta crítica e nunca cria outra.
    const target = routed.targetId ?? routed.createdId;
    await tx.execute(sql`UPDATE mail_messages SET pipeline = 'criticas', pipelineStatus = 'processed', pipelineError = NULL WHERE id = ${mail.id}`);
    await tx.execute(sql`INSERT IGNORE INTO inbound_emails (messageId, alias, fromName, fromEmail, subject, targetModule, targetId, status, receivedAt)
      VALUES (${mail.rfcMessageId}, 'criticas', ${mail.fromName ? mail.fromName.slice(0, 255) : null}, ${mail.fromEmail ? mail.fromEmail.slice(0, 320) : null},
        ${mail.subject.slice(0, 500)}, 'review', ${target}, 'processed', ${mail.sentAt})`);
    await tx.execute(sql`UPDATE inbound_emails SET targetModule = 'review', targetId = ${target}
      WHERE messageId = ${mail.rfcMessageId} AND targetModule IN ('review_off', 'not_review', 'review_summary', 'ignored')`);
    return {
      status: "created", reviewId: routed.targetId ?? routed.createdId, duplicateOf: routed.duplicateOf ?? null,
      followUp: { id: routed.createdId, sourceEmailDate: routed.sourceEmailDate ?? null, messageId: mail.rfcMessageId, duplicateOf: routed.duplicateOf ?? null },
    };
  });
  const { logActivity } = await import("./db");
  if (out.status === "restored") {
    await logActivity({ userId, action: "review_email_import", entity: "google_review", entityId: out.reviewId,
      details: "Importada à mão da caixa de correio (já estava guardada, fora das Críticas)" } as any).catch(() => {});
    return { status: "restored", reviewId: out.reviewId };
  }
  if (out.status === "created" && out.followUp) {
    const { reviewEmailFollowUps } = await import("./jobs/emailInboundSync");
    await reviewEmailFollowUps({ ...out.followUp, manualBy: userId });
    return { status: "created", reviewId: out.reviewId, duplicateOf: out.duplicateOf };
  }
  return { status: "already", reviewId: out.reviewId };
}

/**
 * As críticas dos emails desta lista de Message-IDs (para a conversa mostrar
 * "Nas Críticas" ou "Importar para as Críticas"). Nunca lança.
 */
export async function reviewsOfMessageIds(rfcIds: readonly string[]): Promise<Map<string, { id: number; inCriticas: boolean }>> {
  const out = new Map<string, { id: number; inCriticas: boolean }>();
  const ids = [...new Set(rfcIds.map((x) => String(x ?? "").trim()).filter(Boolean))].slice(0, 200);
  if (!ids.length) return out;
  try {
    const db = await getDb();
    if (!db) return out;
    const rows = rowsOf(await db.execute(sql`SELECT id, sourceEmailId, googleReviewKey, emailImportedAt FROM google_reviews
      WHERE sourceEmailId IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) ORDER BY id`));
    for (const r of rows) {
      const k = String(r.sourceEmailId);
      const inCriticas = !isEmailOnlyReview(r);
      const prev = out.get(k);
      // Uma que conta ganha a uma que ficou fora (cópias antigas do mesmo email).
      if (!prev || (!prev.inCriticas && inCriticas)) out.set(k, { id: Number(r.id), inCriticas });
    }
  } catch (err: any) {
    console.warn("[Críticas] críticas dos emails da conversa:", String(err?.message ?? err).slice(0, 160));
  }
  return out;
}
