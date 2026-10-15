/**
 * Plano MPV F4 (cache das leituras lentas) pelo caminho a sério: o
 * `assistant.ask` (uma mutation tRPC) com o middleware de sempre e o
 * fornecedor falso. A própria pergunta ao Multis NÃO limpa a cache (senão a
 * 2.ª pergunta voltava a ler e o «lidoAs» nunca aparecia); uma mutation de
 * negócio no meio limpa.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  db: null as any,
  logActivity: vi.fn(),
  pressure: vi.fn(),
}));
vi.mock("../db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => h.db,
  logActivity: (x: any) => h.logActivity(x),
  getUserPermissionOverrides: async () => ({}),
  getUserModuleOverrides: async () => ({}),
  getEmployeeByUserId: async () => ({ employee: { id: 1, fullName: "Eu" } }),
}));
vi.mock("../cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => ({ all: true, defaultCityId: null, cityName: null, cityNames: ["Lisboa", "Porto", "Faro"], cityIds: [10, 20, 30], projectIds: [10, 20, 30], missingCostCenter: false }),
}));
vi.mock("../loginBlock", async (original) => ({ ...(await original<object>()), loginBlockFor: async () => null }));
// As ferramentas chamam os procedimentos pelo appRouter (como a pessoa): aqui só a Pressão, controlada pelo teste.
vi.mock("../routers", () => ({
  appRouter: { createCaller: () => ({ extrasDia: { pressure: (...a: unknown[]) => h.pressure(...a) } }) },
}));

import { setAiProvidersForTests } from "../_core/ai/client";
import { resetContextCacheForTests } from "../_core/ai/contextCache";
import { resetFinalCallModeForTests } from "../_core/ai/run";
import { resetRateLimitMemoryForTests } from "../_core/ai/rateLimit";
import { resetAiUsageCachesForTests } from "../_core/ai/usage";
import { resetMaskedColumnsForTests } from "../_core/ai/chat/store";
import { createFakeDb, createFakeProvider, okResponse, type FakeQuery } from "../_core/ai/testUtils";
import { protectedProcedure, router } from "../_core/trpc";
import { invalidateSettingsCache } from "../appSettings";
import { assistantRouter } from "./router";
import { mutationClearsSlowCalls, resetSlowCallsForTests, setSlowCallDefaultMsForTests, slowCallSizesForTests } from "./slowCallCache";

const KEYS = ["GEMINI_API_KEY", "AI_ENABLED", "AI_ASSISTANT", "AI_ASSISTANT_SMART", "MPV", "AI_ASSISTANT_MEMORY"];
let saved: Record<string, string | undefined> = {};

/** A Pressão que o servidor falso devolve (Lisboa, sexta às 9h). */
const PRESSURE = {
  available: true, windowStart: "2026-08-15", windowEnd: "2026-10-13", windowDays: 60,
  cities: { cidade_lisboa: { percentile: 75, useMeasured: false } },
  slots: [{ group: "cidade_lisboa", weekday: 5, hour: 9, days: 8, checkinsDone: 40, checkoutsDone: 24, checkinsStarted: 40, checkoutsStarted: 24, concurrencyAvg: 2, concurrencyMax: 5, deliveryN: 20, deliveryP50: 14, deliveryP75: 19, deliveryP90: 25, pickupN: 0, pickupP50: null, pickupP75: null, cycleN: 30, cycleP75: 38 }],
  times: null,
};

let nextId = 100;
function fakeDb() {
  return createFakeDb((q: FakeQuery) => {
    if (q.sql.startsWith("INSERT INTO ai_rate_limits")) return [{ insertId: 1, affectedRows: 1 }];
    if (q.sql.startsWith("INSERT")) return [{ insertId: ++nextId, affectedRows: 1 }];
    if (q.sql.includes("FROM app_settings") && !q.sql.includes("LIKE")) return [[{ settingKey: "ai.assistantPilot", value: JSON.stringify({ userIds: [7] }) }]];
    if (q.sql.includes("AS dayEur")) return [[{ dayEur: "0", monthEur: "0" }]];
    if (q.sql.includes("userId = ?") && q.sql.includes("FROM ai_usage_log")) return [[{ spent: "0" }]];
    return [[]];
  });
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env.GEMINI_API_KEY = "test-key";
  process.env.MPV = "on";
  process.env.AI_ASSISTANT_MEMORY = "off";
  h.db = fakeDb();
  h.pressure.mockReset();
  resetAiUsageCachesForTests();
  resetRateLimitMemoryForTests();
  resetContextCacheForTests();
  resetFinalCallModeForTests();
  resetMaskedColumnsForTests(null);
  invalidateSettingsCache();
  resetSlowCallsForTests();
  setSlowCallDefaultMsForTests(40);
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setAiProvidersForTests(null);
  resetSlowCallsForTests();
});

