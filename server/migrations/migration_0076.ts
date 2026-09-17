// Migration 0076 — Leads de extras (Jorge, 17 set 2026).
//
// Contactos que ainda NÃO são extras mas estão a ser recrutados (nome + telemóvel
// e/ou email). Tabela própria, fora de `employees`: a ficha de colaborador só
// nasce quando a pessoa aceita — até lá é um lead, contactado pelo WhatsApp com
// o template `seja_motorista`. `phoneE164` liga o lead à conversa do inbox
// (whatsapp_conversations.phoneE164), que nasce sem employeeId.
// Ver memory/whatsapp-integration.md (changelog 2026-09-17).

export const MIGRATION_0076_NAME = "0076_extra_leads";

export const MIGRATION_0076_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS \`extra_leads\` (
    \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    \`fullName\` VARCHAR(256) NOT NULL,
    \`phone\` VARCHAR(32) NULL,
    \`phoneE164\` VARCHAR(20) NULL,
    \`email\` VARCHAR(320) NULL,
    \`status\` ENUM('new','contacted','converted','declined') NOT NULL DEFAULT 'new',
    \`notes\` VARCHAR(512) NULL,
    \`source\` VARCHAR(64) NOT NULL DEFAULT 'manual',
    \`contactCount\` INT NOT NULL DEFAULT 0,
    \`lastContactedAt\` TIMESTAMP NULL,
    \`employeeId\` INT NULL,
    \`createdById\` INT NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updatedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY \`idx_extra_leads_status\` (\`status\`),
    KEY \`idx_extra_leads_phone\` (\`phoneE164\`),
    KEY \`idx_extra_leads_email\` (\`email\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

export const IDEMPOTENT_ERROR_CODES_0076 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME"]);
