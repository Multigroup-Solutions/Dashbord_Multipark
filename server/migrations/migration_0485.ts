// Migration 0485 — Rádio: provas (P3 lote 34a, Jorge 6 out 2026): "guardar
// alguns registos com o histórico e a transcrição para servir de prova".
// Uma linha por mensagem do Zello guardada: a fotografia (quem, quando,
// transcrição, GPS, ações na Multipark) + situação, referência, notas, quem
// guardou e o selo (sha256). Não se apaga: arquiva-se com motivo.
// Só acrescenta. Idempotente.
export const MIGRATION_0485_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `radio_evidence` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`zelloMessageId` BIGINT NOT NULL, " +
    "`messageAt` DATETIME NOT NULL, " +
    "`sender` VARCHAR(128) NOT NULL, " +
    "`senderName` VARCHAR(200) NULL, " +
    "`recipient` VARCHAR(128) NULL, " +
    "`recipientType` VARCHAR(20) NULL, " +
    "`durationS` DECIMAL(8,1) NULL, " +
    "`employeeId` INT NULL, " +
    "`personName` VARCHAR(200) NULL, " +
    "`personVia` VARCHAR(10) NULL, " +
    "`projectId` INT NULL, " +
    "`transcription` TEXT NULL, " +
    "`transcriptionSource` VARCHAR(10) NULL, " +
    "`transcriptionInaccurate` TINYINT NOT NULL DEFAULT 0, " +
    "`summary` TEXT NULL, " +
    "`positionJson` TEXT NULL, " +
    "`actionsJson` TEXT NULL, " +
    "`mediaKey` VARCHAR(200) NULL, " +
    "`audioKey` VARCHAR(300) NULL, " +
    "`audioUrl` TEXT NULL, " +
    "`audioSavedAt` DATETIME NULL, " +
    "`audioNote` VARCHAR(255) NULL, " +
    "`situation` VARCHAR(200) NOT NULL, " +
    "`reference` VARCHAR(100) NULL, " +
    "`notes` TEXT NULL, " +
    "`contentHash` CHAR(64) NOT NULL, " +
    "`savedById` INT NOT NULL, " +
    "`savedAt` DATETIME NOT NULL, " +
    "`archivedAt` DATETIME NULL, " +
    "`archivedById` INT NULL, " +
    "`archiveReason` VARCHAR(255) NULL, " +
    "PRIMARY KEY (`id`), " +
    "KEY `idx_radio_ev_msg` (`zelloMessageId`), " +
    "KEY `idx_radio_ev_at` (`messageAt`), " +
    "KEY `idx_radio_ev_project` (`projectId`), " +
    "KEY `idx_radio_ev_saved` (`savedAt`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
];

export const IDEMPOTENT_ERROR_CODES_0485 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME", "ER_DUP_FIELDNAME"]);
