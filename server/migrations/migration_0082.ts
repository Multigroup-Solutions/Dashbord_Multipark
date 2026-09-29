// Migration 0082 — parceiros "por configurar" (24 set 2026).
//
// A sincronização automática (cron horário) cria parceiros novos com 0% e sem
// avença. Sem uma marca não se distinguia "0% confirmado" de "nunca
// configurado". `configuredAt` é preenchido quando um admin grava o parceiro no
// ecrã; NULL = fila "Por configurar" e, nas finanças, `rate_missing`.
//
// Os parceiros existentes com comissão ou avença já preenchidas contam como
// configurados (idempotente — só toca em linhas ainda NULL). `updatedAt =
// updatedAt` evita o ON UPDATE: é o critério de desempate de conflitos de
// chave em buildPartnerIndex e não pode mudar em massa.

export const MIGRATION_0082_NAME = "0082_partner_configured_at";

export const MIGRATION_0082_STATEMENTS: string[] = [
  "ALTER TABLE `partnerships` ADD COLUMN `configuredAt` DATETIME NULL",
  "UPDATE `partnerships` SET `configuredAt` = `updatedAt`, `updatedAt` = `updatedAt` WHERE `configuredAt` IS NULL AND (COALESCE(`commissionRate`, 0) <> 0 OR COALESCE(`monthlyFee`, 0) <> 0)",
];

export const IDEMPOTENT_ERROR_CODES_0082 = new Set<string>(["ER_DUP_FIELDNAME"]);
