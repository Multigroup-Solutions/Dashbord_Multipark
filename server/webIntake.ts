/**
 * Web Intake — dados que chegam do website multidriver via /api/v1.
 *
 * Dois fluxos, ambos keyed por EMAIL (fonte de verdade da identidade):
 *   1. Candidaturas "Be a Driver"  → upsert em `driver_applications`
 *      (UNIQUE(email) — re-submissão actualiza, nunca duplica).
 *   2. Disponibilidade semanal     → resolve a pessoa pelo email através de
 *      `server/identity.ts` (procura na ficha de colaborador E na conta de
 *      login); só cria um extra pendente quando o email é MESMO desconhecido.
 *      Escreve via setMyAvailability (mesma tabela/lógica da página interna).
 *
 * O website é NÃO-confiável mesmo com API key → validação zod à entrada e
 * o email de disponibilidade vem verificado pelo Google sign-in do site,
 * nunca de input livre do utilizador.
 */
import { z } from "zod";
import { asc, desc, eq, sql } from "drizzle-orm";
import { getDb, logActivity } from "./db";
import { driverApplications } from "../drizzle/schema";
import { setMyAvailability, weekDays, type SetDayInput } from "./extrasAvailability";
import { findOrCreateExtraByEmail } from "./identity";
import { normalizeEmail } from "../shared/email";
import { normalizePhoneForStorage } from "../shared/phone";

// Re-exportado por compatibilidade: a implementação canónica vive em
// `shared/email.ts` (usada também pelo login e pelo matching de contas).
export { normalizeEmail };

// ─── 1. Candidaturas "Be a Driver" ──────────────────────────────────────────

export const driverApplicationSchema = z.object({
  email: z.string().email().max(320),
  firstName: z.string().min(1).max(128),
  lastName: z.string().max(128).optional().default(""),
  phone: z.string().max(32).nullable().optional(),
  city: z.string().max(128).nullable().optional(),
  country: z.string().max(64).nullable().optional(),
  nif: z.string().max(20).nullable().optional(),
  drivingExperience: z.string().max(64).nullable().optional(),
  expectedHourlyRate: z.string().max(32).nullable().optional(),
  howDidYouKnow: z.string().max(64).nullable().optional(),
  // Candidatura completa em bruto (todos os campos do formulário do site).
  payload: z.record(z.string(), z.unknown()).nullable().optional(),
});

export type DriverApplicationInput = z.infer<typeof driverApplicationSchema>;

export interface UpsertApplicationResult {
  id: number;
  created: boolean;
  submissionCount: number;
}

export async function upsertDriverApplication(input: DriverApplicationInput): Promise<UpsertApplicationResult> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");

  const email = normalizeEmail(input.email);
  const fullName = `${input.firstName} ${input.lastName ?? ""}`.trim().slice(0, 256);
  const fields = {
    fullName,
    // Normalizado à ENTRADA: o formulário é texto livre e este telefone é
    // copiado para a ficha do extra (e daí para o envio WhatsApp).
    phone: normalizePhoneForStorage(input.phone ?? null),
    city: input.city?.slice(0, 128) ?? null,
    country: input.country?.slice(0, 64) ?? null,
    nif: input.nif?.slice(0, 20) ?? null,
    drivingExperience: input.drivingExperience?.slice(0, 64) ?? null,
    expectedHourlyRate: input.expectedHourlyRate?.slice(0, 32) ?? null,
    howDidYouKnow: input.howDidYouKnow?.slice(0, 64) ?? null,
    payload: input.payload ?? null,
  };

  // Case-insensitive: linhas antigas podem ter ficado com maiúsculas antes de
  // a normalização existir — sem isto, "Joao@x.pt" criaria uma 2ª candidatura.
  const existing = await db
    .select({ id: driverApplications.id, submissionCount: driverApplications.submissionCount })
    .from(driverApplications)
    .where(sql`LOWER(TRIM(${driverApplications.email})) = ${email}`)
    .orderBy(asc(driverApplications.id))
    .limit(1);

  const now = new Date().toISOString().slice(0, 19).replace("T", " ");

  if (existing.length > 0) {
    const count = existing[0].submissionCount + 1;
    await db
      .update(driverApplications)
      .set({ ...fields, submissionCount: count, lastSubmittedAt: now })
      .where(eq(driverApplications.id, existing[0].id));
    await logActivity({
      userId: 0,
      action: "driver_application_resubmit",
      entity: "driver_applications",
      entityId: existing[0].id,
      details: `[Website] Re-submissão de candidatura: ${fullName} <${email}> (${count}ª vez)`,
    });
    return { id: existing[0].id, created: false, submissionCount: count };
  }

  const result = await db.insert(driverApplications).values({ email, ...fields });
  const id = Number((result as any)[0]?.insertId ?? (result as any).insertId);
  await logActivity({
    userId: 0,
    action: "driver_application_create",
    entity: "driver_applications",
    entityId: id,
    details: `[Website] Nova candidatura de condutor: ${fullName} <${email}>`,
  });
  return { id, created: true, submissionCount: 1 };
}

