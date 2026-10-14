/**
 * Formação com IA — regras PURAS (sem BD nem IA), testadas em trainingAi.test.ts.
 *
 *  - FAQs semanais da base de conhecimento: que documentos escolher, quando
 *    uma FAQ é "a mesma" que outra (incluindo as eliminadas, que ficam
 *    arquivadas) e que FAQs novas ficam;
 *  - quiz feito pela IA em cada jogo: validação das perguntas, baralhar as
 *    opções (a letra certa não fica sempre na mesma), não repetir as que a
 *    pessoa já teve, trechos ao acaso (cada jogo é diferente) e o que vai para
 *    o browser (nunca a resposta certa).
 */
import { z } from "zod";
import { kbPlainText } from "../shared/knowledge";
import { matchKey, matchWords } from "../shared/textKey";
import { lisbonDay, parseDbDate } from "./trainingRules";

// ─── Comum ─────────────────────────────────────────────────────────────────

const STOP = new Set(
  (
    "a o as os um uma uns umas de do da dos das em no na nos nas num numa por pelo pela pelos pelas para pra com sem sob sobre " +
    "e ou mas que se ja nao sim mais menos muito eu tu ele ela nos me te lhe meu minha teu tua seu sua este esta isto isso esse essa " +
    "qual quais quando onde como porque quem quanto quantos ser sou es e foi sao estar estou esta estao ter tenho tens tem temos " +
    "fazer faco fazes faz devo deves deve posso podes pode preciso precisas precisa vou vais vai ir ha"
  ).split(/\s+/),
);

/** Palavras com conteúdo (sem acentos, sem palavras vazias, raiz de 5 letras). PURA. */
export function contentTokens(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const w of matchWords(text)) {
    if (STOP.has(w)) continue;
    if (w.length < 3 && !/^\d+$/.test(w)) continue;
    out.push(w.length >= 6 ? w.slice(0, 5) : w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
  }
  return out;
}

/** Chave de uma pergunta (para "é a mesma?"): as palavras com conteúdo, por ordem. PURA. */
export function questionKeyOf(q: string | null | undefined): string {
  return contentTokens(q).join(" ").slice(0, 190);
}

/** Parecença entre duas perguntas (Jaccard das palavras com conteúdo, 0–1). PURA. */
export function questionSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const A = new Set(contentTokens(a));
  const B = new Set(contentTokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** A partir daqui duas perguntas contam como a mesma (reformular não chega). */
export const SAME_QUESTION_SIMILARITY = 0.6;

/** Texto da IA sem Markdown, sem HTML e com tamanho máximo. PURA. */
export function cleanAiText(s: string | null | undefined, max: number): string {
  const plain = kbPlainText(String(s ?? "").replace(/<[^>]*>/g, " "))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ +([,.;:!?])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

// ─── FAQs da base de conhecimento ───────────────────────────────────────────

/** Documentos por semana, FAQs por semana e candidatas pedidas por documento. */
export const FAQ_WEEKLY_DOCS = 3;
export const FAQ_WEEKLY_MAX = 3;
export const FAQ_CANDIDATES_PER_DOC = 2;
/** Documentos com menos texto do que isto não dão FAQ. */
export const FAQ_MIN_DOC_CHARS = 400;
/** Um documento sem mudanças volta a ser escolhido só passado este tempo (e se ainda couber). */
export const FAQ_REVISIT_DAYS = 28;

export interface FaqDocCandidate {
  id: number;
  title: string;
  charCount: number;
  /** Última mudança do documento (Drive ou sincronização), ISO ou "AAAA-MM-DD HH:MM:SS". */
  updatedAt: string | null;
  /** FAQs da IA que já saíram deste documento (incluindo as eliminadas/arquivadas). */
  faqCount: number;
  /** Quando saiu a última FAQ deste documento. */
  lastFaqAt: string | null;
}

const toMs = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const t = String(s).includes("T") ? String(s) : String(s).replace(" ", "T");
  const ms = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(t) ? t : `${t}Z`);
  return Number.isFinite(ms) ? ms : null;
};

/** Quantas FAQs um documento aguenta (1 por 3000 caracteres, entre 2 e 8). PURA. */
export function faqCapacity(charCount: number): number {
  return Math.max(2, Math.min(8, Math.floor(Math.max(0, charCount) / 3000)));
}

/**
 * Os documentos desta semana. Primeiro os que têm novidade (nunca deram FAQ,
 * ou mudaram depois da última): pontos por "sem FAQ" (2) e por mudança
 * recente (2 até 14 dias, 1 até 60), desempate pelo mais recente. Se
 * faltarem, os que ainda aguentam FAQs e não são visitados há 28 dias (o
 * mais antigo primeiro). PURA.
 */
