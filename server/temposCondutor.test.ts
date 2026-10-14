/**
 * Q7 (Jorge, 14 out 2026) — tempos por condutor: médias e percentis por
 * semana, mês e 6 meses, ao lado dos colegas da mesma cidade e do mesmo
 * serviço (sem o próprio), n mínimo ("sem dados suficientes", nunca 0),
 * portão dos tempos com GPS com `{ gate, isSuperAdmin }` e o acesso do módulo
 * Condutores e agentes (Desempenho só o super admin). Não dá pontos.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { driverTimesView } from "./driverTimes";
import { condutoresTabs } from "../shared/condutoresAccess";
import { can } from "../shared/access";
import type { ServiceRow } from "./serviceTimesAgg";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
const MIN = 60_000;
const REF = "2026-10-14";
const OPEN = { visible: true, minCoveragePct: 60, minN: 20 };
const CLOSED = { visible: false, minCoveragePct: 60, minN: 20 };

let n = 0;
/** Uma entrega começada pelo condutor `emp`, com Fila `q` e Trânsito `t` (min). */
function del(emp: number, q: number, t: number | null, o: Partial<ServiceRow> = {}): ServiceRow {
  n++;
  return {
    kind: "entrega", bookingId: `b${n}`, opDay: o.opDay ?? "2026-10-10", cityKey: "lisboa", terminalClass: "t1", outcome: "entregue",
    startEmployeeId: emp, deliverEmployeeId: emp, queueMs: q * MIN, queueStatus: "medido",
    transitMs: t == null ? null : t * MIN, transitStatus: t == null ? "sem_pontos" : "medido",
    ourMs: t == null ? null : (q + t) * MIN, ourStatus: t == null ? "sem_pontos" : "medido",
    customerMs: t == null ? null : 5 * MIN, customerStatus: t == null ? "sem_pontos" : "medido",
    ...o,
  };
}
const many = (k: number, f: (i: number) => ServiceRow) => Array.from({ length: k }, (_, i) => f(i));

describe("Q7 — médias e percentis por condutor ao lado dos colegas", () => {
  // o Rui (7) entrega sempre com 20–30 min de Fila; os colegas (1, 2, 3) entre 13 e 17
  const rows = [
    ...many(24, (i) => del(7, 20 + (i % 11), 10, { opDay: `2026-10-${String(1 + (i % 14)).padStart(2, "0")}` })),
    ...many(30, (i) => del(1 + (i % 3), 13 + (i % 5), 9, { opDay: `2026-10-${String(1 + (i % 14)).padStart(2, "0")}` })),
  ];
  const v = driverTimesView(rows, { employeeId: 7, refDay: REF, gate: OPEN, isSuperAdmin: false });
  it("semana, mês e 6 meses, com os percentis e a diferença para os colegas", () => {
    expect(Object.keys(v.ranges)).toEqual(["semana", "mes", "6meses"]);
    expect(v.ranges.semana).toEqual({ fromDay: "2026-10-08", toDay: REF });
    expect(v.ranges["6meses"].fromDay).toBe("2026-04-16");
    const fila = v.metrics.find((m) => m.metric === "fila")!;
    const mes = fila.periods.mes[0];
    expect(mes).toMatchObject({ employeeId: 7, cityKey: "lisboa", serviceType: "t1", n: 24, enough: true });
    expect(mes.p50Ms).toBeGreaterThanOrEqual(20 * MIN);
    expect(mes.p75Ms).toBeGreaterThanOrEqual(mes.p50Ms!);
    expect(mes.meanMs).not.toBeNull();
    expect(mes.peers.p50Ms).toBe(15 * MIN);
    expect(mes.deltaP50Ms).toBeGreaterThan(0);
    expect(v.metrics.map((m) => m.metric)).toEqual(["fila", "transito", "cliente", "terminal", "p2"]);
  });
  it("os colegas são os outros (sem o próprio), da mesma cidade e do mesmo serviço", () => {
    const fila = v.metrics.find((m) => m.metric === "fila")!.periods.mes[0];
    expect(fila.peers).toMatchObject({ drivers: 3, n: 30 });
    // um colega noutra cidade e outro no T2 não entram
    const more = [...rows, ...many(15, () => del(4, 60, 9, { cityKey: "porto" })), ...many(15, () => del(5, 60, 9, { terminalClass: "t2" }))];
    const w = driverTimesView(more, { employeeId: 7, refDay: REF, gate: OPEN, isSuperAdmin: false }).metrics.find((m) => m.metric === "fila")!.periods.mes;
    expect(w).toHaveLength(1);
    expect(w[0].peers).toMatchObject({ drivers: 3, n: 30, p50Ms: 15 * MIN });
    // se fosse ele próprio a contar como colega, a mediana dos colegas subia
    const solo = driverTimesView(many(24, () => del(7, 25, 10)), { employeeId: 7, refDay: REF, gate: OPEN, isSuperAdmin: false }).metrics[0].periods.mes[0];
    expect(solo.peers).toMatchObject({ drivers: 0, n: 0, p50Ms: null });
  });
  it("o gráfico: a evolução dele e dos colegas, por mês e por semana", () => {
    const fila = v.metrics.find((m) => m.metric === "fila")!;
    expect(fila.monthly.map((p) => p.period)).toEqual(["2026-10"]);
    expect(fila.monthly[0]).toMatchObject({ n: 24, peersN: 30, peersP50Ms: 15 * MIN });
    expect(fila.weekly.length).toBeGreaterThanOrEqual(2);
    expect(fila.weekly.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.period))).toBe(true);
  });
});

