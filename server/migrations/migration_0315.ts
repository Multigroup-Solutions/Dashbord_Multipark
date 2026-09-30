// Migration 0315 — triagem da IA do WhatsApp com limite (Jorge, 29 set 2026:
// "agendador mais leve"). Conta as falhas seguidas da triagem de cada conversa;
// à 3.ª a conversa deixa de ser reagendada (fica para triagem à mão) até
// chegar uma mensagem nova do cliente. Só acrescenta.
export const MIGRATION_0315_NAME = "0315_whatsapp_triage_fails";

export const MIGRATION_0315_STATEMENTS: string[] = [
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `aiTriageFails` INT NOT NULL DEFAULT 0",
];

export const IDEMPOTENT_ERROR_CODES_0315 = new Set<string>(["ER_DUP_FIELDNAME"]);
