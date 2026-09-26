/**
 * Email semanal de marketing (Jorge, 24 set 2026).
 *
 * À segunda-feira a partir das 8h de Lisboa, pelo cron horário (extras-auto),
 * UMA vez por semana ISO (chave `marketing-weekly:<AAAA-Www>` em
 * extras_automation_runs). Semana = segunda a domingo anteriores, comparada
 * com a semana antes dessa: gasto, reservas, CPA e ROAS s/ IVA por marca e
 * por cidade, as melhores/piores campanhas e os alertas ativos.
 *
 * Destinatários: MARKETING_REPORT_EMAILS (vírgulas). Sem envio de email (Gmail) ou sem
 * destinatários → não envia (e não gasta a chave). MARKETING_WEEKLY=off desliga.
 * Números da fonte única (getAdMetrics / getSpendAndBookingsByBrand), sem
 * âmbito de cidade (é um resumo da direção).
 */
import { isEmailSendConfigured, sendEmail } from "./mail/systemMail";
import { weeklyRanges, weeklyReportDue, weeklyReportRunKey } from "../shared/marketingRules";

export function weeklyRecipients(env: Record<string, string | undefined> = process.env): string[] {
  return String(env.MARKETING_REPORT_EMAILS ?? "").split(/[,;\s]+/).map((e) => e.trim()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
}

const EUR = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: 0, minimumFractionDigits: 0 });
const EUR2 = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: 2, minimumFractionDigits: 2 });
const NUM = new Intl.NumberFormat("pt-PT");
const eur = (v: number | null | undefined, d = 0) => (v == null ? "—" : (d ? EUR2 : EUR).format(v));
const x = (v: number | null | undefined) => (v == null ? "—" : `${v.toFixed(2).replace(".", ",")}×`);
const delta = (cur: number, prev: number) => (prev > 0 ? `${cur >= prev ? "+" : ""}${Math.round((cur / prev - 1) * 100)}%` : cur > 0 ? "novo" : "—");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const shortDay = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

export interface WeeklyLine { label: string; spend: number; bookings: number; revenue: number; prevSpend: number; prevBookings: number; prevRevenue: number }
export interface WeeklyReport {
  range: { from: string; to: string }; prevRange: { from: string; to: string };
  vatRate: number;
  total: WeeklyLine;
  brands: WeeklyLine[];
  cities: WeeklyLine[];
  top: Array<{ name: string; cost: number; bookings: number; roasNet: number | null }>;
  bottom: Array<{ name: string; cost: number; bookings: number; roasNet: number | null }>;
  alerts: Array<{ level: string; title: string; detail: string }>;
}

