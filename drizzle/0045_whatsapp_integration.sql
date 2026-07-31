-- 0045 — Integração WhatsApp (Cloud API)
--
-- 3 tabelas para o envio em massa de templates + inbox de respostas:
--   1. whatsapp_conversations — conversa 1-a-1 por número (chave = E.164).
--      lastInboundAt é a fonte da janela de 24h da Meta (null/antigo = fechada).
--   2. whatsapp_messages — cada mensagem in/out. waMessageId único (quando
--      presente) para dedup do webhook e correlação dos updates de status.
--   3. whatsapp_broadcasts — agrupa um envio em massa de um template.
--
-- Escrita à mão no padrão dos ficheiros manuais 0025–0044 (o journal do
-- drizzle-kit está congelado no idx 24). NÃO executar automaticamente — aplicar
-- pelo runbook habitual da casa.
--
-- ⚠️ SUPERSEDIDO: este ficheiro nunca foi executado por nada. O DDL real vive
-- em server/migrations/migration_0060.ts (IF NOT EXISTS, aplicado no boot via
-- ensureRecentSchema). Mantido só como referência histórica.

-- ── 1. Conversas ────────────────────────────────────────────────────────────
CREATE TABLE `whatsapp_conversations` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `phoneE164` VARCHAR(20) NOT NULL,
  `employeeId` INT NULL,
  `lastInboundAt` TIMESTAMP NULL,
  `lastMessageAt` TIMESTAMP NULL,
  `unreadCount` INT NOT NULL DEFAULT 0,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `whatsapp_conversations_phone_unique` (`phoneE164`),
  INDEX `idx_whatsapp_conversations_employee` (`employeeId`),
  INDEX `idx_whatsapp_conversations_last_message` (`lastMessageAt`)
);

-- ── 2. Mensagens ────────────────────────────────────────────────────────────
CREATE TABLE `whatsapp_messages` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `conversationId` INT NOT NULL,
  `direction` ENUM('in','out') NOT NULL,
  `waMessageId` VARCHAR(128) NULL,
  `type` ENUM('text','template') NOT NULL,
  `body` TEXT NULL,
  `templateName` VARCHAR(128) NULL,
  `status` ENUM('pending','sent','delivered','read','failed') NOT NULL DEFAULT 'pending',
  `errorDetail` TEXT NULL,
  `sentById` INT NULL,
  `broadcastId` INT NULL,
  `waTimestamp` TIMESTAMP NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `whatsapp_messages_wa_message_id_unique` (`waMessageId`),
  INDEX `idx_whatsapp_messages_conversation` (`conversationId`),
  INDEX `idx_whatsapp_messages_broadcast` (`broadcastId`),
  INDEX `idx_whatsapp_messages_status` (`status`)
);

-- ── 3. Broadcasts ───────────────────────────────────────────────────────────
CREATE TABLE `whatsapp_broadcasts` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `templateName` VARCHAR(128) NOT NULL,
  `note` TEXT NULL,
  `createdById` INT NULL,
  `weekStart` DATE NULL,
  `totalCount` INT NOT NULL DEFAULT 0,
  `sentCount` INT NOT NULL DEFAULT 0,
  `failedCount` INT NOT NULL DEFAULT 0,
  -- Fase 3: JSON array dos employeeId que falharam por número inválido/ausente.
  `invalidEmployeeIds` TEXT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);
