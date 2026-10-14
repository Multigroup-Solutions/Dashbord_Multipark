// Migration 0660 — Formação com IA (Jorge, 14 out 2026).
//
//  - `faqs`: FAQs feitas pela IA a partir da base de conhecimento.
//    `source` ('ai'; NULL = escrita por uma pessoa), `sourceKbDocId` (o
//    documento de origem, para a ligação "Fonte") e `aiKey` (a pergunta
//    normalizada no momento em que nasceu — não muda quando alguém a edita).
//    Uma FAQ eliminada fica arquivada (0385) e a linha, com o `aiKey`, impede
//    que a IA volte a gerar a mesma.
//  - `training_manuals` / `training_videos`: `area` (multipark, dashboard,
//    operacional, comunicacao) e `subarea` (texto, ex.: "Financeiro"). NULL =
//    ainda não arrumado: a app mostra a área proposta pelas regras até quem
//    gere a formação a confirmar ou corrigir.
//  - `training_attempt_sessions`: `source` ('ai' = perguntas feitas pela IA
//    para esta tentativa; NULL/'bank' = lista fixa), `topic` (o tema pedido) e
//    `answersJson` (as respostas dadas, para rever a tentativa mais tarde).
//  - `training_quiz_ai_questions`: as perguntas que a IA fez para cada
//    tentativa, com a resposta certa (nunca vai para o browser antes de
//    responder) e o documento de origem. Só acréscimo; nunca se apaga.
//
// Só acrescenta. ADD COLUMN / ADD INDEX / CREATE TABLE IF NOT EXISTS ignoram o que já existe.

const col = (table: string, name: string, type: string) => `ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` ${type}`;

export const MIGRATION_0660_STATEMENTS: string[] = [
  col("faqs", "source", "VARCHAR(16) NULL"),
  col("faqs", "sourceKbDocId", "INT NULL"),
  col("faqs", "aiKey", "VARCHAR(190) NULL"),
  "ALTER TABLE `faqs` ADD INDEX `idx_faqs_kb_doc` (`sourceKbDocId`)",
  col("training_manuals", "area", "VARCHAR(24) NULL"),
  col("training_manuals", "subarea", "VARCHAR(80) NULL"),
  col("training_videos", "area", "VARCHAR(24) NULL"),
  col("training_videos", "subarea", "VARCHAR(80) NULL"),
  col("training_attempt_sessions", "source", "VARCHAR(8) NULL"),
  col("training_attempt_sessions", "topic", "VARCHAR(160) NULL"),
  col("training_attempt_sessions", "answersJson", "TEXT NULL"),
  "CREATE TABLE IF NOT EXISTS `training_quiz_ai_questions` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`sessionId` INT NOT NULL, " +
    "`employeeId` INT NOT NULL, " +
    "`ord` INT NOT NULL DEFAULT 0, " +
    "`question` TEXT NOT NULL, " +
    "`optionA` TEXT NOT NULL, " +
    "`optionB` TEXT NOT NULL, " +
    "`optionC` TEXT NOT NULL, " +
    "`optionD` TEXT NOT NULL, " +
    "`correctOption` CHAR(1) NOT NULL, " +
    "`explanation` TEXT NULL, " +
    "`difficulty` VARCHAR(8) NOT NULL DEFAULT 'medium', " +
    "`points` INT NOT NULL DEFAULT 10, " +
    "`questionKey` VARCHAR(190) NULL, " +
    "`sourceKbDocId` INT NULL, " +
    "`sourceManualId` INT NULL, " +
    "`sourceTitle` VARCHAR(300) NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "KEY `idx_tqai_session` (`sessionId`, `ord`), " +
    "KEY `idx_tqai_employee` (`employeeId`, `createdAt`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
];

/** ER_DUP_FIELDNAME (1060), ER_DUP_KEYNAME (1061), ER_TABLE_EXISTS_ERROR (1050). */
export const IDEMPOTENT_ERROR_CODES_0660 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME", "ER_TABLE_EXISTS_ERROR"]);
