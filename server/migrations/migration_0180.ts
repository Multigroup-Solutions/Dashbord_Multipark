// Migration 0180 — Notificações automáticas de reserva escondidas na
// Comunicação (decisão do dono, 26 set 2026). As ~4000 notificações "Nova
// Reserva" por mês que chegam à caixa "Reservas (geral)" ficam guardadas mas
// escondidas por omissão nas listas ("Mostrar automáticos"); a pesquisa
// encontra-as.
//
//  - mail_messages.automated passa a ter o valor 2 = notificação automática
//    de reserva (0 = pessoa, 1 = remetente automático) — sem coluna nova;
//  - mail_threads.automated: 1 = TODAS as mensagens da conversa são
//    notificações automáticas de reserva (uma resposta nossa ou do cliente
//    torna-a normal); NULL = por calcular (conversas anteriores a esta
//    migração — o backfill abaixo só toca nessas, por isso é barato nos
//    arranques seguintes). O cálculo corrente é do recomputeThread
//    (server/mail/store.ts).
//
// Idempotente (corre em cada arranque via ensureRecentSchema): ADD COLUMN /
// ADD INDEX já existentes → ER_DUP_FIELDNAME / ER_DUP_KEYNAME ignorados; os
// UPDATE só mexem em conversas com `automated` IS NULL.

export const MIGRATION_0180_NAME = "0180_mail_automatic_reservation_notices";

// Mesma heurística de shared/mail.ts isReservationNotificationEmail.
const RESERVATION_NOTICE_SQL =
  "m.`direction` = 'in' AND m.`automated` IN (0, 1) " +
  "AND LOWER(COALESCE(m.`subject`, '')) LIKE '%nova reserva%' " +
  "AND LOWER(COALESCE(m.`subject`, '')) NOT REGEXP '^[[:space:]]*(re|res|fw|fwd|enc|reenc|tr)[[:space:]]*:' " +
  "AND LOWER(COALESCE(m.`fromEmail`, '')) REGEXP '@(multipark|skypark)[.](pt|app)$'";

export const MIGRATION_0180_STATEMENTS: string[] = [
  "ALTER TABLE `mail_threads` ADD COLUMN `automated` TINYINT NULL",
  "ALTER TABLE `mail_threads` ADD INDEX `idx_mail_threads_mailbox_auto` (`mailboxKey`, `automated`, `lastMessageAt`)",
  // 1) Mensagens antigas das conversas por calcular → 2 (notificação de reserva).
  "UPDATE `mail_messages` m JOIN `mail_threads` t ON t.`id` = m.`threadId` SET m.`automated` = 2 " +
    "WHERE t.`automated` IS NULL AND " + RESERVATION_NOTICE_SQL,
  // 2) Conversas por calcular → 1 se todas as mensagens são notificações de reserva.
  "UPDATE `mail_threads` t SET t.`automated` = CASE " +
    "WHEN EXISTS (SELECT 1 FROM `mail_messages` m WHERE m.`threadId` = t.`id`) " +
    "AND NOT EXISTS (SELECT 1 FROM `mail_messages` m WHERE m.`threadId` = t.`id` AND m.`automated` <> 2) THEN 1 ELSE 0 END " +
    "WHERE t.`automated` IS NULL",
];

export const IDEMPOTENT_ERROR_CODES_0180 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
