// Migration 0400 — Perfil/RH (P3 lote 19c): mudar o IBAN passa a PEDIDO
// aprovado pelo RH (decisão do Jorge, 2 out 2026). O IBAN antigo fica na
// ficha até à aprovação; o novo guarda-se CIFRADO (AES-GCM, como os tokens
// das integrações) e só se mostra mascarado. Nada se apaga: um pedido novo
// marca o anterior como "superseded"; aprovar/recusar fica com quem e quando.
// Idempotente: CREATE TABLE IF NOT EXISTS.
export const MIGRATION_0400_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS \`employee_bank_change_requests\` (
    \`id\` INT AUTO_INCREMENT PRIMARY KEY,
    \`employeeId\` INT NOT NULL,
    \`newNibEnc\` TEXT NOT NULL,
    \`newNibMasked\` VARCHAR(40) NOT NULL,
    \`oldNibMasked\` VARCHAR(40) NULL,
    \`status\` ENUM('pending','approved','rejected','superseded') NOT NULL DEFAULT 'pending',
    \`requestedById\` INT NOT NULL,
    \`requestedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`decidedById\` INT NULL,
    \`decidedAt\` TIMESTAMP NULL DEFAULT NULL,
    \`decisionNote\` VARCHAR(300) NULL,
    KEY \`idx_bank_change_employee_status\` (\`employeeId\`, \`status\`),
    KEY \`idx_bank_change_status\` (\`status\`, \`requestedAt\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

export const IDEMPOTENT_ERROR_CODES_0400 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME"]);
