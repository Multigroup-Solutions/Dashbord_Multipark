// Migration 0440 — WhatsApp (P3 lote 24b, Jorge, 3 out 2026):
//  - D28: uma conversa pode ficar atribuída a um GRUPO DE CIDADE (Lisboa,
//    Porto, Faro) em vez de uma pessoa → whatsapp_conversations.assignedCityKey;
//  - D29: respostas rápidas por cidade (NULL = nacionais) →
//    whatsapp_quick_replies.cityKey.
// Só acrescenta colunas (nada se apaga). Idempotente: ADD COLUMN repetido ignora-se.
export const MIGRATION_0440_STATEMENTS: string[] = [
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `assignedCityKey` VARCHAR(16) NULL",
  "ALTER TABLE `whatsapp_quick_replies` ADD COLUMN `cityKey` VARCHAR(16) NULL",
];

export const IDEMPOTENT_ERROR_CODES_0440 = new Set<string>(["ER_DUP_FIELDNAME"]);
