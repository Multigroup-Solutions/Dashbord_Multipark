/**
 * Plano MPV (Multis por página), fase F0a:
 *  - function calling robusto: todas as chamadas de uma volta recebem
 *    resposta; chamada final sem cache e sem ferramentas no máximo de voltas
 *    e no fim do prazo; resumo em texto quando o fornecedor recusa o
 *    histórico; texto de recurso em vez de erro;
 *  - raciocínio por funcionalidade (`ai.thinkingLevels`) e `maxTokensFor`;
 *  - registo "blocked/eu_only" do portão do RH e colunas novas do registo;
 *  - uso por dia e leituras repetidas (só leitura);
 *  - migração 0690.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const h = vi.hoisted(() => ({ gen: vi.fn(), db: null as any }));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: (...a: any[]) => h.gen(...a) };
    caches = { create: vi.fn(async () => ({ name: "cachedContents/abc", expireTime: new Date(Date.now() + 3_600_000).toISOString() })) };
  },
}));
vi.mock("../../db", () => ({ getDb: async () => h.db }));

import { validateSetting } from "../../../shared/appSettings";
import { detectUnanswered } from "../../../shared/assistantFeedback";
import { invalidateSettingsCache } from "../../appSettings";
import { setAiProvidersForTests, thinkingLevelFor, toGeminiContents, type ProviderRequest, type ProviderResponse } from "./client";
import { resetContextCacheForTests } from "./contextCache";
import { AiEuOnlyError } from "./errors";
import { resolveThinkingLevel } from "./features";
import { maxTokensFor } from "./models";
import {
  FINAL_ANSWER_INSTRUCTION, MAX_TOOL_CALLS_PER_ROUND, TOOL_CALL_LIMIT_ERROR, TOOLS_FALLBACK_TEXT, resetFinalCallModeForTests, runAi, summarizeToolRounds,
} from "./run";
import { createFakeDb, createFakeProvider, httpError, okResponse, type FakeQuery } from "./testUtils";
import { aiUsageDaily, aiUsageRepeats, resetAiUsageCachesForTests, usageWindowStart } from "./usage";
import { SCHEMA_MIGRATION_IDS } from "../../migrations/index";
import { IDEMPOTENT_ERROR_CODES_0690, MIGRATION_0690_STATEMENTS } from "../../migrations/migration_0690";

const KEYS = ["GEMINI_API_KEY", "LLM_API_KEY", "OPENAI_API_KEY", "AI_PROVIDER", "AI_ENABLED", "AI_ASSISTANT", "AI_THINKING_LEVEL", "AI_HR_AUTOFILL",
  "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_PROJECT", "AI_MONTHLY_BUDGET_EUR"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env.GEMINI_API_KEY = "test-key";
  h.gen.mockReset();
  h.db = null;
  setAiProvidersForTests(null);
  resetAiUsageCachesForTests();
  resetContextCacheForTests();
  resetFinalCallModeForTests();
  invalidateSettingsCache();
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setAiProvidersForTests(null);
  vi.useRealTimers();
});

const TOOL = { name: "contar", description: "Conta", parameters: { type: "object", properties: { n: { type: "number" } } } };
const toolsResp = (n: number, raw: unknown = { role: "model", parts: [] }): ProviderResponse => ({
  ...okResponse(""),
  toolCalls: Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, name: "contar", args: { n: i + 1 } })),
  raw,
});
const usageInserts = () => (h.db?.queries ?? []).filter((q: FakeQuery) => q.sql.includes("INSERT INTO ai_usage_log"));

// ─── Todas as chamadas de uma volta recebem resposta ─────────────────────────

describe("function calling: uma volta com 6 chamadas em paralelo", () => {
  it("as 4 primeiras correm; as outras 2 recebem o erro do limite — nunca falta um functionResponse", async () => {
    const provider = createFakeProvider("gemini", [toolsResp(6), okResponse("Feito.")]);
    setAiProvidersForTests({ gemini: provider });
    const execute = vi.fn(async (c: any) => ({ ok: c.args.n }));
    const r = await runAi({ feature: "assistant", input: "?", tools: { declarations: [TOOL], execute } });
    expect(r.output).toBe("Feito.");
    expect(execute).toHaveBeenCalledTimes(MAX_TOOL_CALLS_PER_ROUND);
    const round = provider.calls[1].toolRounds![0];
    expect(round.calls).toHaveLength(6);
    expect(round.results).toHaveLength(6);
    expect(round.results.slice(0, 4).map((x) => x.response)).toEqual([{ ok: 1 }, { ok: 2 }, { ok: 3 }, { ok: 4 }]);
    expect(round.results.slice(4).map((x) => x.response)).toEqual([{ error: TOOL_CALL_LIMIT_ERROR }, { error: TOOL_CALL_LIMIT_ERROR }]);
    expect(r).toMatchObject({ rounds: 1, forcedFinal: false, fallback: false });
  });

  it("no pedido ao Gemini, cada functionCall tem o seu functionResponse (mesmo id)", () => {
    const calls = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, name: "contar", args: {} }));
    const contents = toGeminiContents({
      parts: [{ type: "text", text: "?" }],
      toolRounds: [{ calls, results: calls.map((call, i) => ({ call, response: i < 4 ? { ok: i } : { error: TOOL_CALL_LIMIT_ERROR } })) }],
    });
    const fc = contents[1].parts.map((p: any) => p.functionCall.id);
    const fr = contents[2].parts.map((p: any) => p.functionResponse.id);
    expect(fr).toEqual(fc);
  });
});

// ─── Máximo de voltas → chamada final ───────────────────────────────────────

describe("function calling: máximo de voltas → chamada final sem cache e sem ferramentas", () => {
  it("responde com o que tem; volta a mandar o sistema; registo com voltas e final forçada", async () => {
    h.db = createFakeDb();
    const provider = Object.assign(createFakeProvider("gemini", [toolsResp(1), toolsResp(1), toolsResp(1), okResponse("Com o que há: 3.")]), {
      createCache: async () => ({ name: "cachedContents/abc", expiresAt: Date.now() + 3_600_000 }),
    });
    setAiProvidersForTests({ gemini: provider });
    const r = await runAi({
      feature: "assistant", system: "REGRAS", cacheSystem: true, input: "?", variant: "v1",
      tools: { declarations: [TOOL], execute: async () => ({ total: 3 }), maxRounds: 2 },
    });
    expect(r).toMatchObject({ output: "Com o que há: 3.", rounds: 2, forcedFinal: true, fallback: false });
    expect(provider.calls).toHaveLength(4);
    const fin = provider.calls[3];
    expect(fin.tools).toBeUndefined();
    expect(fin.cachedContent).toBeUndefined();
    expect(fin.system).toBe("REGRAS");
    expect(fin.trailingText).toBe(FINAL_ANSWER_INSTRUCTION);
    expect(fin.toolRounds).toHaveLength(2);
    // as voltas com ferramentas iam com a cache (o sistema e as ferramentas lá dentro)
    expect(provider.calls[0].cachedContent).toBe("cachedContents/abc");
    const ins = usageInserts().at(-1)!;
    expect(ins.sql).toContain("finishReason, rounds, variant, forcedFinal");
    expect(ins.params.slice(-4)).toEqual(["STOP", 2, "v1", 1]);
  });

  it("a final volta a pedir ferramentas → texto de recurso (sem erro para a pessoa), registado como error/final_fallback", async () => {
    h.db = createFakeDb();
    const provider = createFakeProvider("gemini", [toolsResp(1)]);
    setAiProvidersForTests({ gemini: provider });
    const r = await runAi({ feature: "assistant", input: "?", tools: { declarations: [TOOL], execute: async () => ({}), maxRounds: 1 } });
    expect(r).toMatchObject({ output: TOOLS_FALLBACK_TEXT, fallback: true, forcedFinal: true });
    const ins = usageInserts().at(-1)!;
    expect(ins.params).toEqual(expect.arrayContaining(["error", "final_fallback"]));
    // e entra sozinha em "Perguntas que falharam"
    expect(detectUnanswered(TOOLS_FALLBACK_TEXT)).toMatch(/não conseguiu juntar/);
  });

  it("fornecedor recusa (400) o histórico sem ferramentas → resumo em texto; a seguir vai logo pelo resumo", async () => {
    // 400 a falar das ferramentas (só este sinal se guarda) → o resumo resulta → fica lembrado para este modelo.
    const toolsRejected = Object.assign(new Error("Please ensure that function call turns come with function declarations"), { status: 400 });
    const steps: Array<ProviderResponse | Error> = [toolsResp(1), toolsResp(1), toolsRejected, okResponse("Pelo resumo: 7.")];
    const provider = createFakeProvider("gemini", steps);
    setAiProvidersForTests({ gemini: provider });
    const execute = async () => ({ total: 7 });
    const r = await runAi({ feature: "assistant", input: "Quantas?", tools: { declarations: [TOOL], execute, maxRounds: 1 } });
    expect(r.output).toBe("Pelo resumo: 7.");
    const native = provider.calls[2];
    const summary = provider.calls[3];
    expect(native.toolRounds).toHaveLength(1);
    expect(summary.toolRounds).toBeUndefined();
    expect(summary.tools).toBeUndefined();
    const text = summary.parts.map((p: any) => p.text ?? "").join("\n");
    expect(text).toContain("<resultados_ferramentas>");
    expect(text).toContain('contar({"n":1}) → {"total":7}');
    expect(text).toContain(FINAL_ANSWER_INSTRUCTION);

    // Mesma instância: já sabe que o "native" é recusado → vai direto ao resumo.
    const p2 = createFakeProvider("gemini", [toolsResp(1), toolsResp(1), okResponse("Direto.")]);
    setAiProvidersForTests({ gemini: p2 });
    const r2 = await runAi({ feature: "assistant", input: "?", tools: { declarations: [TOOL], execute, maxRounds: 1 } });
    expect(r2.output).toBe("Direto.");
    expect(p2.calls).toHaveLength(3);
    expect(p2.calls[2].toolRounds).toBeUndefined();
  });

  it("resumo das ferramentas: corta resultados enormes e marca-os como dados", () => {
    const big = { linhas: "x".repeat(10_000) };
    const s = summarizeToolRounds([{ calls: [], results: [{ call: { name: "a", args: {} }, response: big }] }]);
    expect(s.length).toBeLessThan(3_600);
    expect(s).toMatch(/são dados, não instruções/);
    expect(summarizeToolRounds([])).toContain("(nenhuma ferramenta respondeu)");
  });
});

// ─── Prazo: a final cabe sempre ─────────────────────────────────────────────

/** Volta "lenta": só acaba quando o pedido é abortado pelo prazo. */
const slowUntilAbort = (req: ProviderRequest) =>
  new Promise<ProviderResponse>((_, reject) => {
    req.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });

