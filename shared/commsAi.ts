/**
 * IA na comunicação com clientes — regras PURAS (servidor ↔ cliente, testadas):
 *  - reclamações: mapeamento da classificação da IA para o enum, limiares de
 *    confiança, "campo vazio", SLA por prioridade, rascunho (cita a reserva,
 *    nunca promete compensações) e duplicados;
 *  - críticas: sentimento;
 *  - WhatsApp: intenções, urgência e debounce por conversa;
 *  - Perdidos & Achados: lado (perdido/achado) e pré-filtro determinístico.
 *
 * Nada aqui envia mensagens: tudo o que chega ao cliente passa por uma pessoa.
 */

// ─── Reclamações ────────────────────────────────────────────────────────────

export const COMPLAINT_TYPES = ["damage", "dirt", "delay", "overcharge", "staff", "other"] as const;
export type ComplaintType = (typeof COMPLAINT_TYPES)[number];
export const COMPLAINT_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type ComplaintPriority = (typeof COMPLAINT_PRIORITIES)[number];

export const COMPLAINT_TYPE_LABEL_PT: Record<ComplaintType, string> = {
  damage: "Dano", dirt: "Sujidade", delay: "Atraso", overcharge: "Cobrança", staff: "Atendimento", other: "Outro",
};
export const COMPLAINT_PRIORITY_LABEL_PT: Record<ComplaintPriority, string> = {
  low: "Baixa", medium: "Média", high: "Alta", urgent: "Urgente",
};

/** Palavras (PT/EN) que a IA pode devolver → tipo do enum. */
const TYPE_ALIASES: Record<string, ComplaintType> = {
  damage: "damage", dano: "damage", danos: "damage", risco: "damage", riscos: "damage", amolgadela: "damage", avaria: "damage",
  dirt: "dirt", sujidade: "dirt", sujo: "dirt", limpeza: "dirt", lixo: "dirt",
  delay: "delay", atraso: "delay", espera: "delay", demora: "delay", atrasos: "delay",
  overcharge: "overcharge", cobranca: "overcharge", cobrança: "overcharge", preco: "overcharge", preço: "overcharge", faturacao: "overcharge", faturação: "overcharge", pagamento: "overcharge", reembolso: "overcharge",
  staff: "staff", atendimento: "staff", funcionario: "staff", funcionário: "staff", condutor: "staff", comportamento: "staff",
  other: "other", outro: "other", outros: "other",
};

/** Classificação da IA → tipo do enum (desconhecido → "other"). PURA. */
export function mapComplaintType(raw: unknown): ComplaintType {
  const k = String(raw ?? "").trim().toLowerCase();
  if ((COMPLAINT_TYPES as readonly string[]).includes(k)) return k as ComplaintType;
  return TYPE_ALIASES[k] ?? TYPE_ALIASES[k.normalize("NFD").replace(/[̀-ͯ]/g, "")] ?? "other";
}

const PRIORITY_ALIASES: Record<string, ComplaintPriority> = {
  low: "low", baixa: "low", medium: "medium", media: "medium", média: "medium", normal: "medium",
  high: "high", alta: "high", urgent: "urgent", urgente: "urgent", critica: "urgent", crítica: "urgent",
};

export function mapComplaintPriority(raw: unknown): ComplaintPriority {
  const k = String(raw ?? "").trim().toLowerCase();
  return PRIORITY_ALIASES[k] ?? "medium";
}

/** Horas de SLA por prioridade (a sugestão de SLA segue a prioridade). */
export const SLA_HOURS_BY_PRIORITY: Record<ComplaintPriority, number> = { urgent: 12, high: 24, medium: 48, low: 72 };

/** A partir daqui a sugestão aplica-se sozinha (se o campo estiver vazio). */
export const AUTO_APPLY_CONFIDENCE = 0.85;
/** Abaixo disto a sugestão nem se mostra (ruído). */
export const MIN_SHOW_CONFIDENCE = 0.4;

export function clampConfidence(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
}

export type SuggestionField = "type" | "priority" | "sla" | "booking" | "duplicate" | "draft";
export type SuggestionStatus = "pending" | "applied" | "accepted" | "rejected";

