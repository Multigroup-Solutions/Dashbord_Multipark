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
 *
 * A mão humana manda (Jorge, 7 out 2026): o cron só faz a PRIMEIRA proposta
 * de um dia/cidade intocado. Qualquer mudança de uma pessoa nos condutores
 * desse dia marca-o "mexido à mão" (extras_dia_schedules.manualAt, 0565) e o
 * cron nunca mais propõe nele; quem foi tirado à mão de um dia não volta a ser
 * proposto para esse dia (nem pela proposta à mão, nem pelo "Preencher").
 */
import { sql } from "drizzle-orm";
import { getDb, logActivity } from "./db";
import { extractAffectedRows } from "./availabilityFormToken";
import {
  CITY_LABELS_PT,
  addDaysIso,
  canAutoConfirm,
  describeGap,
  explainProposal,
  autoProposeBlockedReason,
  MANUAL_DAY_REASON,
  lisbonNow,
  marksManualDay,
  removedByHandOut,
  removedOutText,
  type ManualTouch,
  type ManualWhat,
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
  COVERAGE_ALERT_MIN,
  MANUAL_EDIT_AT_CONFIRM_DEFAULT,
  MANUAL_EDIT_AT_CONFIRM_MODES,
  MAX_NOTIFY_ATTEMPTS,
  NOTIFY_SENDING_STALE_MIN,
  MANUAL_EDIT_SETTLE_MIN,
  MANUAL_HOLD_REPEAT_AT_MIN,
  MANUAL_HOLD_REPEAT_MIN_GAP_MIN,
  effectiveManualEditMode,
  settlesAfterLastRun,
  autoConfirmDecision,
  fmtDayPt,
  notifyRetryDue,
  scheduleCoverage,
  unnotifiedAfterRetries,
  type ManualEditAtConfirm,
} from "../shared/extrasSchedule";
import { DEFAULT_CREW_RULES, SETTINGS, hhmmToMinutes, type CrewRulesMap } from "../shared/appSettings";
import { NOTICE_NO_SHOW_MARK } from "../shared/leaves";

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
  crewRules: CrewRulesMap;
  meetingPoints: Record<ScheduleCity, string>;
  /** Plano MPV F7 (D4b): o que a confirmação automática faz a um dia mexido à mão. */
  manualEditAtConfirm: ManualEditAtConfirm;
}

