// Migration 0250 — reservas ao vivo (29 set 2026): a conversa de WhatsApp
// liga-se à reserva pelo id da Multipark (texto), não pelo id da cópia local.
//   - linkedBookingRef: id da reserva na Multipark;
//   - linkedBookingLabel: "#n.º · nome" para as listas (sem ler a Multipark).
// As ligações antigas (linkedBookingId → cópia) passam para as colunas novas
// uma vez; a coluna antiga fica (não se apaga nada). Idempotente.

export const MIGRATION_0250_NAME = "0250_whatsapp_booking_ref";

export const MIGRATION_0250_STATEMENTS: string[] = [
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `linkedBookingRef` VARCHAR(128) NULL",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `linkedBookingLabel` VARCHAR(255) NULL",
  "CREATE INDEX `idx_wa_conv_booking_ref` ON `whatsapp_conversations` (`linkedBookingRef`)",
  "UPDATE `whatsapp_conversations` w JOIN `multipark_bookings` b ON b.id = w.linkedBookingId"
    + " SET w.linkedBookingRef = b.externalId,"
    + " w.linkedBookingLabel = LEFT(TRIM(CONCAT('#', COALESCE(NULLIF(b.bookingNumber, ''), b.externalId), ' · ', COALESCE(NULLIF(TRIM(CONCAT_WS(' ', b.clientFirstName, b.clientLastName)), ''), '—'))), 255)"
    + " WHERE w.linkedBookingId IS NOT NULL AND w.linkedBookingRef IS NULL",
];

export const IDEMPOTENT_ERROR_CODES_0250 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
