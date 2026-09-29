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
  "mbRollsInPouch", "pensInPouch", "mbBattery", "pdasCharged", "materialOk",
  "materialExceptions", "clothingItems", "notes", "openItems",
] as const;
// `uniformsCount` (legado, anterior a 2026-09-09) já não se escreve: a coluna
// fica na BD e os registos antigos mantêm o valor (o UPDATE não lhe toca).
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
    materialOk: bit(data.materialOk),
    materialExceptions: jsonList(data.materialExceptions),
    // JSON compacto — nunca se corta (cortar partia o JSON); o router limita a
    // CLOTHING_MAX_ITEMS peças, muito abaixo do TEXT.
    clothingItems: Array.isArray(data.clothingItems) ? JSON.stringify(data.clothingItems) : cut(data.clothingItems, 60_000),
    notes: cut(data.notes, 2000),
    openItems: jsonList(data.openItems),
  };
}

/** Lista → JSON compacto (o router limita o tamanho); texto já serializado passa; resto → NULL. */
function jsonList(v: unknown): string | null {
  if (v == null) return null;
  if (Array.isArray(v)) return JSON.stringify(v);
  return typeof v === "string" ? v.slice(0, 60_000) : null;
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

// ─── Automação (0088) ───────────────────────────────────────────────────────

/** Colunas que o sistema escreve depois da gravação — NÃO mexem na versão (lock). */
export const HANDOVER_META_COLUMNS = ["autoSummary", "aiSummary", "emailSentVersion"] as const;
export type HandoverMetaColumn = (typeof HANDOVER_META_COLUMNS)[number];

export function buildHandoverMetaUpdate(id: number, patch: Partial<Record<HandoverMetaColumn, string | number | null>>): SQL | null {
  const sets = HANDOVER_META_COLUMNS
    .filter((c) => patch[c] !== undefined)
    .map((c) => sql`${col(c)} = ${c === "emailSentVersion" ? numOrNull(patch[c]) : cut(patch[c], c === "autoSummary" ? 4_000_000 : 20_000)}`);
  if (!sets.length) return null;
  // `updatedAt` = ele próprio: metadados do sistema não contam como edição.
  return sql`UPDATE \`shift_handovers\` SET ${sql.join(sets, sql`, `)}, \`updatedAt\` = \`updatedAt\` WHERE \`id\` = ${id}`;
}

/** Envio do email idempotente por versão: só "ganha" quem vê a versão ainda por enviar. */
export function buildClaimEmailVersion(id: number, version: number): SQL {
  return sql`UPDATE \`shift_handovers\` SET \`emailSentVersion\` = ${version}, \`updatedAt\` = \`updatedAt\`
    WHERE \`id\` = ${id} AND \`version\` = ${version} AND (\`emailSentVersion\` IS NULL OR \`emailSentVersion\` < ${version})`;
}

/** Pendentes resolvidos pelo sistema/turno seguinte — sem versão (não é edição do autor). */
export function buildHandoverOpenItemsUpdate(id: number, openItemsJson: string): SQL {
  return sql`UPDATE \`shift_handovers\` SET \`openItems\` = ${openItemsJson}, \`updatedAt\` = \`updatedAt\` WHERE \`id\` = ${id}`;
}

/** "Recebi": só a 1.ª confirmação conta; o autor original nunca confirma a própria. */
export function buildHandoverAck(id: number, user: { id: number; name: string | null }): SQL {
  return sql`UPDATE \`shift_handovers\` SET \`ackById\` = ${user.id}, \`ackByName\` = ${cut(user.name, 255)}, \`ackAt\` = NOW(), \`updatedAt\` = \`updatedAt\`
    WHERE \`id\` = ${id} AND \`ackAt\` IS NULL AND (\`createdById\` IS NULL OR \`createdById\` <> ${user.id})`;
}

/** Passagens de um intervalo de dias (cumprimento), com o âmbito de cidades. */
export function buildHandoverRange(from: string, to: string, city: string | null, scope: SQL): SQL {
  const conds: SQL[] = [scope, sql`\`handoverDate\` >= ${from}`, sql`\`handoverDate\` <= ${to}`];
  if (city) conds.push(sql`\`city\` = ${city}`);
  return sql`SELECT \`id\`, \`handoverDate\`, \`shift\`, \`city\`, UNIX_TIMESTAMP(\`createdAt\`) AS createdAtUnix,
      UNIX_TIMESTAMP(\`ackAt\`) AS ackAtUnix, \`ackByName\`,
      \`frontPouchValue\`, \`terminalPouchValue\`, \`createdByName\`, \`filledByName\`
    FROM \`shift_handovers\` WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY \`handoverDate\`, \`shift\`, \`city\` LIMIT 1000`;
}
