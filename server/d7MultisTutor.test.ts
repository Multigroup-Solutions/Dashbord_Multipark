/**
 * D7 (Jorge, 16 out 2026): "o Multis passa a ser o tutor da página Formação".
 *
 *  - `training.tutorMode` ("multis" por omissão | "proprio") — reversível;
 *  - com "multis": na página Formação o Multis (v1 e piloto) recebe o papel de
 *    tutor e os trechos dos manuais/vídeos da formação (o módulo aberto
 *    primeiro), com a visibilidade de hoje (publicados; base de conhecimento
 *    pelo papel e cidades, igual ao tutor); no piloto também o perfil de tutor
 *    e a `formacao_procurar` (só leitura, sem IA);
 *  - com "proprio": tudo como era (o código do tutor próprio fica igual);
 *  - nas outras páginas o v1 não muda (os hashes da F3 continuam em mpvF3.test.ts).
 *
 * Nada de IA real: fornecedor falso; BD falsa; leituras da formação simuladas.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const h = vi.hoisted(() => ({
  db: null as any,
  manuals: [] as Array<{ id: number; title: string; content: string; published: number }>,
  videos: [] as Array<{ id: number; title: string; description: string | null }>,
  kbDocs: [] as Array<{ docId: number; title: string; text: string; roles: string[]; cities: string[] }>,
  kbCfg: { useInTutor: true, useInAssistant: true },
  kbCalls: [] as any[],
  getTrainingManuals: vi.fn(),
  loadModule: vi.fn(),
  recordQuestion: vi.fn(),
}));

vi.mock("./db", async (orig) => ({
  ...(await orig<object>()),
  getDb: async () => h.db,
  logActivity: vi.fn(),
  getUserPermissionOverrides: async () => ({}),
  getEmployeeByUserId: async () => ({ employee: { id: 7 } }),
  getTrainingManuals: (...a: any[]) => h.getTrainingManuals(...a),
  getTrainingVideos: async () => h.videos,
}));
vi.mock("./trainingTutorStore", () => ({ loadModule: (...a: any[]) => h.loadModule(...a), recordQuestion: (...a: any[]) => h.recordQuestion(...a) }));
vi.mock("./knowledge/sync", () => ({ loadKnowledgeConfig: async () => h.kbCfg }));
// A base de conhecimento: a barreira em código é a de sempre (canSeeKbDoc), aplicada aqui aos documentos de teste.
vi.mock("./knowledge/retrieve", async (orig) => {
  const real = await orig<typeof import("./knowledge/retrieve")>();
  const { canSeeKbDoc } = await import("../shared/knowledge");
  return {
    ...real,
    retrieveKnowledge: async (input: any) => {
      h.kbCalls.push(input);
      const hits = h.kbDocs
        .filter((d) => canSeeKbDoc({ roles: d.roles as any, cities: d.cities as any }, input.viewer))
        .map((d, i) => ({ chunkId: i + 1, docId: d.docId, title: d.title, section: null, text: d.text, href: null, source: "drive", score: 1 }));
      return { hits, citations: real.citationsFor(hits), mode: "keywords", ...(input.helpTopK ? { helpHits: [] } : {}) };
    },
  };
});
vi.mock("./cityAccess", async (orig) => ({
  ...(await orig<object>()),
  loadCityAccess: async () => ({ all: false, defaultCityId: 10, cityName: "Lisboa", cityNames: ["Lisboa"], cityIds: [10], projectIds: [10], missingCostCenter: false }),
}));

import { SETTINGS, validateSetting } from "../shared/appSettings";
import { pagePathOf, sanitizeMultisPage } from "../shared/multisPage";
import { MULTIS_TUTOR_PROFILE, MULTIS_TUTOR_V1_ROLE, multisProfileFor, profileQuestions } from "../shared/multisProfiles";
import { TUTOR_DEFAULT_MODE, trainingDeepLink, tutorContextFromPage, tutorQuickQuestions } from "../shared/trainingTutor";
import { setAiProvidersForTests } from "./_core/ai/client";
import { resetContextCacheForTests } from "./_core/ai/contextCache";
import { resetRateLimitMemoryForTests } from "./_core/ai/rateLimit";
import { resetAiUsageCachesForTests } from "./_core/ai/usage";
import { resetFinalCallModeForTests } from "./_core/ai/run";
import { resetMaskedColumnsForTests } from "./_core/ai/chat/store";
import { createRedactionContext } from "./_core/ai/pii";
import { availableTools, makeToolExecutor, toolDeclarations } from "./_core/ai/chat/tools";
import { createFakeDb, createFakeProvider, okResponse } from "./_core/ai/testUtils";
import { invalidateSettingsCache } from "./appSettings";
import { cityScope } from "./cityScope";
import type { CityAccess } from "./cityAccess";
import { FORMACAO_SEARCH_TOOL, formacaoSearchInput } from "./assistant/formacaoTool";
import { mpvSuggestions, mpvTurnKnowledge } from "./assistant/mpv";
import { askAssistant, formacaoKnowledge, staffHelpDocs, staffSystemPrompt, turnContext, type AssistantMode } from "./assistant/service";
import { MPV_STAFF_TOOLS, STAFF_TOOLS, type StaffToolCtx } from "./assistant/tools";
import { tutorKnowledge } from "./trainingTutor";
import { mergeTrainingHits, recordTutorQuestion, resetTrainingCatalogForTests, searchTrainingContent, trainingHitOf, trainingTutorMode } from "./trainingTutorMultis";
import { trainingTutorRouter } from "./trainingTutorRouter";

const KEYS = ["GEMINI_API_KEY", "LLM_API_KEY", "OPENAI_API_KEY", "AI_ENABLED", "AI_ASSISTANT", "AI_ASSISTANT_SMART", "MPV", "AI_PROVIDER", "AI_ASSISTANT_MEMORY", "AI_MONTHLY_BUDGET_EUR"];
let saved: Record<string, string | undefined> = {};

const LISBOA: CityAccess = { all: false, defaultCityId: 10, cityName: "Lisboa", cityNames: ["Lisboa"], cityIds: [10], projectIds: [10], missingCostCenter: false };
const V1: AssistantMode = { feature: "assistant", pilot: false, economy: false, economyReason: null };
const PILOT: AssistantMode = { feature: "assistant", pilot: true, economy: false, economyReason: null };
const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8").replace(/\r\n/g, "\n");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const sentText = (c: { input?: string; parts?: any[] }) => [c.input ?? "", ...(c.parts ?? []).map((x: any) => x?.text ?? "")].join("\n");

const MANUALS = [
  { id: 11, title: "Manual do condutor", published: 1, content: "## Entrega das chaves\nAs chaves são entregues ao cliente só depois de confirmar a reserva no terminal. Contacto: chefe@multipark.pt" },
  { id: 12, title: "Rascunho de procedimentos", published: 0, content: "## Chaves de reserva\nAs chaves de reserva ficam no cofre secreto da garagem." },
];

/** BD falsa: as definições (training.tutorMode) e o resto vazio. */
function dbWith(mode?: string) {
  return createFakeDb((q) => {
    if (q.sql.includes("FROM app_settings") && !q.sql.includes("LIKE")) {
      return [[...(mode ? [{ settingKey: "training.tutorMode", value: JSON.stringify(mode) }] : [])]];
    }
    if (q.sql.startsWith("INSERT")) return [{ insertId: 0, affectedRows: 1 }];
    return [[]];
  });
}

