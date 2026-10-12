// Migration 0630 — Reclamações (lote 57; Jorge, 12 out 2026).
//
//  - complaints.origin: de onde veio a reclamação (email | ia | whatsapp |
//    critica | conversao | manual | api) — para o filtro "Origem" da página.
//    As novas gravam-na ao nascer; as antigas preenchem-se pelos sinais que já
//    existem (conversão, crítica Google, conversa de WhatsApp, email do
//    pipeline, criada por uma pessoa). Só onde ainda falta (idempotente; nunca
//    muda uma origem já escrita). As que não dão para saber ficam NULL
//    ("Sem origem registada").
//  - complaint_mail_intake: o que a IA decidiu quando viu uma reclamação num
//    email de OUTRA caixa (info@, reservas@…): criou, juntou a uma aberta,
//    sugeriu, ignorou (e porquê) ou falhou. UMA linha por conversa
//    (`threadId` UNIQUE) — a mesma conversa nunca gera duas reclamações, nem
//    quando o cron corre outra vez. Nada se apaga: "Não é reclamação" marca.
//
// Só acrescenta. ADD COLUMN / CREATE TABLE IF NOT EXISTS ignoram o que já existe.

export const MIGRATION_0630_STATEMENTS: string[] = [
  "ALTER TABLE `complaints` ADD COLUMN `origin` VARCHAR(16) NULL",
  // Preencher as antigas (pela ordem do sinal mais certo para o menos certo).
  "UPDATE `complaints` SET `origin` = 'conversao' WHERE `origin` IS NULL AND `convertedFromType` IS NOT NULL",
  "UPDATE `complaints` SET `origin` = 'critica' WHERE `origin` IS NULL AND `id` IN (SELECT g.`complaintId` FROM `google_reviews` g WHERE g.`complaintId` IS NOT NULL)",
  "UPDATE `complaints` SET `origin` = 'whatsapp' WHERE `origin` IS NULL AND `id` IN (SELECT w.`caseId` FROM `whatsapp_conversations` w WHERE w.`caseKind` = 'complaint' AND w.`caseId` IS NOT NULL)",
  "UPDATE `complaints` SET `origin` = 'email' WHERE `origin` IS NULL AND `createdById` IS NULL AND `id` IN (SELECT e.`targetId` FROM `inbound_emails` e WHERE e.`targetModule` = 'complaint' AND e.`targetId` IS NOT NULL)",
  "UPDATE `complaints` SET `origin` = 'manual' WHERE `origin` IS NULL AND `createdById` IS NOT NULL",
  "CREATE TABLE IF NOT EXISTS `complaint_mail_intake` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`threadId` INT NOT NULL, " +
    "`messageId` INT NULL, " +
    "`fromBoxKey` VARCHAR(40) NULL, " +
    "`aiBoxKey` VARCHAR(40) NULL, " +
    "`confidence` DECIMAL(4,3) NULL, " +
    "`reason` VARCHAR(300) NULL, " +
    "`status` VARCHAR(12) NOT NULL DEFAULT 'pending', " +
    "`skipReason` VARCHAR(32) NULL, " +
    "`complaintId` INT NULL, " +
    "`projectId` INT NULL, " +
    "`attempts` INT NOT NULL DEFAULT 0, " +
    "`error` VARCHAR(300) NULL, " +
    "`decidedById` INT NULL, " +
    "`decidedAt` DATETIME NULL, " +
    "`dismissReason` VARCHAR(255) NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_complaint_mail_intake_thread` (`threadId`), " +
    "KEY `idx_complaint_mail_intake_status` (`status`, `createdAt`), " +
    "KEY `idx_complaint_mail_intake_complaint` (`complaintId`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
];

export const IDEMPOTENT_ERROR_CODES_0630 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME", "ER_TABLE_EXISTS_ERROR"]);
