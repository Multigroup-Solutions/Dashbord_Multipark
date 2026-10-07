/**
 * Notas internas do dia de trabalho do Extras-dia (pedido 4, Jorge 7 out
 * 2026) — tabela `extras_day_notes` (migração 0540). Regras puras em
 * shared/extrasDayNotes.ts; permissões e âmbito de cidade no router
 * (server/extrasDiaShiftRouter.ts). Nada se apaga: arquivar.
 */
import { and, asc, eq, gte, isNull, lte } from "drizzle-orm";
import { getDb, logActivity } from "./db";
import { extrasDayNotes, users } from "../drizzle/schema";
import { CITY_LABELS_PT } from "../shared/extrasSchedule";
import { canArchiveDayNote, dayNoteHourLabel, normalizeDayNoteBody } from "../shared/extrasDayNotes";

export type DayNoteCity = "lisbon" | "porto" | "faro";

export interface DayNote {
  id: number;
  city: DayNoteCity;
  workDate: string;
  hour: number | null;
  body: string;
  authorId: number;
  authorName: string | null;
  createdAt: string;
  /** O utilizador que pediu pode arquivar esta nota (autor ou admin+). */
  canArchive: boolean;
}

export class DayNoteError extends Error {
  constructor(message: string, readonly code: "BAD_REQUEST" | "NOT_FOUND" | "FORBIDDEN") { super(message); }
}

/** Notas (não arquivadas) de uma cidade entre duas datas de trabalho (inclusive). */
export async function listDayNotes(
  city: DayNoteCity,
  from: string,
  to: string,
  viewer: { id: number; role: string },
): Promise<DayNote[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      id: extrasDayNotes.id, city: extrasDayNotes.city, workDate: extrasDayNotes.workDate, hour: extrasDayNotes.hour,
      body: extrasDayNotes.body, authorId: extrasDayNotes.authorId, authorName: users.name, createdAt: extrasDayNotes.createdAt,
    })
    .from(extrasDayNotes)
    .leftJoin(users, eq(users.id, extrasDayNotes.authorId))
    .where(and(eq(extrasDayNotes.city, city), gte(extrasDayNotes.workDate, from), lte(extrasDayNotes.workDate, to), isNull(extrasDayNotes.archivedAt)))
    .orderBy(asc(extrasDayNotes.workDate), asc(extrasDayNotes.createdAt), asc(extrasDayNotes.id))
    .limit(2000);
  return rows.map((r) => ({
    id: r.id,
    city: r.city as DayNoteCity,
    workDate: r.workDate,
    hour: r.hour ?? null,
    body: r.body,
    authorId: r.authorId,
    authorName: r.authorName ?? null,
    createdAt: String(r.createdAt),
    canArchive: canArchiveDayNote(viewer, { authorId: r.authorId }),
  }));
}

export async function addDayNote(input: { city: DayNoteCity; workDate: string; hour: number | null; body: string; authorId: number }): Promise<{ id: number }> {
  const db = await getDb();
  if (!db) throw new DayNoteError("Base de dados indisponível.", "BAD_REQUEST");
  const clean = normalizeDayNoteBody(input.body);
  if (!clean.ok) throw new DayNoteError(clean.error, "BAD_REQUEST");
  const res: any = await db.insert(extrasDayNotes).values({
    city: input.city, workDate: input.workDate, hour: input.hour, body: clean.body, authorId: input.authorId,
  });
  const id = Number(res?.[0]?.insertId ?? res?.insertId ?? 0);
  await logActivity({
    userId: input.authorId,
    action: "extras_day_note_add",
    entity: "extras_day_notes",
    entityId: id || undefined,
    details: `Nota do dia ${input.workDate}${input.hour != null ? ` às ${dayNoteHourLabel(input.hour)}` : ""} · ${CITY_LABELS_PT[input.city] ?? input.city}: ${clean.body.slice(0, 200)}`,
  });
  return { id };
}

/** A nota (para o âmbito de cidade ser verificado antes de arquivar). */
export async function getDayNote(id: number): Promise<{ id: number; city: string; workDate: string; authorId: number; archivedAt: string | null } | null> {
  const db = await getDb();
  if (!db) return null;
  const [r] = await db
    .select({ id: extrasDayNotes.id, city: extrasDayNotes.city, workDate: extrasDayNotes.workDate, authorId: extrasDayNotes.authorId, archivedAt: extrasDayNotes.archivedAt })
    .from(extrasDayNotes)
    .where(eq(extrasDayNotes.id, id))
    .limit(1);
  return r ? { ...r, archivedAt: r.archivedAt ? String(r.archivedAt) : null } : null;
}

export async function archiveDayNote(id: number, viewer: { id: number; role: string }): Promise<{ archived: boolean }> {
  const db = await getDb();
  if (!db) throw new DayNoteError("Base de dados indisponível.", "BAD_REQUEST");
  const note = await getDayNote(id);
  if (!note) throw new DayNoteError("Nota não encontrada.", "NOT_FOUND");
  if (note.archivedAt) return { archived: false };
  if (!canArchiveDayNote(viewer, note)) throw new DayNoteError("Só quem escreveu a nota (ou um administrador) a pode arquivar.", "FORBIDDEN");
  const { sql } = await import("drizzle-orm");
  await db.update(extrasDayNotes).set({ archivedAt: sql`CURRENT_TIMESTAMP`, archivedById: viewer.id }).where(and(eq(extrasDayNotes.id, id), isNull(extrasDayNotes.archivedAt)));
  await logActivity({
    userId: viewer.id,
    action: "extras_day_note_archive",
    entity: "extras_day_notes",
    entityId: id,
    details: `Nota do dia ${note.workDate} · ${CITY_LABELS_PT[note.city] ?? note.city} arquivada`,
  });
  return { archived: true };
}
