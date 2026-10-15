/**
 * Plano MPV (Multis por página), fase F4 — as ferramentas de dados do piloto
 * (server/assistant/mpvDataTools.ts), só no MPV (o v1 fica igual):
 *  - só leitura, nenhuma chama IA; chamam os procedimentos de sempre como a
 *    pessoa (o servidor falso daqui faz de procedimento com as regras do ecrã);
 *  - acesso por ferramenta e por papel (extra, TL de outra cidade, supervisor,
 *    admin): cidades e totais financeiros escondidos a quem não os vê;
 *  - dados pessoais: colaboradores [NOME_n] (repostos), avaliadores pelo 1.º
 *    nome, texto livre com emails/telefones/IBAN/NIF/matrículas tapados;
 *  - resultados com teto (~4 000 caracteres);
 *  - perfis da F3: as planeadas saíram; as perguntas voltam pelo `needs`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const h = vi.hoisted(() => ({ db: null as any, logActivity: vi.fn() }));
vi.mock("../db", () => ({
  getDb: async () => h.db,
  logActivity: h.logActivity,
  getUserPermissionOverrides: async () => ({}),
}));

import type { CityAccess } from "../cityAccess";
import { setAiProvidersForTests, type ProviderResponse } from "../_core/ai/client";
import { resetContextCacheForTests } from "../_core/ai/contextCache";
import { createRedactionContext } from "../_core/ai/pii";
import { MAX_TOOL_CALLS_PER_ROUND, resetFinalCallModeForTests } from "../_core/ai/run";
import { resetRateLimitMemoryForTests } from "../_core/ai/rateLimit";
import { resetAiUsageCachesForTests } from "../_core/ai/usage";
import { TOOL_REFUSED_ERROR, availableTools, makeToolExecutor } from "../_core/ai/chat/tools";
import { resetMaskedColumnsForTests } from "../_core/ai/chat/store";
import { createFakeDb, createFakeProvider, okResponse } from "../_core/ai/testUtils";
import { invalidateSettingsCache } from "../appSettings";
import { PLANNED_TOOLS, allMultisProfiles, multisProfileFor, MULTIS_PROFILE_RULES } from "../../shared/multisProfiles";
import { RULES_DOCS } from "./rulesDocs.generated";
import { askAssistant, staffHelpDocs, type AssistantMode } from "./service";
import { MPV_STAFF_TOOLS, STAFF_TOOLS, type StaffToolCtx } from "./tools";
import { MPV_DATA_TOOLS, MPV_DATA_TOOL_NAMES, MPV_TOOL_RESULT_MAX_CHARS, evaluationRulesFor, fitToolResult, summarizeTimesGrid, weekdayArg } from "./mpvDataTools";
import { mpvSuggestions } from "./mpv";

const KEYS = ["GEMINI_API_KEY", "LLM_API_KEY", "OPENAI_API_KEY", "AI_ENABLED", "AI_ASSISTANT", "AI_ASSISTANT_SMART", "MPV", "AI_MODEL_SMART",
  "AI_MONTHLY_BUDGET_EUR", "AI_PROVIDER", "AI_ASSISTANT_MEMORY"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env.GEMINI_API_KEY = "test-key";
  h.db = createFakeDb(() => [[]]);
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
const PORTO: CityAccess = { all: false, defaultCityId: 20, cityName: "Porto", cityNames: ["Porto"], cityIds: [20], projectIds: [20], missingCostCenter: false };
const ALL: CityAccess = { all: true, defaultCityId: null, cityNames: ["Lisboa", "Porto", "Faro"], cityIds: [10, 20, 30], projectIds: [10, 11, 12, 20, 30], missingCostCenter: false };
const src = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
const PILOT: AssistantMode = { feature: "assistant", pilot: true, economy: false, economyReason: null };
const NO_HOOKS = { knowledge: null, memoryEnabled: false, mode: PILOT } as const;
/** As do Extras Dia: com várias cidades, a cidade é obrigatória. */
const CITY_TOOLS = new Set(["pressao_explicar", "tempos_resumo", "extras_dia_situacao"]);
const lisboaIfNeeded = (name: string) => (CITY_TOOLS.has(name) ? { cidade: "Lisboa" } : {});

// ─── Servidor falso (faz de procedimentos tRPC, com as regras do ecrã) ───────

/** Segredos que o fornecedor nunca pode ver (estão espalhados pelos dados). */
const SECRETS = {
  people: ["João Silva", "João Pereira", "Maria Antunes Costa", "Rui Gomes Lopes"],
  email: "bruno.cliente@z.pt",
  phone: "912345678",
  iban: "PT50000201231234567890154",
  nif: "NIF 123456789",
  plate: "AA-12-BB",
};

interface ServerOpts {
  /** O que o servidor diria: a pessoa vê os totais financeiros? */
  totals?: boolean;
  /** Muitas linhas (para o teto do resultado). */
  many?: boolean;
}

const slot = (weekday: number, hour: number, extra: Record<string, unknown> = {}) => ({
  group: "cidade_lisboa", weekday, hour, days: 8, checkinsDone: 40, checkoutsDone: 24, checkinsStarted: 40, checkoutsStarted: 24,
  concurrencyAvg: 2.5, concurrencyMax: 6, deliveryN: 20, deliveryP50: 14, deliveryP75: 19, deliveryP90: 25, pickupN: 10, pickupP50: 8, pickupP75: 11,
  cycleN: 30, cycleP50: 30, cycleP60: 33, cycleP75: 38, cycleP85: 44, cycleP90: 50, ...extra,
});

