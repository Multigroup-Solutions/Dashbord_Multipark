// Migration 0067 — Contactos PESSOAIS na ficha de colaborador (pedido do
// Jorge, 2026-09-10): os internos têm login e agente Multipark com o email
// @multipark.pt, mas punham o email/telefone pessoal na ficha, o que entrava
// em conflito com a identidade por email. Agora `email`/`phone` são os de
// TRABALHO (identidade) e `personalEmail`/`personalPhone` guardam os pessoais
// só para contacto. Extras não usam estes campos (o pessoal é o principal).
//
// Idempotente: corre no boot (ensureRecentSchema).

export const MIGRATION_0067_NAME = "0067_employees_personal_contacts";

export const MIGRATION_0067_STATEMENTS: string[] = [
  "ALTER TABLE `employees` ADD COLUMN `personalEmail` VARCHAR(320) NULL AFTER `phone`",
  "ALTER TABLE `employees` ADD COLUMN `personalPhone` VARCHAR(32) NULL AFTER `personalEmail`",
];

export const IDEMPOTENT_ERROR_CODES_0067 = new Set(["ER_DUP_FIELDNAME"]);
