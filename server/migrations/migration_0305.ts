// Migration 0305 — fecho do mês de parceiros: quantas reservas do "nosso" lado
// vieram do HISTÓRICO carregado (preço inicial, antes da memória do webhook).
export const MIGRATION_0305_NAME = "0305_partner_close_history";

export const MIGRATION_0305_STATEMENTS: string[] = [
  "ALTER TABLE `partner_month_closes` ADD COLUMN `copyFromHistory` INT NOT NULL DEFAULT 0",
];

export const IDEMPOTENT_ERROR_CODES_0305 = new Set<string>(["ER_DUP_FIELDNAME"]);
