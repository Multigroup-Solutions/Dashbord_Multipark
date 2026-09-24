// Migration 0096 — Novo papel "condutor" (modelo de acessos, 24 set 2026)
//
// Acrescenta 'condutor' ao ENUM users.role (entre extra e team_leader na
// hierarquia — ver shared/access.ts). MODIFY com a lista COMPLETA: correr de
// novo não muda nada (o MySQL não reescreve a tabela se o tipo for igual) e
// nenhum valor existente é perdido. NÃO muda o papel de ninguém — a passagem
// a condutor faz-se em Utilizadores → "Sugerir condutores".

export const MIGRATION_0096_NAME = "0096_role_condutor";

export const USER_ROLE_ENUM_0096 = ["super_admin", "admin", "team_leader", "backoffice", "frontoffice", "supervisor", "condutor", "extra", "user"] as const;

export const MIGRATION_0096_STATEMENTS: string[] = [
  "ALTER TABLE `users` MODIFY COLUMN `role` ENUM(" + USER_ROLE_ENUM_0096.map(r => `'${r}'`).join(",") + ") NOT NULL DEFAULT 'user'",
];

export const IDEMPOTENT_ERROR_CODES_0096 = new Set<string>([]);
