/**
 * Plano 63, passo 10a — RH → "Horários por rever" (só leitura) e a lista
 * "Fora das faltas automáticas" (`rh.noShowSkip`). O que tem de estar visto
 * antes de o Jorge ligar `RH_FALTAS_HORARIO`. As regras estão em
 * shared/scheduleReview.ts; aqui só se lê a BD (e grava a definição).
 */
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { getDb, logActivity } from "./db";
import {
  LOST_PUNCH_TAG, NO_CLOCK_IN_DAYS, NO_SHOW_SKIP_SETTING_KEY, noShowSkipEntrySchema, scheduleReview,
  withNoShowSkip, withoutNoShowSkip, type NoShowSkipEntry,
} from "../shared/scheduleReview";
import { addDays, lisbonDayOf } from "../shared/lisbonDay";

const rowsOf = (res: unknown): any[] => (Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : []) as any[];
const idList = (ids: number[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `);

/**
 * As listas de "Horários por rever" das cidades de quem vê (funcionários
 * ativos, não extras, com o contrato a correr), a lista "Fora das faltas
 * automáticas", as dispensadas como picagem perdida (prova para o passo 0) e
 * o estado do interruptor. Não escreve nada.
 */
export async function loadScheduleReview(now = Date.now()) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Base de dados indisponível." });
  const today = lisbonDayOf(now);
  const { projectScope } = await import("./cityScope");
  const emps = rowsOf(await db.execute(sql`
    SELECT e.id, e.fullName, e.projectId
      FROM employees e
     WHERE e.isActive = 1
       AND COALESCE(e.position, '') <> 'extra' AND COALESCE(e.contractType, '') <> 'extra'
       AND (e.contractEnd IS NULL OR DATE_FORMAT(e.contractEnd, '%Y-%m-%d') >= ${today})
       AND ${projectScope(sql`e.projectId`)}
     ORDER BY e.fullName
     LIMIT 3000`));
  const ids = emps.map((e) => Number(e.id));
  const schedules = ids.length ? rowsOf(await db.execute(sql`
    SELECT id, employeeId, weekday, startTime, endTime, isWorkDay FROM schedules
     WHERE employeeId IN (${idList(ids)}) ORDER BY id`)) : [];
  const lastIn = new Map<number, string>();
  if (ids.length) {
    for (const r of rowsOf(await db.execute(sql`
      SELECT employeeId, DATE_FORMAT(MAX(recordedAt), '%Y-%m-%d %H:%i:%s') AS lastAt FROM time_records
       WHERE type = 'check_in' AND employeeId IN (${idList(ids)}) GROUP BY employeeId`))) {
      if (r.lastAt) lastIn.set(Number(r.employeeId), lisbonDayOf(String(r.lastAt)));
    }
  }
  const { getSettingFresh } = await import("./appSettings");
  const fresh = await getSettingFresh(NO_SHOW_SKIP_SETTING_KEY);
  const skips: NoShowSkipEntry[] = (fresh?.value as NoShowSkipEntry[] | null) ?? [];
  const review = scheduleReview({
    employees: emps.map((e) => ({ id: Number(e.id), fullName: String(e.fullName ?? ""), projectId: e.projectId != null ? Number(e.projectId) : null, lastCheckInDay: lastIn.get(Number(e.id)) ?? null })),
    schedules: schedules.map((s) => ({ id: Number(s.id), employeeId: Number(s.employeeId), weekday: Number(s.weekday), startTime: s.startTime != null ? String(s.startTime) : null, endTime: s.endTime != null ? String(s.endTime) : null, isWorkDay: Number(s.isWorkDay) })),
    today, skips,
  });
  // a lista "Fora das faltas automáticas": só as pessoas das cidades de quem vê
  const skipIds = skips.map((s) => s.employeeId);
  const skipPeople = new Map<number, { fullName: string; projectId: number | null; isActive: boolean }>();
  if (skipIds.length) {
    for (const r of rowsOf(await db.execute(sql`SELECT e.id, e.fullName, e.projectId, e.isActive FROM employees e
       WHERE e.id IN (${idList(skipIds)}) AND ${projectScope(sql`e.projectId`)}`))) {
      skipPeople.set(Number(r.id), { fullName: String(r.fullName ?? ""), projectId: r.projectId != null ? Number(r.projectId) : null, isActive: Number(r.isActive) === 1 });
    }
  }
  const byUser = new Map<number, string>();
  const userIds = Array.from(new Set(skips.map((s) => s.byUserId).filter((x): x is number => typeof x === "number")));
  if (userIds.length) for (const u of rowsOf(await db.execute(sql`SELECT id, name, email FROM users WHERE id IN (${idList(userIds)})`))) byUser.set(Number(u.id), String(u.name || u.email || `Conta ${u.id}`));
  const skipList = skips.filter((s) => skipPeople.has(s.employeeId)).map((s) => ({
    employeeId: s.employeeId, fullName: skipPeople.get(s.employeeId)!.fullName, projectId: skipPeople.get(s.employeeId)!.projectId,
    isActive: skipPeople.get(s.employeeId)!.isActive, until: s.until, reason: s.reason, active: today <= s.until,
    byName: s.byUserId ? byUser.get(s.byUserId) ?? null : null, at: s.at ?? null,
  })).sort((a, b) => a.fullName.localeCompare(b.fullName, "pt"));
  // dispensadas como "picou noutro sistema / picagem perdida" nos últimos 60 dias (prova para o passo 0)
  const since = `${addDays(today, -60)} 00:00:00`;
  const lost = ids.length ? rowsOf(await db.execute(sql`
    SELECT p.id, p.employeeId, p.relatedId, p.notes, DATE_FORMAT(p.reviewedAt, '%Y-%m-%d %H:%i:%s') AS reviewedAt
      FROM employee_penalties p
     WHERE p.reason = 'other' AND p.status = 'dismissed' AND p.employeeId IN (${idList(ids)})
       AND p.notes LIKE ${"[FALTA HORÁRIO]%"} AND p.notes LIKE ${`%${LOST_PUNCH_TAG}%`}
       AND p.createdAt >= ${since}
     ORDER BY p.id DESC LIMIT 100`)) : [];
  const nameOf = new Map(emps.map((e) => [Number(e.id), String(e.fullName ?? "")]));
  const { fixedNoShowDay } = await import("../shared/scheduleReview");
  const [pending] = ids.length ? rowsOf(await db.execute(sql`
    SELECT COUNT(*) AS n FROM employee_penalties
     WHERE reason = 'other' AND status = 'pending' AND notes LIKE ${"[FALTA HORÁRIO]%"} AND employeeId IN (${idList(ids)})`)) : [];
  // lembrete: as férias deste mês têm de estar lançadas (sem elas, cada dia de férias dá uma possível falta)
  const monthStart = `${today.slice(0, 7)}-01`, monthEnd = `${today.slice(0, 7)}-31`;
  const [leaves] = ids.length ? rowsOf(await db.execute(sql`
    SELECT COUNT(*) AS n, COUNT(DISTINCT employeeId) AS people FROM employee_leaves
     WHERE fromDate <= ${monthEnd} AND toDate >= ${monthStart} AND employeeId IN (${idList(ids)})`)) : [];
  const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }, { FIXED_SCHEDULE_NO_SHOWS_FLAG }] = await Promise.all([
    import("./_core/featureFlags"), import("../shared/appSettings"), import("./rhService"),
  ]);
  await ensureFeatureFlagOverrides();
  const cityOf = await (await import("./aiOps/cities")).projectCityResolver(db);
  return {
    today,
    noClockInDays: NO_CLOCK_IN_DAYS,
    flagOn: isFeatureEnabled(FIXED_SCHEDULE_NO_SHOWS_FLAG, { defaultEnabled: automationFlagDefault(FIXED_SCHEDULE_NO_SHOWS_FLAG) }),
    employeesChecked: emps.length,
    cityByProject: Object.fromEntries(Array.from(new Set([...emps.map((e) => e.projectId), ...skipList.map((s) => s.projectId)].filter((x) => x != null).map(Number))).map((pid) => [pid, cityOf(pid)])),
    ...review,
    /** quem tem pelo menos um dia de trabalho no horário (são estas as pessoas que as faltas automáticas leem) */
    withSchedule: emps.filter((e) => schedules.some((r) => Number(r.employeeId) === Number(e.id) && Number(r.isWorkDay) !== 0))
      .map((e) => ({ employeeId: Number(e.id), fullName: String(e.fullName ?? "") })),
    skips: skipList,
    skipsInvalid: !!fresh?.invalid,
    lostPunches: lost.map((p) => ({ id: Number(p.id), employeeId: Number(p.employeeId), fullName: nameOf.get(Number(p.employeeId)) ?? `#${p.employeeId}`, day: fixedNoShowDay({ notes: p.notes, relatedId: p.relatedId != null ? Number(p.relatedId) : null }), reviewedAt: p.reviewedAt ? String(p.reviewedAt) : null })),
    pendingFixed: Number(pending?.n ?? 0),
    leavesThisMonth: { rows: Number(leaves?.n ?? 0), people: Number(leaves?.people ?? 0) },
  };
}

