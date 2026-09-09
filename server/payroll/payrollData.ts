/**
 * Recolha de dados para o cálculo mensal (o cálculo em si é puro: compute.ts).
 *
 *  - colaboradores com VÍNCULO no mês (não só os ativos): contrato a
 *    intersetar o mês, ou ativos sem datas de contrato;
 *  - registos de ponto do mês (com folga de 1 dia para turnos que atravessam
 *    a meia-noite/mês) emparelhados em turnos;
 *  - ausências com TIPO, horário individual, histórico salarial e taxas.
 * Filtro opcional por centro de custos (com descendentes).
 */
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { getDb, resolveProjectIds } from "../db";
import { employeeLeaves, employeeSalaryHistory, employees, extraRates, projects, schedules, timeRecords } from "../../drizzle/schema";
import { pairShifts } from "./shifts";
import { computeEmployeeMonth, type EmployeeMonthResult } from "./compute";

export type PayrollRow = EmployeeMonthResult & {
  department: string | null; projectName: string | null; projectId: number | null; nif: string | null; nib: string | null;
};

function pad(n: number) { return String(n).padStart(2, "0"); }

export async function computePayrollForMonth(year: number, month: number, opts: { projectId?: number | null } = {}): Promise<PayrollRow[]> {
  const db = await getDb();
  if (!db) return [];
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthFirst = `${year}-${pad(month)}-01`;
  const monthLast = `${year}-${pad(month)}-${pad(dim)}`;

  // vínculo no mês: contrato a intersetar, ou ativo sem datas
  const conds: any[] = [
    or(
      and(isNull(employees.contractStart), isNull(employees.contractEnd), eq(employees.isActive, 1)),
      and(
        or(isNull(employees.contractStart), lte(employees.contractStart, `${monthLast} 23:59:59`)),
        or(isNull(employees.contractEnd), gte(employees.contractEnd, `${monthFirst} 00:00:00`)),
        or(eq(employees.isActive, 1), sql`${employees.contractEnd} IS NOT NULL`),
      ),
    ),
  ];
  let projectIds: number[] | null = null;
  if (opts.projectId) {
    projectIds = await resolveProjectIds(opts.projectId);
    conds.push(projectIds.length ? inArray(employees.projectId, projectIds) : sql`1 = 0`);
  }
  const emps = await db.select({ employee: employees, project: projects }).from(employees)
    .leftJoin(projects, eq(employees.projectId, projects.id))
    .where(and(...conds)).orderBy(employees.fullName);
  if (emps.length === 0) return [];
  const empIds = emps.map((e) => e.employee.id);

  const rates = await db.select().from(extraRates);
  const extraRateByLevel = new Map(rates.map((r) => [r.level, parseFloat(String(r.hourlyRate))]));
  const extraRateByName = new Map(rates.filter((r) => r.levelName).map((r) => [String(r.levelName), parseFloat(String(r.hourlyRate))]));

  // registos: do último dia do mês anterior ao primeiro do seguinte (turnos que atravessam)
  const recFrom = new Date(Date.UTC(year, month - 1, 1) - 86400000).toISOString().slice(0, 19).replace("T", " ");
  const recTo = new Date(Date.UTC(year, month, 1) + 86400000).toISOString().slice(0, 19).replace("T", " ");
  const records = await db.select().from(timeRecords)
    .where(and(inArray(timeRecords.employeeId, empIds), gte(timeRecords.recordedAt, recFrom), lte(timeRecords.recordedAt, recTo)))
    .orderBy(timeRecords.recordedAt, timeRecords.id);
  const recordsByEmp = new Map<number, typeof records>();
  for (const r of records) { if (!recordsByEmp.has(r.employeeId)) recordsByEmp.set(r.employeeId, []); recordsByEmp.get(r.employeeId)!.push(r); }

  const hist = await db.select().from(employeeSalaryHistory)
    .where(and(inArray(employeeSalaryHistory.employeeId, empIds), lte(employeeSalaryHistory.effectiveFrom, monthFirst), or(isNull(employeeSalaryHistory.effectiveUntil), gte(employeeSalaryHistory.effectiveUntil, monthFirst))!))
    .orderBy(desc(employeeSalaryHistory.effectiveFrom));
  const snapshotByEmp = new Map<number, { monthlySalary: any; mealAllowancePerDay: any }>();
  for (const h of hist) if (!snapshotByEmp.has(h.employeeId)) snapshotByEmp.set(h.employeeId, { monthlySalary: h.monthlySalary, mealAllowancePerDay: h.mealAllowancePerDay });

  const leaves = await db.select({ employeeId: employeeLeaves.employeeId, leaveType: employeeLeaves.leaveType, fromDate: employeeLeaves.fromDate, toDate: employeeLeaves.toDate })
    .from(employeeLeaves).where(and(inArray(employeeLeaves.employeeId, empIds), lte(employeeLeaves.fromDate, monthLast), gte(employeeLeaves.toDate, monthFirst)));
  const leavesByEmp = new Map<number, typeof leaves>();
  for (const l of leaves) { if (!leavesByEmp.has(l.employeeId)) leavesByEmp.set(l.employeeId, []); leavesByEmp.get(l.employeeId)!.push(l); }

  const scheds = await db.select().from(schedules).where(inArray(schedules.employeeId, empIds));
  const schedByEmp = new Map<number, typeof scheds>();
  for (const s of scheds) { if (!schedByEmp.has(s.employeeId)) schedByEmp.set(s.employeeId, []); schedByEmp.get(s.employeeId)!.push(s); }

  const out: PayrollRow[] = [];
  for (const { employee: e, project } of emps) {
    const { shifts } = pairShifts((recordsByEmp.get(e.id) ?? []).map((r) => ({ id: r.id, type: r.type, recordedAt: r.recordedAt, hoursWorked: r.hoursWorked, notes: r.notes, reviewStatus: (r as any).reviewStatus ?? null })));
    // só turnos que COMEÇAM no mês pedido
    const monthShifts = shifts.filter((s) => s.day >= monthFirst && s.day <= monthLast);
    const res = computeEmployeeMonth({
      employee: { id: e.id, fullName: e.fullName, position: e.position, extraLevel: e.extraLevel, contractStart: e.contractStart, contractEnd: e.contractEnd, isActive: e.isActive, monthlySalary: e.monthlySalary, mealAllowancePerDay: e.mealAllowancePerDay },
      year, month, snapshot: snapshotByEmp.get(e.id) ?? null, shifts: monthShifts,
      leaves: leavesByEmp.get(e.id) ?? [], schedules: schedByEmp.get(e.id) ?? [], extraRateByLevel, extraRateByName,
    });
    // fichas sem vínculo no mês e sem qualquer valor não entram na folha
    if (!res.inContract && res.totalHours === 0 && res.suspiciousHours === 0 && res.openShifts === 0) continue;
    out.push({ ...res, department: e.department, projectName: project?.name ?? null, projectId: e.projectId, nif: e.nif, nib: e.nib });
  }
  return out;
}
