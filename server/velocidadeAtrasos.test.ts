/**
 * Jorge (14 out 2026), sobre Pessoas → Condutores e agentes → Desempenho:
 *  - "Dias acima do limite = 0 não é credível; há gente a 141 e 149 km/h e o
 *    limite em Portugal é 120";
 *  - "Porque é que os 141 não dão aviso nenhum, nem tiram pontos, nem nada?";
 *  - "80 atrasos em 8 dias? 2 dias com GPS em 8 de trabalho?";
 *  - "Como se contam os pontos desta aba" apertado à esquerda.
 * Testa: o limite (unidades, omissão 120, Definições), os picos falsos, os
 * excessos (pontos seguidos), o aviso (interruptor desligado por omissão), a
 * penalização (−10 por excesso na avaliação; o Desempenho não conta a dobrar),
 * os dias com/sem GPS e porquê, os atrasos (entregue = chegou ao local de
 * entrega) e o essencial do novo arranjo da tabela dos pontos.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SPEED_RULE, EXCESS_MERGE_GAP_S, GPS_ABSURD_KMH, SPEED_EXCESS_METRICS_VERSION, SPEED_RULE_SETTING_KEY,
  speedExcesses, speedSpikes, speedThresholdOf, trustedMaxSpeed, type SpeedPoint,
} from "../shared/speedRules";
import { validateSetting, SETTINGS, automationFlagDefault, AUTOMATION_FLAGS } from "../shared/appSettings";
import { GROUP_VIEW, PERF_METRICS, balancedColumns, explainPersonTotals, gpsDayOverLimit, lisbonDaysTouched, workPoints, emptyTotals } from "../shared/peoplePerformance";
import { EVALUATION_POINTS, scoreOf } from "../shared/evaluationRules";
import { computeEmployeeDays, markLateDeliveries, type ActionRow, type EngineInput } from "./evaluationCore";
import { buildEvaluationIdentity } from "./evaluationIdentity";
import { recordSpeedExcessesWith, GPS_SPEED_ALERTS_FLAG, speedAlertDayIsRecent, type SpeedAlertDeps } from "./speedAlerts";
import { DRIVER_METRICS_VERSION, countSpeedViolations, processGeoJsonHistory } from "./jobs/dailyDriverCollection";
import { splitByHolder } from "./zelloGps";
import { buildEngineActionCountsSql, DELIVERED_AT_SQL, movementWindow } from "./multiparkDb/movements";
import { assertReadOnlySql } from "./multiparkDb/client";

const src = (p: string) => readFileSync(resolve(import.meta.dirname, "..", p), "utf8");
const T0 = 1_791_000_000; // segundos
/** pontos a cada `step` s, com posição a andar à velocidade dada (≈ coerente) */
const track = (speeds: number[], step = 10, o: { lat0?: number; accurate?: boolean } = {}): SpeedPoint[] => {
  let lat = o.lat0 ?? 38.7;
  return speeds.map((v, i) => {
    if (i > 0) lat += ((speeds[i - 1] * step) / 3600) / 111; // km → graus (aprox.)
    return { ts: T0 + i * step, speed: v, accurate: o.accurate ?? true, lat, lon: -9.1 };
  });
};

