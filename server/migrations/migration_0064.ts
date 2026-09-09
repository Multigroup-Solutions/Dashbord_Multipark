// Migration 0064 — Pedidos do Jorge de 2026-09-09:
//
//   - whatsapp_messages: media recebida (imagens e áudios enviados pelas
//     pessoas). O webhook passa a descarregar o ficheiro da Meta e a guardá-lo
//     no storage da app; a linha fica com o tipo, o id Meta (para re-tentar o
//     download se falhar), o mime e o URL/key no storage. `type` continua
//     'text' — o enum não é alterado (ver shared/whatsappMedia.ts).
//   - shift_handovers: `clothingItems` (JSON de peças de fardamento com
//     quantidade e tamanho) substitui o uso de `uniformsCount`, que fica na
//     mesma para os registos antigos. A tabela é criada preguiçosamente em
//     db.ts (`ensureShiftHandoverTable`, já com a coluna); se ainda não
//     existir quando isto corre, ER_NO_SUCH_TABLE é esperado e idempotente.
//
// Idempotente: corre no boot (ensureRecentSchema).

export const MIGRATION_0064_NAME = "0064_whatsapp_media_and_handover_clothing";

export const MIGRATION_0064_STATEMENTS: string[] = [
  // ── whatsapp_messages: media entrante ──────────────────────────────────────
  "ALTER TABLE `whatsapp_messages` ADD COLUMN `mediaType` ENUM('image','audio','video','document','sticker') NULL AFTER `templateName`",
  "ALTER TABLE `whatsapp_messages` ADD COLUMN `mediaId` VARCHAR(128) NULL AFTER `mediaType`",
  "ALTER TABLE `whatsapp_messages` ADD COLUMN `mediaMime` VARCHAR(128) NULL AFTER `mediaId`",
  "ALTER TABLE `whatsapp_messages` ADD COLUMN `mediaUrl` TEXT NULL AFTER `mediaMime`",
  "ALTER TABLE `whatsapp_messages` ADD COLUMN `mediaKey` VARCHAR(512) NULL AFTER `mediaUrl`",
  // ── shift_handovers: fardamento com tamanhos ───────────────────────────────
  "ALTER TABLE `shift_handovers` ADD COLUMN `clothingItems` TEXT NULL AFTER `uniformsCount`",
];

export const IDEMPOTENT_ERROR_CODES_0064 = new Set([
  "ER_DUP_FIELDNAME", // ADD COLUMN onde já existe
  "ER_NO_SUCH_TABLE", // shift_handovers ainda não criada (nasce em db.ts já com a coluna)
]);
