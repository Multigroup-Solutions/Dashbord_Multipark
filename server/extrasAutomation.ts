/**
 * Automação dos Extras (Jorge, 24 set 2026) — pontos 5 a 9 das melhorias:
 *
 *  5. Pedido de disponibilidade AUTOMÁTICO à quinta (semana seguinte, email +
 *     WhatsApp) e LEMBRETE ao sábado a quem ainda não respondeu.
 *  6. "SIM" pelo WhatsApp: a resposta a um pedido de um dia marca a
 *     disponibilidade; a resposta a um aviso de escala CONFIRMA o turno (um
 *     "não" avisa o backoffice); a um pedido da semana devolve o link.
 *  7. Aviso por WhatsApp a quem está escalado (template `aviso_de_trabalho`,
 *     com dia e horas), à tarde para o dia seguinte ou por botão; na 1.ª vez
 *     de sempre segue também `morada_e_regras`.
 *  8. Escala sugerida preenchida com quem está disponível + alerta de horas
 *     sem gente suficiente (no ecrã e, à tarde, notificação para amanhã).
 *  9. Converter um lead de recrutamento numa ficha de extra (com cidade).
 *
 * Tudo corre pelo cron horário `/api/cron/extras-auto`, que decide pela hora
 * de Lisboa o que está na altura; cada tarefa fica registada numa tabela de
 * execuções (chave única) para nunca correr duas vezes.
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { extractAffectedRows } from "./availabilityFormToken";

// ─── Relógio de Lisboa (puro) ───────────────────────────────────────────────

export interface LisbonClock {
  date: string; // YYYY-MM-DD
  /** 1 = segunda … 7 = domingo */
  dow: number;
  hour: number;
}

export function lisbonClock(now: Date = new Date()): LisbonClock {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false, weekday: "short",
  }).formatToParts(now)) parts[p.type] = p.value;
  const dowMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    dow: dowMap[parts.weekday] ?? 1,
    hour: Number(parts.hour === "24" ? "0" : parts.hour),
  };
}

export function addDaysIso(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Horários de cada automação (hora de Lisboa). */
export const AUTOMATION_SCHEDULE = {
  weeklyRequest: { dow: 4, hour: 10 }, // quinta 10h → semana seguinte
  reminder: { dow: 6, hour: 10 },      // sábado 10h → quem não respondeu
  dayBefore: { hour: 18 },             // todos os dias 18h → aviso + cobertura de amanhã
} as const;

export interface DueTasks {
  weeklyRequest: string | null; // weekStart
  reminder: string | null;      // weekStart
  tomorrow: string | null;      // data de amanhã (aviso da escala + cobertura)
}

/** O que está na altura de correr (puro). A partir da hora marcada até ao fim do dia. */
export function dueTasks(c: LisbonClock): DueTasks {
  const nextMonday = addDaysIso(c.date, 8 - c.dow);
  const s = AUTOMATION_SCHEDULE;
  return {
    weeklyRequest: c.dow === s.weeklyRequest.dow && c.hour >= s.weeklyRequest.hour ? nextMonday : null,
    reminder: c.dow === s.reminder.dow && c.hour >= s.reminder.hour ? nextMonday : null,
    tomorrow: c.hour >= s.dayBefore.hour ? addDaysIso(c.date, 1) : null,
  };
}

// ─── Textos (puros) ─────────────────────────────────────────────────────────

const WEEKDAYS_PT = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const hh = (h: number) => `${String(((h % 24) + 24) % 24).padStart(2, "0")}h`;

/** "sexta 26/09, das 06h às 14h" — horas > 24 são da madrugada seguinte. */
export function fmtWorkDay(date: string, startHour: number, endHour: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  const label = `${WEEKDAYS_PT[d.getUTCDay()]} ${date.slice(8, 10)}/${date.slice(5, 7)}`;
  return `${label}, das ${hh(startHour)} às ${hh(endHour)}`;
}

/** "semana de 29/09 a 05/10" */
export function fmtWeek(weekStart: string): string {
  const end = addDaysIso(weekStart, 6);
  return `semana de ${weekStart.slice(8, 10)}/${weekStart.slice(5, 7)} a ${end.slice(8, 10)}/${end.slice(5, 7)}`;
}

// ─── Cobertura (pura) ───────────────────────────────────────────────────────

export interface ShiftSpan { startHour: number; endHour: number; sentHomeHour?: number | null }
export interface CoverageGap { hour: number; needed: number; have: number }

/**
 * Horas (do dia operacional, 0–26) em que há menos condutores escalados do que
 * a previsão pede. `needed[h]` = condutores necessários na hora h.
 */
export function coverageGaps(needed: number[], assigned: ShiftSpan[], fromHour = 0, toHour = needed.length): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (let h = Math.max(0, fromHour); h < Math.min(needed.length, toHour); h++) {
    const need = needed[h] ?? 0;
    if (need <= 0) continue;
    const have = assigned.filter((a) => a.startHour <= h && h < (a.sentHomeHour ?? a.endHour)).length;
    if (have < need) gaps.push({ hour: h, needed: need, have });
  }
  return gaps;
}

