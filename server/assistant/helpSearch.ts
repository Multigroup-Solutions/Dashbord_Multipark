/**
 * Pesquisa das secções da ajuda pelo SIGNIFICADO (plano MPV §3.4, F5) — só no
 * Multis do piloto; o v1 e a pesquisa sem vetores ficam com a lexical de hoje
 * (helpTools.searchHelpSections).
 *
 * Candidatos = lexical top 40 ∪ FULLTEXT top 40 (`kb_chunks` das secções,
 * fonte "help_sec") ∪ vizinhos por vetor top 20 (em memória, vectorIndex.ts).
 * A lexical em memória entra também nos candidatos porque apanha as palavras
 * pela raiz (5 letras: "confirmar" ↔ "confirmação"), que o FULLTEXT não apanha.
 *
 * Depois, a pontuação de hoje:
 *   - lexical (a da F3: título da secção ×3, página ×1, texto ×1, palavras
 *     da página ×0,5, +1 na página aberta), a dividir pela melhor;
 *   - FULLTEXT a dividir pelo melhor, com o peso da base de conhecimento:
 *     base = 0,7 × lexical + 0,3 × FULLTEXT (retrieve.rankCandidates);
 *   - com o vetor da secção: 0,65 × cosseno + 0,35 × base (rankCandidates);
 *   - passa se passar na lexical de hoje (≥ 2 pontos e ≥ metade da melhor);
 *     quem entra SÓ pelo vetor precisa de cos ≥ max(0,7; melhor − 0,08)
 *     (o FULLTEXT só soma pontos). Os cossenos de quem tentou entrar só pelo
 *     vetor ficam no registo (só números), para calibrar no piloto.
 *
 * Visibilidade igual à de hoje: os vizinhos e o FULLTEXT são confirmados na
 * BD (`kbVisibilitySql` + `canSeeKbDoc`) e TODAS as secções passam pelo filtro
 * por módulo da F3 (`canSeeHelpPage`, o `canSee` de quem chama) — uma secção
 * de um módulo sem acesso nunca aparece.
 *
 * Corte: sem vetores (desligados, sem índice, IA em baixo) ou se a parte
 * vetorial passar de 3 s, fica a lexical de hoje, sem erro.
 *
 * Nenhuma chamada de IA para além do vetor da pergunta (o mesmo do pedido).
 */
import { canSeeKbDoc, parseVisibility, type KbViewer } from "../../shared/knowledge";
import { treePages, type HelpTree, type HelpTreePage, type HelpTreeSection } from "../../shared/helpTree";
import { candidateChunks, chunksByIds, logVectorGate, vectorOnlyThreshold, withinMs, VECTOR_PART_DEADLINE_MS, type QueryEmbedFn } from "../knowledge/retrieve";
import type { Db } from "../knowledge/store";
import { compareHits, lexicalPasses, scoreHelpSections, searchHelpSections, type HelpSectionHit, type SectionSearchFn } from "./helpTools";
import { knowledgeTree } from "./knowledgeTree";

/** Lexical em memória que entra nos candidatos (as melhores N). */
export const SECTION_LEXICAL_CANDIDATES = 40;
/** Vizinhos por vetor (secções distintas). */
export const SECTION_VECTOR_NEIGHBORS = 20;

const REF_PREFIX = "help:";
/** "help:caixa.md#confirmacao" → "caixa.md#confirmacao" (só secções). PURA. */
export function sectionIdOfRef(ref: string | null | undefined): string | null {
  const s = String(ref ?? "");
  return s.startsWith(REF_PREFIX) && s.includes("#") ? s.slice(REF_PREFIX.length) : null;
}

const byIdMemo = new WeakMap<HelpTree, Map<string, { page: HelpTreePage; section: HelpTreeSection }>>();
function sectionsById(tree: HelpTree): Map<string, { page: HelpTreePage; section: HelpTreeSection }> {
  let m = byIdMemo.get(tree);
  if (!m) {
    m = new Map();
    for (const page of treePages(tree)) for (const section of page.sections) m.set(section.id, { page, section });
    byIdMemo.set(tree, m);
  }
  return m;
}

