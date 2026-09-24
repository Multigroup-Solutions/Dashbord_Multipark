/**
 * Atividade (dia ou intervalo) — o ecrã principal de "Actividade Diária".
 *
 * Junta, POR PESSOA: ações nas reservas (recolhas/entregas/movimentos/
 * cancelamentos), no horário vs fora do horário (escala extras-dia), custo dos
 * extras (só com o gate de totais financeiros), km/velocidades do GPS (com os
 * PDAs partilhados partidos por quem os tinha) e o ponto.
 *
 * FUSOS (B5): tudo o que está na BD é UTC — incluindo
 * `multipark_booking_history.actionTime`: o sync (server/jobs/
 * multiparkBookingSync.ts → parseBookingDate em server/bookingRefresh.ts)
 * grava a hora da API em UTC ("dd/mm/aaaa, hh:mm" é tratado como UTC e ISO
 * com offset é convertido para UTC; o cliente mostra-a com fmtPTDateTime,
 * UTC→Lisboa). Por isso os dias de Lisboa são convertidos em intervalos UTC
 * [início, fim) com `lisbonDayRangeUtc` para ações, ponto, check-ins de PDA e
 * GPS. As linhas do GPS (`daily_driver_history.date`, `driver_day_shares.day`)
 * guardam o DIA de Lisboa a que pertencem e comparam-se como dia.
 */
import { and, gte, lte, sql } from "drizzle-orm";
import { getDb } from "./db";
import { employees, extrasDiaAssignments } from "../drizzle/schema";
import { bookingHistoryScope, cityNameScope, employeeScope, gpsRowOwnScope, gpsRowScope, projectScope } from "./cityScope";
import { addDays, daysInRange, lisbonDayOf, lisbonDayRangeUtc, lisbonHoursSince } from "../shared/lisbonDay";
import { lisbonToday } from "../shared/expensePeriods";
import { aggregateSpeedHistory, buildIdentityResolver, classifyActionShift, leftoverFromShares, type ShiftWindow, type SpeedEntry } from "./activityHelpers";

const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r) as any[]) ?? [];
const r2 = (n: number) => Math.round(n * 100) / 100;
const dayStr = (v: any): string => (v instanceof Date ? v.toISOString() : String(v ?? "")).slice(0, 10);

/** Máximo de dias num pedido (as ações vêm linha a linha para o turno). */
export const MAX_RANGE_DAYS = 93;

export type PersonKind = "colaborador" | "parceiro" | "por_ligar" | "sem_login";

export interface ActivityPerson {
  key: string; name: string; kind: PersonKind;
  employeeId: number | null; partnerName: string | null; isTeamLeader: boolean;
  checkins: number; checkouts: number; movements: number; cancels: number; other: number; totalActions: number;
  /** null = sem escala no intervalo (não se aplica) */
  inShift: number | null; outOfShift: number | null;
  daysScheduled: number; hoursPaid: number;
  /** null = sem permissão para ver custos */
  cost: number | null; costPerAction: number | null;
  totalKm: number | null; hoursWorked: number | null; hoursOnline: number | null; maxSpeed: number | null;
  violations: number; pontoHours: number | null; pdaNames: string | null;
  /** km de dias ainda sem recolha GPS, vindos do ponto (check-out) */
  provisionalKm: boolean;
  zelloUsernames: string[];
}

export interface ActivityDaily { date: string; actions: number; inShift: number; outOfShift: number; scheduled: number; cost: number | null; km: number }

export interface ActivityRange {
  startDate: string; endDate: string; canSeeCost: boolean;
  people: ActivityPerson[];
  daily: ActivityDaily[];
  totals: {
    checkins: number; checkouts: number; movements: number; cancels: number; other: number; totalActions: number;
    totalKm: number; activePeople: number; violations: number;
    inShift: number; outOfShift: number; scheduledPeople: number;
    totalCost: number | null; costPerAction: number | null;
  };
  /** dias do intervalo (até hoje) sem recolha GPS; os km destes são provisórios/ausentes */
  gpsMissingDays: string[];
}

const CT: Record<string, "checkins" | "checkouts" | "movements" | "cancels"> = {
  CHECK_IN: "checkins", CHECKIN: "checkins",
  CHECK_OUT: "checkouts", CHECKOUT: "checkouts",
  MOVEMENT: "movements", MOVE: "movements",
  CANCELLATION: "cancels", CANCEL: "cancels", CANCELLED: "cancels",
};

