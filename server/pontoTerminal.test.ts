import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TERMINAL_AIRPORTS,
  TERMINAL_RETURN_WINDOW_MIN,
  airportCityOf,
  classifyCheckIn,
  classifyCheckOut,
  distanceMeters,
  isAtAirport,
  isPaidTerminal,
  payLevelForShift,
  splitTerminalHours,
  terminalLevelOf,
} from "../shared/pontoTerminal";
import { AUTOMATION_FLAGS, SETTINGS, automationFlagDefault, validateSetting } from "../shared/appSettings";
import { isFeatureEnabled } from "./_core/featureFlags";
import { pairShifts, countableShifts } from "./payroll/shifts";
import { computeEmployeeMonth } from "./payroll/compute";
import { aggregateExtrasCost } from "./finance/extrasCost";
import { MIGRATION_0555_STATEMENTS } from "./migrations/migration_0555";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";

// Terminal no ponto (aeroporto) — pauta do Rafael, Jorge 7 out 2026.

const city = vi.hoisted(() => ({ key: "lisboa" as string | null }));
vi.mock("./employeeCity", () => ({
  resolveCitiesForEmployeeIds: async (ids: number[]) => new Map(ids.map((id) => [id, { city: city.key, source: "project" }])),
}));
vi.mock("./appSettings", () => ({ getSetting: async () => null, loadFeatureFlagOverrides: async () => new Map() }));

const LIS = DEFAULT_TERMINAL_AIRPORTS.lisbon;
/** Ponto a ~X metros a norte do centro do aeroporto de Lisboa. */
const northOfLis = (m: number) => ({ lat: LIS.lat + m / 111_320, lng: LIS.lng });
const src = (p: string) => readFileSync(resolve(import.meta.dirname, "..", p), "utf8");

describe("aeroporto: dentro / fora do raio", () => {
  it("valores por omissão: LIS, OPO e FAO com 1500 m", () => {
    expect(DEFAULT_TERMINAL_AIRPORTS).toEqual({
      lisbon: { lat: 38.7742, lng: -9.1342, radiusM: 1500 },
      porto: { lat: 41.2481, lng: -8.6814, radiusM: 1500 },
      faro: { lat: 37.0144, lng: -7.9659, radiusM: 1500 },
    });
  });
  it("distância de haversine (Lisboa → Porto ≈ 274 km)", () => {
    const d = distanceMeters(LIS.lat, LIS.lng, DEFAULT_TERMINAL_AIRPORTS.porto.lat, DEFAULT_TERMINAL_AIRPORTS.porto.lng);
    expect(d / 1000).toBeGreaterThan(270);
    expect(d / 1000).toBeLessThan(280);
  });
  it("dentro do raio → true; fora → false", () => {
    const inside = northOfLis(1000), outside = northOfLis(2000);
    expect(isAtAirport(String(inside.lat), String(inside.lng), LIS)).toBe(true);
    expect(isAtAirport(outside.lat, outside.lng, LIS)).toBe(false);
    expect(isAtAirport(LIS.lat, LIS.lng, LIS)).toBe(true);
  });
  it("sem GPS, coordenadas inválidas, 0,0 ou cidade sem aeroporto → null", () => {
    expect(isAtAirport(null, null, LIS)).toBeNull();
    expect(isAtAirport("", "-9.1", LIS)).toBeNull();
    expect(isAtAirport("abc", "-9.1", LIS)).toBeNull();
    expect(isAtAirport(0, 0, LIS)).toBeNull();
    expect(isAtAirport(LIS.lat, LIS.lng, null)).toBeNull();
  });
  it("cidade da ficha → aeroporto (lisboa/porto/faro)", () => {
    expect(airportCityOf("lisboa")).toBe("lisbon");
    expect(airportCityOf("porto")).toBe("porto");
    expect(airportCityOf("faro")).toBe("faro");
    expect(airportCityOf(null)).toBeNull();
    expect(airportCityOf("braga")).toBeNull();
  });
});

