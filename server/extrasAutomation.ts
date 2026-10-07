/**
 * Automação dos Extras (Jorge, 24 set 2026) — pontos 5 a 9 das melhorias:
 *
 *  5. Pedido de disponibilidade AUTOMÁTICO à quinta (semana seguinte, email +
 *     WhatsApp) e LEMBRETE ao sábado a quem ainda não respondeu.
 *  6. "SIM" pelo WhatsApp: a resposta a um pedido de um dia marca a
 *     disponibilidade; a resposta a um aviso de escala CONFIRMA o turno (um
 *     "não" avisa o backoffice); a um pedido da semana devolve o link.
 *  7. Aviso por WhatsApp a quem está escalado (template `driver_shift_notice`,
 *     com dia e horas e os botões "Confirmo" / "Não posso", ligados ao turno
 *     pelo `context.id`), à tarde para o dia seguinte ou por botão; na 1.ª vez
 *     de sempre segue também a morada e as regras (texto livre com a janela
 *     de 24 h aberta, senão o template `morada_e_regras`).
 *  8. Escala sugerida preenchida com quem está disponível + alerta de horas
 *     sem gente suficiente (no ecrã e, à tarde, notificação para amanhã).
 *  9. Converter um lead de recrutamento numa ficha de extra (com cidade).
 * 10. Leads (funil único): importação de candidaturas/emails, resumo diário
 *     dos leads à espera e lembrete automático a quem não respondeu.
 *
 * Tudo corre de hora a hora (agendador /api/cron/tick → trabalho extras-auto;
 * à mão em /api/cron/extras-auto), que decide pela hora de Lisboa o que está
 * na altura; cada tarefa fica registada numa tabela de execuções (chave
 * única) para nunca correr duas vezes. Com prazo: os passos que não couberem
 * ficam para a corrida seguinte (runStepsWithDeadline).
 */
import { isFeatureEnabled } from "./_core/featureFlags";
import { automationFlagDefault } from "../shared/appSettings";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { extractAffectedRows } from "./availabilityFormToken";
import { driverCityFrom, hasDriverTemplate, type City, type DriverMessage } from "../shared/driverTemplates";
import type { HourWindow } from "../shared/availabilityWindow";
import { NOT_EXTRA_NOTICE_REASON, noticeSpans } from "../shared/shiftNotice";

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
  /** Janelas do dia operacional (operationalDayWindows); vazio = não pode. */
  windows: readonly HourWindow[];
  /** true = cidade da ficha bate com a da escala; null = ficha sem cidade. */
  cityMatch: boolean | null;
  /** false = funcionário (não extra): só entra na escala à mão (2 out 2026). */
  isExtra?: boolean;
}
export interface AutofillPick { employeeId: number; personName: string; level: AutofillCandidate["level"]; startHour: number; endHour: number }

/**
 * Janela (horas) em que o extra pode, para este turno; null = não pode. Usa
 * as MESMAS janelas do dia operacional da proposta automática e da grelha
 * (shared/availabilityWindow.ts → operationalDayWindows), cortadas ao turno;
 * com duas janelas, fica a mais comprida (≥ 3h).
 */
export function availableWindow(windows: readonly HourWindow[], shift: ShiftKey): { from: number; to: number } | null {
  const bounds = shift === "morning" ? { from: 3, to: 15 } : { from: 15, to: 27 };
  let best: { from: number; to: number } | null = null;
  for (const w of windows) {
    const from = Math.max(bounds.from, w.from);
    const to = Math.min(bounds.to, w.to);
    if (to - from >= 3 && (!best || to - from > best.to - best.from)) best = { from, to };
  }
  return best;
}

/**
 * Distribui os turnos sugeridos que ainda faltam pelos extras disponíveis.
 * Os primeiros `existing` turnos sugeridos (os mais compridos) contam como já
 * cobertos por quem já está escalado. Só EXTRAS da cidade da escala (Jorge,
 * 2 out 2026): quem não tem cidade, é de outra cidade ou é funcionário nunca
 * entra no preenchimento automático.
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
    .filter((c) => c.cityMatch === true && c.isExtra !== false && !alreadyAssigned.has(c.id))
    .map((c) => ({ c, win: availableWindow(c.windows, shift) }))
    .filter((x): x is { c: AutofillCandidate; win: { from: number; to: number } } => x.win != null)
    .sort((a, b) => a.c.fullName.localeCompare(b.c.fullName));

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
    \`changeRequestedAt\` TIMESTAMP NULL,
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

export function appOrigin(): string {
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

/** Centro de custos (projeto) da ficha — dá a cidade das notificações. */
async function employeeProjectId(employeeId: number): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const { employees } = await import("../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const [e] = await db.select({ projectId: employees.projectId }).from(employees).where(eq(employees.id, employeeId)).limit(1);
  return e?.projectId ?? null;
}

/** O utilizador vê a cidade/centro `projectId`? (todas as cidades → sim). PURA. */
export function userSeesProject(access: { all: boolean; projectIds: number[] }, projectId: number): boolean {
  return access.all || access.projectIds.includes(projectId);
}

// ─── 5. Pedido de disponibilidade automático + lembrete ─────────────────────

export interface RequestRunResult {
  emailSent: number;
  whatsappSent: number;
  targets: number;
  /** Extras sem cidade com templates: não recebem o WhatsApp (nunca se assume Lisboa). */
  whatsappNoCity?: number;
}

/**
 * Cidade do registo de templates para cada extra (ficha → candidatura →
 * morada, `server/employeeCity.ts`). Os que não têm cidade, ou cuja cidade não
 * tem template para `message`, vêm em `noCity`.
 */
async function driverCitiesForEmployees(ids: number[], message: DriverMessage): Promise<{ cityByEmployee: Record<number, City>; noCity: number[] }> {
  const { resolveCitiesForEmployeeIds } = await import("./employeeCity");
  const cities = await resolveCitiesForEmployeeIds(ids);
  const cityByEmployee: Record<number, City> = {};
  const noCity: number[] = [];
  for (const id of ids) {
    const city = driverCityFrom(cities.get(id)?.city ?? null);
    if (city && hasDriverTemplate(city, message)) cityByEmployee[id] = city;
    else noCity.push(id);
  }
  return { cityByEmployee, noCity };
}

/** Parte um mapa id → cidade em sub-mapas por cidade (jobs: uma chamada por cidade). PURA. */
export function splitByCity(cityByEmployee: Record<number, City>): [City, Record<number, City>][] {
  const out = new Map<City, Record<number, City>>();
  for (const [id, city] of Object.entries(cityByEmployee)) {
    out.set(city, { ...(out.get(city) ?? {}), [Number(id)]: city });
  }
  return Array.from(out.entries());
}

export async function sendAvailabilityRequest(weekStart: string, employeeIds: number[] | null, note: string | null, autoKind: "availability_request" | "availability_reminder" = "availability_request"): Promise<RequestRunResult> {
  const { sendWeeklyAvailabilityRequest } = await import("./extrasAvailability");
  const out: RequestRunResult = { emailSent: 0, whatsappSent: 0, targets: 0 };
  if (employeeIds && employeeIds.length === 0) return out;

  const email = await sendWeeklyAvailabilityRequest({ weekStart, origin: appOrigin(), note, employeeIds, autoKind });
  out.emailSent = email.sent;
  out.targets = email.total;

  if (process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) {
    const { sendBroadcast } = await import("./whatsappBroadcast");
    const { DEFAULT_WHATSAPP_TEMPLATE_ID } = await import("../shared/whatsappTemplate");
    const { getSystemUserId } = await import("./db");
    // Template da cidade de CADA extra (registo shared/driverTemplates.ts).
    const { listActiveExtras } = await import("./extrasAvailability");
    const ids = employeeIds ?? (await listActiveExtras()).map((e) => e.id);
    const { cityByEmployee, noCity } = await driverCitiesForEmployees(ids, "AVAILABILITY");
    out.whatsappNoCity = noCity.length;
    if (noCity.length) {
      console.warn(`[extras-auto] pedido de disponibilidade ${weekStart}: ${noCity.length} extra(s) sem cidade com templates ficaram sem WhatsApp`);
    }
    const createdById = await getSystemUserId();
    // Uma chamada por cidade: um template do Porto por aprovar não trava Lisboa.
    for (const [city, sub] of splitByCity(cityByEmployee)) {
      try {
        const wa = await sendBroadcast({
          templateId: DEFAULT_WHATSAPP_TEMPLATE_ID,
          cityByEmployee: sub,
          bodyParam2: fmtWeek(weekStart),
          weekStart,
          note: note ?? "Pedido automático de disponibilidade",
          createdById,
        });
        out.whatsappSent += wa.sent;
        for (const r of wa.recipients) {
          if (r.status === "sent" && r.employeeId != null) {
            try { await logWhatsappRequest(r.employeeId, "week", { weekStart }); } catch { /* segue */ }
          }
        }
      } catch (err) {
        console.warn(`[extras-auto] pedido de disponibilidade ${weekStart} (${city}) falhou:`, err);
      }
    }
  }
  return out;
}

