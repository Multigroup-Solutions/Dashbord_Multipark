// Migration 0074 — Google Ads: recolha DIÁRIA (decisão do Jorge, 16 set 2026:
// ir à API o menos possível). O enum `integration_sync_runs.kind` ganha
// 'daily'; 'hourly'/'nightly' ficam para as execuções antigas na lista.
//
// MODIFY COLUMN com a definição completa é idempotente (repetir não falha).
//
// 19b (2 out 2026): + 'recent' (passagem semanal dos últimos 35 dias). Vai
// AQUI e não numa migração nova: esta corre em cada arranque com a definição
// completa — sem 'recent' tirava-o outra vez (e num MySQL não estrito apagava
// o valor das linhas). Só acrescenta; não remove nenhum valor.

export const MIGRATION_0074_NAME = "0074_integration_sync_runs_kind_daily";

export const MIGRATION_0074_STATEMENTS: string[] = [
  "ALTER TABLE `integration_sync_runs` MODIFY COLUMN `kind` ENUM('initial','hourly','nightly','monthly','manual','daily','recent') NOT NULL",
];

export const IDEMPOTENT_ERROR_CODES_0074 = new Set<string>([]);