export async function loadScheduleSettings(): Promise<LoadedScheduleSettings> {
  const { getSetting } = await import("./appSettings");
  const [propose, days, auto, confirm, cars, mp, manualMode] = await Promise.all([
    getSetting("extras.autoProposeAt"),
    getSetting("extras.autoProposeDaysAhead"),
    getSetting("extras.autoConfirm"),
    getSetting("extras.autoConfirmAt"),
    getSetting("extras.crewRules"),
    getSetting("extras.meetingPoints"),
    getSetting("extras.manualEditAtConfirm"),
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
    crewRules: { ...DEFAULT_CREW_RULES, ...(cars ?? {}) },
    meetingPoints: { lisbon: "", porto: "", faro: "", ...(mp ?? {}) },
    manualEditAtConfirm: (MANUAL_EDIT_AT_CONFIRM_MODES as readonly string[]).includes(String(manualMode ?? ""))
      ? (manualMode as ManualEditAtConfirm)
      : MANUAL_EDIT_AT_CONFIRM_DEFAULT,
  };
}

// ─── Estado da escala por (dia, cidade) ─────────────────────────────────────

export interface ScheduleState {
  /** 'hold' = sem proposta (só suspenso ou só mexido à mão). */
  status: "proposing" | "proposed" | "confirmed" | "hold";
  holdAuto: boolean;
  proposedAt: string | null;
  proposedBy: string | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  gaps: Gap[];
  summary: string | null;
  /** Última mudança feita à mão (null = intocado): com ela o cron já não mexe no dia. */
  manual: ManualTouch | null;
}

export async function getScheduleState(date: string, city: string): Promise<ScheduleState | null> {
  const db = await getDb();
  if (!db) return null;
  const cols = sql`s.status, s.holdAuto, DATE_FORMAT(s.proposedAt, '%Y-%m-%d %H:%i:%s') AS proposedAt, s.proposedBy,
             DATE_FORMAT(s.confirmedAt, '%Y-%m-%d %H:%i:%s') AS confirmedAt, s.confirmedBy, s.gapsJson, s.summary`;
  let res: unknown;
  try {
    res = await db.execute(sql`
      SELECT ${cols}, UNIX_TIMESTAMP(s.manualAt) AS manualAtUnix, s.manualById, s.manualWhat, u.name AS manualByName
        FROM extras_dia_schedules s LEFT JOIN users u ON u.id = s.manualById
       WHERE s.assignmentDate = ${date} AND s.city = ${city} LIMIT 1`);
  } catch {
    try {
      // Sem as colunas da 0565 (ainda por aplicar): o estado de antes.
      res = await db.execute(sql`SELECT ${cols} FROM extras_dia_schedules s WHERE s.assignmentDate = ${date} AND s.city = ${city} LIMIT 1`);
    } catch {
      return null; // tabela ainda não existe (migração 0115 por correr)
    }
  }
  const r = rowsOf(res)[0];
  if (!r) return null;
  let gaps: Gap[] = [];
  try { gaps = r.gapsJson ? JSON.parse(String(r.gapsJson)) : []; } catch { gaps = []; }
  const manualAtUnix = r.manualAtUnix == null ? null : Number(r.manualAtUnix);
  return {
    status: String(r.status) as ScheduleState["status"],
    holdAuto: Number(r.holdAuto) === 1,
    proposedAt: r.proposedAt ? String(r.proposedAt) : null,
    proposedBy: r.proposedBy ? String(r.proposedBy) : null,
    confirmedAt: r.confirmedAt ? String(r.confirmedAt) : null,
    confirmedBy: r.confirmedBy ? String(r.confirmedBy) : null,
    gaps: Array.isArray(gaps) ? gaps : [],
    summary: r.summary ? String(r.summary) : null,
    manual: manualAtUnix != null && Number.isFinite(manualAtUnix) && manualAtUnix > 0
      ? {
        atUnix: manualAtUnix,
        byId: r.manualById == null ? null : Number(r.manualById),
        byName: r.manualByName ? String(r.manualByName) : null,
        what: r.manualWhat ? String(r.manualWhat) : null,
      }
      : null,
  };
}

/**
 * Uma pessoa mexeu na escala de (dia, cidade): fica registado quem, quando e
 * o quê, e a partir daí o cron nunca mais propõe nesse dia/cidade. Sem estado
 * ainda, nasce 'hold' (sem proposta, sem suspensão). Nunca lança: a mudança da
 * pessoa já está feita (e o cron também reconhece o dia pelas linhas postas
 * à mão e pelo arquivo das tiradas).
 */
export async function markScheduleManual(date: string, city: string, userId: number | null, what: ManualWhat): Promise<void> {
  if (!(SCHEDULE_CITIES as string[]).includes(city)) return;
  try {
    const db = await getDb();
    if (!db) return;
    await db.execute(sql`
      INSERT INTO extras_dia_schedules (assignmentDate, city, status, holdAuto, manualAt, manualById, manualWhat)
      VALUES (${date.slice(0, 10)}, ${city}, 'hold', 0, NOW(), ${userId}, ${what})
      ON DUPLICATE KEY UPDATE manualAt = NOW(), manualById = VALUES(manualById), manualWhat = VALUES(manualWhat)`);
  } catch (err: any) {
    console.warn("[extras-schedule] marca 'mexido à mão' falhou:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
  }
}

/** "Suspender envio automático" num dia/cidade (true = o cron não confirma nem envia). */
export async function setScheduleHold(date: string, city: ScheduleCity, hold: boolean, userId: number | null): Promise<{ hold: boolean }> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  // Sem estado ainda: 'hold' (só suspenso) — NÃO é uma proposta.
  await db.execute(sql`
    INSERT INTO extras_dia_schedules (assignmentDate, city, status, holdAuto)
    VALUES (${date}, ${city}, 'hold', ${hold ? 1 : 0})
    ON DUPLICATE KEY UPDATE holdAuto = VALUES(holdAuto)`);
  // Suspender (ou retomar) é mexer no dia: a proposta automática já não corre nele.
  await markScheduleManual(date, city, userId, hold ? "suspendeu" : "retomou");
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
/** Agora, em UTC, no formato do MySQL (como os outros carimbos escritos pela app). */
const utcNowSql = () => new Date().toISOString().slice(0, 19).replace("T", " ");

/**
 * Avaliação (pts médios/dia, 4 semanas), dias escalados (14 d), faltas e recusas (60 d).
 * Plano 63 (11): a falta de quem tinha avisado antes de ser escalado (0 pontos,
 * shared/leaves.ts → isNoticeNoShow) não conta para a ordem (Jorge, 15 out 2026).
 */
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
         AND NOT (points = 0 AND COALESCE(notes, '') LIKE ${`%${NOTICE_NO_SHOW_MARK}%`})
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

type DriverCandidateRow = Awaited<ReturnType<typeof import("./extrasDia").listDriverCandidates>>[number];

/** Janelas do dia operacional (já calculadas em getAvailabilityForDay: lê D−1, D e D+1). */
export const candidateWindows = (c: { availability?: { windows?: readonly { from: number; to: number }[] } | null }) => c.availability?.windows ?? [];

/**
 * Extras que PODEM entrar na escala do dia/cidade: disponíveis no dia
 * operacional, extras (funcionários só à mão), da cidade da escala (sem cidade
 * não), com a formação obrigatória concluída e (com FERIAS_MAPA) sem aviso de
 * que não estão nesse dia. A mesma lista serve a proposta automática e o
 * "disponíveis por escalar" do indicador de pessoal.
 */
export async function loadEligibleExtras(date: string, city: ScheduleCity): Promise<DriverCandidateRow[]> {
  const db = await getDb();
  if (!db) return [];
  const { listDriverCandidates } = await import("./extrasDia");
  const all = await listDriverCandidates(date);
  const available = all.filter((c) => candidateWindows(c).length > 0);
  if (!available.length) return [];

  const { employeesMissingTraining } = await import("./trainingPaths");
  const untrained = await employeesMissingTraining(available.map((c) => c.id));
  const { resolveCitiesForEmployeeIds } = await import("./employeeCity");
  const cities = await resolveCitiesForEmployeeIds(available.map((c) => c.id));
  const cityKey = city === "lisbon" ? "lisboa" : city;
  // Proposta automática: só EXTRAS e só da cidade da escala (Jorge, 2 out 2026:
  // funcionários só à mão; quem não tem cidade não se escala).
  const eligible = available.filter((c) => {
    if (untrained.has(c.id)) return false;
    if ((c.position ?? "").toLowerCase() !== "extra") return false;
    return (cities.get(c.id)?.city ?? null) === cityKey;
  });
  // Plano 63 (11, só com FERIAS_MAPA): quem avisou "não vou estar" nesse dia (ou tem outra ausência
  // aprovada de dia inteiro) não é proposto. À mão continua a poder pôr-se, com o aviso.
  const away = eligible.length ? await (await import("./leaves")).awayForAutoProposal(date, eligible.map((c) => c.id)) : new Set<number>();
  return away.size ? eligible.filter((c) => !away.has(c.id)) : eligible;
}

/**
 * Extras disponíveis para o dia/cidade, com o que a ordenação precisa. Fora:
 * formação obrigatória por concluir, ficha de outra cidade ou SEM cidade, sem
 * disponibilidade, e quem não é extra (funcionários só à mão).
 */
export async function loadScheduleCandidates(date: string, city: ScheduleCity): Promise<ScheduleCandidate[]> {
  const pool = await loadEligibleExtras(date, city);
  if (!pool.length) return [];
  const { DRIVER_LEVELS } = await import("./extrasDia");
  const { loadExtraRates, rateFor } = await import("./extraRates");
  const rates = await loadExtraRates();
  const hist = await loadHistory(pool.map((c) => c.id), date);
  return pool.map((c) => ({
    id: c.id,
    fullName: c.fullName,
    level: c.suggestedLevel,
    levelLabel: DRIVER_LEVELS.find((l) => l.id === c.suggestedLevel)?.label ?? c.suggestedLevel,
    hourlyRate: rateFor(rates, c.suggestedLevel),
    windows: candidateWindows(c),
    evalScore: hist.evalScore.get(c.id) ?? null,
    recentDays: hist.recentDays.get(c.id) ?? 0,
    noShows: hist.noShows.get(c.id) ?? 0,
    declines: hist.declines.get(c.id) ?? 0,
  }));
}

// ─── Propor ─────────────────────────────────────────────────────────────────

export const PAST_DAY_MESSAGE = "Esse dia já passou: não se confirma nem se avisa ninguém.";

/**
 * A previsão está incompleta? (leitura cortada no limite, ou só a cópia das
 * reservas porque a BD da Multipark não respondeu). A automação não propõe
 * nem avisa faltas com ela. null = completa. PURA.
 */
export function forecastIncompleteReason(f: { bookingsTruncated?: boolean; bookingSource?: string; bookingSourceNotice?: string | null }): string | null {
  if (f.bookingsTruncated) return "previsão incompleta: a leitura das reservas foi cortada no limite";
  if (f.bookingSource === "copy") return `previsão incompleta: ${f.bookingSourceNotice ?? "sem a BD da Multipark (só a cópia das reservas)"}`;
  return null;
}

/**
 * Liberta a reserva do cron. Só a reserva "limpa" (sem suspensão nem marca de
 * mão) sai; um dia suspenso ou mexido à mão entretanto volta a 'hold' — nem a
 * suspensão nem a marca se perdem.
 */
async function releaseAutoClaim(db: { execute: (q: any) => Promise<any> }, date: string, city: string): Promise<void> {
  await db.execute(sql`DELETE FROM extras_dia_schedules WHERE assignmentDate = ${date} AND city = ${city} AND status = 'proposing' AND holdAuto = 0 AND manualAt IS NULL`);
  await db.execute(sql`UPDATE extras_dia_schedules SET status = 'hold' WHERE assignmentDate = ${date} AND city = ${city} AND status = 'proposing'`);
}

export interface ProposeResult {
  status: "proposed" | "skipped";
  reason?: string;
  proposed: number;
  kept: number;
  gaps: Gap[];
  summary: string | null;
  /** Tirados à mão deste dia que ficaram de fora da proposta. */
  removedOut: number;
}

const skippedProposal = (reason: string): ProposeResult => ({ status: "skipped", reason, proposed: 0, kept: 0, gaps: [], summary: null, removedOut: 0 });

/**
 * Condutores tirados à mão deste dia (arquivo, 'removida'; TL fora). Nenhum
 * automatismo os volta a propor para este dia. Lança se a leitura falhar —
 * melhor não propor do que voltar a pôr quem foi tirado.
 */
export async function loadRemovedByHand(date: string): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const res = await db.execute(sql`
    SELECT DISTINCT employeeId FROM extras_dia_assignments_removed
     WHERE assignmentDate = ${date} AND removedReason = 'removida' AND isTeamLeader = 0 AND employeeId IS NOT NULL`);
  return rowsOf(res).map((r) => Number(r.employeeId)).filter((id) => Number.isFinite(id) && id > 0);
}

/**
 * Sinais de mão humana no dia/cidade que não dependem da marca da 0565 (o que
 * foi feito antes dela): condutores postos/alterados à mão e tirados à mão.
 */
async function manualEvidence(db: { execute: (q: any) => Promise<any> }, date: string, city: string): Promise<{ manualRows: number; removedByHand: number }> {
  const res = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM extras_dia_assignments
        WHERE assignmentDate = ${date} AND city = ${city} AND isTeamLeader = 0 AND source = 'manual') AS manualRows,
      (SELECT COUNT(*) FROM extras_dia_assignments_removed
        WHERE assignmentDate = ${date} AND city = ${city} AND isTeamLeader = 0 AND removedReason = 'removida') AS removedByHand`);
  const r = rowsOf(res)[0] ?? {};
  return { manualRows: Number(r.manualRows ?? 0) || 0, removedByHand: Number(r.removedByHand ?? 0) || 0 };
}

type AssignmentRow = {
  id: number; assignmentDate: string; employeeId: number | null; personName: string; city: string;
  isTeamLeader: number; startHour: number; endHour: number; sentHomeHour: number | null;
  status: string; version: number; shift: string;
  /** 'auto' = criada pela proposta automática (só essas se substituem ao refazer). */
  source?: string;
};

/** A proposta refeita substitui esta linha? Só as que ela criou e ainda estão por confirmar (nunca TL). PURA. */
export function replacedByNewProposal(r: { city: string; status: string; isTeamLeader: number; source?: string }, city: string): boolean {
  return r.city === city && r.status === "proposed" && r.isTeamLeader === 0 && (r.source ?? "manual") === "auto";
}

type Exec = { execute: (q: any) => Promise<any> };
/**
 * Linhas que saem da escala → arquivo (a linha inteira, quem, quando e porquê)
 * e só depois saem da tabela. Nunca se perdem.
 */
export async function archiveAssignments(exec: Exec, where: ReturnType<typeof sql>, reason: "removida" | "substituida", userId: number | null): Promise<number> {
  await exec.execute(sql`
    INSERT INTO extras_dia_assignments_removed
      (assignmentId, assignmentDate, city, employeeId, personName, isTeamLeader, shift, startHour, endHour, status, version, rowJson, removedReason, removedById)
    SELECT id, assignmentDate, city, employeeId, personName, isTeamLeader, shift, startHour, endHour, status, version,
      JSON_OBJECT('id', id, 'assignmentDate', assignmentDate, 'city', city, 'employeeId', employeeId, 'personName', personName,
        'level', level, 'isTeamLeader', isTeamLeader, 'shift', shift, 'startHour', startHour, 'endHour', endHour,
        'sentHomeHour', sentHomeHour, 'notes', notes, 'status', status, 'version', version, 'source', source,
        'proposalReason', proposalReason, 'createdById', createdById, 'updatedById', updatedById,
        'createdAt', createdAt, 'updatedAt', updatedAt, 'personAssignedAt', personAssignedAt),
      ${reason}, ${userId}
      FROM extras_dia_assignments WHERE ${where}`);
  return extractAffectedRows(await exec.execute(sql`DELETE FROM extras_dia_assignments WHERE ${where}`));
}

async function loadDayRows(date: string): Promise<AssignmentRow[]> {
  const db = await getDb();
  if (!db) return [];
  const res = await db.execute(sql`
    SELECT id, assignmentDate, employeeId, personName, city, isTeamLeader, startHour, endHour, sentHomeHour, status, version, shift, source
      FROM extras_dia_assignments WHERE assignmentDate = ${date}`);
  return rowsOf(res).map((r) => ({
    id: Number(r.id), assignmentDate: String(r.assignmentDate), employeeId: r.employeeId == null ? null : Number(r.employeeId),
    personName: String(r.personName), city: String(r.city), isTeamLeader: Number(r.isTeamLeader), startHour: Number(r.startHour),
    endHour: Number(r.endHour), sentHomeHour: r.sentHomeHour == null ? null : Number(r.sentHomeHour),
    status: String(r.status ?? "confirmed"), version: Number(r.version ?? 1), shift: String(r.shift),
    source: String(r.source ?? "manual"),
  }));
}

/**
 * Proposta automática para (dia, cidade). `by: 'auto'` (cron) só faz a
 * PRIMEIRA proposta de um dia intocado (sem estado e sem mão humana);
 * `by: 'manual'` refaz a proposta (substitui as linhas `proposed` que ela
 * criou — nunca toca nas confirmadas, nas postas à mão nem no TL) e marca o
 * dia como mexido à mão. Quem foi tirado à mão deste dia fica sempre de fora.
 */
export async function proposeSchedule(input: { date: string; city: ScheduleCity; by: "auto" | "manual"; userId: number | null }): Promise<ProposeResult> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  const { date, city, by } = input;

  if (by === "auto") {
    // Mão humana manda: dia mexido à mão (ou já com proposta/escala/suspensão) → o cron não toca.
    const [state, evidence] = await Promise.all([getScheduleState(date, city), manualEvidence(db, date, city)]);
    const blocked = autoProposeBlockedReason({ state, ...evidence });
    if (blocked) return skippedProposal(blocked);
    // Reserva atómica: só quem INSERE o estado propõe. Antes era um INSERT …
    // ON DUPLICATE KEY UPDATE: com o FOUND_ROWS do mysql2 (ligado por omissão)
    // dava sempre 1 linha afetada, e o cron refazia a proposta a cada corrida —
    // voltava a pôr quem tinha sido tirado e devolvia escalas confirmadas a
    // "por confirmar". INSERT IGNORE num duplicado dá 0, com ou sem FOUND_ROWS.
    const claim = await db.execute(sql`
      INSERT IGNORE INTO extras_dia_schedules (assignmentDate, city, status, proposedBy, proposedAt)
      VALUES (${date}, ${city}, 'proposing', 'auto', NOW())`);
    if (extractAffectedRows(claim) === 0) return skippedProposal("já tem proposta ou escala");
  }

  try {
    const { getExtrasDiaForecast } = await import("./extrasDia");
    const forecast = await getExtrasDiaForecast(addDaysIso(date, -1), city);
    // Com a previsão incompleta o cron não propõe (faltariam pessoas); à mão
    // propõe na mesma, com o aviso no resumo.
    const incomplete = forecastIncompleteReason(forecast);
    if (incomplete && by === "auto") {
      await releaseAutoClaim(db, date, city);
      return skippedProposal(incomplete);
    }
    const needed = forecast.hourly.map((h) => h.driversNeeded);
    const [dayRows, removedIds] = await Promise.all([loadDayRows(date), loadRemovedByHand(date)]);
    // Fica tudo o que a proposta não criou: confirmadas e as postas à mão (mesmo por confirmar).
    const kept = dayRows.filter((r) => r.city === city && r.isTeamLeader === 0 && !replacedByNewProposal(r, city));
    // Quem já está no dia (outra cidade, TL, confirmado ou posto à mão aqui) não entra outra vez.
    const staying = new Set(
      dayRows.filter((r) => !replacedByNewProposal(r, city) && r.employeeId != null).map((r) => r.employeeId as number),
    );
    // Quem foi tirado à mão deste dia também não (salvo se foi posto outra vez à mão — está em `staying`).
    const removedOut = removedByHandOut(removedIds, staying);
    const exclude = new Set([...Array.from(staying), ...removedOut]);
    const candidates = await loadScheduleCandidates(date, city);
    const plan = planSchedule({ needed, existing: kept, candidates, exclude });

    let peakDrivers = 0;
    let peakHour: number | null = null;
    needed.forEach((n, h) => { if (n > peakDrivers) { peakDrivers = n; peakHour = h; } });
    const summaryBody = explainProposal({
      date, city, capacityText: forecast.crewRuleText, peakDrivers, peakHour,
      picks: plan.picks.map((p) => ({ personName: p.personName, startHour: p.startHour, endHour: p.endHour, hourlyRate: p.hourlyRate })),
      keptCount: kept.length,
      gaps: plan.gaps,
      removedOutCount: removedOut.length,
    });
    const summary = incomplete ? `⚠ ${incomplete[0].toUpperCase()}${incomplete.slice(1)}.\n${summaryBody}` : summaryBody;

    let aborted: string | null = null;
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT IGNORE INTO extras_dia_schedules (assignmentDate, city, status) VALUES (${date}, ${city}, 'proposing')`);
      // Serializa propostas concorrentes do mesmo dia/cidade.
      const lock = rowsOf(await tx.execute(sql`
        SELECT status, (manualAt IS NOT NULL) AS manual FROM extras_dia_schedules
         WHERE assignmentDate = ${date} AND city = ${city} FOR UPDATE`))[0];
      // O cron demorou a ler a previsão e entretanto uma pessoa mexeu no dia → desiste.
      if (by === "auto" && lock && (Number(lock.manual) === 1 || String(lock.status) !== "proposing")) {
        aborted = Number(lock.manual) === 1 ? MANUAL_DAY_REASON : "já tem proposta ou escala";
        return;
      }
      // Só as linhas da proposta anterior saem — para o arquivo, nunca apagadas de vez.
      await archiveAssignments(tx, sql`assignmentDate = ${date} AND city = ${city} AND status = 'proposed' AND isTeamLeader = 0 AND source = 'auto'`, "substituida", input.userId);
      for (const p of plan.picks) {
        await tx.execute(sql`
          INSERT INTO extras_dia_assignments
            (assignmentDate, city, employeeId, personName, level, isTeamLeader, shift, startHour, endHour, notes, status, version, proposalReason, createdById, source, personAssignedAt)
          VALUES (${date}, ${city}, ${p.employeeId}, ${p.personName.slice(0, 128)}, ${p.level}, 0, ${p.shift}, ${p.startHour}, ${p.endHour},
                  'proposta automática', 'proposed', 1, ${p.reason.slice(0, 500)}, ${input.userId}, 'auto', ${utcNowSql()})`);
      }
      // Refazer à mão é mexer no dia: a partir daqui o cron já não propõe nele.
      const manualMark = by === "manual" ? sql`, manualAt = NOW(), manualById = ${input.userId}, manualWhat = ${"refez a proposta" satisfies ManualWhat}` : sql``;
      await tx.execute(sql`
        UPDATE extras_dia_schedules
           SET status = 'proposed', proposedAt = NOW(), proposedBy = ${by}, proposedById = ${input.userId},
               gapsJson = ${JSON.stringify(plan.gaps)}, summary = ${summary.slice(0, 1000)}${manualMark}
         WHERE assignmentDate = ${date} AND city = ${city}`);
    });
    if (aborted) {
      await releaseAutoClaim(db, date, city);
      return skippedProposal(aborted);
    }

    const outText = removedOutText(removedOut.length);
    await logActivity({
      userId: input.userId ?? 0,
      action: "extras_schedule_propose",
      entity: "extras_dia_schedules",
      details: `${by === "auto" ? "Proposta automática (cron)" : "Proposta automática (manual)"} · ${date} · ${CITY_LABELS_PT[city]} · ${plan.picks.length} proposto(s), ${kept.length} já escalado(s)${outText ? ` · ${outText}` : ""}${plan.gaps.length ? ` · ${plan.gaps.map(describeGap).join("; ")}` : ""}`,
    });

    if (by === "auto" && plan.gaps.length) {
      try {
        const { notify } = await import("./notify");
        await notify({
          kind: "extras_gap", city,
          title: `Faltam condutores em ${CITY_LABELS_PT[city]} (${date})`,
          body: `Proposta automática: ${plan.gaps.map(describeGap).join("; ")}. Pede disponibilidade a quem não respondeu.`,
          link: "/extras-dia",
          entity: { type: "extras_gap", id: `${date}:${city}` },
        });
      } catch { /* aviso é best-effort */ }
    }
    return { status: "proposed", proposed: plan.picks.length, kept: kept.length, gaps: plan.gaps, summary, removedOut: removedOut.length };
  } catch (err) {
    if (by === "auto") {
      // Liberta a reserva para a próxima corrida tentar outra vez.
      await releaseAutoClaim(db, date, city);
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
  // Confirmar avisa as pessoas: nunca para um dia que já passou.
  if (date < lisbonNow().date) throw new Error(PAST_DAY_MESSAGE);
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
    await markScheduleManual(date, city, input.userId, "confirmou");
  }
  if (confirmed > 0) import("./google/pendingSync").then((m) => m.scheduleGoogleShiftSync({ city, date })).catch(() => undefined);
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
  const res = await withoutMaxAttempts(
    () => db.execute(sql`SELECT assignmentId, version, kind, channel, status, attempts, maxAttempts
      FROM extras_dia_notifications WHERE assignmentId IN (${inList(assignmentIds)})`),
    () => db.execute(sql`SELECT assignmentId, version, kind, channel, status, attempts, 3 AS maxAttempts
      FROM extras_dia_notifications WHERE assignmentId IN (${inList(assignmentIds)})`),
  );
  return rowsOf(res).map((r) => ({
    assignmentId: Number(r.assignmentId), version: Number(r.version), kind: String(r.kind) as NotifyKind,
    channel: String(r.channel) as NotifyChannel, status: String(r.status), attempts: Number(r.attempts),
    maxAttempts: r.maxAttempts == null ? null : Number(r.maxAttempts),
  }));
}

