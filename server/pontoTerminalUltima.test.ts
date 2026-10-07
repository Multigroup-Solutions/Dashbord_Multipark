import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TERMINAL_RETRY_DAYS,
  classifyCheckIn,
  classifyCheckOut,
  closedTerminalSegment,
  lisbonClock,
  resolveTerminalByLastService,
  splitTerminalHours,
  terminalPartialLabel,
  terminalSplitOfShift,
  terminalStatusLabel,
} from "../shared/pontoTerminal";
import { pairShifts, countableShifts } from "./payroll/shifts";
import { computeEmployeeMonth } from "./payroll/compute";
import { aggregateExtrasCost } from "./finance/extrasCost";
import { MIGRATION_0575_STATEMENTS, IDEMPOTENT_ERROR_CODES_0575 } from "./migrations/migration_0575";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";

// Terminal no ponto — saída fora do aeroporto (Jorge, 7 out 2026): "Se o extra
// der saída do terminal e já não esteja no terminal, conta até à última
// recolha ou entrega feita por ele."

const queryMock = vi.hoisted(() => vi.fn());
vi.mock("./multiparkDb/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("./multiparkDb/client")>();
  return { ...real, multiparkDbQuery: (...args: any[]) => queryMock(...args) };
});
vi.mock("./appSettings", () => ({ getSetting: async () => null, loadFeatureFlagOverrides: async () => new Map() }));

import { assertReadOnlySql } from "./multiparkDb/client";
import {
  SERVICE_INSTANTS_LIMIT,
  buildAgentServiceInstantsSql,
  getAgentServiceInstants,
  mapAgentServiceInstantRow,
  serviceInstantBelongsTo,
} from "./multiparkDb/movements";

const src = (p: string) => readFileSync(resolve(import.meta.dirname, "..", p), "utf8");
const ENV = "DATABASE_URL_MULTIPARK";
let savedEnv: string | undefined;
beforeEach(() => { savedEnv = process.env[ENV]; queryMock.mockReset(); });
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv;
  delete process.env.PONTO_TERMINAL;
});

// Troço: entrada no aeroporto às 08:00 UTC (09:00 Lisboa), saída fora às 14:00 UTC.
const IN = "2026-10-07 08:00:00";
const OUT = "2026-10-07 14:00:00";

