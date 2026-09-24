// Migration 0090 — Formação: percursos obrigatórios, progresso, tentativas
// servidas pelo servidor, promoções e certificados (24 set 2026).
//
//  - Correções: `careerLevel` em training_videos/training_manuals (o schema já
//    o declarava mas nenhuma migration o criava) e training_manuals.type passa
//    a VARCHAR (as migrations drizzle definiam ENUM sem 'link').
//  - quiz_questions: `published` (rascunhos gerados por IA) + `sourceManualId`.
//  - career_exams: `validityMonths` (validade do certificado) e
//    `maxAttemptsPerDay`.
//  - employees.careerLevel: nível de carreira aprovado (condutor_2, front_1…).
//  - Tabelas novas: training_paths, training_path_items, training_assignments,
//    training_progress, training_attempt_sessions, training_promotions,
//    training_certificates.
//
// Idempotente: CREATE TABLE IF NOT EXISTS; ADD COLUMN → ER_DUP_FIELDNAME;
// ADD INDEX → ER_DUP_KEYNAME; MODIFY para VARCHAR pode correr N vezes.

export const MIGRATION_0090_NAME = "0090_training_paths_assignments";

export const MIGRATION_0090_STATEMENTS: string[] = [
  "ALTER TABLE `training_videos` ADD COLUMN `careerLevel` VARCHAR(32) NULL",
  "ALTER TABLE `training_manuals` ADD COLUMN `careerLevel` VARCHAR(32) NULL",
  "ALTER TABLE `training_manuals` MODIFY COLUMN `type` VARCHAR(32) NOT NULL DEFAULT 'manual'",
  "ALTER TABLE `quiz_questions` ADD COLUMN `published` TINYINT NOT NULL DEFAULT 1",
  "ALTER TABLE `quiz_questions` ADD COLUMN `sourceManualId` INT NULL",
  "ALTER TABLE `career_exams` ADD COLUMN `validityMonths` INT NOT NULL DEFAULT 12",
  "ALTER TABLE `career_exams` ADD COLUMN `maxAttemptsPerDay` INT NOT NULL DEFAULT 3",
  "ALTER TABLE `employees` ADD COLUMN `careerLevel` VARCHAR(32) NULL",

  "CREATE TABLE IF NOT EXISTS `training_paths` ("
    + "`id` INT NOT NULL AUTO_INCREMENT,"
    + "`name` VARCHAR(255) NOT NULL,"
    + "`description` TEXT NULL,"
    + "`targetRole` VARCHAR(32) NULL,"
    + "`city` VARCHAR(16) NULL,"
    + "`active` TINYINT NOT NULL DEFAULT 1,"
    + "`isDefaultOnboarding` TINYINT NOT NULL DEFAULT 0,"
    + "`blocksEscala` TINYINT NOT NULL DEFAULT 1,"
    + "`dueDays` INT NOT NULL DEFAULT 7,"
    + "`createdById` INT NULL,"
    + "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,"
    + "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,"
    + "PRIMARY KEY (`id`)"
    + ")",
  "CREATE TABLE IF NOT EXISTS `training_path_items` ("
    + "`id` INT NOT NULL AUTO_INCREMENT,"
    + "`pathId` INT NOT NULL,"
    + "`itemType` VARCHAR(16) NOT NULL,"
    + "`itemId` INT NOT NULL,"
    + "`sortOrder` INT NOT NULL DEFAULT 0,"
    + "`required` TINYINT NOT NULL DEFAULT 1,"
    + "PRIMARY KEY (`id`),"
    + "INDEX `training_path_items_path_idx` (`pathId`)"
    + ")",
  "CREATE TABLE IF NOT EXISTS `training_assignments` ("
    + "`id` INT NOT NULL AUTO_INCREMENT,"
    + "`employeeId` INT NOT NULL,"
    + "`pathId` INT NOT NULL,"
    + "`status` VARCHAR(16) NOT NULL DEFAULT 'assigned',"
    + "`dueAt` DATETIME NULL,"
    + "`assignedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,"
    + "`completedAt` DATETIME NULL,"
    + "`assignedById` INT NULL,"
    + "`source` VARCHAR(32) NULL,"
    + "`lastReminderAt` DATETIME NULL,"
    + "`escalatedAt` DATETIME NULL,"
    + "PRIMARY KEY (`id`),"
    + "UNIQUE INDEX `training_assignments_emp_path` (`employeeId`, `pathId`),"
    + "INDEX `training_assignments_status_idx` (`status`)"
    + ")",
  "CREATE TABLE IF NOT EXISTS `training_progress` ("
    + "`id` INT NOT NULL AUTO_INCREMENT,"
    + "`employeeId` INT NOT NULL,"
    + "`itemType` VARCHAR(16) NOT NULL,"
    + "`itemId` INT NOT NULL,"
    + "`viewedAt` DATETIME NULL,"
    + "`completedAt` DATETIME NULL,"
    + "`seconds` INT NOT NULL DEFAULT 0,"
    + "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,"
    + "PRIMARY KEY (`id`),"
    + "UNIQUE INDEX `training_progress_unique` (`employeeId`, `itemType`, `itemId`)"
    + ")",
  "CREATE TABLE IF NOT EXISTS `training_attempt_sessions` ("
    + "`id` INT NOT NULL AUTO_INCREMENT,"
    + "`employeeId` INT NOT NULL,"
    + "`kind` VARCHAR(8) NOT NULL,"
    + "`examId` INT NULL,"
    + "`categoryId` INT NULL,"
    + "`questionIds` TEXT NOT NULL,"
    + "`startedAt` DATETIME NOT NULL,"
    + "`deadlineAt` DATETIME NULL,"
    + "`submittedAt` DATETIME NULL,"
    + "`resultId` INT NULL,"
    + "`score` INT NULL,"
    + "`passed` TINYINT NULL,"
    + "PRIMARY KEY (`id`),"
    + "INDEX `training_attempt_sessions_emp_idx` (`employeeId`, `kind`, `startedAt`)"
    + ")",
  "CREATE TABLE IF NOT EXISTS `training_promotions` ("
    + "`id` INT NOT NULL AUTO_INCREMENT,"
    + "`employeeId` INT NOT NULL,"
    + "`examId` INT NOT NULL,"
    + "`attemptId` INT NULL,"
    + "`level` VARCHAR(32) NOT NULL,"
    + "`score` INT NULL,"
    + "`status` VARCHAR(16) NOT NULL DEFAULT 'pending',"
    + "`requestedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,"
    + "`decidedAt` DATETIME NULL,"
    + "`decidedById` INT NULL,"
    + "`note` VARCHAR(500) NULL,"
    + "`certificateId` INT NULL,"
    + "PRIMARY KEY (`id`),"
    + "INDEX `training_promotions_status_idx` (`status`)"
    + ")",
  "CREATE TABLE IF NOT EXISTS `training_certificates` ("
    + "`id` INT NOT NULL AUTO_INCREMENT,"
    + "`employeeId` INT NOT NULL,"
    + "`examId` INT NOT NULL,"
    + "`level` VARCHAR(32) NOT NULL,"
    + "`issuedAt` DATETIME NOT NULL,"
    + "`validUntil` DATE NULL,"
    + "`fileKey` VARCHAR(512) NULL,"
    + "`fileUrl` TEXT NULL,"
    + "`promotionId` INT NULL,"
    + "`recertAssignedAt` DATETIME NULL,"
    + "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,"
    + "PRIMARY KEY (`id`),"
    + "INDEX `training_certificates_emp_idx` (`employeeId`)"
    + ")",
];

export const IDEMPOTENT_ERROR_CODES_0090 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME", "ER_TABLE_EXISTS_ERROR"]);