const ctxFor = (role: string, call: (path: string, input?: unknown) => Promise<any> = async () => ({})): StaffToolCtx =>
  ({ user: { id: 7, role }, access: LISBOA, call, today: "2026-10-16", financeAllowed: false, helpDocs: staffHelpDocs() }) as any;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env.GEMINI_API_KEY = "test-key";
  h.db = dbWith();
  h.manuals = MANUALS;
  h.videos = [{ id: 5, title: "Receção do cliente", description: "Como cumprimentar o cliente e confirmar a matrícula na receção." }];
  h.kbDocs = [];
  h.kbCfg = { useInTutor: true, useInAssistant: true };
  h.kbCalls = [];
  h.getTrainingManuals.mockReset().mockImplementation(async (_cat: unknown, _type: unknown, includeUnpublished: boolean) =>
    h.manuals.filter((m) => includeUnpublished || m.published === 1));
  h.loadModule.mockReset().mockResolvedValue({ title: "", manuals: [], createdBy: null, categoryId: null, found: false });
  h.recordQuestion.mockReset().mockResolvedValue(undefined);
  setAiProvidersForTests(null);
  resetAiUsageCachesForTests();
  resetRateLimitMemoryForTests();
  resetContextCacheForTests();
  resetFinalCallModeForTests();
  resetMaskedColumnsForTests(null);
  resetTrainingCatalogForTests();
  invalidateSettingsCache();
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setAiProvidersForTests(null);
});

