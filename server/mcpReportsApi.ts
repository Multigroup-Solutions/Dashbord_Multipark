/**
 * MCP Control API — rotas de RELATÓRIOS (SÓ LEITURA), para a skill `multipark-relatorios`.
 *
 * Montadas por `server/mcpApi.ts` em /api/v1 (mesma autenticação X-API-Key e o
 * mesmo scope "read" das restantes rotas de leitura). Nada aqui escreve na BD:
 * não há INSERT/UPDATE/DELETE e a caixa nunca é contada nem fechada por aqui
 * (isso continua a ser feito no ecrã "Correção de caixa", com autor e explicação).
 *
 *   GET /cash/counts?from&to[&parkId][&city]   contagens de caixa por parque e dia + totais
 *   GET /cash/counts/:parkId/:day              uma contagem: gastos e cada versão (quem e quando)
 *   GET /cash/cases?view&severity&code&parkId&day&limit&offset   fila da "Correção de caixa"
 *   GET /cash/cases/:id                        um caso com a linha do tempo (quem mexeu, quem fechou)
 *   GET /drivers/daily?from&to[&employeeId]    condutores: horas, km, velocidades, bateria + resumo
 *   GET /partners/billing?from&to[&partnerType][&projectId]   a faturar por parceiro
 *   GET /partners/close?month=AAAA-MM          Fecho de parceiros do mês
 *   GET /shift-handovers?from&to[&city]        passagens de turno (caixa no cofre, bolsas, gastos)
 */
