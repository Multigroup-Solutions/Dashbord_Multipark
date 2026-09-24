/**
 * Escala automática do Extras-dia (pedido do dono, 24 set 2026):
 *
 *  1. PROPOR — para um dia e cidade, pega na previsão (condutores por hora,
 *     com a capacidade da cidade) e preenche as horas em falta com os extras
 *     que marcaram disponibilidade, ordenados por cobertura, avaliação, custo,
 *     equidade e fiabilidade (regras puras em shared/extrasSchedule.ts). As
 *     linhas nascem `status='proposed'`, cada uma com o seu "porquê", e o dia
 *     fica com a lista de buracos.
 *  2. CONFIRMAR — o TL/supervisor aceita (ou edita/remove e depois confirma);
 *     se ninguém confirmar nem suspender, o cron confirma à hora definida.
 *  3. AVISAR — ao confirmar, cada extra recebe WhatsApp (template de aviso de
 *     trabalho) e email; quem sai de uma escala confirmada recebe aviso de
 *     remoção. 1 aviso por (linha, versão, canal) — tabela
 *     extras_dia_notifications — e respeita o STOP do WhatsApp.
 *
 * Tudo idempotente: propor duas vezes não duplica (as propostas antigas são
 * substituídas numa transação; o cron só propõe dias sem estado), confirmar
 * duas vezes não reenvia (deduplicação por versão).
 */
import { sql } from "drizzle-orm";
import { getDb, logActivity } from "./db";
import { extractAffectedRows } from "./availabilityFormToken";
import {
  CITY_LABELS_PT,
  addDaysIso,
  availabilityWindow,
  canAutoConfirm,
  describeGap,
  explainProposal,
  lisbonNow,
  pendingScheduleNotifications,
  planSchedule,
  remainingNeed,
  scheduleCronOk,
  scheduleDue,
  scheduleMessageText,
  shouldNotifyRemoval,
  summarizeGaps,
  type Gap,
  type NotifyChannel,
  type NotifyKind,
  type NotifyLogRow,
  type ScheduleCandidate,
  type ScheduleSettings,
} from "../shared/extrasSchedule";
import { DEFAULT_CARS_PER_HOUR, SETTINGS, hhmmToMinutes } from "../shared/appSettings";

export type ScheduleCity = "lisbon" | "porto" | "faro";
export const SCHEDULE_CITIES: ScheduleCity[] = ["lisbon", "porto", "faro"];

function rowsOf(res: unknown): any[] {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
}

// ─── Âmbito de cidade (o mesmo do middleware tRPC) ──────────────────────────

/** Recusa uma cidade fora do âmbito do utilizador (sem âmbito = cron → passa). */
export async function assertCityInScope(city: string): Promise<void> {
  const { cityScope } = await import("./cityScope");
  const access = cityScope.getStore();
  if (!access || access.all) return;
  const { hasForeignCityFilter } = await import("./cityAccess");
  if (hasForeignCityFilter(access, { city })) {
    const { TRPCError } = await import("@trpc/server");
    throw new TRPCError({ code: "FORBIDDEN", message: "Esta cidade não está nas tuas cidades autorizadas." });
  }
}

// ─── Definições ─────────────────────────────────────────────────────────────

export interface LoadedScheduleSettings extends ScheduleSettings {
  autoProposeAt: string;
  autoConfirmAt: string;
  carsPerHour: Record<ScheduleCity, number>;
  meetingPoints: Record<ScheduleCity, string>;
}

export async function loadScheduleSettings(): Promise<LoadedScheduleSettings> {
  const { getSetting } = await import("./appSettings");
  const [propose, days, auto, confirm, cars, mp] = await Promise.all([
    getSetting("extras.autoProposeAt"),
    getSetting("extras.autoProposeDaysAhead"),
    getSetting("extras.autoConfirm"),
    getSetting("extras.autoConfirmAt"),
    getSetting("extras.carsPerHourPerDriver"),
    getSetting("extras.meetingPoints"),
  ]);
  const autoProposeAt = propose ?? (SETTINGS["extras.autoProposeAt"].defaultValue as string);
  const autoConfirmAt = confirm ?? (SETTINGS["extras.autoConfirmAt"].defaultValue as string);
  return {
    autoProposeAt,
    autoConfirmAt,
    autoProposeAtMin: hhmmToMinutes(autoProposeAt),
    autoConfirmAtMin: hhmmToMinutes(autoConfirmAt),
    daysAhead: days ?? (SETTINGS["extras.autoProposeDaysAhead"].defaultValue as number),
    autoConfirm: auto ?? (SETTINGS["extras.autoConfirm"].defaultValue as boolean),
    carsPerHour: { ...DEFAULT_CARS_PER_HOUR, ...(cars ?? {}) },
    meetingPoints: { lisbon: "", porto: "", faro: "", ...(mp ?? {}) },
  };
}

// ─── Estado da escala por (dia, cidade) ─────────────────────────────────────

export interface ScheduleState {
  status: "proposing" | "proposed" | "confirmed";
  holdAuto: boolean;
  proposedAt: string | null;
  proposedBy: string | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  gaps: Gap[];
  summary: string | null;
}

