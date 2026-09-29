// Migration 0190 — Agendador único do servidor (/api/cron/tick, chamado de 5
// em 5 min pelo cron-job.org; o GitHub Actions fica como rede de segurança
// de hora a hora). Substitui os schedules dos workflows do GitHub, que o
// GitHub atrasava/saltava (mail-sync 8× em 29 h; daily-ops das 03:30 às 08:45).
//
//  - cron_job_state: uma linha por trabalho do agendador (server/cronSchedule.ts
//    → TICK_JOBS): última corrida (início/fim/OK), estado (ok/error/partial),
//    último erro (truncado), duração, cursor para retomar (`resumeCursor`,
//    JSON com o período), período dado como feito (`periodKey`: dia de
//    Lisboa ou mês), falhas seguidas no período (`attempts`) e o lease
//    (`leaseUntil`/`leaseOwner`) que impede dois ticks de correrem o mesmo
//    trabalho ao mesmo tempo. Datas em UTC, DATETIME(3) (como cron_runs).
//  - daily_driver_history.collectionPass ('sameday' | 'final') + collectedAt:
//    o GPS do Zello é recolhido duas vezes — provisório no próprio dia
//    (23:15–23:55 de Lisboa; à meia-noite o Zello deixa de o dar) e final em
//    D-2 (04:30). A passagem final substitui a provisória (UPDATE da mesma
//    linha, nunca duplica) e só as linhas 'final' contam como "dia recolhido".
//    As linhas antigas ficam 'final' (valor por omissão).
//
// Idempotente (corre em cada arranque via ensureRecentSchema): CREATE TABLE IF
// NOT EXISTS; ADD COLUMN já existente → ER_DUP_FIELDNAME ignorado.

export const MIGRATION_0190_NAME = "0190_cron_job_state";

export const MIGRATION_0190_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `cron_job_state` (" +
    "`jobKey` VARCHAR(64) NOT NULL, " +
    "`lastStartedAt` DATETIME(3) NULL, " +
    "`lastFinishedAt` DATETIME(3) NULL, " +
    "`lastOkAt` DATETIME(3) NULL, " +
    "`lastStatus` VARCHAR(16) NULL, " +
    "`lastError` VARCHAR(1000) NULL, " +
    "`lastDurationMs` INT NULL, " +
    "`resumeCursor` TEXT NULL, " +
    "`periodKey` VARCHAR(16) NULL, " +
    "`attempts` INT NOT NULL DEFAULT 0, " +
    "`leaseUntil` DATETIME(3) NULL, " +
    "`leaseOwner` VARCHAR(40) NULL, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`jobKey`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  "ALTER TABLE `daily_driver_history` ADD COLUMN `collectionPass` VARCHAR(12) NOT NULL DEFAULT 'final'",
  "ALTER TABLE `daily_driver_history` ADD COLUMN `collectedAt` DATETIME NULL",
];

export const IDEMPOTENT_ERROR_CODES_0190 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_FIELDNAME"]);
