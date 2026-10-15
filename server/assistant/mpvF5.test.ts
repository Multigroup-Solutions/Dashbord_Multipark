/**
 * Plano MPV (Multis por página), fase F5 — pesquisa pelo significado, só no
 * piloto (o v1 fica igual):
 *  - vetores das secções da ajuda ("help_sec"), com quota própria por corrida
 *    (nunca tiram lugar ao Drive) e o custo da 1.ª vez medido;
 *  - candidatos = lexical/FULLTEXT ∪ vizinhos por vetor (memória), depois a
 *    pontuação de hoje;
 *  - cache dos vetores por instância, invalidada pelo kb_sync_state (≤ 1 leitura/60 s);
 *  - visibilidade igual à de hoje (BD + canSeeKbDoc + módulo da F3);
 *  - sem vetores (ou > 3 s) → a lexical, sem erro;
 *  - o vetor da pergunta uma só vez por pedido;
 *  - PROVA de que o v1 não muda (as consultas dos candidatos do v1 congeladas).
 * Sem IA nem embeddings reais: vetores e vetorizadores falsos.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const h = vi.hoisted(() => ({ db: null as any, logActivity: vi.fn() }));
vi.mock("../db", () => ({
  getDb: async () => h.db,
  logActivity: h.logActivity,
  getUserPermissionOverrides: async () => ({}),
}));

import { treePages } from "../../shared/helpTree";
import { setAiProvidersForTests } from "../_core/ai/client";
import { resetContextCacheForTests } from "../_core/ai/contextCache";
import { resetFinalCallModeForTests } from "../_core/ai/run";
import { resetRateLimitMemoryForTests } from "../_core/ai/rateLimit";
import { resetAiUsageCachesForTests } from "../_core/ai/usage";
import { encodeVector, estimateTokens } from "../_core/ai/embed";
import { costEur } from "../_core/ai/pricing";
import { resetMaskedColumnsForTests } from "../_core/ai/chat/store";
import { createFakeDb, createFakeProvider, okResponse, type FakeQuery } from "../_core/ai/testUtils";
import { invalidateSettingsCache } from "../appSettings";
import type { CityAccess } from "../cityAccess";
import { chunkText } from "../knowledge/chunker";
import { VECTOR_NEIGHBORS, kbViewerFrom, onceQueryEmbed, rankCandidates, retrieveKnowledge, vectorOnlyThreshold, withinMs, type CandidateRow } from "../knowledge/retrieve";
import { VECTORS_VERSION_KEY, saveEmbeddings, unembeddedDocIds } from "../knowledge/store";
import { HELP_SECTIONS_EMBED_PER_RUN, embedDoc, embedHelpSections, embedText, runKnowledgeSync } from "../knowledge/sync";
import { runChatTurn } from "../_core/ai/chat/engine";
import {
  VECTOR_CACHE_MAX_CHUNKS, VECTOR_VERSION_CHECK_MS, buildVectorIndex, getVectorIndex, nearestNeighbors, resetVectorCacheForTests, vectorCacheStats,
} from "../knowledge/vectorIndex";
import { HELP_FILES } from "./helpDocs.generated";
import { rankHelpSections, searchHelpSectionsHybrid, sectionIdOfRef } from "./helpSearch";
import { HELP_NAV_TOOLS, canSeeHelpPage, searchHelpSections, type HelpSectionHit } from "./helpTools";
import { knowledgeTree } from "./knowledgeTree";
import { mpvTurnKnowledge, mpvTurnKnowledgeAsync } from "./mpv";
import { askAssistant, staffHelpDocs, type AssistantMode } from "./service";
import type { StaffToolCtx } from "./tools";

const KEYS = ["GEMINI_API_KEY", "LLM_API_KEY", "OPENAI_API_KEY", "AI_ENABLED", "AI_ASSISTANT", "AI_ASSISTANT_SMART", "MPV", "AI_MODEL_SMART",
  "AI_MONTHLY_BUDGET_EUR", "AI_PROVIDER", "AI_ASSISTANT_MEMORY"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env.GEMINI_API_KEY = "test-key";
  process.env.AI_MODEL_SMART = "gemini-4-argon";
  h.db = null;
  setAiProvidersForTests(null);
  resetAiUsageCachesForTests();
  resetRateLimitMemoryForTests();
  resetContextCacheForTests();
  resetFinalCallModeForTests();
  resetMaskedColumnsForTests(null);
  resetVectorCacheForTests();
  invalidateSettingsCache();
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setAiProvidersForTests(null);
  vi.restoreAllMocks();
});

const LISBOA: CityAccess = { all: false, defaultCityId: 10, cityName: "Lisboa", cityNames: ["Lisboa"], cityIds: [10], projectIds: [10, 11, 12], missingCostCenter: false };
const ctxFor = (role: string, id = 7): StaffToolCtx =>
  ({ user: { id, role }, access: LISBOA, call: async () => ({}), today: "2026-10-15", financeAllowed: false, helpDocs: staffHelpDocs() }) as any;
const viewerFor = (role: string) => kbViewerFrom(role, LISBOA);
const tree = knowledgeTree();
const pages = treePages(tree);
const sectionWithText = (pageId: string) => pages.find((p) => p.id === pageId)!.sections.find((s) => s.text.trim())!;

// ─── Vetores falsos (4 dimensões) ───────────────────────────────────────────

const DIM = 4;
/** Um vetor com cosseno `c` com o eixo x (o "vetor da pergunta" é sempre [1,0,0,0]). */
const atCos = (c: number) => [c, Math.sqrt(Math.max(0, 1 - c * c)), 0, 0];
const QUERY = [1, 0, 0, 0];
interface FakeSec { section: string; chunk: number; doc: number; cos: number; roles?: string[] }

/**
 * BD falsa para a pesquisa das secções: versão em kb_sync_state, vetores
 * (carga da memória), FULLTEXT (nada, salvo `ft`) e a confirmação por ids
 * (`confirm` decide o que a BD devolve — a visibilidade "na BD").
 */
