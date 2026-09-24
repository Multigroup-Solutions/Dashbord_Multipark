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
 * 10. Leads (funil único): importação de candidaturas/emails, resumo diário
 *     dos leads à espera e lembrete automático a quem não respondeu.
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
  // Também criada pela migração 0094; aqui para ambientes sem ela.
  await db.execute(sql`CREATE TABLE IF NOT EXISTS \`whatsapp_request_answers\` (
    \`requestId\` INT NOT NULL,
    \`employeeId\` INT NOT NULL,
    \`action\` VARCHAR(16) NOT NULL,
    \`answeredAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`requestId\`)
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

/**
 * Notificação ao backoffice. Com `projectId` (cidade da pessoa em causa), só
 * recebe quem tem essa cidade no seu âmbito — e quem vê todas as cidades. Sem
 * `projectId` (ou cidade desconhecida) vai a todos, como antes.
 */
export async function notifyBackoffice(title: string, body: string, link: string, opts: { projectId?: number | null } = {}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const { users } = await import("../drizzle/schema");
  const { createNotification } = await import("./complaintsExtended");
  const rows = await db.select({ id: users.id }).from(users)
    .where(sql`${users.role} IN ('admin','super_admin','supervisor','backoffice') AND ${users.isActive} = 1`);
  let targets = rows.map((r) => r.id);
  if (opts.projectId != null) {
    const { loadCityAccess } = await import("./cityAccess");
    const scoped: number[] = [];
    for (const id of targets) {
      try {
        const access = await loadCityAccess(id);
        if (userSeesProject(access, opts.projectId)) scoped.push(id);
      } catch { /* sem âmbito resolvido → não recebe avisos de cidade */ }
    }
    targets = scoped;
  }
  for (const id of targets) {
    try { await createNotification({ userId: id, title, body, kind: "extras", link }); } catch { /* segue */ }
  }
}

/** O utilizador vê a cidade/centro `projectId`? (todas as cidades → sim). PURA. */
export function userSeesProject(access: { all: boolean; projectIds: number[] }, projectId: number): boolean {
  return access.all || access.projectIds.includes(projectId);
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

  res.total = rows.length;
  const pending = rows.filter((a) => done.get(a.id)?.status !== "sent");
  res.skipped = rows.length - pending.length;
  if (!pending.length) return res;

  // UM envio por execução (antes era um broadcast por turno): o dia/horas de
  // cada pessoa vai no {{2}} dela. Quem tem dois turnos no dia recebe um só
  // aviso com os dois horários.
  const byEmp = new Map<number, typeof pending>();
  for (const a of pending) {
    const empId = Number(a.employeeId);
    byEmp.set(empId, [...(byEmp.get(empId) ?? []), a]);
  }
  const texts: Record<number, string> = {};
  for (const [empId, list] of Array.from(byEmp.entries())) {
    texts[empId] = list
      .slice()
      .sort((x, y) => x.startHour - y.startHour)
      .map((a) => fmtWorkDay(date, a.startHour, a.sentHomeHour ?? a.endHour))
      .join(" e ");
  }

  const outcome = new Map<number, { status: string; error: string | null }>();
  try {
    const r = await sendBroadcast({
      templateName: aviso.name,
      languageCode: aviso.language,
      bodyParam2ByEmployee: texts,
      employeeIds: Array.from(byEmp.keys()),
      note: `Aviso de escala ${date}`,
      createdById: by,
    });
    for (const rec of r.recipients) {
      if (rec.employeeId == null) continue;
      outcome.set(rec.employeeId, rec.status === "sent" ? { status: "sent", error: null } : { status: "failed", error: rec.error ?? rec.status });
    }
  } catch (err: any) {
    const error = String(err?.message ?? err);
    for (const empId of Array.from(byEmp.keys())) outcome.set(empId, { status: "failed", error });
  }

  const sentEmployees: number[] = [];
  for (const [empId, list] of Array.from(byEmp.entries())) {
    const o = outcome.get(empId) ?? { status: "failed", error: "sem destinatário (ficha inativa ou sem número)" };
    for (const a of list) {
      await db.execute(sql`
        INSERT INTO \`extras_dia_notices\` (assignmentId, employeeId, assignmentDate, status, error)
        VALUES (${a.id}, ${empId}, ${date}, ${o.status}, ${o.error ? o.error.slice(0, 300) : null})
        ON DUPLICATE KEY UPDATE status = VALUES(status), error = VALUES(error), sentAt = CURRENT_TIMESTAMP`);
      if (o.status === "sent") res.sent++;
      else res.failed++;
    }
    if (o.status === "sent") {
      sentEmployees.push(empId);
      try { await logWhatsappRequest(empId, "assignment", { targetDate: date }); } catch { /* segue */ }
    }
  }

  // 1.ª vez de sempre → morada e regras (também num só envio)
  if (sentEmployees.length) {
    const [prev] = (await db.execute(sql`
      SELECT employeeId FROM \`extras_rules_sent\`
       WHERE employeeId IN (${sql.join(sentEmployees.map((id) => sql`${id}`), sql`, `)})`)) as any;
    const already = new Set(((prev as any[]) ?? []).map((r) => Number(r.employeeId)));
    const firstTimers = sentEmployees.filter((id) => !already.has(id));
    if (firstTimers.length) {
      try {
        const r = await sendBroadcast({ templateName: regras.name, languageCode: regras.language, employeeIds: firstTimers, note: "Morada e regras (1.º turno)", createdById: by });
        for (const rec of r.recipients) {
          if (rec.status === "sent" && rec.employeeId != null) {
            await db.execute(sql`INSERT IGNORE INTO \`extras_rules_sent\` (employeeId) VALUES (${rec.employeeId})`);
            res.rulesSent++;
          }
        }
      } catch (err) {
        console.warn("[extras-auto] morada e regras falhou:", err);
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

  // Quem tem formação obrigatória por concluir não entra no preenchimento automático.
  const { employeesMissingTraining } = await import("./trainingPaths");
  const allCands = await listDriverCandidates(input.date);
  const untrained = await employeesMissingTraining(allCands.map((c) => c.id));
  const cands = allCands.filter((c) => !untrained.has(c.id));
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

export interface PendingRequest {
  id: number;
  kind: string;
  targetDate: string | null;
  weekStart: string | null;
  shift: string | null;
  fromHour: number | null;
  toHour: number | null;
}

/**
 * Que resposta automática dar (PURA — a regra testada da idempotência):
 *  - aviso de escala: "sim"/"não" só enquanto o aviso estiver por responder;
 *  - pedido de um dia: marca e agradece 1× — se o pedido já foi respondido
 *    ou o dia/turno já está marcado, não volta a marcar nem a responder;
 *  - pedido da semana: o link do formulário vai no MÁXIMO 1× por pedido
 *    (antes ia a cada "ok"/"sim" durante 10 dias).
 */
export function decideAutoReply(input: {
  pending: Pick<PendingRequest, "kind" | "targetDate" | "weekStart"> | null;
  verdict: "yes" | "no" | "unclear";
  alreadyAnswered: boolean;
  dayAlreadyMarked: boolean;
}): WhatsappReplyOutcome["action"] {
  const { pending, verdict } = input;
  if (!pending || verdict === "unclear" || input.alreadyAnswered) return "none";
  if (pending.kind === "assignment" && pending.targetDate) return verdict === "yes" ? "confirmed" : "declined";
  if (verdict !== "yes") return "none";
  if (pending.targetDate) return input.dayAlreadyMarked ? "none" : "day_marked";
  if (pending.weekStart) return "week_link";
  return "none";
}

/** Último pedido (email ou WhatsApp) feito a este colaborador nos últimos 10 dias. */
async function latestRequestFor(employeeId: number): Promise<PendingRequest | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const [rows] = (await db.execute(sql`
      SELECT id, kind, targetDate, weekStart, shift, fromHour, toHour
        FROM \`availability_request_log\`
       WHERE employeeId = ${employeeId} AND sentAt >= DATE_SUB(NOW(), INTERVAL 10 DAY)
       ORDER BY sentAt DESC, id DESC LIMIT 1`)) as any;
    const r = (rows as any[])?.[0];
    if (!r) return null;
    return {
      id: Number(r.id),
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

async function requestAlreadyAnswered(requestId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return true;
  await ensureTables();
  const [rows] = (await db.execute(sql`SELECT 1 AS x FROM \`whatsapp_request_answers\` WHERE requestId = ${requestId} LIMIT 1`)) as any;
  return ((rows as any[]) ?? []).length > 0;
}

/** Reserva a resposta a um pedido (corrida entre duas mensagens seguidas). false = já respondido. */
async function claimRequestAnswer(requestId: number, employeeId: number, action: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  await ensureTables();
  return extractAffectedRows(await db.execute(sql`
    INSERT IGNORE INTO \`whatsapp_request_answers\` (requestId, employeeId, action)
    VALUES (${requestId}, ${employeeId}, ${action})`)) > 0;
}

async function dayAlreadyMarked(employeeId: number, day: string, shift: string | null): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  try {
    const col = shift === "night" ? sql`night` : sql`morning`;
    const [rows] = (await db.execute(sql`
      SELECT 1 AS x FROM extras_availability WHERE employeeId = ${employeeId} AND day = ${day} AND ${col} = 1 LIMIT 1`)) as any;
    return ((rows as any[]) ?? []).length > 0;
  } catch {
    return false;
  }
}

/**
 * Trata a mensagem de um colaborador conhecido que chegou pelo WhatsApp.
 * Idempotente: cada pedido é respondido no máximo 1× (whatsapp_request_answers).
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

    const action = decideAutoReply({
      pending,
      verdict,
      alreadyAnswered: await requestAlreadyAnswered(pending.id),
      dayAlreadyMarked:
        pending.kind !== "assignment" && pending.targetDate ? await dayAlreadyMarked(input.employeeId, pending.targetDate, pending.shift) : false,
    });
    if (action === "none") return { action };

    const { replyToConversation } = await import("./whatsappInbox");
    const { employees } = await import("../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const [emp] = await db.select({ fullName: employees.fullName, projectId: employees.projectId }).from(employees).where(eq(employees.id, input.employeeId)).limit(1);
    const name = emp?.fullName ?? `#${input.employeeId}`;

    if (action === "confirmed" || action === "declined") {
      await ensureTables();
      const col = action === "confirmed" ? sql`confirmedAt` : sql`declinedAt`;
      const upd = await db.execute(sql`
        UPDATE \`extras_dia_notices\` SET ${col} = CURRENT_TIMESTAMP
         WHERE employeeId = ${input.employeeId} AND assignmentDate = ${pending.targetDate}
           AND confirmedAt IS NULL AND declinedAt IS NULL`);
      if (extractAffectedRows(upd) === 0) return { action: "none" }; // já tinha respondido
      await claimRequestAnswer(pending.id, input.employeeId, action);
      if (action === "confirmed") {
        const reply = "Obrigado! Fica confirmado ✅ Até lá.";
        await replyToConversation(input.conversationId, reply, null);
        return { action, reply };
      }
      await notifyBackoffice(
        `${name} não pode ir ao turno de ${pending.targetDate}`,
        `Respondeu "não" ao aviso de escala por WhatsApp. Procura substituto.`,
        "/extras-dia",
        { projectId: emp?.projectId ?? null },
      );
      const reply = "Obrigado por avisares. Vamos tratar da substituição.";
      await replyToConversation(input.conversationId, reply, null);
      return { action, reply };
    }

    // Pedido do dia / da semana: reserva ANTES de agir (duas mensagens seguidas
    // não geram duas respostas).
    if (!(await claimRequestAnswer(pending.id, input.employeeId, action))) return { action: "none" };

    if (action === "day_marked" && pending.targetDate) {
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
      return { action, reply };
    }

    if (action === "week_link" && pending.weekStart) {
      const reply = `Obrigado! Indica aqui os dias e horas em que podes (${fmtWeek(pending.weekStart)}): ${appOrigin()}/disponibilidade?week=${pending.weekStart}`;
      await replyToConversation(input.conversationId, reply, null);
      return { action, reply };
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
  const { and, eq, isNull, sql } = await import("drizzle-orm");
  const [lead] = await db.select().from(extraLeads).where(eq(extraLeads.id, leadId)).limit(1);
  const { assertLeadVisible } = await import("./extraLeads");
  assertLeadVisible(lead);
  if (lead.employeeId) throw new Error("Este lead já tem ficha de extra.");
  if (!lead.email && !lead.phone) throw new Error("O lead não tem email nem telefone — acrescenta um contacto antes de converter.");

  const { getProjects } = await import("./db");
  const { resolveApprovalCostCenter, planCostCenterAssignment } = await import("./webIntake");
  const costCenter = resolveApprovalCostCenter((await getProjects()) as any, projectId);

  // Reserva o lead ANTES de criar a ficha: dois cliques (ou duas pessoas) ao
  // mesmo tempo já não criam duas fichas. employeeId 0 = "a converter".
  const claim = await db.update(extraLeads).set({ employeeId: 0 }).where(and(eq(extraLeads.id, leadId), isNull(extraLeads.employeeId)));
  if (Number((claim as any)[0]?.affectedRows ?? (claim as any).affectedRows ?? 0) !== 1) {
    throw new Error("Este lead já está a ser convertido.");
  }

  try {
    let employeeId: number | null = null;
    let created = false;

    // 1) Já existe ficha com este telemóvel (ativa OU inativa)? Liga-se a ela.
    if (lead.phoneE164) {
      const { normalizePhoneE164 } = await import("../shared/phone");
      const rows = await db.select({ id: employees.id, phone: employees.phone }).from(employees).where(sql`${employees.phone} IS NOT NULL`);
      const hit = rows.find((r) => r.phone && normalizePhoneE164(r.phone) === lead.phoneE164);
      if (hit) employeeId = hit.id;
    }
    // 2) Pelo email (encontra ou cria a ficha)
    if (employeeId == null && lead.email) {
      const { findOrCreateExtraByEmail } = await import("./identity");
      const r = await findOrCreateExtraByEmail(db as any, lead.email, { fullName: lead.fullName, phone: lead.phone, projectId });
      employeeId = r.id;
      created = r.created;
    }
    // 3) Só telefone e sem ficha: cria
    if (employeeId == null) {
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

    if (!created) {
      // Ficha existente: reativa (senão não aparece na disponibilidade) e
      // atribui o centro de custos se a regra o permitir.
      const [emp] = await db.select({ projectId: employees.projectId, isActive: employees.isActive }).from(employees).where(eq(employees.id, employeeId)).limit(1);
      const patch: Record<string, unknown> = {};
      if (emp && emp.isActive !== 1) patch.isActive = 1;
      if (planCostCenterAssignment(emp?.projectId ?? null, projectId, false).assign) patch.projectId = projectId;
      if (Object.keys(patch).length) await db.update(employees).set(patch as any).where(eq(employees.id, employeeId));
    }

    const convertedAt = new Date().toISOString().slice(0, 19).replace("T", " ");
    await db.update(extraLeads).set({ status: "converted", employeeId, projectId, convertedAt }).where(eq(extraLeads.id, leadId));
    // Funil único: a candidatura pendente da mesma pessoa fica aprovada e ligada.
    const { approveApplicationForConvertedLead } = await import("./extraLeadsSync");
    await approveApplicationForConvertedLead(lead, employeeId, userId);
    const { logActivity } = await import("./db");
    await logActivity({
      userId: userId ?? 0,
      action: "extra_lead_convert",
      entity: "extra_leads",
      entityId: leadId,
      details: `Lead convertido em extra: ${lead.fullName} → employee ${employeeId}${created ? " (criado)" : " (existente)"} · ${costCenter.projectName}${lead.notes ? ` · notas do lead: ${lead.notes}` : ""}`,
    });
    // Percurso de onboarding por defeito (best-effort — nunca parte a conversão).
    const { autoAssignOnboarding } = await import("./trainingPaths");
    await autoAssignOnboarding(employeeId, "lead_convert", userId);
    return { employeeId, created, city: costCenter.city };
  } catch (err) {
    // Falhou: liberta a reserva para se poder tentar de novo
    await db.update(extraLeads).set({ employeeId: null }).where(and(eq(extraLeads.id, leadId), eq(extraLeads.employeeId, 0)));
    throw err;
  }
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

  // Passagem de turno em falta (~15:30 manhã / ~03:30 noite, Lisboa): lembrete
  // aos team leaders do turno + backoffice, 1× por (dia, turno, cidade).
  try {
    const { runHandoverReminders } = await import("./shiftHandoverAutomation");
    report.details["handover-reminders"] = await runHandoverReminders(now);
    report.ran.push("handover-reminders");
  } catch (err: any) {
    report.errors.push(`handover-reminders: ${String(err?.message ?? err).slice(0, 200)}`);
  }

  await runLeadAutomation(clock, now, report, run);

  // WhatsApp: re-tenta downloads de media falhados (lote limitado) e limpa
  // status pendentes antigos.
  try {
    const { runWhatsappMaintenance } = await import("./whatsappInbound");
    report.details["whatsapp-maintenance"] = await runWhatsappMaintenance();
    report.ran.push("whatsapp-maintenance");
  } catch (err: any) {
    report.errors.push(`whatsapp-maintenance: ${String(err?.message ?? err).slice(0, 200)}`);
  }

  // Tarefas: checklists recorrentes do dia (idempotente) + avisos de atraso /
  // conclusão (antes só com o botão manual de admin). TASKS_AUTOMATION=off desliga.
  try {
    const { runTaskAutomation } = await import("./tasksService");
    report.details.tasks = await runTaskAutomation(now);
    report.ran.push("tasks");
  } catch (err: any) {
    report.errors.push(`tasks: ${String(err?.message ?? err).slice(0, 200)}`);
  }

  // Ocorrências/Perdidos em atraso: 1 resumo por pessoa por dia (CASE_REMINDERS=off desliga).
  try {
    const { runCaseSlaReminders } = await import("./caseOps");
    const out = await runCaseSlaReminders(now, clock.hour);
    report.details["case-sla"] = out;
    if (!out.skipped) report.ran.push("case-sla");
  } catch (err: any) {
    report.errors.push(`case-sla: ${String(err?.message ?? err).slice(0, 200)}`);
  }

  // Formação: lembretes, atrasos e recertificação (TRAINING_REMINDERS=off desliga).
  try {
    const { runTrainingAutomation } = await import("./trainingPaths");
    const out = await runTrainingAutomation(now, clock.hour);
    report.details.training = out;
    if (!out.skipped) report.ran.push("training");
  } catch (err: any) {
    report.errors.push(`training: ${String(err?.message ?? err).slice(0, 200)}`);
  }
  return report;
}

// ─── Leads de recrutamento (funil, SLA, lembrete) ───────────────────────────

/** Hora de Lisboa a partir da qual sai o resumo diário de leads à espera. */
const LEAD_SLA_NOTICE_HOUR = 9;

/**
 * Tarefas horárias dos leads:
 *  - importação idempotente das candidaturas pendentes e dos emails de
 *    recrutamento (cada origem só é processada 1×, ver extraLeadsSync);
 *  - resumo diário (a partir das 9h) dos leads à espera (SLA) ao backoffice;
 *  - lembrete automático (seg–sáb, 10h–19h, 1× por dia): reenvia o template de
 *    recrutamento aos `contacted` sem resposta há >3 dias, no máximo 2 envios
 *    por lead no total.
 */
async function runLeadAutomation(
  clock: LisbonClock,
  now: Date,
  report: AutomationReport,
  run: (key: string, fn: () => Promise<unknown>) => Promise<void>,
): Promise<void> {
  try {
    const { syncApplicationLeads, syncEmailLeads } = await import("./extraLeadsSync");
    const apps = await syncApplicationLeads();
    const emails = await syncEmailLeads();
    report.details["leads-sync"] = { applications: apps, emails };
    report.ran.push("leads-sync");
  } catch (err: any) {
    report.errors.push(`leads-sync: ${String(err?.message ?? err).slice(0, 200)}`);
  }

  const { selectSlaLeads, selectReminderLeads, isLeadReminderTime } = await import("../shared/extraLeadsFunnel");
  const loadOpenLeads = async () => {
    const db = await getDb();
    if (!db) return [];
    const { extraLeads } = await import("../drizzle/schema");
    const { and, inArray, isNull } = await import("drizzle-orm");
    return db
      .select({
        id: extraLeads.id,
        status: extraLeads.status,
        createdAt: extraLeads.createdAt,
        lastContactedAt: extraLeads.lastContactedAt,
        lastInboundAt: extraLeads.lastInboundAt,
        contactCount: extraLeads.contactCount,
        phoneE164: extraLeads.phoneE164,
      })
      .from(extraLeads)
      // Quem pediu STOP não entra no SLA nem no lembrete automático.
      .where(and(inArray(extraLeads.status, ["new", "contacted"]), isNull(extraLeads.optedOutAt)));
  };

  if (clock.hour >= LEAD_SLA_NOTICE_HOUR) {
    await run(`leads-sla:${clock.date}`, async () => {
      const { newStale, contactedStale } = selectSlaLeads(await loadOpenLeads(), now.getTime());
      if (newStale.length || contactedStale.length) {
        await notifyBackoffice(
          `Leads à espera: ${newStale.length + contactedStale.length}`,
          `${newStale.length} novo(s) sem contacto há mais de 24h · ${contactedStale.length} contactado(s) sem resposta há mais de 3 dias.`,
          "/extras-leads",
        );
      }
      return { newStale: newStale.length, contactedStale: contactedStale.length };
    });
  }

  if (isLeadReminderTime(clock) && process.env.LEAD_REMINDERS !== "off") {
    if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
      report.skipped.push("leads-reminder (WhatsApp não configurado)");
      return;
    }
    await run(`leads-reminder:${clock.date}`, async () => {
      const due = selectReminderLeads(await loadOpenLeads(), now.getTime());
      if (!due.length) return { due: 0, sent: 0 };
      const { contactExtraLeads } = await import("./extraLeads");
      const { LEAD_RECRUITMENT_TEMPLATE_ID } = await import("../shared/whatsappTemplate");
      const { getSystemUserId } = await import("./db");
      const r = await contactExtraLeads({
        leadIds: due.map((l) => l.id),
        templateId: LEAD_RECRUITMENT_TEMPLATE_ID,
        createdById: await getSystemUserId(),
        note: "lembrete automático a leads sem resposta",
      });
      return { due: due.length, sent: r.sent, failed: r.failed };
    });
  }
}
