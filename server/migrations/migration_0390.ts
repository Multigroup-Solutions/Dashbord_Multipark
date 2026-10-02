// Migration 0390 — Base de conhecimento (P3 lote 18d): `uploadSha` = SHA-256
// dos bytes de um ficheiro carregado. Carregar o mesmo ficheiro outra vez
// devolve o documento que já existe (antes criava um segundo, e as respostas
// do assistente vinham com trechos repetidos).
// Idempotente: ADD COLUMN / ADD KEY ignoram o que já existe. Não apaga nada.
export const MIGRATION_0390_STATEMENTS: string[] = [
  "ALTER TABLE `kb_documents` ADD COLUMN `uploadSha` CHAR(64) NULL",
  "ALTER TABLE `kb_documents` ADD KEY `idx_kb_documents_upload_sha` (`uploadSha`)",
];

export const IDEMPOTENT_ERROR_CODES_0390 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
