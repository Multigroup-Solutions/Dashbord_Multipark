/**
 * Plano MPV (Multis por página), fase F3 — só no MPV (o v1 fica igual):
 *  - sistema com o índice da árvore, IGUAL para toda a gente (uma cache por
 *    modelo: o mesmo texto e as mesmas ferramentas declaradas);
 *  - por pergunta: perfil da página + a secção do separador aberto + até 2
 *    secções da pesquisa lexical por secção, teto de 5 000 caracteres;
 *  - `ajuda_abrir` / `ajuda_procurar` em vez do `abrir_ajuda`;
 *  - perfis por página (shared/multisProfiles.ts) e perguntas sugeridas;
 *  - Base de conhecimento: secções com a referência `help:<ficheiro>.md#<secção>`;
 *    as `help:<ficheiro>.md` ficam e o v1 continua a encontrá-las.
 *  - PROVA de que o v1 não muda (texto do sistema e ferramentas congelados).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const h = vi.hoisted(() => ({ db: null as any, logActivity: vi.fn() }));
vi.mock("../db", () => ({
  getDb: async () => h.db,
  logActivity: h.logActivity,
  getUserPermissionOverrides: async () => ({}),
}));
// Um id antigo (renomeado) → o atual: o ajuda_abrir segue-o.
vi.mock("../../shared/helpIdAliases", () => ({
  HELP_ID_ALIASES: { "caixa.md#id-antigo-f3": "caixa.md#confirmacao-da-caixa" },
}));

import { can } from "../../shared/access";
import { estimateTokens, HELP_INDEX_MAX_TOKENS, treePages } from "../../shared/helpTree";
import {
  DEFAULT_MULTIS_PROFILE, MULTIS_PROFILE_RULES, PLANNED_TOOLS, allMultisProfiles, multisProfileFor, profileQuestions,
} from "../../shared/multisProfiles";
import { KB_SOURCES, isHelpSource } from "../../shared/knowledge";
import { setAiProvidersForTests } from "../_core/ai/client";
import { resetContextCacheForTests } from "../_core/ai/contextCache";
import { resetFinalCallModeForTests } from "../_core/ai/run";
import { resetRateLimitMemoryForTests } from "../_core/ai/rateLimit";
import { resetAiUsageCachesForTests } from "../_core/ai/usage";
import { helpIndex } from "../_core/ai/chat/retrieval";
import { availableTools, makeToolExecutor, toolDeclarations } from "../_core/ai/chat/tools";
import { runChatTurn } from "../_core/ai/chat/engine";
import { resetMaskedColumnsForTests } from "../_core/ai/chat/store";
import { assistantMpvSystemPrompt, assistantSystemPrompt } from "../_core/ai/prompts/assistant";
import { createFakeDb, createFakeProvider, okResponse, type FakeQuery } from "../_core/ai/testUtils";
import { invalidateSettingsCache } from "../appSettings";
import type { CityAccess } from "../cityAccess";
import { candidateChunks, retrieveKnowledge } from "../knowledge/retrieve";
import { listDocs } from "../knowledge/store";
import { runKnowledgeSync, syncHelpSections } from "../knowledge/sync";
import { HELP_FILES } from "./helpDocs.generated";
import { HELP_NAV_TOOLS, canSeeHelpPage, excerptSection, searchHelpSections } from "./helpTools";
import { KNOWLEDGE_INDEX, knowledgeTree } from "./knowledgeTree";
import { MPV_HELP_MAX_CHARS, mpvSuggestions, mpvSystemPrompt, mpvTools, mpvTurnBudget, mpvTurnKnowledge } from "./mpv";
import { askAssistant, helpFileOfRef, staffHelpDocs, staffSystemPrompt, turnContext } from "./service";
import { MPV_STAFF_TOOLS, STAFF_TOOLS, staffToolsFor, type StaffToolCtx } from "./tools";

const KEYS = ["GEMINI_API_KEY", "LLM_API_KEY", "OPENAI_API_KEY", "AI_ENABLED", "AI_ASSISTANT", "AI_ASSISTANT_SMART", "MPV", "AI_MODEL_SMART",
  "AI_MONTHLY_BUDGET_EUR", "AI_PROVIDER", "AI_ASSISTANT_MEMORY"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env.GEMINI_API_KEY = "test-key";
  process.env.AI_MODEL_SMART = "gemini-4-argon";
  h.db = null;
  h.logActivity.mockReset();
  setAiProvidersForTests(null);
  resetAiUsageCachesForTests();
  resetRateLimitMemoryForTests();
  resetContextCacheForTests();
  resetFinalCallModeForTests();
  resetMaskedColumnsForTests(null);
  invalidateSettingsCache();
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setAiProvidersForTests(null);
});

const LISBOA: CityAccess = { all: false, defaultCityId: 10, cityName: "Lisboa", cityNames: ["Lisboa"], cityIds: [10], projectIds: [10, 11, 12], missingCostCenter: false };
const ctxFor = (role: string, id = 7, call: (path: string, input?: unknown) => Promise<any> = async () => ({})): StaffToolCtx =>
  ({ user: { id, role }, access: LISBOA, call, today: "2026-10-15", financeAllowed: false, helpDocs: staffHelpDocs() }) as any;
const sentText = (c: { parts?: any[] }) => (c.parts ?? []).map((x: any) => x?.text ?? "").join("\n");
const src = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const NO_HOOKS = { knowledge: null, memoryEnabled: false } as const;
const nav = (name: string) => HELP_NAV_TOOLS.find((t) => t.name === name)!;

/** BD falsa: definições (piloto) e o resto vazio. */
function dbWith(opts: { pilot?: number[] }) {
  return createFakeDb((q) => {
    if (q.sql.includes("FROM app_settings") && !q.sql.includes("LIKE")) {
      return [[...(opts.pilot ? [{ settingKey: "ai.assistantPilot", value: JSON.stringify({ userIds: opts.pilot }) }] : [])]];
    }
    if (q.sql.includes("AS dayEur")) return [[{ dayEur: "0", monthEur: "0" }]];
    if (q.sql.includes("userId = ?") && q.sql.includes("FROM ai_usage_log")) return [[{ spent: "0" }]];
    return [[]];
  });
}
const pilotOn = (ids: number[]) => {
  invalidateSettingsCache();
  h.db = dbWith({ pilot: ids });
  process.env.MPV = "on";
  process.env.AI_ASSISTANT_SMART = "on";
};

