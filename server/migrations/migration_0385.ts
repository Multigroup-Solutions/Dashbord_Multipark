// Migration 0385 — Formação: nada se apaga (P3 lote 18c).
//  - Vídeos, manuais, FAQs, perguntas do quiz e percursos ARQUIVAM-SE em vez
//    de se apagarem. Antes, apagar um vídeo que estava num percurso deixava
//    um item obrigatório que ninguém conseguia concluir, e quem o tinha ficava
//    "em atraso" e fora da escala para sempre. Um item arquivado deixa de
//    contar como obrigatório.
//  - Remover uma atribuição marca-a (`removedAt`/`removedById`) em vez de a
//    apagar: fica o rasto de quem tinha que percurso e quem o tirou.
// Idempotente: ADD COLUMN ignora o que já existe. Não apaga nada.
export const MIGRATION_0385_STATEMENTS: string[] = [
  "ALTER TABLE `training_videos` ADD COLUMN `archivedAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `training_manuals` ADD COLUMN `archivedAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `faqs` ADD COLUMN `archivedAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `quiz_questions` ADD COLUMN `archivedAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `career_exam_questions` ADD COLUMN `archivedAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `training_paths` ADD COLUMN `archivedAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `training_assignments` ADD COLUMN `removedAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `training_assignments` ADD COLUMN `removedById` INT NULL",
];

export const IDEMPOTENT_ERROR_CODES_0385 = new Set<string>(["ER_DUP_FIELDNAME"]);