/** O app: o assistente e uma mutation de negócio qualquer (pelo MESMO middleware). */
const app = router({
  assistant: assistantRouter,
  expenses: router({ create: protectedProcedure.mutation(() => ({ ok: true })) }),
});
const caller = () => app.createCaller({ user: { id: 7, role: "supervisor", name: "Sup" }, req: { headers: {} }, res: {} } as any);

/** O fornecedor: pede a Pressão e responde; guarda o que a ferramenta devolveu em cada pergunta. */
function provider() {
  const results: any[] = [];
  const p = createFakeProvider("gemini", [async (req: any) => {
    if (req.toolRounds?.length) {
      results.push(req.toolRounds.at(-1).results?.[0]);
      return okResponse("Feito.");
    }
    return { ...okResponse(""), toolCalls: [{ id: "a", name: "pressao_explicar", args: { cidade: "Lisboa", dia: 5, hora: 9 } }], raw: { role: "model", parts: [] } };
  }]);
  setAiProvidersForTests({ gemini: p });
  return results;
}
const text = (r: unknown) => JSON.stringify(r);

describe("assistant.ask (mutation) não anula a cache das leituras lentas", () => {
  it("duas perguntas seguidas: 1 leitura e o «lidoAs» na 2.ª", async () => {
    const results = provider();
    let release!: (v: unknown) => void;
    h.pressure.mockImplementation(() => new Promise((res) => { release = res; }));
    const r1: any = await caller().assistant.ask({ question: "Como está a pressão de sexta às 9h?" });
    expect(r1.ok, text(r1)).toBe(true);
    expect(text(results[0])).toContain("Demorou demasiado");
    // A leitura chega depois do prazo (e depois de a 1.ª pergunta acabar): fica guardada.
    release(PRESSURE);
    await new Promise((r) => setTimeout(r, 5));
    expect(slowCallSizesForTests().cached).toBe(1);
    const r2: any = await caller().assistant.ask({ question: "E agora?" });
    expect(r2.ok, text(r2)).toBe(true);
    expect(h.pressure).toHaveBeenCalledTimes(1);
    expect(text(results[1])).toMatch(/lidoAs[^,]*\d{2}:\d{2} \(Lisboa\)/);
    expect(text(results[1])).toContain("percentilDaCidade");
  });

  it("uma mutation de negócio no meio limpa a cache: a 3.ª leitura é nova, sem «lidoAs»", async () => {
    const results = provider();
    let release!: (v: unknown) => void;
    h.pressure.mockImplementationOnce(() => new Promise((res) => { release = res; }));
    await caller().assistant.ask({ question: "Como está a pressão de sexta às 9h?" });
    release(PRESSURE);
    await new Promise((r) => setTimeout(r, 5));
    expect(slowCallSizesForTests().cached).toBe(1);
    await caller().expenses.create();
    expect(slowCallSizesForTests().cached).toBe(0);
    h.pressure.mockImplementation(async () => PRESSURE);
    const r2: any = await caller().assistant.ask({ question: "E agora?" });
    expect(r2.ok, text(r2)).toBe(true);
    expect(h.pressure).toHaveBeenCalledTimes(2);
    expect(text(results[1])).not.toContain("lidoAs");
    expect(text(results[1])).toContain("percentilDaCidade");
  });

  it("a lista do que não limpa: o Multis, batimentos, \"visto\", marcar como lido e pré-visualizações; o resto limpa", () => {
    for (const p of [
      "assistant.ask", "assistant.memory.add", "assistant.feedback.give", "googleAccount.sync.heartbeat",
      "operational.personalDevices.seen", "operational.personalDevices.register", "operational.pdas.claimOnLogin",
      "notifications.markAllRead", "mail.threads.markRead", "whatsapp.markUnread", "knowledge.open", "partnerships.mpSyncPreview",
    ]) expect(mutationClearsSlowCalls(p), p).toBe(false);
    for (const p of [
      "expenses.create", "reviews.publishReply", "extrasDia.upsertAssignment", "extrasDia.confirmSchedule", "evaluation.setExplanationHidden",
      "partnerships.update", "training.markItem", "operational.pdas.assign", "algo.novo",
    ]) expect(mutationClearsSlowCalls(p), p).toBe(true);
  });
});
