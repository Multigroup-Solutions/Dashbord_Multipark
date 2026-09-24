// Migration 0111 — IA: registo de uso/custo, alertas de orçamento, limites de pedidos e caches de contexto (24 set 2026)
//
//  - ai_usage_log: uma linha por chamada à IA (só METADADOS — nunca o prompt
//    nem a resposta): funcionalidade, nível, fornecedor, modelo, quem, sobre
//    que entidade, tokens, custo estimado (EUR), latência, estado e código
//    de erro. Alimenta o orçamento mensal e o cartão em Definições → Estado.
//  - ai_budget_alerts: um registo por mês em que o orçamento foi excedido
//    (INSERT IGNORE = o aviso aos admins sai uma só vez).
//  - ai_rate_limits: contadores por chave/janela (minuto/dia) para o limitador
//    de pedidos (funciona em serverless: o estado vive na BD).
//  - ai_context_caches: nome da cache de contexto do Gemini por prefixo
//    (system) estável, para as instâncias reutilizarem a mesma.
//
// Idempotente (corre em cada arranque via ensureRecentSchema): só CREATE
// TABLE IF NOT EXISTS. Sem UPDATEs.

export const MIGRATION_0111_NAME = "0111_ai_usage";

export const MIGRATION_0111_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `ai_usage_log` (" +
    "`id` BIGINT NOT NULL AUTO_INCREMENT, " +
    "`createdAt` DATETIME(3) NOT NULL, " +
    "`feature` VARCHAR(40) NOT NULL, " +
    "`tier` VARCHAR(8) NOT NULL, " +
    "`provider` VARCHAR(16) NOT NULL, " +
    "`model` VARCHAR(80) NOT NULL, " +
    "`userId` INT NULL, " +
    "`entity` VARCHAR(40) NULL, " +
    "`entityId` INT NULL, " +
    "`inputTokens` INT NOT NULL DEFAULT 0, " +
    "`outputTokens` INT NOT NULL DEFAULT 0, " +
    "`cachedTokens` INT NOT NULL DEFAULT 0, " +
    "`costEur` DECIMAL(12,6) NOT NULL DEFAULT 0, " +
    "`latencyMs` INT NOT NULL DEFAULT 0, " +
    "`status` VARCHAR(16) NOT NULL, " +
    "`errorCode` VARCHAR(40) NULL, " +
    "PRIMARY KEY (`id`), " +
    "INDEX `idx_ai_usage_created` (`createdAt`), " +
    "INDEX `idx_ai_usage_feature_created` (`feature`, `createdAt`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS `ai_budget_alerts` (" +
    "`month` CHAR(7) NOT NULL, " +
    "`notifiedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`spentEur` DECIMAL(12,4) NULL, " +
    "`budgetEur` DECIMAL(12,4) NULL, " +
    "PRIMARY KEY (`month`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS `ai_rate_limits` (" +
    "`bucketKey` VARCHAR(160) NOT NULL, " +
    "`windowStart` DATETIME NOT NULL, " +
    "`hits` INT NOT NULL DEFAULT 0, " +
    "PRIMARY KEY (`bucketKey`, `windowStart`), " +
    "INDEX `idx_ai_rate_limits_window` (`windowStart`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS `ai_context_caches` (" +
    "`cacheKey` CHAR(64) NOT NULL, " +
    "`provider` VARCHAR(16) NOT NULL, " +
    "`model` VARCHAR(80) NOT NULL, " +
    "`cacheName` VARCHAR(255) NOT NULL, " +
    "`expiresAt` DATETIME NOT NULL, " +
    "PRIMARY KEY (`cacheKey`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
];

export const IDEMPOTENT_ERROR_CODES_0111 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME", "ER_DUP_FIELDNAME"]);