/** "07h (5/3), 08h (6/4)…" — resumo curto para notificações. */
export function describeGaps(gaps: CoverageGap[], max = 6): string {
  const parts = gaps.slice(0, max).map((g) => `${hh(g.hour)} (precisas ${g.needed}, tens ${g.have})`);
  return parts.join(", ") + (gaps.length > max ? ` e mais ${gaps.length - max}h` : "");
}

// ─── Preenchimento automático da escala (puro) ──────────────────────────────

export type ShiftKey = "morning" | "night";
export interface AutofillCandidate {
  id: number;
  fullName: string;
  level: "junior" | "senior" | "terminal" | "master";
  availability: { status: string; morning: boolean; night: boolean; fromHour: number | null; toHour: number | null } | null;
  /** true = cidade da ficha bate com a da escala; null = ficha sem cidade. */
  cityMatch: boolean | null;
}
export interface AutofillPick { employeeId: number; personName: string; level: AutofillCandidate["level"]; startHour: number; endHour: number }

/** Janela (horas) em que o extra disse que pode, para este turno; null = não pode. */
export function availableWindow(a: AutofillCandidate["availability"], shift: ShiftKey): { from: number; to: number } | null {
  if (!a || a.status !== "available") return null;
  const bounds = shift === "morning" ? { from: 3, to: 15 } : { from: 15, to: 27 };
  if (a.fromHour != null && a.toHour != null) {
    const from = Math.max(bounds.from, a.fromHour);
    const to = Math.min(bounds.to, a.toHour);
    return to - from >= 3 ? { from, to } : null;
  }
  return (shift === "morning" ? a.morning : a.night) ? bounds : null;
}

/**
 * Distribui os turnos sugeridos que ainda faltam pelos extras disponíveis.
 * Os primeiros `existing` turnos sugeridos (os mais compridos) contam como já
 * cobertos por quem já está escalado. Cidade certa primeiro, depois sem
 * cidade; quem é de outra cidade nunca entra.
 */
export function planAutofill(
  suggested: { startHour: number; endHour: number }[],
  existingCount: number,
  candidates: AutofillCandidate[],
  shift: ShiftKey,
  alreadyAssigned: Set<number>,
): { picks: AutofillPick[]; unfilled: { startHour: number; endHour: number }[] } {
  const todo = suggested
    .slice()
    .sort((a, b) => (b.endHour - b.startHour) - (a.endHour - a.startHour) || a.startHour - b.startHour)
    .slice(Math.max(0, existingCount));
  const pool = candidates
    .filter((c) => c.cityMatch !== false && !alreadyAssigned.has(c.id))
    .map((c) => ({ c, win: availableWindow(c.availability, shift) }))
    .filter((x): x is { c: AutofillCandidate; win: { from: number; to: number } } => x.win != null)
    .sort((a, b) => Number(b.c.cityMatch === true) - Number(a.c.cityMatch === true) || a.c.fullName.localeCompare(b.c.fullName));

  const picks: AutofillPick[] = [];
  const unfilled: { startHour: number; endHour: number }[] = [];
  const used = new Set<number>();
  for (const s of todo) {
    // melhor encaixe: quem cobre mais horas deste turno
    let best: { c: AutofillCandidate; from: number; to: number } | null = null;
    for (const { c, win } of pool) {
      if (used.has(c.id)) continue;
      const from = Math.max(s.startHour, win.from);
      const to = Math.min(s.endHour, win.to);
      if (to - from < 3) continue;
      if (!best || to - from > best.to - best.from) best = { c, from, to };
      if (best && best.from === s.startHour && best.to === s.endHour) break;
    }
    if (!best) { unfilled.push(s); continue; }
    used.add(best.c.id);
    picks.push({ employeeId: best.c.id, personName: best.c.fullName, level: best.c.level, startHour: best.from, endHour: best.to });
  }
  return { picks, unfilled };
}

