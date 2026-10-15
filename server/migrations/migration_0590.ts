// Migration 0590 — Desempenho 49e (Jorge, 8 out 2026: "avança com o
// desempenho"): a atividade por hora do dia. A avaliação diária (que já lê a
// "History" da Multipark para encher employee_day_metrics) passa a guardar
// também as ações de cada pessoa por hora de relógio de Lisboa, a partir da
// MESMA leitura — o Desempenho nunca relê a History por períodos longos.
//
//  - `actionsByHour`: "[n0,n1,…,n23]" (24 números). NULL = dia sem ações na
//    Multipark ou calculado antes desta migração (o ecrã diz "por hora desde…";
//    o recálculo da noite enche os últimos 31 dias).
//
// Só acrescenta a coluna; sem backfill. Idempotente: ADD COLUMN repetido dá
// ER_DUP_FIELDNAME.

export const MIGRATION_0590_STATEMENTS: string[] = [
  "ALTER TABLE `employee_day_metrics` ADD COLUMN `actionsByHour` VARCHAR(255) NULL AFTER `actionsByType`",
];

export const IDEMPOTENT_ERROR_CODES_0590 = new Set<string>(["ER_DUP_FIELDNAME"]);
