// Migration 0530 — RH (Frente A, Jorge, 7 out 2026):
//  - Documentos da ficha com estado: pendente (entregue pela pessoa / team
//    leader), validado (pelo RH, ou carregado pelo RH) ou recusado (motivo).
//    Substituir/apagar passa a ARQUIVAR (como as tarefas, 0376).
//  - Carta de condução: data de emissão e a validação do RH na ficha (e a
//    data declarada na candidatura, no lead) — "Carta validada" = validada
//    pelo RH e com 3 anos completos (shared/drivingLicence.ts).
// Os documentos que já existiam ficam VALIDADOS (uma vez, com marca em
// `app_notification_maintenance`; não inundar o RH). Só acrescenta;
// idempotente; nada se apaga.

export const SEED_0530_ID = "0530_employee_documents_validated";

const once = "NOT EXISTS (SELECT 1 FROM `app_notification_maintenance` mk WHERE mk.`id` = '" + SEED_0530_ID + "')";

export const MIGRATION_0530_STATEMENTS: string[] = [
  "ALTER TABLE `employee_documents` ADD COLUMN `status` ENUM('pending','validated','rejected') NOT NULL DEFAULT 'pending'",
  "ALTER TABLE `employee_documents` ADD COLUMN `validatedById` INT NULL",
  "ALTER TABLE `employee_documents` ADD COLUMN `validatedAt` DATETIME NULL",
  "ALTER TABLE `employee_documents` ADD COLUMN `rejectedReason` VARCHAR(300) NULL",
  "ALTER TABLE `employee_documents` ADD COLUMN `archivedAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `employee_documents` ADD COLUMN `archivedById` INT NULL",
  "ALTER TABLE `employee_documents` ADD INDEX `idx_employee_documents_emp_type_status` (`employeeId`, `docType`, `status`)",
  // Backfill: os documentos antigos ficam validados (uma vez; a data é a do carregamento).
  "UPDATE `employee_documents` SET `status` = 'validated', `validatedAt` = `createdAt` WHERE `status` = 'pending' AND `validatedAt` IS NULL AND " + once,
  "INSERT IGNORE INTO `app_notification_maintenance` (`id`) VALUES ('" + SEED_0530_ID + "')",
  "ALTER TABLE `employees` ADD COLUMN `drivingLicenseIssuedAt` DATE NULL",
  "ALTER TABLE `employees` ADD COLUMN `drivingLicenseValidatedAt` DATETIME NULL",
  "ALTER TABLE `employees` ADD COLUMN `drivingLicenseValidatedById` INT NULL",
  "ALTER TABLE `extra_leads` ADD COLUMN `drivingLicenseIssuedAt` DATE NULL",
];

export const IDEMPOTENT_ERROR_CODES_0530 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
