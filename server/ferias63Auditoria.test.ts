/**
 * Plano 63, passo 11 — correções da auditoria do mapa de férias (regras puras
 * e guardas que não precisam da BD simulada):
 *  - o "avisou a DD/MM" do Extras-Dia é o dia de LISBOA (não o dia UTC);
 *  - a Avaliação não conta atrasos pelo horário fixo quando as ausências não
 *    se leem (senão quem está de férias levava −5);
 *  - o fluxo (sobreposições ao lançar, avisos) está em ferias63Fluxo.test.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { absenceForScheduler, schedulerAbsenceText } from "../shared/leaves";

describe("Extras-Dia: \"avisou a DD/MM\" é o dia em Lisboa", () => {
  const notice = (requestedAt: string) => absenceForScheduler({ leaveType: "unavailable", status: "approved", fromDate: "2026-11-03", toDate: "2026-11-03", requestedAt });
  it("verão (UTC+1): 23:30 UTC já é o dia seguinte em Lisboa", () => {
    expect(notice("2026-08-02 23:30:00").noticeDay).toBe("2026-08-03");
    expect(schedulerAbsenceText(notice("2026-08-02 23:30:00"))).toBe("Indisponível (avisou a 03/08)");
  });
  it("inverno (UTC+0): igual ao UTC", () => {
    expect(notice("2026-12-01 23:30:00").noticeDay).toBe("2026-12-01");
  });
  it("mudança da hora (25 out 2026 e 29 mar 2026): o dia certo dos dois lados", () => {
    expect(notice("2026-10-24 23:30:00").noticeDay).toBe("2026-10-25"); // 00:30 de verão
    expect(notice("2026-10-25 00:30:00").noticeDay).toBe("2026-10-25"); // 01:30 (a hora repete)
    expect(notice("2026-10-25 23:30:00").noticeDay).toBe("2026-10-25"); // já de inverno
    expect(notice("2026-03-28 23:30:00").noticeDay).toBe("2026-03-28"); // ainda de inverno
    expect(notice("2026-03-29 23:30:00").noticeDay).toBe("2026-03-30"); // já de verão
  });
  it("Date (o mysql2 devolve Date) e sem data", () => {
    expect(absenceForScheduler({ leaveType: "vacation", status: "approved", fromDate: "2026-11-03", toDate: "2026-11-03", requestedAt: new Date("2026-08-02T23:30:00Z") }).noticeDay).toBe("2026-08-03");
    expect(absenceForScheduler({ leaveType: "sick", status: "approved", fromDate: "2026-11-03", toDate: "2026-11-03" }).noticeDay).toBeNull();
  });
});

describe("Avaliação: ausências por ler → sem atraso pelo horário fixo (nunca −5 a quem está de férias)", () => {
  it("se a leitura das ausências falhar, os horários fixos também saem (conta só a escala)", () => {
    const eng = readFileSync(resolve(__dirname, "evaluationEngine.ts"), "utf8");
    const block = eng.slice(eng.indexOf("let fixedSchedules: any[] = [], leaveRows: any[] = [];"), eng.indexOf("const cityOfProjectId"));
    expect(block).toContain("AND ${approvedLeaveSql()}");
    expect(block).toMatch(/catch \(err: any\) \{[\s\S]*fixedSchedules = \[\]; leaveRows = \[\];/);
  });
  it("com as exceções por data (10b): sem as ausências lidas também não se leem as exceções (uma \"trabalha\" num dia de férias dava −5)", () => {
    const eng = readFileSync(resolve(__dirname, "evaluationEngine.ts"), "utf8");
    const block = eng.slice(eng.indexOf("let fixedSchedules: any[] = [], leaveRows: any[] = [];"), eng.indexOf("const cityOfProjectId"));
    // só fica true depois de as ausências (aprovadas) virem
    expect(block.indexOf("leavesRead = true;")).toBeGreaterThan(block.indexOf("AND ${approvedLeaveSql()}"));
    expect(block.indexOf("leavesRead = true;")).toBeLessThan(block.indexOf("} catch (err: any) {"));
    expect(block).toMatch(/const scheduleOverrides = leavesRead\s*\?\s*await \(await import\("\.\/scheduleOverrides"\)\)\.loadActiveOverridesForReaders\(db, addDays\(startDay, -1\), addDays\(endDay, 1\)\)\s*:\s*\[\];/);
  });
});
