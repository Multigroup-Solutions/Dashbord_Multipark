// Migration 0595 — a IA separa emails e WhatsApp pelas caixas (lote 41 ponto 13 +
// decisão do Jorge, 8 out 2026: "a IA vê os e-mails que entram nas caixas
// partilhadas e age sozinha… divide-os pelas caixas, sem ler; o que não
// perceber vai para o info. No WhatsApp o mesmo; recrutamento em 1.º contacto
// cria o candidato").
//
// `comms_ai_routing`: o registo do que a IA decidiu — UMA linha por mensagem de
// email (sourceRef "mail_message:<id>") ou por conversa de WhatsApp
// ("whatsapp_conversation:<id>"); o índice UNIQUE garante que nunca se
// classifica duas vezes. Guarda a caixa de onde veio, o que a IA disse, a caixa
// aplicada (info quando não percebeu ou falhou), confiança e motivo, o que se
// fez no recrutamento (lead/candidatura) e quem corrigiu depois (mover à mão).
// Nada se apaga: é histórico. Só cria; idempotente (ER_TABLE_EXISTS_ERROR).
export const MIGRATION_0595_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `comms_ai_routing` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`channel` VARCHAR(10) NOT NULL, " +
    "`sourceRef` VARCHAR(64) NOT NULL, " +
    "`threadId` INT NULL, " +
    "`messageId` INT NULL, " +
    "`conversationId` INT NULL, " +
    "`fromBoxKey` VARCHAR(40) NULL, " +
    "`aiBoxKey` VARCHAR(40) NULL, " +
    "`boxKey` VARCHAR(40) NULL, " +
    "`confidence` DECIMAL(4,3) NULL, " +
    "`reason` VARCHAR(300) NULL, " +
    "`via` VARCHAR(12) NOT NULL DEFAULT 'ai', " +
    "`status` VARCHAR(12) NOT NULL DEFAULT 'pending', " +
    "`error` VARCHAR(200) NULL, " +
    "`candidateJson` TEXT NULL, " +
    "`recruitOutcome` VARCHAR(16) NULL, " +
    "`leadId` INT NULL, " +
    "`applicationId` INT NULL, " +
    "`correctedBoxKey` VARCHAR(40) NULL, " +
    "`correctedById` INT NULL, " +
    "`correctedAt` DATETIME NULL, " +
    "`decidedAt` DATETIME NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_comms_ai_routing_ref` (`sourceRef`), " +
    "KEY `idx_comms_ai_routing_thread` (`threadId`), " +
    "KEY `idx_comms_ai_routing_conv` (`conversationId`), " +
    "KEY `idx_comms_ai_routing_status` (`status`, `createdAt`), " +
    "KEY `idx_comms_ai_routing_lead` (`leadId`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
];

export const IDEMPOTENT_ERROR_CODES_0595 = new Set<string>(["ER_TABLE_EXISTS_ERROR"]);
