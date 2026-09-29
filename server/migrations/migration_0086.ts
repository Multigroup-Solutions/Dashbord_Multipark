// Migration 0086 — "H. movimento" também para quem partilha PDA (24 set 2026).
//
// `driver_day_shares.movingMinutes`: dos minutos com o PDA, quantos a andar
// (> 2 km/h, a mesma regra de daily_driver_history.hoursWorked). NULL nas
// partes antigas (antes desta coluna) — a UI cai em "H. com PDA". Idempotente:
// ER_DUP_FIELDNAME quando já existe.

export const MIGRATION_0086_NAME = "0086_driver_share_moving_minutes";

export const MIGRATION_0086_STATEMENTS: string[] = [
  "ALTER TABLE `driver_day_shares` ADD COLUMN `movingMinutes` INT NULL",
];

export const IDEMPOTENT_ERROR_CODES_0086 = new Set<string>(["ER_DUP_FIELDNAME"]);