function sectionsDb(secs: FakeSec[], opts: { version?: () => string | null; confirm?: (s: FakeSec) => boolean; ft?: Array<{ sec: FakeSec; ft: number }>; extra?: (q: FakeQuery) => unknown } = {}) {
  const row = (s: FakeSec, ft = 0) => ({
    id: s.chunk, docId: s.doc, section: null, text: "texto", embedding: encodeVector(atCos(s.cos)), title: `Ajuda: ${s.section}`, webViewLink: null,
    source: "help_sec", visibilityRoles: JSON.stringify(s.roles ?? []), visibilityCities: "[]", driveFileId: `help:${s.section}`, ft,
  });
  return createFakeDb((q) => {
    const more = opts.extra?.(q);
    if (more !== undefined) return more;
    if (q.sql.includes("FROM kb_sync_state")) {
      const v = opts.version ? opts.version() : "v1";
      return [[...(v != null ? [{ value: v }] : [])]];
    }
    if (q.sql.includes("COUNT(*)") && q.sql.includes("c.embedding IS NOT NULL")) return [[{ n: q.sql.includes("d.source = 'help_sec'") ? secs.length : 0 }]];
    if (q.sql.includes("c.embedding IS NOT NULL") && q.sql.includes("d.source = 'help_sec'")) return [secs.map((s) => row(s))];
    if (q.sql.includes("c.embedding IS NOT NULL")) return [[]];
    if (q.sql.includes("MATCH(")) return [(opts.ft ?? []).map((x) => row(x.sec, x.ft))];
    if (q.sql.includes("AND c.id IN (")) {
      const ids = new Set(q.params.filter((x) => typeof x === "number"));
      return [secs.filter((s) => ids.has(s.chunk) && (opts.confirm ? opts.confirm(s) : true)).map((s) => row(s))];
    }
    return [[]];
  });
}

// ─── União e pontuação ──────────────────────────────────────────────────────

describe("candidatos: lexical/FULLTEXT ∪ vizinhos por vetor, depois a pontuação de hoje", () => {
  const all = { canSee: () => true };

  it("sem sinais (sem vetores): exatamente a lexical de hoje", () => {
    for (const q of ["nota de crédito", "Como fecho a caixa?", "p75 no Porto", "zzzz qqqq"]) {
      expect(rankHelpSections(tree, q, { ...all, max: 6 }, null)).toEqual(searchHelpSections(tree, q, { ...all, max: 6 }));
    }
  });

  it("um vizinho por vetor SEM palavras em comum entra (cosseno ≥ max(0,7; melhor − 0,08)); um afastado não; a lexical forte continua", () => {
    const near = sectionWithText("caixa").id;
    const far = sectionWithText("multis").id;
    const q = "nota de crédito";
    const lexTop = searchHelpSections(tree, q, all)[0].section.id;
    const signals = { cos: new Map([[near, 0.95], [far, 0.3], [lexTop, 0.7]]), neighbors: [near, far], ft: new Map<string, number>() };
    const ids = rankHelpSections(tree, q, { ...all, max: 8 }, signals).map((x) => x.section.id);
    expect(ids).toContain(near);
    expect(ids).not.toContain(far);
    expect(ids).toContain(lexTop);
    // Pontuação: 0,65 × cosseno + 0,35 × base (base = 0,7 × lexical/melhor + 0,3 × FULLTEXT/melhor).
    const top = rankHelpSections(tree, q, { ...all, max: 8 }, signals);
    const lexHit = top.find((x) => x.section.id === lexTop)!;
    expect(lexHit.score).toBeCloseTo(0.65 * 0.7 + 0.35 * 0.7, 3);
    expect(top.find((x) => x.section.id === near)!.score).toBeCloseTo(0.65 * 0.95, 3);
  });

  it("só o FULLTEXT (sem lexical nem vetor que chegue) não basta; o FULLTEXT só sobe a pontuação de quem já passa", () => {
    const q = "nota de crédito";
    const lex = searchHelpSections(tree, q, all);
    const other = sectionWithText("multis").id;
    const signals = { cos: new Map<string, number>(), neighbors: [], ft: new Map([[other, 9], [lex[0].section.id, 3]]) };
    const r = rankHelpSections(tree, q, { ...all, max: 8 }, signals);
    expect(r.map((x) => x.section.id)).not.toContain(other);
    expect(r.map((x) => x.section.id)).toEqual(expect.arrayContaining(lex.map((x) => x.section.id)));
  });

  it("os vizinhos são as 20 secções mais próximas (uma por secção), e o cosseno de cada uma vem da memória", async () => {
    const ids = pages.flatMap((p) => p.sections).filter((s) => s.text.trim()).slice(0, 30).map((s) => s.id);
    const rows = ids.flatMap((id, i) => [0, 1].map((k) => ({ id: i * 2 + k + 1, docId: i + 1, embedding: encodeVector(atCos(0.99 - i * 0.01 - k * 0.001)), driveFileId: `help:${id}`, visibilityRoles: "[]", visibilityCities: "[]" })));
    const index = await buildVectorIndex("help_sec", "v", rows);
    const near = nearestNeighbors(index, QUERY, VECTOR_NEIGHBORS, { distinctDocs: true });
    expect(near).toHaveLength(20);
    expect(new Set(near.map((n) => n.docId)).size).toBe(20);
    expect(near[0]).toMatchObject({ docId: 1, chunkId: 1 });
    expect(near[0].cos).toBeCloseTo(0.99, 5);
    expect(sectionIdOfRef(near[0].ref)).toBe(ids[0]);
    expect(sectionIdOfRef("help:caixa.md")).toBeNull();
  });

  it("de ponta a ponta: o vizinho confirmado na BD entra no bloco da pergunta e no ajuda_procurar", async () => {
    const target = sectionWithText("caixa").id;
    const d = sectionsDb([{ section: target, chunk: 11, doc: 101, cos: 0.93 }]);
    const embed = vi.fn(async () => QUERY);
    const r = await searchHelpSectionsHybrid("zzzz qqqq wwww", { canSee: () => true, max: 6 }, { viewer: viewerFor("admin"), embedQuery: embed, d: d as any });
    expect(r.mode).toBe("vetores");
    expect(r.hits.map((x) => x.section.id)).toEqual([target]);
    expect(searchHelpSections(tree, "zzzz qqqq wwww", { canSee: () => true })).toEqual([]);
    // A confirmação na BD leva a visibilidade de quem pergunta (kbVisibilitySql).
    const confirm = d.queries.find((q) => q.sql.includes("AND c.id IN ("))!;
    expect(confirm.sql).toContain("d.status = 'synced'");
    expect(confirm.sql).toContain("d.deletedAt IS NULL");
    expect(confirm.sql).toContain("d.source IN (?)");
    expect(confirm.params).toContain("help_sec");
  });
});

// ─── Cache dos vetores ──────────────────────────────────────────────────────

