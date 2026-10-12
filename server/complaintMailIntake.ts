/**
 * Lote 57 (Jorge, 12 out 2026): "mesmo que o email não tenha ido para as
 * reclamações, se a IA vê que é uma reclamação, envia para lá".
 *
 * Porque é que não chegavam: a IA que separa os emails (#351,
 * server/commsRouting.ts) MOVIA a conversa para a caixa "Reclamações" da
 * Comunicação, mas mover não corre o pipeline dessa caixa (ao contrário do RH,
 * que corre o do recrutamento) — a reclamação nunca nascia na página das
 * Reclamações. E se corresse, o pipeline mandava o aviso de receção ao
 * cliente, o que a IA nunca pode fazer sozinha.
 *
 * Agora, quando essa leitura diz "reclamacoes" (regras em
 * shared/complaintIntake.ts):
 *  - certeza alta → cria a reclamação pelo MESMO pipeline das reclamações
 *    (anexos, fotos, reserva ligada, aviso interno no sino), mas SEM aviso de
 *    receção ao cliente, com origem "ia" e com a nota "Criada pela IA… caixa…
 *    motivo"; ou junta o email à reclamação aberta da mesma conversa / do
 *    mesmo cliente / da mesma reserva (nunca só pelo nome ou assunto);
 *  - menos certeza → fica a sugestão "Parece uma reclamação → Criar
 *    reclamação" na página das Reclamações (uma pessoa decide);
 *  - nunca para emails internos, automáticos, de parceiros, newsletters ou
 *    avisos de avaliações.
 * Uma conversa = UMA linha em complaint_mail_intake (threadId UNIQUE): o cron
 * a correr outra vez nunca cria outra reclamação; o Message-ID reservado em
 * inbound_emails também impede que o mesmo email dê dois casos. O email fica
 * na caixa onde está (nada se move nem apaga por causa disto).
 *
 * Interruptor: AI_MAIL_COMPLAINTS (ligado por omissão). Usa a leitura da IA
 * das caixas (AI_MAIL_ROUTING) — não há uma 2.ª chamada à IA.
 */
import { sql } from "drizzle-orm";
import {
  COMPLAINT_INTAKE_BOX, COMPLAINT_INTAKE_FLAG, complaintIntakeDecision, complaintIntakeSettings, intakeNote, isPartnerSender,
  type ComplaintIntakeSettings, type IntakeFacts, type IntakeSkipReason, type IntakeStatus,
} from "../shared/complaintIntake";
import { clientThreadAllowed, clientThreadLink, visibleSharedBoxes } from "../shared/complaintClientMail";
import { isAutomatedSender, isCompanyAddress, type MailViewer } from "../shared/mail";
import type { ParsedGmailMessage } from "./mail/parse";
import type { GmailApi } from "./mail/gmailApi";

const rowsOf = (r: any): any[] => (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : Array.isArray(r) ? r : []);
const affected = (r: any): number => Number((Array.isArray(r) ? r[0] : r)?.affectedRows ?? 0);
const nowStr = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

async function database() {
  const { getDb } = await import("./db");
  const d = await getDb();
  if (!d) throw new Error("Base de dados indisponível.");
  return d;
}

// ─── Tipos ───────────────────────────────────────────────────────────────────

/** A mensagem que a IA leu (a que abre a conversa) — o mesmo que EmailRoutingMessage. */
export interface IntakeMessage {
  threadId: number;
  messageId: number;
  /** Caixa por onde entrou (antes de a IA a mover). */
  fromBoxKey: string;
  subject: string;
  text: string;
  fromName: string | null;
  fromEmail: string | null;
  projectId: number | null;
}

export interface IntakeVerdict { aiBoxKey: string | null; confidence: number | null; reason: string | null }

export type IntakeResult =
  | { status: "off" | "ignored" | "seen" | "suggested" }
  | { status: "skipped"; why: IntakeSkipReason }
  | { status: "created" | "linked"; complaintId: number }
  | { status: "failed"; error: string };

