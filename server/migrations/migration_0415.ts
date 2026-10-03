// Migration 0415 — CRM, ficha do cliente (P3 lote 21b): "Retirar" um email,
// telefone ou carro deixa de apagar sem rasto. A linha sai da ficha (as
// leituras, as sugestões e as junções continuam a ver só o que está na ficha)
// mas fica AQUI, inteira (origem, "visto em", marca/modelo/foto, reservas por
// carro), com quem retirou, quando e porquê — e pode ser reposta na ficha.
// Idempotente: CREATE TABLE IF NOT EXISTS.
export const MIGRATION_0415_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `crm_removed_items` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`clientId` INT NOT NULL, " +
    "`kind` VARCHAR(16) NOT NULL, " +
    "`value` VARCHAR(320) NOT NULL, " +
    "`rowJson` LONGTEXT NOT NULL, " +
    "`reason` VARCHAR(255) NULL, " +
    "`removedBy` INT NULL, " +
    "`removedAt` DATETIME NOT NULL, " +
    "`restoredAt` DATETIME NULL, " +
    "`restoredBy` INT NULL, " +
    "PRIMARY KEY (`id`), " +
    "KEY `idx_crm_removed_client` (`clientId`, `removedAt`)" +
    ") ENGINE=InnoDB",
];

export const IDEMPOTENT_ERROR_CODES_0415 = new Set<string>(["ER_TABLE_EXISTS_ERROR"]);
