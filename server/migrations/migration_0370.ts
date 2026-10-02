// Migration 0370 — "Não enviar" por pessoa (P3 lote 17g, Jorge 2 out 2026:
// "temos que conseguir desativar o enviar mensagem e/ou email para cada um dos
// colaboradores ou extras"). Dois interruptores na ficha:
//   employees.noAutoWhatsapp — não recebe WhatsApp automáticos nem em massa;
//   employees.noAutoEmail    — não recebe emails automáticos.
// As conversas uma a uma (responder no WhatsApp ou num email) continuam.
// Idempotente: ADD COLUMN ignora o que já existe. Não apaga nada.
export const MIGRATION_0370_STATEMENTS: string[] = [
  "ALTER TABLE `employees` ADD COLUMN `noAutoWhatsapp` TINYINT NOT NULL DEFAULT 0",
  "ALTER TABLE `employees` ADD COLUMN `noAutoEmail` TINYINT NOT NULL DEFAULT 0",
];

export const IDEMPOTENT_ERROR_CODES_0370 = new Set<string>(["ER_DUP_FIELDNAME"]);
