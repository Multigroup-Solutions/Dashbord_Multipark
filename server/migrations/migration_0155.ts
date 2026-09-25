// Migration 0155 — Contactos (Google People API), pedido do dono (set 2026)
//
//  - google_directory_people: cache do diretório do domínio do Workspace
//    (perfis DOMAIN_PROFILE lidos pela conta de serviço com delegação):
//    nome, email(s), cargo, departamento, telefone, foto; ligado à conta
//    (users) e à ficha (employees) pelo email. `seenRunAt` = corrida em que
//    apareceu (os que não aparecem numa corrida completa ficam `deletedAt`).
//  - google_directory_state: 1 linha (id = 1) com o cursor (pageToken) da
//    corrida em curso, início da corrida e a última completa.
//  - google_contacts_state: 1 linha por utilizador com a funcionalidade
//    "Contactos": preferências, syncTokens/pageTokens (Outros contactos e
//    ligações), grupos criados pela app, bloqueio, estado da última corrida.
//  - google_user_contacts: contactos Google da própria pessoa (só nome,
//    emails e telefones normalizados — para sugerir ligações e "criar
//    cliente/lead"); só a própria pessoa os vê; apagados ao desligar.
//  - google_pushed_contacts: contactos que a APP criou no Google da pessoa
//    (grupo "Multipark — Serviço" / "Parceiros e fornecedores"), com a
//    retenção (`expiresAt`) — a limpeza só toca nestes.
//  - crm_contacts: contactos do CRM criados à mão ou a partir de um contacto
//    Google (cliente ou lead comercial) — os clientes com reservas continuam
//    a vir das reservas (server/clientsCrm.ts).
//
// Idempotente (corre em cada arranque via ensureRecentSchema): só CREATE
// TABLE IF NOT EXISTS; os códigos de "já existe" são ignorados.

export const MIGRATION_0155_NAME = "0155_google_contacts";

export const MIGRATION_0155_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `google_directory_people` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`resourceName` VARCHAR(128) NOT NULL, " +
    "`primaryEmail` VARCHAR(320) NOT NULL, " +
    "`emailsJson` VARCHAR(2000) NULL, " +
    "`displayName` VARCHAR(255) NOT NULL, " +
    "`givenName` VARCHAR(128) NULL, " +
    "`familyName` VARCHAR(128) NULL, " +
    "`jobTitle` VARCHAR(255) NULL, " +
    "`department` VARCHAR(255) NULL, " +
    "`phoneE164` VARCHAR(20) NULL, " +
    "`phoneRaw` VARCHAR(64) NULL, " +
    "`photoUrl` VARCHAR(1000) NULL, " +
    "`userId` INT NULL, " +
    "`employeeId` INT NULL, " +
    "`seenRunAt` BIGINT NULL, " +
    "`deletedAt` TIMESTAMP NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_google_directory_people_resource` (`resourceName`), " +
    "KEY `idx_google_directory_people_email` (`primaryEmail`), " +
    "KEY `idx_google_directory_people_user` (`userId`), " +
    "KEY `idx_google_directory_people_employee` (`employeeId`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `google_directory_state` (" +
    "`id` TINYINT NOT NULL, " +
    "`pageToken` VARCHAR(1024) NULL, " +
    "`runStartedMs` BIGINT NULL, " +
    "`lastFullSyncAt` TIMESTAMP NULL, " +
    "`lastRunAt` TIMESTAMP NULL, " +
    "`lastError` VARCHAR(500) NULL, " +
    "`peopleCount` INT NOT NULL DEFAULT 0, " +
    "`lockAt` TIMESTAMP NULL, " +
    "PRIMARY KEY (`id`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `google_contacts_state` (" +
    "`userId` INT NOT NULL, " +
    "`prefsJson` TEXT NULL, " +
    "`otherSyncToken` VARCHAR(1024) NULL, " +
    "`otherPageToken` VARCHAR(1024) NULL, " +
    "`connSyncToken` VARCHAR(1024) NULL, " +
    "`connPageToken` VARCHAR(1024) NULL, " +
    "`serviceGroup` VARCHAR(128) NULL, " +
    "`partnersGroup` VARCHAR(128) NULL, " +
    "`lastPullAt` TIMESTAMP NULL, " +
    "`lastPushAt` TIMESTAMP NULL, " +
    "`lastRunAt` TIMESTAMP NULL, " +
    "`lastStatus` VARCHAR(24) NULL, " +
    "`lastError` VARCHAR(500) NULL, " +
    "`lastWarning` VARCHAR(500) NULL, " +
    "`lockAt` TIMESTAMP NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`userId`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `google_user_contacts` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`userId` INT NOT NULL, " +
    "`resourceName` VARCHAR(128) NOT NULL, " +
    "`source` VARCHAR(12) NOT NULL, " +
    "`displayName` VARCHAR(255) NULL, " +
    "`emailsJson` VARCHAR(2000) NULL, " +
    "`phonesJson` VARCHAR(500) NULL, " +
    "`primaryEmail` VARCHAR(320) NULL, " +
    "`primaryPhone` VARCHAR(20) NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_google_user_contacts_res` (`userId`, `resourceName`), " +
    "KEY `idx_google_user_contacts_email` (`userId`, `primaryEmail`), " +
    "KEY `idx_google_user_contacts_phone` (`userId`, `primaryPhone`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `google_pushed_contacts` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`userId` INT NOT NULL, " +
    "`groupKey` VARCHAR(12) NOT NULL, " +
    "`sourceKey` VARCHAR(64) NOT NULL, " +
    "`resourceName` VARCHAR(128) NOT NULL, " +
    "`hash` VARCHAR(32) NULL, " +
    "`expiresAt` BIGINT NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_google_pushed_contacts_key` (`userId`, `groupKey`, `sourceKey`), " +
    "KEY `idx_google_pushed_contacts_res` (`userId`, `resourceName`), " +
    "KEY `idx_google_pushed_contacts_exp` (`expiresAt`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `crm_contacts` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`kind` VARCHAR(12) NOT NULL DEFAULT 'client', " +
    "`name` VARCHAR(255) NOT NULL, " +
    "`email` VARCHAR(320) NULL, " +
    "`phone` VARCHAR(32) NULL, " +
    "`phoneE164` VARCHAR(20) NULL, " +
    "`company` VARCHAR(255) NULL, " +
    "`notes` VARCHAR(1000) NULL, " +
    "`projectId` INT NULL, " +
    "`source` VARCHAR(16) NOT NULL DEFAULT 'manual', " +
    "`googleResourceName` VARCHAR(128) NULL, " +
    "`createdById` INT NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "KEY `idx_crm_contacts_email` (`email`), " +
    "KEY `idx_crm_contacts_phone` (`phoneE164`), " +
    "KEY `idx_crm_contacts_project` (`projectId`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
];

export const IDEMPOTENT_ERROR_CODES_0155 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME", "ER_DUP_FIELDNAME", "ER_DUP_ENTRY"]);