describe("o limite: unidades, omissão e Definições", () => {
  it("120 km/h por omissão (autoestrada em Portugal), sem tolerância, 2 pontos seguidos; tudo em km/h", () => {
    expect(DEFAULT_SPEED_RULE).toEqual({ limitKmh: 120, tolerancePercent: 0, minPoints: 2 });
    expect(speedThresholdOf(DEFAULT_SPEED_RULE)).toBe(120);
    expect(speedThresholdOf({ limitKmh: 120, tolerancePercent: 10 })).toBe(132);
    // o Zello dá km/h (pedimos speedUnits=kmh) — nada de ×3,6
    expect(src("server/zelloGps.ts")).toContain("A API do Zello Work devolve a velocidade JÁ em km/h");
  });
  it("é uma definição validada (Definições → Parâmetros), viva, com a omissão", () => {
    const def = SETTINGS[SPEED_RULE_SETTING_KEY];
    expect(def.group).toBe("operacao");
    expect(def.wiring).toBe("live");
    expect(def.defaultValue).toEqual({ limitKmh: 120, tolerancePercent: 0, minPoints: 2 });
    expect(validateSetting(SPEED_RULE_SETTING_KEY, { limitKmh: 100, tolerancePercent: 5, minPoints: 3 })).toEqual({ ok: true, value: { limitKmh: 100, tolerancePercent: 5, minPoints: 3 } });
    expect(validateSetting(SPEED_RULE_SETTING_KEY, { limitKmh: 999, tolerancePercent: 0, minPoints: 2 }).ok).toBe(false);
    expect(validateSetting(SPEED_RULE_SETTING_KEY, { limitKmh: 120, tolerancePercent: 0, minPoints: 0 }).ok).toBe(false);
    expect(validateSetting(SPEED_RULE_SETTING_KEY, { limitKmh: 120 }).ok).toBe(false);
  });
  it("o limite usado em todo o lado vem da definição (já não da tabela speed_limits, que sem linha dava nulo e 999)", () => {
    expect(src("server/dayActivity.ts")).toMatch(/export async function speedThreshold[\s\S]{0,200}speedRuleNow\(\)\)\.threshold/);
    expect(src("server/dayActivity.ts")).not.toMatch(/getDefaultSpeedLimit/);
    const col = src("server/jobs/dailyDriverCollection.ts");
    expect(col).not.toMatch(/getDefaultSpeedLimit|: 999/);
    expect(col).toMatch(/const \{ rule: speedRule \} = await speedRuleNow\(\);/);
    expect(src("server/operationalRouter.ts")).toMatch(/checkNow[\s\S]{0,400}speedRuleNow\(\)/);
    expect(src("server/speedRule.ts")).toContain("return { ...DEFAULT_SPEED_RULE };");
  });
});

describe("picos falsos do GPS (explícitos, testados)", () => {
  it("acima de 250 km/h é erro; um salto isolado (sobe e desce > 15 km/h por segundo) é erro; o resto conta", () => {
    const p = track([40, 40, 141, 40, 40], 4);
    expect([...speedSpikes(p).entries()]).toEqual([[2, "jump"]]);
    expect(speedSpikes(track([100, 300, 100], 30)).get(1)).toBe("absurd");
    // a 141 numa autoestrada (vizinhos a 130–138) não é pico
    expect(speedSpikes(track([130, 135, 141, 138, 132], 10)).size).toBe(0);
    // antes deitava-se fora tudo acima de 150: agora um 160 real conta
    expect(trustedMaxSpeed(track([140, 155, 160, 150], 10)).maxSpeed).toBe(160);
    expect(GPS_ABSURD_KMH).toBe(250);
  });
  it("ponto impreciso (> 100 m) não conta, nem para pico nem para máxima", () => {
    const p = track([40, 145, 42], 10);
    p[1].accurate = false;
    expect(trustedMaxSpeed(p).maxSpeed).toBe(42);
  });
});

describe("excessos: pontos seguidos acima do limite", () => {
  it("uma autoestrada a 125–141 com uma descida curta é UM excesso, com a máxima e onde", () => {
    const p = track([100, 125, 133, 141, 115, 128, 100, 90], 20);
    const ex = speedExcesses(p, DEFAULT_SPEED_RULE);
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ maxSpeed: 141, points: 4, confirmedBy: "points", startTs: T0 + 20, endTs: T0 + 100 });
    expect(ex[0].lat).not.toBeNull();
  });
  it("dois troços afastados (mais de 2 min abaixo) são dois excessos", () => {
    const p = [...track([125, 130], 10), ...track([125, 128], 10).map((x) => ({ ...x, ts: x.ts + EXCESS_MERGE_GAP_S + 60 }))];
    expect(speedExcesses(p, DEFAULT_SPEED_RULE)).toHaveLength(2);
  });
  it("um ponto sozinho acima do limite só conta se a posição o confirmar (e então também é a máxima)", () => {
    const fake = track([100, 100, 100], 30).map((x, i) => (i === 1 ? { ...x, speed: 141 } : x)); // a posição diz 100
    expect(speedExcesses(fake, DEFAULT_SPEED_RULE)).toEqual([]);
    expect(trustedMaxSpeed(fake, { rule: DEFAULT_SPEED_RULE }).maxSpeed).toBe(100);
    const real = track([100, 141, 100], 30); // andou a 141 entre os pontos
    const ex = speedExcesses(real, DEFAULT_SPEED_RULE);
    expect(ex).toHaveLength(1);
    expect(ex[0].confirmedBy).toBe("position");
    expect(trustedMaxSpeed(real, { rule: DEFAULT_SPEED_RULE }).maxSpeed).toBe(141);
    // com minPoints 1 qualquer ponto de confiança conta
    expect(speedExcesses(fake, { ...DEFAULT_SPEED_RULE, minPoints: 1 })).toHaveLength(1);
  });
  it("a tolerância sobe o limite", () => {
    const p = track([125, 128, 130], 10);
    expect(speedExcesses(p, DEFAULT_SPEED_RULE)).toHaveLength(1);
    expect(speedExcesses(p, { ...DEFAULT_SPEED_RULE, tolerancePercent: 10 })).toHaveLength(0);
  });
});