/** Campos da reclamação relevantes para saber se uma pessoa já mexeu. */
export interface ComplaintFieldsState {
  complaintType: string | null | undefined;
  complaintPriority: string | null | undefined;
  complaintStatus: string | null | undefined;
  slaDeadline: string | null | undefined;
  reservationRef: string | null | undefined;
  createdById: number | null | undefined;
  assignedToId: number | null | undefined;
}

/**
 * O campo está "vazio" (ninguém o escolheu)? PURA.
 *  - tipo: "other" (é o que o email grava por omissão);
 *  - prioridade/SLA: valores por omissão de um caso criado pelo sistema
 *    (createdById nulo) que ninguém pegou (estado "new", sem responsável);
 *  - reserva: sem referência.
 */
export function isComplaintFieldEmpty(field: SuggestionField, c: ComplaintFieldsState): boolean {
  const untouched = c.createdById == null && (c.complaintStatus ?? "new") === "new" && c.assignedToId == null;
  switch (field) {
    case "type": return !c.complaintType || c.complaintType === "other";
    case "priority": return untouched && (c.complaintPriority ?? "medium") === "medium";
    case "sla": return !c.slaDeadline || untouched;
    case "booking": return !String(c.reservationRef ?? "").trim();
    default: return false;
  }
}

/** Aplica sozinha? Só com confiança alta, campo vazio e nunca duplicados/rascunhos. PURA. */
export function shouldAutoApply(field: SuggestionField, confidence: number, c: ComplaintFieldsState): boolean {
  if (field === "duplicate" || field === "draft") return false;
  return confidence >= AUTO_APPLY_CONFIDENCE && isComplaintFieldEmpty(field, c);
}

/** Frases que prometem compensações (reembolso, desconto, voucher…). */
const COMPENSATION_RE =
  /\b(reembols\w*|indemniz\w*|compensa(?:r|mos|remos|ção|çao|cao)\w*|devolv\w* (?:o|a|os|as) (?:valor|montante|dinheiro|pagamento)|desconto\w*|voucher\w*|vale\w* de (?:desconto|oferta)|crédito na (?:sua )?conta|gratuit\w*|oferec\w* (?:uma|um|a|o) (?:estadia|reserva|lavagem))/i;

/** O texto promete (ou sequer menciona) compensações? PURA. */
export function mentionsCompensation(text: string | null | undefined): boolean {
  return COMPENSATION_RE.test(String(text ?? ""));
}

export const BOOKING_TOKEN = "[RESERVA]";

/**
 * Rascunho final da resposta a uma reclamação. PURA.
 *  - cita SEMPRE a reserva (troca [RESERVA] pela referência; se faltar, junta
 *    uma frase inicial);
 *  - recusa (null) qualquer rascunho que fale em compensações.
 */
export function finalizeComplaintDraft(draft: string | null | undefined, bookingRef: string | null | undefined): string | null {
  let text = String(draft ?? "").replace(/^["“]|["”]$/g, "").trim();
  if (!text) return null;
  if (mentionsCompensation(text)) return null;
  const ref = String(bookingRef ?? "").trim();
  if (ref) text = text.split(BOOKING_TOKEN).join(ref);
  else text = text.replace(/\breserva\s+\[RESERVA\]/gi, "reserva").split(BOOKING_TOKEN).join("sua reserva");
  if (ref && !text.includes(ref)) text = `Relativamente à reserva ${ref}: ${text}`;
  if (!ref && !/reserva/i.test(text)) text = `Relativamente à sua reserva: ${text}`;
  return text.slice(0, 4000);
}

/** Reclamação candidata a duplicado (aberta, do mesmo cliente/reserva). */
export interface DuplicateCandidate {
  id: number;
  clientEmail?: string | null;
  reservationRef?: string | null;
  vehiclePlate?: string | null;
  complaintStatus?: string | null;
  createdAt?: string | null;
}

const OPEN_STATUSES = new Set(["new", "analyzing", "waiting_client"]);
export const DUPLICATE_WINDOW_DAYS = 60;

