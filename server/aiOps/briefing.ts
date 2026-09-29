/**
 * Briefing diário por cidade (07:30 Lisboa): reservas do dia (entradas/saídas
 * por hora e pico), extras escalados vs. necessários (previsão do Extras-Dia,
 * só LEITURA), casos com prazo (SLA) hoje, pendentes da passagem de turno
 * (e os que se repetem), anomalias e alertas de marketing.
 *
 * Os números vêm do SQL/código (`buildBriefingData`, PURA); a IA escreve só
 * o parágrafo (`ops_briefing`, lite). Guardado em `ops_briefings`; o email e a
 * página mostram a cada pessoa SÓ as secções dos módulos a que tem acesso.
 */
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { addDays, lisbonDayRangeUtc } from "../../shared/lisbonDay";
import { can, scopeFor, type AccessOverrides } from "../../shared/access";
import type { OpenItem } from "../../shared/shiftHandoverAuto";
import { OPS_BRIEFING_SYSTEM } from "../_core/ai/prompts/ops";
import { AiCallCap, tryAi } from "./aiCall";
import { OPS_CITY_LABELS, type CityTree, type OpsCity } from "./cities";
import type { RepeatedItem } from "./handoverRepeats";

const rowsOf = (res: unknown): any[] => (Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : []) as any[];

// ─── Dados (PUROS) ───────────────────────────────────────────────────────────

export interface HourCount { hour: number; checkins: number; checkouts: number }
export interface SlaRow { type: "complaint" | "incident"; id: number; title: string; dueAt: string }
export interface BriefingAnomaly { domain: string; severity: string; detail: string; explanation: string | null }
export interface BriefingMarketingAlert { level: string; title: string; detail: string }

export interface BriefingData {
  city: OpsCity;
  day: string;
  bookings: { checkins: number; checkouts: number; total: number; byHour: Array<HourCount & { label: string }>; peak: { label: string; total: number } | null };
  extras: { neededPeak: number; neededHours: number; scheduled: number; scheduledHours: number; teamLeaders: number; gap: number } | null;
  sla: { complaintsDueToday: number; complaintsOverdue: number; incidentsDueToday: number; incidentsOverdue: number; items: Array<SlaRow & { overdue: boolean }> };
  handover: { last: string | null; pending: string[]; repeated: RepeatedItem[] };
  anomalies: BriefingAnomaly[];
  marketingAlerts: BriefingMarketingAlert[];
}

/** "03h" … "23h", "00h" (24), "01h" (25), "02h" (26). */
export const hourLabel = (h: number) => `${String(h % 24).padStart(2, "0")}h`;