export interface CreateOrLinkInput {
  threadId: number;
  messageId: number;
  boxLabel: string;
  verdict: IntakeVerdict;
  /** Quem carregou em "Criar reclamação" (null = a IA, sozinha). */
  actor: { id: number; name: string | null } | null;
  projectId: number | null;
}

export type CreateOrLinkOutcome =
  | { complaintId: number; isNew: boolean; already?: boolean }
  | { ignored: true; why: IntakeSkipReason };

export interface IntakePatch {
  status: IntakeStatus;
  complaintId?: number | null;
  skipReason?: IntakeSkipReason | null;
  error?: string | null;
  decidedById?: number | null;
}

export interface IntakeDeps {
  enabled(): Promise<boolean>;
  settings(): Promise<ComplaintIntakeSettings>;
  /** Os factos da mensagem (remetente, automático, parceiro…) + a etiqueta da caixa por onde entrou. */
  facts(msg: IntakeMessage): Promise<IntakeFacts & { boxLabel: string; uncertain?: boolean }>;
  /** Reserva a conversa (INSERT IGNORE, threadId UNIQUE): false = já foi decidida antes. */
  claim(row: { msg: IntakeMessage; verdict: IntakeVerdict; status: IntakeStatus; skipReason: IntakeSkipReason | null }): Promise<boolean>;
  record(threadId: number, patch: IntakePatch): Promise<void>;
  createOrLink(input: CreateOrLinkInput): Promise<CreateOrLinkOutcome>;
}

// ─── Núcleo ──────────────────────────────────────────────────────────────────

/**
 * O que a IA das caixas disse sobre a mensagem que abre a conversa →
 * Reclamações. Nunca lança (uma falha fica "failed" e a separação pelas caixas
 * continua); nunca escreve ao cliente.
 */
export async function intakeFromRouting(msg: IntakeMessage, verdict: IntakeVerdict, deps: IntakeDeps = dbIntakeDeps()): Promise<IntakeResult> {
  // Só interessa quando a IA disse "reclamação" — o resto nem toca na BD.
  if (verdict.aiBoxKey !== COMPLAINT_INTAKE_BOX) return { status: "ignored" };
  try {
    if (!(await deps.enabled())) return { status: "off" };
    return await decideAndApply(msg, verdict, deps);
  } catch (err: any) {
    // Nunca parte a separação pelas caixas; o que ficou reservado e falhou volta a ser tentado.
    return { status: "failed", error: String(err?.message ?? err).slice(0, 300) || "erro" };
  }
}

async function decideAndApply(msg: IntakeMessage, verdict: IntakeVerdict, deps: IntakeDeps): Promise<IntakeResult> {
  const [facts, settings] = await Promise.all([deps.facts(msg), deps.settings()]);
  let decision = complaintIntakeDecision(verdict, facts, settings);
  if (decision.action === "ignore") return { status: "ignored" };
  // Não se conseguiu confirmar tudo (ex.: a lista de parceiros não respondeu): só sugere.
  if (decision.action === "create" && facts.uncertain) decision = { action: "suggest" };
  const status: IntakeStatus = decision.action === "create" ? "creating" : decision.action === "suggest" ? "suggested" : "skipped";
  const skipReason = decision.action === "skip" ? decision.why : null;
  if (!(await deps.claim({ msg, verdict, status, skipReason }))) return { status: "seen" };
  if (decision.action === "skip") return { status: "skipped", why: decision.why };
  if (decision.action === "suggest") return { status: "suggested" };
  return createNow(deps, { threadId: msg.threadId, messageId: msg.messageId, boxLabel: facts.boxLabel, verdict, actor: null, projectId: msg.projectId });
}

