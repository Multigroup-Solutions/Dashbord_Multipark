// Migration 0125 — Automações internas com IA (set 2026)
//
//  - ops_briefings: o briefing diário por cidade (07:30 Lisboa). `data` = os
//    números (JSON, calculados no SQL/código); `summary` = o parágrafo (IA ou
//    texto fixo). Uma linha por (cidade, dia); `emailedAt` evita reenvios.
//  - ops_anomalies: anomalias detetadas por estatística (reservas por
//    parque/canal, despesas, marketing). `detail` vem do código; `explanation`
//    é a linha da IA. `dedupKey` único → a mesma anomalia não se repete.
//  - ai_weekly_reports: relatórios de segunda-feira (direção, marketing,
//    operações, RH e resumo semanal da passagem de turno por cidade).
//  - extra_lead_scores: pontuação das leads (critérios explícitos, calculada
//    no código), resumo da IA e rascunho do 1.º contacto (a aprovar).
//  - evaluation_explanations: explicação da avaliação por (pessoa, período),
//    com o hash das linhas das regras e o "esconder" do team leader.
//
// Idempotente (corre em cada arranque via ensureRecentSchema): só CREATE
// TABLE IF NOT EXISTS. Sem UPDATEs.

export const MIGRATION_0125_NAME = "0125_ai_ops_automations";

export const MIGRATION_0125_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `ops_briefings` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`city` VARCHAR(16) NOT NULL, " +
    "`day` CHAR(10) NOT NULL, " +
    "`data` MEDIUMTEXT NOT NULL, " +
    "`summary` TEXT NULL, " +
    "`aiUsed` TINYINT NOT NULL DEFAULT 0, " +
    "`emailedAt` DATETIME NULL, " +
    "`emailRecipients` INT NOT NULL DEFAULT 0, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_ops_briefings_city_day` (`city`, `day`), " +
    "INDEX `idx_ops_briefings_day` (`day`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS `ops_anomalies` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`day` CHAR(10) NOT NULL, " +
    "`domain` VARCHAR(16) NOT NULL, " +
    "`kind` VARCHAR(32) NOT NULL, " +
    "`cityKey` VARCHAR(16) NULL, " +
    "`projectId` INT NULL, " +
    "`subject` VARCHAR(160) NOT NULL, " +
    "`value` DECIMAL(14,2) NOT NULL DEFAULT 0, " +
    "`expected` DECIMAL(14,2) NULL, " +
    "`zScore` DECIMAL(8,2) NULL, " +
    "`severity` VARCHAR(8) NOT NULL, " +
    "`detail` VARCHAR(500) NOT NULL, " +
    "`explanation` VARCHAR(400) NULL, " +
    "`refIds` VARCHAR(255) NULL, " +
    "`dedupKey` VARCHAR(191) NOT NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_ops_anomalies_dedup` (`dedupKey`), " +
    "INDEX `idx_ops_anomalies_domain_day` (`domain`, `day`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS `ai_weekly_reports` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`kind` VARCHAR(24) NOT NULL, " +
    "`weekStart` CHAR(10) NOT NULL, " +
    "`data` MEDIUMTEXT NOT NULL, " +
    "`narrative` TEXT NULL, " +
    "`aiUsed` TINYINT NOT NULL DEFAULT 0, " +
    "`emailedAt` DATETIME NULL, " +
    "`emailRecipients` INT NOT NULL DEFAULT 0, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_ai_weekly_reports_kind_week` (`kind`, `weekStart`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS `extra_lead_scores` (" +
    "`leadId` INT NOT NULL, " +
    "`score` INT NOT NULL DEFAULT 0, " +
    "`breakdown` TEXT NOT NULL, " +
    "`inputsHash` CHAR(40) NOT NULL, " +
    "`summary` VARCHAR(300) NULL, " +
    "`summaryHash` CHAR(40) NULL, " +
    "`draftMessage` TEXT NULL, " +
    "`draftStatus` VARCHAR(12) NULL, " +
    "`draftCreatedById` INT NULL, " +
    "`draftReviewedById` INT NULL, " +
    "`draftReviewedAt` DATETIME NULL, " +
    "`computedAt` DATETIME NOT NULL, " +
    "PRIMARY KEY (`leadId`), " +
    "INDEX `idx_extra_lead_scores_score` (`score`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS `evaluation_explanations` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`employeeId` INT NOT NULL, " +
    "`fromDay` CHAR(10) NOT NULL, " +
    "`toDay` CHAR(10) NOT NULL, " +
    "`linesHash` CHAR(40) NOT NULL, " +
    "`text` VARCHAR(700) NULL, " +
    "`hiddenAt` DATETIME NULL, " +
    "`hiddenById` INT NULL, " +
    "`hiddenByName` VARCHAR(255) NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_evaluation_explanations` (`employeeId`, `fromDay`, `toDay`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
];

export const IDEMPOTENT_ERROR_CODES_0125 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME", "ER_DUP_FIELDNAME"]);
