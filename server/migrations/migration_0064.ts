// Migration 0064 — RH: riscos imediatos + ponto/ordenados + fecho mensal
// (auditoria "Recursos Humanos — auditoria e melhorias", set 2026).
//
//  - employees: motivos de bloqueio SEPARADOS (blockedByDocs / blockedByPenalties /
//    blockedManually). loginBlocked passa a ser o OR dos três; um processo
//    nunca apaga o bloqueio criado por outro. Backfill: quem está bloqueado
//    hoje fica em blockedManually (preserva o estado) exceto se o motivo diz
//    "faltas" → blockedByPenalties.
//  - employee_penalties: status pending/confirmed/dismissed (faltas automáticas
//    nascem pendentes) + UNIQUE (employeeId, reason, relatedId) contra
//    execuções concorrentes (dedupe prévio dos duplicados existentes).
//  - time_records: reviewStatus (suspeitos não pagam até aprovação) + backfill
//    a partir das notas "[SUSPEITO]".
//  - payroll_runs / payroll_run_lines: fecho mensal versionado.
//
// Idempotente: corre no boot (ensureRecentSchema). Numeração 0064 porque a
// 0063 está reservada ao Google Ads (branch paralelo).

export const MIGRATION_0064_NAME = "0064_rh_blocks_penalties_review_payroll_runs";

export const MIGRATION_0064_STATEMENTS: string[] = [
  // ── employees: motivos de bloqueio ─────────────────────────────────────────
  "ALTER TABLE `employees` ADD COLUMN `blockedByDocs` TINYINT NOT NULL DEFAULT 0",
  "ALTER TABLE `employees` ADD COLUMN `blockedByPenalties` TINYINT NOT NULL DEFAULT 0",
  "ALTER TABLE `employees` ADD COLUMN `blockedManually` TINYINT NOT NULL DEFAULT 0",
  "UPDATE `employees` SET `blockedByPenalties` = 1 WHERE `loginBlocked` = 1 AND `blockedByDocs` = 0 AND `blockedByPenalties` = 0 AND `blockedManually` = 0 AND `loginBlockedReason` LIKE '%falta%'",
  "UPDATE `employees` SET `blockedManually` = 1 WHERE `loginBlocked` = 1 AND `blockedByDocs` = 0 AND `blockedByPenalties` = 0 AND `blockedManually` = 0",

  // ── employee_penalties: estado + unicidade ────────────────────────────────
  "ALTER TABLE `employee_penalties` ADD COLUMN `status` ENUM('pending','confirmed','dismissed') NOT NULL DEFAULT 'confirmed' AFTER `clearedById`",
  "ALTER TABLE `employee_penalties` ADD COLUMN `reviewedById` INT NULL AFTER `status`",
  "ALTER TABLE `employee_penalties` ADD COLUMN `reviewedAt` TIMESTAMP NULL AFTER `reviewedById`",
  // dedupe: mantém o mais antigo por (employeeId, reason, relatedId)
  "DELETE p1 FROM `employee_penalties` p1 INNER JOIN `employee_penalties` p2 ON p1.employeeId = p2.employeeId AND p1.reason = p2.reason AND p1.relatedId <=> p2.relatedId AND p1.relatedId IS NOT NULL AND p1.id > p2.id",
  "ALTER TABLE `employee_penalties` ADD UNIQUE INDEX `uq_employee_penalties_related` (`employeeId`, `reason`, `relatedId`)",

  // ── time_records: revisão ─────────────────────────────────────────────────
  "ALTER TABLE `time_records` ADD COLUMN `reviewStatus` ENUM('ok','suspicious','approved','rejected') NOT NULL DEFAULT 'ok' AFTER `zelloOnlineMinutes`",
  "ALTER TABLE `time_records` ADD COLUMN `reviewedById` INT NULL AFTER `reviewStatus`",
  "ALTER TABLE `time_records` ADD COLUMN `reviewedAt` TIMESTAMP NULL AFTER `reviewedById`",
  "ALTER TABLE `time_records` ADD COLUMN `reviewNote` VARCHAR(255) NULL AFTER `reviewedAt`",
  "UPDATE `time_records` SET `reviewStatus` = 'suspicious' WHERE `reviewStatus` = 'ok' AND `notes` LIKE '%[SUSPEITO]%'",
  "ALTER TABLE `time_records` ADD INDEX `idx_time_records_emp_at` (`employeeId`, `recordedAt`)",

  // ── fecho mensal ─────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS \`payroll_runs\` (
    \`id\` INT NOT NULL AUTO_INCREMENT,
    \`year\` INT NOT NULL,
    \`month\` INT NOT NULL,
    \`version\` INT NOT NULL DEFAULT 1,
    \`status\` ENUM('draft','approved','paid','void') NOT NULL DEFAULT 'draft',
    \`employeesCount\` INT NOT NULL DEFAULT 0,
    \`totalGross\` DECIMAL(12,2) NOT NULL DEFAULT 0,
    \`totalNetEstimate\` DECIMAL(12,2) NOT NULL DEFAULT 0,
    \`warningsCount\` INT NOT NULL DEFAULT 0,
    \`notes\` TEXT NULL,
    \`createdById\` INT NULL,
    \`approvedById\` INT NULL,
    \`approvedAt\` TIMESTAMP NULL,
    \`paidById\` INT NULL,
    \`paidAt\` TIMESTAMP NULL,
    \`paymentRef\` VARCHAR(128) NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE INDEX \`uq_payroll_runs_month_version\` (\`year\`, \`month\`, \`version\`)
  )`,
  `CREATE TABLE IF NOT EXISTS \`payroll_run_lines\` (
    \`id\` INT NOT NULL AUTO_INCREMENT,
    \`runId\` INT NOT NULL,
    \`employeeId\` INT NOT NULL,
    \`fullName\` VARCHAR(256) NULL,
    \`isExtra\` TINYINT NOT NULL DEFAULT 0,
    \`totalHours\` DECIMAL(8,2) NOT NULL DEFAULT 0,
    \`totalPayment\` DECIMAL(12,2) NOT NULL DEFAULT 0,
    \`netEstimate\` DECIMAL(12,2) NOT NULL DEFAULT 0,
    \`snapshot\` TEXT NOT NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    INDEX \`idx_payroll_run_lines_run\` (\`runId\`),
    UNIQUE INDEX \`uq_payroll_run_lines_emp\` (\`runId\`, \`employeeId\`)
  )`,
];

export const IDEMPOTENT_ERROR_CODES_0064 = new Set([
  "ER_DUP_FIELDNAME",
  "ER_DUP_KEYNAME",
  "ER_TABLE_EXISTS_ERROR",
]);
