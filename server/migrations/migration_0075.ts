// Migration 0075 — Google Ads: campanhas NACIONAIS (Jorge, 16 set 2026).
//
// Há campanhas que não são de uma cidade (Brand, Pmax, Portugal): pertencem à
// MARCA e contam no total da marca, não em Lisboa/Porto/Faro. Até aqui ficavam
// com projectId NULL (indistinguível de "por associar") e o cálculo por cidade
// atirava-as para a cidade da conta. `scope` = 'national' marca-as de forma
// explícita; 'city' + projectId NULL continua a ser "por associar".

export const MIGRATION_0075_NAME = "0075_ad_campaigns_scope_national";

export const MIGRATION_0075_STATEMENTS: string[] = [
  "ALTER TABLE `ad_campaigns` ADD COLUMN `scope` ENUM('city','national') NOT NULL DEFAULT 'city' AFTER `projectId`",
];

export const IDEMPOTENT_ERROR_CODES_0075 = new Set<string>(["ER_DUP_FIELDNAME"]);
