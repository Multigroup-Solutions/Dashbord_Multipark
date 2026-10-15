// Migration 0700 — Críticas: marcas reversíveis (plano MPV, F6b — R2/R3).
//
// Nada se apaga: uma crítica que não o é (email que entrou pelas Críticas sem
// ser um aviso de avaliação) fica `notAReview = 1`; a mesma crítica que chegou
// duas vezes fica `duplicateOf = <id da primeira>`. As duas saem das listas,
// dos números e dos rascunhos automáticos, e desfazem-se em Críticas → Limpeza.
//  - `reviewMarkedAt` / `reviewMarkedById`: quando e quem marcou (NULL = o sistema);
//  - `reviewMarkUndoneAt`: uma pessoa desfez a marca — a limpeza não volta a propor esta crítica;
//  - `reviewMarkBackup`: JSON com o rascunho tirado ao marcar (repõe-se ao desfazer).
//
// Só acrescenta (colunas com omissão/NULL, sem backfill). Idempotente:
// ADD COLUMN / ADD INDEX repetidos dão ER_DUP_FIELDNAME / ER_DUP_KEYNAME (calados).

export const MIGRATION_0700_STATEMENTS: string[] = [
  "ALTER TABLE `google_reviews` ADD COLUMN `notAReview` TINYINT NOT NULL DEFAULT 0",
  "ALTER TABLE `google_reviews` ADD COLUMN `duplicateOf` INT NULL",
  "ALTER TABLE `google_reviews` ADD COLUMN `reviewMarkedAt` DATETIME NULL",
  "ALTER TABLE `google_reviews` ADD COLUMN `reviewMarkedById` INT NULL",
  "ALTER TABLE `google_reviews` ADD COLUMN `reviewMarkUndoneAt` DATETIME NULL",
  "ALTER TABLE `google_reviews` ADD COLUMN `reviewMarkBackup` TEXT NULL",
  "ALTER TABLE `google_reviews` ADD INDEX `idx_google_reviews_duplicate_of` (`duplicateOf`)",
];

export const IDEMPOTENT_ERROR_CODES_0700 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
