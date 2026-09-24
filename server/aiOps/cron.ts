/**
 * /api/cron/ops-briefing — corre de manhã (GitHub Actions, 06:32 e 07:32 UTC:
 * cobre 07:32 de Lisboa no verão e no inverno). O servidor decide pela hora
 * de Lisboa (a partir das 07h) e tudo é idempotente:
 *
 *   1. anomalias do dia anterior (OPS_ANOMALIES) + explicações (1 chamada);
 *   2. briefing por cidade (OPS_BRIEFING): guarda em ops_briefings e envia o
 *      email UMA vez (emailedAt) a cada TL/supervisor com acesso à cidade;
 *   3. à segunda (WEEKLY_REPORTS): relatórios de direção, marketing,
 *      operações e RH + resumo semanal da passagem de turno por cidade.
 *
 * Custos: teto de chamadas à IA por corrida; IA desligada/orçamento → texto
 * fixo (os números nunca dependem da IA). Prazo: devolve done:false antes
 * dos 60 s do Vercel e o workflow repete.
 *
 * `ok` honesto: false se um passo falhou (BD, email). IA saltada = aviso.
 */
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { isFeatureEnabled } from "../_core/featureFlags";
import { addDays } from "../../shared/lisbonDay";
import { AiCallCap } from "./aiCall";
import { loadCityTrees, OPS_CITIES, type CityTree, type OpsCity } from "./cities";

const rowsOf = (res: unknown): any[] => (Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : []) as any[];

export const OPS_BRIEFING_HOUR = 7;
export const MAX_AI_CALLS_PER_RUN = 12;

export interface LisbonClock { date: string; dow: number; hour: number }

export function lisbonClockOf(now: Date): LisbonClock {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false, weekday: "short" }).formatToParts(now)) parts[p.type] = p.value;
  const dow: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { date: `${parts.year}-${parts.month}-${parts.day}`, dow: dow[parts.weekday] ?? 1, hour: Number(parts.hour === "24" ? "0" : parts.hour) };
}

export interface OpsCronReport {
  ok: boolean;
  done: boolean;
  clock: LisbonClock;
  skipped?: string;
  ran: string[];
  stepErrors: string[];
  warnings: string[];
  details: Record<string, unknown>;
  aiCalls: number;
}

/** `ok` e `done` a partir do que aconteceu. PURA. */
export function opsCronOutcome(r: { stepErrors: string[]; outOfTime: boolean }): { ok: boolean; done: boolean } {
  return { ok: r.stepErrors.length === 0, done: !r.outOfTime };
}

export interface OpsCronDeps {
  now?: Date;
  deadlineAt: number;
  force?: boolean;
}

const appUrl = () => (process.env.APP_URL || process.env.PUBLIC_APP_URL || "https://dashboard.multipark.pt").replace(/\/+$/, "");
const nowMysql = () => new Date().toISOString().slice(0, 19).replace("T", " ");