// ─── 1b. Revisão de candidaturas (backoffice, via tRPC) ─────────────────────

export type ApplicationStatus = "new" | "reviewed" | "approved" | "rejected";

export async function listDriverApplications(status?: ApplicationStatus | null) {
  const db = await getDb();
  if (!db) return [];
  const base = db.select().from(driverApplications);
  const rows = status
    ? await base.where(eq(driverApplications.status, status)).orderBy(desc(driverApplications.lastSubmittedAt))
    : await base.orderBy(desc(driverApplications.lastSubmittedAt));
  return rows;
}

export async function setApplicationStatus(
  id: number,
  status: ApplicationStatus,
  reviewedById: number,
  notes?: string | null,
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  await db
    .update(driverApplications)
    .set({ status, reviewedById, reviewedAt: now, ...(notes !== undefined ? { notes: notes ? notes.slice(0, 512) : null } : {}) })
    .where(eq(driverApplications.id, id));
}

/**
 * Aprova uma candidatura: cria (ou liga a) um employee extra com o mesmo
 * email e marca a candidatura como aprovada. Idempotente — re-aprovar liga
 * ao mesmo employee.
 */
export async function approveApplication(id: number, reviewedById: number): Promise<{ employeeId: number; employeeCreated: boolean }> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");

  const rows = await db.select().from(driverApplications).where(eq(driverApplications.id, id)).limit(1);
  if (rows.length === 0) throw new Error("Candidatura não encontrada");
  const app = rows[0];

  const { id: employeeId, created } = await findOrCreateExtraByEmail(db, app.email, {
    fullName: app.fullName,
    phone: app.phone,
    nif: app.nif,
  });
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  await db
    .update(driverApplications)
    .set({ status: "approved", employeeId, reviewedById, reviewedAt: now })
    .where(eq(driverApplications.id, id));

  await logActivity({
    userId: reviewedById,
    action: "driver_application_approve",
    entity: "driver_applications",
    entityId: id,
    details: `Candidatura aprovada: ${app.fullName} <${app.email}> → employee ${employeeId}${created ? " (criado)" : " (existente)"}`,
  });

  return { employeeId, employeeCreated: created };
}

// ─── 2. Disponibilidade semanal por email ───────────────────────────────────

// O site envia os slots fixos tal-e-qual o formulário; a tradução para o
// modelo interno (manhã/noite + fromHour/toHour) vive AQUI, para o dashboard
// ser dono do domínio e o site poder mudar de layout sem tocar no mapeamento.
const WEBSITE_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

// Horas em formato "estendido": to > 24 = madrugada do dia seguinte.
const SLOT_RANGES: Record<string, { from: number; to: number }> = {
  "04H-08H": { from: 4, to: 8 },
  "04H-15H": { from: 4, to: 15 },
  "08H-15H": { from: 8, to: 15 },
  "15H-01H": { from: 15, to: 25 },
  "18H-01H": { from: 18, to: 25 },
};

const websiteDaySchema = z.object({
  slots: z.array(z.string().max(16)).max(8).default([]),
  other: z.string().max(300).default(""),
});

export const availabilityByEmailSchema = z.object({
  email: z.string().email().max(320),
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  availability: z.object({
    monday: websiteDaySchema,
    tuesday: websiteDaySchema,
    wednesday: websiteDaySchema,
    thursday: websiteDaySchema,
    friday: websiteDaySchema,
    saturday: websiteDaySchema,
    sunday: websiteDaySchema,
  }),
});

