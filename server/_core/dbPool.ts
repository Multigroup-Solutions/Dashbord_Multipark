/**
 * Pool ÚNICO de ligações à BD da dashboard (DATABASE_URL).
 *
 * 6 nov 2026: o MySQL ficou sem ligações livres ("Too many connections") e o
 * login dava "Não foi possível concluir a entrada". Cada instância da Vercel
 * abria TRÊS pools (db.ts, externalApi.ts, mcpApi.ts), cada uma com o limite
 * por omissão do mysql2 (10 ligações, paradas abertas para sempre): com
 * muitas instâncias ao mesmo tempo o servidor esgota.
 *
 * Agora: uma pool por instância, poucas ligações, e as paradas fecham depressa.
 * Os pedidos a mais esperam na fila da pool em vez de abrirem ligações novas.
 * `DB_POOL_MAX` (env) muda o limite sem deploy de código.
 */
import { drizzle } from "drizzle-orm/mysql2";

// 5 e não menos: há transações que, lá dentro, ainda pedem outra ligação à pool.
export const DB_POOL_MAX_DEFAULT = 5;
export const DB_POOL_IDLE_MS = 15_000;
export const DB_CONNECT_TIMEOUT_MS = 10_000;

/** Opções da pool (PURA): o URL fica como sempre (`uri`), só se limitam as ligações. */
export function appPoolOptions(url: string, env: Record<string, string | undefined> = process.env) {
  const n = parseInt(String(env.DB_POOL_MAX ?? ""), 10);
  const max = Number.isFinite(n) && n > 0 && n <= 50 ? n : DB_POOL_MAX_DEFAULT;
  return {
    uri: url,
    connectionLimit: max,
    // Fica no máximo 1 ligação parada; as outras fecham ao fim de 15 s.
    maxIdle: 1,
    idleTimeout: DB_POOL_IDLE_MS,
    connectTimeout: DB_CONNECT_TIMEOUT_MS,
    waitForConnections: true,
    queueLimit: 0,
    enableKeepAlive: true,
  };
}

let shared: ReturnType<typeof drizzle> | null = null;

/** A ligação partilhada (null sem DATABASE_URL). Todos os módulos usam esta. */
export function sharedDrizzle(): ReturnType<typeof drizzle> | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!shared) shared = drizzle({ connection: appPoolOptions(url) });
  return shared;
}