describe("a recolha diária grava excessos (não pontos) e a máxima sem picos", () => {
  const feature = (ts: number, speed: number, lat: number, accuracy = 10) => ({ type: "Feature", geometry: { type: "Point", coordinates: [-9.1, lat] }, properties: { timestamp: ts, speed, accuracy } });
  const data = { features: [feature(T0, 40, 38.7), feature(T0 + 4, 141, 38.7001), feature(T0 + 8, 42, 38.7002), feature(T0 + 60, 125, 38.71), feature(T0 + 70, 131, 38.7135), feature(T0 + 80, 100, 38.716)] };
  it("o 141 de 4 s entre 40 e 42 é pico: a máxima é 131 e há 1 excesso (125 → 131)", () => {
    expect(processGeoJsonHistory(data, DEFAULT_SPEED_RULE).maxSpeed).toBe(131);
    expect(countSpeedViolations(data, DEFAULT_SPEED_RULE)).toBe(1);
    expect(DRIVER_METRICS_VERSION).toBe(SPEED_EXCESS_METRICS_VERSION);
    expect(SPEED_EXCESS_METRICS_VERSION).toBe(5);
  });
  it("PDA partilhado: cada pessoa com os seus excessos e a sua máxima", () => {
    const pts = track([100, 125, 130, 100, 100, 126, 129], 20);
    const mid = (pts[3].ts) * 1000;
    const shares = Object.fromEntries(splitByHolder(pts, [{ employeeId: 1, start: pts[0].ts * 1000, end: mid }, { employeeId: 2, start: mid, end: (pts[6].ts + 1) * 1000 }], DEFAULT_SPEED_RULE).map((s) => [s.employeeId, s]));
    expect(shares[1]).toMatchObject({ violations: 1, maxSpeed: 130 });
    expect(shares[2]).toMatchObject({ violations: 1, maxSpeed: 129 });
  });
  it("a recolha avisa (com o interruptor) e a re-divisão refaz a máxima e os excessos da linha", () => {
    const col = src("server/jobs/dailyDriverCollection.ts");
    expect(col).toContain("const excesses = speedExcesses(gpsPoints, speedRule);");
    expect(col).toContain("await recordSpeedExcesses({");
    expect(col).toMatch(/UPDATE daily_driver_history SET maxSpeed = [\s\S]{0,200}speedViolations = \$\{speedExcesses\(pts, speedRule\)\.length\}, metricsVersion = \$\{DRIVER_METRICS_VERSION\}/);
  });
});