describe("regra pura: até à última recolha/entrega dentro do troço", () => {
  it("última ação a meio do troço → terminal até lá (\"partial\")", () => {
    const r = resolveTerminalByLastService({
      inAt: IN, outAt: OUT,
      actions: [
        { at: "2026-10-07 09:10:00", kind: "CHECK_IN", bookingCode: "A1" },
        { at: "2026-10-07 12:00:00", kind: "CHECK_OUT", bookingCode: "B2" },
        { at: "2026-10-07 10:30:00", kind: "CHECK_OUT", bookingCode: "C3" },
      ],
    });
    expect(r).toEqual({ status: "partial", terminalUntil: "2026-10-07 12:00:00", lastKind: "entrega", bookingCode: "B2", actions: 3 });
  });
  it("sem ações no troço → fica \"pending\" (o RH decide)", () => {
    expect(resolveTerminalByLastService({ inAt: IN, outAt: OUT, actions: [] })).toEqual({ status: "pending", reason: "no_actions" });
  });
  it("ações fora do troço são ignoradas (antes da entrada, na entrada, depois da saída)", () => {
    const outside = [
      { at: "2026-10-07 07:59:59", kind: "CHECK_OUT" },
      { at: IN, kind: "CHECK_IN" },
      { at: "2026-10-07 14:00:01", kind: "CHECK_IN" },
      { at: "2026-10-08 10:00:00", kind: "CHECK_OUT" },
    ];
    expect(resolveTerminalByLastService({ inAt: IN, outAt: OUT, actions: outside }).status).toBe("pending");
    const r = resolveTerminalByLastService({ inAt: IN, outAt: OUT, actions: [...outside, { at: "2026-10-07 10:00:00", kind: "CHECK_IN" }] });
    expect(r).toMatchObject({ status: "partial", terminalUntil: "2026-10-07 10:00:00", lastKind: "recolha", actions: 1 });
    // a ação no próprio segundo da saída conta (troço todo)
    expect(resolveTerminalByLastService({ inAt: IN, outAt: OUT, actions: [{ at: OUT, kind: "CHECK_OUT" }] })).toMatchObject({ status: "partial", terminalUntil: OUT });
  });
  it("leitura falhada (Multipark sem resposta) → \"pending\"", () => {
    expect(resolveTerminalByLastService({ inAt: IN, outAt: OUT, actions: null })).toEqual({ status: "pending", reason: "read_failed" });
  });
  it("aceita ISO e milissegundos (corta ao segundo, grava em UTC)", () => {
    const r = resolveTerminalByLastService({ inAt: "2026-10-07T08:00:00Z", outAt: new Date("2026-10-07T14:00:00Z"), actions: [{ at: "2026-10-07T11:45:30.250Z", kind: "check_out" }] });
    expect(r).toMatchObject({ status: "partial", terminalUntil: "2026-10-07 11:45:30", lastKind: "entrega" });
  });
  it("saída no aeroporto continua \"auto\" (tudo terminal) — não passa por esta regra", () => {
    expect(classifyCheckOut({ checkInStatus: "start", atAirport: true })).toBe("auto");
    expect(terminalSplitOfShift({ hours: 6, terminalStatus: "auto" }, true)).toEqual({ terminalHours: 6, normalHours: 0 });
  });
  it("saída esquecida (cortada às 12 h): conta até à última ação; horas corrigidas pelo RH nunca dão terminal a mais", () => {
    const outCut = "2026-10-07 20:00:00"; // entrada + 12 h
    const r = resolveTerminalByLastService({ inAt: IN, outAt: outCut, actions: [{ at: "2026-10-07 15:30:00", kind: "CHECK_OUT" }, { at: "2026-10-08 09:00:00", kind: "CHECK_IN" }] });
    expect(r).toMatchObject({ status: "partial", terminalUntil: "2026-10-07 15:30:00" });
    const until = (r as { terminalUntil: string }).terminalUntil;
    expect(terminalSplitOfShift({ hours: 12, terminalStatus: "partial", terminalUntil: until, inAt: IN }, true)).toEqual({ terminalHours: 7.5, normalHours: 4.5 });
    // o RH corrigiu para 9 h reais: 7,5 h terminal + 1,5 h normal
    expect(terminalSplitOfShift({ hours: 9, terminalStatus: "partial", terminalUntil: until, inAt: IN }, true)).toEqual({ terminalHours: 7.5, normalHours: 1.5 });
    // corrigiu para 6 h: nunca mais terminal do que as horas pagas
    expect(terminalSplitOfShift({ hours: 6, terminalStatus: "partial", terminalUntil: until, inAt: IN }, true)).toEqual({ terminalHours: 6, normalHours: 0 });
  });
  it("o \"partial\" fecha um troço de terminal: entrada até 30 min depois é regresso", () => {
    expect(closedTerminalSegment("partial")).toBe(true);
    const prev = { type: "check_out" as const, recordedAt: "2026-10-07 13:50:00", terminalStatus: "partial" };
    expect(classifyCheckIn({ atAirport: true, prev, at: new Date("2026-10-07T14:00:00Z") }).reason).toBe("return");
  });
});

