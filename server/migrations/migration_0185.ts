// Migration 0185 — Chamadas de voz do WhatsApp dentro do dashboard (WhatsApp
// Business Calling API, set 2026): receber chamadas no browser (WebRTC) e
// devolver chamadas (iniciadas pela empresa, com autorização do cliente).
//
//  - whatsapp_calls: uma chamada (id `wacid.…` da Meta = `callId`, único →
//    os retries do webhook não duplicam). Direção in/out, estado
//    (ringing/answering/dialing/connected/ended/missed/rejected/failed),
//    cidade da conversa (projectId, mesma regra do inbox), quem atendeu/ligou,
//    início/atendida/fim/duração, `missed` (não atendida) e o "por devolver"
//    (`callbackDoneAt`). `sdpOffer`/`sdpAnswer` são de vida curta: limpos logo
//    depois de atender/terminar (nunca ficam em chamadas acabadas).
//  - whatsapp_call_permissions: autorização do cliente para a empresa ligar
//    (pedido interativo `call_permission_request` + resposta no webhook):
//    estado, validade (temporária = 7 dias; permanente = sem fim) e os
//    últimos pedidos (limite da Meta: 1 por 24 h e 2 por 7 dias).
//
// Idempotente (corre em cada arranque via ensureRecentSchema): CREATE TABLE IF
// NOT EXISTS; ADD INDEX já existente → ER_DUP_KEYNAME ignorado.

export const MIGRATION_0185_NAME = "0185_whatsapp_calls";

export const MIGRATION_0185_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `whatsapp_calls` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`callId` VARCHAR(160) NOT NULL, " +
    "`conversationId` INT NULL, " +
    "`phoneE164` VARCHAR(20) NOT NULL, " +
    "`direction` ENUM('in','out') NOT NULL, " +
    "`status` VARCHAR(16) NOT NULL DEFAULT 'ringing', " +
    "`sdpOffer` MEDIUMTEXT NULL, " +
    "`sdpAnswer` MEDIUMTEXT NULL, " +
    "`projectId` INT NULL, " +
    "`startedAt` DATETIME NOT NULL, " +
    "`answeredAt` DATETIME NULL, " +
    "`endedAt` DATETIME NULL, " +
    "`durationSec` INT NULL, " +
    "`answeredByUserId` INT NULL, " +
    "`startedByUserId` INT NULL, " +
    "`missed` TINYINT NOT NULL DEFAULT 0, " +
    "`missedNotifiedAt` DATETIME NULL, " +
    "`callbackDoneAt` DATETIME NULL, " +
    "`callbackByUserId` INT NULL, " +
    "`metaStatus` VARCHAR(32) NULL, " +
    "`endReason` VARCHAR(200) NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_whatsapp_calls_call_id` (`callId`), " +
    "KEY `idx_whatsapp_calls_status` (`status`, `startedAt`), " +
    "KEY `idx_whatsapp_calls_conversation` (`conversationId`, `startedAt`), " +
    "KEY `idx_whatsapp_calls_callback` (`direction`, `callbackDoneAt`, `startedAt`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  "CREATE TABLE IF NOT EXISTS `whatsapp_call_permissions` (" +
    "`phoneE164` VARCHAR(20) NOT NULL, " +
    "`status` VARCHAR(16) NOT NULL DEFAULT 'none', " +
    "`expiresAt` DATETIME NULL, " +
    "`isPermanent` TINYINT NOT NULL DEFAULT 0, " +
    "`lastRequestAt` DATETIME NULL, " +
    "`requestTimes` VARCHAR(400) NULL, " +
    "`respondedAt` DATETIME NULL, " +
    "`requestedByUserId` INT NULL, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`phoneE164`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
];

export const IDEMPOTENT_ERROR_CODES_0185 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME", "ER_TABLE_EXISTS_ERROR"]);
