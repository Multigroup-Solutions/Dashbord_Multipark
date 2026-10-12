/**
 * Lote 57 (Jorge, 12 out 2026): "mesmo que o email não tenha ido para as
 * reclamações, se a IA vê que é uma reclamação, envia para lá" — regras PURAS.
 *
 * A IA que separa os emails pelas caixas (#351, server/commsRouting.ts) lê a
 * mensagem que ABRE cada conversa nova numa caixa partilhada. Quando diz
 * "reclamacoes":
 *   - certeza ≥ `createMinConfidence` → a reclamação é criada (ou o email junta-
 *     se à reclamação aberta do mesmo cliente/reserva/conversa);
 *   - entre `suggestMinConfidence` e isso → fica só a sugestão "Parece uma
 *     reclamação → Criar reclamação" na página das Reclamações;
 *   - abaixo → nada (fica registado porquê).
 * Nunca para emails internos, automáticos (newsletters, no-reply), de
 * parceiros, nem avisos de avaliações. Uma conversa = no máximo uma decisão
 * (`complaint_mail_intake.threadId` é UNIQUE). Nunca escreve ao cliente: sem
 * aviso de receção, sem resposta. O email fica na caixa onde está.
 *
 * Interruptor próprio: AI_MAIL_COMPLAINTS (ligado por omissão, a pedido do Jorge).
 */
import { z } from "zod";
import { emailKey } from "./crmIdentity";

export const COMPLAINT_INTAKE_FLAG = "AI_MAIL_COMPLAINTS";
/** A caixa da IA que quer dizer "isto é uma reclamação". */
export const COMPLAINT_INTAKE_BOX = "reclamacoes";

// ─── Definições (Definições → Parâmetros → IA, "ai.mailComplaints") ─────────

export const COMPLAINT_INTAKE_DEFAULTS = { createMinConfidence: 0.85, suggestMinConfidence: 0.5 } as const;

export const complaintIntakeSettingsSchema = z.object({
  createMinConfidence: z.number({ error: "createMinConfidence tem de ser um número entre 0 e 1." }).min(0.5, "createMinConfidence: mínimo 0,5.").max(1, "createMinConfidence: máximo 1."),
  suggestMinConfidence: z.number({ error: "suggestMinConfidence tem de ser um número entre 0 e 1." }).min(0, "suggestMinConfidence: mínimo 0.").max(1, "suggestMinConfidence: máximo 1."),
}).strict().refine((v) => v.suggestMinConfidence <= v.createMinConfidence, { message: "suggestMinConfidence não pode ser maior do que createMinConfidence." });
export type ComplaintIntakeSettings = z.infer<typeof complaintIntakeSettingsSchema>;

/** Valor das Definições (ou a omissão) já validado. PURA. */
export function complaintIntakeSettings(raw: unknown): ComplaintIntakeSettings {
  const r = complaintIntakeSettingsSchema.safeParse(raw);
  return r.success ? r.data : { ...COMPLAINT_INTAKE_DEFAULTS };
}

// ─── Estados do registo ─────────────────────────────────────────────────────

export const INTAKE_STATUSES = ["pending", "creating", "created", "linked", "suggested", "dismissed", "skipped", "failed"] as const;
export type IntakeStatus = (typeof INTAKE_STATUSES)[number];
export const INTAKE_STATUS_LABELS: Record<IntakeStatus, string> = {
  pending: "Por decidir",
  creating: "A criar",
  created: "Reclamação criada pela IA",
  linked: "Junta a uma reclamação aberta",
  suggested: "Parece uma reclamação",
  dismissed: "Não é reclamação",
  skipped: "Ignorada",
  failed: "Falhou ao criar",
};

export type IntakeSkipReason = "internal" | "automatic" | "partner" | "newsletter" | "review" | "personal" | "complaints_box" | "low_confidence" | "ignored_rule";
export const INTAKE_SKIP_LABELS: Record<IntakeSkipReason, string> = {
  internal: "email interno (remetente da empresa)",
  automatic: "email automático (no-reply, sistema, envio em massa)",
  partner: "email de um parceiro",
  newsletter: "newsletter ou publicidade",
  review: "aviso de avaliação/crítica",
  personal: "caixa pessoal",
  complaints_box: "já entrou pela caixa das reclamações",
  low_confidence: "a IA tinha pouca certeza",
  ignored_rule: "regra das reclamações (eco interno, auto-fatura ou aviso de reserva)",
};

// ─── Sinais de falso positivo ───────────────────────────────────────────────

