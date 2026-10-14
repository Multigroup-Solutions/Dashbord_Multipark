/**
 * Lote 57 (Jorge, 12 out 2026): "mesmo que o email não tenha ido para as
 * reclamações, se a IA vê que é uma reclamação, envia para lá" — regras PURAS.
 * 14 out 2026: o mesmo para os PERDIDOS, e a certeza média já não fica só
 * "sugerida": "tudo o que está na caixa de correio e é uma reclamação tem de
 * ir para as Reclamações" (meta: > 90 % das reclamações e dos perdidos).
 *
 * A IA que lê os emails das caixas partilhadas (server/commsRouting.ts) dá a
 * certeza de haver uma reclamação e a de haver um objeto perdido (mesmo dentro
 * de outro pedido, numa resposta ou num reencaminhamento):
 *   - certeza ≥ `createMinConfidence` → o caso é criado (ou o email junta-se
 *     ao caso aberto da mesma conversa / cliente / reserva);
 *   - entre `suggestMinConfidence` e isso → o caso é criado "Por confirmar
 *     (IA)" (fácil de tirar: arquivar, nunca apagar);
 *   - abaixo → nada (fica registado porquê).
 * Nunca para emails internos (salvo a empresa a reencaminhar um cliente),
 * automáticos, de parceiros, envios em massa (pelos cabeçalhos) nem avisos de
 * avaliações (pelo remetente) — nunca pelas palavras do texto. Uma conversa =
 * no máximo um caso (`complaint_mail_intake.threadId` é UNIQUE). Nunca escreve
 * ao cliente: sem aviso de receção, sem resposta.
 *
 * Interruptores: AI_MAIL_COMPLAINTS (reclamações, ligado por omissão a pedido
 * do Jorge) e AI_MAIL_LOST_FOUND (perdidos, desligado por omissão).
 */
import { z } from "zod";
import { emailKey } from "./crmIdentity";
import { isReviewNoticeSender, type MailCaseKind } from "./mailTriage";

export const COMPLAINT_INTAKE_FLAG = "AI_MAIL_COMPLAINTS";
/** 14 out 2026: os perdidos que a IA vê nas caixas partilhadas (desligado por omissão). */
export const LOST_FOUND_INTAKE_FLAG = "AI_MAIL_LOST_FOUND";
/** O interruptor de cada tipo de caso. */
export const CASE_INTAKE_FLAG: Record<MailCaseKind, string> = { complaint: COMPLAINT_INTAKE_FLAG, lost_found: LOST_FOUND_INTAKE_FLAG };
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

