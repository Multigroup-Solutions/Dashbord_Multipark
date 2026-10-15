/**
 * Exceções por data ao horário fixo (plano 63, passo 10b; tabela
 * `schedule_overrides`, migração 0725): "trabalha das HH:MM às HH:MM" ou
 * "folga" numa data. É assim que se marca a rotação do fim de semana.
 *
 *  - Interruptor `FINS_DE_SEMANA` (desligado): o ecrã, as exceções na ficha e
 *    no Perfil, e as exceções no atraso (−5) e nas possíveis faltas. Desligado,
 *    os leitores recebem [] e tudo fica como antes.
 *  - `FINS_DE_SEMANA_AVISO` (desligado): o aviso à pessoa.
 *  - Uma ativa por pessoa e dia; marcar por cima cancela a anterior; cancelar
 *    não apaga (cancelledAt). Fica tudo no registo de atividade.
 *  - Quem marca: o supervisor da cidade, o RH (back office) e os
 *    administradores (`canMarkScheduleOverride`).
 */
import { and, eq, sql } from "drizzle-orm";
import { scheduleOverrides } from "../drizzle/schema";
import { getDb, logActivity, toMysqlDateTime } from "./db";
import { inScopeProject, isOwn, isProtectedTarget, rank, type EmployeeRef, type RhViewer } from "./rhAccess";
import { ROLE_RANK } from "../shared/access";
import { addDays, lisbonDayOf } from "../shared/lisbonDay";
import type { ScheduleOverrideRow } from "../shared/workSchedule";
import { dayLabelPt } from "../shared/weekendRotation";

export const WEEKENDS_FLAG = "FINS_DE_SEMANA";
export const WEEKENDS_NOTIFY_FLAG = "FINS_DE_SEMANA_AVISO";
export const WEEKENDS_OFF_MESSAGE = "Os fins de semana e as exceções por data estão desligados (Definições → Automações → \"RH: fins de semana e exceções por data\").";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
const rowsOf = (res: unknown): any[] => (Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : []) as any[];
const dayStr = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").slice(0, 10));

/** Interruptor lido fresco (Definições → Automações). */
export async function flagOn(name: string): Promise<boolean> {
  const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
  await ensureFeatureFlagOverrides();
  return isFeatureEnabled(name, { defaultEnabled: automationFlagDefault(name) });
}

/** Hoje (dia de calendário de Lisboa). */
export const todayLisbon = (): string => lisbonDayOf(Date.now());

/**
 * Quem marca as exceções de uma ficha (PURA): o super admin; os
 * administradores (nunca numa ficha protegida acima deles); o back office (o
 * RH, em todas as cidades) e o supervisor (na sua cidade) nas fichas abaixo
 * de administrador. NINGUÉM na própria ficha (nem o super admin: o horário de
 * cada um marca-o outra pessoa — como validar os próprios documentos).
 */
export function canMarkScheduleOverride(v: RhViewer, e: EmployeeRef): boolean {
  if (isOwn(v, e.id)) return false;
  if (v.role === "super_admin") return true;
  if (rank(v.role) >= ROLE_RANK.admin) return !isProtectedTarget(v, e);
  const belowAdmin = e.role ? rank(e.role) >= 0 && rank(e.role) < ROLE_RANK.admin : true;
  if (!belowAdmin) return false;
  if (v.role === "backoffice") return true;
  if (v.role === "supervisor") return inScopeProject(v, e.projectId);
  return false;
}

/** Os papéis que abrem o ecrã Fins de semana (o que se pode mudar decide-se pessoa a pessoa). */
export const WEEKENDS_SCREEN_ROLES = ["supervisor", "backoffice", "admin", "super_admin"] as const;

// ─── Leitores (Avaliação e possíveis faltas) ────────────────────────────────

/**
 * Exceções ATIVAS de funcionários ativos (não extras) entre dois dias de
 * calendário, para o atraso e as possíveis faltas. Interruptor desligado, ou
 * a tabela ainda sem existir → [] (fica tudo como antes).
 */
