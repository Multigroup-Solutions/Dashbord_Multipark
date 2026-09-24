import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const h = vi.hoisted(() => ({
  gen: vi.fn(),
  cacheCreate: vi.fn(),
  ctor: [] as any[],
  db: null as any,
  notify: vi.fn(async () => ({ recipients: [1], emailed: 0, duplicates: 0, city: null })),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: (...a: any[]) => h.gen(...a) };
    caches = { create: (...a: any[]) => h.cacheCreate(...a) };
    constructor(o: any) { h.ctor.push(o); }
  },
}));
vi.mock("../../db", () => ({ getDb: async () => h.db }));
vi.mock("../../notify", () => ({ notify: h.notify }));

import { AI_FEATURES, AI_FEATURE_IDS } from "../../../shared/aiFeatures";
import { AUTOMATION_FLAGS, validateSetting } from "../../../shared/appSettings";
import { invalidateSettingsCache } from "../../appSettings";
import {
  aiConfigured, geminiClientOptions, geminiConfig, geminiUsage, parseServiceAccount, selectProvider, setAiProvidersForTests, thinkingLevelFor,
} from "./client";
import { resetContextCacheForTests } from "./contextCache";
import {
  AI_USER_MESSAGES, AiBudgetExceededError, AiDisabledError, AiError, AiInvalidOutputError, AiNotConfiguredError, AiProviderError,
  AiTimeoutError, aiErrorCode, aiUserMessage, toAiError,
} from "./errors";
import { isAiFeatureEnabled, resolveFeatureTier } from "./features";
import { toProviderJsonSchema } from "./jsonSchema";
import { DEFAULT_GEMINI_MODELS, fallbackTier, geminiModelFor, resolveModel, sttModelFor } from "./models";
import { firstName, isValidNif, redactPii } from "./pii";
import { costEur, priceFor, USD_TO_EUR } from "./pricing";
import { invoiceSchema } from "./prompts/invoice";
import { checkRateLimit, decide, ipKey, resetRateLimitMemoryForTests, windowsFor } from "./rateLimit";
import { backoffMs, parseStructured, runAi } from "./run";
import { audioMimeType, transcribeAudio } from "./stt";
import { createFakeDb, createFakeProvider, httpError, okResponse } from "./testUtils";
import { aiUsageSummary, budgetDecision, monthBounds, resetAiUsageCachesForTests } from "./usage";

const ENV_KEYS = [
  "GEMINI_API_KEY", "LLM_API_KEY", "LLM_API_URL", "LLM_MODEL", "OPENAI_API_KEY", "AI_PROVIDER", "AI_PROVIDER_EXPENSE_OCR",
  "AI_ENABLED", "AI_REVIEW_DRAFTS", "AI_HR_AUTOFILL", "AI_RADIO", "AI_MONTHLY_BUDGET_EUR", "AI_MODEL_LITE", "AI_MODEL_FAST",
  "AI_MODEL_SMART", "AI_MODEL_STT", "AI_TIER_QUIZ_GENERATION", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION", "GOOGLE_SERVICE_ACCOUNT_JSON", "AI_THINKING_LEVEL",
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.GEMINI_API_KEY = "test-gemini-key";
  h.gen.mockReset();
  h.cacheCreate.mockReset();
  h.ctor.length = 0;
  h.notify.mockClear();
  h.db = null;
  setAiProvidersForTests(null);
  resetAiUsageCachesForTests();
  resetContextCacheForTests();
  resetRateLimitMemoryForTests();
  invalidateSettingsCache();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setAiProvidersForTests(null);
  vi.unstubAllGlobals();
});

function sdkText(text: string, extra: Record<string, unknown> = {}) {
  return { text, modelVersion: "gemini-3.1-flash-lite", candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 50, thoughtsTokenCount: 10 }, ...extra };
}

// ─── Níveis e modelos ───────────────────────────────────────────────────────