describe("cache dos vetores por instância (kb_sync_state, ≤ 1 leitura por 60 s)", () => {
  const secs: FakeSec[] = [{ section: "caixa.md#x", chunk: 1, doc: 1, cos: 0.9 }, { section: "caixa.md#y", chunk: 2, doc: 2, cos: 0.5 }];
  const count = (d: { queries: FakeQuery[] }) => ({
    version: d.queries.filter((q) => q.sql.includes("FROM kb_sync_state")).length,
    load: d.queries.filter((q) => q.sql.includes("c.embedding IS NOT NULL") && !q.sql.includes("COUNT(*)")).length,
  });

  it("lê uma vez; dentro dos 60 s não volta à BD; depois lê só a versão; versão nova → volta a ler os vetores", async () => {
    let version = "a";
    const d = sectionsDb(secs, { version: () => version });
    const t0 = 1_000_000;
    expect((await getVectorIndex(d as any, "help_sec", t0))?.size).toBe(2);
    expect(count(d)).toEqual({ version: 1, load: 1 });
    expect(d.queries.find((q) => q.sql.includes("FROM kb_sync_state"))!.params).toEqual([VECTORS_VERSION_KEY]);
    await getVectorIndex(d as any, "help_sec", t0 + VECTOR_VERSION_CHECK_MS - 1);
    expect(count(d)).toEqual({ version: 1, load: 1 });
    await getVectorIndex(d as any, "help_sec", t0 + VECTOR_VERSION_CHECK_MS + 1);
    expect(count(d)).toEqual({ version: 2, load: 1 });
    version = "b";
    secs.push({ section: "caixa.md#z", chunk: 3, doc: 3, cos: 0.1 });
    // Dentro dos 60 s da última verificação a versão nova ainda não se vê…
    expect((await getVectorIndex(d as any, "help_sec", t0 + VECTOR_VERSION_CHECK_MS + 2))?.size).toBe(2);
    // …e passados os 60 s volta a ler os vetores.
    expect((await getVectorIndex(d as any, "help_sec", t0 + 2 * VECTOR_VERSION_CHECK_MS + 5))?.size).toBe(3);
    expect(count(d)).toEqual({ version: 3, load: 2 });
    secs.pop();
  });

  it("a BD falha ao ler a versão → fica a cópia que havia (sem erro); sem cópia → nada (a pesquisa fica lexical)", async () => {
    let fail = false;
    const d = sectionsDb(secs, { extra: (q) => (fail && q.sql.includes("kb_sync_state") ? Promise.reject(new Error("BD em baixo")) : undefined) });
    const t0 = 5_000_000;
    expect((await getVectorIndex(d as any, "help_sec", t0))?.size).toBe(2);
    fail = true;
    expect((await getVectorIndex(d as any, "help_sec", t0 + VECTOR_VERSION_CHECK_MS + 1))?.size).toBe(2);
    resetVectorCacheForTests();
    expect(await getVectorIndex(d as any, "help_sec", t0)).toBeNull();
  });

  it("pedidos ao mesmo tempo partilham a mesma leitura", async () => {
    const d = sectionsDb(secs);
    const [a, b] = await Promise.all([getVectorIndex(d as any, "help_sec", 10), getVectorIndex(d as any, "help_sec", 10)]);
    expect(a).toBe(b);
    expect(count(d).load).toBe(1);
  });

  it("memória com teto e medida: acima do teto o âmbito não se carrega; as ≈ 444 secções de 768 dimensões ficam abaixo de 2 MB", async () => {
    const big = Array.from({ length: VECTOR_CACHE_MAX_CHUNKS.help_sec + 1 }, (_, i) => ({ section: `x.md#s${i}`, chunk: i + 1, doc: i + 1, cos: 0.5 }));
    const d = sectionsDb(big);
    expect(await getVectorIndex(d as any, "help_sec", 1)).toBeNull();
    expect(vectorCacheStats().help_sec).toMatchObject({ overCap: true, chunks: 0 });
    // A consulta pede só até ao teto + 1 (nunca a tabela toda).
    // Contou primeiro e nem leu os vetores (B1).
    expect(d.queries.filter((q) => q.sql.includes("c.embedding IS NOT NULL")).map((q) => q.sql.includes("COUNT(*)"))).toEqual([true]);
    const v768 = Array.from({ length: 768 }, (_, k) => Math.sin(k));
    const rows = Array.from({ length: 444 }, (_, i) => ({ id: i + 1, docId: i + 1, embedding: encodeVector(v768), driveFileId: `help:pagina.md#seccao-numero-${i}`, visibilityRoles: "[]", visibilityCities: "[]" }));
    const index = await buildVectorIndex("help_sec", "v", rows);
    expect(index.vectors.byteLength).toBe(444 * 768 * 4);
    expect(index.bytes).toBeLessThan(2 * 1_048_576);
    expect(index.bytes).toBeGreaterThan(1_300_000);
  });
});

// ─── Visibilidade ───────────────────────────────────────────────────────────

