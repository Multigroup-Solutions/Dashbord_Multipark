/**
 * Relatórios semanais (segunda de manhã): direção, marketing, operações e RH.
 * Cada relatório = métricas da semana anterior (seg–dom) vs. a de antes,
 * tiradas dos agregados que já existem (motor financeiro, marketingWeekly,
 * reservas/casos/passagens, avaliação e leads). A IA (`weekly_report`, lite)
 * escreve só a narrativa; sem IA fica um texto fixo com as maiores variações.
 * Destinatários: quem tem o módulo com alcance nacional (recipients.ts).
 */
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { weeklyRanges } from "../../shared/marketingRules";
import { lisbonDayRangeUtc } from "../../shared/lisbonDay";
import type { ModuleId } from "../../shared/access";
import { WEEKLY_REPORT_SYSTEM } from "../_core/ai/prompts/ops";
import { AiCallCap, tryAi } from "./aiCall";

const rowsOf = (res: unknown): any[] => (Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : []) as any[];

export type WeeklyKind = "direcao" | "marketing" | "operacoes" | "rh";
export const WEEKLY_KINDS: readonly WeeklyKind[] = ["direcao", "marketing", "operacoes", "rh"];
export const WEEKLY_META: Record<WeeklyKind, { title: string; audience: string; module: ModuleId; link: string }> = {
  direcao: { title: "Direção", audience: "a direção da empresa", module: "financeiro", link: "/financeiro" },
  marketing: { title: "Marketing", audience: "o responsável de marketing", module: "marketing", link: "/marketing" },
  operacoes: { title: "Operações", audience: "a coordenação de operações", module: "reservas_operacoes", link: "/operacoes" },
  rh: { title: "Recursos Humanos", audience: "os recursos humanos", module: "rh", link: "/rh" },
};

export type MetricUnit = "eur" | "n" | "pct" | "x" | "h";
export interface WeeklyMetric { label: string; value: number | null; prev: number | null; unit: MetricUnit; /** subir é bom? (para o texto fixo) */ higherIsBetter?: boolean }
export interface WeeklyReportData { kind: WeeklyKind; weekStart: string; range: { from: string; to: string }; prevRange: { from: string; to: string }; metrics: WeeklyMetric[]; notes: string[] }

// ─── Formatação e texto (PUROS) ─────────────────────────────────────────────

export function fmtMetric(v: number | null, unit: MetricUnit): string {
  if (v == null || !Number.isFinite(v)) return "—";
  switch (unit) {
    case "eur": return `${Math.round(v).toLocaleString("pt-PT")} €`;
    case "pct": return `${(v * 100).toLocaleString("pt-PT", { maximumFractionDigits: 1 })}%`;
    case "x": return `${v.toLocaleString("pt-PT", { maximumFractionDigits: 2 })}×`;
    case "h": return `${v.toLocaleString("pt-PT", { maximumFractionDigits: 1 })} h`;
    default: return v.toLocaleString("pt-PT", { maximumFractionDigits: 1 });
  }
}

/** Variação relativa (null sem base). PURA. */
export function relChange(value: number | null, prev: number | null): number | null {
  if (value == null || prev == null || !Number.isFinite(value) || !Number.isFinite(prev) || prev === 0) return null;
  return (value - prev) / Math.abs(prev);
}

export function metricLine(m: WeeklyMetric): string {
  const ch = relChange(m.value, m.prev);
  return `${m.label}: ${fmtMetric(m.value, m.unit)}${m.prev != null ? ` (semana anterior ${fmtMetric(m.prev, m.unit)}${ch != null ? `, ${ch >= 0 ? "+" : ""}${Math.round(ch * 100)}%` : ""})` : ""}`;
}

export function weeklyFacts(d: WeeklyReportData): string {
  return [
    `Relatório para ${WEEKLY_META[d.kind].audience}. Semana ${d.range.from} a ${d.range.to}.`,
    ...d.metrics.map(metricLine),
    ...d.notes,
  ].join("\n");
}

