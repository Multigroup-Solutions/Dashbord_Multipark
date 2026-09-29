// Migration 0130 — Assistente (chat da equipa): conversas e mensagens (24 set 2026)
//
//  - ai_chat_conversations: uma conversa por pessoa (ou, no futuro chat
//    público, por visitante: `ownerKey` = "user:<id>" ou "ip:<hash>") e canal
//    ("staff" | "public").
//  - ai_chat_messages: pergunta/resposta (texto) + nomes das ferramentas
//    usadas (nunca os resultados). Retenção: 30 dias (daily-ops apaga; as
//    leituras já ignoram o que é mais antigo).
//
// Idempotente (corre em cada arranque via ensureRecentSchema): só CREATE
// TABLE IF NOT EXISTS. Sem UPDATEs.

export const MIGRATION_0130_NAME = "0130_ai_chat";

export const MIGRATION_0130_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `ai_chat_conversations` (" +
    "`id` BIGINT NOT NULL AUTO_INCREMENT, " +
    "`channel` VARCHAR(16) NOT NULL, " +
    "`ownerKey` VARCHAR(80) NOT NULL, " +
    "`userId` INT NULL, " +
    "`title` VARCHAR(120) NULL, " +
    "`createdAt` DATETIME(3) NOT NULL, " +
    "`updatedAt` DATETIME(3) NOT NULL, " +
    "PRIMARY KEY (`id`), " +
    "INDEX `idx_ai_chat_conv_owner` (`channel`, `ownerKey`, `updatedAt`), " +
    "INDEX `idx_ai_chat_conv_updated` (`updatedAt`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS `ai_chat_messages` (" +
    "`id` BIGINT NOT NULL AUTO_INCREMENT, " +
    "`conversationId` BIGINT NOT NULL, " +
    "`role` VARCHAR(12) NOT NULL, " +
    "`content` TEXT NOT NULL, " +
    "`tools` VARCHAR(255) NULL, " +
    "`createdAt` DATETIME(3) NOT NULL, " +
    "PRIMARY KEY (`id`), " +
    "INDEX `idx_ai_chat_msg_conv` (`conversationId`, `id`), " +
    "INDEX `idx_ai_chat_msg_created` (`createdAt`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
];

export const IDEMPOTENT_ERROR_CODES_0130 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME", "ER_DUP_FIELDNAME"]);
