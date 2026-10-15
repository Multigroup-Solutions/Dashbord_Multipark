// Migration 0605 — Multis 2 (Jorge, 8 out 2026): memória e 👍/👎.
//
//  - `assistant_memories`: notas que o Multis segue em todas as conversas.
//    scope 'user' (da própria pessoa, `userId`; até 30 ativas) ou 'company'
//    (userId NULL; só admin/super_admin; até 100 ativas). Arquivar = marcar
//    `archivedAt`/`archivedById`; nada se apaga.
//  - `assistant_feedback`: 👍/👎 da pessoa (auto = 0) e as marcas automáticas
//    das respostas que não responderam (auto = 1). Guarda CÓPIA da pergunta e
//    da resposta (as conversas apagam-se aos 30 dias; isto não). UNIQUE
//    (messageId, userId, auto): mudar de ideias atualiza a mesma linha.
//    "Marcar como tratada" = resolvedAt/resolvedById/resolvedNote.
//  - `ai_chat_messages.helpFiles` / `.path`: os ficheiros de ajuda usados e a
//    página onde se perguntou, guardados no turno (para o feedback).
//
// Só acrescenta; sem dados. Idempotente (CREATE TABLE IF NOT EXISTS; ADD
// COLUMN repetido dá ER_DUP_FIELDNAME).

export const MIGRATION_0605_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `assistant_memories` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`scope` VARCHAR(10) NOT NULL, " +
    "`userId` INT NULL, " +
    "`text` VARCHAR(300) NOT NULL, " +
    "`createdById` INT NOT NULL, " +
    "`createdAt` DATETIME(3) NOT NULL, " +
    "`archivedAt` DATETIME(3) NULL, " +
    "`archivedById` INT NULL, " +
    "PRIMARY KEY (`id`), " +
    "KEY `idx_assistant_memories_scope` (`scope`, `userId`, `archivedAt`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  "CREATE TABLE IF NOT EXISTS `assistant_feedback` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`messageId` BIGINT NOT NULL, " +
    "`conversationId` BIGINT NULL, " +
    "`userId` INT NOT NULL, " +
    "`rating` TINYINT NOT NULL, " +
    "`reason` VARCHAR(20) NULL, " +
    "`comment` VARCHAR(500) NULL, " +
    "`question` TEXT NULL, " +
    "`answer` TEXT NULL, " +
    "`path` VARCHAR(200) NULL, " +
    "`tools` VARCHAR(255) NULL, " +
    "`helpFiles` VARCHAR(255) NULL, " +
    "`auto` TINYINT NOT NULL DEFAULT 0, " +
    "`createdAt` DATETIME(3) NOT NULL, " +
    "`updatedAt` DATETIME(3) NOT NULL, " +
    "`resolvedAt` DATETIME(3) NULL, " +
    "`resolvedById` INT NULL, " +
    "`resolvedNote` VARCHAR(500) NULL, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_assistant_feedback_msg` (`messageId`, `userId`, `auto`), " +
    "KEY `idx_assistant_feedback_created` (`createdAt`), " +
    "KEY `idx_assistant_feedback_open` (`rating`, `resolvedAt`, `createdAt`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  "ALTER TABLE `ai_chat_messages` ADD COLUMN `helpFiles` VARCHAR(255) NULL AFTER `tools`",
  "ALTER TABLE `ai_chat_messages` ADD COLUMN `path` VARCHAR(200) NULL AFTER `helpFiles`",
];

export const IDEMPOTENT_ERROR_CODES_0605 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
