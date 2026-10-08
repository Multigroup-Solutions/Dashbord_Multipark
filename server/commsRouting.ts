/**
 * A IA separa emails e WhatsApp pelas caixas — UM só encaminhador (lote 41
 * ponto 13 + decisão do Jorge, 8 out 2026). Regras puras: shared/commsRouting.ts.
 *
 * Email (caixas PARTILHADAS — nunca as pessoais): cada mensagem que ABRE uma
 * conversa é lida uma vez (registo `comms_ai_routing`, sourceRef UNIQUE) e a
 * conversa vai para a caixa do tema, por ler. Não percebeu (geral, confiança
 * abaixo do limiar) ou a IA falhou → caixa do info. Uma resposta num fio que já
 * está numa caixa fica onde está. Corre na sincronização (logo) até ao teto por
 * corrida; o que sobra fica "pending" e o varrimento ai-comms trata.
 *
 * WhatsApp: a intenção vem da triagem (server/whatsappTriage.ts — UMA chamada à
 * IA, nunca outra aqui). Conversa que já tem caixa (ou antiga) fica onde está;
 * conversa nova → caixa do tema (ou Geral quando não percebeu).
 *
 * Recrutamento em 1.º contacto → lead + candidatura (server/recruitmentFirstContact.ts).
 *
 * Interruptor: AI_MAIL_ROUTING (feature `mail_routing`). Nunca responde a
 * ninguém; nunca apaga nada.
 */
import { sql } from "drizzle-orm";
import {
  commsRoutingSettings, decideRoutedBox, normalizeCandidate, routingNoteText, whatsappRoutingPlan,
  ROUTING_BODY_MAX, ROUTING_SUBJECT_MAX, type CandidateData, type CommsRoutingSettings,
} from "../shared/commsRouting";
import { GENERAL_BOX_KEY, availableTargets } from "../shared/commsBoxes";
import { CITY_LABELS, cityKeyFromText } from "../shared/city";
import { isAutomatedSender } from "../shared/extraLeadsFunnel";
import type { WhatsappIntent } from "../shared/commsAi";
import type { FirstContactInput, FirstContactResult } from "./recruitmentFirstContact";
import type { MailRoutingOutput } from "./_core/ai/prompts/comms";

const nowStr = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const rowsOf = (r: any): any[] => (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : Array.isArray(r) ? r : []);
const affected = (r: any): number => Number((Array.isArray(r) ? r[0] : r)?.affectedRows ?? 0);

async function database() {
  const { getDb } = await import("./db");
  const d = await getDb();
  if (!d) throw new Error("Base de dados indisponível");
  return d;
}

/** Caixa (só o que interessa aqui). */
export interface BoxLite { key: string; label: string; active: boolean; pipeline?: string | null }

// ─── Dependências (injetáveis nos testes) ────────────────────────────────────

export interface EmailRoutingMessage {
  threadId: number;
  messageId: number;
  fromBoxKey: string;
  subject: string;
  text: string;
  fromName: string | null;
  fromEmail: string | null;
  attachmentNames: string[];
  /** Cidade da conversa (alias/ligações), se houver. */
  projectId: number | null;
}

export interface ClassifiedEmail { output: MailRoutingOutput; restore: (s: string) => string }

export interface EmailRoutingDeps {
  enabled(): Promise<boolean>;
  settings(): Promise<CommsRoutingSettings>;
  boxes(): Promise<BoxLite[]>;
  /** Reserva a mensagem (INSERT IGNORE): false = já foi lida antes. */
  claim(msg: EmailRoutingMessage): Promise<boolean>;
  classify(msg: EmailRoutingMessage, targets: ReadonlyArray<{ key: string; hint: string }>, fromLabel: string): Promise<ClassifiedEmail>;
  /** Move a conversa (sem a marcar como lida). false = já não estava lá. */
  move(threadId: number, boxKey: string): Promise<boolean>;
  record(messageId: number, patch: DecisionPatch): Promise<void>;
  firstContact(input: FirstContactInput): Promise<FirstContactResult>;
  cityProjectId(text: string | null): Promise<number | null>;
  /** Candidato no RH: pipeline do recrutamento (lista Recrutamento + leitura do CV) e ligação à lead. */
  afterRh(threadId: number, opts: { moved: boolean; leadId: number | null }): Promise<void>;
}

