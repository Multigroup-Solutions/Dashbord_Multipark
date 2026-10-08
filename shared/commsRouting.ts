/**
 * A IA separa emails e WhatsApp pelas caixas — regras PURAS (lote 41 ponto 13
 * + decisão do Jorge, 8 out 2026):
 *
 *   "A IA pega e vê os e-mails que entram nas caixas de correio partilhadas e
 *   age sozinha: entende o e-mail e divide-o pelas caixas disponíveis… sem ler
 *   (fica por ler). Tudo o que a IA não consiga perceber, mete na caixa do info
 *   para depois o utilizador dividir. No WhatsApp faz exatamente o mesmo: se já
 *   houver conversa antes, deixa estar na mesma caixa; se não houver, faz a
 *   divisão. No caso de ser recrutamento e ser o primeiro contacto, pode avançar
 *   para a criação de candidato."
 *
 * Um só interruptor: AI_MAIL_ROUTING ("IA: separar emails e WhatsApp pelas
 * caixas", ligado por omissão a pedido do Jorge). Nunca responde a ninguém.
 */
import { z } from "zod";
import { GENERAL_BOX_KEY, INTENT_BOX, parseRoutingAnswer } from "./commsBoxes";
import type { WhatsappIntent } from "./commsAi";
import type { MailPipeline } from "./mail";

// ─── Definições (Definições → Parâmetros → IA, "ai.commsRouting") ───────────

export const COMMS_ROUTING_DEFAULTS = {
  /** Abaixo disto a IA "não percebeu": vai para o info (WhatsApp: Geral). */
  minConfidence: 0.7,
  /** Teto de emails classificados por corrida (sincronização ou varrimento). */
  perRun: 10,
} as const;

export const commsRoutingSettingsSchema = z.object({
  minConfidence: z.number({ error: "minConfidence tem de ser um número entre 0 e 1." }).min(0, "minConfidence: mínimo 0.").max(1, "minConfidence: máximo 1."),
  perRun: z.number({ error: "perRun tem de ser um número." }).int("perRun: número inteiro.").min(1, "perRun: mínimo 1.").max(50, "perRun: máximo 50."),
}).strict();
export type CommsRoutingSettings = z.infer<typeof commsRoutingSettingsSchema>;

/** Valor das Definições (ou a omissão) já validado. PURA. */
export function commsRoutingSettings(raw: unknown): CommsRoutingSettings {
  const r = commsRoutingSettingsSchema.safeParse(raw);
  return r.success ? r.data : { ...COMMS_ROUTING_DEFAULTS };
}

// ─── Tetos de entrada (custo) ────────────────────────────────────────────────

/** Caracteres do corpo do email que vão à IA (nunca o email inteiro). */
export const ROUTING_BODY_MAX = 2500;
export const ROUTING_SUBJECT_MAX = 200;
/** Conversa de WhatsApp "nova": a 1.ª mensagem tem menos do que isto. */
export const WHATSAPP_NEW_CONVERSATION_HOURS = 48;

// ─── Resposta da IA → caixa ─────────────────────────────────────────────────

/** Confiança 0–1 (a IA às vezes devolve 85 em vez de 0,85). null = não veio. PURA. */
export function normalizeConfidence(v: unknown): number | null {
  if (v == null || v === "") return null;
  let n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  if (!Number.isFinite(n)) return null;
  if (n > 1 && n <= 100) n = n / 100;
  return Math.max(0, Math.min(1, Math.round(n * 1000) / 1000));
}

export interface RoutedBox {
  /** Caixa aplicada (GENERAL_BOX_KEY = info quando não percebeu). */
  boxKey: string;
  /** O que a IA disse, se for uma caixa válida (null = "geral"/inválida). */
  aiBoxKey: string | null;
  confidence: number | null;
  /** true = a IA percebeu (caixa válida e confiança ≥ limiar). */
  understood: boolean;
}

/**
 * Caixa final a partir da resposta da IA: caixa válida (ativa) e confiança ≥
 * limiar → essa; senão (geral, inválida, sem confiança, abaixo do limiar) →
 * info. PURA.
 */
