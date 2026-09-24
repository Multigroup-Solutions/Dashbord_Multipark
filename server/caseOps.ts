/**
 * Ocorrências + Perdidos — operações com BD que atravessam os dois módulos:
 *  - cidade: âmbito SQL + derivação do projeto a partir da reserva;
 *  - duplicados (email ↔ remarks Multipark);
 *  - Cruzamento de condutores (ranking, detalhe, "aparece em N outros casos");
 *  - painel (idade, atraso, tempo médio, tipo, cidade, condutores repetidos);
 *  - lembretes de SLA (cron horário);
 *  - conversões NÃO destrutivas (incidente ↔ reclamação ↔ perdido);
 *  - responsabilização (custo + pontos → penalização RH pendente);
 *  - ficheiros com URL assinada e apagar caso por completo.
 *
 * As decisões puras estão em shared/caseRules.ts (testadas).
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  complaintDriversOnDuty, complaints, employees, incidents, lostFoundAttachedDrivers,
  lostFoundItems, lostFoundMessages, lostFoundPhotos, projects, users,
} from "../drizzle/schema";
import { getDb, resolveProjectIds } from "./db";
import { projectScope, scopedProjectIds } from "./cityScope";
import { resolveCityAccess } from "./cityAccess";
import { lisbonDayRangeUtc } from "../shared/lisbonDay";
import {
  buildDriverCrossRef, convertedOriginPatch, complaintToLostFields, driverKey,
  incidentToComplaintFields, incidentToLostFields, isDuplicateIncident, isCaseReminderHour,
  lostToComplaintFields, parseUtc, reminderDue, repeatDriversForCase, utcNowStr,
  INCIDENT_TYPE_LABEL, type CrossRefLink, type CrossRefRow,
} from "../shared/caseRules";

const rowsOf = (r: any): any[] => (Array.isArray(r?.[0]) ? r[0] : r) as any[];

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Base de dados indisponível");
  return d;
}

// ─── Cidade ─────────────────────────────────────────────────────────────────

export interface CaseScopeFilter { projectId?: number; noProject?: boolean }

/**
 * Âmbito de cidade de uma coluna projectId em SQL cru: cidade do utilizador
 * (quem vê todas vê também os "Sem cidade"), filtro hierárquico do projeto ou
 * só os "Sem cidade" (apenas para quem vê todas as cidades).
 */
export async function caseScopeSql(column: SQL, f: CaseScopeFilter = {}): Promise<SQL> {
  const parts: SQL[] = [projectScope(column)];
  if (f.noProject) {
    parts.push(scopedProjectIds() === undefined ? sql`${column} IS NULL` : sql`1 = 0`);
  } else if (f.projectId) {
    const ids = await resolveProjectIds(f.projectId);
    parts.push(ids.length ? sql`${column} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})` : sql`1 = 0`);
  }
  return sql.join(parts, sql` AND `);
}

/**
 * Reserva de uma ocorrência/caso: ref explícita (externalId ou nº) ganha;
 * senão matrícula ancorada na data. Devolve projeto (cidade) + externalId.
 */
export async function deriveBookingForCase(s: { bookingRef?: string | null; plate?: string | null; atUtc?: string | null }): Promise<{ projectId: number | null; externalId: string } | null> {
  if (!s.bookingRef?.trim() && !s.plate?.trim()) return null;
  try {
    const { matchBookingForComplaint } = await import("./complaintDossier");
    const m = await matchBookingForComplaint({
      reservationRef: s.bookingRef ?? undefined,
      vehiclePlate: s.plate ?? undefined,
      anchorDate: s.atUtc ? new Date((s.atUtc.replace(" ", "T")) + "Z").toISOString() : undefined,
    } as any);
    if (!m) return null;
    return { projectId: m.booking.projectId ?? null, externalId: m.booking.externalId };
  } catch (err) {
    console.warn("[caseOps] derivar reserva falhou:", String((err as any)?.message ?? err).slice(0, 160));
    return null;
  }
}

/** Nó de cidade de cada projeto (para agrupar "por cidade" e escolher destinatários). */
async function projectCityMap(): Promise<{ cityOf: (pid: number | null | undefined) => { id: number; name: string } | null; nodes: any[] }> {
  const d = await db();
  const nodes = await d.select({ id: projects.id, parentId: projects.parentId, level: projects.level, name: projects.name }).from(projects);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const cache = new Map<number, { id: number; name: string } | null>();
  const cityOf = (pid: number | null | undefined) => {
    if (pid == null) return null;
    if (cache.has(pid)) return cache.get(pid)!;
    let n = byId.get(pid);
    const seen = new Set<number>();
    while (n && n.level !== "city" && n.parentId != null && !seen.has(n.id)) { seen.add(n.id); n = byId.get(n.parentId); }
    const out = n && n.level === "city" ? { id: n.id, name: n.name } : null;
    cache.set(pid, out);
    return out;
  };
  return { cityOf, nodes };
}

// ─── Duplicados ─────────────────────────────────────────────────────────────