describe("o aviso: interruptor GPS_SPEED_ALERTS, desligado por omissão", () => {
  const ex = speedExcesses(track([100, 125, 141, 128, 100], 20), DEFAULT_SPEED_RULE);
  const deps = (o: { on: boolean; seen?: string[]; today?: string }) => {
    const records: any[] = [], notes: any[] = [];
    const d: SpeedAlertDeps = {
      flagOn: async () => o.on,
      existingStarts: async () => new Set(o.seen ?? []),
      record: async (r) => { records.push(r); },
      notify: async (n) => { notes.push(n); },
      today: () => o.today ?? "2026-10-14",
    };
    return { d, records, notes };
  };
  const input = { zello: "pda12", displayName: "PDA 12", day: "2026-10-12", limitKmh: 120, excesses: ex, employeeAt: () => 7, employeeName: () => "Ana Silva" };
  it("está registado e desligado por omissão", () => {
    expect(AUTOMATION_FLAGS.some((f) => f.name === GPS_SPEED_ALERTS_FLAG)).toBe(true);
    expect(automationFlagDefault(GPS_SPEED_ALERTS_FLAG)).toBe(false);
  });
  it("desligado: não grava nem avisa", async () => {
    const { d, records, notes } = deps({ on: false });
    expect((await recordSpeedExcessesWith(d, input)).outcome).toBe("flag_off");
    expect(records).toEqual([]);
    expect(notes).toEqual([]);
  });
  it("ligado: um registo por excesso e UM aviso por pessoa (speed_alert → chefias da cidade dela)", async () => {
    const { d, records, notes } = deps({ on: true });
    expect(await recordSpeedExcessesWith(d, input)).toEqual({ outcome: "notified", recorded: 1, notified: 1 });
    expect(records[0]).toMatchObject({ zelloUsername: "pda12", speed: "141", speedLimit: 120, excessPercent: "17.5", notificationSent: 1 });
    expect(records[0].notes).toContain("ficha #7 (Ana Silva)");
    expect(notes[0]).toMatchObject({ kind: "speed_alert", employeeId: 7, title: "Excesso de velocidade" });
    expect(notes[0].body).toMatch(/^Ana Silva: 1 excesso\(s\) acima de 120 km\/h em 12\/10\/2026 — máxima 141 km\/h/);
  });
  it("um dia antigo (Recolher Dados de há semanas) grava os excessos mas não manda avisos atrasados", async () => {
    expect(speedAlertDayIsRecent("2026-10-12", "2026-10-14")).toBe(true);
    expect(speedAlertDayIsRecent("2026-10-11", "2026-10-14")).toBe(true);
    expect(speedAlertDayIsRecent("2026-10-10", "2026-10-14")).toBe(false);
    const { d, records, notes } = deps({ on: true, today: "2026-11-02" });
    expect(await recordSpeedExcessesWith(d, input)).toEqual({ outcome: "recorded_old", recorded: 1, notified: 0 });
    expect(records).toHaveLength(1);
    expect(notes).toEqual([]);
  });
  it("as duas passagens e a re-recolha não repetem", async () => {
    const start = new Date(ex[0].startTs * 1000).toISOString().slice(0, 19).replace("T", " ");
    const { d, records, notes } = deps({ on: true, seen: [start] });
    expect((await recordSpeedExcessesWith(d, input)).outcome).toBe("already");
    expect(records.length + notes.length).toBe(0);
  });
});

describe("a penalização: cada excesso −10 na avaliação; o Desempenho não conta a dobrar", () => {
  const identity = buildEvaluationIdentity({ employees: [{ id: 1, fullName: "Ana Silva", userId: 10, multiparkAgentName: null, multiparkAgentUserId: null }], agentAliases: [], accountAliases: [] });
  const base: EngineInput = {
    startDay: "2026-10-12", endDay: "2026-10-12", identity, employees: new Map([[1, { id: 1, position: "driver", contractType: null, extraLevel: null, monthlySalary: null, projectId: 1 }]]),
    actions: [], ponto: [], assignments: [], incidents: [], complaints: [], speedAlerts: [], penalties: [], rate: () => 10, tlWorkingDaysPerMonth: 15,
  };
  it("os excessos do GPS entram como excessos de velocidade (fora do período não)", () => {
    const out = computeEmployeeDays({ ...base, gpsSpeeding: [{ employeeId: 1, day: "2026-10-12", n: 2 }, { employeeId: 1, day: "2026-10-13", n: 5 }] });
    const m = out.rows[0].metrics;
    expect(m.speedingEvents).toBe(2);
    expect(scoreOf(m).lines.find((l) => l.key === "speeding")).toMatchObject({ count: 2, points: EVALUATION_POINTS.speeding, subtotal: -20 });
    // com os alertas da API externa somam
    const both = computeEmployeeDays({ ...base, gpsSpeeding: [{ employeeId: 1, day: "2026-10-12", n: 1 }], speedAlerts: [{ id: 9, employeeId: 1, createdAt: "2026-10-12 10:00:00" }] });
    expect(both.rows[0].metrics.speedingEvents).toBe(2);
  });
  it("o motor só lê os dias recolhidos com a regra nova (os antigos tinham pontos acima de 999)", () => {
    const eng = src("server/evaluationEngine.ts");
    expect(eng).toContain("h.metricsVersion >= ${SPEED_EXCESS_METRICS_VERSION}");
    expect(eng).toContain("gpsSpeeding: gpsSpeedingRows.map(");
    expect(src("server/evaluationCore.ts")).not.toContain("Os \"excessos\" do GPS Zello são PONTOS acima do limite, não eventos — não contam.");
  });
  it("Desempenho: os dias acima do limite já não descontam −10 (o excesso desconta na avaliação, que entra lá)", () => {
    expect(GROUP_VIEW.drivers.weights.overLimitDays).toBeUndefined();
    const t = emptyTotals();
    t.evalPoints = 100 - 10; t.overLimitDays = 1;
    expect(workPoints("drivers", t)).toBe(90);
    expect(PERF_METRICS.speedAlerts).toMatchObject({ label: "Excessos de velocidade", source: "avaliação" });
  });
});

