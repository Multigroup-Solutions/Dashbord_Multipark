-- 0047 — Tokens do formulário externo de disponibilidades (Fase 4)
--
-- Suporta a API segura para a app externa: cada extra recebe um link com um
-- token JWT single-use. O `jti` do JWT vive aqui; a submissão consome o token
-- (usedAt) de forma atómica (UPDATE ... WHERE usedAt IS NULL).
--
-- Numeração 0047 (não 0046): `server/migrations/migration_0046.ts` já ocupa
-- semanticamente o "0046" (runner one-shot). Ficheiro NOVO por regra: migrações
-- existentes são imutáveis.
--
-- ⚠️ SUPERSEDIDO: este ficheiro nunca foi executado por nada (e o número 0047
-- colide com server/migrations/migration_0047.ts). O DDL real vive em
-- server/migrations/migration_0060.ts (IF NOT EXISTS, aplicado no boot via
-- ensureRecentSchema). Mantido só como referência histórica.

CREATE TABLE `availability_form_tokens` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `jti` VARCHAR(64) NOT NULL,
  `employeeId` INT NOT NULL,
  `weekStart` VARCHAR(10) NOT NULL,
  `expiresAt` TIMESTAMP NOT NULL,
  `usedAt` TIMESTAMP NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `availability_form_tokens_jti_unique` (`jti`),
  INDEX `idx_availability_form_tokens_employee` (`employeeId`)
);