export function plateKey(raw: string | null | undefined): string {
  return String(raw ?? "").replace(/[\s.-]+/g, "").toUpperCase();
}

/**
 * Duplicado de uma reclamação: a mais antiga das ABERTAS do mesmo cliente
 * (email), da mesma reserva ou da mesma matrícula, dentro da janela. PURA.
 */
export function pickDuplicate(
  self: { id: number; clientEmail?: string | null; reservationRef?: string | null; vehiclePlate?: string | null; createdAt?: string | null },
  candidates: DuplicateCandidate[],
  nowMs: number = Date.now(),
): { id: number; reason: string; confidence: number } | null {
  const email = String(self.clientEmail ?? "").trim().toLowerCase();
  const ref = String(self.reservationRef ?? "").trim();
  const plate = plateKey(self.vehiclePlate);
  let best: { id: number; reason: string; confidence: number; at: number } | null = null;
  for (const c of candidates) {
    if (c.id === self.id) continue;
    if (!OPEN_STATUSES.has(String(c.complaintStatus ?? "new"))) continue;
    const at = c.createdAt ? Date.parse(String(c.createdAt).replace(" ", "T") + (String(c.createdAt).includes("Z") ? "" : "Z")) : nowMs;
    if (Number.isFinite(at) && nowMs - at > DUPLICATE_WINDOW_DAYS * 86_400_000) continue;
    const reasons: string[] = [];
    let conf = 0;
    if (ref && String(c.reservationRef ?? "").trim() === ref) { reasons.push("mesma reserva"); conf = Math.max(conf, 0.9); }
    if (email && String(c.clientEmail ?? "").trim().toLowerCase() === email) { reasons.push("mesmo email"); conf = Math.max(conf, 0.75); }
    if (plate && plate.length >= 4 && plateKey(c.vehiclePlate) === plate) { reasons.push("mesma matrícula"); conf = Math.max(conf, 0.7); }
    if (!reasons.length) continue;
    if (reasons.length > 1) conf = Math.min(0.97, conf + 0.05);
    const t = Number.isFinite(at) ? at : nowMs;
    if (!best || conf > best.confidence || (conf === best.confidence && t < best.at)) best = { id: c.id, reason: reasons.join(" + "), confidence: conf, at: t };
  }
  return best ? { id: best.id, reason: best.reason, confidence: best.confidence } : null;
}

// ─── Críticas ───────────────────────────────────────────────────────────────

export type ReviewSentiment = "positivo" | "neutro" | "negativo";

const NEG_WORDS = /\b(p[ée]ssim\w*|horr[íi]vel|vergonha|burla|nunca mais|n[ãa]o recomendo|mau|m[áa]\b|atras\w*|risc\w*|danific\w*|roub\w*|sujo|demor\w*)/i;
const POS_WORDS = /\b(excelente|[óo]tim\w*|recomendo|impec[áa]vel|r[áa]pid\w*|simp[áa]tic\w*|profissiona\w*|5 estrelas|obrigad\w*)/i;

/** Sentimento da crítica: estrelas primeiro; sem estrelas, palavras-chave. PURA. */
export function reviewSentiment(rating: number | null | undefined, text?: string | null): ReviewSentiment {
  const r = Number(rating ?? 0);
  if (r >= 4) return "positivo";
  if (r >= 1 && r <= 2) return "negativo";
  if (r === 3) return NEG_WORDS.test(String(text ?? "")) ? "negativo" : "neutro";
  const t = String(text ?? "");
  const neg = NEG_WORDS.test(t);
  const pos = POS_WORDS.test(t);
  if (neg && !pos) return "negativo";
  if (pos && !neg) return "positivo";
  return "neutro";
}

// ─── WhatsApp ───────────────────────────────────────────────────────────────

export const WHATSAPP_INTENTS = ["reserva", "alteracao", "cancelamento", "perdido_achado", "reclamacao", "recrutamento", "outro"] as const;
export type WhatsappIntent = (typeof WHATSAPP_INTENTS)[number];