describe("visibilidade igual à de hoje", () => {
  const hidden = sectionWithText("faturacao").id;
  const open = sectionWithText("multis").id;

  it("uma secção de um módulo sem acesso NUNCA aparece (bloco da pergunta, ajuda_procurar, pesquisa), mesmo com o vetor mais próximo", async () => {
    const extra = ctxFor("extra");
    expect(canSeeHelpPage(extra.user, pages.find((p) => p.id === "faturacao")!)).toBe(false);
    const secs: FakeSec[] = [{ section: hidden, chunk: 1, doc: 1, cos: 0.99 }, { section: open, chunk: 2, doc: 2, cos: 0.9 }];
    const d = sectionsDb(secs);
    const embed = async () => QUERY;
    const search = async (text: string, o: any) => (await searchHelpSectionsHybrid(text, o, { viewer: viewerFor("extra"), embedQuery: embed, d: d as any })).hits;
    const turn = await mpvTurnKnowledgeAsync({ path: "/multis", question: "zzzz qqqq", ctx: extra }, search);
    expect(turn.refs).not.toContain(hidden);
    expect(turn.block).not.toContain(hidden);
    const tool = await HELP_NAV_TOOLS.find((t) => t.name === "ajuda_procurar")!.run({ texto: "zzzz qqqq" }, { ...extra, sectionSearch: search });
    expect(tool.resultados.map((x: any) => x.id)).toContain(open);
    expect(tool.resultados.map((x: any) => x.id)).not.toContain(hidden);
    const adm = ctxFor("super_admin");
    const admTool = await HELP_NAV_TOOLS.find((t) => t.name === "ajuda_procurar")!.run({ texto: "zzzz qqqq" }, { ...adm, sectionSearch: search });
    expect(admTool.resultados.map((x: any) => x.id)).toContain(hidden);
    // Defesa no bloco: mesmo que a pesquisa devolvesse a secção, o filtro do módulo tira-a.
    const leaky = async () => [{ page: pages.find((p) => p.id === "faturacao")!, section: pages.find((p) => p.id === "faturacao")!.sections.find((s) => s.id === hidden)!, score: 9 }] as HelpSectionHit[];
    expect((await mpvTurnKnowledgeAsync({ path: "/multis", question: "x", ctx: extra }, leaky)).refs).not.toContain(hidden);
  });

  it("um vizinho que a BD não devolve (restringido ou retirado depois da leitura) não entra; o restringido em memória nem se pede", async () => {
    const secs: FakeSec[] = [
      { section: open, chunk: 1, doc: 1, cos: 0.95 },
      { section: sectionWithText("caixa").id, chunk: 2, doc: 2, cos: 0.94, roles: ["admin"] },
    ];
    const d = sectionsDb(secs, { confirm: (s) => s.chunk !== 1 });
    const r = await searchHelpSectionsHybrid("zzzz qqqq", { canSee: () => true, max: 6 }, { viewer: viewerFor("extra"), embedQuery: async () => QUERY, d: d as any });
    expect(r.mode).toBe("vetores");
    expect(r.hits).toEqual([]);
    const confirm = d.queries.find((q) => q.sql.includes("AND c.id IN ("))!;
    expect(confirm.params).toContain(1);
    expect(confirm.params).not.toContain(2); // restrita ao admin já na memória
    expect(confirm.sql).toContain("JSON_CONTAINS");
  });

  it("manuais (MPV): os vizinhos dos manuais também passam pela BD com a visibilidade e pelo canSeeKbDoc", async () => {
    const kbRow = (id: number, roles: string[], cos: number, ft = 0) => ({
      id, docId: id * 10, section: "Cofre", text: "procedimento do cofre", embedding: encodeVector(atCos(cos)), title: `Manual ${id}`, webViewLink: null,
      source: "drive", visibilityRoles: JSON.stringify(roles), visibilityCities: "[]", driveFileId: `drive-${id}`, ft,
    });
    const d = createFakeDb((q) => {
      if (q.sql.includes("FROM kb_sync_state")) return [[{ value: "v" }]];
      if (q.sql.includes("c.embedding IS NOT NULL")) return [[kbRow(1, [], 0.9), kbRow(2, [], 0.85), kbRow(3, [], 0.2)]];
      if (q.sql.includes("MATCH(")) return [[kbRow(3, [], 0.2, 5)]];
      // A BD devolve o 2 restringido ao admin (como se tivesse mudado depois da leitura): o canSeeKbDoc tira-o.
      if (q.sql.includes("AND c.id IN (")) return [[kbRow(1, [], 0.9), kbRow(2, ["admin"], 0.85)]];
      return [[]];
    });
    const r = await retrieveKnowledge({ question: "onde fica o cofre", viewer: viewerFor("extra"), d: d as any, topK: 4, excludeSources: ["help"], helpTopK: 0, vectorNeighbors: true, embedQuery: async () => QUERY });
    expect(r.mode).toBe("embeddings");
    expect(r.hits.map((x) => x.chunkId)).toContain(1);
    expect(r.hits.map((x) => x.chunkId)).not.toContain(2);
    const confirm = d.queries.find((q) => q.sql.includes("AND c.id IN ("))!;
    expect(confirm.sql).toContain("JSON_CONTAINS");
    expect(confirm.sql).toContain("d.source NOT IN (?)");
    expect(confirm.params).not.toContain(3); // já veio do FULLTEXT
  });
});

// ─── Sem vetores → lexical ──────────────────────────────────────────────────

describe("sem a parte vetorial fica a lexical, sem erro", () => {
  const q = "nota de crédito";
  const lexical = () => searchHelpSections(tree, q, { canSee: () => true, max: 6 });
  const target = sectionWithText("caixa").id;

  it("vetores desligados (sem vetorizador): a lexical, sem tocar na BD", async () => {
    const d = createFakeDb(() => [[]]);
    const r = await searchHelpSectionsHybrid(q, { canSee: () => true, max: 6 }, { viewer: viewerFor("admin"), embedQuery: null, d: d as any });
    expect(r).toEqual({ hits: lexical(), mode: "lexical" });
    expect(d.queries).toHaveLength(0);
  });

  it("sem vetores na BD: a lexical, sem gastar o vetor da pergunta", async () => {
    const d = sectionsDb([]);
    const embed = vi.fn(async () => QUERY);
    expect(await searchHelpSectionsHybrid(q, { canSee: () => true, max: 6 }, { viewer: viewerFor("admin"), embedQuery: embed, d: d as any })).toEqual({ hits: lexical(), mode: "lexical" });
    expect(embed).not.toHaveBeenCalled();
  });

  it("a IA falha, devolve um vetor de outro tamanho, ou a BD falha: a lexical", async () => {
    const secs: FakeSec[] = [{ section: target, chunk: 1, doc: 1, cos: 0.99 }];
    for (const embedQuery of [async () => { throw new Error("orçamento"); }, async () => null, async () => [1, 0]]) {
      resetVectorCacheForTests();
      const r = await searchHelpSectionsHybrid(q, { canSee: () => true, max: 6 }, { viewer: viewerFor("admin"), embedQuery: embedQuery as any, d: sectionsDb(secs) as any });
      expect(r).toEqual({ hits: lexical(), mode: "lexical" });
    }
    resetVectorCacheForTests();
    const broken = sectionsDb(secs, { extra: (x) => (x.sql.includes("AND c.id IN (") ? Promise.reject(new Error("BD")) : undefined) });
    expect(await searchHelpSectionsHybrid(q, { canSee: () => true, max: 6 }, { viewer: viewerFor("admin"), embedQuery: async () => QUERY, d: broken as any })).toEqual({ hits: lexical(), mode: "lexical" });
  });

  it("mais lento do que o prazo (~3 s): corta e fica a lexical", async () => {
    const secs: FakeSec[] = [{ section: target, chunk: 1, doc: 1, cos: 0.99 }];
    const slow = () => new Promise<number[]>((resolve) => setTimeout(() => resolve(QUERY), 300));
    const t = Date.now();
    const r = await searchHelpSectionsHybrid(q, { canSee: () => true, max: 6 }, { viewer: viewerFor("admin"), embedQuery: slow, d: sectionsDb(secs) as any, deadlineMs: 40 });
    expect(r.mode).toBe("lexical");
    expect(r.hits).toEqual(lexical());
    expect(Date.now() - t).toBeLessThan(250);
    expect(await withinMs(new Promise((r2) => setTimeout(() => r2(1), 5)), 1_000)).toBe(1);
    expect(await withinMs(Promise.reject(new Error("x")), 1_000)).toBeNull();
  });

  it("manuais: sem vetores (ou a parte vetorial falha) ficam os candidatos do FULLTEXT, como hoje", async () => {
    const row = { id: 1, docId: 10, section: "Cofre", text: "procedimento do cofre e das chaves", embedding: null, title: "Manual", webViewLink: null, source: "drive", visibilityRoles: "[]", visibilityCities: "[]", driveFileId: "x", ft: 2 };
    const d = createFakeDb((x) => (x.sql.includes("MATCH(") ? [[row]] : x.sql.includes("FROM kb_sync_state") ? Promise.reject(new Error("BD")) : [[]]));
    const r = await retrieveKnowledge({ question: "procedimento do cofre", viewer: viewerFor("admin"), d: d as any, excludeSources: ["help"], helpTopK: 0, vectorNeighbors: true, embedQuery: null });
    expect(r.hits.map((x) => x.chunkId)).toEqual([1]);
    expect(r.mode).toBe("fulltext");
    expect(r.failed).toBeUndefined();
  });
});