// ─── Tabelas de apoio (on-demand, como o availability_request_log) ──────────

let tablesEnsured = false;
async function ensureTables(): Promise<void> {
  if (tablesEnsured) return;
  const db = await getDb();
  if (!db) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS \`extras_automation_runs\` (
    \`runKey\` VARCHAR(64) NOT NULL,
    \`ranAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`result\` VARCHAR(500) NULL,
    PRIMARY KEY (\`runKey\`)
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS \`extras_dia_notices\` (
    \`id\` INT NOT NULL AUTO_INCREMENT,
    \`assignmentId\` INT NOT NULL,
    \`employeeId\` INT NOT NULL,
    \`assignmentDate\` VARCHAR(10) NOT NULL,
    \`status\` VARCHAR(12) NOT NULL,
    \`error\` VARCHAR(300) NULL,
    \`sentAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`confirmedAt\` TIMESTAMP NULL,
    \`declinedAt\` TIMESTAMP NULL,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`edn_assignment\` (\`assignmentId\`),
    KEY \`edn_emp_date\` (\`employeeId\`, \`assignmentDate\`)
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS \`extras_rules_sent\` (
    \`employeeId\` INT NOT NULL,
    \`sentAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`employeeId\`)
  )`);
  tablesEnsured = true;
}

/** Reserva a execução `key`; false = já correu (ou está a correr). */
async function claimRun(key: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  await ensureTables();
  return extractAffectedRows(await db.execute(sql`INSERT IGNORE INTO \`extras_automation_runs\` (runKey) VALUES (${key})`)) > 0;
}
async function finishRun(key: string, result: string): Promise<void> {
  const db = await getDb();
  if (db) await db.execute(sql`UPDATE \`extras_automation_runs\` SET result = ${result.slice(0, 500)} WHERE runKey = ${key}`);
}
/** Falhou → liberta a chave para a próxima hora tentar outra vez. */
async function releaseRun(key: string): Promise<void> {
  const db = await getDb();
  if (db) await db.execute(sql`DELETE FROM \`extras_automation_runs\` WHERE runKey = ${key}`);
}

function appOrigin(): string {
  return (process.env.APP_URL || process.env.PUBLIC_APP_URL || "https://dashboard.multipark.pt").replace(/\/+$/, "");
}

async function logWhatsappRequest(employeeId: number, kind: string, fields: { targetDate?: string | null; weekStart?: string | null }): Promise<void> {
  // email '' = pedido feito por WhatsApp (o casamento por email ignora-o)
  const db = await getDb();
  if (!db) return;
  await db.execute(sql`
    INSERT INTO \`availability_request_log\` (employeeId, email, kind, targetDate, shift, fromHour, toHour, weekStart)
    VALUES (${employeeId}, '', ${kind}, ${fields.targetDate ?? null}, NULL, NULL, NULL, ${fields.weekStart ?? null})`);
}

async function notifyBackoffice(title: string, body: string, link: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const { users } = await import("../drizzle/schema");
  const { createNotification } = await import("./complaintsExtended");
  const rows = await db.select({ id: users.id }).from(users)
    .where(sql`${users.role} IN ('admin','super_admin','supervisor','backoffice') AND ${users.isActive} = 1`);
  for (const r of rows) {
    try { await createNotification({ userId: r.id, title, body, kind: "extras", link }); } catch { /* segue */ }
  }
}

