// Migration 0380 — Leads de extras: "Apagar" passa a ARQUIVAR (P3 lote 18b).
// Antes era um DELETE: um lead convertido saía do funil e perdia-se o rasto
// da conversão, sem volta. Agora fica `archivedAt`/`archivedById`: sai da
// lista, do funil, dos envios e dos lembretes, e pode ser reposto.
// Idempotente: ADD COLUMN ignora o que já existe. Não apaga nada.
export const MIGRATION_0380_STATEMENTS: string[] = [
  "ALTER TABLE `extra_leads` ADD COLUMN `archivedAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `extra_leads` ADD COLUMN `archivedById` INT NULL",
];

export const IDEMPOTENT_ERROR_CODES_0380 = new Set<string>(["ER_DUP_FIELDNAME"]);
