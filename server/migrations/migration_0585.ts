// Migration 0585 — entrada de candidatos e de quem volta (49c, Jorge, 8 out 2026).
//
//  - `employees.comebackRequestedAt`: quando a pessoa INATIVA carregou em
//    "Voltei, quero trabalhar" (ecrã "A minha ficha" / Disponibilidade). O RH
//    vê "Quer voltar" e decide se reativa. Reativar limpa-a.
//  - `account_link_requests`: pedidos "Liga a tua conta" — quem entrou com uma
//    conta Google sem ficha diz com que email/telefone se candidatou ou
//    trabalhou connosco (kind = "link"), e os possíveis duplicados que o
//    próprio candidato cria ao gravar telefone/NIF (kind = "duplicate").
//    Estado: pending / confirmed / rejected / expired. O código enviado por
//    email (interruptor ACCOUNT_LINK_EMAIL_CODE) guarda-se só em hash, com
//    validade e tentativas. Nada se apaga: decidido fica com quem e quando.
//
// Só acrescenta; idempotente (ER_DUP_FIELDNAME / ER_TABLE_EXISTS_ERROR).
export const MIGRATION_0585_STATEMENTS: string[] = [
  "ALTER TABLE `employees` ADD COLUMN `comebackRequestedAt` DATETIME NULL",
  "CREATE TABLE IF NOT EXISTS `account_link_requests` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`kind` VARCHAR(16) NOT NULL DEFAULT 'link', " +
    "`userId` INT NOT NULL, " +
    "`googleEmail` VARCHAR(320) NULL, " +
    "`claimedEmail` VARCHAR(320) NULL, " +
    "`claimedPhone` VARCHAR(32) NULL, " +
    "`employeeId` INT NULL, " +
    "`matchedEmployeeId` INT NULL, " +
    "`matchedApplicationId` INT NULL, " +
    "`status` VARCHAR(16) NOT NULL DEFAULT 'pending', " +
    "`codeHash` VARCHAR(128) NULL, " +
    "`codeExpiresAt` DATETIME NULL, " +
    "`attempts` INT NOT NULL DEFAULT 0, " +
    "`note` VARCHAR(255) NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`resolvedById` INT NULL, " +
    "`resolvedAt` DATETIME NULL, " +
    "PRIMARY KEY (`id`), " +
    "KEY `idx_account_link_user` (`userId`, `createdAt`), " +
    "KEY `idx_account_link_status` (`status`, `createdAt`), " +
    "KEY `idx_account_link_employee` (`matchedEmployeeId`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
];

export const IDEMPOTENT_ERROR_CODES_0585 = new Set<string>(["ER_DUP_FIELDNAME", "ER_TABLE_EXISTS_ERROR"]);
