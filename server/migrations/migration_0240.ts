// Migration 0240 — Memória do webhook da Multipark (caixa, 28 set 2026).
//
// Decisão do dono: o que nos chega pelo WEBHOOK da Multipark fica guardado na
// nossa BD e NUNCA é reescrito nem apagado (memória só de acréscimo). Uma
// linha por entrega (`deliveryId` único: as repetições da mesma entrega não
// duplicam), com os campos de dinheiro tal como vieram e o payload em JSON
// SEM dados pessoais (sem email, telefone, nome, NIF nem matrícula).
//
// Serve para a "Conferência (era / é)" da ficha da reserva e para a
// "Correção de caixa" da Faturação: o "era" vem daqui, o "é" vem da BD da
// Multipark ao vivo. Não há UPDATE nem DELETE a esta tabela em lado nenhum
// do código (server/webhookMemory.test.ts verifica-o).
//
// Idempotente (corre em cada arranque via ensureRecentSchema).

export const MIGRATION_0240_NAME = "0240_multipark_webhook_snapshots";

export const MIGRATION_0240_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `multipark_webhook_snapshots` (" +
    "`id` BIGINT NOT NULL AUTO_INCREMENT, " +
    "`deliveryId` VARCHAR(191) NOT NULL, " +
    "`bookingId` VARCHAR(128) NOT NULL, " +
    "`eventType` VARCHAR(64) NOT NULL, " +
    "`receivedAt` DATETIME(3) NOT NULL, " +
    "`signatureValid` TINYINT(1) NOT NULL DEFAULT 0, " +
    "`eventCreatedAt` DATETIME NULL, " +
    "`sourceCreatedAt` DATETIME NULL, " +
    "`sourceUpdatedAt` DATETIME NULL, " +
    "`parkId` VARCHAR(128) NULL, " +
    "`status` VARCHAR(40) NULL, " +
    "`checkIn` DATETIME NULL, " +
    "`checkOut` DATETIME NULL, " +
    "`bookingPrice` DECIMAL(12,2) NULL, " +
    "`originalBookingPrice` DECIMAL(12,2) NULL, " +
    "`parkingPrice` DECIMAL(12,2) NULL, " +
    "`deliveryPrice` DECIMAL(12,2) NULL, " +
    "`discountAmount` DECIMAL(12,2) NULL, " +
    "`discountApplied` TINYINT(1) NULL, " +
    "`paidAmount` DECIMAL(12,2) NULL, " +
    "`paymentMethod` VARCHAR(128) NULL, " +
    "`paymentSource` VARCHAR(64) NULL, " +
    "`paymentBy` VARCHAR(64) NULL, " +
    "`campaignId` VARCHAR(128) NULL, " +
    "`partnerId` VARCHAR(128) NULL, " +
    "`partnerAmountDue` DECIMAL(12,2) NULL, " +
    "`partnerAmountPaid` DECIMAL(12,2) NULL, " +
    "`partnerContributedAmount` DECIMAL(12,2) NULL, " +
    "`pro` TINYINT(1) NULL, " +
    "`proClientId` VARCHAR(128) NULL, " +
    "`cashierClosed` TINYINT(1) NULL, " +
    "`cashValidated` TINYINT(1) NULL, " +
    "`driverValidated` TINYINT(1) NULL, " +
    "`payloadHash` CHAR(64) NOT NULL, " +
    "`payloadJson` MEDIUMTEXT NOT NULL, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_mp_webhook_snap_delivery` (`deliveryId`), " +
    "KEY `idx_mp_webhook_snap_booking` (`bookingId`, `receivedAt`), " +
    "KEY `idx_mp_webhook_snap_checkout` (`parkId`, `checkOut`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
];

export const IDEMPOTENT_ERROR_CODES_0240 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME"]);
