// Migration 0675 — Categorias de despesa (Jorge, 14 out 2026): nomes com os
// acentos certos + a categoria "Sinistros".
//
// No esquema só um índice no nome. O resto é um passo de DADOS que corre UMA
// vez em toda a frota, e nunca dois em paralelo:
//
//  1. Reclama a tarefa com uma linha em `app_settings`
//     (`expenses.categoryNamesFixedV1`). A chave é PRIMARY KEY, por isso o
//     `INSERT IGNORE` só dá 1 linha afetada a UM arranque — os outros (outras
//     instâncias da Vercel a arrancar ao mesmo tempo) veem 0 e saem. Se uma
//     tentativa falhou (estado "failed") ou ficou abandonada a meio ("running"
//     há mais de 15 min — instância morta), a próxima reclama-a com um UPDATE
//     condicional (atómico: só um apanha a linha). Retomar é seguro: o plano
//     recalcula-se com os nomes de agora, cada UPDATE exige o nome antigo e o
//     Sinistros só entra se ainda não existir.
//  2. Renomeia POR ID as categorias com acentos em falta (regra pura
//     shared/expenseCategories.ts → planCategoryFixes). As despesas guardam o
//     id da categoria: nada muda nelas. Nada se apaga nem se junta — se o nome
//     certo já existir noutra categoria, a errada fica como está (registado).
//  3. Acrescenta "Sinistros" se não houver (e se a tabela já tiver categorias;
//     numa BD nova as de origem — já com Sinistros — entram pelo
//     seedDefaultCategories).
//  4. Marca "done" com o que mudou (fica visível em app_settings e nos logs) e
//     escreve cada mudança no registo de atividade (origem "system").
//
// Uma categoria criada DEPOIS com um nome sem acentos não é corrigida aqui.

import { sql } from "drizzle-orm";
import { planCategoryFixes, SINISTROS_CATEGORY, type CategoryFixPlan } from "../../shared/expenseCategories";
import { defaultCategoryFlags } from "../../shared/financeCategories";

export const MIGRATION_0675_NAME = "0675_expense_category_names";
// Único SQL de esquema: índice (não único) no nome — a lista das categorias
// ordena e procura por nome. Repetir dá ER_DUP_KEYNAME (calado).
export const MIGRATION_0675_STATEMENTS: string[] = [
  "ALTER TABLE `expense_categories` ADD INDEX `idx_expense_categories_name` (`name`)",
];
export const IDEMPOTENT_ERROR_CODES_0675 = new Set<string>(["ER_DUP_KEYNAME"]);

export const CATEGORY_FIX_FLAG_0675 = "expenses.categoryNamesFixedV1";
/** "running" mais antigo do que isto = tentativa abandonada (pode ser retomada). */
export const STALE_RUNNING_MS_0675 = 15 * 60_000;

type Executor = { execute: (q: any) => Promise<unknown> };

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const affectedOf = (res: unknown): number => {
  const h = Array.isArray(res) ? res[0] : res;
  return Number((h as any)?.affectedRows ?? 0);
};

/** Reclama a tarefa: só um arranque ganha (chave primária / UPDATE condicional). */
async function claim0675(db: Executor, now: Date): Promise<boolean> {
  const running = JSON.stringify({ state: "running", at: now.toISOString() });
  const ins = await db.execute(sql`INSERT IGNORE INTO app_settings (settingKey, \`value\`) VALUES (${CATEGORY_FIX_FLAG_0675}, ${running})`);
  if (affectedOf(ins) === 1) return true;
  // `at` é ISO (UTC, sempre o mesmo formato) → comparar como texto dá a ordem certa.
  const staleBefore = new Date(now.getTime() - STALE_RUNNING_MS_0675).toISOString();
  const retry = await db.execute(sql`UPDATE app_settings SET \`value\` = ${running}
    WHERE settingKey = ${CATEGORY_FIX_FLAG_0675} AND (
      JSON_UNQUOTE(JSON_EXTRACT(\`value\`, '$.state')) = 'failed'
      OR (JSON_UNQUOTE(JSON_EXTRACT(\`value\`, '$.state')) = 'running' AND JSON_UNQUOTE(JSON_EXTRACT(\`value\`, '$.at')) < ${staleBefore})
    )`);
  return affectedOf(retry) === 1;
}

async function finish0675(db: Executor, value: Record<string, unknown>): Promise<void> {
  await db.execute(sql`UPDATE app_settings SET \`value\` = ${JSON.stringify(value)} WHERE settingKey = ${CATEGORY_FIX_FLAG_0675}`);
}

export async function runMigration0675Data(db: Executor, opts: { now?: Date } = {}): Promise<{ status: "applied" | "skipped"; plan?: CategoryFixPlan; sinistrosAdded?: boolean }> {
  if (!(await claim0675(db, opts.now ?? new Date()))) return { status: "skipped" };
  try {
    const rows = rowsOf(await db.execute(sql`SELECT id, name FROM expense_categories ORDER BY id`))
      .map((r) => ({ id: Number(r.id), name: r.name == null ? null : String(r.name) }));
    const plan = planCategoryFixes(rows);
    const renamed: typeof plan.renames = [];
    for (const r of plan.renames) {
      const upd = await db.execute(sql`UPDATE expense_categories SET name = ${r.to} WHERE id = ${r.id} AND name = ${r.from}`);
      // Só regista o que mudou de facto (outro processo/pessoa pode ter mexido entretanto).
      if (affectedOf(upd) !== 1) continue;
      renamed.push(r);
      await db.execute(sql`INSERT INTO activity_logs (userId, action, entity, entityId, details, source)
        VALUES (0, 'update', 'expense_category', ${r.id}, ${`Nome corrigido: «${r.from}» → «${r.to}»`}, 'system')`);
    }
    let sinistrosAdded = false;
    if (plan.addSinistros && rows.length > 0) {
      const f = defaultCategoryFlags(SINISTROS_CATEGORY.name);
      const ins = await db.execute(sql`INSERT INTO expense_categories (name, department, color, excludeFromMargin, reverseCharge)
        VALUES (${SINISTROS_CATEGORY.name}, ${SINISTROS_CATEGORY.department}, ${SINISTROS_CATEGORY.color}, ${f.excludeFromMargin ? 1 : 0}, ${f.reverseCharge ? 1 : 0})`);
      if (affectedOf(ins) === 1) {
        await db.execute(sql`INSERT INTO activity_logs (userId, action, entity, details, source)
          VALUES (0, 'create', 'expense_category', ${`Categoria acrescentada: «${SINISTROS_CATEGORY.name}»`}, 'system')`);
        sinistrosAdded = true;
      }
    }
    const insSin = sinistrosAdded;
    await finish0675(db, { state: "done", at: new Date().toISOString(), renames: renamed, skipped: plan.skipped, sinistrosAdded: insSin });
    return { status: "applied", plan: { ...plan, renames: renamed }, sinistrosAdded: insSin };
  } catch (err: any) {
    // Deixa voltar a tentar no próximo arranque (só um, pelo UPDATE condicional).
    try { await finish0675(db, { state: "failed", at: new Date().toISOString(), error: String(err?.cause?.message ?? err?.message ?? err).slice(0, 200) }); } catch { /* fica "running" */ }
    throw err;
  }
}
