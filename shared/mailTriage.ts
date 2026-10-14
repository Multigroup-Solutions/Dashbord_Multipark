/**
 * Triagem dos emails das caixas partilhadas pela IA — regras PURAS (Jorge,
 * 14 out 2026):
 *
 *   "As críticas deixa-as quietas, só no email. As reclamações têm de ir para
 *   as Reclamações, e os perdidos e achados também. A IA não pode só pôr na
 *   caixa de correio: tudo o que está na caixa de correio e é uma reclamação
 *   tem de ir para as Reclamações. Não por palavra-chave: tem de perceber."
 *
 * Quem decide a CATEGORIA é a IA, pelo sentido (uma só leitura por mensagem,
 * server/commsRouting.ts). Aqui ficam só:
 *  - os filtros determinísticos óbvios ANTES da IA (`preTriageMail`): o que
 *    não é de pessoas (enviados, sistema, notificações de reserva, envios em
 *    massa pelos cabeçalhos), o que uma pessoa já mexeu, as caixas que criam o
 *    caso sozinhas, e três avisos AUTOMÁTICOS de formato conhecido (avaliação
 *    publicada, ocorrência da app Multipark, Livro de Reclamações) — reconhecidos
 *    pelo remetente/formulário, nunca por palavras do texto;
 *  - o que fazer com a resposta da IA (`decideMailTriage`): reclamação e
 *    perdido abrem (ou juntam-se a) um caso — com certeza média ficam "Por
 *    confirmar (IA)"; críticas vão para a caixa das Críticas e ficam lidas;
 *    ocorrências vão para as Ocorrências; o resto separa-se pelas caixas como
 *    já fazia o AI_MAIL_ROUTING;
 *  - a porta da reclamacoes@/perdidos@ (`aliasGateIsNoise`): tudo o que lá chega
 *    é caso, salvo a IA ter a certeza de que é lixo;
 *  - as contas da avaliação (`triageMetrics`, "Testar a triagem").
 *
 * Nunca responde nem avisa o cliente; nada se apaga.
 */
import { z } from "zod";
import { GENERAL_BOX_KEY, ROUTING_TARGETS } from "./commsBoxes";
import { normalizeConfidence } from "./commsRouting";
import { isAutomatedSender, normalizeAddress } from "./mail";

// ─── Categorias ─────────────────────────────────────────────────────────────

export const MAIL_TRIAGE_CATEGORIES = [
  "reclamacoes", "perdidos", "criticas", "ocorrencias", "rh", "reservas", "alteracoes", "cancelamentos",
  "servicos_extra", "parcerias", "faturacao", "ruido", "geral",
] as const;
export type MailTriageCategory = (typeof MAIL_TRIAGE_CATEGORIES)[number];

export const MAIL_TRIAGE_CATEGORY_LABELS: Record<MailTriageCategory, string> = {
  reclamacoes: "Reclamações",
  perdidos: "Perdidos e achados",
  criticas: "Críticas",
  ocorrencias: "Ocorrências",
  rh: "RH",
  reservas: "Reservas",
  alteracoes: "Alterações",
  cancelamentos: "Cancelamentos",
  servicos_extra: "Serviços extra",
  parcerias: "Parcerias",
  faturacao: "Faturação",
  ruido: "Lixo (publicidade, spam, automáticos)",
  geral: "Geral (não percebeu)",
};

/** Lixo: fica onde está (nunca abre caso). */
export const NOISE_CATEGORY = "ruido" as const;

/**
 * O que cada categoria QUER DIZER — vai no pedido à IA. As das caixas vêm de
 * ROUTING_TARGETS (uma só fonte); `ruido` e `geral` só existem na triagem.
 */
export const MAIL_TRIAGE_HINTS: ReadonlyArray<{ key: MailTriageCategory; hint: string }> = [
  ...(ROUTING_TARGETS as ReadonlyArray<{ key: MailTriageCategory; hint: string }>),
  { key: "ruido", hint: "não é de uma pessoa a pedir alguma coisa: publicidade, boletins, spam, tentativas de fraude, respostas automáticas (ausência, entrega falhada) e avisos de sistemas sem nada para tratar" },
  { key: "geral", hint: "é de uma pessoa mas não encaixa em nenhuma das outras, ou não dá para perceber o que quer" },
];