// ─── O vetor da pergunta uma vez por pedido ─────────────────────────────────

describe("o vetor da pergunta calcula-se UMA vez por pedido", () => {
  it("onceQueryEmbed: o mesmo texto → uma chamada; um texto diferente → a sua; uma falha não se repete", async () => {
    const base = vi.fn(async (t: string) => (t === "falha" ? Promise.reject(new Error("x")) : [t.length, 0, 0, 0]));
    const e = onceQueryEmbed(base);
    await Promise.all([e("Como fecho a caixa?"), e("  Como fecho a caixa?  "), e("Como fecho a caixa?")]);
    expect(base).toHaveBeenCalledTimes(1);
    await e("outra coisa");
    expect(base).toHaveBeenCalledTimes(2);
    expect(await e("falha")).toBeNull();
    expect(await e("falha")).toBeNull();
    expect(base).toHaveBeenCalledTimes(3);
  });

  it("piloto: bloco da ajuda + manuais + descida smart → lite partilham o mesmo vetor (1 chamada)", async () => {
    const target = sectionWithText("caixa").id;
    h.db = createFakeDb((q) => {
      if (q.sql.startsWith("INSERT INTO ai_rate_limits")) return [{ insertId: 1, affectedRows: 1 }];
      if (q.sql.includes("FROM app_settings") && !q.sql.includes("LIKE")) return [[{ settingKey: "ai.assistantPilot", value: JSON.stringify({ userIds: [7] }) }]];
      if (q.sql.includes("AS dayEur")) return [[{ dayEur: "20", monthEur: "20" }]]; // o teto do smart já passou → desce para o lite
      if (q.sql.includes("userId = ?") && q.sql.includes("FROM ai_usage_log")) return [[{ spent: "0" }]];
      if (q.sql.includes("kb_") || q.sql.includes("MATCH(")) return respondLike(q);
      return [[]];
    });
    // O responder das tabelas da base (o mesmo da BD falsa das secções).
    function respondLike(q: FakeQuery): unknown {
      if (q.sql.includes("FROM kb_sync_state")) return [[{ value: "v1" }]];
      if (q.sql.includes("c.embedding IS NOT NULL") && q.sql.includes("d.source = 'help_sec'")) {
        return [[{ id: 11, docId: 101, embedding: encodeVector(atCos(0.95)), driveFileId: `help:${target}`, visibilityRoles: "[]", visibilityCities: "[]" }]];
      }
      if (q.sql.includes("AND c.id IN (") && q.params.includes("help_sec")) {
        return [[{ id: 11, docId: 101, section: null, text: "t", embedding: null, title: "t", webViewLink: null, source: "help_sec", visibilityRoles: "[]", visibilityCities: "[]", driveFileId: `help:${target}`, ft: 0 }]];
      }
      return [[]];
    }
    invalidateSettingsCache();
    process.env.MPV = "on";
    process.env.AI_ASSISTANT_SMART = "on";
    const p = createFakeProvider("gemini", [okResponse("Lite.")]);
    setAiProvidersForTests({ gemini: p });
    const embedQuery = vi.fn(async () => QUERY);
    const stale: AssistantMode = { feature: "assistant_smart", pilot: true, economy: false, economyReason: null };
    const r = await askAssistant({ question: "zzzz qqqq wwww", path: "/multis" }, ctxFor("super_admin", 7), { memoryEnabled: false, mode: stale, embedQuery });
    expect(r).toMatchObject({ ok: true, feature: "assistant", economy: true });
    expect(embedQuery).toHaveBeenCalledTimes(1);
    // O vizinho (sem palavras em comum) chegou ao bloco da pergunta.
    expect((r as any).helpFiles).toContain(target);
    const sent = (p.calls[0].parts ?? []).map((x: any) => x?.text ?? "").join("\n");
    expect(sent).toContain(`<ajuda id="${target}"`);
    // Os manuais foram consultados com os vizinhos (memória "kb") — o mesmo vetor.
    expect(h.db.queries.some((q: FakeQuery) => q.sql.includes("c.embedding IS NOT NULL") && q.sql.includes("d.source NOT IN ('help', 'help_sec')"))).toBe(true);
  });
});

// ─── O v1 igual ─────────────────────────────────────────────────────────────

