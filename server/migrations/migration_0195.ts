// Migration 0195 — Todo o email pela API do Gmail + encaminhamento por alias.
//
//  - mail_threads.needsTriage: 1 = conversa recebida numa caixa partilhada
//    por um endereço que NÃO está na tabela de aliases (ex.: em Bcc, alias
//    novo por configurar) → caixa virtual "Por classificar" na Comunicação,
//    até um admin a atribuir a uma caixa (o pipeline do destino corre então).
//    Automáticos (notificações de reserva, emails de sistema) nunca ficam aqui.
//  - mail_threads.routeLabel: etiqueta do alias por onde a conversa entrou
//    (ex.: "Skypark Porto"), mostrada na lista.
//  - índice (needsTriage, lastMessageAt) para a lista/contagem "Por classificar".
//
// A tabela de aliases em si (marca, cidade, destino, responsável, etiqueta,
// ativo) vive no `addressesJson` de cada caixa (mail_mailboxes) — os campos
// novos têm omissões, as caixas existentes continuam válidas; nada é semeado.
// Os emails de sistema (mail_messages.automated = 3) não precisam de coluna.
//
// Idempotente (corre em cada arranque via ensureRecentSchema): ADD COLUMN /
// ADD INDEX já existentes → ER_DUP_FIELDNAME / ER_DUP_KEYNAME ignorados.

export const MIGRATION_0195_NAME = "0195_mail_alias_routing";

export const MIGRATION_0195_STATEMENTS: string[] = [
  "ALTER TABLE `mail_threads` ADD COLUMN `needsTriage` TINYINT NOT NULL DEFAULT 0",
  "ALTER TABLE `mail_threads` ADD COLUMN `routeLabel` VARCHAR(80) NULL",
  "ALTER TABLE `mail_threads` ADD INDEX `idx_mail_threads_triage` (`needsTriage`, `lastMessageAt`)",
];

export const IDEMPOTENT_ERROR_CODES_0195 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