/**
 * Sem a coluna maxAttempts (0705 por aplicar): corre a versão de antes, com
 * o teto antigo (3) — nunca uma 4.ª tentativa para quem já tinha esgotado.
 */
async function withoutMaxAttempts<T>(withCol: () => Promise<T>, without: () => Promise<T>): Promise<T> {
  try { return await withCol(); } catch (err: any) {
    const code = err?.code ?? err?.cause?.code;
    if (code === "ER_BAD_FIELD_ERROR") return without();
    throw err;
  }
}

/**
 * Reserva o envio de (linha, versão, tipo, canal). true = este processo envia.
 * Nova → insere 'sending'. Falhada → só com espera crescente (plano MPV F7):
 * menos de MAX_NOTIFY_ATTEMPTS (4) tentativas e passados 30 × tentativas min
 * desde a última (`updatedAt < NOW() − INTERVAL (30 × attempts) MINUTE`, com
 * 2 min de folga — regra pura `notifyRetryDue`); 'sending' esquecida há mais
 * de 15 min → volta a 'sending'. A idade vem do relógio da BD (o mesmo do
 * `updatedAt`). Duas corridas ao mesmo tempo: só uma ganha (o UPDATE só
 * passa se o estado e as tentativas forem os que se leram).
 */
export async function claimNotification(
  a: { id: number; version: number; employeeId: number | null; assignmentDate: string; city: string },
  kind: NotifyKind,
  channel: NotifyChannel,
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  // As linhas novas nascem com o teto novo (4); as de antes do F7 ficaram com 3 (0705).
  const ins = await withoutMaxAttempts(
    () => db.execute(sql`
      INSERT IGNORE INTO extras_dia_notifications (assignmentId, version, kind, channel, employeeId, assignmentDate, city, status, attempts, maxAttempts)
      VALUES (${a.id}, ${a.version}, ${kind}, ${channel}, ${a.employeeId}, ${a.assignmentDate}, ${a.city}, 'sending', 1, ${MAX_NOTIFY_ATTEMPTS})`),
    () => db.execute(sql`
      INSERT IGNORE INTO extras_dia_notifications (assignmentId, version, kind, channel, employeeId, assignmentDate, city, status, attempts)
      VALUES (${a.id}, ${a.version}, ${kind}, ${channel}, ${a.employeeId}, ${a.assignmentDate}, ${a.city}, 'sending', 1)`),
  );
  if (extractAffectedRows(ins) > 0) return true;
  const seen = rowsOf(await withoutMaxAttempts(
    () => db.execute(sql`
      SELECT status, attempts, maxAttempts, TIMESTAMPDIFF(SECOND, updatedAt, NOW()) AS ageS
        FROM extras_dia_notifications
       WHERE assignmentId = ${a.id} AND version = ${a.version} AND kind = ${kind} AND channel = ${channel} LIMIT 1`),
    () => db.execute(sql`
      SELECT status, attempts, 3 AS maxAttempts, TIMESTAMPDIFF(SECOND, updatedAt, NOW()) AS ageS
        FROM extras_dia_notifications
       WHERE assignmentId = ${a.id} AND version = ${a.version} AND kind = ${kind} AND channel = ${channel} LIMIT 1`),
  ))[0];
  if (!seen) return false;
  const status = String(seen.status ?? "");
  const attempts = Number(seen.attempts ?? 0) || 0;
  const ageMs = Math.max(0, Number(seen.ageS ?? 0) || 0) * 1000;
  const retry = notifyRetryDue({ status, attempts, ageMs, maxAttempts: seen.maxAttempts == null ? null : Number(seen.maxAttempts) })
    || (status === "sending" && ageMs > NOTIFY_SENDING_STALE_MIN * 60_000);
  if (!retry) return false;
  const upd = await db.execute(sql`
    UPDATE extras_dia_notifications SET status = 'sending', attempts = attempts + 1
     WHERE assignmentId = ${a.id} AND version = ${a.version} AND kind = ${kind} AND channel = ${channel}
       AND status = ${status} AND attempts = ${attempts}`);
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

/** Envio de email disponível (API do Gmail pela conta de serviço — server/mail/systemMail.ts)? */
async function emailConfigured(): Promise<boolean> {
  const { isEmailSendConfigured } = await import("./mail/systemMail");
  return isEmailSendConfigured();
}

function whatsappConfigured(): boolean {
  return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/**
 * Email "Aviso de trabalho" (1 por pessoa e versão da linha). Vai para o email
 * de trabalho ou, sem ele, para o pessoal (os extras usam o pessoal — antes
 * ficavam "sem email na ficha"). `shift` limita a um turno ("Avisar este turno").
 */
export async function sendScheduleEmails(
  date: string,
  city: ScheduleCity,
  /** `employeeIds`: só estas pessoas (alternativa de um WhatsApp não entregue, 0375). */
  opts: { respectHold?: boolean; employeeIds?: readonly number[]; shift?: "morning" | "night" | null } = {},
): Promise<NotifySummary["email"]> {
  const db = await getDb();
  const out = { sent: 0, failed: 0, noEmail: 0, skipped: 0 };
  if (!db) return out;
  if (opts.respectHold && (await heldCities(date)).has(city)) return out;
  const only = opts.employeeIds ? new Set(opts.employeeIds) : null;
  const rows = (await loadDayRows(date)).filter((r) =>
    r.city === city && (!opts.shift || r.shift === opts.shift) && (!only || (r.employeeId != null && only.has(r.employeeId))));
  const log = await loadNotifyLog(rows.map((r) => r.id));
  const pending = pendingScheduleNotifications(rows, log, "email");
  out.skipped = rows.filter((r) => r.status === "confirmed" && r.employeeId != null).length - pending.length;
  if (!pending.length) return out;

  const empIds = Array.from(new Set(pending.map((r) => r.employeeId as number)));
  const res = await db.execute(sql`SELECT id, fullName, email, personalEmail, position, isActive, noAutoEmail FROM employees WHERE id IN (${inList(empIds)})`);
  const { noticeEmailAddress, noticeSpans, shiftNoticeEmailLines, shiftNoticeSubject } = await import("../shared/shiftNotice");
  const people = new Map(rowsOf(res).map((r) => [Number(r.id), {
    fullName: String(r.fullName ?? ""),
    email: noticeEmailAddress({ email: r.email ? String(r.email) : null, personalEmail: r.personalEmail ? String(r.personalEmail) : null }) ?? "",
    // Só EXTRAS ativos recebem o email da escala (Jorge, 2 out 2026).
    extra: String(r.position ?? "") === "extra" && Number(r.isActive) === 1,
    noAutoEmail: Number(r.noAutoEmail ?? 0) === 1,
  }]));
  const settings = await loadScheduleSettings();
  const { sendEmail } = await import("./mail/systemMail");

  for (const empId of empIds) {
    const mine = pending.filter((r) => r.employeeId === empId);
    const claimed: AssignmentRow[] = [];
    for (const a of mine) if (await claimNotification(a, "scheduled", "email")) claimed.push(a);
    if (!claimed.length) continue;
    const p = people.get(empId);
    if (p?.noAutoEmail) {
      const { NO_AUTO_EMAIL_ERROR } = await import("../shared/contactPrefs");
      for (const a of claimed) await finishNotification(a, "scheduled", "email", "opted_out", NO_AUTO_EMAIL_ERROR);
      out.skipped += claimed.length;
      continue;
    }
    if (p && !p.extra) {
      const { NOT_EXTRA_NO_NOTICE } = await import("./extrasAutomation");
      for (const a of claimed) await finishNotification(a, "scheduled", "email", "no_contact", NOT_EXTRA_NO_NOTICE);
      out.skipped += claimed.length;
      continue;
    }
    if (!p?.email) {
      for (const a of claimed) await finishNotification(a, "scheduled", "email", "no_contact", "sem email (de trabalho nem pessoal) na ficha");
      out.noEmail += claimed.length;
      continue;
    }
    // Todas as horas confirmadas da pessoa nesta seleção (o mesmo texto da pré-visualização).
    const spans = noticeSpans(rows.filter((a) => a.employeeId === empId && a.status === "confirmed"));
    const text = scheduleMessageText({ date, city, spans, meetingPoint: settings.meetingPoints[city] });
    const first = p.fullName.split(/\s+/)[0] || "olá";
    const lines = shiftNoticeEmailLines(first, text);
    const ok = await sendEmail({
      to: p.email,
      subject: shiftNoticeSubject(date, spans),
      text: lines.join("\n\n"),
      html: lines.map((l) => `<p>${esc(l).replace(/\n/g, "<br/>").replace(esc(text), `<strong>${esc(text)}</strong>`)}</p>`).join(""),
      auto: { kind: "schedule_notice", employeeId: empId },
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
  if (await emailConfigured()) {
    try {
      out.email = await sendScheduleEmails(date, city, { respectHold: opts.respectHold });
    } catch (err: any) {
      out.errors.push(`email: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  } else {
    out.warnings.push("Envio de email (Gmail) não configurado — sem email");
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
  // Para o arquivo (linha inteira + quem + quando), nunca apagada de vez.
  await db.transaction(async (tx) => { await archiveAssignments(tx, sql`id = ${id}`, "removida", userId); });
  out.removed = true;
  // Tirar um condutor é mexer no dia: o cron já não propõe nele e esta pessoa
  // não volta a ser proposta para este dia (loadRemovedByHand).
  if (marksManualDay(row)) await markScheduleManual(row.assignmentDate.slice(0, 10), row.city, userId, "tirou");
  import("./google/pendingSync")
    .then((m) => m.scheduleGoogleShiftSync({ city: row.city, date: row.assignmentDate.slice(0, 10), employeeIds: row.employeeId != null ? [row.employeeId] : [] }))
    .catch(() => undefined);
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
  const empRes = await db.execute(sql`SELECT fullName, email, personalEmail, position, noAutoWhatsapp, noAutoEmail FROM employees WHERE id = ${row.employeeId} LIMIT 1`);
  const emp = rowsOf(empRes)[0];
  // Funcionário posto à mão na escala: nunca foi avisado, também não é avisado da saída.
  if (String(emp?.position ?? "") !== "extra") return out;
  const first = String(emp?.fullName ?? "").split(/\s+/)[0] || "Olá";
  const msg = `Olá ${first}, o teu turno de ${text} foi cancelado — já não precisas de vir. Obrigado!`;

  // WhatsApp: texto livre só com a janela de 24h aberta (não há template de remoção).
  if (whatsappConfigured() && (await claimNotification(row, "removed", "whatsapp"))) {
    let status = "no_contact";
    let detail: string | null = "sem conversa WhatsApp com este extra";
    try {
      const conv = rowsOf(await db.execute(sql`
        SELECT id FROM whatsapp_conversations WHERE employeeId = ${row.employeeId} ORDER BY lastMessageAt DESC, id DESC LIMIT 1`))[0];
      if (Number(emp?.noAutoWhatsapp ?? 0) === 1) {
        const { NO_AUTO_WHATSAPP_ERROR } = await import("../shared/contactPrefs");
        status = "opted_out"; detail = NO_AUTO_WHATSAPP_ERROR;
      } else if (conv) {
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
  // Trabalho ou, sem ele, o pessoal (o mesmo do aviso de trabalho).
  const { noticeEmailAddress } = await import("../shared/shiftNotice");
  const email = noticeEmailAddress({ email: emp?.email ? String(emp.email) : null, personalEmail: emp?.personalEmail ? String(emp.personalEmail) : null }) ?? "";
  if ((await emailConfigured()) && (await claimNotification(row, "removed", "email"))) {
    if (Number(emp?.noAutoEmail ?? 0) === 1) {
      const { NO_AUTO_EMAIL_ERROR } = await import("../shared/contactPrefs");
      await finishNotification(row, "removed", "email", "opted_out", NO_AUTO_EMAIL_ERROR);
      out.email = "opted_out";
    } else if (!email) {
      await finishNotification(row, "removed", "email", "no_contact", "sem email na ficha");
      out.email = "no_contact";
    } else {
      const { sendEmail } = await import("./mail/systemMail");
      const ok = await sendEmail({
        to: email,
        subject: `Escala Multipark — turno cancelado (${text.split(" · ")[0]})`,
        text: `${msg}\n\nMultipark`,
        html: `<p>${esc(msg)}</p><p>Multipark</p>`,
        auto: { kind: "schedule_cancel", employeeId: row.employeeId ?? null },
      } as any);
      await finishNotification(row, "removed", "email", ok ? "sent" : "failed", ok ? null : "falhou o envio do email");
      out.email = ok ? "sent" : "failed";
    }
  }
  return out;
}

// ─── Pedir disponibilidade a quem não respondeu ─────────────────────────────

/**
 * Quem recebe "Pedir disponibilidade a quem não respondeu": EXTRAS ativos, sem
 * resposta para esse dia, DA cidade (sem cidade não — 2 out 2026). A MESMA lista dá
 * o número do botão e o envio — antes o botão contava toda a gente de todas as
 * cidades (25) e o envio ia a 10.
 */
export async function noAnswerTargets(
  date: string, city: ScheduleCity,
  cands?: Array<{ id: number; position?: string | null; availability?: { status?: string | null } | null }>,
): Promise<number[]> {
  const list = cands ?? await (await import("./extrasDia")).listDriverCandidates(date);
  const noAnswer = list.filter((c) => (c.position ?? "").toLowerCase() === "extra" && (c.availability?.status ?? "no_response") === "no_response");
  if (!noAnswer.length) return [];
  const { resolveCitiesForEmployeeIds } = await import("./employeeCity");
  const cities = await resolveCitiesForEmployeeIds(noAnswer.map((c) => c.id));
  const cityKey = city === "lisbon" ? "lisboa" : city;
  // Sem cidade não se pede disponibilidade para uma cidade (pede-se a cidade — ver employeeCityFix).
  return noAnswer.filter((c) => cities.get(c.id)?.city === cityKey).map((c) => c.id);
}

export async function resendAvailabilityRequest(date: string, city: ScheduleCity, userId: number | null): Promise<{ targets: number; emailSent: number; whatsappSent: number }> {
  const ids = await noAnswerTargets(date, city);
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
  /** Regra de capacidade da cidade (D12), em texto. */
  capacityText: string;
  /** Buracos AGORA (previsão vs. escala actual, propostas incluídas). */
  gaps: Gap[];
  neededPeak: number;
  proposedCount: number;
  confirmedCount: number;
  noAnswerCount: number;
  availableCount: number;
  notifications: { assignmentId: number; version: number; kind: string; channel: string; status: string; detail: string | null }[];
  settings: { autoProposeAt: string; autoConfirm: boolean; autoConfirmAt: string; daysAhead: number; manualEditAtConfirm: ManualEditAtConfirm; alertsOn: boolean };
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
    capacityText: forecast.crewRuleText,
    gaps,
    neededPeak: Math.max(0, ...needed),
    proposedCount: mine.filter((r) => r.status === "proposed").length,
    confirmedCount: mine.filter((r) => r.status !== "proposed").length,
    noAnswerCount: (await noAnswerTargets(date, city, cands)).length,
    availableCount: cands.filter((c) => candidateWindows(c).length > 0).length,
    notifications,
    settings: { autoProposeAt: settings.autoProposeAt, autoConfirm: settings.autoConfirm, autoConfirmAt: settings.autoConfirmAt, daysAhead: settings.daysAhead, ...(await (async () => {
      // A opção em vigor de facto ("não confirma e avisa" sem os avisos → confirma) — o cartão diz o que vai acontecer.
      const alertsOn = await scheduleFlagOn(SCHEDULE_ALERTS_FLAG).catch(() => false);
      return { manualEditAtConfirm: effectiveManualEditMode(settings.manualEditAtConfirm, alertsOn), alertsOn };
    })()) },
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

// ─── Avisos que só saem uma vez (0705, extras_dia_alerts) ───────────────────

export type ScheduleAlertKind =
  | "reminder_propose" | "reminder_confirm" | "manual_hold" | "unnotified" | "low_coverage" | "confirm_failed" | "complete";

/** Um aviso libertado (não chegou a ninguém, ou o trabalho falhou) volta a ser tentado no máximo isto. */
export const ALERT_MAX_ATTEMPTS = 3;

type AlertRef = { date: string; city: string; kind: ScheduleAlertKind; key?: string };
const alertWhere = (a: AlertRef) =>
  sql`assignmentDate = ${a.date.slice(0, 10)} AND city = ${a.city} AND kind = ${a.kind} AND alertKey = ${(a.key ?? "").slice(0, 64)}`;

/**
 * Reserva um aviso de (dia, cidade, tipo, chave): true = este processo avisa.
 * 1.ª vez → insere; libertado antes (sem destinatários / erro) e com menos de
 * ALERT_MAX_ATTEMPTS tentativas → volta a ser seu (compare-and-set). Sem a
 * tabela (0705 por aplicar) → false: na dúvida não se avisa (nunca há avisos
 * repetidos a cada 15 min).
 */
export async function claimScheduleAlert(a: AlertRef & { detail?: string | null }): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) return false;
    const res = await db.execute(sql`
      INSERT IGNORE INTO extras_dia_alerts (assignmentDate, city, kind, alertKey, detail)
      VALUES (${a.date.slice(0, 10)}, ${a.city}, ${a.kind}, ${(a.key ?? "").slice(0, 64)}, ${a.detail ? a.detail.slice(0, 1000) : null})`);
    if (extractAffectedRows(res) > 0) return true;
    const again = await db.execute(sql`UPDATE extras_dia_alerts SET released = 0, attempts = attempts + 1, recipients = NULL
      WHERE ${alertWhere(a)} AND released = 1 AND attempts < ${ALERT_MAX_ATTEMPTS}`);
    return extractAffectedRows(again) > 0;
  } catch (err: any) {
    console.warn("[extras-schedule] reserva do aviso falhou:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
    return false;
  }
}

/** Liberta a reserva (o aviso não chegou a ninguém ou o trabalho falhou): a corrida seguinte volta a tentar. Nunca lança. */
export async function releaseScheduleAlert(a: AlertRef): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.execute(sql`UPDATE extras_dia_alerts SET released = 1 WHERE ${alertWhere(a)}`);
  } catch { /* na pior, não se repete */ }
}

/** Quando saiu (ms) um aviso já reservado e não libertado; null = nunca saiu. Nunca lança. */
export async function scheduleAlertSentAt(a: AlertRef): Promise<number | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const r = rowsOf(await db.execute(sql`SELECT UNIX_TIMESTAMP(createdAt) AS at FROM extras_dia_alerts WHERE ${alertWhere(a)} AND released = 0 LIMIT 1`))[0];
    const at = r?.at == null ? NaN : Number(r.at);
    return Number.isFinite(at) && at > 0 ? at * 1000 : null;
  } catch { return null; }
}

/** Quem foi avisado depois de reservado (para o registo). Nunca lança. */
async function noteAlertRecipients(a: AlertRef, recipients: number): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.execute(sql`UPDATE extras_dia_alerts SET recipients = ${recipients} WHERE ${alertWhere(a)}`);
  } catch { /* registo */ }
}

/** Administradores e super admins ativos (recurso quando um aviso não chega a ninguém da cidade). */
async function loadAdminUserIds(): Promise<number[]> {
  try {
    const db = await getDb();
    if (!db) return [];
    const res = await db.execute(sql`SELECT id FROM users WHERE isActive = 1 AND role IN ('admin', 'super_admin') ORDER BY id LIMIT 20`);
    return rowsOf(res).map((r) => Number(r.id)).filter((id) => Number.isFinite(id) && id > 0);
  } catch { return []; }
}

/** Chave curta e estável de uma lista (para "ficaram por avisar" de um conjunto de linhas). */
export function alertKeyOf(parts: readonly (string | number)[]): string {
  let h = 0x811c9dc5;
  const s = [...parts].map(String).sort().join("|");
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${parts.length}:${h.toString(16)}`;
}

/**
 * Linhas da escala (dia, cidade) em que NENHUM canal chegou e nada está por
 * tentar — "ficaram por avisar" (regra pura `unnotifiedAfterRetries`).
 */
export async function loadUnnotifiedAfterRetries(date: string, city: string): Promise<ReturnType<typeof unnotifiedAfterRetries>> {
  const db = await getDb();
  if (!db) return [];
  const q = (maxCol: ReturnType<typeof sql>) => db.execute(sql`
    SELECT n.assignmentId, n.version, n.channel, n.status, n.attempts, ${maxCol} AS maxAttempts, n.detail, a.personName
      FROM extras_dia_notifications n
      JOIN extras_dia_assignments a ON a.id = n.assignmentId AND a.version = n.version AND a.status = 'confirmed'
     WHERE n.assignmentDate = ${date} AND n.city = ${city} AND n.kind = 'scheduled'`);
  const res = await withoutMaxAttempts(() => q(sql`n.maxAttempts`), () => q(sql`3`));
  const { NOT_EXTRA_NOTICE_REASON } = await import("../shared/shiftNotice");
  return unnotifiedAfterRetries(rowsOf(res).map((r) => ({
    assignmentId: Number(r.assignmentId), version: Number(r.version), channel: String(r.channel),
    status: String(r.status), attempts: Number(r.attempts ?? 0), maxAttempts: r.maxAttempts == null ? null : Number(r.maxAttempts),
    detail: r.detail ? String(r.detail) : null, personName: r.personName ? String(r.personName) : null,
  })), NOT_EXTRA_NOTICE_REASON);
}

/**
 * Cobertura da escala de (dia, cidade) agora (previsão ao vivo vs linhas da
 * escala, sem TL). null = previsão incompleta (não se avisa com ela).
 */
export async function loadScheduleCoverage(date: string, city: ScheduleCity): Promise<{ coverage: number; gaps: Gap[] } | null> {
  const { getExtrasDiaForecast } = await import("./extrasDia");
  const [forecast, rows] = await Promise.all([getExtrasDiaForecast(addDaysIso(date, -1), city), loadDayRows(date)]);
  if (forecastIncompleteReason(forecast)) return null;
  const needed = forecast.hourly.map((h) => h.driversNeeded);
  const mine = rows.filter((r) => r.city === city && r.isTeamLeader === 0);
  return { coverage: scheduleCoverage(needed, mine), gaps: summarizeGaps(remainingNeed(needed, mine).map((v, h) => (h < 3 ? 0 : v))) };
}

// ─── Completar com quem respondeu (plano MPV F7, §6.1) ──────────────────────

/** Nota das linhas acrescentadas pelo "completar" (o lembrete das 14:30 lista-as). */
export const COMPLETED_NOTE = "completado com quem respondeu";

export interface CompleteResult {
  status: "completed" | "skipped";
  reason?: string;
  added: Array<{ personName: string; startHour: number; endHour: number }>;
  gaps: Gap[];
}

const skippedComplete = (reason: string): CompleteResult => ({ status: "skipped", reason, added: [], gaps: [] });

/**
 * Antes da confirmação, num dia com a proposta AUTOMÁTICA ainda intocada,
 * acrescenta às horas em falta os extras que entretanto marcaram
 * disponibilidade. Só acrescenta (nunca tira nem muda ninguém); num dia mexido
 * à mão, suspenso, confirmado ou sem proposta automática não faz nada; quem
 * foi tirado à mão fica de fora. As linhas novas ficam "proposta automática"
 * (`source = 'auto'`, a nota diz "completado").
 */
export async function completeSchedule(input: { date: string; city: ScheduleCity }): Promise<CompleteResult> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  const { date, city } = input;
  const [state, evidence] = await Promise.all([getScheduleState(date, city), manualEvidence(db, date, city)]);
  if (!state || state.status !== "proposed" || state.proposedBy !== "auto") return skippedComplete("sem proposta automática por confirmar");
  if (state.holdAuto) return skippedComplete("envio automático suspenso");
  if (state.manual || evidence.manualRows > 0 || evidence.removedByHand > 0) return skippedComplete(MANUAL_DAY_REASON);
  const { getExtrasDiaForecast } = await import("./extrasDia");
  const forecast = await getExtrasDiaForecast(addDaysIso(date, -1), city);
  const incomplete = forecastIncompleteReason(forecast);
  if (incomplete) return skippedComplete(incomplete);
  const needed = forecast.hourly.map((h) => h.driversNeeded);
  const [dayRows, removedIds] = await Promise.all([loadDayRows(date), loadRemovedByHand(date)]);
  const kept = dayRows.filter((r) => r.city === city && r.isTeamLeader === 0);
  if (!remainingNeed(needed, kept).some((v, h) => h >= 3 && v > 0)) return skippedComplete("sem horas em falta");
  const staying = new Set(dayRows.filter((r) => r.employeeId != null).map((r) => r.employeeId as number));
  const exclude = new Set([...Array.from(staying), ...removedByHandOut(removedIds, staying)]);
  const candidates = await loadScheduleCandidates(date, city);
  const plan = planSchedule({ needed, existing: kept, candidates, exclude });
  if (!plan.picks.length) return { ...skippedComplete("ninguém novo disponível para as horas em falta"), gaps: plan.gaps };

  let aborted: string | null = null;
  await db.transaction(async (tx) => {
    const lock = rowsOf(await tx.execute(sql`
      SELECT status, holdAuto, proposedBy, (manualAt IS NOT NULL) AS manual FROM extras_dia_schedules
       WHERE assignmentDate = ${date} AND city = ${city} FOR UPDATE`))[0];
    // Entretanto alguém mexeu, suspendeu ou confirmou → desiste (a mão humana manda).
    if (!lock || String(lock.status) !== "proposed" || String(lock.proposedBy ?? "") !== "auto" || Number(lock.holdAuto) === 1 || Number(lock.manual) === 1) {
      aborted = lock && Number(lock.manual) === 1 ? MANUAL_DAY_REASON : "a escala mudou entretanto";
      return;
    }
    for (const p of plan.picks) {
      await tx.execute(sql`
        INSERT INTO extras_dia_assignments
          (assignmentDate, city, employeeId, personName, level, isTeamLeader, shift, startHour, endHour, notes, status, version, proposalReason, createdById, source, personAssignedAt)
        VALUES (${date}, ${city}, ${p.employeeId}, ${p.personName.slice(0, 128)}, ${p.level}, 0, ${p.shift}, ${p.startHour}, ${p.endHour},
                ${COMPLETED_NOTE}, 'proposed', 1, ${p.reason.slice(0, 500)}, NULL, 'auto', ${utcNowSql()})`);
    }
    const note = `Completado antes da confirmação: ${plan.picks.length} acrescentado(s).${plan.gaps.length ? ` Ainda: ${plan.gaps.map(describeGap).join("; ")}.` : ""}`;
    await tx.execute(sql`
      UPDATE extras_dia_schedules
         SET gapsJson = ${JSON.stringify(plan.gaps)}, summary = LEFT(CONCAT(COALESCE(summary, ''), '\n', ${note}), 1000)
       WHERE assignmentDate = ${date} AND city = ${city}`);
  });
  if (aborted) return skippedComplete(aborted);
  await logActivity({
    userId: 0,
    action: "extras_schedule_complete",
    entity: "extras_dia_schedules",
    details: `Completado com quem respondeu (cron) · ${date} · ${CITY_LABELS_PT[city]} · ${plan.picks.map((p) => `${p.personName} ${p.startHour}h–${p.endHour}h`).join(", ")}${plan.gaps.length ? ` · ${plan.gaps.map(describeGap).join("; ")}` : ""}`.slice(0, 1000),
  });
  return { status: "completed", added: plan.picks.map((p) => ({ personName: p.personName, startHour: p.startHour, endHour: p.endHour })), gaps: plan.gaps };
}

/** Condutores (sem TL) propostos e confirmados num dia/cidade (para o lembrete). */
export async function countScheduleRows(date: string, city: string): Promise<{ proposed: number; confirmed: number }> {
  const mine = (await loadDayRows(date)).filter((r) => r.city === city && r.isTeamLeader === 0);
  return { proposed: mine.filter((r) => r.status === "proposed").length, confirmed: mine.filter((r) => r.status !== "proposed").length };
}

/** Nomes acrescentados pelo "completar" num dia/cidade (para o lembrete). */
export async function loadCompletedNames(date: string, city: string): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    const res = await db.execute(sql`
      SELECT personName FROM extras_dia_assignments
       WHERE assignmentDate = ${date} AND city = ${city} AND isTeamLeader = 0 AND source = 'auto' AND notes = ${COMPLETED_NOTE}
       ORDER BY personName`);
    return rowsOf(res).map((r) => String(r.personName ?? "").trim()).filter(Boolean);
  } catch { return []; }
}

// ─── Orquestração do trabalho (injetável nos testes) ────────────────────────

/** Interruptor lido fresco (sobreposição da BD > env > omissão do catálogo). */
export async function scheduleFlagOn(name: string): Promise<boolean> {
  const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([
    import("./_core/featureFlags"), import("../shared/appSettings"),
  ]);
  await ensureFeatureFlagOverrides();
  return isFeatureEnabled(name, { defaultEnabled: automationFlagDefault(name) });
}

export interface ScheduleAutomationDeps {
  flagOn(name: string): Promise<boolean>;
  loadSettings(): Promise<LoadedScheduleSettings>;
  getState(date: string, city: ScheduleCity): Promise<ScheduleState | null>;
  propose(input: { date: string; city: ScheduleCity; by: "auto"; userId: null }): Promise<ProposeResult>;
  complete(input: { date: string; city: ScheduleCity }): Promise<CompleteResult>;
  confirm(input: { date: string; city: ScheduleCity; by: "auto"; userId: null }): Promise<ConfirmResult>;
  sendNotifications(date: string, city: ScheduleCity, opts: { userId: null; respectHold: true }): Promise<NotifySummary>;
  unnotified(date: string, city: ScheduleCity): Promise<ReturnType<typeof unnotifiedAfterRetries>>;
  coverage(date: string, city: ScheduleCity): Promise<{ coverage: number; gaps: Gap[] } | null>;
  claimAlert(a: { date: string; city: string; kind: ScheduleAlertKind; key?: string; detail?: string | null }): Promise<boolean>;
  releaseAlert(a: { date: string; city: string; kind: ScheduleAlertKind; key?: string }): Promise<void>;
  /** Quando saiu (ms) o aviso reservado (null = nunca). */
  alertSentAt(a: { date: string; city: string; kind: ScheduleAlertKind; key?: string }): Promise<number | null>;
  alert(input: import("./notify").NotifyInput): Promise<{ recipients: number[]; duplicates?: number }>;
  adminIds(): Promise<number[]>;
  noteRecipients(a: { date: string; city: string; kind: ScheduleAlertKind; key?: string }, recipients: number): Promise<void>;
}

export const realScheduleDeps: ScheduleAutomationDeps = {
  flagOn: scheduleFlagOn,
  loadSettings: loadScheduleSettings,
  getState: getScheduleState,
  propose: proposeSchedule,
  complete: completeSchedule,
  confirm: confirmSchedule,
  sendNotifications: sendScheduleNotifications,
  unnotified: loadUnnotifiedAfterRetries,
  coverage: loadScheduleCoverage,
  claimAlert: claimScheduleAlert,
  releaseAlert: releaseScheduleAlert,
  alertSentAt: scheduleAlertSentAt,
  alert: async (input) => (await import("./notify")).notify(input),
  adminIds: loadAdminUserIds,
  noteRecipients: noteAlertRecipients,
};

/** Interruptor dos avisos da escala (manual_hold, low_coverage, unnotified, confirm_failed): sino e email. */
export const SCHEDULE_ALERTS_FLAG = "EXTRAS_SCHEDULE_ALERTS";

/** "faltam 2 condutores entre 14h–17h" → "Faltam 2 …" */
const capital = (s: string) => (s ? `${s[0].toUpperCase()}${s.slice(1)}` : s);

/**
 * /api/cron/extras-schedule (de 15 em 15 min, 08h–23h Lisboa — plano MPV F7):
 *  - a partir de `extras.autoProposeAt` (11:00): propõe amanhã … +N para cada
 *    cidade (só a PRIMEIRA proposta de dias intocados — nunca num dia com
 *    proposta, escala, suspensão ou mexido à mão);
 *  - 30 min antes da confirmação, com EXTRAS_COMPLETE_BEFORE_CONFIRM: completa
 *    as horas em falta de amanhã com quem respondeu (só dias intocados);
 *  - a partir de `extras.autoConfirmAt` (15:00, se `extras.autoConfirm`):
 *    confirma a proposta de amanhã não suspensa e avisa; um dia mexido à mão
 *    segue `extras.manualEditAtConfirm` (D4b);
 *  - escalas já confirmadas e não suspensas de hoje em diante: envia avisos
 *    em falta (linhas editadas → nova versão; falhas → até 4 tentativas, com
 *    30/60/90 min de espera).
 * Os avisos às pessoas (dia mexido por confirmar, cobertura < 80 %, quem
 * ficou por avisar, confirmação falhada) só com EXTRAS_SCHEDULE_ALERTS ligado.
 */
export async function runScheduleAutomation(now: Date = new Date(), deps: ScheduleAutomationDeps = realScheduleDeps): Promise<ScheduleCronReport> {
  const ln = lisbonNow(now);
  const report: ScheduleCronReport = { ok: true, now: ln, ran: [], skipped: [], warnings: [], errors: [], details: {} };
  if (!(await deps.flagOn("EXTRAS_AUTOMATION"))) {
    report.skipped.push("desligado (EXTRAS_AUTOMATION=off)");
    return report;
  }
  const settings = await deps.loadSettings();
  const due = scheduleDue(ln, settings);
  const alertsOn = await deps.flagOn(SCHEDULE_ALERTS_FLAG).catch(() => false);
  const step = async (key: string, fn: () => Promise<unknown>): Promise<{ ok: boolean; out: any; error?: string }> => {
    try {
      const out: any = await fn();
      if (out && out.status === "skipped") report.skipped.push(`${key} (${out.reason ?? "nada a fazer"})`);
      else report.ran.push(key);
      report.details[key] = out;
      for (const w of out?.notifications?.warnings ?? out?.warnings ?? []) if (!report.warnings.includes(w)) report.warnings.push(w);
      for (const e of out?.notifications?.errors ?? out?.errors ?? []) report.errors.push(`${key}: ${e}`);
      return { ok: true, out };
    } catch (err: any) {
      const error = String(err?.message ?? err).slice(0, 200);
      report.errors.push(`${key}: ${error}`);
      return { ok: false, out: null, error };
    }
  };
  /**
   * Aviso a TL + supervisor + back office da cidade (e admins), uma só vez por
   * (dia, cidade, tipo, chave). Só com EXTRAS_SCHEDULE_ALERTS ligado (sino e
   * email). Sem destinatários na cidade → vai aos admins/super admins; sem
   * ninguém mesmo assim → liberta a reserva e tenta na corrida seguinte (no
   * máximo ALERT_MAX_ATTEMPTS vezes).
   */
  const alertOnce = async (a: { date: string; city: ScheduleCity; kind: ScheduleAlertKind; key?: string; title: string; body: string }): Promise<boolean> => {
    const ref = { date: a.date, city: a.city, kind: a.kind, key: a.key };
    if (!alertsOn) { report.skipped.push(`aviso ${a.kind}:${a.date}:${a.city} (${SCHEDULE_ALERTS_FLAG} desligado)`); return false; }
    let claimed = false;
    try {
      if (!(await deps.claimAlert({ ...ref, detail: a.body }))) return false;
      claimed = true;
      const base = {
        kind: "extras_schedule_alert" as const, title: a.title, body: a.body, link: "/extras-dia",
        entity: { type: "extras_schedule_alert", id: `${a.date}:${a.city}:${a.kind}:${a.key ?? ""}` },
      };
      let r = await deps.alert({ ...base, city: a.city });
      let n = r?.recipients?.length ?? 0;
      if (n === 0 && !(r?.duplicates ?? 0)) {
        // Ninguém na cidade (ou todos o silenciaram): os administradores.
        const admins = await deps.adminIds().catch(() => [] as number[]);
        if (admins.length) {
          const ids = new Set(admins);
          r = await deps.alert({ ...base, city: null, noCityToAll: true, alsoUserIds: admins, recipientFilter: (c) => ids.has(c.id) });
          n = r?.recipients?.length ?? 0;
          if (n) report.warnings.push(`aviso ${a.kind} (${a.date}, ${CITY_LABELS_PT[a.city]}): ninguém da cidade o recebe — foi aos admins`);
        }
      }
      if (n === 0 && !(r?.duplicates ?? 0)) {
        await deps.releaseAlert(ref);
        report.warnings.push(`aviso ${a.kind} (${a.date}, ${CITY_LABELS_PT[a.city]}) sem destinatários — volta a tentar na corrida seguinte (até ${ALERT_MAX_ATTEMPTS} vezes)`);
        return false;
      }
      await deps.noteRecipients(ref, n);
      report.ran.push(`alert:${a.kind}:${a.date}:${a.city}`);
      return true;
    } catch (err: any) {
      if (claimed) await deps.releaseAlert(ref).catch(() => undefined);
      report.warnings.push(`aviso ${a.kind} (${a.date}, ${CITY_LABELS_PT[a.city]}) falhou: ${String(err?.message ?? err).slice(0, 120)}`);
      return false;
    }
  };

  for (const date of due.proposeDates) {
    for (const city of SCHEDULE_CITIES) {
      await step(`propose:${date}:${city}`, () => deps.propose({ date, city, by: "auto", userId: null }));
    }
  }

  // Completar com quem respondeu: 30 min antes da confirmação (14:30), só amanhã e só dias intocados.
  const completeFrom = settings.autoConfirmAtMin - 30;
  if (settings.autoConfirm && ln.minutes >= completeFrom && ln.minutes < settings.autoConfirmAtMin && (await deps.flagOn("EXTRAS_COMPLETE_BEFORE_CONFIRM"))) {
    const date = addDaysIso(ln.date, 1);
    for (const city of SCHEDULE_CITIES) {
      // Uma vez por dia e cidade (a leitura da previsão é ao vivo — não se repete de 15 em 15 min);
      // se lançar erro, liberta a reserva para a corrida seguinte (até 3 vezes).
      if (!(await deps.claimAlert({ date, city, kind: "complete" }))) continue;
      const r = await step(`complete:${date}:${city}`, () => deps.complete({ date, city }));
      if (!r.ok) await deps.releaseAlert({ date, city, kind: "complete" }).catch(() => undefined);
    }
  }

  for (const date of due.confirmDates) {
    for (const city of SCHEDULE_CITIES) {
      const state = await deps.getState(date, city);
      // "Não confirma e avisa" com os avisos desligados deixava o dia por confirmar sem ninguém saber → confirma.
      const decision = autoConfirmDecision(state, effectiveManualEditMode(settings.manualEditAtConfirm, alertsOn), now.getTime());
      if (decision.action === "skip") continue;
      const who = state?.manual?.byName ? ` por ${state.manual.byName}` : "";
      const what = state?.manual?.what ? ` (${state.manual.what})` : "";
      if (decision.action === "wait") {
        report.skipped.push(`confirm:${date}:${city} (${decision.reason})`);
        // Mudança tarde demais (depois das ~23:15): a espera acabava depois da última corrida → avisa, não fica pendurada.
        if (settlesAfterLastRun(decision.settleAtMs, ln.date)) {
          await alertOnce({
            date, city, kind: "manual_hold", key: "late",
            title: `Escala de ${fmtDayPt(date)} (${CITY_LABELS_PT[city]}) por confirmar: mexida à mão tarde`,
            body: `O dia foi mexido à mão${who}${what} perto do fim do dia: os ${MANUAL_EDIT_SETTLE_MIN} min de espera passam depois da última volta do agendador (23:45), por isso não vai ser confirmado sozinho. Confirma tu em Extras-dia → Dia → "Confirmar escala".`,
          });
        }
        continue;
      }
      if (decision.action === "hold_notify") {
        report.skipped.push(`confirm:${date}:${city} (${decision.reason})`);
        const body = `O dia foi mexido à mão${who}${what}, por isso às ${settings.autoConfirmAt} não foi confirmado nem os extras foram avisados. Confirma tu em Extras-dia → Dia → "Confirmar escala" (avisa cada extra por WhatsApp e email).`;
        const first = await alertOnce({ date, city, kind: "manual_hold", title: `Escala de ${fmtDayPt(date)} (${CITY_LABELS_PT[city]}) por confirmar: mexida à mão`, body });
        // Continua por confirmar às 18:00 → o aviso repete-se (uma vez), só se o 1.º saiu há pelo menos 1 h.
        const firstAt = first || ln.minutes < MANUAL_HOLD_REPEAT_AT_MIN ? null : await deps.alertSentAt({ date, city, kind: "manual_hold" }).catch(() => null);
        if (firstAt != null && now.getTime() - firstAt >= MANUAL_HOLD_REPEAT_MIN_GAP_MIN * 60_000) {
          await alertOnce({ date, city, kind: "manual_hold", key: "repeat", title: `Escala de ${fmtDayPt(date)} (${CITY_LABELS_PT[city]}) AINDA por confirmar`, body: `Continua por confirmar: ninguém foi avisado para amanhã. ${body}` });
        }
        continue;
      }
      const r = await step(`confirm:${date}:${city}`, () => deps.confirm({ date, city, by: "auto", userId: null }));
      if (!r.ok) {
        await alertOnce({
          date, city, kind: "confirm_failed",
          title: `Escala de ${fmtDayPt(date)} (${CITY_LABELS_PT[city]}): a confirmação automática falhou`,
          body: `A confirmação das ${settings.autoConfirmAt} falhou (${r.error ?? "erro"}). O agendador volta a tentar de 15 em 15 min; se não passar, confirma à mão em Extras-dia → Dia.`,
        });
        continue;
      }
      if (r.out?.status !== "confirmed") continue;
      // Cobertura abaixo de 80 % depois de confirmar → aviso (a previsão é a de agora).
      if (!alertsOn) continue;
      try {
        const cov = await deps.coverage(date, city);
        if (cov && cov.coverage < COVERAGE_ALERT_MIN) {
          await alertOnce({
            date, city, kind: "low_coverage",
            title: `Escala de ${fmtDayPt(date)} (${CITY_LABELS_PT[city]}): só ${Math.round(cov.coverage * 100)} % das horas cobertas`,
            body: `Confirmada às ${settings.autoConfirmAt} com ${Math.round(cov.coverage * 100)} % das horas×condutor previstas (abaixo de ${Math.round(COVERAGE_ALERT_MIN * 100)} %).${cov.gaps.length ? ` ${capital(cov.gaps.map(describeGap).join("; "))}.` : ""} Pede disponibilidade a quem não respondeu ou põe gente à mão.`,
          });
        }
      } catch (err: any) {
        report.warnings.push(`cobertura ${date} ${CITY_LABELS_PT[city]}: ${String(err?.message ?? err).slice(0, 120)}`);
      }
    }
  }
  // Avisos em falta nas escalas já confirmadas (hoje em diante) e quem ficou por avisar.
  for (let i = 0; i <= Math.max(1, settings.daysAhead); i++) {
    const date = addDaysIso(ln.date, i);
    for (const city of SCHEDULE_CITIES) {
      const state = await deps.getState(date, city);
      if (!state || state.status !== "confirmed" || state.holdAuto) continue;
      if (!report.ran.includes(`confirm:${date}:${city}`)) {
        await step(`notify:${date}:${city}`, () => deps.sendNotifications(date, city, { userId: null, respectHold: true }));
      }
      if (!alertsOn) continue;
      try {
        const left = await deps.unnotified(date, city);
        if (left.length) {
          await alertOnce({
            date, city, kind: "unnotified", key: alertKeyOf(left.map((l) => `${l.assignmentId}:${l.version}`)),
            title: `Escala de ${fmtDayPt(date)} (${CITY_LABELS_PT[city]}): ${left.length === 1 ? "1 extra ficou" : `${left.length} extras ficaram`} por avisar`,
            body: `O aviso de trabalho não chegou por nenhum canal (as falhas são tentadas ${MAX_NOTIFY_ATTEMPTS} vezes, a última 3 h depois da primeira): ${left.map((l) => `${l.personName} (${l.reasons.join("; ")})`).join(", ")}. Avisa-os tu (telefone) — em Extras-dia → Dia vês o estado de cada aviso.`,
          });
        }
      } catch (err: any) {
        report.warnings.push(`por avisar ${date} ${CITY_LABELS_PT[city]}: ${String(err?.message ?? err).slice(0, 120)}`);
      }
    }
  }
  report.ok = scheduleCronOk(report);
  return report;
}