// ─── 5. Pedido de disponibilidade automático + lembrete ─────────────────────

export interface RequestRunResult { emailSent: number; whatsappSent: number; targets: number }

async function sendAvailabilityRequest(weekStart: string, employeeIds: number[] | null, note: string | null): Promise<RequestRunResult> {
  const { sendWeeklyAvailabilityRequest } = await import("./extrasAvailability");
  const out: RequestRunResult = { emailSent: 0, whatsappSent: 0, targets: 0 };
  if (employeeIds && employeeIds.length === 0) return out;

  const email = await sendWeeklyAvailabilityRequest({ weekStart, origin: appOrigin(), note, employeeIds });
  out.emailSent = email.sent;
  out.targets = email.total;

  if (process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) {
    const { sendBroadcast } = await import("./whatsappBroadcast");
    const { AVAILABILITY_TEMPLATE_NAME, DEFAULT_TEMPLATE_LANGUAGE } = await import("../shared/whatsappTemplate");
    const { getSystemUserId } = await import("./db");
    const wa = await sendBroadcast({
      templateName: AVAILABILITY_TEMPLATE_NAME,
      languageCode: DEFAULT_TEMPLATE_LANGUAGE,
      bodyParam2: fmtWeek(weekStart),
      employeeIds,
      weekStart,
      note: note ?? "Pedido automático de disponibilidade",
      createdById: await getSystemUserId(),
    });
    out.whatsappSent = wa.sent;
    for (const r of wa.recipients) {
      if (r.status === "sent" && r.employeeId != null) {
        try { await logWhatsappRequest(r.employeeId, "week", { weekStart }); } catch { /* segue */ }
      }
    }
  }
  return out;
}

/** Quinta: pedido a todos os extras ativos para a semana seguinte. */
export async function runWeeklyRequest(weekStart: string): Promise<RequestRunResult> {
  return sendAvailabilityRequest(weekStart, null, null);
}

/** Sábado: lembrete só a quem ainda não respondeu para essa semana. */
export async function runReminder(weekStart: string): Promise<RequestRunResult> {
  const { getWeekOverview } = await import("./extrasAvailability");
  const ov = await getWeekOverview(weekStart);
  const pending = ov.extras.filter((e) => !e.responded).map((e) => e.employeeId);
  return sendAvailabilityRequest(weekStart, pending, "Lembrete: ainda não indicaste a tua disponibilidade");
}

// ─── 7. Aviso de escala por WhatsApp ────────────────────────────────────────

export interface NoticeRow { assignmentId: number; status: string; sentAt: string; confirmedAt: string | null; declinedAt: string | null; error: string | null }

export async function listNotices(date: string): Promise<NoticeRow[]> {
  const db = await getDb();
  if (!db) return [];
  await ensureTables();
  const [rows] = (await db.execute(sql`
    SELECT assignmentId, status, sentAt, confirmedAt, declinedAt, error
      FROM \`extras_dia_notices\` WHERE assignmentDate = ${date}`)) as any;
  return (rows as any[]).map((r) => ({
    assignmentId: Number(r.assignmentId),
    status: String(r.status),
    sentAt: String(r.sentAt),
    confirmedAt: r.confirmedAt ? String(r.confirmedAt) : null,
    declinedAt: r.declinedAt ? String(r.declinedAt) : null,
    error: r.error ? String(r.error) : null,
  }));
}

export interface NotifyResult { total: number; sent: number; failed: number; skipped: number; rulesSent: number }

/**
 * Avisa por WhatsApp quem está escalado em `date` (e ainda não foi avisado
 * com sucesso). `city` limita a uma cidade; sem ela, todas.
 */
