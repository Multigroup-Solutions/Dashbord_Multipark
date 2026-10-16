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
 *  - já está nas Críticas → nada muda;
 *  - marcada como «não é crítica» (Limpeza) → não mexe: desfaz-se lá primeiro.
 * Nos dois primeiros casos compara SEMPRE com as que já estão nas Críticas (a
 * regra das repetidas, com ou sem o REVIEWS_DEDUP): a API do Google já trouxe
 * as críticas, e importar o aviso de uma delas não a pode repetir — a do email
 * fica marcada como repetida dessa (não se apaga; Limpeza desfaz).
 * Fica no registo de atividade. O rascunho da IA segue as regras de sempre
 * (AI_REVIEW_AUTO_DRAFTS, 14 dias pela data do email).
 *
 * Duas pessoas a carregar ao mesmo tempo (no mesmo email ou numa cópia dele
 * noutra conta): as linhas desse email (mail_messages, pelo Message-ID) são
 * trancadas na transação, sempre pela mesma ordem — a segunda vê a crítica da
 * primeira (nunca duas).
 */
import { sql } from "drizzle-orm";
import { googleReviews, type InsertGoogleReview } from "../drizzle/schema";
import { getDb } from "./db";
import { isEmailOnlyReview } from "../shared/reviewRules";

const rowsOf = (res: any): any[] => (Array.isArray(res?.[0]) ? res[0] : Array.isArray(res) ? res : []);
const nowStr = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const isOn = (v: unknown) => v === true || Number(v) === 1;

/** `google_reviews.sourceEmailId` guarda até 100 caracteres do Message-ID (o resto do email guarda até 255). */
export const REVIEW_SOURCE_EMAIL_MAX = 100;
const sourceKey = (rfc: string) => rfc.slice(0, REVIEW_SOURCE_EMAIL_MAX);

export type ReviewImportResult =
  | { status: "created"; reviewId: number; duplicateOf: number | null }
  | { status: "restored"; reviewId: number; duplicateOf: number | null }
  | { status: "already"; reviewId: number };

export class ReviewImportError extends Error {}

export const NOT_A_REVIEW_IMPORT =
  "A crítica deste email está marcada como «não é crítica» (Críticas → Limpeza → Marcadas). Para a importar, desfaz lá a marca e carrega outra vez.";

/** O email guardado (mail_messages) → o que a leitura da crítica precisa. */
interface StoredMail {
  id: number; threadId: number;
  /** O Message-ID inteiro (como em mail_messages / inbound_emails). */
  rfcFull: string;
  /** O mesmo, como fica na crítica (`sourceEmailId`). */
  rfcMessageId: string;
  subject: string; fromName: string | null; fromEmail: string | null;
  bodyText: string; sentAt: string | null;
}

async function loadMail(exec: { execute: (q: any) => Promise<any> }, messageId: number): Promise<StoredMail | null> {
  const r = rowsOf(await exec.execute(sql`SELECT id, threadId, direction, rfcMessageId, subject, fromName, fromEmail, bodyText, bodyHtml,
      DATE_FORMAT(sentAt, '%Y-%m-%d %H:%i:%s') AS sentAt
    FROM mail_messages WHERE id = ${messageId} LIMIT 1`))[0];
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
    id: Number(r.id), threadId: Number(r.threadId), rfcFull: String(r.rfcMessageId), rfcMessageId: sourceKey(rfc), subject: String(r.subject ?? ""),
    fromName: r.fromName ?? null, fromEmail: r.fromEmail ?? null, bodyText: bodyText.slice(0, 20000), sentAt: r.sentAt ?? null,
  };
}

type Exec = { execute: (q: any) => Promise<any> };

/** As colunas de uma crítica guardada que a importação lê (a regra de quem conta + as repetidas). */
const REVIEW_COLS = sql.raw("id, sourceEmailId, googleReviewKey, emailImportedAt, notAReview, duplicateOf, reviewerName, rating, reviewText, reviewDate, sourceEmailDate, createdAt, projectId");

type Outcome = {
  status: "created" | "restored" | "already"; reviewId: number; duplicateOf: number | null;
  /** Registo de atividade (depois de gravar). */
  log?: { entityId: number; details: string };
  /** Criada: o registo e o rascunho da IA (depois de gravar). */
  followUp?: { id: number; sourceEmailDate: string | null; messageId: string; duplicateOf: number | null };
};

/**
 * Uma crítica guardada que ficou fora das Críticas volta a contar — só essa
 * linha. Antes compara-a com as que estão nas Críticas (a regra das
 * repetidas): se a API já a trouxe, fica marcada como repetida dessa.
 */
