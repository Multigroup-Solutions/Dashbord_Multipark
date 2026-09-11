// Migration 0071 — MOTIVO da desativação (pedido do Jorge, 2026-09-11).
//
// Desativar um utilizador (ou uma ficha de colaborador, que desativa o login em
// cascata) passa a guardar POR QUE RAZÃO foi desativado: o código do motivo
// (vocabulário em `shared/deactivationReasons.ts`), o texto livre do "Outro",
// as notas da textarea, e quando/por quem. As colunas existem nas DUAS tabelas
// porque os dois caminhos são independentes (Utilizadores e RH) e a ficha tem
// de mostrar o motivo mesmo quando não há conta associada.
//
// Reativar volta a pôr tudo a NULL — o histórico fica em `activity_logs`.
// Idempotente: corre no boot (ensureRecentSchema) e via scripts/run-migration.ts.

export const MIGRATION_0071_NAME = "0071_deactivation_reason_and_notes";

export const MIGRATION_0071_STATEMENTS: string[] = [
  "ALTER TABLE `users` ADD COLUMN `deactivationReason` VARCHAR(48) NULL",
  "ALTER TABLE `users` ADD COLUMN `deactivationReasonOther` VARCHAR(200) NULL",
  "ALTER TABLE `users` ADD COLUMN `deactivationNotes` TEXT NULL",
  "ALTER TABLE `users` ADD COLUMN `deactivatedAt` DATETIME NULL",
  "ALTER TABLE `users` ADD COLUMN `deactivatedById` INT NULL",
  "ALTER TABLE `employees` ADD COLUMN `deactivationReason` VARCHAR(48) NULL",
  "ALTER TABLE `employees` ADD COLUMN `deactivationReasonOther` VARCHAR(200) NULL",
  "ALTER TABLE `employees` ADD COLUMN `deactivationNotes` TEXT NULL",
  "ALTER TABLE `employees` ADD COLUMN `deactivatedAt` DATETIME NULL",
  "ALTER TABLE `employees` ADD COLUMN `deactivatedById` INT NULL",
];

export const IDEMPOTENT_ERROR_CODES_0071 = new Set([
  "ER_DUP_FIELDNAME", // coluna já existe
]);