export async function getScheduleState(date: string, city: string): Promise<ScheduleState | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const res = await db.execute(sql`
      SELECT status, holdAuto, DATE_FORMAT(proposedAt, '%Y-%m-%d %H:%i:%s') AS proposedAt, proposedBy,
             DATE_FORMAT(confirmedAt, '%Y-%m-%d %H:%i:%s') AS confirmedAt, confirmedBy, gapsJson, summary
        FROM extras_dia_schedules WHERE assignmentDate = ${date} AND city = ${city} LIMIT 1`);
    const r = rowsOf(res)[0];
    if (!r) return null;
    let gaps: Gap[] = [];
    try { gaps = r.gapsJson ? JSON.parse(String(r.gapsJson)) : []; } catch { gaps = []; }
    return {
      status: String(r.status) as ScheduleState["status"],
      holdAuto: Number(r.holdAuto) === 1,
      proposedAt: r.proposedAt ? String(r.proposedAt) : null,
      proposedBy: r.proposedBy ? String(r.proposedBy) : null,
      confirmedAt: r.confirmedAt ? String(r.confirmedAt) : null,
      confirmedBy: r.confirmedBy ? String(r.confirmedBy) : null,
      gaps: Array.isArray(gaps) ? gaps : [],
      summary: r.summary ? String(r.summary) : null,
    };
  } catch {
    return null; // tabela ainda não existe (migração 0115 por correr)
  }
}

/** "Suspender envio automático" num dia/cidade (true = o cron não confirma nem envia). */
export async function setScheduleHold(date: string, city: ScheduleCity, hold: boolean, userId: number | null): Promise<{ hold: boolean }> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  await db.execute(sql`
    INSERT INTO extras_dia_schedules (assignmentDate, city, status, holdAuto)
    VALUES (${date}, ${city}, 'proposed', ${hold ? 1 : 0})
    ON DUPLICATE KEY UPDATE holdAuto = VALUES(holdAuto)`);
  await logActivity({
    userId: userId ?? 0,
    action: hold ? "extras_schedule_hold" : "extras_schedule_release",
    entity: "extras_dia_schedules",
    details: `${hold ? "Suspenso" : "Retomado"} o envio automático da escala · ${date} · ${CITY_LABELS_PT[city]}`,
  });
  return { hold };
}

// ─── Candidatos ─────────────────────────────────────────────────────────────

