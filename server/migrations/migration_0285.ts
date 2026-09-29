// Migration 0285 — alertas "a trabalhar sem PDA ou Zello ligado" (passo 4 do
// plano dos PDAs, docs/auditoria/pdas-identidade.md §4). Um registo por
// pessoa × tipo enquanto o problema durar: quando abriu, quando se avisou no
// sino, quando passou ao WhatsApp, quem deu "visto" e quando fechou.
// Só cria a tabela (idempotente).

export const MIGRATION_0285_NAME = "0285_ops_presence_alerts";

export const MIGRATION_0285_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS \`ops_presence_alerts\` (
    \`id\` INT AUTO_INCREMENT PRIMARY KEY,
    \`employeeId\` INT NOT NULL,
    \`kind\` VARCHAR(32) NOT NULL,
    \`city\` VARCHAR(16) NULL,
    \`detail\` VARCHAR(500) NULL,
    \`openedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`lastSeenAt\` TIMESTAMP NULL,
    \`notifiedAt\` TIMESTAMP NULL,
    \`escalatedAt\` TIMESTAMP NULL,
    \`escalationResult\` VARCHAR(255) NULL,
    \`acknowledgedById\` INT NULL,
    \`acknowledgedAt\` TIMESTAMP NULL,
    \`ackNote\` VARCHAR(255) NULL,
    \`resolvedAt\` TIMESTAMP NULL,
    \`resolution\` VARCHAR(16) NULL,
    INDEX \`idx_ops_presence_open\` (\`resolvedAt\`, \`kind\`),
    INDEX \`idx_ops_presence_emp\` (\`employeeId\`, \`kind\`)
  )`,
];

export const IDEMPOTENT_ERROR_CODES_0285 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME"]);
