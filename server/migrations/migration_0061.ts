// Migration 0061 — notas internas nos emails de recrutamento.
//
// A aba Recrutamento só permitia responder; o Jorge quer poder anotar o
// candidato ("já liguei", "sem carta", ...). Uma coluna de texto livre em
// inbound_emails chega — a nota pertence ao email/candidatura, não à pessoa
// (que pode nem existir ainda como employee/user).

export const MIGRATION_0061_NAME = "0061_inbound_emails_notes";

export const MIGRATION_0061_STATEMENTS: string[] = [
  "ALTER TABLE `inbound_emails` ADD COLUMN `notes` TEXT NULL AFTER `headerRefs`",
];

export const IDEMPOTENT_ERROR_CODES_0061 = new Set([
  "ER_DUP_FIELDNAME",
]);
