// Migration 0078 — versão das métricas GPS diárias (Fase 0, 24 set 2026).
//
// As velocidades do Zello eram multiplicadas por 3,6 (a API já dá km/h) e o
// funcionário nunca era gravado. `metricsVersion` = 1 nas linhas antigas; a
// recolha nova grava 2 e o daily-ops recalcula as antigas a partir do GeoJSON.

export const MIGRATION_0078_NAME = "0078_driver_history_metrics_version";

export const MIGRATION_0078_STATEMENTS: string[] = [
  "ALTER TABLE `daily_driver_history` ADD COLUMN `metricsVersion` INT NOT NULL DEFAULT 1",
];

export const IDEMPOTENT_ERROR_CODES_0078 = new Set<string>(["ER_DUP_FIELDNAME"]);
