/**
 * Recolha de dados para o cálculo mensal (o cálculo em si é puro: compute.ts).
 *
 *  - colaboradores com VÍNCULO no mês (não só os ativos): contrato a
 *    intersetar o mês, ou ativos sem datas de contrato — e, SEMPRE, as fichas
 *    com entradas do ponto no mês (mesmo inativas ou fora do contrato: as
 *    horas nunca ficam de fora em silêncio; vão com aviso);
 *  - registos de ponto do mês (com folga de 1 dia para turnos que atravessam
 *    a meia-noite/mês) emparelhados em turnos;
 *  - ausências com TIPO, horário individual, histórico salarial e taxas.
 * Filtro opcional por centro de custos (com descendentes).
 */
import { and, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { getDb, resolveProjectIds } from "../db";
import { employeeLeaves, employeeSalaryHistory, employees, extraRates, projects, schedules, timeRecords } from "../../drizzle/schema";
import { pairShifts } from "./shifts";
import { computeEmployeeMonth, type EmployeeMonthResult } from "./compute";
import { lisbonDayRangeUtc } from "../../shared/lisbonDay";
import { pontoFichaWarnings, type PontoFichaLike } from "../../shared/pontoFichas";

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

  // Fichas com ENTRADAS do ponto no mês (dia de Lisboa, como os turnos da
  // folha), com as contas de login de cada uma. Entram SEMPRE na folha: antes,
  // uma ficha inativa sem fim de contrato ficava de fora com as horas todas
  // (ex.: a 2.ª ficha da mesma conta, para onde foram as picagens a meio do mês).
  const monthRange = lisbonDayRangeUtc(monthFirst, monthLast);
  const pontoFichas = await loadPontoFichas(db, monthRange.start, monthRange.end);
  const withPontoIds = pontoFichas.map((f) => f.employeeId);

  // vínculo no mês: contrato a intersetar, ou ativo sem datas
  const bond = or(
    and(isNull(employees.contractStart), isNull(employees.contractEnd), eq(employees.isActive, 1)),
    and(
      or(isNull(employees.contractStart), lte(employees.contractStart, `${monthLast} 23:59:59`)),
      or(isNull(employees.contractEnd), gte(employees.contractEnd, `${monthFirst} 00:00:00`)),
      or(eq(employees.isActive, 1), sql`${employees.contractEnd} IS NOT NULL`),
    ),
  );
  const conds: any[] = [withPontoIds.length ? or(bond, inArray(employees.id, withPontoIds)) : bond];
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
  // Terminal no ponto (aeroporto): interruptor PONTO_TERMINAL (desligado → como antes)
  const { pontoTerminalEnabled } = await import("../pontoTerminal");
  const terminalEnabled = await pontoTerminalEnabled();
  // Plano 56 B2: as sessões do terminal pelo perfil (só extras, payUplift = 1) que tocam
  // os turnos do mês — só com o interruptor ligado (desligado → nem se leem).
  let terminalSessionsFailed = false;
  const sessionsByEmp = terminalEnabled
    ? await (await import("../terminalPay")).loadTerminalPaySessions(empIds, recFrom, recTo).catch((err) => {
      // nunca em silêncio: os extras ficam com o aviso (as horas de terminal ficam de fora)
      terminalSessionsFailed = true;
      console.warn("[payroll] sessões do terminal não lidas:", String((err as Error)?.message ?? err).slice(0, 160));
      return new Map<number, never[]>();
    })
    : new Map<number, never[]>();
  const schedByEmp = new Map<number, typeof scheds>();
  for (const s of scheds) { if (!schedByEmp.has(s.employeeId)) schedByEmp.set(s.employeeId, []); schedByEmp.get(s.employeeId)!.push(s); }

  const fichaWarnings = pontoFichaWarnings(pontoFichas);
  const out: PayrollRow[] = [];
  for (const { employee: e, project } of emps) {
    const { shifts } = pairShifts((recordsByEmp.get(e.id) ?? []).map((r) => ({ id: r.id, type: r.type, recordedAt: r.recordedAt, hoursWorked: r.hoursWorked, notes: r.notes, reviewStatus: (r as any).reviewStatus ?? null, terminalStatus: r.terminalStatus ?? null, terminalUntil: r.terminalUntil ?? null })));
    // só turnos que COMEÇAM no mês pedido
    const monthShifts = shifts.filter((s) => s.day >= monthFirst && s.day <= monthLast);
    const res = computeEmployeeMonth({
      employee: { id: e.id, fullName: e.fullName, position: e.position, extraLevel: e.extraLevel, contractStart: e.contractStart, contractEnd: e.contractEnd, isActive: e.isActive, monthlySalary: e.monthlySalary, mealAllowancePerDay: e.mealAllowancePerDay },
      year, month, snapshot: snapshotByEmp.get(e.id) ?? null, shifts: monthShifts,
      leaves: leavesByEmp.get(e.id) ?? [], schedules: schedByEmp.get(e.id) ?? [], extraRateByLevel, extraRateByName, terminalEnabled,
      terminalSessions: sessionsByEmp.get(e.id) ?? null,
    });
    if (terminalSessionsFailed && res.isExtra) res.warnings.push("terminal pelo perfil: as sessões não foram lidas — horas de terminal em falta (recarrega antes de fechar o mês)");
    // ficha inativa com picagens / a mesma conta picou noutra ficha (shared/pontoFichas.ts)
    res.warnings.push(...(fichaWarnings.get(e.id) ?? []));
    if (Number(e.isActive) !== 1 && !e.contractEnd && !res.isExtra && res.baseSalary > 0) {
      res.warnings.push("ficha inativa sem data de fim de contrato: o salário base está a contar o mês inteiro — põe a data de fim na ficha");
    }
    // fichas sem vínculo no mês e sem qualquer valor não entram na folha
    if (!res.inContract && res.totalHours === 0 && res.suspiciousHours === 0 && res.openShifts === 0) continue;
    out.push({ ...res, department: e.department, projectName: project?.name ?? null, projectId: e.projectId, nif: e.nif, nib: e.nib });
  }
  return out;
}