export async function loadActiveOverridesForReaders(db: { execute: (q: any) => Promise<unknown> }, fromDay: string, toDay: string): Promise<ScheduleOverrideRow[]> {
  try {
    if (!(await flagOn(WEEKENDS_FLAG))) return [];
    const rows = rowsOf(await db.execute(sql`
      SELECT o.id, o.employeeId, DATE_FORMAT(o.day, '%Y-%m-%d') AS day, o.kind, o.startTime, o.endTime, o.reason,
             DATE_FORMAT(e.contractStart, '%Y-%m-%d') AS contractStart, DATE_FORMAT(e.contractEnd, '%Y-%m-%d') AS contractEnd
        FROM schedule_overrides o JOIN employees e ON e.id = o.employeeId
       WHERE o.activeFlag = 1 AND o.day >= ${fromDay} AND o.day <= ${toDay}
         AND e.isActive = 1 AND COALESCE(e.position, '') <> 'extra' AND COALESCE(e.contractType, '') <> 'extra'
       ORDER BY o.id`));
    return rows.map((r) => ({
      id: Number(r.id), employeeId: Number(r.employeeId), day: dayStr(r.day), kind: String(r.kind), startTime: r.startTime ?? null, endTime: r.endTime ?? null,
      reason: r.reason ?? null, contractStart: r.contractStart ?? null, contractEnd: r.contractEnd ?? null,
    }));
  } catch (err: any) {
    console.warn("[schedule-overrides] leitura falhou (sem exceções):", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
    return [];
  }
}

// ─── Leitura e escrita ───────────────────────────────────────────────────────

export interface OverrideRecord {
  id: number;
  employeeId: number;
  day: string;
  kind: "work" | "off";
  startTime: string | null;
  endTime: string | null;
  reason: string;
  city: string | null;
  note: string | null;
  active: boolean;
  createdById: number | null;
  createdAt: string | null;
  updatedById: number | null;
  cancelledAt: string | null;
  cancelledById: number | null;
}

function toRecord(r: any): OverrideRecord {
  return {
    id: Number(r.id), employeeId: Number(r.employeeId), day: dayStr(r.day), kind: r.kind === "work" ? "work" : "off",
    startTime: r.startTime ? String(r.startTime).slice(0, 5) : null, endTime: r.endTime ? String(r.endTime).slice(0, 5) : null,
    reason: String(r.reason ?? "other"), city: r.city ?? null, note: r.note ?? null, active: Number(r.activeFlag) === 1,
    createdById: r.createdById != null ? Number(r.createdById) : null, createdAt: r.createdAt ? String(r.createdAt) : null,
    updatedById: r.updatedById != null ? Number(r.updatedById) : null,
    cancelledAt: r.cancelledAt ? String(r.cancelledAt) : null, cancelledById: r.cancelledById != null ? Number(r.cancelledById) : null,
  };
}

async function dbOrThrow(): Promise<Db> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  return db;
}

/** As exceções destas fichas entre dois dias (as ativas; com `includeCancelled`, também as canceladas). */
export async function listOverrides(employeeIds: readonly number[], fromDay: string, toDay: string, opts: { includeCancelled?: boolean } = {}): Promise<OverrideRecord[]> {
  if (!employeeIds.length) return [];
  const db = await dbOrThrow();
  const ids = sql.join(employeeIds.map((id) => sql`${id}`), sql`, `);
  const rows = rowsOf(await db.execute(sql`
    SELECT id, employeeId, DATE_FORMAT(day, '%Y-%m-%d') AS day, kind, startTime, endTime, reason, city, note, activeFlag,
           createdById, createdAt, updatedById, cancelledAt, cancelledById
      FROM schedule_overrides
     WHERE employeeId IN (${ids}) AND day >= ${fromDay} AND day <= ${toDay}
       ${opts.includeCancelled ? sql`` : sql`AND activeFlag = 1`}
     ORDER BY day, id`));
  return rows.map(toRecord);
}

export async function getOverride(id: number): Promise<OverrideRecord | null> {
  const db = await dbOrThrow();
  const [r] = rowsOf(await db.execute(sql`
    SELECT id, employeeId, DATE_FORMAT(day, '%Y-%m-%d') AS day, kind, startTime, endTime, reason, city, note, activeFlag,
           createdById, createdAt, updatedById, cancelledAt, cancelledById
      FROM schedule_overrides WHERE id = ${id} LIMIT 1`));
  return r ? toRecord(r) : null;
}

export interface SetOverrideInput {
  employeeId: number;
  day: string;
  kind: "work" | "off";
  startTime?: string | null;
  endTime?: string | null;
  reason: string;
  note?: string | null;
  city?: string | null;
  userId: number;
}

const describe = (o: { day: string; kind: string; startTime?: string | null; endTime?: string | null; reason?: string | null }) =>
  `${dayLabelPt(o.day)} ${o.day.slice(0, 4)}: ${o.kind === "work" ? `trabalha ${o.startTime}–${o.endTime}` : "folga"}${o.reason ? ` (${o.reason})` : ""}`;

/**
 * Marca a exceção desse dia. Se já havia uma ativa, fica cancelada (nunca se
 * apaga) e entra a nova; igual à que já está → não muda nada. Fica no registo
 * de atividade (antes → depois).
 */