export async function notifyAssignments(date: string, opts: { city?: string | null; createdById?: number | null } = {}): Promise<NotifyResult> {
  const db = await getDb();
  const res: NotifyResult = { total: 0, sent: 0, failed: 0, skipped: 0, rulesSent: 0 };
  if (!db) return res;
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error("WhatsApp não está configurado (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID).");
  }
  await ensureTables();
  const { extrasDiaAssignments } = await import("../drizzle/schema");
  const { and, eq, isNotNull } = await import("drizzle-orm");
  const conds = [eq(extrasDiaAssignments.assignmentDate, date), isNotNull(extrasDiaAssignments.employeeId)];
  if (opts.city) conds.push(eq(extrasDiaAssignments.city, opts.city));
  const rows = await db.select().from(extrasDiaAssignments).where(and(...conds));
  const done = new Map((await listNotices(date)).map((n) => [n.assignmentId, n]));
  const { sendBroadcast } = await import("./whatsappBroadcast");
  const { findWhatsAppTemplate } = await import("../shared/whatsappTemplate");
  const aviso = findWhatsAppTemplate("aviso_trabalho")!;
  const regras = findWhatsAppTemplate("morada_regras")!;
  const { getSystemUserId } = await import("./db");
  const by = opts.createdById ?? (await getSystemUserId());

  for (const a of rows) {
    res.total++;
    if (done.get(a.id)?.status === "sent") { res.skipped++; continue; }
    const empId = Number(a.employeeId);
    const end = a.sentHomeHour ?? a.endHour;
    let status = "failed";
    let error: string | null = null;
    try {
      const r = await sendBroadcast({
        templateName: aviso.name,
        languageCode: aviso.language,
        bodyParam2: fmtWorkDay(date, a.startHour, end),
        employeeIds: [empId],
        note: `Aviso de escala ${date}`,
        createdById: by,
      });
      const rec = r.recipients[0];
      status = rec?.status === "sent" ? "sent" : "failed";
      error = rec?.status === "sent" ? null : (rec?.error ?? "sem destinatário (ficha inativa ou sem número)");
    } catch (err: any) {
      error = String(err?.message ?? err);
    }
    await db.execute(sql`
      INSERT INTO \`extras_dia_notices\` (assignmentId, employeeId, assignmentDate, status, error)
      VALUES (${a.id}, ${empId}, ${date}, ${status}, ${error ? error.slice(0, 300) : null})
      ON DUPLICATE KEY UPDATE status = VALUES(status), error = VALUES(error), sentAt = CURRENT_TIMESTAMP`);
    if (status !== "sent") { res.failed++; continue; }
    res.sent++;
    try { await logWhatsappRequest(empId, "assignment", { targetDate: date }); } catch { /* segue */ }

    // 1.ª vez de sempre → morada e regras
    const [prev] = (await db.execute(sql`SELECT 1 AS x FROM \`extras_rules_sent\` WHERE employeeId = ${empId} LIMIT 1`)) as any;
    if (!(prev as any[])?.length) {
      try {
        const r = await sendBroadcast({ templateName: regras.name, languageCode: regras.language, employeeIds: [empId], note: "Morada e regras (1.º turno)", createdById: by });
        if (r.recipients[0]?.status === "sent") {
          await db.execute(sql`INSERT IGNORE INTO \`extras_rules_sent\` (employeeId) VALUES (${empId})`);
          res.rulesSent++;
        }
      } catch (err) {
        console.warn("[extras-auto] morada e regras falhou:", empId, err);
      }
    }
  }
  return res;
}

// ─── 8. Escala sugerida + cobertura ─────────────────────────────────────────

type CityId = "lisbon" | "porto" | "faro";
const CITY_KEY_TO_EXTRA: Record<string, CityId> = { lisboa: "lisbon", porto: "porto", faro: "faro" };

export interface AutofillResult { created: AutofillPick[]; unfilled: { startHour: number; endHour: number }[]; suggested: number; existing: number }

