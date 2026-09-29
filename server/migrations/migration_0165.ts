// Migration 0165 — Web & SEO no Marketing: Google Analytics 4, Search Console
// e PageSpeed Insights (pedido do dono, set 2026). Só AGREGADOS (sem dados de
// pessoas):
//
//  - web_ga_daily: totais por propriedade GA4 × dia (sessões, utilizadores,
//    novos, sessões com envolvimento, eventos-chave, receita).
//  - web_ga_dims: por propriedade × dimensão × dia × valor (canal, página de
//    entrada, dispositivo, país, cidade, eventos do funil) — top N por dia;
//    `valueHash` = sha1 do valor (chave única curta).
//  - web_sc_daily: Search Console por propriedade × dia (cliques, impressões,
//    posição média ponderada).
//  - web_sc_dims: por propriedade × dimensão × dia × valor (pesquisa, página,
//    dispositivo, país) — top 250 pesquisas/páginas por dia.
//  - web_pagespeed_runs: histórico semanal da PageSpeed por página × estratégia
//    (móvel/computador): pontuação, LCP, CLS, TBT, FCP, INP de campo.
//  - web_analytics_state: cursores da recolha (retomável), trinco, últimos
//    erros por fonte, alertas enviados e o resumo semanal.
//
// Idempotente (corre em cada arranque via ensureRecentSchema): só CREATE
// TABLE IF NOT EXISTS; os códigos de "já existe" são ignorados.

export const MIGRATION_0165_NAME = "0165_web_analytics";

export const MIGRATION_0165_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `web_ga_daily` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`propertyId` VARCHAR(20) NOT NULL, " +
    "`day` DATE NOT NULL, " +
    "`sessions` INT NOT NULL DEFAULT 0, " +
    "`totalUsers` INT NOT NULL DEFAULT 0, " +
    "`newUsers` INT NOT NULL DEFAULT 0, " +
    "`engagedSessions` INT NOT NULL DEFAULT 0, " +
    "`keyEvents` DECIMAL(14,2) NOT NULL DEFAULT 0, " +
    "`revenue` DECIMAL(14,2) NOT NULL DEFAULT 0, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_web_ga_daily` (`propertyId`, `day`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `web_ga_dims` (" +
    "`id` BIGINT NOT NULL AUTO_INCREMENT, " +
    "`propertyId` VARCHAR(20) NOT NULL, " +
    "`dim` VARCHAR(12) NOT NULL, " +
    "`day` DATE NOT NULL, " +
    "`valueHash` CHAR(40) NOT NULL, " +
    "`dimValue` VARCHAR(500) NOT NULL, " +
    "`sessions` INT NOT NULL DEFAULT 0, " +
    "`totalUsers` INT NOT NULL DEFAULT 0, " +
    "`engagedSessions` INT NOT NULL DEFAULT 0, " +
    "`keyEvents` DECIMAL(14,2) NOT NULL DEFAULT 0, " +
    "`revenue` DECIMAL(14,2) NOT NULL DEFAULT 0, " +
    "`eventCount` INT NOT NULL DEFAULT 0, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_web_ga_dims` (`propertyId`, `dim`, `day`, `valueHash`), " +
    "KEY `idx_web_ga_dims_hash` (`propertyId`, `dim`, `valueHash`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `web_sc_daily` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`siteUrl` VARCHAR(255) NOT NULL, " +
    "`day` DATE NOT NULL, " +
    "`clicks` INT NOT NULL DEFAULT 0, " +
    "`impressions` INT NOT NULL DEFAULT 0, " +
    "`position` DECIMAL(8,2) NULL, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_web_sc_daily` (`siteUrl`, `day`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `web_sc_dims` (" +
    "`id` BIGINT NOT NULL AUTO_INCREMENT, " +
    "`siteUrl` VARCHAR(255) NOT NULL, " +
    "`dim` VARCHAR(12) NOT NULL, " +
    "`day` DATE NOT NULL, " +
    "`valueHash` CHAR(40) NOT NULL, " +
    "`dimValue` VARCHAR(1000) NOT NULL, " +
    "`clicks` INT NOT NULL DEFAULT 0, " +
    "`impressions` INT NOT NULL DEFAULT 0, " +
    "`position` DECIMAL(8,2) NULL, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_web_sc_dims` (`siteUrl`, `dim`, `day`, `valueHash`), " +
    "KEY `idx_web_sc_dims_hash` (`siteUrl`, `dim`, `valueHash`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `web_pagespeed_runs` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`url` VARCHAR(1000) NOT NULL, " +
    "`urlHash` CHAR(40) NOT NULL, " +
    "`strategy` VARCHAR(8) NOT NULL, " +
    "`runDay` DATE NOT NULL, " +
    "`score` INT NULL, " +
    "`lcpMs` INT NULL, " +
    "`cls` DECIMAL(6,3) NULL, " +
    "`tbtMs` INT NULL, " +
    "`fcpMs` INT NULL, " +
    "`speedIndexMs` INT NULL, " +
    "`inpMs` INT NULL, " +
    "`fieldLcpMs` INT NULL, " +
    "`fieldCls` DECIMAL(6,3) NULL, " +
    "`fieldCategory` VARCHAR(20) NULL, " +
    "`error` VARCHAR(300) NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_web_pagespeed_runs` (`urlHash`, `strategy`, `runDay`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `web_analytics_state` (" +
    "`stateKey` VARCHAR(191) NOT NULL, " +
    "`value` TEXT NULL, " +
    "`leaseUntil` DATETIME NULL, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`stateKey`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
];

export const IDEMPOTENT_ERROR_CODES_0165 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME", "ER_DUP_FIELDNAME", "ER_DUP_ENTRY"]);
