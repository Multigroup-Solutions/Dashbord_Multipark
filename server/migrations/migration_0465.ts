// Migration 0465 — Despesas (P3 lote 25a, Jorge, 3 out 2026):
//  - D4: "Eliminar" uma despesa esconde-a de todo o lado (listas, totais,
//    Faturação, exportações) mas a linha fica guardada com a fatura —
//    `expenses.deletedAt/deletedById`; só o super admin a vê, a pedido.
//  - "Remover" um modelo recorrente = desativar e sair da lista —
//    `recurring_expenses.removedAt/removedById`.
// Só acrescenta colunas (nada se apaga). Idempotente: ADD COLUMN repetido ignora-se.
export const MIGRATION_0465_STATEMENTS: string[] = [
  "ALTER TABLE `expenses` ADD COLUMN `deletedAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `expenses` ADD COLUMN `deletedById` INT NULL",
  "ALTER TABLE `recurring_expenses` ADD COLUMN `removedAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `recurring_expenses` ADD COLUMN `removedById` INT NULL",
];

export const IDEMPOTENT_ERROR_CODES_0465 = new Set<string>(["ER_DUP_FIELDNAME"]);