const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r?.rows ?? r) as any[]) ?? [];

/**
 * Todas as fichas com entradas do ponto em [start, end) (UTC) — de qualquer
 * cidade, ativas ou não — com as contas de login de cada uma (a principal e as
 * extra de employee_accounts). Serve para as meter na folha e para ver se a
 * mesma conta picou em mais do que uma ficha.
 */
async function loadPontoFichas(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, start: string, end: string): Promise<PontoFichaLike[]> {
  const rows = await db.select({
    id: employees.id, fullName: employees.fullName, isActive: employees.isActive, userId: employees.userId,
    checkIns: sql<number>`COUNT(*)`,
  }).from(timeRecords).innerJoin(employees, eq(employees.id, timeRecords.employeeId))
    .where(and(eq(timeRecords.type, "check_in"), gte(timeRecords.recordedAt, start), lt(timeRecords.recordedAt, end)))
    .groupBy(employees.id, employees.fullName, employees.isActive, employees.userId);
  if (!rows.length) return [];
  const extraLogins = new Map<number, number[]>();
  try {
    const ids = rows.map((r) => r.id);
    const aliases = rowsOf(await db.execute(sql`SELECT userId, employeeId FROM employee_accounts WHERE employeeId IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`));
    for (const a of aliases) extraLogins.set(Number(a.employeeId), [...(extraLogins.get(Number(a.employeeId)) ?? []), Number(a.userId)]);
  } catch { /* employee_accounts ainda não criada: só a conta principal */ }
  return rows.map((r) => ({
    employeeId: r.id,
    fullName: r.fullName,
    isActive: Number(r.isActive) === 1,
    logins: [...(r.userId != null ? [Number(r.userId)] : []), ...(extraLogins.get(r.id) ?? [])],
    checkIns: Number(r.checkIns),
  }));
}
