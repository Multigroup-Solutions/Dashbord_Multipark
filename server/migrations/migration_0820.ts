// Migration 0820 — Ponto em três modos por pessoa (plano 63, passo 1).
//
//  - `employees.pontoMode`: cópia do modo de HOJE (NULL = sem modo, as regras
//    de hoje; `fixed`, `exempt`, `always_on`). Só para mostrar: o ordenado e a
//    Avaliação leem o histórico.
//  - `employee_ponto_modes`: o histórico. Cada mudança é uma linha "a partir de"
//    (`effectiveFrom`, dia operacional), com o motivo, quem e quando. Uma mudança
//    posterior com data igual ou anterior substitui as seguintes (fica tudo;
//    shared/pontoMode.ts `pontoModeTimeline`). Nada se apaga.
//  - `ponto_alerts`: alertas do ponto (zona, caras, turnos longos, fim de semana
//    da isenção…), um por (ficha, `dedupeKey`). A chave não leva o id da ficha:
//    juntar fichas muda o `employeeId` e a chave continua certa.
//  - `ponto_mode_acks`: os avisos escritos lidos ("Li" na app, ou em papel,
//    registado pelo RH). As colunas da ativação do modo 3 (foto, GPS, Zello)
//    ficam já criadas e vazias até ao passo 8.
//  - `time_records`: o rasto de cada picagem — o modo desse dia, de onde veio a
//    selfie (câmara/ficheiro), a idade do ficheiro, a imprecisão do GPS e a conta
//    que picou. Só informação: nenhuma conta de horas as lê.
//
// Só acrescenta (colunas NULL, tabelas novas, índices). Idempotente: ADD
// COLUMN/INDEX e CREATE TABLE IF NOT EXISTS calam o que já existe. Sem dados.
const col = (table: string, name: string, type: string) => `ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` ${type}`;

export const MIGRATION_0820_STATEMENTS: string[] = [
  col("employees", "pontoMode", "VARCHAR(12) NULL"),
  "CREATE TABLE IF NOT EXISTS `employee_ponto_modes` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`employeeId` INT NOT NULL, " +
    "`mode` VARCHAR(12) NULL, " +
    "`effectiveFrom` DATE NOT NULL, " +
    "`note` VARCHAR(255) NULL, " +
    "`setById` INT NULL, " +
    "`setAt` DATETIME NOT NULL, " +
    "PRIMARY KEY (`id`), " +
    "KEY `idx_employee_ponto_modes_emp` (`employeeId`, `effectiveFrom`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  "CREATE TABLE IF NOT EXISTS `ponto_alerts` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`employeeId` INT NOT NULL, " +
    "`kind` VARCHAR(32) NOT NULL, " +
    "`day` DATE NOT NULL, " +
    "`timeRecordId` INT NULL, " +
    "`faceCheckId` INT NULL, " +
    "`autoDayId` INT NULL, " +
    "`detail` VARCHAR(500) NULL, " +
    "`severity` VARCHAR(8) NOT NULL DEFAULT 'amber', " +
    "`status` VARCHAR(12) NOT NULL DEFAULT 'open', " +
    "`notifiedAt` DATETIME NULL, " +
    "`reviewedById` INT NULL, " +
    "`reviewedAt` DATETIME NULL, " +
    "`reviewNote` VARCHAR(255) NULL, " +
    "`dedupeKey` VARCHAR(120) NOT NULL, " +
    "`createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_ponto_alerts_dedupe` (`employeeId`, `dedupeKey`), " +
    "KEY `idx_ponto_alerts_status` (`status`, `kind`, `day`), " +
    "KEY `idx_ponto_alerts_emp_day` (`employeeId`, `day`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  "CREATE TABLE IF NOT EXISTS `ponto_mode_acks` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`employeeId` INT NOT NULL, " +
    "`mode` VARCHAR(12) NULL, " +
    "`notice` VARCHAR(24) NOT NULL, " +
    "`channel` VARCHAR(8) NOT NULL DEFAULT 'app', " +
    "`ackAt` DATETIME NOT NULL, " +
    "`ackByUserId` INT NULL, " +
    "`note` VARCHAR(255) NULL, " +
    "`photoKey` VARCHAR(512) NULL, " +
    "`latitude` DECIMAL(10,7) NULL, " +
    "`longitude` DECIMAL(10,7) NULL, " +
    "`gpsAccuracyM` INT NULL, " +
    "`zelloUsername` VARCHAR(128) NULL, " +
    "`zelloSeenAt` DATETIME NULL, " +
    "PRIMARY KEY (`id`), " +
    "KEY `idx_ponto_mode_acks_emp` (`employeeId`, `notice`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  col("time_records", "pontoMode", "VARCHAR(12) NULL"),
  col("time_records", "photoSource", "VARCHAR(8) NULL"),
  col("time_records", "photoFileAgeS", "INT NULL"),
  col("time_records", "gpsAccuracyM", "INT NULL"),
  col("time_records", "createdByUserId", "INT NULL"),
];

export const IDEMPOTENT_ERROR_CODES_0820 = new Set<string>(["ER_DUP_FIELDNAME", "ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME"]);