export function pickFaqDocs(docs: readonly FaqDocCandidate[], now: Date, n = FAQ_WEEKLY_DOCS): FaqDocCandidate[] {
  const nowMs = now.getTime();
  const day = 86_400_000;
  const fresh: Array<{ d: FaqDocCandidate; score: number; upd: number }> = [];
  const revisit: Array<{ d: FaqDocCandidate; last: number }> = [];
  for (const d of docs) {
    if (!d || d.charCount < FAQ_MIN_DOC_CHARS) continue;
    const upd = toMs(d.updatedAt) ?? 0;
    const last = toMs(d.lastFaqAt);
    const neverHadFaq = d.faqCount <= 0 || last == null;
    if (neverHadFaq || upd > (last ?? 0)) {
      const age = nowMs - upd;
      const score = (neverHadFaq ? 2 : 0) + (upd && age <= 14 * day ? 2 : upd && age <= 60 * day ? 1 : 0);
      fresh.push({ d, score, upd });
    } else if (d.faqCount < faqCapacity(d.charCount) && last != null && nowMs - last >= FAQ_REVISIT_DAYS * day) {
      revisit.push({ d, last });
    }
  }
  fresh.sort((a, b) => b.score - a.score || b.upd - a.upd || a.d.id - b.d.id);
  revisit.sort((a, b) => a.last - b.last || a.d.id - b.d.id);
  return [...fresh.map((x) => x.d), ...revisit.map((x) => x.d)].slice(0, Math.max(0, n));
}

export interface ExistingFaq { question: string; aiKey?: string | null }

/** Já existe (ou existiu: as eliminadas contam) uma FAQ igual ou quase? PURA. */
export function isDuplicateFaq(question: string, existing: readonly ExistingFaq[]): boolean {
  const key = questionKeyOf(question);
  if (!key) return true;
  for (const e of existing) {
    if (e.aiKey && e.aiKey === key) return true;
    if (questionKeyOf(e.question) === key) return true;
    if (questionSimilarity(question, e.question) >= SAME_QUESTION_SIMILARITY) return true;
  }
  return false;
}

export interface FaqCandidate { question: string; answer: string }
export interface NewFaq { docId: number; docTitle: string; question: string; answer: string; aiKey: string }

/** Pergunta e resposta limpas (ou null se não servem). PURA. */
export function cleanFaqCandidate(c: FaqCandidate): FaqCandidate | null {
  let question = cleanAiText(c?.question, 200).replace(/\s+/g, " ").trim();
  const answer = cleanAiText(c?.answer, 700);
  if (question.length < 10 || answer.length < 20) return null;
  if (!/[?？]$/.test(question)) question = `${question.replace(/[.!:;]+$/, "")}?`;
  return { question, answer };
}

/**
 * As FAQs novas desta corrida: uma de cada documento à vez (para variar),
 * sem repetir nenhuma que já exista ou existiu, nem duas iguais entre si,
 * até `max`. PURA.
 */
export function selectNewFaqs(perDoc: ReadonlyArray<{ docId: number; docTitle: string; items: readonly FaqCandidate[] }>, existing: readonly ExistingFaq[], max = FAQ_WEEKLY_MAX): NewFaq[] {
  const out: NewFaq[] = [];
  const seen: ExistingFaq[] = [...existing];
  const queues = perDoc.map((d) => ({ ...d, items: d.items.map(cleanFaqCandidate).filter((x): x is FaqCandidate => !!x) }));
  let progressed = true;
  while (out.length < max && progressed) {
    progressed = false;
    for (const q of queues) {
      if (out.length >= max) break;
      while (q.items.length) {
        const c = q.items.shift()!;
        if (isDuplicateFaq(c.question, seen)) continue;
        const aiKey = questionKeyOf(c.question);
        out.push({ docId: q.docId, docTitle: q.docTitle, question: c.question, answer: c.answer, aiKey });
        seen.push({ question: c.question, aiKey });
        progressed = true;
        break;
      }
    }
  }
  return out;
}

// ─── Quiz feito pela IA ─────────────────────────────────────────────────────

export type Letter = "A" | "B" | "C" | "D";
export const LETTERS: readonly Letter[] = ["A", "B", "C", "D"];
/** Com menos perguntas válidas do que isto, o jogo usa a lista fixa. */
export const LIVE_QUIZ_MIN_VALID = 5;

export interface LiveQuestion {
  question: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correctOption: Letter;
  explanation: string | null;
  difficulty: "easy" | "medium" | "hard";
  /** Trecho de onde saiu ("S1"…), se a IA disse e existe. */
  sourceTag: string | null;
  /** Pode ter saído de um documento restrito (papel/cidade)? Preenchido por quem gera. */
  restricted?: boolean;
}