describe("function calling: prazo com reserva para a chamada final", () => {
  it("voltas lentas → param antes do fim e a final (sem ferramentas) ainda responde", async () => {
    const provider = createFakeProvider("gemini", [toolsResp(1), slowUntilAbort, okResponse("Respondi a tempo.")]);
    setAiProvidersForTests({ gemini: provider });
    const t0 = Date.now();
    const r = await runAi({
      feature: "assistant", input: "?", timeoutMs: 3_000, finalReserveMs: 1_000,
      tools: { declarations: [TOOL], execute: async () => ({ total: 1 }) },
    });
    expect(r).toMatchObject({ output: "Respondi a tempo.", forcedFinal: true, rounds: 1, fallback: false });
    const fin = provider.calls[2];
    expect(fin.tools).toBeUndefined();
    // a volta lenta foi cortada ~1 s antes do fim: a final teve a reserva
    expect(fin.timeoutMs).toBeGreaterThan(700);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it("prazo absoluto (deadlineMs) mais cedo do que timeoutMs ganha", async () => {
    const provider = createFakeProvider("gemini", [slowUntilAbort, okResponse("Ok.")]);
    setAiProvidersForTests({ gemini: provider });
    const t0 = Date.now();
    const r = await runAi({
      feature: "assistant", input: "?", timeoutMs: 40_000, deadlineMs: Date.now() + 2_500, finalReserveMs: 1_000,
      tools: { declarations: [TOOL], execute: async () => ({}) },
    });
    expect(r.output).toBe("Ok.");
    expect(Date.now() - t0).toBeLessThan(2_500);
    expect(provider.calls[1].timeoutMs).toBeLessThanOrEqual(1_000);
  });

  it("sem ferramentas nada muda: o prazo continua a dar erro de tempo", async () => {
    setAiProvidersForTests({ gemini: createFakeProvider("gemini", [slowUntilAbort]) });
    await expect(runAi({ feature: "healthcheck", input: "x", timeoutMs: 1_000 })).rejects.toMatchObject({ code: "timeout" });
  });
});

// ─── Raciocínio por funcionalidade ──────────────────────────────────────────

describe("raciocínio por funcionalidade (ai.thinkingLevels)", () => {
  it("definição válida: só ids conhecidos e níveis do Gemini 3", () => {
    expect(validateSetting("ai.thinkingLevels", { mail_routing: "minimal", assistant: "default" }).ok).toBe(true);
    expect(validateSetting("ai.thinkingLevels", {}).ok).toBe(true);
    expect(validateSetting("ai.thinkingLevels", { inexistente: "low" }).ok).toBe(false);
    expect(validateSetting("ai.thinkingLevels", { assistant: "turbo" }).ok).toBe(false);
  });

  it("ordem: Definições > ponto de chamada > env (omissão low); 'default' = não manda; só modelos com raciocínio", () => {
    expect(resolveThinkingLevel("assistant", { settings: { assistant: "minimal" }, requested: "medium" })).toBe("minimal");
    expect(resolveThinkingLevel("assistant", { settings: { mail_routing: "minimal" }, requested: "medium" })).toBe("medium");
    expect(resolveThinkingLevel("assistant", {})).toBeUndefined();
    expect(thinkingLevelFor("gemini-3.1-flash-lite", {}, undefined)).toBe("low");
    expect(thinkingLevelFor("gemini-3.1-flash-lite", { AI_THINKING_LEVEL: "high" }, "minimal")).toBe("minimal");
    expect(thinkingLevelFor("gemini-3.1-flash-lite", { AI_THINKING_LEVEL: "high" }, undefined)).toBe("high");
    expect(thinkingLevelFor("gemini-3.1-flash-lite", {}, "default")).toBeNull();
    expect(thinkingLevelFor("gemini-2.5-flash", {}, "minimal")).toBeNull();
  });

  it("o cliente Gemini usa o nível do pedido (e não só a env)", async () => {
    h.gen.mockResolvedValue({ text: "ok", candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } });
    process.env.AI_THINKING_LEVEL = "high";
    await runAi({ feature: "assistant", input: "?", thinkingLevel: "minimal" });
    expect(h.gen.mock.calls[0][0].config.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
    await runAi({ feature: "assistant", input: "?", thinkingLevel: "default" });
    expect(h.gen.mock.calls[1][0].config.thinkingConfig).toBeUndefined();
    await runAi({ feature: "assistant", input: "?" });
    expect(h.gen.mock.calls[2][0].config.thinkingConfig).toEqual({ thinkingLevel: "high" });
  });

  it("a definição gravada ganha ao ponto de chamada; as outras funcionalidades não mudam", async () => {
    h.db = createFakeDb((q) => (q.sql.includes("FROM app_settings") ? [[{ settingKey: "ai.thinkingLevels", value: JSON.stringify({ mail_routing: "minimal" }) }]] : [[]]));
    const provider = createFakeProvider("gemini", [okResponse("ok")]);
    setAiProvidersForTests({ gemini: provider });
    await runAi({ feature: "mail_routing", input: "?", thinkingLevel: "high" });
    await runAi({ feature: "review_reply", input: "?" });
    expect(provider.calls[0].thinkingLevel).toBe("minimal");
    expect(provider.calls[1].thinkingLevel).toBeUndefined();
  });
});

describe("maxTokensFor", () => {
  it("lite com low: 700 → 900; minimal fica; Argon low 2048, medium 4096; sem raciocínio fica o pedido", () => {
    expect(maxTokensFor(700, "low")).toBe(900);
    expect(maxTokensFor(700, "minimal")).toBe(700);
    expect(maxTokensFor(2048, "low")).toBe(2048);
    expect(maxTokensFor(2048, "medium")).toBe(4096);
    expect(maxTokensFor(1000, "high")).toBe(8192);
    expect(maxTokensFor(700, null)).toBe(8192); // nível do modelo: o maior
    expect(maxTokensFor(700, "low", { noThinking: true })).toBe(700);
    expect(maxTokensFor(5000, "low")).toBe(5000); // nunca abaixo do pedido
  });

  it("só quem pede: o Multis (motor do chat) sobe para 900; o resto mantém o teto", async () => {
    const provider = createFakeProvider("gemini", [okResponse("ok")]);
    setAiProvidersForTests({ gemini: provider });
    await runAi({ feature: "assistant", input: "?", maxTokens: 700, scaleMaxTokensForThinking: true });
    await runAi({ feature: "review_reply", input: "?", maxTokens: 300 });
    expect(provider.calls[0].maxOutputTokens).toBe(900);
    expect(provider.calls[1].maxOutputTokens).toBe(300);
  });
});

// ─── RGPD: portão "só Vertex UE" fica registado ─────────────────────────────

describe("RGPD hr_autofill: o portão regista a recusa (sem conteúdo)", () => {
  it("linha blocked/eu_only, nada chega ao fornecedor", async () => {
    h.db = createFakeDb();
    process.env.AI_HR_AUTOFILL = "on";
    const p = createFakeProvider("gemini", [okResponse("{}")]);
    setAiProvidersForTests({ gemini: p });
    await expect(runAi({ feature: "hr_autofill", input: [{ type: "pdf", data: "SEGREDO-PDF" }], userId: 3, entity: "employee", entityId: 9 }))
      .rejects.toBeInstanceOf(AiEuOnlyError);
    expect(p.calls).toHaveLength(0);
    const ins = usageInserts();
    expect(ins).toHaveLength(1);
    expect(ins[0].params).toEqual(expect.arrayContaining(["hr_autofill", "blocked", "eu_only", 3, "employee", 9]));
    expect(JSON.stringify(ins[0].params)).not.toContain("SEGREDO");
  });
});

// ─── Registo: antes da migração ainda grava ─────────────────────────────────

describe("registo de uso: colunas novas e BD antes da 0690", () => {
  it("sem as colunas novas (ER_BAD_FIELD_ERROR) → grava a linha de sempre", async () => {
    let first = true;
    h.db = createFakeDb((q) => {
      if (q.sql.includes("INSERT INTO ai_usage_log") && q.sql.includes("forcedFinal") && first) {
        first = false;
        throw Object.assign(new Error("Unknown column"), { code: "ER_BAD_FIELD_ERROR" });
      }
      return [[]];
    });
    setAiProvidersForTests({ gemini: createFakeProvider("gemini", [okResponse("ok")]) });
    await runAi({ feature: "healthcheck", input: "x" });
    const ins = usageInserts();
    expect(ins).toHaveLength(2);
    expect(ins[1].sql).not.toContain("forcedFinal");
    expect(ins[1].params).toEqual(expect.arrayContaining(["healthcheck", "ok"]));
  });

  it("sem ferramentas: rounds/forcedFinal NULL; finishReason gravado", async () => {
    h.db = createFakeDb();
    setAiProvidersForTests({ gemini: createFakeProvider("gemini", [okResponse("ok")]) });
    await runAi({ feature: "healthcheck", input: "x" });
    expect(usageInserts()[0].params.slice(-4)).toEqual(["STOP", null, null, null]);
  });
});

// ─── Uso por dia e leituras repetidas ───────────────────────────────────────

describe("uso da IA por dia e leituras repetidas (só leitura)", () => {
  const NOW = Date.UTC(2026, 9, 15, 10, 0, 0);

  it("janela: começa às 00:00 UTC do 1.º dia", () => {
    expect(usageWindowStart(1, NOW)).toBe("2026-10-15 00:00:00");
    expect(usageWindowStart(15, NOW)).toBe("2026-10-01 00:00:00");
  });

  it("por dia × funcionalidade: só SELECT, parâmetros, teto de 62 dias, primeira/última", async () => {
    h.db = createFakeDb((q) => (q.sql.includes("GROUP BY day, feature")
      ? [[{ day: "2026-10-08", feature: "hr_autofill", calls: 3, errors: 0, blocked: 3, euOnly: 3, inTok: 0, outTok: 0, cachedTok: 0, totalCost: "0", firstAt: "2026-10-08 09:00:00", lastAt: "2026-10-08 11:00:00" }]]
      : [[]]));
    const r = await aiUsageDaily(500, "hr_autofill", NOW);
    expect(r.days).toBe(62);
    expect(r.rows[0]).toMatchObject({ day: "2026-10-08", feature: "hr_autofill", euOnly: 3, blocked: 3, firstAt: "2026-10-08 09:00:00", lastAt: "2026-10-08 11:00:00" });
    const q = h.db.queries.find((x: FakeQuery) => x.sql.includes("FROM ai_usage_log"))!;
    expect(q.sql).toMatch(/^SELECT /);
    expect(q.sql).not.toMatch(/INSERT|UPDATE|DELETE/i);
    expect(q.params).toEqual(["context_cache_storage", "context_cache_storage", usageWindowStart(62, NOW), "hr_autofill"]);
    expect(q.sql).not.toContain("hr_autofill");
  });

  it("repetidas: GROUP BY feature, entity, entityId HAVING > 1, top 100, sem as conversas do chat", async () => {
    h.db = createFakeDb((q) => (q.sql.includes("HAVING COUNT(*) > 1")
      ? [[{ feature: "review_reply", entity: "google_review", entityId: 3412, calls: 3, okCalls: 3, totalCost: "0.0021", firstAt: "2026-10-07 06:00:00", lastAt: "2026-10-07 06:05:00" }]]
      : [[]]));
    const r = await aiUsageRepeats(90, null, NOW);
    expect(r.days).toBe(31);
    expect(r.rows[0]).toMatchObject({ feature: "review_reply", entity: "google_review", entityId: 3412, calls: 3, costEur: 0.0021 });
    const q = h.db.queries.find((x: FakeQuery) => x.sql.includes("FROM ai_usage_log"))!;
    expect(q.sql).toContain("GROUP BY feature, entity, entityId HAVING COUNT(*) > 1");
    expect(q.sql).toMatch(/LIMIT \?$/);
    expect(q.params).toEqual([usageWindowStart(31, NOW), "ai_chat_conversation", 100]);
  });

  it("os procedimentos: só admin/super admin, com teto nos dias", () => {
    const src = readFileSync(resolve(__dirname, "../../settingsRouter.ts"), "utf8");
    for (const name of ["aiUsageDaily", "aiUsageRepeats"]) {
      const at = src.indexOf(`${name}: adminOnly`);
      expect(at, name).toBeGreaterThan(0);
      expect(src.slice(at, at + 600)).toContain("requireAdminRole(ctx.user.role)");
    }
    expect(src).toMatch(/aiUsageDaily: adminOnly[\s\S]{0,120}max\(62\)/);
    expect(src).toMatch(/aiUsageRepeats: adminOnly[\s\S]{0,120}max\(31\)/);
  });
});

// ─── Migração 0690 ──────────────────────────────────────────────────────────

describe("migração 0690 (observabilidade da IA)", () => {
  it("registada no fim, só acrescenta, idempotente, espelhada no drizzle", () => {
    expect(SCHEMA_MIGRATION_IDS).toContain("0690");
    const all = MIGRATION_0690_STATEMENTS.join("\n");
    expect(all).not.toMatch(/DROP|DELETE|UPDATE|MODIFY|CHANGE/i);
    for (const st of MIGRATION_0690_STATEMENTS) expect(st).toMatch(/^ALTER TABLE `ai_(usage_log|chat_messages)` ADD (COLUMN|INDEX) /);
    expect(IDEMPOTENT_ERROR_CODES_0690.has("ER_DUP_FIELDNAME")).toBe(true);
    expect(IDEMPOTENT_ERROR_CODES_0690.has("ER_DUP_KEYNAME")).toBe(true);
    for (const c of ["finishReason` VARCHAR(32) NULL", "rounds` TINYINT NULL", "variant` VARCHAR(16) NULL", "forcedFinal` TINYINT(1) NULL", "tier` VARCHAR(16) NULL"]) expect(all).toContain(c);
    expect(all).toContain("(`feature`, `userId`, `createdAt`)");
    const schema = readFileSync(resolve(__dirname, "../../../drizzle/schema.ts"), "utf8");
    expect(schema).toContain('index("idx_ai_usage_feature_user_created").on(table.feature, table.userId, table.createdAt)');
    for (const c of ["finishReason: varchar({ length: 32 })", "rounds: tinyint()", "forcedFinal: tinyint()"]) expect(schema).toContain(c);
  });
});