// ─── Prova: o v1 não muda ───────────────────────────────────────────────────

describe("v1 fica exatamente igual (princípio 1)", () => {
  // Valores calculados na origin/main f777524a, ANTES da F3.
  const V1_TEMPLATE_SHA = "e54024f40eba05b685e6f9b8826b7f88fc0f657d462f5d9fd1be17f355c8037a";
  const V1_TOOLS_SHA = "96bbbfc2d2a2b137a9efd64373f70a31a2c6df13fded1e082cc289ae458da788";

  it("o texto do sistema do v1 e as ferramentas do v1 são os de antes", () => {
    expect(sha(assistantSystemPrompt("«INDICE»"))).toBe(V1_TEMPLATE_SHA);
    expect(staffSystemPrompt()).toBe(assistantSystemPrompt(helpIndex(staffHelpDocs())));
    expect(sha(JSON.stringify(toolDeclarations(STAFF_TOOLS)))).toBe(V1_TOOLS_SHA);
    expect(STAFF_TOOLS.map((t) => t.name)).toEqual(["abrir_ajuda", "reservas_resumo", "extras_escala", "casos_abertos", "whatsapp_pendentes", "minha_avaliacao", "minhas_tarefas", "financeiro_totais"]);
    expect(staffSystemPrompt()).not.toContain(KNOWLEDGE_INDEX.slice(0, 200));
  });

  it("fora do piloto (MPV desligado, ou ligado mas a pessoa fora da lista): o mesmo pedido de sempre", async () => {
    for (const setup of [() => { invalidateSettingsCache(); h.db = dbWith({ pilot: [7] }); }, () => pilotOn([99])]) {
      setup();
      const p = createFakeProvider("gemini", [okResponse("Passos.")]);
      setAiProvidersForTests({ gemini: p });
      const ctx = ctxFor("extra");
      const r = await askAssistant({ question: "Como pico o ponto?", path: "/rh", tab: "x" }, ctx, NO_HOOKS);
      expect(r).toMatchObject({ ok: true, feature: "assistant" });
      const call = p.calls[0];
      expect(call.system).toBe(staffSystemPrompt());
      expect(call.tools?.map((t) => t.name)).toEqual(availableTools(STAFF_TOOLS, ctx).map((t) => t.name));
      expect(call.tools?.map((t) => t.name)).toContain("abrir_ajuda");
      const text = sentText(call);
      expect(text).toContain("<ajuda ficheiro=");
      expect(text).not.toContain("<pagina_atual>");
      expect(text).not.toContain("Ferramentas que podes usar");
      expect((r as any).helpFiles.every((f: string) => /\.md$/.test(f))).toBe(true);
    }
  });

  it("turnContext sem `tools` não muda (a linha só existe no MPV)", () => {
    const base = { today: "2026-10-15", path: "/extras-dia", role: "supervisor", cities: ["Lisboa"] as string[], tab: "pressao" };
    expect(turnContext(base)).not.toContain("Ferramentas");
    expect(turnContext({ ...base, tools: ["ajuda_abrir", "extras_escala"] })).toContain("Ferramentas que podes usar: ajuda_abrir, extras_escala.");
  });
});

// ─── Sistema do MPV ─────────────────────────────────────────────────────────

