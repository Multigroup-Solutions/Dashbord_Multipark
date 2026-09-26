// Migration 0205 — BD Multipark como fonte (DATABASE_URL_MULTIPARK, só
// leitura; ver docs/multipark-db/README.md e server/multiparkDb/).
//
// Os movimentos (check-in/check-out/lugar/km com quem e quando) continuam em
// `multipark_booking_history` (já existe e é o que a avaliação e as fichas
// leem) — não há tabela nova para eles. Novas só:
//
//  - multipark_agents: catálogo dos condutores/agentes da app Multipark
//    (hoje só os conhecemos pelo histórico). `agentUserId` = o mesmo id de
//    multipark_booking_history.agentUserId / employees.multiparkAgentUserId /
//    employee_agents.agentUserId. Sem telefone nem outros dados pessoais além
//    de nome e email (o email liga o agente à ficha, como já acontece).
//  - multipark_db_cursors: cursor do sync incremental por fluxo
//    (`bookings`, `movements`, `drivers`, `partners`): última alteração
//    (texto com µs, UTC) + id de desempate, e o estado da última corrida.
//
// Idempotente (corre em cada arranque via ensureRecentSchema): CREATE TABLE
// IF NOT EXISTS; ER_TABLE_EXISTS_ERROR ignorado.

export const MIGRATION_0205_NAME = "0205_multipark_db_source";

export const MIGRATION_0205_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `multipark_agents` (" +
    "`agentUserId` VARCHAR(128) NOT NULL, " +
    "`agentName` VARCHAR(256) NULL, " +
    "`email` VARCHAR(320) NULL, " +
    "`role` VARCHAR(64) NULL, " +
    "`active` TINYINT NOT NULL DEFAULT 1, " +
    "`parkId` VARCHAR(128) NULL, " +
    "`city` VARCHAR(64) NULL, " +
    "`sourceUpdatedAt` DATETIME NULL, " +
    "`syncedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`agentUserId`), " +
    "KEY `idx_multipark_agents_email` (`email`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  "CREATE TABLE IF NOT EXISTS `multipark_db_cursors` (" +
    "`stream` VARCHAR(32) NOT NULL, " +
    "`cursorAt` VARCHAR(40) NULL, " +
    "`cursorId` VARCHAR(128) NULL, " +
    "`lastRunAt` DATETIME NULL, " +
    "`lastOkAt` DATETIME NULL, " +
    "`lastStatus` VARCHAR(16) NULL, " +
    "`lastError` VARCHAR(500) NULL, " +
    "`rowsTotal` BIGINT NOT NULL DEFAULT 0, " +
    "PRIMARY KEY (`stream`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
];

export const IDEMPOTENT_ERROR_CODES_0205 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME"]);
