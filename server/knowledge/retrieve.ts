/**
 * Base de conhecimento — recuperação para o assistente e o tutor.
 *
 *   visibilidade (SQL, papel + cidades de quem pergunta) → pré-seleção barata
 *   (FULLTEXT; sem índice ou sem resultados → LIKE nas palavras mais longas)
 *   → nova verificação da visibilidade em código (nunca um trecho de um
 *   documento restrito chega a um prompt) → pontuação por palavras-chave
 *   → reordenação por embeddings (cosseno com o vetor da pergunta) quando os
 *   vetores estão ligados e a IA responde; se falhar, fica a ordem por
 *   palavras-chave. Tudo com LIMIT e dentro de poucos segundos.
 */
import { sql, type SQL } from "drizzle-orm";
import { KB_HELP_SECTION_SOURCE, canSeeKbDoc, parseVisibility, type KbCitation, type KbSource, type KbViewer } from "../../shared/knowledge";
import { normalizeText, tokenize } from "../trainingTutorRules";
import { kbVisibilitySql, rowsOf, type Db } from "./store";

export interface KbHit {
  chunkId: number;
  docId: number;
  title: string;
  section: string | null;
  text: string;
  href: string | null;
  source: KbSource;
  score: number;
  /** Chave do documento (kb_documents.driveFileId; na ajuda, "help:<ficheiro>.md"). */
  ref?: string | null;
}

export interface KbRetrieval {
  hits: KbHit[];
  citations: KbCitation[];
  mode: "embeddings" | "fulltext" | "keywords" | "none";
  /** A consulta falhou (BD/IA) — não é o mesmo que "os manuais não falam disso" (18d). */
  failed?: boolean;
  /** Com `helpTopK`: os trechos da AJUDA da app (fonte "help"), ordenados à parte. */
  helpHits?: KbHit[];
}

export type QueryEmbedFn = (question: string) => Promise<number[] | null>;

const CANDIDATES = 40;

/** Palavras para o LIKE de recurso (as 6 mais longas, sem acentos). PURA. */
export function fallbackTerms(question: string): string[] {
  const words = normalizeText(question).split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 6);
}

