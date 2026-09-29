// Migration 0295 — Parcerias a partir da Multipark (decisão do dono, 29 set
// 2026: "fica tudo por lá"). Cada registo das Parcerias fica preso a uma
// entidade da Multipark (parceiro "Partner".userId, Pro "pro:<Client.id>",
// avença "plan:<ClientPlan.id>"): o tipo e a comissão passam a vir de lá (só
// leitura). O que é só nosso (NIF, acordo, notas) fica. Os registos antigos sem
// par na Multipark são ARQUIVADOS (archivedAt), nunca apagados. Só acrescenta.

export const MIGRATION_0295_NAME = "0295_partnerships_multipark_source";

export const MIGRATION_0295_STATEMENTS: string[] = [
  "ALTER TABLE `partnerships` ADD COLUMN `multiparkKind` VARCHAR(16) NULL",
  "ALTER TABLE `partnerships` ADD COLUMN `multiparkSnapshot` TEXT NULL",
  "ALTER TABLE `partnerships` ADD COLUMN `multiparkSyncedAt` TIMESTAMP NULL",
  "ALTER TABLE `partnerships` ADD COLUMN `archivedAt` TIMESTAMP NULL",
  "ALTER TABLE `partnerships` ADD COLUMN `archivedReason` VARCHAR(255) NULL",
  "CREATE INDEX `idx_partnerships_mp` ON `partnerships` (`multiparkPartnerId`)",
];

export const IDEMPOTENT_ERROR_CODES_0295 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
