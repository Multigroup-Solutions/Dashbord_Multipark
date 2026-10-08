// Migration 0610 — campanhas com 0 reservas ligadas (Jorge, 8 out 2026).
//
// Com o auto-tagging da Google o link da reserva só traz o `gclid` (sem o ID
// da campanha), por isso a reserva não se ligava a campanha nenhuma. O
// Google Ads diz de que campanha é cada clique (relatório click_view):
//
//  - `google_ads_clicks`: um clique por linha — gclid → conta, campanha e grupo
//    de anúncios, dia do clique. `gclid` é a chave (comparação EXATA:
//    utf8mb4_bin — o gclid distingue maiúsculas). Repetir a leitura atualiza a
//    mesma linha (INSERT … ON DUPLICATE KEY UPDATE). Sem purga: lê-se só o
//    que interessa (WHERE gclid IN (…)).
//  - `google_ads_click_days`: que dias de cada conta já foram lidos e com
//    quantos cliques — é o que diz os "dias em falta" (um dia sem cliques
//    também fica lido).
//
// Só acrescenta; sem dados. Idempotente (CREATE TABLE IF NOT EXISTS).

export const MIGRATION_0610_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `google_ads_clicks` (" +
    "`gclid` VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, " +
    "`customerId` VARCHAR(32) NOT NULL, " +
    "`campaignId` VARCHAR(64) NOT NULL, " +
    "`adGroupId` VARCHAR(64) NULL, " +
    "`clickDate` DATE NOT NULL, " +
    "`fetchedAt` DATETIME(3) NOT NULL, " +
    "PRIMARY KEY (`gclid`), " +
    "KEY `idx_google_ads_clicks_day` (`customerId`, `clickDate`), " +
    "KEY `idx_google_ads_clicks_campaign` (`campaignId`, `clickDate`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  "CREATE TABLE IF NOT EXISTS `google_ads_click_days` (" +
    "`customerId` VARCHAR(32) NOT NULL, " +
    "`clickDate` DATE NOT NULL, " +
    "`clicks` INT NOT NULL DEFAULT 0, " +
    "`fetchedAt` DATETIME(3) NOT NULL, " +
    "PRIMARY KEY (`customerId`, `clickDate`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
];

export const IDEMPOTENT_ERROR_CODES_0610 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME"]);
