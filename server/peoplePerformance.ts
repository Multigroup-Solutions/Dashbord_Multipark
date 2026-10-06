/**
 * P3 lote 37a — Desempenho por pessoa (regras em shared/peoplePerformance.ts).
 * Só leitura; só para o super admin (o router confirma o papel).
 *
 * Junta por pessoa (ficha) e por dia operacional (03h→03h):
 *  - a avaliação diária já calculada (`employee_day_metrics` + ajustes), que
 *    traz da Multipark as recolhas, entregas, movimentos, "pôs em recolha /
 *    entrega", reservas criadas e alteradas, ocorrências, e da nossa BD as
 *    horas (ponto, ou escala sem ponto), atrasos, reclamações e acidentes;
 *  - o GPS do Zello (km, velocidade máxima, dias acima do limite);
 *  - o que cada conta fez na dashboard (chamadas, WhatsApp, emails,
 *    reclamações, críticas Google, despesas, caixa, correções de caixa,
 *    tarefas, leads, passagens de turno);
 *  - a Multipark ao vivo, por agente: voos de regresso, cobranças de
 *    parceiros e cobranças de Pro e avenças (quem as registou fica guardado
 *    na Multipark);
 *  - a escala (dias como team leader e quantas pessoas tinha).
 * As contas ligam-se à ficha por employees.userId e employee_accounts.
 */
import { sql, type SQL } from "drizzle-orm";
import {
  addTotals, bucketOf, emptyTotals, GROUP_VIEW, groupOf, perfRange, perHourOf, utcHourMs, workPoints,
  type PerfGroup, type PerfMetric, type PerfPeriod, type PerfTotals,
} from "../shared/peoplePerformance";
import { applyAdjustments, emptyDayMetrics, METRIC_KEYS, normalisationHours, scoreOf, withAccidentCutoff, type DayMetrics } from "../shared/evaluationRules";
import { operationalDayOf, operationalDayRangeUtc } from "../shared/lisbonDay";
import type { MultiparkRead } from "./multiparkDb/read";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const dayStr = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").slice(0, 10));

