// Migration 0395 — Marketing (P3 lote 19a): "Apagar" um orçamento ou uma
// ligação campanha ↔ utm/código passa a ARQUIVAR (antes era um DELETE sem
// rasto). A linha fica com quem arquivou e quando; voltar a definir o mesmo
// orçamento/ligação reaproveita a linha (a chave única mantém-se).
// Idempotente: ADD COLUMN ignora o que já existe. Não apaga nada.
export const MIGRATION_0395_STATEMENTS: string[] = [
  "ALTER TABLE `marketing_budgets` ADD COLUMN `archivedAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `marketing_budgets` ADD COLUMN `archivedById` INT NULL",
  "ALTER TABLE `ad_campaign_links` ADD COLUMN `archivedAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `ad_campaign_links` ADD COLUMN `archivedById` INT NULL",
];

export const IDEMPOTENT_ERROR_CODES_0395 = new Set<string>(["ER_DUP_FIELDNAME"]);