const liveSchema = z.object({
  question: z.string().min(8).max(600),
  optionA: z.string().min(1).max(300),
  optionB: z.string().min(1).max(300),
  optionC: z.string().min(1).max(300),
  optionD: z.string().min(1).max(300),
  correctOption: z.enum(["A", "B", "C", "D"]),
  explanation: z.string().max(1200).nullable().optional(),
  difficulty: z.enum(["easy", "medium", "hard"]).nullable().optional(),
  source: z.string().max(10).nullable().optional(),
});

/** Baralha as quatro opções e acerta a letra certa (Fisher–Yates; `rand` para testes). PURA. */
export function shuffleOptions<T extends Pick<LiveQuestion, "optionA" | "optionB" | "optionC" | "optionD" | "correctOption">>(q: T, rand: () => number = Math.random): T {
  const opts = LETTERS.map((l) => ({ l, text: q[`option${l}`] as string }));
  for (let i = opts.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [opts[i], opts[j]] = [opts[j], opts[i]];
  }
  const correctIdx = opts.findIndex((o) => o.l === q.correctOption);
  return {
    ...q,
    optionA: opts[0].text, optionB: opts[1].text, optionC: opts[2].text, optionD: opts[3].text,
    correctOption: LETTERS[correctIdx],
  };
}

/**
 * Perguntas da IA que servem: formato certo, quatro opções diferentes, sem
 * repetir entre si nem as que a pessoa já teve (`recent`, pela parecença),
 * opções baralhadas, no máximo `n`. PURA (salvo `rand`).
 */
export function validateLiveQuestions(raw: readonly unknown[], opts: { n: number; recent?: readonly string[]; sourceTags?: ReadonlySet<string>; rand?: () => number }): LiveQuestion[] {
  const out: LiveQuestion[] = [];
  const seen: string[] = [...(opts.recent ?? [])];
  for (const item of raw ?? []) {
    if (out.length >= opts.n) break;
    const r = liveSchema.safeParse(item);
    if (!r.success) continue;
    const q = r.data;
    const texts = [q.optionA, q.optionB, q.optionC, q.optionD].map((t) => cleanAiText(t, 300));
    if (texts.some((t) => !t)) continue;
    if (new Set(texts.map((t) => matchKey(t))).size !== 4) continue;
    // Opção "marcada" como a certa (✓, "(correta)"…): a pergunta não serve.
    if ([q.optionA, q.optionB, q.optionC, q.optionD].some(optionLooksMarked)) continue;
    const question = cleanAiText(q.question, 600);
    if (question.length < 8) continue;
    if (seen.some((p) => questionKeyOf(p) === questionKeyOf(question) || questionSimilarity(p, question) >= SAME_QUESTION_SIMILARITY)) continue;
    const tag = q.source && opts.sourceTags?.has(q.source.trim().toUpperCase()) ? q.source.trim().toUpperCase() : null;
    const base: LiveQuestion = {
      question, optionA: texts[0], optionB: texts[1], optionC: texts[2], optionD: texts[3], correctOption: q.correctOption,
      explanation: q.explanation ? cleanAiText(q.explanation, 600) || null : null, difficulty: q.difficulty ?? "medium", sourceTag: tag,
    };
    out.push(shuffleOptions(base, opts.rand));
    seen.push(question);
  }
  return out;
}

/** Baralha (Fisher–Yates) uma cópia. PURA (salvo `rand`). */
export function shuffled<T>(list: readonly T[], rand: () => number = Math.random): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface Excerpt { title: string; section: string | null; text: string; kbDocId?: number | null; manualId?: number | null }

/**
 * Trechos para um jogo: baralhados e cortados por um orçamento de caracteres
 * (cada jogo leva trechos diferentes → perguntas diferentes). No máximo 2
 * trechos do mesmo documento, para não ficar tudo sobre o mesmo. PURA (salvo `rand`).
 */
export function pickExcerpts<T extends Excerpt>(list: readonly T[], opts: { maxChars: number; maxItems?: number; perDoc?: number; rand?: () => number }): T[] {
  const out: T[] = [];
  const perDoc = new Map<string, number>();
  let used = 0;
  for (const e of shuffled(list, opts.rand)) {
    if (out.length >= (opts.maxItems ?? 10)) break;
    const text = String(e.text ?? "").trim();
    if (text.length < 80) continue;
    const doc = e.kbDocId ? `k${e.kbDocId}` : e.manualId ? `m${e.manualId}` : `t${matchKey(e.title)}`;
    if ((perDoc.get(doc) ?? 0) >= (opts.perDoc ?? 2)) continue;
    if (used + Math.min(text.length, 2500) > opts.maxChars && out.length) continue;
    perDoc.set(doc, (perDoc.get(doc) ?? 0) + 1);
    used += Math.min(text.length, 2500);
    out.push(e);
  }
  return out;
}

