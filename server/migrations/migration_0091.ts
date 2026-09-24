// Migration 0091 — Tarefas: origem (link + fecho automático), prazo com hora,
// checklists recorrentes por turno/cidade e comentários (24 set 2026).
//
//  - tasks: `sourceModule`/`sourceId`/`sourceKey` (origem: availability,
//    complaint, incident, lost_found, manual, template), `dueHasTime` (prazo
//    com hora exata; 0 = fim do dia de Lisboa), `templateId`/`templateDate`/
//    `templateShift` com UNIQUE (geração idempotente por modelo × dia × turno),
//    `completedById` (quem concluiu — sem alerta ao criador se foi ele).
//  - task_assignees: índices por tarefa e por pessoa (filtro em SQL).
//  - Tabelas novas: task_templates, task_comments.
//
// Idempotente: CREATE TABLE IF NOT EXISTS; ADD COLUMN → ER_DUP_FIELDNAME;
// ADD INDEX → ER_DUP_KEYNAME.

export const MIGRATION_0091_NAME = "0091_tasks_sources_templates_comments";

export const MIGRATION_0091_STATEMENTS: string[] = [
  "ALTER TABLE `tasks` ADD COLUMN `sourceModule` VARCHAR(32) NULL",
  "ALTER TABLE `tasks` ADD COLUMN `sourceId` INT NULL",
  "ALTER TABLE `tasks` ADD COLUMN `sourceKey` VARCHAR(128) NULL",
  "ALTER TABLE `tasks` ADD COLUMN `dueHasTime` TINYINT NOT NULL DEFAULT 0",
  "ALTER TABLE `tasks` ADD COLUMN `templateId` INT NULL",
  "ALTER TABLE `tasks` ADD COLUMN `templateDate` VARCHAR(10) NULL",
  "ALTER TABLE `tasks` ADD COLUMN `templateShift` VARCHAR(8) NULL",
  "ALTER TABLE `tasks` ADD COLUMN `completedById` INT NULL",
  "ALTER TABLE `tasks` ADD INDEX `tasks_source_idx` (`sourceModule`, `sourceId`)",
  "ALTER TABLE `tasks` ADD INDEX `tasks_source_key_idx` (`sourceKey`)",
  "ALTER TABLE `tasks` ADD UNIQUE INDEX `tasks_template_run_uq` (`templateId`, `templateDate`, `templateShift`)",
  "ALTER TABLE `tasks` ADD INDEX `tasks_status_idx` (`taskStatus`)",
  "ALTER TABLE `task_assignees` ADD INDEX `task_assignees_task_idx` (`taskId`)",
  "ALTER TABLE `task_assignees` ADD INDEX `task_assignees_emp_idx` (`employeeId`)",

  "CREATE TABLE IF NOT EXISTS `task_templates` ("
    + "`id` INT NOT NULL AUTO_INCREMENT,"
    + "`title` VARCHAR(256) NOT NULL,"
    + "`description` TEXT NULL,"
    + "`cityProjectId` INT NULL,"
    + "`shift` VARCHAR(8) NOT NULL DEFAULT 'any',"
    + "`weekdaysMask` INT NOT NULL DEFAULT 127,"
    + "`dueHour` INT NULL,"
    + "`priority` VARCHAR(16) NOT NULL DEFAULT 'medium',"
    + "`assigneeRole` VARCHAR(32) NULL,"
    + "`assigneeEmployeeIds` TEXT NULL,"
    + "`active` TINYINT NOT NULL DEFAULT 1,"
    + "`createdById` INT NULL,"
    + "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,"
    + "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,"
    + "PRIMARY KEY (`id`),"
    + "INDEX `task_templates_city_idx` (`cityProjectId`)"
    + ")",
  "CREATE TABLE IF NOT EXISTS `task_comments` ("
    + "`id` INT NOT NULL AUTO_INCREMENT,"
    + "`taskId` INT NOT NULL,"
    + "`userId` INT NOT NULL,"
    + "`body` TEXT NOT NULL,"
    + "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,"
    + "PRIMARY KEY (`id`),"
    + "INDEX `task_comments_task_idx` (`taskId`)"
    + ")",
];

export const IDEMPOTENT_ERROR_CODES_0091 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME", "ER_TABLE_EXISTS_ERROR"]);
