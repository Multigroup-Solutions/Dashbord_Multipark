// Migration 0320 — quem PROPÔS cada penalização (pontos). Quem confirma tem de
// ser outra pessoa, supervisor ou acima (Perdidos e RH). Só acrescenta.
export const MIGRATION_0320_NAME = "0320_penalty_proposed_by";

export const MIGRATION_0320_STATEMENTS: string[] = [
  "ALTER TABLE `employee_penalties` ADD COLUMN `proposedById` INT NULL",
];

export const IDEMPOTENT_ERROR_CODES_0320 = new Set<string>(["ER_DUP_FIELDNAME"]);