export interface DecisionPatch {
  status: "moved" | "kept" | "failed" | "pending";
  via?: "ai" | "triage" | "rule" | "fallback";
  aiBoxKey?: string | null;
  boxKey?: string | null;
  confidence?: number | null;
  reason?: string | null;
  error?: string | null;
  candidateJson?: string | null;
  recruitOutcome?: string | null;
  leadId?: number | null;
  applicationId?: number | null;
}

export type EmailRoutingResult =
  | { status: "off" | "seen" | "pending" }
  | { status: "moved" | "kept" | "failed"; boxKey: string; recruit?: FirstContactResult | null };

// ─── Email ───────────────────────────────────────────────────────────────────

/**
 * Uma mensagem nova numa caixa partilhada (já filtrada por
 * `emailRoutingEligible`). `run.left` = classificações que ainda cabem nesta
 * corrida; sem espaço (ou sem tempo) fica "pending" para o varrimento.
 */
export async function routeEmailMessage(
  msg: EmailRoutingMessage,
  deps: EmailRoutingDeps = dbEmailRoutingDeps,
  run: { left: number; deadlineAt?: number } = { left: 1 },
): Promise<EmailRoutingResult> {
  if (!(await deps.enabled())) return { status: "off" };
  if (!(await deps.claim(msg))) return { status: "seen" };
  if (run.left <= 0 || (run.deadlineAt != null && Date.now() + 16_000 > run.deadlineAt)) return { status: "pending" };
  run.left--;
  return classifyAndApply(msg, deps);
}