describe("Q7 — n mínimo: \"sem dados suficientes\", nunca 0", () => {
  it("abaixo de 10 medições não há número (nem nos colegas)", () => {
    const rows = [...many(6, () => del(7, 25, 10)), ...many(5, () => del(1, 15, 9))];
    const s = driverTimesView(rows, { employeeId: 7, refDay: REF, gate: OPEN, isSuperAdmin: false }).metrics[0].periods.mes[0];
    expect(s).toMatchObject({ n: 6, enough: false, meanMs: null, p50Ms: null, p75Ms: null, deltaP50Ms: null });
    expect(s.peers.p50Ms).toBeNull();
    expect(s.p50Ms).not.toBe(0);
    const ui = src("client/src/components/people/DriverTimesCard.tsx");
    expect(ui).toContain("sem dados suficientes (n = {s.n}, mínimo {d.minN})");
  });
  it("o gráfico deixa o ponto em falta (não desenha 0)", () => {
    const rows = many(3, () => del(7, 25, 10));
    const p = driverTimesView(rows, { employeeId: 7, refDay: REF, gate: OPEN, isSuperAdmin: false }).metrics[0].monthly[0];
    expect(p).toMatchObject({ n: 3, p50Ms: null });
    expect(src("client/src/components/people/DriverTimesCard.tsx")).toContain("connectNulls={false}");
  });
});

