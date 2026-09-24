/**
 * Passagem de turno — SQL SEMPRE parametrizado (drizzle `sql`), sem strings
 * coladas. Antes o INSERT/SELECT eram montados à mão com um `esc()` que só
 * duplicava plicas (e cortava DEPOIS de escapar); agora cada valor vai como
 * parâmetro e é cortado ANTES de ser ligado.
 */
import { sql, type SQL } from "drizzle-orm";

/** Colunas editáveis do formulário (ordem estável para INSERT/UPDATE). */
export const HANDOVER_VALUE_COLUMNS = [
  "carsForCovered", "chargedUntilDate", "cashClosedInSafe", "checkoutCashDone",
  "frontPouchValue", "terminalPouchValue", "ticketsExpensesPaid", "mbRolls",
  "mbRollsInPouch", "pensInPouch", "mbBattery", "pdasCharged", "uniformsCount",
  "clothingItems", "notes",
] as const;
export type HandoverValueColumn = (typeof HANDOVER_VALUE_COLUMNS)[number];

export interface HandoverKey { handoverDate: string; shift: "morning" | "night"; city: "lisbon" | "porto" | "faro" }
export type HandoverInput = Partial<Record<HandoverValueColumn, unknown>>;
export type HandoverBound = string | number | null;

const cut = (v: unknown, max: number): string | null => (v == null ? null : String(v).slice(0, max));
const bit = (v: unknown): number | null => (v == null ? null : v ? 1 : 0);
const numOrNull = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Valores normalizados, prontos a ligar como parâmetros (texto já cortado). */
export function handoverBoundValues(data: HandoverInput): Record<HandoverValueColumn, HandoverBound> {
  return {
    carsForCovered: numOrNull(data.carsForCovered),
    chargedUntilDate: cut(data.chargedUntilDate, 10),
    cashClosedInSafe: bit(data.cashClosedInSafe),
    checkoutCashDone: bit(data.checkoutCashDone),
    frontPouchValue: numOrNull(data.frontPouchValue),
    terminalPouchValue: numOrNull(data.terminalPouchValue),
    ticketsExpensesPaid: numOrNull(data.ticketsExpensesPaid),
    mbRolls: numOrNull(data.mbRolls),
    mbRollsInPouch: numOrNull(data.mbRollsInPouch),
    pensInPouch: numOrNull(data.pensInPouch),
    mbBattery: numOrNull(data.mbBattery),
    pdasCharged: bit(data.pdasCharged),
    uniformsCount: numOrNull(data.uniformsCount),
    // JSON compacto — nunca se corta (cortar partia o JSON); o router limita a
    // CLOTHING_MAX_ITEMS peças, muito abaixo do TEXT.
    clothingItems: Array.isArray(data.clothingItems) ? JSON.stringify(data.clothingItems) : cut(data.clothingItems, 60_000),
    notes: cut(data.notes, 2000),
  };
}

const col = (name: string) => sql.identifier(name);

export function buildHandoverInsert(
  key: HandoverKey,
  data: HandoverInput,
  author: { id: number | null; name: string | null },
): SQL {
  const v = handoverBoundValues(data);
  const name = cut(author.name, 255);
  const entries: Array<[string, HandoverBound]> = [
    ["handoverDate", cut(key.handoverDate, 10)], ["shift", cut(key.shift, 10)], ["city", cut(key.city, 16)],
    ...HANDOVER_VALUE_COLUMNS.map((c) => [c, v[c]] as [string, HandoverBound]),
    ["filledById", author.id], ["filledByName", name],
    ["createdById", author.id], ["createdByName", name],
    ["version", 1],
  ];
  return sql`INSERT INTO \`shift_handovers\` (${sql.join(entries.map(([c]) => col(c)), sql`, `)})
    VALUES (${sql.join(entries.map(([, val]) => sql`${val}`), sql`, `)})`;
}

/** UPDATE com lock otimista: só grava se a versão ainda é a que foi carregada. */
export function buildHandoverUpdate(
  id: number,
  expectedVersion: number,
  data: HandoverInput,
  editor: { id: number | null; name: string | null },
): SQL {
  const v = handoverBoundValues(data);
  const sets = [
    ...HANDOVER_VALUE_COLUMNS.map((c) => sql`${col(c)} = ${v[c]}`),
    sql`\`filledById\` = ${editor.id}`,
    sql`\`filledByName\` = ${cut(editor.name, 255)}`,
    sql`\`version\` = \`version\` + 1`,
  ];
  return sql`UPDATE \`shift_handovers\` SET ${sql.join(sets, sql`, `)}
    WHERE \`id\` = ${id} AND \`version\` = ${expectedVersion}`;
}

/** Registo atual de um (dia, turno, cidade), com a idade em minutos (relógio da BD). */
export function buildHandoverCurrent(key: HandoverKey): SQL {
  return sql`SELECT *, TIMESTAMPDIFF(MINUTE, \`createdAt\`, NOW()) AS ageMinutes
    FROM \`shift_handovers\`
    WHERE \`handoverDate\` = ${key.handoverDate} AND \`shift\` = ${key.shift} AND \`city\` = ${key.city}
    LIMIT 1`;
}

/** Histórico: filtros ligados como parâmetros + âmbito de cidades do utilizador. */
export function buildHandoverList(opts: { from?: string; to?: string; city?: string }, scope: SQL): SQL {
  const conds: SQL[] = [scope];
  if (opts.from) conds.push(sql`\`handoverDate\` >= ${opts.from}`);
  if (opts.to) conds.push(sql`\`handoverDate\` <= ${opts.to}`);
  if (opts.city) conds.push(sql`\`city\` = ${opts.city}`);
  return sql`SELECT * FROM \`shift_handovers\` WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY \`handoverDate\` DESC, \`shift\`, \`city\` LIMIT 200`;
}
