// Migration 0365 — Comunicação única: caixas por tema para o email e o
// WhatsApp (P3 lote 17f, out 2026 — Jorge: "separar por recursos humanos,
// reservas, alterações, serviços extra, reclamações, parcerias, faturação").
//  1. `mail_mailboxes.aiRoute`: caixa geral cujos emails novos a IA separa
//     pelos temas (o info@ fica assim, uma vez).
//  2. Caixas por tema novas (sourceKind "tema", sem conta Gmail própria):
//     Alterações, Serviços extra, Parcerias, Faturação. RH, Reservas e
//     Reclamações já existiam. Uma vez: o dono pode mudar/desativar sem que voltem.
//  3. `mail_threads.routedFromKey` / `routedBy`: conversa movida de caixa.
//  4. `whatsapp_conversations.boxKey` / `boxSource`: a caixa da conversa
//     (null = Geral) e quem a escolheu (rule | ai | manual), com o
//     preenchimento inicial UMA vez: colaborador ou candidato → RH; intenção
//     da IA → caixa do tema.
// Idempotente: ADD COLUMN/ADD KEY ignoram o que já existe; o resto só corre
// sem a marca em `app_notification_maintenance`.
import { TOPIC_BOX_SEEDS } from "../../shared/commsBoxes";

export const MIGRATION_0365_NAME = "0365_comms_topic_boxes";
export const SEED_0365_ID = "0365_comms_topic_boxes";

const q = (s: string) => "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
const once = "NOT EXISTS (SELECT 1 FROM `app_notification_maintenance` mk WHERE mk.`id` = '" + SEED_0365_ID + "')";

const seed = (b: (typeof TOPIC_BOX_SEEDS)[number]) =>
  "INSERT IGNORE INTO `mail_mailboxes` (`mailboxKey`, `label`, `addressesJson`, `sourceKind`, `sourceEmail`, `module`, `pipeline`, `cityRule`, " +
  "`visibleRolesJson`, `signaturesJson`, `catchAll`, `notify`, `active`, `sortOrder`, `aiRoute`) SELECT " +
  [q(b.key), q(b.label), q("[]"), q("tema"), "NULL", q(b.module), "NULL", q(b.cityRule), q("[]"), q("{}"), "0", "1", "1", String(b.sortOrder), "0"].join(", ") +
  " FROM DUAL WHERE " + once;

const intentCase = "CASE `aiIntent` " +
  "WHEN 'reserva' THEN 'reservas' WHEN 'alteracao' THEN 'alteracoes' WHEN 'cancelamento' THEN 'alteracoes' " +
  "WHEN 'perdido_achado' THEN 'perdidos' WHEN 'reclamacao' THEN 'reclamacoes' WHEN 'recrutamento' THEN 'rh' END";

export const MIGRATION_0365_STATEMENTS: string[] = [
  "ALTER TABLE `mail_mailboxes` ADD COLUMN `aiRoute` TINYINT NOT NULL DEFAULT 0",
  "ALTER TABLE `mail_threads` ADD COLUMN `routedFromKey` VARCHAR(40) NULL",
  "ALTER TABLE `mail_threads` ADD COLUMN `routedBy` VARCHAR(8) NULL",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `boxKey` VARCHAR(40) NULL",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `boxSource` VARCHAR(8) NULL",
  "ALTER TABLE `whatsapp_conversations` ADD KEY `idx_whatsapp_conversations_box` (`boxKey`)",
  ...TOPIC_BOX_SEEDS.map(seed),
  "UPDATE `mail_mailboxes` SET `aiRoute` = 1 WHERE `mailboxKey` = 'info' AND " + once,
  // WhatsApp: colaboradores e candidatos → RH.
  "UPDATE `whatsapp_conversations` SET `boxKey` = 'rh', `boxSource` = 'rule' WHERE `boxKey` IS NULL AND (`employeeId` IS NOT NULL OR EXISTS " +
    "(SELECT 1 FROM `extra_leads` l WHERE l.`phoneE164` = `whatsapp_conversations`.`phoneE164` COLLATE utf8mb4_unicode_ci)) AND " + once,
  // O resto: pela intenção que a IA já tinha dado.
  "UPDATE `whatsapp_conversations` SET `boxKey` = " + intentCase + ", `boxSource` = 'ai' WHERE `boxKey` IS NULL AND `aiIntent` IN " +
    "('reserva','alteracao','cancelamento','perdido_achado','reclamacao','recrutamento') AND " + once,
  "INSERT IGNORE INTO `app_notification_maintenance` (`id`) VALUES ('" + SEED_0365_ID + "')",
];

export const IDEMPOTENT_ERROR_CODES_0365 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
