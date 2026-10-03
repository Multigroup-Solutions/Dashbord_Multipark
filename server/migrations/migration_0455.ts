// Migration 0455 — Comunicação (P3 lote 24e, Jorge, 3 out 2026):
//  - D40: caixa por tema própria para os CANCELAMENTOS (antes iam para
//    Alterações). Mesmo módulo e regra de cidade das Alterações. Uma vez: o
//    dono pode mudar/desativar sem que volte.
//  - As conversas de WhatsApp que a IA tinha posto em Alterações por serem
//    cancelamento passam para a caixa nova (as escolhidas à mão não mexem).
// Nada se apaga. Só corre sem a marca em `app_notification_maintenance`.
import { CANCELLATIONS_BOX } from "../../shared/commsBoxes";

export const SEED_0455_ID = "0455_cancellations_box";

const q = (s: string) => "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
const once = "NOT EXISTS (SELECT 1 FROM `app_notification_maintenance` mk WHERE mk.`id` = '" + SEED_0455_ID + "')";
const b = CANCELLATIONS_BOX;

export const MIGRATION_0455_STATEMENTS: string[] = [
  "INSERT IGNORE INTO `mail_mailboxes` (`mailboxKey`, `label`, `addressesJson`, `sourceKind`, `sourceEmail`, `module`, `pipeline`, `cityRule`, " +
    "`visibleRolesJson`, `signaturesJson`, `catchAll`, `notify`, `active`, `sortOrder`, `aiRoute`) SELECT " +
    [q(b.key), q(b.label), q("[]"), q("tema"), "NULL", q(b.module), "NULL", q(b.cityRule), q("[]"), q("{}"), "0", "1", "1", String(b.sortOrder), "0"].join(", ") +
    " FROM DUAL WHERE " + once,
  "UPDATE `whatsapp_conversations` SET `boxKey` = " + q(b.key) + " WHERE `boxKey` = 'alteracoes' AND `boxSource` = 'ai' AND `aiIntent` = 'cancelamento' AND " + once,
  "INSERT IGNORE INTO `app_notification_maintenance` (`id`) VALUES ('" + SEED_0455_ID + "')",
];

export const IDEMPOTENT_ERROR_CODES_0455 = new Set<string>([]);