describe("Desempenho: dias acima do limite, dias com e sem GPS", () => {
  it("linha nova pelos excessos; antiga pela máxima (aproximado); sem limite nunca", () => {
    expect(gpsDayOverLimit({ metricsVersion: 5, violations: 1, maxSpeed: 90 }, 120)).toEqual({ over: true, approx: false });
    expect(gpsDayOverLimit({ metricsVersion: 5, violations: 0, maxSpeed: 141 }, 120)).toEqual({ over: false, approx: false });
    expect(gpsDayOverLimit({ metricsVersion: 4, violations: 0, maxSpeed: 141 }, 120)).toEqual({ over: true, approx: true });
    expect(gpsDayOverLimit({ metricsVersion: 4, maxSpeed: 141 }, null)).toEqual({ over: false, approx: false });
  });
  it("check-in de PDA → dias de Lisboa que toca", () => {
    expect(lisbonDaysTouched("2026-10-12 22:30:00", "2026-10-13 02:00:00")).toEqual(["2026-10-12", "2026-10-13"]); // 23:30 → 03:00 Lisboa
    expect(lisbonDaysTouched("2026-10-12 08:00:00", null, Date.parse("2026-10-12T12:00:00Z"))).toEqual(["2026-10-12"]);
    expect(lisbonDaysTouched("lixo", null)).toEqual([]);
  });
  it("o porquê no detalhe: atrasos (entregas + ponto) e dias sem GPS (sem Zello ligado)", () => {
    const lines = explainPersonTotals({ delays: 80, lateDeliveries: 74, lateArrivals: 6, noGpsDays: 6, noZelloDays: 6, speedAlerts: 1 });
    expect(lines[0]).toBe("Atrasos 80 = 74 entrega(s) a mais de 15 min do pedido do cliente + 6 entrada(s) no ponto depois da hora da escala. Cada um −5 na avaliação.");
    expect(lines[1]).toMatch(/^6 dia\(s\) de trabalho sem GPS: 6 sem Zello ligado à pessoa .* "Utilizadores Zello ↔ Pessoas"\.$/);
    expect(lines[2]).toBe("Excessos de velocidade: 1 (−10 cada na avaliação).");
    expect(explainPersonTotals({ noGpsDays: 2, noZelloDays: 0 })[0]).toMatch(/2 com Zello ou PDA mas sem GPS recolhido/);
    expect(explainPersonTotals({})).toEqual([]);
  });
});

