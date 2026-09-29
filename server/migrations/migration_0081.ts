// Migration 0081 — várias contas e vários agentes por ficha (Jorge, 24 set 2026).
//
// Uma pessoa pode entrar com o email profissional E com o pessoal (duas contas
// Google) e pode ter mais do que um agente Multipark (contas com nomes
// diferentes). A ficha continua a ter a conta/agente PRINCIPAL em
// employees.userId / multiparkAgentUserId; estas tabelas guardam os EXTRA.

export const MIGRATION_0081_NAME = "0081_employee_aliases";

export const MIGRATION_0081_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS \`employee_accounts\` (
    \`userId\` INT NOT NULL PRIMARY KEY,
    \`employeeId\` INT NOT NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY \`idx_employee_accounts_emp\` (\`employeeId\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS \`employee_agents\` (
    \`agentUserId\` VARCHAR(128) NOT NULL PRIMARY KEY,
    \`employeeId\` INT NOT NULL,
    \`agentName\` VARCHAR(256) NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY \`idx_employee_agents_emp\` (\`employeeId\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

export const IDEMPOTENT_ERROR_CODES_0081 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME"]);
