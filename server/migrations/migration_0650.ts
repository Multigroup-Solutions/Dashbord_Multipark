// Migration 0650 — Telemóveis pessoais (Jorge, 13 out 2026: "registar os
// telefones dos team leaders, dos supervisores… mas não podia ficar como PDA
// extra, porque só uma pessoa é que se liga àquele PDA").
//
//  - `personal_devices`: o telemóvel de UMA pessoa, registado por ela no
//    próprio aparelho ("Registar este telemóvel como meu"). Não é um PDA
//    partilhado: não tem sessão presa (nonce/16 h), não acaba na saída do
//    ponto, não tem check-ins de PDA nem Zello próprio — usa o Zello da ficha
//    de quem lá está. O nome que aparece é o de quem tem sessão nele agora.
//    Um PDA registado por engano (o telemóvel do Jorge, da Márcia, do Marco)
//    converte-se: o token passa para aqui e o PDA fica Inativo (nunca se apaga).
//
// Só acrescenta. CREATE TABLE IF NOT EXISTS ignora o que já existe.

export const MIGRATION_0650_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `personal_devices` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    // O token distingue maiúsculas (base64url): comparação binária, como o gclid (0610).
    "`deviceToken` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, " +
    "`label` VARCHAR(255) NULL, " +
    "`status` ENUM('active','inactive') NOT NULL DEFAULT 'active', " +
    "`ownerUserId` INT NULL, " +
    "`ownerEmployeeId` INT NULL, " +
    "`currentUserId` INT NULL, " +
    "`currentEmployeeId` INT NULL, " +
    "`currentSince` DATETIME NULL, " +
    "`lastUserId` INT NULL, " +
    "`lastEmployeeId` INT NULL, " +
    "`lastSeenAt` DATETIME NULL, " +
    "`convertedFromPdaId` INT NULL, " +
    "`deactivatedAt` DATETIME NULL, " +
    "`deactivatedById` INT NULL, " +
    "`createdById` INT NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_personal_devices_token` (`deviceToken`), " +
    "KEY `idx_personal_devices_owner` (`ownerEmployeeId`), " +
    "KEY `idx_personal_devices_current` (`currentEmployeeId`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
];

/** ER_TABLE_EXISTS_ERROR (1050), ER_DUP_KEYNAME (1061). */
export const IDEMPOTENT_ERROR_CODES_0650 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME"]);