describe("IA: níveis e modelos", () => {
  it("omissões: Flash-Lite / Flash / Pro, sobreponíveis por env (valores inválidos ignorados)", () => {
    expect(geminiModelFor("lite", {})).toBe(DEFAULT_GEMINI_MODELS.lite);
    expect(DEFAULT_GEMINI_MODELS.lite).toMatch(/flash-lite/);
    expect(DEFAULT_GEMINI_MODELS.fast).toMatch(/flash/);
    expect(geminiModelFor("fast", { AI_MODEL_FAST: " gemini-x-flash " })).toBe("gemini-x-flash");
    expect(geminiModelFor("smart", { AI_MODEL_SMART: "modelo com espaços" })).toBe(DEFAULT_GEMINI_MODELS.smart);
    expect(sttModelFor({})).toBe(DEFAULT_GEMINI_MODELS.lite);
    expect(sttModelFor({ AI_MODEL_STT: "gemini-audio" })).toBe("gemini-audio");
  });

  it("caminho antigo: LLM_MODEL para todos os níveis (ou AI_MODEL_<NÍVEL> não-Gemini)", () => {
    expect(resolveModel("fast", "legacy", { LLM_MODEL: "meu-modelo" })).toBe("meu-modelo");
    expect(resolveModel("fast", "legacy", { LLM_MODEL: "meu-modelo", AI_MODEL_FAST: "outro-modelo" })).toBe("outro-modelo");
    expect(resolveModel("fast", "legacy", { LLM_MODEL: "meu-modelo", AI_MODEL_FAST: "gemini-3.8-flash" })).toBe("meu-modelo");
    expect(fallbackTier("smart")).toBe("fast");
    expect(fallbackTier("lite")).toBeNull();
  });

  it("regra do dono: tudo lite por omissão; fast só onde o lite falha; smart em lado nenhum", () => {
    for (const id of AI_FEATURE_IDS) expect(AI_FEATURES[id].tier).not.toBe("smart");
    const fast = AI_FEATURE_IDS.filter((id) => AI_FEATURES[id].tier === "fast");
    expect(fast).toEqual(["quiz_generation"]);
    expect(AI_FEATURES.expense_ocr.tier).toBe("lite");
    expect(AI_FEATURES.review_reply.tier).toBe("lite");
  });

  it("nível efetivo: Definições > env AI_TIER_<FUNC> > ponto de chamada > catálogo", () => {
    expect(resolveFeatureTier("quiz_generation", { env: {} })).toBe("fast");
    expect(resolveFeatureTier("expense_ocr", { env: {}, requested: "fast" })).toBe("fast");
    expect(resolveFeatureTier("expense_ocr", { env: { AI_TIER_EXPENSE_OCR: "lite" }, requested: "fast" })).toBe("lite");
    expect(resolveFeatureTier("expense_ocr", { env: { AI_TIER_EXPENSE_OCR: "lite" }, requested: "fast", settings: { expense_ocr: "smart" } })).toBe("smart");
    expect(resolveFeatureTier("expense_ocr", { env: { AI_TIER_EXPENSE_OCR: "nada" } })).toBe("lite");
    expect(validateSetting("ai.featureTiers", { quiz_generation: "lite" }).ok).toBe(true);
    expect(validateSetting("ai.featureTiers", { inexistente: "lite" }).ok).toBe(false);
    expect(validateSetting("ai.featureTiers", { quiz_generation: "turbo" }).ok).toBe(false);
  });

  it("runAi usa o nível pedido e AI_TIER_* ganha-lhe", async () => {
    const p = createFakeProvider("gemini", [okResponse("ok")]);
    setAiProvidersForTests({ gemini: p });
    await runAi({ feature: "quiz_generation", input: "x" });
    expect(p.calls[0].model).toBe(DEFAULT_GEMINI_MODELS.fast);
    process.env.AI_TIER_QUIZ_GENERATION = "lite";
    await runAi({ feature: "quiz_generation", input: "x" });
    expect(p.calls[1].model).toBe(DEFAULT_GEMINI_MODELS.lite);
  });

  it("modelo smart inexistente (404) → cai para o fast sem gastar tentativa", async () => {
    const p = createFakeProvider("gemini", [httpError(404), okResponse("ok")]);
    setAiProvidersForTests({ gemini: p });
    const r = await runAi({ feature: "healthcheck", tier: "smart", input: "x", retries: 0 });
    expect(p.calls.map((c) => c.model)).toEqual([DEFAULT_GEMINI_MODELS.smart, DEFAULT_GEMINI_MODELS.fast]);
    expect(r.tier).toBe("fast");
    expect(r.model).toBe(DEFAULT_GEMINI_MODELS.fast);
  });
});

// ─── Fornecedor ─────────────────────────────────────────────────────────────