export async function setOverride(input: SetOverrideInput): Promise<{ id: number; replaced: OverrideRecord | null; unchanged: boolean }> {
  const db = await dbOrThrow();
  const startTime = input.kind === "work" ? (input.startTime ?? null) : null;
  const endTime = input.kind === "work" ? (input.endTime ?? null) : null;
  const note = input.note?.trim() ? input.note.trim().slice(0, 255) : null;
  let out: { id: number; replaced: OverrideRecord | null; unchanged: boolean } = { id: 0, replaced: null, unchanged: false };
  await db.transaction(async (tx) => {
    const prev = rowsOf(await tx.execute(sql`
      SELECT id, employeeId, DATE_FORMAT(day, '%Y-%m-%d') AS day, kind, startTime, endTime, reason, city, note, activeFlag,
             createdById, createdAt, updatedById, cancelledAt, cancelledById
        FROM schedule_overrides WHERE employeeId = ${input.employeeId} AND day = ${input.day} AND activeFlag = 1 ORDER BY id DESC FOR UPDATE`)).map(toRecord);
    const same = prev[0] && prev.length === 1 && prev[0].kind === input.kind && prev[0].startTime === startTime && prev[0].endTime === endTime
      && prev[0].reason === input.reason && (prev[0].note ?? null) === note;
    if (same) { out = { id: prev[0].id, replaced: null, unchanged: true }; return; }
    if (prev.length) {
      await tx.update(scheduleOverrides)
        .set({ activeFlag: null, cancelledAt: toMysqlDateTime(new Date()), cancelledById: input.userId, updatedById: input.userId })
        .where(and(eq(scheduleOverrides.employeeId, input.employeeId), eq(scheduleOverrides.day, input.day), eq(scheduleOverrides.activeFlag, 1)));
    }
    const res: any = await tx.insert(scheduleOverrides).values({
      employeeId: input.employeeId, day: input.day, kind: input.kind, startTime, endTime, reason: input.reason,
      city: input.city ?? null, note, activeFlag: 1, createdById: input.userId, updatedById: input.userId,
    });
    out = { id: Number((Array.isArray(res) ? res[0] : res)?.insertId ?? 0), replaced: prev[0] ?? null, unchanged: false };
  });
  if (!out.unchanged) {
    await logActivity({
      userId: input.userId, action: "schedule_override_set", entity: "schedule_overrides", entityId: out.id,
      details: `Exceção ao horário da ficha #${input.employeeId} — ${out.replaced ? `antes: ${describe(out.replaced)} → ` : ""}${describe({ ...input, startTime, endTime })}${note ? ` · ${note}` : ""}`.slice(0, 1000),
    }).catch(() => undefined);
  }
  return out;
}

/** Cancela (nunca apaga) uma exceção ativa. Devolve a exceção como estava, ou null se já não estava ativa. */
export async function cancelOverride(id: number, userId: number): Promise<OverrideRecord | null> {
  const db = await dbOrThrow();
  const before = await getOverride(id);
  if (!before || !before.active) return null;
  const res: any = await db.update(scheduleOverrides)
    .set({ activeFlag: null, cancelledAt: toMysqlDateTime(new Date()), cancelledById: userId, updatedById: userId })
    .where(and(eq(scheduleOverrides.id, id), eq(scheduleOverrides.activeFlag, 1)));
  // outra pessoa cancelou-a (ou substituiu-a) entretanto: não regista nem avisa duas vezes
  const affected = (Array.isArray(res) ? res[0] : res)?.affectedRows;
  if (affected === 0) return null;
  await logActivity({
    userId, action: "schedule_override_cancel", entity: "schedule_overrides", entityId: id,
    details: `Exceção ao horário da ficha #${before.employeeId} cancelada — era: ${describe(before)} (volta o horário fixo nesse dia)`.slice(0, 1000),
  }).catch(() => undefined);
  return before;
}

// ─── Aviso à pessoa (FINS_DE_SEMANA_AVISO) ──────────────────────────────────

export interface OverrideChange { day: string; kind: "work" | "off"; startTime?: string | null; endTime?: string | null; reason?: string | null; cancelled?: boolean }

/** O texto do aviso (PURA). */
export function overrideNoticeText(changes: readonly OverrideChange[]): { title: string; body: string } {
  const sorted = [...changes].sort((a, b) => a.day.localeCompare(b.day));
  const duty = sorted.filter((c) => !c.cancelled && c.kind === "work" && [0, 6].includes(new Date(`${c.day}T00:00:00Z`).getUTCDay()));
  const title = duty.length ? `Estás de serviço: ${duty.map((c) => dayLabelPt(c.day)).join(", ")}` : "O teu horário mudou";
  const line = (c: OverrideChange) => c.cancelled
    ? `${dayLabelPt(c.day)}: cancelado — voltas ao teu horário fixo`
    : c.kind === "work" ? `${dayLabelPt(c.day)}: trabalhas das ${c.startTime} às ${c.endTime}`
      : `${dayLabelPt(c.day)}: folga${c.reason === "compensation" ? " (compensação)" : ""}`;
  return { title: title.slice(0, 200), body: `${sorted.map(line).join("\n")}\n\nVês tudo no Perfil → O meu horário.` };
}

