// Migration 0535 — RH (Frente A, Jorge, 7 out 2026: "Os extras devem ter
// notas internas (ex. este extra trabalhou mal no dia ...)"): notas internas
// por ficha, do team leader para cima (a própria pessoa nunca as vê — regras
// em server/rhAccess.ts). Opcionalmente presas a um dia de trabalho e à linha
// da escala do Extras-dia. "Apagar" = arquivar. Só cria; idempotente.
export const MIGRATION_0535_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `employee_notes` (" +
    "`id` INT AUTO_INCREMENT PRIMARY KEY, " +
    "`employeeId` INT NOT NULL, " +
    "`body` TEXT NOT NULL, " +
    "`kind` VARCHAR(16) NOT NULL DEFAULT 'general', " +
    "`workDate` VARCHAR(10) NULL, " +
    "`assignmentId` INT NULL, " +
    "`authorId` INT NOT NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`editedAt` TIMESTAMP NULL DEFAULT NULL, " +
    "`archivedAt` TIMESTAMP NULL DEFAULT NULL, " +
    "`archivedById` INT NULL, " +
    "KEY `idx_employee_notes_emp_created` (`employeeId`, `createdAt`), " +
    "KEY `idx_employee_notes_assignment` (`assignmentId`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
];

export const IDEMPOTENT_ERROR_CODES_0535 = new Set<string>(["ER_TABLE_EXISTS_ERROR"]);