describe("IA: escolha do fornecedor", () => {
  it("automático: Gemini se configurado, senão o antigo, senão nenhum", () => {
    expect(selectProvider({ GEMINI_API_KEY: "k" })).toBe("gemini");
    expect(selectProvider({ GEMINI_API_KEY: "k", LLM_API_KEY: "l" })).toBe("gemini");
    expect(selectProvider({ LLM_API_KEY: "l" })).toBe("legacy");
    expect(selectProvider({})).toBeNull();
    expect(aiConfigured({})).toBe(false);
  });

  it("explícito (geral e por funcionalidade); nunca cai para outro fornecedor", () => {
    expect(selectProvider({ GEMINI_API_KEY: "k", LLM_API_KEY: "l", AI_PROVIDER: "legacy" })).toBe("legacy");
    expect(selectProvider({ LLM_API_KEY: "l", AI_PROVIDER: "gemini" })).toBeNull();
    const env = { GEMINI_API_KEY: "k", LLM_API_KEY: "l", AI_PROVIDER_EXPENSE_OCR: "anthropic" };
    expect(selectProvider(env, "expense_ocr")).toBe("legacy");
    expect(selectProvider(env, "review_reply")).toBe("gemini");
  });

  it("Vertex AI (UE): projeto + região + conta de serviço (JSON ou base64)", () => {
    const sa = { type: "service_account", client_email: "x@y.iam.gserviceaccount.com" };
    expect(parseServiceAccount(JSON.stringify(sa))).toEqual(sa);
    expect(parseServiceAccount(Buffer.from(JSON.stringify(sa)).toString("base64"))).toEqual(sa);
    expect(parseServiceAccount("lixo")).toBeNull();
    const env = { GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_CLOUD_PROJECT: "multipark-ai", GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) };
    const cfg = geminiConfig(env);
    expect(cfg).toMatchObject({ mode: "vertex", project: "multipark-ai", location: "europe-west1" });
    const opts = geminiClientOptions(cfg!) as any;
    expect(opts.vertexai).toBe(true);
    expect(opts.googleAuthOptions.credentials).toEqual(sa);
    expect(opts.httpOptions.retryOptions.attempts).toBe(1);
    expect(selectProvider(env)).toBe("gemini");
    expect(geminiConfig({ GOOGLE_GENAI_USE_VERTEXAI: "true" })).toBeNull();
  });

  it("chama o SDK @google/genai com system, prazo, sem retries do SDK e raciocínio baixo", async () => {
    h.gen.mockResolvedValueOnce(sdkText("ok"));
    const r = await runAi({ feature: "healthcheck", system: "Sistema", input: "Olá", maxTokens: 64 });
    expect(r.output).toBe("ok");
    expect(r.provider).toBe("gemini");
    expect(h.ctor[0]).toMatchObject({ apiKey: "test-gemini-key" });
    const arg = h.gen.mock.calls[0][0];
    expect(arg.model).toBe(DEFAULT_GEMINI_MODELS.lite);
    expect(arg.contents).toEqual([{ role: "user", parts: [{ text: "Olá" }] }]);
    expect(arg.config.systemInstruction).toBe("Sistema");
    expect(arg.config.maxOutputTokens).toBe(64);
    expect(arg.config.abortSignal).toBeInstanceOf(AbortSignal);
    expect(arg.config.httpOptions.retryOptions.attempts).toBe(1);
    expect(arg.config.thinkingConfig).toEqual({ thinkingLevel: "low" });
    // "thinking" paga-se como saída
    expect(r.usage).toMatchObject({ inputTokens: 800, outputTokens: 60 });
  });

  it("raciocínio: só Gemini 3.x; AI_THINKING_LEVEL muda/desliga", () => {
    expect(thinkingLevelFor("gemini-3.1-flash-lite", {})).toBe("low");
    expect(thinkingLevelFor("gemini-2.5-flash-lite", {})).toBeNull();
    expect(thinkingLevelFor("gemini-3.8-flash", { AI_THINKING_LEVEL: "minimal" })).toBe("minimal");
    expect(thinkingLevelFor("gemini-3.8-flash", { AI_THINKING_LEVEL: "off" })).toBeNull();
    expect(geminiUsage({ promptTokenCount: 10, cachedContentTokenCount: 4, promptTokensDetails: [{ modality: "AUDIO", tokenCount: 6 }] })).toMatchObject({ inputTokens: 10, cachedTokens: 4, audioInputTokens: 6 });
  });

  it("sem configuração → AiNotConfiguredError com mensagem genérica", async () => {
    delete process.env.GEMINI_API_KEY;
    await expect(runAi({ feature: "healthcheck", input: "x" })).rejects.toBeInstanceOf(AiNotConfiguredError);
    expect(aiUserMessage(new AiNotConfiguredError())).toBe("A IA não está configurada.");
  });
});

// ─── Saída estruturada ──────────────────────────────────────────────────────

describe("IA: saída estruturada (zod → JSON Schema)", () => {
  it("schema no subconjunto do Gemini (nullable = type [x, null]; sem $schema)", () => {
    const js = toProviderJsonSchema(invoiceSchema) as any;
    expect(js.$schema).toBeUndefined();
    expect(js.type).toBe("object");
    expect(js.properties.supplier.type).toEqual(["string", "null"]);
    expect(js.properties.selfInvoice.type).toBe("boolean");
    expect(js.properties.paymentMethod.enum).toEqual(expect.arrayContaining(["cash", "card"]));
    expect(js.required).toEqual(expect.arrayContaining(["supplier", "amount"]));
    const withLimits = toProviderJsonSchema(z.object({ a: z.string().min(3).max(9).regex(/x/) })) as any;
    expect(withLimits.properties.a).toEqual({ type: "string" });
  });

  it("parseStructured: JSON válido passa; texto solto ou fora do schema → AiInvalidOutputError", () => {
    const s = z.object({ n: z.number() });
    expect(parseStructured('{"n":2}', s)).toEqual({ n: 2 });
    expect(() => parseStructured("```json\n{\"n\":2}\n```", s)).toThrow(AiInvalidOutputError);
    expect(() => parseStructured('{"n":"dois"}', s)).toThrow(AiInvalidOutputError);
  });

  it("pede JSON ao SDK e valida; resposta inválida → uma nova tentativa", async () => {
    h.gen.mockResolvedValueOnce(sdkText('{"n":"x"}')).mockResolvedValueOnce(sdkText('{"n":3}'));
    const r = await runAi({ feature: "healthcheck", input: "x", schema: z.object({ n: z.number() }) });
    expect(r.output).toEqual({ n: 3 });
    expect(r.attempts).toBe(2);
    const cfg = h.gen.mock.calls[0][0].config;
    expect(cfg.responseMimeType).toBe("application/json");
    expect(cfg.responseJsonSchema.properties.n.type).toBe("number");
  });
});

