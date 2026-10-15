/**
 * Críticas 5★ — resposta publicada sozinha (plano MPV F7, §6.2; D6). Regras
 * PURAS das salvaguardas, partilhadas pelo trabalho `reviews-5star`
 * (server/reviewAutoPublish.ts), pela página das Críticas e pelos testes.
 *
 * Tudo atrás do interruptor REVIEW_AUTO_PUBLISH_5STAR (desligado por omissão).
 * Publicar é conteúdo PÚBLICO e substitui a resposta que lá estiver, por isso:
 *  1. entrada: só 5★ ligadas ao Google (API/Windsor), recentes, sem
 *     reclamação, sem resposta, não marcadas (não é crítica / repetida), e o
 *     texto sem links, emails, telefones, insultos nem instruções;
 *  2. a resposta (IA barata) passa a validação: 40–400 caracteres, sem
 *     números, links, emails, telefones, marcadores `[…]`, insultos, e na
 *     língua da crítica;
 *  3. fica 6 h à vista na crítica, com "Cancelar";
 *  4. antes de publicar, a crítica é lida outra vez NA FONTE (Google ou
 *     Windsor): tem de continuar com 5★, o mesmo texto e sem resposta;
 *  5. no máximo 20 por dia e por perfil; pára ao fim de 3 falhas seguidas;
 *  6. depois de publicar, verificação diária: se descer das 5★ → aviso.
 */
import { matchKey, matchWords } from "./textKey";
import { REVIEW_AUTO_DRAFT_MAX_AGE_DAYS, reviewAutoDraftEligible } from "./reviewRules";

/** Atraso entre preparar e publicar (h) — tempo para alguém ver e cancelar. */
export const REVIEW_AUTO_PUBLISH_DELAY_HOURS = 6;
/** Publicações automáticas por perfil Google e por dia (de Lisboa). */
export const REVIEW_AUTO_PUBLISH_MAX_PER_PROFILE_DAY = 20;
/** Falhas seguidas (a publicar) que param tudo até alguém retomar. */
export const REVIEW_AUTO_PUBLISH_MAX_CONSECUTIVE_FAILURES = 3;
/** Tentativas de publicar a mesma resposta (as falhadas voltam 30 min depois). */
export const REVIEW_AUTO_PUBLISH_MAX_ATTEMPTS = 3;
export const REVIEW_AUTO_PUBLISH_RETRY_MIN = 30;
/** Resposta à espera há mais do que isto depois da hora (interruptor desligado, agendador parado) → não se publica. */
export const REVIEW_AUTO_PUBLISH_EXPIRE_HOURS = 24;
/** Só críticas escritas nos últimos N dias (a mesma janela dos rascunhos automáticos). */
export const REVIEW_AUTO_PUBLISH_MAX_AGE_DAYS = REVIEW_AUTO_DRAFT_MAX_AGE_DAYS;
/** Verificação depois de publicar: as publicadas nos últimos N dias, uma vez por dia. */
export const REVIEW_AUTO_PUBLISH_VERIFY_DAYS = 30;
export const REPLY_MIN_CHARS = 40;
export const REPLY_MAX_CHARS = 400;

export type AutoPublishStatus = "scheduled" | "published" | "cancelled" | "skipped" | "failed";
export const AUTO_PUBLISH_STATUS_LABELS: Record<AutoPublishStatus, string> = {
  scheduled: "À espera", published: "Publicada sozinha", cancelled: "Cancelada", skipped: "Não publicada", failed: "Falhou",
};

const REVIEW_NAME_RE = /^accounts\/[^/\s]+\/locations\/[^/\s]+\/reviews\/[^/\s]+$/;

// ─── Texto: links, contactos, insultos, instruções ──────────────────────────

const URL_RE = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]{2,}\.(?:com|pt|net|org|io|br|es|fr|eu|uk|de|info|biz|me|app|link|ly)\b/i;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/;
/** 9 ou mais algarismos seguidos (com espaços, pontos, traços ou parênteses pelo meio), com ou sem +/00. */
const PHONE_RE = /(?:\+|00)?\d(?:[\s().-]{0,2}\d){8,}/;

