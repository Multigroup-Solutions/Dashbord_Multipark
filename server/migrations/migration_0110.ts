// Migration 0110 — Faturação: custos a dobrar, autoliquidação e base da comissão (24 set 2026)
//
//  - expense_categories.excludeFromMargin: categorias cujo custo JÁ entra no
//    motor por outra via (RH/salários e TSU/Segurança Social pelo histórico
//    salarial; extras pelo ponto × tarifa). Ficam fora dos custos da margem e
//    aparecem num aviso de qualidade com o valor excluído.
//  - expense_categories.reverseCharge: autoliquidação de IVA (faturas do
//    Google/Meta vêm sem IVA; o IVA liquida-se e deduz-se na mesma
//    declaração) → IVA 0% no custo, em vez dos 23% por omissão.
//  - partnerships.commissionBase: 'net' (sem IVA, regra do dono) | 'gross'.
//
// Corre em CADA arranque. Os flags das categorias são NULL = "ainda não
// decidido": os UPDATE só tocam em linhas NULL (valor por omissão pelo nome,
// sem maiúsculas nem acentos — LOWER + `_` no lugar das letras acentuadas),
// por isso nunca pisam o que o admin escolher no ecrã. commissionBase nasce
// NOT NULL DEFAULT 'net' (sem UPDATE).

export const MIGRATION_0110_NAME = "0110_finance_category_flags";

/** Padrões (LOWER(name) LIKE …) — espelho de shared/financeCategories.ts. */
const EXCLUDE_LIKE = [
  "%sal_rio%", "%ordenado%", "%recursos humanos%", "%tsu%", "%seguran_a social%", "%extras%",
];
const REVERSE_LIKE = ["%marketing%", "%publicidade%", "%google%", "%meta ads%", "%facebook%", "%an_ncio%"];

const likeAny = (pats: string[]) => pats.map((p) => `LOWER(\`name\`) LIKE '${p}'`).join(" OR ");

export const MIGRATION_0110_STATEMENTS: string[] = [
  `ALTER TABLE \`expense_categories\` ADD COLUMN \`excludeFromMargin\` TINYINT NULL`,
  `ALTER TABLE \`expense_categories\` ADD COLUMN \`reverseCharge\` TINYINT NULL`,
  `ALTER TABLE \`partnerships\` ADD COLUMN \`commissionBase\` VARCHAR(8) NOT NULL DEFAULT 'net'`,
  // "RH" como palavra (não apanha "TRHotel"): REGEXP igual em MySQL 8 e MariaDB.
  `UPDATE \`expense_categories\` SET \`excludeFromMargin\` = 1
     WHERE \`excludeFromMargin\` IS NULL AND (${likeAny(EXCLUDE_LIKE)} OR LOWER(\`name\`) REGEXP '(^|[^a-z])rh([^a-z]|$)')`,
  `UPDATE \`expense_categories\` SET \`excludeFromMargin\` = 0 WHERE \`excludeFromMargin\` IS NULL`,
  `UPDATE \`expense_categories\` SET \`reverseCharge\` = 1
     WHERE \`reverseCharge\` IS NULL AND (${likeAny(REVERSE_LIKE)})`,
  `UPDATE \`expense_categories\` SET \`reverseCharge\` = 0 WHERE \`reverseCharge\` IS NULL`,
];

export const IDEMPOTENT_ERROR_CODES_0110 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME", "ER_TABLE_EXISTS_ERROR"]);
