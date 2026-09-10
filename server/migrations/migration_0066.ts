// Migration 0066 — Identidade por EMAIL (pedido do Jorge, 2026-09-10):
//
//   - users.email passa a UNIQUE: nunca podem existir dois utilizadores com o
//     mesmo email (a identidade do sistema). Os emails são gravados sempre na
//     forma canónica (normalizeEmail) por isso o índice simples chega.
//     Se ainda houver duplicados na BD, o ALTER falha com ER_DUP_ENTRY e é
//     tolerado (aviso no boot) até correr `scripts/identity-reconcile.ts --apply`;
//     no arranque seguinte aplica-se.
//   - employees.multiparkAgentUserId ganha índice: os joins com o histórico
//     das reservas passam a poder usar o id do agente (e não só o nome).
//
// Idempotente: corre no boot (ensureRecentSchema).

export const MIGRATION_0066_NAME = "0066_identity_users_email_unique_agent_index";

export const MIGRATION_0066_STATEMENTS: string[] = [
  "ALTER TABLE `users` ADD UNIQUE INDEX `uq_users_email` (`email`)",
  "ALTER TABLE `employees` ADD INDEX `idx_employees_mp_agent_user` (`multiparkAgentUserId`)",
];

export const IDEMPOTENT_ERROR_CODES_0066 = new Set([
  "ER_DUP_KEYNAME", // índice já existe
  "ER_DUP_ENTRY", // ainda há emails duplicados em users — aviso até reconciliar
]);
