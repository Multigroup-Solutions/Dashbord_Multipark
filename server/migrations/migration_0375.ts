// Migration 0375 — WhatsApp: falhas de entrega 131026 / 131049 (Jorge, 2 out 2026).
// A Meta aceita a mensagem e só depois diz "failed" (webhook statuses[].errors[]).
//
// whatsapp_messages:
//   language / category    língua e categoria do template enviado (categoria
//                          também pelo `pricing.category` do webhook)
//   errorCode / errorTitle o erro da Meta estruturado (o errorDetail continua)
//   sendPayload            JSON do envio de equipa (components sem o token do
//                          formulário) — permite a nova tentativa do 131049
//   retryState / retryAt   nova tentativa agendada (scheduled → done/skipped)
//   retryOfId              esta linha é a nova tentativa daquela
//   fallbackAt / fallbackResult  alternativa por email (uma só vez) e resultado
// whatsapp_pending_statuses: errorCode / errorTitle / category (estado que chega antes da linha)
// whatsapp_conversations:
//   undeliverableCount     131026 seguidos para o número (entregue/lida repõe)
//   unreachableAt          2.º 131026 seguido → sem templates até a pessoa escrever
// Idempotente: ADD COLUMN / ADD INDEX ignoram o que já existe. Não apaga nada.
export const MIGRATION_0375_STATEMENTS: string[] = [
  "ALTER TABLE `whatsapp_messages` ADD COLUMN `language` VARCHAR(16) NULL",
  "ALTER TABLE `whatsapp_messages` ADD COLUMN `category` VARCHAR(16) NULL",
  "ALTER TABLE `whatsapp_messages` ADD COLUMN `errorCode` INT NULL",
  "ALTER TABLE `whatsapp_messages` ADD COLUMN `errorTitle` VARCHAR(255) NULL",
  "ALTER TABLE `whatsapp_messages` ADD COLUMN `sendPayload` TEXT NULL",
  "ALTER TABLE `whatsapp_messages` ADD COLUMN `retryState` VARCHAR(16) NULL",
  "ALTER TABLE `whatsapp_messages` ADD COLUMN `retryAt` TIMESTAMP NULL",
  "ALTER TABLE `whatsapp_messages` ADD COLUMN `retryOfId` INT NULL",
  "ALTER TABLE `whatsapp_messages` ADD COLUMN `fallbackAt` TIMESTAMP NULL",
  "ALTER TABLE `whatsapp_messages` ADD COLUMN `fallbackResult` VARCHAR(32) NULL",
  "ALTER TABLE `whatsapp_messages` ADD INDEX `idx_whatsapp_messages_retry` (`retryState`, `retryAt`)",
  "ALTER TABLE `whatsapp_pending_statuses` ADD COLUMN `errorCode` INT NULL",
  "ALTER TABLE `whatsapp_pending_statuses` ADD COLUMN `errorTitle` VARCHAR(255) NULL",
  "ALTER TABLE `whatsapp_pending_statuses` ADD COLUMN `category` VARCHAR(16) NULL",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `undeliverableCount` INT NOT NULL DEFAULT 0",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `unreachableAt` TIMESTAMP NULL",
];

export const IDEMPOTENT_ERROR_CODES_0375 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
