// Migration 0175 — Pesquisa global (Ctrl+K) e Base de conhecimento (pedido do
// dono, set 2026 — "tudo dentro do dashboard"):
//
//  - kb_documents: um documento da base de conhecimento (pasta do Shared
//    Drive, ficheiro carregado na app ou ajuda da app) — título, origem,
//    ligação, estado da sincronização (sincronizado/erro), checksum do texto
//    extraído (sincronização incremental), modifiedTime/md5 do Drive, texto
//    extraído (pré-visualização) e visibilidade (papéis/cidades em JSON; vazio
//    = todos).
//  - kb_chunks: trechos (~800–1200 tokens com sobreposição) com a secção e o
//    vetor (embeddings em base64 Float32, opcional). FULLTEXT em (section,
//    text) para a pré-seleção barata dos candidatos; sem FULLTEXT (ex.: base de
//    dados sem suporte) a recuperação cai para LIKE.
//  - kb_sync_state: cursores da sincronização retomável (pastas × página).
//  - quiz_questions.sourceKbDocId: perguntas geradas a partir de um documento
//    da base de conhecimento (rascunhos, revistos pelo admin antes de publicar).
//  - Índices para a pesquisa global nas reservas (nº, matrícula, email e
//    nome/apelido — pesquisas por prefixo, com LIMIT).
//
// Idempotente (corre em cada arranque via ensureRecentSchema): CREATE TABLE IF
// NOT EXISTS, ADD COLUMN/INDEX (já existente → ER_DUP_FIELDNAME/ER_DUP_KEYNAME
// ignorado).

export const MIGRATION_0175_NAME = "0175_global_search_knowledge_base";

export const MIGRATION_0175_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `kb_documents` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`source` VARCHAR(12) NOT NULL, " +
    "`driveFileId` VARCHAR(128) NULL, " +
    "`folderPath` VARCHAR(300) NULL, " +
    "`title` VARCHAR(300) NOT NULL, " +
    "`mimeType` VARCHAR(160) NULL, " +
    "`webViewLink` VARCHAR(600) NULL, " +
    "`fileKey` VARCHAR(512) NULL, " +
    "`fileUrl` TEXT NULL, " +
    "`sizeBytes` INT NULL, " +
    "`modifiedTime` VARCHAR(40) NULL, " +
    "`md5` VARCHAR(64) NULL, " +
    "`checksum` CHAR(64) NULL, " +
    "`status` VARCHAR(12) NOT NULL DEFAULT 'pending', " +
    "`error` VARCHAR(500) NULL, " +
    "`attempts` INT NOT NULL DEFAULT 0, " +
    "`visibilityRoles` VARCHAR(400) NULL, " +
    "`visibilityCities` VARCHAR(200) NULL, " +
    "`visibilityCustom` TINYINT NOT NULL DEFAULT 0, " +
    "`chunkCount` INT NOT NULL DEFAULT 0, " +
    "`charCount` INT NOT NULL DEFAULT 0, " +
    "`embedded` TINYINT NOT NULL DEFAULT 0, " +
    "`embedModel` VARCHAR(80) NULL, " +
    "`textContent` MEDIUMTEXT NULL, " +
    "`createdById` INT NULL, " +
    "`syncedAt` DATETIME NULL, " +
    "`seenAt` DATETIME NULL, " +
    "`deletedAt` DATETIME NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_kb_documents_drive` (`driveFileId`), " +
    "KEY `idx_kb_documents_status` (`status`, `updatedAt`), " +
    "KEY `idx_kb_documents_title` (`title`(191))" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `kb_chunks` (" +
    "`id` BIGINT NOT NULL AUTO_INCREMENT, " +
    "`docId` INT NOT NULL, " +
    "`ord` INT NOT NULL, " +
    "`section` VARCHAR(300) NULL, " +
    "`text` TEXT NOT NULL, " +
    "`tokens` INT NOT NULL DEFAULT 0, " +
    "`embedding` MEDIUMTEXT NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "KEY `idx_kb_chunks_doc` (`docId`, `ord`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "ALTER TABLE `kb_chunks` ADD FULLTEXT INDEX `ft_kb_chunks` (`section`, `text`)",

  "CREATE TABLE IF NOT EXISTS `kb_sync_state` (" +
    "`stateKey` VARCHAR(64) NOT NULL, " +
    "`value` TEXT NULL, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`stateKey`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "ALTER TABLE `quiz_questions` ADD COLUMN `sourceKbDocId` INT NULL",

  "ALTER TABLE `multipark_bookings` ADD INDEX `idx_mb_booking_number` (`bookingNumber`)",
  "ALTER TABLE `multipark_bookings` ADD INDEX `idx_mb_license_plate` (`licensePlate`)",
  "ALTER TABLE `multipark_bookings` ADD INDEX `idx_mb_client_email` (`clientEmail`(191))",
  "ALTER TABLE `multipark_bookings` ADD INDEX `idx_mb_client_last_name` (`clientLastName`)",
  "ALTER TABLE `multipark_bookings` ADD INDEX `idx_mb_client_first_name` (`clientFirstName`)",
];

export const IDEMPOTENT_ERROR_CODES_0175 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME", "ER_DUP_FIELDNAME", "ER_DUP_ENTRY"]);