/** Webmail público: o domínio não identifica uma empresa (um parceiro não se reconhece por gmail.com). */
export const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.pt", "outlook.com", "outlook.pt", "live.com", "live.com.pt", "msn.com",
  "yahoo.com", "yahoo.es", "yahoo.fr", "yahoo.co.uk", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com",
  "sapo.pt", "netcabo.pt", "clix.pt", "iol.pt", "mail.pt", "gmx.com", "gmx.net", "gmx.de", "web.de", "proton.me", "protonmail.com",
  "zoho.com", "yandex.com", "mail.com", "free.fr", "orange.fr", "libero.it", "t-online.de",
]);

const domainOf = (e: string): string => e.slice(e.lastIndexOf("@") + 1);

/**
 * Famílias de webmail em qualquer país (hotmail.co.uk, outlook.es, yahoo.com.br,
 * gmx.at…): a lista acima não chega — um parceiro com "@hotmail.co.uk" fazia de
 * TODOS os clientes desse webmail "parceiros" (as reclamações deles nunca
 * chegavam). Auditoria do lote 57.
 */
const PUBLIC_MAIL_FAMILY_RE = /^(gmail|googlemail|hotmail|outlook|live|msn|windowslive|yahoo|ymail|rocketmail|icloud|me|mac|aol|gmx|web|proton|protonmail|pm|zoho|yandex|mail|email|inbox|free|orange|wanadoo|laposte|sfr|libero|virgilio|tiscali|alice|t-online|freenet|arcor|btinternet|sky|virginmedia|comcast|verizon|att|bellsouth|sbcglobal|telenet|skynet|bluewin|seznam|wp|o2|interia|onet|terra|uol|bol|ig|sapo|netcabo|clix|iol|vodafone|meo|nos|telepac)\.(com|net|org|co|[a-z]{2})(\.[a-z]{2})?$/;

/** O domínio é de um webmail público (não identifica uma empresa)? PURA. */
export function isPublicMailDomain(domain: string | null | undefined): boolean {
  const d = String(domain ?? "").trim().toLowerCase();
  return !!d && (PUBLIC_MAIL_DOMAINS.has(d) || PUBLIC_MAIL_FAMILY_RE.test(d));
}

/**
 * O remetente é um parceiro? O email exato de um contacto de parceria, ou o
 * mesmo domínio de empresa (nunca por um webmail público). PURA.
 */
export function isPartnerSender(sender: string | null | undefined, partnerEmails: readonly (string | null | undefined)[]): boolean {
  const s = emailKey(sender);
  if (!s) return false;
  const list = partnerEmails.map((p) => emailKey(p)).filter(Boolean);
  if (list.includes(s)) return true;
  const d = domainOf(s);
  if (!d || isPublicMailDomain(d)) return false;
  return list.some((p) => domainOf(p) === d);
}

const NEWSLETTER_RE = /\b(unsubscribe|newsletter|cancelar (a )?subscri[cç][aã]o|anular (a )?subscri[cç][aã]o|deixar de receber (estes|os nossos|este tipo de) (e-?mails|emails|mensagens)|ver (este|o) e-?mail no (navegador|browser)|view (this email )?in (your )?browser|manage (your )?(email )?preferences|gerir (as )?(suas )?prefer[eê]ncias)\b/i;

/** Newsletter / publicidade (texto típico de envio em massa). PURA. */
export function looksLikeNewsletter(subject: string | null | undefined, text: string | null | undefined): boolean {
  return NEWSLETTER_RE.test(`${subject ?? ""}\n${String(text ?? "").slice(0, 20_000)}`);
}

const REVIEW_SUBJECT_RE = /(nova|new) (avalia[cç][aã]o|cr[ií]tica|review)|deixou (uma|um) (avalia[cç][aã]o|cr[ií]tica|coment[aá]rio)|left a review|wrote a review|responder [àa] (avalia[cç][aã]o|cr[ií]tica)|trustpilot|google business profile/i;

/** Aviso de uma avaliação (Google, Trustpilot…) — trata-se nas Críticas, não aqui. PURA. */
export function looksLikeReviewNotice(subject: string | null | undefined, sender: string | null | undefined): boolean {
  const from = String(sender ?? "").toLowerCase();
  if (/@(google\.com|business\.google\.com|trustpilot\.com|tripadvisor\.[a-z.]+|booking\.com)$/.test(from)) return true;
  return REVIEW_SUBJECT_RE.test(String(subject ?? ""));
}

// ─── Decisão ────────────────────────────────────────────────────────────────