export async function runOpsBriefingCron(deps: OpsCronDeps): Promise<OpsCronReport> {
  const now = deps.now ?? new Date();
  const clock = lisbonClockOf(now);
  const report: OpsCronReport = { ok: true, done: true, clock, ran: [], stepErrors: [], warnings: [], details: {}, aiCalls: 0 };
  if (!deps.force && clock.hour < OPS_BRIEFING_HOUR) return { ...report, skipped: `fora de horas (${clock.hour}h de Lisboa; corre a partir das ${OPS_BRIEFING_HOUR}h)` };
  const cap = new AiCallCap(MAX_AI_CALLS_PER_RUN);
  let outOfTime = false;
  const timeLeft = () => {
    if (Date.now() < deps.deadlineAt) return true;
    outOfTime = true;
    return false;
  };
  const step = async (name: string, fn: () => Promise<unknown>) => {
    if (!timeLeft()) return;
    try {
      const out = await fn();
      report.ran.push(name);
      if (out !== undefined) report.details[name] = out;
    } catch (err: any) {
      report.stepErrors.push(`${name}: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  };

  let trees: CityTree[] = [];
  await step("cities", async () => { trees = await loadCityTrees(); return trees.map((t) => t.city); });

  // 1. Anomalias (ontem = último dia completo)
  if (isFeatureEnabled("OPS_ANOMALIES")) {
    await step("anomalies", async () => {
      const { runAnomalyDetection } = await import("./anomalies");
      const r = await runAnomalyDetection(addDays(clock.date, -1), cap);
      if (r.aiSkipped) report.warnings.push(`anomalias: IA saltada (${r.aiSkipped})`);
      return r;
    });
  } else report.warnings.push("anomalias desligadas (OPS_ANOMALIES)");

  // 2. Briefing por cidade
  if (isFeatureEnabled("OPS_BRIEFING")) {
    for (const tree of trees.filter((t) => (OPS_CITIES as readonly string[]).includes(t.city))) {
      await step(`briefing:${tree.city}`, () => briefingForCity(tree, clock.date, cap, report));
    }
  } else report.warnings.push("briefing desligado (OPS_BRIEFING)");

  // 3. Segunda-feira: relatórios semanais + resumo semanal da passagem por cidade
  if (clock.dow === 1) {
    if (isFeatureEnabled("WEEKLY_REPORTS")) {
      const { WEEKLY_KINDS } = await import("./weeklyReports");
      for (const kind of WEEKLY_KINDS) await step(`weekly:${kind}`, () => weeklyReport(kind, clock.date, cap, report));
      for (const tree of trees) await step(`handover-week:${tree.city}`, () => handoverWeek(tree.city, clock.date, cap, report));
    } else report.warnings.push("relatórios semanais desligados (WEEKLY_REPORTS)");
  }

  report.aiCalls = cap.used;
  const o = opsCronOutcome({ stepErrors: report.stepErrors, outOfTime });
  return { ...report, ...o };
}

// ─── Briefing ───────────────────────────────────────────────────────────────

async function briefingForCity(tree: CityTree, day: string, cap: AiCallCap, report: OpsCronReport) {
  const db = await getDb();
  if (!db) throw new Error("BD indisponível");
  const { collectBriefing, briefingSummary, filterBriefingFor, renderBriefingEmail, viewerPerms } = await import("./briefing");
  let row = rowsOf(await db.execute(sql`SELECT id, data, summary, emailedAt FROM ops_briefings WHERE city = ${tree.city} AND day = ${day} LIMIT 1`))[0];
  let created = false;
  if (!row) {
    const data = await collectBriefing(day, tree, nowMysql());
    const s = await briefingSummary(data, cap);
    if (!s.ai) report.warnings.push(`briefing ${tree.city}: sem IA (texto fixo)`);
    await db.execute(sql`
      INSERT IGNORE INTO ops_briefings (city, day, data, summary, aiUsed)
      VALUES (${tree.city}, ${day}, ${JSON.stringify(data)}, ${s.text}, ${s.ai ? 1 : 0})`);
    row = rowsOf(await db.execute(sql`SELECT id, data, summary, emailedAt FROM ops_briefings WHERE city = ${tree.city} AND day = ${day} LIMIT 1`))[0];
    created = true;
  }
  if (!row) throw new Error("briefing não gravado");
  if (row.emailedAt) return { created, emailed: 0, already: true };

  const { isSmtpConfigured, sendEmail } = await import("../_core/notification");
  if (!isSmtpConfigured()) { report.warnings.push(`briefing ${tree.city}: SMTP não configurado`); return { created, emailed: 0 }; }
  const { cityRecipients } = await import("./recipients");
  const to = await cityRecipients(tree.city, "passagem_turno");
  if (!to.length) { report.warnings.push(`briefing ${tree.city}: sem destinatários`); return { created, emailed: 0 }; }
  // Reserva o envio (duas corridas ao mesmo tempo não enviam a dobrar).
  const claim = await db.execute(sql`UPDATE ops_briefings SET emailedAt = ${nowMysql()} WHERE id = ${Number(row.id)} AND emailedAt IS NULL`);
  if (Number((Array.isArray(claim) ? (claim[0] as any) : (claim as any))?.affectedRows ?? 0) === 0) return { created, emailed: 0, already: true };
  const data = JSON.parse(String(row.data));
  let sent = 0;
  const failed: string[] = [];
  for (const r of to) {
    const mail = renderBriefingEmail(filterBriefingFor(data, viewerPerms(r)), String(row.summary ?? ""), appUrl());
    const ok = await sendEmail({ to: r.email, subject: mail.subject, html: mail.html, text: mail.text, fromName: "Dashboard Multipark" });
    if (ok) sent++; else failed.push(String(r.userId));
  }
  await db.execute(sql`UPDATE ops_briefings SET emailRecipients = ${sent} WHERE id = ${Number(row.id)}`);
  if (failed.length) throw new Error(`email falhou para ${failed.length} de ${to.length} destinatário(s)`);
  return { created, emailed: sent };
}

// ─── Relatórios semanais ────────────────────────────────────────────────────

async function saveWeekly(kind: string, weekStart: string, data: unknown, narrative: string, ai: boolean): Promise<{ id: number; emailedAt: string | null; narrative: string; data: string }> {
  const db = await getDb();
  if (!db) throw new Error("BD indisponível");
  await db.execute(sql`
    INSERT IGNORE INTO ai_weekly_reports (kind, weekStart, data, narrative, aiUsed)
    VALUES (${kind}, ${weekStart}, ${JSON.stringify(data)}, ${narrative}, ${ai ? 1 : 0})`);
  const r = rowsOf(await db.execute(sql`SELECT id, emailedAt, narrative, data FROM ai_weekly_reports WHERE kind = ${kind} AND weekStart = ${weekStart} LIMIT 1`))[0];
  if (!r) throw new Error("relatório não gravado");
  return { id: Number(r.id), emailedAt: r.emailedAt ?? null, narrative: String(r.narrative ?? ""), data: String(r.data) };
}

async function existingWeekly(kind: string, weekStart: string) {
  const db = await getDb();
  if (!db) return null;
  return rowsOf(await db.execute(sql`SELECT id, emailedAt, narrative, data FROM ai_weekly_reports WHERE kind = ${kind} AND weekStart = ${weekStart} LIMIT 1`))[0] ?? null;
}

async function claimAndSend(id: number, recipients: Array<{ email: string }>, mail: { subject: string; html: string; text: string }): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("BD indisponível");
  const claim = await db.execute(sql`UPDATE ai_weekly_reports SET emailedAt = ${nowMysql()} WHERE id = ${id} AND emailedAt IS NULL`);
  if (Number((Array.isArray(claim) ? (claim[0] as any) : (claim as any))?.affectedRows ?? 0) === 0) return 0;
  const { sendEmail } = await import("../_core/notification");
  let sent = 0;
  for (const r of recipients) if (await sendEmail({ to: r.email, subject: mail.subject, html: mail.html, text: mail.text, fromName: "Dashboard Multipark" })) sent++;
  await db.execute(sql`UPDATE ai_weekly_reports SET emailRecipients = ${sent} WHERE id = ${id}`);
  if (sent < recipients.length) throw new Error(`email falhou para ${recipients.length - sent} de ${recipients.length} destinatário(s)`);
  return sent;
}

async function weeklyReport(kind: import("./weeklyReports").WeeklyKind, monday: string, cap: AiCallCap, report: OpsCronReport) {
  const { buildWeeklyReportData, weeklyNarrative, renderWeeklyEmail, WEEKLY_META } = await import("./weeklyReports");
  const weekStart = addDays(monday, -7);
  let row = await existingWeekly(kind, weekStart);
  if (!row) {
    const data = await buildWeeklyReportData(kind, monday);
    const n = await weeklyNarrative(data, cap);
    if (!n.ai) report.warnings.push(`semanal ${kind}: sem IA (texto fixo)`);
    row = await saveWeekly(kind, weekStart, data, n.text, n.ai);
  }
  if (row.emailedAt) return { already: true };
  const { isSmtpConfigured } = await import("../_core/notification");
  if (!isSmtpConfigured()) { report.warnings.push(`semanal ${kind}: SMTP não configurado`); return { emailed: 0 }; }
  const { nationalRecipients } = await import("./recipients");
  const to = await nationalRecipients(WEEKLY_META[kind].module);
  if (!to.length) { report.warnings.push(`semanal ${kind}: sem destinatários`); return { emailed: 0 }; }
  const mail = renderWeeklyEmail(JSON.parse(String(row.data)), String(row.narrative ?? ""), appUrl());
  return { emailed: await claimAndSend(Number(row.id), to, mail) };
}

async function handoverWeek(city: OpsCity, monday: string, cap: AiCallCap, report: OpsCronReport) {
  const { buildHandoverWeek, handoverWeekNarrative } = await import("./handoverRepeats");
  const kind = `handover:${city}`;
  const from = addDays(monday, -7);
  const to = addDays(monday, -1);
  let row = await existingWeekly(kind, from);
  if (!row) {
    const data = await buildHandoverWeek(city, from, to);
    const n = await handoverWeekNarrative(data, cap);
    row = await saveWeekly(kind, from, data, n.text, n.ai);
  }
  if (row.emailedAt) return { already: true };
  const { isSmtpConfigured } = await import("../_core/notification");
  if (!isSmtpConfigured()) return { emailed: 0 };
  const { cityRecipients } = await import("./recipients");
  const recipients = await cityRecipients(city, "passagem_turno");
  if (!recipients.length) { report.warnings.push(`passagem semanal ${city}: sem destinatários`); return { emailed: 0 }; }
  const { renderHandoverWeekEmail } = await import("./handoverRepeats");
  return { emailed: await claimAndSend(Number(row.id), recipients, renderHandoverWeekEmail(JSON.parse(String(row.data)), String(row.narrative ?? ""), appUrl())) };
}