// ─── Retries e prazos ───────────────────────────────────────────────────────

describe("IA: novas tentativas e prazos", () => {
  it("503 e 429 → nova tentativa com espera; depois OK", async () => {
    const p = createFakeProvider("gemini", [httpError(503), httpError(429), okResponse("ok")]);
    setAiProvidersForTests({ gemini: p });
    const r = await runAi({ feature: "healthcheck", input: "x", timeoutMs: 15_000 });
    expect(r.attempts).toBe(3);
    expect(p.calls).toHaveLength(3);
  });

  it("400 → sem nova tentativa; erro tipado com mensagem genérica (sem detalhe do fornecedor)", async () => {
    const p = createFakeProvider("gemini", [Object.assign(new Error("API key sk-SEGREDO inválida para cliente joao@x.pt"), { status: 400 })]);
    setAiProvidersForTests({ gemini: p });
    const err = await runAi({ feature: "healthcheck", input: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(p.calls).toHaveLength(1);
    expect(err.userMessage).toBe(AI_USER_MESSAGES.provider);
    expect(err.message).not.toMatch(/SEGREDO|joao/);
    expect(aiErrorCode(err)).toBe("provider_400");
  });

  it("prazo: o pedido é abortado (AbortSignal) e dá AiTimeoutError", async () => {
    const p = createFakeProvider("gemini", [
      (req) => new Promise((_, rej) => req.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))),
    ]);
    setAiProvidersForTests({ gemini: p });
    const started = Date.now();
    const err = await runAi({ feature: "healthcheck", input: "x", timeoutMs: 1000 }).catch((e) => e);
    expect(err).toBeInstanceOf(AiTimeoutError);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(p.calls).toHaveLength(1);
    expect(err.userMessage).toMatch(/demorou/);
  });

  it("espera exponencial com teto e mapeamento de erros", () => {
    expect(backoffMs(1, () => 0.5)).toBe(400);
    expect(backoffMs(2, () => 0.5)).toBe(800);
    expect(backoffMs(9, () => 0.5)).toBe(4000);
    expect(toAiError({ status: 429 }).code).toBe("rate_limited");
    expect(toAiError({ status: 503 }).retryable).toBe(true);
    expect(toAiError({ status: 401 }).retryable).toBe(false);
    expect(toAiError(Object.assign(new Error("x"), { name: "AbortError" })).code).toBe("timeout");
    expect(toAiError(new TypeError("fetch failed")).retryable).toBe(true);
    expect(aiUserMessage(new Error("qualquer coisa interna"))).toBe(AI_USER_MESSAGES.provider);
  });
});

// ─── Orçamento ──────────────────────────────────────────────────────────────

function budgetDb(spent: number) {
  const alerted = new Set<string>();
  return createFakeDb((q) => {
    if (q.sql.includes("AS spent")) return [[{ spent }]];
    if (q.sql.startsWith("insert IGNORE INTO ai_budget_alerts") || q.sql.startsWith("INSERT IGNORE INTO ai_budget_alerts")) {
      const month = String(q.params[0]);
      const first = !alerted.has(month);
      alerted.add(month);
      return [{ affectedRows: first ? 1 : 0 }];
    }
    return [[]];
  });
}

describe("IA: orçamento mensal", () => {
  it("decisão: não essenciais param a 100%, essenciais a 150%, 0 = sem limite", () => {
    expect(budgetDecision(29.99, 30, false)).toBe("ok");
    expect(budgetDecision(30, 30, false)).toBe("blocked");
    expect(budgetDecision(40, 30, true)).toBe("ok");
    expect(budgetDecision(45, 30, true)).toBe("blocked");
    expect(budgetDecision(1e6, 0, false)).toBe("ok");
    expect(monthBounds(Date.UTC(2026, 11, 31, 23, 0))).toEqual({ month: "2026-12", start: "2026-12-01 00:00:00", end: "2027-01-01 00:00:00" });
  });

  it("orçamento excedido → \"IA temporariamente indisponível\", registo 'blocked' e aviso aos admins UMA vez", async () => {
    process.env.AI_MONTHLY_BUDGET_EUR = "10";
    h.db = budgetDb(12);
    const p = createFakeProvider("gemini", [okResponse("ok")]);
    setAiProvidersForTests({ gemini: p });
    const e1 = await runAi({ feature: "review_reply", input: "x" }).catch((e) => e);
    expect(e1).toBeInstanceOf(AiBudgetExceededError);
    expect(e1.userMessage).toBe("IA temporariamente indisponível.");
    await runAi({ feature: "whatsapp_reply", input: "x" }).catch(() => null);
    expect(p.calls).toHaveLength(0);
    expect(h.notify).toHaveBeenCalledTimes(1);
    const blocked = h.db.queries.filter((q: any) => q.sql.includes("INSERT INTO ai_usage_log"));
    expect(blocked).toHaveLength(2);
    expect(blocked[0].params).toContain("blocked");
    // essencial (faturas) ainda passa entre 100% e 150%
    const r = await runAi({ feature: "expense_ocr", input: "x" });
    expect(r.output).toBe("ok");
  });

  it("sem limite (0) nunca bloqueia", async () => {
    process.env.AI_MONTHLY_BUDGET_EUR = "0";
    h.db = budgetDb(9999);
    setAiProvidersForTests({ gemini: createFakeProvider("gemini", [okResponse("ok")]) });
    await expect(runAi({ feature: "review_reply", input: "x" })).resolves.toMatchObject({ output: "ok" });
    expect(h.notify).not.toHaveBeenCalled();
  });
});

