// Migration 0094 — WhatsApp: opt-out, escrita segura do webhook, lista barata,
// media privada (24 set 2026).
//
//  - whatsapp_conversations: `optedOutAt` (STOP/PARAR), `profileName` (nome de
//    perfil do webhook), `lastPreview`/`lastDirection`/`lastType` (a lista do
//    inbox deixa de ler todas as mensagens), `bookingProjectId` +
//    `bookingCheckedAt` (cidade de números soltos pelo telefone de uma reserva).
//  - whatsapp_messages: enum `type` ganha image/audio/document/video (as linhas
//    antigas continuam 'text' + mediaType); `mediaAttempts` (retry do download
//    no cron); `phoneNumberId` (metadata do webhook).
//  - extra_leads: `optedOutAt`.
//  - whatsapp_pending_statuses: status que chega antes da linha outbound.
//  - whatsapp_request_answers: "este pedido já foi respondido" (respostas
//    automáticas idempotentes — o link da semana vai no máximo 1×).
//
// Backfill do preview: UPDATE com JOIN a uma tabela DERIVADA de OUTRA tabela
// (whatsapp_messages) — nunca subquery sobre a própria tabela atualizada
// (erro 1093). Só mexe em conversas com `lastDirection` NULL → idempotente.
//
// Idempotente: ADD COLUMN → ER_DUP_FIELDNAME; ADD INDEX → ER_DUP_KEYNAME;
// CREATE TABLE IF NOT EXISTS; MODIFY pode correr N vezes (o enum só cresce, no
// fim — alteração instantânea).

export const MIGRATION_0094_NAME = "0094_whatsapp_fixes";

export const MIGRATION_0094_STATEMENTS: string[] = [
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `optedOutAt` TIMESTAMP NULL",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `profileName` VARCHAR(128) NULL",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `lastPreview` VARCHAR(160) NULL",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `lastDirection` ENUM('in','out') NULL",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `lastType` VARCHAR(16) NULL",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `bookingProjectId` INT NULL",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `bookingCheckedAt` TIMESTAMP NULL",
  "ALTER TABLE `whatsapp_conversations` ADD INDEX `idx_whatsapp_conversations_booking_project` (`bookingProjectId`)",

  "ALTER TABLE `whatsapp_messages` MODIFY COLUMN `type` ENUM('text','template','image','audio','document','video') NOT NULL",
  "ALTER TABLE `whatsapp_messages` ADD COLUMN `mediaAttempts` INT NOT NULL DEFAULT 0",
  "ALTER TABLE `whatsapp_messages` ADD COLUMN `phoneNumberId` VARCHAR(32) NULL",

  "ALTER TABLE `extra_leads` ADD COLUMN `optedOutAt` DATETIME NULL",

  "CREATE TABLE IF NOT EXISTS `whatsapp_pending_statuses` (" +
    "`waMessageId` VARCHAR(128) NOT NULL, " +
    "`status` ENUM('sent','delivered','read','failed') NOT NULL, " +
    "`errorDetail` TEXT NULL, " +
    "`receivedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`waMessageId`))",

  "CREATE TABLE IF NOT EXISTS `whatsapp_request_answers` (" +
    "`requestId` INT NOT NULL, " +
    "`employeeId` INT NOT NULL, " +
    "`action` VARCHAR(16) NOT NULL, " +
    "`answeredAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`requestId`))",

  // Backfill do preview a partir da última mensagem de cada conversa.
  "UPDATE `whatsapp_conversations` c " +
    "JOIN (SELECT m.`conversationId`, m.`body`, m.`direction`, m.`type`, m.`templateName`, m.`mediaType` " +
    "FROM `whatsapp_messages` m " +
    "JOIN (SELECT `conversationId`, MAX(`id`) AS `maxId` FROM `whatsapp_messages` GROUP BY `conversationId`) t " +
    "ON t.`maxId` = m.`id`) x ON x.`conversationId` = c.`id` " +
    "SET c.`lastPreview` = LEFT(CASE " +
    "WHEN x.`body` IS NOT NULL AND TRIM(x.`body`) <> '' THEN TRIM(x.`body`) " +
    "WHEN x.`type` = 'template' AND x.`templateName` IS NOT NULL THEN CONCAT('Mensagem de template “', x.`templateName`, '” (conteúdo não registado)') " +
    "WHEN x.`type` = 'template' THEN 'Mensagem de template (conteúdo não registado)' " +
    "ELSE '' END, 120), " +
    "c.`lastDirection` = x.`direction`, " +
    "c.`lastType` = COALESCE(x.`mediaType`, x.`type`) " +
    "WHERE c.`lastDirection` IS NULL",
];

export const IDEMPOTENT_ERROR_CODES_0094 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME", "ER_TABLE_EXISTS_ERROR"]);