export type AvailabilityByEmailInput = z.infer<typeof availabilityByEmailSchema>;

function isNoAvailability(other: string): boolean {
  const t = other.trim().toUpperCase().replace(/[.!]/g, "");
  return t === "NÃO" || t === "NAO" || t === "NO";
}

/** Tenta extrair um intervalo horário de texto livre ("09H-18H", "9 às 18"). */
export function parseFreeTextRange(text: string): { from: number; to: number } | null {
  const m = text.match(/(\d{1,2})\s*[hH:]?\d{0,2}\s*(?:-|–|a|às|as|ate|até)\s*(\d{1,2})/i);
  if (!m) return null;
  const from = parseInt(m[1], 10);
  let to = parseInt(m[2], 10);
  if (from > 23 || to > 23) return null;
  if (to <= from) to += 24; // atravessa a meia-noite
  return { from, to };
}

/**
 * Mapeia um dia do formulário do site → SetDayInput interno.
 * Devolve null quando o dia não tem nada a guardar (sem slots nem texto).
 * "NÃO" guarda só a nota — a semana conta como respondida e o dia fica
 * "unavailable" no Extras Dia (em vez de "no_response").
 */
export function mapWebsiteDay(slots: string[], other: string): Omit<SetDayInput, "day"> | null {
  const text = other.trim();
  const ranges = slots.map(s => SLOT_RANGES[s]).filter(Boolean);

  if (ranges.length === 0 && !text) return null;
  if (ranges.length === 0 && isNoAvailability(text)) {
    return { note: text.slice(0, 300) };
  }

  const parsed = ranges.length === 0 && text ? parseFreeTextRange(text) : null;
  if (parsed) ranges.push(parsed);

  if (ranges.length === 0) {
    // Texto livre não interpretável — guarda como nota (visível no overview).
    return { note: text.slice(0, 300) };
  }

  const fromHour = Math.min(...ranges.map(r => r.from));
  const toExtended = Math.max(...ranges.map(r => r.to));
  // Manhã 03–15 / Noite 15–03+1 (mesma convenção do Extras Dia): manhã se o
  // intervalo começa antes das 15h, noite se se estende para lá das 15h.
  return {
    morning: ranges.some(r => r.from < 15),
    night: ranges.some(r => r.to > 15),
    fromHour,
    toHour: toExtended % 24,
    note: text ? text.slice(0, 300) : null,
  };
}

export interface AvailabilityByEmailResult {
  saved: number;
  employeeId: number;
  employeeCreated: boolean;
  /** Como a pessoa foi identificada — útil para depurar do lado do site. */
  matchedBy: "employee_email" | "linked_user" | "created";
}

export async function submitAvailabilityByEmail(input: AvailabilityByEmailInput): Promise<AvailabilityByEmailResult> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");

  const email = normalizeEmail(input.email);
  const days = weekDays(input.weekStart);
  if (days.length !== 7) throw new Error("weekStart inválido (esperado YYYY-MM-DD, segunda-feira)");

  // Identidade por EMAIL: procura na ficha de colaborador E na conta de login
  // (ver server/identity.ts). Só cria quando o email é mesmo desconhecido.
  const { id: employeeId, created, matchedBy } = await findOrCreateExtraByEmail(db, email);

  const inputDays: SetDayInput[] = [];
  WEBSITE_WEEKDAYS.forEach((key, i) => {
    const d = input.availability[key];
    const mapped = mapWebsiteDay(d.slots, d.other);
    if (mapped) inputDays.push({ day: days[i].day, ...mapped });
  });

  const result = await setMyAvailability(employeeId, input.weekStart, inputDays, null);

  await logActivity({
    userId: 0,
    action: "availability_web_submit",
    entity: "extras_availability",
    entityId: employeeId,
    details: `[Website] Disponibilidade via site (extra ${employeeId} <${email}>, semana ${input.weekStart}): ${result.saved} dias — ${created ? "extra auto-criado" : `ligado por ${matchedBy}`}`,
  });

  return { saved: result.saved, employeeId, employeeCreated: created, matchedBy };
}
