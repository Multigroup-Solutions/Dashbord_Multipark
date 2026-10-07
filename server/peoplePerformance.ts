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
 *
 * 42c (Jorge, 7 out 2026):
 *  - cidade e marca do topo (a marca vale a cidade dela): com cidade escolhida
 *    conta o dia na cidade ONDE a pessoa trabalhou (escala / avaliação do
 *    dia); quem é de outra cidade só entra com os dias que fez nesta;
 *  - a aba pela escala: um extra que foi TL em pelo menos metade dos dias
 *    escalados conta como team leader;
 *  - condutores e extras sem nada no período saem; "km sem movimentos"
 *    assinalado (o Zello e o agente não estão na mesma ficha);
 *  - a EQUIPA do TL (o turno dele) e do supervisor (as cidades dele):
 *    movimentos, custo, quem mexeu carros sem Zello, horas paradas e, no
 *    supervisor, extras a mais/a menos face à previsão (dia e semana).
 */
import { sql, type SQL } from "drizzle-orm";
import {
  addTotals, bucketOf, emptyTotals, GROUP_VIEW, groupOf, kmWithoutMoves, perfRange, perHourOf, rosterGroup, teamDayPoints, utcHourMs, workPoints,
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

/** 39g: chamadas da central com clientes e números de fora (sem colegas do RH nem extensões). */
const CENTRAL_EXTERNAL_ONLY = sql`(contactRef IS NULL OR (contactRef NOT LIKE 'emp-%' AND contactRef NOT LIKE 'ext-%'))`;
/**
 * 39g: das internas só conta o supervisor a ligar aos extras (a chamar o
 * pessoal): a ficha do outro lado é extra (posto ou contrato) e quem liga é
 * supervisor (papel da conta ou posto da ficha). Jorge, 7 out 2026.
 */
const CENTRAL_SUPERVISOR_TO_EXTRA = sql`(central_calls.contactRef LIKE 'emp-%'
  AND EXISTS (SELECT 1 FROM employees x WHERE x.id = CAST(SUBSTRING(central_calls.contactRef, 5) AS UNSIGNED) AND (x.position = 'extra' OR x.contractType = 'extra'))
  AND (EXISTS (SELECT 1 FROM users su WHERE su.id = central_calls.userId AND su.role = 'supervisor')
    OR EXISTS (SELECT 1 FROM employees se WHERE se.userId = central_calls.userId AND se.position = 'supervisor')))`;

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
    // 39g: as internas — colegas do RH (emp-) e extensões (ext-) — não contam, exceto o supervisor a ligar aos extras
    src("callsAnswered", "chamadas da central (atendidas)", sql`central_calls`, sql`userId`, sql`startedAt`, sql`direction = 'in' AND held = 1 AND ${CENTRAL_EXTERNAL_ONLY}`),
    src("callsMade", "chamadas da central (feitas)", sql`central_calls`, sql`userId`, sql`startedAt`, sql`direction = 'out' AND (${CENTRAL_EXTERNAL_ONLY} OR ${CENTRAL_SUPERVISOR_TO_EXTRA})`),
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
  /** 42c: tem km do Zello e nenhum movimento na Multipark (utilizador e agente diferentes) */
  kmNoMoves: boolean;
  /** 42c: na aba dos team leaders por ter sido TL na escala (o posto da ficha é outro) */
  byRoster: boolean;
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
  /** 42c: cidades da escala do filtro (null = todas) */
  cities: string[] | null;
  notes: string[];
}

interface RosterRow { day: string; city: string; shift: string; employeeId: number; isTL: boolean; hours: number; level: string | null; startHour: number; endHour: number; sentHomeHour: number | null }

