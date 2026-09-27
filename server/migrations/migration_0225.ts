// Migration 0225 — CRM fase 3: parceiros (agregadores/agências) e parques em
// que somos o agregador (Jorge, 27 set 2026).
//
// Os parceiros e os parques vêm AO VIVO da BD da Multipark
// (server/multiparkDb/partners.ts). Na nossa BD fica só o que é do CRM:
//  - crm_partner_links: por parceiro ("Partner".userId) ou parque ("Park".id),
//    a ligação ao registo nas Parcerias (partnerships.id), notas e contacto.
//
// Idempotente (corre em cada arranque via ensureRecentSchema).

export const MIGRATION_0225_NAME = "0225_crm_partner_links";

export const MIGRATION_0225_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `crm_partner_links` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`kind` VARCHAR(8) NOT NULL, " +
    "`mpId` VARCHAR(64) NOT NULL, " +
    "`partnershipId` INT NULL, " +
    "`notes` TEXT NULL, " +
    "`contactName` VARCHAR(255) NULL, " +
    "`contactEmail` VARCHAR(320) NULL, " +
    "`contactPhone` VARCHAR(40) NULL, " +
    "`updatedBy` INT NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_crm_partner_link` (`kind`, `mpId`), " +
    "KEY `idx_crm_partner_link_partnership` (`partnershipId`)" +
    ") ENGINE=InnoDB",
];

export const IDEMPOTENT_ERROR_CODES_0225 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME", "ER_DUP_FIELDNAME"]);