describe("divisão das horas de um troço (regra única do ordenado e do custo)", () => {
  const partial = { hours: 6, terminalStatus: "partial", terminalUntil: "2026-10-07 12:00:00", inAt: IN };
  it("partial: terminal da entrada até à última ação, o resto normal", () => {
    expect(terminalSplitOfShift(partial, true)).toEqual({ terminalHours: 4, normalHours: 2 });
  });
  it("interruptor desligado → tudo normal (igual a hoje), seja qual for o estado", () => {
    for (const st of ["partial", "auto", "confirmed", "pending", "rejected", null]) {
      expect(terminalSplitOfShift({ ...partial, terminalStatus: st }, false)).toEqual({ terminalHours: 0, normalHours: 6 });
    }
  });
  it("RH ganha: confirmado = troço todo; desmarcado = nenhum (mesmo com a hora guardada)", () => {
    expect(terminalSplitOfShift({ ...partial, terminalStatus: "confirmed" }, true)).toEqual({ terminalHours: 6, normalHours: 0 });
    expect(terminalSplitOfShift({ ...partial, terminalStatus: "rejected" }, true)).toEqual({ terminalHours: 0, normalHours: 6 });
  });
  it("sem prova não paga terminal: partial sem entrada ou sem hora, por confirmar, normal → tudo normal", () => {
    expect(terminalSplitOfShift({ ...partial, inAt: null }, true)).toEqual({ terminalHours: 0, normalHours: 6 });
    expect(terminalSplitOfShift({ ...partial, terminalUntil: null }, true)).toEqual({ terminalHours: 0, normalHours: 6 });
    expect(terminalSplitOfShift({ ...partial, terminalUntil: "2026-10-07 07:00:00" }, true)).toEqual({ terminalHours: 0, normalHours: 6 });
    expect(terminalSplitOfShift({ ...partial, terminalStatus: "pending" }, true)).toEqual({ terminalHours: 0, normalHours: 6 });
    expect(terminalSplitOfShift({ ...partial, terminalStatus: null }, true)).toEqual({ terminalHours: 0, normalHours: 6 });
  });
  it("splitTerminalHours soma troço a troço (o partial não conta como por confirmar)", () => {
    const shifts = [{ hours: 2, terminalStatus: null }, partial, { hours: 3, terminalStatus: "auto" }, { hours: 1, terminalStatus: "pending" }];
    expect(splitTerminalHours(shifts, true)).toEqual({ normalHours: 5, terminalHours: 7, pendingHours: 1 });
    expect(splitTerminalHours(shifts, false)).toEqual({ normalHours: 12, terminalHours: 0, pendingHours: 0 });
  });
});

describe("etiquetas (hora de Lisboa)", () => {
  it("\"Terminal até HH:MM (última recolha/entrega)\" — verão e inverno", () => {
    expect(terminalPartialLabel("2026-10-07 13:32:00")).toBe("Terminal até 14:32 (última recolha/entrega)");
    expect(terminalPartialLabel("2026-12-07 13:32:00")).toBe("Terminal até 13:32 (última recolha/entrega)");
    expect(terminalPartialLabel(null)).toBe("Terminal até à última recolha/entrega");
    expect(lisbonClock("2026-10-07T23:05:00Z")).toBe("00:05");
  });
  it("terminalStatusLabel: só o partial leva a hora", () => {
    expect(terminalStatusLabel("partial", "2026-10-07 11:00:00")).toBe("Terminal até 12:00 (última recolha/entrega)");
    expect(terminalStatusLabel("pending", "2026-10-07 11:00:00")).toBe("Terminal por confirmar");
    expect(terminalStatusLabel(null)).toBe("");
  });
});

