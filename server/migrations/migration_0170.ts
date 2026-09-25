// Migration 0170 — Google Business Profile (desempenho, pesquisas, estado dos
// perfis) e melhorias da PageSpeed (CrUX e "o que corrigir primeiro"), pedido
// do dono (set 2026). Só AGREGADOS (sem dados de pessoas):
//
//  - gbp_daily_metrics: por perfil (google_business_locations.id) × dia —
//    impressões Maps/Pesquisa (computador/telemóvel), chamadas, cliques no
//    site, pedidos de direções, conversas e marcações (Performance API).
//  - gbp_search_keywords: pesquisas que mostraram o perfil, por mês; a Google
//    esconde os valores pequenos (`threshold` em vez de `impressions`).
//  - google_business_locations (0072) + estado do perfil: alterado pela
//    Google, edições pendentes, controlo do perfil (verificação/suspensão),
//    aberto/fechado, pode publicar, link do Maps e place id.
//  - web_crux_records: Chrome UX Report (dados reais) por origem/URL ×
//    telemóvel/computador × período de recolha (28 dias, semanal): p75 de
//    LCP, INP, CLS, FCP e TTFB + distribuição bom/a melhorar/fraco.
//  - web_pagespeed_audits: oportunidades/diagnósticos Lighthouse de cada
//    medição PageSpeed (id, título, poupança em ms/bytes).
//
// Os cursores/estado da recolha ficam em web_analytics_state (0165) com o
// prefixo "gbp:" / "crux:". Idempotente (corre em cada arranque via
// ensureRecentSchema): CREATE TABLE IF NOT EXISTS e ADD COLUMN (coluna já
// existente → ER_DUP_FIELDNAME ignorado).

export const MIGRATION_0170_NAME = "0170_google_business_profile_crux";

export const MIGRATION_0170_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `gbp_daily_metrics` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`locationId` INT NOT NULL, " +
    "`day` DATE NOT NULL, " +
    "`impDesktopMaps` INT NOT NULL DEFAULT 0, " +
    "`impDesktopSearch` INT NOT NULL DEFAULT 0, " +
    "`impMobileMaps` INT NOT NULL DEFAULT 0, " +
    "`impMobileSearch` INT NOT NULL DEFAULT 0, " +
    "`callClicks` INT NOT NULL DEFAULT 0, " +
    "`websiteClicks` INT NOT NULL DEFAULT 0, " +
    "`directionRequests` INT NOT NULL DEFAULT 0, " +
    "`conversations` INT NOT NULL DEFAULT 0, " +
    "`bookings` INT NOT NULL DEFAULT 0, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_gbp_daily_metrics` (`locationId`, `day`), " +
    "KEY `idx_gbp_daily_metrics_day` (`day`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `gbp_search_keywords` (" +
    "`id` BIGINT NOT NULL AUTO_INCREMENT, " +
    "`locationId` INT NOT NULL, " +
    "`month` DATE NOT NULL, " +
    "`keywordHash` CHAR(40) NOT NULL, " +
    "`keyword` VARCHAR(300) NOT NULL, " +
    "`impressions` INT NULL, " +
    "`threshold` INT NULL, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_gbp_search_keywords` (`locationId`, `month`, `keywordHash`), " +
    "KEY `idx_gbp_search_keywords_month` (`month`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "ALTER TABLE `google_business_locations` ADD COLUMN `hasGoogleUpdated` TINYINT NULL",
  "ALTER TABLE `google_business_locations` ADD COLUMN `hasPendingEdits` TINYINT NULL",
  "ALTER TABLE `google_business_locations` ADD COLUMN `hasVoiceOfMerchant` TINYINT NULL",
  "ALTER TABLE `google_business_locations` ADD COLUMN `canOperateLocalPost` TINYINT NULL",
  "ALTER TABLE `google_business_locations` ADD COLUMN `openStatus` VARCHAR(30) NULL",
  "ALTER TABLE `google_business_locations` ADD COLUMN `mapsUri` VARCHAR(500) NULL",
  "ALTER TABLE `google_business_locations` ADD COLUMN `placeId` VARCHAR(100) NULL",
  "ALTER TABLE `google_business_locations` ADD COLUMN `metaCheckedAt` DATETIME NULL",

  "CREATE TABLE IF NOT EXISTS `web_crux_records` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`targetType` VARCHAR(6) NOT NULL, " +
    "`target` VARCHAR(1000) NOT NULL, " +
    "`targetHash` CHAR(40) NOT NULL, " +
    "`formFactor` VARCHAR(8) NOT NULL, " +
    "`periodStart` DATE NOT NULL, " +
    "`periodEnd` DATE NOT NULL, " +
    "`lcpP75` INT NULL, " +
    "`inpP75` INT NULL, " +
    "`clsP75` DECIMAL(6,3) NULL, " +
    "`fcpP75` INT NULL, " +
    "`ttfbP75` INT NULL, " +
    "`lcpGood` DECIMAL(5,4) NULL, `lcpNi` DECIMAL(5,4) NULL, `lcpPoor` DECIMAL(5,4) NULL, " +
    "`inpGood` DECIMAL(5,4) NULL, `inpNi` DECIMAL(5,4) NULL, `inpPoor` DECIMAL(5,4) NULL, " +
    "`clsGood` DECIMAL(5,4) NULL, `clsNi` DECIMAL(5,4) NULL, `clsPoor` DECIMAL(5,4) NULL, " +
    "`fcpGood` DECIMAL(5,4) NULL, `fcpNi` DECIMAL(5,4) NULL, `fcpPoor` DECIMAL(5,4) NULL, " +
    "`ttfbGood` DECIMAL(5,4) NULL, `ttfbNi` DECIMAL(5,4) NULL, `ttfbPoor` DECIMAL(5,4) NULL, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_web_crux_records` (`targetHash`, `formFactor`, `periodEnd`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `web_pagespeed_audits` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`urlHash` CHAR(40) NOT NULL, " +
    "`strategy` VARCHAR(8) NOT NULL, " +
    "`runDay` DATE NOT NULL, " +
    "`auditId` VARCHAR(80) NOT NULL, " +
    "`kind` VARCHAR(12) NOT NULL, " +
    "`title` VARCHAR(300) NOT NULL, " +
    "`displayValue` VARCHAR(160) NULL, " +
    "`savingsMs` INT NULL, " +
    "`savingsBytes` INT NULL, " +
    "`score` DECIMAL(4,2) NULL, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_web_pagespeed_audits` (`urlHash`, `strategy`, `runDay`, `auditId`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
];

export const IDEMPOTENT_ERROR_CODES_0170 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME", "ER_DUP_FIELDNAME", "ER_DUP_ENTRY"]);
