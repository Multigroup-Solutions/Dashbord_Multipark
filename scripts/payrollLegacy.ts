// Cálculo ANTIGO de ordenados (main 31a6eecb) extraído tal e qual — SÓ para scripts/payroll-parity.ts. Apagar quando o Jorge validar os valores.
import { and, eq, gte, lte, inArray, or, isNull, desc, sql } from "drizzle-orm";
import { getDb, toMysqlDateTime } from "../server/db";
import { employees, projects, extraRates, timeRecords, employeeSalaryHistory, employeeLeaves } from "../drizzle/schema";

export async function getPayrollData(year: number, month: number) {
  const db = await getDb();
  if (!db) return [];

  // Get all active employees with project info
  const emps = await db.select({ employee: employees, project: projects })
    .from(employees)
    .leftJoin(projects, eq(employees.projectId, projects.id))
    .where(eq(employees.isActive, 1))
    .orderBy(employees.fullName);

  // Get extra rates
  const rates = await db.select().from(extraRates).orderBy(extraRates.level);
  // Mapa por level numérico (compat) e por nome (sincronizado com extras-dia)
  const rateMap = new Map(rates.map(r => [r.level, parseFloat(String(r.hourlyRate))]));
  const rateByName = new Map(rates.map(r => [String(r.levelName ?? ""), parseFloat(String(r.hourlyRate))]));

  // Dia 1 do mês para snapshot de salário histórico
  const monthFirstDay = `${year}-${String(month).padStart(2, "0")}-01`;

  // Get time records for the month
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0, 23, 59, 59);
  const records = await db.select().from(timeRecords)
    .where(and(gte(timeRecords.recordedAt, toMysqlDateTime(start)), lte(timeRecords.recordedAt, toMysqlDateTime(end))));

  // Group hours by employee
  const hoursByEmployee = new Map<number, { totalHours: number; days: Set<string>; records: typeof records }>();
  for (const r of records) {
    if (!hoursByEmployee.has(r.employeeId)) {
      hoursByEmployee.set(r.employeeId, { totalHours: 0, days: new Set(), records: [] });
    }
    const entry = hoursByEmployee.get(r.employeeId)!;
    entry.totalHours += parseFloat(String(r.hoursWorked ?? 0));
    entry.days.add(new Date(r.recordedAt).toISOString().split("T")[0]);
    entry.records.push(r);
  }

  // Standard working hours per month (22 days * 8h)
  const STANDARD_MONTHLY_HOURS = 176;
  const STANDARD_DAILY_HOURS = 8;

  // Portuguese labor law rates
  const OVERTIME_RATE_FIRST_HOUR = 1.25;  // 25% extra for first hour
  const OVERTIME_RATE_SUBSEQUENT = 1.375; // 37.5% extra for subsequent hours
  const NIGHT_RATE_MULTIPLIER = 1.25;     // 25% extra for night work (22h-7h)
  const WEEKEND_RATE_MULTIPLIER = 1.50;   // 50% extra for weekends/holidays

  // Pré-carrega salário histórico + faltas de TODOS os colaboradores em BULK
  // (2 queries no total, em vez de 2 × nº colaboradores — corrige N+1 que fazia
  // a página Anual estourar os 60s do Vercel com ~8.5k queries para 12 meses).
  const empIds = emps.map(({ employee }) => employee.id);
  const histAll = empIds.length ? await db
    .select()
    .from(employeeSalaryHistory)
    .where(and(
      inArray(employeeSalaryHistory.employeeId, empIds),
      lte(employeeSalaryHistory.effectiveFrom, monthFirstDay),
      or(isNull(employeeSalaryHistory.effectiveUntil), gte(employeeSalaryHistory.effectiveUntil, monthFirstDay))!,
    ))
    .orderBy(desc(employeeSalaryHistory.effectiveFrom)) : [];
  const snapshotByEmp = new Map<number, { monthlySalary: any; mealAllowancePerDay: any }>();
  for (const h of histAll) {
    if (!snapshotByEmp.has(h.employeeId)) snapshotByEmp.set(h.employeeId, { monthlySalary: h.monthlySalary, mealAllowancePerDay: h.mealAllowancePerDay });
  }
  const lastDayNum = new Date(year, month, 0).getDate();
  const monthEndStr = `${year}-${String(month).padStart(2, "0")}-${String(lastDayNum).padStart(2, "0")}`;
  const leavesAll = empIds.length ? await db
    .select({ employeeId: employeeLeaves.employeeId, fromDate: employeeLeaves.fromDate, toDate: employeeLeaves.toDate })
    .from(employeeLeaves)
    .where(and(
      inArray(employeeLeaves.employeeId, empIds),
      lte(employeeLeaves.fromDate, monthEndStr),
      gte(employeeLeaves.toDate, monthFirstDay),
    )) : [];
  const leavesByEmp = new Map<number, Set<string>>();
  for (const r of leavesAll) {
    let set = leavesByEmp.get(r.employeeId);
    if (!set) { set = new Set<string>(); leavesByEmp.set(r.employeeId, set); }
    const from = r.fromDate < monthFirstDay ? monthFirstDay : r.fromDate;
    const to = r.toDate > monthEndStr ? monthEndStr : r.toDate;
    const d = new Date(from + "T00:00:00");
    const limit = new Date(to + "T00:00:00");
    while (d <= limit) { set.add(d.toISOString().slice(0, 10)); d.setDate(d.getDate() + 1); }
  }
  const empMeta = emps.map(({ employee: emp }) => ({
    empId: emp.id,
    snapshot: snapshotByEmp.get(emp.id) ?? { monthlySalary: emp.monthlySalary, mealAllowancePerDay: emp.mealAllowancePerDay },
    leaveDays: leavesByEmp.get(emp.id) ?? new Set<string>(),
  }));
  const metaById = new Map(empMeta.map(m => [m.empId, m]));

  return emps.map(({ employee: emp, project }) => {
    const empHours = hoursByEmployee.get(emp.id) ?? { totalHours: 0, days: new Set(), records: [] };
    const totalHours = Math.round(empHours.totalHours * 100) / 100;
    const daysWorked = empHours.days.size;
    const isExtra = emp.position === "extra";
    const meta = metaById.get(emp.id);
    const snapshot = meta?.snapshot;
    const leaveDays = meta?.leaveDays ?? new Set<string>();

    let baseSalary = 0;
    let extraPayment = 0;
    let overtimeHours = 0;
    let overtimePayment = 0;
    let thirteenthProvision = 0;  // Provisão 13º mês (subsídio de Natal) — duodécimos
    let fourteenthProvision = 0;  // Provisão 14º mês (subsídio de férias) — duodécimos
    let nightHours = 0;
    let nightPayment = 0;
    let weekendHours = 0;
    let weekendPayment = 0;
    let mealAllowance = 0;
    const mealAllowancePerDay = parseFloat(String(snapshot?.mealAllowancePerDay ?? emp.mealAllowancePerDay ?? 0));

    if (isExtra) {
      // Extras: taxa horária por nível. Tenta primeiro pelo nome (sincronizado
      // com extras-dia: junior/senior/terminal/master) e depois pelo nº legacy.
      const levelNum = emp.extraLevel ?? 1;
      const NAME_BY_LEVEL: Record<number, string> = { 1: "junior", 2: "senior", 3: "terminal", 4: "master" };
      const fromName = rateByName.get(NAME_BY_LEVEL[levelNum] ?? "junior");
      const hourlyRate = fromName ?? rateMap.get(levelNum) ?? 4.5;
      extraPayment = Math.round(totalHours * hourlyRate * 100) / 100;
    } else {
      // Regular employees: base salary + overtime + provisions + night/weekend
      // Usa snapshot histórico (salário vigente no mês), não o salário actual.
      baseSalary = parseFloat(String(snapshot?.monthlySalary ?? emp.monthlySalary ?? 0));
      const hourlyBase = baseSalary > 0 ? baseSalary / STANDARD_MONTHLY_HOURS : 0;

      // Classifica cada record em buckets MUTUAMENTE EXCLUSIVOS para evitar
      // contar a mesma hora duas vezes (uma hora noturna num sábado contava
      // como "noite" E "FDS"). Hierarquia: FDS > Noite > Normal.
      let normalHours = 0;
      // Hora/dia-da-semana em Europe/Lisbon (o servidor está em UTC — sem isto
      // as noturnas ficavam desviadas 1h no verão).
      const lisbonFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Lisbon", hour: "numeric", weekday: "short", hour12: false });
      for (const rec of empHours.records) {
        const recDate = new Date(rec.recordedAt);
        const hours = parseFloat(String(rec.hoursWorked ?? 0));
        if (hours <= 0) continue;
        const parts = lisbonFmt.formatToParts(recDate);
        const hour = Number(parts.find((p) => p.type === "hour")?.value ?? recDate.getHours());
        const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
        const isWeekend = weekday === "Sat" || weekday === "Sun";
        const isNight = hour >= 22 || hour < 7;
        if (isWeekend) weekendHours += hours;
        else if (isNight) nightHours += hours;
        else normalHours += hours;
      }
      nightHours = Math.round(nightHours * 100) / 100;
      weekendHours = Math.round(weekendHours * 100) / 100;
      normalHours = Math.round(normalHours * 100) / 100;

      // Acréscimos sobre a base horária (NIGHT 25%, WEEKEND 50%)
      nightPayment = Math.round(nightHours * hourlyBase * (NIGHT_RATE_MULTIPLIER - 1) * 100) / 100;
      weekendPayment = Math.round(weekendHours * hourlyBase * (WEEKEND_RATE_MULTIPLIER - 1) * 100) / 100;

      // Overtime: só horas normais acima do limiar mensal.
      if (normalHours > STANDARD_MONTHLY_HOURS) {
        overtimeHours = Math.round((normalHours - STANDARD_MONTHLY_HOURS) * 100) / 100;
        // Primeira hora/dia a 25%, restantes a 37,5% (aproximação)
        const firstHourPortion = Math.min(overtimeHours, daysWorked);
        const subsequentPortion = Math.max(0, overtimeHours - firstHourPortion);
        overtimePayment = Math.round(
          (firstHourPortion * hourlyBase * OVERTIME_RATE_FIRST_HOUR +
           subsequentPortion * hourlyBase * OVERTIME_RATE_SUBSEQUENT) * 100
        ) / 100;
      }

      // 13th month provision (subsídio de Natal): 1/12 of base salary per month
      thirteenthProvision = Math.round(baseSalary / 12 * 100) / 100;

      // 14th month provision (subsídio de férias): 1/12 of base salary per month
      fourteenthProvision = Math.round(baseSalary / 12 * 100) / 100;

      // Subsídio alimentação: só dias trabalhados que NÃO caiam em férias/baixa.
      let workedDaysExcludingLeave = 0;
      for (const day of empHours.days) {
        if (!leaveDays.has(day)) workedDaysExcludingLeave += 1;
      }
      mealAllowance = Math.round(mealAllowancePerDay * workedDaysExcludingLeave * 100) / 100;
    }

    // Total bruto
    const totalPayment = isExtra
      ? extraPayment
      : baseSalary + overtimePayment + nightPayment + weekendPayment +
        thirteenthProvision + fourteenthProvision + mealAllowance;

    // Estimativa de líquido após impostos (NÃO é contabilidade fiscal real)
    // - TSU empregado: 11% sobre vencimento + extras + acréscimos (NÃO sobre
    //   subsídio de alimentação nem provisões 13º/14º)
    // - IRS: 15% simplificado sobre a mesma base
    const TSU_EMPLOYEE = 0.11;
    const IRS_RATE = 0.15;
    const taxableBase = isExtra
      ? extraPayment
      : baseSalary + overtimePayment + nightPayment + weekendPayment;
    const tsuEmployee = Math.round(taxableBase * TSU_EMPLOYEE * 100) / 100;
    const irsEstimate = Math.round(taxableBase * IRS_RATE * 100) / 100;
    const netEstimate = Math.round((totalPayment - tsuEmployee - irsEstimate) * 100) / 100;

    return {
      employeeId: emp.id,
      fullName: emp.fullName,
      position: emp.position,
      extraLevel: emp.extraLevel,
      department: emp.department,
      projectName: project?.name ?? null,
      projectId: emp.projectId,
      nif: emp.nif,
      nib: emp.nib,
      isExtra,
      totalHours,
      daysWorked,
      baseSalary,
      extraPayment,
      overtimeHours,
      overtimePayment,
      nightHours,
      nightPayment,
      weekendHours,
      weekendPayment,
      thirteenthProvision,
      fourteenthProvision,
      mealAllowance,
      mealAllowancePerDay,
      totalPayment,
      // Estimativa líquido (não fiscal)
      tsuEmployee,
      irsEstimate,
      netEstimate,
      hourlyRate: isExtra
        ? (() => {
            const NAME_BY_LEVEL: Record<number, string> = { 1: "junior", 2: "senior", 3: "terminal", 4: "master" };
            return rateByName.get(NAME_BY_LEVEL[emp.extraLevel ?? 1] ?? "junior") ?? rateMap.get(emp.extraLevel ?? 1) ?? 4.5;
          })()
        : (baseSalary > 0 ? Math.round(baseSalary / STANDARD_MONTHLY_HOURS * 100) / 100 : 0),
    };
  });
}
