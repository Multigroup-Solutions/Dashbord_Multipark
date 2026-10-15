// Migration 0715 — plano MPV, F7 (seguimento da auditoria).
//
// A 0705 foi publicada em duas versões: numa BD onde a 1.ª (250a35ca) já
// criou `extras_dia_alerts` e `review_auto_publish`, o CREATE TABLE IF NOT
// EXISTS da 2.ª não acrescenta as colunas novas. Aqui acrescentam-se (ou ficam,
// se já lá estiverem):
//  - extras_dia_alerts: `released`, `attempts` e `recipients` passa a aceitar
//    NULL (NULL = ainda por avisar);
//  - review_auto_publish: `reviewTextAtPrepare`, `verifyFailures` e `sentAt`
//    (marcador gravado ANTES de enviar à Google/Windsor: uma resposta presa em
//    "a publicar" que já está na fonte com o nosso texto fica "publicada").
//
// Só acrescenta (colunas com omissão/NULL, sem backfill). Idempotente:
// ADD COLUMN repetido dá ER_DUP_FIELDNAME (calado); o MODIFY repete-se sem erro.

export const MIGRATION_0715_STATEMENTS: string[] = [
  "ALTER TABLE `extras_dia_alerts` ADD COLUMN `released` TINYINT NOT NULL DEFAULT 0",
  "ALTER TABLE `extras_dia_alerts` ADD COLUMN `attempts` INT NOT NULL DEFAULT 1",
  "ALTER TABLE `extras_dia_alerts` MODIFY COLUMN `recipients` INT NULL",
  "ALTER TABLE `review_auto_publish` ADD COLUMN `reviewTextAtPrepare` TEXT NULL",
  "ALTER TABLE `review_auto_publish` ADD COLUMN `verifyFailures` INT NOT NULL DEFAULT 0",
  "ALTER TABLE `review_auto_publish` ADD COLUMN `sentAt` DATETIME NULL",
];

export const IDEMPOTENT_ERROR_CODES_0715 = new Set<string>(["ER_DUP_FIELDNAME"]);