describe("sistema do MPV (bloco estável)", () => {
  it("leva o índice da árvore (≤ 6 000 tokens), não o dos 48 ficheiros; nada da pessoa nem da página", () => {
    const s = mpvSystemPrompt();
    expect(s).toBe(assistantMpvSystemPrompt(KNOWLEDGE_INDEX));
    expect(s).toContain(KNOWLEDGE_INDEX);
    expect(s).not.toContain(helpIndex(staffHelpDocs()));
    expect(estimateTokens(KNOWLEDGE_INDEX)).toBeLessThanOrEqual(HELP_INDEX_MAX_TOKENS);
    // As regras à volta do índice são curtas (o índice é o grosso).
    expect(estimateTokens(s) - estimateTokens(KNOWLEDGE_INDEX)).toBeLessThan(1600);
    expect(s).toContain("ajuda_abrir");
    expect(s).toContain("ajuda_procurar");
    expect(s).not.toContain("abrir_ajuda");
    // Os perfis vão por pergunta, nunca no sistema.
    for (const p of allMultisProfiles()) expect(s).not.toContain(p.role);
  });

  it("o MESMO sistema e as MESMAS ferramentas declaradas para dois papéis diferentes (1 cache por modelo)", async () => {
    pilotOn([7, 8]);
    const p = createFakeProvider("gemini", [okResponse("ok", "gemini-4-argon")]);
    setAiProvidersForTests({ gemini: p });
    const extra = ctxFor("extra", 7);
    const admin = { ...ctxFor("admin", 8), financeAllowed: true } as StaffToolCtx;
    await askAssistant({ question: "Como pico o ponto?", path: "/rh" }, extra, NO_HOOKS);
    await askAssistant({ question: "Qual o valor das reservas?", path: "/faturacao" }, admin, NO_HOOKS);
    const [a, b] = p.calls;
    expect(a.model).toBe("gemini-4-argon");
    expect(a.system).toBe(mpvSystemPrompt());
    expect(b.system).toBe(a.system);
    expect(JSON.stringify(b.tools)).toBe(JSON.stringify(a.tools));
    expect(a.tools?.map((t) => t.name)).toEqual(mpvTools().map((t) => t.name));
    // O que muda é o <contexto> (as ferramentas que cada um pode usar).
    expect(sentText(a)).toMatch(/Ferramentas que podes usar: [^\n]*ajuda_abrir/);
    expect(sentText(a)).not.toMatch(/Ferramentas que podes usar: [^\n]*financeiro_totais/);
    expect(sentText(b)).toMatch(/Ferramentas que podes usar: [^\n]*financeiro_totais/);
    const usage = h.db.queries.filter((q: FakeQuery) => q.sql.includes("INSERT INTO ai_usage_log"));
    expect(usage.at(-1)!.params).toEqual(expect.arrayContaining(["mpv"]));
  });

  it("variante do turno: \"mpv\" no piloto (também em modo económico), \"v1\" fora — em ai_usage_log e ai_chat_messages", async () => {
    let next = 100;
    // As respostas do dbWith, mas os INSERT devolvem um id (para a conversa e a mensagem ficarem guardadas).
    const respond = (q: FakeQuery) => {
      if (q.sql.startsWith("INSERT INTO ai_rate_limits")) return [{ insertId: 1, affectedRows: 1 }]; // o contador da janela
      if (q.sql.startsWith("INSERT")) return [{ insertId: ++next, affectedRows: 1 }];
      if (q.sql.includes("FROM app_settings") && !q.sql.includes("LIKE")) return [[{ settingKey: "ai.assistantPilot", value: JSON.stringify({ userIds: [7] }) }]];
      if (q.sql.includes("AS dayEur")) return [[{ dayEur: "0", monthEur: "0" }]];
      if (q.sql.includes("userId = ?") && q.sql.includes("FROM ai_usage_log")) return [[{ spent: "0" }]];
      return [[]];
    };
    const variantsFor = async (userId: number, smart: boolean) => {
      invalidateSettingsCache();
      resetAiUsageCachesForTests();
      h.db = createFakeDb(respond);
      process.env.MPV = "on";
      if (smart) process.env.AI_ASSISTANT_SMART = "on"; else delete process.env.AI_ASSISTANT_SMART;
      setAiProvidersForTests({ gemini: createFakeProvider("gemini", [okResponse("ok", smart ? "gemini-4-argon" : "gemini-3.1-flash-lite")]) });
      const r = await askAssistant({ question: "Olá?" }, ctxFor("supervisor", userId), NO_HOOKS);
      expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
      const usage = h.db.queries.filter((q: FakeQuery) => q.sql.startsWith("INSERT INTO ai_usage_log")).at(-1)!;
      const msg = h.db.queries.filter((q: FakeQuery) => q.sql.startsWith("INSERT INTO ai_chat_messages") && q.sql.includes("'assistant'")).at(-1)!;
      return { usage: usage.params, msg: msg.params };
    };
    const pilot = await variantsFor(7, true);
    expect(pilot.usage).toEqual(expect.arrayContaining(["assistant_smart", "mpv"]));
    expect(pilot.msg).toEqual(expect.arrayContaining(["mpv", "smart"]));
    // No piloto mas com o smart desligado → o lite responde, com o conteúdo do MPV ("MPV-lite").
    const lite = await variantsFor(7, false);
    expect(lite.usage).toEqual(expect.arrayContaining(["assistant", "mpv"]));
    expect(lite.msg).toEqual(expect.arrayContaining(["mpv", "lite"]));
    const out = await variantsFor(8, true);
    expect(out.usage).toEqual(expect.arrayContaining(["assistant", "v1"]));
    expect(out.msg).toEqual(expect.arrayContaining(["v1", "lite"]));
    expect(out.usage).not.toContain("mpv");
  });

  it("uma ferramenta declarada que a pessoa não pode usar → \"indisponível\", sem a correr", async () => {
    const call = vi.fn(async () => ({ receitaPeriodo: 1 }));
    const exec = makeToolExecutor(mpvTools(), ctxFor("extra", 7, call));
    expect(await exec({ name: "financeiro_totais", args: {} } as any)).toEqual({ error: "Ferramenta indisponível para esta pessoa." });
    expect(call).not.toHaveBeenCalled();
  });

  it("ferramentas do MPV: ajuda_abrir + ajuda_procurar no lugar do abrir_ajuda (o v1 mantém o abrir_ajuda)", () => {
    const names = mpvTools().map((t) => t.name);
    expect(names.slice(0, 2)).toEqual(["ajuda_abrir", "ajuda_procurar"]);
    expect(names).not.toContain("abrir_ajuda");
    expect(STAFF_TOOLS.map((t) => t.name)).toContain("abrir_ajuda");
    expect(names.slice(2)).toEqual([...STAFF_TOOLS.map((t) => t.name).filter((n) => n !== "abrir_ajuda"), "regras_em_vigor"]);
    // Registadas no MESMO sítio que a F2 (tools.ts → MPV_STAFF_TOOLS / staffToolsFor).
    expect(mpvTools()).toBe(MPV_STAFF_TOOLS);
    expect(staffToolsFor({ pilot: true })).toBe(MPV_STAFF_TOOLS);
    expect(staffToolsFor({ pilot: false })).toBe(STAFF_TOOLS);
  });
});

