// Migration 0080 — GPS do dia partido por quem tinha o PDA (Fase 3).
//
// Os PDAs são partilhados: um Zello pode passar por 2–3 pessoas no mesmo dia.
// Cada linha diz quanto do GPS desse dia (km, minutos, velocidades, excessos)
// foi feito por cada pessoa, pelos intervalos de check-in no PDA.

export const MIGRATION_0080_NAME = "0080_driver_day_shares";

export const MIGRATION_0080_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS \`driver_day_shares\` (
    \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    \`historyId\` INT NOT NULL,
    \`zelloUsername\` VARCHAR(255) NOT NULL,
    \`day\` VARCHAR(10) NOT NULL,
    \`employeeId\` INT NOT NULL,
    \`minutes\` INT NOT NULL DEFAULT 0,
    \`km\` DECIMAL(10,2) NOT NULL DEFAULT 0,
    \`maxSpeed\` DECIMAL(6,2) NOT NULL DEFAULT 0,
    \`avgSpeed\` DECIMAL(6,2) NOT NULL DEFAULT 0,
    \`violations\` INT NOT NULL DEFAULT 0,
    \`points\` INT NOT NULL DEFAULT 0,
    UNIQUE KEY \`uq_dds_history_emp\` (\`historyId\`, \`employeeId\`),
    KEY \`idx_dds_day_emp\` (\`day\`, \`employeeId\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

export const IDEMPOTENT_ERROR_CODES_0080 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME"]);