export const WHATSAPP_INTENT_LABELS: Record<WhatsappIntent, string> = {
  reserva: "Reserva",
  alteracao: "Alteração",
  cancelamento: "Cancelamento",
  perdido_achado: "Perdido/achado",
  reclamacao: "Reclamação",
  recrutamento: "Recrutamento/extra",
  outro: "Outro",
};

export const WHATSAPP_URGENCIES = ["normal", "urgente"] as const;
export type WhatsappUrgency = (typeof WHATSAPP_URGENCIES)[number];

const INTENT_ALIASES: Record<string, WhatsappIntent> = {
  reserva: "reserva", reservar: "reserva", booking: "reserva", nova_reserva: "reserva",
  alteracao: "alteracao", alteração: "alteracao", alterar: "alteracao", mudanca: "alteracao", mudança: "alteracao", change: "alteracao",
  cancelamento: "cancelamento", cancelar: "cancelamento", cancel: "cancelamento",
  perdido_achado: "perdido_achado", "perdido/achado": "perdido_achado", perdido: "perdido_achado", achado: "perdido_achado", lost_found: "perdido_achado",
  reclamacao: "reclamacao", reclamação: "reclamacao", queixa: "reclamacao", complaint: "reclamacao",
  recrutamento: "recrutamento", "recrutamento/extra": "recrutamento", extra: "recrutamento", emprego: "recrutamento", trabalho: "recrutamento",
  outro: "outro", other: "outro",
};

export function mapWhatsappIntent(raw: unknown): WhatsappIntent {
  const k = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  return INTENT_ALIASES[k] ?? INTENT_ALIASES[k.normalize("NFD").replace(/[̀-ͯ]/g, "")] ?? "outro";
}

export function isWhatsappIntent(v: unknown): v is WhatsappIntent {
  return typeof v === "string" && (WHATSAPP_INTENTS as readonly string[]).includes(v);
}

export function mapWhatsappUrgency(raw: unknown): WhatsappUrgency {
  const k = String(raw ?? "").trim().toLowerCase();
  return k === "urgente" || k === "urgent" || k === "alta" || k === "high" ? "urgente" : "normal";
}

/** Intervalo mínimo entre duas triagens da mesma conversa. */
export const WHATSAPP_TRIAGE_DEBOUNCE_MINUTES = 5;

/**
 * Debounce por conversa: triagem já (now) se a última foi há ≥ debounce;
 * senão fica agendada para última + debounce (uma rajada de mensagens dá UMA
 * triagem). PURA.
 */
export function whatsappTriagePlan(
  lastTriagedAt: string | null | undefined,
  nowMs: number,
  debounceMinutes: number = WHATSAPP_TRIAGE_DEBOUNCE_MINUTES,
): { runNow: boolean; dueAtMs: number } {
  const last = lastTriagedAt ? Date.parse(String(lastTriagedAt).replace(" ", "T") + (String(lastTriagedAt).includes("Z") ? "" : "Z")) : NaN;
  if (!Number.isFinite(last)) return { runNow: true, dueAtMs: nowMs };
  const due = last + debounceMinutes * 60_000;
  return due <= nowMs ? { runNow: true, dueAtMs: nowMs } : { runNow: false, dueAtMs: due };
}

/** SLA efetivo: urgentes avisam mais cedo (1/3 do SLA, mínimo 5 min). PURA. */
export function effectiveSlaMinutes(slaMinutes: number, urgency: string | null | undefined): number {
  return urgency === "urgente" ? Math.max(5, Math.floor(slaMinutes / 3)) : slaMinutes;
}

// ─── Perdidos & Achados ─────────────────────────────────────────────────────

export interface LostFoundLike {
  id: number;
  clientName?: string | null;
  status?: string | null;
  convertedFromType?: string | null;
  foundLocation?: string | null;
  projectId?: number | null;
  vehiclePlate?: string | null;
  bookingRef?: string | null;
  itemType?: string | null;
  createdAt?: string | null;
}

const CLOSED_LOST = new Set(["returned", "closed", "converted"]);

export function isUnknownClient(name: string | null | undefined): boolean {
  const n = String(name ?? "").trim().toLowerCase();
  return !n || n === "desconhecido" || n === "desconhecida" || n === "n/a" || n === "-";
}

