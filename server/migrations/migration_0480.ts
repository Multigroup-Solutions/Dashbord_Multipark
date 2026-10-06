// Migration 0480 — Rádio × Zello (P3 lote 32a, Jorge 6 out 2026): as
// gravações vêm do histórico do Zello; quando se transcreve uma com a IA (o
// Zello não a transcreveu), a transcrição fica ligada à mensagem do Zello
// (`radio_transcriptions.zelloMessageId`) para não se pagar duas vezes.
// Só acrescenta. Idempotente.
export const MIGRATION_0480_STATEMENTS: string[] = [
  "ALTER TABLE `radio_transcriptions` ADD COLUMN `zelloMessageId` BIGINT NULL DEFAULT NULL",
  "ALTER TABLE `radio_transcriptions` ADD INDEX `idx_radio_zello_msg` (`zelloMessageId`)",
];

export const IDEMPOTENT_ERROR_CODES_0480 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
