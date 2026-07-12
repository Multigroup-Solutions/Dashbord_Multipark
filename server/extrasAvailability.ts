/**
 * Extras Availability — disponibilidade semanal declarada pelos próprios extras.
 *
 * Fluxo:
 *   1. Backoffice envia (manual) um pedido por email a todos os extras ativos
 *      (com email) → link para /disponibilidade?week=YYYY-MM-DD.
 *   2. O extra abre o link no telemóvel, já autenticado com o login dele, e marca
 *      os dias da semana + turnos (manhã/noite) e/ou horas.
 *   3. Backoffice vê o resumo por dia/turno em Extras-Dia.
 *
 * Sem tokens nem páginas públicas — usa a autenticação normal da app. Cada extra
 * só pode ver/editar a própria disponibilidade (mapeado por employees.userId).
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./db";
import { employees, extrasAvailability } from "../drizzle/schema";

// ─── Helpers de datas ──────────────────────────────────────────────────────────

const WEEKDAY_LABELS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Valida 'YYYY-MM-DD' e devolve um Date à meia-noite local. */
function parseIsoDate(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00");
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Segunda-feira da semana que contém `ref` (ou hoje). */
export function mondayOf(ref?: Date): string {
  const d = ref ? new Date(ref) : new Date();
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Dom … 6=Sáb
  const diff = dow === 0 ? -6 : 1 - dow; // recua até segunda
  d.setDate(d.getDate() + diff);
  return isoDate(d);
}

/** Segunda-feira da PRÓXIMA semana — default do pedido semanal. */
export function nextMonday(ref?: Date): string {
  const m = parseIsoDate(mondayOf(ref))!;
  m.setDate(m.getDate() + 7);
  return isoDate(m);
}

export interface DayInfo {
  day: string; // YYYY-MM-DD
  label: string; // ex: "Segunda 23/06"
}

/** Os 7 dias a partir de weekStart (inclusive). */
export function weekDays(weekStart: string): DayInfo[] {
  const start = parseIsoDate(weekStart);
  if (!start) return [];
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return {
      day: isoDate(d),
      label: `${WEEKDAY_LABELS[d.getDay()]} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`,
    };
  });
}

// ─── Extras ativos ───────────────────────────────────────────────────────────

export interface ActiveExtra {
  id: number;
  fullName: string;
  email: string | null;
  phone: string | null;
  projectId: number | null;
}

export async function listActiveExtras(projectId?: number | null): Promise<ActiveExtra[]> {
  const db = await getDb();
  if (!db) return [];
  const conds = [eq(employees.isActive, 1), eq(employees.position, "extra")];
  if (projectId != null) conds.push(eq(employees.projectId, projectId));
  const rows = await db
    .select({
      id: employees.id,
      fullName: employees.fullName,
      email: employees.email,
      phone: employees.phone,
      projectId: employees.projectId,
    })
    .from(employees)
    .where(and(...conds))
    .orderBy(asc(employees.fullName));
  return rows;
}

// ─── Disponibilidade de um extra (a própria página dele) ───────────────────────

export interface AvailabilityDay {
  day: string;
  label: string;
  morning: boolean;
  night: boolean;
  fromHour: number | null;
  toHour: number | null;
  note: string | null;
}

export interface MyWeek {
  weekStart: string;
  weekEnd: string;
  days: AvailabilityDay[];
  submitted: boolean; // já guardou alguma coisa para esta semana?
}

export async function getMyWeek(employeeId: number, weekStart: string): Promise<MyWeek> {
  const days = weekDays(weekStart);
  const weekEnd = days.length ? days[days.length - 1].day : weekStart;
  const db = await getDb();
  const existing = db
    ? await db
        .select()
        .from(extrasAvailability)
        .where(and(eq(extrasAvailability.employeeId, employeeId), eq(extrasAvailability.weekStart, weekStart)))
    : [];
  const byDay = new Map(existing.map(r => [r.day, r]));
  return {
    weekStart,
    weekEnd,
    submitted: existing.length > 0,
    days: days.map(d => {
      const r = byDay.get(d.day);
      return {
        day: d.day,
        label: d.label,
        morning: r ? r.morning === 1 : false,
        night: r ? r.night === 1 : false,
        fromHour: r?.fromHour ?? null,
        toHour: r?.toHour ?? null,
        note: r?.note ?? null,
      };
    }),
  };
}

export interface SetDayInput {
  day: string;
  morning?: boolean;
  night?: boolean;
  fromHour?: number | null;
  toHour?: number | null;
  note?: string | null;
}

/**
 * Substitui a disponibilidade do extra para a semana: apaga as linhas dessa
 * semana e regrava apenas os dias com algo marcado (turno, horas ou nota).
 */
