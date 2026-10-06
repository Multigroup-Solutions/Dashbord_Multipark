// Migration 0470 — Caixa por dia (P3 lote 29d, Jorge 6 out 2026):
//  - Despesas do turno: o team leader lança-as na Passagem de turno e entram
//    DIRETAS nas Despesas (paga, dinheiro) e na caixa do dia —
//    `expenses.cashSource` = "shift:<dia>:<turno>:<cidade>".
//  - Correção do dia por cidade: "dia certo / não certo" com motivo —
//    `cash_day_reviews` (o estado atual) e `cash_day_review_log` (cada
//    gravação, nunca se apaga).
// Só acrescenta (nada se apaga). Idempotente.
export const MIGRATION_0470_STATEMENTS: string[] = [
  "ALTER TABLE `expenses` ADD COLUMN `cashSource` VARCHAR(64) NULL DEFAULT NULL",
  "ALTER TABLE `expenses` ADD INDEX `idx_expenses_cash_source` (`cashSource`)",
  "CREATE TABLE IF NOT EXISTS `cash_day_reviews` ("
    + " `id` INT AUTO_INCREMENT PRIMARY KEY,"
    + " `day` DATE NOT NULL,"
    + " `city` VARCHAR(16) NOT NULL,"
    + " `status` VARCHAR(16) NOT NULL,"
    + " `reason` TEXT NULL,"
    + " `expectedCash` DECIMAL(12,2) NULL,"
    + " `countedCash` DECIMAL(12,2) NULL,"
    + " `reviewedBy` INT NULL,"
    + " `reviewedAt` DATETIME NOT NULL,"
    + " UNIQUE KEY `uq_cash_day_review` (`day`, `city`)"
    + ")",
  "CREATE TABLE IF NOT EXISTS `cash_day_review_log` ("
    + " `id` BIGINT AUTO_INCREMENT PRIMARY KEY,"
    + " `day` DATE NOT NULL,"
    + " `city` VARCHAR(16) NOT NULL,"
    + " `status` VARCHAR(16) NOT NULL,"
    + " `reason` TEXT NULL,"
    + " `expectedCash` DECIMAL(12,2) NULL,"
    + " `countedCash` DECIMAL(12,2) NULL,"
    + " `userId` INT NULL,"
    + " `at` DATETIME NOT NULL,"
    + " KEY `idx_cash_day_review_log` (`day`, `city`, `at`)"
    + ")",
];

export const IDEMPOTENT_ERROR_CODES_0470 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME", "ER_TABLE_EXISTS_ERROR"]);