export async function autofillShift(input: { date: string; city: CityId; shift: ShiftKey; createdById?: number | null }): Promise<AutofillResult> {
  const { getExtrasDiaForecast, listAssignments, listDriverCandidates, upsertAssignment } = await import("./extrasDia");
  const { resolveEmployeeCities } = await import("./employeeCity");
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");

  const forecast = await getExtrasDiaForecast(addDaysIso(input.date, -1), input.city);
  const inShift = (h: number) => (input.shift === "morning" ? h < 15 : h >= 15);
  const suggested = forecast.allocation.cheapest.shifts.filter((s) => inShift(s.startHour)).map((s) => ({ startHour: s.startHour, endHour: s.endHour }));

  // quem já está escalado nesse dia (qualquer cidade/turno) não entra outra vez
  const all = await listAssignments(input.date);
  const sameCity = (await listAssignments(input.date, input.city)).filter((a) => a.shift === input.shift && !a.isTeamLeader);
  const alreadyAssigned = new Set(all.map((a) => a.employeeId).filter((x): x is number => x != null));

  const cands = await listDriverCandidates(input.date);
  const { employees } = await import("../drizzle/schema");
  const { inArray } = await import("drizzle-orm");
  const ids = cands.map((c) => c.id);
  const people = ids.length ? await db.select({ id: employees.id, projectId: employees.projectId, address: employees.address }).from(employees).where(inArray(employees.id, ids)) : [];
  const cities = await resolveEmployeeCities(people);

  const plan = planAutofill(
    suggested,
    sameCity.length,
    cands.map((c) => {
      const key = cities.get(c.id)?.city ?? null;
      return {
        id: c.id,
        fullName: c.fullName,
        level: c.suggestedLevel,
        availability: c.availability ?? null,
        cityMatch: key ? CITY_KEY_TO_EXTRA[key] === input.city : null,
      };
    }),
    input.shift,
    alreadyAssigned,
  );

  for (const p of plan.picks) {
    await upsertAssignment({
      city: input.city,
      assignmentDate: input.date,
      employeeId: p.employeeId,
      personName: p.personName,
      level: p.level,
      shift: input.shift,
      startHour: p.startHour,
      endHour: p.endHour,
      notes: "preenchido automaticamente (disponibilidade)",
      createdById: input.createdById ?? null,
    });
  }
  return { created: plan.picks, unfilled: plan.unfilled, suggested: suggested.length, existing: sameCity.length };
}

/** Horas com falta de gente num dia/cidade (previsão vs escalados). */
export async function coverageFor(date: string, city: CityId): Promise<CoverageGap[]> {
  const { getExtrasDiaForecast, listAssignments } = await import("./extrasDia");
  const forecast = await getExtrasDiaForecast(addDaysIso(date, -1), city);
  const needed = forecast.hourly.map((h) => h.driversNeeded);
  const drivers = (await listAssignments(date, city)).filter((a) => !a.isTeamLeader);
  return coverageGaps(needed, drivers);
}

// ─── 6. Respostas pelo WhatsApp ─────────────────────────────────────────────

export interface WhatsappReplyOutcome { action: "none" | "confirmed" | "declined" | "day_marked" | "week_link"; reply?: string }

/** Último pedido (email ou WhatsApp) feito a este colaborador nos últimos 10 dias. */
async function latestRequestFor(employeeId: number): Promise<{ kind: string; targetDate: string | null; weekStart: string | null; shift: string | null; fromHour: number | null; toHour: number | null } | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const [rows] = (await db.execute(sql`
      SELECT kind, targetDate, weekStart, shift, fromHour, toHour
        FROM \`availability_request_log\`
       WHERE employeeId = ${employeeId} AND sentAt >= DATE_SUB(NOW(), INTERVAL 10 DAY)
       ORDER BY sentAt DESC, id DESC LIMIT 1`)) as any;
    const r = (rows as any[])?.[0];
    if (!r) return null;
    return {
      kind: String(r.kind),
      targetDate: r.targetDate ? String(r.targetDate) : null,
      weekStart: r.weekStart ? String(r.weekStart) : null,
      shift: r.shift ? String(r.shift) : null,
      fromHour: r.fromHour != null ? Number(r.fromHour) : null,
      toHour: r.toHour != null ? Number(r.toHour) : null,
    };
  } catch {
    return null; // tabela ainda não existe
  }
}

