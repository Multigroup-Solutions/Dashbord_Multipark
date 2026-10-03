// Migration 0420 — CRM, Rever fichas (P3 lote 21c): regras de identidade do
// dono (3 out 2026) e IA nas dúvidas.
//  - crm_merge_suggestions: o veredicto das regras (same/doubt/block) e os
//    avisos (NIF diferente, telefone em várias fichas, email genérico, nome de
//    uma palavra, empresa, Pro…) que se mostram em Rever fichas; o parecer da
//    IA (mesma pessoa / outra / não sabe, confiança, porquê, quando); e a
//    última vez que a sugestão foi vista pelas sugestões da madrugada (as que
//    deixaram de aparecer numa corrida completa ficam obsoletas).
//  - crm_merge_events.source: quem juntou — "ui" (uma pessoa), "auto" (as
//    regras) ou "ai" (a IA), para filtrar "Juntas recentemente".
// Idempotente: ADD COLUMN ignora o que já existe.
export const MIGRATION_0420_STATEMENTS: string[] = [
  "ALTER TABLE `crm_merge_suggestions` ADD COLUMN `verdict` VARCHAR(8) NULL",
  "ALTER TABLE `crm_merge_suggestions` ADD COLUMN `signals` VARCHAR(255) NULL",
  "ALTER TABLE `crm_merge_suggestions` ADD COLUMN `aiVerdict` VARCHAR(8) NULL",
  "ALTER TABLE `crm_merge_suggestions` ADD COLUMN `aiConfidence` INT NULL",
  "ALTER TABLE `crm_merge_suggestions` ADD COLUMN `aiReason` VARCHAR(255) NULL",
  "ALTER TABLE `crm_merge_suggestions` ADD COLUMN `aiAt` DATETIME NULL",
  "ALTER TABLE `crm_merge_suggestions` ADD COLUMN `seenAt` DATETIME NULL",
  "ALTER TABLE `crm_merge_events` ADD COLUMN `source` VARCHAR(8) NULL",
];

export const IDEMPOTENT_ERROR_CODES_0420 = new Set<string>(["ER_DUP_FIELDNAME"]);