export async function setMyAvailability(
  employeeId: number,
  weekStart: string,
  inputDays: SetDayInput[],
  createdById?: number | null,
): Promise<{ saved: number }> {
  const db = await getDb();
  if (!db) return { saved: 0 };
  const validDays = new Set(weekDays(weekStart).map(d => d.day));

  await db
    .delete(extrasAvailability)
    .where(and(eq(extrasAvailability.employeeId, employeeId), eq(extrasAvailability.weekStart, weekStart)));

  const rows = inputDays
    .filter(d => validDays.has(d.day))
    .map(d => ({
      employeeId,
      weekStart,
      day: d.day,
      morning: d.morning ? 1 : 0,
      night: d.night ? 1 : 0,
      fromHour: d.fromHour ?? null,
      toHour: d.toHour ?? null,
      note: d.note ? d.note.slice(0, 300) : null,
      createdById: createdById ?? null,
    }))
    // só guarda dias com alguma indicação
    .filter(r => r.morning === 1 || r.night === 1 || r.fromHour != null || r.toHour != null || r.note);

  if (rows.length > 0) await db.insert(extrasAvailability).values(rows);
  return { saved: rows.length };
}

// ─── Resumo para o backoffice ──────────────────────────────────────────────────

export interface OverviewExtra {
  employeeId: number;
  fullName: string;
  phone: string | null;
  responded: boolean;
  availableDays: number;
  days: { day: string; morning: boolean; night: boolean; fromHour: number | null; toHour: number | null; note: string | null }[];
}

export interface WeekOverview {
  weekStart: string;
  weekEnd: string;
  dayHeaders: DayInfo[];
  totalExtras: number;
  responded: number;
  perDay: { day: string; morning: number; night: number }[];
  extras: OverviewExtra[];
}

export async function getWeekOverview(weekStart: string, projectId?: number | null): Promise<WeekOverview> {
  const headers = weekDays(weekStart);
  const weekEnd = headers.length ? headers[headers.length - 1].day : weekStart;
  const extras = await listActiveExtras(projectId);
  const db = await getDb();

  const ids = extras.map(e => e.id);
  const rows = db && ids.length
    ? await db
        .select()
        .from(extrasAvailability)
        .where(and(eq(extrasAvailability.weekStart, weekStart), inArray(extrasAvailability.employeeId, ids)))
    : [];

  const byEmp = new Map<number, typeof rows>();
  for (const r of rows) {
    const list = byEmp.get(r.employeeId) ?? [];
    list.push(r);
    byEmp.set(r.employeeId, list);
  }

  const perDay = headers.map(h => ({ day: h.day, morning: 0, night: 0 }));
  const perDayIdx = new Map(perDay.map((p, i) => [p.day, i]));

  const overviewExtras: OverviewExtra[] = extras.map(e => {
    const empRows = byEmp.get(e.id) ?? [];
    const dayMap = new Map(empRows.map(r => [r.day, r]));
    let availableDays = 0;
    const days = headers.map(h => {
      const r = dayMap.get(h.day);
      const morning = r ? r.morning === 1 : false;
      const night = r ? r.night === 1 : false;
      if (morning || night || r?.fromHour != null) availableDays++;
      if (morning) perDay[perDayIdx.get(h.day)!].morning++;
      if (night) perDay[perDayIdx.get(h.day)!].night++;
      return { day: h.day, morning, night, fromHour: r?.fromHour ?? null, toHour: r?.toHour ?? null, note: r?.note ?? null };
    });
    return { employeeId: e.id, fullName: e.fullName, phone: e.phone, responded: empRows.length > 0, availableDays, days };
  });

  return {
    weekStart,
    weekEnd,
    dayHeaders: headers,
    totalExtras: extras.length,
    responded: overviewExtras.filter(e => e.responded).length,
    perDay,
    extras: overviewExtras,
  };
}

// ─── Disponibilidade de um DIA (para alimentar o Extras-Dia) ───────────────────

export type DayAvailabilityStatus = "available" | "unavailable" | "no_response";

export interface DayAvailability {
  status: DayAvailabilityStatus;
  morning: boolean;
  night: boolean;
  fromHour: number | null;
  toHour: number | null;
  note: string | null;
}

/**
 * Devolve um Map employeeId → disponibilidade para o dia `date` (YYYY-MM-DD).
 *   - available    → marcou turno/horas nesse dia
 *   - unavailable  → respondeu à semana mas não marcou esse dia
 *   - no_response  → não respondeu (não recebeu/não abriu o link)
 */