async function ask(role: string, path: string, opts: { mode?: AssistantMode; tab?: string; entity?: unknown; question?: string } = {}) {
  const p = createFakeProvider("gemini", [okResponse("As chaves entregam-se depois de confirmar a reserva [K1].")]);
  setAiProvidersForTests({ gemini: p });
  const r = await askAssistant(
    { question: opts.question ?? "Quando entrego as chaves ao cliente?", path, tab: opts.tab, entity: opts.entity },
    ctxFor(role), { memoryEnabled: false, mode: opts.mode ?? V1, embedQuery: null },
  );
  return { r, call: p.calls[0], text: p.calls[0] ? sentText(p.calls[0]) : "" };
}

// ─── Definição ───────────────────────────────────────────────────────────────

describe("training.tutorMode (reversível)", () => {
  it("omissão \"multis\" (decisão do Jorge); só \"multis\" ou \"proprio\"", async () => {
    expect(TUTOR_DEFAULT_MODE).toBe("multis");
    expect(SETTINGS["training.tutorMode"].defaultValue).toBe("multis");
    expect(SETTINGS["training.tutorMode"].description).toMatch(/por omissão/);
    for (const v of ["multis", "proprio"]) expect(validateSetting("training.tutorMode", v)).toEqual({ ok: true, value: v });
    expect(validateSetting("training.tutorMode", "talvez").ok).toBe(false);
    expect(await trainingTutorMode()).toBe("multis");
    h.db = dbWith("proprio");
    invalidateSettingsCache();
    expect(await trainingTutorMode()).toBe("proprio");
    h.db = null; // sem BD → a omissão
    invalidateSettingsCache();
    expect(await trainingTutorMode()).toBe("multis");
  });

  it("training.tutor.mode: \"multis\" só com o Multis ligado (senão o tutor próprio, para não ficar sem tutor)", async () => {
    const caller = trainingTutorRouter.createCaller({ user: { id: 7, role: "extra", name: "Ana" }, req: { headers: {} }, res: {} } as any);
    expect(await caller.mode()).toEqual({ setting: "multis", effective: "multis" });
    process.env.AI_ASSISTANT = "off";
    expect(await caller.mode()).toEqual({ setting: "multis", effective: "proprio" });
    delete process.env.AI_ASSISTANT;
    h.db = dbWith("proprio");
    invalidateSettingsCache();
    expect(await caller.mode()).toEqual({ setting: "proprio", effective: "proprio" });
  });
});

// ─── Peças puras ─────────────────────────────────────────────────────────────

