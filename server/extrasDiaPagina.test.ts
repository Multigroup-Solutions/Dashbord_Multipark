/**
 * P3 lote 15c — Extras Dia: nada da escala se perde (arquivo em vez de apagar,
 * a proposta refeita só substitui o que criou, editar não apaga notas), a mesma
 * pessoa não fica a horas sobrepostas, avisos só do turno e nunca para dias
 * passados, cada conta só vê os euros que pode, a previsão incompleta não
 * dispara automação e o pedido de disponibilidade conta quem recebe.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const state = vi.hoisted(() => ({
  overrides: {} as Record<string, unknown>,
  permRows: {} as Record<string, string>,
  rows: [] as any[],
  notified: [] as any[],
}));
const national = vi.hoisted(() => ({ all: true, defaultCityId: null, cityName: null, cityIds: [] as number[], projectIds: [] as number[], missingCostCenter: false }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => national,
  loadCityAccessParts: async () => ({ access: national, base: national, all: national }),
}));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getUserPermissionOverrides: async () => state.permRows,
  getUserModuleOverrides: async () => state.overrides,
  logActivity: async () => {},
}));
vi.mock("./extrasDia", async (original) => ({
  ...(await original<object>()),
  listAssignments: async () => state.rows,
}));
vi.mock("./extrasAutomation", async (original) => ({
  ...(await original<object>()),
  notifyAssignments: async (date: string, opts: any) => { state.notified.push({ date, ...opts }); return { total: 0, sent: 0, failed: 0, skipped: 0, rulesSent: 0, optedOut: 0 }; },
}));

import { appRouter } from "./routers";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { MIGRATION_0335_STATEMENTS } from "./migrations/migration_0335";
import { archiveAssignments, forecastIncompleteReason, replacedByNewProposal } from "./extrasSchedule";
import { findScheduleOverlap, maskForecastCosts } from "./extrasDia";
import { availableWindow } from "./extrasAutomation";
import { extrasCostView, maskAssignmentCost, stripEuros } from "../shared/extrasCostView";
import { lisbonNow } from "../shared/extrasSchedule";
import { addDays } from "../shared/lisbonDay";
import { sql } from "drizzle-orm";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const dialect = new MySqlDialect();
const caller = (role: string) => appRouter.createCaller({ user: { id: 77, role, name: "Rita" }, req: { headers: {} }, res: {} } as any);
const row = (o: Partial<any> = {}) => ({
  id: 1, assignmentDate: "2026-10-05", employeeId: 11, personName: "Ana", level: "junior", isTeamLeader: false, shift: "morning",
  startHour: 7, endHour: 15, sentHomeHour: null, notes: null, status: "confirmed", version: 1, proposalReason: "Júnior 4,50 €/h · disponível 7h–15h",
  hoursBilled: 8, cost: 36, multiparkAgentName: null, multiparkAgentUserId: null, photoUrl: null, ...o,
});

beforeEach(() => { state.overrides = {}; state.permRows = {}; state.rows = []; state.notified = []; });

describe("Migração 0335", () => {
  it("está no arranque e acrescenta só (colunas, arquivo, 'hold')", () => {
    expect(SCHEMA_MIGRATION_IDS).toContain("0335");
    const all = MIGRATION_0335_STATEMENTS.join("\n");
    expect(all).toContain("ADD COLUMN `source`");
    expect(all).toContain("ADD COLUMN `updatedById`");
    expect(all).toContain("CREATE TABLE IF NOT EXISTS `extras_dia_assignments_removed`");
    expect(all).toContain("SET `status` = 'hold' WHERE `status` = 'proposed' AND `proposedAt` IS NULL");
    expect(all).not.toMatch(/DELETE|DROP/i);
  });
});

describe("Escala: nada se perde", () => {
  it("sair da escala = para o arquivo (linha inteira + quem + porquê) e só depois sai da tabela", async () => {
    const executed: string[] = [];
    const exec = { execute: async (q: any) => { executed.push(dialect.sqlToQuery(q).sql); return [{ affectedRows: 1 }]; } };
    const n = await archiveAssignments(exec, sql`id = ${5}`, "removida", 9);
    expect(n).toBe(1);
    expect(executed[0]).toMatch(/^\s*INSERT INTO extras_dia_assignments_removed/);
    expect(executed[0]).toContain("JSON_OBJECT(");
    expect(executed[1]).toMatch(/^DELETE FROM extras_dia_assignments WHERE id = \?/);
  });
  it("remover e refazer a proposta usam o arquivo (não há DELETE solto na escala)", () => {
    const sched = src("server/extrasSchedule.ts");
    expect(sched).toContain(`archiveAssignments(tx, sql\`id = \${id}\`, "removida", userId)`);
    expect(sched).toContain(`AND source = 'auto'\`, "substituida"`);
    expect(sched).not.toMatch(/DELETE FROM extras_dia_assignments\s+WHERE assignmentDate/);
    expect(src("server/extrasDia.ts")).not.toContain("export async function deleteAssignment");
  });
  it("refazer a proposta só substitui o que ela criou (nunca o que foi posto à mão nem o TL)", () => {
    expect(replacedByNewProposal({ city: "lisbon", status: "proposed", isTeamLeader: 0, source: "auto" }, "lisbon")).toBe(true);
    expect(replacedByNewProposal({ city: "lisbon", status: "proposed", isTeamLeader: 0, source: "manual" }, "lisbon")).toBe(false);
    expect(replacedByNewProposal({ city: "lisbon", status: "confirmed", isTeamLeader: 0, source: "auto" }, "lisbon")).toBe(false);
    expect(replacedByNewProposal({ city: "lisbon", status: "proposed", isTeamLeader: 1, source: "auto" }, "lisbon")).toBe(false);
    expect(replacedByNewProposal({ city: "porto", status: "proposed", isTeamLeader: 0, source: "auto" }, "lisbon")).toBe(false);
  });
  it("editar não apaga as notas e fica quem alterou", () => {
    const fn = src("server/extrasDia.ts").split("export async function upsertAssignment")[1];
    expect(fn).toContain("...(input.notes !== undefined ? { notes: input.notes } : {})");
    expect(fn).toContain("updatedById: input.updatedById ?? null");
  });
  it("'Suspender' sem proposta é 'hold' e o cron volta a propor esse dia", () => {
    const sched = src("server/extrasSchedule.ts");
    expect(sched).toMatch(/VALUES \(\$\{date\}, \$\{city\}, 'hold', \$\{hold \? 1 : 0\}\)/);
    expect(sched).toContain("status = IF(status = 'hold', 'proposing', status)");
  });
});

describe("A mesma pessoa não fica a horas sobrepostas", () => {
  const day = [{ id: 1, startHour: 7, endHour: 15, city: "lisbon" }];
  it("sobreposição → conflito; encostado ou a própria linha → não", () => {
    expect(findScheduleOverlap(day, { id: null, startHour: 14, endHour: 20 })).toMatchObject({ id: 1 });
    expect(findScheduleOverlap(day, { id: null, startHour: 15, endHour: 20 })).toBeNull();
    expect(findScheduleOverlap(day, { id: 1, startHour: 8, endHour: 16 })).toBeNull();
  });
  it("o turno começa às 03h (0h–3h é a noite do dia anterior) e a data é validada", async () => {
    const base = { personName: "Ana", shift: "night" as const, endHour: 6 };
    await expect(caller("supervisor").extrasDia.upsertAssignment({ ...base, assignmentDate: "2026-10-05", startHour: 1 })).rejects.toThrow(/03h/);
    await expect(caller("supervisor").extrasDia.upsertAssignment({ ...base, assignmentDate: "5/10/2026", startHour: 3 })).rejects.toThrow();
  });
  it("quem só vê não grava", async () => {
    await expect(caller("condutor").extrasDia.upsertAssignment({ personName: "Ana", shift: "morning", assignmentDate: "2026-10-05", startHour: 7, endHour: 15 })).rejects.toThrow(/Acesso/);
  });
});

describe("Avisos: só o turno do botão, nunca para dias passados", () => {
  it("dia passado → recusa (nem chega a enviar)", async () => {
    await expect(caller("supervisor").extrasDia.notify({ date: "2020-01-06", city: "lisbon", shift: "morning" })).rejects.toThrow(/já passou/);
    expect(state.notified).toHaveLength(0);
  });
  it("o botão de um turno avisa só esse turno", async () => {
    const future = addDays(lisbonNow().date, 2);
    await caller("supervisor").extrasDia.notify({ date: future, city: "porto", shift: "night" });
    expect(state.notified[0]).toMatchObject({ date: future, city: "porto", shift: "night" });
  });
  it("os avisos vêm só da cidade pedida e marcam os de horas antigas", () => {
    const fn = src("server/extrasAutomation.ts").split("export async function listNotices")[1].split("export interface NotifyResult")[0];
    expect(fn).toContain("AND a.city = ${city}");
    expect(fn).toContain("x.version = a.version");
  });
});

describe("Euros por conta", () => {
  it("quem planeia vê custos; o TL (salário) só quem vê salários ou totais financeiros", () => {
    expect(extrasCostView({ role: "condutor" }, { financeTotals: false })).toEqual({ costs: false, salaries: false });
    expect(extrasCostView({ role: "supervisor" }, { financeTotals: false })).toEqual({ costs: true, salaries: false });
    expect(extrasCostView({ role: "supervisor" }, { financeTotals: true })).toEqual({ costs: true, salaries: true });
    expect(extrasCostView({ role: "admin" }, { financeTotals: false })).toEqual({ costs: true, salaries: true });
  });
  it("tira taxas e euros do texto e das linhas", () => {
    expect(stripEuros("Júnior 4,50 €/h · disponível 7h–15h")).toBe("Júnior · disponível 7h–15h");
    expect(stripEuros("3 condutor(es) propostos (24h, 108,00 €).")).toBe("3 condutor(es) propostos (24h).");
    const tl = maskAssignmentCost(row({ isTeamLeader: true, cost: 120 }), { costs: true, salaries: false });
    expect(tl.cost).toBeNull();
    const ex = maskAssignmentCost(row(), { costs: false, salaries: false });
    expect(ex.cost).toBeNull();
    expect(ex.proposalReason).toBe("Júnior · disponível 7h–15h");
  });
  it("o condutor recebe a escala sem euros; o supervisor recebe os custos dos extras mas não o do TL", async () => {
    state.rows = [row({ id: 1 }), row({ id: 2, isTeamLeader: true, cost: 120, level: null, proposalReason: null })];
    const cond = await caller("condutor").extrasDia.assignments({ date: "2026-10-05", city: "lisbon" });
    expect(cond.map((a) => a.cost)).toEqual([null, null]);
    const sup = await caller("supervisor").extrasDia.assignments({ date: "2026-10-05", city: "lisbon" });
    expect(sup.map((a) => a.cost)).toEqual([36, null]);
    expect(await caller("condutor").extrasDia.costAccess()).toEqual({ costs: false, salaries: false });
  });
  it("previsão sem euros para quem não vê custos (as horas ficam)", () => {
    const f: any = {
      rates: { junior: 5 }, costsHidden: false,
      allocation: { cheapest: { shifts: [{ startHour: 7, endHour: 15, hours: 8, level: "junior", label: "Júnior", hourlyRate: 5, cost: 40 }], totalCost: 40, peakDrivers: 1, totalDriverHours: 8 }, bySingleLevel: [{ level: "junior", label: "Júnior", totalCost: 40, totalHours: 8 }] },
    };
    const m = maskForecastCosts(f);
    expect(m).toMatchObject({ rates: null, costsHidden: true });
    expect(m.allocation.cheapest).toMatchObject({ totalCost: 0, totalDriverHours: 8 });
    expect(m.allocation.cheapest.shifts[0]).toMatchObject({ hours: 8, hourlyRate: 0, cost: 0 });
  });
});

describe("Previsão incompleta e disponibilidade", () => {
  it("leitura cortada ou só a cópia → incompleta (o cron não propõe nem avisa faltas)", () => {
    expect(forecastIncompleteReason({ bookingsTruncated: true, bookingSource: "multipark-db" })).toMatch(/cortada/);
    expect(forecastIncompleteReason({ bookingsTruncated: false, bookingSource: "copy", bookingSourceNotice: "Sem BD." })).toMatch(/Sem BD/);
    expect(forecastIncompleteReason({ bookingsTruncated: false, bookingSource: "multipark-db" })).toBeNull();
    const sched = src("server/extrasSchedule.ts");
    expect(sched).toMatch(/if \(incomplete && by === "auto"\) \{\s*await releaseAutoClaim/);
    expect(src("server/extrasAutomation.ts")).toContain("if (incomplete) { out[`${city}_incompleta`] = 1; continue; }");
  });
  it("as compras online por pagar continuam a contar na previsão (vão ser recolhidas)", () => {
    expect(src("server/multiparkDb/extrasBookings.ts")).toContain(`b."status"::text <> 'CANCELLED'`);
    expect(src("server/extrasDia.ts")).toContain("${multiparkBookings.status} != 'CANCELLED'");
  });
  it("'Preencher' lê a disponibilidade como a proposta (meia-noite e só o início)", () => {
    const avail = (o: any) => ({ status: "available", morning: false, night: false, fromHour: null, toHour: null, ...o });
    expect(availableWindow(avail({ fromHour: 18, toHour: 2 }), "night")).toEqual({ from: 18, to: 26 });
    expect(availableWindow(avail({ fromHour: 10 }), "morning")).toEqual({ from: 10, to: 15 });
    expect(availableWindow(avail({ morning: true }), "night")).toBeNull();
  });
  it("o número do botão 'pedir disponibilidade' e o envio usam a mesma lista (só extras da cidade)", () => {
    const sched = src("server/extrasSchedule.ts");
    expect(sched).toContain("noAnswerCount: (await noAnswerTargets(date, city, cands)).length");
    expect(sched).toMatch(/const ids = await noAnswerTargets\(date, city\);/);
    expect(sched).toContain(`(c.position ?? "").toLowerCase() === "extra"`);
  });
});

describe("Ecrã do Extras Dia", () => {
  const page = src("client/src/pages/ExtrasDiaPage.tsx");
  it("quem só vê não tem botões de ação nem euros", () => {
    expect(page).toContain(`can(user as any, "extras_dia", "edit")`);
    expect(page).toContain("{canEdit && <Button size=\"sm\" variant=\"default\" onClick={() => setAdding(v => !v)}>");
    expect(page).toContain("{access.costs && (");
    expect(page).not.toContain("trpc.rh.extraRates.list");
  });
  it("remover pergunta antes; avisar é por turno; erros com 'Tentar de novo'", () => {
    expect(page).toContain("Tirar ${a.personName} da escala?");
    expect(page).toContain("notify.mutate({ date: targetDate, city, shift })");
    for (const what of ["a previsão", "o estado da escala", "a equipa deste turno", "a falta de gente por hora", "os avisos enviados", "as reservas deste intervalo"]) {
      expect(page).toContain(`what="${what}"`);
    }
  });
  it("custo da escala é uma estimativa (o extra recebe pelo ponto) e o hoje é o de Lisboa", () => {
    expect(page).toContain(`"Custo escalado (estimativa)"`);
    expect(page).not.toContain(`"Custo real"`);
    expect(page).toContain("return lisbonDayOf(Date.now());");
  });
});
