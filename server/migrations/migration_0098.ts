// Migration 0098 — Página "Definições" (24 set 2026)
//
//  - cron_runs: uma linha por corrida de /api/cron/* (nome, início, fim, ok,
//    erro, duração, HTTP status, query). ok = NULL → a correr / morreu sem
//    responder. Retenção de 30 dias (feita pelo próprio registo).
//  - app_settings: definições chave → valor JSON (inclui as sobreposições dos
//    interruptores das automações, chaves "flag.<NOME>").
//  - app_settings_audit: quem mudou o quê, quando, valor antigo e novo.
//  - users.sessionVersion: versão da sessão; o cookie leva-a e deixa de valer
//    quando sobe ("Terminar todas as sessões"). Os cookies antigos (sem versão)
//    valem como versão 0 — ninguém é desligado pela migração.
//  - users.notificationPrefs: preferências de notificação da pessoa (JSON).
//
// Idempotente (corre em cada arranque via ensureRecentSchema): CREATE TABLE IF
// NOT EXISTS; ADD COLUMN → ER_DUP_FIELDNAME; ADD INDEX → ER_DUP_KEYNAME. Sem
// UPDATEs (as colunas novas nascem com o valor por omissão certo).

export const MIGRATION_0098_NAME = "0098_settings_cron_runs_sessions";

export const MIGRATION_0098_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `cron_runs` (" +
    "`id` BIGINT NOT NULL AUTO_INCREMENT, " +
    "`name` VARCHAR(64) NOT NULL, " +
    "`startedAt` DATETIME(3) NOT NULL, " +
    "`finishedAt` DATETIME(3) NULL, " +
    "`ok` TINYINT NULL, " +
    "`error` TEXT NULL, " +
    "`durationMs` INT NULL, " +
    "`httpStatus` SMALLINT NULL, " +
    "`meta` VARCHAR(255) NULL, " +
    "PRIMARY KEY (`id`), " +
    "KEY `idx_cron_runs_name_started` (`name`, `startedAt`), " +
    "KEY `idx_cron_runs_started` (`startedAt`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `app_settings` (" +
    "`settingKey` VARCHAR(100) NOT NULL, " +
    "`value` JSON NOT NULL, " +
    "`updatedById` INT NULL, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`settingKey`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `app_settings_audit` (" +
    "`id` BIGINT NOT NULL AUTO_INCREMENT, " +
    "`settingKey` VARCHAR(100) NOT NULL, " +
    "`oldValue` JSON NULL, " +
    "`newValue` JSON NULL, " +
    "`changedById` INT NULL, " +
    "`changedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "KEY `idx_app_settings_audit_key_changed` (`settingKey`, `changedAt`), " +
    "KEY `idx_app_settings_audit_changed` (`changedAt`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "ALTER TABLE `users` ADD COLUMN `sessionVersion` INT NOT NULL DEFAULT 0",
  "ALTER TABLE `users` ADD COLUMN `notificationPrefs` JSON NULL",
];

export const IDEMPOTENT_ERROR_CODES_0098 = new Set<string>([
  "ER_DUP_FIELDNAME",
  "ER_DUP_KEYNAME",
  "ER_TABLE_EXISTS_ERROR",
]);
