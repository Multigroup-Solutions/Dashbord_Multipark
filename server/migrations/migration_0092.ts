// Migration 0092 — Ocorrências + Perdidos (24 set 2026)
//
//  - Ocorrências: `driverConfirmed` (+ quem/quando) — só uma ocorrência com o
//    envolvimento do condutor CONFIRMADO conta pontos negativos na avaliação;
//    `dueAt` (SLA, 48h por omissão), `lastReminderAt`, `costAmount`.
//  - Conversões não destrutivas: estado 'converted' nas três tabelas
//    (incidents / lost_found_items / complaints) + ligação nos dois sentidos
//    (`convertedToType/Id`, `convertedFromType/Id`).
//  - Perdidos: `relatedComplaintId` (email para perdidos@ de um cliente com
//    reclamação aberta), `lastReminderAt`; condutores ligados ao caso com
//    `costAmount`, `points`, `pointsConfirmed`, `penaltyId`.
//
// Backfill (decisão): as ocorrências JÁ existentes com condutor e não
// descartadas ficam CONFIRMADAS — assim a avaliação não salta de repente. O
// truque para ser idempotente: a coluna nasce NULL, o UPDATE só mexe nas NULL e
// o MODIFY final torna-a NOT NULL DEFAULT 0 (nas corridas seguintes o UPDATE
// não encontra nada; ocorrências novas nascem 0 = por confirmar).
//
// Idempotente: ADD COLUMN → ER_DUP_FIELDNAME; ADD INDEX → ER_DUP_KEYNAME;
// MODIFY/UPDATE podem correr N vezes.

export const MIGRATION_0092_NAME = "0092_incidents_lostfound_fairness";

export const MIGRATION_0092_STATEMENTS: string[] = [
  // ── Ocorrências ──
  "ALTER TABLE `incidents` ADD COLUMN `driverConfirmed` TINYINT NULL",
  "UPDATE `incidents` SET `driverConfirmed` = IF(`employeeId` IS NOT NULL AND `status` <> 'dismissed', 1, 0) WHERE `driverConfirmed` IS NULL",
  "ALTER TABLE `incidents` MODIFY COLUMN `driverConfirmed` TINYINT NOT NULL DEFAULT 0",
  "ALTER TABLE `incidents` ADD COLUMN `driverConfirmedById` INT NULL",
  "ALTER TABLE `incidents` ADD COLUMN `driverConfirmedAt` TIMESTAMP NULL",
  "ALTER TABLE `incidents` ADD COLUMN `dueAt` TIMESTAMP NULL",
  "ALTER TABLE `incidents` ADD COLUMN `lastReminderAt` TIMESTAMP NULL",
  "ALTER TABLE `incidents` ADD COLUMN `costAmount` DECIMAL(10,2) NULL",
  "ALTER TABLE `incidents` ADD COLUMN `convertedToType` VARCHAR(16) NULL",
  "ALTER TABLE `incidents` ADD COLUMN `convertedToId` INT NULL",
  "ALTER TABLE `incidents` ADD COLUMN `convertedFromType` VARCHAR(16) NULL",
  "ALTER TABLE `incidents` ADD COLUMN `convertedFromId` INT NULL",
  "ALTER TABLE `incidents` MODIFY COLUMN `status` ENUM('open','investigating','resolved','dismissed','converted') NOT NULL DEFAULT 'open'",
  "UPDATE `incidents` SET `dueAt` = DATE_ADD(`createdAt`, INTERVAL 48 HOUR) WHERE `dueAt` IS NULL",
  "ALTER TABLE `incidents` ADD INDEX `idx_incidents_project` (`projectId`)",
  "ALTER TABLE `incidents` ADD INDEX `idx_incidents_employee` (`employeeId`)",
  "ALTER TABLE `incidents` ADD INDEX `idx_incidents_plate` (`vehiclePlate`)",

  // ── Perdidos ──
  "ALTER TABLE `lost_found_items` MODIFY COLUMN `status` ENUM('new','investigating','found','returned','closed','converted') NOT NULL DEFAULT 'new'",
  "ALTER TABLE `lost_found_items` ADD COLUMN `convertedToType` VARCHAR(16) NULL",
  "ALTER TABLE `lost_found_items` ADD COLUMN `convertedToId` INT NULL",
  "ALTER TABLE `lost_found_items` ADD COLUMN `convertedFromType` VARCHAR(16) NULL",
  "ALTER TABLE `lost_found_items` ADD COLUMN `convertedFromId` INT NULL",
  "ALTER TABLE `lost_found_items` ADD COLUMN `relatedComplaintId` INT NULL",
  "ALTER TABLE `lost_found_items` ADD COLUMN `lastReminderAt` TIMESTAMP NULL",
  "ALTER TABLE `lost_found_items` ADD INDEX `idx_lfi_booking` (`bookingRef`)",
  "ALTER TABLE `lost_found_items` ADD INDEX `idx_lfi_project` (`projectId`)",
  "ALTER TABLE `lost_found_attached_drivers` ADD COLUMN `costAmount` DECIMAL(10,2) NULL",
  "ALTER TABLE `lost_found_attached_drivers` ADD COLUMN `points` INT NOT NULL DEFAULT 0",
  "ALTER TABLE `lost_found_attached_drivers` ADD COLUMN `pointsConfirmed` TINYINT NOT NULL DEFAULT 0",
  "ALTER TABLE `lost_found_attached_drivers` ADD COLUMN `penaltyId` INT NULL",

  // ── Reclamações (só o necessário para as conversões) ──
  "ALTER TABLE `complaints` MODIFY COLUMN `complaint_status` ENUM('new','analyzing','waiting_client','resolved','closed','converted') NOT NULL DEFAULT 'new'",
  "ALTER TABLE `complaints` ADD COLUMN `convertedToType` VARCHAR(16) NULL",
  "ALTER TABLE `complaints` ADD COLUMN `convertedToId` INT NULL",
  "ALTER TABLE `complaints` ADD COLUMN `convertedFromType` VARCHAR(16) NULL",
  "ALTER TABLE `complaints` ADD COLUMN `convertedFromId` INT NULL",
];

export const IDEMPOTENT_ERROR_CODES_0092 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME", "ER_TABLE_EXISTS_ERROR"]);