/** Ocorrência já existente (±2h, mesma matrícula, reserva compatível). */
export async function findDuplicateIncident(s: { plate?: string | null; bookingRef?: string | null; atUtc?: string | null }): Promise<{ id: number } | null> {
  const plate = (s.plate ?? "").replace(/[\s.\-]/g, "").toUpperCase();
  const atMs = parseUtc(s.atUtc ?? null);
  if (!plate || atMs == null) return null;
  const d = await db();
  const from = utcNowStr(new Date(atMs - 3 * 3_600_000));
  const to = utcNowStr(new Date(atMs + 3 * 3_600_000));
  const cands = rowsOf(await d.execute(sql`
    SELECT id, vehiclePlate, reservationLink, COALESCE(sourceEmailDate, createdAt) AS at
    FROM incidents
    WHERE UPPER(REPLACE(REPLACE(REPLACE(vehiclePlate, ' ', ''), '-', ''), '.', '')) = ${plate}
      AND status <> 'converted'
      AND COALESCE(sourceEmailDate, createdAt) >= ${from} AND COALESCE(sourceEmailDate, createdAt) <= ${to}
    ORDER BY id ASC LIMIT 10`));
  for (const c of cands) {
    const at = c.at instanceof Date ? c.at.getTime() : parseUtc(String(c.at));
    if (isDuplicateIncident({ plate, bookingRef: s.bookingRef ?? null, atMs }, { plate: c.vehiclePlate, bookingRef: c.reservationLink, atMs: at })) {
      return { id: Number(c.id) };
    }
  }
  return null;
}