/**
 * Trata a mensagem de um colaborador conhecido que chegou pelo WhatsApp.
 * Best-effort: nunca lança (o webhook tem de responder 200 à Meta).
 */
export async function handleWhatsappReply(input: { employeeId: number; conversationId: number; body: string }): Promise<WhatsappReplyOutcome> {
  try {
    const pending = await latestRequestFor(input.employeeId);
    if (!pending) return { action: "none" };
    const { classifyAvailabilityReply } = await import("./availabilityReply");
    const verdict = classifyAvailabilityReply(input.body).verdict;
    if (verdict === "unclear") return { action: "none" };
    const db = await getDb();
    if (!db) return { action: "none" };
    const { replyToConversation } = await import("./whatsappInbox");
    const { employees } = await import("../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const [emp] = await db.select({ fullName: employees.fullName }).from(employees).where(eq(employees.id, input.employeeId)).limit(1);
    const name = emp?.fullName ?? `#${input.employeeId}`;

    if (pending.kind === "assignment" && pending.targetDate) {
      await ensureTables();
      const col = verdict === "yes" ? sql`confirmedAt` : sql`declinedAt`;
      const upd = await db.execute(sql`
        UPDATE \`extras_dia_notices\` SET ${col} = CURRENT_TIMESTAMP
         WHERE employeeId = ${input.employeeId} AND assignmentDate = ${pending.targetDate}
           AND confirmedAt IS NULL AND declinedAt IS NULL`);
      if (extractAffectedRows(upd) === 0) return { action: "none" }; // já tinha respondido
      if (verdict === "yes") {
        const reply = "Obrigado! Fica confirmado ✅ Até lá.";
        await replyToConversation(input.conversationId, reply, null);
        return { action: "confirmed", reply };
      }
      await notifyBackoffice(
        `${name} não pode ir ao turno de ${pending.targetDate}`,
        `Respondeu "não" ao aviso de escala por WhatsApp. Procura substituto.`,
        "/extras-dia",
      );
      const reply = "Obrigado por avisares. Vamos tratar da substituição.";
      await replyToConversation(input.conversationId, reply, null);
      return { action: "declined", reply };
    }

    if (verdict !== "yes") return { action: "none" };

    if (pending.targetDate) {
      const { markDayAvailability } = await import("./extrasAvailability");
      await markDayAvailability(input.employeeId, pending.targetDate, {
        morning: pending.shift !== "night",
        night: pending.shift === "night",
        fromHour: pending.fromHour,
        toHour: pending.toHour,
        note: "respondeu SIM por WhatsApp",
      });
      const reply = "Obrigado! Ficou registada a tua disponibilidade ✅";
      await replyToConversation(input.conversationId, reply, null);
      return { action: "day_marked", reply };
    }

    if (pending.weekStart) {
      const reply = `Obrigado! Indica aqui os dias e horas em que podes (${fmtWeek(pending.weekStart)}): ${appOrigin()}/disponibilidade?week=${pending.weekStart}`;
      await replyToConversation(input.conversationId, reply, null);
      return { action: "week_link", reply };
    }
    return { action: "none" };
  } catch (err) {
    console.warn("[extras-auto] resposta WhatsApp:", err);
    return { action: "none" };
  }
}

// ─── 9. Converter lead em extra ─────────────────────────────────────────────

export async function convertLeadToExtra(leadId: number, projectId: number, userId: number | null): Promise<{ employeeId: number; created: boolean; city: string }> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const { extraLeads, employees } = await import("../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const [lead] = await db.select().from(extraLeads).where(eq(extraLeads.id, leadId)).limit(1);
  if (!lead) throw new Error("Lead não encontrado");
  if (lead.employeeId) throw new Error("Este lead já tem ficha de extra.");

  const { getProjects } = await import("./db");
  const { resolveApprovalCostCenter, planCostCenterAssignment } = await import("./webIntake");
  const costCenter = resolveApprovalCostCenter((await getProjects()) as any, projectId);

  let employeeId: number;
  let created: boolean;
  if (lead.email) {
    const { findOrCreateExtraByEmail } = await import("./identity");
    const r = await findOrCreateExtraByEmail(db as any, lead.email, { fullName: lead.fullName, phone: lead.phone, projectId });
    employeeId = r.id;
    created = r.created;
    if (!created) {
      const [emp] = await db.select({ projectId: employees.projectId }).from(employees).where(eq(employees.id, employeeId)).limit(1);
      if (planCostCenterAssignment(emp?.projectId ?? null, projectId, false).assign) {
        await db.update(employees).set({ projectId }).where(eq(employees.id, employeeId));
      }
    }
  } else {
    if (!lead.phone) throw new Error("O lead não tem email nem telefone — acrescenta um contacto antes de converter.");
    const ins = await db.insert(employees).values({
      fullName: lead.fullName.slice(0, 256),
      phone: lead.phone,
      position: "extra",
      contractType: "extra",
      projectId,
      isActive: 1,
    } as any);
    employeeId = Number((ins as any)[0]?.insertId ?? (ins as any).insertId);
    created = true;
  }

  await db.update(extraLeads).set({ status: "converted", employeeId }).where(eq(extraLeads.id, leadId));
  const { logActivity } = await import("./db");
  await logActivity({
    userId: userId ?? 0,
    action: "extra_lead_convert",
    entity: "extra_leads",
    entityId: leadId,
    details: `Lead convertido em extra: ${lead.fullName} → employee ${employeeId}${created ? " (criado)" : " (existente)"} · ${costCenter.projectName}`,
  });
  return { employeeId, created, city: costCenter.city };
}

// ─── Orquestração do cron ───────────────────────────────────────────────────

export interface AutomationReport { clock: LisbonClock; ran: string[]; skipped: string[]; errors: string[]; details: Record<string, unknown> }

export async function runExtrasAutomation(now: Date = new Date()): Promise<AutomationReport> {
  const clock = lisbonClock(now);
  const due = dueTasks(clock);
  const report: AutomationReport = { clock, ran: [], skipped: [], errors: [], details: {} };
  if (process.env.EXTRAS_AUTOMATION === "off") { report.skipped.push("desligado (EXTRAS_AUTOMATION=off)"); return report; }

  const run = async (key: string, fn: () => Promise<unknown>) => {
    if (!(await claimRun(key))) { report.skipped.push(key); return; }
    try {
      const out = await fn();
      report.ran.push(key);
      report.details[key] = out;
      await finishRun(key, JSON.stringify(out ?? null));
    } catch (err: any) {
      report.errors.push(`${key}: ${String(err?.message ?? err).slice(0, 200)}`);
      await releaseRun(key);
    }
  };

  if (due.weeklyRequest) await run(`request:${due.weeklyRequest}`, () => runWeeklyRequest(due.weeklyRequest!));
  if (due.reminder) await run(`reminder:${due.reminder}`, () => runReminder(due.reminder!));
  if (due.tomorrow) {
    const date = due.tomorrow;
    // Sem chave de execução: o aviso já é idempotente por turno (só envia a quem
    // ainda não foi avisado com sucesso) — assim, de hora a hora até à meia-noite,
    // apanha quem for escalado depois das 18h e repete as falhas.
    try {
      report.details[`notify:${date}`] = await notifyAssignments(date);
      report.ran.push(`notify:${date}`);
    } catch (err: any) {
      report.errors.push(`notify:${date}: ${String(err?.message ?? err).slice(0, 200)}`);
    }
    await run(`coverage:${date}`, async () => {
      const out: Record<string, number> = {};
      for (const city of ["lisbon", "porto", "faro"] as CityId[]) {
        const gaps = await coverageFor(date, city);
        out[city] = gaps.length;
        if (gaps.length) {
          const label = city === "lisbon" ? "Lisboa" : city === "porto" ? "Porto" : "Faro";
          await notifyBackoffice(`Faltam condutores amanhã em ${label}`, `${date}: ${describeGaps(gaps)}`, "/extras-dia");
        }
      }
      return out;
    });
  }
  return report;
}
