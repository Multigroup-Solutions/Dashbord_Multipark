/**
 * Dias livres HABITUAIS (Jorge, 8 out 2026) — leitura e gravação
 * (tabela extras_availability_pattern, migração 0580). Regras puras em
 * shared/availabilityPattern.ts.
 *
 * Uma linha por ficha. Gravar substitui a linha (INSERT … ON DUPLICATE KEY
 * UPDATE); "Limpar" grava a grelha vazia — nunca se apaga nada. O que estava
 * antes vai para o registo de atividade (quem chama regista).
 *
 * É só uma dica para quem escala: nada daqui entra na escala automática.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./db";
import { extrasAvailabilityPattern, users } from "../drizzle/schema";
import {
  PATTERN_NOTE_MAX,
  normalizeSlots,
  parseSlots,
  serializeSlots,
  summarizePattern,
  type PatternSlots,
} from "../shared/availabilityPattern";

export interface AvailabilityPatternView {
  employeeId: number;
  slots: PatternSlots;
  note: string | null;
  /** "Ter tarde · Qua manhã · Sáb e Dom todo o dia" ("" = ainda nada). */
  summary: string;
  /** Quando foi gravado pela última vez (UTC, "AAAA-MM-DD HH:MM:SS"); null = nunca. */
  updatedAt: string | null;
  /** Quem gravou (nome da conta); null = nunca ou conta sem nome. */
  updatedByName: string | null;
}

const cleanNote = (note: string | null | undefined): string | null => {
  const t = (note ?? "").trim();
  return t ? t.slice(0, PATTERN_NOTE_MAX) : null;
};

const emptyView = (employeeId: number): AvailabilityPatternView => ({
  employeeId, slots: {}, note: null, summary: "", updatedAt: null, updatedByName: null,
});

/** O padrão de uma ficha (vazio se ainda não foi indicado). */
export async function getAvailabilityPattern(employeeId: number): Promise<AvailabilityPatternView> {
  const db = await getDb();
  if (!db) return emptyView(employeeId);
  const rows = await db
    .select({
      slots: extrasAvailabilityPattern.slots,
      note: extrasAvailabilityPattern.note,
      updatedAt: extrasAvailabilityPattern.updatedAt,
      updatedByName: users.name,
    })
    .from(extrasAvailabilityPattern)
    .leftJoin(users, eq(users.id, extrasAvailabilityPattern.updatedById))
    .where(eq(extrasAvailabilityPattern.employeeId, employeeId))
    .limit(1);
  const r = rows[0];
  if (!r) return emptyView(employeeId);
  const slots = parseSlots(r.slots);
  return {
    employeeId,
    slots,
    note: r.note ?? null,
    summary: summarizePattern(slots),
    updatedAt: r.updatedAt ?? null,
    updatedByName: r.updatedByName ?? null,
  };
}

/** Texto curto de um padrão para o histórico ("nada" quando vazio). PURA. */
export function patternLogLine(slots: PatternSlots, note: string | null): string {
  const s = summarizePattern(slots) || "nada";
  return note ? `${s} (nota: ${note.slice(0, 80)})` : s;
}

/**
 * Grava (substitui) o padrão de uma ficha. Devolve o que ficou e, em texto,
 * o que estava antes (para o registo de atividade).
 */
export async function saveAvailabilityPattern(
  employeeId: number,
  slots: PatternSlots,
  note: string | null | undefined,
  updatedById: number | null,
): Promise<{ view: AvailabilityPatternView; previous: string; current: string }> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  const clean = normalizeSlots(slots);
  const n = cleanNote(note);
  const before = await db
    .select({ slots: extrasAvailabilityPattern.slots, note: extrasAvailabilityPattern.note })
    .from(extrasAvailabilityPattern)
    .where(eq(extrasAvailabilityPattern.employeeId, employeeId))
    .limit(1);
  const previous = before[0] ? patternLogLine(parseSlots(before[0].slots), before[0].note ?? null) : "nada";
  await db
    .insert(extrasAvailabilityPattern)
    .values({ employeeId, slots: serializeSlots(clean), note: n, updatedById })
    .onDuplicateKeyUpdate({
      set: { slots: serializeSlots(clean), note: n, updatedById, updatedAt: sql`CURRENT_TIMESTAMP` },
    });
  const view = await getAvailabilityPattern(employeeId);
  return { view, previous, current: patternLogLine(clean, n) };
}

export interface PatternBrief {
  slots: PatternSlots;
  note: string | null;
}

/**
 * Padrões de várias fichas de uma vez (listas da gestão). Tolerante: se a
 * leitura falhar (ex.: migração 0580 ainda por aplicar), devolve vazio em vez
 * de partir a página — o resumo é só uma dica.
 */
export async function patternsForEmployees(ids: number[]): Promise<Map<number, PatternBrief>> {
  const out = new Map<number, PatternBrief>();
  if (!ids.length) return out;
  try {
    const db = await getDb();
    if (!db) return out;
    const rows = await db
      .select({ employeeId: extrasAvailabilityPattern.employeeId, slots: extrasAvailabilityPattern.slots, note: extrasAvailabilityPattern.note })
      .from(extrasAvailabilityPattern)
      .where(inArray(extrasAvailabilityPattern.employeeId, ids));
    for (const r of rows) {
      const slots = parseSlots(r.slots);
      if (Object.keys(slots).length || r.note) out.set(r.employeeId, { slots, note: r.note ?? null });
    }
  } catch (err: any) {
    console.warn("[availability] dias habituais indisponíveis:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 120));
  }
  return out;
}
