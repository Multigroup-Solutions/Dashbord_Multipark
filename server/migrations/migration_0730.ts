// Migration 0730 — Mapa de férias (plano 63, passo 11).
//
// `employee_leaves` ganha o estado e a aprovação:
//  - `status` ('requested' | 'approved' | 'rejected' | 'cancelled'), NOT NULL
//    DEFAULT 'approved': o que já existe fica APROVADO (era o que contava);
//  - quem pediu e quando (`requestedById`, `requestedAt`), quem decidiu e
//    quando (`decidedById`, `decidedAt`, `decisionNote`), quem podia aprovar
//    quando se pediu (`approverUserIds`, JSON — mudar as regras depois não
//    muda os pedidos feitos) e quem cancelou (`cancelledById`, `cancelledAt`);
//  - `hours` DECIMAL(4,2) NULL: NULL = dias inteiros; com valor, ausência
//    justificada de PARTE de um dia;
//  - o tipo `unavailable` no fim do ENUM `leaveType` (a indisponibilidade dos
//    extras, sem aprovação nem pagamento) — as linhas que existem não mudam.
//
// `employees.contractType` passa a aceitar `partner_company` (parceiros-empresa:
// fora do mapa e da folha, o salário fica só como referência para os custos).
//
// Nada se apaga: "apagar" uma ausência passa a CANCELAR (status 'cancelled').
//
// Idempotente e só acrescenta: ADD COLUMN → ER_DUP_FIELDNAME, ADD INDEX →
// ER_DUP_KEYNAME (calados); os MODIFY só acrescentam um valor no fim do ENUM e
// podem correr N vezes.
export const MIGRATION_0730_STATEMENTS: string[] = [
  "ALTER TABLE `employee_leaves` MODIFY COLUMN `leaveType` ENUM('vacation','sick','unpaid','other','unavailable') NOT NULL DEFAULT 'vacation'",
  "ALTER TABLE `employee_leaves` ADD COLUMN `status` VARCHAR(10) NOT NULL DEFAULT 'approved'",
  "ALTER TABLE `employee_leaves` ADD COLUMN `hours` DECIMAL(4,2) NULL",
  "ALTER TABLE `employee_leaves` ADD COLUMN `requestedById` INT NULL",
  "ALTER TABLE `employee_leaves` ADD COLUMN `requestedAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `employee_leaves` ADD COLUMN `decidedById` INT NULL",
  "ALTER TABLE `employee_leaves` ADD COLUMN `decidedAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `employee_leaves` ADD COLUMN `decisionNote` VARCHAR(255) NULL",
  "ALTER TABLE `employee_leaves` ADD COLUMN `approverUserIds` JSON NULL",
  "ALTER TABLE `employee_leaves` ADD COLUMN `cancelledById` INT NULL",
  "ALTER TABLE `employee_leaves` ADD COLUMN `cancelledAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `employee_leaves` ADD INDEX `idx_employee_leaves_status` (`status`, `fromDate`)",
  "ALTER TABLE `employees` MODIFY COLUMN `contractType` ENUM('permanent','fixed_term','extra','partner_company') NULL DEFAULT 'permanent'",
];

export const IDEMPOTENT_ERROR_CODES_0730 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
