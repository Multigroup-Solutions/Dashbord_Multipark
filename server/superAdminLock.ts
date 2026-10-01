/**
 * Mudanças que podem tirar um super_admin — despromover, desativar a conta ou
 * a ficha, herdar um papel ao ligar um login — com a guarda do ÚLTIMO
 * super_admin ATÓMICA (P1, 1 out 2026).
 *
 * Antes era "contar e depois escrever": dois pedidos ao mesmo tempo (dois
 * separadores, dois admins) viam ambos "há 2 super_admin ativos" e tiravam os
 * dois — a app ficava sem ninguém que a gerisse. Agora a contagem, a releitura
 * do alvo e a escrita correm numa transação que TRANCA as contas super_admin
 * ativas (SELECT … FOR UPDATE): o segundo pedido espera pelo primeiro e conta
 * já sem ele.
 *
 * Quem chama pode (e deve) verificar antes, fora da tranca, para dar o erro
 * logo; a decisão que conta é a de dentro.
 */
import { sql } from "drizzle-orm";
import { countActiveSuperAdmins, getDb, getUserById } from "./db";
import type { RoleChangeTarget } from "./userAdminRules";

/** Executor da escrita: a transação (mesma API do db do drizzle) ou `undefined` sem BD. */
export type AccountTx = any;

/**
 * Corre `write` só se `decide` (com o alvo e a contagem de super_admin ativos
 * lidos DENTRO da tranca) não devolver erro. Devolve a mensagem de erro (PT-PT)
 * ou null quando escreveu.
 */
export async function guardedAccountChange(
  targetId: number,
  decide: (target: RoleChangeTarget, activeSuperAdmins: number) => string | null,
  write: (tx: AccountTx) => Promise<unknown>,
): Promise<string | null> {
  const db: any = await getDb();
  if (!db) {
    // Sem BD (testes, arranque): a mesma regra, sem tranca.
    const target = await getUserById(targetId);
    if (!target) return "Utilizador não encontrado.";
    const msg = decide({ id: target.id, role: String(target.role), isActive: target.isActive }, await countActiveSuperAdmins());
    if (msg) return msg;
    await write(undefined);
    return null;
  }
  return db.transaction(async (tx: any) => {
    // Primeiro as contas super_admin ativas (sempre pela mesma ordem → sem
    // impasses entre pedidos), depois o alvo.
    const [supers] = await tx.execute(sql`SELECT id FROM users WHERE role = 'super_admin' AND isActive = 1 ORDER BY id FOR UPDATE`);
    const [rows] = await tx.execute(sql`SELECT id, role, isActive FROM users WHERE id = ${targetId} FOR UPDATE`);
    const t = (rows as any[])?.[0];
    if (!t) return "Utilizador não encontrado.";
    const msg = decide({ id: Number(t.id), role: String(t.role), isActive: Number(t.isActive) }, (supers as any[]).length);
    if (msg) return msg;
    await write(tx);
    return null;
  });
}
