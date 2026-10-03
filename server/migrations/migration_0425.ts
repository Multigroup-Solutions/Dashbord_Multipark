// Migration 0425 — Avaliação: acidentes confirmados (P3 lote 22c, D15 do Jorge,
// 3 out 2026: acidente = −6000 pontos).
//  `evaluation_accidents`: uma ocorrência da app Multipark que um team leader
//  (ou acima) confirmou como ACIDENTE, com quem conduzia. É o que o motor da
//  avaliação conta (metrics.accidents) no dia operacional da ocorrência.
//  - Nunca se apaga: "Desfazer" marca `voidedAt` (quem, porquê) e a linha fica.
//  - `activeKey` = id da ocorrência enquanto está ativa, NULL depois de
//    desfeita: o UNIQUE garante UMA confirmação ativa por ocorrência (o MySQL
//    deixa vários NULL), e pode voltar a confirmar-se depois de desfeita.
// Idempotente: CREATE TABLE IF NOT EXISTS.
export const MIGRATION_0425_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `evaluation_accidents` ("
    + " `id` INT NOT NULL AUTO_INCREMENT,"
    + " `occurrenceId` VARCHAR(64) NOT NULL,"
    + " `activeKey` VARCHAR(64) NULL,"
    + " `employeeId` INT NOT NULL,"
    + " `day` VARCHAR(10) NOT NULL,"
    + " `occurredAt` DATETIME NULL,"
    + " `title` VARCHAR(200) NULL,"
    + " `bookingId` VARCHAR(64) NULL,"
    + " `bookingCode` VARCHAR(64) NULL,"
    + " `plate` VARCHAR(32) NULL,"
    + " `parkCity` VARCHAR(64) NULL,"
    + " `note` VARCHAR(500) NULL,"
    + " `confirmedById` INT NOT NULL,"
    + " `confirmedByName` VARCHAR(128) NULL,"
    + " `confirmedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,"
    + " `voidedAt` DATETIME NULL,"
    + " `voidedById` INT NULL,"
    + " `voidedByName` VARCHAR(128) NULL,"
    + " `voidReason` VARCHAR(255) NULL,"
    + " PRIMARY KEY (`id`),"
    + " UNIQUE KEY `uq_eval_accidents_active` (`activeKey`),"
    + " KEY `idx_eval_accidents_occ` (`occurrenceId`),"
    + " KEY `idx_eval_accidents_day` (`day`),"
    + " KEY `idx_eval_accidents_emp_day` (`employeeId`, `day`)"
    + ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
];

export const IDEMPOTENT_ERROR_CODES_0425 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME"]);