import type { Router, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { requireScope } from "./apiKeyAuth";

type Handler = (fn: (req: Request, res: Response) => Promise<any>) => (req: Request, res: Response) => void;
type Db = { execute: (q: any) => Promise<any> };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const MAX_RANGE_DAYS = 366;

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
export const r2 = (v: unknown): number => Math.round((Number(v) || 0) * 100) / 100;
const DT = (c: string) => sql.raw(`DATE_FORMAT(${c}, '%Y-%m-%d %H:%i:%s')`);
const DAYF = (c: string) => sql.raw(`DATE_FORMAT(${c}, '%Y-%m-%d')`);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

async function database(): Promise<Db> {
  const { getDb } = await import("./db");
  const d = await getDb();
  if (!d) throw new Error("BD indisponível");
  return d as unknown as Db;
}

// ─── Puras (testadas em mcpReportsApi.test.ts) ──────────────────────────────

/** Intervalo AAAA-MM-DD a AAAA-MM-DD: os dois obrigatórios, ordenados e com no máximo 366 dias. */
export function parseRange(from: unknown, to: unknown): { from: string; to: string } | { error: string } {
  const f = str(from);
  const t = str(to);
  if (!f || !t) return { error: "from e to (AAAA-MM-DD) são obrigatórios" };
  if (!DAY_RE.test(f) || !DAY_RE.test(t)) return { error: "from e to têm de ser AAAA-MM-DD" };
  const fm = Date.parse(`${f}T00:00:00Z`);
  const tm = Date.parse(`${t}T00:00:00Z`);
  if (!Number.isFinite(fm) || !Number.isFinite(tm)) return { error: "Data inválida" };
  if (fm > tm) return { error: "from tem de ser anterior ou igual a to" };
  if ((tm - fm) / 86_400_000 + 1 > MAX_RANGE_DAYS) return { error: `Intervalo máximo: ${MAX_RANGE_DAYS} dias` };
  return { from: f, to: t };
}

export interface CountRow {
  parkId: string; parkName: string | null; city: string | null; day: string;
  receivedCash: number; expensesCash: number; expectedCash: number; countedAmount: number; difference: number;
}
export interface CountTotals {
  received: number; expenses: number; expected: number; counted: number; difference: number;
  counts: number; countsWithDifference: number; daysWithDifference: number;
}

const hasDiff = (v: number) => Math.abs(v) >= 0.005;

function addTotals(t: CountTotals, r: CountRow): void {
  t.received = r2(t.received + r.receivedCash);
  t.expenses = r2(t.expenses + r.expensesCash);
  t.expected = r2(t.expected + r.expectedCash);
  t.counted = r2(t.counted + r.countedAmount);
  t.difference = r2(t.difference + r.difference);
  t.counts += 1;
  if (hasDiff(r.difference)) t.countsWithDifference += 1;
}
const emptyTotals = (): CountTotals => ({ received: 0, expenses: 0, expected: 0, counted: 0, difference: 0, counts: 0, countsWithDifference: 0, daysWithDifference: 0 });

/** Totais do período, por dia e por cidade. `difference` = contado − previsto (previsto = recebido em dinheiro − gastos). */
export function summarizeCounts(rows: readonly CountRow[]): { total: CountTotals; byDay: Array<CountTotals & { day: string }>; byCity: Array<CountTotals & { city: string }> } {
  const total = emptyTotals();
  const days = new Map<string, CountTotals>();
  const cities = new Map<string, CountTotals>();
  for (const r of rows) {
    addTotals(total, r);
    addTotals(days.get(r.day) ?? days.set(r.day, emptyTotals()).get(r.day)!, r);
    const c = r.city ?? "(sem cidade)";
    addTotals(cities.get(c) ?? cities.set(c, emptyTotals()).get(c)!, r);
  }
  for (const t of days.values()) t.daysWithDifference = hasDiff(t.difference) ? 1 : 0;
  total.daysWithDifference = [...days.values()].filter((t) => hasDiff(t.difference)).length;
  // dia com diferença numa cidade = soma das diferenças dos parques dessa cidade nesse dia
  const cityDay = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.city ?? "(sem cidade)"}|${r.day}`;
    cityDay.set(k, (cityDay.get(k) ?? 0) + r.difference);
  }
  for (const [k, v] of cityDay) {
    if (hasDiff(v)) cities.get(k.slice(0, k.lastIndexOf("|")))!.daysWithDifference += 1;
  }
  return {
    total,
    byDay: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, t]) => ({ day, ...t })),
    byCity: [...cities.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([city, t]) => ({ city, ...t })),
  };
}

export interface DriverDayRow {
  key: string; employeeId: number | null; name: string; day: string; collectionPass: string;
  totalKm: number; hoursWorked: number; hoursStopped: number; totalHoursOnline: number;
  avgSpeed: number; maxSpeed: number; speedViolations: number; avgBattery: number; minBattery: number;
}

/** Uma linha por condutor e dia: a recolha 'final' (D-2) vale mais do que a provisória do próprio dia. PURA. */
export function dedupeDriverDays(rows: readonly DriverDayRow[]): DriverDayRow[] {
  const best = new Map<string, DriverDayRow>();
  for (const r of rows) {
    const k = `${r.key}|${r.day}`;
    const cur = best.get(k);
    if (!cur || (cur.collectionPass !== "final" && r.collectionPass === "final")) best.set(k, r);
  }
  return [...best.values()].sort((a, b) => a.day.localeCompare(b.day) || a.name.localeCompare(b.name));
}

/** Resumo por condutor no período. PURA. */
export function summarizeDrivers(rows: readonly DriverDayRow[]) {
  const by = new Map<string, { key: string; employeeId: number | null; name: string; days: number; totalKm: number; hoursWorked: number; hoursStopped: number; speedSum: number; speedDays: number; maxSpeed: number; speedViolations: number; minBattery: number | null }>();
  for (const r of rows) {
    const cur = by.get(r.key) ?? { key: r.key, employeeId: r.employeeId, name: r.name, days: 0, totalKm: 0, hoursWorked: 0, hoursStopped: 0, speedSum: 0, speedDays: 0, maxSpeed: 0, speedViolations: 0, minBattery: null as number | null };
    cur.days += 1;
    cur.totalKm += r.totalKm;
    cur.hoursWorked += r.hoursWorked;
    cur.hoursStopped += r.hoursStopped;
    if (r.avgSpeed > 0) { cur.speedSum += r.avgSpeed; cur.speedDays += 1; }
    cur.maxSpeed = Math.max(cur.maxSpeed, r.maxSpeed);
    cur.speedViolations += r.speedViolations;
    if (r.minBattery > 0) cur.minBattery = cur.minBattery == null ? r.minBattery : Math.min(cur.minBattery, r.minBattery);
    by.set(r.key, cur);
  }
  return [...by.values()].map((c) => ({
    key: c.key, employeeId: c.employeeId, name: c.name, days: c.days,
    totalKm: r2(c.totalKm), hoursWorked: r2(c.hoursWorked), hoursStopped: r2(c.hoursStopped),
    avgHoursPerDay: c.days ? r2(c.hoursWorked / c.days) : 0,
    kmPerHour: c.hoursWorked > 0 ? r2(c.totalKm / c.hoursWorked) : null,
    avgSpeed: c.speedDays ? r2(c.speedSum / c.speedDays) : 0,
    maxSpeed: r2(c.maxSpeed), speedViolations: c.speedViolations, minBattery: c.minBattery,
  })).sort((a, b) => b.hoursWorked - a.hoursWorked);
}

// ─── Leituras ───────────────────────────────────────────────────────────────

async function parkNames(): Promise<Map<string, { name: string | null; city: string | null }>> {
  try {
    const { loadLiveContext } = await import("./finance/liveBookings");
    const ctx: any = await loadLiveContext();
    const out = new Map<string, { name: string | null; city: string | null }>();
    for (const [id, p] of (ctx.parkInfo ?? new Map()).entries()) out.set(String(id), { name: p?.name ?? null, city: p?.city ? String(p.city).toLowerCase() : null });
    return out;
  } catch {
    return new Map();
  }
}

export function registerMcpReportRoutes(r: Router, h: Handler): void {
  // ── CAIXA: contagens por parque e dia ─────────────────────────────────────
  r.get("/cash/counts", requireScope("read"), h(async (req, res) => {
    const rg = parseRange(req.query.from, req.query.to);
    if ("error" in rg) return res.status(400).json({ success: false, error: rg.error });
    const parkId = str(req.query.parkId);
    const city = str(req.query.city)?.toLowerCase();
    const d = await database();
    const conds = [sql`c.day >= ${rg.from}`, sql`c.day <= ${rg.to}`];
    if (parkId) conds.push(sql`c.parkId = ${parkId}`);
    const raw = rowsOf(await d.execute(sql`SELECT c.id, c.parkId, c.projectId, ${DAYF("c.day")} AS day, c.shift, c.receivedCash, c.expensesCash, c.expectedCash,
        c.countedAmount, c.difference, c.note, ${DT("c.countedAt")} AS countedAt, u.name AS countedBy,
        (SELECT COUNT(*) FROM cash_count_log l WHERE l.countId = c.id) AS versions
      FROM cash_counts c LEFT JOIN users u ON u.id = c.countedBy
      WHERE ${sql.join(conds, sql` AND `)} ORDER BY c.day, c.parkId LIMIT 5000`));
    const names = await parkNames();
    const warnings: string[] = [];
    if (!names.size) warnings.push("Nomes e cidades dos parques indisponíveis (BD da Multipark sem resposta): só há ids de parque.");
    let rows = raw.map((x) => {
      const p = names.get(String(x.parkId));
      return {
        id: Number(x.id), parkId: String(x.parkId), parkName: p?.name ?? null, city: p?.city ?? null, projectId: x.projectId == null ? null : Number(x.projectId),
        day: String(x.day), shift: String(x.shift), receivedCash: r2(x.receivedCash), expensesCash: r2(x.expensesCash), expectedCash: r2(x.expectedCash),
        countedAmount: r2(x.countedAmount), difference: r2(x.difference), note: x.note ?? null, countedAt: x.countedAt ?? null, countedBy: x.countedBy ?? null, versions: Number(x.versions ?? 0),
      };
    });
    if (city) {
      if (!names.size) warnings.push("Filtro por cidade ignorado: sem cidades dos parques.");
      else rows = rows.filter((x) => x.city === city);
    }
    const s = summarizeCounts(rows);
    res.json({
      success: true, from: rg.from, to: rg.to, count: rows.length, truncated: raw.length >= 5000,
      definition: "difference = contado − previsto; previsto = recebido em dinheiro (Multipark) − gastos pagos da caixa. Só há linha nos dias em que alguém contou a caixa.",
      warnings, totals: s.total, byDay: s.byDay, byCity: s.byCity, rows,
    });
  }));

  r.get("/cash/counts/:parkId/:day", requireScope("read"), h(async (req, res) => {
    const parkId = String(req.params.parkId);
    const day = String(req.params.day);
    if (!DAY_RE.test(day)) return res.status(400).json({ success: false, error: "day tem de ser AAAA-MM-DD" });
    const d = await database();
    const count = rowsOf(await d.execute(sql`SELECT c.*, ${DT("c.countedAt")} AS countedAtS, u.name AS byName FROM cash_counts c LEFT JOIN users u ON u.id = c.countedBy
      WHERE c.parkId = ${parkId} AND c.day = ${day} AND c.shift = 'dia' LIMIT 1`))[0];
    if (!count) return res.status(404).json({ success: false, error: "Sem contagem de caixa para esse parque e dia" });
    const expenses = rowsOf(await d.execute(sql`SELECT id, description, amount, receipt FROM cash_count_expenses WHERE countId = ${count.id} ORDER BY id`));
    const log = rowsOf(await d.execute(sql`SELECT ${DT("l.at")} AS at, l.dataJson, u.name AS byName FROM cash_count_log l LEFT JOIN users u ON u.id = l.userId
      WHERE l.countId = ${count.id} ORDER BY l.at DESC, l.id DESC LIMIT 50`));
    const names = await parkNames();
    res.json({
      success: true, parkId, parkName: names.get(parkId)?.name ?? null, city: names.get(parkId)?.city ?? null, day,
      count: {
        id: Number(count.id), received: r2(count.receivedCash), expenses: r2(count.expensesCash), expected: r2(count.expectedCash), counted: r2(count.countedAmount),
        difference: r2(count.difference), note: count.note ?? null, countedAt: count.countedAtS, byName: count.byName ?? null,
      },
      expenses: expenses.map((e) => ({ id: Number(e.id), description: String(e.description), amount: r2(e.amount), receipt: e.receipt ?? null })),
      versions: log.map((l) => {
        let data: any = null;
        try { data = JSON.parse(String(l.dataJson)); } catch { data = null; }
        return { at: l.at, byName: l.byName ?? null, counted: data?.counted ?? null, expected: data?.expected ?? null, difference: data?.difference ?? null, note: data?.note ?? null };
      }),
    });
  }));

  // ── CAIXA: casos da "Correção de caixa" ───────────────────────────────────
  r.get("/cash/cases", requireScope("read"), h(async (req, res) => {
    const view = str(req.query.view) ?? "abertos";
    if (!["abertos", "fechados", "todos"].includes(view)) return res.status(400).json({ success: false, error: "view: abertos | fechados | todos" });
    const severity = str(req.query.severity);
    if (severity && !["critical", "high", "medium"].includes(severity)) return res.status(400).json({ success: false, error: "severity: critical | high | medium" });
    const day = str(req.query.day);
    if (day && !DAY_RE.test(day)) return res.status(400).json({ success: false, error: "day tem de ser AAAA-MM-DD" });
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 10), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const d = await database();
    const conds = [view === "abertos" ? sql`c.state IN ('aberto', 'em_analise')` : view === "fechados" ? sql`c.state NOT IN ('aberto', 'em_analise')` : sql`1 = 1`];
    if (severity) conds.push(sql`c.severity = ${severity}`);
    if (str(req.query.code)) conds.push(sql`c.code = ${String(req.query.code).slice(0, 40)}`);
    if (str(req.query.parkId)) conds.push(sql`c.parkId = ${String(req.query.parkId)}`);
    if (day) conds.push(sql`c.day = ${day}`);
    const where = sql.join(conds, sql` AND `);
    const sev = sql.raw(`CASE c.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END`);
    const [rows, total, counts] = await Promise.all([
      d.execute(sql`SELECT c.id, c.subjectType, c.subjectId, c.code, c.ruleRef, c.label, c.severity, c.state, c.detail, c.parkId, c.bookingCode,
          ${DAYF("c.day")} AS day, ${DT("c.openedAt")} AS openedAt, ${DT("c.lastSeenAt")} AS lastSeenAt, ${DT("c.closedAt")} AS closedAt,
          c.closeReason, c.explanation, c.reopenCount, u.name AS closedByName
        FROM cash_cases c LEFT JOIN users u ON u.id = c.closedBy WHERE ${where} ORDER BY ${sev} DESC, c.lastSeenAt DESC, c.id DESC LIMIT ${limit} OFFSET ${offset}`),
      d.execute(sql`SELECT COUNT(*) AS n FROM cash_cases c WHERE ${where}`),
      d.execute(sql`SELECT c.state, c.severity, COUNT(*) AS n FROM cash_cases c GROUP BY c.state, c.severity`),
    ]);
    const names = await parkNames();
    const byState: Record<string, number> = {};
    const openBySeverity: Record<string, number> = {};
    for (const x of rowsOf(counts)) {
      byState[String(x.state)] = (byState[String(x.state)] ?? 0) + Number(x.n);
      if (x.state === "aberto" || x.state === "em_analise") openBySeverity[String(x.severity)] = (openBySeverity[String(x.severity)] ?? 0) + Number(x.n);
    }
    res.json({
      success: true, view, limit, offset, total: Number(rowsOf(total)[0]?.n ?? 0), byState, openBySeverity,
      data: rowsOf(rows).map((x) => ({
        id: Number(x.id), subjectType: String(x.subjectType), subjectId: String(x.subjectId), code: String(x.code), rule: x.ruleRef ?? null, label: String(x.label),
        severity: String(x.severity), state: String(x.state), detail: x.detail ?? null, parkId: x.parkId ?? null, parkName: x.parkId ? names.get(String(x.parkId))?.name ?? null : null,
        city: x.parkId ? names.get(String(x.parkId))?.city ?? null : null, bookingCode: x.bookingCode ?? null, day: x.day ?? null, openedAt: x.openedAt, lastSeenAt: x.lastSeenAt,
        closedAt: x.closedAt ?? null, closedByName: x.closedByName ?? null, closeReason: x.closeReason ?? null, explanation: x.explanation ?? null, reopenCount: Number(x.reopenCount ?? 0),
      })),
    });
  }));

  r.get("/cash/cases/:id", requireScope("read"), h(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, error: "id inválido" });
    const d = await database();
    const c = rowsOf(await d.execute(sql`SELECT c.*, ${DAYF("c.day")} AS dayS, ${DT("c.openedAt")} AS openedAtS, ${DT("c.lastSeenAt")} AS lastSeenAtS, ${DT("c.closedAt")} AS closedAtS, u.name AS closedByName
      FROM cash_cases c LEFT JOIN users u ON u.id = c.closedBy WHERE c.id = ${id} LIMIT 1`))[0];
    if (!c) return res.status(404).json({ success: false, error: "Caso não encontrado" });
    const events = rowsOf(await d.execute(sql`SELECT e.id, ${DT("e.at")} AS at, e.action, e.note, u.name AS byName FROM cash_case_events e
      LEFT JOIN users u ON u.id = e.userId WHERE e.caseId = ${id} ORDER BY e.at DESC, e.id DESC LIMIT 200`));
    const names = await parkNames();
    res.json({
      success: true,
      data: {
        id: Number(c.id), subjectType: String(c.subjectType), subjectId: String(c.subjectId), code: String(c.code), rule: c.ruleRef ?? null, label: String(c.label),
        severity: String(c.severity), state: String(c.state), detail: c.detail ?? null, parkId: c.parkId ?? null, parkName: c.parkId ? names.get(String(c.parkId))?.name ?? null : null,
        bookingCode: c.bookingCode ?? null, day: c.dayS ?? null, openedAt: c.openedAtS, lastSeenAt: c.lastSeenAtS, closedAt: c.closedAtS ?? null, closedByName: c.closedByName ?? null,
        closeReason: c.closeReason ?? null, explanation: c.explanation ?? null, reopenCount: Number(c.reopenCount ?? 0),
        events: events.map((e) => ({ id: Number(e.id), at: e.at, action: String(e.action), note: e.note ?? null, byName: e.byName ?? null })),
      },
    });
  }));

  // ── CONDUTORES ────────────────────────────────────────────────────────────
  r.get("/drivers/daily", requireScope("read"), h(async (req, res) => {
    const rg = parseRange(req.query.from, req.query.to);
    if ("error" in rg) return res.status(400).json({ success: false, error: rg.error });
    const employeeId = req.query.employeeId !== undefined ? Number(req.query.employeeId) : undefined;
    if (employeeId !== undefined && (!Number.isInteger(employeeId) || employeeId <= 0)) return res.status(400).json({ success: false, error: "employeeId inválido" });
    const d = await database();
    const conds = [sql`h.date >= ${rg.from}`, sql`h.date < DATE_ADD(${rg.to}, INTERVAL 1 DAY)`];
    if (employeeId) conds.push(sql`h.employeeId = ${employeeId}`);
    const raw = rowsOf(await d.execute(sql`SELECT h.zelloUsername, h.displayName, h.employeeId, e.fullName, ${DAYF("h.date")} AS day, h.totalKm, h.hoursWorked, h.hoursStopped,
        h.totalHoursOnline, h.avgSpeed, h.maxSpeed, h.speedViolations, h.avgBattery, h.minBattery, h.collectionPass
      FROM daily_driver_history h LEFT JOIN employees e ON e.id = h.employeeId
      WHERE ${sql.join(conds, sql` AND `)} ORDER BY h.date, h.zelloUsername LIMIT 20000`));
    const rows = dedupeDriverDays(raw.map((x): DriverDayRow => ({
      key: x.employeeId ? `e${x.employeeId}` : `z${x.zelloUsername}`, employeeId: x.employeeId == null ? null : Number(x.employeeId),
      name: String(x.fullName ?? x.displayName ?? x.zelloUsername ?? "?"), day: String(x.day), collectionPass: String(x.collectionPass ?? "final"),
      totalKm: Number(x.totalKm) || 0, hoursWorked: Number(x.hoursWorked) || 0, hoursStopped: Number(x.hoursStopped) || 0, totalHoursOnline: Number(x.totalHoursOnline) || 0,
      avgSpeed: Number(x.avgSpeed) || 0, maxSpeed: Number(x.maxSpeed) || 0, speedViolations: Number(x.speedViolations) || 0, avgBattery: Number(x.avgBattery) || 0, minBattery: Number(x.minBattery) || 0,
    })));
    res.json({
      success: true, from: rg.from, to: rg.to, days: rows.length, truncated: raw.length >= 20000,
      note: "Fonte: histórico diário do GPS/Zello. Dias 'sameday' são provisórios; quando existe a recolha 'final' (D-2) essa prevalece.",
      summary: summarizeDrivers(rows), rows,
    });
  }));

  // ── PARCEIROS ─────────────────────────────────────────────────────────────
  r.get("/partners/billing", requireScope("read"), h(async (req, res) => {
    const rg = parseRange(req.query.from, req.query.to);
    if ("error" in rg) return res.status(400).json({ success: false, error: rg.error });
    const projectId = req.query.projectId !== undefined ? Number(req.query.projectId) : undefined;
    if (projectId !== undefined && (!Number.isInteger(projectId) || projectId <= 0)) return res.status(400).json({ success: false, error: "projectId inválido" });
    const { getPartnerInvoicingSummary } = await import("./db");
    const rows = await getPartnerInvoicingSummary({ from: rg.from, to: rg.to, projectId, partnerType: str(req.query.partnerType) });
    const sum = (f: (x: (typeof rows)[number]) => number) => r2(rows.reduce((s, x) => s + f(x), 0));
    res.json({
      success: true, from: rg.from, to: rg.to, count: rows.length,
      note: "aFaturar = comissão das reservas concluídas no período (ou avença rateada). Não há registo de faturas emitidas nesta fonte: para o estado do mês usa /partners/close.",
      totals: { bookings: rows.reduce((s, x) => s + x.bookingsCount, 0), revenueGross: sum((x) => x.revenueGross), revenueNet: sum((x) => x.revenueNet), aFaturar: sum((x) => x.aFaturar ?? 0) },
      data: rows,
    });
  }));

  r.get("/partners/close", requireScope("read"), h(async (req, res) => {
    const month = str(req.query.month);
    if (!month || !MONTH_RE.test(month)) return res.status(400).json({ success: false, error: "month (AAAA-MM) é obrigatório" });
    const { listPartnerClose } = await import("./partnerClose");
    const rows = await listPartnerClose(month);
    res.json({
      success: true, month, count: rows.length,
      summary: {
        closed: rows.filter((x) => x.state === "fechado").length, open: rows.filter((x) => x.state !== "fechado").length,
        withDifferences: rows.filter((x) => x.diffs > 0).length, differences: rows.reduce((s, x) => s + x.diffs, 0),
        mpOurs: r2(rows.reduce((s, x) => s + x.mp.ours, 0)), copyOurs: r2(rows.reduce((s, x) => s + x.copy.ours, 0)),
      },
      data: rows,
    });
  }));

  // ── PASSAGENS DE TURNO ────────────────────────────────────────────────────
  r.get("/shift-handovers", requireScope("read"), h(async (req, res) => {
    const rg = parseRange(req.query.from, req.query.to);
    if ("error" in rg) return res.status(400).json({ success: false, error: rg.error });
    const city = str(req.query.city)?.toLowerCase();
    const d = await database();
    const conds = [sql`handoverDate >= ${rg.from}`, sql`handoverDate <= ${rg.to}`];
    if (city) conds.push(sql`city = ${city}`);
    const rows = rowsOf(await d.execute(sql`SELECT id, handoverDate, shift, city, cashClosedInSafe, checkoutCashDone, frontPouchValue, terminalPouchValue, ticketsExpensesPaid,
        mbRolls, materialOk, filledByName, createdByName, ackByName, ${DT("ackAt")} AS ackAt, version, ${DT("updatedAt")} AS updatedAt
      FROM shift_handovers WHERE ${sql.join(conds, sql` AND `)} ORDER BY handoverDate, city, shift LIMIT 2000`));
    const num = (v: unknown) => (v == null ? null : r2(v));
    res.json({
      success: true, from: rg.from, to: rg.to, count: rows.length,
      data: rows.map((x) => ({
        id: Number(x.id), day: String(x.handoverDate), shift: String(x.shift), city: String(x.city),
        cashClosedInSafe: x.cashClosedInSafe == null ? null : Number(x.cashClosedInSafe) === 1, checkoutCashDone: x.checkoutCashDone == null ? null : Number(x.checkoutCashDone) === 1,
        frontPouchValue: num(x.frontPouchValue), terminalPouchValue: num(x.terminalPouchValue), ticketsExpensesPaid: num(x.ticketsExpensesPaid), mbRolls: x.mbRolls == null ? null : Number(x.mbRolls),
        materialOk: x.materialOk == null ? null : Number(x.materialOk) === 1, filledByName: x.filledByName ?? null, createdByName: x.createdByName ?? null,
        ackByName: x.ackByName ?? null, ackAt: x.ackAt ?? null, version: Number(x.version ?? 1), updatedAt: x.updatedAt ?? null,
      })),
    });
  }));
}
