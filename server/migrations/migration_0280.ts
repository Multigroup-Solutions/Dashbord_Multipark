// Migration 0280 — PDAs (29 set 2026, decisão do dono): cada PDA tem uma
// CIDADE fixa (nó `level='city'` da árvore de projetos). Antes a cidade de um
// PDA era a de quem lá fazia check-in. Só acrescenta a coluna (idempotente).

export const MIGRATION_0280_NAME = "0280_pdas_city";

export const MIGRATION_0280_STATEMENTS: string[] = [
  "ALTER TABLE `pdas` ADD COLUMN `projectId` INT NULL",
];

export const IDEMPOTENT_ERROR_CODES_0280 = new Set<string>(["ER_DUP_FIELDNAME"]);
