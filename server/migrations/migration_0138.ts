// Migration 0138 — Tutor da Formação (IA): histórico curto e perguntas frequentes (24 set 2026)
//
//  - training_tutor_messages: últimas conversas de cada formando com o tutor,
//    por módulo (contextType + contextId). O texto do formando é guardado JÁ
//    SEM dados pessoais (redactPii). Apagado ao fim de 30 dias (limpeza
//    oportunista em server/trainingTutorStore.ts).
//  - training_tutor_questions: agregado anónimo (sem userId) das perguntas por
//    módulo — os formadores veem o que se pergunta mais para melhorar os
//    manuais. Texto também já sem dados pessoais.
//
// Idempotente (corre em cada arranque via ensureRecentSchema): só CREATE
// TABLE IF NOT EXISTS. Sem UPDATEs.

export const MIGRATION_0138_NAME = "0138_training_tutor";

export const MIGRATION_0138_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `training_tutor_messages` (" +
    "`id` BIGINT NOT NULL AUTO_INCREMENT, " +
    "`userId` INT NOT NULL, " +
    "`employeeId` INT NULL, " +
    "`contextType` VARCHAR(8) NOT NULL, " +
    "`contextId` INT NOT NULL, " +
    "`role` VARCHAR(10) NOT NULL, " +
    "`content` TEXT NOT NULL, " +
    "`outOfContent` TINYINT NOT NULL DEFAULT 0, " +
    "`createdAt` DATETIME NOT NULL, " +
    "PRIMARY KEY (`id`), " +
    "INDEX `idx_tt_messages_user_ctx` (`userId`, `contextType`, `contextId`, `createdAt`), " +
    "INDEX `idx_tt_messages_created` (`createdAt`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS `training_tutor_questions` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`contextType` VARCHAR(8) NOT NULL, " +
    "`contextId` INT NOT NULL, " +
    "`questionKey` VARCHAR(191) NOT NULL, " +
    "`sampleText` VARCHAR(500) NOT NULL, " +
    "`askCount` INT NOT NULL DEFAULT 0, " +
    "`outOfContentCount` INT NOT NULL DEFAULT 0, " +
    "`firstAskedAt` DATETIME NOT NULL, " +
    "`lastAskedAt` DATETIME NOT NULL, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE INDEX `uq_tt_questions_ctx_key` (`contextType`, `contextId`, `questionKey`), " +
    "INDEX `idx_tt_questions_last` (`lastAskedAt`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
];

export const IDEMPOTENT_ERROR_CODES_0138 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME", "ER_DUP_FIELDNAME"]);
