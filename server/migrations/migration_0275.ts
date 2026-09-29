// Migration 0275 — Caixa, fase 4 (cruzar com o exterior), 29 set 2026: os
// extratos importados em CSV (terminal multibanco, banco e parceiros) e as
// suas linhas, com o que cada linha encontrou na Multipark.
//   - cash_statement_batches: um ficheiro importado (tipo, parque/parceiro,
//     período, quem, quando, resumo do cruzamento);
//   - cash_statement_lines: as linhas (dia, valor, referência) e o resultado;
//   - cash_external_runs: cada corrida do cruzamento diário (InvoiceExpress e
//     Stripe) com o resumo, para o ecrã mostrar o estado.
// Só cria tabelas (idempotente). Nada se apaga: um extrato novo do mesmo
// período fica ao lado do anterior.

export const MIGRATION_0275_NAME = "0275_cash_statements";

export const MIGRATION_0275_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `cash_statement_batches` ("
    + " `id` INT AUTO_INCREMENT PRIMARY KEY,"
    + " `kind` VARCHAR(16) NOT NULL,"
    + " `parkId` VARCHAR(128) NULL,"
    + " `projectId` INT NULL,"
    + " `partnerName` VARCHAR(128) NULL,"
    + " `fileName` VARCHAR(255) NULL,"
    + " `periodStart` DATE NULL,"
    + " `periodEnd` DATE NULL,"
    + " `lineCount` INT NOT NULL DEFAULT 0,"
    + " `matchedCount` INT NOT NULL DEFAULT 0,"
    + " `casesOpened` INT NOT NULL DEFAULT 0,"
    + " `summaryJson` TEXT NULL,"
    + " `uploadedBy` INT NULL,"
    + " `uploadedAt` DATETIME NOT NULL,"
    + " KEY `idx_cash_statement_kind` (`kind`, `uploadedAt`),"
    + " KEY `idx_cash_statement_project` (`projectId`, `uploadedAt`)"
    + ")",
  "CREATE TABLE IF NOT EXISTS `cash_statement_lines` ("
    + " `id` BIGINT AUTO_INCREMENT PRIMARY KEY,"
    + " `batchId` INT NOT NULL,"
    + " `lineNo` INT NOT NULL,"
    + " `day` DATE NOT NULL,"
    + " `amount` DECIMAL(12,2) NOT NULL,"
    + " `reference` VARCHAR(255) NULL,"
    + " `description` VARCHAR(255) NULL,"
    + " `matchState` VARCHAR(16) NOT NULL DEFAULT 'por_ver',"
    + " `bookingId` VARCHAR(128) NULL,"
    + " `bookingCode` VARCHAR(64) NULL,"
    + " KEY `idx_cash_statement_lines_batch` (`batchId`, `lineNo`)"
    + ")",
  "CREATE TABLE IF NOT EXISTS `cash_external_runs` ("
    + " `id` INT AUTO_INCREMENT PRIMARY KEY,"
    + " `at` DATETIME NOT NULL,"
    + " `summaryJson` TEXT NOT NULL,"
    + " KEY `idx_cash_external_runs_at` (`at`)"
    + ")",
];

export const IDEMPOTENT_ERROR_CODES_0275 = new Set<string>(["ER_TABLE_EXISTS_ERROR"]);
