/**
 * Jorge (14 out 2026), sobre Pessoas → Condutores e agentes → Desempenho:
 *  - "Dias acima do limite = 0 não é credível; há gente a 141 e 149 km/h e o
 *    limite em Portugal é 120";
 *  - "Porque é que os 141 não dão aviso nenhum, nem tiram pontos, nem nada?";
 *  - "80 atrasos em 8 dias? 2 dias com GPS em 8 de trabalho?";
 *  - "Como se contam os pontos desta aba" apertado à esquerda.
 * Testa: o limite (unidades, omissão 120 sem tolerância desde a tarefa 62, Definições), os picos
 * falsos (com trajetos realistas), os excessos (pontos seguidos), o aviso
 * (interruptor desligado por omissão), a penalização (a regra do #381: 1
 * excesso por dia acima do limite, sem contar a dobrar com os alertas; o
 * Desempenho não volta a descontar), os dias com/sem GPS e porquê, o porquê
 * dos atrasos e o essencial do novo arranjo da tabela dos pontos.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SPEED_RULE, EXCESS_MERGE_GAP_S, GPS_ABSURD_KMH, POSITION_MAX_GAP_S, SPEED_EXCESS_METRICS_VERSION, SPEED_RULE_SETTING_KEY,
  LEGACY_COLLECTED_THRESHOLD_KMH, SPEED_THRESHOLD_METRICS_VERSION, gpsDayOverThreshold, gpsDayThresholdOf,
  speedExcesses, speedSpikes, speedThresholdOf, trustedMaxSpeed, type SpeedPoint, type SpeedRule,
} from "../shared/speedRules";
import { validateSetting, SETTINGS, automationFlagDefault, AUTOMATION_FLAGS } from "../shared/appSettings";
import { GROUP_VIEW, PERF_METRICS, balancedColumns, explainPersonTotals, gpsDayOverLimit, lisbonDaysTouched, workPoints, emptyTotals } from "../shared/peoplePerformance";
import { EVALUATION_POINTS, scoreOf } from "../shared/evaluationRules";
import { computeEmployeeDays, type EngineInput } from "./evaluationCore";
import { buildEvaluationIdentity } from "./evaluationIdentity";
import { recordSpeedExcessesWith, GPS_SPEED_ALERTS_FLAG, speedAlertDayIsRecent, type SpeedAlertDeps } from "./speedAlerts";
import { DRIVER_METRICS_VERSION, countSpeedViolations, processGeoJsonHistory } from "./jobs/dailyDriverCollection";
import { splitByHolder } from "./zelloGps";

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
/** Uma regra sem tolerância (120 km/h), para testar a mecânica dos excessos com números redondos. */
const R120: SpeedRule = { limitKmh: 120, tolerancePercent: 0, minPoints: 2 };
/** A omissão de antes da tarefa 62 (120 + 10 % = 132). */
const R132: SpeedRule = { limitKmh: 120, tolerancePercent: 10, minPoints: 2 };

