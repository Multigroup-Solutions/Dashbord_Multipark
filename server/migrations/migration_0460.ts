// Migration 0460 — RH (P3 lote 24f, Jorge, 3 out 2026):
//  - D39: os anexos dos emails do RH passam pela IA (interruptor
//    AI_HR_EMAIL_ATTACHMENTS, desligado por omissão). Cada anexo lido fica em
//    `rh_attachment_reads` (uma vez por anexo); o candidato (`extra_leads`)
//    ganha NIF, n.º do BI/CC, n.º da carta, resumo para quem entrevista; a
//    ficha do colaborador ganha o n.º do BI/CC e da carta (copiados ao
//    converter, só se vazios).
// Só cria/acrescenta (nada se apaga). Idempotente.
export const MIGRATION_0460_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `rh_attachment_reads` (" +
    "`id` INT AUTO_INCREMENT PRIMARY KEY, " +
    "`inboundEmailId` INT NOT NULL, " +
    "`attachmentIndex` INT NOT NULL, " +
    "`filename` VARCHAR(255) NULL, " +
    "`leadId` INT NULL, " +
    "`status` VARCHAR(16) NOT NULL, " +
    "`reason` VARCHAR(255) NULL, " +
    "`docKind` VARCHAR(24) NULL, " +
    "`extractedJson` TEXT NULL, " +
    "`summary` TEXT NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "UNIQUE KEY `uq_rh_attachment_reads` (`inboundEmailId`, `attachmentIndex`), " +
    "KEY `idx_rh_attachment_reads_lead` (`leadId`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  "ALTER TABLE `extra_leads` ADD COLUMN `nif` VARCHAR(16) NULL",
  "ALTER TABLE `extra_leads` ADD COLUMN `idDocNumber` VARCHAR(32) NULL",
  "ALTER TABLE `extra_leads` ADD COLUMN `drivingLicenseNumber` VARCHAR(32) NULL",
  "ALTER TABLE `extra_leads` ADD COLUMN `aiSummary` TEXT NULL",
  "ALTER TABLE `extra_leads` ADD COLUMN `aiReadAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `employees` ADD COLUMN `idDocNumber` VARCHAR(32) NULL",
  "ALTER TABLE `employees` ADD COLUMN `drivingLicenseNumber` VARCHAR(32) NULL",
];

export const IDEMPOTENT_ERROR_CODES_0460 = new Set<string>(["ER_DUP_FIELDNAME"]);