/**
 * Quem recebe o pedido automático: só extras COM cidade (D43, Jorge, 3 out
 * 2026 — sem cidade não entram na escala; o RH trata primeiro da cidade, ver
 * employeeCityFix). `onlyPending` = o lembrete, só a quem ainda não respondeu. PURA.
 */
export function availabilityRequestTargets(
  extras: readonly { employeeId: number; city: string | null; responded: boolean }[],
  onlyPending: boolean,
): number[] {
  return extras.filter((e) => e.city != null && (!onlyPending || !e.responded)).map((e) => e.employeeId);
}

/** Quinta: pedido aos extras ativos COM cidade para a semana seguinte. */
export async function runWeeklyRequest(weekStart: string): Promise<RequestRunResult> {
  const { getWeekOverview } = await import("./extrasAvailability");
  const ov = await getWeekOverview(weekStart);
  return sendAvailabilityRequest(weekStart, availabilityRequestTargets(ov.extras, false), null);
}

/** Sábado: lembrete só a quem (com cidade) ainda não respondeu para essa semana. */
export async function runReminder(weekStart: string): Promise<RequestRunResult> {
  const { getWeekOverview } = await import("./extrasAvailability");
  const ov = await getWeekOverview(weekStart);
  return sendAvailabilityRequest(weekStart, availabilityRequestTargets(ov.extras, true), "Lembrete: ainda não indicaste a tua disponibilidade", "availability_reminder");
}

// ─── 7. Aviso de escala por WhatsApp ────────────────────────────────────────

export interface NoticeRow {
  assignmentId: number; status: string; sentAt: string; confirmedAt: string | null; declinedAt: string | null; error: string | null;
  /** O aviso foi de uma versão ANTERIOR da linha (mudaram as horas/pessoa depois): já não vale. */
  outdated: boolean;
  /** Carregou em "Preciso de alterar" no turno_confirmado (0550). */
  changeRequestedAt: string | null;
}

export async function listNotices(date: string, city: string | null = null): Promise<NoticeRow[]> {
  const db = await getDb();
  if (!db) return [];
  await ensureTables();
  const byCity = city ? sql` AND a.city = ${city}` : sql``;
  // Desatualizado: a linha mudou (versão > 1) e a versão ATUAL não tem aviso enviado.
  const [rows] = (await db.execute(sql`
    SELECT n.assignmentId, n.status, n.sentAt, n.confirmedAt, n.declinedAt, n.changeRequestedAt, n.error,
      (a.version > 1 AND NOT EXISTS (SELECT 1 FROM extras_dia_notifications x
        WHERE x.assignmentId = n.assignmentId AND x.version = a.version AND x.kind = 'scheduled' AND x.status = 'sent')) AS outdated
      FROM \`extras_dia_notices\` n
      LEFT JOIN extras_dia_assignments a ON a.id = n.assignmentId
     WHERE n.assignmentDate = ${date}${byCity}`)) as any;
  return (rows as any[]).map((r) => ({
    assignmentId: Number(r.assignmentId),
    status: String(r.status),
    sentAt: String(r.sentAt),
    confirmedAt: r.confirmedAt ? String(r.confirmedAt) : null,
    declinedAt: r.declinedAt ? String(r.declinedAt) : null,
    changeRequestedAt: r.changeRequestedAt ? String(r.changeRequestedAt) : null,
    error: r.error ? String(r.error) : null,
    outdated: Number(r.outdated ?? 0) === 1,
  }));
}

export interface NotifyResult { total: number; sent: number; failed: number; skipped: number; rulesSent: number; optedOut: number }

/**
 * Morada e regras como TEXTO LIVRE a quem tem a janela de 24 h aberta (a
 * última mensagem dessa pessoa chegou há menos de 24 h). O texto é o do
 * próprio template na Meta (cabeçalho, corpo, rodapé, links), com negrito de
 * um asterisco — o conteúdo é o mesmo nos dois caminhos. Devolve quem recebeu;
 * os outros seguem pelo template. Sem leitura do template ou com qualquer
 * falha, ninguém recebe por aqui (o template é o recurso). Nunca lança.
 */
async function sendRulesAsFreeText(employeeIds: number[], templateName: string, language: string): Promise<Set<number>> {
  const sent = new Set<number>();
  try {
    const db = await getDb();
    if (!db || !employeeIds.length) return sent;
    const { getTemplateMeta } = await import("./whatsappTemplateMeta");
    const meta = await getTemplateMeta(templateName, language);
    const text = meta.available && meta.lookup.ok ? (meta.lookup.analysis.freeText ?? "").trim() : "";
    if (!text) return sent;

    const [rows] = (await db.execute(sql`
      SELECT id, employeeId, DATE_FORMAT(lastInboundAt, '%Y-%m-%d %H:%i:%s') AS lastInboundAt FROM whatsapp_conversations
       WHERE employeeId IN (${sql.join(employeeIds.map((id) => sql`${id}`), sql`, `)}) AND optedOutAt IS NULL
       ORDER BY lastMessageAt DESC`)) as any;
    const { deriveWindowState, replyToConversation } = await import("./whatsappInbox");
    for (const r of (rows as any[]) ?? []) {
      const empId = Number(r.employeeId);
      if (sent.has(empId)) continue; // uma conversa por pessoa (a mais recente)
      const lastInboundAt = r.lastInboundAt == null ? null : String(r.lastInboundAt);
      if (deriveWindowState(lastInboundAt).windowState !== "open") continue;
      const res = await replyToConversation(Number(r.id), text, null);
      if (res.ok) sent.add(empId);
    }
  } catch (err: any) {
    console.warn("[extras-auto] morada e regras em texto livre:", String(err?.message ?? err).slice(0, 160));
  }
  return sent;
}

/** Motivo registado quando quem está na escala não é extra (não recebe avisos). */
export const NOT_EXTRA_NO_NOTICE = NOT_EXTRA_NOTICE_REASON;

/**
 * Avisa por WhatsApp quem está escalado em `date` e ainda não foi avisado
 * NESTA versão da linha (tabela extras_dia_notifications; a versão sobe
 * quando mudam pessoa/dia/horas). Só linhas CONFIRMADAS — as propostas
 * automáticas por confirmar não são avisadas. `city` limita a uma cidade;
 * `respectHold` salta os dias/cidades com envio automático suspenso.
 * Quem pediu STOP não recebe (sendBroadcast) e fica registado como tal.
 */
