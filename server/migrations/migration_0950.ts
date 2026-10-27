// Migration 0950 — Identidade partilhada (be-shared), plano 05 (Jorge, 14 out 2026).
//
// A autenticação passa a ser do be-shared (a conta Multipark); o dashboard fica
// com a autorização (papel, permissões, cidade, ficha). A ligação é por ID:
//
//  - `users.sharedUserId`: o id do utilizador no be-shared (cuid). ÚNICO — uma
//    conta Multipark liga a no máximo uma conta do dashboard.
//  - `users.sharedLinkedAt` / `sharedLinkMethod`: quando e como ficou ligada
//    (google_shadow | password | agent_confirmed | proposal | created | email_verified).
//  - `users.sharedCheckedAt`: última confirmação no be-shared (sessões).
//    Estas colunas NÃO estão no drizzle `users` (como as da palavra-passe, 0620):
//    lêem-se e escrevem-se por SQL em server/sharedIdentityStore.ts, para que uma
//    migração por aplicar nunca parta as leituras de `users` (nem o login).
//
//  - `shared_link_proposals` (L2): o admin propõe "esta conta do dashboard é a
//    conta Multipark X"; a pessoa confirma no link enviado para o email dessa
//    conta Multipark. Só o hash do token fica guardado.
//  - `shared_access_requests` (L5): quem entra com uma conta Multipark válida
//    sem ligação fica num pedido de acesso que um admin aprova ou recusa.
//
// Só acrescenta. Idempotente (ADD COLUMN/INDEX repetidos, CREATE IF NOT EXISTS).
// NOTA: o número pode ter de subir no merge se entretanto main usar 0950.

export const MIGRATION_0950_STATEMENTS: string[] = [
  "ALTER TABLE `users` ADD COLUMN `sharedUserId` VARCHAR(32) NULL",
  "ALTER TABLE `users` ADD COLUMN `sharedLinkedAt` TIMESTAMP NULL",
  "ALTER TABLE `users` ADD COLUMN `sharedLinkMethod` VARCHAR(32) NULL",
  "ALTER TABLE `users` ADD COLUMN `sharedCheckedAt` TIMESTAMP NULL",
  "ALTER TABLE `users` ADD UNIQUE INDEX `users_sharedUserId_unique` (`sharedUserId`)",
  `CREATE TABLE IF NOT EXISTS \`shared_link_proposals\` (
    \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    \`userId\` INT NOT NULL,
    \`sharedUserId\` VARCHAR(32) NOT NULL,
    \`sharedEmail\` VARCHAR(320) NOT NULL,
    \`tokenHash\` CHAR(64) NOT NULL,
    \`proposedById\` INT NOT NULL,
    \`expiresAt\` TIMESTAMP NOT NULL,
    \`confirmedAt\` TIMESTAMP NULL,
    \`cancelledAt\` TIMESTAMP NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY \`uq_shared_link_proposals_token\` (\`tokenHash\`),
    KEY \`idx_shared_link_proposals_user\` (\`userId\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS \`shared_access_requests\` (
    \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    \`sharedUserId\` VARCHAR(32) NOT NULL,
    \`email\` VARCHAR(320) NULL,
    \`name\` VARCHAR(255) NULL,
    \`status\` VARCHAR(16) NOT NULL DEFAULT 'pending',
    \`requestCount\` INT NOT NULL DEFAULT 1,
    \`lastRequestedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`decidedById\` INT NULL,
    \`decidedAt\` TIMESTAMP NULL,
    \`userId\` INT NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY \`uq_shared_access_requests_shared\` (\`sharedUserId\`),
    KEY \`idx_shared_access_requests_status\` (\`status\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

export const IDEMPOTENT_ERROR_CODES_0950 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME", "ER_TABLE_EXISTS_ERROR"]);
