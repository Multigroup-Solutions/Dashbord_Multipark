// Migration 0565 — Extras Dia: a mão humana manda na escala (Jorge, 7 out 2026:
// "a Márcia tirou um dos condutores e o sistema pôs outra vez").
//
// `extras_dia_schedules` passa a guardar a ÚLTIMA mudança feita por uma pessoa
// na escala de (dia, cidade) — pôr, tirar, mudar horas, mandar para casa,
// preencher, refazer a proposta, confirmar, suspender:
//  - `manualAt`: quando (NULL = ninguém mexeu à mão);
//  - `manualById`: quem (users.id);
//  - `manualWhat`: o quê (texto curto, ex.: "tirou").
// Com `manualAt` preenchido o cron nunca mais propõe nem muda esse dia/cidade
// (regra em shared/extrasSchedule.ts → autoProposeBlockedReason).
//
// Só acrescenta colunas; SEM backfill (os dias antigos mexidos à mão
// reconhecem-se pelas linhas postas à mão e pelo arquivo das tiradas).
// Idempotente: ADD COLUMN repetido dá ER_DUP_FIELDNAME.

export const MIGRATION_0565_STATEMENTS: string[] = [
  "ALTER TABLE `extras_dia_schedules` ADD COLUMN `manualAt` TIMESTAMP NULL",
  "ALTER TABLE `extras_dia_schedules` ADD COLUMN `manualById` INT NULL",
  "ALTER TABLE `extras_dia_schedules` ADD COLUMN `manualWhat` VARCHAR(32) NULL",
];

export const IDEMPOTENT_ERROR_CODES_0565 = new Set<string>(["ER_DUP_FIELDNAME"]);
