// Migration 0290 — preços iniciais das reservas (exportados do History da
// Multipark, só leitura). A cópia `multipark_bookings` foi escrita por cima
// durante meses; este é o "era" de origem na Correção de caixa. Decisão do
// dono (29 set 2026): fica com esta história. Só cria a tabela (idempotente);
// uma nova importação atualiza as linhas, nunca apaga.

export const MIGRATION_0290_NAME = "0290_booking_initial_prices";

export const MIGRATION_0290_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS \`booking_initial_prices\` (
    \`bookingExternalId\` VARCHAR(64) NOT NULL PRIMARY KEY,
    \`reference\` VARCHAR(32) NULL,
    \`parkId\` VARCHAR(64) NULL,
    \`parkName\` VARCHAR(128) NULL,
    \`city\` VARCHAR(32) NULL,
    \`bookingCreatedAt\` DATETIME NULL,
    \`statusAtExport\` VARCHAR(32) NULL,
    \`initialPrice\` DECIMAL(10,2) NULL,
    \`verification\` VARCHAR(32) NULL,
    \`source\` VARCHAR(64) NULL,
    \`historyId\` VARCHAR(64) NULL,
    \`priceAtExport\` DECIMAL(10,2) NULL,
    \`originalPriceField\` DECIMAL(10,2) NULL,
    \`importedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`importedById\` INT NULL,
    INDEX \`idx_bip_created\` (\`bookingCreatedAt\`),
    INDEX \`idx_bip_reference\` (\`reference\`)
  )`,
];

export const IDEMPOTENT_ERROR_CODES_0290 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME"]);