function fakeServer(opts: ServerOpts = {}) {
  const calls: Array<{ path: string; input: any }> = [];
  const n = opts.many ? 60 : 3;
  const call = vi.fn(async (path: string, input?: any) => {
    calls.push({ path, input });
    switch (path) {
      case "partnerships.live": {
        const money = !!opts.totals;
        return {
          available: true, canSeeTotals: money, periods: { thisMonth: "2026-10", from12: "2025-11-01" },
          partners: Array.from({ length: n }, (_, i) => ({
            userId: `p${i}`, name: i === 0 ? `Agência Sol ${SECRETS.email}` : `Parceiro ${i}`, type: i % 2 ? "AGENCY" : "AGGREGATOR", active: true,
            parks: [
              { partnerId: `p${i}`, parkId: "k1", parkName: "Airpark Lisboa", city: "Lisboa", active: true, brand: "airpark", parkActive: true, feeType: money ? "PERCENT" : null, feePct: money ? 15 : null, feeFixed: null },
              { partnerId: `p${i}`, parkId: "k2", parkName: "Redpark Porto", city: "Porto", active: true, brand: "redpark", parkActive: true, feeType: money ? "FIXED" : null, feePct: null, feeFixed: money ? 3 : null },
            ],
            thisMonth: { bookings: 10 + i, value: money ? 1000 : null, ours: money ? 150 : null, missing: 0 },
            last12: { bookings: 100, value: money ? 9000 : null, ours: money ? 1400 : null, missing: 0 },
            record: i === 1 ? null : { id: i, name: `Parceiro ${i}`, partnerType: i % 2 ? "agencia_viagem" : "agregador", partnerStatus: "active" },
          })),
          parks: { ours: [], third: [] },
        };
      }
      case "expenses.access": return { scope: opts.totals ? "all" : "users", canSeeTotals: !!opts.totals };
      case "expenses.list": return Array.from({ length: n }, (_, i) => ({
        expense: { id: i, amount: "100.50", status: ["pending", "paid", "overdue", "cancelled"][i % 4], expenseDate: `2026-10-0${(i % 9) + 1}`, supplier: `Fornecedor ${SECRETS.nif}`, supplierNif: "123456789", notes: SECRETS.iban },
        category: { name: i % 2 ? "Combustível" : "Limpeza" }, project: { name: "Lisboa" },
        insertedByName: SECRETS.people[2],
      }));
      case "extrasDia.pressure": return {
        available: true, windowStart: "2026-08-15", windowEnd: "2026-10-13", windowDays: 60, computedAt: null, groups: [],
        cities: { cidade_lisboa: { city: "lisbon", percentile: 75, bands: [], useMeasured: false }, cidade_porto: { city: "porto", percentile: 60, bands: [], useMeasured: true } },
        slots: [
          slot(5, 9), slot(5, 10, { checkinsDone: 4, checkoutsDone: 2, cycleN: 3 }), slot(5, 18, { checkinsDone: 120, checkoutsDone: 90, deliveryP75: 40 }),
          { ...slot(5, 9), group: "cidade_porto", cycleN: 4, cycleP60: 41 },
        ],
        loads: [], crew: [],
        times: {
          available: true, from: "2026-08-15", to: "2026-10-13", rows: 900, truncated: false, targetMinutes: 15,
          groups: {
            cidade_lisboa: {
              cells: {
                "5:9": { deliveries: 20, pickups: 10, m: { fila: { n: 20, p50Ms: 300_000, p75Ms: 480_000, meanMs: 360_000 }, total: { n: 20, p50Ms: 900_000, p75Ms: 1_200_000, meanMs: 960_000 } } },
                "5:18": { deliveries: 30, pickups: 5, m: { fila: { n: 30, p50Ms: 600_000, p75Ms: 900_000, meanMs: 660_000 } } },
              },
              hidden: { transito: "Em calibração: o Trânsito ainda não se mostra (cobertura do GPS abaixo do mínimo)." },
              notes: {}, coverage: { fila: 92, transito: 41 }, deliveries: 50, pickups: 15, tightUsesQueue: false, queue: null, queueCoveragePct: null,
            },
          },
        },
      };
      case "multipark.weekActivity": return {
        weekStart: "2026-10-11",
        times: {
          available: true, truncated: false, targetMinutes: 15, cells: {}, byDay: {}, byHour: {},
          total: { cells: { "*": { deliveries: 80, pickups: 40, m: { fila: { n: 80, p50Ms: 420_000, p75Ms: 600_000, meanMs: 450_000 } } } }, hidden: { cliente: "Em calibração." }, notes: {}, coverage: { fila: 90 }, deliveries: 80, pickups: 40 },
        },
      };
      case "evaluation.mine": return {
        employee: { id: 5, fullName: SECRETS.people[3] },
        totals: {
          days: 10, metrics: { hoursWorked: 80, recolhas: 30, entregas: 28, movements: 12, spotChanges: 3, delays: 2, lateServices: 0, speedingEvents: 1, complaints: 0, accidents: 0 },
          score: { totalPoints: 150, positivePoints: 175, negativePoints: -25, lines: [{ label: "Excesso de velocidade", count: 1, subtotal: -10 }, { label: "Recolha ou entrega", count: 58, subtotal: 174 }] },
          perHour: { pointsPerHour: 1.9 },
        },
        days: [
          { day: "2026-10-03", score: { totalPoints: -5, negativePoints: -15, lines: [{ label: "Excesso de velocidade", count: 1, subtotal: -10 }, { label: "Atraso ao trabalho (≥ 5 min)", count: 1, subtotal: -5 }] } },
          { day: "2026-10-04", score: { totalPoints: 20, negativePoints: 0, lines: [] } },
        ],
        disputes: [{ id: 1, status: "open", note: `liga para ${SECRETS.phone}` }],
      };
      case "reviews.stats": return { total: 40, avg: 4.3, star1: 2, star2: 1, star3: 3, star4: 10, star5: 24, unrated: 0, pending: 3, responded: 35, complaints: 2 };
      case "reviews.list": return [
        { id: 1, rating: 1, status: "new", respondedAt: null, complaintId: null, notAReview: 0, duplicateOf: null, reviewDate: "2026-10-14 10:00:00", createdAt: "2026-10-14", reviewerName: "Maria Antunes Costa", reviewerEmail: SECRETS.email, vehiclePlate: SECRETS.plate, reviewText: `Péssimo, o carro ${SECRETS.plate} veio sujo. Liguem para ${SECRETS.phone} ou ${SECRETS.email}. ${"Muito mau. ".repeat(40)}`, locationTitle: "Airpark Lisboa", aiResponse: "Lamentamos…" },
        { id: 2, rating: 5, status: "new", respondedAt: null, complaintId: null, notAReview: 1, duplicateOf: null, reviewDate: "2026-10-13", reviewerName: "Candidato", reviewText: "Envio o meu CV" },
        { id: 3, rating: 5, status: "new", respondedAt: null, complaintId: null, notAReview: 0, duplicateOf: 1, reviewDate: "2026-10-13", reviewerName: "Repetido", reviewText: "Repetida" },
        { id: 4, rating: 4, status: "manually_responded", respondedAt: null, complaintId: null, notAReview: 0, duplicateOf: null, reviewDate: "2026-10-12", reviewerName: "Ana", reviewText: "Bom" },
        ...Array.from({ length: opts.many ? 40 : 1 }, (_, i) => ({ id: 10 + i, rating: 5, status: "new", respondedAt: null, complaintId: null, notAReview: 0, duplicateOf: null, reviewDate: `2026-10-0${(i % 9) + 1}`, reviewerName: "Rui Gomes Lopes", reviewText: "Excelente serviço" })),
      ];
      case "training.myTraining": return {
        employeeId: 5,
        assignments: [{ pathName: "Formação obrigatória", status: "in_progress", dueAt: "2026-10-20 00:00:00", daysLate: 0, blocksEscala: true, progress: { pct: 50, requiredDone: 2, requiredTotal: 4 }, items: [{ required: true, completedAt: null, title: "Recolha de um carro" }, { required: true, completedAt: "2026-10-01", title: "Boas-vindas" }] }],
        certificates: [{ state: "valid" }],
      };
      case "training.dashboard": return {
        totals: { assigned: 10, completed: 6, overdue: 2, pct: 60 },
        summary: [{ city: "porto", pathName: "Formação obrigatória", assigned: 10, completed: 6, overdue: 2, pct: 60 }],
        overdue: [{ fullName: SECRETS.people[0], pathName: "Formação obrigatória", daysLate: 5, city: "porto" }, { fullName: SECRETS.people[1], pathName: "Formação obrigatória", daysLate: 2, city: "porto" }],
        promotions: [], certificates: [],
      };
      case "extrasDia.staffing": return {
        date: input?.date, city: input?.city, incomplete: null,
        hours: [{ hour: 8, needed: 2, scheduled: 1, availableIds: [1] }, { hour: 9, needed: 2, scheduled: 2, availableIds: [] }, { hour: 18, needed: 1, scheduled: 3, availableIds: [] }, { hour: 25, needed: 0, scheduled: 0, availableIds: [] }],
        gaps: [{ fromHour: 8, toHour: 9, missing: 1, available: [{ id: 1, name: "João Pereira" }] }],
        people: [{ id: 1, name: "João Pereira", hours: "08–14" }],
      };
      case "extrasDia.assignments": return Array.from({ length: opts.many ? 40 : 2 }, (_, i) => ({
        employeeId: 100 + i, personName: i === 0 ? "João Silva" : i === 1 ? "João Pereira" : `Pessoa Número ${i}`, shift: i ? "night" : "morning",
        startHour: 8, endHour: 16, sentHomeHour: null, isTeamLeader: i === 1, status: i === 1 ? "proposed" : "confirmed", phone: SECRETS.phone,
      }));
      case "extrasDia.schedule": return { state: { status: "proposed", manual: null }, noAnswerCount: 4, notifications: [{ status: "sent" }, { status: "failed" }] };
      case "extrasDia.candidates": return [
        { id: 1, fullName: "João Pereira", city: "lisbon", availability: { status: "available" } },
        { id: 100, fullName: "João Silva", city: "lisbon", availability: { status: "available" } },
        { id: 2, fullName: "Maria Antunes Costa", city: "lisbon", availability: { status: "unavailable" } },
        { id: 3, fullName: "Pessoa do Porto", city: "porto", availability: { status: "available" } },
        { id: 4, fullName: "Sem Resposta", city: "lisbon", availability: { status: "no_response" } },
      ];
      default: throw new Error(`procedimento inesperado: ${path}`);
    }
  });
  return { call, calls };
}