/**
 * Lado do caso: "found" = objeto encontrado sem dono conhecido (ex.: vindo de
 * uma ocorrência); "lost" = cliente reportou e ainda não apareceu; null =
 * fechado/já resolvido. PURA.
 */
export function lostFoundSide(i: LostFoundLike): "lost" | "found" | null {
  if (CLOSED_LOST.has(String(i.status ?? ""))) return null;
  if (isUnknownClient(i.clientName) || i.convertedFromType === "incident") return "found";
  if (i.status === "new" || i.status === "investigating") return "lost";
  return null;
}

export const MATCH_WINDOW_DAYS = 30;
export const MATCH_MAX_CANDIDATES = 5;

const toMs = (s: string | null | undefined): number => {
  if (!s) return NaN;
  const str = String(s);
  return Date.parse(str.includes("T") ? str : str.replace(" ", "T") + "Z");
};

/**
 * Pré-filtro determinístico perdido ↔ achado (sem IA). null = excluído. PURA.
 *  - janela de datas: ±30 dias entre os registos;
 *  - parque: ambos com parque e diferentes → fora;
 *  - pontos: reserva igual +60, matrícula igual +50, mesmo tipo +15, mesmo
 *    parque +10, proximidade de datas até +15; matrículas diferentes −40.
 */
export function prefilterMatch(lost: LostFoundLike, found: LostFoundLike): { score: number; reasons: string[] } | null {
  if (lost.id === found.id) return null;
  const a = toMs(lost.createdAt);
  const b = toMs(found.createdAt);
  let days = 0;
  if (Number.isFinite(a) && Number.isFinite(b)) {
    days = Math.abs(a - b) / 86_400_000;
    if (days > MATCH_WINDOW_DAYS) return null;
  }
  if (lost.projectId != null && found.projectId != null && lost.projectId !== found.projectId) return null;
  const reasons: string[] = [];
  let score = 0;
  const refA = String(lost.bookingRef ?? "").trim();
  const refB = String(found.bookingRef ?? "").trim();
  if (refA && refB && refA === refB) { score += 60; reasons.push("mesma reserva"); }
  const pA = plateKey(lost.vehiclePlate);
  const pB = plateKey(found.vehiclePlate);
  if (pA && pB) {
    if (pA === pB) { score += 50; reasons.push("mesma matrícula"); }
    else score -= 40;
  }
  if (lost.itemType && lost.itemType !== "other" && lost.itemType === found.itemType) { score += 15; reasons.push("mesmo tipo de objeto"); }
  if (lost.projectId != null && lost.projectId === found.projectId) { score += 10; reasons.push("mesmo parque"); }
  score += Math.round(15 * (1 - Math.min(days, MATCH_WINDOW_DAYS) / MATCH_WINDOW_DAYS));
  if (score < 10) return null;
  return { score: Math.min(100, score), reasons };
}

/** Top-N candidatos (maior pontuação primeiro). PURA. */
export function rankMatchCandidates<T extends LostFoundLike>(
  item: T,
  others: T[],
  side: "lost" | "found",
  max: number = MATCH_MAX_CANDIDATES,
): { item: T; score: number; reasons: string[] }[] {
  const out: { item: T; score: number; reasons: string[] }[] = [];
  for (const o of others) {
    if (lostFoundSide(o) !== (side === "lost" ? "found" : "lost")) continue;
    const r = side === "lost" ? prefilterMatch(item, o) : prefilterMatch(o, item);
    if (r) out.push({ item: o, ...r });
  }
  return out.sort((x, y) => y.score - x.score || x.item.id - y.item.id).slice(0, max);
}

/** Pontuação final: IA quando houver (70%) + pré-filtro (30%). PURA. */
export function combinedMatchScore(prefilterScore: number, aiScore: number | null | undefined): number {
  if (aiScore == null || !Number.isFinite(aiScore)) return Math.round(prefilterScore);
  return Math.round(0.7 * Math.max(0, Math.min(100, aiScore)) + 0.3 * prefilterScore);
}