describe("peças puras", () => {
  it("o módulo aberto: manual/vídeo/percurso pelo registo; o quiz pelo separador; o resto nada", () => {
    expect(tutorContextFromPage({ type: "training_manual", id: 11 }, "manuals")).toEqual({ type: "manual", id: 11 });
    expect(tutorContextFromPage({ type: "training_video", id: 5 }, null)).toEqual({ type: "video", id: 5 });
    expect(tutorContextFromPage({ type: "training_path", id: 3 }, "mine")).toEqual({ type: "path", id: 3 });
    expect(tutorContextFromPage(null, "quiz")).toEqual({ type: "quiz", id: 0 });
    expect(tutorContextFromPage({ type: "booking", id: 9 }, "mine")).toBeNull();
    expect(tutorContextFromPage({ type: "training_manual", id: 0 }, null)).toBeNull();
    // O widget pode mandar o registo da formação (validado como os outros).
    expect(sanitizeMultisPage({ path: "/formacao", tab: "manuals", entity: { type: "training_manual", id: 11 } })).toEqual({ tab: "manuals", entity: { type: "training_manual", id: 11 } });
    expect(sanitizeMultisPage({ path: "/formacao", entity: { type: "training_manual", id: -1 } }).entity).toBeNull();
  });

  it("as Fontes abrem o manual/vídeo (?manual= / ?video=); lixo → nada", () => {
    expect(trainingDeepLink("?manual=12")).toEqual({ type: "manual", id: 12 });
    expect(trainingDeepLink("video=5")).toEqual({ type: "video", id: 5 });
    for (const s of ["", "?manual=0", "?manual=abc", "?manual=1e3", "?x=1", null]) expect(trainingDeepLink(s as any)).toBeNull();
    expect(trainingHitOf({ manualId: 12, manualTitle: "M", heading: "H", text: "t" }).href).toBe("/formacao?manual=12");
    expect(trainingHitOf({ manualId: -5, manualTitle: "Vídeo: V", heading: "V", text: "t" })).toMatchObject({ kind: "video", id: 5, href: "/formacao?video=5" });
    expect(trainingHitOf({ manualId: 0, manualTitle: "Percurso: P", heading: "P", text: "t" })).toMatchObject({ kind: "outro", id: null, href: null });
  });

  it("o módulo aberto vem primeiro, sem repetir trechos; perguntas rápidas por tipo", () => {
    const a = { manualId: 1, manualTitle: "A", heading: "x", text: "aaa" };
    const b = { manualId: 2, manualTitle: "B", heading: "y", text: "bbb" };
    expect(mergeTrainingHits([a], [b, a], 3)).toEqual([a, b]);
    expect(mergeTrainingHits([a, b], [a], 1)).toEqual([a]);
    for (const t of ["manual", "video", "path", "quiz"] as const) expect(tutorQuickQuestions(t).length).toBeGreaterThanOrEqual(2);
    expect(pagePathOf("/formacao?manual=1")).toBe("/formacao");
  });

  it("perfil de tutor só com o modo \"multis\"; sem ele, o perfil \"formacao\" de sempre", () => {
    expect(multisProfileFor({ page: "formacao", tutor: true })).toBe(MULTIS_TUTOR_PROFILE);
    expect(multisProfileFor({ page: "formacao", tab: "quiz", tutor: true })).toBe(MULTIS_TUTOR_PROFILE);
    expect(multisProfileFor({ page: "formacao" }).key).toBe("formacao");
    expect(multisProfileFor({ page: "avaliacao", tutor: true }).key).toBe("avaliacao");
    expect(MULTIS_TUTOR_PROFILE.tools[0]).toBe("formacao_procurar");
    expect(MULTIS_TUTOR_PROFILE.role).toMatch(/Não dás as respostas dos quizzes nem dos exames/);
    // Sugestões: no piloto as do tutor; no v1 só as que não precisam de ferramentas.
    expect(mpvSuggestions("/formacao", null, ctxFor("extra"), { tutor: true })).toContain("Faz-me uma pergunta para ver se percebi.");
    expect(mpvSuggestions("/formacao", null, ctxFor("extra"))).toContain("Como faço a minha formação obrigatória?");
    expect(profileQuestions(MULTIS_TUTOR_PROFILE, { role: "extra" } as any)).not.toContain("O que me falta para acabar a formação?");
  });
});

// ─── Com "multis": o Multis encontra os manuais da formação ──────────────────

