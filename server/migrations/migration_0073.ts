// Migration 0073 — Responder a críticas Google a partir do dashboard.
//
//   google_reviews.googleReviewName guarda o nome do recurso na Business
//   Profile API (accounts/…/locations/…/reviews/…). A chave 0072
//   (googleReviewKey) é um hash e não permite reconstruir o nome; sem ele não
//   dá para chamar PUT …/reviews/{id}/reply. É preenchido na importação
//   (e, para linhas já importadas, na próxima sincronização).
//
// Idempotente: corre no boot (ensureRecentSchema).

export const MIGRATION_0073_NAME = "0073_google_reviews_review_name";

export const MIGRATION_0073_STATEMENTS: string[] = [
  "ALTER TABLE `google_reviews` ADD COLUMN `googleReviewName` VARCHAR(255) NULL AFTER `googleReply`",
];

export const IDEMPOTENT_ERROR_CODES_0073 = new Set(["ER_DUP_FIELDNAME"]);