/** Resposta da IA → categoria válida (null = inválida). PURA. */
export function parseTriageCategory(raw: unknown): MailTriageCategory | null {
  const k = String(raw ?? "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z_]/g, "");
  return (MAIL_TRIAGE_CATEGORIES as readonly string[]).includes(k) ? (k as MailTriageCategory) : null;
}

/** Caso que cada tipo abre e a caixa para onde a conversa vai. */
export type MailCaseKind = "complaint" | "lost_found";
export const CASE_BOX: Record<MailCaseKind, MailTriageCategory> = { complaint: "reclamacoes", lost_found: "perdidos" };
export const CASE_LABEL: Record<MailCaseKind, string> = { complaint: "reclamação", lost_found: "perdido" };

/** Caixas cujo pipeline já cria o caso de TUDO o que chega (reclamacoes@, perdidos@). */
export const DIRECT_CASE_PIPELINES: ReadonlySet<string> = new Set(["reclamacoes", "perdidos"]);
/** Pipelines que a IA lê (os outros são de máquinas ou já tratam o email: críticas, ocorrências, campanhas). */
export const TRIAGE_PIPELINES: ReadonlySet<string> = new Set(["recursos-humanos"]);

// ─── Definições ─────────────────────────────────────────────────────────────

/** Tentativas da IA por email (falhou → fica onde está, por ler, e volta a ser lido). */
export const MAIL_TRIAGE_MAX_ATTEMPTS = 3;
/** reclamacoes@ / perdidos@: só não abre o caso quando a IA tem ESTA certeza de que é lixo. */
export const ALIAS_NOISE_MIN_CONFIDENCE = 0.9;

/** Varrimento dos emails que já estão nas caixas (Definições → Parâmetros → IA, "ai.mailBackfill"). */
export const MAIL_BACKFILL_DEFAULTS = { days: 30, perRun: 6 } as const;
export const mailBackfillSettingsSchema = z.object({
  days: z.number({ error: "days tem de ser um número." }).int("days: número inteiro.").min(1, "days: mínimo 1.").max(90, "days: máximo 90."),
  perRun: z.number({ error: "perRun tem de ser um número." }).int("perRun: número inteiro.").min(1, "perRun: mínimo 1.").max(20, "perRun: máximo 20."),
}).strict();
export type MailBackfillSettings = z.infer<typeof mailBackfillSettingsSchema>;

/** Valor das Definições (ou a omissão) já validado. PURA. */
export function mailBackfillSettings(raw: unknown): MailBackfillSettings {
  const r = mailBackfillSettingsSchema.safeParse(raw);
  return r.success ? r.data : { ...MAIL_BACKFILL_DEFAULTS };
}

// ─── Avisos automáticos de formato conhecido (remetente/formulário) ─────────

const REVIEW_SENDER_RES: readonly RegExp[] = [
  // Google Business Profile (businessprofile-noreply@, noreply-business@…).
  /^[^@]*business[^@]*@google\.com$/,
  /@(?:[a-z0-9-]+\.)*trustpilot\.(?:com|net)$/,
  /@(?:[a-z0-9-]+\.)*tripadvisor\.[a-z.]+$/,
];

/** Remetente dos avisos de avaliação (Google Business Profile, Trustpilot, Tripadvisor). PURA. */
export function isReviewNoticeSender(sender: string | null | undefined): boolean {
  const s = normalizeAddress(sender);
  return !!s && REVIEW_SENDER_RES.some((re) => re.test(s));
}

/** Livro de Reclamações eletrónico (plataforma oficial). PURA. */
export function isLivroNoticeSender(sender: string | null | undefined): boolean {
  const s = normalizeAddress(sender);
  return /@(?:[a-z0-9-]+\.)*livroreclamacoes\.pt$/.test(s);
}

export interface OccurrenceNotice {
  type: string;
  plate: string | null;
  remarks: string | null;
  /** Código do link "consulta/<código>" da reserva, se vier. */
  bookingCode: string | null;
}

const field = (text: string, label: string): string | null => {
  const m = new RegExp(`^[\\s*_•-]*${label}[\\s*_]*:[\\s*_]*(.+?)[\\s*_]*$`, "im").exec(text);
  const v = m?.[1]?.trim();
  return v ? v.slice(0, 200) : null;
};

/**
 * O formulário do aviso de ocorrência que a app Multipark envia (campos
 * "Tipo de ocorrência:" e "Matrícula:", mais "Observações:" e "Link reserva:").
 * null = não é esse aviso. Reconhece o FORMULÁRIO (como o de uma notificação
 * de reserva), não o assunto. PURA.
 */
export function parseOccurrenceNotice(text: string | null | undefined): OccurrenceNotice | null {
  const t = String(text ?? "").replace(/\r/g, "").slice(0, 20_000);
  const type = field(t, "Tipo de ocorr[eê]ncia");
  const plateRaw = field(t, "Matr[ií]cula");
  if (!type || !plateRaw) return null;
  const plate = plateRaw.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 12) || null;
  const link = field(t, "Link (?:da )?reserva");
  const code = link ? /\/consulta\/([A-Za-z0-9_-]{6,64})/.exec(link)?.[1] ?? null : null;
  return { type, plate, remarks: field(t, "Observa[cç](?:õ|o)es"), bookingCode: code };
}