const inList = (ids: number[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `);

/** Avaliação (pts médios/dia, 4 semanas), dias escalados (14 d), faltas e recusas (60 d). */
async function loadHistory(ids: number[], date: string): Promise<{
  evalScore: Map<number, number>; recentDays: Map<number, number>; noShows: Map<number, number>; declines: Map<number, number>;
}> {
  const out = { evalScore: new Map<number, number>(), recentDays: new Map<number, number>(), noShows: new Map<number, number>(), declines: new Map<number, number>() };
  const db = await getDb();
  if (!db || !ids.length) return out;
  const from28 = addDaysIso(date, -28);
  const from14 = addDaysIso(date, -14);
  const from60 = `${addDaysIso(date, -60)} 00:00:00`;
  const safe = async (fn: () => Promise<void>) => {
    try { await fn(); } catch (err: any) {
      // Tabelas criadas "on demand" (ex.: extras_dia_notices) podem ainda não existir.
      if ((err?.code ?? err?.cause?.code) === "ER_NO_SUCH_TABLE") return;
      console.warn("[extras-schedule] histórico:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
    }
  };
  await safe(async () => {
    const res = await db.execute(sql`
      SELECT employeeId, AVG(totalPoints) AS avgPts
        FROM employee_day_metrics
       WHERE employeeId IN (${inList(ids)}) AND day >= ${from28} AND day < ${date}
         AND isTeamLeader = 0 AND (hoursWorked > 0 OR actions > 0)
       GROUP BY employeeId`);
    for (const r of rowsOf(res)) out.evalScore.set(Number(r.employeeId), Math.round(Number(r.avgPts) * 100) / 100);
  });
  await safe(async () => {
    const res = await db.execute(sql`
      SELECT employeeId, COUNT(DISTINCT assignmentDate) AS n
        FROM extras_dia_assignments
       WHERE employeeId IN (${inList(ids)}) AND assignmentDate >= ${from14} AND assignmentDate < ${date}
         AND status = 'confirmed'
       GROUP BY employeeId`);
    for (const r of rowsOf(res)) out.recentDays.set(Number(r.employeeId), Number(r.n));
  });
  await safe(async () => {
    const res = await db.execute(sql`
      SELECT employeeId, COUNT(*) AS n
        FROM employee_penalties
       WHERE employeeId IN (${inList(ids)}) AND reason = 'no_show_extra_dia' AND status = 'confirmed'
         AND clearedAt IS NULL AND createdAt >= ${from60}
       GROUP BY employeeId`);
    for (const r of rowsOf(res)) out.noShows.set(Number(r.employeeId), Number(r.n));
  });
  await safe(async () => {
    const res = await db.execute(sql`
      SELECT employeeId, COUNT(*) AS n
        FROM extras_dia_notices
       WHERE employeeId IN (${inList(ids)}) AND declinedAt IS NOT NULL AND declinedAt >= ${from60}
       GROUP BY employeeId`);
    for (const r of rowsOf(res)) out.declines.set(Number(r.employeeId), Number(r.n));
  });
  return out;
}

/**
 * Extras disponíveis para o dia/cidade, com o que a ordenação precisa. Fora:
 * formação obrigatória por concluir, ficha de outra cidade, sem disponibilidade.
 */
export async function loadScheduleCandidates(date: string, city: ScheduleCity): Promise<ScheduleCandidate[]> {
  const db = await getDb();
  if (!db) return [];
  const { listDriverCandidates, DRIVER_LEVELS } = await import("./extrasDia");
  const all = await listDriverCandidates(date);
  const available = all.filter((c) => availabilityWindow(c.availability ?? null) != null);
  if (!available.length) return [];

  const { employeesMissingTraining } = await import("./trainingPaths");
  const untrained = await employeesMissingTraining(available.map((c) => c.id));
  const { resolveCitiesForEmployeeIds } = await import("./employeeCity");
  const cities = await resolveCitiesForEmployeeIds(available.map((c) => c.id));
  const cityKey = city === "lisbon" ? "lisboa" : city;
  const pool = available.filter((c) => {
    if (untrained.has(c.id)) return false;
    const k = cities.get(c.id)?.city ?? null;
    return k == null || k === cityKey;
  });
  if (!pool.length) return [];

  const { loadExtraRates, rateFor } = await import("./extraRates");
  const rates = await loadExtraRates();
  const hist = await loadHistory(pool.map((c) => c.id), date);
  return pool.map((c) => ({
    id: c.id,
    fullName: c.fullName,
    level: c.suggestedLevel,
    levelLabel: DRIVER_LEVELS.find((l) => l.id === c.suggestedLevel)?.label ?? c.suggestedLevel,
    hourlyRate: rateFor(rates, c.suggestedLevel),
    window: availabilityWindow(c.availability ?? null),
    evalScore: hist.evalScore.get(c.id) ?? null,
    recentDays: hist.recentDays.get(c.id) ?? 0,
    noShows: hist.noShows.get(c.id) ?? 0,
    declines: hist.declines.get(c.id) ?? 0,
  }));
}

// ─── Propor ─────────────────────────────────────────────────────────────────

export interface ProposeResult {
  status: "proposed" | "skipped";
  reason?: string;
  proposed: number;
  kept: number;
  gaps: Gap[];
  summary: string | null;
}

type AssignmentRow = {
  id: number; assignmentDate: string; employeeId: number | null; personName: string; city: string;
  isTeamLeader: number; startHour: number; endHour: number; sentHomeHour: number | null;
  status: string; version: number; shift: string;
};

async function loadDayRows(date: string): Promise<AssignmentRow[]> {
  const db = await getDb();
  if (!db) return [];
  const res = await db.execute(sql`
    SELECT id, assignmentDate, employeeId, personName, city, isTeamLeader, startHour, endHour, sentHomeHour, status, version, shift
      FROM extras_dia_assignments WHERE assignmentDate = ${date}`);
  return rowsOf(res).map((r) => ({
    id: Number(r.id), assignmentDate: String(r.assignmentDate), employeeId: r.employeeId == null ? null : Number(r.employeeId),
    personName: String(r.personName), city: String(r.city), isTeamLeader: Number(r.isTeamLeader), startHour: Number(r.startHour),
    endHour: Number(r.endHour), sentHomeHour: r.sentHomeHour == null ? null : Number(r.sentHomeHour),
    status: String(r.status ?? "confirmed"), version: Number(r.version ?? 1), shift: String(r.shift),
  }));
}

/**
 * Proposta automática para (dia, cidade). `by: 'auto'` (cron) só propõe se o
 * dia ainda não tem estado; `by: 'manual'` refaz a proposta (substitui as
 * linhas `proposed` — nunca toca nas confirmadas nem no TL).
 */
export async function proposeSchedule(input: { date: string; city: ScheduleCity; by: "auto" | "manual"; userId: number | null }): Promise<ProposeResult> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  const { date, city, by } = input;

  if (by === "auto") {
    const claim = await db.execute(sql`
      INSERT IGNORE INTO extras_dia_schedules (assignmentDate, city, status, proposedBy, proposedAt)
      VALUES (${date}, ${city}, 'proposing', 'auto', NOW())`);
    if (extractAffectedRows(claim) === 0) {
      return { status: "skipped", reason: "já tem proposta ou escala", proposed: 0, kept: 0, gaps: [], summary: null };
    }
  }

  try {
    const { getExtrasDiaForecast } = await import("./extrasDia");
    const forecast = await getExtrasDiaForecast(addDaysIso(date, -1), city);
    const needed = forecast.hourly.map((h) => h.driversNeeded);
    const dayRows = await loadDayRows(date);
    const kept = dayRows.filter((r) => r.city === city && r.isTeamLeader === 0 && r.status !== "proposed");
    // Quem já está no dia (outra cidade, TL, ou confirmado aqui) não entra outra vez.
    const exclude = new Set(
      dayRows.filter((r) => !(r.city === city && r.status === "proposed" && r.isTeamLeader === 0) && r.employeeId != null).map((r) => r.employeeId as number),
    );
    const candidates = await loadScheduleCandidates(date, city);
    const plan = planSchedule({ needed, existing: kept, candidates, exclude });

    let peakDrivers = 0;
    let peakHour: number | null = null;
    needed.forEach((n, h) => { if (n > peakDrivers) { peakDrivers = n; peakHour = h; } });
    const summary = explainProposal({
      date, city, carsPerHour: forecast.carsPerHourPerDriver, peakDrivers, peakHour,
      picks: plan.picks.map((p) => ({ personName: p.personName, startHour: p.startHour, endHour: p.endHour, hourlyRate: p.hourlyRate })),
      keptCount: kept.length,
      gaps: plan.gaps,
    });

    await db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT IGNORE INTO extras_dia_schedules (assignmentDate, city, status) VALUES (${date}, ${city}, 'proposing')`);
      // Serializa propostas concorrentes do mesmo dia/cidade.
      await tx.execute(sql`SELECT assignmentDate FROM extras_dia_schedules WHERE assignmentDate = ${date} AND city = ${city} FOR UPDATE`);
      await tx.execute(sql`
        DELETE FROM extras_dia_assignments
         WHERE assignmentDate = ${date} AND city = ${city} AND status = 'proposed' AND isTeamLeader = 0`);
      for (const p of plan.picks) {
        await tx.execute(sql`
          INSERT INTO extras_dia_assignments
            (assignmentDate, city, employeeId, personName, level, isTeamLeader, shift, startHour, endHour, notes, status, version, proposalReason, createdById)
          VALUES (${date}, ${city}, ${p.employeeId}, ${p.personName.slice(0, 128)}, ${p.level}, 0, ${p.shift}, ${p.startHour}, ${p.endHour},
                  'proposta automática', 'proposed', 1, ${p.reason.slice(0, 500)}, ${input.userId})`);
      }
      await tx.execute(sql`
        UPDATE extras_dia_schedules
           SET status = 'proposed', proposedAt = NOW(), proposedBy = ${by}, proposedById = ${input.userId},
               gapsJson = ${JSON.stringify(plan.gaps)}, summary = ${summary.slice(0, 1000)}
         WHERE assignmentDate = ${date} AND city = ${city}`);
    });

    await logActivity({
      userId: input.userId ?? 0,
      action: "extras_schedule_propose",
      entity: "extras_dia_schedules",
      details: `${by === "auto" ? "Proposta automática (cron)" : "Proposta automática (manual)"} · ${date} · ${CITY_LABELS_PT[city]} · ${plan.picks.length} proposto(s), ${kept.length} já escalado(s)${plan.gaps.length ? ` · ${plan.gaps.map(describeGap).join("; ")}` : ""}`,
    });

    if (by === "auto" && plan.gaps.length) {
      try {
        const { notifyBackoffice } = await import("./extrasAutomation");
        await notifyBackoffice(
          `Faltam condutores em ${CITY_LABELS_PT[city]} (${date})`,
          `Proposta automática: ${plan.gaps.map(describeGap).join("; ")}. Pede disponibilidade a quem não respondeu.`,
          "/extras-dia",
        );
      } catch { /* aviso é best-effort */ }
    }
    return { status: "proposed", proposed: plan.picks.length, kept: kept.length, gaps: plan.gaps, summary };
  } catch (err) {
    if (by === "auto") {
      // Liberta a reserva para a próxima corrida tentar outra vez.
      await db.execute(sql`DELETE FROM extras_dia_schedules WHERE assignmentDate = ${date} AND city = ${city} AND status = 'proposing'`);
    }
    throw err;
  }
}