const ctxFor = (role: string, access: CityAccess, srv = fakeServer(), financeAllowed = false): StaffToolCtx =>
  ({ user: { id: 7, role }, access, call: srv.call, today: "2026-10-15", financeAllowed, helpDocs: staffHelpDocs() }) as any;

/** As 4 pessoas dos testes de acesso (com o que o servidor diria de cada uma). */
const PEOPLE = {
  extra: () => ctxFor("extra", LISBOA, fakeServer({ totals: false })),
  tlPorto: () => ctxFor("team_leader", PORTO, fakeServer({ totals: false })),
  supervisor: () => ctxFor("supervisor", LISBOA, fakeServer({ totals: true })),
  admin: () => ctxFor("admin", ALL, fakeServer({ totals: true }), true),
} as const;
type Who = keyof typeof PEOPLE;

async function runTool(ctx: StaffToolCtx, name: string, args: Record<string, unknown> = {}) {
  const redact = createRedactionContext();
  const exec = makeToolExecutor(MPV_STAFF_TOOLS, ctx, {}, { refuseUnavailable: true, redact });
  const result = await exec({ name, args } as any);
  return { result, redact, json: JSON.stringify(result) };
}

// ─── Registo ─────────────────────────────────────────────────────────────────

describe("as 8 ferramentas novas: só no MPV, só leitura, sem IA", () => {
  it("estão no MPV (no fim), não no v1; a avaliacao_minha substitui a minha_avaliacao só no MPV", () => {
    expect(MPV_DATA_TOOLS.map((t) => t.name)).toEqual([...MPV_DATA_TOOL_NAMES]);
    const mpv = MPV_STAFF_TOOLS.map((t) => t.name);
    expect(mpv.slice(-MPV_DATA_TOOL_NAMES.length)).toEqual([...MPV_DATA_TOOL_NAMES]);
    for (const n of MPV_DATA_TOOL_NAMES) expect(STAFF_TOOLS.map((t) => t.name)).not.toContain(n);
    expect(mpv).not.toContain("minha_avaliacao");
    expect(STAFF_TOOLS.map((t) => t.name)).toContain("minha_avaliacao");
    // Cada uma declara os seus campos com dados pessoais (mesmo que vazio).
    for (const t of MPV_DATA_TOOLS) expect(t.pii, t.name).toBeDefined();
  });

  it("nenhuma chama IA: o código não importa o runAi nem a explicação da avaliação; só procedimentos de leitura", async () => {
    const code = src("server/assistant/mpvDataTools.ts");
    for (const bad of ["_core/ai/run", "runAi", "evaluation.explanation", "evaluationExplain", "draftReviewReply", "generateResponse"]) expect(code, bad).not.toContain(bad);
    const srv = fakeServer({ totals: true });
    const ctx = ctxFor("admin", ALL, srv, true);
    for (const n of MPV_DATA_TOOL_NAMES) await runTool(ctx, n, lisboaIfNeeded(n));
    const READ_ONLY = new Set([
      "partnerships.live", "expenses.access", "expenses.list", "extrasDia.pressure", "multipark.weekActivity", "evaluation.mine",
      "reviews.stats", "reviews.list", "training.myTraining", "training.dashboard",
      "extrasDia.staffing", "extrasDia.assignments", "extrasDia.schedule", "extrasDia.candidates",
    ]);
    expect(srv.calls.length).toBeGreaterThan(8);
    for (const c of srv.calls) expect(READ_ONLY.has(c.path), c.path).toBe(true);
    // Os procedimentos usados são queries no código (nenhuma mutation).
    const routers = src("server/routers.ts") + src("server/expensesRouter.ts") + src("server/trainingRouter.ts") + src("server/evaluationRouter.ts") + src("server/extrasDiaShiftRouter.ts");
    for (const p of READ_ONLY) {
      const leaf = p.split(".")[1];
      expect(routers, p).toMatch(new RegExp(`\\b${leaf}: protectedProcedure[\\s\\S]{0,1200}?\\.query\\(`));
    }
  });
});

