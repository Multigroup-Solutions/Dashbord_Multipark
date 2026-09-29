// Migration 0310 — JUNTAR registos das Parcerias (pedido do dono, 29 set 2026:
// "o mesmo parceiro separado em vários registos; as reservas ficam fora do
// sítio"). O registo que sai fica arquivado com `mergedIntoId` (o que fica) e
// `mergeJson` (o que se mudou, para Separar). O nome e a chave de campanha do
// que sai passam a apontar para o que fica. Só acrescenta.
export const MIGRATION_0310_NAME = "0310_partnerships_merge";

export const MIGRATION_0310_STATEMENTS: string[] = [
  "ALTER TABLE `partnerships` ADD COLUMN `mergedIntoId` INT NULL",
  "ALTER TABLE `partnerships` ADD COLUMN `mergeJson` TEXT NULL",
];

export const IDEMPOTENT_ERROR_CODES_0310 = new Set<string>(["ER_DUP_FIELDNAME"]);
