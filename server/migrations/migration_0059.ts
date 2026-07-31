// Migration 0059 — Utilizador Zello anexado ao COLABORADOR (persistente).
// Como o multiparkAgentName: liga-se uma vez ("extra600" → colaborador X) e
// fica; o GPS/atividade mostra sempre o colaborador. O check-in de PDA continua
// a dar a dimensão temporal (quem levou que aparelho quando).

export const MIGRATION_0059_NAME = "0059_employee_zello_username";

export const MIGRATION_0059_STATEMENTS: string[] = [
  "ALTER TABLE `employees` ADD COLUMN `zelloUsername` VARCHAR(128) NULL AFTER `multiparkAgentUserId`",
];

export const IDEMPOTENT_ERROR_CODES_0059 = new Set([
  "ER_DUP_FIELDNAME",
]);