// ─── PII ────────────────────────────────────────────────────────────────────

describe("IA: dados pessoais", () => {
  it("tapa email, telefone, IBAN, NIF e matrícula com marcadores reversíveis", () => {
    const t = "Liguem para +351 912 345 678 ou 213456789, email joao.silva@gmail.com, NIF 123456789, IBAN PT50 0002 0123 1234 5678 9015 4, carro AA-12-BC e 12-AB-34.";
    const r = redactPii(t);
    expect(r.text).not.toMatch(/912|213456789|joao|123456789|PT50|AA-12-BC|12-AB-34/);
    expect(r.text).toContain("[TELEFONE_1]");
    expect(r.text).toContain("[TELEFONE_2]");
    expect(r.text).toContain("[EMAIL_1]");
    expect(r.text).toContain("[NIF_1]");
    expect(r.text).toContain("[IBAN_1]");
    expect(r.text).toContain("[MATRICULA_1]");
    expect(r.text).toContain("[MATRICULA_2]");
    expect(r.restore(r.text)).toBe(t);
    expect(r.restore("Falar com [EMAIL_1] sobre [MATRICULA_1]")).toBe("Falar com joao.silva@gmail.com sobre AA-12-BC");
    expect(r.strip("Obrigado [EMAIL_1] , até breve")).toBe("Obrigado, até breve");
  });

  it("não estraga texto normal (horas, datas, valores, 'às 12 de')", () => {
    const t = "Chegou às 12 de manhã, 2026-09-24, pagou 45,90 € e ficou no piso 2.";
    expect(redactPii(t).text).toBe(t);
    expect(isValidNif("123456789")).toBe(true);
    expect(isValidNif("123456780")).toBe(false);
  });

  it("mesmo valor → mesmo marcador; só o primeiro nome", () => {
    const r = redactPii("a@b.pt e outra vez a@b.pt");
    expect(r.text).toBe("[EMAIL_1] e outra vez [EMAIL_1]");
    expect(firstName("maria joão silva")).toBe("Maria");
    expect(firstName("", "Cliente")).toBe("Cliente");
    expect(firstName("912345678")).toBe("Cliente");
  });
});

// ─── Interruptores ──────────────────────────────────────────────────────────

