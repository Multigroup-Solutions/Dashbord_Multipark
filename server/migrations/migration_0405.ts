// Migration 0405 — API keys (P3 lote 20a): "Eliminar" uma chave passa a
// REVOGAR (antes era um DELETE sem rasto). A linha fica com quem revogou,
// quando e porquê; uma chave revogada nunca volta a funcionar (não se reativa)
// e sai da lista por omissão. Idempotente: ADD COLUMN ignora o que já existe.
export const MIGRATION_0405_STATEMENTS: string[] = [
  "ALTER TABLE `api_keys` ADD COLUMN `revokedAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `api_keys` ADD COLUMN `revokedById` INT NULL",
  "ALTER TABLE `api_keys` ADD COLUMN `revokeReason` VARCHAR(255) NULL",
];

export const IDEMPOTENT_ERROR_CODES_0405 = new Set<string>(["ER_DUP_FIELDNAME"]);