describe("o limite: unidades, omissão e Definições", () => {
  it("tarefa 62: 120 km/h sem tolerância por omissão (conta acima de 120), 2 pontos seguidos; tudo em km/h", () => {
    expect(DEFAULT_SPEED_RULE).toEqual({ limitKmh: 120, tolerancePercent: 0, minPoints: 2 });
    expect(speedThresholdOf(DEFAULT_SPEED_RULE)).toBe(120);
    expect(speedThresholdOf(R132)).toBe(132);
    // o Zello dá km/h (pedimos speedUnits=kmh) — nada de ×3,6
    expect(src("server/zelloGps.ts")).toContain("A API do Zello Work devolve a velocidade JÁ em km/h");
    expect(src("server/zello.ts")).toContain('speedUnits: "kmh"');
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
  it("o limite usado em todo o lado vem da definição; para CONTAR, uma leitura falhada dá 'sem limite' (não a omissão)", () => {
    expect(src("server/dayActivity.ts")).toMatch(/export async function speedThreshold[\s\S]{0,200}speedRuleRead\(\)\)\?\.threshold \?\? null/);
    expect(src("server/dayActivity.ts")).not.toMatch(/getDefaultSpeedLimit/);
    const col = src("server/jobs/dailyDriverCollection.ts");
    // (a função antiga speedThresholdKmh() de gpsRules saiu; a coluna speedThresholdKmh da 0680 é outra coisa)
    expect(col).not.toMatch(/getDefaultSpeedLimit|speedThresholdKmh\(|: 999/);
    expect(col).toMatch(/const \{ rule: speedRule \} = await speedRuleNow\(\);/);
    expect(src("server/operationalRouter.ts")).toMatch(/checkNow[\s\S]{0,800}speedRuleNow\(\)/);
    const rule = src("server/speedRule.ts");
    expect(rule).toMatch(/if \(r == null\) return null; \/\/ BD em baixo ou erro a ler/);
    expect(rule).toContain("return (await speedRuleRead()) ?? withThreshold({ ...DEFAULT_SPEED_RULE });");
    // a omissão antiga (tabela speed_limits) saiu de shared/gpsRules.ts: um só sítio
    expect(src("shared/gpsRules.ts")).not.toMatch(/export function speedThresholdKmh|DEFAULT_SPEED_LIMIT_KMH =/);
  });
});

const appSettingsMock = vi.hoisted(() => ({ fresh: null as null | "erro" | { value: unknown } }));
vi.mock("./appSettings", async (original) => ({
  ...(await original<object>()),
  getSettingFresh: async () => {
    if (appSettingsMock.fresh === "erro") return null;
    return appSettingsMock.fresh ? { value: appSettingsMock.fresh.value, invalid: false, updatedAt: null, updatedByName: null } : { value: null, invalid: false, updatedAt: null, updatedByName: null };
  },
}));

describe("server/speedRule.ts: ler o limite", () => {
  it("sem valor gravado: a omissão (120, tarefa 62); com valor: o dele; leitura falhada: null para contar, a omissão para a recolha", async () => {
    const { speedRuleRead, speedRuleNow } = await import("./speedRule");
    appSettingsMock.fresh = null;
    expect((await speedRuleRead())?.threshold).toBe(120);
    appSettingsMock.fresh = { value: { limitKmh: 120, tolerancePercent: 10, minPoints: 2 } };
    expect((await speedRuleRead())?.threshold).toBe(132);
    appSettingsMock.fresh = { value: { limitKmh: 120, tolerancePercent: 0, minPoints: 3 } };
    expect(await speedRuleRead()).toEqual({ rule: { limitKmh: 120, tolerancePercent: 0, minPoints: 3 }, threshold: 120 });
    appSettingsMock.fresh = "erro";
    expect(await speedRuleRead()).toBeNull();
    expect((await speedRuleNow()).threshold).toBe(120);
    appSettingsMock.fresh = null;
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
  it("um salto de 2–3 reports seguidos também é pico (o GPS a saltar), mas 4 já é andar", () => {
    const two = track([40, 160, 158, 40, 42], 3);
    expect([...speedSpikes(two).keys()]).toEqual([1, 2]);
    expect(speedExcesses(two, DEFAULT_SPEED_RULE)).toEqual([]);
    expect(trustedMaxSpeed(two, { rule: DEFAULT_SPEED_RULE }).maxSpeed).toBe(42);
    const three = track([50, 170, 165, 168, 45], 3);
    expect(speedSpikes(three).size).toBe(3);
    // 4 pontos seguidos acima (12 s) — já não se trata como salto (fica para a regra dos excessos)
    expect(speedSpikes(track([50, 170, 165, 168, 166, 45], 3)).size).toBe(0);
  });
  it("carro parado: 0 → 141 → 0 é pico (os vizinhos parados contam)", () => {
    const p = track([0, 0, 141, 0, 0], 5);
    expect(speedSpikes(p).get(2)).toBe("jump");
    expect(trustedMaxSpeed(p).maxSpeed).toBe(0);
  });
});

describe("trajetos realistas (limite por omissão: 120 km/h desde a tarefa 62)", () => {
  it("autoestrada a 125–150 km/h durante 5 minutos (um ponto a cada 10 s): UM excesso, máxima 150", () => {
    const speeds = Array.from({ length: 31 }, (_, i) => 125 + Math.round(12.5 * (1 + Math.sin(i / 3)))); // 125…150
    const p = track([90, 110, ...speeds, 110, 90], 10);
    expect(speedSpikes(p).size).toBe(0);
    const ex = speedExcesses(p, DEFAULT_SPEED_RULE);
    expect(ex).toHaveLength(1);
    expect(ex[0].maxSpeed).toBe(150);
    expect(ex[0].confirmedBy).toBe("points");
    expect(trustedMaxSpeed(p, { rule: DEFAULT_SPEED_RULE }).maxSpeed).toBe(150);
  });
  it("autoestrada a 125–131: com a omissão (120, sem tolerância) um excesso; com a antiga (132) nada", () => {
    const p = track([100, 125, 128, 131, 127, 100], 10);
    expect(speedExcesses(p, DEFAULT_SPEED_RULE)).toHaveLength(1);
    expect(speedExcesses(p, R132)).toEqual([]);
  });
  it("um pico isolado de 300 no meio de um troço a 100: não conta e não estraga a máxima", () => {
    const p = track([100, 102, 300, 101, 99], 10);
    expect(speedSpikes(p).get(2)).toBe("absurd");
    expect(speedExcesses(p, DEFAULT_SPEED_RULE)).toEqual([]);
    expect(trustedMaxSpeed(p, { rule: DEFAULT_SPEED_RULE }).maxSpeed).toBe(102);
  });
  it("GPS com saltos na cidade (50 → 180 → 48 em 5 s, várias vezes): nenhum excesso; a máxima fica a da cidade", () => {
    const p = track([50, 52, 180, 48, 50, 51, 175, 172, 49, 50], 5);
    expect(speedExcesses(p, DEFAULT_SPEED_RULE)).toEqual([]);
    expect(trustedMaxSpeed(p, { rule: DEFAULT_SPEED_RULE }).maxSpeed).toBe(52);
  });
  it("Zello com pontos espaçados (a cada 3 min) a 145 na autoestrada: a posição confirma", () => {
    const p = track([100, 145, 100], 180);
    expect(POSITION_MAX_GAP_S).toBeGreaterThanOrEqual(180);
    const ex = speedExcesses(p, DEFAULT_SPEED_RULE);
    expect(ex).toHaveLength(1);
    expect(ex[0].confirmedBy).toBe("position");
    // a mesma velocidade sem a posição a acompanhar (o carro "não andou") não conta
    const fake = track([100, 100, 100], 180).map((x, i) => (i === 1 ? { ...x, speed: 145 } : x));
    expect(speedExcesses(fake, DEFAULT_SPEED_RULE)).toEqual([]);
  });
});

describe("excessos: pontos seguidos acima do limite (mecânica, limite 120)", () => {
  it("uma autoestrada a 125–141 com uma descida curta é UM excesso, com a máxima e onde", () => {
    const p = track([100, 125, 133, 141, 115, 128, 100, 90], 20);
    const ex = speedExcesses(p, R120);
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ maxSpeed: 141, points: 4, confirmedBy: "points", startTs: T0 + 20, endTs: T0 + 100 });
    expect(ex[0].lat).not.toBeNull();
  });
  it("dois troços afastados (mais de 2 min abaixo) são dois excessos", () => {
    // ronda 2: "abaixo" quer dizer pontos abaixo do limite pelo meio — sem eles (Zello espaçado) é o mesmo troço
    const below = track([100, 95, 100], 30).map((x) => ({ ...x, ts: x.ts + 40 }));
    const p = [...track([125, 130], 10), ...below, ...track([125, 128], 10).map((x) => ({ ...x, ts: x.ts + EXCESS_MERGE_GAP_S + 60 }))];
    expect(speedExcesses(p, R120)).toHaveLength(2);
  });
  it("um ponto sozinho acima do limite só conta se a posição o confirmar (e então também é a máxima)", () => {
    const fake = track([100, 100, 100], 30).map((x, i) => (i === 1 ? { ...x, speed: 141 } : x)); // a posição diz 100
    expect(speedExcesses(fake, R120)).toEqual([]);
    expect(trustedMaxSpeed(fake, { rule: R120 }).maxSpeed).toBe(100);
    const real = track([100, 141, 100], 30); // andou a 141 entre os pontos
    const ex = speedExcesses(real, R120);
    expect(ex).toHaveLength(1);
    expect(ex[0].confirmedBy).toBe("position");
    expect(trustedMaxSpeed(real, { rule: R120 }).maxSpeed).toBe(141);
    // com minPoints 1 qualquer ponto de confiança conta
    expect(speedExcesses(fake, { ...R120, minPoints: 1 })).toHaveLength(1);
  });
  it("a tolerância sobe o limite", () => {
    const p = track([125, 128, 130], 10);
    expect(speedExcesses(p, R120)).toHaveLength(1);
    expect(speedExcesses(p, { ...R120, tolerancePercent: 10 })).toHaveLength(0);
  });
});

describe("a recolha diária grava excessos (não pontos) e a máxima sem picos", () => {
  const feature = (ts: number, speed: number, lat: number, accuracy = 10) => ({ type: "Feature", geometry: { type: "Point", coordinates: [-9.1, lat] }, properties: { timestamp: ts, speed, accuracy } });
  const data = { features: [feature(T0, 40, 38.7), feature(T0 + 4, 141, 38.7001), feature(T0 + 8, 42, 38.7002), feature(T0 + 60, 125, 38.71), feature(T0 + 70, 131, 38.7135), feature(T0 + 80, 100, 38.716)] };
  it("o 141 de 4 s entre 40 e 42 é pico: a máxima é 131 e há 1 excesso (125 → 131) com o limite a 120", () => {
    expect(processGeoJsonHistory(data, R120).maxSpeed).toBe(131);
    expect(countSpeedViolations(data, R120)).toBe(1);
    // com a omissão antiga (132) não há excesso, e a máxima continua 131; com a nova (120) há 1
    expect(countSpeedViolations(data, R132)).toBe(0);
    expect(processGeoJsonHistory(data, R132).maxSpeed).toBe(131);
    expect(countSpeedViolations(data, DEFAULT_SPEED_RULE)).toBe(1);
    // tarefa 62: versão 6 = + o limiar da recolha; os excessos são de confiança desde a 5
    expect(DRIVER_METRICS_VERSION).toBe(SPEED_THRESHOLD_METRICS_VERSION);
    expect(SPEED_THRESHOLD_METRICS_VERSION).toBe(6);
    expect(SPEED_EXCESS_METRICS_VERSION).toBe(5);
  });
  it("PDA partilhado: cada pessoa com os seus excessos e a sua máxima", () => {
    const pts = track([100, 125, 130, 100, 100, 126, 129], 20);
    const mid = (pts[3].ts) * 1000;
    const shares = Object.fromEntries(splitByHolder(pts, [{ employeeId: 1, start: pts[0].ts * 1000, end: mid }, { employeeId: 2, start: mid, end: (pts[6].ts + 1) * 1000 }], R120).map((s) => [s.employeeId, s]));
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
  const ex = speedExcesses(track([100, 125, 141, 128, 100], 20), R120);
  const deps = (o: { on: boolean; seen?: string[]; today?: string }) => {
    const records: any[] = [], notes: any[] = [];
    const d: SpeedAlertDeps = {
      flagOn: async () => o.on,
      existingStarts: async () => o.seen ?? [],
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
    const stamp = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 19).replace("T", " ");
    const start = stamp(ex[0].startTs);
    const { d, records, notes } = deps({ on: true, seen: [start] });
    expect((await recordSpeedExcessesWith(d, input)).outcome).toBe("already");
    expect(records.length + notes.length).toBe(0);
    // ronda 2: a final trouxe pontos que a provisória não tinha e o mesmo troço começa um pouco antes — continua registado
    const later = deps({ on: true, seen: [stamp(ex[0].startTs + 20)] });
    expect((await recordSpeedExcessesWith(later.d, input)).outcome).toBe("already");
    // uma linha de há uma hora (outro troço) não esconde este
    const other = deps({ on: true, seen: [stamp(ex[0].startTs - 3600)] });
    expect((await recordSpeedExcessesWith(other.d, input)).outcome).toBe("notified");
  });
  it("o aviso diz o limite que se passou, JÁ com a tolerância (com 10 % seria 132, não 120)", () => {
    expect(src("server/jobs/dailyDriverCollection.ts")).toContain("limitKmh: speedThresholdOf(speedRule), excesses,");
  });
  it("o \"verificar agora\" manual (sem ecrã) também só avisa com o interruptor, e diz o limite com a tolerância", () => {
    const r = src("server/operationalRouter.ts");
    const block = r.slice(r.indexOf("speedMonitoring: router({"), r.indexOf("violations: router({", r.indexOf("speedMonitoring: router({")) + 4000);
    expect(block).toContain("const alertsOn = isFeatureEnabled(GPS_SPEED_ALERTS_FLAG");
    expect(block).toContain("if (!alertsOn) continue;");
    expect(block).toContain("const defaultLimit = { maxSpeed: Math.round(threshold) };");
  });
  it("os registos vão para speed_violations (não para speed_alerts): a Avaliação não os conta a dobrar", () => {
    const s = src("server/speedAlerts.ts");
    expect(s).toContain("recordSpeedViolation(row as any)");
    expect(s).not.toMatch(/createSpeedAlert|INSERT INTO speed_alerts/);
  });
});

describe("a penalização: 1 excesso (−10) por dia acima do limite, sem contar a dobrar", () => {
  const identity = buildEvaluationIdentity({ employees: [{ id: 1, fullName: "Ana Silva", userId: 10, multiparkAgentName: null, multiparkAgentUserId: null }], agentAliases: [], accountAliases: [] });
  const base: EngineInput = {
    startDay: "2026-10-12", endDay: "2026-10-12", identity, employees: new Map([[1, { id: 1, position: "driver", contractType: null, extraLevel: null, monthlySalary: null, projectId: 1 }]]),
    actions: [], ponto: [], assignments: [], incidents: [], complaints: [], speedAlerts: [], penalties: [], rate: () => 10, tlWorkingDaysPerMonth: 15,
    speedThresholdKmh: 132,
  };
  it("os 141 de um dia contam −10 (dois PDAs no mesmo dia: um só); abaixo do limite não", () => {
    const out = computeEmployeeDays({ ...base, gpsDays: [{ employeeId: 1, day: "2026-10-12", maxSpeed: 141 }, { employeeId: 1, day: "2026-10-12", maxSpeed: 149 }] });
    const m = out.rows[0].metrics;
    expect(m.speedingEvents).toBe(1);
    expect(scoreOf(m).lines.find((l) => l.key === "speeding")).toMatchObject({ count: 1, points: EVALUATION_POINTS.speeding, subtotal: -10 });
    expect(computeEmployeeDays({ ...base, gpsDays: [{ employeeId: 1, day: "2026-10-12", maxSpeed: 131 }] }).rows).toHaveLength(0);
  });
  it("com um alerta de velocidade nesse dia, o GPS não conta outra vez; sem limite lido, o GPS não conta", () => {
    const both = computeEmployeeDays({ ...base, gpsDays: [{ employeeId: 1, day: "2026-10-12", maxSpeed: 141 }], speedAlerts: [{ id: 9, employeeId: 1, createdAt: "2026-10-12 10:00:00" }] });
    expect(both.rows[0].metrics.speedingEvents).toBe(1);
    expect(computeEmployeeDays({ ...base, speedThresholdKmh: null, gpsDays: [{ employeeId: 1, day: "2026-10-12", maxSpeed: 200 }] }).rows).toHaveLength(0);
  });
  it("o motor lê o limite pela definição (dayActivity.speedThreshold → speedRuleRead)", () => {
    const eng = src("server/evaluationEngine.ts");
    expect(eng).toContain('const { speedThreshold } = await import("./dayActivity");');
    expect(eng).not.toContain("gpsSpeeding");
  });
  it("Desempenho: os dias acima do limite não descontam outra vez (já estão nos pontos da avaliação)", () => {
    expect(GROUP_VIEW.drivers.weights.overLimitDays).toBeUndefined();
    const t = emptyTotals();
    t.evalPoints = 100 - 10; t.overLimitDays = 1;
    expect(workPoints("drivers", t)).toBe(90);
    expect(workPoints("drivers", t, { evalPoints: 1, overLimitDays: -10 })).toBe(90); // nem com peso (#381: proibido nas abas da avaliação)
    expect(PERF_METRICS.speedAlerts).toMatchObject({ label: "Excessos de velocidade", source: "avaliação" });
  });
});

describe("tarefa 62: a trava da linha GPS (um dia nunca conta um excesso que a recolha não confirmou)", () => {
  const identity = buildEvaluationIdentity({ employees: [{ id: 1, fullName: "Ana Silva", userId: 10, multiparkAgentName: null, multiparkAgentUserId: null }], agentAliases: [], accountAliases: [] });
  const base: EngineInput = {
    startDay: "2026-11-02", endDay: "2026-11-02", identity, employees: new Map([[1, { id: 1, position: "driver", contractType: null, extraLevel: null, monthlySalary: null, projectId: 1 }]]),
    actions: [], ponto: [], assignments: [], incidents: [], complaints: [], speedAlerts: [], penalties: [], rate: () => 10, tlWorkingDaysPerMonth: 15,
    speedThresholdKmh: 120,
  };
  const over = (maxSpeed: number, collected: number | null | undefined, today = 120) =>
    computeEmployeeDays({ ...base, speedThresholdKmh: today, gpsDays: [{ employeeId: 1, day: "2026-11-02", maxSpeed, collectedThresholdKmh: collected }] }).rows[0]?.metrics.speedingEvents ?? 0;
  it("linha antiga (sem limiar gravado = 132) com 125 → não conta; com 133 → conta", () => {
    expect(gpsDayThresholdOf(120, null)).toBe(LEGACY_COLLECTED_THRESHOLD_KMH);
    expect(LEGACY_COLLECTED_THRESHOLD_KMH).toBe(132);
    expect(over(125, null)).toBe(0);
    expect(over(125, undefined)).toBe(0);
    expect(over(133, null)).toBe(1);
  });
  it("re-dividida a 120 com 125 confirmado → conta", () => {
    expect(over(125, 120)).toBe(1);
    expect(gpsDayOverThreshold("125.00", 120, "120.00")).toBe(true);
  });
  it("linha recolhida a 120 com o limite mudado para 125 → conta a 125", () => {
    expect(gpsDayThresholdOf(125, 120)).toBe(125);
    expect(over(124, 120, 125)).toBe(0);
    expect(over(126, 120, 125)).toBe(1);
  });
  it("sem limite de hoje (não deu para ler), nunca conta", () => {
    expect(gpsDayThresholdOf(null, 120)).toBeNull();
    expect(gpsDayOverThreshold(200, null, 120)).toBe(false);
  });
  it("a recolha (as duas passagens) e a re-divisão gravam o limiar; a Avaliação e o Desempenho leem-no (as partes pela historyId)", () => {
    const col = src("server/jobs/dailyDriverCollection.ts");
    expect(col).toContain("speedThresholdKmh: String(speedThresholdOf(speedRule)),");
    expect(col).toContain("speedThresholdKmh = ${String(speedThresholdOf(speedRule))} WHERE id = ${r.id}");
    const eng = src("server/evaluationEngine.ts");
    expect(eng).toMatch(/SELECT s\.employeeId, s\.day, s\.maxSpeed, h\.speedThresholdKmh FROM driver_day_shares s\s+LEFT JOIN daily_driver_history h ON h\.id = s\.historyId/);
    expect(eng).toContain("collectedThresholdKmh: r.speedThresholdKmh != null ? Number(r.speedThresholdKmh) : null");
    expect(src("drizzle/schema.ts")).toContain("speedThresholdKmh: decimal({ precision: 6, scale: 2 }),");
  });
  it("GPS_SPEED_ALERTS continua desligado por omissão (D3)", () => {
    expect(automationFlagDefault(GPS_SPEED_ALERTS_FLAG)).toBe(false);
  });
});

describe("Desempenho: dias acima do limite, dias com e sem GPS", () => {
  it("a mesma regra da avaliação (máxima > limite); linhas antigas marcadas como aproximadas; sem limite nunca", () => {
    expect(gpsDayOverLimit({ metricsVersion: 5, maxSpeed: 141 }, 132)).toEqual({ over: true, approx: false, locked: false });
    expect(gpsDayOverLimit({ metricsVersion: 5, maxSpeed: 131 }, 132)).toEqual({ over: false, approx: false, locked: false });
    expect(gpsDayOverLimit({ metricsVersion: 4, maxSpeed: 141 }, 132)).toEqual({ over: true, approx: true, locked: false });
    expect(gpsDayOverLimit({ metricsVersion: 4, maxSpeed: 141 }, null)).toEqual({ over: false, approx: false, locked: false });
    // tarefa 62 (trava): linha antiga (sem limiar gravado = 132) a 125 com o limite de hoje a 120 → não conta
    expect(gpsDayOverLimit({ metricsVersion: 5, maxSpeed: 125 }, 120)).toEqual({ over: false, approx: false, locked: true });
    expect(gpsDayOverLimit({ metricsVersion: 6, maxSpeed: 125, speedThresholdKmh: "120.00" }, 120)).toEqual({ over: true, approx: false, locked: false });
  });
  it("check-in de PDA → dias de Lisboa que toca", () => {
    expect(lisbonDaysTouched("2026-10-12 22:30:00", "2026-10-13 02:00:00")).toEqual(["2026-10-12", "2026-10-13"]); // 23:30 → 03:00 Lisboa
    expect(lisbonDaysTouched("2026-10-12 08:00:00", null, Date.parse("2026-10-12T12:00:00Z"))).toEqual(["2026-10-12"]);
    expect(lisbonDaysTouched("lixo", null)).toEqual([]);
  });
  it("o porquê no detalhe: atrasos ao trabalho (≥ 5 min), excessos e dias sem GPS (sem Zello ligado); a entrega atrasada saiu (tarefa 62)", () => {
    const lines = explainPersonTotals({ delays: 2, lateDeliveries: 9, noGpsDays: 6, noZelloDays: 6, speedAlerts: 1 });
    expect(lines[0]).toBe("Atrasos ao trabalho 2: entrada no ponto 5 min ou mais depois da hora da escala ou do horário, no máximo 1 por dia. Cada um −5 na avaliação.");
    expect(lines[1]).toMatch(/^6 dia\(s\) de trabalho sem GPS: 6 sem Zello ligado à pessoa .* "Utilizadores Zello ↔ Pessoas"\.$/);
    expect(lines[2]).toMatch(/^Excessos de velocidade 1: alertas e penalizações de velocidade e 1 por dia com o GPS do Zello acima do limite\./);
    expect(lines.join(" ")).not.toMatch(/Entregas atrasadas/);
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
        const day = (d: string, o: Record<string, unknown> = {}) => ({ employeeId: 1, day: d, hoursWorked: 8, scheduledHours: 0, actions: 10, recolhas: 2, entregas: 3, movements: 2, parkingMoves: 1, spotChanges: 3, cancels: 0, otherActions: 0, weightedActions: 0, speedingEvents: 0, delays: 0, lateServices: 0, complaints: 0, accidents: 0, incidentsReported: 0, incidentsAgainst: 0, penaltyPoints: 0, actionsByType: "{}", rulesVersion: 2, ...o });
        return [[day("2026-10-05", { delays: 4, lateServices: 3, speedingEvents: 1 }), day("2026-10-06"), day("2026-10-07"), day("2026-10-08")]];
      }
      if (/FROM employee_metric_adjustments/.test(text)) return [[]];
      // 5 out: dois PDAs no mesmo dia (UM dia com GPS, UM acima do limite — a parte recolhida a 120);
      // 6 out: linha antiga a 125 (sem limiar gravado = 132: a trava não a conta a 120)
      if (/FROM driver_day_shares s\s+LEFT JOIN daily_driver_history/.test(text)) return [[
        { employeeId: 1, day: "2026-10-05", km: 40, maxSpeed: 125, violations: 1, points: 300, metricsVersion: 6, speedThresholdKmh: "120.00" },
        { employeeId: 1, day: "2026-10-05", km: 10, maxSpeed: 80, violations: 0, points: 90, metricsVersion: 6, speedThresholdKmh: "120.00" },
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
  it("dias com GPS sem contar a dobrar; dias acima do limite (novo e antigo); dias sem GPS e porquê; atrasos separados", async () => {
    const { loadPeoplePerformance } = await import("./peoplePerformance");
    const r = await loadPeoplePerformance({ period: "week", anchor: "2026-10-06", group: "drivers" });
    const ana = r.people[0];
    expect(ana.totals).toMatchObject({
      workDays: 4, gpsDays: 2, km: 80, maxSpeed: 125, overLimitDays: 1, noGpsDays: 2, noZelloDays: 1,
      // tarefa 62: "Atrasos ao trabalho" = delays − lateServices nas linhas antigas (4 − 3 = 1); a entrega atrasada saiu
      delays: 1, speedAlerts: 1, movements: 8, spotChanges: 12,
    });
    expect(r.speedLimit).toBe(120);
    // tarefa 62: o 6 out (125, recolhido a 132) não conta e a nota diz porquê
    expect(r.notes.join(" ")).toMatch(/1 dia\(s\) com a máxima acima do limite de hoje não contam porque foram recolhidos com um limite mais largo/);
    expect(h.texts.some((t) => /h\.speedThresholdKmh FROM driver_day_shares s/.test(t))).toBe(true);
    expect(ana.totals.lateDeliveries ?? 0).toBe(0);
    // só leitura
    expect(h.texts.some((t) => /\b(INSERT|UPDATE|DELETE)\b/.test(t))).toBe(false);
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
    // ronda 2: nos condutores (sem a tabela da equipa) a da avaliação também se reparte pelas 2 colunas
    expect(block).toContain("(showTeam ? [EVALUATION_RULES] : balancedColumns(EVALUATION_RULES, 2))");
    expect(block).not.toMatch(/min-w-\[/);
    // a régua diz as regras do #381 (mudança de lugar +1, não é movimento)
    expect(block).toContain("mudança de lugar +1 — não é movimento");
  });
});
