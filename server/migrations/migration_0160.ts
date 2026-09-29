// Migration 0160 — Google Drive / Docs / Sheets, pedido do dono (set 2026)
//
//  - google_drive_links: ficheiros do Drive ligados a um registo (cliente,
//    reclamação, conversa de email, colaborador/RH, tarefa, parceria) — só a
//    referência (id, nome, tipo, link, dono), nunca o conteúdo. `source` =
//    link | picker | saved (Guardar no Drive) | generated (modelo) | pdf;
//    `location` = user (Drive da pessoa) | shared (Shared Drive da empresa).
//    Remover = `removedAt` (histórico), a mesma ligação pode voltar.
//  - google_drive_folders: cache das pastas criadas pela app (pasta
//    "Multipark" de cada pessoa e o caminho no Shared Drive), por âmbito
//    (`user:<id>` / `shared:<driveId>`) e caminho.
//  - google_drive_mirror: espelho dos documentos do RH e das provas das
//    reclamações no Shared Drive (1 linha por origem; estado + tentativas —
//    o cron retoma de onde parou).
//  - google_doc_templates: modelos Google Docs com {{marcadores}} por tipo
//    (contrato de trabalho, declaração, resposta a reclamação, propostas).
//  - google_drive_state: pequenos valores do Drive (id do Shared Drive
//    resolvido, folha dos relatórios ao vivo, última corrida).
//
// Idempotente (corre em cada arranque via ensureRecentSchema): só CREATE
// TABLE IF NOT EXISTS; os códigos de "já existe" são ignorados.

export const MIGRATION_0160_NAME = "0160_google_drive";

export const MIGRATION_0160_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `google_drive_links` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`entityType` VARCHAR(16) NOT NULL, " +
    "`entityId` VARCHAR(320) NOT NULL, " +
    "`fileId` VARCHAR(200) NOT NULL, " +
    "`name` VARCHAR(255) NOT NULL, " +
    "`mimeType` VARCHAR(160) NULL, " +
    "`webViewLink` VARCHAR(1000) NULL, " +
    "`iconLink` VARCHAR(1000) NULL, " +
    "`ownerEmail` VARCHAR(320) NULL, " +
    "`ownerName` VARCHAR(255) NULL, " +
    "`source` VARCHAR(12) NOT NULL DEFAULT 'link', " +
    "`location` VARCHAR(8) NOT NULL DEFAULT 'user', " +
    "`templateId` INT NULL, " +
    "`createdById` INT NULL, " +
    "`removedAt` TIMESTAMP NULL, " +
    "`removedById` INT NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_google_drive_links_entity_file` (`entityType`, `entityId`, `fileId`), " +
    "KEY `idx_google_drive_links_entity` (`entityType`, `entityId`, `removedAt`), " +
    "KEY `idx_google_drive_links_file` (`fileId`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `google_drive_folders` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`scopeKey` VARCHAR(64) NOT NULL, " +
    "`pathKey` VARCHAR(500) NOT NULL, " +
    "`folderId` VARCHAR(200) NOT NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_google_drive_folders_path` (`scopeKey`, `pathKey`(255))" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `google_drive_mirror` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`sourceType` VARCHAR(24) NOT NULL, " +
    "`sourceId` INT NOT NULL, " +
    "`fileId` VARCHAR(200) NULL, " +
    "`status` VARCHAR(12) NOT NULL DEFAULT 'pending', " +
    "`attempts` INT NOT NULL DEFAULT 0, " +
    "`lastError` VARCHAR(500) NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_google_drive_mirror_source` (`sourceType`, `sourceId`), " +
    "KEY `idx_google_drive_mirror_status` (`status`, `updatedAt`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `google_doc_templates` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`name` VARCHAR(160) NOT NULL, " +
    "`templateType` VARCHAR(32) NOT NULL, " +
    "`fileId` VARCHAR(200) NOT NULL, " +
    "`fileName` VARCHAR(255) NULL, " +
    "`description` VARCHAR(500) NULL, " +
    "`placeholdersJson` VARCHAR(2000) NULL, " +
    "`active` TINYINT NOT NULL DEFAULT 1, " +
    "`createdById` INT NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "KEY `idx_google_doc_templates_type` (`templateType`, `active`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `google_drive_state` (" +
    "`stateKey` VARCHAR(64) NOT NULL, " +
    "`value` VARCHAR(1000) NULL, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`stateKey`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
];

export const IDEMPOTENT_ERROR_CODES_0160 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME", "ER_DUP_FIELDNAME", "ER_DUP_ENTRY"]);
