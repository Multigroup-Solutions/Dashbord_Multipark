// Migration 0088 — Passagem de turno: automação (24 set 2026).
//
// Colunas novas em `shift_handovers`:
//   - `autoSummary` (JSON em MEDIUMTEXT): fotografia do resumo automático no momento da gravação;
//   - `openItems` (JSON): pendentes que passam de turno, com `resolved` por item;
//   - `aiSummary`: 5 pontos gerados por IA para o turno seguinte;
//   - `ackById` / `ackByName` / `ackAt`: "Recebi" do team leader que entra;
//   - `emailSentVersion`: última versão já enviada por email (idempotência);
//   - `materialOk` + `materialExceptions` (JSON): material simplificado.
// Tabela `shift_handover_reminders`: lembrete de passagem em falta, 1× por
// (dia, turno, cidade) — a passagem ainda não existe quando se lembra.
//
// Idempotente: ADD COLUMN → ER_DUP_FIELDNAME; CREATE TABLE IF NOT EXISTS.

export const MIGRATION_0088_NAME = "0088_shift_handover_automation";

export const MIGRATION_0088_STATEMENTS: string[] = [
  "ALTER TABLE `shift_handovers` ADD COLUMN `materialOk` TINYINT NULL AFTER `pdasCharged`",
  "ALTER TABLE `shift_handovers` ADD COLUMN `materialExceptions` TEXT NULL AFTER `materialOk`",
  "ALTER TABLE `shift_handovers` ADD COLUMN `openItems` TEXT NULL AFTER `notes`",
  "ALTER TABLE `shift_handovers` ADD COLUMN `autoSummary` MEDIUMTEXT NULL AFTER `openItems`",
  "ALTER TABLE `shift_handovers` ADD COLUMN `aiSummary` TEXT NULL AFTER `autoSummary`",
  "ALTER TABLE `shift_handovers` ADD COLUMN `ackById` INT NULL AFTER `version`",
  "ALTER TABLE `shift_handovers` ADD COLUMN `ackByName` VARCHAR(255) NULL AFTER `ackById`",
  "ALTER TABLE `shift_handovers` ADD COLUMN `ackAt` TIMESTAMP NULL AFTER `ackByName`",
  "ALTER TABLE `shift_handovers` ADD COLUMN `emailSentVersion` INT NULL AFTER `ackAt`",
  "CREATE TABLE IF NOT EXISTS `shift_handover_reminders` ("
    + "`handoverDate` VARCHAR(10) NOT NULL,"
    + "`shift` VARCHAR(10) NOT NULL,"
    + "`city` VARCHAR(16) NOT NULL,"
    + "`reminderSentAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,"
    + "`recipients` INT NOT NULL DEFAULT 0,"
    + "PRIMARY KEY (`handoverDate`, `shift`, `city`)"
    + ")",
];

export const IDEMPOTENT_ERROR_CODES_0088 = new Set<string>(["ER_DUP_FIELDNAME"]);