// ─── Acesso por ferramenta e por papel ───────────────────────────────────────

describe("acesso: por ferramenta e por papel (extra, TL de outra cidade, supervisor, admin)", () => {
  const EXPECTED: Record<string, Record<Who, boolean>> = {
    parcerias_resumo: { extra: false, tlPorto: true, supervisor: true, admin: true },
    despesas_resumo: { extra: false, tlPorto: true, supervisor: true, admin: true },
    pressao_explicar: { extra: false, tlPorto: true, supervisor: true, admin: true },
    tempos_resumo: { extra: false, tlPorto: true, supervisor: true, admin: true },
    avaliacao_minha: { extra: true, tlPorto: true, supervisor: true, admin: true },
    criticas_por_responder: { extra: false, tlPorto: true, supervisor: true, admin: true },
    formacao_progresso: { extra: true, tlPorto: true, supervisor: true, admin: true },
    extras_dia_situacao: { extra: false, tlPorto: true, supervisor: true, admin: true },
  };

  for (const name of MPV_DATA_TOOL_NAMES) {
    it(`${name}: quem pode usar (recusada → "Sem acesso", sem chamar nada)`, async () => {
      for (const who of Object.keys(PEOPLE) as Who[]) {
        const ctx = PEOPLE[who]();
        const ok = EXPECTED[name][who];
        expect(availableTools(MPV_STAFF_TOOLS, ctx).map((t) => t.name).includes(name), `${who}`).toBe(ok);
        // Quem tem várias cidades tem de dizer qual nas do Extras Dia (como no ecrã).
        const needsCity = who === "admin" && CITY_TOOLS.has(name);
        if (needsCity) expect((await runTool(ctx, name)).result).toEqual({ error: "Indica a cidade (Lisboa, Porto ou Faro)." });
        const { result } = await runTool(ctx, name, needsCity ? { cidade: "Lisboa" } : {});
        if (!ok) {
          expect(result, who).toEqual({ error: TOOL_REFUSED_ERROR });
          expect(ctx.call, who).not.toHaveBeenCalled();
        } else {
          expect(result.error, `${who}: ${JSON.stringify(result).slice(0, 200)}`).toBeUndefined();
        }
      }
    });
  }

  it("TL de outra cidade: pedir Lisboa → \"Não tens acesso aos dados de Lisboa.\" sem chamar o servidor; sem cidade → a dele (Porto)", async () => {
    for (const name of MPV_DATA_TOOL_NAMES.filter((n) => n !== "avaliacao_minha")) {
      const ctx = PEOPLE.tlPorto();
      const { result } = await runTool(ctx, name, { cidade: "Lisboa" });
      expect(result, name).toEqual({ error: "Não tens acesso aos dados de Lisboa." });
      expect(ctx.call, name).not.toHaveBeenCalled();
    }
    const ctx = PEOPLE.tlPorto();
    await runTool(ctx, "extras_dia_situacao");
    expect((ctx.call as any).mock.calls.find((c: any[]) => c[0] === "extrasDia.staffing")[1]).toEqual({ date: "2026-10-16", city: "porto" });
    const crit = PEOPLE.tlPorto();
    await runTool(crit, "criticas_por_responder", { cidade: "Porto" });
    expect((crit.call as any).mock.calls.find((c: any[]) => c[0] === "reviews.list")[1]).toEqual({ projectId: 20 });
    // Parcerias: só os parques da cidade pedida.
    const par = await runTool(PEOPLE.tlPorto(), "parcerias_resumo", { cidade: "Porto" });
    expect(par.result.cidade).toBe("Porto");
  });

  it("parcerias_resumo: euros e taxas só a quem o servidor deixa ver os totais (e tapados aqui também)", async () => {
    const tl = await runTool(PEOPLE.tlPorto(), "parcerias_resumo");
    expect(tl.result.totaisVisiveis).toBe(false);
    expect(tl.json).not.toMatch(/valorEsteMes|nossoEsteMes|taxasPorMarcaECidade|percentagem/);
    expect(tl.result.porModeloDeCobranca).toMatchObject({ "comissão sobre a receita": expect.any(Number) });
    // O servidor diz "sem totais" mas mandou valores por engano → não saem na mesma.
    const leaky = fakeServer({ totals: true });
    const call = vi.fn(async (p: string, i?: any) => ({ ...(await leaky.call(p, i)), canSeeTotals: false }));
    const leak = await runTool({ ...PEOPLE.tlPorto(), call } as StaffToolCtx, "parcerias_resumo");
    expect(leak.json).not.toMatch(/valorEsteMes|taxasPorMarcaECidade|"percentagem"/);
    const adm = await runTool(PEOPLE.admin(), "parcerias_resumo");
    expect(adm.result.totaisVisiveis).toBe(true);
    const first = (adm.result.lista as any[])[0];
    expect(first).toMatchObject({ valorEsteMes: 1000, nossoEsteMes: 150 });
    expect(first.taxasPorMarcaECidade).toEqual(expect.arrayContaining([expect.objectContaining({ marca: "airpark", cidade: "Lisboa", percentagem: 15 })]));
  });

  it("despesas_resumo: os totais em euros só com o canSeeTotals do servidor (a regra do ecrã); as canceladas à parte", async () => {
    const tl = await runTool(PEOPLE.tlPorto(), "despesas_resumo");
    expect(tl.result.totais).toMatch(/^Sem acesso aos totais/);
    expect(tl.json).not.toMatch(/"valor"|"total"|"pago"|"emAtraso"/);
    expect(tl.result.registos).toBeGreaterThan(0);
    const sup = await runTool(PEOPLE.supervisor(), "despesas_resumo", { de: "2026-10-01", ate: "2026-10-15" });
    expect(sup.result.totais).toMatchObject({ total: 301.5, pendente: 100.5, pago: 100.5, emAtraso: 100.5, canceladasAParte: 0 });
    expect(sup.result.canceladas).toBe(0);
    // Com uma cancelada: fica fora do total e conta à parte.
    const many = await runTool(ctxFor("admin", ALL, fakeServer({ totals: true, many: true }), true), "despesas_resumo");
    expect(many.result.canceladas).toBe(15);
    expect((many.result.totais as any).canceladasAParte).toBe(1507.5);
    expect((many.result.totais as any).total).toBe(4522.5);
    const admCtx = PEOPLE.admin();
    await runTool(admCtx, "despesas_resumo", { estado: "pending", cidade: "Porto" });
    expect((admCtx.call as any).mock.calls.find((c: any[]) => c[0] === "expenses.list")[1]).toEqual({ startDate: "2026-10-01", endDate: "2026-10-15", projectId: 20, status: "pending" });
    // Nunca fornecedores, NIF, notas nem quem lançou.
    for (const s of ["Fornecedor", "123456789", SECRETS.iban, SECRETS.people[2]]) expect(sup.json, s).not.toContain(s);
  });

  it("um extra que pede os totais financeiros → \"Sem acesso\", gastando no máximo 1 ronda", async () => {
    const ctx = PEOPLE.extra();
    const p = createFakeProvider("gemini", [
      { ...okResponse(""), toolCalls: [{ id: "a", name: "financeiro_totais", args: {} }, { id: "b", name: "despesas_resumo", args: {} }], raw: { role: "model", parts: [] } } as ProviderResponse,
      okResponse("Sem acesso: não tens acesso aos totais financeiros."),
    ]);
    setAiProvidersForTests({ gemini: p });
    const r = await askAssistant({ question: "Quanto gastámos e faturámos este mês?" }, ctx, NO_HOOKS);
    expect(r).toMatchObject({ ok: true, toolsUsed: [], toolsRefused: ["financeiro_totais", "despesas_resumo"] });
    expect(p.calls.length).toBeLessThanOrEqual(2);
    expect(ctx.call).not.toHaveBeenCalled();
    const results = JSON.stringify(p.calls.at(-1)!.toolRounds?.map((x: any) => x.results));
    expect(results).toContain(TOOL_REFUSED_ERROR);
  });
});