export async function notifyAssignments(
  date: string,
  opts: { city?: string | null; shift?: "morning" | "night" | null; createdById?: number | null; respectHold?: boolean } = {},
): Promise<NotifyResult> {
  const db = await getDb();
  const res: NotifyResult = { total: 0, sent: 0, failed: 0, skipped: 0, rulesSent: 0, optedOut: 0 };
  if (!db) return res;
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error("WhatsApp não está configurado (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID).");
  }
  await ensureTables();
  const { extrasDiaAssignments } = await import("../drizzle/schema");
  const { and, eq, isNotNull } = await import("drizzle-orm");
  const conds = [eq(extrasDiaAssignments.assignmentDate, date), isNotNull(extrasDiaAssignments.employeeId), eq(extrasDiaAssignments.status, "confirmed")];
  if (opts.city) conds.push(eq(extrasDiaAssignments.city, opts.city));
  if (opts.shift) conds.push(eq(extrasDiaAssignments.shift, opts.shift));
  let rows = await db.select().from(extrasDiaAssignments).where(and(...conds));
  const sched = await import("./extrasSchedule");
  if (opts.respectHold) {
    const held = await sched.heldCities(date);
    rows = rows.filter((a) => !held.has(a.city));
  }
  const { pendingScheduleNotifications, scheduleMessageText, whatsappOutcomeStatus } = await import("../shared/extrasSchedule");
  // Um aviso antigo de uma versão anterior (horas mudadas) não impede o aviso novo.
  const legacySent = new Set((await listNotices(date)).filter((n) => n.status === "sent" && !n.outdated).map((n) => n.assignmentId));
  const log = await sched.loadNotifyLog(rows.map((a) => a.id));
  const candidates = pendingScheduleNotifications(rows, log, "whatsapp", legacySent);
  res.total = rows.length;

  // Reserva cada linha (corrida entre o cron e o botão: só um envia).
  const pending: typeof rows = [];
  for (const a of candidates) {
    if (await sched.claimNotification(a, "scheduled", "whatsapp")) pending.push(a);
  }
  res.skipped = rows.length - pending.length;
  if (!pending.length) return res;

  const { sendBroadcast } = await import("./whatsappBroadcast");
  const { findWhatsAppTemplate, templateForCity } = await import("../shared/whatsappTemplate");
  const aviso = findWhatsAppTemplate("aviso_trabalho")!;
  const regras = findWhatsAppTemplate("morada_regras")!;
  // Template da cidade do TURNO (é onde a pessoa vai trabalhar: a morada e as
  // regras têm de ser as desse sítio). Cidade sem templates → não se envia.
  const { getSystemUserId } = await import("./db");
  const by = opts.createdById ?? (await getSystemUserId());
  const settings = await sched.loadScheduleSettings();

  // UM envio por execução: o dia/horas/cidade de cada pessoa vai no {{2}}
  // dela. Quem tem dois turnos no dia recebe um só aviso com os dois horários.
  const byEmp = new Map<number, typeof pending>();
  for (const a of pending) {
    const empId = Number(a.employeeId);
    byEmp.set(empId, [...(byEmp.get(empId) ?? []), a]);
  }
  // O texto leva TODAS as horas confirmadas da pessoa nesta seleção (não só as
  // linhas por avisar) — é o mesmo texto da pré-visualização (shared/shiftNotice.ts)
  // e o mesmo que segue no turno_confirmado (`shiftText`).
  const texts: Record<number, string> = {};
  for (const [empId, list] of Array.from(byEmp.entries())) {
    const city = list[0].city;
    texts[empId] = shiftText(
      date,
      rows.filter((a) => Number(a.employeeId) === empId && a.city === city),
      settings.meetingPoints as Record<string, string>,
      scheduleMessageText,
    );
  }

  const outcome = new Map<number, { status: string; error: string | null }>();
  // Só EXTRAS recebem avisos de escala (Jorge, 2 out 2026): um funcionário
  // posto à mão na escala fica escalado mas sem aviso, e fica registado porquê.
  const { extraIdsAmong } = await import("./extrasAvailability");
  const extrasSet = await extraIdsAmong(Array.from(byEmp.keys()));
  const toNotify = Array.from(byEmp.keys()).filter((id) => extrasSet.has(id));
  for (const empId of Array.from(byEmp.keys())) {
    if (!extrasSet.has(empId)) outcome.set(empId, { status: "no_contact", error: NOT_EXTRA_NO_NOTICE });
  }
  const cityByEmployee: Record<number, City> = {};
  for (const empId of toNotify) {
    const shiftCity = byEmp.get(empId)![0].city;
    const city = driverCityFrom(shiftCity);
    if (city && hasDriverTemplate(city, "WORK_NOTICE")) cityByEmployee[empId] = city;
    else outcome.set(empId, { status: "failed", error: `Sem template de aviso de WhatsApp para a cidade do turno (${shiftCity}).` });
  }
  // Uma chamada por cidade: um template do Porto por aprovar não trava Lisboa.
  for (const [, sub] of splitByCity(cityByEmployee)) {
    try {
      const r = await sendBroadcast({
        templateId: aviso.id,
        cityByEmployee: sub,
        bodyParam2ByEmployee: texts,
        note: `Aviso de escala ${date}`,
        createdById: by,
      });
      for (const rec of r.recipients) {
        if (rec.employeeId == null) continue;
        outcome.set(rec.employeeId, { status: whatsappOutcomeStatus(rec.status), error: rec.status === "sent" ? null : (rec.error ?? rec.status) });
      }
    } catch (err: any) {
      const error = String(err?.message ?? err);
      for (const empId of Object.keys(sub).map(Number)) outcome.set(empId, { status: "failed", error });
    }
  }

  const sentEmployees: number[] = [];
  for (const [empId, list] of Array.from(byEmp.entries())) {
    const o = outcome.get(empId) ?? { status: "no_contact", error: "sem destinatário (ficha inativa ou sem número)" };
    for (const a of list) {
      await sched.finishNotification(a, "scheduled", "whatsapp", o.status, o.error);
      // Registo usado pela resposta "sim/não" do WhatsApp (nova versão → nova confirmação).
      await db.execute(sql`
        INSERT INTO \`extras_dia_notices\` (assignmentId, employeeId, assignmentDate, status, error)
        VALUES (${a.id}, ${empId}, ${date}, ${o.status === "sent" ? "sent" : "failed"}, ${o.error ? o.error.slice(0, 300) : null})
        ON DUPLICATE KEY UPDATE status = VALUES(status), error = VALUES(error), sentAt = CURRENT_TIMESTAMP,
          confirmedAt = IF(VALUES(status) = 'sent', NULL, confirmedAt), declinedAt = IF(VALUES(status) = 'sent', NULL, declinedAt),
          changeRequestedAt = IF(VALUES(status) = 'sent', NULL, changeRequestedAt)`);
      if (o.status === "sent") res.sent++;
      else if (o.status === "opted_out") res.optedOut++;
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
    // Morada e regras da cidade do turno (cada cidade tem a sua morada).
    // Cidade sem morada própria (Faro, por agora): não recebe a de outra cidade.
    const rulesCities: Record<number, City> = {};
    for (const id of firstTimers) if (cityByEmployee[id] && hasDriverTemplate(cityByEmployee[id], "ADDRESS_RULES")) rulesCities[id] = cityByEmployee[id];
    for (const [city, sub] of splitByCity(rulesCities)) {
      const ids = Object.keys(sub).map(Number);
      const tpl = templateForCity(regras, city)!;
      // Janela de 24 h aberta → o MESMO conteúdo em texto livre (sem template);
      // fechada → o template de morada e regras da cidade fica como recurso.
      const viaText = await sendRulesAsFreeText(ids, tpl.name, tpl.language);
      for (const empId of Array.from(viaText)) {
        await db.execute(sql`INSERT IGNORE INTO \`extras_rules_sent\` (employeeId) VALUES (${empId})`);
        res.rulesSent++;
      }
      const viaTemplate = ids.filter((id) => !viaText.has(id));
      if (!viaTemplate.length) continue;
      try {
        // A data na nota liga a mensagem ao turno (nova tentativa após 131049, 0375).
        const r = await sendBroadcast({
          templateId: regras.id,
          cityByEmployee: Object.fromEntries(viaTemplate.map((id) => [id, city])),
          note: `Morada e regras (1.º turno) ${date}`,
          createdById: by,
        });
        for (const rec of r.recipients) {
          if (rec.status === "sent" && rec.employeeId != null) {
            await db.execute(sql`INSERT IGNORE INTO \`extras_rules_sent\` (employeeId) VALUES (${rec.employeeId})`);
            res.rulesSent++;
          }
        }
      } catch (err) {
        console.warn(`[extras-auto] morada e regras (${city}) falhou:`, err);
      }
    }
  }
  try {
    const { logActivity } = await import("./db");
    await logActivity({
      userId: opts.createdById ?? 0,
      action: "extras_schedule_notify_whatsapp",
      entity: "extras_dia_assignments",
      details: `Aviso de escala por WhatsApp · ${date}${opts.city ? ` · ${opts.city}` : ""} · ${res.sent} enviado(s), ${res.failed} falhado(s), ${res.optedOut} com STOP`,
    });
  } catch { /* registo é best-effort */ }
  return res;
}

/**
 * Texto do turno de UMA pessoa num dia (dia, horas, cidade, ponto de
 * encontro). É o MESMO no {{day}} do aviso e no {{shift}} do turno_confirmado.
 * Quem tem dois turnos no dia recebe os dois horários.
 */
function shiftText(
  date: string,
  list: { city: string; startHour: number; endHour: number; sentHomeHour: number | null }[],
  meetingPoints: Record<string, string>,
  render: typeof import("../shared/extrasSchedule").scheduleMessageText,
): string {
  const city = list[0].city;
  return render({
    date,
    city,
    spans: noticeSpans(list),
    meetingPoint: meetingPoints[city] ?? null,
  });
}