export function buildBriefingData(input: {
  city: OpsCity;
  day: string;
  /** hora (0–26, dia operacional 03h→03h) → entradas/saídas */
  hourly: HourCount[];
  extras: { neededPeak: number; neededHours: number; assignments: Array<{ isTeamLeader: boolean; startHour: number; endHour: number }> } | null;
  sla: SlaRow[];
  /** fim do dia de hoje em UTC ("YYYY-MM-DD HH:MM:SS") e agora */
  nowUtc: string;
  handover: { last: string | null; pending: OpenItem[]; repeated: RepeatedItem[] };
  anomalies: BriefingAnomaly[];
  marketingAlerts: BriefingMarketingAlert[];
}): BriefingData {
  const byHour = input.hourly
    .filter((h) => h.hour >= 3 && h.checkins + h.checkouts > 0)
    .sort((a, b) => a.hour - b.hour)
    .map((h) => ({ ...h, label: hourLabel(h.hour) }));
  const checkins = byHour.reduce((s, h) => s + h.checkins, 0);
  const checkouts = byHour.reduce((s, h) => s + h.checkouts, 0);
  let peak: BriefingData["bookings"]["peak"] = null;
  for (const h of byHour) {
    const t = h.checkins + h.checkouts;
    if (!peak || t > peak.total) peak = { label: h.label, total: t };
  }
  let extras: BriefingData["extras"] = null;
  if (input.extras) {
    const drivers = input.extras.assignments.filter((a) => !a.isTeamLeader);
    const scheduledHours = drivers.reduce((s, a) => s + Math.max(0, a.endHour - a.startHour), 0);
    extras = {
      neededPeak: input.extras.neededPeak, neededHours: input.extras.neededHours,
      scheduled: drivers.length, scheduledHours,
      teamLeaders: input.extras.assignments.length - drivers.length,
      gap: Math.max(0, input.extras.neededPeak - drivers.length),
    };
  }
  const items = input.sla
    .map((r) => ({ ...r, overdue: r.dueAt < input.nowUtc }))
    .sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1));
  const count = (type: SlaRow["type"], overdue: boolean) => items.filter((i) => i.type === type && i.overdue === overdue).length;
  return {
    city: input.city, day: input.day,
    bookings: { checkins, checkouts, total: checkins + checkouts, byHour, peak },
    extras,
    sla: {
      complaintsDueToday: count("complaint", false), complaintsOverdue: count("complaint", true),
      incidentsDueToday: count("incident", false), incidentsOverdue: count("incident", true),
      items: items.slice(0, 10),
    },
    handover: { last: input.handover.last, pending: input.handover.pending.map((i) => i.text).slice(0, 12), repeated: input.handover.repeated.slice(0, 8) },
    anomalies: input.anomalies.slice(0, 10),
    marketingAlerts: input.marketingAlerts.slice(0, 8),
  };
}

// ─── Quem vê o quê (por pessoa) ──────────────────────────────────────────────

export interface ViewerPerms { complaints: boolean; incidents: boolean; marketing: boolean; bookingsAnomalies: boolean; expenseAnomalies: boolean }

export function viewerPerms(user: { role: string; accessOverrides?: AccessOverrides | null }): ViewerPerms {
  const exp = scopeFor(user as any, "despesas");
  return {
    complaints: can(user as any, "reclamacoes", "view"),
    incidents: can(user as any, "ocorrencias", "view"),
    marketing: can(user as any, "marketing", "view"),
    bookingsAnomalies: can(user as any, "reservas_operacoes", "view"),
    expenseAnomalies: exp === "city" || exp === "national",
  };
}

const ANOMALY_DOMAIN_PERM: Record<string, keyof ViewerPerms> = { bookings: "bookingsAnomalies", expenses: "expenseAnomalies", marketing: "marketing" };

/** A mesma BriefingData, só com o que a pessoa pode ver. PURA. */
export function filterBriefingFor(d: BriefingData, p: ViewerPerms): BriefingData {
  const items = d.sla.items.filter((i) => (i.type === "complaint" ? p.complaints : p.incidents));
  return {
    ...d,
    sla: {
      complaintsDueToday: p.complaints ? d.sla.complaintsDueToday : 0, complaintsOverdue: p.complaints ? d.sla.complaintsOverdue : 0,
      incidentsDueToday: p.incidents ? d.sla.incidentsDueToday : 0, incidentsOverdue: p.incidents ? d.sla.incidentsOverdue : 0,
      items,
    },
    anomalies: d.anomalies.filter((a) => p[ANOMALY_DOMAIN_PERM[a.domain] ?? "marketing"]),
    marketingAlerts: p.marketing ? d.marketingAlerts : [],
  };
}

// ─── Texto ──────────────────────────────────────────────────────────────────

/**
 * Factos para a IA: só a parte OPERACIONAL (reservas, extras, SLA em números,
 * pendentes) — nada de marketing/despesas, para o parágrafo servir a todos
 * os destinatários da cidade. Sem nomes de clientes. PURA.
 */
