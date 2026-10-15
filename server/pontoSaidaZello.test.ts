/**
 * Saída do ponto: grava PRIMEIRO a saída e as horas, e só depois junta o
 * retrato do Zello (km, velocidades, minutos offline) numa atualização à parte.
 * Antes lia-se o Zello antes de gravar (até 15 s por chamada) e um corte de
 * 60 s da Vercel perdia a saída. A atualização é idempotente: só preenche uma
 * saída sem retrato e nunca cria outra saída.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  resolve: vi.fn(async () => "pda12" as string | null),
  summarize: vi.fn(async () => ({ km: 42.5, avgSpeed: 30, maxSpeed: 95, offlineMinutes: 12, onlineMinutes: 468, points: 300 }) as any),
  updates: [] as Array<{ set: Record<string, unknown>; where: unknown }>,
  dbOn: true,
}));
vi.mock("./db", () => ({
  getDb: async () => (h.dbOn ? { update: () => ({ set: (set: Record<string, unknown>) => ({ where: async (where: unknown) => { h.updates.push({ set, where }); } }) }) } : null),
  getDocumentChecklistForEmployee: async () => [], getPayrollData: async () => [], toMysqlDateTime: (d: Date) => d.toISOString().slice(0, 19).replace("T", " "),
  resolveZelloUsernameForShift: h.resolve,
}));
vi.mock("./zello", () => ({ summarizeZelloShift: h.summarize }));

const { attachZelloToCheckOut, withCap, CHECKOUT_ZELLO_CAP_MS } = await import("./rhService");
const read = (f: string) => readFileSync(path.resolve(__dirname, "..", f), "utf8");

const shift = { recordId: 901, employeeId: 10, inAt: new Date("2026-09-20T07:00:00Z"), outAt: new Date("2026-09-20T15:00:00Z") };

beforeEach(() => { h.updates.length = 0; h.dbOn = true; h.resolve.mockClear(); h.summarize.mockClear(); });

describe("attachZelloToCheckOut — o Zello junta-se à saída já gravada", () => {
  it("preenche só os campos do Zello (nunca as horas) e só numa saída que ainda não os tem", async () => {
    const z = await attachZelloToCheckOut(shift);
    expect(z?.km).toBe(42.5);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].set).toEqual({ zelloKm: "42.5", zelloAvgSpeed: "30", zelloMaxSpeed: "95", zelloOfflineMinutes: 12, zelloOnlineMinutes: 468 });
    expect(Object.keys(h.updates[0].set)).not.toContain("hoursWorked");
  });
  it("Zello em baixo, lento a falhar ou sem utilizador → null, sem lançar e sem escrever", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.summarize.mockRejectedValueOnce(new Error("timeout"));
    expect(await attachZelloToCheckOut(shift)).toBeNull();
    h.resolve.mockResolvedValueOnce(null);
    expect(await attachZelloToCheckOut(shift)).toBeNull();
    expect(await attachZelloToCheckOut({ ...shift, recordId: 0 })).toBeNull();
    expect(h.updates).toHaveLength(0);
    warn.mockRestore();
  });
  it("a condição da atualização é a saída desta ficha SEM retrato (repetir não muda nada)", () => {
    const s = read("server/rhService.ts");
    const fn = s.slice(s.indexOf("export async function attachZelloToCheckOut"), s.indexOf("export async function withCap"));
    expect(fn).toContain('eq(timeRecords.id, o.recordId), eq(timeRecords.employeeId, o.employeeId), eq(timeRecords.type, "check_out"), isNull(timeRecords.zelloKm)');
    expect(fn).not.toMatch(/insert\(|delete\(/i);
  });
});

describe("withCap — o resto da saída espera pelo Zello no máximo o teto", () => {
  it("devolve o valor se chegar a tempo, senão o valor de recurso", async () => {
    expect(await withCap(Promise.resolve(7), 50, 0)).toBe(7);
    expect(await withCap(new Promise<number>((r) => setTimeout(() => r(7), 200)), 10, 0)).toBe(0);
    expect(CHECKOUT_ZELLO_CAP_MS).toBeLessThanOrEqual(20_000);
  });
});

describe("check-out no router: gravar primeiro, Zello depois", () => {
  const r = read("server/rhRouter.ts");
  const block = r.slice(r.indexOf("checkOut: protectedProcedure"), r.indexOf("// ── Geofence por centro de custos"));
  it("a saída grava-se antes de qualquer leitura do Zello; o Zello não vai no INSERT", () => {
    const ins = block.indexOf('insertTimeRecordAtomic(input.employeeId, "check_out"');
    expect(ins).toBeGreaterThan(0);
    expect(block.indexOf("attachZelloToCheckOut(")).toBeGreaterThan(ins);
    expect(block).not.toContain("summarizeZelloShift");
    expect(block).not.toContain("resolveZelloUsernameForShift");
    const insert = block.slice(ins, block.indexOf("}));", ins));
    expect(insert).not.toMatch(/zelloKm/);
  });
  it("o registo de atividade da saída escreve-se antes de esperar pelo Zello", () => {
    expect(block.indexOf('action: "check_out"')).toBeLessThan(block.indexOf("await withCap(zelloPending"));
  });
  it("entrada, saída e estado do ponto leem só a última picagem (não o histórico todo)", () => {
    expect(r.slice(r.indexOf("myStatus: protectedProcedure"), r.indexOf("terminalEnabled: protectedProcedure"))).toContain("getLastTimeRecord(me.employee.id)");
    expect(block).toContain("getLastTimeRecord(input.employeeId)");
    const checkIn = r.slice(r.indexOf("checkIn: protectedProcedure"), r.indexOf("checkOut: protectedProcedure"));
    expect(checkIn).toContain("getLastTimeRecord(input.employeeId)");
    expect(checkIn).not.toContain("getTimeRecords(input.employeeId)");
  });
});