export type IntakeSkipReason = "internal" | "automatic" | "partner" | "newsletter" | "review" | "personal" | "complaints_box" | "lost_box" | "low_confidence" | "ignored_rule";
export const INTAKE_SKIP_LABELS: Record<IntakeSkipReason, string> = {
  internal: "email interno (remetente da empresa)",
  automatic: "email automático (no-reply, sistema, envio em massa)",
  partner: "email de um parceiro",
  newsletter: "newsletter ou publicidade",
  review: "aviso de avaliação/crítica",
  personal: "caixa pessoal",
  complaints_box: "já entrou pela caixa das reclamações",
  lost_box: "já entrou pela caixa dos perdidos",
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

/**
 * Aviso de uma avaliação (Google Business Profile, Trustpilot, Tripadvisor) —
 * trata-se nas Críticas, não aqui. Pelo REMETENTE (nunca pelas palavras do
 * assunto, 14 out 2026). PURA.
 */
export function looksLikeReviewNotice(_subject: string | null | undefined, sender: string | null | undefined): boolean {
  return isReviewNoticeSender(sender);
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
  /** A empresa reencaminha a mensagem de alguém de fora (o caso pode nascer). */
  forwardedExternal?: boolean;
  /** Envio em massa pelos CABEÇALHOS (List-Unsubscribe/List-Id) — newsletter. */
  listMail?: boolean;
}

export type IntakeDecision =
  /** A IA não disse "reclamação": nada a registar. */
  | { action: "ignore" }
  /** `uncertain` = certeza média → "Por confirmar (IA)". */
  | { action: "create"; uncertain?: true }
  | { action: "suggest" }
  | { action: "skip"; why: IntakeSkipReason };

/**
 * O que fazer com a certeza da IA de haver um caso (reclamação ou perdido) na
 * mensagem. A ordem conta: primeiro o que NUNCA abre caso (pessoal, já veio
 * pela caixa do caso, automático, interno sem ser reencaminhamento de um
 * cliente, parceiro, aviso de avaliação, envio em massa), depois a certeza.
 * `trusted` = aviso oficial de formato conhecido (Livro de Reclamações): passa
 * os filtros de automático. Sem certeza → "Por confirmar". PURA.
 */
export function caseIntakeDecision(
  kind: MailCaseKind,
  confidence: number | null | undefined,
  facts: IntakeFacts,
  settings: ComplaintIntakeSettings,
  opts: { trusted?: boolean } = {},
): IntakeDecision {
  if (facts.personal || !facts.fromBoxKey) return { action: "skip", why: "personal" };
  // Entrou pela caixa do próprio caso: o pipeline dela já criou (ou juntou) o caso.
  if (kind === "complaint" && facts.fromBoxPipeline === "reclamacoes") return { action: "skip", why: "complaints_box" };
  if (kind === "lost_found" && facts.fromBoxPipeline === "perdidos") return { action: "skip", why: "lost_box" };
  if (!opts.trusted) {
    if (facts.outbound || facts.automated || facts.systemMail || facts.senderIsAutomated || !facts.senderEmail) return { action: "skip", why: "automatic" };
    if (facts.senderIsCompany && !facts.forwardedExternal) return { action: "skip", why: "internal" };
    if (facts.senderIsPartner) return { action: "skip", why: "partner" };
    if (looksLikeReviewNotice(facts.subject, facts.senderEmail)) return { action: "skip", why: "review" };
    if (facts.listMail) return { action: "skip", why: "newsletter" };
  }
  const c = confidence;
  if (c == null || !Number.isFinite(c)) return { action: "create", uncertain: true };
  if (c >= settings.createMinConfidence) return { action: "create" };
  if (c >= settings.suggestMinConfidence) return { action: "create", uncertain: true };
  return { action: "skip", why: "low_confidence" };
}

/** Lote 57 (só reclamações, pela caixa que a IA disse) — o mesmo que `caseIntakeDecision("complaint", …)`. PURA. */
export function complaintIntakeDecision(
  verdict: { aiBoxKey: string | null | undefined; confidence: number | null | undefined },
  facts: IntakeFacts,
  settings: ComplaintIntakeSettings,
): IntakeDecision {
  if (verdict.aiBoxKey !== COMPLAINT_INTAKE_BOX) return { action: "ignore" };
  return caseIntakeDecision("complaint", verdict.confidence, facts, settings);
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
 * Nota interna que fica no caso: que veio da IA, de que caixa e porquê (e se
 * ficou "Por confirmar"). `by` = a pessoa que carregou em "Criar reclamação"
 * numa sugestão. PURA.
 */
export function intakeNote(kind: "created" | "linked", ctx: {
  boxLabel: string; reason: string | null | undefined; confidence: number | null | undefined; by?: string | null;
  caseKind?: MailCaseKind; uncertain?: boolean;
}): string {
  const why = String(ctx.reason ?? "").replace(/\s+/g, " ").trim();
  const conf = pct(ctx.confidence);
  const detail = [why ? `Motivo da IA: ${why}` : null, conf ? `certeza ${conf}` : null].filter(Boolean).join(" · ");
  const lost = ctx.caseKind === "lost_found";
  const is = lost ? "fala de um objeto perdido" : "é uma reclamação";
  const seems = lost ? "parece falar de um objeto perdido" : "parece uma reclamação";
  const head = kind === "created"
    ? ctx.by
      ? `🤖 Criada por ${ctx.by} a partir da sugestão da IA: um email que chegou à caixa «${ctx.boxLabel}» parece uma reclamação.`
      : ctx.uncertain
        ? `🤖 ${lost ? "Criado" : "Criada"} pela IA — POR CONFIRMAR: um email que chegou à caixa «${ctx.boxLabel}» ${seems}, mas a IA não tem a certeza. Se não for, arquiva (nada se apaga).`
        : `🤖 ${lost ? "Criado" : "Criada"} pela IA: um email que chegou à caixa «${ctx.boxLabel}» ${is}.`
    : `🤖 A IA juntou ${lost ? "a este caso" : "a esta reclamação"} um email que chegou à caixa «${ctx.boxLabel}».`;
  return [head, detail || null, "O email está na Comunicação. Ninguém respondeu ao cliente — responder é sempre uma pessoa."].filter(Boolean).join("\n");
}