// ─── Desempenho por inteiro, com a BD simulada ──────────────────────────────
const h = vi.hoisted(() => ({ texts: [] as string[] }));
vi.mock("./dayActivity", () => ({ speedThreshold: async () => 120 }));
vi.mock("./db", () => ({
  getDb: async () => ({
    execute: async (q: any) => {
      const flat = (c: any): string => (c?.queryChunks ? c.queryChunks.map(flat).join("") : Array.isArray(c?.value) ? c.value.join("") : typeof c === "string" ? c : "");
      const text = flat(q);
      h.texts.push(text);
      if (/FROM employees e LEFT JOIN users/.test(text)) return [[{ id: 1, fullName: "Ana Condutora", position: "driver", contractType: "permanent", isActive: 1, userId: 11, photoUrl: null, role: "condutor" }]];
      if (/FROM employee_day_metrics/.test(text)) {
        const day = (d: string, o: Record<string, unknown> = {}) => ({ employeeId: 1, day: d, hoursWorked: 8, scheduledHours: 0, actions: 10, recolhas: 2, entregas: 3, movements: 2, parkingMoves: 1, spotChanges: 3, cancels: 0, otherActions: 0, weightedActions: 0, speedingEvents: 0, delays: 0, lateServices: 0, complaints: 0, accidents: 0, incidentsReported: 0, incidentsAgainst: 0, penaltyPoints: 0, actionsByType: "{}", ...o });
        return [[day("2026-10-05", { delays: 4, lateServices: 3, speedingEvents: 1 }), day("2026-10-06"), day("2026-10-07"), day("2026-10-08")]];
      }
      if (/FROM employee_metric_adjustments/.test(text)) return [[]];
      // 5 out: dois PDAs no mesmo dia (UM dia com GPS, UM acima do limite); 6 out: linha antiga a 125
      if (/FROM driver_day_shares s\s+LEFT JOIN daily_driver_history/.test(text)) return [[
        { employeeId: 1, day: "2026-10-05", km: 40, maxSpeed: 141, violations: 1, points: 300, metricsVersion: 5 },
        { employeeId: 1, day: "2026-10-05", km: 10, maxSpeed: 80, violations: 0, points: 90, metricsVersion: 5 },
      ]];
      if (/FROM daily_driver_history h/.test(text)) return [[{ employeeId: 1, day: "2026-10-06", km: 30, maxSpeed: 125, violations: 0, points: 200, metricsVersion: 4 }]];
      if (/zelloUsername IS NOT NULL/.test(text)) return [[]]; // sem Zello fixo na ficha
      // 7 out: leu um PDA com o QR (tinha Zello) mas não há GPS; 8 out: nada
      if (/FROM pda_checkins/.test(text)) return [[{ employeeId: 1, checkinAt: "2026-10-07 06:00:00", checkoutAt: "2026-10-07 15:00:00" }]];
      return [[]];
    },
  }),
}));

describe("Desempenho → Condutores: os números do detalhe", () => {
  it("dias com GPS sem contar a dobrar; dias acima do limite (novo e antigo); dias sem GPS e porquê; atrasos repartidos", async () => {
    const { loadPeoplePerformance } = await import("./peoplePerformance");
    const r = await loadPeoplePerformance({ period: "week", anchor: "2026-10-06", group: "drivers" });
    const ana = r.people[0];
    expect(ana.totals).toMatchObject({
      workDays: 4, gpsDays: 2, km: 80, maxSpeed: 141, overLimitDays: 2, noGpsDays: 2, noZelloDays: 1,
      delays: 4, lateDeliveries: 3, lateArrivals: 1, speedAlerts: 1, movements: 8, spotChanges: 12,
    });
    expect(r.speedLimit).toBe(120);
    expect(r.notes.join(" ")).toMatch(/1 dia\(s\) recolhido\(s\) antes de 14 out 2026 contam pela velocidade máxima/);
    // só leitura
    expect(h.texts.some((t) => /\b(INSERT|UPDATE|DELETE)\b/.test(t))).toBe(false);
  });
});

