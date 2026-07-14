// Migration 0056 — Candidaturas de condutores vindas do website multidriver.
// O formulário "Be a Driver" do site passa a enviar cada candidatura também para
// aqui (além do Google Sheets). Email é a chave de identidade: UNIQUE garante
// que re-submissões actualizam a candidatura existente em vez de duplicar.

export const MIGRATION_0056_NAME = "0056_driver_applications";

export const MIGRATION_0056_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS \`driver_applications\` (
    \`id\` INT NOT NULL AUTO_INCREMENT,
    \`email\` VARCHAR(320) NOT NULL,
    \`fullName\` VARCHAR(256) NOT NULL,
    \`phone\` VARCHAR(32) NULL,
    \`city\` VARCHAR(128) NULL,
    \`country\` VARCHAR(64) NULL,
    \`nif\` VARCHAR(20) NULL,
    \`drivingExperience\` VARCHAR(64) NULL,
    \`expectedHourlyRate\` VARCHAR(32) NULL,
    \`howDidYouKnow\` VARCHAR(64) NULL,
    \`status\` ENUM('new','reviewed','approved','rejected') NOT NULL DEFAULT 'new',
    \`employeeId\` INT NULL,
    \`payload\` JSON NULL,
    \`submissionCount\` INT NOT NULL DEFAULT 1,
    \`lastSubmittedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`reviewedById\` INT NULL,
    \`reviewedAt\` TIMESTAMP NULL,
    \`notes\` VARCHAR(512) NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updatedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`driver_applications_email_unique\` (\`email\`),
    KEY \`idx_driver_applications_status\` (\`status\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

export const IDEMPOTENT_ERROR_CODES_0056 = new Set([
  "ER_TABLE_EXISTS_ERROR",
  "ER_DUP_KEYNAME",
  "ER_DUP_FIELDNAME",
]);
