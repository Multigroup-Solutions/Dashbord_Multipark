// Migration 0335 — Extras Dia: nada se perde na escala (P3 lote 15c, out 2026).
//  1. `source` ('auto' | 'manual'): refazer a proposta automática só substitui
//     as linhas que ELA criou — antes apagava também quem tinha sido posto à mão
//     num dia com proposta por confirmar.
//  2. `updatedById`: quem alterou a linha por último (quem criou já existia).
//  3. Linhas que saem da escala (removidas à mão ou substituídas por uma nova
//     proposta) vão para `extras_dia_assignments_removed`, com a linha inteira,
//     quem, quando e porquê — antes eram apagadas de vez.
//  4. "Suspender" num dia sem escala criava o estado 'proposed' sem proposta:
//     o cron nunca mais propunha esse dia. Esses estados passam a 'hold'.
// Idempotente: ADD COLUMN/CREATE TABLE ignoram o que já existe; os UPDATE só
// mexem no que ainda está por marcar.
export const MIGRATION_0335_NAME = "0335_extras_dia_source_removed_hold";

export const MIGRATION_0335_STATEMENTS: string[] = [
  "ALTER TABLE `extras_dia_assignments` ADD COLUMN `source` VARCHAR(8) NOT NULL DEFAULT 'manual'",
  "ALTER TABLE `extras_dia_assignments` ADD COLUMN `updatedById` INT NULL",
  // Linhas da proposta automática ainda não tocadas por ninguém.
  "UPDATE `extras_dia_assignments` SET `source` = 'auto' WHERE `source` = 'manual' AND `proposalReason` IS NOT NULL AND `updatedById` IS NULL AND `notes` = 'proposta automática'",
  "CREATE TABLE IF NOT EXISTS `extras_dia_assignments_removed` ("
    + " `id` INT NOT NULL AUTO_INCREMENT,"
    + " `assignmentId` INT NOT NULL,"
    + " `assignmentDate` VARCHAR(10) NOT NULL,"
    + " `city` VARCHAR(16) NOT NULL,"
    + " `employeeId` INT NULL,"
    + " `personName` VARCHAR(128) NOT NULL,"
    + " `isTeamLeader` TINYINT NOT NULL DEFAULT 0,"
    + " `shift` VARCHAR(8) NOT NULL,"
    + " `startHour` INT NOT NULL,"
    + " `endHour` INT NOT NULL,"
    + " `status` VARCHAR(12) NOT NULL,"
    + " `version` INT NOT NULL DEFAULT 1,"
    + " `rowJson` TEXT NOT NULL,"
    + " `removedReason` VARCHAR(32) NOT NULL,"
    + " `removedById` INT NULL,"
    + " `removedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,"
    + " PRIMARY KEY (`id`),"
    + " KEY `idx_extras_removed_date_city` (`assignmentDate`, `city`),"
    + " KEY `idx_extras_removed_assignment` (`assignmentId`)"
    + ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  // "Suspender" sem proposta: não é uma proposta (proposedAt nunca foi preenchido).
  "UPDATE `extras_dia_schedules` SET `status` = 'hold' WHERE `status` = 'proposed' AND `proposedAt` IS NULL",
];

export const IDEMPOTENT_ERROR_CODES_0335 = new Set<string>(["ER_DUP_FIELDNAME", "ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME"]);