describe("IA: interruptores", () => {
  it("AI_ENABLED=off desliga tudo sem chamar o fornecedor", async () => {
    process.env.AI_ENABLED = "off";
    const p = createFakeProvider("gemini", [okResponse("ok")]);
    setAiProvidersForTests({ gemini: p });
    const err = await runAi({ feature: "expense_ocr", input: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(AiDisabledError);
    expect(err.userMessage).toBe("Esta funcionalidade de IA está desligada.");
    expect(p.calls).toHaveLength(0);
  });

  it("interruptor por funcionalidade (AI_RADIO desliga transcrição e resumo)", () => {
    const env = { AI_RADIO: "off" };
    expect(isAiFeatureEnabled("radio_summary", { env, overrides: null })).toBe(false);
    expect(isAiFeatureEnabled("radio_transcription", { env, overrides: null })).toBe(false);
    expect(isAiFeatureEnabled("review_reply", { env, overrides: null })).toBe(true);
    expect(isAiFeatureEnabled("review_reply", { env: {}, overrides: new Map([["AI_REVIEW_DRAFTS", false]]) })).toBe(false);
  });

  it("AI_HR_AUTOFILL nasce desligado (RGPD); liga-se por env ou Definições", () => {
    expect(isAiFeatureEnabled("hr_autofill", { env: {}, overrides: null })).toBe(false);
    expect(isAiFeatureEnabled("hr_autofill", { env: { AI_HR_AUTOFILL: "on" }, overrides: null })).toBe(true);
    expect(isAiFeatureEnabled("hr_autofill", { env: {}, overrides: new Map([["AI_HR_AUTOFILL", true]]) })).toBe(true);
  });

  it("todos os interruptores aparecem em Definições → Automações", () => {
    const names = AUTOMATION_FLAGS.map((f) => f.name);
    for (const f of ["AI_ENABLED", "AI_EXPENSE_OCR", "AI_REVIEW_DRAFTS", "AI_RADIO", "AI_HANDOVER_SUMMARY", "AI_WHATSAPP_ASSIST", "AI_QUIZ", "AI_HR_AUTOFILL", "AI_TRAINING_TUTOR"]) {
      expect(names).toContain(f);
      expect(validateSetting(`flag.${f}`, false)).toEqual({ ok: true, value: false });
    }
    expect(AUTOMATION_FLAGS.find((f) => f.name === "AI_HR_AUTOFILL")?.defaultEnabled).toBe(false);
    for (const id of AI_FEATURE_IDS) {
      const flag = AI_FEATURES[id].flag;
      if (flag) expect(names).toContain(flag);
    }
  });
});

// ─── Registo de uso ─────────────────────────────────────────────────────────

describe("IA: registo de uso e custo", () => {
  it("regista metadados (nunca o prompt) com custo estimado", async () => {
    h.db = createFakeDb();
    h.gen.mockResolvedValueOnce(sdkText("ok"));
    await runAi({ feature: "review_reply", system: "SISTEMA-SECRETO", input: "PROMPT-COM-DADOS joao@x.pt", userId: 7, entity: "google_review", entityId: 42 });
    const ins = h.db.queries.find((q: any) => q.sql.includes("INSERT INTO ai_usage_log"));
    expect(ins).toBeTruthy();
    expect(ins.params).toEqual(expect.arrayContaining(["review_reply", "lite", "gemini", DEFAULT_GEMINI_MODELS.lite, 7, "google_review", 42, 800, 60, "ok"]));
    expect(JSON.stringify(ins.params)).not.toMatch(/SECRETO|PROMPT|joao/);
    const cost = Number(ins.params.find((p: unknown) => typeof p === "string" && /^\d+\.\d{6}$/.test(p)));
    expect(cost).toBeCloseTo((800 * 0.25 + 60 * 1.5) / 1e6 * USD_TO_EUR, 6);
  });

  it("falha → linha 'error' com código curto", async () => {
    h.db = createFakeDb();
    setAiProvidersForTests({ gemini: createFakeProvider("gemini", [httpError(400)]) });
    await runAi({ feature: "healthcheck", input: "x" }).catch(() => null);
    const ins = h.db.queries.find((q: any) => q.sql.includes("INSERT INTO ai_usage_log"));
    expect(ins.params).toEqual(expect.arrayContaining(["error", "provider_400"]));
  });

  it("preços: tabela, sufixos de versão, sobreposição (EUR) e cache mais barata", () => {
    const base = priceFor("gemini-3.1-flash-lite");
    expect(base.input).toBeCloseTo(0.25 * USD_TO_EUR);
    expect(priceFor("gemini-3.1-flash-lite-001").input).toBeCloseTo(base.input);
    expect(priceFor("x", { x: { input: 1, output: 2 } })).toEqual({ input: 1, output: 2 });
    const full = costEur("gemini-3.1-flash-lite", { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0 });
    const cached = costEur("gemini-3.1-flash-lite", { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 1_000_000 });
    expect(cached).toBeLessThan(full / 5);
  });

  it("resumo mensal: GROUP BY seguro (ONLY_FULL_GROUP_BY) e datas parametrizadas", async () => {
    h.db = createFakeDb((q) => (q.sql.includes("GROUP BY feature") ? [[{ feature: "review_reply", calls: 3, errors: 1, blocked: 0, inTok: 100, outTok: 20, totalCost: "0.0123", avgLatency: 900 }]] : [[]]));
    const s = await aiUsageSummary(Date.UTC(2026, 8, 24));
    expect(s.month).toBe("2026-09");
    expect(s.features[0]).toMatchObject({ feature: "review_reply", label: "Resposta a críticas", calls: 3, costEur: 0.0123 });
    const q = h.db.queries.find((x: any) => x.sql.includes("GROUP BY feature"));
    expect(q.sql).not.toMatch(/2026-09/);
    expect(q.params).toEqual(["2026-09-01 00:00:00", "2026-10-01 00:00:00"]);
    const selectList = q.sql.slice(q.sql.indexOf("SELECT") + 6, q.sql.indexOf("FROM ai_usage_log"));
    // Divide por vírgulas de topo (fora de parênteses): só `feature` pode não ser agregado.
    const cols: string[] = [];
    let depth = 0, cur = "";
    for (const ch of selectList) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) { cols.push(cur.trim()); cur = ""; } else cur += ch;
    }
    cols.push(cur.trim());
    const bare = cols.filter((c) => !/^(COUNT|SUM|COALESCE|AVG|ROUND|MAX|MIN)\(/i.test(c));
    expect(bare).toEqual(["feature"]);
  });
});

// ─── Cache de contexto (preparação do chat) ─────────────────────────────────

describe("IA: cache de contexto", () => {
  it("cria uma vez e reutiliza; o system vai na cache (não no pedido)", async () => {
    const p = createFakeProvider("gemini", [okResponse("a")]);
    const create = vi.fn(async () => ({ name: "cachedContents/abc", expiresAt: Date.now() + 3_600_000 }));
    setAiProvidersForTests({ gemini: { ...p, generate: p.generate, createCache: create } as any });
    await runAi({ feature: "healthcheck", system: "Base de conhecimento longa…", input: "Q1", cacheSystem: true });
    await runAi({ feature: "healthcheck", system: "Base de conhecimento longa…", input: "Q2", cacheSystem: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(p.calls[0].cachedContent).toBe("cachedContents/abc");
    expect(p.calls[1].cachedContent).toBe("cachedContents/abc");
  });

  it("SDK: com cachedContent não manda systemInstruction", async () => {
    h.cacheCreate.mockResolvedValueOnce({ name: "cachedContents/xyz", expireTime: new Date(Date.now() + 3_600_000).toISOString() });
    h.gen.mockResolvedValueOnce(sdkText("ok"));
    await runAi({ feature: "healthcheck", system: "Contexto estável", input: "Q", cacheSystem: { ttlSeconds: 600 } });
    expect(h.cacheCreate.mock.calls[0][0].config).toMatchObject({ systemInstruction: "Contexto estável", ttl: "600s" });
    const cfg = h.gen.mock.calls[0][0].config;
    expect(cfg.cachedContent).toBe("cachedContents/xyz");
    expect(cfg.systemInstruction).toBeUndefined();
  });

  it("se a cache falhar, segue sem ela (system no pedido)", async () => {
    const p = createFakeProvider("gemini", [okResponse("a")]);
    setAiProvidersForTests({ gemini: { ...p, generate: p.generate, createCache: async () => { throw httpError(400); } } as any });
    await runAi({ feature: "healthcheck", system: "Curto", input: "Q", cacheSystem: true });
    expect(p.calls[0].cachedContent).toBeUndefined();
    expect(p.calls[0].system).toBe("Curto");
  });
});

// ─── Limitador de pedidos ───────────────────────────────────────────────────

describe("IA: limitador de pedidos", () => {
  it("janelas por minuto/dia e decisão", () => {
    const now = Date.UTC(2026, 8, 24, 10, 30, 15);
    const w = windowsFor({ perMinute: 5, perDay: 100 }, now);
    expect(w.map((x) => x.kind)).toEqual(["minute", "day"]);
    expect(decide(w, [5, 50], now)).toMatchObject({ allowed: true, remaining: 0 });
    expect(decide(w, [6, 50], now)).toMatchObject({ allowed: false, limitedBy: "minute", retryAfterSec: 45 });
    expect(decide(w, [1, 101], now)).toMatchObject({ allowed: false, limitedBy: "day" });
    expect(ipKey("1.2.3.4")).toMatch(/^ip:[0-9a-f]{24}$/);
    expect(ipKey("1.2.3.4")).not.toContain("1.2.3.4");
  });

  it("sem BD: contador em memória (nunca deixa passar sem limite)", async () => {
    const now = Date.UTC(2026, 8, 24, 10, 0, 0);
    expect((await checkRateLimit("chat:user:1", { perMinute: 2 }, now)).allowed).toBe(true);
    expect((await checkRateLimit("chat:user:1", { perMinute: 2 }, now)).allowed).toBe(true);
    const third = await checkRateLimit("chat:user:1", { perMinute: 2 }, now);
    expect(third).toMatchObject({ allowed: false, limitedBy: "minute" });
    expect((await checkRateLimit("chat:user:2", { perMinute: 2 }, now)).allowed).toBe(true);
    expect((await checkRateLimit("chat:user:1", { perMinute: 2 }, now + 60_000)).allowed).toBe(true);
  });

  it("com BD: um INSERT … ON DUPLICATE KEY atómico por janela, parametrizado", async () => {
    let n = 0;
    h.db = createFakeDb((q) => (q.sql.includes("INSERT INTO ai_rate_limits") ? [{ insertId: ++n }] : [[]]));
    const r = await checkRateLimit("chat:ip:abc", { perMinute: 10, perDay: 100 }, Date.UTC(2026, 8, 24));
    expect(r.allowed).toBe(true);
    const ins = h.db.queries.filter((q: any) => q.sql.includes("INSERT INTO ai_rate_limits"));
    expect(ins).toHaveLength(2);
    expect(ins[0].sql).toMatch(/LAST_INSERT_ID\(hits \+ 1\)/);
    expect(ins[0].params[0]).toBe("minute:chat:ip:abc");
  });
});

// ─── Transcrição ────────────────────────────────────────────────────────────

function audioFetch(extra?: (url: string, init: any) => Response | undefined) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
    calls.push(String(url));
    const e = extra?.(String(url), init);
    if (e) return e;
    return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "audio/ogg" } });
  }));
  return calls;
}

