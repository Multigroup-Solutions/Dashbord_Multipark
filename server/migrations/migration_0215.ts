// Migration 0215 — CRM de clientes, fase 1 (Jorge, 27 set 2026).
// Desenho: docs/crm/desenho-crm.md (documento revisto com o Jorge) e
// docs/crm/plano-crm.md. A ficha do cliente vive na NOSSA BD.
//
//  - crm_clients: a ficha (pessoa ou empresa). `id` = o nosso número de
//    cliente, o que está certo (os ids de cliente da Multipark têm fichas
//    repetidas e ficam só em crm_client_external_ids). Métricas em cache,
//    recalculadas pela carga (server/crm/sync.ts).
//  - crm_client_emails / _phones / _vehicles: vários por cliente. Um email
//    pode existir em mais de uma ficha (família que partilha o email) — as
//    sugestões de fusão tratam disso; `generic` marca emails de balcão ou de
//    agregador, que não servem para ligar pessoas.
//  - crm_client_external_ids: ids nas outras bases (Multipark, Firebase…).
//  - crm_booking_links: reserva → cliente (quem viajou e, nos Pro, quem paga).
//  - crm_client_relations: pessoa ↔ empresa, familiar… (nunca se juntam).
//  - crm_merge_suggestions / crm_merge_events: "quer juntar?" e o retrato de
//    cada fusão, para se poder SEPARAR.
//  - crm_saved_filters: filtros guardados (privados ou partilhados).
//
// Divisão geográfica (Jorge): por cidade, região e país dos PARQUES onde o
// cliente reservou (filtros por EXISTS nas reservas; tabela de cidades em
// shared/crmGeo.ts) e `country` = país do cliente (indicativo do telefone).
// `parksJson` = parques usados e n.º de reservas em cada um.
//
// Idempotente (corre em cada arranque via ensureRecentSchema).

export const MIGRATION_0215_NAME = "0215_crm_clients";

const T = " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