export interface IntakeFacts {
  fromBoxKey: string | null;
  /** Pipeline da caixa onde entrou ("reclamacoes" = já entrou pelas reclamações). */
  fromBoxPipeline: string | null;
  outbound: boolean;
  /** mail_messages.automated ≠ 0 ou cabeçalhos de envio automático. */
  automated: boolean;
  systemMail: boolean;
  personal: boolean;
  senderIsCompany: boolean;
  senderIsAutomated: boolean;
  senderIsPartner: boolean;
  subject: string;
  text: string;
  senderEmail: string | null;
}

export type IntakeDecision =
  /** A IA não disse "reclamação": nada a registar. */
  | { action: "ignore" }
  | { action: "create" }
  | { action: "suggest" }
  | { action: "skip"; why: IntakeSkipReason };

/**
 * O que fazer com o veredicto da IA para a mensagem que abre a conversa. A
 * ordem conta: primeiro o que NUNCA é reclamação (interno, automático,
 * parceiro, newsletter, avaliação), depois a certeza. Sem confiança → só
 * sugere. PURA.
 */
export function complaintIntakeDecision(
  verdict: { aiBoxKey: string | null | undefined; confidence: number | null | undefined },
  facts: IntakeFacts,
  settings: ComplaintIntakeSettings,
): IntakeDecision {
  if (verdict.aiBoxKey !== COMPLAINT_INTAKE_BOX) return { action: "ignore" };
  if (facts.personal || !facts.fromBoxKey) return { action: "skip", why: "personal" };
  // Entrou pela caixa das reclamações: o pipeline dela já criou (ou juntou) o caso.
  if (facts.fromBoxPipeline === "reclamacoes") return { action: "skip", why: "complaints_box" };
  if (facts.outbound || facts.automated || facts.systemMail || facts.senderIsAutomated || !facts.senderEmail) return { action: "skip", why: "automatic" };
  if (facts.senderIsCompany) return { action: "skip", why: "internal" };
  if (facts.senderIsPartner) return { action: "skip", why: "partner" };
  if (looksLikeReviewNotice(facts.subject, facts.senderEmail)) return { action: "skip", why: "review" };
  if (looksLikeNewsletter(facts.subject, facts.text)) return { action: "skip", why: "newsletter" };
  const c = verdict.confidence;
  if (c == null || !Number.isFinite(c)) return { action: "suggest" };
  if (c >= settings.createMinConfidence) return { action: "create" };
  if (c >= settings.suggestMinConfidence) return { action: "suggest" };
  return { action: "skip", why: "low_confidence" };
}

// ─── Juntar a uma reclamação aberta ─────────────────────────────────────────

/**
 * Pode o email que a IA viu juntar-se a esta reclamação aberta por um sinal
 * FRACO (a mesma matrícula ou a mesma reserva)? Só se a reclamação não tiver
 * email do cliente ou for o MESMO email — a mesma matrícula de outro cliente
 * (carro de empresa, vendido, gralha) ou a reserva de outra pessoa nunca
 * escondem uma reclamação dentro do caso de outro cliente. Auditoria do lote
 * 57. A conversa, o fio do email e a etiqueta [REC-n] continuam a juntar. PURA.
 */
export function aiMergeSameClient(existingEmail: string | null | undefined, senderEmail: string | null | undefined): boolean {
  const a = emailKey(existingEmail);
  const b = emailKey(senderEmail);
  return !a || !b || a === b;
}

// ─── Notas na reclamação ────────────────────────────────────────────────────

const pct = (c: number | null | undefined) => (c == null || !Number.isFinite(c) ? null : `${Math.round(c * 100)}%`);

/**
 * Nota interna que fica na reclamação: que veio da IA, de que caixa e porquê.
 * `by` = a pessoa que carregou em "Criar reclamação" numa sugestão. PURA.
 */
export function intakeNote(kind: "created" | "linked", ctx: { boxLabel: string; reason: string | null | undefined; confidence: number | null | undefined; by?: string | null }): string {
  const why = String(ctx.reason ?? "").replace(/\s+/g, " ").trim();
  const conf = pct(ctx.confidence);
  const detail = [why ? `Motivo da IA: ${why}` : null, conf ? `certeza ${conf}` : null].filter(Boolean).join(" · ");
  const head = kind === "created"
    ? ctx.by
      ? `🤖 Criada por ${ctx.by} a partir da sugestão da IA: um email que chegou à caixa «${ctx.boxLabel}» parece uma reclamação.`
      : `🤖 Criada pela IA: um email que chegou à caixa «${ctx.boxLabel}» é uma reclamação.`
    : `🤖 A IA juntou a esta reclamação um email que chegou à caixa «${ctx.boxLabel}».`;
  return [head, detail || null, "O email ficou na caixa onde chegou. Ninguém respondeu ao cliente — responder é sempre uma pessoa."].filter(Boolean).join("\n");
}
