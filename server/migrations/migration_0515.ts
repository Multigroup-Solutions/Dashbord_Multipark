// Migration 0515 — alertas calculados tirados para TODA a gente (Jorge, 7 out
// 2026, sobre o X dos alertas do Marketing: "pode ser para todos"). Antes
// ficava só no aparelho de quem carregava. Uma linha por alerta tirado
// (âmbito + projeto + chave + mês), com quem e quando; "Repor" marca
// `restoredAt` — nada se apaga. Só acrescenta. Idempotente.
export const MIGRATION_0515_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS \`alert_dismissals\` (
    \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    \`scope\` VARCHAR(32) NOT NULL,
    \`projectId\` INT NOT NULL DEFAULT 0,
    \`alertKey\` VARCHAR(191) NOT NULL,
    \`period\` CHAR(7) NOT NULL,
    \`dismissedById\` INT NULL,
    \`dismissedAt\` DATETIME NOT NULL,
    \`restoredById\` INT NULL,
    \`restoredAt\` DATETIME NULL,
    UNIQUE KEY \`uq_alert_dismissals\` (\`scope\`, \`projectId\`, \`alertKey\`, \`period\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

export const IDEMPOTENT_ERROR_CODES_0515 = new Set<string>(["ER_TABLE_EXISTS_ERROR"]);
