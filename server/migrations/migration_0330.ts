// Migration 0330 — subscrições de notificações push do browser (Web Push +
// VAPID), para avisar de uma chamada do WhatsApp a tocar mesmo com o separador
// do dashboard em segundo plano (set 2026).
//
//  - uma linha por browser/dispositivo; `endpoint` é o URL do serviço de push
//    do browser, único (pelo hash SHA-256 `endpointHash`, porque o URL pode
//    passar dos 500 caracteres);
//  - `userId` = quem ativou; a mesma subscrição a mudar de pessoa (outro login
//    no mesmo browser) passa a ser da nova pessoa;
//  - linhas apagadas quando o serviço de push responde 404/410 ou quando a
//    pessoa desativa / sai da conta nesse browser.
//
// Idempotente (corre em cada arranque via ensureRecentSchema): CREATE TABLE IF
// NOT EXISTS; nada mais.

export const MIGRATION_0330_NAME = "0330_web_push_subscriptions";

export const MIGRATION_0330_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `web_push_subscriptions` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`userId` INT NOT NULL, " +
    "`endpointHash` CHAR(64) NOT NULL, " +
    "`endpoint` TEXT NOT NULL, " +
    "`p256dh` VARCHAR(255) NOT NULL, " +
    "`auth` VARCHAR(64) NOT NULL, " +
    "`userAgent` VARCHAR(255) NULL, " +
    "`lastSuccessAt` DATETIME NULL, " +
    "`lastFailureAt` DATETIME NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_web_push_endpoint` (`endpointHash`), " +
    "KEY `idx_web_push_user` (`userId`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
];

export const IDEMPOTENT_ERROR_CODES_0330 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME"]);
