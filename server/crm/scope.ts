/**
 * CRM — que fichas vê quem tem alcance de cidade (cityScope do pedido).
 *
 * Uma ficha é visível se tiver pelo menos uma reserva numa das cidades que o
 * utilizador vê — pelo RESUMO da ficha (`cityKeys`, as cidades das reservas,
 * calculadas ao vivo da Multipark pelo crm-sync; fase 1, sem cópia de
 * reservas) — ou se foi criada à mão e ainda não tem reservas (senão quem a
 * cria numa cidade deixava de a ver logo a seguir; por agora ficam visíveis a
 * todas as cidades). Fichas da carga sem reservas (restos de um lote
 * interrompido) e fichas já juntas não passam.
 * Quem vê todas as cidades vê tudo. Uma só regra para a lista, a ficha,
 * "Rever fichas" e as ações (editar, juntar, separar, ligações).
 */
import { sql, type SQL } from "drizzle-orm";
import { scopedCityNamesLive } from "../cityScope";
import { cityAliases } from "../../shared/crmGeo";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};

/** "Uma das cidades do resumo (`cityKeys`, "lisboa,porto") está nesta lista". PURA. */
export function cityKeysMatch(col: SQL, cities: readonly string[]): SQL {
  const aliases = cityAliases([...cities]);
  if (!aliases.length) return sql`1 = 0`;
  return sql`(${sql.join(aliases.map((a) => sql`CONCAT(',', COALESCE(${col}, ''), ',') LIKE ${`%,${a},%`}`), sql` OR `)})`;
}

/** Condição SQL "a ficha `idCol` é visível a quem pede". */
export function clientVisibleSql(idCol: SQL): SQL {
  const cities = scopedCityNamesLive();
  if (cities === undefined) return sql`1 = 1`;
  return sql`EXISTS (SELECT 1 FROM crm_clients sc WHERE sc.id = ${idCol} AND (
      ${cityKeysMatch(sql`sc.cityKeys`, cities)}
      OR (sc.bookings = 0 AND sc.source <> 'bookings')))`;
}

/** Ids (de entre estes) que existem e são visíveis a quem pede. */
export async function visibleClientIds(db: any, ids: number[]): Promise<Set<number>> {
  const list = [...new Set(ids.filter((x) => Number.isInteger(x) && x > 0))];
  if (!list.length) return new Set();
  const rows = rowsOf(await db.execute(sql`SELECT c.id FROM crm_clients c
    WHERE c.id IN (${sql.join(list.map((x) => sql`${x}`), sql`, `)}) AND ${clientVisibleSql(sql`c.id`)}`));
  return new Set(rows.map((r) => Number(r.id)));
}
