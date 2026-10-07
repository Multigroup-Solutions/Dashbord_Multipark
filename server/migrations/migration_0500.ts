// Migration 0500 — Xsi da One Net (lote 40a): uma linha de configuração
// (servidor, utilizador, palavra-passe CIFRADA com a chave das integrações)
// e o resultado do último "Testar". Só acrescenta. Idempotente.
export const MIGRATION_0500_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS \`central_xsi_config\` (
    \`id\` TINYINT NOT NULL PRIMARY KEY,
    \`baseUrl\` VARCHAR(255) NULL,
    \`userId\` VARCHAR(120) NULL,
    \`readUserId\` VARCHAR(120) NULL,
    \`passwordEnc\` TEXT NULL,
    \`updatedById\` INT NULL,
    \`updatedAt\` DATETIME NULL,
    \`lastTestAt\` DATETIME NULL,
    \`lastTestOk\` TINYINT NULL,
    \`lastTestJson\` MEDIUMTEXT NULL
  ) DEFAULT CHARSET=utf8mb4`,
];

export const IDEMPOTENT_ERROR_CODES_0500 = new Set<string>(["ER_TABLE_EXISTS_ERROR"]);