describe("Q7 — portão dos tempos com GPS, sempre com { gate, isSuperAdmin }", () => {
  const rows = [...many(25, () => del(7, 20, 12)), ...many(25, () => del(1, 15, 9))];
  it("fechado: quem não é super admin não recebe o Trânsito nem o Cliente (a Fila sim)", () => {
    const v = driverTimesView(rows, { employeeId: 7, refDay: REF, gate: CLOSED, isSuperAdmin: false });
    const t = v.metrics.find((m) => m.metric === "transito")!;
    expect(t.periods.mes[0]).toMatchObject({ p50Ms: null, meanMs: null, gpsHidden: "Em calibração" });
    expect(t.periods.mes[0].peers.p50Ms).toBeNull();
    expect(t.monthly[0]).toMatchObject({ p50Ms: null, gpsHidden: "Em calibração" });
    expect(v.metrics.find((m) => m.metric === "cliente")!.periods.mes[0].p50Ms).toBeNull();
    expect(v.metrics.find((m) => m.metric === "fila")!.periods.mes[0].p50Ms).toBe(20 * MIN);
    expect(JSON.stringify(t)).not.toMatch(/"p50Ms":72\d{4}/);
  });
  it("super admin vê sempre, com \"em calibração\"", () => {
    const t = driverTimesView(rows, { employeeId: 7, refDay: REF, gate: CLOSED, isSuperAdmin: true }).metrics.find((m) => m.metric === "transito")!.periods.mes[0];
    expect(t).toMatchObject({ p50Ms: 12 * MIN, gpsHidden: null, gpsLabel: "em calibração" });
  });
  it("aberto com cobertura < 60 % na cidade: sem dados suficientes; ≥ 60 % e n ≥ 20: mostra", () => {
    const low = [...rows, ...many(40, () => del(2, 15, null))]; // 50 de 90 medidas = 56 %
    expect(driverTimesView(low, { employeeId: 7, refDay: REF, gate: OPEN, isSuperAdmin: false }).metrics.find((m) => m.metric === "transito")!.periods.mes[0].gpsHidden).toMatch(/^Sem dados suficientes \(cobertura 56 %, n = 50\)$/);
    expect(driverTimesView(rows, { employeeId: 7, refDay: REF, gate: OPEN, isSuperAdmin: false }).metrics.find((m) => m.metric === "transito")!.periods.mes[0]).toMatchObject({ p50Ms: 12 * MIN, gpsHidden: null });
  });
  it("o servidor passa sempre o portão às contas por condutor", () => {
    const s = src("server/driverTimes.ts");
    expect(s).toContain("const gpsGate = { gate: o.gate, isSuperAdmin: o.isSuperAdmin };");
    expect(s.match(/driverTimeStats\([^)]*gpsGate \}\)/g)?.length).toBe(1);
    expect(s.match(/driverTimeSeries\(rows, \{[^}]*gpsGate \}\)/g)?.length).toBe(2);
    expect(src("server/routers.ts")).toContain('getDriverTimes({ employeeId: input.employeeId, refDay, cityKeys: await scopedServiceCityKeys(), isSuperAdmin: ctx.user.role === "super_admin" })');
  });
});

describe("Q7 — quem vê", () => {
  it("o módulo Condutores e agentes: supervisor (cidade), back office, admin, super admin; nem team leader nem front office", () => {
    for (const role of ["supervisor", "backoffice", "admin", "super_admin"]) expect(can({ role } as any, "condutores_agentes", "view"), role).toBe(true);
    for (const role of ["team_leader", "frontoffice", "condutor", "extra", "user"]) expect(can({ role } as any, "condutores_agentes", "view"), role).toBe(false);
    expect(condutoresTabs({ role: "supervisor" })).toEqual(["drivers", "agents"]);
    expect(condutoresTabs({ role: "super_admin" })).toContain("performance");
  });
  it("o procedimento pede o módulo, a ficha no âmbito e segue o alcance de cidade do módulo", () => {
    const r = src("server/routers.ts");
    const proc = r.slice(r.indexOf("driverTimes: protectedProcedure"), r.indexOf("// Agent performance history"));
    expect(proc).toContain('requireAccess(ctx.user, "condutores_agentes", "view");');
    expect(proc).toContain("await assertEmployeeAccess(input.employeeId);");
    expect(src("server/_core/accessContext.ts")).toContain('["reviews.driverTimes", "condutores_agentes"]');
  });
  it("aparece em Condutores e agentes → condutor e no detalhe do Desempenho (só super admin)", () => {
    expect(src("client/src/components/people/MovementPeoplePanel.tsx")).toContain("<DriverTimesCard employeeId={timesOf.employeeId}");
    expect(src("client/src/components/people/PeoplePerformancePanel.tsx")).toContain('(group === "drivers" || group === "teamleaders") && <DriverTimesCard');
  });
  it("não dá pontos: nem a Avaliação nem o ranking leem estes tempos", () => {
    for (const f of ["server/evaluationEngine.ts", "server/evaluationCore.ts", "server/peoplePerformance.ts", "shared/peoplePerformance.ts"]) {
      expect(src(f), f).not.toMatch(/driverTimes|service_times|serviceTimesAgg/);
    }
  });
});