// ─── Confirmar ──────────────────────────────────────────────────────────────

export interface NotifySummary {
  whatsapp: { sent: number; failed: number; optedOut: number; skipped: number } | null;
  email: { sent: number; failed: number; noEmail: number; skipped: number } | null;
  warnings: string[];
  errors: string[];
}

export interface ConfirmResult {
  status: "confirmed" | "skipped";
  reason?: string;
  confirmed: number;
  notifications: NotifySummary | null;
}

/**
 * Confirma a escala (todas as linhas `proposed` passam a `confirmed`) e avisa.
 * `auto` só confirma propostas por confirmar e não suspensas. Idempotente: a
 * segunda chamada não confirma nada nem reenvia (deduplicação por versão).
 */
export async function confirmSchedule(input: { date: string; city: ScheduleCity; by: "auto" | "manual"; userId: number | null }): Promise<ConfirmResult> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  const { date, city, by } = input;
  let confirmed = 0;
  if (by === "auto") {
    const claim = await db.execute(sql`
      UPDATE extras_dia_schedules
         SET status = 'confirmed', confirmedAt = NOW(), confirmedBy = 'auto', confirmedById = ${input.userId}
       WHERE assignmentDate = ${date} AND city = ${city} AND status = 'proposed' AND holdAuto = 0`);
    if (extractAffectedRows(claim) === 0) return { status: "skipped", reason: "sem proposta por confirmar ou envio suspenso", confirmed: 0, notifications: null };
    confirmed = extractAffectedRows(await db.execute(sql`
      UPDATE extras_dia_assignments SET status = 'confirmed'
       WHERE assignmentDate = ${date} AND city = ${city} AND status = 'proposed'`));
  } else {
    await db.transaction(async (tx) => {
      confirmed = extractAffectedRows(await tx.execute(sql`
        UPDATE extras_dia_assignments SET status = 'confirmed'
         WHERE assignmentDate = ${date} AND city = ${city} AND status = 'proposed'`));
      await tx.execute(sql`
        INSERT INTO extras_dia_schedules (assignmentDate, city, status, confirmedAt, confirmedBy, confirmedById)
        VALUES (${date}, ${city}, 'confirmed', NOW(), 'manual', ${input.userId})
        ON DUPLICATE KEY UPDATE status = 'confirmed', confirmedAt = NOW(), confirmedBy = 'manual', confirmedById = VALUES(confirmedById)`);
    });
  }
  const notifications = await sendScheduleNotifications(date, city, { userId: input.userId, respectHold: false });
  await logActivity({
    userId: input.userId ?? 0,
    action: "extras_schedule_confirm",
    entity: "extras_dia_schedules",
    details: `Escala confirmada (${by === "auto" ? "automático" : "manual"}) · ${date} · ${CITY_LABELS_PT[city]} · ${confirmed} linha(s) confirmada(s) · ${describeNotify(notifications)}`,
  });
  return { status: "confirmed", confirmed, notifications };
}

