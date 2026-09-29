// Migration 0235 — "Pressão" do Extras-Dia (fase 5B, 27 set 2026).
//
// Resultado do trabalho `extras-pressure` (server/extrasPressure.ts): os
// últimos 60 dias da BD da Multipark agregados por grupo de parques × dia da
// semana × hora de Lisboa. Uma linha por:
//   kind = 'slot'  (grupo, dia da semana 1–7, hora 0–23): volume, concorrência,
//                  tempos de entrega (p50/p75/p90) e de recolha (p50/p75);
//   kind = 'load'  (grupo, escalão de carga, ponta 0/1): tempo de entrega;
//   kind = 'done'  (grupo "_done"): marca de janela completa.
// Chave: janela (windowEnd = último dia, inclusive) + grupo + célula. As
// janelas com mais de 14 dias apagam-se no fim de cada corrida.
// Idempotente (corre em cada arranque via ensureRecentSchema).

export const MIGRATION_0235_NAME = "0235_ops_pressure_stats";

export const MIGRATION_0235_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `ops_pressure_stats` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`windowEnd` DATE NOT NULL, " +
    "`windowDays` SMALLINT NOT NULL DEFAULT 60, " +
    "`parkGroup` VARCHAR(40) NOT NULL, " +
    "`groupLabel` VARCHAR(80) NULL, " +
    "`kind` VARCHAR(8) NOT NULL, " +
    "`weekday` TINYINT NOT NULL DEFAULT 0, " +
    "`hour` TINYINT NOT NULL DEFAULT 0, " +
    "`loadBucket` TINYINT NOT NULL DEFAULT 0, " +
    "`rush` TINYINT NOT NULL DEFAULT 0, " +
    "`days` SMALLINT NOT NULL DEFAULT 0, " +
    "`checkinsDone` INT NOT NULL DEFAULT 0, " +
    "`checkoutsDone` INT NOT NULL DEFAULT 0, " +
    "`checkinsStarted` INT NOT NULL DEFAULT 0, " +
    "`checkoutsStarted` INT NOT NULL DEFAULT 0, " +
    "`concurrencyAvg` DECIMAL(8,2) NULL, " +
    "`concurrencyMax` INT NULL, " +
    "`deliveryN` INT NOT NULL DEFAULT 0, " +
    "`deliveryP50` DECIMAL(7,1) NULL, " +
    "`deliveryP75` DECIMAL(7,1) NULL, " +
    "`deliveryP90` DECIMAL(7,1) NULL, " +
    "`pickupN` INT NOT NULL DEFAULT 0, " +
    "`pickupP50` DECIMAL(7,1) NULL, " +
    "`pickupP75` DECIMAL(7,1) NULL, " +
    "`computedAt` DATETIME NOT NULL, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_ops_pressure_cell` (`windowEnd`, `parkGroup`, `kind`, `weekday`, `hour`, `loadBucket`, `rush`), " +
    "KEY `idx_ops_pressure_group` (`parkGroup`, `windowEnd`)" +
    ") ENGINE=InnoDB",
];

export const IDEMPOTENT_ERROR_CODES_0235 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME", "ER_DUP_FIELDNAME"]);