describe("ordenado e custo dos extras: júnior, 6 h de troço, última entrega às 4 h", () => {
  const rates = { extraRateByLevel: new Map([[1, 4.5], [2, 5], [3, 5.5], [4, 6]]), extraRateByName: new Map([["junior", 4.5], ["senior", 5], ["terminal", 5.5], ["master", 6]]) };
  const extra = (level: number) => ({ id: 1, fullName: "Extra", position: "extra", extraLevel: level, isActive: 1, contractStart: null, contractEnd: null });
  const records = (status: string | null, until: string | null) => [
    { id: 1, type: "check_in" as const, recordedAt: IN, terminalStatus: "start" },
    { id: 2, type: "check_out" as const, recordedAt: OUT, terminalStatus: status, terminalUntil: until },
  ];
  const run = (enabled: boolean | undefined, status: string | null = "partial", until: string | null = "2026-10-07 12:00:00") =>
    computeEmployeeMonth({ employee: extra(1), year: 2026, month: 10, shifts: pairShifts(records(status, until)).shifts, leaves: [], ...rates, terminalEnabled: enabled });

  it("a hora chega ao turno pela saída", () => {
    expect(countableShifts(pairShifts(records("partial", "2026-10-07 12:00:00")).shifts)[0]).toMatchObject({ terminalStatus: "partial", terminalUntil: "2026-10-07 12:00:00", inAt: IN, hours: 6 });
  });
  it("4 h × 5,00 € (sénior) + 2 h × 4,50 € = 29,00 €", () => {
    const r = run(true);
    expect(r.totalHours).toBe(6);
    expect(r.terminalHours).toBe(4);
    expect(r.terminalHourlyRate).toBe(5);
    expect(r.terminalPayment).toBe(20);
    expect(r.terminalPendingHours).toBe(0);
    expect(r.extraPayment).toBe(4 * 5 + 2 * 4.5);
  });
  it("interruptor desligado = igual a hoje (6 h × 4,50 €)", () => {
    const off = run(false);
    const before = computeEmployeeMonth({ employee: extra(1), year: 2026, month: 10, shifts: pairShifts(records(null, null)).shifts, leaves: [], ...rates });
    expect(off.extraPayment).toBe(27);
    expect({ ...off }).toEqual({ ...before });
    expect(run(undefined).extraPayment).toBe(27);
  });
  it("por confirmar paga normal; o RH confirma (troço todo) ou desmarca (nenhum)", () => {
    expect(run(true, "pending", null).extraPayment).toBe(27);
    expect(run(true, "confirmed").extraPayment).toBe(30);
    expect(run(true, "rejected").extraPayment).toBe(27);
  });
  it("custo dos extras: a mesma divisão", () => {
    const ponto = [{ recordedAt: OUT, hours: "6.00", level: 1, employeeId: 1, projectId: 10, terminalStatus: "partial", terminalUntil: "2026-10-07 12:00:00", shiftInAt: IN }];
    const opts = (terminal?: boolean) => ({ dayOfRecord: (v: string | null) => String(v).slice(0, 10), cityOfProject: () => null, terminal });
    const r = { junior: 4.5, senior: 5, terminal: 5.5, master: 6 };
    expect(aggregateExtrasCost({ assignments: [], ponto }, r, opts(true)).realByDay.get("2026-10-07")).toBe(29);
    expect(aggregateExtrasCost({ assignments: [], ponto }, r, opts(false)).realByDay.get("2026-10-07")).toBe(27);
    expect(aggregateExtrasCost({ assignments: [], ponto }, r, opts()).realByDay.get("2026-10-07")).toBe(27);
    // sem a entrada do troço (não lida) → sem prova → normal
    expect(aggregateExtrasCost({ assignments: [], ponto: [{ ...ponto[0], shiftInAt: null }] }, r, opts(true)).realByDay.get("2026-10-07")).toBe(27);
  });
  it("o custo lê a entrada do troço só nos \"partial\" e a hora gravada", () => {
    const s = src("server/finance/extrasCost.ts");
    expect(s).toContain("terminalUntil: timeRecords.terminalUntil");
    expect(s).toMatch(/CASE WHEN \$\{timeRecords\.terminalStatus\} = 'partial'/);
  });
});