export function decideRoutedBox(
  answer: { box?: unknown; confidence?: unknown },
  targets: ReadonlyArray<{ key: string }>,
  opts: { minConfidence: number },
): RoutedBox {
  const aiBoxKey = parseRoutingAnswer(answer.box, targets);
  const confidence = normalizeConfidence(answer.confidence);
  const understood = !!aiBoxKey && confidence != null && confidence >= opts.minConfidence;
  return { boxKey: understood ? aiBoxKey! : GENERAL_BOX_KEY, aiBoxKey, confidence, understood };
}

// ─── Email: que mensagens se separam ─────────────────────────────────────────

/** Pipelines que podem ser separados (os outros são emails de máquinas ou já criaram o caso). */
const ROUTABLE_PIPELINES: ReadonlySet<string> = new Set<MailPipeline>(["recursos-humanos"]);

/**
 * Esta mensagem guardada é para separar? Só emails RECEBIDOS de pessoas, numa
 * caixa PARTILHADA (nunca as pessoais nem "Por classificar"), que ABREM uma
 * conversa (uma resposta num fio que já está numa caixa fica onde está) e que
 * não criaram um caso (reclamação, perdido…) nem são de máquinas (críticas,
 * campanhas, ocorrências). PURA.
 */
export function emailRoutingEligible(e: {
  outbound: boolean;
  personal: boolean;
  systemMail: boolean;
  automated: boolean;
  newThread: boolean;
  mailboxKey: string | null | undefined;
  pipeline: string | null | undefined;
  createdCase: boolean;
}): boolean {
  if (e.outbound || e.personal || e.systemMail || e.automated) return false;
  if (!e.newThread || !e.mailboxKey) return false;
  if (e.createdCase) return false;
  if (e.pipeline && !ROUTABLE_PIPELINES.has(e.pipeline)) return false;
  return true;
}

// ─── WhatsApp: caixa de uma conversa nova ────────────────────────────────────

export type WhatsappRoutingPlan =
  | { action: "leave"; why: "has_box" | "old_conversation" | "no_intent" }
  | { action: "route"; boxKey: string | null; boxSource: "rule" | "ai"; understood: boolean };

/**
 * Conversa de WhatsApp: já tem caixa (ou é uma conversa antiga) → fica onde
 * está; nova → colaborador/candidato vai para o RH (regra); senão a intenção
 * da triagem (uma só chamada à IA) decide; "outro" ou confiança abaixo do
 * limiar → Geral (boxKey null, a "caixa do info" do WhatsApp). PURA.
 */
export function whatsappRoutingPlan(c: {
  boxKey: string | null;
  boxSource: string | null;
  employeeId: number | null;
  isLead: boolean;
  intent: WhatsappIntent | null;
  confidence: number | null;
  firstMessageAtMs: number | null;
  nowMs: number;
}, opts: { minConfidence: number }): WhatsappRoutingPlan {
  if (c.boxKey != null || c.boxSource != null) return { action: "leave", why: "has_box" };
  const ageMs = c.firstMessageAtMs == null ? 0 : c.nowMs - c.firstMessageAtMs;
  if (ageMs > WHATSAPP_NEW_CONVERSATION_HOURS * 3_600_000) return { action: "leave", why: "old_conversation" };
  if (c.employeeId != null || c.isLead) return { action: "route", boxKey: "rh", boxSource: "rule", understood: true };
  if (!c.intent) return { action: "leave", why: "no_intent" };
  // Sem confiança (resposta antiga da triagem) conta como percebido — era assim antes.
  const understood = c.intent !== "outro" && (c.confidence == null || c.confidence >= opts.minConfidence);
  const key = understood ? INTENT_BOX[c.intent] : GENERAL_BOX_KEY;
  return { action: "route", boxKey: key === GENERAL_BOX_KEY ? null : key, boxSource: "ai", understood };
}

// ─── Recrutamento: dados do candidato lidos pela IA ──────────────────────────

export interface CandidateData {
  fullName: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  hasLicense: boolean | null;
  licenseYears: number | null;
  availability: string | null;
}

const clean = (v: unknown, max: number): string | null => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  if (!s || /^(null|undefined|n\/?a|-|desconhecido|nenhum)$/i.test(s)) return null;
  return s.slice(0, max);
};

/**
 * Normaliza o que a IA leu do candidato. Os marcadores ([TELEFONE_1],
 * [EMAIL_1]) são repostos com `restore` (o fornecedor nunca viu os valores).
 * Um nome com "@", dígitos ou marcadores não é nome. PURA.
 */
