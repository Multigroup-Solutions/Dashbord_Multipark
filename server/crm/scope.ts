/**
 * CRM — que fichas vê quem tem alcance de cidade (cityScope do pedido).
 *
 * Uma ficha é visível se tiver pelo menos uma reserva nos projetos que o
 * utilizador vê — ou se foi criada à mão e ainda não tem reservas (senão
 * quem a cria numa cidade deixava de a ver logo a seguir; por agora ficam
 * visíveis a todas as cidades). Fichas da carga sem reservas (restos de um
 * lote interrompido) e fichas já juntas (as reservas passaram para a que
 * ficou) não passam.
 * Quem vê todas as cidades vê tudo. Uma só regra para a lista, a ficha,
 * "Rever fichas" e as ações (editar, juntar, separar, ligações).
 */
import { sql, type SQL } from "drizzle-orm";
import { projectScope, scopedProjectIds } from "../cityScope";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};

/** Condição SQL "a ficha `idCol` é visível a quem pede". */
export function clientVisibleSql(idCol: SQL): SQL {
  if (scopedProjectIds() === undefined) return sql`1 = 1`;
  return sql`(EXISTS (SELECT 1 FROM crm_booking_links sl JOIN multipark_bookings sb ON sb.externalId = sl.bookingExternalId
      WHERE sl.clientId = ${idCol} AND ${projectScope(sql`sb.projectId`)})
    OR (NOT EXISTS (SELECT 1 FROM crm_booking_links sl2 WHERE sl2.clientId = ${idCol})
      AND EXISTS (SELECT 1 FROM crm_clients sc WHERE sc.id = ${idCol} AND sc.source <> 'bookings')))`;
}

/** Ids (de entre estes) que existem e são visíveis a quem pede. */
export async function visibleClientIds(db: any, ids: number[]): Promise<Set<number>> {
  const list = [...new Set(ids.filter((x) => Number.isInteger(x) && x > 0))];
  if (!list.length) return new Set();
  const rows = rowsOf(await db.execute(sql`SELECT c.id FROM crm_clients c
    WHERE c.id IN (${sql.join(list.map((x) => sql`${x}`), sql`, `)}) AND ${clientVisibleSql(sql`c.id`)}`));
  return new Set(rows.map((r) => Number(r.id)));
}