describe("com \"multis\" (omissão): o Multis da Formação encontra os materiais do tutor", () => {
  it("v1: o papel de tutor no <contexto> e o manual da formação no <conhecimento>, com as Fontes", async () => {
    const { r, call, text } = await ask("extra", "/formacao", { tab: "manuals" });
    expect(r.ok).toBe(true);
    // O sistema e as ferramentas do v1 não mudam (só o bloco por pergunta).
    expect(call.system).toBe(staffSystemPrompt());
    expect(JSON.stringify(call.tools?.map((t) => t.name))).toBe(JSON.stringify(availableTools(STAFF_TOOLS, ctxFor("extra")).map((t) => t.name)));
    expect(text).toContain(MULTIS_TUTOR_V1_ROLE);
    expect(text).toMatch(/<conhecimento>\n\[K1\] «Manual do condutor» — secção «Entrega das chaves»:\nAs chaves são entregues/);
    // Os dados pessoais dos manuais não vão para a IA.
    expect(text).not.toContain("chefe@multipark.pt");
    if (r.ok) {
      expect(r.answer).toContain("Fontes:");
      expect(r.answer).toContain("(/formacao?manual=11)");
    }
    // Como o tutor: a pergunta entra no agregado anónimo (página, sem módulo).
    expect(h.recordQuestion).toHaveBeenCalledWith({ type: "formacao", id: 0 }, expect.any(String), "Quando entrego as chaves ao cliente?", false);
  });

  it("visibilidade: um extra só vê os manuais publicados (como no tutor); o admin vê também os não publicados", async () => {
    const extra = await ask("extra", "/formacao", { question: "Onde ficam as chaves de reserva no cofre?" });
    expect(h.getTrainingManuals).toHaveBeenLastCalledWith(undefined, undefined, false);
    expect(extra.text).not.toContain("cofre secreto");
    resetTrainingCatalogForTests();
    const admin = await ask("admin", "/formacao", { question: "Onde ficam as chaves de reserva no cofre?" });
    expect(h.getTrainingManuals).toHaveBeenLastCalledWith(undefined, undefined, true);
    expect(admin.text).toContain("cofre secreto");
  });

  it("visibilidade da base de conhecimento: a mesma do tutor (papel e cidades do pedido)", async () => {
    h.kbDocs = [
      { docId: 1, title: "Procedimento geral", text: "As chaves entregam-se ao cliente na receção.", roles: [], cities: [] },
      { docId: 2, title: "Só administradores", text: "As chaves mestras estão com o administrador.", roles: ["admin"], cities: [] },
      { docId: 3, title: "Só Porto", text: "No Porto as chaves ficam no balcão.", roles: [], cities: ["porto"] },
    ];
    const multis = await formacaoKnowledge("chaves cliente", { role: "extra" }, LISBOA);
    const viaTutor = await cityScope.run(LISBOA, () => tutorKnowledge("chaves cliente", "extra", 3));
    const kbTitles = (multis.knowledge?.citations ?? []).filter((c) => c.docId > 0).map((c) => c.title).sort();
    expect(kbTitles).toEqual(viaTutor.hits.map((x) => x.title).sort());
    expect(kbTitles).toEqual(["Procedimento geral"]);
    // O mesmo leitor (papel + cidades) nos dois.
    expect(h.kbCalls[0].viewer).toEqual(h.kbCalls[1].viewer);
    expect(h.kbCalls[0].excludeSources).toEqual(["help"]);
    // Base desligada para o Multis mas ligada para o tutor → o Multis-tutor continua a usá-la (sem a ajuda pelo significado).
    h.kbCalls = [];
    h.kbCfg = { useInTutor: true, useInAssistant: false };
    await formacaoKnowledge("chaves cliente", { role: "extra" }, LISBOA);
    expect(h.kbCalls).toHaveLength(1);
    expect(h.kbCalls[0].helpTopK).toBe(0);
    h.kbCalls = [];
    h.kbCfg = { useInTutor: false, useInAssistant: false };
    await formacaoKnowledge("chaves cliente", { role: "extra" }, LISBOA);
    expect(h.kbCalls).toHaveLength(0);
  });

  it("o módulo aberto vem primeiro (o mesmo conteúdo que o tutor lia: loadModule, publicados para o extra)", async () => {
    h.loadModule.mockResolvedValue({ title: "Vídeo da receção", manuals: [{ id: 0, title: "Vídeo: Receção do cliente", content: "Confirma sempre a matrícula do cliente antes de entregar." }], createdBy: null, categoryId: 1, found: true });
    const { text } = await ask("extra", "/formacao", { tab: "videos", entity: { type: "training_video", id: 5 }, question: "Como confirmo a matrícula do cliente?" });
    expect(h.loadModule).toHaveBeenCalledWith({ type: "video", id: 5 }, { includeUnpublished: false });
    expect(text).toMatch(/\[K1\] «Vídeo: Receção do cliente»/);
    expect(text).toContain("Registo aberto: training_video #5 (vídeo da formação)");
    const s = await searchTrainingContent("matrícula do cliente", { role: "extra", module: { type: "video", id: 5 } });
    expect(s.hits[0]).toMatchObject({ kind: "video", id: 5, href: "/formacao?video=5" });
  });

  it("nada nos manuais → sem <conhecimento> da formação e a pergunta fica como \"sem resposta\" para os formadores", async () => {
    h.manuals = [];
    h.videos = [];
    await ask("extra", "/formacao", { question: "Qual é a cor do céu em Marte?" });
    expect(h.recordQuestion).toHaveBeenCalledWith({ type: "formacao", id: 0 }, expect.any(String), "Qual é a cor do céu em Marte?", true);
  });

  it("piloto (MPV): perfil de tutor na <pagina_atual> e a formacao_procurar entre as ferramentas", async () => {
    const { call, text } = await ask("extra", "/formacao", { mode: PILOT, tab: "manuals" });
    expect(text).toContain(MULTIS_TUTOR_PROFILE.role);
    expect(text).toMatch(/Ferramentas mais úteis aqui: formacao_procurar, formacao_progresso/);
    expect(text).not.toContain(MULTIS_TUTOR_V1_ROLE);
    expect(text).toContain("Manual do condutor");
    expect(call.tools?.map((t) => t.name)).toContain("formacao_procurar");
    // Sem o modo tutor (puro): o perfil de sempre.
    expect(mpvTurnKnowledge({ path: "/formacao", tab: "manuals", question: "x", ctx: ctxFor("extra") }).profile.key).toBe("formacao");
  });
});