export function normalizeCandidate(raw: Record<string, unknown> | null | undefined, restore: (s: string) => string = (s) => s): CandidateData {
  const r = raw ?? {};
  let fullName = clean(r.candidateName ?? r.fullName, 120);
  if (fullName && (/[@\d[\]]/.test(fullName) || fullName.length < 2)) fullName = null;
  const phone = clean(restore(String(r.candidatePhone ?? r.phone ?? "")), 40);
  const emailRaw = clean(restore(String(r.candidateEmail ?? r.email ?? "")), 320);
  const email = emailRaw && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailRaw) ? emailRaw.toLowerCase() : null;
  const lic = String(r.hasLicense ?? "").trim().toLowerCase();
  const hasLicense = /^(sim|s|yes|true)$/.test(lic) ? true : /^(nao|não|no|false)$/.test(lic) ? false : null;
  const yearsRaw = r.licenseYears == null || r.licenseYears === "" ? NaN : Number(r.licenseYears);
  const licenseYears = Number.isFinite(yearsRaw) && yearsRaw >= 0 && yearsRaw <= 70 ? Math.round(yearsRaw) : null;
  return {
    fullName,
    phone: phone && !/\[[A-Z]+_\d+\]/.test(phone) ? phone : null,
    email,
    city: clean(r.candidateCity ?? r.city, 80),
    hasLicense,
    licenseYears,
    availability: clean(r.availability, 200),
  };
}

/** Nota curta que fica na lead/candidatura criada pela IA ("Entrou pela IA"). PURA. */
export function aiIntakeNote(channel: "email" | "whatsapp", c: Pick<CandidateData, "hasLicense" | "licenseYears" | "availability">, reason: string | null): string {
  const bits = [`Entrou pela IA (${channel === "email" ? "email" : "WhatsApp"})`];
  if (reason) bits.push(reason.slice(0, 120));
  if (c.hasLicense === true) bits.push(c.licenseYears != null ? `carta há ${c.licenseYears} ano${c.licenseYears === 1 ? "" : "s"}` : "tem carta");
  if (c.hasLicense === false) bits.push("sem carta");
  if (c.availability) bits.push(`disponibilidade: ${c.availability}`);
  return bits.join(" · ").slice(0, 512);
}

/** A tag que identifica as leads que entraram pela IA (procura-se nas notas). */
export const AI_INTAKE_TAG = "Entrou pela IA";

/**
 * 1.º contacto de recrutamento? Só cria quando NÃO há ficha, lead nem
 * candidatura com o mesmo email/telefone; colaborador → só se liga; já
 * existe → só se liga/atualiza. PURA.
 */
export function firstContactPlan(found: { employee: boolean; lead: boolean; application: boolean }, contact: { email: string | null; phoneE164: string | null }): "invalid" | "employee" | "existing" | "create" {
  if (!contact.email && !contact.phoneE164) return "invalid";
  if (found.employee) return "employee";
  if (found.lead || found.application) return "existing";
  return "create";
}

// ─── Ecrã: "Movido pela IA → caixa (motivo)" ────────────────────────────────

export interface RoutingNoteRow {
  status: string;
  via: string;
  boxKey: string | null;
  fromBoxKey: string | null;
  reason: string | null;
  confidence: number | null;
  correctedBoxKey: string | null;
}

/** Linha para o ecrã. null = nada a mostrar. PURA. */
export function routingNoteText(r: RoutingNoteRow, label: (key: string | null) => string): string | null {
  if (r.status === "pending") return null;
  const pct = r.confidence != null ? ` · ${Math.round(r.confidence * 100)}%` : "";
  const why = r.reason ? ` (${r.reason}${pct})` : pct ? ` (${pct.slice(3)})` : "";
  let text: string;
  if (r.status === "failed") text = `A IA não conseguiu ler — ficou em ${label(r.boxKey)}`;
  else if (r.status === "kept") text = `A IA deixou em ${label(r.boxKey)}${why}`;
  else text = `Movido pela IA → ${label(r.boxKey)}${why}`;
  if (r.correctedBoxKey !== null && r.correctedBoxKey !== undefined) text += ` · corrigido à mão → ${label(r.correctedBoxKey || null)}`;
  return text;
}
