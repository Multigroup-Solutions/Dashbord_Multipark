// Migration 0640 — Terminal pelo perfil, entrega B2 (plano 56; Jorge, 12 out 2026).
//
// Acrescenta a `terminal_sessions` (0625) o que o B2 precisa:
//  - GPS de 5 em 5 min (cron `terminal-watch`): `lastFixAt` (instante da última
//    leitura do Zello usada — duas leituras "seguidas" têm de ser leituras
//    DIFERENTES), `lastFixState` (inside / outside / no_gps, para o "Terminal
//    agora"), `lastFixDistanceM` e `lastCheckAt` (quando se olhou pela última vez);
//  - reabrir sem buraco ("Ainda estou" até 30 min depois de libertado):
//    `prevSessionId` (a sessão de onde veio);
//  - horas que contam: `countedFrom` (início do que conta quando não é o
//    `startedAt`: a reabertura sem prova ou a correção do RH);
//  - decisão do RH (confirmar / corrigir / desmarcar, sempre com motivo):
//    `reviewedByUserId`, `reviewedAt`, `reviewNote` e o resultado automático
//    que havia antes (`autoCountedUntil`, `autoCountedBasis`) — nada se perde.
//
// Só acrescenta colunas (todas NULL); sem dados. Idempotente (ER_DUP_FIELDNAME).
const col = (name: string, type: string) => `ALTER TABLE \`terminal_sessions\` ADD COLUMN \`${name}\` ${type}`;

export const MIGRATION_0640_STATEMENTS: string[] = [
  col("lastFixAt", "DATETIME NULL"),
  col("lastFixState", "VARCHAR(8) NULL"),
  col("lastFixDistanceM", "INT NULL"),
  col("lastCheckAt", "DATETIME NULL"),
  col("countedFrom", "DATETIME NULL"),
  col("prevSessionId", "INT NULL"),
  col("reviewedByUserId", "INT NULL"),
  col("reviewedAt", "DATETIME NULL"),
  col("reviewNote", "VARCHAR(255) NULL"),
  col("autoCountedUntil", "DATETIME NULL"),
  col("autoCountedBasis", "VARCHAR(16) NULL"),
];

export const IDEMPOTENT_ERROR_CODES_0640 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