function describeNotify(n: NotifySummary): string {
  const bits: string[] = [];
  if (n.whatsapp) bits.push(`WhatsApp ${n.whatsapp.sent} enviado(s)${n.whatsapp.failed ? `, ${n.whatsapp.failed} falhado(s)` : ""}${n.whatsapp.optedOut ? `, ${n.whatsapp.optedOut} com STOP` : ""}`);
  if (n.email) bits.push(`email ${n.email.sent} enviado(s)${n.email.failed ? `, ${n.email.failed} falhado(s)` : ""}${n.email.noEmail ? `, ${n.email.noEmail} sem email` : ""}`);
  for (const w of n.warnings) bits.push(w);
  for (const e of n.errors) bits.push(`erro: ${e}`);
  return bits.join(" · ") || "sem avisos por enviar";
}

// ─── Avisos (dedupe por versão) ─────────────────────────────────────────────

export async function loadNotifyLog(assignmentIds: number[]): Promise<NotifyLogRow[]> {
  const db = await getDb();
  if (!db || !assignmentIds.length) return [];
  const res = await db.execute(sql`
    SELECT assignmentId, version, kind, channel, status, attempts
      FROM extras_dia_notifications WHERE assignmentId IN (${inList(assignmentIds)})`);
  return rowsOf(res).map((r) => ({
    assignmentId: Number(r.assignmentId), version: Number(r.version), kind: String(r.kind) as NotifyKind,
    channel: String(r.channel) as NotifyChannel, status: String(r.status), attempts: Number(r.attempts),
  }));
}

/**
 * Reserva o envio de (linha, versão, tipo, canal). true = este processo envia.
 * Nova → insere 'sending'; falhada com < 3 tentativas, ou 'sending' esquecida
 * há mais de 15 min → volta a 'sending'. Duas corridas ao mesmo tempo: só uma ganha.
 */
export async function claimNotification(
  a: { id: number; version: number; employeeId: number | null; assignmentDate: string; city: string },
  kind: NotifyKind,
  channel: NotifyChannel,
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const ins = await db.execute(sql`
    INSERT IGNORE INTO extras_dia_notifications (assignmentId, version, kind, channel, employeeId, assignmentDate, city, status, attempts)
    VALUES (${a.id}, ${a.version}, ${kind}, ${channel}, ${a.employeeId}, ${a.assignmentDate}, ${a.city}, 'sending', 1)`);
  if (extractAffectedRows(ins) > 0) return true;
  const upd = await db.execute(sql`
    UPDATE extras_dia_notifications SET status = 'sending', attempts = attempts + 1
     WHERE assignmentId = ${a.id} AND version = ${a.version} AND kind = ${kind} AND channel = ${channel}
       AND ((status = 'failed' AND attempts < 3) OR (status = 'sending' AND updatedAt < (NOW() - INTERVAL 15 MINUTE)))`);
  return extractAffectedRows(upd) > 0;
}

export async function finishNotification(
  a: { id: number; version: number },
  kind: NotifyKind,
  channel: NotifyChannel,
  status: string,
  detail: string | null,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.execute(sql`
    UPDATE extras_dia_notifications SET status = ${status}, detail = ${detail ? detail.slice(0, 300) : null}
     WHERE assignmentId = ${a.id} AND version = ${a.version} AND kind = ${kind} AND channel = ${channel}`);
}

/** Dias/cidades com envio automático suspenso (para o cron respeitar). */
export async function heldCities(date: string): Promise<Set<string>> {
  const db = await getDb();
  const out = new Set<string>();
  if (!db) return out;
  try {
    const res = await db.execute(sql`SELECT city FROM extras_dia_schedules WHERE assignmentDate = ${date} AND holdAuto = 1`);
    for (const r of rowsOf(res)) out.add(String(r.city));
  } catch { /* sem tabela */ }
  return out;
}

function smtpConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function whatsappConfigured(): boolean {
  return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** Email "estás escalado" a quem tem email na ficha (1 por pessoa e versão). */
export async function sendScheduleEmails(date: string, city: ScheduleCity, opts: { respectHold?: boolean } = {}): Promise<NotifySummary["email"]> {
  const db = await getDb();
  const out = { sent: 0, failed: 0, noEmail: 0, skipped: 0 };
  if (!db) return out;
  if (opts.respectHold && (await heldCities(date)).has(city)) return out;
  const rows = (await loadDayRows(date)).filter((r) => r.city === city);
  const log = await loadNotifyLog(rows.map((r) => r.id));
  const pending = pendingScheduleNotifications(rows, log, "email");
  out.skipped = rows.filter((r) => r.status === "confirmed" && r.employeeId != null).length - pending.length;
  if (!pending.length) return out;

  const empIds = Array.from(new Set(pending.map((r) => r.employeeId as number)));
  const res = await db.execute(sql`SELECT id, fullName, email FROM employees WHERE id IN (${inList(empIds)})`);
  const people = new Map(rowsOf(res).map((r) => [Number(r.id), { fullName: String(r.fullName ?? ""), email: r.email ? String(r.email).trim() : "" }]));
  const settings = await loadScheduleSettings();
  const { sendEmail } = await import("./_core/notification");

  for (const empId of empIds) {
    const mine = pending.filter((r) => r.employeeId === empId);
    const claimed: AssignmentRow[] = [];
    for (const a of mine) if (await claimNotification(a, "scheduled", "email")) claimed.push(a);
    if (!claimed.length) continue;
    const p = people.get(empId);
    if (!p?.email || !/@/.test(p.email)) {
      for (const a of claimed) await finishNotification(a, "scheduled", "email", "no_contact", "sem email na ficha");
      out.noEmail += claimed.length;
      continue;
    }
    const text = scheduleMessageText({ date, city, spans: claimed.map((a) => ({ startHour: a.startHour, endHour: a.sentHomeHour ?? a.endHour })), meetingPoint: settings.meetingPoints[city] });
    const first = p.fullName.split(/\s+/)[0] || "olá";
    const ok = await sendEmail({
      to: p.email,
      subject: `Escala Multipark — ${text.split(" · ")[0]}`,
      text: `Olá ${first},\n\nEstás escalado(a): ${text}.\n\nSe não puderes ir, avisa-nos o quanto antes (responde a este email ou pelo WhatsApp).\n\nObrigado,\nMultipark`,
      html: `<p>Olá ${esc(first)},</p><p>Estás escalado(a): <strong>${esc(text)}</strong>.</p><p>Se não puderes ir, avisa-nos o quanto antes (responde a este email ou pelo WhatsApp).</p><p>Obrigado,<br/>Multipark</p>`,
    } as any);
    for (const a of claimed) await finishNotification(a, "scheduled", "email", ok ? "sent" : "failed", ok ? null : "falhou o envio do email");
    if (ok) out.sent += claimed.length;
    else out.failed += claimed.length;
  }
  return out;
}

/**
 * Avisa (WhatsApp + email) todas as linhas CONFIRMADAS do dia/cidade que
 * ainda não foram avisadas nesta versão. Nunca lança: erros vão no resultado.
 */
export async function sendScheduleNotifications(date: string, city: ScheduleCity, opts: { userId: number | null; respectHold?: boolean }): Promise<NotifySummary> {
  const out: NotifySummary = { whatsapp: null, email: null, warnings: [], errors: [] };
  if (whatsappConfigured()) {
    try {
      const { notifyAssignments } = await import("./extrasAutomation");
      const r = await notifyAssignments(date, { city, createdById: opts.userId, respectHold: opts.respectHold });
      out.whatsapp = { sent: r.sent, failed: r.failed, optedOut: r.optedOut, skipped: r.skipped };
    } catch (err: any) {
      out.errors.push(`WhatsApp: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  } else {
    out.warnings.push("WhatsApp não configurado — só email");
  }
  if (smtpConfigured()) {
    try {
      out.email = await sendScheduleEmails(date, city, { respectHold: opts.respectHold });
    } catch (err: any) {
      out.errors.push(`email: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  } else {
    out.warnings.push("SMTP não configurado — sem email");
  }
  return out;
}

// ─── Remover (com aviso a quem já tinha sido avisado) ───────────────────────

async function wasScheduledNotified(assignmentId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const res = await db.execute(sql`
    SELECT 1 AS x FROM extras_dia_notifications
     WHERE assignmentId = ${assignmentId} AND kind = 'scheduled' AND status = 'sent' LIMIT 1`);
  if (rowsOf(res).length) return true;
  try {
    const legacy = await db.execute(sql`SELECT 1 AS x FROM extras_dia_notices WHERE assignmentId = ${assignmentId} AND status = 'sent' LIMIT 1`);
    return rowsOf(legacy).length > 0;
  } catch {
    return false;
  }
}

export interface RemoveResult { removed: boolean; notified: { whatsapp: string | null; email: string | null } }

/** Remove uma linha da escala; se era confirmada e a pessoa já tinha sido avisada, avisa que saiu. */
export async function removeAssignment(id: number, userId: number | null): Promise<RemoveResult> {
  const db = await getDb();
  const out: RemoveResult = { removed: false, notified: { whatsapp: null, email: null } };
  if (!db) return out;
  const res = await db.execute(sql`
    SELECT id, assignmentDate, employeeId, personName, city, isTeamLeader, startHour, endHour, sentHomeHour, status, version, shift
      FROM extras_dia_assignments WHERE id = ${id} LIMIT 1`);
  const r = rowsOf(res)[0];
  if (!r) return out;
  const row: AssignmentRow = {
    id: Number(r.id), assignmentDate: String(r.assignmentDate), employeeId: r.employeeId == null ? null : Number(r.employeeId),
    personName: String(r.personName), city: String(r.city), isTeamLeader: Number(r.isTeamLeader), startHour: Number(r.startHour),
    endHour: Number(r.endHour), sentHomeHour: r.sentHomeHour == null ? null : Number(r.sentHomeHour),
    status: String(r.status ?? "confirmed"), version: Number(r.version ?? 1), shift: String(r.shift),
  };
  await assertCityInScope(row.city);
  const notified = await wasScheduledNotified(row.id);
  await db.execute(sql`DELETE FROM extras_dia_assignments WHERE id = ${id}`);
  out.removed = true;
  const future = row.assignmentDate >= lisbonNow().date;
  if (future && shouldNotifyRemoval(row, notified)) out.notified = await notifyRemoval(row, userId);
  await logActivity({
    userId: userId ?? 0,
    action: "extras_dia_assignment_delete",
    entity: "extras_dia_assignments",
    entityId: row.id,
    details: `Removido da escala: ${row.personName} · ${row.assignmentDate} · ${CITY_LABELS_PT[row.city] ?? row.city} · ${row.startHour}h–${row.endHour}h (${row.status})${out.notified.whatsapp || out.notified.email ? ` · aviso de remoção: WhatsApp ${out.notified.whatsapp ?? "—"}, email ${out.notified.email ?? "—"}` : ""}`,
  });
  return out;
}

async function notifyRemoval(row: AssignmentRow, userId: number | null): Promise<RemoveResult["notified"]> {
  const db = await getDb();
  const out: RemoveResult["notified"] = { whatsapp: null, email: null };
  if (!db || row.employeeId == null) return out;
  const text = scheduleMessageText({ date: row.assignmentDate, city: row.city, spans: [{ startHour: row.startHour, endHour: row.endHour }], meetingPoint: null });
  const empRes = await db.execute(sql`SELECT fullName, email FROM employees WHERE id = ${row.employeeId} LIMIT 1`);
  const emp = rowsOf(empRes)[0];
  const first = String(emp?.fullName ?? "").split(/\s+/)[0] || "Olá";
  const msg = `Olá ${first}, o teu turno de ${text} foi cancelado — já não precisas de vir. Obrigado!`;

  // WhatsApp: texto livre só com a janela de 24h aberta (não há template de remoção).
  if (whatsappConfigured() && (await claimNotification(row, "removed", "whatsapp"))) {
    let status = "no_contact";
    let detail: string | null = "sem conversa WhatsApp com este extra";
    try {
      const conv = rowsOf(await db.execute(sql`
        SELECT id FROM whatsapp_conversations WHERE employeeId = ${row.employeeId} ORDER BY lastMessageAt DESC, id DESC LIMIT 1`))[0];
      if (conv) {
        const { replyToConversation } = await import("./whatsappInbox");
        const r = await replyToConversation(Number(conv.id), msg, userId);
        if (r.ok) { status = "sent"; detail = null; }
        else if ((r as any).optedOut) { status = "opted_out"; detail = r.error ?? "pediu STOP"; }
        else { status = "skipped"; detail = r.error ?? "janela de 24h fechada"; }
      }
    } catch (err: any) {
      status = "failed";
      detail = String(err?.message ?? err);
    }
    await finishNotification(row, "removed", "whatsapp", status, detail);
    out.whatsapp = status;
  }
  const email = emp?.email ? String(emp.email).trim() : "";
  if (smtpConfigured() && (await claimNotification(row, "removed", "email"))) {
    if (!email) {
      await finishNotification(row, "removed", "email", "no_contact", "sem email na ficha");
      out.email = "no_contact";
    } else {
      const { sendEmail } = await import("./_core/notification");
      const ok = await sendEmail({
        to: email,
        subject: `Escala Multipark — turno cancelado (${text.split(" · ")[0]})`,
        text: `${msg}\n\nMultipark`,
        html: `<p>${esc(msg)}</p><p>Multipark</p>`,
      } as any);
      await finishNotification(row, "removed", "email", ok ? "sent" : "failed", ok ? null : "falhou o envio do email");
      out.email = ok ? "sent" : "failed";
    }
  }
  return out;
}

// ─── Pedir disponibilidade a quem não respondeu ─────────────────────────────

export async function resendAvailabilityRequest(date: string, city: ScheduleCity, userId: number | null): Promise<{ targets: number; emailSent: number; whatsappSent: number }> {
  const { listDriverCandidates } = await import("./extrasDia");
  const all = await listDriverCandidates(date);
  const noAnswer = all.filter((c) => (c.availability?.status ?? "no_response") === "no_response");
  if (!noAnswer.length) return { targets: 0, emailSent: 0, whatsappSent: 0 };
  const { resolveCitiesForEmployeeIds } = await import("./employeeCity");
  const cities = await resolveCitiesForEmployeeIds(noAnswer.map((c) => c.id));
  const cityKey = city === "lisbon" ? "lisboa" : city;
  const ids = noAnswer.filter((c) => { const k = cities.get(c.id)?.city ?? null; return k == null || k === cityKey; }).map((c) => c.id);
  if (!ids.length) return { targets: 0, emailSent: 0, whatsappSent: 0 };
  const { mondayOf } = await import("./extrasAvailability");
  const weekStart = mondayOf(new Date(`${date}T12:00:00`));
  const { sendAvailabilityRequest } = await import("./extrasAutomation");
  const r = await sendAvailabilityRequest(weekStart, ids, `Precisamos de gente para ${date}: indica a tua disponibilidade`);
  await logActivity({
    userId: userId ?? 0,
    action: "extras_schedule_availability_request",
    entity: "extras_availability",
    details: `Pedido de disponibilidade a quem não respondeu · ${date} · ${CITY_LABELS_PT[city]} · ${ids.length} extra(s) · email ${r.emailSent}, WhatsApp ${r.whatsappSent}`,
  });
  return { targets: ids.length, emailSent: r.emailSent, whatsappSent: r.whatsappSent };
}

// ─── Visão para a página ────────────────────────────────────────────────────

export interface ScheduleOverview {
  date: string;
  city: ScheduleCity;
  state: ScheduleState | null;
  carsPerHour: number;
  /** Buracos AGORA (previsão vs. escala actual, propostas incluídas). */
  gaps: Gap[];
  neededPeak: number;
  proposedCount: number;
  confirmedCount: number;
  noAnswerCount: number;
  availableCount: number;
  notifications: { assignmentId: number; version: number; kind: string; channel: string; status: string; detail: string | null }[];
  settings: { autoProposeAt: string; autoConfirm: boolean; autoConfirmAt: string; daysAhead: number };
}

export async function getScheduleOverview(date: string, city: ScheduleCity): Promise<ScheduleOverview> {
  const db = await getDb();
  const { getExtrasDiaForecast, listDriverCandidates } = await import("./extrasDia");
  const [forecast, state, settings, rows, cands] = await Promise.all([
    getExtrasDiaForecast(addDaysIso(date, -1), city),
    getScheduleState(date, city),
    loadScheduleSettings(),
    loadDayRows(date),
    listDriverCandidates(date),
  ]);
  const mine = rows.filter((r) => r.city === city && r.isTeamLeader === 0);
  const needed = forecast.hourly.map((h) => h.driversNeeded);
  const gaps = summarizeGaps(remainingNeed(needed, mine).map((v, h) => (h < 3 ? 0 : v)));
  let notifications: ScheduleOverview["notifications"] = [];
  if (db && mine.length) {
    try {
      const res = await db.execute(sql`
        SELECT assignmentId, version, kind, channel, status, detail
          FROM extras_dia_notifications WHERE assignmentDate = ${date} AND city = ${city}`);
      notifications = rowsOf(res).map((r) => ({
        assignmentId: Number(r.assignmentId), version: Number(r.version), kind: String(r.kind), channel: String(r.channel),
        status: String(r.status), detail: r.detail ? String(r.detail) : null,
      }));
    } catch { /* sem tabela */ }
  }
  return {
    date,
    city,
    state,
    carsPerHour: forecast.carsPerHourPerDriver,
    gaps,
    neededPeak: Math.max(0, ...needed),
    proposedCount: mine.filter((r) => r.status === "proposed").length,
    confirmedCount: mine.filter((r) => r.status !== "proposed").length,
    noAnswerCount: cands.filter((c) => (c.availability?.status ?? "no_response") === "no_response").length,
    availableCount: cands.filter((c) => availabilityWindow(c.availability ?? null) != null).length,
    notifications,
    settings: { autoProposeAt: settings.autoProposeAt, autoConfirm: settings.autoConfirm, autoConfirmAt: settings.autoConfirmAt, daysAhead: settings.daysAhead },
  };
}

// ─── Cron ───────────────────────────────────────────────────────────────────

export interface ScheduleCronReport {
  ok: boolean;
  now: { date: string; minutes: number };
  ran: string[];
  skipped: string[];
  warnings: string[];
  errors: string[];
  details: Record<string, unknown>;
}

/**
 * /api/cron/extras-schedule (de 30 em 30 min, 08h–23h Lisboa):
 *  - a partir de `extras.autoProposeAt`: propõe amanhã … +N para cada cidade
 *    (só dias sem proposta/escala);
 *  - a partir de `extras.autoConfirmAt` (se `extras.autoConfirm`): confirma a
 *    proposta de amanhã não suspensa e avisa;
 *  - escalas já confirmadas e não suspensas de hoje em diante: envia avisos
 *    em falta (linhas editadas → nova versão; falhas → até 3 tentativas).
 */
export async function runScheduleAutomation(now: Date = new Date()): Promise<ScheduleCronReport> {
  const ln = lisbonNow(now);
  const report: ScheduleCronReport = { ok: true, now: ln, ran: [], skipped: [], warnings: [], errors: [], details: {} };
  const { isFeatureEnabled } = await import("./_core/featureFlags");
  if (!isFeatureEnabled("EXTRAS_AUTOMATION")) {
    report.skipped.push("desligado (EXTRAS_AUTOMATION=off)");
    return report;
  }
  const settings = await loadScheduleSettings();
  const due = scheduleDue(ln, settings);
  const step = async (key: string, fn: () => Promise<unknown>) => {
    try {
      const out: any = await fn();
      if (out && out.status === "skipped") report.skipped.push(`${key} (${out.reason ?? "nada a fazer"})`);
      else report.ran.push(key);
      report.details[key] = out;
      for (const w of out?.notifications?.warnings ?? out?.warnings ?? []) if (!report.warnings.includes(w)) report.warnings.push(w);
      for (const e of out?.notifications?.errors ?? out?.errors ?? []) report.errors.push(`${key}: ${e}`);
    } catch (err: any) {
      report.errors.push(`${key}: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  };

  for (const date of due.proposeDates) {
    for (const city of SCHEDULE_CITIES) {
      await step(`propose:${date}:${city}`, () => proposeSchedule({ date, city, by: "auto", userId: null }));
    }
  }
  for (const date of due.confirmDates) {
    for (const city of SCHEDULE_CITIES) {
      const state = await getScheduleState(date, city);
      if (!canAutoConfirm(state)) continue;
      await step(`confirm:${date}:${city}`, () => confirmSchedule({ date, city, by: "auto", userId: null }));
    }
  }
  // Avisos em falta nas escalas já confirmadas (hoje em diante).
  for (let i = 0; i <= Math.max(1, settings.daysAhead); i++) {
    const date = addDaysIso(ln.date, i);
    for (const city of SCHEDULE_CITIES) {
      const state = await getScheduleState(date, city);
      if (!state || state.status !== "confirmed" || state.holdAuto) continue;
      if (report.ran.includes(`confirm:${date}:${city}`)) continue;
      await step(`notify:${date}:${city}`, () => sendScheduleNotifications(date, city, { userId: null, respectHold: true }));
    }
  }
  report.ok = scheduleCronOk(report);
  return report;
}
