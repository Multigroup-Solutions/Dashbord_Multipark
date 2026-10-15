/**
 * Auditoria do #389 (Tempos, plano 62 fase 3) — as correções:
 *  1. Resumo do dia dentro dos 60 s: a Atividade do Dia em paralelo com os
 *     tempos; a Multipark em baixo não leva o resumo inteiro; o GPS do dia do
 *     condutor com o prazo que sobra (até 25 s, nunca para lá dos 55 s);
 *  3. "Atrasadas no T2" por cidade: uma cidade fechada não entra, mesmo com
 *     outra aberta (equipas, grelhas e ficha da reserva);
 *  5. Ficha da reserva: o T2 pela cobertura da chegada ao T2, não do terminal;
 *  8. a escala sem ficha ligada (só o nome) também recebe as suas entregas;
 *  9. o portão pelos PROCEDIMENTOS (createCaller), admin vs super admin:
 *     supervisorDashboard, driverDay e bookingFile.times;
 * 10. o dia do condutor: o portão das entregas e o das recolhas à parte;
 * 11. sem código morto (supervisorTimings).
 * (O achado 2 ficou como estava, por decisão do Jorge: a entrega é de quem
 * marcou "em entrega", que é o condutor que leva o carro.)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks (só leitura; nada toca na Multipark nem na nossa BD) ─────────────

const national = vi.hoisted(() => ({ all: true, defaultCityId: null, cityName: null, cityIds: [] as number[], projectIds: [] as number[], missingCostCenter: false }));
const state = vi.hoisted(() => ({
  roster: [] as any[],
  rows: [] as any[],
  bookingRows: [] as any[],
  gate: { visible: false, minCoveragePct: 60, minN: 20 },
  calls: [] as string[],
  activityDelayMs: 0,
  timesDelayMs: 0,
  histFails: false,
  names: {} as Record<number, string>,
}));

vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => national,
  loadCityAccessParts: async () => ({ access: national, base: national, all: national }),
}));
vi.mock("./db", async (original) => {
  const chain: any = new Proxy(function () {}, {
    get: (_t, p) => (p === "then" ? (res: (v: unknown) => void) => res(state.roster) : () => chain),
    apply: () => chain,
  });
  const fakeDb = { execute: async () => [[{ n: 0 }]], select: () => chain };
  return {
    ...(await original<object>()),
    getDb: async () => fakeDb,
    getUserPermissionOverrides: async () => ({}),
    getUserModuleOverrides: async () => ({}),
    getEmployeeByUserId: async () => null,
    getDayActivity: async () => {
      state.calls.push("activity:start");
      await new Promise((r) => setTimeout(r, state.activityDelayMs));
      state.calls.push("activity:end");
      return { totals: { checkins: 0 }, people: [], gpsMissingDays: [] };
    },
  };
});
vi.mock("./multiparkDb/historyLive", async (original) => ({
  ...(await original<object>()),
  readLiveHistory: async () => {
    state.calls.push("hist");
    if (state.histFails) throw new Error("ligação recusada");
    return [];
  },
}));
vi.mock("./departedComplaints", () => ({ countComplaintsForRefs: async () => 0 }));
vi.mock("./serviceTimesRead", async (original) => ({
  ...(await original<object>()),
  loadServiceViewSettings: async () => ({ gate: state.gate, targetMinutes: 15, t2TargetMinutes: 15 }),
  scopedServiceCityKeys: async () => null,
  employeeNames: async (ids: Iterable<number | null | undefined>) => Object.fromEntries([...ids].filter((x): x is number => typeof x === "number" && state.names[x] != null).map((x) => [x, state.names[x]])),
  dayServiceRows: async () => {
    state.calls.push("times:start");
    await new Promise((r) => setTimeout(r, state.timesDelayMs));
    state.calls.push("times:end");
    return { source: "tabela", rows: state.rows, computedAt: null, truncated: false, reason: null };
  },
  loadBookingServiceRows: async () => state.bookingRows,
  loadServiceRows: async () => state.rows,
}));
vi.mock("./dayActivity", async (original) => ({
  ...(await original<object>()),
  loadIdentityResolver: async () => ({ emps: [{ id: 7, fullName: "Rui Condutor", multiparkAgentName: null, multiparkAgentUserId: null }], resolve: () => ({ kind: "colaborador", key: "emp:7" }) }),
}));
vi.mock("./shiftGps", async (original) => ({ ...(await original<object>()), scopedEmployeeIds: async () => [] }));
vi.mock("./multiparkDb/client", async (original) => ({
  ...(await original<object>()),
  multiparkDbQuery: async () => [{ id: "bk1", delivery_type: "Terminal 2", city: "Lisboa" }],
}));

import { appRouter } from "./routers";
import { bookingTimesView } from "./serviceTimesBooking";
import { driverDayTimes, t2OpenCities, t2View, teamActs, timesGrid, type ServiceRow } from "./serviceTimesAgg";
import { DRIVER_DAY_TOTAL_MS, driverDayGpsBudgetMs } from "./shiftDayDetail";
import { SUPERVISOR_DAY_BUDGET_MS } from "./supervisorDay";
import { teamLines, type RosterEntry } from "../shared/shiftDayReview";
import { lisbonLocalTimeUtcMs } from "../shared/shiftHandover";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
const caller = (role: string) => appRouter.createCaller({ user: { id: 1, role, name: "Rita" }, req: { headers: {} }, res: {} } as any);
const MIN = 60_000;
const DAY = "2026-10-13";
const T = (hhmm: string) => Date.parse(`${DAY}T${hhmm}:00Z`);

let n = 0;
function del(o: Partial<ServiceRow> = {}): ServiceRow {
  n++;
  const S = T("16:00") + n * MIN;
  return {
    kind: "entrega", bookingId: `e${n}`, bookingCode: `LX-${n}`, opDay: DAY, cityKey: "lisboa", terminalClass: "t1", outcome: "entregue",
    startSource: "pendente", requestAt: S - 5 * MIN, startedAt: S, arrivedAt: S + 10 * MIN, deliveredAt: S + 18 * MIN, arrivedSource: "gps_zona",
    queueMs: 5 * MIN, queueStatus: "medido", transitMs: 10 * MIN, transitStatus: "medido", ourMs: 15 * MIN, ourStatus: "medido",
    customerMs: 8 * MIN, customerStatus: "medido", totalMs: 23 * MIN, startEmployeeId: 7, deliverEmployeeId: 9,
    ...o,
  };
}
function pick(o: Partial<ServiceRow> & { late?: number | null } = {}): ServiceRow {
  n++;
  const I = T("07:00") + n * MIN;
  const late = o.late === undefined ? 3 : o.late;
  return {
    kind: "recolha", bookingId: `r${n}`, bookingCode: `LX-r${n}`, opDay: DAY, cityKey: "lisboa", terminalClass: "t2", outcome: "recebido",
    startSource: "em_recolha", checkInAt: I, customerMs: 12 * MIN, customerStatus: "medido",
    terminalMs: 6 * MIN, terminalStatus: "medido", terminalExitSource: "gps", terminalExitAt: I + 6 * MIN,
    p2Ms: null, p2Status: "nao_passou_no_p2", parkedStatus: "arrumado", toParkedMs: 30 * MIN,
    t2LateMs: late == null ? null : late * MIN, t2Status: late == null ? "sem_pontos" : "medido",
    driverEmployeeId: 7, checkInEmployeeId: 3,
    ...o,
  };
}
const many = <X>(k: number, f: () => X) => Array.from({ length: k }, f);
const OPEN = { gate: { visible: true, minCoveragePct: 60, minN: 20 }, isSuperAdmin: false };
const CLOSED_GATE = { visible: false, minCoveragePct: 60, minN: 20 };

beforeEach(() => {
  state.roster = []; state.rows = []; state.bookingRows = []; state.calls = []; state.names = {};
  state.gate = { ...CLOSED_GATE }; state.activityDelayMs = 0; state.timesDelayMs = 0; state.histFails = false;
});

// ─── 9. O portão pelos procedimentos (admin vs super admin) ─────────────────

describe("9 — o portão aplica-se nos procedimentos, pelo papel de quem pede", () => {
  it("supervisorDashboard: com o portão fechado o admin não recebe Trânsito/Nosso/% na meta; o super admin sim, marcado provisório", async () => {
    state.rows = many(30, () => del());
    const admin = await caller("admin").shiftHandover.supervisorDashboard({ date: DAY });
    expect(admin!.times.deliveries.metrics.transito).toMatchObject({ stats: null, hidden: "Em calibração" });
    expect(admin!.times.deliveries.metrics.nosso.stats).toBeNull();
    expect(admin!.times.deliveries.inTarget.pct).toBeNull();
    expect(admin!.times.deliveries.slowest.every((x) => x.transitMs == null && x.ourMs == null && x.customerMs == null)).toBe(true);
    // a Fila não depende do GPS: vê-se sempre
    expect(admin!.times.deliveries.metrics.fila.stats?.p50Ms).toBe(5 * MIN);
    const sa = await caller("super_admin").shiftHandover.supervisorDashboard({ date: DAY });
    expect(sa!.times.deliveries.metrics.transito).toMatchObject({ hidden: null, note: "em calibração" });
    expect(sa!.times.deliveries.metrics.transito.stats?.p50Ms).toBe(10 * MIN);
    expect(sa!.times.provisional).toBe(true);
  });

  it("driverDay: o admin não recebe o Trânsito nem o Cliente; o super admin sim", async () => {
    state.rows = [...many(25, () => del()), ...many(25, () => pick())];
    const admin = await caller("admin").shiftHandover.driverDay({ date: DAY, key: "emp:7" });
    expect(admin.times!.deliveries.length).toBe(25);
    expect(admin.times!.deliveries.every((d) => d.transitMs == null && d.customerMs == null && d.transitWindow == null)).toBe(true);
    expect(admin.times!.gpsHiddenDeliveries).toBe("Em calibração");
    const sa = await caller("super_admin").shiftHandover.driverDay({ date: DAY, key: "emp:7" });
    expect(sa.times!.deliveries[0].transitMs).toBe(10 * MIN);
    expect(sa.times!.gpsHiddenDeliveries).toBeNull();
  });

  it("bookingFile.times: o admin não vê os tempos com GPS (nem o T2); o super admin vê", async () => {
    state.bookingRows = [pick({ late: 4 })];
    const admin = await caller("admin").bookingFile.times({ id: "bk1" });
    if (!admin.available) throw new Error("devia estar disponível");
    const t = (k: string) => admin.entries[0].times.find((x) => x.key === k)!;
    expect(t("terminal")).toMatchObject({ ms: null, hidden: "Em calibração" });
    expect(t("t2")).toMatchObject({ ms: null, hidden: "Em calibração" });
    expect(admin.entries[0].at.terminalExit).toBeNull();
    const sa = await caller("super_admin").bookingFile.times({ id: "bk1" });
    if (!sa.available) throw new Error("devia estar disponível");
    expect(sa.entries[0].times.find((x) => x.key === "t2")).toMatchObject({ ms: 4 * MIN, hidden: null });
    expect(sa.gpsNote).toBe("em calibração");
  });
});

// ─── 1. Prazo do Resumo do dia ──────────────────────────────────────────────

describe("1 — Resumo do dia dentro dos 60 s da função", () => {
  it("a Atividade do Dia corre em paralelo com os tempos (não depois)", async () => {
    state.activityDelayMs = 40;
    state.timesDelayMs = 40;
    const r = await caller("admin").shiftHandover.supervisorDashboard({ date: DAY });
    expect(r!.totals).toEqual({ checkins: 0 });
    // a atividade começou antes de os tempos acabarem
    expect(state.calls.indexOf("activity:start")).toBeLessThan(state.calls.indexOf("times:end"));
  });

  it("a Multipark em baixo (CHECK_OUT do dia) não leva o resumo inteiro: só as reclamações dos carros que saíram ficam por contar", async () => {
    state.histFails = true;
    state.rows = many(3, () => del());
    const r = await caller("admin").shiftHandover.supervisorDashboard({ date: DAY });
    expect(r!.complaintsDeparted).toMatchObject({ available: false });
    expect(r!.times.deliveries.n).toBe(3);
    expect(r!.timingsTruncated).toBe(false);
  });

  it("o orçamento dos tempos e o comentário certo (a Atividade também lê a Multipark)", () => {
    expect(SUPERVISOR_DAY_BUDGET_MS).toBe(48_000);
    const f = src("server/supervisorDay.ts");
    expect(f).not.toContain("o resto — escala, reclamações — é a nossa BD");
    expect(f).toContain("getDayActivity → loadActivityActions");
    expect(f).toContain("const activityP = getDayActivity(date)");
  });

  it("dia do condutor: o GPS com o prazo que sobra (até 25 s, nunca para lá dos 55 s); sem tempo não se lê", () => {
    expect(DRIVER_DAY_TOTAL_MS).toBe(55_000);
    expect(driverDayGpsBudgetMs(0)).toBe(25_000);
    expect(driverDayGpsBudgetMs(20_000)).toBe(25_000);
    expect(driverDayGpsBudgetMs(40_000)).toBe(15_000);
    expect(driverDayGpsBudgetMs(52_500)).toBeNull();
    expect(driverDayGpsBudgetMs(60_000)).toBeNull();
    expect(src("server/shiftDayDetail.ts")).toContain("deadlineAt: Date.now() + gpsBudget");
  });
});

// ─── 3. T2 por cidade ───────────────────────────────────────────────────────

describe("3 — atrasadas no T2 por cidade (uma aberta, outra fechada)", () => {
  // Lisboa: 25 T2 todas medidas (aberta); Porto: 25 T2, só 5 medidas (20 % → fechada)
  const lx = many(25, () => pick({ cityKey: "lisboa", late: 4 }));
  const po = [...many(5, () => pick({ cityKey: "porto", late: 9 })), ...many(20, () => pick({ cityKey: "porto", late: null }))];
  const rows = [...lx, ...po];

  it("a regra: só Lisboa abre", () => {
    expect([...t2OpenCities(rows, OPEN).open]).toEqual(["lisboa"]);
    expect(t2View(rows, OPEN).late).toBe(25);
  });
  it("equipas: as recolhas do Porto vão sem medida (nunca \"atrasadas\")", () => {
    const acts = teamActs(rows, { targetMinutes: 15, gate: OPEN });
    const porto = acts.pickups.filter((_, i) => rows[i].cityKey === "porto");
    expect(porto.every((p) => p.t2LateMins == null)).toBe(true);
    const lisboa = acts.pickups.filter((_, i) => rows[i].cityKey === "lisboa");
    expect(lisboa.every((p) => p.t2LateMins === 4)).toBe(true);
  });
  it("grelhas (Pressão / Semana): o Porto não entra na % de atrasadas", () => {
    const g = timesGrid(rows, () => "*", { gate: OPEN, targetMinutes: 15 });
    expect(g.cells["*"].t2Late).toEqual({ n: 25, pct: 100 });
  });
  it("ficha da reserva: o T2 pela cobertura da chegada ao T2, não pela do terminal", () => {
    // terminal todo medido (o portão do terminal abriria), T2 sem medição na cidade → o T2 fica fechado
    const day = many(25, () => pick({ cityKey: "porto", late: null }));
    const one = pick({ cityKey: "porto", late: 2 });
    const all = [...day, one];
    const open = (r: ServiceRow, m: any) => (m === "t2" ? t2OpenCities(all, { gate: OPEN.gate, isSuperAdmin: false }).open : new Set(["porto"])).has(r.cityKey ?? "");
    const v = bookingTimesView([one], { gate: OPEN.gate, isSuperAdmin: false, open });
    const times = v.entries[0].times;
    expect(times.find((x) => x.key === "terminal")!.ms).toBe(6 * MIN);
    expect(times.find((x) => x.key === "t2")).toMatchObject({ ms: null, hidden: "Sem dados suficientes nesta cidade e dia" });
    const src2 = src("server/serviceTimesBooking.ts");
    expect(src2).not.toContain('m === "t2" ? "terminal" : m');
    expect(src2).toContain('m === "t2" ? t2OpenCities(day, g).open');
  });
});

// ─── 8. Escala sem ficha ligada ─────────────────────────────────────────────

describe("8 — a escala sem ficha ligada (só o nome) também recebe as suas entregas", () => {
  it("teamLines encontra pelo nome quando a ação traz a ficha e o nome", () => {
    const at = new Date(lisbonLocalTimeUtcMs(DAY, 10)).toISOString().slice(0, 19).replace("T", " ");
    const roster: RosterEntry[] = [
      { employeeId: 1, personName: "Teresa TL", shift: "morning", city: "lisbon", isTeamLeader: 1, startHour: 7, endHour: 15 },
      { employeeId: null, personName: "Zé Sem Ficha", shift: "morning", city: "lisbon", isTeamLeader: 0, startHour: 7, endHour: 15 },
    ];
    const lines = teamLines(DAY, roster, { deliveries: [{ actor: { employeeId: 42, name: "Zé Sem Ficha" }, at, ourMins: 12 }], pickups: [] }, { targetMinutes: 15 });
    expect(lines[0].deliveries).toMatchObject({ count: 1, onTime: 1 });
  });
  it("o Resumo do dia manda o nome de cada ficha às equipas", async () => {
    state.gate = { visible: true, minCoveragePct: 0, minN: 1 };
    state.names = { 7: "Rui Condutor" };
    state.roster = [
      { personName: "Teresa TL", shift: "morning", city: "lisbon", employeeId: 1, startHour: 7, endHour: 23, sentHomeHour: null, isTeamLeader: 1 },
      { personName: "Rui Condutor", shift: "morning", city: "lisbon", employeeId: null, startHour: 7, endHour: 23, sentHomeHour: null, isTeamLeader: 0 },
    ];
    state.rows = many(2, () => del());
    const r = await caller("admin").shiftHandover.supervisorDashboard({ date: DAY });
    expect(r!.teams[0].deliveries.count).toBe(2);
  });
});

// ─── 10. Dia do condutor: um portão por tabela ──────────────────────────────

describe("10 — dia do condutor: o portão das entregas e o das recolhas à parte", () => {
  it("entregas abertas e recolhas fechadas: só as recolhas ficam com o cadeado", () => {
    const rows = [...many(25, () => del()), ...many(25, () => pick({ terminalMs: null, terminalStatus: "sem_zello" })), pick()];
    const d = driverDayTimes(rows, 7, { gate: OPEN });
    expect(d.gpsHiddenDeliveries).toBeNull();
    expect(d.gpsHiddenPickups).toMatch(/^Sem dados suficientes/);
    expect(d.deliveries[0].transitMs).toBe(10 * MIN);
    const ui = src("client/src/components/shiftDay/ShiftDayReview.tsx");
    expect(ui).toContain("gpsCell(hiddenD, x.transitMs");
    expect(ui).toContain("gpsCell(hiddenP, x.terminalMs");
  });
});

// ─── 11. Código morto ───────────────────────────────────────────────────────

describe("11 — sem código morto", () => {
  it("supervisorTimings saiu (os testes usam dayTimings)", () => {
    expect(src("server/db.ts")).not.toContain("supervisorTimings");
    expect(src("server/db.ts")).not.toContain("export async function getSupervisorDayDashboard");
    expect(src("server/routers.ts")).toContain('await import("./supervisorDay")');
  });
});