export async function loadPeoplePerformance(o: { period: PerfPeriod; anchor: string; group: PerfGroup }): Promise<PerfResult> {
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  const r = perfRange(o.period, o.anchor);
  const range = operationalDayRangeUtc(r.from, r.to);
  const notes: string[] = [];

  // ── 42c: cidade do topo (a marca vale a cidade dela) ──
  const { scopedDayCities } = await import("./evaluationEngine");
  const { employeeScope, projectScope } = await import("./cityScope");
  const dayCities = scopedDayCities(); // undefined = sem filtro
  const inCities = (c: unknown) => dayCities === undefined || dayCities.includes(String(c ?? ""));

  // ── Escala do período (lida primeiro: dá a aba pela escala, os dias noutra cidade e as equipas) ──
  let roster: RosterRow[] = [];
  try {
    roster = rowsOf(await db.execute(sql`SELECT assignmentDate AS day, city, shift, employeeId, isTeamLeader, level, startHour, endHour, sentHomeHour
        FROM extras_dia_assignments WHERE assignmentDate >= ${r.from} AND assignmentDate <= ${r.to} AND employeeId IS NOT NULL`)).map((a) => {
      const startHour = Number(a.startHour) || 0, endHour = Number(a.endHour) || 0, sent = a.sentHomeHour == null ? null : Number(a.sentHomeHour);
      return { day: dayStr(a.day), city: String(a.city ?? ""), shift: String(a.shift ?? ""), employeeId: Number(a.employeeId), isTL: Number(a.isTeamLeader) === 1,
        level: a.level == null ? null : String(a.level), startHour, endHour, sentHomeHour: sent, hours: Math.max(0, (sent ?? endHour) - startHour) };
    });
  } catch { notes.push("Não deu para ler a escala (dias como team leader e equipas)."); }
  const rosterIn = roster.filter((a) => inCities(a.city));
  const rosterDays = new Map<number, { days: Set<string>; tl: Set<string> }>();
  for (const a of roster) {
    const x = rosterDays.get(a.employeeId) ?? { days: new Set<string>(), tl: new Set<string>() };
    x.days.add(a.day);
    if (a.isTL) x.tl.add(a.day);
    rosterDays.set(a.employeeId, x);
  }
  // dias que contam, com cidade escolhida: os da escala nesta cidade e os da avaliação nesta cidade;
  // dias com escala SÓ noutra cidade não contam
  const allowedDays = new Map<number, Set<string>>();
  const otherCityDays = new Map<number, Set<string>>();
  const addDay = (m: Map<number, Set<string>>, emp: number, day: string) => { const x = m.get(emp) ?? new Set<string>(); x.add(day); m.set(emp, x); };
  if (dayCities !== undefined) {
    for (const a of rosterIn) addDay(allowedDays, a.employeeId, a.day);
    for (const a of roster) if (!inCities(a.city) && !allowedDays.get(a.employeeId)?.has(a.day)) addDay(otherCityDays, a.employeeId, a.day);
  }

  // ── Pessoas da aba ──
  const emps = rowsOf(await db.execute(sql`SELECT e.id, e.fullName, e.position, e.contractType, e.isActive, e.userId, e.photoUrl, u.role,
      ${dayCities === undefined ? sql`1` : sql`CASE WHEN ${projectScope(sql`e.projectId`)} THEN 1 ELSE 0 END`} AS inScope
      FROM employees e LEFT JOIN users u ON u.id = e.userId`));
  // com cidade escolhida: quem tem avaliação do dia nesta cidade, mesmo com a ficha noutra
  if (dayCities !== undefined && dayCities.length) {
    const cityList = sql.join(dayCities.map((c) => sql`${c}`), sql`, `);
    for (const m of rowsOf(await db.execute(sql`SELECT employeeId, day FROM employee_day_metrics
        WHERE day >= ${r.from} AND day <= ${r.to} AND city IN (${cityList})`).catch(() => [[]]))) addDay(allowedDays, Number(m.employeeId), dayStr(m.day));
  }
  // 42c: cidades de cada supervisor (as do acesso da conta; "todas" = as 3)
  const supCities = new Map<number, string[]>();
  if (o.group === "supervision") {
    const { loadCandidatesFromDb } = await import("./notify");
    const cand = new Map((await loadCandidatesFromDb().catch(() => [])).map((c) => [c.id, c.cities] as const));
    const accounts = new Map<number, number[]>();
    for (const e of emps) if (e.userId != null) accounts.set(Number(e.id), [Number(e.userId)]);
    for (const a of rowsOf(await db.execute(sql`SELECT employeeId, userId FROM employee_accounts`).catch(() => [[]]))) {
      accounts.set(Number(a.employeeId), [...(accounts.get(Number(a.employeeId)) ?? []), Number(a.userId)]);
    }
    for (const [emp, users] of accounts) {
      const set = new Set<string>();
      for (const u of users) { const c = cand.get(u); if (c === "all") ["lisbon", "porto", "faro"].forEach((x) => set.add(x)); else for (const x of c ?? []) set.add(x); }
      if (set.size) supCities.set(emp, [...set].sort());
    }
  }
  const people = new Map<number, { name: string; position: string | null; role: string | null; active: boolean; photoUrl: string | null; byRoster: boolean; inScope: boolean }>();
  for (const e of emps) {
    const id = Number(e.id);
    const base = groupOf({ position: e.position ?? null, role: e.role ?? null, contractType: e.contractType ?? null });
    const rd = rosterDays.get(id);
    const g = rosterGroup(base, rd ? { days: rd.days.size, tlDays: rd.tl.size } : undefined);
    if (g !== o.group) continue;
    // o supervisor que cobre a cidade escolhida conta como desta cidade (o trabalho de escritório não é por cidade)
    const inScope = Number(e.inScope) === 1 || (o.group === "supervision" && dayCities !== undefined && (supCities.get(id) ?? []).some((c) => inCities(c)));
    if (dayCities !== undefined && !inScope && !allowedDays.get(id)?.size) continue;
    people.set(id, { name: String(e.fullName ?? ""), position: e.position ?? null, role: e.role ?? null, active: Number(e.isActive) === 1, photoUrl: e.photoUrl ?? null, byRoster: g !== base, inScope });
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
    const p = people.get(emp);
    if (!p) return;
    if (dayCities !== undefined) {
      if (otherCityDays.get(emp)?.has(day)) return; // escalado noutra cidade nesse dia
      if (!p.inScope && !allowedDays.get(emp)?.has(day)) return; // ficha de outra cidade: só os dias feitos aqui
    }
    const b = bucketOf(o.period, day, r);
    if (b) addTotals(cell(emp, b), part);
  };

  // ── Avaliação diária (Multipark + horas + penalizações), com os ajustes ──
  const ids = [...people.keys()];
  if (ids.length) {
    const idList = sql.join(ids.map((x) => sql`${x}`), sql`, `);
    // 42c: com cidade escolhida, o dia conta na cidade onde a pessoa trabalhou (sem cidade no dia: a da ficha)
    const metricCity = dayCities === undefined ? sql`1 = 1`
      : sql`(${dayCities.length ? sql`city IN (${sql.join(dayCities.map((c) => sql`${c}`), sql`, `)})` : sql`1 = 0`} OR (city IS NULL AND ${employeeScope(sql`employee_day_metrics.employeeId`)}))`;
    const mRows = rowsOf(await db.execute(sql`SELECT * FROM employee_day_metrics WHERE day >= ${r.from} AND day <= ${r.to} AND employeeId IN (${idList}) AND ${metricCity}`));
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

  // ── Escala: dias como team leader e quantas pessoas tinha (na cidade escolhida) ──
  const teams = new Map<string, number>();
  for (const a of rosterIn) teams.set(`${a.day}|${a.city}|${a.shift}`, (teams.get(`${a.day}|${a.city}|${a.shift}`) ?? 0) + 1);
  for (const a of rosterIn) {
    if (!a.isTL || !people.has(a.employeeId)) continue;
    const b = bucketOf(o.period, a.day, r);
    if (!b) continue;
    addTotals(cell(a.employeeId, b), { tlDays: 1 });
    const k = `${a.employeeId}|${b}`;
    teamSum.set(k, (teamSum.get(k) ?? 0) + Math.max(0, (teams.get(`${a.day}|${a.city}|${a.shift}`) ?? 1) - 1));
  }

  // ── 42c: a equipa do TL (o turno dele) e do supervisor (as cidades dele) ──
  if ((o.group === "teamleaders" || o.group === "supervision") && rosterIn.length && people.size) {
    try {
      await addTeams({ db, group: o.group, period: o.period, roster: rosterIn, people, supCities, put, notes });
    } catch (err) {
      notes.push(`Não deu para calcular a equipa: ${String((err as Error)?.message ?? err).slice(0, 160)}.`);
    }
  }

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
    totals.teamCost = Math.round(totals.teamCost * 100) / 100;
    totals.teamHoursStopped = Math.round(totals.teamHoursStopped * 10) / 10;
    totals.teamPoints = Math.round(totals.teamPoints * 10) / 10;
    const active = Object.entries(totals).some(([k, v]) => k !== "maxSpeed" && v > 0);
    // inativos sem nada no período ficam de fora; 42c: condutores e extras sem nada também ("se não tem nada, não precisa de estar aqui")
    if (!active && (!p.active || o.group === "drivers")) continue;
    addTotals(groupTotals, { ...totals, teamPeople: 0, maxSpeed: totals.maxSpeed });
    groupTeam += teamTotal;
    const points = workPoints(o.group, totals);
    const { inScope: _inScope, ...shown } = p;
    out.push({ employeeId: emp, ...shown, totals, points, perHour: perHourOf(points, totals.hours), series, kmNoMoves: o.group === "drivers" || o.group === "teamleaders" ? kmWithoutMoves(totals) : false });
  }
  groupTotals.teamPeople = groupTotals.tlDays > 0 ? Math.round((groupTeam / groupTotals.tlDays) * 10) / 10 : 0;
  groupTotals.hours = Math.round(groupTotals.hours * 10) / 10;
  groupTotals.km = Math.round(groupTotals.km * 10) / 10;
  groupTotals.evalPoints = Math.round(groupTotals.evalPoints * 10) / 10;
  notes.push("Telefonemas da central: contam os que a consola da Vodafone registou na dashboard (Integrações → Central Vodafone), sem as chamadas internas (colegas e extensões) — das internas só contam as do supervisor a ligar aos extras —, mais as chamadas do WhatsApp. Emails contam só os enviados pela dashboard.");
  if (dayCities !== undefined) notes.push("Cidade escolhida: conta o dia na cidade onde a pessoa trabalhou (escala ou avaliação do dia); quem tem a ficha noutra cidade entra só com os dias que fez nesta. A marca conta como a cidade dela (as ações da avaliação não estão separadas por parque).");
  if (out.some((x) => x.byRoster)) notes.push("Team leaders pela escala: quem tem posto de condutor ou extra mas foi team leader em pelo menos metade dos dias escalados do período conta aqui.");
  return { period: o.period, anchor: o.anchor, group: o.group, from: r.from, to: r.to, buckets: r.buckets, bucketLabels: r.bucketLabels,
    people: out, groupTotals, groupSeries, speedLimit, cities: dayCities ?? null, notes };
}

