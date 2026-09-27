// Migration 0220 — CRM fase 2: clientes Pro com CONTA CORRENTE (Jorge, 27 set 2026).
//
// Os Pro pagam no fim do mês. A conta corrente fica na NOSSA BD, alimentada
// pela BD da Multipark (só leitura), que é quem manda: o que está pago é o
// que a Multipark registou. Nada se paga cá. Regras: shared/crmPro.ts.
//
//  - crm_pro_accounts: uma conta por cliente da Multipark ("Client") que é Pro
//    em pelo menos um parque. Ligada à ficha do CRM (crm_clients).
//  - crm_pro_parks: os "ProClient" da conta (um por parque: desconto, ativo).
//  - crm_pro_ledger: os movimentos, idempotentes por (kind, sourceId = id na
//    Multipark):
//      booking       débito = soma das linhas de preço da reserva ("BookingPricing.total";
//                    sem linhas, "bookingPrice"); `paidAmount` = soma de "amountPaid"
//      payment       crédito = um pagamento datado ("BookingPricingPayment")
//      paid_undated  crédito = pago na reserva sem pagamento datado (registos antigos)
//      settlement    marca "período pago" ("EntitySettlement"), não conta no saldo
//      online        marca "pagamento online" ("ProPayment"), não conta no saldo
//    `periodKey` = mês "AAAA-MM" (Lisboa) da ENTRADA da reserva a que o
//    movimento diz respeito — os Pro são faturados no fim de cada mês.
//
// Sem charset/collation explícitos (o passo da 0215 acerta todas as crm_*).
// Idempotente (corre em cada arranque via ensureRecentSchema).

export const MIGRATION_0220_NAME = "0220_crm_pro_accounts";

const T = " ENGINE=InnoDB";

export const MIGRATION_0220_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `crm_pro_accounts` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`mpClientId` VARCHAR(64) NOT NULL, " +
    "`crmClientId` INT NULL, " +
    "`name` VARCHAR(255) NULL, " +
    "`email` VARCHAR(320) NULL, " +
    "`phone` VARCHAR(40) NULL, " +
    "`nif` VARCHAR(32) NULL, " +
    "`taxName` VARCHAR(255) NULL, " +
    "`autoBilling` TINYINT NOT NULL DEFAULT 0, " +
    "`active` TINYINT NOT NULL DEFAULT 1, " +
    "`billingEmail` VARCHAR(320) NULL, " +
    "`notes` TEXT NULL, " +
    "`syncedAt` DATETIME NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_crm_pro_mp_client` (`mpClientId`), " +
    "KEY `idx_crm_pro_crm_client` (`crmClientId`)" +
    ")" + T,
  "CREATE TABLE IF NOT EXISTS `crm_pro_parks` (" +
    "`proClientId` VARCHAR(64) NOT NULL, " +
    "`accountId` INT NOT NULL, " +
    "`parkId` VARCHAR(64) NULL, " +
    "`parkName` VARCHAR(128) NULL, " +
    "`city` VARCHAR(64) NULL, " +
    "`name` VARCHAR(255) NULL, " +
    "`discount` DECIMAL(5,2) NULL, " +
    "`active` TINYINT NOT NULL DEFAULT 1, " +
    "`deactivatedAt` DATETIME NULL, " +
    "`mpCreatedAt` DATETIME NULL, " +
    "`goneAt` DATETIME NULL, " +
    "PRIMARY KEY (`proClientId`), " +
    "KEY `idx_crm_pro_parks_account` (`accountId`)" +
    ")" + T,
  "CREATE TABLE IF NOT EXISTS `crm_pro_ledger` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`accountId` INT NOT NULL, " +
    "`kind` VARCHAR(16) NOT NULL, " +
    "`sourceId` VARCHAR(64) NOT NULL, " +
    "`entryAt` DATETIME NOT NULL, " +
    "`periodKey` VARCHAR(7) NOT NULL DEFAULT '', " +
    "`mpPeriodKey` VARCHAR(64) NULL, " +
    "`parkId` VARCHAR(64) NULL, " +
    "`parkName` VARCHAR(128) NULL, " +
    "`city` VARCHAR(64) NULL, " +
    "`bookingExternalId` VARCHAR(128) NULL, " +
    "`bookingCode` VARCHAR(64) NULL, " +
    "`checkIn` DATETIME NULL, " +
    "`checkOut` DATETIME NULL, " +
    "`plate` VARCHAR(32) NULL, " +
    "`travelerName` VARCHAR(255) NULL, " +
    "`description` VARCHAR(255) NULL, " +
    "`debit` DECIMAL(12,2) NOT NULL DEFAULT 0, " +
    "`credit` DECIMAL(12,2) NOT NULL DEFAULT 0, " +
    "`paidAmount` DECIMAL(12,2) NULL, " +
    "`listPrice` DECIMAL(12,2) NULL, " +
    "`discountAmount` DECIMAL(12,2) NULL, " +
    "`infoAmount` DECIMAL(12,2) NULL, " +
    "`status` VARCHAR(24) NULL, " +
    "`method` VARCHAR(64) NULL, " +
    "`goneAt` DATETIME NULL, " +
    "`syncedAt` DATETIME NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_crm_pro_ledger_source` (`kind`, `sourceId`), " +
    "KEY `idx_crm_pro_ledger_account` (`accountId`, `entryAt`), " +
    "KEY `idx_crm_pro_ledger_period` (`accountId`, `periodKey`), " +
    "KEY `idx_crm_pro_ledger_booking` (`bookingExternalId`)" +
    ")" + T,
];

export const IDEMPOTENT_ERROR_CODES_0220 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME", "ER_DUP_FIELDNAME"]);