describe("IA: transcrição do rádio", () => {
  it("Gemini com o áudio como entrada (modelo AI_MODEL_STT → lite)", async () => {
    audioFetch();
    h.gen.mockResolvedValueOnce(sdkText("Carro na zona B, cliente à espera."));
    const r = await transcribeAudio({ audioUrl: "https://x.test/a.ogg" });
    expect(r).toMatchObject({ provider: "gemini", text: "Carro na zona B, cliente à espera." });
    const arg = h.gen.mock.calls[0][0];
    expect(arg.model).toBe(DEFAULT_GEMINI_MODELS.lite);
    expect(arg.contents[0].parts[0].inlineData).toEqual({ mimeType: "audio/ogg", data: Buffer.from([1, 2, 3, 4]).toString("base64") });
  });

  it("sem Gemini e com OPENAI_API_KEY → Whisper em api.openai.com (nunca no LLM_API_URL)", async () => {
    delete process.env.GEMINI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.LLM_API_URL = "https://api.anthropic.com";
    process.env.LLM_API_KEY = "anthropic-key";
    const calls = audioFetch((url) => (url.includes("openai.com") ? new Response(JSON.stringify({ text: "olá", duration: 3 }), { status: 200 }) : undefined));
    const r = await transcribeAudio({ audioUrl: "https://x.test/a.mp3" });
    expect(r).toMatchObject({ provider: "openai", text: "olá" });
    expect(calls).toContain("https://api.openai.com/v1/audio/transcriptions");
    expect(calls.some((u) => u.includes("anthropic"))).toBe(false);
  });

  it("só o fornecedor antigo (sem OPENAI_API_KEY) → não configurado, sem pedidos", async () => {
    delete process.env.GEMINI_API_KEY;
    process.env.LLM_API_URL = "https://api.anthropic.com";
    process.env.LLM_API_KEY = "anthropic-key";
    const calls = audioFetch();
    await expect(transcribeAudio({ audioUrl: "https://x.test/a.mp3" })).rejects.toBeInstanceOf(AiNotConfiguredError);
    expect(calls).toHaveLength(0);
  });

  it("AI_RADIO=off → desligado", async () => {
    process.env.AI_RADIO = "off";
    const calls = audioFetch();
    await expect(transcribeAudio({ audioUrl: "https://x.test/a.mp3" })).rejects.toBeInstanceOf(AiDisabledError);
    expect(calls).toHaveLength(0);
  });

  it("tipo MIME do áudio", () => {
    expect(audioMimeType("audio/mp3", "x")).toBe("audio/mpeg");
    expect(audioMimeType("application/octet-stream", "https://a/b.wav?sig=1")).toBe("audio/wav");
    expect(audioMimeType(null, "https://a/b")).toBe("audio/mpeg");
  });
});