describe("entrada e saída: troço de terminal", () => {
  const at = new Date("2026-10-07T14:00:00Z");
  it("entrada no aeroporto abre o troço de terminal", () => {
    expect(classifyCheckIn({ atAirport: true, prev: null, at })).toEqual({ status: "start", reason: "start" });
    // a saída anterior foi normal (a chegada ao aeroporto: saída + entrada)
    expect(classifyCheckIn({ atAirport: true, prev: { type: "check_out", recordedAt: "2026-10-07 13:59:00", terminalStatus: null }, at }).status).toBe("start");
  });
  it("regresso: entrada logo a seguir a fechar um troço de terminal → volta a extra normal", () => {
    const prev = { type: "check_out" as const, recordedAt: "2026-10-07 13:58:00", terminalStatus: "auto" };
    expect(classifyCheckIn({ atAirport: true, prev, at })).toEqual({ status: null, reason: "return" });
    expect(classifyCheckIn({ atAirport: true, prev: { ...prev, terminalStatus: "pending" }, at }).reason).toBe("return");
  });
  it(`passados mais de ${TERMINAL_RETURN_WINDOW_MIN} min já não é regresso (novo troço de terminal)`, () => {
    const prev = { type: "check_out" as const, recordedAt: "2026-10-07 10:00:00", terminalStatus: "auto" };
    expect(classifyCheckIn({ atAirport: true, prev, at }).status).toBe("start");
  });
  it("entrada fora do aeroporto ou sem GPS → normal", () => {
    expect(classifyCheckIn({ atAirport: false, prev: null, at })).toEqual({ status: null, reason: "outside" });
    expect(classifyCheckIn({ atAirport: null, prev: null, at })).toEqual({ status: null, reason: "no_gps" });
  });
  it("saída: no aeroporto → terminal; fora ou sem GPS → por confirmar; entrada normal → normal", () => {
    expect(classifyCheckOut({ checkInStatus: "start", atAirport: true })).toBe("auto");
    expect(classifyCheckOut({ checkInStatus: "start", atAirport: false })).toBe("pending");
    expect(classifyCheckOut({ checkInStatus: "start", atAirport: null })).toBe("pending");
    expect(classifyCheckOut({ checkInStatus: null, atAirport: true })).toBeNull();
  });
  it("só paga terminal o automático (GPS) e o confirmado pelo RH", () => {
    expect(isPaidTerminal("auto")).toBe(true);
    expect(isPaidTerminal("confirmed")).toBe(true);
    expect(isPaidTerminal("pending")).toBe(false);
    expect(isPaidTerminal("rejected")).toBe(false);
    expect(isPaidTerminal("start")).toBe(false);
    expect(isPaidTerminal(null)).toBe(false);
  });
});

describe("nível + 1 (tecto no master)", () => {
  it("júnior → sénior, sénior → terminal, terminal → master, master fica master", () => {
    expect([1, 2, 3, 4].map((l) => terminalLevelOf(l))).toEqual([2, 3, 4, 4]);
    expect(terminalLevelOf(null)).toBe(2);
  });
  it("payLevelForShift: interruptor desligado ou troço que não paga → o nível dele", () => {
    expect(payLevelForShift(1, { terminalStatus: "auto", enabled: true })).toBe(2);
    expect(payLevelForShift(4, { terminalStatus: "confirmed", enabled: true })).toBe(4);
    expect(payLevelForShift(1, { terminalStatus: "auto", enabled: false })).toBe(1);
    expect(payLevelForShift(2, { terminalStatus: "pending", enabled: true })).toBe(2);
    expect(payLevelForShift(2, { terminalStatus: "rejected", enabled: true })).toBe(2);
    expect(payLevelForShift(3, { terminalStatus: null, enabled: true })).toBe(3);
  });
  it("divide as horas em normais e terminal; desligado = tudo normal", () => {
    const shifts = [{ hours: 6, terminalStatus: null }, { hours: 4, terminalStatus: "auto" }, { hours: 2, terminalStatus: "pending" }];
    expect(splitTerminalHours(shifts, true)).toEqual({ normalHours: 8, terminalHours: 4, pendingHours: 2 });
    expect(splitTerminalHours(shifts, false)).toEqual({ normalHours: 12, terminalHours: 0, pendingHours: 0 });
  });
});

