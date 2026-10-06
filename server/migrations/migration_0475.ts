// Migration 0475 — Marketing nas contas (P3 lote 29f, Jorge 6 out 2026):
// a fatura do Google/Meta traz o PERÍODO DE CONSUMO (60–90 dias para trás);
// nesse período substitui o gasto dos anúncios na Faturação.
// `expenses.consumptionFrom/consumptionTo` (dias, inclusivos). Só acrescenta. Idempotente.
export const MIGRATION_0475_STATEMENTS: string[] = [
  "ALTER TABLE `expenses` ADD COLUMN `consumptionFrom` DATE NULL DEFAULT NULL",
  "ALTER TABLE `expenses` ADD COLUMN `consumptionTo` DATE NULL DEFAULT NULL",
];

export const IDEMPOTENT_ERROR_CODES_0475 = new Set<string>(["ER_DUP_FIELDNAME"]);