/** Contas da dashboard → contagens por hora UTC (agrupadas no SQL). */
function userSources(start: string, end: string): Array<{ key: PerfMetric; label: string; q: SQL }> {
  const hour = (col: SQL) => sql`DATE_FORMAT(${col}, '%Y-%m-%d %H')`;
  const src = (key: PerfMetric, label: string, table: SQL, userCol: SQL, timeCol: SQL, where: SQL = sql`1 = 1`) => ({
    key, label,
    q: sql`SELECT ${userCol} AS u, ${hour(timeCol)} AS h, COUNT(*) AS n FROM ${table}
            WHERE ${userCol} IS NOT NULL AND ${timeCol} >= ${start} AND ${timeCol} < ${end} AND ${where}
            GROUP BY u, h`,
  });
  return [
    src("callsAnswered", "chamadas atendidas", sql`whatsapp_calls`, sql`answeredByUserId`, sql`answeredAt`, sql`direction = 'in' AND status <> 'rejected'`),
    src("callsMade", "chamadas feitas", sql`whatsapp_calls`, sql`startedByUserId`, sql`startedAt`, sql`direction = 'out'`),
    src("callbacks", "devoluções de chamada", sql`whatsapp_calls`, sql`callbackByUserId`, sql`callbackDoneAt`),
    // 39a: telefonemas da central Vodafone, registados pela consola (como "Sugar CRM")
    src("callsAnswered", "chamadas da central (atendidas)", sql`central_calls`, sql`userId`, sql`startedAt`, sql`direction = 'in' AND held = 1`),
    src("callsMade", "chamadas da central (feitas)", sql`central_calls`, sql`userId`, sql`startedAt`, sql`direction = 'out'`),
    src("waMessages", "mensagens WhatsApp", sql`whatsapp_messages`, sql`sentById`, sql`createdAt`, sql`direction = 'out'`),
    src("emails", "emails", sql`mail_messages`, sql`sentById`, sql`COALESCE(sentAt, createdAt)`, sql`direction = 'out' AND automated = 0`),
    src("complaintMsgs", "respostas em reclamações", sql`complaint_messages`, sql`authorId`, sql`createdAt`, sql`isInternal = 0`),
    src("complaintsClosed", "reclamações fechadas", sql`complaints`, sql`closedById`, sql`closedAt`),
    src("reviewsReplied", "críticas Google", sql`google_reviews`, sql`respondedBy`, sql`respondedAt`),
    src("expenses", "despesas", sql`expenses`, sql`insertedById`, sql`createdAt`),
    src("expensesApproved", "despesas aprovadas", sql`expenses`, sql`approvedById`, sql`approvedAt`),
    src("cashCounts", "contagens de caixa", sql`cash_counts`, sql`countedBy`, sql`countedAt`),
    src("cashCorrections", "correções de caixa", sql`cash_day_review_log`, sql`userId`, sql`\`at\``),
    src("tasksDone", "tarefas", sql`tasks`, sql`completedById`, sql`completedAt`),
    src("leadsActions", "leads", sql`activity_logs`, sql`userId`, sql`createdAt`,
      sql`entity IN ('extra_lead', 'extra_leads') AND action IN ('extra_lead_status', 'extra_lead_contact', 'extra_lead_convert', 'extra_lead_city')`),
    src("handovers", "passagens de turno", sql`shift_handovers`, sql`filledById`, sql`createdAt`),
    // 37b: contas e fecho de mês dos parceiros, extras do dia, CRM, perdidos e achados
    src("partnerAccounts", "contas de parceiros", sql`activity_logs`, sql`userId`, sql`createdAt`,
      sql`entity IN ('partnership', 'agent_partner') AND action <> 'sync'`),
    src("partnerClosings", "fechos de parceiros", sql`partner_month_closes`, sql`closedBy`, sql`closedAt`),
    src("extrasDia", "extras do dia", sql`extras_dia_assignments`, sql`createdById`, sql`createdAt`),
    src("crmUpdates", "CRM", sql`activity_logs`, sql`userId`, sql`createdAt`,
      sql`entity IN ('crm_client', 'crm_contact', 'crm', 'crm_merge_suggestion')`),
    src("crmUpdates", "CRM (junções)", sql`crm_merge_events`, sql`mergedBy`, sql`mergedAt`),
    src("lostFound", "perdidos e achados", sql`activity_logs`, sql`userId`, sql`createdAt`,
      sql`entity IN ('lost_found', 'lost_found_driver', 'lost_found_return_photo')`),
    src("lostFound", "perdidos e achados (mensagens)", sql`lost_found_messages`, sql`userId`, sql`createdAt`),
  ];
}

export interface PerfPerson {
  employeeId: number; name: string; position: string | null; role: string | null; active: boolean; photoUrl: string | null;
  totals: PerfTotals; points: number; perHour: number | null;
  /** por balde, só as métricas do gráfico da aba */
  series: Partial<Record<PerfMetric, number[]>>;
}
export interface PerfResult {
  period: PerfPeriod; anchor: string; group: PerfGroup; from: string; to: string;
  buckets: string[]; bucketLabels: string[];
  people: PerfPerson[];
  groupTotals: PerfTotals;
  groupSeries: Partial<Record<PerfMetric, number[]>>;
  speedLimit: number | null;
  notes: string[];
}