/** Texto para o MATCH … AGAINST (só letras/dígitos/espaços). PURA. */
export function fulltextQuery(question: string): string {
  return String(question ?? "").replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Fração dos termos da pergunta presentes no trecho (0–1). PURA. */
export function keywordScore(question: string, text: string): number {
  const q = [...new Set(tokenize(question))];
  if (!q.length) return 0;
  const t = new Set(tokenize(text));
  return q.filter((w) => t.has(w)).length / q.length;
}

export interface CandidateRow {
  id: number; docId: number; section: string | null; text: string; embedding: string | null;
  title: string; webViewLink: string | null; source: KbSource; visibilityRoles: unknown; visibilityCities: unknown; ft: number;
  ref?: string | null;
}

function toRow(r: any): CandidateRow {
  return {
    id: Number(r.id), docId: Number(r.docId), section: r.section != null ? String(r.section) : null, text: String(r.text ?? ""),
    embedding: r.embedding != null ? String(r.embedding) : null, title: String(r.title ?? ""), webViewLink: r.webViewLink != null ? String(r.webViewLink) : null,
    source: String(r.source) as KbSource, visibilityRoles: r.visibilityRoles, visibilityCities: r.visibilityCities, ft: Number(r.ft ?? 0) || 0,
    ref: r.driveFileId != null ? String(r.driveFileId) : null,
  };
}

type SourceOpts = { excludeSources?: KbSource[]; onlySources?: KbSource[]; docIds?: number[] };

/** As condições de sempre sobre o documento: não apagado, sincronizado, VISÍVEL para quem pergunta, fontes. */
function baseConds(viewer: KbViewer, opts: SourceOpts): SQL[] {
  const base: SQL[] = [sql`d.deletedAt IS NULL`, sql`d.status = 'synced'`, kbVisibilitySql(viewer)];
  if (opts.excludeSources?.length) base.push(sql`d.source NOT IN (${sql.join(opts.excludeSources.map((x) => sql`${x}`), sql`, `)})`);
  if (opts.onlySources?.length) base.push(sql`d.source IN (${sql.join(opts.onlySources.map((x) => sql`${x}`), sql`, `)})`);
  // As secções da ajuda (MPV) só entram quando pedidas (repetem o texto da ajuda por ficheiro).
  if (!opts.onlySources?.includes(KB_HELP_SECTION_SOURCE)) base.push(sql`d.source <> 'help_sec'`);
  if (opts.docIds?.length) base.push(sql`d.id IN (${sql.join(opts.docIds.map((x) => sql`${x}`), sql`, `)})`);
  return base;
}
const CANDIDATE_COLS = sql`c.id, c.docId, c.section, c.text, c.embedding, d.title, d.webViewLink, d.source, d.visibilityRoles, d.visibilityCities, d.driveFileId`;

/** Candidatos visíveis (FULLTEXT → LIKE). */
export async function candidateChunks(d: Db, question: string, viewer: KbViewer, opts: SourceOpts = {}): Promise<{ rows: CandidateRow[]; mode: "fulltext" | "keywords" }> {
  const base = baseConds(viewer, opts);
  const cols = CANDIDATE_COLS;
  const ftq = fulltextQuery(question);
  if (ftq) {
    try {
      const rows = rowsOf(await d.execute(sql`SELECT /*+ MAX_EXECUTION_TIME(2000) */ ${cols}, MATCH(c.section, c.text) AGAINST (${ftq} IN NATURAL LANGUAGE MODE) AS ft
        FROM kb_chunks c JOIN kb_documents d ON d.id = c.docId
        WHERE ${sql.join(base, sql` AND `)} AND MATCH(c.section, c.text) AGAINST (${ftq} IN NATURAL LANGUAGE MODE)
        ORDER BY ft DESC LIMIT ${CANDIDATES}`)).map(toRow);
      if (rows.length) return { rows, mode: "fulltext" };
    } catch { /* sem índice FULLTEXT: segue para o LIKE */ }
  }
  const terms = fallbackTerms(question);
  if (!terms.length) return { rows: [], mode: "keywords" };
  const likes = terms.map((w) => sql`LOWER(c.text) LIKE ${`%${w}%`}`);
  const rows = rowsOf(await d.execute(sql`SELECT /*+ MAX_EXECUTION_TIME(2000) */ ${cols}, 0 AS ft
    FROM kb_chunks c JOIN kb_documents d ON d.id = c.docId
    WHERE ${sql.join(base, sql` AND `)} AND (${sql.join(likes, sql` OR `)})
    LIMIT ${CANDIDATES * 2}`)).map(toRow);
  return { rows, mode: "keywords" };
}

/**
 * Plano MPV (F5): os trechos `ids` (os vizinhos por vetor escolhidos em
 * memória) confirmados na BD com as MESMAS condições dos candidatos —
 * visibilidade de quem pergunta (`kbVisibilitySql`), sincronizado, não
 * apagado, fontes — e depois `canSeeKbDoc` em código. `ft` = 0 (não vieram do
 * FULLTEXT). Lança se a BD falhar (quem chama fica com a lexical).
 */
export async function chunksByIds(d: Db, ids: readonly number[], viewer: KbViewer, opts: SourceOpts = {}): Promise<CandidateRow[]> {
  const clean = [...new Set(ids.filter((x) => Number.isInteger(x) && x > 0))].slice(0, 100);
  if (!clean.length) return [];
  const base = baseConds(viewer, opts);
  const rows = rowsOf(await d.execute(sql`SELECT /*+ MAX_EXECUTION_TIME(2000) */ ${CANDIDATE_COLS}, 0 AS ft
    FROM kb_chunks c JOIN kb_documents d ON d.id = c.docId
    WHERE ${sql.join(base, sql` AND `)} AND c.id IN (${sql.join(clean.map((x) => sql`${x}`), sql`, `)})
    LIMIT ${clean.length}`)).map(toRow);
  return rows.filter((r) => canSeeKbDoc(parseVisibility(r.visibilityRoles, r.visibilityCities), viewer));
}

/** MPV (F5): quem entra SÓ pelo vetor precisa de pelo menos isto… */
export const VECTOR_ONLY_MIN_COSINE = 0.7;
/** …e de não ficar mais do que isto abaixo do melhor cosseno da pergunta. */
export const VECTOR_ONLY_BELOW_BEST = 0.08;
/** Limiar de quem entra só pelo vetor: max(0,7; melhor − 0,08). PURA. */
export const vectorOnlyThreshold = (best: number): number => Math.max(VECTOR_ONLY_MIN_COSINE, best - VECTOR_ONLY_BELOW_BEST);

/**
 * Regista os cossenos de quem tentou entrar só pelo vetor (aceites e
 * rejeitados), para calibrar o limiar no piloto. SÓ números (nunca texto, ids
 * ou títulos); no máx. 10 de cada.
 */
export function logVectorGate(scope: string, threshold: number, accepted: readonly number[], rejected: readonly number[]): void {
  const fmt = (xs: readonly number[]) => `[${[...xs].sort((a, b) => b - a).slice(0, 10).map((x) => x.toFixed(3)).join(",")}]`;
  console.info(`[knowledge] vetor ${scope === "kb" ? "kb" : "help_sec"}: limiar ${threshold.toFixed(3)} aceites ${fmt(accepted)} rejeitados ${fmt(rejected)}`);
}

/** Quantos vizinhos por vetor entram nos candidatos (plano MPV §3.4: FULLTEXT top 40 ∪ vetor top 20). */
export const VECTOR_NEIGHBORS = 20;
/** Prazo da parte vetorial (vetor da pergunta + memória + confirmação na BD); passado isto, fica a lexical. */
export const VECTOR_PART_DEADLINE_MS = 3_000;

/** `p` ou null se demorar mais de `ms` ou falhar (nunca lança; o que chega tarde é ignorado). */
export async function withinMs<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, ms));
    (timer as any)?.unref?.();
  });
  try {
    return await Promise.race([p.catch(() => null), late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Um vetor por TEXTO no pedido (plano MPV F5: a pergunta vetoriza-se UMA vez,
 * partilhada pelo bloco da ajuda e pela base de conhecimento; um texto
 * diferente — o do `ajuda_procurar` — tem o seu, também uma só vez). Falhas
 * dão null (e não se repetem no mesmo pedido).
 */
export function onceQueryEmbed(base: QueryEmbedFn): QueryEmbedFn {
  const memo = new Map<string, Promise<number[] | null>>();
  return (text: string) => {
    const key = String(text ?? "").trim().slice(0, 1000);
    let p = memo.get(key);
    if (!p) {
      p = Promise.resolve().then(() => base(key)).catch(() => null);
      memo.set(key, p);
    }
    return p;
  };
}

/**
 * O vetorizador da pergunta para o Multis do piloto: null se os vetores
 * estiverem desligados (definição da base de conhecimento ou IA indisponível);
 * senão o de sempre (`knowledge_embed`, sem dados pessoais), uma vez por texto.
 */
export async function mpvQueryEmbedder(): Promise<QueryEmbedFn | null> {
  try {
    const { embeddingsWanted, loadKnowledgeConfig } = await import("./sync");
    return (await embeddingsWanted(await loadKnowledgeConfig())) ? onceQueryEmbed(defaultQueryEmbed) : null;
  } catch {
    return null;
  }
}

/** Ordena os candidatos (palavras-chave, e cosseno se houver vetor da pergunta). PURA (salvo decodificar vetores). */
export async function rankCandidates(question: string, rows: CandidateRow[], queryVector: number[] | null, topK: number,
  /**
   * MPV (F5): quem passa SÓ pelo vetor (sem passar nas palavras nem no
   * FULLTEXT) precisa de `cos ≥ max(0,7; melhor − 0,08)` (vectorOnlyThreshold),
   * e os cossenos aceites/rejeitados ficam no registo (só números). Omisso = como sempre (0,6).
   */
  opts: { strictVector?: { scope: string } } = {}): Promise<{ hits: KbHit[]; usedEmbeddings: boolean }> {
  const { cosine, decodeVector } = await import("../_core/ai/embed");
  const maxFt = Math.max(0, ...rows.map((r) => r.ft));
  let usedEmbeddings = false;
  const cosOf = (r: CandidateRow): number | null => {
    if (!queryVector?.length) return null;
    const v = decodeVector(r.embedding);
    return v && v.length === queryVector.length ? cosine(queryVector, v) : null;
  };
  const strict = opts.strictVector ? { cos: rows.map(cosOf) } : null;
  const threshold = strict ? vectorOnlyThreshold(Math.max(0, ...strict.cos.map((c) => c ?? 0))) : 0.6;
  const gate = { accepted: [] as number[], rejected: [] as number[] };
  const scored = rows.map((r, i) => {
    const kw = keywordScore(question, `${r.title} ${r.section ?? ""} ${r.text}`);
    const ft = maxFt > 0 ? r.ft / maxFt : 0;
    const base = 0.7 * kw + 0.3 * ft;
    let score = base;
    let pass = kw >= 0.25 || ft >= 0.6;
    if (queryVector?.length) {
      const cos = strict ? strict.cos[i] : cosOf(r);
      if (cos != null) {
        usedEmbeddings = true;
        score = 0.65 * cos + 0.35 * base;
        if (!pass && strict) (cos >= threshold ? gate.accepted : gate.rejected).push(cos);
        pass = pass || cos >= threshold;
      }
    }
    return { r, score, pass };
  }).filter((x) => x.pass).sort((a, b) => b.score - a.score);
  if (strict && (gate.accepted.length || gate.rejected.length)) logVectorGate(opts.strictVector!.scope, threshold, gate.accepted, gate.rejected);
  const hits: KbHit[] = [];
  const perDoc = new Map<number, number>();
  for (const x of scored) {
    if (hits.length >= topK) break;
    const n = perDoc.get(x.r.docId) ?? 0;
    if (n >= 2) continue; // no máximo 2 trechos do mesmo documento
    perDoc.set(x.r.docId, n + 1);
    hits.push({ chunkId: x.r.id, docId: x.r.docId, title: x.r.title, section: x.r.section, text: x.r.text, href: x.r.webViewLink, source: x.r.source, score: Math.round(x.score * 1000) / 1000, ref: x.r.ref ?? null });
  }
  return { hits, usedEmbeddings };
}

/** Citações [K1]… a partir dos trechos escolhidos. PURA. */
export function citationsFor(hits: readonly KbHit[]): KbCitation[] {
  return hits.map((h, i) => ({ tag: `K${i + 1}`, docId: h.docId, title: h.title, section: h.section, href: h.href }));
}

/** Bloco <conhecimento> para o prompt (com teto de caracteres). PURA. */
export function knowledgeBlock(hits: readonly KbHit[], maxChars = 6000): string {
  if (!hits.length) return "";
  const per = Math.max(400, Math.floor(maxChars / hits.length));
  const parts = hits.map((h, i) => {
    const body = h.text.length > per ? `${h.text.slice(0, per - 1)}…` : h.text;
    return `[K${i + 1}] «${h.title}»${h.section && h.section !== h.title ? ` — secção «${h.section}»` : ""}:\n${body}`;
  });
  return `<conhecimento>\n${parts.join("\n\n")}\n</conhecimento>`;
}

async function defaultQueryEmbed(question: string): Promise<number[] | null> {
  const { embedTexts } = await import("../_core/ai/embed");
  const { redactPii } = await import("../_core/ai/pii");
  const r = await embedTexts({ feature: "knowledge_embed", texts: [redactPii(question).text], taskType: "RETRIEVAL_QUERY", timeoutMs: 5_000 });
  return r.vectors[0] ?? null;
}

/**
 * Trechos da base de conhecimento que `viewer` pode ver, para `question`.
 * Nunca lança (sem BD/erro → sem trechos).
 *
 * `helpTopK` (Multis 2): na MESMA consulta, também os trechos da ajuda da app
 * (fonte "help"), ordenados à parte em `helpHits` — o vetor da pergunta é
 * calculado UMA vez para os dois (sem chamada extra de embeddings).
 */
export async function retrieveKnowledge(input: {
  question: string;
  viewer: KbViewer;
  topK?: number;
  excludeSources?: KbSource[];
  docIds?: number[];
  /** Quantos trechos da ajuda ("help") devolver à parte em `helpHits` (0/omisso = nenhum). */
  helpTopK?: number;
  d?: Db;
  /** null = sem embeddings; omisso = decide pela configuração. */
  embedQuery?: QueryEmbedFn | null;
  /**
   * Plano MPV (F5, só o Multis do piloto): junta aos candidatos os 20 vizinhos
   * por vetor (memória, vectorIndex.ts), confirmados na BD. Omisso = como sempre.
   */
  vectorNeighbors?: boolean;
}): Promise<KbRetrieval> {
  const empty: KbRetrieval = { hits: [], citations: [], mode: "none" };
  const question = String(input.question ?? "").trim().slice(0, 1000);
  if (question.length < 3) return empty;
  try {
    let d = input.d;
    if (!d) {
      const { getDb } = await import("../db");
      const got = await getDb();
      if (!got) return empty;
      d = got as unknown as Db;
    }
    const { rows, mode } = await candidateChunks(d, question, input.viewer, { excludeSources: input.excludeSources, docIds: input.docIds });
    // Segunda barreira: a mesma regra em código (nunca um trecho restrito num prompt).
    const canSee = (r: CandidateRow) => canSeeKbDoc(parseVisibility(r.visibilityRoles, r.visibilityCities), input.viewer);
    let visible = rows.filter(canSee);
    const helpTopK = Math.max(0, Math.min(8, Math.floor(input.helpTopK ?? 0)));
    let helpRows: CandidateRow[] = [];
    if (helpTopK > 0) {
      // A ajuda falhar não estraga os manuais (fica só com as palavras-chave).
      try { helpRows = (await candidateChunks(d, question, input.viewer, { onlySources: ["help"] })).rows.filter(canSee); } catch { helpRows = []; }
    }
    let qv: number[] | null = null;
    if (input.vectorNeighbors) {
      // Plano MPV (F5): candidatos = FULLTEXT top 40 ∪ vizinhos por vetor top 20 (memória),
      // confirmados na BD; sem a parte vetorial em ≤ 3 s, fica a lexical (sem erro).
      const extra = await withinMs(vectorPart(d, question, input, visible), VECTOR_PART_DEADLINE_MS);
      if (extra) {
        qv = extra.qv;
        visible = [...visible, ...extra.rows];
      }
    }
    if (!visible.length && !helpRows.length) return { ...empty, mode, ...(helpTopK > 0 ? { helpHits: [] } : {}) };
    if (!input.vectorNeighbors) {
      const withVectors = [...visible, ...helpRows].some((r) => r.embedding);
      let embedQuery = input.embedQuery;
      if (embedQuery === undefined) {
        const { embeddingsWanted, loadKnowledgeConfig } = await import("./sync");
        embedQuery = withVectors && (await embeddingsWanted(await loadKnowledgeConfig())) ? defaultQueryEmbed : null;
      }
      if (embedQuery && withVectors) {
        try { qv = await embedQuery(question); } catch { qv = null; }
      }
    }
    const main = visible.length
      ? await rankCandidates(question, visible, qv, Math.max(1, Math.min(8, input.topK ?? 4)), input.vectorNeighbors ? { strictVector: { scope: "kb" } } : {})
      : { hits: [] as KbHit[], usedEmbeddings: false };
    const help = helpRows.length ? await rankCandidates(question, helpRows, qv, helpTopK) : { hits: [] as KbHit[], usedEmbeddings: false };
    return {
      hits: main.hits,
      citations: citationsFor(main.hits),
      mode: main.usedEmbeddings || help.usedEmbeddings ? "embeddings" : mode,
      ...(helpTopK > 0 ? { helpHits: help.hits } : {}),
    };
  } catch (err) {
    console.warn("[knowledge] recuperação falhou:", String((err as any)?.code ?? (err as any)?.name ?? "erro"));
    return { ...empty, failed: true };
  }
}

/**
 * A parte vetorial dos manuais (MPV F5): o vetor da pergunta e os vizinhos
 * por vetor que ainda não estão nos candidatos, confirmados na BD. null = sem
 * vetores (desligados, sem índice, IA em baixo). Lança se a BD falhar.
 */
async function vectorPart(d: Db, question: string, input: { viewer: KbViewer; excludeSources?: KbSource[]; docIds?: number[]; embedQuery?: QueryEmbedFn | null },
  have: readonly CandidateRow[]): Promise<{ qv: number[]; rows: CandidateRow[] } | null> {
  const { getVectorIndex, nearestNeighbors } = await import("./vectorIndex");
  const index = await getVectorIndex(d, "kb");
  if (!index?.size && !have.some((r) => r.embedding)) return null;
  const embed = input.embedQuery === undefined ? await mpvQueryEmbedder() : input.embedQuery;
  if (!embed) return null;
  const qv = await embed(question);
  if (!qv?.length) return null;
  if (!index?.size) return { qv, rows: [] };
  const seen = new Set(have.map((r) => r.id));
  const docs = input.docIds?.length ? new Set(input.docIds) : null;
  const near = nearestNeighbors(index, qv, VECTOR_NEIGHBORS, {
    accept: (e) => !seen.has(e.chunkId) && (!docs || docs.has(e.docId)) && (!e.visibility || canSeeKbDoc(e.visibility, input.viewer)),
  });
  const rows = await chunksByIds(d, near.map((n) => n.chunkId), input.viewer, { excludeSources: input.excludeSources, docIds: input.docIds });
  return { qv, rows };
}

/** Quem pergunta, a partir do papel e do âmbito de cidade do pedido. */
export function kbViewerFrom(role: string, access: { all: boolean; cityName?: string; cityNames?: string[] } | undefined): KbViewer {
  if (!access) return { role, allCities: false, cityNames: [] };
  return { role, allCities: !!access.all, cityNames: access.cityNames ?? (access.cityName ? [access.cityName] : []) };
}