export const MIGRATION_0215_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `crm_clients` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`kind` VARCHAR(16) NOT NULL DEFAULT 'person', " +
    "`status` VARCHAR(16) NOT NULL DEFAULT 'active', " +
    "`mergedInto` INT NULL, " +
    "`displayName` VARCHAR(255) NULL, " +
    "`firstName` VARCHAR(128) NULL, " +
    "`lastName` VARCHAR(128) NULL, " +
    "`photoUrl` VARCHAR(1024) NULL, " +
    "`primaryEmail` VARCHAR(320) NULL, " +
    "`primaryPhone` VARCHAR(32) NULL, " +
    "`nif` VARCHAR(16) NULL, " +
    "`taxName` VARCHAR(255) NULL, " +
    "`taxAddress` VARCHAR(500) NULL, " +
    "`address` VARCHAR(500) NULL, " +
    "`zone` VARCHAR(128) NULL, " +
    "`gender` VARCHAR(16) NULL, " +
    "`ageBand` VARCHAR(16) NULL, " +
    "`birthDate` DATE NULL, " +
    "`language` VARCHAR(8) NULL, " +
    "`ibanEnc` VARCHAR(512) NULL, " +
    "`isPro` TINYINT NOT NULL DEFAULT 0, " +
    "`proDiscount` DECIMAL(5,2) NULL, " +
    "`originPartnerId` VARCHAR(128) NULL, " +
    "`originPartnerName` VARCHAR(255) NULL, " +
    "`originChannel` VARCHAR(64) NULL, " +
    "`consentEmail` TINYINT NULL, " +
    "`consentWhatsapp` TINYINT NULL, " +
    "`consentSms` TINYINT NULL, " +
    "`tagsJson` VARCHAR(2000) NULL, " +
    "`notes` TEXT NULL, " +
    "`source` VARCHAR(32) NOT NULL DEFAULT 'bookings', " +
    "`syncKey` VARCHAR(160) NULL, " +
    "`bookings` INT NOT NULL DEFAULT 0, " +
    "`completed` INT NOT NULL DEFAULT 0, " +
    "`cancelled` INT NOT NULL DEFAULT 0, " +
    "`upcoming` INT NOT NULL DEFAULT 0, " +
    "`partnerBookings` INT NOT NULL DEFAULT 0, " +
    "`totalSpent` DECIMAL(12,2) NULL, " +
    "`firstVisit` DATETIME NULL, " +
    "`lastVisit` DATETIME NULL, " +
    "`nextCheckIn` DATETIME NULL, " +
    "`preferredPark` VARCHAR(128) NULL, " +
    "`parksJson` VARCHAR(2000) NULL, " +
    "`cities` VARCHAR(128) NULL, " +
    "`country` VARCHAR(2) NULL, " +
    "`noEmail` TINYINT NOT NULL DEFAULT 0, " +
    "`genericEmailOnly` TINYINT NOT NULL DEFAULT 0, " +
    "`metricsAt` DATETIME NULL, " +
    "`lastSeenAt` DATETIME NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_crm_clients_syncKey` (`syncKey`), " +
    "KEY `idx_crm_clients_status_last` (`status`, `lastVisit`), " +
    "KEY `idx_crm_clients_name` (`displayName`), " +
    "KEY `idx_crm_clients_nif` (`nif`), " +
    "KEY `idx_crm_clients_pro` (`isPro`), " +
    "KEY `idx_crm_clients_country` (`country`)" +
    ")" + T,
  "CREATE TABLE IF NOT EXISTS `crm_client_emails` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`clientId` INT NOT NULL, " +
    "`email` VARCHAR(320) NOT NULL, " +
    "`isPrimary` TINYINT NOT NULL DEFAULT 0, " +
    "`generic` TINYINT NOT NULL DEFAULT 0, " +
    "`verified` TINYINT NOT NULL DEFAULT 0, " +
    "`source` VARCHAR(32) NULL, " +
    "`firstSeenAt` DATETIME NULL, " +
    "`lastSeenAt` DATETIME NULL, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_crm_email_client` (`clientId`, `email`), " +
    "KEY `idx_crm_email` (`email`)" +
    ")" + T,
  "CREATE TABLE IF NOT EXISTS `crm_client_phones` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`clientId` INT NOT NULL, " +
    "`phone` VARCHAR(32) NOT NULL, " +
    "`isPrimary` TINYINT NOT NULL DEFAULT 0, " +
    "`whatsapp` TINYINT NOT NULL DEFAULT 0, " +
    "`label` VARCHAR(64) NULL, " +
    "`source` VARCHAR(32) NULL, " +
    "`firstSeenAt` DATETIME NULL, " +
    "`lastSeenAt` DATETIME NULL, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_crm_phone_client` (`clientId`, `phone`), " +
    "KEY `idx_crm_phone` (`phone`)" +
    ")" + T,
  "CREATE TABLE IF NOT EXISTS `crm_client_vehicles` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`clientId` INT NOT NULL, " +
    "`plate` VARCHAR(32) NOT NULL, " +
    "`plateDisplay` VARCHAR(32) NULL, " +
    "`brand` VARCHAR(64) NULL, " +
    "`model` VARCHAR(96) NULL, " +
    "`color` VARCHAR(48) NULL, " +
    "`vehicleType` VARCHAR(24) NULL, " +
    "`photoUrl` VARCHAR(1024) NULL, " +
    "`lastKm` INT NULL, " +
    "`bookings` INT NOT NULL DEFAULT 0, " +
    "`firstSeenAt` DATETIME NULL, " +
    "`lastSeenAt` DATETIME NULL, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_crm_vehicle_client` (`clientId`, `plate`), " +
    "KEY `idx_crm_vehicle_plate` (`plate`)" +
    ")" + T,
  "CREATE TABLE IF NOT EXISTS `crm_client_external_ids` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`clientId` INT NOT NULL, " +
    "`system` VARCHAR(32) NOT NULL, " +
    "`externalId` VARCHAR(128) NOT NULL, " +
    "`url` VARCHAR(1024) NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_crm_ext` (`system`, `externalId`), " +
    "KEY `idx_crm_ext_client` (`clientId`)" +
    ")" + T,
  "CREATE TABLE IF NOT EXISTS `crm_booking_links` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`bookingExternalId` VARCHAR(128) NOT NULL, " +
    "`clientId` INT NOT NULL, " +
    "`role` VARCHAR(16) NOT NULL DEFAULT 'traveler', " +
    "`rule` VARCHAR(24) NULL, " +
    "`linkedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_crm_booking_role` (`bookingExternalId`, `role`), " +
    "KEY `idx_crm_booking_client` (`clientId`)" +
    ")" + T,
  "CREATE TABLE IF NOT EXISTS `crm_client_relations` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`clientId` INT NOT NULL, " +
    "`relatedClientId` INT NOT NULL, " +
    "`kind` VARCHAR(16) NOT NULL, " +
    "`label` VARCHAR(64) NULL, " +
    "`pays` TINYINT NOT NULL DEFAULT 0, " +
    "`since` DATE NULL, " +
    "`until` DATE NULL, " +
    "`createdBy` INT NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_crm_relation` (`clientId`, `relatedClientId`, `kind`), " +
    "KEY `idx_crm_relation_related` (`relatedClientId`)" +
    ")" + T,
  "CREATE TABLE IF NOT EXISTS `crm_merge_suggestions` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`clientA` INT NOT NULL, " +
    "`clientB` INT NOT NULL, " +
    "`score` INT NOT NULL, " +
    "`reasons` VARCHAR(255) NOT NULL, " +
    "`status` VARCHAR(16) NOT NULL DEFAULT 'pending', " +
    "`decidedBy` INT NULL, " +
    "`decidedAt` DATETIME NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_crm_suggestion_pair` (`clientA`, `clientB`), " +
    "KEY `idx_crm_suggestion_status` (`status`, `score`)" +
    ")" + T,
  "CREATE TABLE IF NOT EXISTS `crm_merge_events` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`survivorId` INT NOT NULL, " +
    "`mergedId` INT NOT NULL, " +
    "`snapshotJson` LONGTEXT NOT NULL, " +
    "`reason` VARCHAR(255) NULL, " +
    "`mergedBy` INT NULL, " +
    "`mergedAt` DATETIME NOT NULL, " +
    "`undoneAt` DATETIME NULL, " +
    "`undoneBy` INT NULL, " +
    "PRIMARY KEY (`id`), " +
    "KEY `idx_crm_merge_survivor` (`survivorId`), " +
    "KEY `idx_crm_merge_merged` (`mergedId`)" +
    ")" + T,
  "CREATE TABLE IF NOT EXISTS `crm_saved_filters` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`userId` INT NOT NULL, " +
    "`name` VARCHAR(128) NOT NULL, " +
    "`payloadJson` TEXT NOT NULL, " +
    "`shared` TINYINT NOT NULL DEFAULT 0, " +
    "`isDefault` TINYINT NOT NULL DEFAULT 0, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "KEY `idx_crm_filters_user` (`userId`), " +
    "KEY `idx_crm_filters_shared` (`shared`)" +
    ")" + T,
];

export const IDEMPOTENT_ERROR_CODES_0215 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME"]);