/**
 * O extra aceitou o aviso de trabalho → envia o turno_confirmado da cidade do
 * turno, com o mesmo texto do aviso no {{shift}}. Devolve o texto enviado, ou
 * null se não foi possível (sem turno confirmado, cidade sem templates,
 * template por aprovar, falha de envio): quem chama responde então com o
 * texto livre de sempre. Nunca lança.
 */
async function sendShiftConfirmation(employeeId: number, date: string): Promise<string | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const { extrasDiaAssignments } = await import("../drizzle/schema");
    const { and, eq } = await import("drizzle-orm");
    const list = await db
      .select()
      .from(extrasDiaAssignments)
      .where(and(eq(extrasDiaAssignments.assignmentDate, date), eq(extrasDiaAssignments.employeeId, employeeId), eq(extrasDiaAssignments.status, "confirmed")));
    if (!list.length) return null;
    const city = driverCityFrom(list[0].city);
    // Cidade sem turno_confirmado (Faro, por agora) → fica a resposta de texto.
    if (!city || !hasDriverTemplate(city, "CONFIRMED_SHIFT")) return null;
    const sched = await import("./extrasSchedule");
    const { scheduleMessageText } = await import("../shared/extrasSchedule");
    const settings = await sched.loadScheduleSettings();
    const text = shiftText(date, list, settings.meetingPoints as Record<string, string>, scheduleMessageText);
    const { sendBroadcast } = await import("./whatsappBroadcast");
    const { CONFIRMED_SHIFT_TEMPLATE_ID } = await import("../shared/whatsappTemplate");
    const { getSystemUserId } = await import("./db");
    const r = await sendBroadcast({
      templateId: CONFIRMED_SHIFT_TEMPLATE_ID,
      cityByEmployee: { [employeeId]: city },
      bodyParam2ByEmployee: { [employeeId]: text },
      // A data na nota liga a mensagem ao turno (botão "Preciso de alterar", nova tentativa).
      note: `Turno confirmado ${date}`,
      createdById: await getSystemUserId(),
    });
    const rec = r.recipients[0];
    if (rec?.status === "sent") return text;
    console.warn(`[extras-auto] turno_confirmado ${date} (${city}) não enviado a ${employeeId}: ${rec?.error ?? rec?.status ?? "sem destinatário"}`);
    return null;
  } catch (err) {
    console.warn("[extras-auto] turno_confirmado falhou:", String((err as any)?.message ?? err).slice(0, 160));
    return null;
  }
}

/** Texto do botão de resposta rápida do turno_confirmado. */
export const SHIFT_CHANGE_REQUEST_LABEL = "Preciso de alterar";

/** A mensagem é o botão "Preciso de alterar"? (sem acentos, maiúsculas nem espaços a mais). PURA. */
export function isShiftChangeRequest(body: string | null | undefined): boolean {
  const fold = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  return fold(String(body ?? "")) === fold(SHIFT_CHANGE_REQUEST_LABEL);
}

/**
 * Botão "Preciso de alterar" do turno_confirmado: marca o turno como
 * "alteração pedida" (só a 1.ª carga conta), avisa a equipa e responde.
 */
async function applyShiftChangeRequest(employeeId: number, conversationId: number, date: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await ensureTables();
  const upd = await db.execute(sql`
    UPDATE \`extras_dia_notices\` SET changeRequestedAt = CURRENT_TIMESTAMP
     WHERE employeeId = ${employeeId} AND assignmentDate = ${date} AND changeRequestedAt IS NULL`);
  if (extractAffectedRows(upd) === 0) return; // já tinha pedido (ou o turno mudou entretanto)
  const { employees } = await import("../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const [emp] = await db.select({ fullName: employees.fullName, projectId: employees.projectId }).from(employees).where(eq(employees.id, employeeId)).limit(1);
  const { notify } = await import("./notify");
  await notify({
    kind: "extras_schedule_reply",
    projectId: emp?.projectId ?? null,
    title: `${emp?.fullName ?? `#${employeeId}`} pediu para alterar o turno de ${date}`,
    body: `Carregou em "Preciso de alterar" na confirmação do turno por WhatsApp. Fala com a pessoa no inbox.`,
    link: "/extras-dia",
    entity: { type: "extras_notice", id: `${employeeId}:${date}` },
  });
  const { replyToConversation } = await import("./whatsappInbox");
  await replyToConversation(conversationId, "Obrigado por avisares. A equipa vai falar contigo para ajustar o turno.", null);
}

// ─── 8. Escala sugerida + cobertura ─────────────────────────────────────────

type CityId = "lisbon" | "porto" | "faro";
const CITY_KEY_TO_EXTRA: Record<string, CityId> = { lisboa: "lisbon", porto: "porto", faro: "faro" };

export interface AutofillResult {
  created: AutofillPick[];
  unfilled: { startHour: number; endHour: number }[];
  suggested: number;
  existing: number;
  /** Tirados à mão deste dia que ficaram de fora (não voltam por automatismo). */
  removedOut: number;
}

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
  // Quem foi tirado à mão deste dia também não volta (Jorge, 7 out 2026: a mão
  // humana manda). Quem foi posto outra vez à mão já está em alreadyAssigned.
  const { loadRemovedByHand } = await import("./extrasSchedule");
  const { removedByHandOut } = await import("../shared/extrasSchedule");
  const removedOut = removedByHandOut(await loadRemovedByHand(input.date), alreadyAssigned);
  for (const id of removedOut) alreadyAssigned.add(id);

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
        windows: c.availability?.windows ?? [],
        cityMatch: key ? CITY_KEY_TO_EXTRA[key] === input.city : null,
        isExtra: (c.position ?? "").toLowerCase() === "extra",
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
      // Carregado por uma pessoa: o dia fica "mexido à mão" (o cron já não propõe nele).
      manualWhat: "preencheu",
    });
  }
  return { created: plan.picks, unfilled: plan.unfilled, suggested: suggested.length, existing: sameCity.length, removedOut: removedOut.length };
}

/** Horas com falta de gente num dia/cidade (previsão vs escalados). */
export async function coverageFor(date: string, city: CityId): Promise<CoverageGap[]> {
  return (await coverageReport(date, city)).gaps;
}