/** O que vai para o browser: a pergunta e as opções, NUNCA a resposta certa nem a explicação. PURA. */
export function toPlayerQuestion(q: { id: number; question: string; optionA: string; optionB: string; optionC: string; optionD: string; points?: number | null; difficulty?: string | null }) {
  return { id: q.id, question: q.question, optionA: q.optionA, optionB: q.optionB, optionC: q.optionC, optionD: q.optionD, points: q.points ?? 10, difficulty: q.difficulty ?? "medium" };
}

/**
 * A opção vem "marcada" como a certa? (um tema escrito pela pessoa pode pedir
 * à IA "marca a certa" para subir no ranking — essas perguntas caem). PURA.
 */
export function optionLooksMarked(text: string | null | undefined): boolean {
  const t = String(text ?? "");
  if (/[✓✔✅☑]/u.test(t)) return true;
  if (/^\s*\*/.test(t) || /\*\s*$/.test(t)) return true;
  return /\((?:a\s+)?(?:correta|certa|verdadeira|resposta\s+certa)\)|\[(?:correta|certa)\]|(?:^|\s)(?:<-|←)\s*(?:correta|certa)/i.test(t);
}

// ─── Documentos restritos (papel/cidade) ────────────────────────────────────

/**
 * Visibilidade de um documento da base de conhecimento é "toda a gente"? A
 * mesma regra do SQL (NULL, '' ou '[]' nos papéis E nas cidades). PURA.
 */
export function isPublicKbVisibility(rolesRaw: unknown, citiesRaw: unknown): boolean {
  const empty = (raw: unknown): boolean => {
    if (raw == null) return true;
    if (Array.isArray(raw)) return raw.length === 0;
    const s = String(raw).trim();
    if (s === "" || s === "[]") return true;
    try { const v = JSON.parse(s); return Array.isArray(v) && v.length === 0; } catch { return false; }
  };
  return empty(rolesRaw) && empty(citiesRaw);
}

/**
 * Uma pergunta da IA pode ter saído de um documento restrito? Com a fonte
 * (S1…) sabe-se de que trecho; sem fonte, conta o pior caso (algum trecho do
 * jogo era restrito). `publicByTag`: trecho → é de toda a gente. PURA.
 */
export function liveQuestionRestricted(sourceTag: string | null | undefined, publicByTag: ReadonlyMap<string, boolean>): boolean {
  if (sourceTag && publicByTag.has(sourceTag)) return !publicByTag.get(sourceTag);
  for (const pub of publicByTag.values()) if (!pub) return true;
  return false;
}

export type AiQuestionAccess = "public" | "restricted_visible" | "hidden";

/**
 * Quem gere a formação pode ver esta pergunta da IA? Pública → sim; restrita
 * → só se a fonte for um documento conhecido que ESTA pessoa pode ver (sem
 * fonte conhecida fica escondida). `doc`: o documento de origem agora (ou null). PURA.
 */
export function aiQuestionAccess(
  q: { restricted?: number | boolean | null; sourceKbDocId?: number | null },
  doc: { isPublic: boolean; viewerCanSee: boolean } | null,
): AiQuestionAccess {
  const flagged = !!q.restricted;
  if (q.sourceKbDocId) {
    if (!doc) return "hidden"; // documento que já não existe: não se sabe quem o podia ver
    if (!flagged && doc.isPublic) return "public";
    return doc.viewerCanSee ? "restricted_visible" : "hidden";
  }
  return flagged ? "hidden" : "public";
}

/**
 * Reserva de uma tentativa (quiz da IA): a reserva só vale se for uma das
 * primeiras `max` do dia de Lisboa (por id — dois cliques ao mesmo tempo não
 * passam os dois do limite). `rows`: tentativas recentes não anuladas. PURA.
 */
export function reservationWithinLimit(rows: ReadonlyArray<{ id: number; startedAt: string | Date }>, ownId: number, now: Date, max: number): boolean {
  if (!max || max <= 0) return true;
  const today = lisbonDay(now);
  const before = rows.filter((r) => r.id <= ownId && lisbonDay(parseDbDate(r.startedAt)) === today).length;
  return before <= max;
}

/** Respostas guardadas na tentativa (JSON) → lista limpa. PURA. */
export function parseStoredAnswers(raw: string | null | undefined): Array<{ questionId: number; answer: Letter }> {
  try {
    const v = JSON.parse(String(raw ?? "[]"));
    if (!Array.isArray(v)) return [];
    return v
      .map((a: any) => ({ questionId: Number(a?.questionId), answer: String(a?.answer ?? "").toUpperCase() as Letter }))
      .filter((a) => Number.isInteger(a.questionId) && a.questionId > 0 && (LETTERS as readonly string[]).includes(a.answer));
  } catch {
    return [];
  }
}
