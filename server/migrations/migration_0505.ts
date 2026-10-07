// Migration 0505 — alertas dispensáveis (lote 42d, Jorge 7 out 2026: "estes
// alertas… dar para retirar"): quem tirou e quando. O alerta fica guardado
// (nada se apaga) e pode voltar ("Repor"). Só acrescenta. Idempotente.
export const MIGRATION_0505_STATEMENTS: string[] = [
  "ALTER TABLE `ops_anomalies` ADD COLUMN `dismissedAt` DATETIME NULL",
  "ALTER TABLE `ops_anomalies` ADD COLUMN `dismissedById` INT NULL",
];

export const IDEMPOTENT_ERROR_CODES_0505 = new Set<string>(["ER_DUP_FIELDNAME"]);
