/**
 * Tempos nos ecrãs (P8) — Resumo do dia e dia do condutor: equipas pelo
 * condutor do Trânsito e por quem tirou o carro do terminal, meta, cobertura,
 * tabela vazia → os mesmos números ao vivo, a hora marcada fora das recolhas e
 * o PORTÃO dos tempos com GPS aplicado no servidor (§8.1).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { coverageOf, dayTimesView, driverDayTimes, inTargetView, metricView, teamActs, type ServiceRow } from "./serviceTimesAgg";
import { teamLines, type RosterEntry } from "../shared/shiftDayReview";
import { lisbonLocalTimeUtcMs } from "../shared/shiftHandover";
import { DEFAULT_GARAGE_ROLES, type CallRecord } from "../shared/serviceTimes";
import { computeServiceRowsLive, runServiceTimes, type ServiceTimesDeps, type ServiceTimesRow } from "./serviceTimesJob";
import { serviceRowFromJob } from "./serviceTimesRead";
import { assertReadOnlySql } from "./multiparkDb/client";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
const MIN = 60_000;
const DAY = "2026-10-13";
const T = (hhmm: string) => Date.parse(`${DAY}T${hhmm}:00Z`);

// ─── Linhas sintéticas ──────────────────────────────────────────────────────
let n = 0;
function del(o: Partial<ServiceRow> & { q?: number | null; t?: number | null; c?: number | null }): ServiceRow {
  n++;
  const q = o.q === undefined ? 5 : o.q, t = o.t === undefined ? 10 : o.t, c = o.c === undefined ? 8 : o.c;
  const S = T("16:00") + n * MIN;
  return {
    kind: "entrega", bookingId: `e${n}`, bookingCode: `LX-${n}`, opDay: DAY, cityKey: "lisboa", terminalClass: "t1", outcome: "entregue",
    startSource: "pendente", requestAt: q == null ? null : S - q * MIN, startedAt: S, arrivedAt: t == null ? null : S + t * MIN, deliveredAt: S + ((t ?? 0) + (c ?? 0)) * MIN,
    arrivedSource: t == null ? null : "gps_zona",
    queueMs: q == null ? null : q * MIN, queueStatus: q == null ? "sem_pedido" : "medido",
    transitMs: t == null ? null : t * MIN, transitStatus: t == null ? "sem_pontos" : "medido",
    ourMs: q != null && t != null ? (q + t) * MIN : null, ourStatus: q != null && t != null ? "medido" : t == null ? "sem_pontos" : "sem_pedido",
    customerMs: t == null || c == null ? null : c * MIN, customerStatus: t == null ? "sem_pontos" : "medido",
    totalMs: ((q ?? 0) + (t ?? 0) + (c ?? 0)) * MIN, startEmployeeId: 1, deliverEmployeeId: 9,
    ...o,
  };
}
function pick(o: Partial<ServiceRow> & { term?: number | null; p2?: number | null; late?: number | null }): ServiceRow {
  n++;
  const I = T("07:00") + n * MIN;
  const term = o.term === undefined ? 6 : o.term;
  return {
    kind: "recolha", bookingId: `r${n}`, bookingCode: `LX-r${n}`, opDay: DAY, cityKey: "lisboa", terminalClass: "t1", outcome: "recebido",
    startSource: "em_recolha", checkInAt: I, customerMs: 12 * MIN, customerStatus: "medido",
    terminalMs: term == null ? null : term * MIN, terminalStatus: term == null ? "sem_zello" : "medido", terminalExitSource: term == null ? null : "gps", terminalExitAt: term == null ? null : I + term * MIN,
    toFirstGarageMs: 9 * MIN, p2Ms: o.p2 == null ? null : o.p2 * MIN, p2Status: o.p2 == null ? "nao_passou_no_p2" : "medido",
    toParkedMs: 30 * MIN, parkedStatus: "arrumado", firstGarage: o.p2 == null ? "PD" : "P2", parkedGarage: "PD",
    t2LateMs: o.late == null ? null : o.late * MIN, t2Status: o.late == null ? "nao_aplicavel" : "medido",
    driverEmployeeId: 2, checkInEmployeeId: 3,
    ...o,
  };
}
const OPEN = { gate: { visible: true, minCoveragePct: 60, minN: 20 }, isSuperAdmin: false };
const CLOSED = { gate: { visible: false, minCoveragePct: 60, minN: 20 }, isSuperAdmin: false };
const SUPER_CLOSED = { gate: { visible: false, minCoveragePct: 60, minN: 20 }, isSuperAdmin: true };

describe("P8 — equipas: o condutor do Trânsito e quem tirou o carro do terminal", () => {
  const roster: RosterEntry[] = [
    { employeeId: 7, personName: "TL Manhã", shift: "morning", city: "lisbon", isTeamLeader: 1, startHour: 6, endHour: 15 },
    { employeeId: 2, personName: "Bruno", shift: "morning", city: "lisbon", isTeamLeader: 0, startHour: 6, endHour: 15 },
    { employeeId: 3, personName: "Carla", shift: "morning", city: "lisbon", isTeamLeader: 0, startHour: 6, endHour: 15 },
    { employeeId: 8, personName: "TL Noite", shift: "night", city: "lisbon", isTeamLeader: 1, startHour: 15, endHour: 27 },
    { employeeId: 1, personName: "Ana", shift: "night", city: "lisbon", isTeamLeader: 0, startHour: 15, endHour: 27 },
    { employeeId: 9, personName: "Rui", shift: "night", city: "lisbon", isTeamLeader: 0, startHour: 15, endHour: 27 },
  ];
  const rows = [
    // entregas: começadas pela Ana (1), assinadas com o Rui (9) — contam para a Ana
    del({ q: 3, t: 8 }), del({ q: 10, t: 12 }), del({ q: 2, t: null }),
    // recolhas: check-in da Carla (3), tiradas do terminal pelo Bruno (2); uma no T2 atrasada
    pick({}), pick({ terminalClass: "t2", late: 4 }), pick({ terminalClass: "t2", late: 0 }),
  ];
  it("entregas na equipa de quem pegou no carro (dentro / fora da meta); recolhas na de quem a tirou do terminal", () => {
    const acts = teamActs(rows, { targetMinutes: 15, gate: OPEN });
    const lines = teamLines(DAY, roster, {
      deliveries: acts.deliveries.map((d) => ({ actor: { employeeId: d.employeeId, name: null }, at: d.at, ourMins: d.ourMins })),
      pickups: acts.pickups.map((p) => ({ actor: { employeeId: p.employeeId, name: null }, at: p.at, t2: p.t2, t2LateMins: p.t2LateMins })),
    }, { targetMinutes: 15 });
    const night = lines.find((l) => l.shift === "night")!, morning = lines.find((l) => l.shift === "morning")!;
    // 3+8 = 11 dentro; 10+12 = 22 fora; uma sem chegada: sem medida (com o portão ABERTO, mas a cobertura 2/3 = 67 % e n = 2 < 20 → fechado na cidade)
    expect(night.deliveries.count).toBe(3);
    expect(morning.pickups).toMatchObject({ count: 3, t2: 2 });
    expect(morning.deliveries.count).toBe(0);
    expect(night.pickups.count).toBe(0);
  });
  it("com cobertura suficiente conta dentro / fora da meta e atrasadas no T2", () => {
    const many = [...Array.from({ length: 20 }, (_, i) => del({ q: 2, t: i < 15 ? 8 : 20 })), ...Array.from({ length: 20 }, (_, i) => pick({ terminalClass: "t2", late: i < 5 ? 3 : 0 }))];
    const acts = teamActs(many, { targetMinutes: 15, gate: OPEN });
    expect(acts.hidden).toBeNull();
    const lines = teamLines(DAY, roster, {
      deliveries: acts.deliveries.map((d) => ({ actor: { employeeId: d.employeeId, name: null }, at: d.at, ourMins: d.ourMins })),
      pickups: acts.pickups.map((p) => ({ actor: { employeeId: p.employeeId, name: null }, at: p.at, t2: p.t2, t2LateMins: p.t2LateMins })),
    }, { targetMinutes: 15 });
    expect(lines.find((l) => l.shift === "night")!.deliveries).toEqual({ count: 20, measured: 20, onTime: 15, late: 5 });
    expect(lines.find((l) => l.shift === "morning")!.pickups).toEqual({ count: 20, t2: 20, measured: 20, onTime: 15, late: 5 });
  });
  it("portão fechado: as equipas vêm sem medida (a contagem fica)", () => {
    const many = Array.from({ length: 25 }, () => del({ q: 2, t: 8 }));
    const acts = teamActs(many, { targetMinutes: 15, gate: CLOSED });
    expect(acts.hidden).toBe("Em calibração");
    expect(acts.deliveries.every((d) => d.ourMins == null)).toBe(true);
    expect(acts.deliveries).toHaveLength(25);
  });
  it("quem só despachou não leva a entrega (dia do condutor)", () => {
    const own = driverDayTimes([del({ startEmployeeId: 7, transitStatus: "condutor_por_confirmar", transitMs: null }), del({ startEmployeeId: 7 })], 7, { gate: SUPER_CLOSED });
    expect(own.deliveries).toHaveLength(1);
    expect(driverDayTimes([pick({ driverEmployeeId: 2 }), pick({ driverEmployeeId: 4 })], 2, { gate: SUPER_CLOSED }).pickups).toHaveLength(1);
  });
});

describe("P8 — meta e cobertura", () => {
  const rows = Array.from({ length: 24 }, (_, i) => del({ q: 3, t: i < 18 ? 10 : 14, startSource: i < 6 ? "chamada" : "pendente" }));
  rows.push(del({ q: 3, t: null, transitStatus: "sem_zello" }), del({ q: 3, t: null, transitStatus: "sem_zello" }), del({ q: null, t: 9, arrivedSource: "botao", startSource: "inicio" }));
  it("% na meta só com o nosso tempo medido (Fila + Trânsito ≤ meta)", () => {
    const v = inTargetView(rows, 15, OPEN);
    expect(v).toMatchObject({ measured: 24, within: 18, hidden: null });
    expect(v.pct).toBe(75);
    expect(inTargetView(rows, 17, OPEN).within).toBe(24);
  });
  it("a cobertura conta o início da Fila e a chegada (GPS / botão / sem medição) com os motivos", () => {
    const c = coverageOf(rows).deliveries;
    expect(c).toMatchObject({ n: 27, withCall: 6, fromPending: 20, noRequest: 1, gps: 24, button: 1, unmeasured: 2 });
    expect(c.reasons).toEqual({ sem_zello: 2 });
  });
  it("a cobertura vê-se também com o portão fechado (contagens, nunca tempos)", () => {
    const v = dayTimesView(rows, { targetMinutes: 15, gate: CLOSED });
    expect(v.deliveries.coverage.n).toBe(27);
    expect(v.deliveries.metrics.transito).toMatchObject({ n: 27, measured: 25, stats: null, hidden: "Em calibração" });
  });
});

describe("P8 — portão dos tempos com GPS (§8.1), aplicado no servidor", () => {
  const rows = [...Array.from({ length: 30 }, (_, i) => del({ q: 4, t: 9 + (i % 5), c: 6 })), ...Array.from({ length: 20 }, () => del({ q: 4, t: null }))];
  // cobertura do Trânsito: 30 / 50 = 60 %
  it("fechado: quem não é super admin não recebe Trânsito, Cliente, Nosso nem a % na meta (nem nas listas)", () => {
    const v = dayTimesView(rows, { targetMinutes: 15, gate: CLOSED });
    for (const m of ["transito", "cliente", "nosso"] as const) expect(v.deliveries.metrics[m]).toMatchObject({ stats: null, hidden: "Em calibração" });
    expect(v.deliveries.inTarget).toMatchObject({ pct: null, within: null, hidden: "Em calibração" });
    expect(v.deliveries.metrics.fila.stats).not.toBeNull();
    expect(v.deliveries.metrics.total.stats).not.toBeNull();
    expect(v.deliveries.slowestBy).toBe("fila");
    for (const s of v.deliveries.slowest) expect([s.transitMs, s.customerMs, s.ourMs]).toEqual([null, null, null]);
    // nada dos tempos com GPS vai no JSON
    const json = JSON.stringify(v);
    for (const ms of [9, 10, 11, 12, 13].map((t) => t * MIN)) expect(json).not.toContain(`"transitMs":${ms}`);
    expect(json).not.toMatch(/"ourMs":\d/);
  });
  it("aberto com cobertura 59 % → \"sem dados suficientes\"; 60 % e n ≥ 20 → mostra", () => {
    const at59 = [...Array.from({ length: 59 }, () => del({ q: 4, t: 10 })), ...Array.from({ length: 41 }, () => del({ q: 4, t: null }))];
    const v59 = metricView(at59, "transito", OPEN);
    expect(v59.stats).toBeNull();
    expect(v59.hidden).toBe("Sem dados suficientes (cobertura 59 %, n = 59)");
    const v60 = metricView(rows, "transito", OPEN);
    expect(v60.hidden).toBeNull();
    expect(v60.stats).toMatchObject({ n: 30 });
    // 60 % mas n < 20 → sem dados suficientes
    const small = [...Array.from({ length: 12 }, () => del({ q: 4, t: 10 })), ...Array.from({ length: 8 }, () => del({ q: 4, t: null }))];
    expect(metricView(small, "transito", OPEN).hidden).toBe("Sem dados suficientes (cobertura 60 %, n = 12)");
  });
  it("super admin vê sempre, marcado em calibração", () => {
    const v = dayTimesView(rows, { targetMinutes: 15, gate: SUPER_CLOSED });
    expect(v.deliveries.metrics.transito.stats).not.toBeNull();
    expect(v.deliveries.metrics.transito.note).toBe("em calibração");
    expect(v.provisional).toBe(true);
    expect(v.deliveries.slowestBy).toBe("nosso");
  });
  it("por cidade: uma cidade fechada sai das contas, a aberta fica", () => {
    const porto = Array.from({ length: 10 }, () => del({ q: 4, t: 30, cityKey: "porto" })); // n = 10 < 20
    const v = metricView([...rows, ...porto], "transito", OPEN);
    expect(v.hidden).toBeNull();
    expect(v.stats!.n).toBe(30);
    expect(v.stats!.p90Ms).toBeLessThan(30 * MIN);
  });
  it("o dia do condutor: fechado sem Trânsito/Cliente/Nosso nem a janela da máxima", () => {
    const d = driverDayTimes(rows, 1, { gate: CLOSED });
    expect(d.gpsHidden).toBe("Em calibração");
    expect(d.deliveries.every((x) => x.transitMs == null && x.customerMs == null && x.ourMs == null && x.transitWindow == null)).toBe(true);
    expect(d.deliveries.some((x) => x.queueMs != null)).toBe(true);
    const s = driverDayTimes(rows, 1, { gate: SUPER_CLOSED });
    expect(s.deliveries.filter((x) => x.transitWindow).length).toBe(30);
  });
  it("recolhas: No terminal e Atrasadas no T2 atrás do portão; No P2 e Até arrumado sempre", () => {
    const p = [...Array.from({ length: 25 }, () => pick({ p2: 90, terminalClass: "t2", late: 2 }))];
    const v = dayTimesView(p, { targetMinutes: 15, gate: CLOSED });
    expect(v.pickups.metrics.terminal).toMatchObject({ stats: null, hidden: "Em calibração" });
    expect(v.pickups.metrics.ate_garagem.stats).toBeNull();
    expect(v.pickups.t2).toMatchObject({ late: null, hidden: "Em calibração" });
    expect(v.pickups.metrics.p2.stats).toMatchObject({ n: 25, p50Ms: 90 * MIN });
    expect(v.pickups.metrics.ate_arrumado.stats).not.toBeNull();
    expect(v.pickups.longest.every((x) => x.terminalMs == null)).toBe(true);
    expect(dayTimesView(p, { targetMinutes: 15, gate: OPEN }).pickups.t2).toMatchObject({ late: 25, measured: 25 });
  });
  it("o procedimento passa o papel e não há outra porta para os números", () => {
    const r = src("server/routers.ts");
    expect(r).toContain('getSupervisorDayDashboard(input.date, { isSuperAdmin: ctx.user.role === "super_admin" })');
    expect(r).toContain('getDriverShiftDay(input.date, input.key, Date.now(), { isSuperAdmin: ctx.user.role === "super_admin" })');
    const db = src("server/db.ts");
    expect(db).toContain("dayTimesView(svc.rows");
    expect(db).toContain("teamActs(svc.rows");
  });
});

// ─── Tabela vazia → os mesmos números ao vivo ───────────────────────────────

const utc = (ms: number) => new Date(ms).toISOString().slice(0, 23).replace("T", " ");
const PARK = { lat: 38.7742, lng: -9.09 };
const h = (bookingId: string, type: string, time: string, agent: string, extra: Record<string, unknown> = {}) => ({
  id: `h-${bookingId}-${type}-${time}`, booking_id: bookingId, change_type: type, action_time: utc(T(time)), agent_user_id: agent, agent_name: `Agente ${agent}`, platform: "MOBILE",
  lat: null, lng: null, status_from: null, status_to: null, move_kind: null, garage_from: null, garage_to: null, snap_arrived: null, snap_baggage: null, ...extra,
});
const mv = (b: string, time: string, agent: string, kind: string, to: string | null = null, from: string | null = null) => h(b, "MOVEMENT", time, agent, { move_kind: kind, garage_to: to, garage_from: from });
const history = [
  h("e1", "PENDING_CHECKOUT", "16:00", "uOff"), h("e1", "CHECKING_OUT", "16:10", "uA"), h("e1", "CHECK_OUT", "16:40", "uTL"),
  h("e2", "PENDING_CHECKOUT", "14:50", "uOff"), h("e2", "CHECKING_OUT", "15:02", "uB"), h("e2", "CHECK_OUT", "15:35", "uB"),
  h("e3", "CHECKING_OUT", "20:00", "uA"), h("e3", "CHECK_OUT", "20:30", "uA"),
  h("e4", "PENDING_CHECKOUT", "19:30", "uOff"), h("e4", "CHECKING_OUT", "19:35", "uA"), h("e4", "CANCEL", "19:40", "uOff"),
  h("r1", "CHECKING_IN", "06:00", "uOff"), h("r1", "CHECK_IN", "06:20", "uA"), mv("r1", "06:27", "uA", "inicio"), mv("r1", "06:45", "uA", "arrumar", "CENTRAL"),
  h("r2", "CHECK_IN", "06:30", "uX"), mv("r2", "06:35", "uX", "inicio"), mv("r2", "06:50", "uX", "arrumar", "P2"), mv("r2", "09:00", "uC", "inicio"), mv("r2", "09:10", "uC", "parques", "CENTRAL", "P2"),
  h("r3", "CHECKING_IN", "07:02", "uOff"), h("r3", "CHECK_IN", "07:30", "uB"), mv("r3", "07:40", "uB", "inicio"), mv("r3", "07:55", "uB", "arrumar", "PD"),
];
const bookings: Record<string, Record<string, unknown>> = Object.fromEntries(["e1", "e2", "e3", "e4", "r1", "r2", "r3"].map((id) => [id, { id, park_id: "pLX", status: "CHECKED_OUT", delivery_type: id === "r3" ? "Terminal 2" : "Terminal 1", code: `LX-${id}`, parking_type: "UNCOVERED", client_phone: `+35191200${id.replace(/\D/g, "").padStart(4, "0")}` }]));
const calls: CallRecord[] = [{ at: T("15:40"), source: "central", held: true, phone9: "912000001", crmClientId: null }];
const EMP: Record<string, number> = { uA: 1, uB: 2, uC: 4, uX: 5, uOff: 8, uTL: 9 };

function fakeDeps(written: ServiceTimesRow[], gpsSince: string): ServiceTimesDeps {
  return {
    query: async (sql, params = []) => {
      assertReadOnlySql(sql);
      if (sql.includes('FROM "History"')) {
        const from = Date.parse(String(params[0]).replace(" ", "T") + "Z"), to = Date.parse(String(params[1]).replace(" ", "T") + "Z");
        return history.filter((r) => { const t = Date.parse(String(r.action_time).replace(" ", "T") + "Z"); return t >= from && t < to; }) as any;
      }
      if (sql.includes('FROM "Booking"')) return params.map((id) => bookings[String(id)]).filter(Boolean) as any;
      if (sql.includes('FROM "Driver"')) return [];
      if (sql.includes('FROM "Agent"')) return [{ user_id: "uA", park_id: "pLX", role: "DRIVER" }, { user_id: "uB", park_id: "pLX", role: "DRIVER" }] as any;
      if (sql.includes('FROM "Park"')) return [{ id: "pLX", name: "Airpark Lisboa", city: "Lisboa", address: null, firebase_brand: "airpark", listing_type: "ON_PLATFORM", lat: PARK.lat, lng: PARK.lng }] as any;
      if (sql.includes('FROM "Garage"')) return [];
      throw new Error(`SQL inesperado: ${sql.slice(0, 60)}`);
    },
    now: () => Date.parse("2026-10-14T05:40:00Z"),
    settings: async () => ({
      excludedParks: [], airports: { lisbon: { lat: 38.7742, lng: -9.1342, radiusM: 1500 }, porto: { lat: 41.2481, lng: -8.6814, radiusM: 1500 }, faro: { lat: 37.0144, lng: -7.9659, radiusM: 1500 } },
      parkZones: { lisbon: [], porto: [], faro: [] }, garageRoles: DEFAULT_GARAGE_ROLES.map((g) => ({ ...g })),
      targetMinutes: 15, t2TargetMinutes: 15, since: "2026-10-11", gpsSince, useCalls: true,
    }),
    ourDb: { calls: async () => calls, crmLinks: async () => new Map(), pdaCheckins: async () => [], fixedZellos: async () => [] },
    loadGps: async () => new Map(),
    identity: async () => ({ agent: (userId) => (userId && EMP[userId] ? { kind: "colaborador", employeeId: EMP[userId] } : { kind: "por_ligar", employeeId: null }) }),
    store: {
      loadState: async () => null, saveState: async () => undefined, existing: async () => [],
      upsert: async (list) => { written.push(...list); }, voidRows: async () => undefined,
    },
    log: () => undefined,
  };
}

describe("P8 — tabela vazia: os mesmos números ao vivo", () => {
  it("o cálculo ao vivo dá os mesmos tempos sem GPS que a tabela (e não grava nada)", async () => {
    const written: ServiceTimesRow[] = [];
    // a noite com o GPS ainda fora do período (as linhas guardadas sem GPS)
    const r = await runServiceTimes(fakeDeps(written, "2027-01-01"), { deadlineAt: Date.now() + 40_000 });
    expect(r.ok).toBe(true);
    const stored = written.filter((x) => x.opDay === DAY).map(serviceRowFromJob);
    const liveWritten: ServiceTimesRow[] = [];
    const live = await computeServiceRowsLive(fakeDeps(liveWritten, "2026-09-15"), { from: DAY, to: DAY, deadlineAt: Date.now() + 40_000 });
    expect(live.ok).toBe(true);
    expect(liveWritten).toHaveLength(0);
    const liveRows = (live as { rows: ServiceTimesRow[] }).rows.map(serviceRowFromJob);
    expect(liveRows.length).toBe(stored.length);
    const a = dayTimesView(stored, { targetMinutes: 15, gate: SUPER_CLOSED }), b = dayTimesView(liveRows, { targetMinutes: 15, gate: SUPER_CLOSED });
    for (const m of ["fila", "total"] as const) expect(b.deliveries.metrics[m].stats).toEqual(a.deliveries.metrics[m].stats);
    for (const m of ["cliente_recolha", "p2", "ate_arrumado"] as const) expect(b.pickups.metrics[m].stats).toEqual(a.pickups.metrics[m].stats);
    expect(b.deliveries.coverage.withCall).toBe(a.deliveries.coverage.withCall);
    // Fila de e1 desde a chamada (15:40 → 16:10 = 30 min) também ao vivo
    expect(liveRows.find((x) => x.bookingId === "e1")).toMatchObject({ queueMs: 30 * MIN, startSource: "chamada" });
    // ao vivo os tempos com GPS ficam "GPS por recolher" (nunca 0)
    expect(liveRows.filter((x) => x.kind === "entrega" && x.outcome === "entregue").every((x) => x.transitStatus === "gps_por_recolher" && x.transitMs == null)).toBe(true);
    expect(b.deliveries.metrics.transito.stats).toBeNull();
  });
  it("o Resumo do dia lê a tabela e, sem linhas, calcula ao vivo", () => {
    const read = src("server/serviceTimesRead.ts");
    expect(read).toContain("computeServiceRowsLive");
    expect(read).toContain('source: "tabela"');
    expect(read).toContain('source: "ao_vivo"');
  });
});

describe("P8 — a hora marcada já não entra nas recolhas", () => {
  it("nem no Resumo do dia, nem no dia do condutor", () => {
    const db = src("server/db.ts");
    const fn = db.slice(db.indexOf("export async function getSupervisorDayDashboard"), db.indexOf("// ─── LIGAÇÃO AGENTE→PARCEIRO"));
    expect(fn).not.toMatch(/PICKUP_LATE_MIN|delayMins|avgDelayMins|r\.checkIn\b/);
    const detail = src("server/shiftDayDetail.ts");
    expect(detail).not.toMatch(/delayMins|plannedIn/);
    expect(src("shared/shiftDayReview.ts")).not.toMatch(/PICKUP_LATE_MIN|delayMins/);
    expect(src("client/src/components/shiftDay/DaySummaryTab.tsx")).not.toMatch(/Recolhas atrasadas &gt;15min|avgDelayMins/);
  });
  it("a recolha só conta atrasada no T2 (nunca pela entrada prevista)", () => {
    const rows = [pick({ terminalClass: "t1" }), pick({ terminalClass: "t2", late: 0 })];
    const acts = teamActs(rows, { targetMinutes: 15, gate: SUPER_CLOSED });
    expect(acts.pickups.map((p) => [p.t2, p.t2LateMins])).toEqual([[false, null], [true, 0]]);
  });
});
