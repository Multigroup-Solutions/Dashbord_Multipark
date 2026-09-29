// Migration 0200 — Google por eventos em vez de sondagem (decisão do Jorge,
// 26 set 2026; shared/googlePush.ts):
//
//  - google_watch_channels: um canal de notificação da Google por âmbito
//    vigiado — Calendário pessoal "Multipark" (`user:<id>`), calendário
//    partilhado da escala (`shared:<cidade>`) e Shared Drive da base de
//    conhecimento (`drive:kb`). `id` = X-Goog-Channel-ID (uuid nosso);
//    `resourceId` = X-Goog-Resource-ID devolvido pela Google; `resourceKey` =
//    o que foi vigiado (id do calendário / do Shared Drive); `tokenHash` =
//    SHA-256 do segredo do canal (X-Goog-Channel-Token — o segredo em claro
//    nunca é guardado); `expiration` (≤ 7 dias; renovação diária pelo
//    google-watch-renew); `lastMessageNumber` / `lastNotifiedAt` /
//    `notifications` para ignorar reenvios e mostrar o estado nas Definições.
//  - google_sync_pending: fila "sincronizar já" por âmbito (`user:<id>`,
//    `user-cal:<id>`, `shared:<cidade>`, `drive:kb`, `drive:mirror`).
//    `version` sobe a cada marcação — a corrida só apaga a linha se ninguém a
//    marcou entretanto (senão corre outra vez); `runningUntil` é o lease;
//    `attempts`/`nextAttemptAt` a espera depois de uma falha.
//  - google_sync_state.lastOnlineSyncAt: última sincronização "enquanto o
//    dashboard está aberto" (heartbeat; limite de 1 por pessoa a cada ~5 min).
//
// Idempotente (corre em cada arranque via ensureRecentSchema): CREATE TABLE IF
// NOT EXISTS; ADD COLUMN já existente → ER_DUP_FIELDNAME ignorado.

export const MIGRATION_0200_NAME = "0200_google_push_channels";

export const MIGRATION_0200_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `google_watch_channels` (" +
    "`id` VARCHAR(64) NOT NULL, " +
    "`kind` VARCHAR(16) NOT NULL, " +
    "`scopeKey` VARCHAR(128) NOT NULL, " +
    "`resourceKey` VARCHAR(255) NULL, " +
    "`userId` INT NULL, " +
    "`resourceId` VARCHAR(255) NULL, " +
    "`tokenHash` CHAR(64) NOT NULL, " +
    "`expiration` DATETIME NULL, " +
    "`lastMessageNumber` BIGINT NULL, " +
    "`lastNotifiedAt` DATETIME NULL, " +
    "`notifications` INT NOT NULL DEFAULT 0, " +
    "`lastError` VARCHAR(500) NULL, " +
    "`createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "KEY `idx_google_watch_scope` (`scopeKey`), " +
    "KEY `idx_google_watch_exp` (`expiration`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  "CREATE TABLE IF NOT EXISTS `google_sync_pending` (" +
    "`scopeKey` VARCHAR(128) NOT NULL, " +
    "`reason` VARCHAR(32) NULL, " +
    "`version` INT NOT NULL DEFAULT 1, " +
    "`dirtyAt` DATETIME NOT NULL, " +
    "`runningUntil` DATETIME NULL, " +
    "`attempts` INT NOT NULL DEFAULT 0, " +
    "`nextAttemptAt` DATETIME NULL, " +
    "`lastError` VARCHAR(500) NULL, " +
    "`createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`scopeKey`), " +
    "KEY `idx_google_sync_pending_due` (`nextAttemptAt`, `dirtyAt`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  "ALTER TABLE `google_sync_state` ADD COLUMN `lastOnlineSyncAt` DATETIME NULL",
];

export const IDEMPOTENT_ERROR_CODES_0200 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_FIELDNAME"]);
