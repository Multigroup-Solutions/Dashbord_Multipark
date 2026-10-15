// Migration 0690 — Observabilidade da IA (plano MPV "Multis por página", F0a, §8.3).
//
// `ai_usage_log` (uma linha por chamada — só metadados, nunca conteúdo):
//  - `finishReason`: o finishReason da última resposta (STOP, MAX_TOKENS…) —
//    para o alarme "MAX_TOKENS > 2 %";
//  - `rounds`: voltas de ferramentas (NULL = chamada sem ferramentas);
//  - `variant`: versão do chamador ("v1" | "mpv" no Multis; NULL nas outras);
//  - `forcedFinal`: houve chamada final sem ferramentas (máximo de voltas ou
//    prazo); NULL = sem ferramentas;
//  - índice (feature, userId, createdAt) para o teto por pessoa (§5.3) não
//    varrer a tabela.
//
// `ai_chat_messages`: `variant` e `tier` de cada resposta do Multis, para o
// 👍/👎 saber a versão e o nível.
//
// Só acrescenta (colunas NULL, sem backfill). Idempotente: ADD COLUMN repetido
// dá ER_DUP_FIELDNAME e ADD INDEX repetido ER_DUP_KEYNAME (calados).

export const MIGRATION_0690_STATEMENTS: string[] = [
  "ALTER TABLE `ai_usage_log` ADD COLUMN `finishReason` VARCHAR(32) NULL",
  "ALTER TABLE `ai_usage_log` ADD COLUMN `rounds` TINYINT NULL",
  "ALTER TABLE `ai_usage_log` ADD COLUMN `variant` VARCHAR(16) NULL",
  "ALTER TABLE `ai_usage_log` ADD COLUMN `forcedFinal` TINYINT(1) NULL",
  "ALTER TABLE `ai_usage_log` ADD INDEX `idx_ai_usage_feature_user_created` (`feature`, `userId`, `createdAt`)",
  "ALTER TABLE `ai_chat_messages` ADD COLUMN `variant` VARCHAR(16) NULL",
  "ALTER TABLE `ai_chat_messages` ADD COLUMN `tier` VARCHAR(16) NULL",
];

export const IDEMPOTENT_ERROR_CODES_0690 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
