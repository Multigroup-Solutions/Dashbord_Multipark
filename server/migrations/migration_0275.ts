// Migration 0275 — Caixa, fase 4 (confirmar o que não é dinheiro), 29 set 2026.
//   - cash_external_runs: cada corrida diária do cruzamento (online na
//     Multipark; Stripe, Viva Wallet e InvoiceExpress quando ligados);
//   - cash_mb_receipts: talões do multibanco (foto) por parque e dia, ligados
//     a um pagamento; tirar um talão não apaga (removedAt);
//   - cash_mb_days: quem confirmou o multibanco de um parque num dia;
//   - cash_viva_imports / cash_viva_txns: CSV exportado da Viva Wallet e o
//     resultado de cada transação;
//   - cash_monthly_receipts: recebimentos do fim do mês (Pro, agentes,
//     agregadores), conferidos à mão, com comprovativo.
// Só cria tabelas (idempotente). Nada se apaga.

export const MIGRATION_0275_NAME = "0275_cash_confirmations";

export const MIGRATION_0275_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `cash_external_runs` ("
    + " `id` INT AUTO_INCREMENT PRIMARY KEY,"
    + " `at` DATETIME NOT NULL,"
    + " `summaryJson` TEXT NOT NULL,"
    + " KEY `idx_cash_external_runs_at` (`at`)"
    + ")",
  "CREATE TABLE IF NOT EXISTS `cash_mb_receipts` ("
    + " `id` INT AUTO_INCREMENT PRIMARY KEY,"
    + " `parkId` VARCHAR(128) NOT NULL,"
    + " `projectId` INT NULL,"
    + " `day` DATE NOT NULL,"
    + " `amount` DECIMAL(12,2) NOT NULL,"
    + " `bookingId` VARCHAR(128) NULL,"
    + " `photoKey` VARCHAR(512) NULL,"
    + " `photoUrl` VARCHAR(1024) NULL,"
    + " `note` VARCHAR(500) NULL,"
    + " `uploadedBy` INT NULL,"
    + " `uploadedAt` DATETIME NOT NULL,"
    + " `removedAt` DATETIME NULL,"
    + " `removedBy` INT NULL,"
    + " KEY `idx_cash_mb_receipts_park_day` (`parkId`, `day`)"
    + ")",
  "CREATE TABLE IF NOT EXISTS `cash_mb_days` ("
    + " `id` INT AUTO_INCREMENT PRIMARY KEY,"
    + " `parkId` VARCHAR(128) NOT NULL,"
    + " `projectId` INT NULL,"
    + " `day` DATE NOT NULL,"
    + " `payments` INT NOT NULL DEFAULT 0,"
    + " `unmatched` INT NOT NULL DEFAULT 0,"
    + " `extraReceipts` INT NOT NULL DEFAULT 0,"
    + " `confirmedBy` INT NULL,"
    + " `confirmedAt` DATETIME NOT NULL,"
    + " UNIQUE KEY `uq_cash_mb_day` (`parkId`, `day`)"
    + ")",
  "CREATE TABLE IF NOT EXISTS `cash_viva_imports` ("
    + " `id` INT AUTO_INCREMENT PRIMARY KEY,"
    + " `fileName` VARCHAR(255) NULL,"
    + " `periodStart` DATE NULL,"
    + " `periodEnd` DATE NULL,"
    + " `txnCount` INT NOT NULL DEFAULT 0,"
    + " `matchedCount` INT NOT NULL DEFAULT 0,"
    + " `casesOpened` INT NOT NULL DEFAULT 0,"
    + " `summaryJson` TEXT NULL,"
    + " `uploadedBy` INT NULL,"
    + " `uploadedAt` DATETIME NOT NULL,"
    + " KEY `idx_cash_viva_imports_at` (`uploadedAt`)"
    + ")",
  "CREATE TABLE IF NOT EXISTS `cash_viva_txns` ("
    + " `id` BIGINT AUTO_INCREMENT PRIMARY KEY,"
    + " `importId` INT NOT NULL,"
    + " `txnId` VARCHAR(128) NULL,"
    + " `at` DATETIME NULL,"
    + " `amount` DECIMAL(12,2) NOT NULL,"
    + " `channel` VARCHAR(16) NOT NULL,"
    + " `terminalId` VARCHAR(64) NULL,"
    + " `matchState` VARCHAR(16) NOT NULL DEFAULT 'por_ver',"
    + " `bookingId` VARCHAR(128) NULL,"
    + " KEY `idx_cash_viva_txns_import` (`importId`)"
    + ")",
  "CREATE TABLE IF NOT EXISTS `cash_monthly_receipts` ("
    + " `id` INT AUTO_INCREMENT PRIMARY KEY,"
    + " `kind` VARCHAR(16) NOT NULL,"
    + " `entityId` VARCHAR(191) NOT NULL,"
    + " `entityName` VARCHAR(255) NULL,"
    + " `month` CHAR(7) NOT NULL,"
    + " `amount` DECIMAL(12,2) NOT NULL,"
    + " `receivedOn` DATE NULL,"
    + " `proofKey` VARCHAR(512) NULL,"
    + " `proofUrl` VARCHAR(1024) NULL,"
    + " `note` VARCHAR(500) NULL,"
    + " `createdBy` INT NULL,"
    + " `createdAt` DATETIME NOT NULL,"
    + " `removedAt` DATETIME NULL,"
    + " `removedBy` INT NULL,"
    + " KEY `idx_cash_monthly_entity` (`kind`, `entityId`, `month`),"
    + " KEY `idx_cash_monthly_month` (`month`)"
    + ")",
];

export const IDEMPOTENT_ERROR_CODES_0275 = new Set<string>(["ER_TABLE_EXISTS_ERROR"]);
