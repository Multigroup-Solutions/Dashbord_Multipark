// Migration 0376 — Tarefas: "Eliminar" passa a ARQUIVAR (P3 lote 18a).
// (Era a 0375; passou a 0376 porque o #235 do WhatsApp usou a 0375 no main.)
// Antes, apagar uma tarefa fazia DELETE (tarefa, responsáveis e comentários) e
// as automáticas (checklists, serviços) voltavam a nascer na hora seguinte.
// Agora a linha fica com `archivedAt`/`archivedById`: sai das listas, dos
// contadores, dos avisos e do Google, mas os geradores continuam a vê-la (não
// a recriam). Os modelos das checklists também se arquivam (e ficam inativos).
// Idempotente: ADD COLUMN ignora o que já existe. Não apaga nada.
export const MIGRATION_0376_STATEMENTS: string[] = [
  "ALTER TABLE `tasks` ADD COLUMN `archivedAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `tasks` ADD COLUMN `archivedById` INT NULL",
  "ALTER TABLE `task_templates` ADD COLUMN `archivedAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `task_templates` ADD COLUMN `archivedById` INT NULL",
];

export const IDEMPOTENT_ERROR_CODES_0376 = new Set<string>(["ER_DUP_FIELDNAME"]);
