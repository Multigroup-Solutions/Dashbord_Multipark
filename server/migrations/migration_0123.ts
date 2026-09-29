// Migration 0123 — IA na comunicação com clientes (24 set 2026)
//
//  - ai_suggestions: sugestões da IA SEPARADAS dos campos preenchidos por
//    pessoas (uma linha por entidade × campo), com confiança, motivo, estado
//    (pending/applied/accepted/rejected) e o valor anterior (para desfazer
//    uma aplicação automática). Usada pela triagem das reclamações.
//  - complaints.aiTriagedAt: triagem já tentada (o varrimento não repete).
//  - google_reviews.aiSentiment / aiDraftAttemptedAt: sentimento da crítica e
//    rascunho automático já tentado (1× por crítica).
//  - whatsapp_conversations.aiIntent / aiUrgency / aiTriagedAt / aiTriageDueAt:
//    etiquetas do inbox e o "debounce" por conversa.
//  - lost_found_matches + lost_found_items.aiMatchCheckedAt: correspondências
//    perdido ↔ achado (filtro determinístico + semelhança da IA).
//
// Idempotente (corre em cada arranque via ensureRecentSchema): CREATE TABLE
// IF NOT EXISTS e ADD COLUMN/INDEX (ER_DUP_* ignorados). Sem UPDATEs.

export const MIGRATION_0123_NAME = "0123_ai_customer_comms";

export const MIGRATION_0123_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `ai_suggestions` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`entityType` VARCHAR(24) NOT NULL, " +
    "`entityId` INT NOT NULL, " +
    "`field` VARCHAR(24) NOT NULL, " +
    "`value` TEXT NULL, " +
    "`confidence` DECIMAL(4,3) NULL, " +
    "`reason` VARCHAR(500) NULL, " +
    "`status` VARCHAR(12) NOT NULL DEFAULT 'pending', " +
    "`previousValue` VARCHAR(255) NULL, " +
    "`decidedById` INT NULL, " +
    "`decidedAt` TIMESTAMP NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_ai_suggestions_entity_field` (`entityType`, `entityId`, `field`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "ALTER TABLE `complaints` ADD COLUMN `aiTriagedAt` TIMESTAMP NULL",
  "ALTER TABLE `google_reviews` ADD COLUMN `aiSentiment` VARCHAR(10) NULL",
  "ALTER TABLE `google_reviews` ADD COLUMN `aiDraftAttemptedAt` TIMESTAMP NULL",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `aiIntent` VARCHAR(24) NULL",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `aiUrgency` VARCHAR(10) NULL",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `aiTriagedAt` TIMESTAMP NULL",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `aiTriageDueAt` TIMESTAMP NULL",
  "ALTER TABLE `whatsapp_conversations` ADD INDEX `idx_whatsapp_conversations_ai_due` (`aiTriageDueAt`)",
  "ALTER TABLE `lost_found_items` ADD COLUMN `aiMatchCheckedAt` TIMESTAMP NULL",
  "CREATE TABLE IF NOT EXISTS `lost_found_matches` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`lostId` INT NOT NULL, " +
    "`foundId` INT NOT NULL, " +
    "`prefilterScore` INT NOT NULL DEFAULT 0, " +
    "`aiScore` INT NULL, " +
    "`reason` VARCHAR(300) NULL, " +
    "`status` VARCHAR(12) NOT NULL DEFAULT 'suggested', " +
    "`decidedById` INT NULL, " +
    "`decidedAt` TIMESTAMP NULL, " +
    "`computedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_lost_found_matches_pair` (`lostId`, `foundId`), " +
    "INDEX `idx_lost_found_matches_found` (`foundId`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
];

export const IDEMPOTENT_ERROR_CODES_0123 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME", "ER_DUP_FIELDNAME"]);