// ─── Remetente ──────────────────────────────────────────────────────────────

/** De fora (cliente, parceiro…), da empresa, ou automático (no-reply, envio em massa). */
export type SenderKind = "external" | "company" | "automated";

/**
 * Quem escreve. `automated` = mail_messages.automated (0 pessoa, 1 automático,
 * 2/3 já ficaram de fora). A empresa ganha (um aviso da app sai do info@). PURA.
 */
export function senderKindOf(m: { fromEmail: string | null | undefined; automated: number }, isCompany: (a: string) => boolean): SenderKind {
  const from = normalizeAddress(m.fromEmail);
  if (from && isCompany(from)) return "company";
  if (m.automated !== 0 || isAutomatedSender(from)) return "automated";
  return "external";
}

/**
 * Automático pelos CABEÇALHOS (envio em massa, lista, resposta automática) e
 * não pelo endereço no-reply: só se sabe olhando para o que ficou guardado —
 * marcado como automático (1) mas o endereço não é de no-reply. PURA.
 */
export function automatedByHeaders(m: { fromEmail: string | null | undefined; automated: number }): boolean {
  return m.automated === 1 && !isAutomatedSender(m.fromEmail);
}

/**
 * Envio em massa (newsletter) pelos cabeçalhos de lista — SÓ quando a
 * sincronização já o deu como automático. Auditoria (14 out 2026): os emails
 * que um Grupo Google da empresa distribui (info@, reclamacoes@…) trazem
 * List-Id/List-Unsubscribe do NOSSO domínio; a sincronização sabe que são do
 * cliente (automated = 0, shared/mail.ts isOwnListId), mas o caso via o
 * cabeçalho cru e deitava a reclamação fora como "newsletter". PURA.
 */
export function bulkListMail(m: { automated: number; listUnsubscribe?: string | null; listId?: string | null }): boolean {
  return m.automated === 1 && !!(String(m.listUnsubscribe ?? "").trim() || String(m.listId ?? "").trim());
}

const FORWARD_FROM_RE = /^[\s>*]*(?:De|From|Von|Desde)\s*:\s*(.+)$/gim;
const EMAIL_IN_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/**
 * Um email da empresa que REENCAMINHA a mensagem de alguém de fora (o
 * backoffice manda à caixa a queixa que recebeu): devolve esse remetente de
 * fora (null = não é reencaminhamento de um cliente). Lê o bloco "De:/From:"
 * do reencaminhamento — quem decide se é reclamação continua a ser a IA. PURA.
 */
