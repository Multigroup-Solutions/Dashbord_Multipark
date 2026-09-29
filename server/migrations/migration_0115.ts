// Migration 0115 — Escala automática do Extras-dia (24 set 2026)
//
//  - extras_dia_assignments.status: 'proposed' (proposta automática, ainda por
//    confirmar) | 'confirmed'. As linhas que já existem ficam 'confirmed'
//    (DEFAULT) — o comportamento antigo (escala manual + aviso) não muda.
//  - extras_dia_assignments.version: sobe quando muda a pessoa, o dia ou as
//    horas; os avisos são 1 por (linha, versão, canal).
//  - extras_dia_assignments.proposalReason: o "porquê" da proposta.
//  - extras_dia_schedules: estado da escala por (dia, cidade) — proposta /
//    confirmada, "suspender envio automático", buracos e resumo.
//  - extras_dia_notifications: registo (e deduplicação) dos avisos enviados
//    por WhatsApp e email, "escalado" e "removido".
//
// Corre em CADA arranque (ensureRecentSchema): ADD COLUMN → ER_DUP_FIELDNAME,
// ADD INDEX → ER_DUP_KEYNAME, CREATE TABLE IF NOT EXISTS. Sem UPDATEs.

export const MIGRATION_0115_NAME = "0115_extras_schedule_proposals";

export const MIGRATION_0115_STATEMENTS: string[] = [
  "ALTER TABLE `extras_dia_assignments` ADD COLUMN `status` VARCHAR(12) NOT NULL DEFAULT 'confirmed'",
  "ALTER TABLE `extras_dia_assignments` ADD COLUMN `version` INT NOT NULL DEFAULT 1",
  "ALTER TABLE `extras_dia_assignments` ADD COLUMN `proposalReason` VARCHAR(500) NULL",
  "ALTER TABLE `extras_dia_assignments` ADD INDEX `idx_extras_dia_date_city_status` (`assignmentDate`, `city`, `status`)",
  "CREATE TABLE IF NOT EXISTS `extras_dia_schedules` (" +
    "`assignmentDate` VARCHAR(10) NOT NULL, " +
    "`city` VARCHAR(16) NOT NULL, " +
    "`status` VARCHAR(12) NOT NULL DEFAULT 'proposed', " +
    "`holdAuto` TINYINT NOT NULL DEFAULT 0, " +
    "`proposedAt` TIMESTAMP NULL, " +
    "`proposedBy` VARCHAR(8) NULL, " +
    "`proposedById` INT NULL, " +
    "`confirmedAt` TIMESTAMP NULL, " +
    "`confirmedBy` VARCHAR(8) NULL, " +
    "`confirmedById` INT NULL, " +
    "`gapsJson` TEXT NULL, " +
    "`summary` VARCHAR(1000) NULL, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`assignmentDate`, `city`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS `extras_dia_notifications` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`assignmentId` INT NOT NULL, " +
    "`version` INT NOT NULL, " +
    "`kind` VARCHAR(12) NOT NULL, " +
    "`channel` VARCHAR(12) NOT NULL, " +
    "`employeeId` INT NULL, " +
    "`assignmentDate` VARCHAR(10) NOT NULL, " +
    "`city` VARCHAR(16) NOT NULL, " +
    "`status` VARCHAR(12) NOT NULL, " +
    "`attempts` INT NOT NULL DEFAULT 0, " +
    "`detail` VARCHAR(300) NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_edn_version` (`assignmentId`, `version`, `kind`, `channel`), " +
    "KEY `idx_edn_date_city` (`assignmentDate`, `city`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
];

export const IDEMPOTENT_ERROR_CODES_0115 = new Set<string>([
  "ER_DUP_FIELDNAME",
  "ER_DUP_KEYNAME",
  "ER_TABLE_EXISTS_ERROR",
]);
