// Migration 0265 — Caixa, fase 2 (detetar), 29 set 2026
// (docs/auditoria/caixa-precos.md + caixa-furos.md):
//   - cash_live_snapshots: retratos do dinheiro de cada reserva lidos pela
//     varredura (só acréscimo; um novo só quando o estado muda) — o "era"
//     mesmo quando não chega webhook;
//   - cash_cases: "Correção de caixa" — um caso por reserva (ou agente/parque)
//     e regra, com estado, gravidade e explicação ao fechar;
//   - cash_case_events: tudo o que acontece a um caso (só acréscimo);
//   - cash_agent_perms: retrato diário das permissões de dinheiro dos agentes
//     dos nossos parques (só acréscimo, quando mudam);
//   - cash_sweep_state: onde a varredura ficou.
// Só cria tabelas (idempotente).

export const MIGRATION_0265_NAME = "0265_cash_sweep";

export const MIGRATION_0265_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `cash_live_snapshots` ("
    + " `id` BIGINT AUTO_INCREMENT PRIMARY KEY,"
    + " `bookingExternalId` VARCHAR(128) NOT NULL,"
    + " `parkId` VARCHAR(128) NULL,"
    + " `status` VARCHAR(32) NULL,"
    + " `checkOut` DATETIME NULL,"
    + " `hash` CHAR(40) NOT NULL,"
    + " `snapJson` MEDIUMTEXT NOT NULL,"
    + " `capturedAt` DATETIME NOT NULL,"
    + " KEY `idx_cash_snap_booking` (`bookingExternalId`, `capturedAt`),"
    + " KEY `idx_cash_snap_captured` (`capturedAt`)"
    + ")",
  "CREATE TABLE IF NOT EXISTS `cash_cases` ("
    + " `id` INT AUTO_INCREMENT PRIMARY KEY,"
    + " `subjectType` VARCHAR(16) NOT NULL,"
    + " `subjectId` VARCHAR(128) NOT NULL,"
    + " `code` VARCHAR(40) NOT NULL,"
    + " `ruleRef` VARCHAR(8) NULL,"
    + " `severity` VARCHAR(12) NOT NULL,"
    + " `state` VARCHAR(24) NOT NULL DEFAULT 'aberto',"
    + " `label` VARCHAR(160) NOT NULL,"
    + " `detail` TEXT NULL,"
    + " `parkId` VARCHAR(128) NULL,"
    + " `projectId` INT NULL,"
    + " `bookingCode` VARCHAR(64) NULL,"
    + " `day` DATE NULL,"
    + " `openedAt` DATETIME NOT NULL,"
    + " `lastSeenAt` DATETIME NOT NULL,"
    + " `resolvedAt` DATETIME NULL,"
    + " `closedAt` DATETIME NULL,"
    + " `closedBy` INT NULL,"
    + " `closeReason` VARCHAR(40) NULL,"
    + " `explanation` TEXT NULL,"
    + " `reopenCount` INT NOT NULL DEFAULT 0,"
    + " `alertedAt` DATETIME NULL,"
    + " UNIQUE KEY `uq_cash_case` (`subjectType`, `subjectId`, `code`),"
    + " KEY `idx_cash_case_state` (`state`, `severity`),"
    + " KEY `idx_cash_case_park_day` (`parkId`, `day`),"
    + " KEY `idx_cash_case_project` (`projectId`)"
    + ")",
  "CREATE TABLE IF NOT EXISTS `cash_case_events` ("
    + " `id` BIGINT AUTO_INCREMENT PRIMARY KEY,"
    + " `caseId` INT NOT NULL,"
    + " `at` DATETIME NOT NULL,"
    + " `userId` INT NULL,"
    + " `action` VARCHAR(24) NOT NULL,"
    + " `note` TEXT NULL,"
    + " KEY `idx_cash_case_events_case` (`caseId`, `at`)"
    + ")",
  "CREATE TABLE IF NOT EXISTS `cash_agent_perms` ("
    + " `id` BIGINT AUTO_INCREMENT PRIMARY KEY,"
    + " `agentId` VARCHAR(128) NOT NULL,"
    + " `parkId` VARCHAR(128) NULL,"
    + " `name` VARCHAR(255) NULL,"
    + " `role` VARCHAR(32) NULL,"
    + " `permsJson` TEXT NOT NULL,"
    + " `hash` CHAR(40) NOT NULL,"
    + " `capturedAt` DATETIME NOT NULL,"
    + " KEY `idx_cash_agent_perms_agent` (`agentId`, `capturedAt`)"
    + ")",
  "CREATE TABLE IF NOT EXISTS `cash_sweep_state` ("
    + " `key` VARCHAR(32) PRIMARY KEY,"
    + " `value` VARCHAR(64) NULL,"
    + " `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
    + ")",
];

export const IDEMPOTENT_ERROR_CODES_0265 = new Set<string>(["ER_TABLE_EXISTS_ERROR"]);
