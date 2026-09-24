// Migration 0105 — Estado dos alertas das integrações (24 set 2026)
//
//  - integration_alert_state: último estado ALERTADO de cada ligação
//    (conn:google_ads, conn:meta, conn:google_business, conn:whatsapp…) e de
//    cada cron (cron:<nome>). O avaliador (server/integrations/alerts.ts) só
//    avisa os admins (notificação na app + email ao dono) quando o estado MUDA
//    para mau — uma vez por transição, mesmo com várias invocações em paralelo
//    (UPDATE condicional atómico).
//
// Idempotente (corre em cada arranque): CREATE TABLE IF NOT EXISTS +
// ER_TABLE_EXISTS_ERROR / ER_DUP_FIELDNAME / ER_DUP_KEYNAME ignorados. Sem
// UPDATEs (tabela nova). Não apaga nada.

export const MIGRATION_0105_NAME = "0105_integration_alert_state";

export const MIGRATION_0105_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS \`integration_alert_state\` (
    \`alertKey\` VARCHAR(96) NOT NULL PRIMARY KEY,
    \`state\` VARCHAR(32) NOT NULL,
    \`detail\` VARCHAR(500) NULL,
    \`changedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`alertedAt\` TIMESTAMP NULL
  )`,
];

export const IDEMPOTENT_ERROR_CODES_0105 = new Set(["ER_TABLE_EXISTS_ERROR", "ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