// ─── Orçamentos por versão (§3.6) ───────────────────────────────────────────

describe("orçamentos do turno por versão (§3.6)", () => {
  /** O modelo pede sempre mais uma ferramenta; sem ferramentas (chamada final), responde. */
  const greedy = (model: string, onCall?: (req: any) => void) => createFakeProvider("gemini", [async (req: any) => {
    onCall?.(req);
    if (req.tools?.length) return { ...okResponse("", model), toolCalls: [{ name: "ajuda_procurar", args: { texto: "caixa" } }], raw: { parts: [] } };
    return okResponse("Resposta final.", model);
  }]);
  const run = async (userId: number, smart: boolean, model: string, onCall?: (req: any) => void) => {
    pilotOn([7]);
    if (!smart) delete process.env.AI_ASSISTANT_SMART;
    const p = greedy(model, onCall);
    setAiProvidersForTests({ gemini: p });
    const r = await askAssistant({ question: "Como fecho a caixa?", path: "/caixa" }, ctxFor("supervisor", userId), NO_HOOKS);
    const withTools = p.calls.filter((c) => c.tools?.length).length;
    const final = p.calls.at(-1)!;
    // Voltas executadas = as que a chamada final leva no histórico (a que pede uma a mais já não corre).
    return { r, withTools, rounds: (final.toolRounds ?? []).length, final, first: p.calls[0] };
  };

  it("valores: 35 s com 8 s para a chamada final; Argon 4 voltas, lite (e económico) 3", () => {
    expect(mpvTurnBudget("assistant_smart")).toEqual({ timeoutMs: 35_000, finalReserveMs: 8_000, maxToolRounds: 4 });
    expect(mpvTurnBudget("assistant")).toEqual({ timeoutMs: 35_000, finalReserveMs: 8_000, maxToolRounds: 3 });
  });

  it("MPV-Argon: até 4 voltas com ferramentas e depois a chamada final sem ferramentas; as voltas param aos 27 s", async () => {
    const a = await run(7, true, "gemini-4-argon");
    expect(a.r).toMatchObject({ ok: true, answer: "Resposta final.", feature: "assistant_smart" });
    expect(a.rounds).toBe(4); // 4 voltas executadas; o pedido de uma 5.ª leva à chamada final
    expect(a.withTools).toBe(5);
    expect(a.final.tools).toBeUndefined();
    expect(a.first.timeoutMs).toBeLessThanOrEqual(27_000);
    expect(a.first.timeoutMs).toBeGreaterThan(26_000);
  });

  it("MPV-lite (piloto com o smart desligado): até 3 voltas, a mesma regra do prazo", async () => {
    const l = await run(7, false, "gemini-3.1-flash-lite");
    expect(l.r).toMatchObject({ ok: true, answer: "Resposta final.", feature: "assistant" });
    expect(l.rounds).toBe(3);
    expect(l.withTools).toBe(4);
    expect(l.first.timeoutMs).toBeLessThanOrEqual(27_000);
    expect(l.first.timeoutMs).toBeGreaterThan(26_000);
  });

  it("v1 sem alterações: 3 voltas e o prazo de sempre (40 s − 8 s de reserva)", async () => {
    const v = await run(99, true, "gemini-3.1-flash-lite");
    expect(v.r).toMatchObject({ ok: true, feature: "assistant" });
    expect(v.rounds).toBe(3);
    expect(v.withTools).toBe(4);
    expect(v.first.timeoutMs).toBeGreaterThan(31_000);
    expect(v.first.timeoutMs).toBeLessThanOrEqual(32_000);
    expect(v.first.tools?.map((t: any) => t.name)).toContain("abrir_ajuda");
  });

  it("voltas lentas (9 s cada): param aos 27 s e a chamada final ainda cabe nos 8 s guardados — e responde", async () => {
    let now = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const s = await run(7, true, "gemini-4-argon", (req) => { now += req.tools?.length ? 9_000 : 1_000; });
      expect(s.r).toMatchObject({ ok: true, answer: "Resposta final.", feature: "assistant_smart" });
      expect(s.rounds).toBe(3); // a 4.ª volta já não cabia antes dos 27 s
      expect(s.withTools).toBe(3);
      expect(s.final.tools).toBeUndefined();
      expect(s.final.timeoutMs).toBe(8_000);
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── Por pergunta ───────────────────────────────────────────────────────────

describe("bloco por pergunta (perfil + secções)", () => {
  const ajudaPart = (block: string) => block.slice(block.indexOf("</pagina_atual>") + "</pagina_atual>".length).trim();

  it("leva SEMPRE a secção do separador aberto, mais até 2 da pesquisa, no máx. 5 000 car.", () => {
    const r = mpvTurnKnowledge({ path: "/extras-dia", tab: "pressao", question: "O que é o p75 no Porto?", ctx: ctxFor("supervisor") });
    expect(r.refs[0]).toBe("extras-dia.md#separador-pressao-quando-e-que-aperta");
    expect(r.refs.length).toBeGreaterThanOrEqual(1);
    expect(r.refs.length).toBeLessThanOrEqual(3);
    expect(new Set(r.refs).size).toBe(r.refs.length);
    expect(ajudaPart(r.block).length).toBeLessThanOrEqual(MPV_HELP_MAX_CHARS);
    expect(r.block).toContain('<ajuda id="extras-dia.md#separador-pressao-quando-e-que-aperta"');
    // O perfil do separador vai no bloco da pergunta.
    expect(r.block).toContain(multisProfileFor({ page: "extras-dia", tab: "pressao" }).role);
    expect(r.block).toContain("· separador: pressao");
  });

  it("sem separador: a introdução da página; uma pergunta de outra página traz as secções certas", () => {
    const r = mpvTurnKnowledge({ path: "/despesas", question: "Como registo uma nota de crédito?", ctx: ctxFor("supervisor") });
    expect(r.refs[0]).toBe("despesas.md#inicio");
    expect(r.refs).toContain("despesas.md#notas-de-credito");
  });

  it("secções grandes (o agendador) vão recortadas na parte da pergunta, dentro do teto", () => {
    const big = knowledgeTree().groups.flatMap((g) => g.pages).flatMap((p) => p.sections).find((s) => s.id === "agendador.md#o-que-corre-e-quando-hora-de-lisboa")!;
    expect(big.text.length).toBeGreaterThan(MPV_HELP_MAX_CHARS);
    const r = mpvTurnKnowledge({ path: "/definicoes", question: "De quanto em quanto tempo corre o cash-confirm-recheck no agendador?", ctx: ctxFor("admin") });
    expect(r.refs).toContain("agendador.md#o-que-corre-e-quando-hora-de-lisboa");
    expect(ajudaPart(r.block).length).toBeLessThanOrEqual(MPV_HELP_MAX_CHARS);
    expect(r.block).toContain("cash-confirm-recheck");
    expect(r.block).toContain("[…]");
    // A tabela é partida em linhas (antes, uma tabela inteira era um só parágrafo).
    const cut = excerptSection(big.text, 1500, "cash-confirm-recheck");
    expect(cut.length).toBeLessThanOrEqual(1500);
    expect(cut).toContain("cash-confirm-recheck");
  });

  it("a página de um módulo sem acesso não entra (nem a do separador, nem pela pesquisa)", () => {
    expect(can({ role: "extra" } as any, "faturacao", "view")).toBe(false);
    const r = mpvTurnKnowledge({ path: "/faturacao", question: "O que é o fecho previsto da faturação?", ctx: ctxFor("extra") });
    expect(r.refs.some((id) => id.startsWith("faturacao.md"))).toBe(false);
    const adm = mpvTurnKnowledge({ path: "/faturacao", question: "O que é o fecho previsto da faturação?", ctx: ctxFor("super_admin") });
    expect(adm.refs.some((id) => id.startsWith("faturacao.md"))).toBe(true);
  });

  it("ferramentas preferidas: só as que existem E a pessoa pode usar (as planeadas não aparecem)", () => {
    const r = mpvTurnKnowledge({ path: "/extras-dia", tab: "dia", question: "Quantos extras amanhã?", ctx: ctxFor("supervisor") });
    const line = /Ferramentas mais úteis aqui: ([^\n]*)\./.exec(r.block)?.[1] ?? "";
    const allowed = new Set(availableTools(mpvTools(), ctxFor("supervisor")).map((t) => t.name));
    expect(line.split(", ")).toEqual(multisProfileFor({ page: "extras-dia" }).tools.filter((t) => allowed.has(t)));
    expect(line.split(", ")).toContain("extras_escala");
    for (const planned of PLANNED_TOOLS) expect(r.block).not.toContain(planned);
  });

  it("no turno: o bloco vai na MESMA redação que a pergunta (marcadores repostos no fim) e os ids ficam como ajuda usada", async () => {
    const p = createFakeProvider("gemini", [(req) => Promise.resolve(okResponse(/\[EMAIL_\d\]/.exec(sentText(req))?.[0] ?? "sem marcador"))]);
    setAiProvidersForTests({ gemini: p });
    const r = await runChatTurn({
      feature: "assistant", channel: "staff", ownerKey: "user:7", userId: 7, system: "S", rateKey: "assistant:user:7",
      limits: { perMinute: 20, perDay: 100, maxInputChars: 500 }, question: "Quem trato?", helpDocs: staffHelpDocs(),
      pageKnowledge: { block: "<pagina_atual>\nfala com ana@exemplo.pt\n</pagina_atual>", refs: ["caixa.md#inicio"] },
    });
    expect(sentText(p.calls[0])).not.toContain("ana@exemplo.pt");
    expect(sentText(p.calls[0])).not.toContain("<ajuda ficheiro=");
    expect(r).toMatchObject({ ok: true, answer: "ana@exemplo.pt", helpFiles: ["caixa.md#inicio"] });
  });
});

// ─── ajuda_abrir / ajuda_procurar ───────────────────────────────────────────

describe("ajuda_abrir e ajuda_procurar", () => {
  it("página → a lista das secções com os ids; secção → o texto; contentor → os filhos", async () => {
    const ctx = ctxFor("super_admin");
    const page = await nav("ajuda_abrir").run({ id: "caixa" }, ctx);
    expect(page).toMatchObject({ id: "caixa", tipo: "pagina", pagina: "caixa" });
    expect(page.texto).toContain("caixa.md#confirmacao-da-caixa");
    const sec = await nav("ajuda_abrir").run({ id: "caixa.md#confirmacao-da-caixa" }, ctx);
    expect(sec).toMatchObject({ id: "caixa.md#confirmacao-da-caixa", tipo: "secao" });
    expect(sec.texto).toContain("Caixa → Confirmação");
    const box = await nav("ajuda_abrir").run({ id: "caixa.md#separadores" }, ctx);
    expect(box).toMatchObject({ tipo: "secoes" });
    expect(box.texto).toContain("caixa.md#resumo");
    // Também pelo ficheiro.
    expect(await nav("ajuda_abrir").run({ id: "caixa.md" }, ctx)).toMatchObject({ id: "caixa", tipo: "pagina" });
  });

  it("segue os ids antigos (aliases) e diz qual foi pedido", async () => {
    const r = await nav("ajuda_abrir").run({ id: "caixa.md#id-antigo-f3" }, ctxFor("super_admin"));
    expect(r).toMatchObject({ id: "caixa.md#confirmacao-da-caixa", pedido: "caixa.md#id-antigo-f3", tipo: "secao" });
  });

  it("id desconhecido → erro com as parecidas; página sem acesso → erro (o texto não sai)", async () => {
    const r = await nav("ajuda_abrir").run({ id: "extras-dia.md#pressao-inventada" }, ctxFor("supervisor"));
    expect(r.error).toBe("Não há ajuda com esse id.");
    expect(Array.isArray(r.parecidas)).toBe(true);
    const hidden = await nav("ajuda_abrir").run({ id: "faturacao" }, ctxFor("extra"));
    expect(hidden.error).toMatch(/Sem acesso/);
    expect(hidden.texto).toBeUndefined();
    await expect(nav("ajuda_abrir").run({}, ctxFor("extra"))).rejects.toThrow(/Indica o id/);
  });

  it("ajuda_procurar devolve ids + título + página + resumo, sem as páginas sem acesso", async () => {
    const r = await nav("ajuda_procurar").run({ texto: "nota de crédito" }, ctxFor("supervisor"));
    expect(r.resultados[0]).toMatchObject({ id: "despesas.md#notas-de-credito", pagina: "despesas" });
    expect(Object.keys(r.resultados[0]).sort()).toEqual(["id", "pagina", "resumo", "titulo"]);
    const extra = await nav("ajuda_procurar").run({ texto: "fecho previsto faturação" }, ctxFor("extra"));
    expect(extra.resultados.every((x: any) => x.pagina !== "faturacao")).toBe(true);
    const adm = await nav("ajuda_procurar").run({ texto: "fecho previsto faturação" }, ctxFor("super_admin"));
    expect(adm.resultados.some((x: any) => x.pagina === "faturacao")).toBe(true);
    expect((await nav("ajuda_procurar").run({ texto: "zzzz qqqq" }, ctxFor("extra"))).resultados).toEqual([]);
  });

  it("visibilidade: módulo do mapa de acessos → precisa de o ver; os outros e a entrada → toda a gente", () => {
    const pages = treePages(knowledgeTree());
    const byId = (id: string) => pages.find((p) => p.id === id)!;
    const extra = { id: 1, role: "extra" };
    expect(canSeeHelpPage(extra, byId("dashboards.entrada"))).toBe(true);
    expect(canSeeHelpPage(extra, byId("multis"))).toBe(true); // "multis" não é um módulo do mapa
    expect(canSeeHelpPage(extra, byId("faturacao"))).toBe(false);
    expect(canSeeHelpPage({ id: 1, role: "super_admin" }, byId("faturacao"))).toBe(true);
  });

  it("nenhuma chama IA nem a BD: só leem a árvore no bundle; o texto passa pela redação do turno", async () => {
    const call = vi.fn();
    await nav("ajuda_procurar").run({ texto: "caixa" }, ctxFor("admin", 7, call));
    await nav("ajuda_abrir").run({ id: "caixa" }, ctxFor("admin", 7, call));
    expect(call).not.toHaveBeenCalled();
    expect(nav("ajuda_abrir").pii?.text).toContain("texto");
    expect(nav("ajuda_procurar").pii?.text).toContain("resumo");
    expect(src("server/assistant/helpTools.ts")).not.toMatch(/runAi|selectProvider|getDb/);
  });

  it("pesquisa por secção: o título da secção pesa mais do que o da página", () => {
    const hits = searchHelpSections(knowledgeTree(), "nota de crédito");
    expect(hits[0].section.id).toBe("despesas.md#notas-de-credito");
    expect(searchHelpSections(knowledgeTree(), "")).toEqual([]);
  });
});

// ─── Perfis por página ──────────────────────────────────────────────────────

describe("perfis por página (shared/multisProfiles.ts)", () => {
  const sentences = (s: string) => s.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÂÊÔÃÕÀÇ"])/).filter(Boolean).length;
  const existing = new Set([...STAFF_TOOLS, ...MPV_STAFF_TOOLS].map((t) => t.name));

  it("cada perfil: papel de 2–4 frases, 3–4 perguntas (o por omissão usa as do v1), ferramentas que existem OU planeadas (F4)", () => {
    for (const p of allMultisProfiles()) {
      const n = sentences(p.role);
      expect(n, p.key).toBeGreaterThanOrEqual(p === DEFAULT_MULTIS_PROFILE ? 1 : 2);
      expect(n, p.key).toBeLessThanOrEqual(4);
      if (p !== DEFAULT_MULTIS_PROFILE) {
        expect(p.questions.length, p.key).toBeGreaterThanOrEqual(3);
        expect(p.questions.length, p.key).toBeLessThanOrEqual(4);
      }
      expect(p.tools.length, p.key).toBeGreaterThan(0);
      for (const t of p.tools) expect(existing.has(t) || PLANNED_TOOLS.includes(t), `${p.key}: ${t}`).toBe(true);
    }
    // Uma planeada que já exista tem de sair da lista (não fica lixo).
    for (const t of PLANNED_TOOLS) expect(existing.has(t), t).toBe(false);
  });

  it("as páginas e os separadores dos perfis existem na árvore", () => {
    const pages = treePages(knowledgeTree());
    for (const r of MULTIS_PROFILE_RULES) {
      for (const id of r.pages ?? []) {
        const page = pages.find((p) => p.id === id);
        expect(page, id).toBeDefined();
        if (r.tab) expect(page!.tabs.map((t) => t.tab), `${id}/${r.tab}`).toContain(r.tab);
      }
      if (r.group) expect(pages.some((p) => p.group === r.group)).toBe(true);
    }
  });

  it("os do plano §3.5: Despesas sem aconselhamento fiscal; Operacional/Extras/Passagem \"propõe, não decide\"; Formação tutor", () => {
    expect(multisProfileFor({ page: "despesas" }).role).toMatch(/Não dás aconselhamento fiscal[^.]*contabilista/);
    expect(multisProfileFor({ page: "faturacao" }).role).toMatch(/sem dar aconselhamento fiscal/);
    for (const page of ["operacional", "extras-dia", "passagem-turno"]) expect(multisProfileFor({ page }).role, page).toContain("Propões, não decides");
    expect(multisProfileFor({ page: "formacao" }).role).toMatch(/tutor/);
    expect(multisProfileFor({ page: "extras-dia", tab: "pressao" }).key).toBe("extras-dia.pressao");
    expect(multisProfileFor({ page: "extras-dia", tab: "dia" }).key).toBe("extras-dia");
    expect(multisProfileFor({ page: "dashboards", group: "Dashboards" }).key).toBe("dashboards");
    expect(multisProfileFor({ page: "tarefas", group: "Operações" })).toBe(DEFAULT_MULTIS_PROFILE);
    expect(multisProfileFor({})).toBe(DEFAULT_MULTIS_PROFILE);
  });

  it("perguntas sugeridas: do perfil da página/separador, filtradas pelo módulo; sem perfil próprio → as do v1", () => {
    const sup = { id: 1, role: "supervisor" };
    expect(mpvSuggestions("/extras-dia", "pressao", sup)).toEqual(profileQuestions(multisProfileFor({ page: "extras-dia", tab: "pressao" }), sup));
    expect(mpvSuggestions("/extras-dia", "pressao", sup)?.[0]).toMatch(/p75/);
    expect(mpvSuggestions("/tarefas", null, sup)).toBeNull();
    const noOps = profileQuestions(multisProfileFor({ page: "operacional" }), { id: 1, role: "extra" } as any);
    for (const s of multisProfileFor({ page: "operacional" }).questions) {
      if (s.module && !can({ role: "extra" } as any, s.module, "view")) expect(noOps).not.toContain(s.text);
    }
  });

  it("assistant.status: só no piloto as perguntas vêm do perfil (com o separador validado); o widget mostra-as como sempre", () => {
    const r = src("server/assistant/router.ts");
    expect(r).toContain("const mpvAsks = mode.pilot ? mpvSuggestions(input?.path, sanitizeMultisPage(input ?? {}).tab, viewer) : null;");
    expect(r).toContain("const suggestions = mpvAsks ?? assistantSuggestions(input?.path, viewer);");
    expect(src("client/src/components/assistant/AssistantWidget.tsx")).toContain("const suggestions = status.data?.suggestions ?? [];");
  });
});

// ─── Base de conhecimento ───────────────────────────────────────────────────

describe("Base de conhecimento: secções com help:<ficheiro>.md#<secção>", () => {
  const dialect = new MySqlDialect();

  it("sincroniza cada secção com texto (fonte help_sec); as iguais não voltam a partir; as que saíram ficam marcadas (nunca apagadas)", async () => {
    const tree = knowledgeTree();
    const withText = treePages(tree).flatMap((p) => p.sections).filter((s) => s.text.trim());
    let nextId = 1000;
    const d = createFakeDb((q) => {
      if (q.sql.startsWith("INSERT INTO kb_documents")) return [{ insertId: nextId++ }];
      if (q.sql.includes("FROM kb_documents WHERE source = 'help_sec'")) {
        return [[{ id: 1, driveFileId: "help:caixa.md#secao-que-saiu", checksum: "x", deletedAt: null }]];
      }
      return [[]];
    });
    const r = await syncHelpSections(d as any, HELP_FILES);
    expect(r).toMatchObject({ updated: withText.length, retired: 1, done: true });
    const inserts = d.queries.filter((q) => q.sql.startsWith("INSERT INTO kb_documents"));
    expect(inserts).toHaveLength(withText.length);
    expect(inserts[0].params).toEqual(expect.arrayContaining(["help_sec", `help:${withText[0].id}`]));
    expect(inserts.every((q) => (q.params as unknown[]).some((x) => typeof x === "string" && /^help:[a-z0-9-]+\.md#[a-z0-9-]+$/.test(x)))).toBe(true);
    const retire = d.queries.find((q) => q.sql.startsWith("UPDATE kb_documents SET deletedAt"))!;
    expect(retire.params).toEqual(expect.arrayContaining([1]));
    expect(d.queries.some((q) => /^DELETE FROM kb_documents/.test(q.sql))).toBe(false);
  });

  it("checksum igual → nada a fazer", async () => {
    const page = treePages(knowledgeTree()).find((p) => p.id === "caixa")!;
    const s = page.sections.find((x) => x.text.trim())!;
    const { textChecksum } = await import("../knowledge/chunker");
    const title = s.level === 1 ? page.title : `${page.title} → ${s.title}`;
    const sum = textChecksum(`${title}\n\n${s.text}`);
    const d = createFakeDb((q) => (q.sql.includes("FROM kb_documents WHERE source = 'help_sec'")
      ? [[{ id: 5, driveFileId: `help:${s.id}`, checksum: sum, deletedAt: null }]] : q.sql.startsWith("INSERT") ? [{ insertId: 9 }] : [[]]));
    await syncHelpSections(d as any, HELP_FILES.filter((f) => f.file === "caixa.md"));
    expect(d.queries.some((q) => q.sql.startsWith("UPDATE kb_chunks") || (q.sql.includes("kb_documents SET textContent") && q.params.includes(5)))).toBe(false);
  });

  it("as help:<ficheiro>.md de sempre ficam: o v1 continua a encontrá-las e ignora as das secções", async () => {
    expect(helpFileOfRef("help:caixa.md")).toBe("caixa.md");
    expect(helpFileOfRef("help:caixa.md#confirmacao-da-caixa")).toBeNull();
    const seen: string[] = [];
    const row = (o: Record<string, unknown>) => ({ id: 1, docId: 10, section: null, text: "", embedding: null, title: "", webViewLink: null, source: "drive", visibilityRoles: "[]", visibilityCities: "[]", driveFileId: null, ft: 1, ...o });
    const d = {
      execute: async (q: any) => {
        const c = dialect.sqlToQuery(q);
        seen.push(c.sql);
        if (c.sql.includes("d.source IN")) return [[row({ id: 2, docId: 20, title: "Ajuda: Caixa", text: "Fecho da caixa: conta o dinheiro e valida.", source: "help", driveFileId: "help:caixa.md" })]];
        return [[row({ id: 1, docId: 10, title: "Manual do cofre", text: "Fecho da caixa no cofre." })]];
      },
    };
    const r = await retrieveKnowledge({ question: "fecho da caixa", viewer: { role: "admin", allCities: true, cityNames: [] }, d: d as any, embedQuery: null, excludeSources: ["help"], helpTopK: 6 });
    expect(r.helpHits?.map((x) => helpFileOfRef(x.ref))).toEqual(["caixa.md"]);
    // As secções ficam fora de TODAS as consultas que não as pedem.
    expect(seen.filter((s) => s.includes("FROM kb_chunks")).every((s) => s.includes("d.source <> 'help_sec'"))).toBe(true);
    const only: string[] = [];
    await candidateChunks({ execute: async (q: any) => { only.push(dialect.sqlToQuery(q).sql); return [[]]; } } as any, "fecho caixa", { role: "admin", allCities: true, cityNames: [] }, { onlySources: ["help_sec"] });
    expect(only[0]).not.toContain("d.source <> 'help_sec'");
  });

  it("fora da lista da página, das contagens e da pesquisa global (salvo filtrando por elas); o interruptor MPV decide se sincroniza", async () => {
    const d = createFakeDb(() => [[]]);
    await listDocs(d as any, {});
    expect(d.queries[0].sql).toContain("d.source <> 'help_sec'");
    await listDocs(d as any, { source: "help_sec" });
    expect(d.queries[1].sql).not.toContain("<> 'help_sec'");
    expect(src("server/knowledge/store.ts")).toContain("WHERE deletedAt IS NULL AND source <> 'help_sec' GROUP BY status");
    expect(src("server/globalSearch.ts")).toContain("AND d.source <> 'help' AND d.source <> 'help_sec' AND");
    expect(KB_SOURCES).toContain("help_sec");
    expect(isHelpSource("help_sec") && isHelpSource("help") && !isHelpSource("drive")).toBe(true);
    // Sem o interruptor (omissão): nenhuma consulta às secções.
    const off = createFakeDb(() => [[]]);
    await runKnowledgeSync({ deadlineAt: Date.now() + 60_000, d: off as any, drive: null, embed: null, helpFiles: HELP_FILES.slice(0, 1), helpSections: false });
    expect(off.queries.some((q) => q.sql.includes("'help_sec'") && q.sql.startsWith("SELECT id, driveFileId"))).toBe(false);
    const on = createFakeDb((q) => (q.sql.startsWith("INSERT") ? [{ insertId: 1 }] : [[]]));
    const rep = await runKnowledgeSync({ deadlineAt: Date.now() + 60_000, d: on as any, drive: null, embed: null, helpFiles: HELP_FILES.filter((f) => f.file === "caixa.md"), helpSections: true });
    expect(rep.help.sections).toBeGreaterThan(0);
  });
});
