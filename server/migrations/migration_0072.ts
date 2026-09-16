export const MIGRATION_0072_NAME = '0072_google_business_reviews';
export const IDEMPOTENT_ERROR_CODES_0072 = new Set(['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME']);
export const MIGRATION_0072_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS google_business_locations (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    locationName VARCHAR(100) NOT NULL, accountName VARCHAR(100) NOT NULL,
    title VARCHAR(256) NOT NULL, address TEXT NULL, projectId INT NULL,
    selected TINYINT NOT NULL DEFAULT 0, available TINYINT NOT NULL DEFAULT 1,
    nextPageToken TEXT NULL, lastSyncAt DATETIME NULL, lastError TEXT NULL,
    dirtyAt DATETIME NULL, dirtyVersion INT NOT NULL DEFAULT 0, UNIQUE KEY uq_gbp_location (locationName))`,
  `CREATE TABLE IF NOT EXISTS google_business_review_pending (
    reviewKey VARCHAR(64) NOT NULL PRIMARY KEY, locationId INT NOT NULL,
    payload JSON NOT NULL, candidates JSON NOT NULL, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  'ALTER TABLE google_reviews ADD COLUMN googleReviewKey VARCHAR(64) NULL',
  'ALTER TABLE google_reviews ADD COLUMN googleLocationId INT NULL',
  'ALTER TABLE google_reviews ADD COLUMN googleUpdatedAt VARCHAR(40) NULL',
  'ALTER TABLE google_reviews ADD COLUMN googleReply TEXT NULL',
  'ALTER TABLE google_reviews ADD UNIQUE KEY uq_google_review_key (googleReviewKey)',
];