export function forwardedExternalSender(text: string | null | undefined, isCompany: (a: string) => boolean): string | null {
  const t = String(text ?? "").replace(/\r/g, "").slice(0, 20_000);
  for (const m of t.matchAll(FORWARD_FROM_RE)) {
    const e = EMAIL_IN_RE.exec(m[1] ?? "")?.[0]?.toLowerCase();
    // Um aviso de avaliação reencaminhado (Google Business Profile, Trustpilot…)
    // não é um cliente: a crítica entra pelas Críticas (auditoria, 14 out 2026).
    if (e && !isCompany(e) && !isAutomatedSender(e) && !isReviewNoticeSender(e)) return e;
  }
  return null;
}

// ─── Texto que vai à IA: a mensagem nova + o citado/reencaminhado ────────────

const QUOTE_HEADER_RE = /^\s*(On .+ wrote:|Em .+ escreveu:|Le .+ a écrit\s*:|El .+ escribió\s*:|-----\s*Original Message|De:\s.+|From:\s.+)$/i;
const FORWARD_MARK_RE = /^\s*-{2,}\s*(Forwarded message|Original Message|Mensagem (?:encaminhada|reencaminhada|original)|Mensaje (?:reenviado|original)|Message (?:transféré|d'origine))\s*-*\s*$/i;

/**
 * Separa a mensagem NOVA do histórico citado ou reencaminhado (o que vem
 * depois de "Em … escreveu:", "De: …", "---------- Forwarded message"; as
 * linhas "> …"). A nova é o que a IA lê primeiro; o citado vai como contexto
 * (uma resposta curta ou um reencaminhamento sem texto não ficam às cegas). PURA.
 */
export function splitQuotedText(text: string | null | undefined): { fresh: string; quoted: string } {
  const lines = String(text ?? "").split(/\r?\n/);
  const fresh: string[] = [];
  const quoted: string[] = [];
  let broke = false;
  const nextIsQuote = (i: number) => {
    for (let j = i + 1; j < lines.length; j++) if (lines[j].trim()) return /^\s*>/.test(lines[j]);
    return false;
  };
  for (const [i, l] of lines.entries()) {
    if (broke) { quoted.push(l.replace(/^\s*>\s?/, "")); continue; }
    if ((QUOTE_HEADER_RE.test(l) || FORWARD_MARK_RE.test(l)) && fresh.some((x) => x.trim())) { broke = true; quoted.push(l); continue; }
    // Ronda 2: resposta POR BAIXO da citação ("Em … escreveu:" + "> …" e só depois o texto
    // novo) — a linha "Em … escreveu:" é do citado, não da mensagem nova.
    if (QUOTE_HEADER_RE.test(l) && nextIsQuote(i)) { quoted.push(l); continue; }
    if (/^\s*>/.test(l)) { quoted.push(l.replace(/^\s*>\s?/, "")); continue; }
    fresh.push(l);
  }
  const tidy = (a: string[]) => a.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { fresh: tidy(fresh), quoted: tidy(quoted) };
}

// ─── Antes da IA ────────────────────────────────────────────────────────────

export interface PreTriageFacts {
  outbound: boolean;
  personal: boolean;
  systemMail: boolean;
  /** mail_messages.automated: 0 pessoa, 1 automático, 2 notificação de reserva, 3 sistema. */
  automated: number;
  mailboxKey: string | null | undefined;
  /** Pipeline que o email usou (o do alias/caixa onde entrou). */
  pipeline: string | null | undefined;
  fromEmail: string | null | undefined;
  text: string;
  senderIsCompany: boolean;
  /** O pipeline do alias já criou o caso (reclamação, perdido, crítica…). */
  createdCase: boolean;
  /** A conversa já tem uma reclamação/perdido (ou uma pessoa desligou um). */
  threadHasCase: boolean;
  /** Uma pessoa já mexeu: moveu à mão, corrigiu a IA, recusou o caso, resolveu a conversa. */
  humanTouched: boolean;
}

export type PreTriageSkip = "not_inbound" | "personal" | "no_box" | "system" | "reservation" | "human" | "case_box" | "pipeline" | "has_case";
export type MailNoticeKind = "review" | "occurrence" | "livro" | "automatic";

export type PreTriage =
  | { action: "skip"; why: PreTriageSkip }
  | { action: "rule"; category: MailTriageCategory; notice: MailNoticeKind; occurrence?: OccurrenceNotice }
  | { action: "ai" };

/**
 * O que acontece ANTES de a IA ler — determinístico. A ordem conta:
 *  1. não é de pessoas para nós (enviado, pessoal, sistema, notificação de
 *     reserva, sem caixa) → nada;
 *  2. uma pessoa já mexeu → nada (o humano manda);
 *  3. reclamacoes@ / perdidos@ → o pipeline delas cria o caso (porta própria);
 *  4. avisos automáticos de formato conhecido → regra (crítica, ocorrência,
 *     Livro de Reclamações);
 *  5. caixas de máquinas (críticas, ocorrências, campanhas) ou caso já aberto → nada;
 *  6. envio em massa / resposta automática pelos cabeçalhos → lixo (regra);
 *  7. o resto → a IA lê.
 * PURA.
 */
export function preTriageMail(f: PreTriageFacts): PreTriage {
  if (f.outbound) return { action: "skip", why: "not_inbound" };
  if (f.personal) return { action: "skip", why: "personal" };
  if (!f.mailboxKey) return { action: "skip", why: "no_box" };
  if (f.systemMail || f.automated === 3) return { action: "skip", why: "system" };
  if (f.automated === 2) return { action: "skip", why: "reservation" };
  if (f.humanTouched) return { action: "skip", why: "human" };
  if (f.pipeline && DIRECT_CASE_PIPELINES.has(f.pipeline)) return { action: "skip", why: "case_box" };
  if (isReviewNoticeSender(f.fromEmail)) return { action: "rule", category: "criticas", notice: "review" };
  if (f.senderIsCompany) {
    const occ = parseOccurrenceNotice(f.text);
    if (occ) return { action: "rule", category: "ocorrencias", notice: "occurrence", occurrence: occ };
  }
  if (f.pipeline && !TRIAGE_PIPELINES.has(f.pipeline)) return { action: "skip", why: "pipeline" };
  if (f.createdCase || f.threadHasCase) return { action: "skip", why: "has_case" };
  if (isLivroNoticeSender(f.fromEmail)) return { action: "rule", category: "reclamacoes", notice: "livro" };
  if (automatedByHeaders({ fromEmail: f.fromEmail, automated: f.automated })) return { action: "rule", category: NOISE_CATEGORY, notice: "automatic" };
  return { action: "ai" };
}

// ─── Depois da IA ───────────────────────────────────────────────────────────

/** O que a IA respondeu (campos que a decisão usa). */
export interface TriageAiOutput {
  box?: unknown;
  confidence?: unknown;
  complaint?: unknown;
  lostItem?: unknown;
  /** A IA viu uma queixa em qualquer parte do email (mesmo de passagem). */
  complaintMentioned?: unknown;
  /** A IA viu um objeto deixado/perdido em qualquer parte do email. */
  lostItemMentioned?: unknown;
}

/**
 * As certezas de caso que a decisão usa (ronda 2 da auditoria, 14 out 2026):
 * a maior entre a certeza que a IA deu, a da caixa (quando a caixa É a do
 * caso) e — quando a IA disse que a queixa / o objeto aparece em qualquer
 * parte do email — `suggestMinConfidence` ("Por confirmar (IA)"). Um modelo
 * pequeno vê a queixa dita de passagem dentro de outro pedido, mas dá-lhe uma
 * certeza baixa porque o assunto principal é outro: o sim/não não depende
 * dessa calibração, e uma pessoa confirma. Só números e sim/não da IA — o
 * texto do email não entra aqui. PURA.
 */
export function caseScoresOf(out: TriageAiOutput, t: Pick<TriageThresholds, "suggestMinConfidence">): { complaintScore: number; lostScore: number } {
  const aiBoxKey = parseTriageCategory(out.box);
  const confidence = normalizeConfidence(out.confidence) ?? 0;
  const floor = (said: unknown) => (said === true ? t.suggestMinConfidence : 0);
  return {
    complaintScore: Math.max(normalizeConfidence(out.complaint) ?? 0, aiBoxKey === "reclamacoes" ? confidence : 0, floor(out.complaintMentioned)),
    lostScore: Math.max(normalizeConfidence(out.lostItem) ?? 0, aiBoxKey === "perdidos" ? confidence : 0, floor(out.lostItemMentioned)),
  };
}

export interface TriageFacts {
  sender: SenderKind;
  /** Email da empresa que reencaminha a mensagem de alguém de fora. */
  forwardedExternal: boolean;
  /** A mensagem abre a conversa (só estas mudam de caixa de tema). */
  newThread: boolean;
  /** "sync" = email que acabou de chegar; "sweep" = varrimento dos antigos (não baralha as caixas de tema). */
  mode: "sync" | "sweep";
}

export interface TriageThresholds {
  /** Caixa de tema: abaixo disto a IA "não percebeu" (ai.commsRouting). */
  minConfidence: number;
  /** Caso confirmado a partir daqui (ai.mailComplaints). */
  createMinConfidence: number;
  /** Caso "Por confirmar (IA)" a partir daqui (ai.mailComplaints); abaixo, nada. */
  suggestMinConfidence: number;
}

/** Interruptores que mudam o que se faz (AI_MAIL_COMPLAINTS, AI_MAIL_LOST_FOUND, AI_MAIL_NOTICES). */
export interface TriageFeatures { complaints: boolean; lostFound: boolean; notices: boolean }
export const ALL_TRIAGE_FEATURES: TriageFeatures = { complaints: true, lostFound: true, notices: true };

export interface TriageDecision {
  /** A categoria final (a que conta na avaliação). */
  category: MailTriageCategory;
  /** O que a IA disse em `box` (null = inválido). */
  aiBoxKey: MailTriageCategory | null;
  confidence: number | null;
  complaintScore: number;
  lostScore: number;
  /** A IA percebeu a caixa de tema (válida, certeza ≥ limiar). */
  understood: boolean;
  /** Caso a abrir (ou juntar). */
  caseKind: MailCaseKind | null;
  caseScore: number | null;
  /** Certeza média → "Por confirmar (IA)". */
  uncertain: boolean;
  /**
   * Caixa de tema para onde a conversa vai SE não abrir caso (null = fica
   * onde está). Só conversas novas, no email que acabou de chegar.
   */
  routeBox: string | null;
  /** Crítica (elogio/opinião): fica lida. */
  markRead: boolean;
}

const NOTICE_CATEGORIES: ReadonlySet<string> = new Set(["criticas", "ocorrencias"]);

/**
 * Resposta da IA → o que se faz. Só números e chaves — o texto do email não
 * entra aqui (a IA já o leu; nenhuma palavra decide nada). PURA.
 *
 *  - reclamação/perdido: quando a certeza do caso (`caseScoresOf`: a da IA, a
 *    da caixa do caso, ou "Por confirmar" quando a IA disse que a queixa / o
 *    objeto aparece no email) ≥ `suggestMinConfidence`
 *    e quem escreve é de fora (ou a empresa a reencaminhar alguém de fora).
 *    Abaixo de `createMinConfidence` fica "Por confirmar (IA)". Os dois ao
 *    mesmo tempo → o mais certo (empate: reclamação);
 *  - críticas e ocorrências só com o interruptor dos avisos (senão é como se
 *    a IA não tivesse percebido — o que fazia antes);
 *  - caixa de tema (só conversa nova, email novo): a da IA se percebeu; lixo
 *    fica onde está; não percebeu → info (sem info ativa: fica).
 */
export function decideMailTriage(
  out: TriageAiOutput,
  facts: TriageFacts,
  t: TriageThresholds,
  features: TriageFeatures,
  activeBoxes: ReadonlySet<string>,
): TriageDecision {
  const aiBoxKey = parseTriageCategory(out.box);
  const confidence = normalizeConfidence(out.confidence);
  const { complaintScore, lostScore } = caseScoresOf(out, t);
  const noticeOk = !aiBoxKey || !NOTICE_CATEGORIES.has(aiBoxKey) || features.notices;
  const understood = !!aiBoxKey && aiBoxKey !== "geral" && confidence != null && confidence >= t.minConfidence && noticeOk;

  const caseAllowed = facts.sender === "external" || (facts.sender === "company" && facts.forwardedExternal);
  const wantComplaint = features.complaints && caseAllowed && complaintScore >= t.suggestMinConfidence;
  const wantLost = features.lostFound && caseAllowed && lostScore >= t.suggestMinConfidence;
  const caseKind: MailCaseKind | null = wantComplaint && (!wantLost || complaintScore >= lostScore) ? "complaint" : wantLost ? "lost_found" : null;
  const caseScore = caseKind === "complaint" ? complaintScore : caseKind === "lost_found" ? lostScore : null;
  const uncertain = caseScore != null && caseScore < t.createMinConfidence;

  const category: MailTriageCategory = caseKind ? CASE_BOX[caseKind] : understood ? aiBoxKey! : "geral";

  let routeBox: string | null = null;
  if (facts.mode === "sync" && facts.newThread) {
    const topic = understood ? aiBoxKey! : GENERAL_BOX_KEY;
    if (topic !== NOISE_CATEGORY) {
      routeBox = activeBoxes.has(topic) ? topic : activeBoxes.has(GENERAL_BOX_KEY) ? GENERAL_BOX_KEY : null;
    }
  }
  const markRead = !caseKind && category === "criticas" && features.notices && facts.mode === "sync" && facts.newThread;
  return { category, aiBoxKey, confidence, complaintScore, lostScore, understood, caseKind, caseScore, uncertain, routeBox, markRead };
}

/**
 * reclamacoes@ / perdidos@: "tudo o que lá chega é caso, salvo se a IA tiver a
 * certeza de que não é". Só não abre quando a IA diz lixo com certeza ≥ 90 %
 * e não vê reclamação nem perdido. PURA.
 */
export function aliasGateIsNoise(out: TriageAiOutput, t: Pick<TriageThresholds, "suggestMinConfidence">): boolean {
  const k = parseTriageCategory(out.box);
  const c = normalizeConfidence(out.confidence) ?? 0;
  const { complaintScore, lostScore } = caseScoresOf(out, t);
  // A IA disse que há uma queixa ou um objeto (sim/não) → nunca é lixo, mesmo com suggestMinConfidence a 0.
  if (out.complaintMentioned === true || out.lostItemMentioned === true) return false;
  return k === NOISE_CATEGORY && c >= ALIAS_NOISE_MIN_CONFIDENCE && complaintScore < t.suggestMinConfidence && lostScore < t.suggestMinConfidence;
}

// ─── Nota no ecrã ───────────────────────────────────────────────────────────

/** Linha curta do que a triagem fez (vai para o motivo do registo). PURA. */
export function triageReasonText(d: { caseKind: MailCaseKind | null; uncertain: boolean; category: MailTriageCategory }, aiReason: string | null): string | null {
  const why = String(aiReason ?? "").replace(/\s+/g, " ").trim();
  const head = d.caseKind ? `${d.uncertain ? "Por confirmar: " : ""}${CASE_LABEL[d.caseKind]}` : null;
  const text = [head, why || null].filter(Boolean).join(" — ");
  return text ? text.slice(0, 300) : null;
}

// ─── Avaliação ("Testar a triagem") ─────────────────────────────────────────

export interface TriageEvalRow {
  id: string;
  expected: MailTriageCategory;
  /** null = a IA falhou neste email. */
  predicted: MailTriageCategory | null;
}

export interface CategoryMetrics {
  category: MailTriageCategory;
  label: string;
  /** Quantos o corpus diz que são desta categoria. */
  support: number;
  /** Quantos a triagem pôs nesta categoria. */
  predicted: number;
  correct: number;
  recall: number | null;
  precision: number | null;
}

export interface TriageMetrics {
  total: number;
  correct: number;
  failed: number;
  accuracy: number | null;
  byCategory: CategoryMetrics[];
  recallComplaints: number | null;
  recallLostFound: number | null;
  /** A meta do Jorge: mais de 90 % das reclamações e dos perdidos vão para lá. */
  target: number;
  passes: boolean;
}

export const TRIAGE_RECALL_TARGET = 0.9;

/**
 * Os conjuntos rotulados do "Testar a triagem" (server/fixtures): o principal,
 * o de controlo e o CEGO (escrito na auditoria antes de ler os outros dois). A
 * meta tem de passar em todos.
 */
export const TRIAGE_CORPUS_KEYS = ["principal", "controlo", "cego"] as const;
export type TriageCorpusKey = (typeof TRIAGE_CORPUS_KEYS)[number];
export const TRIAGE_CORPUS_LABELS: Record<TriageCorpusKey, string> = {
  principal: "Corpus principal",
  controlo: "Corpus de controlo (independente)",
  cego: "Corpus cego (auditoria)",
};

const ratio = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);

/** Recall e precisão por categoria (uma falha da IA conta como errada). PURA. */
export function triageMetrics(rows: readonly TriageEvalRow[]): TriageMetrics {
  const byCategory = MAIL_TRIAGE_CATEGORIES.map((c): CategoryMetrics => {
    const support = rows.filter((r) => r.expected === c).length;
    const predicted = rows.filter((r) => r.predicted === c).length;
    const correct = rows.filter((r) => r.expected === c && r.predicted === c).length;
    return { category: c, label: MAIL_TRIAGE_CATEGORY_LABELS[c], support, predicted, correct, recall: ratio(correct, support), precision: ratio(correct, predicted) };
  }).filter((m) => m.support > 0 || m.predicted > 0);
  const correct = rows.filter((r) => r.predicted === r.expected).length;
  const rec = (c: MailTriageCategory) => byCategory.find((m) => m.category === c)?.recall ?? null;
  const recallComplaints = rec("reclamacoes");
  const recallLostFound = rec("perdidos");
  return {
    total: rows.length,
    correct,
    failed: rows.filter((r) => r.predicted == null).length,
    accuracy: ratio(correct, rows.length),
    byCategory,
    recallComplaints,
    recallLostFound,
    target: TRIAGE_RECALL_TARGET,
    passes: (recallComplaints ?? 0) >= TRIAGE_RECALL_TARGET && (recallLostFound ?? 0) >= TRIAGE_RECALL_TARGET,
  };
}

/** Uma linha para os logs ("[triagem-eval] …"), sem dados pessoais. PURA. */
export function triageMetricsLogLine(m: TriageMetrics, extra: { model?: string | null; ms?: number | null } = {}): string {
  const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
  const cats = m.byCategory.map((c) => `${c.category}=r${pct(c.recall)}/p${pct(c.precision)}(${c.support})`).join(" ");
  return [
    `[triagem-eval] ${m.passes ? "PASSA" : "NÃO PASSA"} meta ${pct(m.target)}`,
    `reclamacoes recall=${pct(m.recallComplaints)}`,
    `perdidos recall=${pct(m.recallLostFound)}`,
    `acerto=${pct(m.accuracy)} (${m.correct}/${m.total})`,
    `falhas=${m.failed}`,
    extra.model ? `modelo=${extra.model}` : null,
    extra.ms != null ? `${Math.round(extra.ms / 1000)}s` : null,
    cats,
  ].filter(Boolean).join(" · ");
}