/** Texto fixo: as duas maiores variações + as notas. PURA. */
export function weeklyFallback(d: WeeklyReportData): string {
  const moves = d.metrics
    .map((m) => ({ m, ch: relChange(m.value, m.prev) }))
    .filter((x): x is { m: WeeklyMetric; ch: number } => x.ch != null && Math.abs(x.ch) >= 0.05)
    .sort((a, b) => Math.abs(b.ch) - Math.abs(a.ch))
    .slice(0, 2)
    .map(({ m, ch }) => `${m.label} ${ch >= 0 ? "subiu" : "desceu"} ${Math.abs(Math.round(ch * 100))}% (${fmtMetric(m.value, m.unit)})`);
  const head = moves.length ? `${moves.join("; ")}.` : "Semana sem grandes variações face à anterior.";
  return [head, ...d.notes.slice(0, 2)].join(" ");
}

const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const shortDay = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

export function renderWeeklyEmail(d: WeeklyReportData, narrative: string, appUrl: string): { subject: string; html: string; text: string } {
  const meta = WEEKLY_META[d.kind];
  const period = `${shortDay(d.range.from)}–${shortDay(d.range.to)}`;
  const subject = `Relatório semanal ${meta.title} ${period}`;
  const rows = d.metrics.map((m) => {
    const ch = relChange(m.value, m.prev);
    return `<tr><td style="padding:4px 8px">${esc(m.label)}</td><td style="padding:4px 8px;text-align:right"><b>${fmtMetric(m.value, m.unit)}</b></td><td style="padding:4px 8px;text-align:right;color:#667">${fmtMetric(m.prev, m.unit)}${ch != null ? ` (${ch >= 0 ? "+" : ""}${Math.round(ch * 100)}%)` : ""}</td></tr>`;
  }).join("");
  const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;color:#1b2430;max-width:720px">
    <h2 style="font-size:18px;margin:0 0 6px">${esc(meta.title)} — semana ${period}</h2>
    <p style="font-size:14px;line-height:1.45;background:#f4f6fa;border-radius:8px;padding:10px 12px">${esc(narrative)}</p>
    <table style="border-collapse:collapse;font-size:13px;width:100%"><thead><tr style="background:#f1f3f7;text-align:left"><th style="padding:4px 8px"></th><th style="padding:4px 8px;text-align:right">Semana</th><th style="padding:4px 8px;text-align:right">Anterior</th></tr></thead><tbody>${rows}</tbody></table>
    ${d.notes.length ? `<ul style="font-size:13px;padding-left:18px">${d.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
    <p style="font-size:12px;color:#667;margin-top:18px"><a href="${appUrl}${meta.link}">Abrir na app</a> · Números do sistema; o texto é escrito por IA quando está ligada.</p></div>`;
  const text = [`${meta.title} — semana ${period}`, "", narrative, "", ...d.metrics.map(metricLine), ...d.notes, "", `${appUrl}${meta.link}`].join("\n");
  return { subject, html, text };
}

export async function weeklyNarrative(d: WeeklyReportData, cap: AiCallCap): Promise<{ text: string; ai: boolean }> {
  const res = await tryAi({ feature: "weekly_report", system: WEEKLY_REPORT_SYSTEM, input: weeklyFacts(d), cap, maxTokens: 400, entity: `weekly_${d.kind}` });
  return res.ok && res.output.trim() ? { text: res.output.trim().slice(0, 2000), ai: true } : { text: weeklyFallback(d), ai: false };
}

// ─── Recolha (BD / agregados existentes) ────────────────────────────────────

type Range = { from: string; to: string };

async function direcao(cur: Range, prev: Range): Promise<Pick<WeeklyReportData, "metrics" | "notes">> {
  const { computeFinance } = await import("../finance/engine");
  const [a, b] = await Promise.all([computeFinance({ from: cur.from, to: cur.to }), computeFinance({ from: prev.from, to: prev.to })]);
  return {
    metrics: [
      { label: "Receita entregue s/ IVA", value: a.revenue.producedNet, prev: b.revenue.producedNet, unit: "eur", higherIsBetter: true },
      { label: "Reservas entregues", value: a.revenue.producedCount, prev: b.revenue.producedCount, unit: "n", higherIsBetter: true },
      { label: "Custos s/ IVA", value: a.costs.totalNet, prev: b.costs.totalNet, unit: "eur", higherIsBetter: false },
      { label: "Margem", value: a.margin.margin, prev: b.margin.margin, unit: "eur", higherIsBetter: true },
      { label: "Margem %", value: a.margin.marginPct, prev: b.margin.marginPct, unit: "pct", higherIsBetter: true },
      { label: "Custo dos extras (ponto)", value: a.costs.extrasReal, prev: b.costs.extrasReal, unit: "eur", higherIsBetter: false },
    ],
    notes: a.quality.bookingsWithoutProject.count ? [`${a.quality.bookingsWithoutProject.count} reservas entregues sem centro de custos.`] : [],
  };
}

async function marketing(monday: string): Promise<Pick<WeeklyReportData, "metrics" | "notes">> {
  const { buildWeeklyReport } = await import("../marketingWeekly");
  const r = await buildWeeklyReport(monday);
  const roas = (rev: number, spend: number) => (spend > 0 ? rev / (1 + r.vatRate) / spend : null);
  const cpa = (spend: number, n: number) => (n > 0 ? spend / n : null);
  // Resumo semanal do Web & SEO (GA4/Search Console), se houver um recente.
  const web = await import("../webAnalytics/service").then((m) => m.webInsightNote()).catch(() => null);
  return {
    metrics: [
      { label: "Gasto em anúncios", value: r.total.spend, prev: r.total.prevSpend, unit: "eur" },
      { label: "Reservas criadas", value: r.total.bookings, prev: r.total.prevBookings, unit: "n", higherIsBetter: true },
      { label: "Gasto por reserva", value: cpa(r.total.spend, r.total.bookings), prev: cpa(r.total.prevSpend, r.total.prevBookings), unit: "eur", higherIsBetter: false },
      { label: "ROAS s/ IVA", value: roas(r.total.revenue, r.total.spend), prev: roas(r.total.prevRevenue, r.total.prevSpend), unit: "x", higherIsBetter: true },
    ],
    notes: [
      ...(r.top[0] ? [`Melhor campanha: ${r.top[0].name} (ROAS s/ IVA ${fmtMetric(r.top[0].roasNet, "x")}).`] : []),
      ...(r.bottom[0] ? [`Pior campanha: ${r.bottom[0].name} (${fmtMetric(r.bottom[0].cost, "eur")}, ROAS s/ IVA ${fmtMetric(r.bottom[0].roasNet, "x")}).`] : []),
      ...(r.alerts.length ? [`${r.alerts.length} alerta(s) de marketing ativo(s).`] : []),
      ...(web ? [web] : []),
    ],
  };
}

async function operacoes(cur: Range, prev: Range): Promise<Pick<WeeklyReportData, "metrics" | "notes">> {
  const db = await getDb();
  if (!db) return { metrics: [], notes: [] };
  const counts = async (r: Range) => {
    const u = lisbonDayRangeUtc(r.from, r.to);
    const b = rowsOf(await db.execute(sql`
      SELECT SUM(CASE WHEN checkIn >= ${u.start} AND checkIn < ${u.end} THEN 1 ELSE 0 END) AS ins,
             SUM(CASE WHEN checkOut >= ${u.start} AND checkOut < ${u.end} THEN 1 ELSE 0 END) AS outs
        FROM multipark_bookings
       WHERE (status IS NULL OR status <> 'CANCELLED')
         AND ((checkIn >= ${u.start} AND checkIn < ${u.end}) OR (checkOut >= ${u.start} AND checkOut < ${u.end}))`))[0] ?? {};
    const c = rowsOf(await db.execute(sql`SELECT COUNT(*) AS n FROM complaints WHERE createdAt >= ${u.start} AND createdAt < ${u.end}`))[0] ?? {};
    const i = rowsOf(await db.execute(sql`SELECT COUNT(*) AS n FROM incidents WHERE createdAt >= ${u.start} AND createdAt < ${u.end}`))[0] ?? {};
    const late = rowsOf(await db.execute(sql`
      SELECT COUNT(*) AS n FROM complaints
       WHERE complaint_status NOT IN ('resolved', 'closed', 'converted') AND COALESCE(slaDeadline, dueDate) < ${u.end}`))[0] ?? {};
    const h = rowsOf(await db.execute(sql`SELECT COUNT(*) AS n FROM shift_handovers WHERE handoverDate >= ${r.from} AND handoverDate <= ${r.to}`))[0] ?? {};
    const s = rowsOf(await db.execute(sql`
      SELECT COUNT(*) AS n FROM (SELECT DISTINCT assignmentDate, shift, city FROM extras_dia_assignments
        WHERE assignmentDate >= ${r.from} AND assignmentDate <= ${r.to}) t`))[0] ?? {};
    const shifts = Number(s.n ?? 0);
    return { ins: Number(b.ins ?? 0), outs: Number(b.outs ?? 0), complaints: Number(c.n ?? 0), incidents: Number(i.n ?? 0), late: Number(late.n ?? 0), handoverPct: shifts ? Math.min(1, Number(h.n ?? 0) / shifts) : null };
  };
  const [a, b] = [await counts(cur), await counts(prev)];
  return {
    metrics: [
      { label: "Entradas (check-in)", value: a.ins, prev: b.ins, unit: "n" },
      { label: "Saídas (check-out)", value: a.outs, prev: b.outs, unit: "n" },
      { label: "Reclamações novas", value: a.complaints, prev: b.complaints, unit: "n", higherIsBetter: false },
      { label: "Ocorrências novas", value: a.incidents, prev: b.incidents, unit: "n", higherIsBetter: false },
      { label: "Reclamações abertas fora do prazo (fim da semana)", value: a.late, prev: b.late, unit: "n", higherIsBetter: false },
      { label: "Passagens de turno preenchidas", value: a.handoverPct, prev: b.handoverPct, unit: "pct", higherIsBetter: true },
    ],
    notes: [],
  };
}

async function rh(cur: Range, prev: Range): Promise<Pick<WeeklyReportData, "metrics" | "notes">> {
  const { loadEvaluatedDays } = await import("../evaluationEngine");
  const agg = async (r: Range) => {
    const days = await loadEvaluatedDays({ startDay: r.from, endDay: r.to, rankingOnly: true });
    const people = new Set(days.map((d) => d.employeeId));
    const points = days.reduce((s, d) => s + d.score.totalPoints, 0);
    return {
      people: people.size,
      avgPoints: people.size ? points / people.size : null,
      delays: days.reduce((s, d) => s + (d.metrics.delays ?? 0), 0),
      complaints: days.reduce((s, d) => s + (d.metrics.complaints ?? 0), 0),
      hours: days.reduce((s, d) => s + (d.metrics.hoursWorked ?? 0), 0),
    };
  };
  const [a, b] = [await agg(cur), await agg(prev)];
  const db = await getDb();
  const leads = async (r: Range) => {
    if (!db) return { created: 0, converted: 0 };
    const u = lisbonDayRangeUtc(r.from, r.to);
    const x = rowsOf(await db.execute(sql`
      SELECT SUM(CASE WHEN createdAt >= ${u.start} AND createdAt < ${u.end} THEN 1 ELSE 0 END) AS created,
             SUM(CASE WHEN convertedAt >= ${u.start} AND convertedAt < ${u.end} THEN 1 ELSE 0 END) AS converted
        FROM extra_leads WHERE createdAt >= ${u.start} OR convertedAt >= ${u.start}`))[0] ?? {};
    return { created: Number(x.created ?? 0), converted: Number(x.converted ?? 0) };
  };
  const [la, lb] = [await leads(cur), await leads(prev)];
  return {
    metrics: [
      { label: "Pessoas avaliadas", value: a.people, prev: b.people, unit: "n" },
      { label: "Pontos médios por pessoa", value: a.avgPoints, prev: b.avgPoints, unit: "n", higherIsBetter: true },
      { label: "Horas trabalhadas (ponto)", value: a.hours, prev: b.hours, unit: "h" },
      { label: "Atrasos", value: a.delays, prev: b.delays, unit: "n", higherIsBetter: false },
      { label: "Reclamações atribuídas", value: a.complaints, prev: b.complaints, unit: "n", higherIsBetter: false },
      { label: "Leads novas (extras)", value: la.created, prev: lb.created, unit: "n", higherIsBetter: true },
      { label: "Leads convertidas", value: la.converted, prev: lb.converted, unit: "n", higherIsBetter: true },
    ],
    notes: [],
  };
}

export async function buildWeeklyReportData(kind: WeeklyKind, monday: string): Promise<WeeklyReportData> {
  const { current, previous } = weeklyRanges(monday);
  const part = kind === "direcao" ? await direcao(current, previous)
    : kind === "marketing" ? await marketing(monday)
    : kind === "operacoes" ? await operacoes(current, previous)
    : await rh(current, previous);
  return { kind, weekStart: current.from, range: current, prevRange: previous, ...part };
}
