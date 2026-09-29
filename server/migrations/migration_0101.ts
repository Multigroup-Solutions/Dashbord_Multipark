// Migration 0101 — Sincronização Multipark: janela por parque, trinco,
// reconciliação diária, alertas e dead-letter da fila (24 set 2026)
//
//  - multipark_sync_logs: windowStart/windowEnd (janela realmente pedida) e
//    meta (JSON: parques com erro, trabalhos por fazer, total≠length). As
//    linhas antigas ficam com NULL e continuam válidas.
//  - multipark_sync_coverage: última cobertura COMPLETA do sync recente por
//    parque (um parque partido não força 3 dias aos outros).
//  - multipark_sync_lock: trinco por lease partilhado por cron, botões e MCP.
//  - multipark_reconciliation: diferenças do report D-1/D-2 contra a BD.
//  - multipark_sync_alerts: estado dos alertas (1 aviso por transição).
//  - multipark_webhook_jobs: deadAt + índice para a limpeza dos concluídos.
//
// Idempotente (corre em cada arranque): CREATE TABLE IF NOT EXISTS e
// ER_DUP_FIELDNAME / ER_DUP_KEYNAME / ER_TABLE_EXISTS_ERROR ignorados. O único
// UPDATE só toca em linhas ainda 'failed' que já cumprem a regra do dead-letter,
// por isso repetir não muda nada.

export const MIGRATION_0101_NAME = "0101_multipark_sync_health";

export const MIGRATION_0101_STATEMENTS: string[] = [
  "ALTER TABLE `multipark_sync_logs` ADD COLUMN `windowStart` DATETIME NULL",
  "ALTER TABLE `multipark_sync_logs` ADD COLUMN `windowEnd` DATETIME NULL",
  "ALTER TABLE `multipark_sync_logs` ADD COLUMN `meta` TEXT NULL",
  "ALTER TABLE `multipark_sync_logs` ADD INDEX `idx_mpsl_type_status` (`syncType`, `status`, `startedAt`)",
  `CREATE TABLE IF NOT EXISTS \`multipark_sync_coverage\` (
    \`parkId\` VARCHAR(64) NOT NULL PRIMARY KEY,
    \`recentCoveredAt\` DATETIME NULL,
    \`lastRunAt\` DATETIME NULL,
    \`lastStatus\` VARCHAR(16) NULL,
    \`lastErrorCode\` VARCHAR(64) NULL,
    \`updatedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS \`multipark_sync_lock\` (
    \`name\` VARCHAR(64) NOT NULL PRIMARY KEY,
    \`holder\` VARCHAR(64) NULL,
    \`owner\` VARCHAR(64) NULL,
    \`acquiredAt\` DATETIME NULL,
    \`leaseUntil\` DATETIME NULL
  )`,
  `CREATE TABLE IF NOT EXISTS \`multipark_reconciliation\` (
    \`id\` INT AUTO_INCREMENT PRIMARY KEY,
    \`day\` VARCHAR(10) NOT NULL,
    \`parkId\` VARCHAR(64) NOT NULL,
    \`actionType\` VARCHAR(16) NOT NULL,
    \`apiTotal\` INT NULL,
    \`apiCount\` INT NOT NULL DEFAULT 0,
    \`dbFound\` INT NOT NULL DEFAULT 0,
    \`missing\` INT NOT NULL DEFAULT 0,
    \`status\` VARCHAR(16) NOT NULL,
    \`errorCode\` VARCHAR(64) NULL,
    \`checkedAt\` DATETIME NOT NULL,
    UNIQUE KEY \`uq_mp_recon\` (\`day\`, \`parkId\`, \`actionType\`),
    KEY \`idx_mp_recon_status\` (\`status\`, \`day\`)
  )`,
  `CREATE TABLE IF NOT EXISTS \`multipark_sync_alerts\` (
    \`alertKey\` VARCHAR(64) NOT NULL PRIMARY KEY,
    \`active\` TINYINT NOT NULL DEFAULT 0,
    \`since\` DATETIME NULL,
    \`detail\` VARCHAR(255) NULL,
    \`updatedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,
  "ALTER TABLE `multipark_webhook_jobs` ADD COLUMN `deadAt` DATETIME NULL",
  "ALTER TABLE `multipark_webhook_jobs` ADD INDEX `mp_jobs_state_completed` (`state`, `completedAt`)",
  // Dead-letter retroativo: só linhas 'failed' que já cumprem a regra.
  `UPDATE \`multipark_webhook_jobs\` SET \`state\` = 'dead', \`deadAt\` = UTC_TIMESTAMP()
    WHERE \`state\` = 'failed' AND (\`attempts\` >= 10 OR \`errorCode\` IN ('PARK_ACCESS_MISSING', 'PARK_NOT_MAPPED'))`,
];

export const IDEMPOTENT_ERROR_CODES_0101 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
