// Migration 0062 — Despesas: correções de base + estrutura do circuito
// financeiro (fase 1 do plano "Despesas Multipark — controlo financeiro").
//
// O que entra JÁ em uso nesta fase:
//   - expenses.supplierNif / documentNumber / paidBy (a IA já extraía NIF e
//     nº de fatura, mas iam parar às notas);
//   - expenses.recurringPeriod + UNIQUE (recurringTemplateId, recurringPeriod):
//     duas gerações simultâneas do mesmo mês criam UMA ocorrência;
//   - expense_events: histórico (autor, data, valores anteriores) de cada
//     alteração relevante.
// O resto (approvalStatus, finance_accounts, expense_payments, expense_budgets,
// finance_import_batches) fica criado e vazio: é a base para aprovações,
// pagamentos parciais/reembolsos, orçamentos e a importação da caixa (que já
// existe noutra app — aqui só se importa e cruza). `approvalStatus='legacy'`
// marca tudo o que é anterior ao circuito — nunca se inventa uma aprovação.
//
// Idempotente: corre no boot (ensureRecentSchema) em todos os processos.
// ⚠️ O UNIQUE das recorrentes só é criado depois de preencher recurringPeriod;
// se já existirem duplicados históricos o ALTER falha com ER_DUP_ENTRY (fica
// em warning) — o GET_LOCK na geração protege na mesma; limpar à mão e o boot
// seguinte cria o índice.

export const MIGRATION_0062_NAME = "0062_expenses_financial_control";

