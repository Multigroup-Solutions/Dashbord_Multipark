// Migration 0355 — WhatsApp: difusões sem duplicar (P3 lote 17b, out 2026).
// `whatsapp_broadcasts.sendKey`: código único de cada envio em massa feito por
// uma pessoa (o ecrã gera-o). Se a função for cortada a meio (60 s da Vercel)
// e a pessoa carregar outra vez, o envio RETOMA a mesma difusão: quem já
// recebeu não recebe outra vez (cada destinatário tem o seu código na mensagem).
// Idempotente: ADD COLUMN/ADD KEY ignoram o que já existe.
export const MIGRATION_0355_NAME = "0355_whatsapp_broadcast_send_key";

export const MIGRATION_0355_STATEMENTS: string[] = [
  "ALTER TABLE `whatsapp_broadcasts` ADD COLUMN `sendKey` VARCHAR(40) NULL",
  "ALTER TABLE `whatsapp_broadcasts` ADD UNIQUE KEY `uq_whatsapp_broadcasts_send_key` (`sendKey`)",
];

export const IDEMPOTENT_ERROR_CODES_0355 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