describe("v1 fica exatamente igual", () => {
  // Consultas dos candidatos do v1 (manuais + ajuda por ficheiro), calculadas na origin/main 7e1fb5d1, ANTES da F5.
  const V1_CANDIDATES = { count: 24, sha: "bbda6a0aec941a49d3b16711771530b145202814571639b7742479a9f1f56809" };

  it("as consultas dos candidatos do v1 são as de antes (e nunca leem vetores da memória nem a versão)", async () => {
    const dialect = new MySqlDialect();
    const seen: string[] = [];
    const mk = (ft: boolean) => ({ execute: async (q: any) => { const c = dialect.sqlToQuery(q); seen.push(JSON.stringify([c.sql, c.params])); return c.sql.includes("MATCH") && !ft ? [[]] : [[{ id: 1, docId: 2, section: null, text: "fecho da caixa", embedding: null, title: "T", webViewLink: null, source: "drive", visibilityRoles: "[]", visibilityCities: "[]", driveFileId: null, ft: 1 }]]; } });
    for (const ft of [true, false]) {
      for (const viewer of [{ role: "admin", allCities: true, cityNames: [] }, { role: "extra", allCities: false, cityNames: ["Lisboa"] }]) {
        await retrieveKnowledge({ question: "fecho da caixa no cofre", viewer, d: mk(ft) as any, embedQuery: null, excludeSources: ["help"], helpTopK: 6 });
        await retrieveKnowledge({ question: "fecho da caixa no cofre", viewer, d: mk(ft) as any, embedQuery: null, excludeSources: ["help"], helpTopK: 0, topK: 4 });
        await retrieveKnowledge({ question: "fecho da caixa no cofre", viewer, d: mk(ft) as any, embedQuery: null, topK: 6 });
      }
    }
    expect({ count: seen.length, sha: createHash("sha256").update(seen.join("\n")).digest("hex") }).toEqual(V1_CANDIDATES);
    expect(seen.some((s) => s.includes("kb_sync_state") || s.includes("c.embedding IS NOT NULL"))).toBe(false);
  });

  it("fora do piloto o vetorizador do MPV nunca se chama e a ajuda é a de sempre (ficheiros)", async () => {
    invalidateSettingsCache();
    h.db = createFakeDb((q) => (q.sql.includes("FROM app_settings") && !q.sql.includes("LIKE") ? [[{ settingKey: "ai.assistantPilot", value: JSON.stringify({ userIds: [7] }) }]] : [[]]));
    const p = createFakeProvider("gemini", [okResponse("Passos.")]);
    setAiProvidersForTests({ gemini: p });
    const embedQuery = vi.fn(async () => QUERY);
    const r = await askAssistant({ question: "Como fecho a caixa?", path: "/caixa" }, ctxFor("admin", 7), { knowledge: null, memoryEnabled: false, embedQuery });
    expect(r).toMatchObject({ ok: true, feature: "assistant" });
    expect(embedQuery).not.toHaveBeenCalled();
    expect((r as any).helpFiles.every((f: string) => /\.md$/.test(f))).toBe(true);
    expect(h.db.queries.some((q: FakeQuery) => q.sql.includes("kb_sync_state") || q.sql.includes("c.embedding IS NOT NULL"))).toBe(false);
  });

  it("o bloco da pergunta sem pesquisa do piloto é o mesmo da F3", async () => {
    for (const [path, tab, question] of [["/extras-dia", "pressao", "O que é o p75 no Porto?"], ["/despesas", null, "Como registo uma nota de crédito?"], ["/caixa", null, "Como fecho a caixa?"]] as const) {
      const ctx = ctxFor("supervisor");
      expect(await mpvTurnKnowledgeAsync({ path, tab, question, ctx }, null)).toEqual(mpvTurnKnowledge({ path, tab, question, ctx }));
      // Uma pesquisa "lexical" injetada dá o mesmo bloco (a montagem não mudou).
      const lex = async (t: string, o: any) => searchHelpSections(tree, t, o);
      expect(await mpvTurnKnowledgeAsync({ path, tab, question, ctx }, lex)).toEqual(mpvTurnKnowledge({ path, tab, question, ctx }));
    }
  });

  it("o ajuda_procurar sem a pesquisa do piloto no contexto é o da F3 (lexical, sem BD nem IA)", async () => {
    const ctx = ctxFor("supervisor");
    const r = await HELP_NAV_TOOLS.find((t) => t.name === "ajuda_procurar")!.run({ texto: "nota de crédito" }, ctx);
    expect(r.resultados.map((x: any) => x.id)).toEqual(searchHelpSections(tree, "nota de crédito", { canSee: (pg) => canSeeHelpPage(ctx.user, pg), max: 8 }).map((x) => x.section.id));
  });
});

// ─── Vetores das secções: backfill com quota própria ────────────────────────

describe("vetores das secções (help_sec): mesmo modelo e backfill, quota própria", () => {
  it("unembeddedDocIds: por omissão sem as secções (a quota do Drive fica igual); com helpSections, só as secções", async () => {
    const d = createFakeDb(() => [[]]);
    await unembeddedDocIds(d as any, 3);
    await unembeddedDocIds(d as any, 121, { helpSections: true });
    expect(d.queries[0].sql).toContain("d.source <> 'help_sec'");
    expect(d.queries[1].sql).toContain("d.source = 'help_sec'");
    expect(d.queries[1].sql).not.toContain("<> 'help_sec'");
  });

  it("um lote: um pedido de embeddings para as secções, o mesmo texto da base (título — secção + trecho), uma só mudança de versão", async () => {
    const d = createFakeDb((q) => {
      if (q.sql.includes("d.source = 'help_sec'") && q.sql.startsWith("SELECT d.id")) return [[{ id: 1 }, { id: 2 }, { id: 3 }]];
      if (q.sql.includes("c.embedding IS NULL")) return [[
        { id: 10, docId: 1, section: "Fecho", text: "a", title: "Ajuda: Caixa → Fecho" },
        { id: 11, docId: 1, section: null, text: "b", title: "Ajuda: Caixa → Fecho" },
        { id: 20, docId: 2, section: null, text: "c", title: "Ajuda: Multis" },
      ]];
      return [[]];
    });
    const embed = vi.fn(async (texts: string[]) => ({ vectors: texts.map(() => [1, 0]), model: "gemini-embedding-001" }));
    const r = await embedHelpSections(d as any, embed, { deadlineAt: Date.now() + 60_000, maxPerRun: 2 });
    expect(r).toEqual({ embedded: 2, done: false });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0][0]).toEqual([embedText("Ajuda: Caixa → Fecho", "Fecho", "a"), embedText("Ajuda: Caixa → Fecho", null, "b"), embedText("Ajuda: Multis", null, "c")]);
    // Só os 2 da quota (o 3.º fica para a próxima), cada um marcado com vetores.
    const docsDone = d.queries.filter((q) => q.sql.startsWith("UPDATE kb_documents SET embedded = 1"));
    expect(docsDone.map((q) => q.params.at(-1))).toEqual([1, 2]);
    expect(d.queries.filter((q) => q.sql.includes("INSERT INTO kb_sync_state")).map((q) => q.params[0])).toEqual([VECTORS_VERSION_KEY]);
    // A IA em baixo: nada se marca e tenta na próxima corrida.
    const down = await embedHelpSections(d as any, async () => { throw new Error("orçamento"); }, { deadlineAt: Date.now() + 60_000 });
    expect(down).toMatchObject({ embedded: 0, done: false, error: "orçamento" });
    // Sem tempo: nem pede.
    expect(await embedHelpSections(d as any, embed, { deadlineAt: Date.now() + 5_000 })).toEqual({ embedded: 0, done: false });
    expect(HELP_SECTIONS_EMBED_PER_RUN).toBeGreaterThanOrEqual(80);
  });

  it("na corrida: o Drive primeiro (os mesmos 3 por corrida), as secções depois e à parte; com o MPV desligado, as secções não", async () => {
    const order: string[] = [];
    const mk = () => createFakeDb((q) => {
      if (q.sql.startsWith("SELECT d.id FROM kb_documents d WHERE d.deletedAt IS NULL AND d.status = 'synced' AND d.embedded = 0")) {
        if (q.sql.includes("d.source = 'help_sec'")) { order.push("secções"); return [[{ id: 900 }]]; }
        order.push("drive");
        return [[{ id: 1 }]];
      }
      if (q.sql.includes("FROM kb_documents d WHERE d.id = ?")) return [[{ id: 1, source: "drive", title: "Manual", status: "synced", visibilityRoles: "[]", visibilityCities: "[]" }]];
      if (q.sql.startsWith("SELECT id, ord, section, text")) return [[{ id: 5, ord: 0, section: null, text: "x", hasEmb: 0 }]];
      if (q.sql.includes("c.embedding IS NULL")) return [[{ id: 7, docId: 900, section: null, text: "y", title: "Ajuda: X" }]];
      return [[]];
    });
    const embed = vi.fn(async (texts: string[]) => ({ vectors: texts.map(() => [1, 0]), model: "m" }));
    const on = await runKnowledgeSync({ deadlineAt: Date.now() + 60_000, d: mk() as any, drive: null, embed, helpFiles: [], helpSections: true });
    expect(order).toEqual(["drive", "secções"]);
    expect(on.help.sectionsEmbedded).toBe(1);
    expect(on.embedded).toBe(1); // o do Drive (as secções contam à parte)
    order.length = 0;
    const off = await runKnowledgeSync({ deadlineAt: Date.now() + 60_000, d: mk() as any, drive: null, embed, helpFiles: [], helpSections: false });
    expect(order).toEqual(["drive"]);
    expect(off.help.sectionsEmbedded).toBeUndefined();
  });

  it("custo da 1.ª vez, medido: ≈ 430 secções, ≈ 130 mil tokens, cêntimos (gemini-embedding-001)", () => {
    let sections = 0;
    let chunks = 0;
    let tokens = 0;
    for (const page of pages) {
      for (const s of page.sections) {
        if (!s.text.trim()) continue;
        sections++;
        // O mesmo texto que o syncHelpSections guarda e o embedHelpSections manda.
        const title = (s.level === 1 ? `Ajuda: ${page.title}` : `Ajuda: ${page.title} → ${s.title}`).slice(0, 300);
        for (const c of chunkText(`${title.replace(/^Ajuda: /, "")}\n\n${s.text}`)) {
          chunks++;
          tokens += estimateTokens(embedText(title, c.section, c.text).slice(0, 8000));
        }
      }
    }
    const eur = costEur("gemini-embedding-001", { inputTokens: tokens, outputTokens: 0, cachedTokens: 0 });
    expect(sections).toBeGreaterThan(350);
    expect(sections).toBeLessThan(550);
    expect(chunks).toBeGreaterThanOrEqual(sections);
    expect(tokens).toBeGreaterThan(90_000);
    expect(tokens).toBeLessThan(180_000);
    expect(eur).toBeLessThan(0.05);
    expect(HELP_FILES.length).toBeGreaterThan(40);
  });
});

