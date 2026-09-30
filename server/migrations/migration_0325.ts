// Migration 0325 — tarefas dos serviços (arrumar o #185, Jorge 30 set 2026).
//  1. Gémeas: duas entregas do webhook da mesma reserva ao mesmo tempo criavam
//     a mesma tarefa duas vezes (a chave não era única). Fica a mais antiga; as
//     outras ficam CONCLUÍDAS com a chave marcada "#dup<id>" (nada apagado).
//  2. Chave única SÓ para as tarefas de serviço (coluna gerada): uma chave
//     global partia a Disponibilidade, que reutiliza a sourceKey depois de a
//     anterior estar concluída.
//  3. Repetição do que falha no webhook (service_task_retries), despachada
//     pela fila do webhook (multipark-deliveries, de hora a hora).
// Só acrescenta; o passo 1 é idempotente (sem gémeas não mexe em nada).
export const MIGRATION_0325_NAME = "0325_service_tasks_unique_retries";

export const MIGRATION_0325_STATEMENTS: string[] = [
  // derivada dupla: materializa a lista antes do UPDATE (erro 1093 do MySQL)
  "UPDATE `tasks` t JOIN (SELECT `sourceKey`, MIN(`id`) AS `keepId` FROM (SELECT `sourceKey`, `id` FROM `tasks` WHERE `sourceModule` = 'service' AND `sourceKey` IS NOT NULL) x GROUP BY `sourceKey` HAVING COUNT(*) > 1) d ON d.`sourceKey` = t.`sourceKey` AND t.`id` <> d.`keepId` SET t.`taskStatus` = 'done', t.`completedAt` = COALESCE(t.`completedAt`, UTC_TIMESTAMP()), t.`notifiedComplete` = 1, t.`sourceKey` = LEFT(CONCAT(t.`sourceKey`, '#dup', t.`id`), 128) WHERE t.`sourceModule` = 'service'",
  "ALTER TABLE `tasks` ADD COLUMN `serviceSourceKey` VARCHAR(128) GENERATED ALWAYS AS (IF(`sourceModule` = 'service', `sourceKey`, NULL)) STORED",
  "ALTER TABLE `tasks` ADD UNIQUE INDEX `uq_tasks_service_source_key` (`serviceSourceKey`)",
  "CREATE TABLE IF NOT EXISTS `service_task_retries` ("
    + " `bookingExternalId` VARCHAR(128) NOT NULL PRIMARY KEY,"
    + " `attempts` INT NOT NULL DEFAULT 0,"
    + " `nextAttemptAt` DATETIME NOT NULL,"
    + " `lastError` VARCHAR(255) NULL,"
    + " `doneAt` DATETIME NULL,"
    + " `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,"
    + " `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,"
    + " KEY `idx_service_task_retries_due` (`doneAt`, `nextAttemptAt`)"
    + ")",
];

export const IDEMPOTENT_ERROR_CODES_0325 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME", "ER_TABLE_EXISTS_ERROR"]);
