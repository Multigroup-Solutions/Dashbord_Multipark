// Migration 0835 — Críticas: as que vieram por email ficam só na caixa de correio
// (Jorge, 15 out 2026: "as críticas do Google vêm pela API; as que entraram por
// email estão a repetir — tira-as das Críticas, mas não apagues").
//
// `google_reviews` ganha a marca de quem trouxe a crítica de um email:
//  - `emailImportedAt` DATETIME NULL: quando foi importada (à mão, na caixa de
//    correio, ou sozinha com o interruptor REVIEWS_FROM_EMAIL ligado);
//  - `emailImportedById` INT NULL: quem a importou à mão (NULL = o sistema).
// Uma crítica com `sourceEmailId`, sem `googleReviewKey` e sem `emailImportedAt`
// fica FORA das Críticas e dos números (filtro na leitura — server/reviewVisibility.ts).
// As que já existem ficam todas sem marca, ou seja fora: SEM backfill (nenhum
// UPDATE em massa) e nada se apaga.
//  - índice em `sourceEmailId`: "esta mensagem já é crítica?" sem ler a tabela toda.
//
// Só acrescenta. Idempotente: ADD COLUMN / ADD INDEX repetidos dão
// ER_DUP_FIELDNAME / ER_DUP_KEYNAME (calados).

export const MIGRATION_0835_STATEMENTS: string[] = [
  "ALTER TABLE `google_reviews` ADD COLUMN `emailImportedAt` DATETIME NULL",
  "ALTER TABLE `google_reviews` ADD COLUMN `emailImportedById` INT NULL",
  "ALTER TABLE `google_reviews` ADD INDEX `idx_google_reviews_source_email` (`sourceEmailId`)",
];

export const IDEMPOTENT_ERROR_CODES_0835 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
