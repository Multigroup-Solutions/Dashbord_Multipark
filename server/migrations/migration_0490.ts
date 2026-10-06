// Migration 0490 — Central Vodafone pela consola (lote 39a, Jorge 6 out 2026:
// "avança com o Sugar"). A consola One Net Attendant Console só regista
// chamadas num CRM conhecido; a dashboard faz de "Sugar CRM":
//  - central_accounts: um acesso por pessoa do escritório (o segredo só se
//    guarda em hash; revoga-se, nunca se apaga);
//  - central_calls: cada chamada que a consola registou, de quem foi;
//  - central_requests: o que a consola pediu (sem segredos), para ver o que
//    ela manda e afinar a porta.
// Só acrescenta. Idempotente.
export const MIGRATION_0490_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `central_accounts` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`username` VARCHAR(100) NOT NULL, " +
    "`secretHash` CHAR(64) NOT NULL, " +
    "`userId` INT NOT NULL, " +
    "`label` VARCHAR(200) NULL, " +
    "`createdById` INT NOT NULL, " +
    "`createdAt` DATETIME NOT NULL, " +
    "`lastUsedAt` DATETIME NULL, " +
    "`revokedAt` DATETIME NULL, " +
    "`revokedById` INT NULL, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_central_acc_username` (`username`), " +
    "KEY `idx_central_acc_user` (`userId`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS `central_calls` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`externalId` CHAR(36) NOT NULL, " +
    "`accountId` INT NOT NULL, " +
    "`userId` INT NOT NULL, " +
    "`direction` VARCHAR(8) NOT NULL, " +
    "`held` TINYINT NOT NULL DEFAULT 1, " +
    "`startedAt` DATETIME NOT NULL, " +
    "`durationS` INT NULL, " +
    "`phone` VARCHAR(32) NULL, " +
    "`subject` VARCHAR(255) NULL, " +
    "`description` TEXT NULL, " +
    "`source` VARCHAR(16) NOT NULL, " +
    "`rawJson` TEXT NULL, " +
    "`createdAt` DATETIME NOT NULL, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_central_calls_ext` (`externalId`), " +
    "KEY `idx_central_calls_user_at` (`userId`, `startedAt`), " +
    "KEY `idx_central_calls_at` (`startedAt`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS `central_requests` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`at` DATETIME NOT NULL, " +
    "`method` VARCHAR(8) NOT NULL, " +
    "`path` VARCHAR(255) NOT NULL, " +
    "`status` INT NOT NULL, " +
    "`accountId` INT NULL, " +
    "`note` VARCHAR(255) NULL, " +
    "`bodyJson` TEXT NULL, " +
    "PRIMARY KEY (`id`), " +
    "KEY `idx_central_req_at` (`at`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
];

export const IDEMPOTENT_ERROR_CODES_0490 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME", "ER_DUP_FIELDNAME"]);