async function restoreRow(tx: Exec, row: any, userId: number): Promise<{ id: number; duplicateOf: number | null }> {
  const id = Number(row.id);
  const { dedupFactsOfRow, emailParser, findEmailReviewDuplicate, loadRawEmails } = await import("./reviewCleanup");
  const raw = row.sourceEmailId ? (await loadRawEmails(tx, [row.sourceEmailId])).get(String(row.sourceEmailId)) ?? null : null;
  const { id: _self, ...facts } = dedupFactsOfRow(row, await emailParser(), raw);
  const found = await findEmailReviewDuplicate(facts);
  const dup = found != null && found !== id ? found : null;
  const at = nowStr();
  await tx.execute(sql`UPDATE google_reviews SET emailImportedAt = ${at}, emailImportedById = ${userId}
      ${dup ? sql`, duplicateOf = ${dup}, reviewMarkedAt = ${at}, reviewMarkedById = ${userId}` : sql``}
    WHERE id = ${id} AND emailImportedAt IS NULL AND googleReviewKey IS NULL AND notAReview = 0 AND duplicateOf IS NULL`);
  return { id, duplicateOf: dup };
}

/** Já há crítica(s) deste email (`found`, pela ordem de criação). */
async function importExisting(tx: Exec, found: any[], userId: number): Promise<Outcome> {
  // Uma que conta (ou que é a repetida de uma que conta) ganha a uma cópia que ficou fora.
  const row = found.find((r) => !isOn(r.notAReview) && (!isEmailOnlyReview(r) || r.duplicateOf != null)) ?? found.find((r) => !isOn(r.notAReview)) ?? found[0];
  if (isOn(row.notAReview)) throw new ReviewImportError(NOT_A_REVIEW_IMPORT);
  const id = Number(row.id);
  if (row.duplicateOf != null) {
    // Repetida de outra: é a original que conta. A do email fica com a marca de quem importou (a conversa
    // passa a mostrar "Nas Críticas (#original)"); a original, se também tinha ficado fora, volta.
    const origId = Number(row.duplicateOf);
    if (isEmailOnlyReview(row)) {
      await tx.execute(sql`UPDATE google_reviews SET emailImportedAt = ${nowStr()}, emailImportedById = ${userId}
        WHERE id = ${id} AND emailImportedAt IS NULL AND googleReviewKey IS NULL`);
    }
    const orig = rowsOf(await tx.execute(sql`SELECT ${REVIEW_COLS} FROM google_reviews WHERE id = ${origId} LIMIT 1`))[0];
    if (orig && isEmailOnlyReview(orig) && !isOn(orig.notAReview) && orig.duplicateOf == null) {
      const r = await restoreRow(tx, orig, userId);
      return { status: "restored", reviewId: r.duplicateOf ?? r.id, duplicateOf: r.duplicateOf,
        log: { entityId: r.id, details: `Importada à mão da caixa de correio (já estava guardada, fora das Críticas; o email #${id} é repetida desta)${r.duplicateOf ? ` — repetida de #${r.duplicateOf}` : ""}` } };
    }
    return { status: "already", reviewId: origId, duplicateOf: null };
  }
  if (!isEmailOnlyReview(row)) return { status: "already", reviewId: id, duplicateOf: null };
  // Entrou sozinha antes (fora das Críticas): só esta linha passa a contar.
  const r = await restoreRow(tx, row, userId);
  return { status: "restored", reviewId: r.duplicateOf ?? r.id, duplicateOf: r.duplicateOf,
    log: { entityId: r.id, details: `Importada à mão da caixa de correio (já estava guardada, fora das Críticas)${r.duplicateOf ? ` — repetida de #${r.duplicateOf}` : ""}` } };
}

/**
 * Importa UM email (mail_messages.id) para as Críticas, por decisão de uma
 * pessoa (`userId`). O acesso (caixa Críticas, poder agir, editar Críticas)
 * verifica-se antes (server/mail/inbox.ts).
 */
export async function importMailMessageAsReview(
  messageId: number, userId: number,
  /** Quem só vê as suas cidades: a cidade onde fica a crítica sem parque reconhecido (ver `reviewFromEmail`). */
  opts: { fallbackProjectId?: number | null } = {},
): Promise<ReviewImportResult> {
  const db = await getDb();
  if (!db) throw new ReviewImportError("Base de dados indisponível.");
  const out: Outcome = await db.transaction(async (tx: any) => {
    const mail = await loadMail(tx, messageId);
    if (!mail) throw new ReviewImportError("Email não encontrado.");
    // Trinco: todas as cópias deste email (a mesma mensagem noutra conta), pela ordem do id.
    await tx.execute(sql`SELECT id FROM mail_messages WHERE rfcMessageId = ${mail.rfcFull} ORDER BY id FOR UPDATE`);
    const found = rowsOf(await tx.execute(sql`SELECT ${REVIEW_COLS} FROM google_reviews
      WHERE sourceEmailId = ${mail.rfcMessageId} ORDER BY id LIMIT 20`));
    if (found.length) return importExisting(tx, found, userId);
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
      fallbackProjectId: opts.fallbackProjectId ?? null,
    });
    if (routed.targetModule !== "review" || !routed.createdId) throw new ReviewImportError("Não foi possível criar a crítica a partir deste email.");
    // O email fica com o caminho dele (→ criticas) e o Message-ID fica reservado (inbound_emails): uma 2.ª cópia
    // do mesmo email (outra conta, nova tentativa) liga-se a esta crítica e nunca cria outra.
    const target = routed.targetId ?? routed.createdId;
    await tx.execute(sql`UPDATE mail_messages SET pipeline = 'criticas', pipelineStatus = 'processed', pipelineError = NULL WHERE id = ${mail.id}`);
    await tx.execute(sql`INSERT IGNORE INTO inbound_emails (messageId, alias, fromName, fromEmail, subject, targetModule, targetId, status, receivedAt)
      VALUES (${mail.rfcFull}, 'criticas', ${mail.fromName ? mail.fromName.slice(0, 255) : null}, ${mail.fromEmail ? mail.fromEmail.slice(0, 320) : null},
        ${mail.subject.slice(0, 500)}, 'review', ${target}, 'processed', ${mail.sentAt})`);
    await tx.execute(sql`UPDATE inbound_emails SET targetModule = 'review', targetId = ${target}
      WHERE messageId = ${mail.rfcFull} AND targetModule IN ('review_off', 'not_review', 'review_summary', 'ignored')`);
    return {
      status: "created", reviewId: target, duplicateOf: routed.duplicateOf ?? null,
      followUp: { id: routed.createdId, sourceEmailDate: routed.sourceEmailDate ?? null, messageId: mail.rfcMessageId, duplicateOf: routed.duplicateOf ?? null },
    } as Outcome;
  });
  if (out.log) {
    const { logActivity } = await import("./db");
    await logActivity({ userId, action: "review_email_import", entity: "google_review", entityId: out.log.entityId, details: out.log.details } as any).catch(() => {});
  }
  if (out.followUp) {
    const { reviewEmailFollowUps } = await import("./jobs/emailInboundSync");
    await reviewEmailFollowUps({ ...out.followUp, manualBy: userId });
  }
  if (out.status === "already") return { status: "already", reviewId: out.reviewId };
  return { status: out.status, reviewId: out.reviewId, duplicateOf: out.duplicateOf };
}

/**
 * As críticas dos emails desta lista de Message-IDs (para a conversa mostrar
 * "Nas Críticas (#N)" ou "Importar para as Críticas"). `id` é a crítica que se
 * trata (a original, quando a do email é repetida). Nunca lança.
 */
export async function reviewsOfMessageIds(rfcIds: readonly string[]): Promise<Map<string, { id: number; inCriticas: boolean }>> {
  const out = new Map<string, { id: number; inCriticas: boolean }>();
  const ids = [...new Set(rfcIds.map((x) => String(x ?? "").trim()).filter(Boolean))].slice(0, 200);
  if (!ids.length) return out;
  // A crítica guarda só o início do Message-ID (`sourceEmailId`): a mesma chave para procurar.
  const asked = new Map<string, string[]>();
  for (const id of ids) asked.set(sourceKey(id), [...(asked.get(sourceKey(id)) ?? []), id]);
  try {
    const db = await getDb();
    if (!db) return out;
    const rows = rowsOf(await db.execute(sql`SELECT id, sourceEmailId, googleReviewKey, emailImportedAt, notAReview, duplicateOf FROM google_reviews
      WHERE sourceEmailId IN (${sql.join([...asked.keys()].map((i) => sql`${i}`), sql`, `)}) ORDER BY id`));
    for (const r of rows) {
      // Conta: não é «não é crítica» e não ficou só no email (a repetida conta pela original).
      const inCriticas = !isOn(r.notAReview) && !isEmailOnlyReview(r);
      const shown = { id: r.duplicateOf != null ? Number(r.duplicateOf) : Number(r.id), inCriticas };
      for (const k of asked.get(String(r.sourceEmailId)) ?? []) {
        const prev = out.get(k);
        // Uma que conta ganha a uma cópia que ficou fora.
        if (!prev || (!prev.inCriticas && inCriticas)) out.set(k, shown);
      }
    }
  } catch (err: any) {
    console.warn("[Críticas] críticas dos emails da conversa:", String(err?.message ?? err).slice(0, 160));
  }
  return out;
}
