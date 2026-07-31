// Migration 0058 — Utilizador Zello no PDA.
// O PDA leva o funcionário (via check-in, já existia) e o utilizador Zello:
// o Zello dá GPS/velocidades/alertas, mas quem conta é o funcionário — o
// utilizador Zello só aparece no registo de PDAs; na Atividade/GPS resolve-se
// zelloUsername → PDA → check-in ativo → funcionário.

export const MIGRATION_0058_NAME = "0058_pda_zello_username";

export const MIGRATION_0058_STATEMENTS: string[] = [
  "ALTER TABLE `pdas` ADD COLUMN `zelloUsername` VARCHAR(128) NULL AFTER `model`",
];

export const IDEMPOTENT_ERROR_CODES_0058 = new Set([
  "ER_DUP_FIELDNAME",
]);