export function briefingFacts(d: BriefingData): string {
  const b = d.bookings;
  const lines = [
    `Cidade: ${OPS_CITY_LABELS[d.city]}. Dia: ${d.day}.`,
    `Reservas hoje: ${b.checkins} entradas e ${b.checkouts} saídas (${b.total} movimentos).`,
    b.peak ? `Hora de pico: ${b.peak.label} com ${b.peak.total} movimentos.` : "",
    b.byHour.length ? `Por hora (entradas/saídas): ${b.byHour.map((h) => `${h.label} ${h.checkins}/${h.checkouts}`).join("; ")}.` : "",
    d.extras ? `Extras: ${d.extras.scheduled} escalados (${d.extras.scheduledHours} h) para ${d.extras.neededPeak} necessários no pico (${d.extras.neededHours} h previstas); ${d.extras.teamLeaders} team leader(s).${d.extras.gap ? ` Faltam ${d.extras.gap}.` : ""}` : "",
    `Prazos hoje: ${d.sla.complaintsDueToday} reclamações e ${d.sla.incidentsDueToday} ocorrências; já em atraso: ${d.sla.complaintsOverdue} reclamações e ${d.sla.incidentsOverdue} ocorrências.`,
    d.handover.pending.length ? `Pendentes da última passagem (${d.handover.pending.length}): ${d.handover.pending.slice(0, 8).map((t) => t.slice(0, 120)).join(" | ")}.` : "Sem pendentes da passagem de turno.",
    d.handover.repeated.length ? `Pendentes que se arrastam: ${d.handover.repeated.map((r) => `${r.text.slice(0, 100)} (${r.count} passagens seguidas)`).join(" | ")}.` : "",
    ...d.anomalies.filter((a) => a.domain === "bookings").slice(0, 3).map((a) => `Anomalia: ${a.detail}`),
  ];
  return lines.filter(Boolean).join("\n");
}

