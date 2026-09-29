// Migration 0245 — CRM fase 1: resumo por ficha para o CRM ler a Multipark ao
// vivo (29 set 2026). Sem cópia de reservas: a ficha guarda só o resumo que
// os filtros e o âmbito de cidade precisam.
//   - cityKeys: cidades das reservas, em minúsculas e separadas por vírgulas
//     ("lisboa,porto") — âmbito de cidade e filtros de cidade/região/país;
//   - channels: canais (origem) das reservas ("API,MARKETPLACE");
//   - partners: parceiros das reservas (nomes, separados por "|").
// Só acrescenta colunas (ER_DUP_FIELDNAME = já existe) — idempotente.

export const MIGRATION_0245_NAME = "0245_crm_live_summary";

export const MIGRATION_0245_STATEMENTS: string[] = [
  "ALTER TABLE `crm_clients` ADD COLUMN `cityKeys` VARCHAR(255) NULL",
  "ALTER TABLE `crm_clients` ADD COLUMN `channels` VARCHAR(255) NULL",
  "ALTER TABLE `crm_clients` ADD COLUMN `partners` VARCHAR(1000) NULL",
  // Até o crm-sync rever as fichas: cityKeys a partir das cidades que já lá estão
  // (o âmbito de cidade passa a usar cityKeys — sem isto quem só vê uma cidade não via nada).
  "UPDATE `crm_clients` SET `cityKeys` = LOWER(`cities`) WHERE `cityKeys` IS NULL AND `cities` IS NOT NULL AND `cities` <> ''",
];

export const IDEMPOTENT_ERROR_CODES_0245 = new Set<string>(["ER_DUP_FIELDNAME"]);
