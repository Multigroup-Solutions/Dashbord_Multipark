// Migration 0099 — Motor único da avaliação (individual + operacional) (24 set 2026)
//
//  - employee_day_metrics: métricas CALCULADAS por (colaborador, dia
//    operacional de Lisboa 03h→03h). Escritas só pelo motor (recálculo diário
//    das últimas 4 semanas, botão Recalcular e vista do operacional). UNIQUE
//    (employeeId, day) → upsert idempotente.
//  - employee_metric_adjustments: ajustes MANUAIS (delta sobre uma métrica de
//    um dia) com autor, motivo e data — nunca alteram o calculado; anulam-se
//    (voidedAt), não se apagam.
//  - employee_metric_disputes: contestações do colaborador (dia + métrica
//    opcional + comentário); o gestor aceita (com ajuste opcional) ou recusa.
//
// Idempotente (corre em cada arranque): CREATE TABLE IF NOT EXISTS +
// ER_TABLE_EXISTS_ERROR / ER_DUP_FIELDNAME / ER_DUP_KEYNAME ignorados. Sem
// UPDATEs (tabelas novas).

export const MIGRATION_0099_NAME = "0099_employee_day_metrics";

export const MIGRATION_0099_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS \`employee_day_metrics\` (
    \`id\` INT AUTO_INCREMENT PRIMARY KEY,
    \`employeeId\` INT NOT NULL,
    \`day\` VARCHAR(10) NOT NULL,
    \`projectId\` INT NULL,
    \`city\` VARCHAR(16) NULL,
    \`shift\` VARCHAR(8) NULL,
    \`isTeamLeader\` TINYINT NOT NULL DEFAULT 0,
    \`level\` VARCHAR(16) NULL,
    \`hoursSource\` VARCHAR(8) NULL,
    \`hoursWorked\` DECIMAL(8,2) NOT NULL DEFAULT 0,
    \`suspiciousHours\` DECIMAL(8,2) NOT NULL DEFAULT 0,
    \`scheduledHours\` DECIMAL(8,2) NOT NULL DEFAULT 0,
    \`pontoEvents\` INT NOT NULL DEFAULT 0,
    \`cost\` DECIMAL(10,2) NOT NULL DEFAULT 0,
    \`actions\` INT NOT NULL DEFAULT 0,
    \`actionsMorning\` INT NOT NULL DEFAULT 0,
    \`actionsNight\` INT NOT NULL DEFAULT 0,
    \`recolhas\` INT NOT NULL DEFAULT 0,
    \`entregas\` INT NOT NULL DEFAULT 0,
    \`movements\` INT NOT NULL DEFAULT 0,
    \`parkingMoves\` INT NOT NULL DEFAULT 0,
    \`cancels\` INT NOT NULL DEFAULT 0,
    \`otherActions\` INT NOT NULL DEFAULT 0,
    \`weightedActions\` DECIMAL(10,2) NOT NULL DEFAULT 0,
    \`actionsByType\` TEXT NULL,
    \`speedingEvents\` INT NOT NULL DEFAULT 0,
    \`delays\` INT NOT NULL DEFAULT 0,
    \`lateServices\` INT NOT NULL DEFAULT 0,
    \`complaints\` INT NOT NULL DEFAULT 0,
    \`accidents\` INT NOT NULL DEFAULT 0,
    \`incidentsReported\` INT NOT NULL DEFAULT 0,
    \`incidentsAgainst\` INT NOT NULL DEFAULT 0,
    \`penaltyPoints\` INT NOT NULL DEFAULT 0,
    \`positivePoints\` DECIMAL(10,2) NOT NULL DEFAULT 0,
    \`negativePoints\` DECIMAL(10,2) NOT NULL DEFAULT 0,
    \`totalPoints\` DECIMAL(10,2) NOT NULL DEFAULT 0,
    \`computedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY \`uq_employee_day_metrics\` (\`employeeId\`, \`day\`),
    KEY \`idx_edm_day\` (\`day\`),
    KEY \`idx_edm_project_day\` (\`projectId\`, \`day\`)
  )`,
  `CREATE TABLE IF NOT EXISTS \`employee_metric_adjustments\` (
    \`id\` INT AUTO_INCREMENT PRIMARY KEY,
    \`employeeId\` INT NOT NULL,
    \`day\` VARCHAR(10) NOT NULL,
    \`metric\` VARCHAR(32) NOT NULL,
    \`delta\` DECIMAL(10,2) NOT NULL,
    \`reason\` VARCHAR(500) NOT NULL,
    \`authorId\` INT NULL,
    \`authorName\` VARCHAR(128) NULL,
    \`disputeId\` INT NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`voidedAt\` TIMESTAMP NULL,
    \`voidedById\` INT NULL,
    \`voidReason\` VARCHAR(255) NULL,
    KEY \`idx_ema_emp_day\` (\`employeeId\`, \`day\`),
    KEY \`idx_ema_day\` (\`day\`)
  )`,
  `CREATE TABLE IF NOT EXISTS \`employee_metric_disputes\` (
    \`id\` INT AUTO_INCREMENT PRIMARY KEY,
    \`employeeId\` INT NOT NULL,
    \`day\` VARCHAR(10) NOT NULL,
    \`metric\` VARCHAR(32) NULL,
    \`comment\` TEXT NOT NULL,
    \`status\` VARCHAR(16) NOT NULL DEFAULT 'open',
    \`createdByUserId\` INT NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`resolvedById\` INT NULL,
    \`resolvedByName\` VARCHAR(128) NULL,
    \`resolvedAt\` TIMESTAMP NULL,
    \`resolution\` TEXT NULL,
    \`adjustmentId\` INT NULL,
    KEY \`idx_emd_emp_day\` (\`employeeId\`, \`day\`),
    KEY \`idx_emd_status\` (\`status\`, \`createdAt\`)
  )`,
  // Índice de apoio ao ranking (dia + colaborador); repetido = ER_DUP_KEYNAME
  "ALTER TABLE `employee_day_metrics` ADD INDEX `idx_edm_day_emp` (`day`, `employeeId`)",
];

export const IDEMPOTENT_ERROR_CODES_0099 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
