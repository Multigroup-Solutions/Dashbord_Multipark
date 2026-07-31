// Migration 0060 — Tabelas do WhatsApp + tokens do formulário de disponibilidade.
//
// O DDL vivia em drizzle/0045_whatsapp_integration.sql e
// drizzle/0047_availability_form_tokens.sql, mas esses ficheiros .sql soltos
// nunca são executados por nada (o journal do drizzle-kit está congelado no
// idx 24 e o runner da casa são os migration_XXXX.ts). Resultado: o código do
// WhatsApp estava completo mas rebentava com ER_NO_SUCH_TABLE — incluindo o
// webhook, que respondia 500 à Meta em cada mensagem.
//
// Numeração 0060 (não 0045/0047): esses números já estão ocupados por
// server/migrations/migration_0045.ts e migration_0047.ts. Migrações
// existentes são imutáveis; ficheiro novo.
//
// IF NOT EXISTS em todos os CREATE: ao contrário dos .sql originais, isto corre
// no boot (ensureRecentSchema) em todos os processos, tem de ser re-executável.

export const MIGRATION_0060_NAME = "0060_whatsapp_and_availability_tokens";

export const MIGRATION_0060_STATEMENTS: string[] = [
  // ── 1. Conversas (1-a-1 por número E.164; lastInboundAt = janela 24h Meta) ──
  `CREATE TABLE IF NOT EXISTS \`whatsapp_conversations\` (
    \`id\` INT NOT NULL AUTO_INCREMENT,
    \`phoneE164\` VARCHAR(20) NOT NULL,
    \`employeeId\` INT NULL,
    \`lastInboundAt\` TIMESTAMP NULL,
    \`lastMessageAt\` TIMESTAMP NULL,
    \`unreadCount\` INT NOT NULL DEFAULT 0,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updatedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE INDEX \`whatsapp_conversations_phone_unique\` (\`phoneE164\`),
    INDEX \`idx_whatsapp_conversations_employee\` (\`employeeId\`),
    INDEX \`idx_whatsapp_conversations_last_message\` (\`lastMessageAt\`)
  )`,

  // ── 2. Mensagens (waMessageId único p/ dedup do webhook e updates de status) ──
  `CREATE TABLE IF NOT EXISTS \`whatsapp_messages\` (
    \`id\` INT NOT NULL AUTO_INCREMENT,
    \`conversationId\` INT NOT NULL,
    \`direction\` ENUM('in','out') NOT NULL,
    \`waMessageId\` VARCHAR(128) NULL,
    \`type\` ENUM('text','template') NOT NULL,
    \`body\` TEXT NULL,
    \`templateName\` VARCHAR(128) NULL,
    \`status\` ENUM('pending','sent','delivered','read','failed') NOT NULL DEFAULT 'pending',
    \`errorDetail\` TEXT NULL,
    \`sentById\` INT NULL,
    \`broadcastId\` INT NULL,
    \`waTimestamp\` TIMESTAMP NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updatedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE INDEX \`whatsapp_messages_wa_message_id_unique\` (\`waMessageId\`),
    INDEX \`idx_whatsapp_messages_conversation\` (\`conversationId\`),
    INDEX \`idx_whatsapp_messages_broadcast\` (\`broadcastId\`),
    INDEX \`idx_whatsapp_messages_status\` (\`status\`)
  )`,

  // ── 3. Broadcasts (um envio em massa de um template) ──
  `CREATE TABLE IF NOT EXISTS \`whatsapp_broadcasts\` (
    \`id\` INT NOT NULL AUTO_INCREMENT,
    \`templateName\` VARCHAR(128) NOT NULL,
    \`note\` TEXT NULL,
    \`createdById\` INT NULL,
    \`weekStart\` DATE NULL,
    \`totalCount\` INT NOT NULL DEFAULT 0,
    \`sentCount\` INT NOT NULL DEFAULT 0,
    \`failedCount\` INT NOT NULL DEFAULT 0,
    \`invalidEmployeeIds\` TEXT NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updatedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`)
  )`,

  // ── 4. Tokens single-use do formulário externo de disponibilidades ──
  `CREATE TABLE IF NOT EXISTS \`availability_form_tokens\` (
    \`id\` INT NOT NULL AUTO_INCREMENT,
    \`jti\` VARCHAR(64) NOT NULL,
    \`employeeId\` INT NOT NULL,
    \`weekStart\` VARCHAR(10) NOT NULL,
    \`expiresAt\` TIMESTAMP NOT NULL,
    \`usedAt\` TIMESTAMP NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE INDEX \`availability_form_tokens_jti_unique\` (\`jti\`),
    INDEX \`idx_availability_form_tokens_employee\` (\`employeeId\`)
  )`,
];

export const IDEMPOTENT_ERROR_CODES_0060 = new Set([
  "ER_TABLE_EXISTS_ERROR",
]);