/** Cria/junta já e regista o resultado (a conversa já está reservada como "creating"). */
async function createNow(deps: Pick<IntakeDeps, "record" | "createOrLink">, input: CreateOrLinkInput): Promise<IntakeResult> {
  try {
    const out = await deps.createOrLink(input);
    if ("ignored" in out) {
      await deps.record(input.threadId, { status: "skipped", skipReason: out.why, decidedById: input.actor?.id ?? null });
      return { status: "skipped", why: out.why };
    }
    const status = out.isNew ? "created" : "linked";
    await deps.record(input.threadId, { status, complaintId: out.complaintId, error: null, decidedById: input.actor?.id ?? null });
    return { status, complaintId: out.complaintId };
  } catch (err: any) {
    const error = String(err?.message ?? err).slice(0, 300) || "erro";
    await deps.record(input.threadId, { status: "failed", error, decidedById: input.actor?.id ?? null }).catch(() => {});
    return { status: "failed", error };
  }
}

// ─── Dependências reais ─────────────────────────────────────────────────────

async function intakeEnabled(): Promise<boolean> {
  const { ensureFeatureFlagOverrides, isFeatureEnabled } = await import("./_core/featureFlags");
  const { automationFlagDefault } = await import("../shared/appSettings");
  await ensureFeatureFlagOverrides().catch(() => {});
  return isFeatureEnabled(COMPLAINT_INTAKE_FLAG, { defaultEnabled: automationFlagDefault(COMPLAINT_INTAKE_FLAG) });
}

async function intakeSettings(): Promise<ComplaintIntakeSettings> {
  try {
    const { getSetting } = await import("./appSettings");
    return complaintIntakeSettings(await getSetting("ai.mailComplaints"));
  } catch {
    return complaintIntakeSettings(null);
  }
}

/**
 * Emails dos contactos das parcerias (parcerias + ligações do CRM aos
 * parceiros). Lança se a BD falhar. Também usado pelos "Emails do cliente"
 * (server/complaintClientMail.ts): o email de um parceiro nunca identifica um cliente.
 */
export async function partnerEmails(d: any): Promise<string[]> {
  const a = rowsOf(await d.execute(sql`SELECT contactEmail AS e FROM partnerships WHERE contactEmail IS NOT NULL AND contactEmail <> '' AND archivedAt IS NULL LIMIT 2000`));
  let b: any[] = [];
  try {
    b = rowsOf(await d.execute(sql`SELECT contactEmail AS e FROM crm_partner_links WHERE contactEmail IS NOT NULL AND contactEmail <> '' LIMIT 2000`));
  } catch { /* tabela opcional */ }
  return [...a, ...b].map((r) => String(r.e ?? "")).filter(Boolean);
}

async function factsOf(msg: IntakeMessage): Promise<IntakeFacts & { boxLabel: string; uncertain?: boolean }> {
  const d = await database();
  const r = rowsOf(await d.execute(sql`SELECT m.direction, m.automated, m.fromEmail, m.subject, LEFT(m.bodyText, 20000) AS bodyText,
      t.mailboxKey, t.ownerUserId
    FROM mail_messages m JOIN mail_threads t ON t.id = m.threadId WHERE m.id = ${msg.messageId} LIMIT 1`))[0] ?? {};
  const { getMailbox, loadBrandDomains } = await import("./mail/store");
  const [box, brandDomains] = await Promise.all([getMailbox(msg.fromBoxKey), loadBrandDomains()]);
  const sender = String(r.fromEmail ?? msg.fromEmail ?? "").trim() || null;
  let senderIsPartner = false;
  let uncertain = false;
  try { senderIsPartner = isPartnerSender(sender, await partnerEmails(d)); } catch { uncertain = true; }
  const automated = Number(r.automated ?? 0);
  return {
    fromBoxKey: msg.fromBoxKey || null,
    fromBoxPipeline: box?.pipeline ?? null,
    outbound: r.direction === "out",
    automated: automated !== 0,
    systemMail: automated === 3,
    personal: r.mailboxKey == null && r.ownerUserId != null,
    senderIsCompany: !!sender && isCompanyAddress(sender, brandDomains),
    senderIsAutomated: !!sender && isAutomatedSender(sender),
    senderIsPartner,
    subject: String(r.subject ?? msg.subject ?? ""),
    text: String(r.bodyText ?? msg.text ?? ""),
    senderEmail: sender,
    boxLabel: box?.label ?? msg.fromBoxKey,
    uncertain,
  };
}