/** O mesmo, e se a previsão está incompleta (nesse caso não se avisa ninguém de faltas). */
export async function coverageReport(date: string, city: CityId): Promise<{ gaps: CoverageGap[]; incomplete: string | null }> {
  const { getExtrasDiaForecast, listAssignments } = await import("./extrasDia");
  const { forecastIncompleteReason } = await import("./extrasSchedule");
  const forecast = await getExtrasDiaForecast(addDaysIso(date, -1), city);
  const needed = forecast.hourly.map((h) => h.driversNeeded);
  const drivers = (await listAssignments(date, city)).filter((a) => !a.isTeamLeader);
  return { gaps: coverageGaps(needed, drivers), incomplete: forecastIncompleteReason(forecast) };
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

/** Sobreposições dos interruptores lidas frescas (o webhook não passa pelo tRPC). */
async function ensureFeatureFlagOverridesFresh(): Promise<void> {
  const { ensureFeatureFlagOverrides } = await import("./_core/featureFlags");
  await ensureFeatureFlagOverrides();
}

/**
 * D30 (Jorge, 3 out 2026): a resposta automática à disponibilidade tem
 * interruptor próprio (EXTRAS_AVAILABILITY_AUTO_REPLY). Sem valor próprio segue
 * a "Automação dos extras" (EXTRAS_AUTOMATION), como até aqui.
 */
export function availabilityAutoReplyOn(): boolean {
  const extrasOn = isFeatureEnabled("EXTRAS_AUTOMATION", { defaultEnabled: automationFlagDefault("EXTRAS_AUTOMATION") });
  return isFeatureEnabled("EXTRAS_AVAILABILITY_AUTO_REPLY", { defaultEnabled: extrasOn });
}

/**
 * Trata a mensagem de um colaborador conhecido que chegou pelo WhatsApp.
 * Idempotente: cada pedido é respondido no máximo 1× (whatsapp_request_answers).
 * Best-effort: nunca lança (o webhook tem de responder 200 à Meta).
 */
export async function handleWhatsappReply(input: { employeeId: number; conversationId: number; body: string }): Promise<WhatsappReplyOutcome> {
  try {
    // Resposta automática desligada → não se marca nem se responde sozinho (17a):
    // a mensagem fica na caixa para uma pessoa. O webhook não passa pelo tRPC,
    // por isso lê-se o interruptor fresco aqui.
    await ensureFeatureFlagOverridesFresh();
    if (!availabilityAutoReplyOn()) return { action: "none" };
    const pending = await latestRequestFor(input.employeeId);
    if (!pending) return { action: "none" };
    const { classifyAvailabilityReply } = await import("./availabilityReply");
    let verdict = classifyAvailabilityReply(input.body).verdict;
    // Pouco clara → IA (lite). Confiança alta aplica-se sozinha; o resto fica
    // para revisão humana (server/aiOps/availabilityAi.ts).
    let aiYes: { days: string[]; fromHour: number | null; toHour: number | null } | null = null;
    if (verdict === "unclear") {
      // Pedido já respondido → conversa normal no inbox (sem gastar IA).
      if (await requestAlreadyAnswered(pending.id)) return { action: "none" };
      const { classifyUnclearAvailability, reviewNote } = await import("./aiOps/availabilityAi");
      const d = await classifyUnclearAvailability(input.body, pending, { employeeId: input.employeeId });
      if (d.action === "apply_no") verdict = "no";
      else if (d.action === "apply_yes") { verdict = "yes"; aiYes = { days: d.days, fromHour: d.fromHour, toHour: d.toHour }; }
      else {
        // Sem leitura da IA (desligada/indisponível) → como antes: fica no inbox.
        // Com leitura mas sem confiança → revisão humana (tarefa/backoffice).
        if (d.ai) await flagAvailabilityForReview(input.employeeId, pending, `${reviewNote(d)} WhatsApp: "${input.body.slice(0, 300)}"`);
        return { action: "none" };
      }
    }
    const db = await getDb();
    if (!db) return { action: "none" };

    // Pedido da semana com dias ditos (lidos pela IA com confiança alta): marca esses dias.
    if (aiYes && pending.kind !== "assignment" && !pending.targetDate && pending.weekStart && aiYes.days.length) {
      if (await requestAlreadyAnswered(pending.id)) return { action: "none" };
      if (!(await claimRequestAnswer(pending.id, input.employeeId, "day_marked"))) return { action: "none" };
      const { markDayAvailability } = await import("./extrasAvailability");
      for (const day of aiYes.days) {
        await markDayAvailability(input.employeeId, day, {
          morning: pending.shift !== "night", night: pending.shift === "night",
          fromHour: aiYes.fromHour ?? pending.fromHour, toHour: aiYes.toHour ?? pending.toHour,
          note: "respondeu por WhatsApp (lido por IA)",
        });
      }
      const { replyToConversation } = await import("./whatsappInbox");
      const reply = "Obrigado! Ficou registada a tua disponibilidade ✅";
      await replyToConversation(input.conversationId, reply, null);
      return { action: "day_marked", reply };
    }

    const action = decideAutoReply({
      pending,
      verdict,
      alreadyAnswered: await requestAlreadyAnswered(pending.id),
      dayAlreadyMarked:
        pending.kind !== "assignment" && pending.targetDate ? await dayAlreadyMarked(input.employeeId, pending.targetDate, pending.shift) : false,
    });
    if (action === "none") return { action };

    const { replyToConversation } = await import("./whatsappInbox");

    if (action === "confirmed" || action === "declined") {
      if (!pending.targetDate) return { action: "none" };
      return applyShiftNoticeAnswer({
        employeeId: input.employeeId,
        conversationId: input.conversationId,
        date: pending.targetDate,
        action,
        requestId: pending.id,
        via: "texto",
      });
    }

    // Pedido do dia / da semana: reserva ANTES de agir (duas mensagens seguidas
    // não geram duas respostas).
    if (!(await claimRequestAnswer(pending.id, input.employeeId, action))) return { action: "none" };

    if (action === "day_marked" && pending.targetDate) {
      const { markDayAvailability } = await import("./extrasAvailability");
      await markDayAvailability(input.employeeId, pending.targetDate, {
        morning: pending.shift !== "night",
        night: pending.shift === "night",
        fromHour: aiYes?.fromHour ?? pending.fromHour,
        toHour: aiYes?.toHour ?? pending.toHour,
        note: aiYes ? "respondeu por WhatsApp (lido por IA)" : "respondeu SIM por WhatsApp",
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

/**
 * Resposta ao aviso de escala (texto lido pelas regras/IA ou botão do
 * `driver_shift_notice`): marca o turno confirmado/recusado em
 * `extras_dia_notices` (uma vez — a 2.ª resposta não muda nada), responde e,
 * num "não", avisa o backoffice para procurar substituto.
 */
async function applyShiftNoticeAnswer(input: {
  employeeId: number;
  conversationId: number;
  date: string;
  action: "confirmed" | "declined";
  requestId: number | null;
  via: "texto" | "botão";
}): Promise<WhatsappReplyOutcome> {
  const db = await getDb();
  if (!db) return { action: "none" };
  await ensureTables();
  const col = input.action === "confirmed" ? sql`confirmedAt` : sql`declinedAt`;
  const upd = await db.execute(sql`
    UPDATE \`extras_dia_notices\` SET ${col} = CURRENT_TIMESTAMP
     WHERE employeeId = ${input.employeeId} AND assignmentDate = ${input.date}
       AND confirmedAt IS NULL AND declinedAt IS NULL`);
  if (extractAffectedRows(upd) === 0) return { action: "none" }; // já tinha respondido
  if (input.requestId != null) await claimRequestAnswer(input.requestId, input.employeeId, input.action);

  const { replyToConversation } = await import("./whatsappInbox");
  if (input.action === "confirmed") {
    // Aceitou a proposta (aviso de trabalho) → turno_confirmado da cidade do
    // turno, com o mesmo texto. Sem template possível, a resposta de sempre.
    const confirmed = await sendShiftConfirmation(input.employeeId, input.date);
    if (confirmed) return { action: input.action, reply: confirmed };
    const reply = "Obrigado! Fica confirmado ✅ Até lá.";
    await replyToConversation(input.conversationId, reply, null);
    return { action: input.action, reply };
  }
  const { employees } = await import("../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const [emp] = await db.select({ fullName: employees.fullName, projectId: employees.projectId }).from(employees).where(eq(employees.id, input.employeeId)).limit(1);
  const name = emp?.fullName ?? `#${input.employeeId}`;
  const { notify } = await import("./notify");
  await notify({
    kind: "extras_schedule_reply",
    projectId: emp?.projectId ?? null,
    title: `${name} não pode ir ao turno de ${input.date}`,
    body: input.via === "botão"
      ? `Carregou em "Não posso" no aviso de escala do WhatsApp. Procura substituto.`
      : `Respondeu "não" ao aviso de escala por WhatsApp. Procura substituto.`,
    link: "/extras-dia",
    entity: { type: "extras_notice", id: `${input.employeeId}:${input.date}` },
  });
  const reply = "Obrigado por avisares. Vamos tratar da substituição.";
  await replyToConversation(input.conversationId, reply, null);
  return { action: input.action, reply };
}

/** Pedido "assignment" (aviso de escala) registado para este colaborador e dia. */
async function assignmentRequestFor(employeeId: number, date: string): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const [rows] = (await db.execute(sql`
      SELECT id FROM \`availability_request_log\`
       WHERE employeeId = ${employeeId} AND kind = 'assignment' AND targetDate = ${date}
       ORDER BY sentAt DESC, id DESC LIMIT 1`)) as any;
    const r = (rows as any[])?.[0];
    return r ? Number(r.id) : null;
  } catch {
    return null; // tabela ainda não existe
  }
}

/**
 * Botão "Confirmo" / "Não posso" do `driver_shift_notice`. A resposta liga-se
 * ao turno pelo `context.id` (o wamid do aviso que a pessoa recebeu) — não pelo
 * "último pedido", que pode ser outro (vários turnos, um pedido de
 * disponibilidade entretanto). true = era um botão de um aviso nosso a esta
 * conversa (tratado, mesmo que já estivesse respondido): a leitura genérica do
 * texto não corre. Nunca lança.
 */
export async function handleShiftNoticeButton(input: {
  employeeId: number;
  conversationId: number;
  contextId: string;
  text: string | null;
  payload: string | null;
}): Promise<boolean> {
  try {
    const { isDriverMessageTemplate, shiftNoticeButtonAction } = await import("../shared/whatsappTemplate");
    const action = shiftNoticeButtonAction(input.payload) ?? shiftNoticeButtonAction(input.text);
    const changeRequest = !action && (isShiftChangeRequest(input.payload) || isShiftChangeRequest(input.text));
    if (!action && !changeRequest) return false;
    const db = await getDb();
    if (!db) return false;
    const [rows] = (await db.execute(sql`
      SELECT m.conversationId, m.templateName, b.note
        FROM whatsapp_messages m LEFT JOIN whatsapp_broadcasts b ON b.id = m.broadcastId
       WHERE m.waMessageId = ${input.contextId} AND m.direction = 'out' LIMIT 1`)) as any;
    const sent = (rows as any[])?.[0];
    // Só um aviso de turno (ou turno_confirmado) NOSSO, de qualquer cidade, enviado a ESTA conversa.
    const templateName = sent ? String(sent.templateName) : null;
    const expected = changeRequest ? "CONFIRMED_SHIFT" : "WORK_NOTICE";
    if (!sent || !isDriverMessageTemplate(templateName, expected) || Number(sent.conversationId) !== input.conversationId) return false;
    const { shiftDateFromNote } = await import("./whatsappFailurePolicy");
    const date = shiftDateFromNote(sent.note);
    if (!date) return false;

    await ensureFeatureFlagOverridesFresh();
    // Resposta automática desligada: a resposta fica na caixa para uma pessoa (como o texto).
    if (!availabilityAutoReplyOn()) return true;

    if (changeRequest) {
      await applyShiftChangeRequest(input.employeeId, input.conversationId, date);
      return true;
    }

    await applyShiftNoticeAnswer({
      employeeId: input.employeeId,
      conversationId: input.conversationId,
      date,
      action: action!,
      requestId: await assignmentRequestFor(input.employeeId, date),
      via: "botão",
    });
    return true;
  } catch (err) {
    console.warn("[extras-auto] botão do aviso de escala:", String((err as any)?.message ?? err).slice(0, 160));
    return false;
  }
}

/**
 * Resposta que nem as regras nem a IA (com confiança) perceberam → humano:
 * aviso de escala → backoffice; pedido de disponibilidade → tarefa (uma por
 * pessoa × semana, com a leitura da IA anotada). Nunca lança.
 */
async function flagAvailabilityForReview(employeeId: number, pending: PendingRequest, detail: string): Promise<void> {
  try {
    if (pending.kind === "assignment") {
      const { notify } = await import("./notify");
      await notify({
        kind: "extras_schedule_reply",
        projectId: await employeeProjectId(employeeId),
        title: "Resposta ao aviso de escala por rever",
        body: `${detail}`.slice(0, 500),
        link: "/extras-dia",
        entity: { type: "extras_notice", id: `${employeeId}:${pending.targetDate ?? ""}` },
      });
      return;
    }
    const day = pending.weekStart ?? pending.targetDate;
    if (!day) return;
    const { upsertAvailabilityTask } = await import("./tasksService");
    await upsertAvailabilityTask({ employeeId, day, detail: `[Resposta pouco clara por WhatsApp] ${pending.targetDate ?? pending.weekStart ?? ""} ${pending.shift ?? ""}\n${detail}`.slice(0, 3000) });
  } catch (err) {
    console.warn("[extras-auto] revisão da resposta:", String((err as any)?.message ?? err).slice(0, 160));
  }
}

// ─── 9. Converter lead em extra ─────────────────────────────────────────────

export type ConvertLeadResult =
  | { ok: true; employeeId: number; created: boolean; city: string; reactivated: boolean }
  /** A pessoa já teve ficha, desativada: mostra-se o motivo e só se reativa com confirmação (18b). */
  | { ok: false; needsConfirm: { employeeId: number; fullName: string; reason: string; deactivatedAt: string | null } };

/**
 * A ficha que já existe para esta pessoa (pelo telemóvel, senão pelo email),
 * seguindo as juntas ("ficha_duplicada" → a ficha que ficou). null = não há.
 * Usada pelo Converter (lead) e pelo Aprovar (candidatura) — 18b.
 */
export async function existingFichaFor(db: any, lead: { phoneE164: string | null; email: string | null }) {
  const { employees } = await import("../drizzle/schema");
  const { eq, sql } = await import("drizzle-orm");
  const { mergedTargetId, pickFicha } = await import("../shared/extraLeadsConvert");
  const cols = {
    id: employees.id, fullName: employees.fullName, phone: employees.phone, position: employees.position, isActive: employees.isActive,
    projectId: employees.projectId, deactivationReason: employees.deactivationReason, deactivationReasonOther: employees.deactivationReasonOther,
    deactivatedAt: employees.deactivatedAt,
  };
  let found: any = null;
  let via: "phone" | "email" = "phone";
  if (lead.phoneE164) {
    const { normalizePhoneE164 } = await import("../shared/phone");
    const rows = await db.select(cols).from(employees).where(sql`${employees.phone} IS NOT NULL`);
    found = pickFicha(rows.filter((r: any) => r.phone && normalizePhoneE164(r.phone) === lead.phoneE164));
  }
  if (!found && lead.email) {
    const { findEmployeeByEmail } = await import("./identity");
    const hit = await findEmployeeByEmail(db, lead.email);
    if (hit) {
      [found] = await db.select(cols).from(employees).where(eq(employees.id, hit.id)).limit(1);
      via = "email";
    }
  }
  // Ficha junta a outra → a que ficou (até 5 saltos).
  let redirected = false;
  for (let i = 0; found && i < 5; i++) {
    const next = mergedTargetId(found);
    if (next == null) break;
    const [t] = await db.select(cols).from(employees).where(eq(employees.id, next)).limit(1);
    if (!t) break;
    found = t;
    redirected = true;
  }
  return found ? { ...found, via, redirected } : null;
}

/**
 * D39: NIF e números dos documentos do candidato que faltam na ficha. Nunca
 * substitui o que a ficha já tem. PURA.
 */
export function leadIdentityPatch(
  lead: { nif?: string | null; idDocNumber?: string | null; drivingLicenseNumber?: string | null; drivingLicenseIssuedAt?: string | null },
  emp: { nif: string | null; idDocNumber: string | null; drivingLicenseNumber: string | null; drivingLicenseIssuedAt?: string | null } | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!emp) return out;
  const empty = (v: string | null | undefined) => v == null || v.trim() === "";
  if (lead.nif && empty(emp.nif)) out.nif = lead.nif;
  if (lead.idDocNumber && empty(emp.idDocNumber)) out.idDocNumber = lead.idDocNumber;
  if (lead.drivingLicenseNumber && empty(emp.drivingLicenseNumber)) out.drivingLicenseNumber = lead.drivingLicenseNumber;
  // 0530: data de emissão da carta declarada (fica "pendente de validação" até o RH a ver).
  if (lead.drivingLicenseIssuedAt && empty(emp.drivingLicenseIssuedAt)) out.drivingLicenseIssuedAt = lead.drivingLicenseIssuedAt;
  return out;
}

export async function convertLeadToExtra(
  leadId: number, projectId: number, userId: number | null, opts: { confirmReactivate?: boolean } = {},
): Promise<ConvertLeadResult> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const { extraLeads, employees } = await import("../drizzle/schema");
  const { and, eq, isNull } = await import("drizzle-orm");
  const [lead] = await db.select().from(extraLeads).where(and(eq(extraLeads.id, leadId), isNull(extraLeads.archivedAt))).limit(1);
  const { assertLeadVisible } = await import("./extraLeads");
  assertLeadVisible(lead);
  if (lead.employeeId) throw new Error("Este lead já tem ficha de extra.");
  if (!lead.email && !lead.phone) throw new Error("O lead não tem email nem telefone — acrescenta um contacto antes de converter.");

  const { getProjects } = await import("./db");
  const { resolveApprovalCostCenter, planCostCenterAssignment } = await import("./webIntake");
  const costCenter = resolveApprovalCostCenter((await getProjects()) as any, projectId);

  // 1) Já teve ficha? (P3 18b) Antes reativava-se qualquer uma, em silêncio.
  const existing = await existingFichaFor(db, lead);
  let reactivate = false;
  if (existing) {
    const { leadFichaDecision, blockedFichaMessage } = await import("../shared/extraLeadsConvert");
    const d = leadFichaDecision(existing, !!opts.confirmReactivate);
    if (d.kind === "blocked") throw new Error(blockedFichaMessage(existing, d.reason));
    if (d.kind === "confirm") {
      return { ok: false, needsConfirm: { employeeId: existing.id, fullName: String(existing.fullName ?? ""), reason: d.reason, deactivatedAt: existing.deactivatedAt ?? null } };
    }
    reactivate = d.reactivate;
    // Ficha de outra cidade: não se liga nem se mexe nela daqui.
    const { scopedProjectIds } = await import("./cityScope");
    const scoped = scopedProjectIds();
    if (scoped !== undefined && existing.projectId != null && !scoped.includes(existing.projectId)) {
      throw new Error(`Já existe uma ficha com este contacto noutra cidade (#${existing.id}). Pede a quem gere essa cidade para converter.`);
    }
  }

  // Reserva o lead ANTES de criar a ficha: dois cliques (ou duas pessoas) ao
  // mesmo tempo já não criam duas fichas. employeeId 0 = "a converter"; uma
  // reserva com mais de 10 min (a função morreu a meio) já não prende (18b).
  const { sql } = await import("drizzle-orm");
  const claim = await db.update(extraLeads).set({ employeeId: 0 })
    .where(and(eq(extraLeads.id, leadId), sql`(${extraLeads.employeeId} IS NULL OR (${extraLeads.employeeId} = 0 AND ${extraLeads.updatedAt} < NOW() - INTERVAL 10 MINUTE))`));
  if (Number((claim as any)[0]?.affectedRows ?? (claim as any).affectedRows ?? 0) !== 1) {
    throw new Error("Este lead já está a ser convertido.");
  }

  try {
    let employeeId: number | null = existing?.id ?? null;
    let created = false;

    // 2) Sem ficha: pelo email (encontra ou cria), senão só com o telefone.
    if (employeeId == null && lead.email) {
      const { findOrCreateExtraByEmail } = await import("./identity");
      const r = await findOrCreateExtraByEmail(db as any, lead.email, { fullName: lead.fullName, phone: lead.phone, projectId });
      employeeId = r.id;
      created = r.created;
    }
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
      // Ficha existente: reativa SÓ com confirmação (e limpa o motivo — a regra
      // de reativar) e atribui o centro de custos se a regra o permitir.
      const [emp] = await db.select({ projectId: employees.projectId, isActive: employees.isActive, phone: employees.phone }).from(employees).where(eq(employees.id, employeeId)).limit(1);
      const patch: Record<string, unknown> = {};
      if (reactivate && emp && emp.isActive !== 1) {
        Object.assign(patch, { isActive: 1, deactivationReason: null, deactivationReasonOther: null, deactivationNotes: null, deactivatedAt: null, deactivatedById: null });
      }
      if (planCostCenterAssignment(emp?.projectId ?? null, projectId, false).assign) patch.projectId = projectId;
      if (emp && !emp.phone && lead.phone) patch.phone = lead.phone;
      if (Object.keys(patch).length) await db.update(employees).set(patch as any).where(eq(employees.id, employeeId));
    }

    // D39: o que a IA leu nos anexos do email (NIF, BI/CC, carta) passa para a ficha — só campos vazios.
    const idPatch = leadIdentityPatch(lead as any, (await db.select({ nif: employees.nif, idDocNumber: employees.idDocNumber, drivingLicenseNumber: employees.drivingLicenseNumber, drivingLicenseIssuedAt: employees.drivingLicenseIssuedAt }).from(employees).where(eq(employees.id, employeeId)).limit(1))[0] ?? null);
    if (Object.keys(idPatch).length) await db.update(employees).set(idPatch as any).where(eq(employees.id, employeeId));

    const convertedAt = new Date().toISOString().slice(0, 19).replace("T", " ");
    await db.update(extraLeads).set({ status: "converted", employeeId, projectId, convertedAt }).where(eq(extraLeads.id, leadId));
    // Funil único: a candidatura pendente da mesma pessoa fica aprovada e ligada.
    const { approveApplicationForConvertedLead } = await import("./extraLeadsSync");
    await approveApplicationForConvertedLead(lead, employeeId, userId);
    const { logActivity } = await import("./db");
    const how = created ? " (criado)" : reactivate ? ` (existente, REATIVADA — tinha saído por «${existing ? (await import("../shared/deactivationReasons")).deactivationReasonLabel(existing.deactivationReason, existing.deactivationReasonOther) : "?"}»)` : " (existente)";
    await logActivity({
      userId: userId ?? 0,
      action: "extra_lead_convert",
      entity: "extra_leads",
      entityId: leadId,
      details: `Lead convertido em extra: ${lead.fullName} → employee ${employeeId}${how} · ${costCenter.projectName}${lead.notes ? ` · notas do lead: ${lead.notes}` : ""}`.slice(0, 1000),
    });
    if (reactivate) {
      await logActivity({ userId: userId ?? 0, action: "employee_reactivate", entity: "employee", entityId: employeeId, details: `Reativada ao converter o lead #${leadId} (confirmado por quem converteu)` });
    }
    // Percurso de onboarding por defeito (best-effort — nunca parte a conversão).
    const { autoAssignOnboarding } = await import("./trainingPaths");
    await autoAssignOnboarding(employeeId, "lead_convert", userId);
    return { ok: true, employeeId, created, city: costCenter.city, reactivated: reactivate };
  } catch (err) {
    // Falhou: liberta a reserva para se poder tentar de novo
    await db.update(extraLeads).set({ employeeId: null }).where(and(eq(extraLeads.id, leadId), eq(extraLeads.employeeId, 0)));
    throw err;
  }
}

// ─── Orquestração do cron ───────────────────────────────────────────────────

export interface AutomationReport {
  clock: LisbonClock; ran: string[]; skipped: string[]; errors: string[]; details: Record<string, unknown>;
  /** false = o prazo acabou antes do último passo; o tick seguinte retoma em `nextStep`. */
  done: boolean;
  nextStep: string | null;
}

/** Folga mínima para arrancar um passo novo (nenhum passo deve ir além disto). */
export const STEP_RESERVE_MS = 6_000;

export interface AutomationStep { key: string; fn: () => Promise<void> }

/**
 * Corre os passos por ordem, a partir de `from` (se existir na lista), e
 * deixa de ARRANCAR passos quando faltam menos de `reserveMs` para o prazo:
 * devolve `done:false` + `nextStep` e a próxima chamada continua dali (os
 * passos são idempotentes — chave de execução ou "1× por …" — por isso
 * repetir um passo não duplica nada). Um passo que lança não pára os outros.
 */
export async function runStepsWithDeadline(
  steps: readonly AutomationStep[],
  o: { deadlineAt: number; from?: string | null; reserveMs?: number; now?: () => number; onError?: (key: string, err: unknown) => void },
): Promise<{ done: boolean; nextStep: string | null; started: string[] }> {
  const now = o.now ?? Date.now;
  const reserve = o.reserveMs ?? STEP_RESERVE_MS;
  const startIdx = Math.max(0, o.from ? steps.findIndex((s) => s.key === o.from) : 0);
  const started: string[] = [];
  for (let i = startIdx; i < steps.length; i++) {
    if (started.length > 0 && now() > o.deadlineAt - reserve) return { done: false, nextStep: steps[i].key, started };
    started.push(steps[i].key);
    try { await steps[i].fn(); } catch (err) { o.onError?.(steps[i].key, err); }
  }
  return { done: true, nextStep: null, started };
}

/**
 * Automação horária dos extras (e companhia). Com prazo (`deadlineAt`, por
 * omissão 45 s): antes não tinha nenhum e morria com 504 no Vercel. `from`
 * retoma a partir de um passo (o agendador guarda-o como cursor).
 */
export async function runExtrasAutomation(now: Date = new Date(), opts: { deadlineAt?: number; from?: string | null } = {}): Promise<AutomationReport> {
  const clock = lisbonClock(now);
  const due = dueTasks(clock);
  const report: AutomationReport = { clock, ran: [], skipped: [], errors: [], details: {}, done: true, nextStep: null };
  if (!isFeatureEnabled("EXTRAS_AUTOMATION")) {
    report.skipped.push("desligado (EXTRAS_AUTOMATION=off)");
    // A manutenção do WhatsApp (ficheiros por descarregar, estados pendentes,
    // chamadas penduradas) e os alertas de SLA não são automação dos extras
    // (17b): correm sempre — antes paravam com este interruptor.
    // As tarefas (checklists do dia e avisos de atraso) também não (P3 18a):
    // com isto desligado ficavam só para a rede de segurança das 04:30.
    for (const [key, fn] of [
      ["whatsapp-maintenance", async () => (await import("./whatsappInbound")).runWhatsappMaintenance()],
      ["whatsapp-sla", async () => (await import("./whatsappInboxOps")).runWhatsappSlaAlerts(now)],
      ["tasks", async () => (await import("./tasksService")).runTaskAutomation(now)],
      // A entrada das candidaturas e dos emails de recrutamento nos Leads
      // também não é automação dos extras (18b): antes parava com ela.
      ["leads-sync", async () => {
        const m = await import("./extraLeadsSync");
        return { applications: await m.syncApplicationLeads(), emails: await m.syncEmailLeads() };
      }],
    ] as const) {
      try {
        report.details[key] = await fn();
        report.ran.push(key);
      } catch (err: any) {
        report.errors.push(`${key}: ${String(err?.message ?? err).slice(0, 200)}`);
      }
    }
    return report;
  }

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
  /** Passo sem chave de execução: regista o resultado ou o erro. */
  const plain = (key: string, fn: () => Promise<unknown>, opts2: { skippedWhen?: (out: any) => boolean } = {}) => async () => {
    try {
      const out = await fn();
      report.details[key] = out;
      if (!opts2.skippedWhen?.(out)) report.ran.push(key);
    } catch (err: any) {
      report.errors.push(`${key}: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  };

  const steps: AutomationStep[] = [];
  if (due.weeklyRequest) steps.push({ key: "weekly-request", fn: () => run(`request:${due.weeklyRequest}`, () => runWeeklyRequest(due.weeklyRequest!)) });
  if (due.reminder) steps.push({ key: "reminder", fn: () => run(`reminder:${due.reminder}`, () => runReminder(due.reminder!)) });
  if (due.tomorrow) {
    const date = due.tomorrow;
    // Sem chave de execução: o aviso já é idempotente por turno (só envia a quem
    // ainda não foi avisado com sucesso) — assim, de hora a hora até à meia-noite,
    // apanha quem for escalado depois das 18h e repete as falhas.
    steps.push({ key: "tomorrow-notify", fn: plain(`notify:${date}`, () => notifyAssignments(date, { respectHold: true })) });
    steps.push({ key: "tomorrow-coverage", fn: () => run(`coverage:${date}`, async () => {
      const out: Record<string, number> = {};
      for (const city of ["lisbon", "porto", "faro"] as CityId[]) {
        const { gaps, incomplete } = await coverageReport(date, city);
        out[city] = gaps.length;
        // Previsão incompleta: as "faltas" seriam falsas — não se avisa ninguém.
        if (incomplete) { out[`${city}_incompleta`] = 1; continue; }
        if (gaps.length) {
          const label = city === "lisbon" ? "Lisboa" : city === "porto" ? "Porto" : "Faro";
          const { notify } = await import("./notify");
          await notify({
            kind: "extras_gap", city,
            title: `Faltam condutores amanhã em ${label}`, body: `${date}: ${describeGaps(gaps)}`, link: "/extras-dia",
            entity: { type: "extras_gap", id: `${date}:${city}` },
          });
        }
      }
      return out;
    }) });
  }

  // Passagem de turno em falta (~15:30 manhã / ~03:30 noite, Lisboa): lembrete
  // aos team leaders do turno + backoffice, 1× por (dia, turno, cidade).
  steps.push({ key: "handover-reminders", fn: plain("handover-reminders", async () => {
    const { runHandoverReminders } = await import("./shiftHandoverAutomation");
    return runHandoverReminders(now);
  }) });

  steps.push({ key: "leads", fn: () => runLeadAutomation(clock, now, report, run) });

  // WhatsApp: re-tenta downloads de media falhados (lote limitado) e limpa
  // status pendentes antigos.
  steps.push({ key: "whatsapp-maintenance", fn: plain("whatsapp-maintenance", async () => {
    const { runWhatsappMaintenance } = await import("./whatsappInbound");
    return runWhatsappMaintenance();
  }) });

  // WhatsApp: conversas sem resposta há mais do que o SLA (WHATSAPP_SLA_MINUTES)
  // e janelas de 24h a fechar → uma notificação por cidade (1× por conversa).
  steps.push({ key: "whatsapp-sla", fn: plain("whatsapp-sla", async () => {
    const { runWhatsappSlaAlerts } = await import("./whatsappInboxOps");
    return runWhatsappSlaAlerts(now);
  }) });

  // Tarefas: checklists recorrentes do dia (idempotente) + avisos de atraso /
  // conclusão (antes só com o botão manual de admin). TASKS_AUTOMATION=off desliga.
  steps.push({ key: "tasks", fn: plain("tasks", async () => {
    const { runTaskAutomation } = await import("./tasksService");
    return runTaskAutomation(now);
  }) });

  // Ocorrências/Perdidos em atraso: 1 resumo por pessoa por dia (CASE_REMINDERS=off desliga).
  steps.push({ key: "case-sla", fn: plain("case-sla", async () => {
    const { runCaseSlaReminders } = await import("./caseOps");
    return runCaseSlaReminders(now, clock.hour);
  }, { skippedWhen: (out) => !!out?.skipped }) });

  // Marketing: email semanal à segunda ≥ 8h, 1× por semana ISO (MARKETING_WEEKLY=off desliga).
  steps.push({ key: "marketing-weekly", fn: async () => {
    try {
      const { maybeSendMarketingWeekly } = await import("./marketingWeekly");
      const out = await maybeSendMarketingWeekly(clock, run);
      if (out.key) report.details["marketing-weekly"] = out;
    } catch (err: any) {
      report.errors.push(`marketing-weekly: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  } });

  // Formação: lembretes, atrasos e recertificação (TRAINING_REMINDERS=off desliga).
  steps.push({ key: "training", fn: plain("training", async () => {
    const { runTrainingAutomation } = await import("./trainingPaths");
    return runTrainingAutomation(now, clock.hour);
  }, { skippedWhen: (out) => !!out?.skipped }) });

  const r = await runStepsWithDeadline(steps, {
    deadlineAt: opts.deadlineAt ?? Date.now() + 45_000,
    from: opts.from,
    onError: (key, err: any) => report.errors.push(`${key}: ${String(err?.message ?? err).slice(0, 200)}`),
  });
  report.done = r.done;
  report.nextStep = r.nextStep;
  if (!r.done) report.skipped.push(`prazo: continua em "${r.nextStep}" na próxima corrida`);
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
        projectId: extraLeads.projectId,
        createdAt: extraLeads.createdAt,
        lastContactedAt: extraLeads.lastContactedAt,
        lastInboundAt: extraLeads.lastInboundAt,
        contactCount: extraLeads.contactCount,
        phoneE164: extraLeads.phoneE164,
      })
      .from(extraLeads)
      // Quem pediu STOP não entra no SLA nem no lembrete automático; nem os arquivados (0380).
      .where(and(inArray(extraLeads.status, ["new", "contacted"]), isNull(extraLeads.optedOutAt), isNull(extraLeads.archivedAt)));
  };

  if (clock.hour >= LEAD_SLA_NOTICE_HOUR) {
    await run(`leads-sla:${clock.date}`, async () => {
      const { newStale, contactedStale } = selectSlaLeads(await loadOpenLeads(), now.getTime());
      // Um resumo por cidade da lead (sem cidade → só quem vê todas as cidades).
      const byProject = new Map<string, { projectId: number | null; fresh: number; contacted: number }>();
      const bump = (projectId: number | null, k: "fresh" | "contacted") => {
        const key = String(projectId);
        const g = byProject.get(key) ?? { projectId, fresh: 0, contacted: 0 };
        g[k]++;
        byProject.set(key, g);
      };
      for (const l of newStale) bump(l.projectId ?? null, "fresh");
      for (const l of contactedStale) bump(l.projectId ?? null, "contacted");
      const { notify } = await import("./notify");
      for (const g of Array.from(byProject.values())) {
        await notify({
          kind: "leads_waiting",
          projectId: g.projectId,
          title: `Leads à espera: ${g.fresh + g.contacted}`,
          body: `${g.fresh} novo(s) sem contacto há mais de 24h · ${g.contacted} contactado(s) sem resposta há mais de 3 dias.`,
          link: "/extras-leads",
          entity: { type: "leads_waiting", id: `${clock.date}:${g.projectId ?? "-"}` },
        });
      }
      return { newStale: newStale.length, contactedStale: contactedStale.length };
    });
  }

  if (isLeadReminderTime(clock) && isFeatureEnabled("LEAD_REMINDERS")) {
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
        // 18b: uma corrida repetida no mesmo dia retoma o envio, não o duplica.
        sendKey: `leads-reminder:${clock.date}`,
      });
      return { due: due.length, sent: r.sent, failed: r.failed };
    });
  }
}
