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
// O indicador de pessoal a sério (getStaffingReport → loadEligibleExtras) com as leituras falsas por baixo.
const st = vi.hoisted(() => ({ candidates: [] as any[], rows: [] as any[], cities: new Map<number, { city: string | null }>() }));
vi.mock("../extrasDia", () => ({
  getExtrasDiaForecast: async () => ({ hourly: Array.from({ length: 27 }, (_, h) => ({ hour: h, driversNeeded: h >= 8 && h < 12 ? 2 : 0 })) }),
  listAssignments: async (_date: string, city?: string) => st.rows.filter((r) => !city || r.city === city),
  listDriverCandidates: async () => st.candidates,
}));
vi.mock("../trainingPaths", () => ({ employeesMissingTraining: async () => new Set<number>() }));
vi.mock("../employeeCity", () => ({ resolveCitiesForEmployeeIds: async (ids: number[]) => new Map(ids.map((id) => [id, st.cities.get(id) ?? { city: null }])) }));

import type { CityAccess } from "../cityAccess";
import { getStaffingReport } from "../extrasDiaShift";
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
import {
  CUT_NOTE, MPV_DATA_TOOLS, MPV_DATA_TOOL_NAMES, MPV_TOOL_RESULT_MAX_CHARS, SLOW_CALL_MESSAGE, cutText, evaluationRulesFor, fitToolResult, resetSlowCallsForTests,
  summarizeTimesGrid, weekdayArg,
} from "./mpvDataTools";
import { mpvSuggestions } from "./mpv";
import { CACHE_HINT, SLOW_PROJECTIONS, readAtLabel } from "./mpvDataTools";
import { LATE_CACHE_MAX, SLOW_CALL_INFLIGHT_MAX_MS, SLOW_CALL_LATE_CACHE_MS, SlowCallTimeout, forgetSlowCallsOf, slowCallSizesForTests, slowRead } from "./slowCallCache";
import { publicProcedure, router as trpcRouter } from "../_core/trpc";

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
  resetSlowCallsForTests();
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setAiProvidersForTests(null);
  resetSlowCallsForTests();
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
  /** Avaliação com 8 dias negativos e regras longas. */
  bigEval?: boolean;
  /** Os procedimentos lentos (pressure, weekActivity) nunca respondem. */
  hang?: boolean;
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
    if (opts.hang && (path === "extrasDia.pressure" || path === "multipark.weekActivity")) return new Promise(() => {});
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
        days: opts.bigEval
          ? Array.from({ length: 8 }, (_, i) => ({
            day: `2026-10-0${i + 1}`,
            score: { totalPoints: -10 - i, negativePoints: -20 - i, lines: ["Excesso de velocidade", "Atraso ao trabalho (≥ 5 min)", "Reclamação confirmada", "Acidente ou dano/risco"].map((label) => ({ label: `${label} — ${"descrição longa ".repeat(4)}`, count: 1, subtotal: -5 })) },
          }))
          : [
            { day: "2026-10-03", score: { totalPoints: -5, negativePoints: -15, lines: [{ label: "Excesso de velocidade", count: 1, subtotal: -10 }, { label: "Atraso ao trabalho (≥ 5 min)", count: 1, subtotal: -5 }] } },
            { day: "2026-10-04", score: { totalPoints: 20, negativePoints: 0, lines: [] } },
          ],
        disputes: [{ id: 1, status: "open", note: `liga para ${SECRETS.phone}` }],
      };
      case "reviews.stats": return { total: 40, avg: 4.3, star1: 2, star2: 1, star3: 3, star4: 10, star5: 24, unrated: 0, pending: 3, responded: 35, complaints: 2 };
      case "reviews.list": return [
        { id: 1, projectId: 10, rating: 1, status: "new", respondedAt: null, complaintId: null, notAReview: 0, duplicateOf: null, reviewDate: "2026-10-14 10:00:00", createdAt: "2026-10-14", reviewerName: "Maria Antunes Costa", reviewerEmail: SECRETS.email, vehiclePlate: SECRETS.plate, reviewText: `Péssimo, o carro ${SECRETS.plate} veio sujo. Liguem para ${SECRETS.phone} ou ${SECRETS.email}. ${"Muito mau. ".repeat(40)}`, locationTitle: "Airpark Lisboa", aiResponse: "Lamentamos…" },
        { id: 2, projectId: 10, rating: 5, status: "new", respondedAt: null, complaintId: null, notAReview: 1, duplicateOf: null, reviewDate: "2026-10-13", reviewerName: "Candidato", reviewText: "Envio o meu CV" },
        { id: 3, projectId: 10, rating: 5, status: "new", respondedAt: null, complaintId: null, notAReview: 0, duplicateOf: 1, reviewDate: "2026-10-13", reviewerName: "Repetido", reviewText: "Repetida" },
        { id: 4, projectId: 10, rating: 4, status: "manually_responded", respondedAt: null, complaintId: null, notAReview: 0, duplicateOf: null, reviewDate: "2026-10-12", reviewerName: "Ana", reviewText: "Bom" },
        // Lixo: sem parque nem marca (fica fora, como no ecrã).
        { id: 5, projectId: null, locationTitle: null, rating: 5, status: "new", respondedAt: null, complaintId: null, notAReview: 0, duplicateOf: null, reviewDate: "2026-10-15", reviewerName: "Lixo", reviewText: "Recebeu 3 críticas novas" },
        ...Array.from({ length: opts.many ? 40 : 1 }, (_, i) => ({ id: 10 + i, projectId: 10, rating: 5, status: "new", respondedAt: null, complaintId: null, notAReview: 0, duplicateOf: null, reviewDate: `2026-10-0${(i % 9) + 1}`, reviewerName: "Rui Gomes Lopes", reviewText: "Excelente serviço" })),
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
      case "projects.list": return [{ id: 10, name: "Lisboa", level: "city" }, { id: 20, name: "Porto", level: "city" }];
      // extrasDia.candidates NÃO: conta toda a gente (backoffice, sem cidade); a ferramenta usa os números do ecrã.
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
    // Cada uma declara os seus campos com dados pessoais (mesmo que vazio) e redige-os ela própria ANTES de cortar.
    for (const t of MPV_DATA_TOOLS) {
      expect(t.pii, t.name).toBeDefined();
      expect(t.selfRedacts, t.name).toBe(true);
    }
    // A avaliacao_minha mantém as definições que a minha_avaliacao (v1) dava ao modelo.
    const desc = MPV_DATA_TOOLS.find((t) => t.name === "avaliacao_minha")!.description;
    for (const bit of ["movimentos (levar ao parque e entre garagens)", "mudanças de lugar (mesma garagem: não são movimentos)", "entrada 5 min ou mais depois da hora da escala ou do horário"]) expect(desc).toContain(bit);
    // Horas apertadas: a mesma função do ecrã.
    expect(src("server/assistant/mpvDataTools.ts")).toMatch(/tightHoursForDay\(slots, date, hours\.map/);
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
      "extrasDia.staffing", "extrasDia.assignments", "extrasDia.schedule", "projects.list",
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
    expect(adm.result.nota).toMatch(/todas as tuas cidades juntas/);
  });

  it("parcerias_resumo com cidade: sem as reservas nem os euros do parceiro (são de todas as cidades); as taxas só dessa cidade", async () => {
    const r = await runTool(PEOPLE.admin(), "parcerias_resumo", { cidade: "Porto" });
    expect(r.result.cidade).toBe("Porto");
    const rows = r.result.lista as any[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.reservasEsteMes, row.nome).toBeUndefined();
      expect(row.reservas12Meses).toBeUndefined();
      expect(row.valorEsteMes).toBeUndefined();
      expect(row.nossoEsteMes).toBeUndefined();
      expect(row.parques).toBe(1);
      for (const t of row.taxasPorMarcaECidade) expect(t.cidade).toBe("Porto");
    }
    expect(r.result.nota).toMatch(/de todas as cidades juntas e por isso não vêm aqui/);
    // Sem cidade: vêm, ditas como de todas as cidades.
    const all = await runTool(PEOPLE.admin(), "parcerias_resumo");
    expect((all.result.lista as any[])[0].reservasEsteMes).toBeGreaterThan(0);
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
    for (const s of [SECRETS.email, SECRETS.plate, SECRETS.phone, "Candidato", "Repetido", "Lixo"]) expect(json, s).not.toContain(s);
  });

  it("criticas_por_responder: UM só \"por responder\", o da lista pedida (cidade/estrelas), sem lixo; o geral sem esse número", async () => {
    const all = await runTool(PEOPLE.supervisor(), "criticas_por_responder");
    expect(all.result.porResponder).toBe((all.result.ultimas as any[]).length);
    expect((all.result.ultimas as any[]).map((x) => x.id)).not.toContain(5); // sem parque nem marca
    expect(all.json.match(/porResponder"/g)?.length).toBe(1);
    expect(all.result.geral).toMatchObject({ criticas: 40, media: 4.3, respondidas: 35 });
    expect((all.result.geral as any).porResponder).toBeUndefined();
    const ctx = PEOPLE.supervisor();
    const one = await runTool(ctx, "criticas_por_responder", { estrelas: 1 });
    expect((ctx.call as any).mock.calls.find((c: any[]) => c[0] === "reviews.list")[1]).toEqual({ rating: 1 });
    expect(one.result.geralSemFiltroDeEstrelas).toBeDefined();
    expect(one.result.geral).toBeUndefined();
  });

  it("PII cortada só DEPOIS da redação: um email e um telefone no limite do corte não escapam pela metade", async () => {
    for (const pad of [150, 160, 165, 170, 175]) {
      const text = `${"a".repeat(pad)} joao.silva@gmail.com e 912 345 678 fim`;
      const srv = fakeServer();
      const call = vi.fn(async (p: string, i?: any) => (p === "reviews.list"
        ? [{ id: 1, projectId: 10, rating: 2, status: "new", respondedAt: null, complaintId: null, notAReview: 0, duplicateOf: null, reviewDate: "2026-10-14", reviewerName: "Ana", reviewText: text }]
        : srv.call(p, i)));
      const { json, redact } = await runTool({ ...PEOPLE.supervisor(), call } as StaffToolCtx, "criticas_por_responder");
      for (const part of ["joao", "silva@", "gmail", "912 345", "912", "345 678"]) expect(json, `${pad}: ${part}`).not.toContain(part);
      const texto = String((JSON.parse(json).ultimas as any[])[0].texto);
      expect(texto.length, String(pad)).toBeLessThanOrEqual(181);
      // Um marcador nunca fica partido: ou inteiro (e repõe-se) ou fora.
      expect(texto).not.toMatch(/\[[A-Z]*_?\d*…$/);
      expect(redact.restore(texto)).not.toMatch(/\[(EMAIL|TELEFONE)_/);
    }
    expect(cutText("abc [EMAIL_12] fim", 9)).toBe("abc…");
    expect(cutText("abc [EMAIL_1] fim", 13)).toBe("abc [EMAIL_1]…");
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

  it("formacao_progresso: sem centro de custos dá na mesma a formação própria (como o ecrã); certificados expirados à parte dos a expirar", async () => {
    const noCc: CityAccess = { ...LISBOA, missingCostCenter: true };
    const ctx = ctxFor("team_leader", noCc, fakeServer());
    const r = await runTool(ctx, "formacao_progresso");
    expect(r.result.error).toBeUndefined();
    expect(r.result.minha).toMatchObject({ percursos: [expect.objectContaining({ progressoPct: 50 })], certificados: { validos: 1, aExpirar: 0, expirados: 0 } });
    expect(r.result.equipa).toMatchObject({ indisponivel: expect.stringMatching(/centro de custos/) });
    expect((ctx.call as any).mock.calls.map((c: any[]) => c[0])).toEqual(["training.myTraining"]);
    // Equipa: expirados e a expirar separados.
    const srv = fakeServer();
    const call = vi.fn(async (p: string, i?: any) => (p === "training.dashboard"
      ? { ...(await srv.call(p, i)), certificates: [{ state: "expired" }, { state: "expired" }, { state: "expiring" }] }
      : srv.call(p, i)));
    const tl = await runTool({ ...PEOPLE.tlPorto(), call } as StaffToolCtx, "formacao_progresso");
    expect(tl.result.equipa).toMatchObject({ certificadosExpirados: 2, certificadosAExpirar: 1 });
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

  it("tempos_resumo: cobertura só dos tempos visíveis; pior célula só com amostra ≥ MIN_SAMPLE", () => {
    const s = summarizeTimesGrid({
      cells: {
        "1:9": { m: { fila: { n: 2, p50Ms: 0, p75Ms: 3_600_000, meanMs: 3_000_000 } } },
        "1:10": { m: { fila: { n: 10, p50Ms: 0, p75Ms: 600_000, meanMs: 480_000 } } },
      },
      hidden: { transito: "Em calibração." }, coverage: { fila: 90, transito: 40 }, deliveries: 12, pickups: 0,
    });
    expect(s.coberturaPct).toEqual({ fila: 90 });
    expect((s.temposDasEntregas as any).fila.piorCelula).toEqual({ celula: "1:10", p75Min: 10, casos: 10 });
  });

  it("tempos_resumo: declara-se a quem tem um dos modos; cada modo verifica o seu acesso", async () => {
    const tl = PEOPLE.tlPorto();
    expect(availableTools(MPV_STAFF_TOOLS, tl).map((t) => t.name)).toContain("tempos_resumo");
    // Só a Atividade diária (sem Extras Dia) → a semana; pedir a Pressão não dá Pressão.
    const onlyWeek = ctxFor("supervisor", LISBOA, fakeServer());
    (onlyWeek.user as any).accessOverrides = { extras_dia: { access: "none", actions: [] } };
    const r = await runTool(onlyWeek, "tempos_resumo", { dia: "sexta" });
    expect(r.result.error, JSON.stringify(r.result)).toBeUndefined();
    expect(r.result.fonte).toMatch(/Semana/);
    expect((onlyWeek.call as any).mock.calls.map((c: any[]) => c[0])).toEqual(["multipark.weekActivity"]);
    // Nenhum modo → nem se declara (recusada).
    const none = ctxFor("extra", LISBOA, fakeServer());
    expect((await runTool(none, "tempos_resumo")).result).toEqual({ error: TOOL_REFUSED_ERROR });
  });

  it("leituras lentas com prazo próprio (injetado no ctx): \"demorou demasiado\" em vez de comer as voltas", async () => {
    const quick = (srv = fakeServer({ hang: true })) => ({ ...ctxFor("supervisor", LISBOA, srv), slowCallMs: 20 }) as StaffToolCtx;
    for (const [name, args] of [["pressao_explicar", {}], ["tempos_resumo", {}], ["tempos_resumo", { semana: "2026-10-14" }]] as const) {
      resetSlowCallsForTests();
      const t0 = Date.now();
      const { result } = await runTool(quick(), name, args);
      expect(result, name).toEqual({ error: SLOW_CALL_MESSAGE });
      expect(Date.now() - t0).toBeLessThan(2000);
    }
    // Na situação do Extras Dia a Pressão é só um extra: sem ela, as horas apertadas ficam "indisponível".
    resetSlowCallsForTests();
    const sit = await runTool(quick(), "extras_dia_situacao");
    expect(sit.result.horasApertadas).toBe("indisponível");
    expect(sit.result.cobertura).toBeDefined();
    // O indicador de pessoal e a lista das críticas também têm prazo.
    for (const [path, name] of [["extrasDia.staffing", "extras_dia_situacao"], ["reviews.list", "criticas_por_responder"]] as const) {
      resetSlowCallsForTests();
      const srv = fakeServer();
      const call = vi.fn(async (p: string, i?: any) => (p === path ? new Promise(() => {}) : srv.call(p, i)));
      const { result } = await runTool({ ...quick(), call } as StaffToolCtx, name);
      expect(result, path).toEqual({ error: SLOW_CALL_MESSAGE });
    }
  });

  it("prazo: uma 2.ª leitura igual espera pela 1.ª (single-flight) e o resultado atrasado serve a pergunta seguinte", async () => {
    let release!: (v: unknown) => void;
    const srv = fakeServer();
    const pressure = await srv.call("extrasDia.pressure");
    let pressureCalls = 0;
    const call = vi.fn(async (p: string, i?: any) => {
      if (p !== "extrasDia.pressure") return srv.call(p, i);
      pressureCalls++;
      return new Promise((res) => { release = res; });
    });
    const ctx = { ...ctxFor("supervisor", LISBOA, srv), call, slowCallMs: 30 } as StaffToolCtx;
    // Duas perguntas ao mesmo tempo: UMA leitura; as duas passam o prazo.
    const [a, b] = await Promise.all([runTool(ctx, "pressao_explicar", { dia: 5, hora: 9 }), runTool(ctx, "tempos_resumo")]);
    expect(a.result).toEqual({ error: SLOW_CALL_MESSAGE });
    expect(b.result).toEqual({ error: SLOW_CALL_MESSAGE });
    expect(pressureCalls).toBe(1);
    // Ainda a correr: uma 3.ª pergunta não lança outra leitura.
    await runTool(ctx, "pressao_explicar", { dia: 5, hora: 9 });
    expect(pressureCalls).toBe(1);
    // A leitura chega (tarde): a pergunta seguinte usa-a logo, sem ler outra vez.
    release(pressure);
    await new Promise((r) => setTimeout(r, 5));
    const c = await runTool(ctx, "pressao_explicar", { dia: 5, hora: 9 });
    expect(c.result.error).toBeUndefined();
    expect(c.result).toMatchObject({ percentilDaCidade: "p75", celula: { hora: "09h" } });
    // Dados de uma leitura anterior: com a hora (Lisboa).
    expect(String(c.result.lidoAs)).toMatch(/^\d{2}:\d{2} \(Lisboa\)/);
    expect(pressureCalls).toBe(1);
    // Outra pessoa (ou outras cidades) não aproveita a leitura desta.
    const other = { ...ctx, user: { id: 8, role: "supervisor" } } as StaffToolCtx;
    const d = runTool(other, "pressao_explicar", { dia: 5, hora: 9 });
    await new Promise((r) => setTimeout(r, 1));
    expect(pressureCalls).toBe(2);
    release(pressure);
    const dr = (await d).result;
    expect(dr.error).toBeUndefined();
    expect(dr.lidoAs).toBeUndefined(); // lida agora, a tempo
  });
});

// ─── Cache das leituras lentas ───────────────────────────────────────────────

describe("cache das leituras lentas (dados velhos, totais, memória)", () => {
  /** Uma leitura que só chega quando se manda (para simular "chegou tarde"). */
  const deferred = () => {
    let release!: (v: unknown) => void;
    const promise = new Promise((res) => { release = res; });
    return { promise, release };
  };
  const lateEntry = async (key: string, userId: number, value: unknown = { ok: true }) => {
    const d = deferred();
    await expect(slowRead({ key, userId, ms: 5, read: () => d.promise, project: (x) => x })).rejects.toBeInstanceOf(SlowCallTimeout);
    d.release(value);
    await new Promise((r) => setTimeout(r, 1));
  };

  it("as ferramentas lentas dizem ao modelo que indique a hora («lidoAs»); readAtLabel é a hora de Lisboa", () => {
    for (const name of ["parcerias_resumo", "pressao_explicar", "tempos_resumo", "avaliacao_minha", "criticas_por_responder", "extras_dia_situacao"]) {
      expect(MPV_DATA_TOOLS.find((t) => t.name === name)!.description, name).toContain(CACHE_HINT);
    }
    expect(readAtLabel(Date.parse("2026-10-15T13:05:00Z"))).toBe("14:05");
    expect(readAtLabel(Date.parse("2026-12-15T13:05:00Z"))).toBe("13:05");
  });

  it("se outro chamador recebeu o resultado a tempo, não vai para a cache", async () => {
    const d = deferred();
    const read = vi.fn(() => d.promise);
    const quick = slowRead({ key: "k", userId: 7, ms: 5, read, project: (x) => x });
    const patient = slowRead({ key: "k", userId: 7, ms: 2000, read, project: (x) => x });
    await expect(quick).rejects.toBeInstanceOf(SlowCallTimeout);
    d.release({ v: 1 });
    expect(await patient).toEqual({ data: { v: 1 }, cachedAt: null });
    expect(read).toHaveBeenCalledTimes(1);
    expect(slowCallSizesForTests()).toEqual({ inflight: 0, cached: 0 });
    // Só quem esperou e desistiu: aí sim.
    await lateEntry("k2", 7);
    expect(slowCallSizesForTests().cached).toBe(1);
  });

  it("uma mutação tRPC da pessoa apaga as entradas dela (e só dela); a leitura em curso deixa de ser guardada", async () => {
    await lateEntry("a|7", 7);
    await lateEntry("b|8", 8);
    // Uma em curso da pessoa 7, que chega depois da mutação: não se guarda.
    const d = deferred();
    await expect(slowRead({ key: "c|7", userId: 7, ms: 5, read: () => d.promise, project: (x) => x })).rejects.toBeInstanceOf(SlowCallTimeout);
    expect(slowCallSizesForTests()).toEqual({ inflight: 1, cached: 2 });
    const r = trpcRouter({ mexer: publicProcedure.mutation(() => "feito"), ler: publicProcedure.query(() => "lido") });
    const caller7 = r.createCaller({ user: { id: 7, role: "supervisor" }, req: {} as any, res: {} as any } as any);
    await caller7.ler();
    expect(slowCallSizesForTests().cached).toBe(2); // uma query não apaga nada
    expect(await caller7.mexer()).toBe("feito");
    expect(slowCallSizesForTests()).toEqual({ inflight: 0, cached: 1 });
    d.release({ velho: true });
    await new Promise((res) => setTimeout(res, 1));
    expect(slowCallSizesForTests().cached).toBe(1); // a do 8 fica; a do 7 (antes da mutação) não entra
    forgetSlowCallsOf(8);
    expect(slowCallSizesForTests().cached).toBe(0);
  });

  it("a chave inclui os totais financeiros da pessoa (e a pessoa, mesmo com as mesmas permissões e cidades)", async () => {
    const srv = fakeServer({ totals: true });
    let reads = 0;
    const pending: Array<(v: unknown) => void> = [];
    const call = vi.fn(async (p: string, i?: any) => {
      if (p !== "partnerships.live") return srv.call(p, i);
      reads++;
      const real = await srv.call(p, i);
      return new Promise((res) => pending.push(() => res(real)));
    });
    const base = { ...ctxFor("supervisor", LISBOA, srv), call, slowCallMs: 10 } as StaffToolCtx;
    // Pessoa 7 sem totais: chega tarde → guardada.
    expect((await runTool({ ...base, financeAllowed: false }, "parcerias_resumo")).result).toEqual({ error: SLOW_CALL_MESSAGE });
    pending.splice(0).forEach((f) => f(null));
    await new Promise((r) => setTimeout(r, 2));
    expect(slowCallSizesForTests().cached).toBe(1);
    // A MESMA pessoa com totais: outra chave → outra leitura (não usa a guardada).
    const withTotals = runTool({ ...base, financeAllowed: true }, "parcerias_resumo");
    await new Promise((r) => setTimeout(r, 1));
    expect(reads).toBe(2);
    pending.splice(0).forEach((f) => f(null));
    await withTotals;
    // Outra pessoa com as mesmas permissões e cidades: nem a guardada nem a em curso.
    const p8 = runTool({ ...base, user: { id: 8, role: "supervisor" }, financeAllowed: false }, "parcerias_resumo");
    const p8b = runTool({ ...base, user: { id: 9, role: "supervisor" }, financeAllowed: false }, "parcerias_resumo");
    await new Promise((r) => setTimeout(r, 1));
    expect(reads).toBe(4);
    pending.splice(0).forEach((f) => f(null));
    await Promise.all([p8, p8b]);
    // A pessoa 7 sem totais continua a ter a sua (com a hora).
    const again = await runTool({ ...base, financeAllowed: false }, "parcerias_resumo");
    expect(reads).toBe(4);
    expect(String(again.result.lidoAs)).toMatch(/Lisboa/);
  });

  it("memória: no máximo 20 entradas; as vencidas saem ao escrever; só a projeção; penduradas saem aos 90 s", async () => {
    for (let i = 0; i < LATE_CACHE_MAX + 5; i++) await lateEntry(`m${i}`, 7);
    expect(slowCallSizesForTests().cached).toBe(LATE_CACHE_MAX);
    // Vencidas: 6 min depois, uma escrita limpa as velhas.
    const realNow = Date.now;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + SLOW_CALL_LATE_CACHE_MS + 60_000);
    try {
      await lateEntry("nova", 7);
      expect(slowCallSizesForTests().cached).toBe(1);
    } finally { spy.mockRestore(); }
    // Projeção: o que se partilha e se guarda é só o que a ferramenta usa.
    const ev = SLOW_PROJECTIONS["evaluation.mine"]({ employee: { id: 5, fullName: "Rui Gomes Lopes", phone: "912345678" }, totals: { days: 1, secret: 1 }, days: [], disputes: [{ status: "open", note: "liga 912345678" }] }) as any;
    expect(JSON.stringify(ev)).not.toMatch(/Rui|912345678|secret/);
    expect(ev).toMatchObject({ employee: true, disputes: [{ status: "open" }] });
    const rv = SLOW_PROJECTIONS["reviews.list"]([{ id: 1, reviewerEmail: "a@b.pt", vehiclePlate: "AA-12-BB", reviewText: "x", reviewerName: "Ana" }]) as any[];
    expect(rv[0]).toEqual({ id: 1, reviewText: "x", reviewerName: "Ana" });
    const late = deferred();
    const raw = { employee: { fullName: "Rui Gomes Lopes" }, totals: { days: 2 }, days: [], disputes: [] };
    const ctx = { ...ctxFor("extra", LISBOA, fakeServer()), slowCallMs: 5 } as StaffToolCtx;
    const ctxLate = { ...ctx, call: vi.fn(() => late.promise) } as StaffToolCtx;
    expect((await runTool(ctxLate, "avaliacao_minha")).result).toEqual({ error: SLOW_CALL_MESSAGE });
    late.release(raw);
    await new Promise((r) => setTimeout(r, 1));
    const fromCache = await runTool(ctx, "avaliacao_minha");
    expect(String(fromCache.result.lidoAs)).toMatch(/Lisboa/);
    expect((ctx.call as any)).not.toHaveBeenCalled();
    // Penduradas: uma leitura que nunca acaba sai do mapa aos 90 s.
    vi.useFakeTimers();
    try {
      const hung = slowRead({ key: "pendurada", userId: 7, ms: 10, read: () => new Promise(() => {}), project: (x) => x });
      const caught = hung.catch((e) => e);
      await vi.advanceTimersByTimeAsync(20);
      expect(await caught).toBeInstanceOf(SlowCallTimeout);
      expect(slowCallSizesForTests().inflight).toBeGreaterThanOrEqual(1);
      await vi.advanceTimersByTimeAsync(SLOW_CALL_INFLIGHT_MAX_MS + 10);
      expect(slowCallSizesForTests().inflight).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe("o que cada ferramenta devolve (continuação)", () => {

  it("avaliacao_minha: evaluation.mine + as regras em vigor (sem IA): dias com mais negativos e as regras desses pontos primeiro", async () => {
    const ctx = PEOPLE.extra();
    const { result } = await runTool(ctx, "avaliacao_minha");
    expect((ctx.call as any).mock.calls.map((c: any[]) => c[0])).toEqual(["evaluation.mine"]);
    expect(result).toMatchObject({ pontos: { total: 150, negativos: -25 }, contestacoes: { abertas: 1, total: 1 } });
    expect((result.diasComMaisNegativos as any[])[0]).toMatchObject({ dia: "2026-10-03", negativos: -15, regrasDoDia: ["Excesso de velocidade ×1", "Atraso ao trabalho (≥ 5 min) ×1"] });
    const rules = result.regras as string[];
    expect(rules.length).toBeGreaterThan(2);
    expect(rules[0]).toMatch(/Excesso de velocidade|Recolha ou entrega/);
    for (const t of rules) expect(RULES_DOCS.avaliacao.rules.map((x) => x.text)).toContain(t);
    expect(evaluationRulesFor([], 10_000).length).toBe(RULES_DOCS.avaliacao.rules.length);
    expect(JSON.stringify(result)).not.toContain(SECRETS.phone);
  });

  it("avaliacao_minha grande (8 dias negativos, regras e valores): cabe no teto e devolve os dias (não só a nota do corte)", async () => {
    const { result, json } = await runTool(ctxFor("extra", LISBOA, fakeServer({ bigEval: true })), "avaliacao_minha");
    expect(json.length).toBeLessThanOrEqual(MPV_TOOL_RESULT_MAX_CHARS);
    expect((result.diasComMaisNegativos as any[]).length).toBe(5);
    expect(result.pontos).toMatchObject({ total: 150 });
    expect(Object.keys(result).length).toBeGreaterThan(3);
  });

  it("extras_dia_situacao: cobertura, faltas (com quem está disponível), sobras, horas apertadas e os números do ecrã (sem extrasDia.candidates)", async () => {
    const ctx = PEOPLE.supervisor();
    const { result } = await runTool(ctx, "extras_dia_situacao", { data: "2026-10-16" });
    expect(result).toMatchObject({
      data: "2026-10-16", cidade: "Lisboa",
      cobertura: { horasComPrevisao: 3, horasCobertas: 2, pct: 67, picoNecessario: 2 },
      faltas: [{ de: "08h", ate: "09h", faltam: 1, nomes: ["[NOME_1]"] }],
      sobras: [{ de: "18h", ate: "19h", aMais: 2 }],
      escala: { estado: "proposed", confirmados: 1, propostos: 1, teamLeaders: 1, total: 2 },
      respostas: { disponiveisPorEscalar: 1, pessoas: [{ nome: "[NOME_1]", horas: "08–14" }], semResposta: 4 },
      avisos: { sent: 1, failed: 1 },
    });
    expect((result.horasApertadas as any[]).map((x) => x.hora)).toContain("18h");
    expect((ctx.call as any).mock.calls.map((c: any[]) => c[0])).not.toContain("extrasDia.candidates");
  });

  it("extras_dia_situacao com o indicador a sério: um backoffice não conta, sem cidade não entra, escalado noutra cidade não é disponível", async () => {
    const win = { status: "available", windows: [{ from: 8, to: 12 }], hours: "08–12" };
    st.candidates = [
      { id: 1, fullName: "Extra Lisboa", position: "extra", availability: win },
      { id: 2, fullName: "Backoffice Lisboa", position: "backoffice", availability: win },
      { id: 3, fullName: "Extra Sem Cidade", position: "extra", availability: win },
      { id: 4, fullName: "Extra Escalado no Porto", position: "extra", availability: win },
      { id: 5, fullName: "Extra Do Porto", position: "extra", availability: win },
      { id: 6, fullName: "Extra Sem Resposta", position: "extra", availability: { status: "no_response", windows: [] } },
    ];
    st.cities = new Map([[1, { city: "lisboa" }], [2, { city: "lisboa" }], [4, { city: "lisboa" }], [5, { city: "porto" }], [6, { city: "lisboa" }]]);
    st.rows = [{ employeeId: 4, city: "porto", isTeamLeader: false, startHour: 8, endHour: 16, sentHomeHour: null }];
    const report = await getStaffingReport("2026-10-16", "lisbon");
    const srv = fakeServer();
    const call = vi.fn(async (p: string, i?: any) => (p === "extrasDia.staffing" ? report : srv.call(p, i)));
    const { result, redact } = await runTool({ ...PEOPLE.supervisor(), call } as StaffToolCtx, "extras_dia_situacao", { data: "2026-10-16" });
    const names = ((result.respostas as any).pessoas as any[]).map((p) => redact.restore(p.nome));
    expect(names).toEqual(["Extra Lisboa"]);
    expect((result.respostas as any).disponiveisPorEscalar).toBe(1);
    const gapNames = (result.faltas as any[]).flatMap((g) => g.nomes.map((n: string) => redact.restore(n)));
    for (const n of ["Backoffice Lisboa", "Extra Sem Cidade", "Extra Escalado no Porto", "Extra Do Porto"]) {
      expect(names, n).not.toContain(n);
      expect(gapNames, n).not.toContain(n);
    }
    expect(gapNames).toContain("Extra Lisboa");
  });
});

// ─── Teto do resultado ───────────────────────────────────────────────────────

describe("teto do resultado (~4 000 caracteres)", () => {
  it("fitToolResult corta listas e textos grandes, marca \"cortado\" e a lista principal fica", () => {
    const big = { lista: Array.from({ length: 500 }, (_, i) => ({ nome: `Linha ${i}`, texto: "x".repeat(50) })), nota: "y".repeat(3000) };
    const out = fitToolResult(big);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(MPV_TOOL_RESULT_MAX_CHARS);
    expect(out.cortado).toMatch(/encurtado.*Listas encurtadas: lista/);
    expect((out.lista as any[]).length).toBeGreaterThan(10);
    expect(fitToolResult({ a: 1 })).toEqual({ a: 1 });
  });

  it("fitToolResult nunca devolve só a nota quando há dados (a nota conta no teto ANTES de cortar)", () => {
    // Entradas grandes de todos os feitios, incluindo as que ficam mesmo no limite com a nota.
    for (let n = 0; n < 120; n++) {
      const input: Record<string, unknown> = {
        a: Array.from({ length: n }, (_, i) => ({ k: i, v: "z".repeat(10 + (n % 7) * 5) })),
        b: "t".repeat(n * 37),
        c: Array.from({ length: 1 + (n % 5) }, () => "q".repeat(400 + n)),
      };
      const out = fitToolResult(input, 1500);
      const size = JSON.stringify(out).length;
      expect(size, String(n)).toBeLessThanOrEqual(1500);
      if (JSON.stringify(input).length > 1500) {
        expect(Object.keys(out).filter((k) => k !== "cortado").length, String(n)).toBeGreaterThan(0);
        expect(out, String(n)).not.toEqual({ cortado: CUT_NOTE });
      }
    }
  });

  it("o 2.º corte (a nota não coube na reserva) volta a acertar os contadores", () => {
    const input = { total: 50, lista: Array.from({ length: 50 }, (_, i) => ({ n: i, t: "x".repeat(30) })) };
    const shown = [{ at: [] as string[], list: "lista", count: "mostrados", total: "total" }];
    // Sem reserva: o 1.º corte vai até ao teto, a nota passa-o e o 2.º corte tira mais linhas.
    const first = fitToolResult(input, 900, { shown, noteReserve: 1_000_000 });
    const out = fitToolResult(input, 900, { shown, noteReserve: 0 });
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(900);
    expect(out.mostrados).toBe((out.lista as any[]).length);
    expect(out.total).toBe(50);
    expect(out.cortado).toMatch(/encurtado/);
    expect((first.lista as any[]).length).toBeLessThanOrEqual((out.lista as any[]).length);
  });

  it("redigir antes de cortar também nos campos curtos (parceiro, perfil, percurso, em falta, regras, previsão, horas)", async () => {
    const email = "geral.da.agencia@exemplo-longo.pt";
    const phone = "+351 912 345 678";
    const pad = (n: number) => "p".repeat(n);
    const srv = fakeServer({ totals: true });
    const call = vi.fn(async (p: string, i?: any) => {
      const base: any = await srv.call(p, i);
      if (p === "partnerships.live") return { ...base, partners: base.partners.map((x: any) => ({ ...x, name: `${pad(70)} ${email}` })) };
      if (p === "reviews.list") return base.map((x: any) => ({ ...x, locationTitle: `${pad(50)} ${phone}` }));
      if (p === "training.myTraining") return { ...base, assignments: base.assignments.map((a: any) => ({ ...a, pathName: `${pad(72)} ${email}`, items: a.items.map((it: any) => ({ ...it, title: `${pad(73)} ${phone}` })) })) };
      if (p === "evaluation.mine") return { ...base, days: [{ day: "2026-10-03", score: { totalPoints: -5, negativePoints: -5, lines: [{ label: `${pad(60)} ${email}`, count: 1, subtotal: -5 }] } }] };
      if (p === "extrasDia.staffing") return { ...base, incomplete: `${pad(190)} ${email}`, people: [{ id: 1, name: "João Pereira", hours: `${pad(32)} ${phone}` }] };
      return base;
    });
    const ctx = { ...ctxFor("admin", ALL, srv, true), call } as StaffToolCtx;
    const all: string[] = [];
    for (const name of ["parcerias_resumo", "criticas_por_responder", "formacao_progresso", "avaliacao_minha", "extras_dia_situacao"]) {
      const { json } = await runTool(ctx, name, lisboaIfNeeded(name));
      all.push(json);
    }
    const sent = all.join("\n");
    for (const part of ["geral.da", "agencia@", "exemplo-longo", "+351", "912 345", "345 678"]) expect(sent, part).not.toContain(part);
    expect(sent).not.toMatch(/\[(EMAIL|TELEFONE)_?\d*…/);
  });

  it("os contadores batem certo depois do corte (mostrados = linhas que ficaram)", async () => {
    const r = await runTool(ctxFor("admin", ALL, fakeServer({ totals: true, many: true }), true), "parcerias_resumo");
    expect(r.result.mostrados).toBe((r.result.lista as any[]).length);
    expect(r.result.parceiros).toBe(60);
    const s = await runTool(ctxFor("admin", ALL, fakeServer({ totals: true, many: true }), true), "extras_dia_situacao", { cidade: "Lisboa" });
    const esc = s.result.escala as any;
    expect(esc.total).toBe(40);
    expect(esc.mostradas).toBe(esc.pessoas.length);
    // Despesas: avisa quando as categorias/meses estão cortados.
    const srv = fakeServer({ totals: true });
    const call = vi.fn(async (p: string, i?: any) => (p === "expenses.list"
      ? Array.from({ length: 30 }, (_, k) => ({ expense: { amount: "1", status: "paid", expenseDate: `2025-${String((k % 14) + 1 > 12 ? 12 : (k % 12) + 1).padStart(2, "0")}-01` }, category: { name: `Cat ${k}` } }))
      : srv.call(p, i)));
    const d = await runTool({ ...PEOPLE.admin(), call } as StaffToolCtx, "despesas_resumo", { de: "2025-01-01", ate: "2025-12-31" });
    expect(d.result.porCategoriaCortada).toMatchObject({ mostradas: 10, total: 30 });
    expect((d.result.porCategoria as any[]).length).toBe(10);
    expect(d.result.porMesCortado).toBeUndefined();
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