/** Parágrafo sem IA (interruptor desligado, orçamento, erro). PURA. */
export function briefingFallbackSummary(d: BriefingData): string {
  const b = d.bookings;
  const parts = [
    `Hoje em ${OPS_CITY_LABELS[d.city]}: ${b.checkins} entradas e ${b.checkouts} saídas${b.peak ? `, com pico às ${b.peak.label} (${b.peak.total})` : ""}.`,
    d.extras ? `Extras: ${d.extras.scheduled} escalados para ${d.extras.neededPeak} necessários no pico${d.extras.gap ? ` — faltam ${d.extras.gap}` : ""}.` : "",
    (() => {
      const due = d.sla.complaintsDueToday + d.sla.incidentsDueToday;
      const late = d.sla.complaintsOverdue + d.sla.incidentsOverdue;
      return due || late ? `${due} caso(s) com prazo hoje${late ? ` e ${late} em atraso` : ""}.` : "";
    })(),
    d.handover.pending.length ? `${d.handover.pending.length} pendente(s) da passagem de turno${d.handover.repeated.length ? `, ${d.handover.repeated.length} a repetir-se` : ""}.` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

export async function briefingSummary(d: BriefingData, cap: AiCallCap): Promise<{ text: string; ai: boolean }> {
  const res = await tryAi({ feature: "ops_briefing", system: OPS_BRIEFING_SYSTEM, input: briefingFacts(d), cap, maxTokens: 300, entity: "ops_briefing" });
  if (res.ok && res.output.trim()) return { text: res.output.trim().slice(0, 1200), ai: true };
  return { text: briefingFallbackSummary(d), ai: false };
}

const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const fmtDue = (utc: string) => {
  const ms = Date.parse(utc.replace(" ", "T") + "Z");
  return Number.isFinite(ms) ? new Intl.DateTimeFormat("pt-PT", { timeZone: "Europe/Lisbon", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(ms) : utc;
};

/** Email do briefing para UMA pessoa (já filtrado pelas permissões dela). PURA. */
export function renderBriefingEmail(d: BriefingData, summary: string, appUrl: string): { subject: string; html: string; text: string } {
  const city = OPS_CITY_LABELS[d.city];
  const b = d.bookings;
  const dd = `${d.day.slice(8, 10)}/${d.day.slice(5, 7)}`;
  const subject = `Briefing ${city} ${dd}: ${b.checkins} entradas, ${b.checkouts} saídas${d.extras?.gap ? `, faltam ${d.extras.gap} extras` : ""}`;
  const li = (s: string) => `<li style="margin:2px 0">${s}</li>`;
  const section = (title: string, body: string) => `<h3 style="font-size:15px;margin:16px 0 6px">${title}</h3>${body}`;
  const hours = b.byHour.length
    ? `<table style="border-collapse:collapse;font-size:12px"><tr>${b.byHour.map((h) => `<td style="padding:2px 6px;text-align:center;border:1px solid #e3e7ee">${h.label}<br><b>${h.checkins}</b>/<b>${h.checkouts}</b></td>`).join("")}</tr></table><p style="font-size:11px;color:#667;margin:4px 0 0">entradas/saídas por hora</p>`
    : `<p style="font-size:13px">Sem reservas para hoje.</p>`;
  const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;color:#1b2430;max-width:720px">
    <h2 style="font-size:18px;margin:0 0 6px">Briefing — ${esc(city)}, ${dd}</h2>
    <p style="font-size:14px;line-height:1.45;background:#f4f6fa;border-radius:8px;padding:10px 12px;margin:0 0 8px">${esc(summary)}</p>
    ${section(`Reservas: ${b.checkins} entradas · ${b.checkouts} saídas${b.peak ? ` · pico ${b.peak.label} (${b.peak.total})` : ""}`, hours)}
    ${d.extras ? section("Extras", `<p style="font-size:13px;margin:0">${d.extras.scheduled} escalados (${d.extras.scheduledHours} h) · ${d.extras.neededPeak} necessários no pico (${d.extras.neededHours} h previstas) · ${d.extras.teamLeaders} TL${d.extras.gap ? ` · <b style="color:#b42318">faltam ${d.extras.gap}</b>` : ""}</p>`) : ""}
    ${d.sla.items.length || d.sla.complaintsOverdue + d.sla.incidentsOverdue + d.sla.complaintsDueToday + d.sla.incidentsDueToday
      ? section("Prazos (SLA) hoje", `<ul style="font-size:13px;padding-left:18px;margin:0">${d.sla.items.map((i) => li(`${i.overdue ? '<b style="color:#b42318">Em atraso</b> · ' : ""}${i.type === "complaint" ? "Reclamação" : "Ocorrência"} #${i.id} — ${esc(i.title.slice(0, 120))} (prazo ${esc(fmtDue(i.dueAt))})`)).join("")}</ul>`) : ""}
    ${d.handover.pending.length ? section(`Pendentes da passagem de turno${d.handover.last ? ` (${esc(d.handover.last)})` : ""}`, `<ul style="font-size:13px;padding-left:18px;margin:0">${d.handover.pending.map((t) => li(esc(t))).join("")}</ul>`) : ""}
    ${d.handover.repeated.length ? section("A repetir-se entre turnos", `<ul style="font-size:13px;padding-left:18px;margin:0">${d.handover.repeated.map((r) => li(`${esc(r.text)} — <b>${r.count} passagens seguidas</b>`)).join("")}</ul>`) : ""}
    ${d.anomalies.length ? section("Alertas (anomalias)", `<ul style="font-size:13px;padding-left:18px;margin:0">${d.anomalies.map((a) => li(`${a.severity === "critical" ? "<b>Crítico:</b> " : ""}${esc(a.detail)}${a.explanation ? `<br><i style="color:#556">${esc(a.explanation)}</i>` : ""}`)).join("")}</ul>`) : ""}
    ${d.marketingAlerts.length ? section("Marketing", `<ul style="font-size:13px;padding-left:18px;margin:0">${d.marketingAlerts.map((a) => li(`${a.level === "critical" ? "<b>Crítico:</b> " : ""}${esc(a.title)} — ${esc(a.detail)}`)).join("")}</ul>`) : ""}
    <p style="font-size:12px;color:#667;margin-top:18px"><a href="${appUrl}/dashboard">Abrir o Dashboard</a> · Números do sistema; o parágrafo é escrito por IA quando está ligada.</p></div>`;
  const text = [
    `Briefing — ${city}, ${dd}`, "", summary, "",
    `Reservas: ${b.checkins} entradas, ${b.checkouts} saídas${b.peak ? `, pico ${b.peak.label} (${b.peak.total})` : ""}`,
    b.byHour.map((h) => `${h.label} ${h.checkins}/${h.checkouts}`).join("  "),
    d.extras ? `Extras: ${d.extras.scheduled} escalados / ${d.extras.neededPeak} necessários no pico${d.extras.gap ? ` — faltam ${d.extras.gap}` : ""}` : "",
    ...d.sla.items.map((i) => `${i.overdue ? "[ATRASO] " : ""}${i.type === "complaint" ? "Reclamação" : "Ocorrência"} #${i.id} — ${i.title.slice(0, 100)} (prazo ${fmtDue(i.dueAt)})`),
    ...(d.handover.pending.length ? ["", "Pendentes:", ...d.handover.pending.map((t) => `- ${t}`)] : []),
    ...(d.handover.repeated.length ? ["", "A repetir-se:", ...d.handover.repeated.map((r) => `- ${r.text} (${r.count} passagens)`)] : []),
    ...(d.anomalies.length ? ["", "Alertas:", ...d.anomalies.map((a) => `- ${a.detail}${a.explanation ? ` — ${a.explanation}` : ""}`)] : []),
    ...(d.marketingAlerts.length ? ["", "Marketing:", ...d.marketingAlerts.map((a) => `- ${a.title}`)] : []),
    "", `${appUrl}/dashboard`,
  ].filter((l) => l !== "").join("\n");
  return { subject, html, text };
}

// ─── Recolha (BD) ───────────────────────────────────────────────────────────

async function loadSla(day: string, tree: CityTree): Promise<SlaRow[]> {
  const db = await getDb();
  if (!db || !tree.ids.length) return [];
  const end = lisbonDayRangeUtc(day).end;
  const ids = sql.join(tree.ids.map((id) => sql`${id}`), sql`, `);
  const complaints = rowsOf(await db.execute(sql`
    SELECT id, title, DATE_FORMAT(COALESCE(slaDeadline, dueDate), '%Y-%m-%d %H:%i:%s') AS dueAt FROM complaints
     WHERE projectId IN (${ids}) AND complaint_status NOT IN ('resolved', 'closed', 'converted')
       AND COALESCE(slaDeadline, dueDate) IS NOT NULL AND COALESCE(slaDeadline, dueDate) < ${end}
     ORDER BY COALESCE(slaDeadline, dueDate) LIMIT 50`));
  const incidents = rowsOf(await db.execute(sql`
    SELECT id, incidentType, DATE_FORMAT(dueAt, '%Y-%m-%d %H:%i:%s') AS dueAt FROM incidents
     WHERE projectId IN (${ids}) AND status IN ('open', 'investigating')
       AND dueAt IS NOT NULL AND dueAt < ${end}
     ORDER BY dueAt LIMIT 50`));
  const INCIDENT_LABEL: Record<string, string> = { vidro_aberto: "Vidro aberto", mal_estacionado: "Mal estacionado", dano: "Dano", chave_errada: "Chave errada", combustivel: "Combustível", limpeza: "Limpeza", documentos: "Documentos", outro: "Ocorrência" };
  return [
    ...complaints.map((r) => ({ type: "complaint" as const, id: Number(r.id), title: String(r.title ?? ""), dueAt: String(r.dueAt) })),
    ...incidents.map((r) => ({ type: "incident" as const, id: Number(r.id), title: INCIDENT_LABEL[String(r.incidentType)] ?? "Ocorrência", dueAt: String(r.dueAt) })),
  ];
}

interface ExtrasInput { hourly: HourCount[]; extras: { neededPeak: number; neededHours: number; assignments: Array<{ isTeamLeader: boolean; startHour: number; endHour: number }> } | null }

async function loadExtras(day: string, city: OpsCity): Promise<ExtrasInput> {
  // Previsão do Extras-Dia (só leitura): a previsão de D+1 a partir de D.
  const { getExtrasDiaForecast } = await import("../extrasDia");
  const f = await getExtrasDiaForecast(addDays(day, -1), city);
  const hourly = f.hourly.map((h) => ({ hour: h.hour, checkins: h.checkins, checkouts: h.checkouts }));
  const db = await getDb();
  const rows = db ? rowsOf(await db.execute(sql`
    SELECT isTeamLeader, startHour, COALESCE(sentHomeHour, endHour) AS endHour FROM extras_dia_assignments
     WHERE assignmentDate = ${day} AND city = ${city}`)) : [];
  return {
    hourly,
    extras: {
      neededPeak: f.allocation.cheapest.peakDrivers, neededHours: f.allocation.cheapest.totalDriverHours,
      assignments: rows.map((r) => ({ isTeamLeader: Number(r.isTeamLeader) === 1, startHour: Number(r.startHour ?? 0), endHour: Number(r.endHour ?? 0) })),
    },
  };
}

export async function collectBriefing(day: string, tree: CityTree, nowUtc: string): Promise<BriefingData> {
  const city = tree.city;
  const { repeatedItemsFor } = await import("./handoverRepeats");
  const [ex, sla, ho] = await Promise.all([loadExtras(day, city), loadSla(day, tree), repeatedItemsFor(city)]);
  const db = await getDb();
  const anomalies = db ? rowsOf(await db.execute(sql`
    SELECT domain, severity, detail, explanation FROM ops_anomalies
     WHERE day >= ${addDays(day, -2)} AND (cityKey = ${city} OR (cityKey IS NULL AND domain = 'marketing'))
     ORDER BY FIELD(severity, 'critical', 'warning'), id DESC LIMIT 10`)) : [];
  let marketingAlerts: BriefingMarketingAlert[] = [];
  try {
    const { computeAlertsFor } = await import("../marketingAlertsService");
    const r = await computeAlertsFor(tree.rootId);
    marketingAlerts = r.alerts.map((a: any) => ({ level: String(a.level), title: String(a.title), detail: String(a.detail) }));
  } catch { /* sem dados de marketing → secção vazia */ }
  return buildBriefingData({
    city, day, hourly: ex.hourly, extras: ex.extras, sla, nowUtc,
    handover: { last: ho.latest ? `${ho.latest.date} ${ho.latest.shift === "night" ? "noite" : "manhã"}` : null, pending: ho.pending, repeated: ho.repeated },
    anomalies: anomalies.map((a) => ({ domain: String(a.domain), severity: String(a.severity), detail: String(a.detail), explanation: a.explanation ?? null })),
    marketingAlerts,
  });
}

// ─── Leitura (Dashboard) ─────────────────────────────────────────────────────

export interface BriefingView { city: OpsCity; day: string; summary: string | null; aiUsed: boolean; emailedAt: string | null; data: BriefingData }

export async function latestBriefings(cities: OpsCity[], perms: ViewerPerms, today: string): Promise<BriefingView[]> {
  const db = await getDb();
  if (!db || !cities.length) return [];
  const rows = rowsOf(await db.execute(sql`
    SELECT city, day, data, summary, aiUsed, DATE_FORMAT(emailedAt, '%Y-%m-%d %H:%i:%s') AS emailedAt FROM ops_briefings
     WHERE day >= ${addDays(today, -1)} AND city IN (${sql.join(cities.map((c) => sql`${c}`), sql`, `)})
     ORDER BY day DESC`));
  const out: BriefingView[] = [];
  for (const c of cities) {
    const r = rows.find((x) => x.city === c);
    if (!r) continue;
    let data: BriefingData;
    try { data = JSON.parse(String(r.data)); } catch { continue; }
    out.push({ city: c, day: String(r.day), summary: r.summary ?? null, aiUsed: Number(r.aiUsed) === 1, emailedAt: r.emailedAt ?? null, data: filterBriefingFor(data, perms) });
  }
  return out;
}