// ─── Com "proprio": como era ─────────────────────────────────────────────────

describe("com \"proprio\": fica tudo como era", () => {
  it("o Multis na Formação não recebe o papel de tutor nem os manuais da formação; nada se regista", async () => {
    h.db = dbWith("proprio");
    invalidateSettingsCache();
    const { text } = await ask("extra", "/formacao", { tab: "manuals" });
    expect(text).not.toContain(MULTIS_TUTOR_V1_ROLE);
    expect(h.getTrainingManuals).not.toHaveBeenCalled();
    expect(h.loadModule).not.toHaveBeenCalled();
    expect(h.recordQuestion).not.toHaveBeenCalled();
    // A base de conhecimento do Multis de sempre (assistantKnowledge: 4 trechos).
    expect(h.kbCalls[0]).toMatchObject({ topK: 4, excludeSources: ["help"] });
    expect(text).toContain(`<contexto>\n${turnContext({ today: "2026-10-16", path: "/formacao", role: "extra", cities: ["Lisboa"], memoryOff: true, tab: "manuals" })}\n</contexto>`);
    // Piloto: o perfil "formacao" de sempre.
    const pilot = await ask("extra", "/formacao", { mode: PILOT });
    expect(pilot.text).toContain(multisProfileFor({ page: "formacao" }).role);
    expect(pilot.text).not.toContain(MULTIS_TUTOR_PROFILE.role);
  });

  it("o tutor próprio no cliente é o código de antes, sem mudanças (hash do corpo); o quiz explicado também", () => {
    const tsx = src("client/src/pages/training/TutorPanel.tsx");
    const body = (start: string) => { const i = tsx.indexOf(start); return tsx.slice(i + start.length, tsx.indexOf("\n}\n", i) + 3); };
    // Calculado na origin/main 925e0500 (corpo do `TutorPanel` de antes do D7).
    expect(sha(body("function OwnTutorPanel("))).toBe("8e9d39952624460aaa124321f2542b5c5b8c1333e38846d19fe25099fe26f68d");
    expect(tsx).toContain('return mode === "multis" ? <MultisTutorPanel {...props} /> : <OwnTutorPanel {...props} />;');
    // Erro a ler o modo → o tutor próprio.
    expect(tsx).toContain('return { mode: q.data?.effective ?? "proprio", loading: false };');
    expect(tsx).toContain("export function QuizTutorReview(");
  });
});

// ─── O v1 nas outras páginas ─────────────────────────────────────────────────

describe("o v1 nas outras páginas fica igual", () => {
  it("noutra página: nem se lê a formação nem entra o papel de tutor (o mesmo pedido de sempre)", async () => {
    for (const path of ["/rh", "/avaliacao", "/formacao/conhecimento"]) {
      h.kbCalls = [];
      const { call, text } = await ask("extra", path);
      expect(call.system).toBe(staffSystemPrompt());
      expect(text).not.toContain(MULTIS_TUTOR_V1_ROLE);
      expect(h.kbCalls[0]).toMatchObject({ topK: 4 });
    }
    expect(h.getTrainingManuals).not.toHaveBeenCalled();
    expect(h.recordQuestion).not.toHaveBeenCalled();
    // As ferramentas do v1 não ganham a formacao_procurar (os hashes da F3 continuam em mpvF3.test.ts).
    expect(STAFF_TOOLS.map((t) => t.name)).not.toContain("formacao_procurar");
    expect(JSON.stringify(toolDeclarations(STAFF_TOOLS))).not.toContain("formacao_procurar");
  });
});