describe("atrasos: uma vez por entrega, até o carro chegar ao local de entrega", () => {
  const act = (b: string, ct: string, t: string, arrived?: string): ActionRow => ({ bookingExternalId: b, changeType: ct, actionTime: t, agentUserId: null, agentName: "Ana", arrivedAtDeliveryAt: arrived ?? null });
  it("o cliente nas malas não é atraso de quem entregou; sem a hora de chegada, o check-out", () => {
    const rows = [
      act("B1", "PENDING_CHECKOUT", "2026-10-12 10:00:00"),
      act("B1", "CHECK_OUT", "2026-10-12 10:40:00", "2026-10-12 10:12:00"), // chegou aos 12 min → não é atraso
      act("B2", "PENDING_CHECKOUT", "2026-10-12 11:00:00"),
      act("B2", "CHECK_OUT", "2026-10-12 11:40:00", "2026-10-12 11:25:00"), // chegou aos 25 → atraso
      act("B3", "PENDING_CHECKOUT", "2026-10-12 12:00:00"),
      act("B3", "CHECK_OUT", "2026-10-12 12:30:00"), // sem hora de chegada → o check-out (30) → atraso
      act("B4", "PENDING_CHECKOUT", "2026-10-12 13:00:00"),
      act("B4", "CHECK_OUT", "2026-10-12 13:30:00", "2026-10-12 09:00:00"), // a chegada não é deste pedido → o check-out
      act("B5", "PENDING_CHECKOUT", "2026-10-12 14:00:00"),
      act("B5", "PENDING_CHECKOUT", "2026-10-12 14:05:00"), // pedido repetido: conta o 1.º
      act("B5", "CHECK_OUT", "2026-10-12 14:10:00"),
      act("B5", "CHECK_OUT", "2026-10-12 14:50:00"), // 2.º check-out sem pedido novo: nunca é atraso (não duplica)
    ];
    expect([...markLateDeliveries(rows)].sort((a, b) => a - b)).toEqual([3, 5, 7]);
  });
  it("o SQL do motor usa a mesma regra (Booking.arrivedAtDeliveryAt entre o pedido e o check-out)", () => {
    const { sql } = buildEngineActionCountsSql({ lookbackFrom: "2026-08-29 02:00:00", ...movementWindow("2026-09-01") });
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain(`b."arrivedAtDeliveryAt" AS arrived_at`);
    expect(DELIVERED_AT_SQL).toBe("(CASE WHEN x.arrived_at IS NOT NULL AND x.arrived_at >= x.pending_at AND x.arrived_at <= x.at THEN x.arrived_at ELSE x.at END)");
    expect(sql).toContain(`AND ${DELIVERED_AT_SQL} - x.pending_at > $4::int * interval '1 minute'`);
    // é a mesma medida do Extras → Pressão
    expect(src("server/multiparkDb/pressure.ts")).toContain("entregue          = arrivedAtDeliveryAt → 1.º CHECK_OUT");
  });
});

describe("Como se contam os pontos desta aba: a toda a largura", () => {
  it("reparte os pesos em colunas equilibradas, pela mesma ordem", () => {
    const keys = ["a", "b", "c", "d", "e"];
    expect(balancedColumns(keys, 2)).toEqual([["a", "b", "c"], ["d", "e"]]);
    expect(balancedColumns(keys, 2).flat()).toEqual(keys);
    expect(balancedColumns([], 2)).toEqual([]);
    expect(balancedColumns(["a"], 2)).toEqual([["a"]]);
  });
  it("explicação por cima; pesos em grelha (2 colunas no computador, 1 no telemóvel); avaliação e equipa lado a lado em baixo", () => {
    const p = src("client/src/components/people/PeoplePerformancePanel.tsx");
    const block = p.slice(p.indexOf("function PointsTable("), p.indexOf("function GradeBar("));
    const explain = block.indexOf("border-l-4 border-primary");
    const grid = block.indexOf('className="grid gap-x-6 gap-y-2 md:grid-cols-2" data-weights-grid');
    const evalTable = block.indexOf('headRow("Pontos da avaliação — cada…")');
    expect(explain).toBeGreaterThan(0);
    expect(grid).toBeGreaterThan(explain);
    expect(evalTable).toBeGreaterThan(grid);
    expect(block).toContain("balancedColumns(keys, 2)");
    // no telemóvel, o 2.º cabeçalho esconde-se (fica uma lista só) e nada força largura
    expect(block).toContain('<thead className="max-md:hidden">');
    expect(block).not.toMatch(/min-w-\[/);
    // já não há a coluna da direita só com o texto
    expect(block).not.toContain('<div className="space-y-4">\n              {shownEval');
  });
});