/** Prazo máximo de uma linha da lista (depois volta-se a pôr, se for preciso). */
export const NO_SHOW_SKIP_MAX_DAYS = 366;

/**
 * Pôr (ou mudar) uma pessoa na lista "Fora das faltas automáticas" até uma
 * data, ou tirá-la (`until` null). Lê a definição sem cache e grava com o
 * `updatedAt` lido (duas pessoas ao mesmo tempo → CONFLICT, nada muda). O
 * histórico fica nas Definições e no registo de atividade.
 */
export async function changeNoShowSkip(user: { id: number }, change: { employeeId: number; until: string | null; reason?: string | null }, now = Date.now()): Promise<{ until: string | null }> {
  const today = lisbonDayOf(now);
  const { getSettingFresh, setSetting, SettingConflictError } = await import("./appSettings");
  const fresh = await getSettingFresh(NO_SHOW_SKIP_SETTING_KEY);
  if (!fresh) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não deu para ler a lista. Tenta de novo." });
  const current = (fresh.value as NoShowSkipEntry[] | null) ?? [];
  let next: NoShowSkipEntry[];
  let details: string;
  if (change.until == null) {
    if (!current.some((e) => e.employeeId === change.employeeId)) return { until: null };
    next = withoutNoShowSkip(current, change.employeeId);
    details = `Ficha #${change.employeeId} volta às faltas automáticas (horário fixo)`;
  } else {
    if (change.until < today) throw new TRPCError({ code: "BAD_REQUEST", message: "A data tem de ser hoje ou depois." });
    if (change.until > addDays(today, NO_SHOW_SKIP_MAX_DAYS)) throw new TRPCError({ code: "BAD_REQUEST", message: "No máximo um ano. Depois volta a pôr, se for preciso." });
    const parsed = noShowSkipEntrySchema.safeParse({ employeeId: change.employeeId, until: change.until, reason: change.reason ?? "", byUserId: user.id, at: new Date(now).toISOString().slice(0, 19).replace("T", " ") });
    if (!parsed.success) throw new TRPCError({ code: "BAD_REQUEST", message: parsed.error.issues[0]?.message ?? "Dados inválidos." });
    next = withNoShowSkip(current, parsed.data, today);
    details = `Ficha #${change.employeeId} fora das faltas automáticas (horário fixo) até ${parsed.data.until} — ${parsed.data.reason}`;
  }
  try {
    await setSetting(NO_SHOW_SKIP_SETTING_KEY, next, user.id, { expectedUpdatedAt: fresh.updatedAt });
  } catch (err) {
    if (err instanceof SettingConflictError) throw new TRPCError({ code: "CONFLICT", message: "Alguém mudou a lista entretanto. Atualiza e volta a tentar." });
    throw new TRPCError({ code: "BAD_REQUEST", message: String((err as any)?.message ?? err) });
  }
  await logActivity({ userId: user.id, action: "update", entity: "no_show_skip", entityId: change.employeeId, details: details.slice(0, 1000) });
  return { until: change.until };
}
