// Migration 0665 — Avaliação (Jorge, 14 out 2026): "os movimentos dentro do
// mesmo parque só contam como mudança de lugar, não como movimento".
//
//  - `employee_day_metrics.spotChanges`: as mudanças de lugar do dia (linhas
//    MOVEMENT da History na mesma garagem — shared/multiparkMovements.ts →
//    classifyMovement). Valem +1 na avaliação (EVALUATION_POINTS.spotChange) e
//    deixam de entrar em `movements`.
//
//  - `employee_day_metrics.deliveriesWithoutSchedule`: entregas sem hora marcada
//    legível (medidas pelo pedido + 30 min) — nota na avaliação do dia/mês.
//  - `employee_day_metrics.rulesVersion`: com que regras o dia foi calculado
//    (1 = antigas, por omissão em todas as linhas que já existem; 2 = as de
//    14 out 2026, EVALUATION_RULES_VERSION). Os ecrãs avisam dos dias com < 2.
//
// Só acrescenta as colunas (0/1 por omissão); sem backfill: o recálculo da noite
// refaz os últimos 31 dias. Idempotente: ADD COLUMN repetido dá ER_DUP_FIELDNAME.

export const MIGRATION_0665_STATEMENTS: string[] = [
  "ALTER TABLE `employee_day_metrics` ADD COLUMN `spotChanges` INT NOT NULL DEFAULT 0 AFTER `parkingMoves`",
  "ALTER TABLE `employee_day_metrics` ADD COLUMN `deliveriesWithoutSchedule` INT NOT NULL DEFAULT 0 AFTER `lateServices`",
  "ALTER TABLE `employee_day_metrics` ADD COLUMN `rulesVersion` INT NOT NULL DEFAULT 1 AFTER `totalPoints`",
];

export const IDEMPOTENT_ERROR_CODES_0665 = new Set<string>(["ER_DUP_FIELDNAME"]);
