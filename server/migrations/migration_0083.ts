// Migration 0083 — IVA por categoria de despesa (Jorge, 24 set 2026).
//
// As Finanças assumiam 23% de IVA em TODAS as despesas, incluindo rendas,
// seguros, bancos, impostos e pessoal (isentos) — o custo líquido e o IVA a
// pagar saíam errados. Cada categoria passa a ter a sua taxa (%).
// NULL = taxa normal (23%). O UPDATE só toca em linhas ainda NULL, por isso
// corre em cada arranque sem pisar o que o admin definir no ecrã.

export const MIGRATION_0083_NAME = "0083_expense_category_vat";

export const MIGRATION_0083_STATEMENTS: string[] = [
  `ALTER TABLE \`expense_categories\` ADD COLUMN \`vatRate\` DECIMAL(5,2) NULL`,
  `UPDATE \`expense_categories\` SET \`vatRate\` = 0
     WHERE \`vatRate\` IS NULL AND \`name\` IN ('Rendas', 'Seguros', 'Bancos', 'Impostos', 'Recursos Humanos')`,
  `UPDATE \`expense_categories\` SET \`vatRate\` = 6
     WHERE \`vatRate\` IS NULL AND \`name\` = 'Água'`,
];

export const IDEMPOTENT_ERROR_CODES_0083 = new Set<string>(["ER_DUP_FIELDNAME"]);
