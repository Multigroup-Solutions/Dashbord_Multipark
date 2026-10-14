// Migration 0665 — Filtros guardados também na Avaliação → Mês (Jorge, 14 out
// 2026: filtros "como no Odoo" no ranking, com filtros guardados e um por
// omissão). Reaproveita a tabela do CRM (`crm_saved_filters`): ganha a coluna
// `page` — "crm" (todos os que já existem, por omissão) ou "avaliacao". Cada
// página só vê os seus; o "abrir com este" é um por pessoa em cada página.
//
// Só acrescenta (coluna com valor por omissão + índice). Idempotente: a coluna
// ou o índice que já existam ficam calados.

export const MIGRATION_0665_STATEMENTS: string[] = [
  "ALTER TABLE `crm_saved_filters` ADD COLUMN `page` VARCHAR(24) NOT NULL DEFAULT 'crm'",
  "ALTER TABLE `crm_saved_filters` ADD INDEX `idx_crm_filters_user_page` (`userId`, `page`)",
];

/** ER_DUP_FIELDNAME (1060), ER_DUP_KEYNAME (1061). */
export const IDEMPOTENT_ERROR_CODES_0665 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
