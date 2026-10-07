// Migration 0530 — templates WhatsApp dos motoristas POR CIDADE (Jorge, 7 out
// 2026). Com um conjunto de templates por cidade (registo em
// shared/driverTemplates.ts), o registo de envios passa a guardar a CIDADE (a
// língua já ficava em whatsapp_messages.language, 0375):
//
//  - `whatsapp_broadcasts.city` + `languageCode`: um lote com motoristas de
//    várias cidades gera uma difusão por cidade;
//  - `whatsapp_messages.city`: por mensagem enviada;
//  - SEM backfill: os templates antigos iam a extras de TODAS as cidades, por
//    isso marcar essas linhas como Lisboa seria inventar. NULL = enviado antes
//    do registo por cidade;
//  - `extras_dia_notices.changeRequestedAt`: o extra carregou em "Preciso de
//    alterar" no turno_confirmado. A tabela é criada a pedido em
//    server/extrasAutomation.ts (ensureTables, já com a coluna); numa BD onde
//    ainda não existe, o ALTER dá ER_NO_SUCH_TABLE e é ignorado.
//
// Idempotente: ADD COLUMN repetido dá ER_DUP_FIELDNAME.

export const MIGRATION_0530_STATEMENTS: string[] = [
  "ALTER TABLE `whatsapp_broadcasts` ADD COLUMN `city` VARCHAR(16) NULL AFTER `templateName`",
  "ALTER TABLE `whatsapp_broadcasts` ADD COLUMN `languageCode` VARCHAR(16) NULL AFTER `city`",
  "ALTER TABLE `whatsapp_messages` ADD COLUMN `city` VARCHAR(16) NULL AFTER `templateName`",
  "ALTER TABLE `extras_dia_notices` ADD COLUMN `changeRequestedAt` TIMESTAMP NULL AFTER `declinedAt`",
];

export const IDEMPOTENT_ERROR_CODES_0530 = new Set<string>(["ER_DUP_FIELDNAME", "ER_NO_SUCH_TABLE"]);
