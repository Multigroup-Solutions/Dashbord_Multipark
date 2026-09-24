// Migration 0079 — QR code dos PDAs (Fase 2, 24 set 2026).
//
// Cada PDA tem um código secreto impresso num QR colado no aparelho. Ler o QR
// no próprio aparelho regista-o como esse PDA (sem escolher de uma lista); a
// partir daí quem faz login nele fica com o PDA/Zello até sair.

export const MIGRATION_0079_NAME = "0079_pda_qr_code";

export const MIGRATION_0079_STATEMENTS: string[] = [
  "ALTER TABLE `pdas` ADD COLUMN `qrCode` VARCHAR(40) NULL",
];

export const IDEMPOTENT_ERROR_CODES_0079 = new Set<string>(["ER_DUP_FIELDNAME"]);