describe("ordenado: horas mistas", () => {
  const rates = { extraRateByLevel: new Map([[1, 4.5], [2, 5], [3, 5.5], [4, 6]]), extraRateByName: new Map([["junior", 4.5], ["senior", 5], ["terminal", 5.5], ["master", 6]]) };
  const extra = (level: number) => ({ id: 1, fullName: "Extra", position: "extra", extraLevel: level, isActive: 1, contractStart: null, contractEnd: null });
  // 7 out 2026 (quarta): 08–14 normal, 14–18 terminal (GPS), 18–20 terminal por confirmar
  const records = (terminal: [string | null, string | null, string | null]) => [
    { id: 1, type: "check_in" as const, recordedAt: "2026-10-07 07:00:00" },
    { id: 2, type: "check_out" as const, recordedAt: "2026-10-07 13:00:00", terminalStatus: terminal[0] },
    { id: 3, type: "check_in" as const, recordedAt: "2026-10-07 13:00:00", terminalStatus: terminal[1] ? "start" : null },
    { id: 4, type: "check_out" as const, recordedAt: "2026-10-07 17:00:00", terminalStatus: terminal[1] },
    { id: 5, type: "check_in" as const, recordedAt: "2026-10-07 17:00:00", terminalStatus: terminal[2] ? "start" : null },
    { id: 6, type: "check_out" as const, recordedAt: "2026-10-07 19:00:00", terminalStatus: terminal[2] },
  ];
  const run = (level: number, enabled: boolean | undefined, terminal: [string | null, string | null, string | null] = [null, "auto", "pending"]) =>
    computeEmployeeMonth({ employee: extra(level), year: 2026, month: 10, shifts: pairShifts(records(terminal)).shifts, leaves: [], ...rates, terminalEnabled: enabled });

  it("o troço de terminal chega ao turno pela saída", () => {
    const s = countableShifts(pairShifts(records([null, "auto", "pending"])).shifts);
    expect(s.map((x) => x.terminalStatus)).toEqual([null, "auto", "pending"]);
  });
  it("júnior: 8 h × 4,50 € + 4 h terminal × 5,00 € (o por confirmar paga normal)", () => {
    const r = run(1, true);
    expect(r.totalHours).toBe(12);
    expect(r.terminalHours).toBe(4);
    expect(r.terminalHourlyRate).toBe(5);
    expect(r.terminalPayment).toBe(20);
    expect(r.terminalPendingHours).toBe(2);
    expect(r.extraPayment).toBe(8 * 4.5 + 20);
    expect(r.totalPayment).toBe(56);
    expect(r.warnings.some((w) => w.includes("terminal por confirmar"))).toBe(true);
  });
  it("sénior paga o terminal à taxa de terminal (5,50 €); terminal à de master (6 €)", () => {
    expect(run(2, true).terminalPayment).toBe(22);
    expect(run(3, true).terminalPayment).toBe(24);
  });
  it("master fica master: o total é igual a sem terminal", () => {
    const r = run(4, true);
    expect(r.terminalHourlyRate).toBe(6);
    expect(r.extraPayment).toBe(12 * 6);
  });
  it("confirmado pelo RH paga terminal; desmarcado não", () => {
    expect(run(1, true, [null, "confirmed", "rejected"]).terminalHours).toBe(4);
    expect(run(1, true, [null, "rejected", "rejected"]).terminalHours).toBe(0);
  });
  it("interruptor desligado = igual a hoje (mesmo resultado que sem estados de terminal)", () => {
    const off = run(1, false);
    const before = computeEmployeeMonth({ employee: extra(1), year: 2026, month: 10, shifts: pairShifts(records([null, null, null])).shifts, leaves: [], ...rates });
    expect(off.extraPayment).toBe(12 * 4.5);
    expect(off.terminalHours).toBe(0);
    expect(off.terminalPendingHours).toBe(0);
    expect(off.warnings).toEqual(before.warnings);
    expect({ ...off }).toEqual({ ...before });
    expect(run(1, undefined).extraPayment).toBe(54);
  });
  it("nível seguinte sem taxa: paga à taxa dele, com aviso (nunca a mais sem taxa)", () => {
    const r = computeEmployeeMonth({ employee: extra(1), year: 2026, month: 10, shifts: pairShifts(records([null, "auto", null])).shifts, leaves: [], extraRateByLevel: new Map([[1, 4.5]]), extraRateByName: new Map(), terminalEnabled: true });
    expect(r.terminalHourlyRate).toBe(4.5);
    expect(r.extraPayment).toBe(12 * 4.5);
    expect(r.warnings.some((w) => w.includes("nível de extra 2 sem taxa"))).toBe(true);
  });
  it("quem não é extra não tem terminal", () => {
    const r = computeEmployeeMonth({ employee: { ...extra(1), position: "driver", monthlySalary: 1000 }, year: 2026, month: 10, shifts: pairShifts(records([null, "auto", null])).shifts, leaves: [], ...rates, terminalEnabled: true });
    expect(r.terminalHours).toBe(0);
    expect(r.terminalPayment).toBe(0);
  });
});