/** Avisa a pessoa (sino; email se ela o ligar) das mudanças de hoje para a frente. Só com os dois interruptores ligados. Nunca lança. */
export async function notifyOverrideChanges(employeeId: number, changes: readonly OverrideChange[], actorUserId: number): Promise<void> {
  try {
    const today = todayLisbon();
    const future = changes.filter((c) => c.day >= today);
    if (!future.length) return;
    if (!(await flagOn(WEEKENDS_FLAG)) || !(await flagOn(WEEKENDS_NOTIFY_FLAG))) return;
    const { getEmployeeById } = await import("./db");
    const emp = (await getEmployeeById(employeeId))?.employee;
    if (!emp?.userId || emp.userId === actorUserId) return;
    const { title, body } = overrideNoticeText(future);
    const { notify } = await import("./notify");
    await notify({
      kind: "my_schedule_override", targetUserId: emp.userId, title, body, link: "/perfil",
      entity: { type: "schedule_override", id: `${employeeId}:${future.map((c) => c.day).join(",")}:${Date.now()}` },
    });
  } catch (err) {
    console.warn("[schedule-overrides] aviso à pessoa falhou:", String((err as any)?.message ?? err).slice(0, 160));
  }
}

// ─── Dados do quadro (pessoas de uma cidade) ────────────────────────────────

export interface BoardPersonRow {
  employeeId: number;
  name: string;
  projectId: number | null;
  position: string | null;
  accountRole: string | null;
  userId: number | null;
  contractStart: string | null;
  contractEnd: string | null;
}

/** Funcionários ativos (não extras) com a cidade da ficha; `projectIds` (âmbito do pedido) filtra, se vier. */
export async function loadActiveStaff(): Promise<BoardPersonRow[]> {
  const db = await dbOrThrow();
  const rows = rowsOf(await db.execute(sql`
    SELECT e.id, e.fullName, e.projectId, e.position, e.userId, u.role AS accountRole,
           DATE_FORMAT(e.contractStart, '%Y-%m-%d') AS contractStart, DATE_FORMAT(e.contractEnd, '%Y-%m-%d') AS contractEnd
      FROM employees e LEFT JOIN users u ON u.id = e.userId
     WHERE e.isActive = 1 AND COALESCE(e.position, '') <> 'extra' AND COALESCE(e.contractType, '') <> 'extra'
     ORDER BY e.fullName`));
  return rows.map((r) => ({
    employeeId: Number(r.id), name: String(r.fullName ?? `#${r.id}`), projectId: r.projectId != null ? Number(r.projectId) : null,
    position: r.position ?? null, accountRole: r.accountRole ?? null, userId: r.userId != null ? Number(r.userId) : null,
    contractStart: r.contractStart ?? null, contractEnd: r.contractEnd ?? null,
  }));
}

/** Horário fixo (todas as linhas, por id) e férias/baixas destas fichas. */
export async function loadSchedulesAndLeaves(employeeIds: readonly number[], fromDay: string, toDay: string) {
  if (!employeeIds.length) return { schedules: [] as any[], leaves: [] as any[] };
  const db = await dbOrThrow();
  const ids = sql.join(employeeIds.map((id) => sql`${id}`), sql`, `);
  const schedules = rowsOf(await db.execute(sql`SELECT id, employeeId, weekday, startTime, endTime, isWorkDay FROM schedules WHERE employeeId IN (${ids}) ORDER BY id`))
    .map((r) => ({ id: Number(r.id), employeeId: Number(r.employeeId), weekday: Number(r.weekday), startTime: String(r.startTime ?? ""), endTime: r.endTime != null ? String(r.endTime) : null, isWorkDay: Number(r.isWorkDay) === 1 }));
  // Férias/baixas (employee_leaves). Plano 63, passo 11: quando houver estado, só as aprovadas.
  const leaves = rowsOf(await db.execute(sql`SELECT employeeId, fromDate, toDate FROM employee_leaves WHERE employeeId IN (${ids}) AND fromDate <= ${toDay} AND toDate >= ${fromDay}`))
    .map((r) => ({ employeeId: Number(r.employeeId), fromDate: String(r.fromDate).slice(0, 10), toDate: String(r.toDate).slice(0, 10) }));
  return { schedules, leaves };
}

/**
 * Janela de leitura à volta dos fins de semana: três semanas para cada lado —
 * os 7 dias seguidos e os dias de serviço à volta (uma semana), mais as folgas
 * de compensação deles (até 7 dias) e as que essas disputam (outra semana).
 */
export const boardWindow = (firstSaturday: string, lastSaturday: string) => ({ from: addDays(firstSaturday, -21), to: addDays(lastSaturday, 22) });
