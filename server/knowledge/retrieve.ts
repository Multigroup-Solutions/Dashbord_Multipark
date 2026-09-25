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
import { canSeeKbDoc, parseVisibility, type KbCitation, type KbSource, type KbViewer } from "../../shared/knowledge";
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
}

export interface KbRetrieval {
  hits: KbHit[];
  citations: KbCitation[];
  mode: "embeddings" | "fulltext" | "keywords" | "none";
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

interface CandidateRow {
  id: number; docId: number; section: string | null; text: string; embedding: string | null;
  title: string; webViewLink: string | null; source: KbSource; visibilityRoles: unknown; visibilityCities: unknown; ft: number;
}

function toRow(r: any): CandidateRow {
  return {
    id: Number(r.id), docId: Number(r.docId), section: r.section != null ? String(r.section) : null, text: String(r.text ?? ""),
    embedding: r.embedding != null ? String(r.embedding) : null, title: String(r.title ?? ""), webViewLink: r.webViewLink != null ? String(r.webViewLink) : null,
    source: String(r.source) as KbSource, visibilityRoles: r.visibilityRoles, visibilityCities: r.visibilityCities, ft: Number(r.ft ?? 0) || 0,
  };
}

/** Candidatos visíveis (FULLTEXT → LIKE). */
export async function candidateChunks(d: Db, question: string, viewer: KbViewer, opts: { excludeSources?: KbSource[]; docIds?: number[] } = {}): Promise<{ rows: CandidateRow[]; mode: "fulltext" | "keywords" }> {
  const base: SQL[] = [sql`d.deletedAt IS NULL`, sql`d.status = 'synced'`, kbVisibilitySql(viewer)];
  if (opts.excludeSources?.length) base.push(sql`d.source NOT IN (${sql.join(opts.excludeSources.map((x) => sql`${x}`), sql`, `)})`);
  if (opts.docIds?.length) base.push(sql`d.id IN (${sql.join(opts.docIds.map((x) => sql`${x}`), sql`, `)})`);
  const cols = sql`c.id, c.docId, c.section, c.text, c.embedding, d.title, d.webViewLink, d.source, d.visibilityRoles, d.visibilityCities`;
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

/** Ordena os candidatos (palavras-chave, e cosseno se houver vetor da pergunta). PURA (salvo decodificar vetores). */
export async function rankCandidates(question: string, rows: CandidateRow[], queryVector: number[] | null, topK: number): Promise<{ hits: KbHit[]; usedEmbeddings: boolean }> {
  const { cosine, decodeVector } = await import("../_core/ai/embed");
  const maxFt = Math.max(0, ...rows.map((r) => r.ft));
  let usedEmbeddings = false;
  const scored = rows.map((r) => {
    const kw = keywordScore(question, `${r.title} ${r.section ?? ""} ${r.text}`);
    const ft = maxFt > 0 ? r.ft / maxFt : 0;
    const base = 0.7 * kw + 0.3 * ft;
    let score = base;
    let pass = kw >= 0.25 || ft >= 0.6;
    if (queryVector?.length) {
      const v = decodeVector(r.embedding);
      if (v && v.length === queryVector.length) {
        usedEmbeddings = true;
        const cos = cosine(queryVector, v);
        score = 0.65 * cos + 0.35 * base;
        pass = pass || cos >= 0.6;
      }
    }
    return { r, score, pass };
  }).filter((x) => x.pass).sort((a, b) => b.score - a.score);
  const hits: KbHit[] = [];
  const perDoc = new Map<number, number>();
  for (const x of scored) {
    if (hits.length >= topK) break;
    const n = perDoc.get(x.r.docId) ?? 0;
    if (n >= 2) continue; // no máximo 2 trechos do mesmo documento
    perDoc.set(x.r.docId, n + 1);
    hits.push({ chunkId: x.r.id, docId: x.r.docId, title: x.r.title, section: x.r.section, text: x.r.text, href: x.r.webViewLink, source: x.r.source, score: Math.round(x.score * 1000) / 1000 });
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
 */
export async function retrieveKnowledge(input: {
  question: string;
  viewer: KbViewer;
  topK?: number;
  excludeSources?: KbSource[];
  docIds?: number[];
  d?: Db;
  /** null = sem embeddings; omisso = decide pela configuração. */
  embedQuery?: QueryEmbedFn | null;
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
    const visible = rows.filter((r) => canSeeKbDoc(parseVisibility(r.visibilityRoles, r.visibilityCities), input.viewer));
    if (!visible.length) return { ...empty, mode };
    let embedQuery = input.embedQuery;
    if (embedQuery === undefined) {
      const { embeddingsWanted, loadKnowledgeConfig } = await import("./sync");
      embedQuery = visible.some((r) => r.embedding) && (await embeddingsWanted(await loadKnowledgeConfig())) ? defaultQueryEmbed : null;
    }
    let qv: number[] | null = null;
    if (embedQuery && visible.some((r) => r.embedding)) {
      try { qv = await embedQuery(question); } catch { qv = null; }
    }
    const { hits, usedEmbeddings } = await rankCandidates(question, visible, qv, Math.max(1, Math.min(8, input.topK ?? 4)));
    return { hits, citations: citationsFor(hits), mode: usedEmbeddings ? "embeddings" : mode };
  } catch (err) {
    console.warn("[knowledge] recuperação falhou:", String((err as any)?.code ?? (err as any)?.name ?? "erro"));
    return empty;
  }
}

/** Quem pergunta, a partir do papel e do âmbito de cidade do pedido. */
export function kbViewerFrom(role: string, access: { all: boolean; cityName?: string; cityNames?: string[] } | undefined): KbViewer {
  if (!access) return { role, allCities: false, cityNames: [] };
  return { role, allCities: !!access.all, cityNames: access.cityNames ?? (access.cityName ? [access.cityName] : []) };
}
