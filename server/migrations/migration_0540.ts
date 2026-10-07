// Migration 0540 — Extras-dia → Pressão: notas internas do dia de trabalho
// (pedido 4, Jorge 7 out 2026: "deve dar para guardar várias notas para esse
// dia"). Várias notas por (cidade, dia de calendário), hora opcional (hora
// operacional 3–26: 24–26 = 00h–02h da madrugada seguinte), autor e arquivo
// ("apagar" = arquivar, como na 0376). Só acrescenta. Idempotente.
export const MIGRATION_0540_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS \`extras_day_notes\` (
    \`id\` INT NOT NULL AUTO_INCREMENT,
    \`city\` VARCHAR(16) NOT NULL,
    \`workDate\` VARCHAR(10) NOT NULL,
    \`hour\` TINYINT NULL,
    \`body\` TEXT NOT NULL,
    \`authorId\` INT NOT NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`editedAt\` TIMESTAMP NULL,
    \`archivedAt\` TIMESTAMP NULL,
    \`archivedById\` INT NULL,
    PRIMARY KEY (\`id\`),
    KEY \`idx_extras_day_notes_city_date\` (\`city\`, \`workDate\`)
  ) DEFAULT CHARSET=utf8mb4`,
];

export const IDEMPOTENT_ERROR_CODES_0540 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME"]);
