/**
 * Tutor da Formação — regras PURAS (sem I/O): partir os manuais em trechos
 * pelos títulos, procura por palavras-chave (BM25 simples, sem embeddings —
 * barato), citação literal de um trecho, sequência de dias ("streak"),
 * saudação com o progresso, dicas antes do quiz e cortes de tamanho.
 */
import { TUTOR_SHORT_WORDS, type TutorContextType } from "../shared/trainingTutor";

export interface ManualDoc {
  id: number;
  title: string;
  content: string;
}

export interface Chunk {
  manualId: number;
  manualTitle: string;
  heading: string;
  text: string;
}

export interface ScoredChunk extends Chunk {
  score: number;
  /** Fração dos termos da pergunta que aparecem no trecho (0–1). */
  coverage: number;
}

const MAX_CHUNK_CHARS = 1500;

// ─── Trechos ────────────────────────────────────────────────────────────────

const MD_HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const BOLD_HEADING = /^\s*\*\*([^*]{3,80})\*\*\s*:?\s*$/;
// "1. Receção do cliente", "2.3) Chaves" — curto, começa por maiúscula e sem ponto final.
const NUMBERED_HEADING = /^\s*(\d{1,2}(?:\.\d{1,2})*[.)]?)\s+([A-ZÀ-Ý][^.!?]{2,78})$/;

