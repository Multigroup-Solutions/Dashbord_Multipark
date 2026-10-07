// Migration 0525 — Comunicação (lote 45, Jorge 7 out 2026: "cada um começava
// pela sua caixa"): a caixa de email por onde cada pessoa entra (chave da
// caixa partilhada ou "me"). NULL = a escolha automática. Só acrescenta.
export const MIGRATION_0525_STATEMENTS: string[] = [
  "ALTER TABLE `users` ADD COLUMN `mailHomeBox` VARCHAR(64) NULL",
];

export const IDEMPOTENT_ERROR_CODES_0525 = new Set<string>(["ER_DUP_FIELDNAME"]);