// ─── Dados pessoais ──────────────────────────────────────────────────────────

describe("dados pessoais nos resultados (redação única do turno)", () => {
  it("dois \"João\" diferentes no extras_dia_situacao → a resposta mostra os dois nomes completos certos", async () => {
    const ctx = PEOPLE.supervisor();
    const p = createFakeProvider("gemini", [
      { ...okResponse(""), toolCalls: [{ id: "a", name: "extras_dia_situacao", args: { data: "2026-10-16", cidade: "Lisboa" } }], raw: { role: "model", parts: [] } } as ProviderResponse,
      async (req: any) => {
        const res = JSON.stringify(req.toolRounds?.map((x: any) => x.results));
        // O fornecedor vê marcadores: [NOME_1] é o primeiro a aparecer, [NOME_2] o segundo.
        expect(res).toContain("[NOME_1]");
        expect(res).toContain("[NOME_2]");
        return okResponse("Às 8h falta 1: chama o [NOME_1]. Confirmado: o [NOME_2].");
      },
    ]);
    setAiProvidersForTests({ gemini: p });
    const r = await askAssistant({ question: "Como está o dia de amanhã?", path: "/extras-dia" }, ctx, NO_HOOKS);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    // Os marcadores numeram-se pela ordem em que aparecem no resultado: o da falta (João Pereira) e o da escala (João Silva).
    expect(r.answer).toBe("Às 8h falta 1: chama o João Pereira. Confirmado: o João Silva.");
    const sent = JSON.stringify(p.calls.map((c) => ({ parts: c.parts, rounds: c.toolRounds?.map((x) => x.results) })));
    for (const name of ["João Silva", "João Pereira", "Maria Antunes Costa"]) expect(sent, name).not.toContain(name);
  });

  it("dois emails diferentes (na pergunta e num resultado) voltam cada um ao seu sítio", async () => {
    const ctx = PEOPLE.supervisor();
    const p = createFakeProvider("gemini", [
      { ...okResponse(""), toolCalls: [{ id: "a", name: "criticas_por_responder", args: {} }], raw: { role: "model", parts: [] } } as ProviderResponse,
      okResponse("Responde a [EMAIL_1]; o cliente da crítica escreveu [EMAIL_2]."),
    ]);
    setAiProvidersForTests({ gemini: p });
    const r = await askAssistant({ question: "Que críticas faltam? Manda o resumo para ana@x.pt" }, ctx, NO_HOOKS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answer).toBe(`Responde a ana@x.pt; o cliente da crítica escreveu ${SECRETS.email}.`);
    const sent = JSON.stringify(p.calls.map((c) => ({ parts: c.parts, rounds: c.toolRounds?.map((x) => x.results) })));
    expect(sent).not.toContain("ana@x.pt");
    expect(sent).not.toContain(SECRETS.email);
    expect(sent).toContain("[EMAIL_1]");
    expect(sent).toContain("[EMAIL_2]");
  });

  it("o fornecedor (o falso) nunca vê nomes completos de colaboradores, emails, telefones, IBAN, NIF nem matrículas — com as 8 ferramentas", async () => {
    const ctx = PEOPLE.admin();
    const all = MPV_DATA_TOOL_NAMES.map((name, i) => ({ id: `t${i}`, name, args: lisboaIfNeeded(name) }));
    const rounds = [all.slice(0, MAX_TOOL_CALLS_PER_ROUND), all.slice(MAX_TOOL_CALLS_PER_ROUND)];
    const p = createFakeProvider("gemini", [
      ...rounds.map((calls) => ({ ...okResponse(""), toolCalls: calls, raw: { role: "model", parts: [] } }) as ProviderResponse),
      okResponse("Resumo feito."),
    ]);
    setAiProvidersForTests({ gemini: p });
    const r = await askAssistant({ question: "Dá-me o ponto da situação." }, ctx, NO_HOOKS);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect([...r.toolsUsed].sort()).toEqual([...MPV_DATA_TOOL_NAMES].sort());
    const sent = JSON.stringify(p.calls.map((c) => ({ parts: c.parts, rounds: c.toolRounds?.map((x) => x.results) })));
    for (const s of [...SECRETS.people, SECRETS.email, SECRETS.phone, SECRETS.iban, "123456789", SECRETS.plate]) expect(sent, s).not.toContain(s);
    // Avaliador só pelo 1.º nome; colegas com marcador.
    expect(sent).toContain('"avaliador":"Maria"');
    expect(sent).toMatch(/\[NOME_\d+\]/);
  });

  it("criticas_por_responder: sem as que não são críticas nem as repetidas; texto curto; nada de email/matrícula do registo", async () => {
    const { result, json } = await runTool(PEOPLE.supervisor(), "criticas_por_responder");
    const ids = (result.ultimas as any[]).map((x) => x.id);
    expect(ids).not.toContain(2);
    expect(ids).not.toContain(3);
    expect(ids).not.toContain(4); // respondida à mão
    expect(result.porResponder).toBe(2);
    const first = (result.ultimas as any[])[0];
    expect(first.id).toBe(1);
    expect(first.avaliador).toBe("Maria");
    expect(String(first.texto).length).toBeLessThanOrEqual(200);
    expect(first.texto).toContain("[MATRICULA_1]");
    for (const s of [SECRETS.email, SECRETS.plate, SECRETS.phone, "Candidato", "Repetido"]) expect(json, s).not.toContain(s);
  });

  it("formacao_progresso: o próprio para todos; a equipa (com [NOME_n]) só para quem a acompanha", async () => {
    const extra = PEOPLE.extra();
    const a = await runTool(extra, "formacao_progresso");
    expect(a.result.minha).toMatchObject({ percursos: [expect.objectContaining({ progressoPct: 50, emFalta: ["Recolha de um carro"] })] });
    expect(a.result.equipa).toBeUndefined();
    expect((extra.call as any).mock.calls.map((c: any[]) => c[0])).toEqual(["training.myTraining"]);
    const tl = await runTool(PEOPLE.tlPorto(), "formacao_progresso");
    expect((tl.result.equipa as any).ambito).toBe("a tua equipa");
    expect((tl.result.equipa as any).maisAtrasados.map((x: any) => x.nome)).toEqual(["[NOME_1]", "[NOME_2]"]);
    expect(tl.redact.restore("[NOME_1] e [NOME_2]")).toBe("João Silva e João Pereira");
  });
});

