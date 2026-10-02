// Migration 0340 — Reclamações: nada se apaga (P3 lote 16b, out 2026).
//  1. "Eliminar" uma reclamação passa a ARQUIVAR: `archivedAt`, `archivedById`
//     e `archiveReason`. A reclamação, as mensagens e as fotos ficam; sai das
//     listas, dos contadores, dos lembretes e da avaliação.
//  2. `removed_records`: o que se tira de um caso (uma foto, um condutor
//     associado) fica aqui com a linha inteira, quem, quando e porquê — antes
//     era apagado de vez. Serve também os Perdidos e Achados (16c).
// Idempotente: ADD COLUMN/ADD KEY/CREATE TABLE ignoram o que já existe.
export const MIGRATION_0340_NAME = "0340_complaints_archive_removed_records";

export const MIGRATION_0340_STATEMENTS: string[] = [
  "ALTER TABLE `complaints` ADD COLUMN `archivedAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `complaints` ADD COLUMN `archivedById` INT NULL",
  "ALTER TABLE `complaints` ADD COLUMN `archiveReason` VARCHAR(255) NULL",
  "ALTER TABLE `complaints` ADD KEY `idx_complaints_archived` (`archivedAt`)",
  "CREATE TABLE IF NOT EXISTS `removed_records` ("
    + " `id` INT NOT NULL AUTO_INCREMENT,"
    + " `entity` VARCHAR(48) NOT NULL,"
    + " `recordId` INT NOT NULL,"
    + " `parentId` INT NULL,"
    + " `rowJson` MEDIUMTEXT NOT NULL,"
    + " `reason` VARCHAR(255) NULL,"
    + " `removedById` INT NULL,"
    + " `removedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,"
    + " PRIMARY KEY (`id`),"
    + " KEY `idx_removed_records_parent` (`entity`, `parentId`)"
    + ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
];

export const IDEMPOTENT_ERROR_CODES_0340 = new Set<string>(["ER_DUP_FIELDNAME", "ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME"]);