async function claimRow(row: { msg: IntakeMessage; verdict: IntakeVerdict; status: IntakeStatus; skipReason: IntakeSkipReason | null }): Promise<boolean> {
  const d = await database();
  const reason = String(row.verdict.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || null;
  const res = await d.execute(sql`INSERT IGNORE INTO complaint_mail_intake (threadId, messageId, fromBoxKey, aiBoxKey, confidence, reason, status, skipReason, projectId, decidedAt)
    VALUES (${row.msg.threadId}, ${row.msg.messageId}, ${row.msg.fromBoxKey || null}, ${row.verdict.aiBoxKey}, ${row.verdict.confidence}, ${reason},
      ${row.status}, ${row.skipReason}, ${row.msg.projectId}, ${row.status === "suggested" || row.status === "skipped" ? nowStr() : null})`);
  return affected(res) === 1;
}

async function recordRow(threadId: number, p: IntakePatch): Promise<void> {
  const d = await database();
  await d.execute(sql`UPDATE complaint_mail_intake SET status = ${p.status},
      complaintId = COALESCE(${p.complaintId ?? null}, complaintId),
      skipReason = ${p.skipReason ?? null},
      error = ${p.error ?? null},
      attempts = attempts + ${p.status === "failed" || p.status === "created" || p.status === "linked" ? 1 : 0},
      decidedById = COALESCE(${p.decidedById ?? null}, decidedById),
      decidedAt = ${nowStr()}
    WHERE threadId = ${threadId}`);
}

/**
 * Cria a reclamação (ou junta o email a uma aberta) pelo pipeline das
 * reclamações, com `aiIntake` (sem aviso de receção; agrupar estrito; origem
 * "ia"). `ctx` traz o email já lido na sincronização; sem ele vai buscá-lo ao Gmail.
 */
export async function createOrLinkFromThread(
  input: CreateOrLinkInput,
  ctx: { parsed?: ParsedGmailMessage | null; api?: Pick<GmailApi, "getAttachment" | "getMessage"> | null } = {},
): Promise<CreateOrLinkOutcome> {
  const d = await database();
  const m = rowsOf(await d.execute(sql`SELECT m.id, m.threadId, m.accountKey, m.gmailMessageId FROM mail_messages m WHERE m.id = ${input.messageId} LIMIT 1`))[0];
  if (!m) throw new Error("O email já não está na Comunicação.");
  let api = ctx.api ?? null;
  let parsed = ctx.parsed ?? null;
  if (!parsed || !api) {
    const { gmailApiForAccount } = await import("./mail/gmailApi");
    api = api ?? await gmailApiForAccount(String(m.accountKey));
  }
  if (!parsed) {
    const raw = await api!.getMessage(String(m.gmailMessageId));
    if (!raw) throw new Error("O email já não está no Gmail.");
    const { parseGmailMessage } = await import("./mail/parse");
    parsed = parseGmailMessage(raw);
  }
  const { gmailThreadIdToImap } = await import("./mail/parse");
  const { processInboundEmail } = await import("./jobs/emailInboundSync");
  const p = parsed;
  const messageKey = p.rfcMessageId || `gmail:${String(m.accountKey)}:${String(m.gmailMessageId)}`;
  const out = await processInboundEmail({
    alias: "reclamacoes",
    messageId: messageKey,
    gmThreadId: gmailThreadIdToImap(p.gmailThreadId),
    refs: [...(p.inReplyTo ? [p.inReplyTo] : []), ...p.references],
    fromName: p.fromName ?? undefined,
    fromEmail: p.fromEmail ?? undefined,
    subject: p.subject,
    receivedAt: p.sentAt,
    text: p.text || null,
    html: p.html || null,
    loadAttachments: async () => {
      const list = [];
      for (const a of p.attachments.slice(0, 10)) {
        if (!a.attachmentId || a.size > 15 * 1024 * 1024) { list.push({ filename: a.filename, contentType: a.mimeType, size: a.size, content: null, related: a.inline }); continue; }
        const content = await api!.getAttachment(p.gmailMessageId, a.attachmentId).catch(() => null);
        list.push({ filename: a.filename, contentType: a.mimeType, size: content?.length ?? a.size, content, related: a.inline });
      }
      return list;
    },
    aiIntake: { actorId: input.actor?.id ?? null, projectId: input.projectId },
  });
  const { setMessagePipeline, addAutoLink, setThreadProjectIfEmpty } = await import("./mail/store");
  let complaintId: number | null = null;
  let isNew = false;
  let already = false;
  if (out.status === "processed") {
    await setMessagePipeline(input.messageId, "reclamacoes", "processed").catch(() => {});
    if (out.routed.targetModule !== "complaint" || !out.routed.targetId) return { ignored: true, why: "ignored_rule" };
    complaintId = Number(out.routed.targetId);
    isNew = !!out.routed.isNew;
  } else if (out.status === "duplicate") {
    // O mesmo email já foi tratado (ex.: veio também para reclamacoes@): liga-se ao caso que existe, sem repetir a mensagem.
    const { getInboundEmailByMessageId } = await import("./db");
    const row: any = await getInboundEmailByMessageId(messageKey);
    if (row?.targetModule !== "complaint" || !row?.targetId) return { ignored: true, why: "ignored_rule" };
    complaintId = Number(row.targetId);
    already = true;
  } else {
    await setMessagePipeline(input.messageId, "reclamacoes", "skipped").catch(() => {});
    return { ignored: true, why: "automatic" };
  }
  // A reclamação já existe: o que se segue é complemento — uma falha aqui não a
  // dá como "falhada" (uma nova tentativa só a voltaria a ligar).
  const warn = (what: string) => (err: unknown) => console.warn(`[reclamações IA] ${what} (conversa ${input.threadId}):`, String((err as any)?.message ?? err).slice(0, 160));
  await addAutoLink({
    threadId: input.threadId, messageId: input.messageId, entityType: "complaint", entityId: String(complaintId), confidence: 100,
    reason: isNew ? "reclamação criada pela IA (outra caixa)" : "email junto pela IA a esta reclamação",
  }).catch(warn("ligar a conversa"));
  const { getComplaintById, addComplaintMessage, logActivity } = await import("./db");
  const c: any = await getComplaintById(complaintId).catch(() => null);
  await setThreadProjectIfEmpty(input.threadId, c?.projectId ?? null).catch(warn("cidade da conversa"));
  if (!already) {
    await addComplaintMessage({
      complaintId, isInternal: 1, authorId: input.actor?.id ?? null, authorName: input.actor?.name ?? "IA",
      message: intakeNote(isNew ? "created" : "linked", { boxLabel: input.boxLabel, reason: input.verdict.reason, confidence: input.verdict.confidence, by: input.actor?.name ?? null }),
    } as any).catch(warn("nota da IA"));
    await logActivity({
      userId: input.actor?.id ?? 0, action: isNew ? "create" : "update", entity: "complaint", entityId: complaintId,
      details: `${isNew ? "Reclamação criada" : "Email junto à reclamação"} pela IA — email da caixa ${input.boxLabel} (conversa ${input.threadId})`,
      source: input.actor ? "ui" : "system",
    } as any).catch(() => {});
  }
  return { complaintId, isNew, already };
}

/** Dependências reais (com o email já lido na sincronização, quando há). */
export function dbIntakeDeps(ctx: { parsed?: ParsedGmailMessage | null; api?: Pick<GmailApi, "getAttachment" | "getMessage"> | null } = {}): IntakeDeps {
  return {
    enabled: intakeEnabled,
    settings: intakeSettings,
    facts: factsOf,
    claim: claimRow,
    record: recordRow,
    createOrLink: (input) => createOrLinkFromThread(input, ctx),
  };
}

// ─── Respostas do cliente numa conversa que a IA ligou ──────────────────────

/** Reclamação que a IA criou/ligou a esta conversa (para as respostas do cliente irem para lá). Nunca lança. */
export async function intakeComplaintOfThread(threadId: number): Promise<number | null> {
  try {
    if (!(await intakeEnabled())) return null;
    return (await intakeOfThread(threadId))?.complaintId ?? null;
  } catch {
    return null;
  }
}

/**
 * A conversa foi vista pela IA das reclamações? (seja qual for o interruptor)
 * — a nova tentativa de uma resposta que falhou usa isto para nunca correr o
 * pipeline "normal" (que podia criar outra reclamação e mandar o aviso de
 * receção). Lança se a BD falhar.
 */
export async function intakeOfThread(threadId: number): Promise<{ complaintId: number | null } | null> {
  const d = await database();
  const r = rowsOf(await d.execute(sql`SELECT complaintId, status FROM complaint_mail_intake WHERE threadId = ${threadId} LIMIT 1`))[0];
  if (!r) return null;
  return { complaintId: r.complaintId != null && (r.status === "created" || r.status === "linked") ? Number(r.complaintId) : null };
}

// ─── Página das Reclamações: sugestões ("Parece uma reclamação") ─────────────

export interface MailSuggestion {
  id: number;
  threadId: number;
  status: "suggested" | "failed";
  boxKey: string | null;
  boxLabel: string;
  fromBoxLabel: string;
  subject: string;
  snippet: string;
  contactEmail: string | null;
  contactName: string | null;
  confidence: number | null;
  reason: string | null;
  error: string | null;
  at: string | null;
  link: string;
}

/** Quantos dias uma sugestão fica à vista. */
export const SUGGESTION_DAYS = 30;

/**
 * Sugestões por decidir (e as que falharam a criar) das conversas que a pessoa
 * vê (caixa partilhada + cidade). Erro → lança (a página diz que falhou).
 */
export async function listMailSuggestions(viewer: MailViewer, scopeIds: number[] | undefined): Promise<MailSuggestion[]> {
  const d = await database();
  const { listMailboxes } = await import("./mail/store");
  const boxes = await listMailboxes();
  const access = visibleSharedBoxes(viewer, boxes, scopeIds);
  if (!access.length) return [];
  const since = nowStr(Date.now() - SUGGESTION_DAYS * 86_400_000);
  const rows = rowsOf(await d.execute(sql`SELECT i.id, i.threadId, i.status, i.fromBoxKey, i.confidence, i.reason, i.error,
      DATE_FORMAT(i.createdAt, '%Y-%m-%d %H:%i:%s') AS at,
      t.mailboxKey, t.projectId, t.ownerUserId, t.archivedAt, t.automated, t.subject, t.snippet, t.contactEmail, t.contactName
    FROM complaint_mail_intake i JOIN mail_threads t ON t.id = i.threadId
    WHERE i.status IN ('suggested', 'failed') AND i.createdAt >= ${since}
    ORDER BY i.id DESC LIMIT 100`));
  const label = (k: string | null) => (k ? boxes.find((b) => b.key === k)?.label ?? k : "—");
  return rows
    .filter((r) => clientThreadAllowed({ id: Number(r.threadId), mailboxKey: r.mailboxKey ?? null, projectId: r.projectId != null ? Number(r.projectId) : null, ownerUserId: r.ownerUserId ?? null, archivedAt: r.archivedAt ?? null, automated: r.automated }, access))
    .slice(0, 50)
    .map((r) => ({
      id: Number(r.id), threadId: Number(r.threadId), status: r.status === "failed" ? "failed" as const : "suggested" as const,
      boxKey: r.mailboxKey ?? null, boxLabel: label(r.mailboxKey ?? null), fromBoxLabel: label(r.fromBoxKey ?? null),
      subject: String(r.subject ?? "") || "(sem assunto)", snippet: String(r.snippet ?? ""),
      contactEmail: r.contactEmail ?? null, contactName: r.contactName ?? null,
      confidence: r.confidence != null ? Number(r.confidence) : null, reason: r.reason ?? null, error: r.error ?? null,
      at: r.at ?? null, link: clientThreadLink({ id: Number(r.threadId), mailboxKey: r.mailboxKey ?? null }),
    }));
}

export class IntakeActionError extends Error {
  constructor(message: string, readonly code: "NOT_FOUND" | "CONFLICT" | "BAD_REQUEST") { super(message); }
}

async function loadIntake(id: number): Promise<any> {
  const d = await database();
  const r = rowsOf(await d.execute(sql`SELECT i.id, i.threadId, i.messageId, i.fromBoxKey, i.aiBoxKey, i.confidence, i.reason, i.status, i.complaintId, i.projectId,
      i.decidedById, u.name AS decidedByName, DATE_FORMAT(i.updatedAt, '%Y-%m-%d %H:%i:%s') AS updatedAt
    FROM complaint_mail_intake i LEFT JOIN users u ON u.id = i.decidedById WHERE i.id = ${id} LIMIT 1`))[0];
  if (!r) throw new IntakeActionError("Sugestão não encontrada.", "NOT_FOUND");
  return r;
}

/**
 * "Criar reclamação" numa sugestão (ou "Tentar de novo" numa que falhou). Quem
 * chama já confirmou o acesso à conversa e à edição das reclamações. Uma só
 * vez: dois cliques ao mesmo tempo nunca dão duas reclamações.
 */
export async function createFromSuggestion(
  id: number,
  actor: { id: number; name: string | null },
  deps: Pick<IntakeDeps, "record" | "createOrLink"> = dbIntakeDeps(),
  /** Cidade de quem cria quando nem a conversa nem a reserva a dão (senão a reclamação desaparecia-lhe da lista). */
  fallbackProjectId: number | null = null,
): Promise<{ complaintId: number; isNew: boolean; already: boolean }> {
  const row = await loadIntake(id);
  if (row.complaintId && (row.status === "created" || row.status === "linked")) return { complaintId: Number(row.complaintId), isNew: false, already: true };
  const d = await database();
  const stale = nowStr(Date.now() - 10 * 60_000);
  const res = await d.execute(sql`UPDATE complaint_mail_intake SET status = 'creating', decidedById = ${actor.id}
    WHERE id = ${id} AND (status IN ('suggested', 'failed') OR (status = 'creating' AND updatedAt < ${stale}))`);
  if (affected(res) !== 1) {
    const cur = await loadIntake(id);
    if (cur.complaintId) return { complaintId: Number(cur.complaintId), isNew: false, already: true };
    if (cur.status === "dismissed") throw new IntakeActionError("Esta sugestão já foi marcada como \"Não é reclamação\".", "CONFLICT");
    throw new IntakeActionError("A reclamação desta conversa já está a ser criada — espera um pouco.", "CONFLICT");
  }
  const { getMailbox } = await import("./mail/store");
  const boxLabel = (await getMailbox(row.fromBoxKey).catch(() => null))?.label ?? String(row.fromBoxKey ?? "—");
  const r = await createNow(deps, {
    threadId: Number(row.threadId), messageId: Number(row.messageId), boxLabel,
    verdict: { aiBoxKey: row.aiBoxKey ?? null, confidence: row.confidence != null ? Number(row.confidence) : null, reason: row.reason ?? null },
    actor, projectId: row.projectId != null ? Number(row.projectId) : fallbackProjectId,
  });
  if (r.status === "created" || r.status === "linked") return { complaintId: r.complaintId, isNew: r.status === "created", already: false };
  if (r.status === "failed") throw new IntakeActionError(`Não foi possível criar a reclamação: ${r.error}`, "BAD_REQUEST");
  throw new IntakeActionError("Este email não dá uma reclamação (regras das reclamações: eco interno, auto-fatura ou aviso automático).", "BAD_REQUEST");
}

/** "Não é reclamação": marca (nada se apaga). */
export async function dismissSuggestion(id: number, actor: { id: number }, reason: string | null): Promise<void> {
  await loadIntake(id);
  const d = await database();
  const res = await d.execute(sql`UPDATE complaint_mail_intake SET status = 'dismissed', decidedById = ${actor.id}, decidedAt = ${nowStr()},
      dismissReason = ${String(reason ?? "").trim().slice(0, 255) || null}
    WHERE id = ${id} AND status IN ('suggested', 'failed')`);
  if (affected(res) !== 1) throw new IntakeActionError("Esta sugestão já foi decidida.", "CONFLICT");
}

/** Thread da sugestão (para o router confirmar o acesso antes de agir). */
export async function suggestionThreadId(id: number): Promise<number> {
  return Number((await loadIntake(id)).threadId);
}

// ─── Nova tentativa automática (varrimento ai-comms) ────────────────────────

export const INTAKE_MAX_ATTEMPTS = 3;

/** As criações que falharam (Gmail/BD em baixo) voltam a ser tentadas — no máximo 3 vezes, só nos últimos 2 dias. */
export async function retryFailedIntakes(opts: { limit?: number; deadlineAt?: number } = {}, deps: IntakeDeps = dbIntakeDeps()): Promise<{ retried: number; created: number; skipped?: string }> {
  const out: { retried: number; created: number; skipped?: string } = { retried: 0, created: 0 };
  if (!(await deps.enabled())) return { ...out, skipped: "disabled" };
  const d = await database();
  const since = nowStr(Date.now() - 2 * 86_400_000);
  // "creating" há mais de 10 min = a corrida morreu a meio (o Message-ID reservado impede um 2.º caso).
  const stale = nowStr(Date.now() - 10 * 60_000);
  const rows = rowsOf(await d.execute(sql`SELECT id FROM complaint_mail_intake
    WHERE (status = 'failed' OR (status = 'creating' AND updatedAt < ${stale})) AND attempts < ${INTAKE_MAX_ATTEMPTS} AND createdAt >= ${since}
    ORDER BY id LIMIT ${Math.max(1, Math.min(5, opts.limit ?? 2))}`));
  for (const r of rows) {
    if (opts.deadlineAt != null && Date.now() + 15_000 > opts.deadlineAt) { out.skipped = "deadline"; break; }
    const row = await loadIntake(Number(r.id));
    const res = await d.execute(sql`UPDATE complaint_mail_intake SET status = 'creating'
      WHERE id = ${row.id} AND (status = 'failed' OR (status = 'creating' AND updatedAt < ${stale}))`);
    if (affected(res) !== 1) continue;
    const { getMailbox } = await import("./mail/store");
    const boxLabel = (await getMailbox(row.fromBoxKey).catch(() => null))?.label ?? String(row.fromBoxKey ?? "—");
    const result = await createNow(deps, {
      threadId: Number(row.threadId), messageId: Number(row.messageId), boxLabel,
      verdict: { aiBoxKey: row.aiBoxKey ?? null, confidence: row.confidence != null ? Number(row.confidence) : null, reason: row.reason ?? null },
      // Se foi uma pessoa a pedir (sugestão aceite), a reclamação continua a ser dela.
      actor: row.decidedById != null ? { id: Number(row.decidedById), name: row.decidedByName ?? null } : null,
      projectId: row.projectId != null ? Number(row.projectId) : null,
    });
    out.retried++;
    if (result.status === "created" || result.status === "linked") out.created++;
  }
  return out;
}
