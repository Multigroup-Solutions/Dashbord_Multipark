// Migration 0345 — Perdidos e Achados: nada se apaga (P3 lote 16c, out 2026).
// "Eliminar" um caso apagava o caso, as mensagens, os condutores e os FICHEIROS
// no storage. Passa a ARQUIVAR: `archivedAt`, `archivedById`, `archiveReason`.
// O caso sai das listas, contadores, lembretes, passagem de turno e cruzamento;
// volta com "Tirar do arquivo". Os condutores tirados de um caso vão para
// `removed_records` (criada na 0340).
// Idempotente: ADD COLUMN/ADD KEY ignoram o que já existe.
export const MIGRATION_0345_NAME = "0345_lost_found_archive";

export const MIGRATION_0345_STATEMENTS: string[] = [
  "ALTER TABLE `lost_found_items` ADD COLUMN `archivedAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `lost_found_items` ADD COLUMN `archivedById` INT NULL",
  "ALTER TABLE `lost_found_items` ADD COLUMN `archiveReason` VARCHAR(255) NULL",
  "ALTER TABLE `lost_found_items` ADD KEY `idx_lost_found_archived` (`archivedAt`)",
];

export const IDEMPOTENT_ERROR_CODES_0345 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