/**
 * 42c: a equipa de cada TL (o turno dele na escala: mesmo dia, cidade e turno,
 * sem ele) e de cada supervisor (todos os escalados das cidades dele, TL
 * incluídos), dia a dia: pessoas, movimentos (recolhas + entregas +
 * movimentos da avaliação do dia), custo (como na Atividade do dia: horas ×
 * taxa do nível; o TL = salário ÷ dias de trabalho do mês), quem mexeu carros
 * sem GPS do Zello, horas paradas (GPS) e, no supervisor com dia ou semana, as
 * horas·pessoa a menos / a mais face à previsão do Extras Dia. Os pontos da
 * equipa são por pessoa (shared/peoplePerformance.ts → teamDayPoints).
 */
async function addTeams(o: {
  db: any; group: "teamleaders" | "supervision"; period: PerfPeriod; roster: RosterRow[];
  people: Map<number, unknown>; supCities: Map<number, string[]>;
  put: (emp: number, day: string, part: Partial<PerfTotals>) => void; notes: string[];
}): Promise<void> {
  const { db, roster } = o;
  const memberIds = Array.from(new Set(roster.map((a) => a.employeeId)));
  const days = roster.map((a) => a.day).sort();
  const from = days[0], to = days[days.length - 1];
  const idList = sql.join(memberIds.map((x) => sql`${x}`), sql`, `);

  // movimentos de cada pessoa por dia (avaliação do dia, já calculada)
  const actions = new Map<string, number>();
  for (const m of rowsOf(await db.execute(sql`SELECT employeeId, day, recolhas, entregas, movements FROM employee_day_metrics
      WHERE day >= ${from} AND day <= ${to} AND employeeId IN (${idList})`).catch(() => [[]]))) {
    actions.set(`${m.employeeId}|${dayStr(m.day)}`, (Number(m.recolhas) || 0) + (Number(m.entregas) || 0) + (Number(m.movements) || 0));
  }
  // GPS de cada pessoa por dia: km e horas paradas (partes do PDA partilhado; sem partes, a linha do dia)
  const gps = new Map<string, { km: number; stopped: number }>();
  const addGps = (emp: unknown, day: unknown, km: number, stopped: number) => {
    const k = `${emp}|${dayStr(day)}`;
    const g = gps.get(k) ?? { km: 0, stopped: 0 };
    g.km += km; g.stopped += stopped;
    gps.set(k, g);
  };
  for (const g of rowsOf(await db.execute(sql`SELECT employeeId, day, km, minutes, movingMinutes FROM driver_day_shares
      WHERE day >= ${from} AND day <= ${to} AND employeeId IN (${idList})`).catch(() => [[]]))) {
    addGps(g.employeeId, g.day, Number(g.km) || 0, Math.max(0, (Number(g.minutes) || 0) - (Number(g.movingMinutes) || 0)) / 60);
  }
  for (const g of rowsOf(await db.execute(sql`SELECT h.employeeId, DATE_FORMAT(h.date, '%Y-%m-%d') AS day, h.totalKm AS km, h.hoursStopped FROM daily_driver_history h
      WHERE h.employeeId IN (${idList}) AND DATE(h.date) >= ${from} AND DATE(h.date) <= ${to}
        AND NOT EXISTS (SELECT 1 FROM driver_day_shares s WHERE s.historyId = h.id)`).catch(() => [[]]))) {
    addGps(g.employeeId, g.day, Number(g.km) || 0, Number(g.hoursStopped) || 0);
  }

  // custo de cada linha da escala
  const [{ loadExtraRates, rateFor }, { TL_WORKING_DAYS_PER_MONTH }] = await Promise.all([import("./extraRates"), import("./extrasDia")]);
  const rates = await loadExtraRates();
  const tlIds = Array.from(new Set(roster.filter((a) => a.isTL).map((a) => a.employeeId)));
  const salaries = new Map<number, number>();
  if (tlIds.length) {
    for (const e of rowsOf(await db.execute(sql`SELECT id, monthlySalary FROM employees WHERE id IN (${sql.join(tlIds.map((x) => sql`${x}`), sql`, `)})`).catch(() => [[]]))) {
      salaries.set(Number(e.id), Number(e.monthlySalary ?? 0) || 0);
    }
  }
  const costOf = (a: RosterRow) => {
    if (a.isTL) { const m = salaries.get(a.employeeId) ?? 0; return m > 0 ? m / TL_WORKING_DAYS_PER_MONTH : 0; }
    return a.level ? a.hours * rateFor(rates, a.level) : 0;
  };

  type Unit = { people: number; actions: number; cost: number; noZello: number; hoursStopped: number; short: number; over: number };
  /** Uma equipa (linhas da escala): os membros contam uma vez por dia. */
  const unitOf = (rows: RosterRow[], members: RosterRow[]): Unit => {
    const day = rows[0]?.day ?? "";
    const ids = Array.from(new Set(members.map((a) => a.employeeId)));
    let acts = 0, noZello = 0, stopped = 0;
    for (const id of ids) {
      const n = actions.get(`${id}|${day}`) ?? 0;
      const g = gps.get(`${id}|${day}`);
      acts += n;
      if (n > 0 && !(g && g.km > 0)) noZello += 1;
      stopped += g?.stopped ?? 0;
    }
    return { people: ids.length, actions: acts, cost: rows.reduce((s, a) => s + costOf(a), 0), noZello, hoursStopped: stopped, short: 0, over: 0 };
  };

  // por pessoa (TL ou supervisor) e dia: as equipas desse dia somadas
  const perDay = new Map<string, Unit & { points: number }>();
  const addUnit = (emp: number, day: string, u: Unit) => {
    const k = `${emp}|${day}`;
    const x = perDay.get(k) ?? { people: 0, actions: 0, cost: 0, noZello: 0, hoursStopped: 0, short: 0, over: 0, points: 0 };
    x.people += u.people; x.actions += u.actions; x.cost += u.cost; x.noZello += u.noZello; x.hoursStopped += u.hoursStopped; x.short += u.short; x.over += u.over;
    x.points += teamDayPoints({ people: u.people, actions: u.actions, noZello: u.noZello, hoursStopped: u.hoursStopped });
    perDay.set(k, x);
  };
  const byKey = new Map<string, RosterRow[]>();
  const group = (k: string, a: RosterRow) => byKey.set(k, [...(byKey.get(k) ?? []), a]);

  if (o.group === "teamleaders") {
    for (const a of roster) group(`${a.day}|${a.city}|${a.shift}`, a);
    for (const a of roster) {
      if (!a.isTL || !o.people.has(a.employeeId)) continue;
      const rows = byKey.get(`${a.day}|${a.city}|${a.shift}`) ?? [];
      const members = rows.filter((x) => !x.isTL && x.employeeId !== a.employeeId);
      // o custo da equipa inclui o do TL; os movimentos e o resto são dos outros
      addUnit(a.employeeId, a.day, { ...unitOf(members, members), cost: members.reduce((s, x) => s + costOf(x), 0) + costOf(a) });
    }
  } else {
    for (const a of roster) group(`${a.day}|${a.city}`, a);
    // extras a mais / a menos: a previsão do Extras Dia é lida ao vivo, dia a dia — só no dia e na semana
    const coverage = new Map<string, { short: number; over: number }>();
    if (o.period === "day" || o.period === "week") {
      const [{ getExtrasDiaForecast }, { addDaysIso }, { forecastIncompleteReason }, { coverageBalance }] = await Promise.all([
        import("./extrasDia"), import("./extrasAutomation"), import("./extrasSchedule"), import("../shared/evaluationTeam"),
      ]);
      let incomplete = 0;
      await Promise.all(Array.from(byKey.entries()).map(async ([k, rows]) => {
        const [day, city] = k.split("|");
        try {
          const f = await getExtrasDiaForecast(addDaysIso(day, -1), city as any);
          if (forecastIncompleteReason(f)) { incomplete += 1; return; }
          const c = coverageBalance(f.hourly.map((h) => h.driversNeeded), rows.filter((a) => !a.isTL).map((a) => ({ startHour: a.startHour, endHour: a.endHour, sentHomeHour: a.sentHomeHour })));
          if (c.verdict !== "sem_previsao") coverage.set(k, { short: c.shortPersonHours, over: c.overPersonHours });
        } catch { incomplete += 1; }
      }));
      if (incomplete) o.notes.push(`Extras a mais / a menos: ${incomplete} dia(s) de cidade sem previsão completa ficaram de fora.`);
    } else {
      o.notes.push("Extras a mais / a menos: escolhe Dia ou Semana (a previsão é lida ao vivo da Multipark, dia a dia).");
    }
    for (const emp of o.people.keys()) {
      const cities = o.supCities.get(emp) ?? [];
      for (const [k, rows] of byKey) {
        const [day, city] = k.split("|");
        if (!cities.includes(city)) continue;
        const c = coverage.get(k);
        addUnit(emp, day, { ...unitOf(rows, rows), short: c?.short ?? 0, over: c?.over ?? 0 });
      }
    }
    const noCity = Array.from(o.people.keys()).filter((e) => !o.supCities.get(e)?.length).length;
    if (noCity) o.notes.push(`${noCity} pessoa(s) da supervisão sem cidade na conta: sem equipa.`);
  }

  for (const [k, u] of perDay) {
    const [emp, day] = k.split("|");
    o.put(Number(emp), day, {
      teamDays: 1, teamPersonDays: u.people, teamActions: u.actions, teamCost: Math.round(u.cost * 100) / 100,
      teamNoZello: u.noZello, teamHoursStopped: Math.round(u.hoursStopped * 10) / 10,
      teamShortHours: u.short, teamOverHours: u.over, teamPoints: Math.round(u.points * 10) / 10,
    });
  }
  o.notes.push("Equipa: TL = o turno dele na escala (mesmo dia, cidade e turno); supervisor = todos os escalados das cidades da conta (dois supervisores da mesma cidade partilham a equipa). Pontos da equipa por dia, por pessoa: cada movimento +1, quem mexeu carros sem Zello −20, cada hora parada −2.");
}