export async function buildWeeklyReport(monday: string): Promise<WeeklyReport> {
  const { current, previous } = weeklyRanges(monday);
  const { getSpendAndBookingsByBrand } = await import("./integrations/googleAds/marketingStats");
  const { getCampaignRoas } = await import("./marketingCampaignRoas");
  const { computeAlertsFor } = await import("./marketingAlertsService");
  const { getProjects } = await import("./db");
  const [cur, prev, roas, alerts, projects] = await Promise.all([
    getSpendAndBookingsByBrand(current), getSpendAndBookingsByBrand(previous), getCampaignRoas(current), computeAlertsFor(), getProjects(),
  ]);
  const vat = (cur as any).vatRate ?? 0.23;
  const lines = new Map<string, WeeklyLine>();
  const line = (m: Map<string, WeeklyLine>, label: string) => { const l = m.get(label) ?? { label, spend: 0, bookings: 0, revenue: 0, prevSpend: 0, prevBookings: 0, prevRevenue: 0 }; m.set(label, l); return l; };
  for (const b of cur.brands) { const l = line(lines, b.brand); l.spend += b.spend; l.bookings += b.bookings; l.revenue += b.revenue; }
  for (const b of prev.brands) { const l = line(lines, b.brand); l.prevSpend += b.spend; l.prevBookings += b.bookings; l.prevRevenue += b.revenue; }
  const byId = new Map((projects as any[]).map((p) => [p.id, p]));
  const cityName = (brandNode: number) => { const p: any = byId.get(brandNode); const parent: any = p?.parentId != null ? byId.get(p.parentId) : null; return parent?.name ?? "Sem cidade"; };
  const cities = new Map<string, WeeklyLine>();
  for (const c of cur.byBrandCity) { const l = line(cities, cityName(c.projectId)); l.spend += c.spend; l.bookings += c.bookings; l.revenue += c.revenue; }
  for (const c of prev.byBrandCity) { const l = line(cities, cityName(c.projectId)); l.prevSpend += c.spend; l.prevBookings += c.bookings; l.prevRevenue += c.revenue; }
  if ((cur as any).unassignedSpend || (prev as any).unassignedSpend) {
    const l = line(cities, "Sem cidade / nacional por atribuir"); l.spend += (cur as any).unassignedSpend ?? 0; l.prevSpend += (prev as any).unassignedSpend ?? 0;
  }
  const total = Array.from(lines.values()).reduce((t, l) => ({ ...t, spend: t.spend + l.spend, bookings: t.bookings + l.bookings, revenue: t.revenue + l.revenue, prevSpend: t.prevSpend + l.prevSpend, prevBookings: t.prevBookings + l.prevBookings, prevRevenue: t.prevRevenue + l.prevRevenue }),
    { label: "Total", spend: 0, bookings: 0, revenue: 0, prevSpend: 0, prevBookings: 0, prevRevenue: 0 } as WeeklyLine);
  const withSpend = roas.rows.filter((r: any) => r.cost >= 20);
  const top = withSpend.filter((r: any) => r.bookings > 0).sort((a: any, b: any) => (b.roasNet ?? 0) - (a.roasNet ?? 0)).slice(0, 5);
  const bottom = withSpend.slice().sort((a: any, b: any) => (a.roasNet ?? 0) - (b.roasNet ?? 0) || b.cost - a.cost).slice(0, 5);
  const pick = (r: any) => ({ name: String(r.name), cost: Number(r.cost), bookings: Number(r.bookings), roasNet: r.roasNet ?? null });
  return {
    range: current, prevRange: previous, vatRate: vat, total,
    brands: Array.from(lines.values()).sort((a, b) => b.spend - a.spend),
    cities: Array.from(cities.values()).sort((a, b) => b.spend - a.spend),
    top: top.map(pick), bottom: bottom.map(pick),
    alerts: alerts.alerts.map((a) => ({ level: a.level, title: a.title, detail: a.detail })),
  };
}