/** Insultos/palavrões (PT, EN, ES, FR), comparados sem acentos e por palavra inteira. */
export const INSULT_WORDS: readonly string[] = [
  "merda", "merdas", "caralho", "caralhos", "foda", "fodase", "fodasse", "foder", "fodam", "fodido", "fodidos", "puta", "putas", "putos", "cabrao", "cabroes",
  "otario", "otarios", "idiota", "idiotas", "estupido", "estupidos", "estupida", "palhaco", "palhacos", "burro", "burros", "ladrao", "ladroes", "ladra",
  "vigarista", "vigaristas", "aldrabao", "aldraboes", "aldrabices", "chulo", "chulos", "porra", "cona", "badalhoco", "nojentos", "escumalha", "corja", "bandidos",
  "fuck", "fucking", "fucked", "shit", "bitch", "asshole", "assholes", "idiot", "idiots", "stupid", "scam", "scammer", "scammers", "crook", "crooks", "thieves",
  "mierda", "joder", "gilipollas", "cabron", "cabrones", "imbecil", "imbeciles", "estafa", "estafadores", "ladrones",
  "connard", "connards", "putain", "merde", "salaud", "escroc", "escrocs", "voleurs",
];
const INSULTS = new Set(INSULT_WORDS);

/**
 * Instruções escondidas no texto (o texto da crítica é um DADO, nunca uma
 * ordem). Na dúvida não se publica sozinho — fica para uma pessoa.
 */
