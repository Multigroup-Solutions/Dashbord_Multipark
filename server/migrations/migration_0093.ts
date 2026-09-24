// Migration 0093 — Marketing (24 set 2026)
//
//  - Atribuição Meta: `adAttribution` ganha 'meta_paid' e guarda-se o `fbclid`.
//    As reservas já marcadas 'unknown' que trazem fbclid / utm_source de Meta
//    voltam a NULL para o botão "Atribuir reservas" (backfill) as reclassificar
//    — UPDATE simples, sem subconsulta; na 2.ª corrida já não encontra nada.
//  - `marketing_budgets`: orçamento mensal por nó cidade/marca (e fornecedor
//    opcional; 'all' = todos) para o ritmo de gasto.
//  - `ad_campaign_links`: campanha de anúncios ↔ utm_campaign / código de
//    desconto, para ligar reservas a campanhas sem ID na URL.
//
// As tabelas ad_accounts / ad_campaigns / ad_daily_metrics já têm `provider`
// desde 0063 — a Meta escreve lá com provider = 'meta'.
//
// campaign_daily_stats (legado): NÃO se cria chave única (campaignId, date).
// Apagar duplicados no arranque seria destrutivo e irreversível; em vez disso
// a leitura deduplica por (campanha, dia) ficando com o registo mais recente
// (ver adMetrics.ts, derivado com MAX(id) — sem 1093).
//
// Idempotente: ADD COLUMN → ER_DUP_FIELDNAME; CREATE TABLE IF NOT EXISTS;
// MODIFY/UPDATE podem correr N vezes.

export const MIGRATION_0093_NAME = "0093_marketing_meta_budgets";

export const MIGRATION_0093_STATEMENTS: string[] = [
  "ALTER TABLE `multipark_bookings` MODIFY COLUMN `adAttribution` ENUM('google_paid','meta_paid','unknown') NULL",
  "ALTER TABLE `multipark_bookings` ADD COLUMN `fbclid` VARCHAR(255) NULL",
  "UPDATE `multipark_bookings` SET `adAttribution` = NULL WHERE `adAttribution` = 'unknown' AND (`originUrl` LIKE '%fbclid=%' OR LOWER(COALESCE(`utmSource`, '')) IN ('facebook','instagram','meta','fb','ig'))",
  `CREATE TABLE IF NOT EXISTS \`marketing_budgets\` (
    \`id\` INT AUTO_INCREMENT PRIMARY KEY,
    \`month\` CHAR(7) NOT NULL,
    \`projectId\` INT NOT NULL,
    \`provider\` VARCHAR(32) NOT NULL DEFAULT 'all',
    \`amount\` DECIMAL(12,2) NOT NULL,
    \`notes\` VARCHAR(255) NULL,
    \`createdById\` INT NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updatedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY \`uq_marketing_budgets\` (\`month\`, \`projectId\`, \`provider\`)
  )`,
  `CREATE TABLE IF NOT EXISTS \`ad_campaign_links\` (
    \`id\` INT AUTO_INCREMENT PRIMARY KEY,
    \`adCampaignId\` INT NOT NULL,
    \`keyType\` ENUM('utm_campaign','discount_code') NOT NULL,
    \`keyValue\` VARCHAR(256) NOT NULL,
    \`createdById\` INT NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY \`uq_ad_campaign_links\` (\`keyType\`, \`keyValue\`),
    KEY \`idx_ad_campaign_links_campaign\` (\`adCampaignId\`)
  )`,
];

export const IDEMPOTENT_ERROR_CODES_0093 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME", "ER_TABLE_EXISTS_ERROR"]);
