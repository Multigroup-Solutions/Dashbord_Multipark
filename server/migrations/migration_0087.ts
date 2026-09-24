// Migration 0087 — Passagem de turno: tabela no schema + integridade (24 set 2026).
//
// `shift_handovers` nascia em runtime (db.ts `ensureShiftHandoverTable`). Passa
// a ser criada aqui (e declarada em drizzle/schema.ts), com colunas novas:
//   - `createdById` / `createdByName`: autor ORIGINAL (o `filledBy*` passa a ser
//     só o último a editar). Registos antigos herdam o `filledBy*` que tinham
//     (é o melhor que existe — o autor original já tinha sido sobrescrito).
//   - `version`: lock otimista — cada gravação exige a versão carregada.
//
// Idempotente: CREATE TABLE IF NOT EXISTS; ADD COLUMN → ER_DUP_FIELDNAME
// quando já existe; o UPDATE só toca linhas sem autor.

export const MIGRATION_0087_NAME = "0087_shift_handovers_schema_integrity";

export const MIGRATION_0087_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `shift_handovers` ("
    + "`id` INT NOT NULL AUTO_INCREMENT,"
    + "`handoverDate` VARCHAR(10) NOT NULL,"
    + "`shift` VARCHAR(10) NOT NULL,"
    + "`city` VARCHAR(16) NOT NULL DEFAULT 'lisbon',"
    + "`carsForCovered` INT NULL,"
    + "`chargedUntilDate` VARCHAR(10) NULL,"
    + "`cashClosedInSafe` TINYINT NULL,"
    + "`checkoutCashDone` TINYINT NULL,"
    + "`frontPouchValue` DECIMAL(10,2) NULL,"
    + "`terminalPouchValue` DECIMAL(10,2) NULL,"
    + "`ticketsExpensesPaid` DECIMAL(10,2) NULL,"
    + "`mbRolls` INT NULL,"
    + "`mbRollsInPouch` INT NULL,"
    + "`pensInPouch` INT NULL,"
    + "`mbBattery` INT NULL,"
    + "`pdasCharged` TINYINT NULL,"
    + "`uniformsCount` INT NULL,"
    + "`clothingItems` TEXT NULL,"
    + "`notes` TEXT NULL,"
    + "`filledById` INT NULL,"
    + "`filledByName` VARCHAR(255) NULL,"
    + "`createdById` INT NULL,"
    + "`createdByName` VARCHAR(255) NULL,"
    + "`version` INT NOT NULL DEFAULT 1,"
    + "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,"
    + "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,"
    + "PRIMARY KEY (`id`),"
    + "UNIQUE INDEX `shift_handover_unique` (`handoverDate`, `shift`, `city`)"
    + ")",
  // Tabelas criadas antes da 0065 / desta migração
  "ALTER TABLE `shift_handovers` ADD COLUMN `clothingItems` TEXT NULL AFTER `uniformsCount`",
  "ALTER TABLE `shift_handovers` ADD COLUMN `createdById` INT NULL AFTER `filledByName`",
  "ALTER TABLE `shift_handovers` ADD COLUMN `createdByName` VARCHAR(255) NULL AFTER `createdById`",
  "ALTER TABLE `shift_handovers` ADD COLUMN `version` INT NOT NULL DEFAULT 1 AFTER `createdByName`",
  "UPDATE `shift_handovers` SET `createdById` = `filledById`, `createdByName` = `filledByName`, `updatedAt` = `updatedAt`"
    + " WHERE `createdById` IS NULL AND `createdByName` IS NULL AND (`filledById` IS NOT NULL OR `filledByName` IS NOT NULL)",
];

export const IDEMPOTENT_ERROR_CODES_0087 = new Set<string>(["ER_DUP_FIELDNAME"]);
