export const MIGRATION_0069_STATEMENTS = [
  'ALTER TABLE multipark_bookings ADD COLUMN historyRetryAt DATETIME NULL',
  'ALTER TABLE multipark_bookings ADD COLUMN historyAttempts INT NOT NULL DEFAULT 0',
  'ALTER TABLE multipark_bookings ADD COLUMN historyErrorCode VARCHAR(64) NULL',
];
export const IDEMPOTENT_ERROR_CODES_0069 = new Set(['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME']);
