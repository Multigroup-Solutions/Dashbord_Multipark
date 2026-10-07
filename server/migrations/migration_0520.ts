// Migration 0520 — notas de crédito nas Despesas (Jorge, 7 out 2026): a NC é
// uma despesa própria, com valor negativo, ligada à fatura (`creditNoteOfId`),
// com o estado do reembolso (`creditNoteState`: to_receive | received | offset).
// Só acrescenta. Idempotente.
export const MIGRATION_0520_STATEMENTS: string[] = [
  "ALTER TABLE `expenses` ADD COLUMN `creditNoteOfId` INT NULL",
  "ALTER TABLE `expenses` ADD COLUMN `creditNoteState` VARCHAR(12) NULL",
  "ALTER TABLE `expenses` ADD INDEX `idx_expenses_credit_note_of` (`creditNoteOfId`)",
];

export const IDEMPOTENT_ERROR_CODES_0520 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
