// Migration 0635 — Confirmação da caixa reserva a reserva (Jorge, 13 out 2026;
// plano docs/plans/2026-10-13-confirmacao-caixa-plano.md).
//
//  - shift_handovers: o team leader declara, no fecho do turno (depois de fechar
//    na Multipark), o dinheiro recebido dos condutores (antes das despesas), o
//    Multibanco recebido e o total que dava a caixa na Multipark.
//  - cash_confirm_days: o ESTADO de cada cidade × dia (aberto, fechado, à espera
//    do Jorge, aprovado, reaberto), o que o João confirmou, a diferença e o selo.
//    É a única tabela mutável; cada mudança gera um evento.
//  - cash_confirm_events: TUDO o que acontece (justificar, anexar, fechar,
//    aprovar, reabrir…), em cadeia de hashes por cidade × dia
//    (hash = sha256(prevHash + JSON canónico)). SÓ ACRÉSCIMO.
//  - cash_confirm_justifications / cash_confirm_decisions / cash_confirm_files /
//    cash_confirm_file_removals: justificações do João, decisões do Jorge,
//    ficheiros (sha256 único — o mesmo talão nunca serve duas vezes) e a
//    retirada de um ficheiro (o ficheiro nunca se apaga). SÓ ACRÉSCIMO.
//
// Só acrescenta. ADD COLUMN / CREATE TABLE IF NOT EXISTS ignoram o que já existe.

export const MIGRATION_0635_STATEMENTS: string[] = [
  "ALTER TABLE `shift_handovers` ADD COLUMN `cashierCashReceived` DECIMAL(10,2) NULL",
  "ALTER TABLE `shift_handovers` ADD COLUMN `cashierMbReceived` DECIMAL(10,2) NULL",
  "ALTER TABLE `shift_handovers` ADD COLUMN `cashierMultiparkTotal` DECIMAL(10,2) NULL",
  "CREATE TABLE IF NOT EXISTS `cash_confirm_days` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`day` VARCHAR(10) NOT NULL, " +
    "`city` VARCHAR(16) NOT NULL, " +
    "`status` VARCHAR(16) NOT NULL DEFAULT 'aberto', " +
    "`confirmedCash` DECIMAL(12,2) NULL, " +
    "`confirmedMb` DECIMAL(12,2) NULL, " +
    "`note` TEXT NULL, " +
    "`differenceCents` INT NULL, " +
    "`alert` VARCHAR(8) NULL, " +
    "`closedBy` INT NULL, " +
    "`closedAt` TIMESTAMP(3) NULL, " +
    "`approvedBy` INT NULL, " +
    "`approvedAt` TIMESTAMP(3) NULL, " +
    "`sealHash` CHAR(64) NULL, " +
    "`sealJson` MEDIUMTEXT NULL, " +
    "`reopenedAt` TIMESTAMP(3) NULL, " +
    "`reopenReason` TEXT NULL, " +
    "`lastCheckedAt` TIMESTAMP(3) NULL, " +
    "`updatedAt` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_cash_confirm_day` (`day`, `city`), " +
    "KEY `idx_cash_confirm_days_status` (`status`, `day`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  "CREATE TABLE IF NOT EXISTS `cash_confirm_events` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`day` VARCHAR(10) NOT NULL, " +
    "`city` VARCHAR(16) NOT NULL, " +
    "`at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), " +
    "`userId` INT NULL, " +
    "`action` VARCHAR(32) NOT NULL, " +
    "`findingKey` VARCHAR(200) NULL, " +
    "`data` MEDIUMTEXT NULL, " +
    "`prevHash` CHAR(64) NOT NULL, " +
    "`hash` CHAR(64) NOT NULL, " +
    "PRIMARY KEY (`id`), " +
    "KEY `idx_cash_confirm_events_day` (`day`, `city`, `id`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  "CREATE TABLE IF NOT EXISTS `cash_confirm_justifications` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`day` VARCHAR(10) NOT NULL, " +
    "`city` VARCHAR(16) NOT NULL, " +
    "`findingKey` VARCHAR(200) NOT NULL, " +
    "`bookingId` VARCHAR(64) NULL, " +
    "`code` VARCHAR(40) NOT NULL, " +
    "`color` VARCHAR(8) NOT NULL, " +
    "`amountCents` INT NOT NULL DEFAULT 0, " +
    "`reason` VARCHAR(40) NOT NULL, " +
    "`explanation` TEXT NOT NULL, " +
    "`fileIds` TEXT NULL, " +
    "`userId` INT NOT NULL, " +
    "`at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), " +
    "PRIMARY KEY (`id`), " +
    "KEY `idx_cash_confirm_just_day` (`day`, `city`), " +
    "KEY `idx_cash_confirm_just_key` (`findingKey`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  "CREATE TABLE IF NOT EXISTS `cash_confirm_decisions` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`day` VARCHAR(10) NOT NULL, " +
    "`city` VARCHAR(16) NOT NULL, " +
    "`justificationId` INT NULL, " +
    "`decision` VARCHAR(12) NOT NULL, " +
    "`note` TEXT NULL, " +
    "`userId` INT NOT NULL, " +
    "`at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), " +
    "PRIMARY KEY (`id`), " +
    "KEY `idx_cash_confirm_dec_day` (`day`, `city`), " +
    "KEY `idx_cash_confirm_dec_just` (`justificationId`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  "CREATE TABLE IF NOT EXISTS `cash_confirm_files` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`day` VARCHAR(10) NOT NULL, " +
    "`city` VARCHAR(16) NOT NULL, " +
    "`bookingId` VARCHAR(64) NULL, " +
    "`kind` VARCHAR(16) NOT NULL, " +
    "`amountCents` INT NULL, " +
    "`storageKey` VARCHAR(255) NOT NULL, " +
    "`mime` VARCHAR(64) NOT NULL, " +
    "`size` INT NOT NULL, " +
    "`sha256` CHAR(64) NOT NULL, " +
    "`uploadedBy` INT NOT NULL, " +
    "`uploadedAt` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_cash_confirm_files_sha` (`sha256`), " +
    "KEY `idx_cash_confirm_files_day` (`day`, `city`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  "CREATE TABLE IF NOT EXISTS `cash_confirm_file_removals` (" +
    "`fileId` INT NOT NULL, " +
    "`userId` INT NOT NULL, " +
    "`reason` VARCHAR(255) NULL, " +
    "`at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), " +
    "PRIMARY KEY (`fileId`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
];

/** ER_DUP_FIELDNAME (1060), ER_TABLE_EXISTS_ERROR (1050), ER_DUP_KEYNAME (1061). */
export const IDEMPOTENT_ERROR_CODES_0635 = new Set<string>(["ER_DUP_FIELDNAME", "ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME"]);