describe("leitura da Multipark (só leitura): recolhas e entregas do extra", () => {
  it("SQL parametrizado, só leitura, feitas por ele OU assinadas a ele, as mais recentes primeiro", () => {
    const { sql, params } = buildAgentServiceInstantsSql({ userIds: ["u1", "u2", "u1", " "], from: IN, to: OUT });
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain(`h."changeType"::text IN ('CHECK_IN', 'CHECK_OUT')`);
    expect(sql).toContain(`h."userId" IN ($3, $4)`);
    expect(sql).toContain(`(h."changeType"::text = 'CHECK_IN' AND b."checkInDriverId" IN ($3, $4))`);
    expect(sql).toContain(`(h."changeType"::text = 'CHECK_OUT' AND b."checkOutDriverId" IN ($3, $4))`);
    expect(sql).toContain(`h."actionTime" >= $1::timestamp AND h."actionTime" <= $2::timestamp`);
    expect(sql).toContain(`ORDER BY h."actionTime" DESC, h."id" DESC`);
    expect(params).toEqual([IN, OUT, "u1", "u2", SERVICE_INSTANTS_LIMIT + 1]);
    expect(sql).not.toMatch(/u1|u2/);
    expect(buildAgentServiceInstantsSql({ userIds: [], from: IN, to: OUT }).sql).toContain("AND FALSE");
  });
  it("linha → ação; de quem é (registou ou ficou assinado)", () => {
    const a = mapAgentServiceInstantRow({ action_time: "2026-10-07 12:00:00", change_type: "check_out", user_id: "tl9", driver_id: "u1", booking_code: "B2" });
    expect(a).toEqual({ at: "2026-10-07 12:00:00", kind: "CHECK_OUT", agentUserId: "tl9", driverId: "u1", bookingCode: "B2" });
    expect(mapAgentServiceInstantRow({ action_time: null })).toBeNull();
    expect(serviceInstantBelongsTo(a!, new Set(["u1"]))).toBe(true);
    expect(serviceInstantBelongsTo(a!, new Set(["tl9"]))).toBe(true);
    expect(serviceInstantBelongsTo(a!, new Set(["x"]))).toBe(false);
  });
  it("leitura: sem BD configurada → indisponível; com BD → linhas e teto", async () => {
    delete process.env[ENV];
    expect((await getAgentServiceInstants({ userIds: ["u1"], from: IN, to: OUT })).available).toBe(false);
    process.env[ENV] = "postgres://ro@db/mp";
    queryMock.mockResolvedValueOnce([{ action_time: "2026-10-07 12:00:00", change_type: "CHECK_OUT", user_id: "u1" }, { action_time: "2026-10-07 10:00:00", change_type: "CHECK_IN", user_id: "u1" }]);
    const r = await getAgentServiceInstants({ userIds: ["u1"], from: IN, to: OUT, limit: 1 });
    expect(r).toMatchObject({ available: true, data: { truncated: true, rows: [{ at: "2026-10-07 12:00:00", kind: "CHECK_OUT" }] } });
    expect(await getAgentServiceInstants({ userIds: [], from: IN, to: OUT })).toEqual({ available: true, data: { rows: [], truncated: false } });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

describe("servidor: na saída e na repetição diária (BD e Multipark simuladas)", () => {
  const ok = (rows: Array<{ at: string; kind: string; agentUserId?: string | null; driverId?: string | null }>, truncated = false) =>
    async () => ({ available: true as const, data: { rows: rows.map((r) => ({ agentUserId: null, driverId: null, bookingCode: null, ...r })), truncated } });
  const failed = async () => ({ available: false as const, code: "TIMEOUT" as const, reason: "lento" });

  it("resolveTerminalShift: ação no troço → partial; leitura falhada, sem agente ou erro → pending", async () => {
    const { resolveTerminalShift } = await import("./pontoTerminal");
    expect(await resolveTerminalShift({ employeeId: 1, inAt: IN, outAt: OUT, agentIds: ["u1"], read: ok([{ at: "2026-10-07 12:00:00", kind: "CHECK_OUT", agentUserId: "u1" }]) }))
      .toMatchObject({ status: "partial", terminalUntil: "2026-10-07 12:00:00" });
    expect(await resolveTerminalShift({ employeeId: 1, inAt: IN, outAt: OUT, agentIds: ["u1"], read: failed })).toEqual({ status: "pending", reason: "read_failed" });
    expect(await resolveTerminalShift({ employeeId: 1, inAt: IN, outAt: OUT, agentIds: [], read: ok([]) })).toEqual({ status: "pending", reason: "no_agent" });
    expect(await resolveTerminalShift({ employeeId: 1, inAt: IN, outAt: OUT, agentIds: ["u1"], read: async () => { throw new Error("x"); } })).toEqual({ status: "pending", reason: "read_failed" });
  });

  it("na saída: interruptor desligado → não lê nada nem grava (igual a hoje)", async () => {
    const { resolvePendingAtCheckout } = await import("./pontoTerminal");
    const read = vi.fn(ok([{ at: "2026-10-07 12:00:00", kind: "CHECK_OUT" }]));
    const r = await resolvePendingAtCheckout({ recordId: 2, employeeId: 1, inAt: IN, outAt: OUT, read });
    expect(r.status).toBe("pending");
    expect(read).not.toHaveBeenCalled();
  });

  const shifts = [
    { id: 11, employeeId: 1, inAt: "2026-10-05 08:00:00", outAt: "2026-10-05 14:00:00" }, // ação lá dentro
    { id: 12, employeeId: 2, inAt: "2026-10-06 08:00:00", outAt: "2026-10-06 12:00:00" }, // sem ações
    { id: 13, employeeId: 3, inAt: "2026-10-06 09:00:00", outAt: "2026-10-06 10:00:00" }, // sem agente ligado
  ];
  const agents: Record<number, string[]> = { 1: ["a1"], 2: ["b1", "b2"], 3: [] };
  const base = () => ({
    deadlineAt: Date.now() + 30_000,
    now: Date.parse("2026-10-07T04:30:00Z"),
    load: vi.fn(async () => shifts),
    agentIdsOf: vi.fn(async (id: number) => agents[id] ?? []),
    apply: vi.fn(async () => true),
  });

  it("repetição diária: interruptor desligado → nada (nem lê a BD)", async () => {
    const { retryPendingTerminalShifts } = await import("./pontoTerminal");
    const o = { ...base(), read: vi.fn(ok([])) };
    expect(await retryPendingTerminalShifts(o)).toMatchObject({ skipped: "off", resolved: 0 });
    expect(o.load).not.toHaveBeenCalled();
    expect(o.read).not.toHaveBeenCalled();
  });

  it("repetição diária: UMA leitura para todos; resolve só quem tem ação no seu troço", async () => {
    process.env.PONTO_TERMINAL = "on";
    const { retryPendingTerminalShifts } = await import("./pontoTerminal");
    const read = vi.fn(ok([
      { at: "2026-10-06 11:00:00", kind: "CHECK_IN", agentUserId: "a1" },   // do a1 mas fora do troço dele
      { at: "2026-10-05 13:15:00", kind: "CHECK_OUT", driverId: "a1" },     // assinada ao a1, dentro
      { at: "2026-10-06 09:30:00", kind: "CHECK_IN", agentUserId: "zz" },   // de outra pessoa
    ]));
    const o = { ...base(), read };
    const r = await retryPendingTerminalShifts(o);
    expect(r).toEqual({ pending: 3, resolved: 1, noActions: 1, noAgent: 1, readFailed: false, deferred: 0 });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][0]).toEqual({ userIds: ["a1", "b1", "b2"], from: "2026-10-05 08:00:00", to: "2026-10-06 12:00:00" });
    expect(o.apply).toHaveBeenCalledTimes(1);
    expect(o.apply).toHaveBeenCalledWith(11, "2026-10-05 13:15:00");
    expect(o.load.mock.calls[0][0]).toBe(new Date(Date.parse("2026-10-07T04:30:00Z") - TERMINAL_RETRY_DAYS * 86_400_000).toISOString().slice(0, 19).replace("T", " "));
  });

  it("repetição diária: leitura falhada → tudo fica pending (nada gravado)", async () => {
    process.env.PONTO_TERMINAL = "on";
    const { retryPendingTerminalShifts } = await import("./pontoTerminal");
    const o = { ...base(), read: vi.fn(failed) };
    expect(await retryPendingTerminalShifts(o)).toMatchObject({ readFailed: true, resolved: 0 });
    expect(o.apply).not.toHaveBeenCalled();
  });

  it("repetição diária: teto da leitura atingido → os troços que a leitura não cobriu ficam para amanhã", async () => {
    process.env.PONTO_TERMINAL = "on";
    const { retryPendingTerminalShifts } = await import("./pontoTerminal");
    const o = { ...base(), read: vi.fn(ok([{ at: "2026-10-06 11:30:00", kind: "CHECK_OUT", agentUserId: "zz" }], true)) };
    const r = await retryPendingTerminalShifts(o);
    expect(r).toMatchObject({ resolved: 0, deferred: 2, noActions: 0, noAgent: 1 });
    expect(o.apply).not.toHaveBeenCalled();
  });
});

describe("gravação, agendador, migração: nada se apaga", () => {
  it("0575 só acrescenta terminalUntil (DATETIME) a time_records e está registada no fim", () => {
    expect(MIGRATION_0575_STATEMENTS).toEqual(["ALTER TABLE `time_records` ADD COLUMN `terminalUntil` DATETIME NULL AFTER `terminalStatus`"]);
    expect(IDEMPOTENT_ERROR_CODES_0575.has("ER_DUP_FIELDNAME")).toBe(true);
    expect(SCHEMA_MIGRATION_IDS.at(-1)).toBe("0575");
    expect(src("drizzle/schema.ts")).toContain("terminalUntil: datetime({ mode: 'string' })");
  });
  it("só UPDATE de quem ainda está pending (nunca por cima do RH) e nunca DELETE", () => {
    const s = src("server/pontoTerminal.ts");
    const fn = s.slice(s.indexOf("export async function applyTerminalPartial"), s.indexOf("export async function resolvePendingAtCheckout"));
    expect(fn).toContain("db.update(timeRecords)");
    expect(fn).toContain('eq(timeRecords.terminalStatus, "pending")');
    expect(fn).toContain('eq(timeRecords.type, "check_out")');
    expect(s).not.toMatch(/\.delete\(|DELETE\s+FROM/i);
    expect(src("server/multiparkDb/movements.ts")).not.toMatch(/DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+"/i);
  });
  it("na saída: grava primeiro (\"pending\") e só depois tenta a Multipark, com teto curto", () => {
    const r = src("server/rhRouter.ts");
    const block = r.slice(r.indexOf("checkOut: protectedProcedure"), r.indexOf("// ── Geofence por centro de custos"));
    expect(block.indexOf("insertTimeRecordAtomic(input.employeeId, \"check_out\"")).toBeLessThan(block.indexOf("resolvePendingAtCheckout("));
    expect(block).toContain('terminalOut.terminalStatus === "pending" && outRecordId > 0');
    expect(src("server/pontoTerminal.ts")).toContain("multiparkServiceReader(TERMINAL_CHECKOUT_READ_TIMEOUT_MS)");
  });
  it("saída esquecida fechada pelo trabalho diário: troço de terminal → pending (só com o interruptor)", () => {
    const d = src("server/db.ts");
    const fn = d.slice(d.indexOf("export async function autoCloseStaleCheckIns"), d.indexOf("// ─── PASSAGEM DE TURNO"));
    expect(fn).toContain('r.terminalStatus === "start"');
    expect(fn).toContain("pontoTerminalEnabled()");
    expect(fn).not.toMatch(/delete\(/i);
  });
  it("daily-ops: a repetição corre logo depois de fechar os pontos esquecidos, com prazo", () => {
    const c = src("server/cronJobs.ts");
    const i = c.indexOf('step("stale-checkins"'), j = c.indexOf('step("terminal-pending"'), k = c.indexOf('step("rh-no-shows"');
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
    expect(k).toBeGreaterThan(j);
    expect(c.slice(j, k)).toContain("retryPendingTerminalShifts({ deadlineAt: cap(");
  });
  it("agentes pela ligação explícita da ficha (por ID), nunca pelo nome", () => {
    const s = src("server/pontoTerminal.ts");
    const fn = s.slice(s.indexOf("export async function terminalAgentIdsOf"), s.indexOf("export async function resolveTerminalShift"));
    expect(fn).toContain("agentIdsOfEmployee(employeeId)");
    expect(fn).toContain("isSystemAgentId");
    expect(fn).not.toMatch(/ByName|agentIdForName/);
  });
});
