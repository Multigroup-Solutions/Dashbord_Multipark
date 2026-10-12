// Migration 0635 — PDAs: sessão de PDA (plano 56, A2; Jorge, 12 out 2026).
//
//  - `pdas.sessionUserId` / `sessionNonce` / `sessionStartedAt`: a sessão
//    aberta AGORA neste PDA. Quem entra no PDA (código, palavra-passe, Google
//    convertido, ou o registo pelo QR) grava aqui um nonce novo, que também vai
//    no cookie; o servidor recusa o cookie se o nonce já não for este, ou se
//    passaram 16 h. O nonce limpa-se (fica NULL) quando outra pessoa entra no
//    PDA, no logout, na saída do ponto e no fecho automático do ponto. Só se
//    limpa se ainda for o mesmo (`WHERE id = ? AND sessionNonce = ?`).
//    `sessionUserId` fica com a última conta (para o registo); nada se apaga.
//  - `web_push_subscriptions.pdaId` / `disabledAt`: os avisos no telemóvel de
//    um PDA pertencem a quem tem a sessão nesse momento (mudam de dono em cada
//    entrada) e ficam desligados (`disabledAt`) quando a sessão acaba.
//
// Só acrescenta (colunas NULL e índices). Idempotente: ADD COLUMN/INDEX
// ignoram o que já existe. Sem dados.
const col = (table: string, name: string, type: string) => `ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` ${type}`;

export const MIGRATION_0635_STATEMENTS: string[] = [
  col("pdas", "sessionUserId", "INT NULL"),
  col("pdas", "sessionNonce", "VARCHAR(64) NULL"),
  col("pdas", "sessionStartedAt", "DATETIME NULL"),
  "ALTER TABLE `pdas` ADD INDEX `idx_pdas_session_user` (`sessionUserId`)",
  col("web_push_subscriptions", "pdaId", "INT NULL"),
  col("web_push_subscriptions", "disabledAt", "DATETIME NULL"),
  "ALTER TABLE `web_push_subscriptions` ADD INDEX `idx_web_push_pda` (`pdaId`)",
];

export const IDEMPOTENT_ERROR_CODES_0635 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
