// Migration 0300 — FECHO DO MÊS DE PARCEIROS (passo 3; decisão do dono, 29 set
// 2026: "como se fosse uma caixa"). Uma linha por (mês, parceiro): os números
// da Multipark e os da nossa memória do webhook, as diferenças reserva a
// reserva (JSON) e o fecho (quem, quando, porquê). Linha fechada fica
// congelada: a comparação automática já não lhe mexe. Só acrescenta.

export const MIGRATION_0300_NAME = "0300_partner_month_closes";

export const MIGRATION_0300_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS \`partner_month_closes\` (
    \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    \`month\` CHAR(7) NOT NULL,
    \`partnerKey\` VARCHAR(128) NOT NULL,
    \`partnerName\` VARCHAR(255) NULL,
    \`mpBookings\` INT NOT NULL DEFAULT 0,
    \`mpValue\` DECIMAL(12,2) NOT NULL DEFAULT 0,
    \`mpOurs\` DECIMAL(12,2) NOT NULL DEFAULT 0,
    \`mpInvoices\` INT NOT NULL DEFAULT 0,
    \`mpNoInvoice\` INT NOT NULL DEFAULT 0,
    \`mpNoDue\` INT NOT NULL DEFAULT 0,
    \`copyBookings\` INT NOT NULL DEFAULT 0,
    \`copyValue\` DECIMAL(12,2) NOT NULL DEFAULT 0,
    \`copyOurs\` DECIMAL(12,2) NOT NULL DEFAULT 0,
    \`beforeMemory\` INT NOT NULL DEFAULT 0,
    \`diffs\` INT NOT NULL DEFAULT 0,
    \`diffsJson\` MEDIUMTEXT NULL,
    \`computedAt\` TIMESTAMP NULL,
    \`state\` VARCHAR(16) NOT NULL DEFAULT 'aberto',
    \`closedAt\` TIMESTAMP NULL,
    \`closedBy\` INT NULL,
    \`closeNote\` TEXT NULL,
    \`alertedDiffs\` INT NOT NULL DEFAULT 0,
    UNIQUE KEY \`uq_partner_month\` (\`month\`, \`partnerKey\`),
    INDEX \`idx_pmc_month\` (\`month\`, \`state\`)
  )`,
];

export const IDEMPOTENT_ERROR_CODES_0300 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME"]);