export const MIGRATION_0062_STATEMENTS: string[] = [
  // ── 1. expenses: fornecedor estruturado + circuito ─────────────────────────
  "ALTER TABLE `expenses` ADD COLUMN `supplierNif` VARCHAR(32) NULL AFTER `recurringTemplateId`",
  "ALTER TABLE `expenses` ADD COLUMN `documentNumber` VARCHAR(64) NULL AFTER `supplierNif`",
  "ALTER TABLE `expenses` ADD COLUMN `paidBy` ENUM('company','employee') NULL AFTER `documentNumber`",
  "ALTER TABLE `expenses` ADD COLUMN `approvalStatus` ENUM('legacy','draft','submitted','approved','returned') NOT NULL DEFAULT 'legacy' AFTER `paidBy`",
  "ALTER TABLE `expenses` ADD COLUMN `submittedAt` TIMESTAMP NULL AFTER `approvalStatus`",
  "ALTER TABLE `expenses` ADD COLUMN `approvedAt` TIMESTAMP NULL AFTER `submittedAt`",
  "ALTER TABLE `expenses` ADD COLUMN `approvedById` INT NULL AFTER `approvedAt`",
  "ALTER TABLE `expenses` ADD COLUMN `returnReason` TEXT NULL AFTER `approvedById`",
  "ALTER TABLE `expenses` ADD COLUMN `recurringPeriod` VARCHAR(7) NULL AFTER `returnReason`",
  "ALTER TABLE `expenses` ADD INDEX `idx_expenses_date` (`expenseDate`)",
  "ALTER TABLE `expenses` ADD INDEX `idx_expenses_project` (`projectId`)",
  "ALTER TABLE `expenses` ADD INDEX `idx_expenses_status` (`status`)",
  // backfill do período das recorrentes já lançadas (só onde ainda está vazio)
  "UPDATE `expenses` SET `recurringPeriod` = DATE_FORMAT(`expenseDate`, '%Y-%m') WHERE `recurringTemplateId` IS NOT NULL AND `recurringPeriod` IS NULL",
  "ALTER TABLE `expenses` ADD UNIQUE INDEX `uq_expenses_recurring_period` (`recurringTemplateId`, `recurringPeriod`)",

  // ── 2. Contas (banco / cartão / caixa) ────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS \`finance_accounts\` (
    \`id\` INT NOT NULL AUTO_INCREMENT,
    \`name\` VARCHAR(128) NOT NULL,
    \`type\` ENUM('bank','card','cash') NOT NULL,
    \`iban\` VARCHAR(34) NULL,
    \`externalRef\` VARCHAR(64) NULL,
    \`active\` TINYINT NOT NULL DEFAULT 1,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`)
  )`,

  // ── 3. Pagamentos (parciais, reembolsos, importados, estornos) ────────────
  `CREATE TABLE IF NOT EXISTS \`expense_payments\` (
    \`id\` INT NOT NULL AUTO_INCREMENT,
    \`expenseId\` INT NOT NULL,
    \`accountId\` INT NULL,
    \`amount\` DECIMAL(10,2) NOT NULL,
    \`paidOn\` DATE NOT NULL,
    \`method\` ENUM('cash','card','transfer','check','other') NULL,
    \`reference\` VARCHAR(128) NULL,
    \`proofUrl\` TEXT NULL,
    \`proofKey\` VARCHAR(512) NULL,
    \`note\` TEXT NULL,
    \`source\` ENUM('manual','legacy','caixa_import','bank_import') NOT NULL DEFAULT 'manual',
    \`importBatchId\` INT NULL,
    \`externalRef\` VARCHAR(128) NULL,
    \`reversalOfId\` INT NULL,
    \`reversedAt\` TIMESTAMP NULL,
    \`createdById\` INT NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    INDEX \`idx_expense_payments_expense\` (\`expenseId\`),
    INDEX \`idx_expense_payments_batch\` (\`importBatchId\`),
    UNIQUE INDEX \`uq_expense_payments_external\` (\`source\`, \`externalRef\`)
  )`,

  // ── 4. Orçamentos mensais por centro/categoria ────────────────────────────
  `CREATE TABLE IF NOT EXISTS \`expense_budgets\` (
    \`id\` INT NOT NULL AUTO_INCREMENT,
    \`projectId\` INT NULL,
    \`categoryId\` INT NULL,
    \`period\` VARCHAR(7) NOT NULL,
    \`amount\` DECIMAL(12,2) NOT NULL,
    \`createdById\` INT NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updatedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE INDEX \`uq_expense_budgets_scope\` (\`projectId\`, \`categoryId\`, \`period\`)
  )`,

  // ── 5. Histórico de alterações ────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS \`expense_events\` (
    \`id\` INT NOT NULL AUTO_INCREMENT,
    \`expenseId\` INT NOT NULL,
    \`type\` VARCHAR(32) NOT NULL,
    \`userId\` INT NULL,
    \`before\` TEXT NULL,
    \`after\` TEXT NULL,
    \`note\` TEXT NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    INDEX \`idx_expense_events_expense\` (\`expenseId\`)
  )`,

  // ── 6. Lotes de importação (caixa externa / extratos) ─────────────────────
  `CREATE TABLE IF NOT EXISTS \`finance_import_batches\` (
    \`id\` INT NOT NULL AUTO_INCREMENT,
    \`source\` ENUM('caixa','bank_csv') NOT NULL,
    \`accountId\` INT NULL,
    \`fileName\` VARCHAR(256) NULL,
    \`fileHash\` VARCHAR(64) NULL,
    \`periodFrom\` DATE NULL,
    \`periodTo\` DATE NULL,
    \`rowsTotal\` INT NOT NULL DEFAULT 0,
    \`rowsImported\` INT NOT NULL DEFAULT 0,
    \`rowsMatched\` INT NOT NULL DEFAULT 0,
    \`status\` ENUM('pending','done','failed') NOT NULL DEFAULT 'pending',
    \`error\` TEXT NULL,
    \`importedById\` INT NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE INDEX \`uq_finance_import_hash\` (\`source\`, \`fileHash\`)
  )`,
];

export const IDEMPOTENT_ERROR_CODES_0062 = new Set([
  "ER_DUP_FIELDNAME",      // ADD COLUMN onde já existe
  "ER_DUP_KEYNAME",        // ADD INDEX onde já existe
  "ER_TABLE_EXISTS_ERROR", // CREATE TABLE
]);
