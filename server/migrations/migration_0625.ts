// Migration 0625 — Terminal pelo perfil (plano 56, parte B; Jorge, 12 out 2026).
//
//  - `terminal_sessions`: uma linha por estadia no terminal (quem, cidade,
//    desde quando, como abriu, como fechou, até onde contam as horas).
//    "Nunca duas pessoas no terminal da mesma cidade" e "cada pessoa só num
//    terminal" são da BD: `activeCityKey` e `activeEmployeeId` só estão
//    preenchidos enquanto a sessão está aberta e são UNIQUE (o MySQL deixa
//    vários NULL). Fechar = pôr os dois a NULL; nada se apaga.
//    Colunas do B2 já aqui (GPS de 5 em 5 min, "Ainda estás no terminal?",
//    horas que contam): lastInsideAt, outsideSince, outsideCount, askedAt,
//    stillHereAt, countedUntil, countedBasis.
//    `payUplift` = 1 só para extras (nível +1 no pagamento).
//  - `terminal_handover_requests`: "Pedir ao João para passar" — pendente até
//    o João responder (Passar / Ainda estou) ou caducar.
//
// Só acrescenta; sem dados. Idempotente (CREATE TABLE IF NOT EXISTS).

export const MIGRATION_0625_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `terminal_sessions` (" +
    "`id` INT AUTO_INCREMENT NOT NULL, " +
    "`employeeId` INT NOT NULL, " +
    "`userId` INT NULL, " +
    "`cityKey` VARCHAR(8) NOT NULL, " +
    "`startedAt` DATETIME NOT NULL, " +
    "`startLat` DECIMAL(10,7) NULL, " +
    "`startLng` DECIMAL(10,7) NULL, " +
    "`startAccuracy` INT NULL, " +
    "`startSource` ENUM('button','checkin','handover','tl','takeover','reopen') NOT NULL, " +
    "`startedByUserId` INT NULL, " +
    "`endedAt` DATETIME NULL, " +
    "`endReason` ENUM('button','handover','tl','checkout','no_answer','stale_checkout') NULL, " +
    "`endedByUserId` INT NULL, " +
    "`endLat` DECIMAL(10,7) NULL, " +
    "`endLng` DECIMAL(10,7) NULL, " +
    "`endNote` VARCHAR(255) NULL, " +
    "`lastInsideAt` DATETIME NULL, " +
    "`outsideSince` DATETIME NULL, " +
    "`outsideCount` INT NOT NULL DEFAULT 0, " +
    "`askedAt` DATETIME NULL, " +
    "`stillHereAt` DATETIME NULL, " +
    "`countedUntil` DATETIME NULL, " +
    "`countedBasis` ENUM('gps_close','last_gps','last_service','confirmed','pending','rejected') NULL, " +
    "`payUplift` TINYINT NOT NULL DEFAULT 0, " +
    "`note` VARCHAR(255) NULL, " +
    "`timeRecordId` INT NULL, " +
    "`activeCityKey` VARCHAR(8) NULL, " +
    "`activeEmployeeId` INT NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_terminal_sessions_active_city` (`activeCityKey`), " +
    "UNIQUE KEY `uq_terminal_sessions_active_employee` (`activeEmployeeId`), " +
    "KEY `idx_terminal_sessions_employee` (`employeeId`, `startedAt`), " +
    "KEY `idx_terminal_sessions_city` (`cityKey`, `startedAt`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  "CREATE TABLE IF NOT EXISTS `terminal_handover_requests` (" +
    "`id` INT AUTO_INCREMENT NOT NULL, " +
    "`sessionId` INT NOT NULL, " +
    "`cityKey` VARCHAR(8) NOT NULL, " +
    "`holderEmployeeId` INT NOT NULL, " +
    "`requesterEmployeeId` INT NOT NULL, " +
    "`requesterUserId` INT NULL, " +
    "`requestedAt` DATETIME NOT NULL, " +
    "`reqLat` DECIMAL(10,7) NULL, " +
    "`reqLng` DECIMAL(10,7) NULL, " +
    "`reqAccuracy` INT NULL, " +
    "`status` ENUM('pending','passed','declined','expired','cancelled') NOT NULL DEFAULT 'pending', " +
    "`answeredAt` DATETIME NULL, " +
    "`answeredByUserId` INT NULL, " +
    "`newSessionId` INT NULL, " +
    "`note` VARCHAR(255) NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "KEY `idx_terminal_handover_session` (`sessionId`, `status`), " +
    "KEY `idx_terminal_handover_requester` (`requesterEmployeeId`, `requestedAt`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
];

export const IDEMPOTENT_ERROR_CODES_0625 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME"]);
