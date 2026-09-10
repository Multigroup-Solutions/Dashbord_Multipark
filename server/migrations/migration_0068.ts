// Reserva de trabalhos durável. A tabela antiga de deduplicação não é usada:
// nela, recebido não prova que o evento tenha sido aplicado.
export const MIGRATION_0068_NAME = "0068_booking_delivery_jobs";
export const MIGRATION_0068_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS multipark_webhook_jobs (
    deliveryId VARCHAR(128) NOT NULL PRIMARY KEY,
    bookingExternalId VARCHAR(128) NOT NULL,
    payload JSON NOT NULL,
    state VARCHAR(16) NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    nextAttemptAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    leaseToken VARCHAR(64) NULL,
    leaseUntil DATETIME NULL,
    errorCode VARCHAR(64) NULL,
    receivedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completedAt DATETIME NULL,
    INDEX mp_jobs_due (state, nextAttemptAt, leaseUntil),
    INDEX mp_jobs_booking (bookingExternalId)
  )`,
  "ALTER TABLE multipark_bookings ADD COLUMN detailRetryAt DATETIME NULL",
  "ALTER TABLE multipark_bookings ADD COLUMN detailAttempts INT NOT NULL DEFAULT 0",
  "ALTER TABLE multipark_bookings ADD COLUMN detailErrorCode VARCHAR(64) NULL",
  "ALTER TABLE multipark_bookings ADD COLUMN sourceUpdatedAt DATETIME NULL",
];
export const IDEMPOTENT_ERROR_CODES_0068 = new Set(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
