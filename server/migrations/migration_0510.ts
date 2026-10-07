// Migration 0510 — Recrutamento (41d, Jorge 7 out 2026: "ver o que não é
// recrutamento e mandar para o lixo… não conseguimos tirar nada daí, fica aí
// para sempre"): estado de cada email de recursos-humanos@ — por tratar (NULL
// ou 'open'), 'done' (pronta) ou 'trash' (lixo) — com quem e quando. Nada se
// apaga: sai da lista e volta com "Repor". Só acrescenta. Idempotente.
export const MIGRATION_0510_STATEMENTS: string[] = [
  "ALTER TABLE `inbound_emails` ADD COLUMN `recruitmentState` VARCHAR(12) NULL",
  "ALTER TABLE `inbound_emails` ADD COLUMN `recruitmentStateAt` DATETIME NULL",
  "ALTER TABLE `inbound_emails` ADD COLUMN `recruitmentStateById` INT NULL",
];

export const IDEMPOTENT_ERROR_CODES_0510 = new Set<string>(["ER_DUP_FIELDNAME"]);
