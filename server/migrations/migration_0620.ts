// Migration 0620 — Entrar com email + código + palavra-passe (plano 56, A1).
//
//  - users.googleSub: o identificador da conta Google (sem o "google_"),
//    ÚNICO quando existe. O Google passa a procurar a conta por aqui, depois
//    pelo openId e (com ENTRAR_COM_CODIGO) pelo email — assim a mesma pessoa
//    cai na MESMA conta quer entre com a Google quer com um código.
//    Preenchido a partir do openId `google_<sub>` (só onde ainda falta e sem
//    repetir um sub que outra conta já tenha).
//  - users.password*: a palavra-passe (só em hash scrypt) e o contador das
//    erradas por dia. NÃO estão no drizzle `users` de propósito: o
//    `select().from(users)` chega ao cliente (auth.me, Utilizadores); só
//    server/loginStore.ts as lê, por SQL.
//  - login_codes: um pedido de código por linha (o código só em HMAC), preso
//    ao aparelho que o pediu (hash do cookie app_login_nonce). Nada se apaga.
//
// Só acrescenta. Idempotente: ADD COLUMN/INDEX e CREATE TABLE IF NOT EXISTS
// ignoram o que já existe; o UPDATE só toca onde falta.
const col = (name: string, type: string) => `ALTER TABLE \`users\` ADD COLUMN \`${name}\` ${type}`;

export const MIGRATION_0620_STATEMENTS: string[] = [
  col("googleSub", "VARCHAR(64) NULL"),
  "ALTER TABLE `users` ADD UNIQUE INDEX `users_googleSub_unique` (`googleSub`)",
  col("passwordHash", "VARCHAR(255) NULL"),
  col("passwordSetAt", "DATETIME NULL"),
  col("passwordFailedDay", "DATE NULL"),
  col("passwordFailedCount", "INT NOT NULL DEFAULT 0"),
  col("passwordLockedUntil", "DATETIME NULL"),
  // Contas Google que já existem: o sub vem do openId. A subconsulta vai por
  // uma tabela derivada (o MySQL não deixa ler a tabela que se atualiza).
  "UPDATE `users` u SET u.`googleSub` = SUBSTRING(u.`openId`, 8) " +
    "WHERE u.`googleSub` IS NULL AND LEFT(u.`openId`, 7) = 'google_' AND CHAR_LENGTH(u.`openId`) > 7 " +
    "AND NOT EXISTS (SELECT 1 FROM (SELECT `googleSub` FROM `users` WHERE `googleSub` IS NOT NULL) g WHERE g.`googleSub` = SUBSTRING(u.`openId`, 8))",
  "CREATE TABLE IF NOT EXISTS `login_codes` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`emailNorm` VARCHAR(320) NOT NULL, " +
    "`userId` INT NULL, " +
    "`employeeId` INT NULL, " +
    "`codeHash` CHAR(64) NOT NULL, " +
    "`deviceNonceHash` CHAR(64) NOT NULL, " +
    "`deviceLabel` VARCHAR(120) NULL, " +
    "`pdaId` INT NULL, " +
    "`cityKey` VARCHAR(16) NULL, " +
    "`deliveredTo` JSON NULL, " +
    "`deliveryMode` ENUM('duty','email') NOT NULL DEFAULT 'duty', " +
    "`expiresAt` DATETIME NOT NULL, " +
    "`attempts` INT NOT NULL DEFAULT 0, " +
    "`usedAt` DATETIME NULL, " +
    "`usedByUserId` INT NULL, " +
    "`ipHash` VARCHAR(32) NULL, " +
    "`createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "KEY `idx_login_codes_device` (`emailNorm`, `deviceNonceHash`, `id`), " +
    "KEY `idx_login_codes_created` (`createdAt`), " +
    "KEY `idx_login_codes_user` (`usedByUserId`, `usedAt`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
];

export const IDEMPOTENT_ERROR_CODES_0620 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME", "ER_TABLE_EXISTS_ERROR"]);
