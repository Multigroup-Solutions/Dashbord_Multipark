// Migration 0270 — Caixa, fase 3 (contar), 29 set 2026: a contagem da caixa
// por parque, dia e turno, e os gastos pagos da caixa (R24:
// recebido em dinheiro − gastos = esperado · contado · diferença).
//   - cash_counts: a contagem atual (uma por parque × dia × turno);
//   - cash_count_expenses: gastos pagos da caixa nessa contagem;
//   - cash_count_log: cada gravação (só acréscimo — quem, quando, o quê).
// Só cria tabelas (idempotente).

export const MIGRATION_0270_NAME = "0270_cash_counts";

export const MIGRATION_0270_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `cash_counts` ("
    + " `id` INT AUTO_INCREMENT PRIMARY KEY,"
    + " `parkId` VARCHAR(128) NOT NULL,"
    + " `projectId` INT NULL,"
    + " `day` DATE NOT NULL,"
    + " `shift` VARCHAR(8) NOT NULL DEFAULT 'dia',"
    + " `receivedCash` DECIMAL(12,2) NOT NULL DEFAULT 0,"
    + " `expensesCash` DECIMAL(12,2) NOT NULL DEFAULT 0,"
    + " `expectedCash` DECIMAL(12,2) NOT NULL DEFAULT 0,"
    + " `countedAmount` DECIMAL(12,2) NOT NULL,"
    + " `difference` DECIMAL(12,2) NOT NULL DEFAULT 0,"
    + " `note` TEXT NULL,"
    + " `countedBy` INT NULL,"
    + " `countedAt` DATETIME NOT NULL,"
    + " UNIQUE KEY `uq_cash_count` (`parkId`, `day`, `shift`),"
    + " KEY `idx_cash_count_project_day` (`projectId`, `day`)"
    + ")",
  "CREATE TABLE IF NOT EXISTS `cash_count_expenses` ("
    + " `id` INT AUTO_INCREMENT PRIMARY KEY,"
    + " `countId` INT NOT NULL,"
    + " `description` VARCHAR(255) NOT NULL,"
    + " `amount` DECIMAL(12,2) NOT NULL,"
    + " `receipt` VARCHAR(255) NULL,"
    + " `createdBy` INT NULL,"
    + " `createdAt` DATETIME NOT NULL,"
    + " KEY `idx_cash_count_expenses_count` (`countId`)"
    + ")",
  "CREATE TABLE IF NOT EXISTS `cash_count_log` ("
    + " `id` BIGINT AUTO_INCREMENT PRIMARY KEY,"
    + " `countId` INT NOT NULL,"
    + " `userId` INT NULL,"
    + " `at` DATETIME NOT NULL,"
    + " `dataJson` TEXT NOT NULL,"
    + " KEY `idx_cash_count_log_count` (`countId`, `at`)"
    + ")",
];

export const IDEMPOTENT_ERROR_CODES_0270 = new Set<string>(["ER_TABLE_EXISTS_ERROR"]);
