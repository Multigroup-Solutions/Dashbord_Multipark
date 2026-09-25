// Migration 0150 — Google Tarefas & Calendário (pedido do dono, set 2026)
//
//  - google_sync_state: 1 linha por utilizador com conta Google ligada —
//    preferências (o que sincronizar), lista "Multipark" do Google Tasks e
//    cursor (updatedMin), calendário "Multipark" e syncToken, bloqueio da
//    corrida, "sujo" (sincronizar já depois de uma alteração), erros.
//  - google_task_links: tarefa do dashboard ↔ tarefa do Google Tasks por
//    pessoa (etag, updated da Google, hash da forma acordada) — base do
//    "a última alteração ganha". `state`: active | rejected (criada no
//    Google por quem não pode criar tarefas; não se tenta outra vez).
//  - google_calendar_events: origem (turno, escala da cidade, passagem,
//    formação, prazo, SLA) ↔ evento no calendário de um alvo ("user:<id>"
//    ou "shared:<cidade>"), com versão e hash (atualizações idempotentes).
//  - google_shared_calendars: calendários partilhados "Escala Multipark —
//    <cidade>" (conta de serviço com delegação): id e syncToken.
//  - google_meetings: reuniões com Meet criadas a partir de um cliente,
//    reclamação ou parceria (aparecem nas Comunicações do registo).
//
// Idempotente (corre em cada arranque via ensureRecentSchema): só CREATE
// TABLE IF NOT EXISTS; os códigos de "já existe" são ignorados.

export const MIGRATION_0150_NAME = "0150_google_tasks_calendar";

export const MIGRATION_0150_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `google_sync_state` (" +
    "`userId` INT NOT NULL, " +
    "`prefsJson` TEXT NULL, " +
    "`tasksListId` VARCHAR(255) NULL, " +
    "`tasksUpdatedMin` VARCHAR(40) NULL, " +
    "`calendarId` VARCHAR(255) NULL, " +
    "`calendarSyncToken` VARCHAR(512) NULL, " +
    "`lastTasksSyncAt` TIMESTAMP NULL, " +
    "`lastCalendarSyncAt` TIMESTAMP NULL, " +
    "`lastRunAt` TIMESTAMP NULL, " +
    "`lastStatus` VARCHAR(24) NULL, " +
    "`lastError` VARCHAR(500) NULL, " +
    "`lastWarning` VARCHAR(500) NULL, " +
    "`lockAt` TIMESTAMP NULL, " +
    "`dirtyAt` TIMESTAMP NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`userId`), KEY `idx_google_sync_state_run` (`dirtyAt`, `lastRunAt`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `google_task_links` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`userId` INT NOT NULL, " +
    "`taskId` INT NULL, " +
    "`googleTaskId` VARCHAR(128) NOT NULL, " +
    "`listId` VARCHAR(255) NOT NULL, " +
    "`etag` VARCHAR(255) NULL, " +
    "`googleUpdatedAt` VARCHAR(40) NULL, " +
    "`syncedHash` VARCHAR(32) NULL, " +
    "`state` VARCHAR(12) NOT NULL DEFAULT 'active', " +
    "`lastSyncedAt` TIMESTAMP NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_google_task_links_gtask` (`userId`, `googleTaskId`), " +
    "UNIQUE KEY `uq_google_task_links_task` (`userId`, `taskId`), " +
    "KEY `idx_google_task_links_task` (`taskId`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `google_calendar_events` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`target` VARCHAR(40) NOT NULL, " +
    "`calendarId` VARCHAR(255) NOT NULL, " +
    "`sourceKey` VARCHAR(120) NOT NULL, " +
    "`eventId` VARCHAR(128) NOT NULL, " +
    "`version` VARCHAR(40) NULL, " +
    "`hash` VARCHAR(32) NULL, " +
    "`startMs` BIGINT NULL, " +
    "`remoteDeleted` TINYINT NOT NULL DEFAULT 0, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_google_calendar_events_key` (`target`, `sourceKey`), " +
    "KEY `idx_google_calendar_events_event` (`target`, `eventId`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `google_shared_calendars` (" +
    "`city` VARCHAR(16) NOT NULL, " +
    "`ownerEmail` VARCHAR(320) NOT NULL, " +
    "`calendarId` VARCHAR(255) NULL, " +
    "`syncToken` VARCHAR(512) NULL, " +
    "`aclDomain` VARCHAR(255) NULL, " +
    "`lastSyncAt` TIMESTAMP NULL, " +
    "`lastError` VARCHAR(500) NULL, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`city`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `google_meetings` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`userId` INT NOT NULL, " +
    "`entityType` VARCHAR(16) NOT NULL, " +
    "`entityId` VARCHAR(320) NOT NULL, " +
    "`eventId` VARCHAR(128) NOT NULL, " +
    "`title` VARCHAR(255) NOT NULL, " +
    "`startAt` DATETIME NOT NULL, " +
    "`endAt` DATETIME NOT NULL, " +
    "`meetLink` VARCHAR(500) NULL, " +
    "`htmlLink` VARCHAR(1000) NULL, " +
    "`invitedEmail` VARCHAR(320) NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), KEY `idx_google_meetings_entity` (`entityType`, `entityId`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
];

export const IDEMPOTENT_ERROR_CODES_0150 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME", "ER_DUP_FIELDNAME", "ER_DUP_ENTRY"]);