// ─── Auditoria (M1–M3, B1–B4) ───────────────────────────────────────────────

describe("M1: quem entra SÓ pelo vetor precisa de cos ≥ max(0,7; melhor − 0,08)", () => {
  const all = { canSee: () => true };
  const LOG = /^\[knowledge\] vetor (kb|help_sec): limiar \d\.\d{3} aceites \[[\d.,]*\] rejeitados \[[\d.,]*\]$/;

  it("o limiar: nunca abaixo de 0,7; perto do melhor sobe com ele", () => {
    expect(vectorOnlyThreshold(0.6)).toBe(0.7);
    expect(vectorOnlyThreshold(0.75)).toBe(0.7);
    expect(vectorOnlyThreshold(0.95)).toBeCloseTo(0.87, 6);
  });

  it("secções: 0,65 já não entra só pelo vetor; 0,72 entra se o melhor for 0,78 e não entra se for 0,95; a lexical não muda", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const [a, b, c] = pages.filter((p) => p.id !== "despesas").map((p) => p.sections.find((s) => s.text.trim())).filter(Boolean).slice(0, 3).map((s) => s!.id);
    const q = "zzzz qqqq";
    const run = (cos: Array<[string, number]>) => rankHelpSections(tree, q, { ...all, max: 8 }, { cos: new Map(cos), neighbors: cos.map(([id]) => id), ft: new Map() }).map((x) => x.section.id);
    expect(run([[a, 0.65]])).toEqual([]);
    expect(run([[a, 0.78], [b, 0.72]])).toEqual([a, b]);
    expect(run([[c, 0.95], [b, 0.72]])).toEqual([c]);
    // Só números no registo (nunca ids nem títulos).
    const lines = info.mock.calls.map((x) => String(x[0])).filter((x) => x.includes("vetor help_sec"));
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      expect(l).toMatch(LOG);
      expect(l).not.toContain(".md");
    }
    expect(lines[2]).toContain("limiar 0.870 aceites [0.950] rejeitados [0.720]");
    // Quem passa na lexical não depende do vetor.
    const lex = searchHelpSections(tree, "nota de crédito", all);
    const withLowCos = rankHelpSections(tree, "nota de crédito", { ...all, max: 8 }, { cos: new Map(lex.map((h) => [h.section.id, 0.1])), neighbors: [], ft: new Map() });
    expect(withLowCos.map((x) => x.section.id).sort()).toEqual(lex.map((x) => x.section.id).sort());
  });

  it("manuais: no MPV a mesma regra (0,65 só pelo vetor fica de fora); o v1 continua com 0,6", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const row = (id: number, cos: number): CandidateRow => ({
      id, docId: id, section: null, text: "zzz", embedding: encodeVector(atCos(cos)), title: "Manual", webViewLink: null, source: "drive",
      visibilityRoles: "[]", visibilityCities: "[]", ft: 0, ref: null,
    });
    const rows = [row(1, 0.65), row(2, 0.9), row(3, 0.84)];
    const v1 = await rankCandidates("cofre", rows, QUERY, 8);
    expect(v1.hits.map((h) => h.chunkId)).toEqual([2, 3, 1]);
    const mpv = await rankCandidates("cofre", rows, QUERY, 8, { strictVector: { scope: "kb" } });
    expect(mpv.hits.map((h) => h.chunkId)).toEqual([2, 3]);
    const line = info.mock.calls.map((x) => String(x[0])).find((x) => x.includes("vetor kb"))!;
    expect(line).toMatch(LOG);
    expect(line).toContain("limiar 0.820 aceites [0.900,0.840] rejeitados [0.650]");
    // No v1 nada se regista.
    expect(info.mock.calls.filter((x) => String(x[0]).includes("vetor kb"))).toHaveLength(1);
  });
});