// ─── Migração ───────────────────────────────────────────────────────────────

describe("migração 0111 (IA)", () => {
  const root = resolve(__dirname, "../../..");
  it("registada no ensureRecentSchema, a seguir à 0110, por ordem", () => {
    const db = readFileSync(resolve(root, "server/db.ts"), "utf8");
    const nums = [...db.matchAll(/import\("\.\/migrations\/migration_(\d{4})"\)\.then\(m => \(\{ s: m\.MIGRATION_/g)].map((x) => Number(x[1]));
    expect(nums).toContain(111);
    expect(nums.indexOf(111)).toBe(nums.indexOf(110) + 1);
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
  });

  it("idempotente (só CREATE TABLE IF NOT EXISTS) e espelhada em drizzle/schema.ts", async () => {
    const { MIGRATION_0111_STATEMENTS, IDEMPOTENT_ERROR_CODES_0111 } = await import("../../migrations/migration_0111");
    for (const st of MIGRATION_0111_STATEMENTS) expect(st).toMatch(/^CREATE TABLE IF NOT EXISTS `ai_/);
    expect(MIGRATION_0111_STATEMENTS.join("\n")).not.toMatch(/UPDATE|DROP|DELETE/i);
    expect(IDEMPOTENT_ERROR_CODES_0111.has("ER_TABLE_EXISTS_ERROR")).toBe(true);
    const schema = readFileSync(resolve(root, "drizzle/schema.ts"), "utf8");
    for (const t of ["ai_usage_log", "ai_budget_alerts", "ai_rate_limits", "ai_context_caches"]) expect(schema).toContain(`mysqlTable("${t}"`);
    const cols = ["feature", "tier", "provider", "model", "userId", "entity", "entityId", "inputTokens", "outputTokens", "cachedTokens", "costEur", "latencyMs", "status", "errorCode"];
    for (const c of cols) expect(MIGRATION_0111_STATEMENTS[0]).toContain(`\`${c}\``);
  });
});

describe("AiError", () => {
  it("é Error com código e mensagem de UI", () => {
    const e = new AiError("budget");
    expect(e).toBeInstanceOf(Error);
    expect(e.userMessage).toBe("IA temporariamente indisponível.");
  });
});