/** Lê com a IA e aplica (mensagem já reservada). Nunca lança por causa da IA. */
export async function classifyAndApply(msg: EmailRoutingMessage, deps: EmailRoutingDeps): Promise<EmailRoutingResult> {
  const [settings, boxes] = await Promise.all([deps.settings(), deps.boxes()]);
  const targets = availableTargets(boxes);
  const fromLabel = boxes.find((b) => b.key === msg.fromBoxKey)?.label ?? msg.fromBoxKey;
  const generalExists = boxes.some((b) => b.key === GENERAL_BOX_KEY && b.active);

  let classified: ClassifiedEmail | null = null;
  let error: string | null = null;
  try {
    classified = await deps.classify(msg, targets, fromLabel);
  } catch (err: any) {
    error = String(err?.code ?? err?.name ?? "erro").slice(0, 60);
  }
  // Desligaram a IA entretanto: não é "não percebeu" — fica onde entrou.
  if (!classified && error === "disabled") {
    await deps.record(msg.messageId, { status: "kept", via: "fallback", boxKey: msg.fromBoxKey, error });
    return { status: "kept", boxKey: msg.fromBoxKey };
  }
  const decision = classified
    ? decideRoutedBox(classified.output, targets, settings)
    : { boxKey: GENERAL_BOX_KEY, aiBoxKey: null, confidence: null, understood: false };
  // Sem caixa do info ativa: fica onde entrou (nunca se perde).
  let target = decision.boxKey;
  if (target === GENERAL_BOX_KEY && !generalExists) target = msg.fromBoxKey;

  let moved = false;
  if (target !== msg.fromBoxKey) moved = await deps.move(msg.threadId, target);
  const finalBox = moved || target === msg.fromBoxKey ? target : msg.fromBoxKey;
  const status: "moved" | "kept" | "failed" = !classified ? "failed" : moved ? "moved" : "kept";

  const reason = classified ? String(classified.output.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || null : null;
  let recruit: FirstContactResult | null = null;
  let candidate: CandidateData | null = null;
  if (classified && decision.understood && finalBox === "rh" && classified.output.candidate === true) {
    candidate = candidateFromEmail(classified, msg);
    try {
      recruit = await deps.firstContact({
        channel: "email", sourceRef: `ai:mail_thread:${msg.threadId}`, candidate,
        projectId: (await deps.cityProjectId(candidate.city)) ?? msg.projectId, reason,
      });
    } catch (err: any) {
      console.warn("[IA caixas] candidato (email) falhou:", msg.threadId, String(err?.message ?? err).slice(0, 160));
    }
  }
  // Candidato: o email entra também na lista do Recrutamento (pipeline do RH,
  // com a leitura do CV) — só candidaturas, não qualquer email do RH.
  if (candidate) {
    await deps.afterRh(msg.threadId, { moved, leadId: recruit?.leadId ?? null }).catch((err: any) =>
      console.warn("[IA caixas] RH (pipeline) falhou:", msg.threadId, String(err?.message ?? err).slice(0, 160)));
  }
  await deps.record(msg.messageId, {
    status, via: classified ? "ai" : "fallback", aiBoxKey: decision.aiBoxKey, boxKey: finalBox, confidence: decision.confidence,
    reason, error, candidateJson: candidate ? JSON.stringify(candidate) : null,
    recruitOutcome: recruit?.outcome ?? null, leadId: recruit?.leadId ?? null, applicationId: recruit?.applicationId ?? null,
  });
  return { status, boxKey: finalBox, recruit };
}

/** Dados do candidato de um email: o que a IA leu + o remetente (quando é uma pessoa). PURA. */
export function candidateFromEmail(c: ClassifiedEmail, msg: Pick<EmailRoutingMessage, "fromName" | "fromEmail">): CandidateData {
  const cand = normalizeCandidate(c.output as unknown as Record<string, unknown>, c.restore);
  const header = String(msg.fromEmail ?? "").trim().toLowerCase();
  // O remetente ganha (é quem escreve), menos portais/no-reply e o nosso domínio.
  const headerIsPerson = !!header && !isAutomatedSender(header);
  const name = String(msg.fromName ?? "").replace(/^["']|["']$/g, "").trim();
  return {
    ...cand,
    email: headerIsPerson ? header : cand.email,
    fullName: cand.fullName ?? (name && !name.includes("@") ? name.slice(0, 120) : null),
  };
}

/** Classificação real (lite): só o 1.º nome, corpo cortado e dados pessoais tapados. */
export async function classifyEmailWithAi(msg: EmailRoutingMessage, targets: ReadonlyArray<{ key: string; hint: string }>, fromLabel: string): Promise<ClassifiedEmail> {
  const { runAi } = await import("./_core/ai/run");
  const { redactPii, firstName } = await import("./_core/ai/pii");
  const { MAIL_ROUTING_SYSTEM, mailRoutingInput, mailRoutingSchema } = await import("./_core/ai/prompts/comms");
  const red = redactPii(`${msg.subject.slice(0, ROUTING_SUBJECT_MAX)}\n${stripQuoted(msg.text).slice(0, ROUTING_BODY_MAX)}`);
  const [subject, ...body] = red.text.split("\n");
  const r = await runAi({
    feature: "mail_routing", system: MAIL_ROUTING_SYSTEM, schema: mailRoutingSchema,
    input: mailRoutingInput({
      targets, subject: subject ?? "", body: body.join("\n"), fromBox: fromLabel,
      senderFirstName: firstName(msg.fromName, ""), attachmentNames: msg.attachmentNames,
    }),
    maxTokens: 700, timeoutMs: 15_000, retries: 1, entity: "mail_thread", entityId: msg.threadId,
  });
  return { output: r.output, restore: red.restore };
}

/** Tira o histórico citado ("> …", "Em … escreveu:") — só a mensagem nova vai à IA. PURA. */
export function stripQuoted(text: string): string {
  const lines = String(text ?? "").split(/\r?\n/);
  const out: string[] = [];
  for (const l of lines) {
    if (/^\s*(On .+ wrote:|Em .+ escreveu:|-----\s*Original Message|De:\s.+|From:\s.+)$/i.test(l) && out.length) break;
    if (/^\s*>/.test(l)) continue;
    out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ─── Email: dependências reais ──────────────────────────────────────────────

async function routingSettings(): Promise<CommsRoutingSettings> {
  try {
    const { getSetting } = await import("./appSettings");
    return commsRoutingSettings(await getSetting("ai.commsRouting"));
  } catch {
    return commsRoutingSettings(null);
  }
}

async function routingEnabled(): Promise<boolean> {
  const { aiFeatureAvailableFresh } = await import("./_core/ai/status");
  return aiFeatureAvailableFresh("mail_routing");
}

async function cityProjectIdOf(text: string | null): Promise<number | null> {
  if (!text) return null;
  try {
    const [{ getProjects }, { cityProjectIdFromText }] = await Promise.all([import("./db"), import("./extraLeadsSync")]);
    return cityProjectIdFromText(text, (await getProjects()) as any);
  } catch {
    return null;
  }
}

export async function recordDecision(sourceRef: string, p: DecisionPatch): Promise<void> {
  const d = await database();
  await d.execute(sql`UPDATE comms_ai_routing SET status = ${p.status}, via = COALESCE(${p.via ?? null}, via),
      aiBoxKey = ${p.aiBoxKey ?? null}, boxKey = ${p.boxKey ?? null}, confidence = ${p.confidence ?? null}, reason = ${p.reason ?? null},
      error = ${p.error ?? null}, candidateJson = ${p.candidateJson ?? null}, recruitOutcome = ${p.recruitOutcome ?? null},
      leadId = ${p.leadId ?? null}, applicationId = ${p.applicationId ?? null}, decidedAt = ${nowStr()}
    WHERE sourceRef = ${sourceRef}`);
}

/** Candidato no RH: corre o pipeline do recrutamento (se a caixa o tiver e o email veio de outra caixa) e liga o email à lead. */
async function afterRhReal(threadId: number, opts: { moved: boolean; leadId: number | null }): Promise<void> {
  const { getMailbox } = await import("./mail/store");
  const { aliasPipeline } = await import("../shared/mail");
  const rh = await getMailbox("rh");
  if (opts.moved && rh && aliasPipeline(rh, null, null) === "recursos-humanos") {
    const { reprocessThreadPipeline } = await import("./mail/service");
    await reprocessThreadPipeline(threadId, rh, null);
  }
  if (opts.leadId == null) return;
  // O email do RH (lista Recrutamento) fica deste candidato: o leitor dos anexos
  // (D39) lê o CV para ESTA lead e a importação de hora a hora não cria outra.
  const d = await database();
  const ids = rowsOf(await d.execute(sql`SELECT rfcMessageId FROM mail_messages WHERE threadId = ${threadId} AND direction = 'in' AND rfcMessageId IS NOT NULL LIMIT 10`))
    .map((r) => String(r.rfcMessageId)).filter(Boolean);
  if (!ids.length) return;
  const emails = rowsOf(await d.execute(sql`SELECT id FROM inbound_emails WHERE alias = 'recursos-humanos' AND messageId IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)}) LIMIT 10`));
  for (const e of emails) {
    await d.execute(sql`INSERT IGNORE INTO extra_lead_sources (sourceRef, leadId, outcome) VALUES (${`email:${e.id}`}, ${opts.leadId}, 'merged')`);
  }
}

export const dbEmailRoutingDeps: EmailRoutingDeps = {
  enabled: routingEnabled,
  settings: routingSettings,
  async boxes() {
    const { listMailboxes } = await import("./mail/store");
    return (await listMailboxes()).map((b) => ({ key: b.key, label: b.label, active: b.active, pipeline: b.pipeline }));
  },
  async claim(msg) {
    const d = await database();
    const res = await d.execute(sql`INSERT IGNORE INTO comms_ai_routing (channel, sourceRef, threadId, messageId, fromBoxKey, via, status)
      VALUES ('email', ${`mail_message:${msg.messageId}`}, ${msg.threadId}, ${msg.messageId}, ${msg.fromBoxKey}, 'ai', 'pending')`);
    return affected(res) === 1;
  },
  classify: classifyEmailWithAi,
  async move(threadId, boxKey) {
    const { moveThreadToBox } = await import("./mail/service");
    return moveThreadToBox(threadId, boxKey, "ai");
  },
  record: (messageId, p) => recordDecision(`mail_message:${messageId}`, p),
  async firstContact(input) {
    const { onRecruitmentFirstContact } = await import("./recruitmentFirstContact");
    return onRecruitmentFirstContact(input);
  },
  cityProjectId: cityProjectIdOf,
  afterRh: afterRhReal,
};

/** Mensagem guardada → o que a IA precisa (BD). null = já não é para separar. */
async function loadEmailMessage(messageId: number): Promise<(EmailRoutingMessage & { routedBy: string | null; mailboxKey: string | null }) | null> {
  const d = await database();
  const r = rowsOf(await d.execute(sql`SELECT m.id, m.threadId, m.subject, m.bodyText, m.snippet, m.fromName, m.fromEmail, m.attachmentsJson,
      t.mailboxKey, t.routedBy, t.projectId
    FROM mail_messages m JOIN mail_threads t ON t.id = m.threadId WHERE m.id = ${messageId} LIMIT 1`))[0];
  if (!r) return null;
  let names: string[] = [];
  try { names = (JSON.parse(String(r.attachmentsJson ?? "[]")) as any[]).map((a) => String(a?.filename ?? "")).filter(Boolean); } catch { /* sem anexos */ }
  return {
    threadId: Number(r.threadId), messageId: Number(r.id), fromBoxKey: String(r.mailboxKey ?? ""), subject: String(r.subject ?? ""),
    text: String(r.bodyText ?? r.snippet ?? ""), fromName: r.fromName ?? null, fromEmail: r.fromEmail ?? null, attachmentNames: names,
    projectId: r.projectId != null ? Number(r.projectId) : null, routedBy: r.routedBy ?? null, mailboxKey: r.mailboxKey ?? null,
  };
}

/**
 * Varrimento (ai-comms, de 15 em 15 min): as mensagens que ficaram "pending"
 * (teto da corrida ou sem tempo). Só as dos últimos 2 dias; uma conversa que
 * alguém já moveu fica como está.
 */
export async function runPendingEmailRoutings(opts: { limit?: number; deadlineAt?: number } = {}, deps: EmailRoutingDeps = dbEmailRoutingDeps): Promise<{ routed: number; skipped?: string }> {
  const out: { routed: number; skipped?: string } = { routed: 0 };
  if (!(await deps.enabled())) return { ...out, skipped: "disabled" };
  const settings = await deps.settings();
  const deadlineAt = opts.deadlineAt ?? Date.now() + 30_000;
  const d = await database();
  const since = nowStr(Date.now() - 2 * 86_400_000);
  const rows = rowsOf(await d.execute(sql`SELECT messageId FROM comms_ai_routing WHERE channel = 'email' AND status = 'pending' AND createdAt >= ${since}
    ORDER BY id LIMIT ${Math.max(1, Math.min(settings.perRun, opts.limit ?? settings.perRun))}`));
  for (const r of rows) {
    if (Date.now() + 16_000 > deadlineAt) { out.skipped = "deadline"; break; }
    const msg = await loadEmailMessage(Number(r.messageId));
    if (!msg || !msg.mailboxKey || msg.routedBy) {
      await deps.record(Number(r.messageId), { status: "kept", via: "rule", boxKey: msg?.mailboxKey ?? null, reason: "já tinha sido movida" });
      continue;
    }
    const res = await classifyAndApply(msg, deps);
    if (res.status !== "failed") out.routed++;
  }
  return out;
}

// ─── WhatsApp ────────────────────────────────────────────────────────────────

export interface WhatsappConversationLite {
  id: number;
  boxKey: string | null;
  boxSource: string | null;
  employeeId: number | null;
  isLead: boolean;
  phoneE164: string;
  profileName: string | null;
  firstMessageAtMs: number | null;
  /** Texto das últimas mensagens RECEBIDAS (para o email/cidade do candidato; não vai à IA). */
  inboundText: string;
}

export interface WhatsappRoutingDeps {
  enabled(): Promise<boolean>;
  settings(): Promise<CommsRoutingSettings>;
  load(conversationId: number): Promise<WhatsappConversationLite | null>;
  claim(conversationId: number, fromBoxKey: string | null): Promise<boolean>;
  /** Só se a conversa ainda não tiver caixa. false = alguém a pôs entretanto. */
  setBox(conversationId: number, boxKey: string | null, source: "rule" | "ai"): Promise<boolean>;
  record(conversationId: number, patch: DecisionPatch): Promise<void>;
  firstContact(input: FirstContactInput): Promise<FirstContactResult>;
  cityProjectId(text: string | null): Promise<number | null>;
}

export type WhatsappRoutingResult = { status: "off" | "leave" | "seen"; why?: string } | { status: "moved" | "kept"; boxKey: string | null; recruit?: FirstContactResult | null };

/**
 * Depois da triagem (que já leu a conversa — nada de segunda chamada à IA):
 * conversa nova sem caixa → caixa do tema; "outro" ou pouca confiança → Geral.
 * Recrutamento em 1.º contacto → lead (+ candidatura se houver email).
 */
export async function routeWhatsappConversation(
  conversationId: number,
  triage: { intent: WhatsappIntent | null; confidence: number | null; reason: string | null },
  deps: WhatsappRoutingDeps = dbWhatsappRoutingDeps,
  nowMs: number = Date.now(),
): Promise<WhatsappRoutingResult> {
  if (!(await deps.enabled())) return { status: "off" };
  const c = await deps.load(conversationId);
  if (!c) return { status: "leave", why: "missing" };
  const settings = await deps.settings();
  const plan = whatsappRoutingPlan({ ...c, intent: triage.intent, confidence: triage.confidence, nowMs }, settings);
  if (plan.action === "leave") return { status: "leave", why: plan.why };
  if (!(await deps.claim(conversationId, c.boxKey))) return { status: "seen" };
  const applied = await deps.setBox(conversationId, plan.boxKey, plan.boxSource);
  const status: "moved" | "kept" = applied && plan.boxKey ? "moved" : "kept";
  const reason = plan.boxSource === "rule" ? "colaborador ou candidato" : (triage.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || null;

  let recruit: FirstContactResult | null = null;
  let candidate: CandidateData | null = null;
  if (applied && plan.boxSource === "ai" && plan.understood && plan.boxKey === "rh" && triage.intent === "recrutamento") {
    candidate = candidateFromWhatsapp(c);
    try {
      recruit = await deps.firstContact({
        channel: "whatsapp", sourceRef: `ai:whatsapp:${conversationId}`, candidate,
        projectId: await deps.cityProjectId(candidate.city), reason,
      });
    } catch (err: any) {
      console.warn("[IA caixas] candidato (WhatsApp) falhou:", conversationId, String(err?.message ?? err).slice(0, 160));
    }
  }
  await deps.record(conversationId, {
    status, via: plan.boxSource === "rule" ? "rule" : "triage", aiBoxKey: plan.boxSource === "ai" && plan.understood ? plan.boxKey : null,
    boxKey: applied ? plan.boxKey : c.boxKey, confidence: triage.confidence, reason,
    candidateJson: candidate ? JSON.stringify(candidate) : null,
    recruitOutcome: recruit?.outcome ?? null, leadId: recruit?.leadId ?? null, applicationId: recruit?.applicationId ?? null,
  });
  return { status, boxKey: applied ? plan.boxKey : c.boxKey, recruit };
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/** Candidato de uma conversa de WhatsApp: telefone da conversa, nome do perfil, email/cidade escritos. PURA. */
export function candidateFromWhatsapp(c: Pick<WhatsappConversationLite, "phoneE164" | "profileName" | "inboundText">): CandidateData {
  const name = String(c.profileName ?? "").trim();
  const city = cityKeyFromText(c.inboundText);
  return {
    fullName: name && /\p{L}{2,}/u.test(name) && !/[@\d]/.test(name) ? name.slice(0, 120) : null,
    phone: c.phoneE164,
    email: EMAIL_RE.exec(c.inboundText)?.[0]?.toLowerCase() ?? null,
    city: city ? CITY_LABELS[city] : null,
    hasLicense: null,
    licenseYears: null,
    availability: null,
  };
}

export const dbWhatsappRoutingDeps: WhatsappRoutingDeps = {
  async enabled() {
    // O WhatsApp não chama a IA aqui (a triagem já leu): só conta o interruptor.
    const { aiFeatureEnabledFresh } = await import("./_core/ai/features");
    return aiFeatureEnabledFresh("mail_routing");
  },
  settings: routingSettings,
  async load(conversationId) {
    const d = await database();
    const c = rowsOf(await d.execute(sql`SELECT c.id, c.boxKey, c.boxSource, c.employeeId, c.phoneE164, c.profileName,
        EXISTS (SELECT 1 FROM extra_leads l WHERE l.phoneE164 = c.phoneE164 COLLATE utf8mb4_unicode_ci) AS isLead,
        (SELECT MIN(m.createdAt) FROM whatsapp_messages m WHERE m.conversationId = c.id) AS firstAt
      FROM whatsapp_conversations c WHERE c.id = ${conversationId} LIMIT 1`))[0];
    if (!c) return null;
    const msgs = rowsOf(await d.execute(sql`SELECT body FROM whatsapp_messages WHERE conversationId = ${conversationId} AND direction = 'in' AND body IS NOT NULL ORDER BY id DESC LIMIT 6`));
    const firstAt = c.firstAt ? Date.parse(String(c.firstAt instanceof Date ? c.firstAt.toISOString() : String(c.firstAt).replace(" ", "T") + "Z")) : NaN;
    return {
      id: Number(c.id), boxKey: c.boxKey ?? null, boxSource: c.boxSource ?? null, employeeId: c.employeeId != null ? Number(c.employeeId) : null,
      isLead: Number(c.isLead) === 1, phoneE164: String(c.phoneE164 ?? ""), profileName: c.profileName ?? null,
      firstMessageAtMs: Number.isFinite(firstAt) ? firstAt : null,
      inboundText: msgs.map((m) => String(m.body ?? "")).reverse().join("\n").slice(0, 2000),
    };
  },
  async claim(conversationId, fromBoxKey) {
    const d = await database();
    const res = await d.execute(sql`INSERT IGNORE INTO comms_ai_routing (channel, sourceRef, conversationId, fromBoxKey, via, status)
      VALUES ('whatsapp', ${`whatsapp_conversation:${conversationId}`}, ${conversationId}, ${fromBoxKey}, 'triage', 'pending')`);
    return affected(res) === 1;
  },
  async setBox(conversationId, boxKey, source) {
    const d = await database();
    const res = await d.execute(sql`UPDATE whatsapp_conversations SET boxKey = ${boxKey}, boxSource = ${source}
      WHERE id = ${conversationId} AND boxKey IS NULL AND boxSource IS NULL`);
    return affected(res) === 1;
  },
  record: (conversationId, p) => recordDecision(`whatsapp_conversation:${conversationId}`, p),
  async firstContact(input) {
    const { onRecruitmentFirstContact } = await import("./recruitmentFirstContact");
    return onRecruitmentFirstContact(input);
  },
  cityProjectId: cityProjectIdOf,
};

// ─── Correções à mão e o que se mostra no ecrã ──────────────────────────────

/** Uma pessoa mudou a caixa: fica registado como correção (nunca lança). `boxKey` null = Geral. */
export async function noteManualBoxChange(channel: "email" | "whatsapp", id: number, boxKey: string | null, userId: number): Promise<void> {
  try {
    const d = await database();
    const col = channel === "email" ? sql`threadId` : sql`conversationId`;
    await d.execute(sql`UPDATE comms_ai_routing SET correctedBoxKey = ${boxKey ?? ""}, correctedById = ${userId}, correctedAt = ${nowStr()}
      WHERE channel = ${channel} AND ${col} = ${id} AND status <> 'pending'`);
  } catch (err: any) {
    console.warn("[IA caixas] registar correção:", String(err?.message ?? err).slice(0, 160));
  }
}

/** "Movido pela IA → caixa (motivo)" de uma conversa (quem chama já verificou o acesso). */
export async function routingNoteFor(channel: "email" | "whatsapp", id: number): Promise<{ text: string; status: string; boxKey: string | null; corrected: boolean } | null> {
  const d = await database();
  const col = channel === "email" ? sql`threadId` : sql`conversationId`;
  const r = rowsOf(await d.execute(sql`SELECT status, via, boxKey, fromBoxKey, reason, confidence, correctedBoxKey FROM comms_ai_routing
    WHERE channel = ${channel} AND ${col} = ${id} ORDER BY id LIMIT 1`))[0];
  if (!r) return null;
  const { listMailboxes } = await import("./mail/store");
  const labels = new Map((await listMailboxes()).map((b) => [b.key, b.label]));
  const label = (k: string | null) => (k ? labels.get(k) ?? k : channel === "whatsapp" ? "Geral" : labels.get(GENERAL_BOX_KEY) ?? "Geral");
  const row = {
    status: String(r.status), via: String(r.via), boxKey: r.boxKey ?? null, fromBoxKey: r.fromBoxKey ?? null, reason: r.reason ?? null,
    confidence: r.confidence != null ? Number(r.confidence) : null, correctedBoxKey: r.correctedBoxKey ?? null,
  };
  const text = routingNoteText(row, label);
  return text ? { text, status: row.status, boxKey: row.boxKey, corrected: row.correctedBoxKey != null } : null;
}

export interface AiIntakeRow {
  id: number;
  channel: "email" | "whatsapp";
  threadId: number | null;
  conversationId: number | null;
  outcome: string;
  reason: string | null;
  confidence: number | null;
  leadId: number | null;
  applicationId: number | null;
  leadName: string | null;
  /** Caixa onde ficou (para o link da conversa). */
  boxKey: string | null;
  decidedAt: string | null;
}

/**
 * Recrutamento: o que entrou pela IA (últimos `days` dias), para a página dos
 * Leads. Só as leads das cidades de quem vê (sem lead: só quem vê todas).
 */
export async function listAiIntake(opts: { days?: number; scope: number[] | undefined }): Promise<AiIntakeRow[]> {
  const d = await database();
  const since = nowStr(Date.now() - Math.max(1, Math.min(90, opts.days ?? 30)) * 86_400_000);
  const rows = rowsOf(await d.execute(sql`SELECT r.id, r.channel, r.threadId, r.conversationId, r.recruitOutcome, r.reason, r.confidence, r.leadId, r.applicationId, r.boxKey,
      DATE_FORMAT(r.decidedAt, '%Y-%m-%d %H:%i:%s') AS decidedAt, l.fullName AS leadName, l.projectId AS leadProjectId
    FROM comms_ai_routing r LEFT JOIN extra_leads l ON l.id = r.leadId
    WHERE r.recruitOutcome IS NOT NULL AND r.createdAt >= ${since}
    ORDER BY r.id DESC LIMIT 100`));
  const { projectVisible } = await import("./extrasCityFilter");
  return rows
    .filter((r) => (r.leadId != null ? projectVisible(r.leadProjectId != null ? Number(r.leadProjectId) : null, opts.scope) : opts.scope === undefined))
    .map((r) => ({
      id: Number(r.id), channel: r.channel === "whatsapp" ? "whatsapp" : "email",
      threadId: r.threadId != null ? Number(r.threadId) : null, conversationId: r.conversationId != null ? Number(r.conversationId) : null,
      outcome: String(r.recruitOutcome), reason: r.reason ?? null, confidence: r.confidence != null ? Number(r.confidence) : null,
      leadId: r.leadId != null ? Number(r.leadId) : null, applicationId: r.applicationId != null ? Number(r.applicationId) : null,
      leadName: r.leadName ?? null, boxKey: r.boxKey ?? null, decidedAt: r.decidedAt ?? null,
    }));
}
