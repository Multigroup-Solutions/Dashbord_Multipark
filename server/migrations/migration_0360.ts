// Migration 0360 — Comunicação (email): envio sem duplicar e casos que não se
// perdem (P3 lote 17d, out 2026).
//  1. `mail_send_requests`: cada envio do editor leva um código (o ecrã gera-o)
//     que fica reservado ANTES de falar com o Gmail. Carregar outra vez em
//     Enviar (erro a meio, rede que caiu) devolve o resultado do primeiro
//     envio em vez de mandar outro email ao cliente. "unknown" = o Gmail não
//     respondeu: pode ter saído — não se volta a enviar sozinho.
//  2. `mail_messages.pipelineAttempts` / `pipelineError`: um email que devia
//     criar uma reclamação (perdido, crítica…) e falhou a meio fica marcado e
//     volta a ser tentado nas corridas seguintes (antes perdia-se).
//  3. `archivedAt` em mail_messages e mail_threads: a retenção (+5 anos, sem
//     ligação) deixa de APAGAR — arquiva. Ficam guardados e só o super admin
//     os vê, a pedido (decisão do Jorge, 2 out 2026).
// Idempotente: CREATE TABLE/ADD COLUMN/ADD KEY ignoram o que já existe.
export const MIGRATION_0360_NAME = "0360_mail_send_requests_pipeline_retry_archive";

export const MIGRATION_0360_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `mail_send_requests` ("
    + " `id` INT NOT NULL AUTO_INCREMENT,"
    + " `requestId` VARCHAR(64) NOT NULL,"
    + " `userId` INT NOT NULL,"
    + " `status` ENUM('sending','sent','unknown','failed') NOT NULL DEFAULT 'sending',"
    + " `gmailMessageId` VARCHAR(32) NULL,"
    + " `threadId` INT NULL,"
    + " `errorDetail` VARCHAR(500) NULL,"
    + " `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,"
    + " `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,"
    + " PRIMARY KEY (`id`),"
    + " UNIQUE KEY `uq_mail_send_requests_request` (`requestId`)"
    + ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  "ALTER TABLE `mail_messages` ADD COLUMN `pipelineAttempts` TINYINT NOT NULL DEFAULT 0",
  "ALTER TABLE `mail_messages` ADD COLUMN `pipelineError` VARCHAR(300) NULL",
  "ALTER TABLE `mail_messages` ADD COLUMN `archivedAt` DATETIME NULL",
  "ALTER TABLE `mail_threads` ADD COLUMN `archivedAt` DATETIME NULL",
];
// Sem índice novo: as consultas dos casos falhados vão pela data (idx_mail_messages_sent),
// e um ADD KEY numa tabela grande no arranque da função não vale o risco.

export const IDEMPOTENT_ERROR_CODES_0360 = new Set<string>(["ER_DUP_FIELDNAME", "ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME"]);
