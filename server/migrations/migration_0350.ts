// Migration 0350 — WhatsApp: envio sem duplicar, respostas rápidas sem apagar (P3 lote 17a, out 2026).
// - `whatsapp_messages.clientRequestId`: código único de CADA envio feito por uma
//   pessoa (o ecrã gera-o). Repetir o pedido (duplo clique, rede que cai) nunca
//   volta a mandar a mensagem ao cliente.
// - estado 'unknown': a Meta não respondeu (prazo, erro do servidor dela) e não
//   sabemos se a mensagem saiu. Antes ficava 'failed' e convidava a reenviar.
// - `whatsapp_quick_replies.archivedAt/archivedById`: "Apagar" passa a arquivar.
// Idempotente: ADD COLUMN/ADD KEY ignoram o que já existe; o MODIFY repete-se sem mal.
export const MIGRATION_0350_NAME = "0350_whatsapp_send_once";

export const MIGRATION_0350_STATEMENTS: string[] = [
  "ALTER TABLE `whatsapp_messages` ADD COLUMN `clientRequestId` VARCHAR(64) NULL",
  "ALTER TABLE `whatsapp_messages` ADD UNIQUE KEY `uq_whatsapp_messages_client_request` (`clientRequestId`)",
  "ALTER TABLE `whatsapp_messages` MODIFY COLUMN `status` ENUM('pending','sent','delivered','read','failed','unknown') NOT NULL DEFAULT 'pending'",
  "ALTER TABLE `whatsapp_quick_replies` ADD COLUMN `archivedAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `whatsapp_quick_replies` ADD COLUMN `archivedById` INT NULL",
];

export const IDEMPOTENT_ERROR_CODES_0350 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
