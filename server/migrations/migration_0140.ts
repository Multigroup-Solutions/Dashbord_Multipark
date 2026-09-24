// Migration 0140 — Roteamento das notificações (24 set 2026)
//
//  - app_notifications.cityKey: cidade da notificação (lisbon/porto/faro) —
//    o sino mostra-a; NULL = sem cidade (sistema, pessoais).
//  - app_notifications.entityKey: registo a que se refere ("complaint:12") —
//    deduplicação (1 por pessoa × tipo × registo dentro de uma janela curta).
//  - índice (userId, kind, entityKey, createdAt) para essa verificação.
//  - complaints.slaAlertedAt: aviso "fora do prazo" enviado (1× por reclamação).
//  - LIMPEZA ÚNICA: as notificações por ler com mais de 14 dias passam a
//    lidas (o sino deixa de estar inundado com os avisos antigos, que iam a
//    toda a gente). Corre UMA vez: fica marcada em
//    app_notification_maintenance ('0140_mark_old_read') e o UPDATE só corre
//    enquanto essa marca não existir.
//
// Idempotente (corre em cada arranque via ensureRecentSchema): ADD COLUMN/
// INDEX (erros "já existe" ignorados), CREATE TABLE IF NOT EXISTS, UPDATE
// guardado pela marca e INSERT IGNORE da marca.

export const MIGRATION_0140_NAME = "0140_notification_routing";

export const CLEANUP_0140_ID = "0140_mark_old_read";

export const MIGRATION_0140_STATEMENTS: string[] = [
  "ALTER TABLE `app_notifications` ADD COLUMN `cityKey` VARCHAR(16) NULL",
  "ALTER TABLE `app_notifications` ADD COLUMN `entityKey` VARCHAR(96) NULL",
  "ALTER TABLE `app_notifications` ADD INDEX `idx_app_notifications_dedupe` (`userId`, `kind`, `entityKey`, `createdAt`)",
  "ALTER TABLE `complaints` ADD COLUMN `slaAlertedAt` TIMESTAMP NULL",
  "CREATE TABLE IF NOT EXISTS `app_notification_maintenance` (" +
    "`id` VARCHAR(64) NOT NULL, " +
    "`ranAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "UPDATE `app_notifications` SET `isRead` = 1 " +
    "WHERE `isRead` = 0 AND `createdAt` < DATE_SUB(NOW(), INTERVAL 14 DAY) " +
    "AND NOT EXISTS (SELECT 1 FROM `app_notification_maintenance` m WHERE m.`id` = '" + CLEANUP_0140_ID + "')",
  "INSERT IGNORE INTO `app_notification_maintenance` (`id`) VALUES ('" + CLEANUP_0140_ID + "')",
];

export const IDEMPOTENT_ERROR_CODES_0140 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME", "ER_DUP_FIELDNAME"]);
