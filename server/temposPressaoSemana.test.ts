/**
 * Tempos nos ecrãs (P9) — Pressão, Semana e o cartão "De onde vêm os tempos":
 * percentis iguais ao percentile_cont, a "hora apertada" exatamente como hoje
 * com a definição desligada, a Fila só com cobertura ≥ 60 %, o Total novo
 * igual ao tempo de entrega antigo numa base sem chamadas, portão e mínimo
 * por célula, e o formato antigo dos procedimentos intacto.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GRID_MIN_SAMPLE, calendarWeekdayOf, percentileCont, pressureCellKey, queueCellsOf, timeStats, timesGrid, weekCellKey, type ServiceRow,
} from "./serviceTimesAgg";
import { coverageCardFrom, pressureTimesFrom, weekTimesFrom } from "./serviceTimesViews";
import { MIN_SAMPLE, percentile, pressureSummary, tightBlocks, tightHoursForDay, tightThresholds, type PressureSlot } from "../shared/extrasPressure";
import { DEFAULT_GARAGE_ROLES, SERVICE_TIMES_CALC_VERSION } from "../shared/serviceTimes";
import { SETTINGS, validateSetting } from "../shared/appSettings";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
const MIN = 60_000;
const OPEN = { gate: { visible: true, minCoveragePct: 60, minN: 20 }, isSuperAdmin: false };
const CLOSED = { gate: { visible: false, minCoveragePct: 60, minN: 20 }, isSuperAdmin: false };
const OFF = { lisbon: false, porto: false, faro: false };
const ON = { lisbon: true, porto: false, faro: false };

let n = 0;
function row(o: Partial<ServiceRow> & { q?: number | null; t?: number | null; total?: number }): ServiceRow {
  n++;
  const q = o.q === undefined ? 5 : o.q, t = o.t === undefined ? 10 : o.t;
  return {
    kind: "entrega", bookingId: `b${n}`, opDay: "2026-10-13", refHour: 17, cityKey: "lisboa", terminalClass: "t1", outcome: "entregue", startSource: "pendente",
    queueMs: q == null ? null : q * MIN, queueStatus: q == null ? "sem_pedido" : "medido",
    transitMs: t == null ? null : t * MIN, transitStatus: t == null ? "sem_pontos" : "medido", arrivedSource: t == null ? null : "gps_zona",
    ourMs: q != null && t != null ? (q + t) * MIN : null, ourStatus: q != null && t != null ? "medido" : "sem_pontos",
    customerMs: t == null ? null : 5 * MIN, customerStatus: t == null ? "sem_pontos" : "medido",
    totalMs: (o.total ?? (q ?? 0) + (t ?? 0) + 5) * MIN,
    ...o,
  };
}

describe("P9 — percentis iguais ao percentile_cont", () => {
  it("os valores do Postgres", () => {
    // SELECT percentile_cont(q) WITHIN GROUP (ORDER BY x) FROM (VALUES (1),(2),(3),(4)) v(x)
    expect(percentileCont([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentileCont([4, 1, 3, 2], 0.75)).toBe(3.25);
    expect(percentileCont([10, 20, 30, 40, 50], 0.9)).toBeCloseTo(46, 10);
    expect(percentileCont([7], 0.9)).toBe(7);
    expect(percentileCont([], 0.5)).toBeNull();
    expect(percentileCont([1, 2, NaN, 3], 0.5)).toBe(2);
  });
  it("o mesmo que o percentil da Pressão (já igual ao percentile_cont), em 200 listas aleatórias", () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    for (let i = 0; i < 200; i++) {
      const vals = Array.from({ length: 1 + Math.floor(rnd() * 40) }, () => Math.round(rnd() * 100000));
      for (const q of [0.5, 0.75, 0.9]) expect(percentileCont(vals, q)).toBeCloseTo(percentile(vals, q)!, 9);
    }
  });
  it("timeStats: n, média e p50/p75/p90", () => {
    expect(timeStats([MIN, 2 * MIN, 3 * MIN, 4 * MIN])).toEqual({ n: 4, meanMs: 150_000, p50Ms: 150_000, p75Ms: 195_000, p90Ms: 222_000 });
  });
});

// Pressão: células de um grupo (dia da semana × hora)
function slot(weekday: number, hour: number, o: Partial<PressureSlot> = {}): PressureSlot {
  return { group: "cidade_lisboa", weekday, hour, days: 4, checkinsDone: 4, checkoutsDone: 8, checkinsStarted: 4, checkoutsStarted: 8, concurrencyAvg: 1, concurrencyMax: 2, deliveryN: 8, deliveryP50: 20, deliveryP75: 30, deliveryP90: 40, pickupN: 4, pickupP50: 10, pickupP75: 15, ...o } as PressureSlot;
}

describe("P9 — hora apertada (extras.tightUsesQueue)", () => {
  let seed = 3;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const slots: PressureSlot[] = [];
  for (let wd = 1; wd <= 7; wd++) for (let h = 0; h < 24; h++) if (rnd() > 0.2) slots.push(slot(wd, h, { checkoutsDone: Math.floor(rnd() * 40), checkinsDone: Math.floor(rnd() * 20), deliveryN: Math.floor(rnd() * 12), deliveryP75: Math.round(rnd() * 60) }));
  const hours = Array.from({ length: 24 }, (_, i) => i + 3);
  it("desligada: as horas apertadas são EXATAMENTE as de hoje (sem opções, null ou sem Fila)", () => {
    const today = tightHoursForDay(slots, "2026-10-16", hours);
    expect(tightHoursForDay(slots, "2026-10-16", hours, null)).toEqual(today);
    expect(tightHoursForDay(slots, "2026-10-16", hours, { queue: null })).toEqual(today);
    expect(tightHoursForDay(slots, "2026-10-16", hours, {})).toEqual(today);
    expect(tightThresholds(slots)).toEqual(tightThresholds(slots, undefined, null));
    expect(tightBlocks(slots, 5, null)).toEqual(tightBlocks(slots, 5));
    expect(pressureSummary(slots, "Lisboa", 3, null)).toEqual(pressureSummary(slots, "Lisboa"));
    expect(today.size).toBeGreaterThan(0);
  });
  it("desligada: igual à regra antiga (cópia congelada da origin/main) em 300 grupos aleatórios", () => {
    // a regra de antes desta fase, copiada tal e qual (tightThresholds + tightReason + tightHoursForDay)
    const load = (s: PressureSlot) => (s.days > 0 ? (s.checkinsDone + s.checkoutsDone) / s.days : 0);
    const oldHours = (sl: PressureSlot[], day: string, hs: number[]) => {
      const loads = sl.map(load).filter((x) => x > 0);
      const p75s = sl.filter((s) => s.deliveryN >= MIN_SAMPLE && s.deliveryP75 != null).map((s) => s.deliveryP75 as number);
      const t = { load: loads.length ? percentile(loads, 0.8) : null, deliveryP75: p75s.length ? percentile(p75s, 0.8) : null };
      const byKey = new Map(sl.map((s) => [`${s.weekday}:${s.hour}`, s]));
      const wd = new Date(`${day}T12:00:00Z`).getUTCDay() || 7;
      const out = new Map<number, { load: boolean; delivery: boolean }>();
      for (const h of hs) {
        const s = byKey.get(`${h >= 24 ? (wd % 7) + 1 : wd}:${h % 24}`);
        if (!s) continue;
        const byLoad = t.load != null && load(s) > 0 && load(s) >= t.load;
        const byDelivery = t.deliveryP75 != null && s.deliveryN >= MIN_SAMPLE && s.deliveryP75 != null && s.deliveryP75 >= t.deliveryP75;
        if (byLoad || byDelivery) out.set(h, { load: byLoad, delivery: byDelivery });
      }
      return out;
    };
    let tight = 0;
    for (let g = 0; g < 300; g++) {
      const sl: PressureSlot[] = [];
      for (let wd = 1; wd <= 7; wd++) for (let h = 0; h < 24; h++) if (rnd() > 0.3) sl.push(slot(wd, h, { days: 1 + Math.floor(rnd() * 9), checkoutsDone: Math.floor(rnd() * 50), checkinsDone: Math.floor(rnd() * 30), deliveryN: Math.floor(rnd() * 12), deliveryP75: rnd() > 0.1 ? Math.round(rnd() * 90) : null }));
      for (const day of ["2026-10-12", "2026-10-16", "2026-10-18"]) {
        const now = tightHoursForDay(sl, day, hours, null);
        expect(now).toEqual(oldHours(sl, day, hours));
        tight += now.size;
      }
    }
    expect(tight).toBeGreaterThan(100);
    // o ecrã só passa a Fila quando o servidor a manda (definição ligada E cobertura ≥ 60 %)
    expect(src("client/src/pages/ExtrasDiaPage.tsx")).toContain("queue ? { queue } : null");
    expect(src("client/src/pages/extrasDia/PressureTab.tsx")).toContain("tg?.queue ? { queue: tg.queue } : null");
  });
  it("desligada na cidade: o servidor nem manda a Fila (mesmo com cobertura cheia)", () => {
    const rows = Array.from({ length: 40 }, (_, i) => row({ q: 3 + (i % 7), refHour: 17 }));
    const t = pressureTimesFrom(rows, { from: "2026-10-01", to: "2026-10-14", isSuperAdmin: false, gate: OPEN.gate, targetMinutes: 15, tightUsesQueue: OFF });
    expect(t.groups.cidade_lisboa.queue).toBeNull();
    expect(t.groups.cidade_lisboa.tightUsesQueue).toBe(false);
  });
  it("ligada com a Fila medida em < 60 % → fica o total", () => {
    const rows = [...Array.from({ length: 10 }, () => row({ q: 8 })), ...Array.from({ length: 11 }, () => row({ q: null }))];
    const t = pressureTimesFrom(rows, { from: "2026-10-01", to: "2026-10-14", isSuperAdmin: false, gate: OPEN.gate, targetMinutes: 15, tightUsesQueue: ON });
    expect(t.groups.cidade_lisboa.queueCoveragePct).toBeCloseTo(47.6, 1);
    expect(t.groups.cidade_lisboa.queue).toBeNull();
  });
  it("ligada com cobertura ≥ 60 %: a parte \"entregas lentas\" passa a ser a Fila", () => {
    // uma hora com a Fila longa (sexta 18h) e o total curto; outra com o total longo e a Fila curta (sexta 10h)
    const day = "2026-10-16"; // sexta
    const rows = [
      ...Array.from({ length: 6 }, () => row({ q: 40, total: 20, opDay: day, refHour: 18 })),
      ...Array.from({ length: 6 }, () => row({ q: 2, total: 60, opDay: day, refHour: 10 })),
      ...Array.from({ length: 30 }, (_, i) => row({ q: 4, opDay: day, refHour: 12 + (i % 3) })),
    ];
    const t = pressureTimesFrom(rows, { from: day, to: day, isSuperAdmin: false, gate: OPEN.gate, targetMinutes: 15, tightUsesQueue: ON });
    const g = t.groups.cidade_lisboa;
    expect(g.queue).not.toBeNull();
    expect(g.queue!["5:18"]).toEqual({ n: 6, p75: 40 });
    const s = [slot(5, 10, { deliveryP75: 60, deliveryN: 8, checkoutsDone: 1, checkinsDone: 0 }), slot(5, 18, { deliveryP75: 20, deliveryN: 8, checkoutsDone: 1, checkinsDone: 0 }),
      ...[12, 13, 14].map((h) => slot(5, h, { deliveryP75: 25, deliveryN: 8, checkoutsDone: 80, checkinsDone: 0 }))]; // muitos carros: as 10h e as 18h não apertam pelo volume
    const byTotal = tightHoursForDay(s, day, [10, 18]);
    const byQueue = tightHoursForDay(s, day, [10, 18], { queue: g.queue });
    expect(byTotal.get(10)?.delivery).toBe(true);
    expect(byTotal.has(18)).toBe(false);
    expect(byQueue.get(18)?.delivery).toBe(true);
    expect(byQueue.has(10)).toBe(false);
    expect(tightThresholds(s, undefined, { queue: g.queue }).by).toBe("fila");
  });
  it("a definição existe, por cidade, desligada por omissão", () => {
    expect(SETTINGS["extras.tightUsesQueue"].defaultValue).toEqual(OFF);
    expect(validateSetting("extras.tightUsesQueue", ON).ok).toBe(true);
    expect(validateSetting("extras.tightUsesQueue", { lisbon: "sim" }).ok).toBe(false);
    expect(SETTINGS["extras.tightUsesQueue"].description).toMatch(/Ligado:[\s\S]*Desligado:[\s\S]*Liga cidade a cidade\./);
  });
});

describe("P9 — Total novo vs o tempo de entrega antigo numa base sem chamadas", () => {
  it("sem chamadas e com o pendente antes do início, o Total = pendente → assinatura (o p75 é o mesmo)", () => {
    // o tempo de entrega antigo da Pressão: pendente → 1.º CHECK_OUT, por hora, p75 com o percentile_cont
    const cycles = Array.from({ length: 30 }, (_, i) => ({ R: 1000 + i * 7, S: 1000 + i * 7 + (i % 9), E: 1000 + i * 7 + 20 + ((i * 13) % 37) }));
    const old = percentile(cycles.map((c) => c.E - c.R), 0.75)!;
    const rows = cycles.map((c) => row({ startSource: "pendente", q: c.S - c.R, total: c.E - c.R, refHour: 17 }));
    const g = timesGrid(rows, pressureCellKey, { gate: OPEN, targetMinutes: 15 });
    const cell = g.cells[`${calendarWeekdayOf("2026-10-13", 17)}:17`];
    expect(cell.m.total!.p75Ms / MIN).toBeCloseTo(old, 9);
    expect(cell.m.total!.n).toBe(30);
  });
});

describe("P9 — grelhas: portão por período, mínimo por célula, chaves", () => {
  it("portão fechado: nenhum tempo com GPS em nenhuma célula; Fila e Total ficam", () => {
    const rows = Array.from({ length: 40 }, () => row({}));
    const g = timesGrid(rows, pressureCellKey, { gate: CLOSED, targetMinutes: 15 });
    const cells = Object.values(g.cells);
    expect(cells.length).toBe(1);
    expect(cells[0].m.fila).toBeTruthy();
    expect(cells[0].m.total).toBeTruthy();
    expect(cells[0].m.transito).toBeUndefined();
    expect(cells[0].m.nosso).toBeUndefined();
    expect(cells[0].inTarget).toBeUndefined();
    expect(g.hidden).toMatchObject({ transito: "Em calibração", nosso: "Em calibração", cliente: "Em calibração", meta: "Em calibração" });
    expect(g.coverage.transito).toBe(100);
    expect(JSON.stringify(g)).not.toMatch(/"transito":\{/);
  });
  it(`menos de ${GRID_MIN_SAMPLE} casos numa célula: em branco`, () => {
    expect(GRID_MIN_SAMPLE).toBe(MIN_SAMPLE);
    const rows = [...Array.from({ length: 4 }, () => row({ refHour: 8 })), ...Array.from({ length: 5 }, () => row({ refHour: 9 }))];
    const g = timesGrid(rows, (r) => String(r.refHour), { gate: OPEN, targetMinutes: 15 });
    expect(g.cells["8"].m.fila).toBeUndefined();
    expect(g.cells["9"].m.fila).toMatchObject({ n: 5 });
  });
  it("00–02h contam no dia de calendário seguinte (Pressão); a Semana fica no dia operacional", () => {
    expect(calendarWeekdayOf("2026-10-13", 1)).toBe(3); // terça (op) às 01h = quarta de calendário
    expect(pressureCellKey(row({ opDay: "2026-10-13", refHour: 1 }))).toBe("3:1");
    expect(weekCellKey(row({ opDay: "2026-10-13", refHour: 1 }))).toBe("2026-10-13|1");
  });
  it("Semana: células, dia, hora e semana; % na meta", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row({ q: 3, t: i < 15 ? 8 : 20, opDay: i < 10 ? "2026-10-12" : "2026-10-13", refHour: 17 }));
    const w = weekTimesFrom(rows, { gate: OPEN, targetMinutes: 15 });
    expect(Object.keys(w.cells.cells).sort()).toEqual(["2026-10-12|17", "2026-10-13|17"]);
    expect(w.byDay.cells["2026-10-12"].m.fila?.n).toBe(10);
    expect(w.byHour.cells["17"].m.fila?.n).toBe(20);
    expect(w.total.cells["*"].inTarget).toEqual({ n: 20, pct: 75 });
  });
  it("Fila por célula para a hora apertada (minutos) e a cobertura", () => {
    const rows = [...Array.from({ length: 6 }, () => row({ q: 12 })), ...Array.from({ length: 4 }, () => row({ q: null }))];
    const q = queueCellsOf(timesGrid(rows, pressureCellKey, { gate: OPEN, targetMinutes: 15 }));
    expect(q.coveragePct).toBe(60);
    expect(q.ok).toBe(true);
    expect(Object.values(q.cells)).toEqual([{ n: 6, p75: 12 }]);
  });
});

describe("P9 — cartão \"De onde vêm os tempos\"", () => {
  it("por cidade e semana: chamada, GPS, botão, saída do terminal, Zellos, zonas e garagens sem papel", () => {
    const rows: ServiceRow[] = [
      row({ startSource: "chamada" }), row({ arrivedSource: "botao" }), row({ t: null, transitStatus: "sem_zello" }), row({ t: null, transitStatus: "sem_destino" }),
      { ...row({}), kind: "recolha", terminalStatus: "medido", terminalExitSource: "gps", firstGarage: "P2", parkedGarage: "GARAGEM NOVA", startSource: "chamada" },
      { ...row({}), kind: "recolha", terminalStatus: "medido", terminalExitSource: "app_inicio_movimento", firstGarage: "PD" },
      { ...row({}), kind: "recolha", terminalStatus: "sem_zona", t2Status: "sem_zona_t2" },
      row({ outcome: "cancelado" }),
    ];
    const c = coverageCardFrom(rows, { roles: DEFAULT_GARAGE_ROLES, today: "2026-10-14" });
    expect(c.weeks).toHaveLength(1);
    expect(c.weeks[0]).toMatchObject({ city: "lisboa", week: "2026-10-12", deliveries: 4, withCall: 1, gps: 1, button: 1, transitUnmeasured: 2, pickups: 3, pickupWithCall: 1, terminalGps: 1, terminalApp: 1, terminalUnmeasured: 1, noZello: 1, missingZones: 3 });
    expect(c.garagesWithoutRole).toEqual(["GARAGEM NOVA"]);
    expect(c.calcVersion).toBe(SERVICE_TIMES_CALC_VERSION);
    expect(JSON.stringify(c)).not.toMatch(/"b\d+"/); // nada de reservas
  });
  it("linhas com outra versão ou outras zonas nos últimos 14 dias", () => {
    const rows = [
      row({ computedAt: "2026-10-14 05:40:00", paramsHash: "aaaaaaaaaaaaaaaa", calcVersion: SERVICE_TIMES_CALC_VERSION }),
      row({ computedAt: "2026-10-12 05:40:00", paramsHash: "bbbbbbbbbbbbbbbb", calcVersion: SERVICE_TIMES_CALC_VERSION }),
      row({ computedAt: "2026-10-12 05:40:00", paramsHash: "aaaaaaaaaaaaaaaa", calcVersion: SERVICE_TIMES_CALC_VERSION + 1 }),
    ];
    expect(coverageCardFrom(rows, { roles: DEFAULT_GARAGE_ROLES, today: "2026-10-14" }).staleRows).toBe(2);
  });
});

describe("P9 — procedimentos: o formato antigo fica, o bloco `times` vem ao lado", () => {
  const r = src("server/routers.ts");
  it("Pressão e Semana acrescentam `times` sem mudar o resto", () => {
    expect(r).toContain("return { ...view, times };");
    expect(r).toContain("return { ...r, times };");
    expect(r).toContain('getPressureTimes({ from: view.windowStart, to: view.windowEnd, cityKeys: keys, isSuperAdmin: ctx.user.role === "super_admin" })');
    expect(r).toContain('isSuperAdmin: ctx.user.role === "super_admin" });\n        return { ...r, times };');
  });
  it("o cartão da cobertura é só do super admin", () => {
    const s = src("server/sondaTemposRouter.ts");
    expect(s).toContain("serviceTimesCoverage: superOnly.query(");
    expect(src("client/src/pages/ExtrasDiaPage.tsx")).toContain('user?.role === "super_admin" && <ServiceTimesCoverageCard />');
  });
  it("a escala do dia só usa a Fila com o bloco a dizê-lo (definição ligada e cobertura)", () => {
    const page = src("client/src/pages/ExtrasDiaPage.tsx");
    expect(page).toContain("tightHoursForDay(slots, data.targetDate, data.hourly.map((h) => h.hour), queue ? { queue } : null)");
  });
});
