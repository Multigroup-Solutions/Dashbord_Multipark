// Migration 0670 — Mudanças de lugar à parte dos movimentos (Jorge, 14 out
// 2026: "as mudanças de lugar não contam como movimentos; contam como
// interações"). A avaliação diária passa a guardar, por pessoa e dia, quantos
// MOVEMENT da Multipark foram só mudanças de lugar (o carro já no parque):
// contam nas ações, não nos movimentos nem nos pontos. A regra está em
// shared/multiparkMovements.ts.
//
// Só acrescenta uma coluna (0 por omissão: os dias guardados antes ficam com
// 0 até serem recalculados — o cron refaz o último mês; os mais antigos só
// com o "Recalcular"). Idempotente: a coluna que já exista fica calada.

export const MIGRATION_0670_STATEMENTS: string[] = [
  "ALTER TABLE `employee_day_metrics` ADD COLUMN `spotChanges` INT NOT NULL DEFAULT 0 AFTER `parkingMoves`",
];

/** ER_DUP_FIELDNAME (1060). */
export const IDEMPOTENT_ERROR_CODES_0670 = new Set<string>(["ER_DUP_FIELDNAME"]);