// ─── Cada ferramenta, o que devolve ──────────────────────────────────────────

describe("o que cada ferramenta devolve", () => {
  it("pressao_explicar: o percentil da cidade, a amostra (fiável ou não), a média por hora e a janela", async () => {
    const lx = await runTool(PEOPLE.supervisor(), "pressao_explicar", { dia: "sexta", hora: 9 });
    expect(lx.result).toMatchObject({
      cidade: "Lisboa", percentilDaCidade: "p75", amostraMinima: 5, janela: { de: "2026-08-15", ate: "2026-10-13", dias: 60 }, diaDaSemana: "sexta-feira",
      celula: { hora: "09h", carrosPorHoraMedia: 8, tempoPorCarro: { percentil: "p75", minutos: 38, amostra: 30, fiavel: true } },
    });
    const low = await runTool(PEOPLE.supervisor(), "pressao_explicar", { dia: "2026-10-16", hora: 10 });
    expect((low.result.celula as any).tempoPorCarro.fiavel).toBe(false);
    const day = await runTool(PEOPLE.supervisor(), "pressao_explicar", { dia: 5 });
    expect((day.result.horas as any[]).find((x) => x.hora === "18h").apertada).toMatch(/muito movimento/);
    // Porto usa o p60 (o valor do p60, não o do p75).
    const porto = await runTool(PEOPLE.tlPorto(), "pressao_explicar", { dia: 5, hora: 9 });
    expect(porto.result).toMatchObject({ percentilDaCidade: "p60", usaTemposMedidos: true, celula: { tempoPorCarro: { percentil: "p60", minutos: 41, amostra: 4, fiavel: false } } });
    expect(weekdayArg("domingo")).toBe(7);
    expect(() => weekdayArg("ontem")).toThrow();
  });

  it("tempos_resumo: só o que o servidor mandou (portão do GPS): o escondido fica dito, sem números", async () => {
    const r = await runTool(PEOPLE.supervisor(), "tempos_resumo");
    expect(r.result.fonte).toMatch(/Pressão/);
    expect(r.result.escondidos).toEqual({ transito: expect.stringMatching(/calibração/) });
    expect(Object.keys(r.result.temposDasEntregas as object)).toEqual(["fila", "total"]);
    expect((r.result.temposDasEntregas as any).fila).toMatchObject({ casos: 50, mediaMin: 9, piorCelula: { celula: "5:18", p75Min: 15, casos: 30 } });
    const cell = await runTool(PEOPLE.supervisor(), "tempos_resumo", { dia: "sexta", hora: 9 });
    expect((cell.result.temposDasEntregas as any).fila).toMatchObject({ casos: 20, mediaMin: 6 });
    // A semana (Atividade diária) — supervisor tem; com o portão da semana.
    const wk = await runTool(PEOPLE.supervisor(), "tempos_resumo", { semana: "2026-10-14" });
    expect(wk.result).toMatchObject({ fonte: expect.stringMatching(/Semana/), semana: "2026-10-11", escondidos: { cliente: "Em calibração." } });
    expect(summarizeTimesGrid({ cells: {}, hidden: {} })).toMatchObject({ entregas: 0, temposDasEntregas: {} });
  });

  it("avaliacao_minha: evaluation.mine + as regras em vigor (sem IA): dias com mais negativos e as regras desses pontos primeiro", async () => {
    const ctx = PEOPLE.extra();
    const { result } = await runTool(ctx, "avaliacao_minha");
    expect((ctx.call as any).mock.calls.map((c: any[]) => c[0])).toEqual(["evaluation.mine"]);
    expect(result).toMatchObject({ pontos: { total: 150, negativos: -25 }, contestacoes: { abertas: 1, total: 1 } });
    expect((result.diasComMaisNegativos as any[])[0]).toMatchObject({ dia: "2026-10-03", negativos: -15, regras: ["Excesso de velocidade ×1", "Atraso ao trabalho (≥ 5 min) ×1"] });
    const rules = result.regras as string[];
    expect(rules.length).toBeGreaterThan(2);
    expect(rules[0]).toMatch(/Excesso de velocidade|Recolha ou entrega/);
    for (const t of rules) expect(RULES_DOCS.avaliacao.rules.map((x) => x.text)).toContain(t);
    expect(evaluationRulesFor([], 10_000).length).toBe(RULES_DOCS.avaliacao.rules.length);
    expect(JSON.stringify(result)).not.toContain(SECRETS.phone);
  });

  it("extras_dia_situacao: cobertura, faltas (com quem está disponível), sobras, horas apertadas e quem respondeu (só desta cidade)", async () => {
    const { result } = await runTool(PEOPLE.supervisor(), "extras_dia_situacao", { data: "2026-10-16" });
    expect(result).toMatchObject({
      data: "2026-10-16", cidade: "Lisboa",
      cobertura: { horasComPrevisao: 3, horasCobertas: 2, pct: 67, picoNecessario: 2 },
      faltas: [{ de: "08h", ate: "09h", faltam: 1, nomes: ["[NOME_1]"] }],
      sobras: [{ de: "18h", ate: "19h", aMais: 2 }],
      escala: { estado: "proposed", confirmados: 1, propostos: 1, teamLeaders: 1 },
      respostas: { "disponível": 2, "indisponível": 1, "sem resposta": 1, semRespostaAosPedidos: 4 },
      avisos: { sent: 1, failed: 1 },
    });
    expect((result.horasApertadas as any[]).map((x) => x.hora)).toContain("18h");
    // Os disponíveis por escalar: o João Pereira (o João Silva já está na escala); o do Porto não entra.
    expect((result.respostas as any).disponiveisPorEscalar.nomes).toEqual(["[NOME_1]"]);
    expect(JSON.stringify(result)).not.toContain("Pessoa do Porto");
  });
});