const INJECTION_RES: readonly RegExp[] = [
  /\bignor(?:a|e|ar|em|es|o|ad|en)\b/i,
  /\binstru[cç](?:ao|ão|oes|ões|ciones|cion|tions?)\b|\binstructions?\b/i,
  /\b(?:system\s*prompt|prompt\s+do\s+sistema|prompt)\b/i,
  /\b(?:you\s+are\s+now|from\s+now\s+on|act\s+as|pretend\s+to|finge\s+que|faz\s+de\s+conta|a\s+partir\s+de\s+agora\s+(?:és|es|tu)|eres\s+ahora)(?=[\s,.!?:;]|$)/i,
  /\b(?:responde|responda|reply|answer|escreve|escreva|write)\s+(?:apenas|só|only)(?=[\s,.!?:;]|$)/i,
  /\b(?:chatgpt|gpt|gemini|openai|llm|assistente\s+virtual)\b/i,
  /<\/?\s*(?:system|user|assistant|instruction)\b|\{\{|\}\}|\[\[|\]\]|```/i,
];

export type TextRefusal = "url" | "email" | "phone" | "insult" | "injection";
export const TEXT_REFUSAL_LABELS: Record<TextRefusal, string> = {
  url: "tem um link", email: "tem um email", phone: "tem um telefone", insult: "tem insultos ou palavrões", injection: "parece trazer instruções",
};

/** O texto tem algo que impede a resposta automática? (null = não). PURA. */
export function textRefusal(text: string | null | undefined): TextRefusal | null {
  const t = String(text ?? "");
  if (!t.trim()) return null;
  if (EMAIL_RE.test(t)) return "email";
  if (URL_RE.test(t)) return "url";
  if (PHONE_RE.test(t)) return "phone";
  if (matchWords(t).some((w) => INSULTS.has(w))) return "insult";
  if (INJECTION_RES.some((re) => re.test(t))) return "injection";
  return null;
}

// ─── Língua (para a resposta sair na língua da crítica) ─────────────────────

export type ReplyLanguage = "pt" | "en" | "es" | "fr";
const LANG_WORDS: Record<ReplyLanguage, readonly string[]> = {
  pt: ["nao", "muito", "muita", "obrigado", "obrigada", "obrigados", "servico", "estacionamento", "recomendo", "otimo", "simpatico", "simpaticos", "atendimento", "carro", "rapido", "tudo", "bem", "equipa", "voltaremos", "agradecemos", "esperamos", "breve", "preferencia", "foi", "uma", "um", "com", "do", "da", "os", "as", "voltar", "sempre", "pela", "pelo", "ficamos", "felizes", "saber", "gostou", "experiencia", "nos", "vemos", "proxima", "viagem", "sua", "seu", "muitissimo", "impecavel", "pontual", "pontuais", "simpatia", "profissionais", "cinco", "estrelas"],
  en: ["the", "and", "was", "very", "great", "service", "thank", "thanks", "with", "for", "we", "you", "our", "recommend", "friendly", "staff", "parking", "car", "fast", "everything", "team", "hope", "see", "again", "your", "is", "it", "to", "of", "glad", "enjoyed", "experience", "next", "trip", "much", "were", "excellent", "highly", "easy", "helpful", "stars"],
  es: ["muy", "servicio", "gracias", "fue", "los", "las", "recomiendo", "amables", "aparcamiento", "coche", "todo", "equipo", "verte", "pronto", "y", "el", "su", "nos", "alegra", "experiencia", "proximo", "viaje", "estrellas", "rapido", "atencion", "sin", "duda", "volveremos", "agradecemos", "mucho", "muchas"],
  fr: ["le", "les", "tres", "merci", "avec", "pour", "nous", "vous", "recommande", "personnel", "voiture", "rapide", "tout", "equipe", "esperons", "bientot", "et", "est", "votre", "ravis", "experience", "prochain", "voyage", "etoiles", "accueil", "parfait", "service"],
};
const LANG_SETS = Object.fromEntries(Object.entries(LANG_WORDS).map(([k, v]) => [k, new Set(v)])) as Record<ReplyLanguage, Set<string>>;

/**
 * Língua de um texto pelas palavras mais comuns (pt/en/es/fr); null quando não
 * dá para dizer (texto curto ou empate). PURA.
 */
export function detectLanguage(text: string | null | undefined): ReplyLanguage | null {
  const words = matchWords(text);
  if (!words.length) return null;
  const score = (Object.keys(LANG_SETS) as ReplyLanguage[]).map((l) => ({ l, n: words.filter((w) => LANG_SETS[l].has(w)).length }))
    .sort((a, b) => b.n - a.n);
  if (score[0].n < 2 || score[0].n === score[1].n) return null;
  return score[0].l;
}

/** A língua que a resposta tem de ter: a da crítica; sem texto (ou sem dar para dizer), português. PURA. */
export function expectedReplyLanguage(reviewText: string | null | undefined): ReplyLanguage {
  return detectLanguage(reviewText) ?? "pt";
}

// ─── Entrada ────────────────────────────────────────────────────────────────

export interface AutoPublishCandidate {
  rating: number | null;
  googleReviewName?: string | null;
  complaintId?: number | null;
  status?: string | null;
  googleReply?: string | null;
  respondedAt?: string | null;
  notAReview?: number | boolean | null;
  duplicateOf?: number | null;
  reviewText?: string | null;
  reviewDate?: unknown;
  sourceEmailDate?: unknown;
  createdAt?: unknown;
}

/**
 * A crítica pode ter resposta automática? null = pode; senão o motivo (em
 * texto, fica registado na fila). PURA.
 */
export function autoPublishEntryRefusal(r: AutoPublishCandidate, nowMs: number): string | null {
  if (Number(r.rating ?? 0) !== 5) return "não é de 5★";
  if (!r.googleReviewName || !REVIEW_NAME_RE.test(String(r.googleReviewName))) return "não está ligada ao Google (veio por email)";
  if (r.complaintId) return "tem uma reclamação ligada";
  if (Number(r.notAReview ?? 0) === 1 || r.notAReview === true) return "marcada como não sendo crítica";
  if (r.duplicateOf != null) return "marcada como repetida";
  if (r.googleReply || r.respondedAt) return "já tem resposta";
  if (r.status !== "pending_response" && r.status !== "ai_responded") return "já foi tratada (dispensada, respondida ou convertida)";
  if (!reviewAutoDraftEligible({ reviewDate: r.reviewDate, sourceEmailDate: r.sourceEmailDate, createdAt: r.createdAt }, nowMs)) {
    return `escrita há mais de ${REVIEW_AUTO_PUBLISH_MAX_AGE_DAYS} dias (as antigas respondem-se à mão)`;
  }
  const t = textRefusal(r.reviewText);
  if (t) return `o texto da crítica ${TEXT_REFUSAL_LABELS[t]}`;
  return null;
}

// ─── Saída ──────────────────────────────────────────────────────────────────

/**
 * A resposta escrita pela IA pode sair sozinha? null = pode; senão o motivo. PURA.
 * `raw` = a resposta antes de repor os dados pessoais (não pode ter marcadores).
 */
export function autoReplyRefusal(reply: string | null | undefined, ctx: { reviewText?: string | null; raw?: string | null }): string | null {
  const t = String(reply ?? "").trim();
  if (t.length < REPLY_MIN_CHARS) return `resposta curta demais (menos de ${REPLY_MIN_CHARS} caracteres)`;
  if (t.length > REPLY_MAX_CHARS) return `resposta comprida demais (mais de ${REPLY_MAX_CHARS} caracteres)`;
  if (/[[\]{}<>]/.test(t) || /\[[A-Z_]+_?\d*\]/.test(String(ctx.raw ?? ""))) return "a resposta tem marcadores ou parênteses retos";
  if (EMAIL_RE.test(t)) return "a resposta tem um email";
  if (URL_RE.test(t)) return "a resposta tem um link";
  if (/\d/.test(t)) return "a resposta tem números (telefone, matrícula, valores…)";
  if (matchWords(t).some((w) => INSULTS.has(w))) return "a resposta tem palavras proibidas";
  const want = expectedReplyLanguage(ctx.reviewText);
  const got = detectLanguage(t);
  if (got !== want) return `a resposta não está na língua da crítica (${want}${got ? `, saiu ${got}` : ", não deu para confirmar"})`;
  return null;
}

// ─── Leitura na fonte antes de publicar ─────────────────────────────────────

export type SourceRead =
  | { ok: true; rating: number; text: string | null; hasReply: boolean }
  | { ok: false; reason: string };

/**
 * Depois de ler a crítica na fonte (Google ou Windsor), ainda se publica?
 * null = sim; senão o motivo. Nunca publica sem conseguir ler. PURA.
 */
export function sourceCheckRefusal(stored: { reviewText?: string | null }, source: SourceRead): string | null {
  if (!source.ok) return `não deu para ler a crítica na fonte (${source.reason})`;
  if (source.hasReply) return "a crítica já tem resposta no Google (dada no perfil?)";
  if (source.rating !== 5) return `as estrelas mudaram (agora ${source.rating}★)`;
  if (matchKey(source.text) !== matchKey(stored.reviewText)) return "o texto da crítica mudou no Google";
  return null;
}

// ─── Limites e estado ───────────────────────────────────────────────────────

/** Quando sai (agora + 6 h), em "AAAA-MM-DD HH:MM:SS" UTC. PURA. */
export function scheduledForOf(nowMs: number): string {
  return new Date(nowMs + REVIEW_AUTO_PUBLISH_DELAY_HOURS * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
}

const utcMs = (s: string | null | undefined): number => {
  const v = String(s ?? "").trim();
  if (!v) return NaN;
  return Date.parse(`${v.includes("T") ? v : v.replace(" ", "T")}${/(Z|[+-]\d\d:?\d\d)$/.test(v) ? "" : "Z"}`);
};

/** Já está na hora de publicar? E passou demasiado tempo (não se publica)? PURA. */
export function publishTiming(scheduledFor: string | null | undefined, nowMs: number): "early" | "due" | "expired" {
  const at = utcMs(scheduledFor);
  if (!Number.isFinite(at)) return "expired";
  if (nowMs < at) return "early";
  return nowMs - at > REVIEW_AUTO_PUBLISH_EXPIRE_HOURS * 3_600_000 ? "expired" : "due";
}

export interface AutoPublishState {
  consecutiveFailures: number;
  /** Parado (3 falhas seguidas) desde… — até alguém carregar em "Retomar". */
  pausedAt: string | null;
  pausedReason: string | null;
}
export const EMPTY_AUTO_PUBLISH_STATE: AutoPublishState = { consecutiveFailures: 0, pausedAt: null, pausedReason: null };

/** Estado depois de uma tentativa de publicar. PURA. */
export function nextAutoPublishState(prev: AutoPublishState, outcome: { ok: boolean; error?: string | null }, nowIso: string): AutoPublishState {
  if (outcome.ok) return { ...prev, consecutiveFailures: 0 };
  const n = prev.consecutiveFailures + 1;
  if (n >= REVIEW_AUTO_PUBLISH_MAX_CONSECUTIVE_FAILURES && !prev.pausedAt) {
    return { consecutiveFailures: n, pausedAt: nowIso, pausedReason: String(outcome.error ?? "falhas seguidas").slice(0, 300) };
  }
  return { ...prev, consecutiveFailures: n };
}

/** Lê o estado guardado (JSON); lixo → vazio. PURA. */
export function parseAutoPublishState(raw: unknown): AutoPublishState {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!v || typeof v !== "object") return { ...EMPTY_AUTO_PUBLISH_STATE };
    const o = v as Record<string, unknown>;
    return {
      consecutiveFailures: Math.max(0, Math.floor(Number(o.consecutiveFailures ?? 0) || 0)),
      pausedAt: typeof o.pausedAt === "string" && o.pausedAt ? o.pausedAt : null,
      pausedReason: typeof o.pausedReason === "string" && o.pausedReason ? o.pausedReason.slice(0, 300) : null,
    };
  } catch { return { ...EMPTY_AUTO_PUBLISH_STATE }; }
}
