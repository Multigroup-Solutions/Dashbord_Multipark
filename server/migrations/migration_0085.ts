// Migration 0085 — ingestão de reclamações por email (24 set 2026).
//
//  - `inbound_emails.status` ganha 'processing' (no FIM do enum → alteração
//    INSTANTÂNEA do InnoDB, segura para correr em cada arranque): o leitor IMAP
//    reserva o Message-ID (índice UNIQUE) ANTES de criar a reclamação, para
//    duas corridas em paralelo nunca criarem o mesmo caso duas vezes;
//  - `complaints.autoAckSentAt`: guarda do aviso de receção automático (sai no
//    máximo 1× por reclamação);
//  - `complaints.lastOutboundMessageId`: Message-ID do último email enviado ao
//    cliente (threading das respostas: In-Reply-To/References).

export const MIGRATION_0085_NAME = "0085_complaint_email_intake";

export const MIGRATION_0085_STATEMENTS: string[] = [
  "ALTER TABLE `inbound_emails` MODIFY COLUMN `status` ENUM('processed','skipped','error','processing') NOT NULL DEFAULT 'processed'",
  "ALTER TABLE `complaints` ADD COLUMN `autoAckSentAt` TIMESTAMP NULL",
  "ALTER TABLE `complaints` ADD COLUMN `lastOutboundMessageId` VARCHAR(255) NULL",
];

export const IDEMPOTENT_ERROR_CODES_0085 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
