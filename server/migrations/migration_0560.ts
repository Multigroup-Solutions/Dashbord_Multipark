// Migration 0560 — pedidos de documentos em falta aos extras (pauta do Rafael,
// 7 out 2026: "criar automação enviar docs em falta"). Uma linha por pedido a
// uma pessoa: quem, quando, à mão ou automático, por quem, os documentos
// pedidos e o resultado de cada canal (WhatsApp / email). Regras em
// shared/docsRequest.ts (7 dias entre pedidos, máximo 4 automáticos).
//
//  - `requestKey` ÚNICO: o mesmo clique (ou a mesma semana ISO do pedido
//    automático) nunca envia duas vezes;
//  - estados por canal: sending | sent | unknown (a Meta não confirmou) |
//    failed | skipped; NULL = canal não pedido;
//  - nada se apaga (é o registo do que se pediu).
//
// Só cria; idempotente (ER_TABLE_EXISTS_ERROR).
export const MIGRATION_0560_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `employee_docs_requests` (" +
    "`id` INT AUTO_INCREMENT PRIMARY KEY, " +
    "`employeeId` INT NOT NULL, " +
    "`mode` VARCHAR(8) NOT NULL DEFAULT 'manual', " +
    "`requestedById` INT NULL, " +
    "`requestKey` VARCHAR(96) NOT NULL, " +
    "`docTypes` VARCHAR(255) NOT NULL, " +
    "`docsText` VARCHAR(700) NULL, " +
    "`whatsappStatus` VARCHAR(16) NULL, " +
    "`whatsappDetail` VARCHAR(300) NULL, " +
    "`templateName` VARCHAR(120) NULL, " +
    "`emailStatus` VARCHAR(16) NULL, " +
    "`emailDetail` VARCHAR(300) NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`finishedAt` TIMESTAMP NULL DEFAULT NULL, " +
    "UNIQUE KEY `uq_employee_docs_requests_key` (`requestKey`), " +
    "KEY `idx_employee_docs_requests_emp_created` (`employeeId`, `createdAt`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
];

export const IDEMPOTENT_ERROR_CODES_0560 = new Set<string>(["ER_TABLE_EXISTS_ERROR"]);