// ─── Teto do resultado ───────────────────────────────────────────────────────

describe("teto do resultado (~4 000 caracteres)", () => {
  it("fitToolResult corta listas e textos grandes e marca \"cortado\"", () => {
    const big = { lista: Array.from({ length: 500 }, (_, i) => ({ nome: `Linha ${i}`, texto: "x".repeat(50) })), nota: "y".repeat(3000) };
    const out = fitToolResult(big);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(3600);
    expect(out.cortado).toMatch(/encurtado/);
    expect(fitToolResult({ a: 1 })).toEqual({ a: 1 });
  });

  it("com muitas linhas, cada ferramenta cabe no teto depois da redação", async () => {
    for (const name of MPV_DATA_TOOL_NAMES) {
      const ctx = ctxFor("admin", ALL, fakeServer({ totals: true, many: true }), true);
      const { json } = await runTool(ctx, name, lisboaIfNeeded(name));
      expect(json.length, name).toBeLessThanOrEqual(MPV_TOOL_RESULT_MAX_CHARS);
    }
  });
});

// ─── Perfis (F3) ─────────────────────────────────────────────────────────────

describe("perfis: as planeadas saíram e as perguntas voltam pelo needs", () => {
  it("PLANNED_TOOLS sem as da F4; todos os needs e ferramentas dos perfis existem no MPV", () => {
    for (const n of MPV_DATA_TOOL_NAMES) expect(PLANNED_TOOLS).not.toContain(n);
    const mpv = new Set(MPV_STAFF_TOOLS.map((t) => t.name));
    for (const p of allMultisProfiles()) {
      for (const q of p.questions) if (q.needs) expect(mpv.has(q.needs), `${p.key}: ${q.needs}`).toBe(true);
    }
  });

  it("Parcerias e Formação voltam a falar dos dados reais; o Dashboards \"porque mudou\" precisa do reservas_resumo", () => {
    expect(multisProfileFor({ page: "parcerias" }).role).toMatch(/dados reais/);
    expect(multisProfileFor({ page: "formacao" }).role).toMatch(/dados reais/);
    const dash = MULTIS_PROFILE_RULES.find((r) => r.group === "Dashboards")!.profile;
    expect(dash.questions.find((q) => q.text.startsWith("Porque é que este valor mudou"))?.needs).toBe("reservas_resumo");
    // Quem não tem as reservas não vê a pergunta; quem tem, vê.
    expect(mpvSuggestions("/dashboards", null, ctxFor("extra", LISBOA)) ?? []).not.toContain("Porque é que este valor mudou face à semana passada?");
    expect(mpvSuggestions("/dashboards", null, ctxFor("admin", ALL))).toContain("Porque é que este valor mudou face à semana passada?");
    expect(mpvSuggestions("/criticas", null, ctxFor("team_leader", PORTO))).toContain("Quantas críticas estão por responder?");
    expect(mpvSuggestions("/formacao", null, ctxFor("extra", LISBOA))).toContain("O que me falta para acabar a formação?");
  });

  it("a ajuda do Multis tem uma linha por ferramenta nova (secção do piloto)", () => {
    const md = src("docs/ajuda/multis.md");
    const head = "\n**Dados que o Multis lê (piloto)**\n";
    const i = md.indexOf(head);
    expect(i).toBeGreaterThan(0);
    const rest = md.slice(i + head.length);
    const end = rest.search(/^(\*\*[^*\n]+\*\*\s*|#{2,3} .*)$/m);
    const section = end < 0 ? rest : rest.slice(0, end);
    expect(section.split("\n").filter((l) => l.startsWith("- **")).length).toBe(MPV_DATA_TOOL_NAMES.length);
  });
});