export async function getAvailabilityForDay(date: string): Promise<Map<number, DayAvailability>> {
  const map = new Map<number, DayAvailability>();
  const db = await getDb();
  if (!db || !parseIsoDate(date)) return map;
  const weekStart = mondayOf(parseIsoDate(date)!);

  const rows = await db
    .select()
    .from(extrasAvailability)
    .where(eq(extrasAvailability.weekStart, weekStart));

  const respondedWeek = new Set<number>();
  const dayRow = new Map<number, typeof rows[number]>();
  for (const r of rows) {
    respondedWeek.add(r.employeeId);
    if (r.day === date) dayRow.set(r.employeeId, r);
  }

  for (const empId of respondedWeek) {
    const r = dayRow.get(empId);
    const available = !!r && (r.morning === 1 || r.night === 1 || r.fromHour != null);
    map.set(empId, {
      status: available ? "available" : "unavailable",
      morning: r?.morning === 1,
      night: r?.night === 1,
      fromHour: r?.fromHour ?? null,
      toHour: r?.toHour ?? null,
      note: r?.note ?? null,
    });
  }
  return map;
}

// ─── Envio do pedido semanal por email ─────────────────────────────────────────

export interface SendResult {
  total: number;
  sent: number;
  failed: number;
  noEmail: number;
  recipients: { name: string; email: string | null; ok: boolean }[];
}

function emailHtml(name: string, weekLabel: string, link: string, note?: string | null): string {
  const firstName = name.trim().split(/\s+/)[0] || name;
  const noteHtml = note ? `<p style="background:#f3f4f6;padding:12px;border-radius:6px">${note}</p>` : "";
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1f2937">
    <h2 style="color:#111827">Disponibilidade — semana de ${weekLabel}</h2>
    <p>Olá ${firstName},</p>
    <p>Indica a tua disponibilidade para a próxima semana (dias e horas). É rápido: abre o link abaixo no telemóvel — já entras com o teu login.</p>
    ${noteHtml}
    <p style="text-align:center;margin:28px 0">
      <a href="${link}" style="background:#2563eb;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:bold;display:inline-block">
        Marcar a minha disponibilidade
      </a>
    </p>
    <p style="font-size:13px;color:#6b7280">Se o botão não funcionar, copia este link:<br>${link}</p>
    <p style="font-size:13px;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:12px;margin-top:20px">Multipark — Operações</p>
  </div>`;
}

export async function sendWeeklyAvailabilityRequest(opts: {
  weekStart: string;
  origin: string;
  projectId?: number | null;
  note?: string | null;
  employeeIds?: number[] | null; // se vier, envia SÓ a estes extras
  testEmail?: string | null;     // se vier, envia SÓ a este endereço (teste)
}): Promise<SendResult> {
  if (!parseIsoDate(opts.weekStart)) {
    throw new Error("weekStart inválido (esperado YYYY-MM-DD)");
  }
  const { sendEmail } = await import("./_core/notification");
  const headers = weekDays(opts.weekStart);
  const weekLabel = headers.length
    ? `${headers[0].label} a ${headers[headers.length - 1].label}`
    : opts.weekStart;
  const origin = opts.origin.replace(/\/+$/, "");
  const link = `${origin}/disponibilidade?week=${encodeURIComponent(opts.weekStart)}`;

  // Modo TESTE: envia uma única mensagem para o endereço indicado.
  if (opts.testEmail) {
    const html = emailHtml("Teste", weekLabel, link, opts.note);
    const ok = await sendEmail({
      to: opts.testEmail,
      subject: `[TESTE] Disponibilidade — semana de ${weekLabel}`,
      html,
      from: "recursos-humanos@multipark.pt",
      fromName: "Multipark Operações",
    });
    return {
      total: 1,
      sent: ok ? 1 : 0,
      failed: ok ? 0 : 1,
      noEmail: 0,
      recipients: [{ name: "Teste", email: opts.testEmail, ok }],
    };
  }

  let extras = await listActiveExtras(opts.projectId);
  if (opts.employeeIds && opts.employeeIds.length) {
    const set = new Set(opts.employeeIds);
    extras = extras.filter(e => set.has(e.id));
  }
  const result: SendResult = { total: extras.length, sent: 0, failed: 0, noEmail: 0, recipients: [] };

  for (const e of extras) {
    if (!e.email) {
      result.noEmail++;
      result.recipients.push({ name: e.fullName, email: null, ok: false });
      continue;
    }
    const html = emailHtml(e.fullName, weekLabel, link, opts.note);
    const ok = await sendEmail({
      to: e.email,
      subject: `Disponibilidade — semana de ${weekLabel}`,
      html,
      from: "recursos-humanos@multipark.pt",
      fromName: "Multipark Operações",
    });
    if (ok) result.sent++;
    else result.failed++;
    result.recipients.push({ name: e.fullName, email: e.email, ok });
  }

  return result;
}