describe("custo dos extras (Finanças / Métricas): a mesma regra", () => {
  const rates = { junior: 4.5, senior: 5, terminal: 5.5, master: 6 };
  const rows = {
    assignments: [],
    ponto: [
      { recordedAt: "2026-10-07 13:00:00", hours: "6", level: 1, employeeId: 1, projectId: 10, terminalStatus: null },
      { recordedAt: "2026-10-07 17:00:00", hours: "4", level: 1, employeeId: 1, projectId: 10, terminalStatus: "auto" },
      { recordedAt: "2026-10-07 19:00:00", hours: "2", level: 1, employeeId: 1, projectId: 10, terminalStatus: "pending" },
      { recordedAt: "2026-10-07 19:00:00", hours: "3", level: 4, employeeId: 2, projectId: 10, terminalStatus: "confirmed" },
    ],
  };
  const opts = (terminal?: boolean) => ({ dayOfRecord: (v: string | null) => String(v).slice(0, 10), cityOfProject: () => null, terminal });
  it("ligado: o troço de terminal paga ao nível seguinte (master fica master)", () => {
    const a = aggregateExtrasCost(rows, rates, opts(true));
    expect(a.realByDay.get("2026-10-07")).toBe(8 * 4.5 + 4 * 5 + 3 * 6);
    // horas e pessoas continuam no nível da ficha
    expect(a.realByLevel.get("junior")!.hours).toBe(12);
    expect(a.realByLevel.get("junior")!.cost).toBe(8 * 4.5 + 4 * 5);
  });
  it("desligado (ou omitido): igual a hoje", () => {
    const expected = 12 * 4.5 + 3 * 6;
    expect(aggregateExtrasCost(rows, rates, opts(false)).realByDay.get("2026-10-07")).toBe(expected);
    expect(aggregateExtrasCost(rows, rates, opts()).realByDay.get("2026-10-07")).toBe(expected);
  });
  it("o ordenado e o custo usam a mesma função (shared/pontoTerminal)", () => {
    // 7 out 2026 ("partial"): troço a troço pela mesma regra das horas
    expect(src("server/finance/extrasCost.ts")).toContain("terminalSplitOfShift(");
    expect(src("shared/pontoTerminal.ts")).toMatch(/export function splitTerminalHours[\s\S]*terminalSplitOfShift\(/);
    expect(src("server/payroll/compute.ts")).toContain("splitTerminalHours(");
    expect(src("server/payroll/compute.ts")).toContain("terminalLevelOf(");
    expect(src("server/finance/engine.ts")).toContain("terminal: extrasTerminal");
    expect(src("server/extrasMetrics.ts")).toContain("terminal: await pontoTerminalEnabled()");
  });
});

describe("interruptor, definições e migração", () => {
  it("PONTO_TERMINAL existe e está desligado por omissão", () => {
    const f = AUTOMATION_FLAGS.find((x) => x.name === "PONTO_TERMINAL");
    expect(f?.label).toBe("Terminal no ponto (aeroporto)");
    expect(f?.defaultEnabled).toBe(false);
    expect(automationFlagDefault("PONTO_TERMINAL")).toBe(false);
    expect(isFeatureEnabled("PONTO_TERMINAL", { defaultEnabled: false, env: {} })).toBe(false);
  });
  it("aeroportos nas Definições (Extras), com validação", () => {
    expect(SETTINGS["ponto.terminalAirports"].group).toBe("extras");
    expect(validateSetting("ponto.terminalAirports", DEFAULT_TERMINAL_AIRPORTS).ok).toBe(true);
    expect(validateSetting("ponto.terminalAirports", { ...DEFAULT_TERMINAL_AIRPORTS, faro: { lat: 37, lng: -7.9, radiusM: 20 } }).ok).toBe(false);
    expect(validateSetting("ponto.terminalAirports", { ...DEFAULT_TERMINAL_AIRPORTS, porto: { lat: 95, lng: -8.6, radiusM: 1500 } }).ok).toBe(false);
  });
  it("0555 só acrescenta colunas a time_records e está registada", () => {
    const all = MIGRATION_0555_STATEMENTS.join("\n");
    for (const col of ["atAirport", "terminalStatus", "terminalReviewedById", "terminalReviewedAt", "terminalNote"]) {
      expect(all).toContain(`ALTER TABLE \`time_records\` ADD COLUMN \`${col}\``);
    }
    expect(MIGRATION_0555_STATEMENTS.every((st) => st.startsWith("ALTER TABLE"))).toBe(true);
    expect(SCHEMA_MIGRATION_IDS).toContain("0555");
    expect(src("drizzle/schema.ts")).toContain("terminalStatus: varchar({ length: 16 })");
  });
});

describe("ponto: avaliação na entrada e na saída (com BD simulada)", () => {
  afterEach(() => { delete process.env.PONTO_TERMINAL; city.key = "lisboa"; });
  const extra = { id: 7, position: "extra", contractType: "extra" };
  const inside = northOfLis(500);

  it("interruptor desligado: nada é avaliado nem gravado", async () => {
    const { evaluateCheckInTerminal } = await import("./pontoTerminal");
    const r = await evaluateCheckInTerminal({ employee: extra, latitude: String(inside.lat), longitude: String(inside.lng), prev: null });
    expect(r).toEqual({ atAirport: null, terminalStatus: null, terminal: null });
  });
  it("ligado: entrada de um extra no aeroporto da cidade dele abre o terminal", async () => {
    process.env.PONTO_TERMINAL = "on";
    const { evaluateCheckInTerminal } = await import("./pontoTerminal");
    const r = await evaluateCheckInTerminal({ employee: extra, latitude: String(inside.lat), longitude: String(inside.lng), prev: null });
    expect(r).toEqual({ atAirport: 1, terminalStatus: "start", terminal: "start" });
  });
  it("ligado: quem não é extra, ou extra de outra cidade, não tem terminal", async () => {
    process.env.PONTO_TERMINAL = "on";
    const { evaluateCheckInTerminal } = await import("./pontoTerminal");
    const driver = await evaluateCheckInTerminal({ employee: { id: 8, position: "driver", contractType: "full_time" }, latitude: String(inside.lat), longitude: String(inside.lng), prev: null });
    expect(driver.terminalStatus).toBeNull();
    city.key = "porto";
    const porto = await evaluateCheckInTerminal({ employee: extra, latitude: String(inside.lat), longitude: String(inside.lng), prev: null });
    expect(porto).toEqual({ atAirport: 0, terminalStatus: null, terminal: null });
  });
  it("ligado: saída sem GPS depois de entrada no aeroporto → por confirmar", async () => {
    process.env.PONTO_TERMINAL = "on";
    const { evaluateCheckOutTerminal } = await import("./pontoTerminal");
    expect((await evaluateCheckOutTerminal({ employee: extra, latitude: null, longitude: null, openCheckInStatus: "start" })).terminalStatus).toBe("pending");
    expect((await evaluateCheckOutTerminal({ employee: extra, latitude: String(inside.lat), longitude: String(inside.lng), openCheckInStatus: "start" })).terminalStatus).toBe("auto");
    expect((await evaluateCheckOutTerminal({ employee: extra, latitude: String(inside.lat), longitude: String(inside.lng), openCheckInStatus: null })).terminalStatus).toBeNull();
  });
});

describe("terminal à mão: quem revê o ponto, com motivo, sem apagar", () => {
  it("setTerminal: mesmas regras da revisão do ponto, motivo obrigatório e registo de atividade", () => {
    const r = src("server/rhRouter.ts");
    const block = r.slice(r.indexOf("setTerminal: protectedProcedure"), r.indexOf("checkIn: protectedProcedure"));
    expect(block).toContain('assertCanManageEmployee(ctx.user, empId, "Sem permissão para rever o ponto desta pessoa.")');
    expect(block).toContain("min(3");
    expect(block).toContain("logActivity(");
    expect(block).toContain("pontoTerminalEnabled()");
  });
  it("saída esquecida (cortada às 12 h) nunca fecha terminal sozinha: fica por confirmar", () => {
    expect(src("server/rhRouter.ts")).toContain('if (autoNote && terminalOut.terminalStatus === "auto") { terminalOut.terminalStatus = "pending";');
  });
  it("no aeroporto não se marca \"fora do raio\" (entrada e saída)", () => {
    const r = src("server/rhRouter.ts");
    expect(r).toContain("terminalIn.atAirport === 1 ? null : await checkGeofenceNote(");
    expect(r).toContain("terminalOut.atAirport === 1 ? null : await checkGeofenceNote(");
  });
  it("marcar/desmarcar só muda o estado (nunca DELETE) e só na saída", () => {
    const s = src("server/rhService.ts");
    const fn = s.slice(s.indexOf("export async function setTimeRecordTerminal"), s.indexOf("// ─── Fecho mensal"));
    expect(fn).toContain('rec.type !== "check_out"');
    expect(fn).toContain("db.update(timeRecords)");
    expect(fn).not.toMatch(/delete\(/i);
  });
});
