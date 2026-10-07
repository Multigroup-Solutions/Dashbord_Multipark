// Migration 0555 — terminal no ponto (aeroporto). Pauta do Rafael, Jorge 7 out
// 2026: o extra que dá saída + entrada no aeroporto da cidade dele conta esse
// troço como terminal (paga à taxa do nível seguinte). Regras em
// shared/pontoTerminal.ts; interruptor PONTO_TERMINAL (desligado por omissão).
//
//  - `atAirport`: 1 = GPS dentro do aeroporto da cidade do extra nesse registo,
//    0 = GPS fora, NULL = sem GPS / não avaliado (interruptor desligado ou não
//    é extra);
//  - `terminalStatus`: na entrada "start" (abriu um troço de terminal); na
//    saída o estado do troço: "auto" | "pending" | "confirmed" | "rejected";
//    NULL = troço normal;
//  - `terminalReviewedById` / `terminalReviewedAt` / `terminalNote`: quem
//    marcou ou desmarcou à mão, quando e porquê (também no registo de
//    atividade).
//
// Só acrescenta colunas; SEM backfill (os registos antigos ficam normais).
// Idempotente: ADD COLUMN repetido dá ER_DUP_FIELDNAME.

export const MIGRATION_0555_STATEMENTS: string[] = [
  "ALTER TABLE `time_records` ADD COLUMN `atAirport` TINYINT NULL AFTER `locationName`",
  "ALTER TABLE `time_records` ADD COLUMN `terminalStatus` VARCHAR(16) NULL AFTER `atAirport`",
  "ALTER TABLE `time_records` ADD COLUMN `terminalReviewedById` INT NULL AFTER `terminalStatus`",
  "ALTER TABLE `time_records` ADD COLUMN `terminalReviewedAt` TIMESTAMP NULL AFTER `terminalReviewedById`",
  "ALTER TABLE `time_records` ADD COLUMN `terminalNote` VARCHAR(255) NULL AFTER `terminalReviewedAt`",
];

export const IDEMPOTENT_ERROR_CODES_0555 = new Set<string>(["ER_DUP_FIELDNAME"]);