/** Nota datada acrescentada às notas/resolução da ocorrência. */
export async function appendIncidentNote(id: number, author: string, text: string): Promise<void> {
  const d = await db();
  const [inc] = await d.select({ resolution: incidents.resolution }).from(incidents).where(eq(incidents.id, id)).limit(1);
  if (!inc) return;
  const stamp = new Date().toLocaleString("pt-PT", { timeZone: "Europe/Lisbon", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const line = `[${stamp} — ${author}] ${text.trim()}`.slice(0, 4000);
  await d.update(incidents).set({ resolution: inc.resolution ? `${inc.resolution}\n${line}` : line }).where(eq(incidents.id, id));
}

// ─── Cruzamento de condutores ───────────────────────────────────────────────

export interface CrossRefLinkRow extends CrossRefLink {
  caseDescription: string | null;
  caseStatus: string;
  caseCreatedAt: string;
  casePlate: string | null;
  bookingRef: string | null;
  changeType: string | null;
  actionTime: string | null;
  parkName: string | null;
  employeeName: string | null;
}

const AGENT_MAP = sql`(SELECT multiparkAgentName AS n, MIN(id) AS empId FROM employees
  WHERE multiparkAgentName IS NOT NULL AND multiparkAgentName <> '' GROUP BY multiparkAgentName)`;

const fmt = (v: any): string | null => (v == null ? null : v instanceof Date ? utcNowStr(v) : String(v));

/**
 * Ligações caso↔condutor para os casos que satisfazem `caseWhere` (alias `l`):
 * condutores ANEXADOS ao caso + agentes com ações no histórico da reserva do
 * caso. Uma só query (UNION ALL), agregação no JS (casos são poucos).
 */
async function fetchLinks(caseWhere: SQL): Promise<CrossRefLinkRow[]> {
  const d = await db();
  const rows = rowsOf(await d.execute(sql`
    SELECT x.caseId, x.via, x.employeeId, x.name, x.changeType, x.actionTime, x.parkName,
           l2.description AS caseDescription, l2.status AS caseStatus, l2.createdAt AS caseCreatedAt,
           l2.vehiclePlate AS casePlate, l2.bookingRef AS bookingRef, e.fullName AS employeeName
    FROM (
      SELECT l.id AS caseId, 'attached' AS via, COALESCE(ad.employeeId, am.empId) AS employeeId, ad.driverName AS name,
             NULL AS changeType, NULL AS actionTime, NULL AS parkName
      FROM lost_found_items l
      JOIN lost_found_attached_drivers ad ON ad.itemId = l.id
      LEFT JOIN ${AGENT_MAP} am ON am.n = ad.driverName
      WHERE ${caseWhere}
      UNION ALL
      SELECT l.id, 'movement', am.empId, h.agentName, h.changeType, h.actionTime, b.parkName
      FROM lost_found_items l
      JOIN multipark_booking_history h ON h.bookingExternalId = l.bookingRef
      LEFT JOIN multipark_bookings b ON b.externalId = h.bookingExternalId
      LEFT JOIN ${AGENT_MAP} am ON am.n = h.agentName
      WHERE ${caseWhere} AND l.bookingRef IS NOT NULL AND l.bookingRef <> ''
        AND h.agentName IS NOT NULL AND h.agentName <> ''
    ) x
    JOIN lost_found_items l2 ON l2.id = x.caseId
    LEFT JOIN employees e ON e.id = x.employeeId
    LIMIT 20000`));
  return rows.map((r) => ({
    caseId: Number(r.caseId),
    via: r.via === "attached" ? "attached" : "movement",
    employeeId: r.employeeId != null ? Number(r.employeeId) : null,
    name: r.employeeName || r.name || null,
    caseDescription: r.caseDescription ?? null,
    caseStatus: String(r.caseStatus ?? ""),
    caseCreatedAt: fmt(r.caseCreatedAt) ?? "",
    casePlate: r.casePlate ?? null,
    bookingRef: r.bookingRef ?? null,
    changeType: r.changeType ?? null,
    actionTime: fmt(r.actionTime),
    parkName: r.parkName ?? null,
    employeeName: r.employeeName ?? null,
  }));
}

export interface CrossRefInput extends CaseScopeFilter { from: string; to: string }

async function periodCaseWhere(input: CrossRefInput): Promise<{ where: SQL; start: string; end: string }> {
  const { start, end } = lisbonDayRangeUtc(input.from, input.to);
  const scope = await caseScopeSql(sql`l.projectId`, input);
  return { where: sql`l.status <> 'converted' AND l.createdAt >= ${start} AND l.createdAt < ${end} AND ${scope}`, start, end };
}

/** Ranking do Cruzamento de condutores (período + cidade). */
export async function getDriverCrossRef(input: CrossRefInput): Promise<{ rows: CrossRefRow[]; teamRate: number | null; totalCases: number; from: string; to: string }> {
  const d = await db();
  const { where, start, end } = await periodCaseWhere(input);
  const links = await fetchLinks(where);
  const bookingScope = await caseScopeSql(sql`b.projectId`, input.noProject ? {} : input);
  const incScope = await caseScopeSql(sql`i.projectId`, input);
  const cScope = await caseScopeSql(sql`c.projectId`, input);

  const movementTotals = rowsOf(await d.execute(sql`
    SELECT h.agentName, am.empId AS employeeId, COUNT(*) AS total,
           SUM(CASE WHEN cb.ref IS NOT NULL THEN 1 ELSE 0 END) AS inCase
    FROM multipark_booking_history h
    LEFT JOIN multipark_bookings b ON b.externalId = h.bookingExternalId
    LEFT JOIN (SELECT DISTINCT l.bookingRef AS ref FROM lost_found_items l
               WHERE ${where} AND l.bookingRef IS NOT NULL AND l.bookingRef <> '') cb ON cb.ref = h.bookingExternalId
    LEFT JOIN ${AGENT_MAP} am ON am.n = h.agentName
    WHERE h.actionTime >= ${start} AND h.actionTime < ${end}
      AND h.agentName IS NOT NULL AND h.agentName <> ''
      AND ${bookingScope}
    GROUP BY h.agentName, am.empId`)).map((r) => ({
    agentName: String(r.agentName), employeeId: r.employeeId != null ? Number(r.employeeId) : null,
    total: Number(r.total) || 0, inCase: Number(r.inCase) || 0,
  }));

  const incRows = rowsOf(await d.execute(sql`
    SELECT i.employeeId, COUNT(*) AS n FROM incidents i
    WHERE i.employeeId IS NOT NULL AND i.status NOT IN ('dismissed', 'converted')
      AND COALESCE(i.sourceEmailDate, i.createdAt) >= ${start} AND COALESCE(i.sourceEmailDate, i.createdAt) < ${end}
      AND ${incScope}
    GROUP BY i.employeeId`));
  const cRows = rowsOf(await d.execute(sql`
    SELECT cd.employeeId, COUNT(DISTINCT cd.complaintId) AS n
    FROM complaint_drivers_on_duty cd JOIN complaints c ON c.id = cd.complaintId
    WHERE cd.employeeId IS NOT NULL AND c.complaint_status <> 'converted'
      AND c.createdAt >= ${start} AND c.createdAt < ${end} AND ${cScope}
    GROUP BY cd.employeeId`));

  const out = buildDriverCrossRef({
    links,
    movementTotals,
    incidentsByEmployee: new Map(incRows.map((r) => [Number(r.employeeId), Number(r.n)])),
    complaintsByEmployee: new Map(cRows.map((r) => [Number(r.employeeId), Number(r.n)])),
  });
  return { ...out, from: input.from, to: input.to };
}

/** Drill-down: casos do condutor e os movimentos EXATOS nas reservas desses casos. */
export async function getDriverCrossRefDetail(input: CrossRefInput & { key: string }) {
  const { where } = await periodCaseWhere(input);
  const links = (await fetchLinks(where)).filter((l) => driverKey(l.employeeId, l.name) === input.key);
  const cases = new Map<number, { id: number; description: string | null; status: string; createdAt: string; plate: string | null; bookingRef: string | null; attached: boolean; movements: number }>();
  const movements: Array<{ caseId: number; actionTime: string | null; changeType: string | null; parkName: string | null; bookingRef: string | null }> = [];
  for (const l of links) {
    const c = cases.get(l.caseId) ?? { id: l.caseId, description: l.caseDescription, status: l.caseStatus, createdAt: l.caseCreatedAt, plate: l.casePlate, bookingRef: l.bookingRef, attached: false, movements: 0 };
    if (l.via === "attached") c.attached = true;
    else {
      c.movements++;
      movements.push({ caseId: l.caseId, actionTime: l.actionTime, changeType: l.changeType, parkName: l.parkName, bookingRef: l.bookingRef });
    }
    cases.set(l.caseId, c);
  }
  movements.sort((a, b) => String(b.actionTime ?? "").localeCompare(String(a.actionTime ?? "")));
  return { name: links[0]?.name ?? null, employeeId: links.find((l) => l.employeeId)?.employeeId ?? null, cases: Array.from(cases.values()).sort((a, b) => b.id - a.id), movements };
}

/**
 * Condutores deste caso que aparecem noutros casos ABERTOS ou recentes
 * (últimos 180 dias) — "aparece em N outros casos".
 */
export async function getCaseRepeatDrivers(itemId: number) {
  const since = utcNowStr(new Date(Date.now() - 180 * 86_400_000));
  const scope = await caseScopeSql(sql`l.projectId`);
  const links = await fetchLinks(sql`l.status <> 'converted' AND ${scope}
    AND (l.id = ${itemId} OR l.status IN ('new', 'investigating', 'found') OR l.createdAt >= ${since})`);
  return repeatDriversForCase(itemId, links);
}

// ─── Painel ─────────────────────────────────────────────────────────────────

async function repeatDriversTop5(f: CaseScopeFilter) {
  const to = new Date();
  const fromD = new Date(Date.now() - 90 * 86_400_000);
  const day = (x: Date) => x.toLocaleDateString("en-CA", { timeZone: "Europe/Lisbon" });
  const r = await getDriverCrossRef({ ...f, from: day(fromD), to: day(to) });
  return r.rows.filter((x) => x.caseCount >= 2).slice(0, 5).map((x) => ({ key: x.key, name: x.name, caseCount: x.caseCount, incidents: x.incidents, complaints: x.complaints }));
}

export async function getIncidentDashboard(f: CaseScopeFilter) {
  const d = await db();
  const scope = await caseScopeSql(sql`i.projectId`, f);
  const now = utcNowStr();
  const [agg] = rowsOf(await d.execute(sql`
    SELECT
      SUM(CASE WHEN i.status IN ('open','investigating') THEN 1 ELSE 0 END) AS openCount,
      SUM(CASE WHEN i.status IN ('open','investigating') AND i.createdAt >= DATE_SUB(${now}, INTERVAL 1 DAY) THEN 1 ELSE 0 END) AS lt1d,
      SUM(CASE WHEN i.status IN ('open','investigating') AND i.createdAt < DATE_SUB(${now}, INTERVAL 1 DAY) AND i.createdAt >= DATE_SUB(${now}, INTERVAL 3 DAY) THEN 1 ELSE 0 END) AS d1to3,
      SUM(CASE WHEN i.status IN ('open','investigating') AND i.createdAt < DATE_SUB(${now}, INTERVAL 3 DAY) AND i.createdAt >= DATE_SUB(${now}, INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS d3to7,
      SUM(CASE WHEN i.status IN ('open','investigating') AND i.createdAt < DATE_SUB(${now}, INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS gt7d,
      SUM(CASE WHEN i.status IN ('open','investigating') AND i.dueAt IS NOT NULL AND i.dueAt < ${now} THEN 1 ELSE 0 END) AS overdue,
      SUM(CASE WHEN i.projectId IS NULL AND i.status <> 'converted' THEN 1 ELSE 0 END) AS noCity,
      SUM(CASE WHEN i.employeeId IS NOT NULL AND i.driverConfirmed = 0 AND i.status NOT IN ('dismissed','converted') THEN 1 ELSE 0 END) AS unconfirmedDriver,
      AVG(CASE WHEN i.status = 'resolved' AND i.resolvedAt IS NOT NULL AND i.resolvedAt >= DATE_SUB(${now}, INTERVAL 90 DAY)
               THEN TIMESTAMPDIFF(MINUTE, i.createdAt, i.resolvedAt) END) AS avgResolveMin
    FROM incidents i WHERE ${scope}`));
  const byType = rowsOf(await d.execute(sql`
    SELECT i.incidentType AS k, COUNT(*) AS n FROM incidents i
    WHERE i.status IN ('open','investigating') AND ${scope} GROUP BY i.incidentType ORDER BY n DESC`));
  const byProject = rowsOf(await d.execute(sql`
    SELECT i.projectId AS pid, COUNT(*) AS n FROM incidents i
    WHERE i.status IN ('open','investigating') AND ${scope} GROUP BY i.projectId`));
  const { cityOf } = await projectCityMap();
  const byCity = new Map<string, number>();
  for (const r of byProject) {
    const c = cityOf(r.pid != null ? Number(r.pid) : null);
    const k = c?.name ?? "Sem cidade";
    byCity.set(k, (byCity.get(k) ?? 0) + Number(r.n));
  }
  return {
    open: Number(agg?.openCount ?? 0),
    ageBuckets: { lt1d: Number(agg?.lt1d ?? 0), d1to3: Number(agg?.d1to3 ?? 0), d3to7: Number(agg?.d3to7 ?? 0), gt7d: Number(agg?.gt7d ?? 0) },
    overdue: Number(agg?.overdue ?? 0),
    noCity: Number(agg?.noCity ?? 0),
    unconfirmedDriver: Number(agg?.unconfirmedDriver ?? 0),
    avgResolveHours: agg?.avgResolveMin != null ? Math.round(Number(agg.avgResolveMin) / 6) / 10 : null,
    byType: byType.map((r) => ({ key: String(r.k), label: INCIDENT_TYPE_LABEL[String(r.k)] ?? String(r.k), count: Number(r.n) })),
    byCity: Array.from(byCity.entries()).map(([city, count]) => ({ city, count })).sort((a, b) => b.count - a.count),
    repeatDrivers: await repeatDriversTop5(f).catch(() => []),
  };
}

export async function getLostDashboard(f: CaseScopeFilter) {
  const d = await db();
  const scope = await caseScopeSql(sql`l.projectId`, f);
  const now = utcNowStr();
  const due = sql`COALESCE(l.dueDate, DATE_ADD(l.createdAt, INTERVAL 7 DAY))`;
  const open = sql`l.status IN ('new','investigating','found')`;
  const [agg] = rowsOf(await d.execute(sql`
    SELECT
      SUM(CASE WHEN ${open} THEN 1 ELSE 0 END) AS openCount,
      SUM(CASE WHEN ${open} AND l.createdAt >= DATE_SUB(${now}, INTERVAL 1 DAY) THEN 1 ELSE 0 END) AS lt1d,
      SUM(CASE WHEN ${open} AND l.createdAt < DATE_SUB(${now}, INTERVAL 1 DAY) AND l.createdAt >= DATE_SUB(${now}, INTERVAL 3 DAY) THEN 1 ELSE 0 END) AS d1to3,
      SUM(CASE WHEN ${open} AND l.createdAt < DATE_SUB(${now}, INTERVAL 3 DAY) AND l.createdAt >= DATE_SUB(${now}, INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS d3to7,
      SUM(CASE WHEN ${open} AND l.createdAt < DATE_SUB(${now}, INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS gt7d,
      SUM(CASE WHEN ${open} AND ${due} < ${now} THEN 1 ELSE 0 END) AS overdue,
      SUM(CASE WHEN l.projectId IS NULL AND l.status <> 'converted' THEN 1 ELSE 0 END) AS noCity,
      AVG(CASE WHEN l.status IN ('returned','closed') AND l.closedAt IS NOT NULL AND l.closedAt >= DATE_SUB(${now}, INTERVAL 180 DAY)
               THEN TIMESTAMPDIFF(MINUTE, l.createdAt, l.closedAt) END) AS avgResolveMin
    FROM lost_found_items l WHERE ${scope}`));
  const byType = rowsOf(await d.execute(sql`
    SELECT l.itemType AS k, COUNT(*) AS n FROM lost_found_items l
    WHERE ${open} AND ${scope} GROUP BY l.itemType ORDER BY n DESC`));
  const byProject = rowsOf(await d.execute(sql`
    SELECT l.projectId AS pid, COUNT(*) AS n FROM lost_found_items l
    WHERE ${open} AND ${scope} GROUP BY l.projectId`));
  const { cityOf } = await projectCityMap();
  const byCity = new Map<string, number>();
  for (const r of byProject) {
    const c = cityOf(r.pid != null ? Number(r.pid) : null);
    const k = c?.name ?? "Sem cidade";
    byCity.set(k, (byCity.get(k) ?? 0) + Number(r.n));
  }
  const TYPE: Record<string, string> = { money: "Dinheiro", electronics: "Eletrónica", clothing: "Roupa", documents: "Documentos", accessories: "Acessórios", other: "Outro" };
  return {
    open: Number(agg?.openCount ?? 0),
    ageBuckets: { lt1d: Number(agg?.lt1d ?? 0), d1to3: Number(agg?.d1to3 ?? 0), d3to7: Number(agg?.d3to7 ?? 0), gt7d: Number(agg?.gt7d ?? 0) },
    overdue: Number(agg?.overdue ?? 0),
    noCity: Number(agg?.noCity ?? 0),
    unconfirmedDriver: 0,
    avgResolveHours: agg?.avgResolveMin != null ? Math.round(Number(agg.avgResolveMin) / 6) / 10 : null,
    byType: byType.map((r) => ({ key: String(r.k), label: TYPE[String(r.k)] ?? String(r.k), count: Number(r.n) })),
    byCity: Array.from(byCity.entries()).map(([city, count]) => ({ city, count })).sort((a, b) => b.count - a.count),
    repeatDrivers: await repeatDriversTop5(f).catch(() => []),
  };
}

// ─── Lembretes de SLA (cron horário) ────────────────────────────────────────

export interface CaseReminderReport { skipped?: string; incidents: number; lost: number; notified: number }

/**
 * Casos em atraso → UM resumo por destinatário por dia (assignee do caso +
 * team leaders/supervisores da cidade do caso; "Sem cidade" → só quem vê
 * todas as cidades). `lastReminderAt` garante 1×/dia por caso.
 */
export async function runCaseSlaReminders(now: Date, hour: number): Promise<CaseReminderReport> {
  const report: CaseReminderReport = { incidents: 0, lost: 0, notified: 0 };
  if (process.env.CASE_REMINDERS === "off") return { ...report, skipped: "CASE_REMINDERS=off" };
  if (!isCaseReminderHour(hour)) return { ...report, skipped: "fora de horas" };
  const d = await db();
  const nowStr = utcNowStr(now);
  const incRows = rowsOf(await d.execute(sql`
    SELECT id, projectId, lastReminderAt FROM incidents
    WHERE status IN ('open','investigating') AND dueAt IS NOT NULL AND dueAt < ${nowStr}
    ORDER BY dueAt ASC LIMIT 500`)).filter((r) => reminderDue(fmt(r.lastReminderAt), now));
  const lostRows = rowsOf(await d.execute(sql`
    SELECT id, projectId, assignedTo, lastReminderAt FROM lost_found_items
    WHERE status IN ('new','investigating','found') AND COALESCE(dueDate, DATE_ADD(createdAt, INTERVAL 7 DAY)) < ${nowStr}
    ORDER BY id ASC LIMIT 500`)).filter((r) => reminderDue(fmt(r.lastReminderAt), now));
  if (!incRows.length && !lostRows.length) return report;

  const { cityOf, nodes } = await projectCityMap();
  const leaders = await d.select({ userId: users.id, role: users.role, projectId: employees.projectId })
    .from(users).innerJoin(employees, eq(employees.userId, users.id))
    .where(and(eq(users.isActive, 1), inArray(users.role, ["team_leader", "supervisor"])));
  const leaderInfo = leaders.map((l) => {
    const acc = resolveCityAccess(l.projectId ?? null, nodes as any);
    return { userId: l.userId, all: acc.all, cityId: cityOf(l.projectId)?.id ?? null };
  });
  const recipientsFor = (projectId: number | null): number[] => {
    const city = cityOf(projectId);
    return leaderInfo.filter((l) => (city ? l.all || l.cityId === city.id : l.all)).map((l) => l.userId);
  };

  const digest = new Map<number, { inc: number[]; lost: number[] }>();
  const add = (uid: number, kind: "inc" | "lost", id: number) => {
    const e = digest.get(uid) ?? { inc: [], lost: [] };
    e[kind].push(id);
    digest.set(uid, e);
  };
  for (const r of incRows) for (const u of recipientsFor(r.projectId != null ? Number(r.projectId) : null)) add(u, "inc", Number(r.id));
  const assigneeIds = Array.from(new Set(lostRows.map((r) => Number(r.assignedTo)).filter(Boolean)));
  const assigneeUser = new Map<number, number>();
  if (assigneeIds.length) {
    const emps = await d.select({ id: employees.id, userId: employees.userId }).from(employees).where(inArray(employees.id, assigneeIds));
    for (const e of emps) if (e.userId) assigneeUser.set(e.id, e.userId);
  }
  for (const r of lostRows) {
    const set = new Set(recipientsFor(r.projectId != null ? Number(r.projectId) : null));
    const au = assigneeUser.get(Number(r.assignedTo));
    if (au) set.add(au);
    for (const u of Array.from(set)) add(u, "lost", Number(r.id));
  }

  const { createNotification } = await import("./complaintsExtended");
  for (const [userId, e] of Array.from(digest.entries())) {
    const parts: string[] = [];
    if (e.inc.length) parts.push(`${e.inc.length} ocorrência(s) (#${e.inc.slice(0, 5).join(", #")}${e.inc.length > 5 ? "…" : ""})`);
    if (e.lost.length) parts.push(`${e.lost.length} perdido(s) (#${e.lost.slice(0, 5).join(", #")}${e.lost.length > 5 ? "…" : ""})`);
    try {
      await createNotification({
        userId, kind: "case_sla", title: "Casos em atraso",
        body: `Fora do prazo: ${parts.join(" · ")}.`,
        link: e.lost.length && !e.inc.length ? "/perdidos-achados" : "/ocorrencias",
      });
      report.notified++;
    } catch { /* best-effort */ }
  }
  if (incRows.length) {
    await d.update(incidents).set({ lastReminderAt: nowStr }).where(inArray(incidents.id, incRows.map((r) => Number(r.id))));
  }
  if (lostRows.length) {
    await d.update(lostFoundItems).set({ lastReminderAt: nowStr }).where(inArray(lostFoundItems.id, lostRows.map((r) => Number(r.id))));
  }
  report.incidents = incRows.length;
  report.lost = lostRows.length;
  return report;
}

// ─── Conversões não destrutivas ─────────────────────────────────────────────

type Actor = { id: number; name?: string | null };

async function employeeName(id: number | null | undefined): Promise<string | null> {
  if (!id) return null;
  const d = await db();
  const [e] = await d.select({ fullName: employees.fullName }).from(employees).where(eq(employees.id, id)).limit(1);
  return e?.fullName ?? null;
}

export async function convertIncident(id: number, to: "complaint" | "lost", actor: Actor): Promise<{ newId: number }> {
  const d = await db();
  const [inc] = await d.select().from(incidents).where(eq(incidents.id, id)).limit(1);
  if (!inc) throw new Error("Ocorrência não encontrada");
  if (inc.status === "converted" && inc.convertedToId) throw new Error(`Já convertida (${inc.convertedToType} #${inc.convertedToId})`);
  const { createComplaint, addComplaintMessage, createLostFoundItem, addLostFoundMessage, attachLostFoundDriver } = await import("./db");
  const drvName = await employeeName(inc.employeeId);
  const noteLines = [
    `🚨 Convertida da Ocorrência #${id} (${INCIDENT_TYPE_LABEL[inc.incidentType] ?? inc.incidentType}, gravidade ${inc.severity}) por ${actor.name ?? "—"}.`,
    inc.resolution ? `Notas da ocorrência:\n${inc.resolution}` : null,
    inc.aiClassification ? `Classificação: ${inc.aiClassification}` : null,
    inc.costAmount ? `Custo registado: ${inc.costAmount}€` : null,
  ].filter(Boolean).join("\n\n");
  let newId: number;
  if (to === "complaint") {
    newId = await createComplaint({ ...incidentToComplaintFields(inc as any), createdById: actor.id } as any);
    await addComplaintMessage({ complaintId: newId, message: noteLines, isInternal: 1, authorId: actor.id, authorName: actor.name ?? null } as any);
    if (inc.employeeId && drvName) {
      await d.insert(complaintDriversOnDuty).values({ complaintId: newId, employeeId: inc.employeeId, employeeName: drvName.slice(0, 256), source: "incident", penaltyPointsApplied: 0, notes: `Da ocorrência #${id}${inc.driverConfirmed ? " (envolvimento confirmado)" : ""}` });
    }
    try { const { autoLinkComplaintBooking } = await import("./complaintDossier"); await autoLinkComplaintBooking(newId); } catch { /* best-effort */ }
  } else {
    const created = await createLostFoundItem({ ...incidentToLostFields(inc as any), createdBy: actor.id } as any);
    if (!created) throw new Error("Falha a criar o registo nos Perdidos");
    newId = created;
    await addLostFoundMessage({ itemId: newId, userId: actor.id, userName: actor.name ?? "—", message: noteLines, isInternal: 1 } as any);
    if (inc.employeeId && drvName) {
      await attachLostFoundDriver({ itemId: newId, employeeId: inc.employeeId, driverName: drvName, source: "incident", notes: `Da ocorrência #${id}`, attachedById: actor.id });
    }
    try { const { autoLinkLostFoundBooking } = await import("./complaintDossier"); await autoLinkLostFoundBooking(newId); } catch { /* best-effort */ }
  }
  const nowStr = utcNowStr();
  await d.update(incidents).set({
    status: "converted", ...convertedOriginPatch(to, newId),
    resolvedAt: inc.resolvedAt ?? nowStr, resolvedBy: inc.resolvedBy ?? actor.id,
  }).where(eq(incidents.id, id));
  await appendIncidentNote(id, actor.name ?? "—", `Convertida em ${to === "complaint" ? "Reclamação" : "Perdido"} #${newId}.`);
  return { newId };
}

export async function convertLostToComplaint(id: number, actor: Actor): Promise<{ newId: number }> {
  const d = await db();
  const [item] = await d.select().from(lostFoundItems).where(eq(lostFoundItems.id, id)).limit(1);
  if (!item) throw new Error("Caso não encontrado");
  if (item.status === "converted" && item.convertedToId) throw new Error(`Já convertido (${item.convertedToType} #${item.convertedToId})`);
  const { createComplaint, addComplaintMessage, addComplaintPhoto, getLostFoundMessages, getLostFoundPhotos, listLostFoundDrivers, addLostFoundMessage } = await import("./db");
  const [messages, photos, drivers] = await Promise.all([getLostFoundMessages(id), getLostFoundPhotos(id), listLostFoundDrivers(id)]);
  const newId = await createComplaint({ ...lostToComplaintFields(item as any), createdById: actor.id } as any);
  for (const m of messages as any[]) {
    try { await addComplaintMessage({ complaintId: newId, message: m.message, isInternal: m.isInternal, authorId: m.userId ?? actor.id, authorName: m.userName ?? null } as any); } catch { /* best-effort */ }
  }
  for (const p of photos as any[]) {
    try { await addComplaintPhoto({ complaintId: newId, url: String(p.url).slice(0, 500), fileKey: String(p.fileKey).slice(0, 500), label: p.caption ?? null, uploadedById: actor.id } as any); } catch { /* best-effort */ }
  }
  for (const dr of drivers as any[]) {
    try {
      await d.insert(complaintDriversOnDuty).values({ complaintId: newId, employeeId: dr.employeeId ?? null, employeeName: String(dr.driverName).slice(0, 256), source: "lost_found", penaltyPointsApplied: 0, notes: [dr.movementsSummary, dr.notes, `do perdido #${id}`].filter(Boolean).join(" · ").slice(0, 512) });
    } catch { /* best-effort */ }
  }
  await addComplaintMessage({ complaintId: newId, message: `📦 Convertido do Perdido #${id} por ${actor.name ?? "—"} (o caso original fica fechado e ligado).`, isInternal: 1, authorId: actor.id, authorName: actor.name ?? null } as any);
  try { const { autoLinkComplaintBooking } = await import("./complaintDossier"); await autoLinkComplaintBooking(newId); } catch { /* best-effort */ }
  const nowStr = utcNowStr();
  await d.update(lostFoundItems).set({ status: "converted", ...convertedOriginPatch("complaint", newId), closedAt: item.closedAt ?? nowStr, closedById: item.closedById ?? actor.id }).where(eq(lostFoundItems.id, id));
  await addLostFoundMessage({ itemId: id, userId: actor.id, userName: actor.name ?? "—", message: `➡️ Convertido na Reclamação #${newId}.`, isInternal: 1 } as any);
  return { newId };
}

export async function convertComplaintToLost(id: number, actor: Actor): Promise<{ newId: number }> {
  const d = await db();
  const [c] = await d.select().from(complaints).where(eq(complaints.id, id)).limit(1);
  if (!c) throw new Error("Reclamação não encontrada");
  if (c.complaintStatus === "converted" && c.convertedToId) throw new Error(`Já convertida (${c.convertedToType} #${c.convertedToId})`);
  const { createLostFoundItem, addLostFoundMessage, addLostFoundPhoto, getComplaintMessages, getComplaintPhotos, addComplaintMessage, attachLostFoundDriver } = await import("./db");
  const [messages, photos] = await Promise.all([getComplaintMessages(id), getComplaintPhotos(id)]);
  const drivers = await d.select().from(complaintDriversOnDuty).where(eq(complaintDriversOnDuty.complaintId, id));
  const created = await createLostFoundItem({ ...complaintToLostFields(c as any), createdBy: actor.id } as any);
  if (!created) throw new Error("Falha a criar o registo nos Perdidos");
  const newId = created;
  for (const m of messages as any[]) {
    try { await addLostFoundMessage({ itemId: newId, userId: m.authorId ?? actor.id, userName: m.authorName ?? "—", message: m.message, isInternal: m.isInternal } as any); } catch { /* best-effort */ }
  }
  for (const p of photos as any[]) {
    try { await addLostFoundPhoto({ itemId: newId, url: p.url, fileKey: p.fileKey, caption: p.label ?? null } as any); } catch { /* best-effort */ }
  }
  for (const dr of drivers) {
    try { await attachLostFoundDriver({ itemId: newId, employeeId: dr.employeeId ?? null, driverName: dr.employeeName, source: "complaint", notes: `da reclamação #${id}${dr.notes ? ` · ${dr.notes}` : ""}`.slice(0, 512), attachedById: actor.id }); } catch { /* best-effort */ }
  }
  await addLostFoundMessage({ itemId: newId, userId: actor.id, userName: actor.name ?? "—", message: `📦 Convertido da Reclamação #${id} por ${actor.name ?? "—"} (a reclamação fica fechada e ligada).`, isInternal: 1 } as any);
  const nowStr = utcNowStr();
  await d.update(complaints).set({ complaintStatus: "converted", ...convertedOriginPatch("lost", newId), closedAt: c.closedAt ?? nowStr, closedById: c.closedById ?? actor.id }).where(eq(complaints.id, id));
  await addComplaintMessage({ complaintId: id, message: `➡️ Convertida no Perdido #${newId}.`, isInternal: 1, authorId: actor.id, authorName: actor.name ?? null } as any);
  return { newId };
}

// ─── Responsabilização (custo + pontos) ─────────────────────────────────────

/**
 * Custo/pontos num condutor ligado a um caso de Perdidos. Pontos > 0 criam
 * (ou atualizam) uma penalização RH `lost_found_investigation` PENDENTE — só
 * conta depois de um supervisor a confirmar. Pontos 0 anulam a pendente.
 */
export async function setLostDriverAccountability(linkId: number, patch: { costAmount?: number | null; points?: number }, actorId: number) {
  const d = await db();
  const [link] = await d.select().from(lostFoundAttachedDrivers).where(eq(lostFoundAttachedDrivers.id, linkId)).limit(1);
  if (!link) throw new Error("Ligação não encontrada");
  const upd: any = {};
  if (patch.costAmount !== undefined) upd.costAmount = patch.costAmount == null ? null : String(patch.costAmount);
  if (patch.points !== undefined) {
    const pts = Math.max(0, Math.min(20, Math.trunc(patch.points)));
    upd.points = pts;
    const { employeePenalties } = await import("../drizzle/schema");
    let empId = link.employeeId;
    if (!empId && pts > 0) {
      const [e] = await d.select({ id: employees.id }).from(employees).where(eq(employees.multiparkAgentName, link.driverName)).limit(1);
      empId = e?.id ?? null;
      if (empId) upd.employeeId = empId;
    }
    if (pts > 0 && !empId) throw new Error("Este condutor não está associado a um colaborador — anexa-o pelo colaborador para lhe atribuir pontos.");
    if (empId) {
      const [existing] = await d.select().from(employeePenalties)
        .where(and(eq(employeePenalties.employeeId, empId), eq(employeePenalties.reason, "lost_found_investigation"), eq(employeePenalties.relatedId, link.itemId))).limit(1);
      if (pts > 0) {
        if (existing) {
          if (existing.status === "confirmed" && existing.points !== pts) throw new Error("Pontos já confirmados por um supervisor — alterações só no RH.");
          await d.update(employeePenalties).set({ points: pts, status: existing.status === "dismissed" ? "pending" : existing.status, clearedAt: existing.status === "dismissed" ? null : existing.clearedAt }).where(eq(employeePenalties.id, existing.id));
          upd.penaltyId = existing.id;
        } else {
          const r = await d.insert(employeePenalties).values({
            employeeId: empId, reason: "lost_found_investigation", severity: "penalty", points: pts,
            relatedId: link.itemId, notes: `Perdido #${link.itemId} (proposto por user #${actorId})`, status: "pending",
          });
          upd.penaltyId = Number((r[0] as any).insertId);
        }
        upd.pointsConfirmed = existing?.status === "confirmed" ? 1 : 0;
      } else if (existing && existing.status === "pending") {
        await d.update(employeePenalties).set({ status: "dismissed", reviewedById: actorId, reviewedAt: utcNowStr(), clearedAt: utcNowStr(), clearedById: actorId }).where(eq(employeePenalties.id, existing.id));
        upd.pointsConfirmed = 0;
      }
    }
  }
  if (Object.keys(upd).length) await d.update(lostFoundAttachedDrivers).set(upd).where(eq(lostFoundAttachedDrivers.id, linkId));
  return { ok: true };
}

/** Supervisor+: confirma/anula os pontos (usa o mesmo fluxo de revisão do RH). */
export async function reviewLostDriverPoints(linkId: number, decision: "confirmed" | "dismissed", reviewerId: number) {
  const d = await db();
  const [link] = await d.select().from(lostFoundAttachedDrivers).where(eq(lostFoundAttachedDrivers.id, linkId)).limit(1);
  if (!link?.penaltyId) throw new Error("Sem penalização proposta para este condutor");
  const { reviewPenalty } = await import("./rhService");
  const r = await reviewPenalty(link.penaltyId, decision, reviewerId, `Perdido #${link.itemId}`);
  await d.update(lostFoundAttachedDrivers).set({ pointsConfirmed: decision === "confirmed" ? 1 : 0, ...(decision === "dismissed" ? { points: 0 } : {}) }).where(eq(lostFoundAttachedDrivers.id, linkId));
  return r;
}

// ─── Ficheiros ──────────────────────────────────────────────────────────────

/** URL de leitura assinada (S3) ou a URL existente noutros backends. */
export async function signedFileUrl(key: string | null | undefined, url: string | null | undefined): Promise<string | null> {
  const src = key || url;
  if (!src) return null;
  try {
    const { storagePresignGet } = await import("./storage");
    const out = await storagePresignGet(src, { fallbackUrl: url ?? null, expiresSeconds: 900 });
    if (out.url) return out.url;
  } catch { /* cai no fallback */ }
  if (url && /^https?:\/\//.test(url)) return url;
  return key ? `/api/file/${encodeURI(key)}` : url ?? null;
}

/** Apaga o caso E os ficheiros (fotos + foto da entrega), mensagens e condutores. */
export async function deleteLostCaseFully(id: number): Promise<void> {
  const d = await db();
  const [item] = await d.select({ returnPhotoKey: lostFoundItems.returnPhotoKey, returnPhotoUrl: lostFoundItems.returnPhotoUrl }).from(lostFoundItems).where(eq(lostFoundItems.id, id)).limit(1);
  const photos = await d.select({ fileKey: lostFoundPhotos.fileKey, url: lostFoundPhotos.url }).from(lostFoundPhotos).where(eq(lostFoundPhotos.itemId, id));
  const { storageDelete } = await import("./storage");
  // Fotos copiadas de/para reclamações partilham a key — só apaga ficheiros que
  // nenhuma reclamação ainda referencia.
  const { complaintPhotos } = await import("../drizzle/schema");
  const keys = photos.map((p) => p.fileKey || p.url).filter(Boolean) as string[];
  const shared = keys.length
    ? new Set((await d.select({ k: complaintPhotos.fileKey }).from(complaintPhotos).where(inArray(complaintPhotos.fileKey, keys))).map((r) => r.k))
    : new Set<string>();
  for (const k of keys) if (!shared.has(k)) await storageDelete(k);
  if (item?.returnPhotoKey || item?.returnPhotoUrl) await storageDelete(item.returnPhotoKey || item.returnPhotoUrl);
  await d.delete(lostFoundPhotos).where(eq(lostFoundPhotos.itemId, id));
  await d.delete(lostFoundMessages).where(eq(lostFoundMessages.itemId, id));
  await d.delete(lostFoundAttachedDrivers).where(eq(lostFoundAttachedDrivers.itemId, id));
  await d.delete(lostFoundItems).where(eq(lostFoundItems.id, id));
}