export async function loadPeoplePerformance(o: { period: PerfPeriod; anchor: string; group: PerfGroup }): Promise<PerfResult> {
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  const r = perfRange(o.period, o.anchor);
  const range = operationalDayRangeUtc(r.from, r.to);
  const notes: string[] = [];

  // ── Pessoas da aba ──
  const emps = rowsOf(await db.execute(sql`SELECT e.id, e.fullName, e.position, e.contractType, e.isActive, e.userId, e.photoUrl, u.role
      FROM employees e LEFT JOIN users u ON u.id = e.userId`));
  const people = new Map<number, { name: string; position: string | null; role: string | null; active: boolean; photoUrl: string | null }>();
  for (const e of emps) {
    const g = groupOf({ position: e.position ?? null, role: e.role ?? null, contractType: e.contractType ?? null });
    if (g === o.group) people.set(Number(e.id), { name: String(e.fullName ?? ""), position: e.position ?? null, role: e.role ?? null, active: Number(e.isActive) === 1, photoUrl: e.photoUrl ?? null });
  }
  // contas → ficha (a principal e as extra)
  const userToEmp = new Map<number, number>();
  for (const e of emps) if (e.userId != null && people.has(Number(e.id))) userToEmp.set(Number(e.userId), Number(e.id));
  for (const a of rowsOf(await db.execute(sql`SELECT employeeId, userId FROM employee_accounts`).catch(() => [[]]))) {
    if (people.has(Number(a.employeeId)) && !userToEmp.has(Number(a.userId))) userToEmp.set(Number(a.userId), Number(a.employeeId));
  }

  // acumuladores: pessoa → balde → totais
  const acc = new Map<number, Map<string, PerfTotals>>();
  const teamSum = new Map<string, number>(); // `${emp}|${bucket}` → soma das equipas
  const cell = (emp: number, bucket: string) => {
    let m = acc.get(emp);
    if (!m) { m = new Map(); acc.set(emp, m); }
    let t = m.get(bucket);
    if (!t) { t = emptyTotals(); m.set(bucket, t); }
    return t;
  };
  const put = (emp: number, day: string, part: Partial<PerfTotals>) => {
    if (!people.has(emp)) return;
    const b = bucketOf(o.period, day, r);
    if (b) addTotals(cell(emp, b), part);
  };

  // ── Avaliação diária (Multipark + horas + penalizações), com os ajustes ──
  const ids = [...people.keys()];
  if (ids.length) {
    const idList = sql.join(ids.map((x) => sql`${x}`), sql`, `);
    const mRows = rowsOf(await db.execute(sql`SELECT * FROM employee_day_metrics WHERE day >= ${r.from} AND day <= ${r.to} AND employeeId IN (${idList})`));
    const adj = new Map<string, Array<{ metric: string; delta: number }>>();
    for (const a of rowsOf(await db.execute(sql`SELECT employeeId, day, metric, delta FROM employee_metric_adjustments
        WHERE voidedAt IS NULL AND day >= ${r.from} AND day <= ${r.to} AND employeeId IN (${idList})`).catch(() => [[]]))) {
      const k = `${a.employeeId}|${dayStr(a.day)}`;
      adj.set(k, [...(adj.get(k) ?? []), { metric: String(a.metric), delta: Number(a.delta) }]);
    }
    for (const m of mRows) {
      const emp = Number(m.employeeId), day = dayStr(m.day);
      const base = emptyDayMetrics();
      for (const k of METRIC_KEYS) if (k in m) (base as any)[k] = Number(m[k] ?? 0) || 0;
      base.bonusPoints = 0;
      let d: DayMetrics = withAccidentCutoff(day, base);
      const a = adj.get(`${emp}|${day}`);
      if (a?.length) d = withAccidentCutoff(day, applyAdjustments(d, a));
      let byType: Record<string, number> = {};
      try { byType = m.actionsByType ? JSON.parse(m.actionsByType) : {}; } catch { byType = {}; }
      const hours = normalisationHours(d);
      put(emp, day, {
        hours, workDays: hours > 0 || d.actions > 0 ? 1 : 0, evalPoints: scoreOf(d).totalPoints,
        recolhas: d.recolhas, entregas: d.entregas, movements: d.movements, parkingMoves: d.parkingMoves, cancels: d.cancels,
        checkingIn: Number(byType.CHECKING_IN ?? 0), checkingOut: Number(byType.CHECKING_OUT ?? 0),
        created: Number(byType.CREATED ?? 0), updated: Number(byType.UPDATE ?? 0),
        occurrences: d.incidentsReported, speedAlerts: d.speedingEvents, delays: d.delays, complaintsAgainst: d.complaints, accidents: d.accidents,
      });
    }
    if (!mRows.length) notes.push("Sem avaliação diária guardada neste período (a Multipark e as horas entram pela avaliação, recalculada todas as noites).");
  }

  // ── GPS do Zello (km, velocidade) ──
  let speedLimit: number | null = null;
  try {
    const { speedThreshold } = await import("./dayActivity");
    speedLimit = await speedThreshold();
  } catch { /* sem limite */ }
  if (ids.length && o.group !== "office" && o.group !== "supervision") {
    const idList = sql.join(ids.map((x) => sql`${x}`), sql`, `);
    const gps = [
      ...rowsOf(await db.execute(sql`SELECT employeeId, day, km, maxSpeed FROM driver_day_shares
          WHERE day >= ${r.from} AND day <= ${r.to} AND employeeId IN (${idList})`).catch(() => [[]])),
      ...rowsOf(await db.execute(sql`SELECT h.employeeId, DATE_FORMAT(h.date, '%Y-%m-%d') AS day, h.totalKm AS km, h.maxSpeed FROM daily_driver_history h
          WHERE h.employeeId IN (${idList}) AND DATE(h.date) >= ${r.from} AND DATE(h.date) <= ${r.to}
            AND NOT EXISTS (SELECT 1 FROM driver_day_shares s WHERE s.historyId = h.id)`).catch(() => [[]])),
    ];
    for (const g of gps) {
      const km = Number(g.km ?? 0), max = Number(g.maxSpeed ?? 0);
      put(Number(g.employeeId), dayStr(g.day), { km: Math.round(km * 10) / 10, gpsDays: km > 0 ? 1 : 0, maxSpeed: max, overLimitDays: speedLimit != null && max > speedLimit ? 1 : 0 });
    }
  }

  // ── O que cada conta fez na dashboard (por hora UTC → dia operacional) ──
  if (userToEmp.size) {
    const failed: string[] = [];
    await Promise.all(userSources(range.start, range.end).map(async (s) => {
      try {
        for (const row of rowsOf(await db.execute(s.q))) {
          const emp = userToEmp.get(Number(row.u));
          if (emp == null) continue;
          const ms = utcHourMs(String(row.h));
          if (!Number.isFinite(ms)) continue;
          put(emp, operationalDayOf(ms), { [s.key]: Number(row.n) || 0 });
        }
      } catch { failed.push(s.label); }
    }));
    if (failed.length) notes.push(`Não deu para ler: ${failed.sort().join(", ")}.`);
  }

  // ── Multipark ao vivo, por agente: voos de regresso (37b) e cobranças de parceiros (37c) ──
  if (ids.length && o.group !== "drivers") {
    const idList = sql.join(ids.map((x) => sql`${x}`), sql`, `);
    const agentToEmp = new Map<string, number>();
    for (const e of rowsOf(await db.execute(sql`SELECT id, multiparkAgentUserId FROM employees WHERE id IN (${idList}) AND multiparkAgentUserId IS NOT NULL`).catch(() => [[]]))) {
      agentToEmp.set(String(e.multiparkAgentUserId), Number(e.id));
    }
    for (const a of rowsOf(await db.execute(sql`SELECT employeeId, agentUserId FROM employee_agents WHERE employeeId IN (${idList})`).catch(() => [[]]))) {
      if (!agentToEmp.has(String(a.agentUserId))) agentToEmp.set(String(a.agentUserId), Number(a.employeeId));
    }
    if (agentToEmp.size) {
      const [{ readReturnFlights }, { readPartnerCharges }, { safeMultiparkRead }] = await Promise.all([
        import("./multiparkDb/perfReturnFlights"), import("./multiparkDb/perfPartnerCharges"), import("./multiparkDb/read"),
      ]);
      const win = { userIds: [...agentToEmp.keys()], fromMs: range.startMs, toMs: range.endMs };
      // cada linha conta na coluna da leitura, ou na que traz (cobranças: parceiros vs Pro e avenças)
      type Row = { userId: string; day: string; n: number; metric?: PerfMetric };
      const reads: Array<[string, PerfMetric, Promise<MultiparkRead<Row[]>>]> = [
        ["Voos de regresso", "returnFlights", safeMultiparkRead("desempenho (voos de regresso)", () => readReturnFlights(win))],
        ["Cobranças de parceiros, Pro e avenças", "partnerCharges", safeMultiparkRead("desempenho (cobranças)", () => readPartnerCharges("settlements", win))],
        ["Créditos de parceiros", "partnerCharges", safeMultiparkRead("desempenho (créditos de parceiros)", () => readPartnerCharges("credits", win))],
      ];
      for (const [label, key, pending] of reads) {
        const res = await pending;
        if (res.available) for (const x of res.data) { const emp = agentToEmp.get(x.userId); if (emp != null) put(emp, x.day, { [x.metric ?? key]: x.n }); }
        else notes.push(`${label}: a Multipark não respondeu (${res.reason}).`);
      }
    }
  }

  // ── Escala: dias como team leader e quantas pessoas tinha ──
  try {
    const asg = rowsOf(await db.execute(sql`SELECT DATE_FORMAT(assignmentDate, '%Y-%m-%d') AS day, city, shift, employeeId, isTeamLeader
        FROM extras_dia_assignments WHERE assignmentDate >= ${r.from} AND assignmentDate <= ${r.to} AND employeeId IS NOT NULL`));
    const teams = new Map<string, number>();
    for (const a of asg) teams.set(`${a.day}|${a.city}|${a.shift}`, (teams.get(`${a.day}|${a.city}|${a.shift}`) ?? 0) + 1);
    for (const a of asg) {
      if (Number(a.isTeamLeader) !== 1) continue;
      const emp = Number(a.employeeId);
      if (!people.has(emp)) continue;
      const b = bucketOf(o.period, String(a.day), r);
      if (!b) continue;
      addTotals(cell(emp, b), { tlDays: 1 });
      const k = `${emp}|${b}`;
      teamSum.set(k, (teamSum.get(k) ?? 0) + Math.max(0, (teams.get(`${a.day}|${a.city}|${a.shift}`) ?? 1) - 1));
    }
  } catch { notes.push("Não deu para ler a escala (dias como team leader)."); }

  // ── Totais, séries e pontos ──
  const view = GROUP_VIEW[o.group];
  const groupTotals = emptyTotals();
  const groupSeries: Partial<Record<PerfMetric, number[]>> = Object.fromEntries(view.chart.map((k) => [k, r.buckets.map(() => 0)]));
  const out: PerfPerson[] = [];
  let groupTeam = 0;
  for (const [emp, p] of people) {
    const byBucket = acc.get(emp);
    const totals = emptyTotals();
    let teamTotal = 0;
    const series: Partial<Record<PerfMetric, number[]>> = Object.fromEntries(view.chart.map((k) => [k, r.buckets.map(() => 0)]));
    if (byBucket) {
      for (const [b, t] of byBucket) {
        const i = r.buckets.indexOf(b);
        const team = teamSum.get(`${emp}|${b}`) ?? 0;
        teamTotal += team;
        addTotals(totals, { ...t, teamPeople: 0 });
        for (const k of view.chart) if (i >= 0) { series[k]![i] += t[k]; groupSeries[k]![i] += t[k]; }
      }
    }
    totals.teamPeople = totals.tlDays > 0 ? Math.round((teamTotal / totals.tlDays) * 10) / 10 : 0;
    totals.hours = Math.round(totals.hours * 10) / 10;
    totals.km = Math.round(totals.km * 10) / 10;
    totals.evalPoints = Math.round(totals.evalPoints * 10) / 10;
    const active = Object.entries(totals).some(([k, v]) => k !== "maxSpeed" && v > 0);
    if (!active && !p.active) continue; // inativos sem nada no período ficam de fora
    addTotals(groupTotals, { ...totals, teamPeople: 0, maxSpeed: totals.maxSpeed });
    groupTeam += teamTotal;
    const points = workPoints(o.group, totals);
    out.push({ employeeId: emp, ...p, totals, points, perHour: perHourOf(points, totals.hours), series });
  }
  groupTotals.teamPeople = groupTotals.tlDays > 0 ? Math.round((groupTeam / groupTotals.tlDays) * 10) / 10 : 0;
  groupTotals.hours = Math.round(groupTotals.hours * 10) / 10;
  groupTotals.km = Math.round(groupTotals.km * 10) / 10;
  groupTotals.evalPoints = Math.round(groupTotals.evalPoints * 10) / 10;
  notes.push("Telefonemas da central: contam os que a consola da Vodafone registou na dashboard (Integrações → Central Vodafone), mais as chamadas do WhatsApp. Emails contam só os enviados pela dashboard.");
  return { period: o.period, anchor: o.anchor, group: o.group, from: r.from, to: r.to, buckets: r.buckets, bucketLabels: r.bucketLabels,
    people: out, groupTotals, groupSeries, speedLimit, notes };
}
