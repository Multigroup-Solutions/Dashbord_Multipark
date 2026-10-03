// Migration 0435 — Perdidos: nota da devolução (Jorge, 3 out 2026 — "Outro"
// como método de devolução obriga a escrever como foi). Só acrescenta a coluna.
// Idempotente: ADD COLUMN ignora o que já existe.
export const MIGRATION_0435_STATEMENTS: string[] = [
  "ALTER TABLE `lost_found_items` ADD COLUMN `returnNote` VARCHAR(500) NULL",
];

export const IDEMPOTENT_ERROR_CODES_0435 = new Set<string>(["ER_DUP_FIELDNAME"]);
