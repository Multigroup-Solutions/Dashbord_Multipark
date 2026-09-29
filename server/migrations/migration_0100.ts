// Migration 0100 — Overrides de acesso por utilizador (24 set 2026)
//
// Pedido do dono: "dar a cada pessoa permissão para qualquer coisa". Em vez de
// uma tabela nova, alarga-se `user_permissions` (já guarda os grants/deny por
// utilizador — finance.view_totals, extras_dia.team_leader, city.*):
//  - chave `module.<id>` = override de um módulo da matriz (shared/access.ts);
//    mode 'grant' + scope/actions = o que passa a ter; mode 'deny' = retirado;
//  - scope: none/own/below_city/city/national (NULL nas permissões antigas);
//  - actions: letras v/e/x/m (NULL nas permissões antigas);
//  - expiresOn: último dia (Lisboa, inclusivo) em que vale; NULL = sem fim;
//  - note: motivo opcional; createdAt: quando foi dado (grantedBy já existia).
// O histórico de quem mudou o quê fica em activity_logs (set_module_access).
//
// Idempotente (corre em cada arranque via ensureRecentSchema): CREATE TABLE IF
// NOT EXISTS (a tabela era criada "on demand" e pode não existir); ADD COLUMN
// → ER_DUP_FIELDNAME; ADD INDEX → ER_DUP_KEYNAME. Sem UPDATEs.

export const MIGRATION_0100_NAME = "0100_user_module_overrides";

export const MIGRATION_0100_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `user_permissions` (" +
    "`userId` INT NOT NULL, " +
    "`permission` VARCHAR(64) NOT NULL, " +
    "`mode` ENUM('grant','deny') NOT NULL, " +
    "`grantedBy` INT NULL, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`userId`, `permission`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "ALTER TABLE `user_permissions` ADD COLUMN `scope` VARCHAR(16) NULL",
  "ALTER TABLE `user_permissions` ADD COLUMN `actions` VARCHAR(8) NULL",
  "ALTER TABLE `user_permissions` ADD COLUMN `expiresOn` DATE NULL",
  "ALTER TABLE `user_permissions` ADD COLUMN `note` VARCHAR(255) NULL",
  "ALTER TABLE `user_permissions` ADD COLUMN `createdAt` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP",
  "ALTER TABLE `user_permissions` ADD INDEX `idx_user_permissions_permission` (`permission`)",
];

export const IDEMPOTENT_ERROR_CODES_0100 = new Set<string>([
  "ER_DUP_FIELDNAME",
  "ER_DUP_KEYNAME",
  "ER_TABLE_EXISTS_ERROR",
]);