/** O que a parte vetorial e o FULLTEXT trouxeram, por secção. */
export interface SectionSignals {
  /** Cosseno do melhor trecho de cada secção com vetor (memória). */
  cos: Map<string, number>;
  /** Vizinhos por vetor JÁ confirmados na BD (ids das secções). */
  neighbors: string[];
  /** FULLTEXT (o melhor trecho de cada secção), já confirmado na BD. */
  ft: Map<string, number>;
}

type SearchOpts = { canSee?: (page: HelpTreePage) => boolean; currentPage?: string | null; exclude?: ReadonlySet<string>; max?: number };

/**
 * A ordem final com os sinais (lexical ∪ FULLTEXT ∪ vizinhos; pontuação de
 * cima). Sem sinais → exatamente a lexical de hoje. PURA.
 */
export function rankHelpSections(tree: HelpTree, question: string, opts: SearchOpts, signals: SectionSignals | null): HelpSectionHit[] {
  if (!signals) return searchHelpSections(tree, question, opts);
  const max = Math.max(1, opts.max ?? 8);
  const byId = sectionsById(tree);
  const lexAll = scoreHelpSections(tree, question, opts);
  const lex = new Map(lexAll.map((h) => [h.section.id, h.score]));
  const bestPassing = lexAll.find((h) => h.score >= 2)?.score ?? 0;
  const ids = new Set<string>([
    ...lexAll.slice(0, SECTION_LEXICAL_CANDIDATES).map((h) => h.section.id),
    ...signals.ft.keys(),
    ...signals.neighbors,
  ]);
  const cands: Array<{ page: HelpTreePage; section: HelpTreeSection; lex: number; ft: number; cos: number | undefined }> = [];
  for (const id of ids) {
    const hit = byId.get(id);
    if (!hit || opts.exclude?.has(id)) continue;
    if (!hit.section.text && !hit.section.children.length) continue;
    if (opts.canSee && !opts.canSee(hit.page)) continue;
    cands.push({ ...hit, lex: lex.get(id) ?? 0, ft: signals.ft.get(id) ?? 0, cos: signals.cos.get(id) });
  }
  const maxLex = Math.max(0, ...cands.map((c) => c.lex));
  const maxFt = Math.max(0, ...cands.map((c) => c.ft));
  // Quem entra SÓ pelo vetor precisa de cos ≥ max(0,7; melhor − 0,08) (o FULLTEXT nas secções só soma pontos).
  const threshold = vectorOnlyThreshold(Math.max(0, ...cands.map((c) => c.cos ?? 0)));
  const gate = { accepted: [] as number[], rejected: [] as number[] };
  const scored: HelpSectionHit[] = [];
  for (const c of cands) {
    const base = 0.7 * (maxLex > 0 ? c.lex / maxLex : 0) + 0.3 * (maxFt > 0 ? c.ft / maxFt : 0);
    const score = c.cos != null ? 0.65 * c.cos + 0.35 * base : base;
    let pass = lexicalPasses(c.lex, bestPassing);
    if (!pass && c.cos != null) {
      pass = c.cos >= threshold;
      (pass ? gate.accepted : gate.rejected).push(c.cos);
    }
    if (pass) scored.push({ page: c.page, section: c.section, score: Math.round(score * 1000) / 1000 });
  }
  if (gate.accepted.length || gate.rejected.length) logVectorGate("help_sec", threshold, gate.accepted, gate.rejected);
  scored.sort(compareHits);
  return scored.slice(0, max);
}

/**
 * Os sinais da parte vetorial (vetor da pergunta, memória, FULLTEXT e
 * confirmação na BD). null = sem vetores (quem chama fica com a lexical).
 * Lança se a BD falhar.
 */