/** Resolver de identidade com os dados da BD (agentes extra, parceiros, ignorados). */
export async function loadIdentityResolver() {
  const db = await getDb();
  const { listAgentAliases } = await import("./employeeAliases");
  const { listAgentPartners, listIgnoredAgents } = await import("./db");
  // Todas as fichas (não só as da cidade): quem mexeu numa reserva desta cidade
  // é mostrado pelo nome, mesmo sendo de outra — o GPS/ponto dele continuam
  // filtrados pela cidade.
  const emps = db ? await db.select({
    id: employees.id, fullName: employees.fullName,
    multiparkAgentName: employees.multiparkAgentName, multiparkAgentUserId: employees.multiparkAgentUserId,
  }).from(employees) : [];
  const [aliases, partners, ignored] = await Promise.all([listAgentAliases(), listAgentPartners(), listIgnoredAgents()]);
  return {
    emps,
    resolve: buildIdentityResolver(
      emps.map((e) => ({ ...e, multiparkAgentUserId: e.multiparkAgentUserId ?? null, multiparkAgentName: e.multiparkAgentName ?? null })),
      aliases, partners.map((p) => ({ agentName: p.agentName, partnerName: p.partnerName })), ignored,
    ),
    aliases,
  };
}

export async function getActivityRange(opts: { startDate: string; endDate?: string; canSeeCost?: boolean }): Promise<ActivityRange> {
  const startDate = opts.startDate;
  const endDate = opts.endDate && opts.endDate >= startDate ? opts.endDate : startDate;
  const canSeeCost = !!opts.canSeeCost;
  const days = daysInRange(startDate, endDate).slice(0, MAX_RANGE_DAYS);
  const lastDay = days[days.length - 1] ?? startDate;
  const emptyTotals = { checkins: 0, checkouts: 0, movements: 0, cancels: 0, other: 0, totalActions: 0, totalKm: 0, activePeople: 0, violations: 0, inShift: 0, outOfShift: 0, scheduledPeople: 0, totalCost: canSeeCost ? 0 : null, costPerAction: null };
  const out: ActivityRange = { startDate, endDate: lastDay, canSeeCost, people: [], daily: [], totals: emptyTotals, gpsMissingDays: [] };
  const db = await getDb();
  if (!db) return out;
  const inRange = (d: string) => d >= startDate && d <= lastDay;
  const range = lisbonDayRangeUtc(startDate, lastDay);

  const { emps, resolve } = await loadIdentityResolver();
  const empById = new Map(emps.map((e) => [e.id, e]));
  const empByFullName = new Map<string, number | null>();
  for (const e of emps) {
    const k = e.fullName.trim().toLowerCase();
    empByFullName.set(k, empByFullName.has(k) ? null : e.id); // homónimos → sem match
  }

  const people = new Map<string, ActivityPerson>();
  const blank = (key: string, name: string, kind: PersonKind, employeeId: number | null, partnerName: string | null = null): ActivityPerson => ({
    key, name, kind, employeeId, partnerName, isTeamLeader: false,
    checkins: 0, checkouts: 0, movements: 0, cancels: 0, other: 0, totalActions: 0,
    inShift: null, outOfShift: null, daysScheduled: 0, hoursPaid: 0, cost: canSeeCost ? 0 : null, costPerAction: null,
    totalKm: null, hoursWorked: null, hoursOnline: null, maxSpeed: null, violations: 0, pontoHours: null, pdaNames: null,
    provisionalKm: false, zelloUsernames: [],
  });
  const get = (key: string, make: () => ActivityPerson) => {
    let p = people.get(key);
    if (!p) { p = make(); people.set(key, p); }
    return p;
  };
  const personForEmployee = (empId: number, fallbackName?: string | null) =>
    get(`emp:${empId}`, () => blank(`emp:${empId}`, empById.get(empId)?.fullName ?? fallbackName ?? `#${empId}`, "colaborador", empId));
  const daily = new Map<string, ActivityDaily>(days.map((d) => [d, { date: d, actions: 0, inShift: 0, outOfShift: 0, scheduled: 0, cost: canSeeCost ? 0 : null, km: 0 }]));

  // ── Escala extras-dia (custo + janelas do turno). Inclui a véspera do 1.º dia:
  // um turno da noite que passa a meia-noite leva as ações da madrugada.
  const assignments = await db.select().from(extrasDiaAssignments).where(and(
    cityNameScope(extrasDiaAssignments.city),
    gte(extrasDiaAssignments.assignmentDate, addDays(startDate, -1)),
    lte(extrasDiaAssignments.assignmentDate, lastDay),
  ));
  const shiftsByEmp = new Map<number, Map<string, ShiftWindow[]>>();
  const scheduledEmps = new Set<number>();
  let salaries = new Map<number, number>();
  const { loadExtraRates, rateFor } = await import("./extraRates");
  const { TL_WORKING_DAYS_PER_MONTH } = await import("./extrasDia");
  const rates = canSeeCost ? await loadExtraRates() : null;
  if (canSeeCost) {
    const tlIds = [...new Set(assignments.filter((a) => a.isTeamLeader === 1 && a.employeeId != null).map((a) => a.employeeId!))];
    if (tlIds.length) {
      const rows = await db.select({ id: employees.id, monthlySalary: employees.monthlySalary }).from(employees)
        .where(sql`${employees.id} IN (${sql.join(tlIds.map((id) => sql`${id}`), sql`, `)})`);
      salaries = new Map(rows.map((r) => [r.id, Number(r.monthlySalary ?? 0)]));
    }
  }
  for (const a of assignments) {
    const empId = a.employeeId ?? empByFullName.get(a.personName.trim().toLowerCase()) ?? null;
    const end = a.sentHomeHour ?? a.endHour;
    if (empId != null) {
      const byDate = shiftsByEmp.get(empId) ?? new Map<string, ShiftWindow[]>();
      byDate.set(a.assignmentDate, [...(byDate.get(a.assignmentDate) ?? []), { date: a.assignmentDate, startHour: a.startHour, endHour: end }]);
      shiftsByEmp.set(empId, byDate);
    }
    if (!inRange(a.assignmentDate)) continue; // véspera: só para o turno
    const p = empId != null ? personForEmployee(empId, a.personName)
      : get(`sched:${a.personName.trim().toLowerCase()}`, () => blank(`sched:${a.personName.trim().toLowerCase()}`, a.personName, "por_ligar", null));
    if (empId != null) scheduledEmps.add(empId);
    const hours = Math.max(0, end - a.startHour);
    p.daysScheduled++;
    p.hoursPaid = r2(p.hoursPaid + hours);
    if (a.isTeamLeader === 1) p.isTeamLeader = true;
    p.inShift ??= 0; p.outOfShift ??= 0;
    const d = daily.get(a.assignmentDate);
    if (d) d.scheduled++;
    if (canSeeCost && rates) {
      let cost = 0;
      if (a.isTeamLeader === 1) { const m = empId != null ? salaries.get(empId) ?? 0 : 0; if (m > 0) cost = m / TL_WORKING_DAYS_PER_MONTH; }
      else if (a.level) cost = hours * rateFor(rates, a.level);
      p.cost = r2((p.cost ?? 0) + cost);
      if (d) d.cost = r2((d.cost ?? 0) + cost);
    }
  }

  // ── Ações: linha a linha (dia do turno), janela até D+2 para a noite do último dia
  const actionRows = rowsOf(await db.execute(sql`
    SELECT agentUserId, agentName, changeType, actionTime FROM multipark_booking_history
     WHERE actionTime >= ${range.start} AND actionTime < ${lisbonDayRangeUtc(addDays(lastDay, 1)).end}
       AND agentName IS NOT NULL AND agentName != ''
       AND ${bookingHistoryScope(sql`multipark_booking_history.bookingExternalId`)}`));
  for (const r of actionRows) {
    const who = resolve(r.agentUserId, r.agentName);
    if (who.kind === "ignorado") continue;
    const cal = lisbonDayOf(r.actionTime);
    let bucket = { day: cal, inShift: false };
    const shifts = who.employeeId != null ? shiftsByEmp.get(who.employeeId) : undefined;
    if (shifts) {
      const cands = [...(shifts.get(addDays(cal, -1)) ?? []), ...(shifts.get(cal) ?? [])];
      bucket = classifyActionShift(cal, cands, (d) => lisbonHoursSince(d, r.actionTime));
    }
    if (!inRange(bucket.day)) continue; // B3: nada fora do intervalo
    const p = who.kind === "colaborador" ? personForEmployee(who.employeeId)
      : get(who.key, () => blank(who.key, who.name, who.kind, null, who.kind === "parceiro" ? who.partnerName : null));
    const col = CT[String(r.changeType ?? "").toUpperCase()] ?? "other";
    p[col]++;
    p.totalActions++;
    const d = daily.get(bucket.day)!;
    d.actions++;
    if (who.employeeId != null && scheduledEmps.has(who.employeeId)) {
      p.inShift ??= 0; p.outOfShift ??= 0;
      if (bucket.inShift) { p.inShift++; d.inShift++; } else { p.outOfShift++; d.outOfShift++; }
    }
  }

  // ── GPS
  const addGps = (p: ActivityPerson, g: { km: number; hoursWorked: number | null; hoursOnline: number | null; maxSpeed: number; violations: number }, day: string) => {
    p.totalKm = r2((p.totalKm ?? 0) + g.km);
    if (g.hoursWorked != null) p.hoursWorked = r2((p.hoursWorked ?? 0) + g.hoursWorked);
    if (g.hoursOnline != null) p.hoursOnline = r2((p.hoursOnline ?? 0) + g.hoursOnline);
    if (g.maxSpeed > 0) p.maxSpeed = Math.max(p.maxSpeed ?? 0, g.maxSpeed);
    p.violations += g.violations;
    const d = daily.get(day);
    if (d) d.km = r2(d.km + g.km);
  };
  const addZello = (p: ActivityPerson, z: string) => { if (z && !p.zelloUsernames.includes(z)) p.zelloUsernames.push(z); };

  let shareRows: any[];
  try {
    shareRows = rowsOf(await db.execute(sql`
      SELECT s.historyId, s.employeeId, s.day, s.zelloUsername, s.minutes, s.movingMinutes, s.km, s.maxSpeed, s.violations
        FROM driver_day_shares s
       WHERE s.day >= ${startDate} AND s.day <= ${lastDay} AND ${employeeScope(sql`s.employeeId`)}`));
  } catch {
    shareRows = []; // tabela/coluna ainda não criada
  }
  for (const sh of shareRows) {
    const p = personForEmployee(Number(sh.employeeId));
    addZello(p, String(sh.zelloUsername ?? ""));
    addGps(p, {
      km: Number(sh.km ?? 0),
      hoursWorked: sh.movingMinutes == null ? null : Number(sh.movingMinutes) / 60,
      hoursOnline: Number(sh.minutes ?? 0) / 60,
      maxSpeed: Number(sh.maxSpeed ?? 0), violations: Number(sh.violations ?? 0),
    }, String(sh.day));
  }
  const gpsRows = rowsOf(await db.execute(sql`
    SELECT h.id, h.employeeId, h.zelloUsername, h.displayName, DATE_FORMAT(h.date, '%Y-%m-%d') AS day,
           h.totalKm, h.hoursWorked, h.totalHoursOnline, h.maxSpeed, h.speedViolations,
           CASE WHEN ${gpsRowOwnScope(sql`h.employeeId`, sql`h.zelloUsername`)} THEN 1 ELSE 0 END AS own
      FROM daily_driver_history h
     WHERE DATE(h.date) >= ${startDate} AND DATE(h.date) <= ${lastDay}
       AND ${gpsRowScope(sql`h.id`, sql`h.employeeId`, sql`h.zelloUsername`)}`));
  // Soma de TODAS as partes de cada linha (de qualquer cidade) — para o resto
  const sharedIds = gpsRows.map((g) => Number(g.id));
  const shareSums = new Map<number, { km: number; minutes: number; movingMinutes: number; maxSpeed: number; violations: number }>();
  if (sharedIds.length) {
    try {
      for (const s of rowsOf(await db.execute(sql`
        SELECT historyId, SUM(km) AS km, SUM(minutes) AS minutes, SUM(COALESCE(movingMinutes, 0)) AS movingMinutes,
               MAX(maxSpeed) AS maxSpeed, SUM(violations) AS violations
          FROM driver_day_shares WHERE historyId IN (${sql.join(sharedIds.map((id) => sql`${id}`), sql`, `)})
         GROUP BY historyId`))) {
        shareSums.set(Number(s.historyId), { km: Number(s.km ?? 0), minutes: Number(s.minutes ?? 0), movingMinutes: Number(s.movingMinutes ?? 0), maxSpeed: Number(s.maxSpeed ?? 0), violations: Number(s.violations ?? 0) });
      }
    } catch { /* sem partes */ }
  }
  const gpsDays = new Set<string>();
  for (const g of gpsRows) {
    const day = String(g.day);
    gpsDays.add(day);
    if (Number(g.own) !== 1) continue; // só visível pelas partes (já contadas)
    const whole = {
      km: Number(g.totalKm ?? 0), hoursMoving: Number(g.hoursWorked ?? 0), hoursOnline: Number(g.totalHoursOnline ?? 0),
      maxSpeed: Number(g.maxSpeed ?? 0), violations: Number(g.speedViolations ?? 0),
    };
    const sums = shareSums.get(Number(g.id));
    const zello = String(g.zelloUsername ?? "");
    if (sums) {
      // B1: o que o PDA fez sem ninguém com login não pode desaparecer dos totais
      const rest = leftoverFromShares(whole, [sums]);
      if (!rest) continue;
      const key = `gpsu:${zello}`;
      const p = get(key, () => blank(key, `${g.displayName || zello} — sem login no PDA`, "sem_login", null));
      addZello(p, zello);
      addGps(p, { km: rest.km, hoursWorked: rest.hoursMoving, hoursOnline: rest.hoursOnline, maxSpeed: rest.maxSpeed, violations: rest.violations }, day);
      continue;
    }
    const gps = { km: whole.km, hoursWorked: whole.hoursMoving, hoursOnline: whole.hoursOnline, maxSpeed: whole.maxSpeed, violations: whole.violations };
    if (g.employeeId != null) {
      const p = personForEmployee(Number(g.employeeId), g.displayName);
      addZello(p, zello);
      addGps(p, gps, day);
    } else {
      const key = `gpsu:${zello}`;
      const p = get(key, () => blank(key, `${g.displayName || zello} — sem login no PDA`, "sem_login", null));
      addZello(p, zello);
      addGps(p, gps, day);
    }
  }

  // ── Ponto (horas pagas do check-out; os rejeitados não contam) + km provisórios
  const today = lisbonToday();
  const collected = new Set(rowsOf(await db.execute(sql`
    SELECT DISTINCT DATE_FORMAT(date, '%Y-%m-%d') AS d FROM daily_driver_history
     WHERE DATE(date) >= ${startDate} AND DATE(date) <= ${lastDay}`)).map((r) => String(r.d)));
  out.gpsMissingDays = days.filter((d) => d <= today && !collected.has(d));
  const missing = new Set(out.gpsMissingDays);
  const pontoRows = rowsOf(await db.execute(sql`
    SELECT employeeId, recordedAt, hoursWorked, zelloKm, zelloMaxSpeed FROM time_records
     WHERE type = 'check_out' AND recordedAt >= ${range.start} AND recordedAt < ${range.end}
       AND reviewStatus <> 'rejected' AND ${employeeScope(sql`time_records.employeeId`)}`));
  for (const r of pontoRows) {
    const p = personForEmployee(Number(r.employeeId));
    const h = Number(r.hoursWorked ?? 0);
    if (h > 0) p.pontoHours = r2((p.pontoHours ?? 0) + h);
    const day = lisbonDayOf(r.recordedAt);
    const km = Number(r.zelloKm ?? 0);
    if (missing.has(day) && km > 0) {
      // "Mais" (a): ainda sem recolha noturna → km do Zello no check-out do ponto
      p.provisionalKm = true;
      addGps(p, { km, hoursWorked: null, hoursOnline: null, maxSpeed: Number(r.zelloMaxSpeed ?? 0), violations: 0 }, day);
    }
  }

  // ── PDAs usados
  const pdaRows = rowsOf(await db.execute(sql`
    SELECT c.employeeId, GROUP_CONCAT(DISTINCT p.name ORDER BY p.name SEPARATOR ', ') AS names
      FROM pda_checkins c JOIN pdas p ON p.id = c.pdaId
     WHERE c.employeeId IS NOT NULL AND c.checkinAt < ${range.end} AND (c.checkoutAt IS NULL OR c.checkoutAt >= ${range.start})
       AND ${employeeScope(sql`c.employeeId`)}
     GROUP BY c.employeeId`));
  for (const r of pdaRows) {
    const p = people.get(`emp:${Number(r.employeeId)}`);
    if (p) p.pdaNames = r.names ? String(r.names) : null; // só quem teve atividade
  }

  // ── Fecho
  const list = [...people.values()];
  for (const p of list) {
    if (canSeeCost && p.cost != null && p.totalActions > 0) p.costPerAction = r2(p.cost / p.totalActions);
  }
  list.sort((a, b) => b.totalActions - a.totalActions || (b.totalKm ?? 0) - (a.totalKm ?? 0) || a.name.localeCompare(b.name));
  const sum = (f: (p: ActivityPerson) => number) => list.reduce((s, p) => s + f(p), 0);
  const totalActions = sum((p) => p.totalActions);
  const totalCost = canSeeCost ? r2(sum((p) => p.cost ?? 0)) : null;
  out.people = list;
  out.daily = [...daily.values()];
  out.totals = {
    checkins: sum((p) => p.checkins), checkouts: sum((p) => p.checkouts), movements: sum((p) => p.movements),
    cancels: sum((p) => p.cancels), other: sum((p) => p.other), totalActions,
    totalKm: Math.round(sum((p) => p.totalKm ?? 0) * 10) / 10,
    activePeople: list.length, violations: sum((p) => p.violations),
    inShift: sum((p) => p.inShift ?? 0), outOfShift: sum((p) => p.outOfShift ?? 0),
    scheduledPeople: list.filter((p) => p.daysScheduled > 0).length,
    totalCost, costPerAction: totalCost != null && totalActions > 0 ? r2(totalCost / totalActions) : null,
  };
  return out;
}