describe("M2: uma corrida que refaz os trechos não deixa o documento como \"com vetores\"", () => {
  /** BD em memória: só o que interessa (trechos com/sem vetor e o embedded do documento). */
  function memDb() {
    const chunks = new Map<number, { docId: number; embedding: string | null }>([[1, { docId: 5, embedding: null }], [2, { docId: 5, embedding: null }]]);
    const doc = { embedded: 0 };
    const d = createFakeDb((q) => {
      if (q.sql.startsWith("SELECT id, ord, section, text")) {
        return [[...chunks].filter(([, c]) => c.docId === 5).map(([id, c]) => ({ id, ord: id, section: null, text: "t", hasEmb: c.embedding ? 1 : 0 }))];
      }
      if (q.sql.startsWith("UPDATE kb_chunks SET embedding")) {
        const [vec, id] = q.params as [string, number];
        const c = chunks.get(id);
        if (c) c.embedding = vec;
        return [{ affectedRows: c ? 1 : 0 }];
      }
      if (q.sql.startsWith("UPDATE kb_documents SET embedded = 1")) {
        expect(q.sql).toContain("NOT EXISTS (SELECT 1 FROM kb_chunks k WHERE k.docId = ? AND k.embedding IS NULL)");
        const left = [...chunks.values()].some((c) => c.docId === 5 && !c.embedding);
        if (!left) doc.embedded = 1;
        return [{ affectedRows: left ? 0 : 1 }];
      }
      return [[]];
    });
    return { d, chunks, doc };
  }

  it("lê os trechos antigos → outra corrida reescreve-os → grava: o documento continua por vetorizar", async () => {
    const { d, chunks, doc } = memDb();
    const embed = async (texts: string[]) => {
      // A meio: outra corrida refez o documento (trechos novos, sem vetor).
      chunks.clear();
      chunks.set(3, { docId: 5, embedding: null });
      return { vectors: texts.map(() => [1, 0]), model: "m" };
    };
    expect(await embedDoc(d as any, 5, "Manual", embed)).toBe(true);
    expect(doc.embedded).toBe(0);
    expect(chunks.get(3)!.embedding).toBeNull();
  });

  it("sem corrida pelo meio: fica com vetores (como sempre)", async () => {
    const { d, doc } = memDb();
    expect(await embedDoc(d as any, 5, "Manual", async (t) => ({ vectors: t.map(() => [1, 0]), model: "m" }))).toBe(true);
    expect(doc.embedded).toBe(1);
  });
});

describe("M3: as duas partes vetoriais em paralelo, só depois do limite de pedidos", () => {
  it("o bloco da página (função) e a base correm ao mesmo tempo; com o limite atingido nenhum corre", async () => {
    setAiProvidersForTests({ gemini: createFakeProvider("gemini", [okResponse("Ok.")]) });
    const events: string[] = [];
    const slow = (name: string, value: any) => async () => {
      events.push(`${name}:início`);
      await new Promise((r) => setTimeout(r, 40));
      events.push(`${name}:fim`);
      return value;
    };
    const pageKnowledge = vi.fn(slow("página", { block: "<pagina_atual>\nx\n</pagina_atual>", refs: ["caixa.md#inicio"] }));
    const knowledge = vi.fn(slow("base", null));
    const base = {
      feature: "assistant" as const, channel: "staff" as const, ownerKey: "user:7", userId: 7, question: "Como fecho a caixa?",
      limits: { perMinute: 1, perDay: 10, maxInputChars: 1000 }, rateKey: "assistant:f5-paralelo", system: "s", pageKnowledge, knowledge,
    };
    const r = await runChatTurn(base as any);
    expect(r).toMatchObject({ ok: true, helpFiles: ["caixa.md#inicio"] });
    expect(events.slice(0, 2).sort()).toEqual(["base:início", "página:início"]);
    // O segundo pedido no mesmo minuto é recusado ANTES de qualquer pesquisa.
    const again = await runChatTurn(base as any);
    expect(again).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(pageKnowledge).toHaveBeenCalledTimes(1);
    expect(knowledge).toHaveBeenCalledTimes(1);
  });
});

describe("B1–B4", () => {
  it("B4: o índice só lê os vetores do modelo atual", async () => {
    const d = sectionsDb([{ section: "caixa.md#x", chunk: 1, doc: 1, cos: 0.9 }]);
    await getVectorIndex(d as any, "help_sec", 1);
    const loads = d.queries.filter((q) => q.sql.includes("c.embedding IS NOT NULL"));
    expect(loads).toHaveLength(2);
    for (const q of loads) {
      expect(q.sql).toContain("d.embedModel = ?");
      expect(q.params).toContain("gemini-embedding-001");
    }
  });

  it("B3: a IA dos vetores falhou no Drive → as secções nem se tentam; uma falha das secções vai para os erros da corrida", async () => {
    const mk = (opts: { sectionsFail?: boolean } = {}) => createFakeDb((q) => {
      if (q.sql.startsWith("SELECT d.id FROM kb_documents d WHERE d.deletedAt IS NULL AND d.status = 'synced' AND d.embedded = 0")) {
        return q.sql.includes("d.source = 'help_sec'") ? [[{ id: 900 }]] : opts.sectionsFail ? [[]] : [[{ id: 1 }]];
      }
      if (q.sql.includes("FROM kb_documents d WHERE d.id = ?")) return [[{ id: 1, source: "drive", title: "Manual", status: "synced", visibilityRoles: "[]", visibilityCities: "[]" }]];
      if (q.sql.startsWith("SELECT id, ord, section, text")) return [[{ id: 5, ord: 0, section: null, text: "x", hasEmb: 0 }]];
      if (q.sql.includes("c.embedding IS NULL")) return [[{ id: 7, docId: 900, section: null, text: "y", title: "Ajuda: X" }]];
      return [[]];
    });
    const down = vi.fn(async () => { throw new Error("orçamento"); });
    const d1 = mk();
    const r1 = await runKnowledgeSync({ deadlineAt: Date.now() + 60_000, d: d1 as any, drive: null, embed: down, helpFiles: [], helpSections: true });
    expect(down).toHaveBeenCalledTimes(1); // só o do Drive
    expect(d1.queries.some((q) => q.sql.includes("d.source = 'help_sec'") && q.sql.startsWith("SELECT d.id"))).toBe(false);
    expect(r1.done).toBe(false);
    // O Drive sem nada por fazer e as secções a falhar: o erro fica na corrida.
    const d2 = mk({ sectionsFail: true });
    const r2 = await runKnowledgeSync({ deadlineAt: Date.now() + 60_000, d: d2 as any, drive: null, embed: down, helpFiles: [], helpSections: true });
    expect(r2.errors.some((e) => e.startsWith("Ajuda (vetores das secções):"))).toBe(true);
    expect(r2.help.sectionsEmbedded).toBe(0);
  });

  it("B3: gravar a versão falhar não faz o embedDoc (v1) devolver false", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const d = createFakeDb((q) => {
      if (q.sql.startsWith("SELECT id, ord, section, text")) return [[{ id: 1, ord: 0, section: null, text: "t", hasEmb: 0 }]];
      if (q.sql.includes("INSERT INTO kb_sync_state")) return Promise.reject(new Error("BD"));
      return [{ affectedRows: 1 }];
    });
    expect(await embedDoc(d as any, 5, "Manual", async (t) => ({ vectors: t.map(() => [1]), model: "m" }))).toBe(true);
    expect(warn.mock.calls.some((x) => String(x[0]).includes("versão dos vetores por gravar"))).toBe(true);
    // E o saveEmbeddings também não lança.
    await expect(saveEmbeddings(d as any, 5, [{ chunkId: 1, vector: "x" }], "m")).resolves.toBeUndefined();
  });
});

it("vetores falsos de 4 dimensões", () => {
  expect(DIM).toBe(4);
});
