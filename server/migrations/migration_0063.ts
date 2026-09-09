// Migration 0063 — Integração Google Ads (fase 1 do "Plano de automatização do
// Google Ads", set 2026): fonte única das métricas + ligação OAuth + atribuição
// das reservas.
//
//   - integration_connections / oauth_states: ligação OAuth (refresh token
//     CIFRADO em BD; estado anti-CSRF de uso único);
//   - ad_accounts / ad_campaigns: contas e campanhas pelos IDs OFICIAIS
//     (campanhas com o mesmo nome em contas diferentes são diferentes);
//   - ad_daily_metrics: UM registo por fornecedor+conta+campanha+dia+origem,
//     dinheiro em micros, conversões decimais, provisório/definitivo;
//   - ad_conversion_action_metrics: conversões por ação, separadas;
//   - integration_sync_runs: execuções retomáveis, sem credenciais;
//   - multipark_bookings: gclid/gbraid/wbraid/utm_* + atribuição local
//     (google_paid | unknown) — NUNCA inventada para o passado;
//   - campaign_daily_stats.conversions → DECIMAL (deixa de arredondar).
//
// Idempotente: corre no boot (ensureRecentSchema).

export const MIGRATION_0063_NAME = "0063_google_ads_integration";

export const MIGRATION_0063_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS \`integration_connections\` (
    \`id\` INT NOT NULL AUTO_INCREMENT,
    \`provider\` VARCHAR(32) NOT NULL,
    \`status\` ENUM('disconnected','connected','reauth_required','error') NOT NULL DEFAULT 'disconnected',
    \`refreshTokenEnc\` TEXT NULL,
    \`scope\` VARCHAR(256) NULL,
    \`accountEmail\` VARCHAR(320) NULL,
    \`loginCustomerId\` VARCHAR(32) NULL,
    \`connectedById\` INT NULL,
    \`connectedAt\` TIMESTAMP NULL,
    \`lastCheckedAt\` TIMESTAMP NULL,
    \`lastError\` TEXT NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updatedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE INDEX \`uq_integration_connections_provider\` (\`provider\`)
  )`,
  `CREATE TABLE IF NOT EXISTS \`oauth_states\` (
    \`state\` VARCHAR(96) NOT NULL,
    \`provider\` VARCHAR(32) NOT NULL,
    \`userId\` INT NOT NULL,
    \`redirectTo\` VARCHAR(512) NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`expiresAt\` TIMESTAMP NOT NULL,
    PRIMARY KEY (\`state\`)
  )`,
  `CREATE TABLE IF NOT EXISTS \`ad_accounts\` (
    \`id\` INT NOT NULL AUTO_INCREMENT,
    \`provider\` VARCHAR(32) NOT NULL,
    \`customerId\` VARCHAR(32) NOT NULL,
    \`loginCustomerId\` VARCHAR(32) NULL,
    \`name\` VARCHAR(256) NULL,
    \`currency\` VARCHAR(8) NULL,
    \`timezone\` VARCHAR(64) NULL,
    \`isManager\` TINYINT NOT NULL DEFAULT 0,
    \`status\` VARCHAR(32) NULL,
    \`selected\` TINYINT NOT NULL DEFAULT 0,
    \`projectId\` INT NULL,
    \`lastSyncAt\` TIMESTAMP NULL,
    \`lastError\` TEXT NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updatedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE INDEX \`uq_ad_accounts_provider_customer\` (\`provider\`, \`customerId\`)
  )`,
  `CREATE TABLE IF NOT EXISTS \`ad_campaigns\` (
    \`id\` INT NOT NULL AUTO_INCREMENT,
    \`provider\` VARCHAR(32) NOT NULL,
    \`accountId\` INT NOT NULL,
    \`externalId\` VARCHAR(64) NOT NULL,
    \`name\` VARCHAR(256) NULL,
    \`status\` VARCHAR(32) NULL,
    \`channelType\` VARCHAR(32) NULL,
    \`budgetMicros\` BIGINT NULL,
    \`projectId\` INT NULL,
    \`legacyCampaignId\` INT NULL,
    \`firstSeenAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`lastSeenAt\` TIMESTAMP NULL,
    PRIMARY KEY (\`id\`),
    UNIQUE INDEX \`uq_ad_campaigns_ext\` (\`provider\`, \`accountId\`, \`externalId\`)
  )`,
  `CREATE TABLE IF NOT EXISTS \`ad_daily_metrics\` (
    \`id\` INT NOT NULL AUTO_INCREMENT,
    \`provider\` VARCHAR(32) NOT NULL,
    \`accountId\` INT NOT NULL,
    \`campaignExternalId\` VARCHAR(64) NOT NULL,
    \`date\` DATE NOT NULL,
    \`costMicros\` BIGINT NOT NULL DEFAULT 0,
    \`currency\` VARCHAR(8) NULL,
    \`impressions\` BIGINT NOT NULL DEFAULT 0,
    \`clicks\` BIGINT NOT NULL DEFAULT 0,
    \`conversions\` DECIMAL(14,4) NOT NULL DEFAULT 0,
    \`conversionValueMicros\` BIGINT NOT NULL DEFAULT 0,
    \`allConversions\` DECIMAL(14,4) NOT NULL DEFAULT 0,
    \`source\` ENUM('api','csv','email','manual') NOT NULL DEFAULT 'api',
    \`isProvisional\` TINYINT NOT NULL DEFAULT 0,
    \`syncRunId\` INT NULL,
    \`collectedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE INDEX \`uq_ad_daily_metrics\` (\`provider\`, \`accountId\`, \`campaignExternalId\`, \`date\`, \`source\`),
    INDEX \`idx_ad_daily_metrics_date\` (\`date\`)
  )`,
  `CREATE TABLE IF NOT EXISTS \`ad_conversion_action_metrics\` (
    \`id\` INT NOT NULL AUTO_INCREMENT,
    \`provider\` VARCHAR(32) NOT NULL,
    \`accountId\` INT NOT NULL,
    \`campaignExternalId\` VARCHAR(64) NOT NULL,
    \`date\` DATE NOT NULL,
    \`actionResource\` VARCHAR(256) NOT NULL,
    \`actionName\` VARCHAR(256) NULL,
    \`category\` VARCHAR(64) NULL,
    \`conversions\` DECIMAL(14,4) NOT NULL DEFAULT 0,
    \`valueMicros\` BIGINT NOT NULL DEFAULT 0,
    \`syncRunId\` INT NULL,
    \`collectedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE INDEX \`uq_ad_conv_action\` (\`provider\`, \`accountId\`, \`campaignExternalId\`, \`date\`, \`actionResource\`)
  )`,
  `CREATE TABLE IF NOT EXISTS \`integration_sync_runs\` (
    \`id\` INT NOT NULL AUTO_INCREMENT,
    \`provider\` VARCHAR(32) NOT NULL,
    \`kind\` ENUM('initial','hourly','nightly','monthly','manual') NOT NULL,
    \`status\` ENUM('running','partial','done','failed','skipped') NOT NULL DEFAULT 'running',
    \`rangeFrom\` DATE NULL,
    \`rangeTo\` DATE NULL,
    \`accountsTotal\` INT NOT NULL DEFAULT 0,
    \`accountsDone\` INT NOT NULL DEFAULT 0,
    \`rowsWritten\` INT NOT NULL DEFAULT 0,
    \`cursor\` VARCHAR(256) NULL,
    \`error\` TEXT NULL,
    \`warnings\` TEXT NULL,
    \`triggeredById\` INT NULL,
    \`startedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`finishedAt\` TIMESTAMP NULL,
    \`updatedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    INDEX \`idx_integration_sync_runs_provider\` (\`provider\`, \`startedAt\`)
  )`,
  // ── reservas: atribuição ao Google Ads ─────────────────────────────────────
  "ALTER TABLE `multipark_bookings` ADD COLUMN `gclid` VARCHAR(128) NULL",
  "ALTER TABLE `multipark_bookings` ADD COLUMN `gbraid` VARCHAR(128) NULL",
  "ALTER TABLE `multipark_bookings` ADD COLUMN `wbraid` VARCHAR(128) NULL",
  "ALTER TABLE `multipark_bookings` ADD COLUMN `utmSource` VARCHAR(128) NULL",
  "ALTER TABLE `multipark_bookings` ADD COLUMN `utmMedium` VARCHAR(128) NULL",
  "ALTER TABLE `multipark_bookings` ADD COLUMN `utmCampaign` VARCHAR(256) NULL",
  "ALTER TABLE `multipark_bookings` ADD COLUMN `utmContent` VARCHAR(256) NULL",
  "ALTER TABLE `multipark_bookings` ADD COLUMN `utmTerm` VARCHAR(256) NULL",
  "ALTER TABLE `multipark_bookings` ADD COLUMN `adCampaignExternalId` VARCHAR(64) NULL",
  "ALTER TABLE `multipark_bookings` ADD COLUMN `adAttribution` ENUM('google_paid','unknown') NULL",
  "ALTER TABLE `multipark_bookings` ADD COLUMN `adAttributedAt` TIMESTAMP NULL",
  "ALTER TABLE `multipark_bookings` ADD INDEX `idx_mp_bookings_ad_attr` (`adAttribution`, `bookingCreatedAt`)",
  // ── conversões fracionadas no legado ───────────────────────────────────────
  "ALTER TABLE `campaign_daily_stats` MODIFY COLUMN `conversions` DECIMAL(14,4) NULL DEFAULT 0",
];

export const IDEMPOTENT_ERROR_CODES_0063 = new Set([
  "ER_DUP_FIELDNAME",
  "ER_DUP_KEYNAME",
  "ER_TABLE_EXISTS_ERROR",
]);