// ─── Detalhe de uma pessoa num dia (gaveta) ──────────────────────────────────

export async function getPersonDay(date: string, key: string) {
  const db = await getDb();
  const empty = { date, key, name: key, actions: [] as any[], gps: [] as any[], pda: [] as any[], ponto: [] as any[] };
  if (!db) return empty;
  const range = lisbonDayRangeUtc(date);
  const [kind, ...rest] = key.split(":");
  const ref = rest.join(":");
  if (kind === "emp") {
    const empId = Number(ref);
    if (!Number.isFinite(empId)) return empty;
    const { emps, aliases } = await loadIdentityResolver();
    const e = emps.find((x) => x.id === empId);
    const ids = [e?.multiparkAgentUserId, ...aliases.filter((a) => a.employeeId === empId).map((a) => a.agentUserId)].filter((x): x is string => !!x && !!String(x).trim());
    const names = [e?.multiparkAgentName, ...aliases.filter((a) => a.employeeId === empId).map((a) => a.agentName)].filter((x): x is string => !!x && !!String(x).trim()).map((n) => n.trim().toLowerCase());
    const who: any[] = [];
    if (ids.length) who.push(sql`h.agentUserId IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
    if (names.length) who.push(sql`LOWER(TRIM(h.agentName)) IN (${sql.join(names.map((n) => sql`${n}`), sql`, `)})`);
    const actions = who.length ? await actionsOf(db, range, sql`(${sql.join(who, sql` OR `)})`) : [];
    const gps = rowsOf(await db.execute(sql`
      SELECT 'parte' AS src, s.zelloUsername, s.km, s.minutes, s.movingMinutes, s.maxSpeed, s.avgSpeed, s.violations, h.geoJsonUrl
        FROM driver_day_shares s LEFT JOIN daily_driver_history h ON h.id = s.historyId
       WHERE s.employeeId = ${empId} AND s.day = ${date} AND ${employeeScope(sql`s.employeeId`)}`).catch(() => [[]] as any))
      .concat(rowsOf(await db.execute(sql`
      SELECT 'dia' AS src, h.zelloUsername, h.totalKm AS km, ROUND(h.totalHoursOnline * 60) AS minutes, ROUND(h.hoursWorked * 60) AS movingMinutes,
             h.maxSpeed, h.avgSpeed, h.speedViolations AS violations, h.geoJsonUrl
        FROM daily_driver_history h
       WHERE h.employeeId = ${empId} AND DATE(h.date) = ${date} AND ${employeeScope(sql`h.employeeId`)}
         AND NOT EXISTS (SELECT 1 FROM driver_day_shares s WHERE s.historyId = h.id)`)));
    const pda = rowsOf(await db.execute(sql`
      SELECT p.name AS pdaName, c.zelloUsername, c.checkinAt, c.checkoutAt FROM pda_checkins c JOIN pdas p ON p.id = c.pdaId
       WHERE c.employeeId = ${empId} AND c.checkinAt < ${range.end} AND (c.checkoutAt IS NULL OR c.checkoutAt >= ${range.start})
         AND ${employeeScope(sql`c.employeeId`)} ORDER BY c.checkinAt`));
    const ponto = rowsOf(await db.execute(sql`
      SELECT type, recordedAt, hoursWorked, reviewStatus, zelloKm, zelloMaxSpeed FROM time_records
       WHERE employeeId = ${empId} AND recordedAt >= ${range.start} AND recordedAt < ${range.end}
         AND ${employeeScope(sql`time_records.employeeId`)} ORDER BY recordedAt`));
    return { date, key, name: e?.fullName ?? `#${empId}`, employeeId: empId, actions, gps: gps.map(normGps), pda, ponto };
  }
  if (kind === "agent") {
    const actions = await actionsOf(db, range, sql`LOWER(TRIM(h.agentName)) = ${ref}`);
    return { ...empty, name: actions[0]?.agentName ?? ref, actions };
  }
  if (kind === "gpsu") {
    const gps = rowsOf(await db.execute(sql`
      SELECT 'dia' AS src, h.zelloUsername, h.displayName, h.totalKm AS km, ROUND(h.totalHoursOnline * 60) AS minutes, ROUND(h.hoursWorked * 60) AS movingMinutes,
             h.maxSpeed, h.avgSpeed, h.speedViolations AS violations, h.geoJsonUrl
        FROM daily_driver_history h
       WHERE h.zelloUsername = ${ref} AND DATE(h.date) = ${date}
         AND ${gpsRowOwnScope(sql`h.employeeId`, sql`h.zelloUsername`)}`));
    const pda = rowsOf(await db.execute(sql`
      SELECT p.name AS pdaName, c.zelloUsername, c.checkinAt, c.checkoutAt, e.fullName AS employeeName
        FROM pda_checkins c JOIN pdas p ON p.id = c.pdaId LEFT JOIN employees e ON e.id = c.employeeId
       WHERE c.zelloUsername = ${ref} AND c.checkinAt < ${range.end} AND (c.checkoutAt IS NULL OR c.checkoutAt >= ${range.start})
         AND ${gpsRowOwnScope(sql`NULL`, sql`c.zelloUsername`)} ORDER BY c.checkinAt`));
    return { ...empty, name: gps[0]?.displayName ?? ref, gps: gps.map(normGps), pda };
  }
  return empty;
}

function normGps(g: any) {
  return {
    src: String(g.src), zelloUsername: String(g.zelloUsername ?? ""), km: Number(g.km ?? 0),
    minutes: g.minutes == null ? null : Number(g.minutes), movingMinutes: g.movingMinutes == null ? null : Number(g.movingMinutes),
    maxSpeed: Number(g.maxSpeed ?? 0), avgSpeed: Number(g.avgSpeed ?? 0), violations: Number(g.violations ?? 0),
    geoJsonUrl: g.geoJsonUrl ? String(g.geoJsonUrl) : null,
  };
}

async function actionsOf(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, range: { start: string; end: string }, who: ReturnType<typeof sql>) {
  return rowsOf(await db.execute(sql`
    SELECT h.bookingExternalId, h.changeType, h.actionTime, h.agentName, b.licensePlate, b.bookingNumber, b.parkName
      FROM multipark_booking_history h LEFT JOIN multipark_bookings b ON b.externalId = h.bookingExternalId
     WHERE h.actionTime >= ${range.start} AND h.actionTime < ${range.end} AND ${who}
       AND ${bookingHistoryScope(sql`h.bookingExternalId`)}
     ORDER BY h.actionTime LIMIT 500`)).map((r) => ({
    bookingExternalId: String(r.bookingExternalId ?? ""), changeType: String(r.changeType ?? ""), actionTime: r.actionTime instanceof Date ? r.actionTime.toISOString() : String(r.actionTime),
    agentName: r.agentName ? String(r.agentName) : null, licensePlate: r.licensePlate ? String(r.licensePlate) : null,
    bookingNumber: r.bookingNumber ? String(r.bookingNumber) : null, parkName: r.parkName ? String(r.parkName) : null,
  }));
}

// ─── Histórico de velocidade por pessoa ──────────────────────────────────────

/** Limite usado nos excessos (o mesmo da recolha): máx. × (1 + tolerância). */
export async function speedThreshold(): Promise<number | null> {
  const { getDefaultSpeedLimit } = await import("./db");
  const l = await getDefaultSpeedLimit();
  return l ? Number(l.maxSpeed) * (1 + Number(l.tolerancePercent ?? 0) / 100) : null;
}

export async function getPersonSpeedHistory(opts: { employeeId?: number; zelloUsername?: string; days: number }) {
  const db = await getDb();
  const threshold = await speedThreshold();
  const since = addDays(lisbonToday(), -Math.max(1, Math.min(opts.days, 366)) + 1);
  if (!db) return { name: "", days: [], threshold };
  const entries: SpeedEntry[] = [];
  let name = opts.zelloUsername ?? "";
  if (opts.employeeId != null) {
    const id = opts.employeeId;
    const [e] = await db.select({ fullName: employees.fullName }).from(employees).where(sql`${employees.id} = ${id}`).limit(1);
    name = e?.fullName ?? `#${id}`;
    const shares = rowsOf(await db.execute(sql`
      SELECT s.day, s.km, s.maxSpeed, s.avgSpeed, s.points, s.violations, s.movingMinutes, h.geoJsonUrl
        FROM driver_day_shares s LEFT JOIN daily_driver_history h ON h.id = s.historyId
       WHERE s.employeeId = ${id} AND s.day >= ${since} AND ${employeeScope(sql`s.employeeId`)}`).catch(() => [[]] as any));
    const whole = rowsOf(await db.execute(sql`
      SELECT DATE_FORMAT(h.date, '%Y-%m-%d') AS day, h.totalKm AS km, h.maxSpeed, h.avgSpeed, h.gpsPointsCount AS points,
             h.speedViolations AS violations, ROUND(h.hoursWorked * 60) AS movingMinutes, h.geoJsonUrl
        FROM daily_driver_history h
       WHERE h.employeeId = ${id} AND DATE(h.date) >= ${since} AND ${employeeScope(sql`h.employeeId`)}
         AND NOT EXISTS (SELECT 1 FROM driver_day_shares s WHERE s.historyId = h.id)`));
    for (const r of [...shares, ...whole]) entries.push(toEntry(r));
  } else if (opts.zelloUsername) {
    const rows = rowsOf(await db.execute(sql`
      SELECT DATE_FORMAT(h.date, '%Y-%m-%d') AS day, h.totalKm AS km, h.maxSpeed, h.avgSpeed, h.gpsPointsCount AS points,
             h.speedViolations AS violations, ROUND(h.hoursWorked * 60) AS movingMinutes, h.geoJsonUrl, h.displayName
        FROM daily_driver_history h
       WHERE h.zelloUsername = ${opts.zelloUsername} AND DATE(h.date) >= ${since}
         AND ${gpsRowOwnScope(sql`h.employeeId`, sql`h.zelloUsername`)}`));
    if (rows[0]?.displayName) name = String(rows[0].displayName);
    for (const r of rows) entries.push(toEntry(r));
  }
  return { name, days: aggregateSpeedHistory(entries), threshold };
}

function toEntry(r: any): SpeedEntry {
  return {
    date: dayStr(r.day), km: Number(r.km ?? 0), maxSpeed: Number(r.maxSpeed ?? 0), avgSpeed: Number(r.avgSpeed ?? 0),
    points: Number(r.points ?? 0), violations: Number(r.violations ?? 0),
    movingMinutes: r.movingMinutes == null ? null : Number(r.movingMinutes), geoJsonUrl: r.geoJsonUrl ? String(r.geoJsonUrl) : null,
  };
}

/** Pessoas (e Zellos sem login) com GPS nos últimos `days` dias — para escolher no histórico. */
export async function listSpeedHistoryPeople(days = 90) {
  const db = await getDb();
  if (!db) return { employees: [], zellos: [] };
  const since = addDays(lisbonToday(), -days + 1);
  const emps = rowsOf(await db.execute(sql`
    SELECT e.id, e.fullName FROM employees e
     WHERE ${projectScope(sql`e.projectId`)} AND (
       EXISTS (SELECT 1 FROM driver_day_shares s WHERE s.employeeId = e.id AND s.day >= ${since})
       OR EXISTS (SELECT 1 FROM daily_driver_history h WHERE h.employeeId = e.id AND DATE(h.date) >= ${since}))
     ORDER BY e.fullName`).catch(() => [[]] as any));
  const zellos = rowsOf(await db.execute(sql`
    SELECT DISTINCT h.zelloUsername, h.displayName FROM daily_driver_history h
     WHERE h.employeeId IS NULL AND DATE(h.date) >= ${since} AND ${gpsRowOwnScope(sql`h.employeeId`, sql`h.zelloUsername`)}
     ORDER BY h.zelloUsername`));
  return {
    employees: emps.map((e) => ({ id: Number(e.id), name: String(e.fullName) })),
    zellos: zellos.map((z) => ({ zelloUsername: String(z.zelloUsername), name: String(z.displayName || z.zelloUsername) })),
  };
}

