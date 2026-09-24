// Migration 0095 — Segurança das API keys + índices do registo de atividade (24 set 2026)
//
//  - api_keys: a chave deixa de ficar em claro. Guarda-se `keyHash` (SHA-256
//    hex) + `keyPrefix` (9 primeiros caracteres, ex. "mp_ab12cd", para a UI) +
//    `expiresAt` opcional. A autenticação procura pelo hash (índice UNIQUE).
//    Backfill das chaves existentes: hash/prefixo calculados a partir do texto
//    em claro (SHA2(apiKey,256) = sha256 hex do Node → as chaves atuais
//    continuam a funcionar) e DEPOIS o texto em claro é apagado (NULL). A
//    coluna `apiKey` fica, por agora, NULLABLE (sai numa migração futura).
//  - activity_logs: índices em (createdAt) e (entity, createdAt) — a página de
//    Logs filtra/ordena por data e entidade, e a retenção apaga por data.
//
// Idempotente: ADD COLUMN → ER_DUP_FIELDNAME; ADD INDEX → ER_DUP_KEYNAME;
// os UPDATE só tocam nas linhas ainda por migrar (WHERE keyHash IS NULL /
// apiKey IS NOT NULL) e não usam subquery sobre a mesma tabela (1093).

export const MIGRATION_0095_NAME = "0095_api_keys_hash_activity_log_indexes";

export const MIGRATION_0095_STATEMENTS: string[] = [
  // ── API keys ──
  "ALTER TABLE `api_keys` ADD COLUMN `keyHash` CHAR(64) NULL",
  "ALTER TABLE `api_keys` ADD COLUMN `keyPrefix` VARCHAR(16) NULL",
  "ALTER TABLE `api_keys` ADD COLUMN `expiresAt` TIMESTAMP NULL",
  "ALTER TABLE `api_keys` MODIFY COLUMN `apiKey` VARCHAR(64) NULL",
  "UPDATE `api_keys` SET `keyHash` = SHA2(`apiKey`, 256), `keyPrefix` = LEFT(`apiKey`, 9) WHERE `keyHash` IS NULL AND `apiKey` IS NOT NULL AND `apiKey` <> ''",
  "UPDATE `api_keys` SET `apiKey` = NULL WHERE `keyHash` IS NOT NULL AND `apiKey` IS NOT NULL",
  "ALTER TABLE `api_keys` ADD UNIQUE INDEX `api_keys_keyHash_unique` (`keyHash`)",

  // ── Registo de atividade ──
  "ALTER TABLE `activity_logs` ADD INDEX `idx_activity_logs_createdAt` (`createdAt`)",
  "ALTER TABLE `activity_logs` ADD INDEX `idx_activity_logs_entity_createdAt` (`entity`, `createdAt`)",
];

export const IDEMPOTENT_ERROR_CODES_0095 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
