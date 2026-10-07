/**
 * Notas internas das fichas (Frente A, Jorge, 7 out 2026: "Os extras devem
 * ter notas internas (ex. este extra trabalhou mal no dia ...)").
 * Só acesso à BD; quem pode ler/escrever/editar está em server/rhAccess.ts
 * (canViewInternalNotes / canEditInternalNote) e é verificado no router `rh`.
 * As notas NUNCA saem em procedimentos que a própria pessoa chama.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { employeeNotes, extrasDiaAssignments, users } from "../drizzle/schema";
import { getDb } from "./db";
import type { NoteKind } from "../shared/employeeNotes";

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new Error("BD indisponível");
  return db;
}
const affected = (r: any) => Number(r?.[0]?.affectedRows ?? r?.affectedRows ?? 0);

export type EmployeeNoteRow = typeof employeeNotes.$inferSelect;

export interface EmployeeNoteView {
  id: number;
  employeeId: number;
  body: string;
  kind: string;
  workDate: string | null;
  assignmentId: number | null;
  authorId: number;
  authorName: string | null;
  createdAt: string;
  editedAt: string | null;
}

/** Notas ATIVAS de uma ficha, mais recentes primeiro (com o nome de quem escreveu). */
export async function listEmployeeNotes(employeeId: number, limit = 200): Promise<EmployeeNoteView[]> {
  const db = await dbOrThrow();
  const rows = await db.select({
    id: employeeNotes.id, employeeId: employeeNotes.employeeId, body: employeeNotes.body, kind: employeeNotes.kind,
    workDate: employeeNotes.workDate, assignmentId: employeeNotes.assignmentId, authorId: employeeNotes.authorId,
    authorName: users.name, createdAt: employeeNotes.createdAt, editedAt: employeeNotes.editedAt,
  }).from(employeeNotes)
    .leftJoin(users, eq(users.id, employeeNotes.authorId))
    .where(and(eq(employeeNotes.employeeId, employeeId), isNull(employeeNotes.archivedAt)))
    .orderBy(desc(employeeNotes.createdAt), desc(employeeNotes.id))
    .limit(Math.min(Math.max(limit, 1), 500));
  return rows.map((r) => ({ ...r, authorName: r.authorName ?? null }));
}

/** Uma nota (ativa ou arquivada). */
export async function getEmployeeNote(id: number): Promise<EmployeeNoteRow | null> {
  const db = await dbOrThrow();
  const [row] = await db.select().from(employeeNotes).where(eq(employeeNotes.id, id)).limit(1);
  return row ?? null;
}

export async function insertEmployeeNote(n: { employeeId: number; body: string; kind: NoteKind; workDate: string | null; assignmentId: number | null; authorId: number }): Promise<number> {
  const db = await dbOrThrow();
  const res: any = await db.insert(employeeNotes).values(n);
  return Number(res?.[0]?.insertId ?? res?.insertId ?? 0);
}

export async function updateEmployeeNote(id: number, patch: { body: string; kind: NoteKind }): Promise<boolean> {
  const db = await dbOrThrow();
  return affected(await db.update(employeeNotes)
    .set({ ...patch, editedAt: sql`CURRENT_TIMESTAMP` as any })
    .where(and(eq(employeeNotes.id, id), isNull(employeeNotes.archivedAt)))) > 0;
}

export async function archiveEmployeeNote(id: number, byUserId: number): Promise<boolean> {
  const db = await dbOrThrow();
  return affected(await db.update(employeeNotes)
    .set({ archivedAt: sql`CURRENT_TIMESTAMP` as any, archivedById: byUserId })
    .where(and(eq(employeeNotes.id, id), isNull(employeeNotes.archivedAt)))) > 0;
}

/** A linha da escala do Extras-dia existe e é desta ficha? (para ligar a nota à linha). */
export async function assignmentBelongsTo(assignmentId: number, employeeId: number): Promise<{ ok: boolean; assignmentDate: string | null }> {
  const db = await dbOrThrow();
  const [r] = await db.select({ employeeId: extrasDiaAssignments.employeeId, assignmentDate: extrasDiaAssignments.assignmentDate })
    .from(extrasDiaAssignments).where(eq(extrasDiaAssignments.id, assignmentId)).limit(1);
  if (!r || r.employeeId !== employeeId) return { ok: false, assignmentDate: null };
  return { ok: true, assignmentDate: r.assignmentDate };
}

/**
 * MySQL TIMESTAMP como string "YYYY-MM-DD HH:MM:SS" (UTC no servidor) → ms.
 * Para a janela de 24 h do autor.
 */
export function noteTimestampMs(ts: string | null | undefined): number {
  if (!ts) return NaN;
  return Date.parse(String(ts).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(ts)) ? "" : "Z"));
}