/** Assunto, HTML e texto do email (puro). */
export function renderWeeklyEmail(r: WeeklyReport, appUrl = "https://dashboard.multipark.pt"): { subject: string; html: string; text: string } {
  const roasNet = (rev: number, spend: number) => (spend > 0 ? rev / (1 + r.vatRate) / spend : null);
  const cpa = (spend: number, n: number) => (n > 0 ? spend / n : null);
  const row = (l: WeeklyLine) => `<tr><td style="padding:4px 8px">${esc(l.label)}</td>
    <td style="padding:4px 8px;text-align:right">${eur(l.spend)} <small style="color:#667">${delta(l.spend, l.prevSpend)}</small></td>
    <td style="padding:4px 8px;text-align:right">${NUM.format(l.bookings)} <small style="color:#667">${delta(l.bookings, l.prevBookings)}</small></td>
    <td style="padding:4px 8px;text-align:right">${eur(cpa(l.spend, l.bookings), 2)}</td>
    <td style="padding:4px 8px;text-align:right">${x(roasNet(l.revenue, l.spend))} <small style="color:#667">(antes ${x(roasNet(l.prevRevenue, l.prevSpend))})</small></td></tr>`;
  const table = (title: string, ls: WeeklyLine[]) => `<h3 style="font-size:15px;margin:18px 0 6px">${title}</h3>
    <table style="border-collapse:collapse;font-size:13px;width:100%"><thead><tr style="background:#f1f3f7;text-align:left">
    <th style="padding:4px 8px"></th><th style="padding:4px 8px;text-align:right">Gasto</th><th style="padding:4px 8px;text-align:right">Reservas</th><th style="padding:4px 8px;text-align:right">Gasto/reserva</th><th style="padding:4px 8px;text-align:right">ROAS s/ IVA</th></tr></thead>
    <tbody>${ls.map(row).join("")}</tbody></table>`;
  const camp = (title: string, cs: WeeklyReport["top"]) => cs.length ? `<h3 style="font-size:15px;margin:18px 0 6px">${title}</h3><ul style="font-size:13px;padding-left:18px">${cs.map((c) => `<li>${esc(c.name)} — ${eur(c.cost)}, ${NUM.format(c.bookings)} reserva(s) ligada(s), ROAS s/ IVA ${x(c.roasNet)}</li>`).join("")}</ul>` : "";
  const alerts = r.alerts.length ? `<h3 style="font-size:15px;margin:18px 0 6px">Alertas ativos (${r.alerts.length})</h3><ul style="font-size:13px;padding-left:18px">${r.alerts.map((a) => `<li><b>${a.level === "critical" ? "Crítico" : "Atenção"}:</b> ${esc(a.title)} — ${esc(a.detail)}</li>`).join("")}</ul>` : `<p style="font-size:13px">Sem alertas ativos.</p>`;
  const period = `${shortDay(r.range.from)}–${shortDay(r.range.to)}`;
  const subject = `Marketing semanal ${period}: ${eur(r.total.spend)} gastos, ${NUM.format(r.total.bookings)} reservas`;
  const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;color:#1b2430;max-width:760px">
    <h2 style="font-size:18px;margin:0 0 4px">Marketing — semana ${period}</h2>
    <p style="font-size:13px;color:#556;margin:0 0 8px">Comparado com ${shortDay(r.prevRange.from)}–${shortDay(r.prevRange.to)}. Gasto Google Ads + Meta; reservas pela data de criação, sem canceladas; ROAS sem IVA (receita ÷ ${(1 + r.vatRate).toFixed(2).replace(".", ",")} ÷ gasto).</p>
    ${table("Total", [r.total])}${table("Por marca", r.brands)}${table("Por cidade", r.cities)}
    ${camp("Melhores campanhas (ROAS s/ IVA)", r.top)}${camp("Piores campanhas", r.bottom)}${alerts}
    <p style="font-size:12px;color:#667;margin-top:18px"><a href="${appUrl}/marketing">Abrir o Marketing</a> · MARKETING_WEEKLY=off desliga este email.</p></div>`;
  const tl = (l: WeeklyLine) => `${l.label}: ${eur(l.spend)} (${delta(l.spend, l.prevSpend)}), ${l.bookings} reservas (${delta(l.bookings, l.prevBookings)}), gasto/reserva ${eur(cpa(l.spend, l.bookings), 2)}, ROAS s/ IVA ${x(roasNet(l.revenue, l.spend))}`;
  const text = [`Marketing — semana ${period}`, "", tl(r.total), "", "Por marca:", ...r.brands.map(tl), "", "Por cidade:", ...r.cities.map(tl), "",
    "Alertas:", ...(r.alerts.length ? r.alerts.map((a) => `- ${a.title}`) : ["- nenhum"]), "", `${appUrl}/marketing`].join("\n");
  return { subject, html, text };
}

/**
 * Chamado de hora a hora (runExtrasAutomation). `run` = o executor idempotente
 * da automação (chave em extras_automation_runs; em erro liberta a chave).
 */
export async function maybeSendMarketingWeekly(clock: { date: string; dow: number; hour: number }, run: (key: string, fn: () => Promise<unknown>) => Promise<void>): Promise<{ skipped?: string; key?: string }> {
  if (process.env.MARKETING_WEEKLY === "off") return { skipped: "desligado (MARKETING_WEEKLY=off)" };
  if (!weeklyReportDue(clock)) return { skipped: "fora de horas" };
  const to = weeklyRecipients();
  if (!to.length) return { skipped: "sem MARKETING_REPORT_EMAILS" };
  if (!isEmailSendConfigured()) return { skipped: "envio de email (Gmail) não configurado" };
  const key = weeklyReportRunKey(clock.date);
  await run(key, async () => {
    const report = await buildWeeklyReport(clock.date);
    const origin = (process.env.APP_URL || process.env.PUBLIC_APP_URL || "https://dashboard.multipark.pt").replace(/\/+$/, "");
    const mail = renderWeeklyEmail(report, origin);
    const ok = await sendEmail({ to: to.join(", "), subject: mail.subject, html: mail.html, text: mail.text, fromName: "Dashboard Multipark" });
    if (!ok) throw new Error("envio do email falhou");
    return { sentTo: to.length, spend: Math.round(report.total.spend), bookings: report.total.bookings };
  });
  return { key };
}