export async function sectionSignals(d: Db, tree: HelpTree, question: string, opts: SearchOpts, deps: { viewer: KbViewer; embedQuery: QueryEmbedFn }): Promise<SectionSignals | null> {
  const { getVectorIndex, nearestNeighbors } = await import("../knowledge/vectorIndex");
  const index = await getVectorIndex(d, "help_sec");
  if (!index?.size) return null;
  const byId = sectionsById(tree);
  const usable = (id: string | null) => {
    if (!id || opts.exclude?.has(id)) return false;
    const hit = byId.get(id);
    return !!hit && (!opts.canSee || opts.canSee(hit.page));
  };
  const [qv, ftRows] = await Promise.all([
    deps.embedQuery(question),
    candidateChunks(d, question, deps.viewer, { onlySources: ["help_sec"] }).then((r) => r.rows).catch(() => []),
  ]);
  if (!qv?.length || qv.length !== index.dims) return null;
  // Cosseno de todas as secções que a pessoa pode ver (≈ 500 vetores: < 1 ms); os 20 melhores são os vizinhos.
  const all = nearestNeighbors(index, qv, index.size, {
    distinctDocs: true,
    accept: (e) => usable(sectionIdOfRef(e.ref)) && (!e.visibility || canSeeKbDoc(e.visibility, deps.viewer)),
  });
  const cos = new Map<string, number>();
  for (const n of all) {
    const id = sectionIdOfRef(n.ref);
    if (id && !cos.has(id)) cos.set(id, n.cos);
  }
  const top = all.slice(0, SECTION_VECTOR_NEIGHBORS);
  const confirmed = await chunksByIds(d, top.map((n) => n.chunkId), deps.viewer, { onlySources: ["help_sec"] });
  const ok = new Set(confirmed.map((r) => sectionIdOfRef(r.ref)).filter((x): x is string => !!x));
  const neighbors = top.map((n) => sectionIdOfRef(n.ref)).filter((id): id is string => !!id && ok.has(id));
  const ft = new Map<string, number>();
  for (const r of ftRows) {
    const id = sectionIdOfRef(r.ref);
    if (!usable(id) || !canSeeKbDoc(parseVisibility(r.visibilityRoles, r.visibilityCities), deps.viewer)) continue;
    ft.set(id!, Math.max(ft.get(id!) ?? 0, r.ft));
  }
  return { cos, neighbors, ft };
}

/**
 * A pesquisa do piloto: lexical ∪ FULLTEXT ∪ vizinhos por vetor, com corte aos
 * 3 s. `embedQuery` null (vetores desligados) → a lexical de hoje, sem tocar
 * na BD. Nunca lança.
 */
export async function searchHelpSectionsHybrid(question: string, opts: SearchOpts, deps: {
  viewer: KbViewer; embedQuery: QueryEmbedFn | null; d?: Db | null; tree?: HelpTree; deadlineMs?: number;
}): Promise<{ hits: HelpSectionHit[]; mode: "vetores" | "lexical" }> {
  const tree = deps.tree ?? knowledgeTree();
  const lexical = () => ({ hits: searchHelpSections(tree, question, opts), mode: "lexical" as const });
  if (!deps.embedQuery || !String(question ?? "").trim()) return lexical();
  try {
    let d = deps.d ?? null;
    if (!d) {
      const { getDb } = await import("../db");
      d = ((await getDb()) as unknown as Db) ?? null;
    }
    if (!d) return lexical();
    const signals = await withinMs(sectionSignals(d, tree, question, opts, { viewer: deps.viewer, embedQuery: deps.embedQuery }), deps.deadlineMs ?? VECTOR_PART_DEADLINE_MS);
    return signals ? { hits: rankHelpSections(tree, question, opts, signals), mode: "vetores" } : lexical();
  } catch {
    return lexical();
  }
}

/** A pesquisa para o contexto das ferramentas e para o bloco da pergunta (MPV). */
export function makeSectionSearch(deps: { viewer: KbViewer; embedQuery: QueryEmbedFn | null; d?: Db | null }): SectionSearchFn {
  return async (text, opts) => (await searchHelpSectionsHybrid(text, opts, deps)).hits;
}
