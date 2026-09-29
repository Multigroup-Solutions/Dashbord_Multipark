/**
 * SQL partilhado do Marketing com as Reservas & Operações (24 set 2026):
 * a MESMA regra de cancelada e a MESMA fronteira de dia.
 *
 *  - Cancelada: `status = 'CANCELLED'` (shared/marketingRules.ts). No SQL
 *    escreve-se `COALESCE(status, '') <> 'CANCELLED'` para um estado NULL
 *    contar como ativo, tal como nas Reservas & Operações (JS `!== 'CANCELLED'`).
 *  - Dia de Lisboa sobre colunas UTC: `[início, fim)` de shared/lisbonDay.ts.
 *    `bookingCreatedAt` está em UTC (bookingRefresh.parseBookingDate).
 */
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { CANCELLED_STATUS } from "../shared/marketingRules";
import { lisbonDayRangeUtc } from "../shared/lisbonDay";
import { resolveProjectIds } from "./db";
import { scopedProjectIds } from "./cityScope";

export function notCancelledSql(status: SQLWrapper | SQL): SQL {
  return sql`COALESCE(${status}, '') <> ${CANCELLED_STATUS}`;
}

/** `col` dentro dos dias de Lisboa [from, to] (col em UTC). */
export function inLisbonDaysSql(col: SQLWrapper | SQL, from: string, to: string): SQL {
  const r = lisbonDayRangeUtc(from, to);
  return sql`(${col} >= ${r.start} AND ${col} < ${r.end})`;
}

/** Projeto pedido (com filhos) ∩ cidades do utilizador; null = tudo; [] = nada. */
export async function marketingProjectIds(projectId?: number | null): Promise<number[] | null> {
  const requested = projectId ? await resolveProjectIds(projectId) : null;
  const allowed = scopedProjectIds();
  return allowed ? (requested ? requested.filter((id) => allowed.includes(id)) : allowed) : requested;
}