// ─── A ferramenta do piloto ──────────────────────────────────────────────────

describe("formacao_procurar (piloto): só leitura, sem IA, como quem pergunta", () => {
  const run = async (ctx: StaffToolCtx, args: Record<string, unknown>) => {
    const redact = createRedactionContext();
    const exec = makeToolExecutor(MPV_STAFF_TOOLS, ctx, {}, { refuseUnavailable: true, redact });
    return exec({ name: "formacao_procurar", args } as any);
  };

  it("chama training.tutor.search como a pessoa, com o módulo pedido; redige antes de cortar; sem IA", async () => {
    const call = vi.fn(async () => ({
      moduleTitle: "Manual do condutor",
      hits: [{ kind: "manual", id: 11, title: "Manual do condutor", heading: "Entrega das chaves", text: "Liga para 912345678 se o cliente faltar. " + "x".repeat(2000), href: "/formacao?manual=11" }],
      kb: [], failed: false,
    }));
    const r: any = await run(ctxFor("extra", call), { texto: "chaves", tipo: "manual", id: 11 });
    expect(call).toHaveBeenCalledWith("training.tutor.search", { question: "chaves", context: { type: "manual", id: 11 } });
    expect(JSON.stringify(r)).not.toContain("912345678");
    expect(r.trechos[0]).toMatchObject({ fonte: "manual", titulo: "Manual do condutor", secao: "Entrega das chaves", ligacao: "/formacao?manual=11" });
    expect(r.trechos[0].texto.length).toBeLessThanOrEqual(901);
    expect(FORMACAO_SEARCH_TOOL.selfRedacts).toBe(true);
    const code = src("server/assistant/formacaoTool.ts");
    for (const bad of ["_core/ai/run", "runAi", "embedTexts"]) expect(code).not.toContain(bad);
  });

  it("argumentos: texto obrigatório; tipo/id inválidos ignorados; nada encontrado → diz para perguntar ao formador; erro ≠ vazio", async () => {
    expect(() => formacaoSearchInput({})).toThrow();
    expect(formacaoSearchInput({ texto: "chaves", tipo: "quiz", id: 3 })).toEqual({ question: "chaves" });
    expect(formacaoSearchInput({ texto: "chaves", tipo: "percurso", id: 3 })).toEqual({ question: "chaves", context: { type: "path", id: 3 } });
    const empty: any = await run(ctxFor("extra", async () => ({ moduleTitle: null, hits: [], kb: [], failed: false })), { texto: "marte" });
    expect(empty.nota).toMatch(/perguntar ao formador/);
    const down: any = await run(ctxFor("extra", async () => { throw new Error("BD"); }), { texto: "chaves" });
    expect(down.indisponivel).toMatch(/Não consegui consultar/);
  });

  it("training.tutor.search: publicados para o extra, todos para o admin; base de conhecimento sem vetores (sem IA)", async () => {
    const caller = (role: string) => trainingTutorRouter.createCaller({ user: { id: 7, role, name: "X" }, req: { headers: {} }, res: {} } as any);
    const extra = await caller("extra").search({ question: "chaves de reserva cofre" });
    expect(extra.hits.map((x) => x.title)).not.toContain("Rascunho de procedimentos");
    resetTrainingCatalogForTests();
    const admin = await caller("admin").search({ question: "chaves de reserva cofre" });
    expect(admin.hits.map((x) => x.title)).toContain("Rascunho de procedimentos");
    expect(h.kbCalls.every((c) => c.embedQuery === null)).toBe(true);
    await expect(caller("extra").search({ question: "x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ─── Agregado dos formadores ─────────────────────────────────────────────────

describe("agregado anónimo dos formadores", () => {
  it("a pergunta vai sem dados pessoais, no módulo aberto (ou na página)", async () => {
    await recordTutorQuestion("O meu email é ana@x.pt, como entrego as chaves?", { type: "manual", id: 11 }, false);
    const [ctx, key, sample, unanswered] = h.recordQuestion.mock.calls[0];
    expect(ctx).toEqual({ type: "manual", id: 11 });
    expect(sample).not.toContain("ana@x.pt");
    expect(key).not.toContain("ana");
    expect(unanswered).toBe(false);
  });
});