/** Linha que é um título? Devolve o texto do título ou null. PURA. */
export function headingOf(line: string): string | null {
  const md = MD_HEADING.exec(line);
  if (md) return md[2].replace(/[*_`]/g, "").trim() || null;
  const b = BOLD_HEADING.exec(line);
  if (b) return b[1].trim();
  const n = NUMBERED_HEADING.exec(line);
  if (n) return `${n[1]} ${n[2]}`.trim();
  return null;
}

function splitLong(text: string, max = MAX_CHUNK_CHARS): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = "";
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (cur && cur.length + p.length + 2 > max) { out.push(cur); cur = ""; }
    if (p.length > max) {
      // Parágrafo gigante: corta por frases.
      for (const sentence of p.split(/(?<=[.!?])\s+/)) {
        if (cur && cur.length + sentence.length + 1 > max) { out.push(cur); cur = ""; }
        cur = cur ? `${cur} ${sentence}` : sentence.slice(0, max);
      }
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Parte um manual em trechos pelos títulos (e os longos por parágrafos). PURA. */
export function chunkManual(doc: ManualDoc): Chunk[] {
  const content = String(doc.content ?? "").replace(/\r\n?/g, "\n");
  // Manuais "link" guardam só o URL no conteúdo: nada para ler.
  if (!content.trim() || /^\s*https?:\/\/\S+\s*$/.test(content)) return [];
  const sections: Array<{ heading: string; lines: string[] }> = [{ heading: doc.title, lines: [] }];
  for (const line of content.split("\n")) {
    const h = headingOf(line);
    if (h) sections.push({ heading: h, lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }
  const out: Chunk[] = [];
  for (const s of sections) {
    const body = s.lines.join("\n").trim();
    if (!body) continue;
    for (const piece of splitLong(body)) out.push({ manualId: doc.id, manualTitle: doc.title, heading: s.heading, text: piece });
  }
  return out;
}

export function chunkManuals(docs: readonly ManualDoc[]): Chunk[] {
  return docs.flatMap((d) => chunkManual(d));
}

// ─── Palavras-chave ─────────────────────────────────────────────────────────

const STOPWORDS = new Set(
  (
    "a o as os um uma uns umas de do da dos das dum duma em no na nos nas num numa por pelo pela pelos pelas para pra " +
    "com sem sob sobre ate apos entre e ou mas nem que se ja nao sim mais menos muito muita muitos muitas pouco " +
    "eu tu ele ela nos vos eles elas me te lhe lhes nos vos meu minha meus minhas teu tua teus tuas seu sua seus suas " +
    "este esta estes estas esse essa esses essas aquele aquela aquilo isto isso qual quais quando onde como porque " +
    "quem quanto quanta quantos quantas ser sou es e somos sao era foi foram estar estou estas esta estamos estao " +
    "ter tenho tens tem temos tinha haver ha fazer faco fazes faz devo deves deve devemos posso podes pode podemos " +
    "preciso precisas precisa vou vais vai ir fica ficar sempre tambem entao assim pois aqui ali la cada todo toda " +
    "todos todas outro outra outros outras mesmo mesma algum alguma alguns algumas nenhum nenhuma coisa coisas " +
    "the and or of to in on for is are what how"
  ).split(/\s+/),
);

/** Minúsculas, sem acentos. PURA. */
export function normalizeText(s: string): string {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Raiz grosseira (PT): 5 primeiras letras nas palavras longas, sem o "s" final nas curtas. PURA. */
export function stem(word: string): string {
  if (/^\d+$/.test(word)) return word;
  if (word.length >= 6) return word.slice(0, 5);
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

/** Termos de pesquisa (sem palavras vazias, com raiz). PURA. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of normalizeText(text).split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    if (raw.length < 3 && !/^\d+$/.test(raw)) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

export interface RetrieveOptions {
  topK?: number;
  /** Fração mínima dos termos da pergunta que o melhor trecho tem de ter. */
  minCoverage?: number;
}

/**
 * Os trechos mais relevantes para a pergunta (BM25 simples; o título do
 * trecho e do manual contam a dobrar). Vazio = a pergunta não está no
 * conteúdo. PURA.
 */
export function retrieveChunks(question: string, chunks: readonly Chunk[], opts: RetrieveOptions = {}): ScoredChunk[] {
  const topK = opts.topK ?? 4;
  const minCoverage = opts.minCoverage ?? 0.34;
  const terms = Array.from(new Set(tokenize(question)));
  if (!terms.length || !chunks.length) return [];
  const docs = chunks.map((c) => {
    const body = tokenize(c.text);
    const head = tokenize(`${c.heading} ${c.manualTitle}`);
    const tf = new Map<string, number>();
    for (const t of body) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of head) tf.set(t, (tf.get(t) ?? 0) + 2);
    return { c, tf, len: body.length + head.length };
  });
  const n = docs.length;
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / n || 1;
  const df = new Map<string, number>();
  for (const t of terms) df.set(t, docs.filter((d) => d.tf.has(t)).length);
  const k1 = 1.2, b = 0.75;
  const scored: ScoredChunk[] = [];
  for (const d of docs) {
    let score = 0, hits = 0;
    for (const t of terms) {
      const f = d.tf.get(t) ?? 0;
      if (!f) continue;
      hits++;
      const idf = Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avgLen)));
    }
    if (score > 0) scored.push({ ...d.c, score, coverage: hits / terms.length });
  }
  scored.sort((x, y) => y.score - x.score || y.coverage - x.coverage);
  if (!scored.length || Math.max(...scored.map((s) => s.coverage)) < minCoverage) return [];
  return scored.slice(0, topK);
}

/**
 * Citação LITERAL do trecho: a frase (ou as duas seguidas) com mais termos da
 * pergunta, cortada em `maxChars`. PURA.
 */
export function bestQuote(chunk: Pick<Chunk, "text">, query: string, maxChars = 240): string {
  const terms = new Set(tokenize(query));
  const sentences = chunk.text
    .replace(/^[#>*\-\s]+/gm, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (!sentences.length) return "";
  let best = 0, bestScore = -1;
  sentences.forEach((s, i) => {
    const score = tokenize(s).filter((t) => terms.has(t)).length;
    if (score > bestScore) { best = i; bestScore = score; }
  });
  let quote = sentences[best];
  if (quote.length < 80 && sentences[best + 1]) quote = `${quote} ${sentences[best + 1]}`;
  return clipChars(quote, maxChars);
}

export function clipChars(s: string, max: number): string {
  const t = String(s ?? "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

/** Corta uma resposta a `max` palavras (numa frase inteira, se der). PURA. */
export function limitWords(text: string, max: number = TUTOR_SHORT_WORDS): string {
  const t = String(text ?? "").trim();
  const words = t.split(/\s+/);
  if (words.length <= max) return t;
  const cut = words.slice(0, max).join(" ");
  const lastEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.endsWith(".") ? cut.length - 1 : -1);
  if (lastEnd > cut.length * 0.6) return cut.slice(0, lastEnd + 1);
  return `${cut}…`;
}

/** Chave para agrupar perguntas iguais (sem acentos/pontuação). PURA. */
export function questionKey(q: string): string {
  return normalizeText(q).replace(/[^a-z0-9[\]_ ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 190);
}

// ─── Resposta "não está no conteúdo" ────────────────────────────────────────

/** O modelo responde com este marcador quando os trechos não têm a resposta. */
export const OUT_OF_CONTENT_MARKER = "SEM_RESPOSTA";

export function isOutOfContentReply(text: string): boolean {
  return normalizeText(text).replace(/[^a-z_]/g, "").includes("sem_resposta");
}

/** Texto fixo (nunca inventado) quando a resposta não está nos manuais. PURA. */
export function outOfContentAnswer(trainerName: string | null | undefined): string {
  const who = trainerName ? `ao teu formador, ${trainerName}` : "ao teu formador";
  return `Isso não está nos manuais desta formação, por isso não te quero dar uma resposta inventada. Pergunta ao formador: fala ${who}. Entretanto, continua — estás a ir bem!`;
}

// ─── Sequência de dias e saudação ───────────────────────────────────────────

/** Dias seguidos com atividade até hoje (ou até ontem, se hoje ainda não houve). PURA. */
export function computeStreak(days: Iterable<string>, today: string): number {
  const set = new Set(days);
  const prev = (d: string) => {
    const t = new Date(`${d}T12:00:00Z`);
    t.setUTCDate(t.getUTCDate() - 1);
    return t.toISOString().slice(0, 10);
  };
  let cur = set.has(today) ? today : prev(today);
  let n = 0;
  while (set.has(cur)) { n++; cur = prev(cur); }
  return n;
}

export interface NextStep { itemType: string; itemId: number; title: string; pathName?: string | null }

export interface GreetingInput {
  firstName: string | null;
  modulesDone: number;
  modulesTotal: number;
  nextStep: NextStep | null;
  streak: number;
  contextType: TutorContextType;
  contextTitle: string | null;
}

const ITEM_LABEL: Record<string, string> = { video: "o vídeo", manual: "o manual", exam: "o exame", quiz: "o quiz" };

/** Saudação curta com o progresso (sem IA — não custa nada). PURA. */
export function buildGreeting(g: GreetingInput): string {
  const parts: string[] = [g.firstName ? `Olá, ${g.firstName}!` : "Olá!"];
  if (g.modulesTotal > 0) {
    if (g.modulesDone >= g.modulesTotal) parts.push(`Já concluíste os ${g.modulesTotal} módulos da tua formação — parabéns!`);
    else parts.push(`Já concluíste ${g.modulesDone} de ${g.modulesTotal} módulos.`);
  } else if (g.modulesDone > 0) {
    parts.push(`Já concluíste ${g.modulesDone} módulo${g.modulesDone === 1 ? "" : "s"}.`);
  }
  if (g.streak >= 2) parts.push(`Estás há ${g.streak} dias seguidos a aprender. Continua assim!`);
  else if (g.streak === 1) parts.push("Bom ritmo hoje!");
  if (g.nextStep) {
    const lbl = ITEM_LABEL[g.nextStep.itemType];
    parts.push(`Próximo passo: ${lbl ? `${lbl} ` : ""}«${g.nextStep.title}».`);
  }
  const where =
    g.contextType === "quiz" ? "Antes do quiz, vê as dicas abaixo."
      : g.contextTitle ? `Tens dúvidas sobre «${g.contextTitle}»? Pergunta-me.`
        : "Tens dúvidas? Pergunta-me.";
  parts.push(where);
  return parts.join(" ");
}

/** Dicas antes do quiz: gerais + temas a rever (títulos dos manuais por ler). PURA. */
export function quizTips(reviewTopics: Array<{ manualTitle: string; heading: string }>): string[] {
  const tips = [
    "Lê cada pergunta até ao fim antes de escolheres.",
    "Elimina primeiro as opções que sabes que estão erradas.",
    "Não há tempo limite no quiz: vai com calma.",
  ];
  const seen = new Set<string>();
  for (const t of reviewTopics) {
    const label = t.heading && t.heading !== t.manualTitle ? `«${t.heading}» (${t.manualTitle})` : `«${t.manualTitle}»`;
    if (seen.has(label)) continue;
    seen.add(label);
    tips.push(`Revê ${label}.`);
    if (seen.size >= 3) break;
  }
  return tips;
}
