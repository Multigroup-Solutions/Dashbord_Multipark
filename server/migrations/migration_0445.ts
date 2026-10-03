// Migration 0445 — WhatsApp (P3 lote 24c, Jorge, 3 out 2026):
//  - D33: estado 'accepted' nas mensagens de saída. Até aqui a mensagem ficava
//    "Enviado" assim que a Meta aceitava o pedido; agora fica "Aceite" e só o
//    webhook 'sent' da Meta a passa a "Enviado" (depois entregue/lido/falhou).
// O valor novo vai NO FIM do ENUM (alteração só de metadados no MySQL 8).
// A 0350 repete o seu MODIFY em cada arranque: passou a ter o mesmo ENUM (com
// 'accepted'), para nunca o encolher por cima das linhas já aceites.
// Idempotente: repetir o MODIFY não muda nada. Nada se apaga.
export const WHATSAPP_MESSAGE_STATUS_ENUM_SQL = "ENUM('pending','sent','delivered','read','failed','unknown','accepted')";

export const MIGRATION_0445_STATEMENTS: string[] = [
  `ALTER TABLE \`whatsapp_messages\` MODIFY COLUMN \`status\` ${WHATSAPP_MESSAGE_STATUS_ENUM_SQL} NOT NULL DEFAULT 'pending'`,
];

export const IDEMPOTENT_ERROR_CODES_0445 = new Set<string>([]);
