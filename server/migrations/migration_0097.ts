// Migration 0097 — WhatsApp: estado + atribuição das conversas, alertas de SLA,
// ligação a reserva/cliente e respostas rápidas (24 set 2026).
//
//  - whatsapp_conversations:
//      `status` aberto/pendente/resolvido (nova mensagem recebida reabre),
//      `assignedUserId` (responsável), `statusChangedAt`, `resolvedAt`,
//      `awaitingSince` (1.ª mensagem recebida ainda sem resposta — SLA),
//      `slaAlertedAt` / `windowAlertedAt` (aviso por cidade enviado 1×),
//      `linkedBookingId` / `linkedClientEmail` (ligação manual a reserva/cliente).
//  - whatsapp_quick_replies: respostas rápidas guardadas (título + texto).
//
// Backfill (corre em cada arranque → tudo guardado por `statusChangedAt IS NULL`,
// que só as linhas anteriores a esta migração têm; o último UPDATE carimba-as):
//   1. conversas paradas há mais de 7 dias → resolvido (senão o badge nascia
//      com centenas de conversas antigas);
//   2. última mensagem recebida (últimos 7 dias) e conversa aberta →
//      `awaitingSince` = `lastInboundAt`;
//   3. `statusChangedAt` = última mensagem (ou criação).
// Nenhum UPDATE lê a própria tabela numa subquery (erro 1093).
//
// Idempotente: ADD COLUMN → ER_DUP_FIELDNAME; ADD INDEX → ER_DUP_KEYNAME;
// CREATE TABLE IF NOT EXISTS (+ ER_TABLE_EXISTS_ERROR por segurança).

export const MIGRATION_0097_NAME = "0097_whatsapp_status_assign_sla_links";

export const MIGRATION_0097_STATEMENTS: string[] = [
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `status` ENUM('aberto','pendente','resolvido') NOT NULL DEFAULT 'aberto'",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `assignedUserId` INT NULL",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `statusChangedAt` TIMESTAMP NULL",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `resolvedAt` TIMESTAMP NULL",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `awaitingSince` TIMESTAMP NULL",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `slaAlertedAt` TIMESTAMP NULL",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `windowAlertedAt` TIMESTAMP NULL",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `linkedBookingId` INT NULL",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `linkedClientEmail` VARCHAR(320) NULL",
  "ALTER TABLE `whatsapp_conversations` ADD INDEX `idx_whatsapp_conversations_status` (`status`, `awaitingSince`)",
  "ALTER TABLE `whatsapp_conversations` ADD INDEX `idx_whatsapp_conversations_assigned` (`assignedUserId`)",

  "CREATE TABLE IF NOT EXISTS `whatsapp_quick_replies` (" +
    "`id` INT AUTO_INCREMENT NOT NULL, " +
    "`title` VARCHAR(80) NOT NULL, " +
    "`body` TEXT NOT NULL, " +
    "`createdById` INT NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`))",

  // Backfill 1: conversas antigas paradas → resolvidas (só linhas pré-0097).
  "UPDATE `whatsapp_conversations` SET `status` = 'resolvido', `resolvedAt` = COALESCE(`lastMessageAt`, `createdAt`) " +
    "WHERE `statusChangedAt` IS NULL AND `status` = 'aberto' " +
    "AND COALESCE(`lastMessageAt`, `createdAt`) < DATE_SUB(NOW(), INTERVAL 7 DAY)",
  // Backfill 2: última mensagem recebida recente e ainda aberta → por responder.
  "UPDATE `whatsapp_conversations` SET `awaitingSince` = `lastInboundAt` " +
    "WHERE `statusChangedAt` IS NULL AND `status` = 'aberto' AND `awaitingSince` IS NULL " +
    "AND `lastDirection` = 'in' AND `lastInboundAt` IS NOT NULL " +
    "AND `lastInboundAt` >= DATE_SUB(NOW(), INTERVAL 7 DAY)",
  // Backfill 3: carimbo — as linhas acima deixam de ser "pré-0097".
  "UPDATE `whatsapp_conversations` SET `statusChangedAt` = COALESCE(`lastMessageAt`, `createdAt`) WHERE `statusChangedAt` IS NULL",
];

export const IDEMPOTENT_ERROR_CODES_0097 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME", "ER_TABLE_EXISTS_ERROR"]);
