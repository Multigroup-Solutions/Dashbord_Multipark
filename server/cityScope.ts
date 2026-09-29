import { AsyncLocalStorage } from 'node:async_hooks';
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { CityAccess } from './cityAccess';

/** Set by the authenticated tRPC middleware, never by request input. Isolated
 * per request (including batched calls). Background jobs have no user scope. */
export const cityScope = new AsyncLocalStorage<CityAccess>();

export function scopedProjectIds(): number[] | undefined {
  const access = cityScope.getStore();
  return access && !access.all ? access.projectIds : undefined;
}

export function projectScope(column: SQLWrapper): SQL {
  const ids = scopedProjectIds();
  return ids === undefined ? sql`1 = 1` : ids.length
    ? sql`${column} IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})` : sql`1 = 0`;
}

export function cityNameScope(column: SQLWrapper): SQL {
  const access = cityScope.getStore();
  if (!access || access.all) return sql`1 = 1`;
  const names = access.cityNames ?? (access.cityName ? [access.cityName] : []);
  const aliases = [...new Set(names.flatMap(name => {
    const n = name.trim().toLowerCase();
    return n === 'lisboa' ? ['lisboa', 'lisbon'] : n === 'porto' ? ['porto', 'oporto'] : [n];
  }))];
  return aliases.length ? sql`LOWER(TRIM(${column})) IN (${sql.join(aliases.map(n => sql`${n}`), sql`, `)})` : sql`1 = 0`;
}

/** A history row belongs to the city of its booking, not to an inferred name. */
export function bookingHistoryScope(externalId: SQLWrapper): SQL {
  if (scopedProjectIds() === undefined) return sql`1 = 1`;
  return sql`EXISTS (SELECT 1 FROM multipark_bookings city_booking
    WHERE city_booking.externalId = ${externalId} AND ${projectScope(sql`city_booking.projectId`)})`;
}

export function employeeScope(employeeId: SQLWrapper): SQL {
  if (scopedProjectIds() === undefined) return sql`1 = 1`;
  return sql`EXISTS (SELECT 1 FROM employees city_employee
    WHERE city_employee.id = ${employeeId} AND ${projectScope(sql`city_employee.projectId`)})`;
}

export function userScope(userId: SQLWrapper): SQL {
  if (scopedProjectIds() === undefined) return sql`1 = 1`;
  return sql`EXISTS (SELECT 1 FROM employees city_employee
    WHERE city_employee.userId = ${userId} AND ${projectScope(sql`city_employee.projectId`)})`;
}

export function partnerScope(partnerId: SQLWrapper): SQL {
  if (scopedProjectIds() === undefined) return sql`1 = 1`;
  const ids = [...new Set([...scopedProjectIds()!, ...(cityScope.getStore()?.cityIds ?? [])])];
  const operated = ids.length ? sql.join(ids.map(id => sql`JSON_CONTAINS(
    IF(JSON_VALID(city_operator.notes), city_operator.notes, '{}'), ${JSON.stringify(id)}, '$.operatesProjects')`), sql` OR `) : sql`1 = 0`;
  return sql`(EXISTS (SELECT 1 FROM partnerships city_operator WHERE city_operator.id = ${partnerId}
    AND (${operated})) OR EXISTS (SELECT 1 FROM multipark_bookings city_booking
    JOIN partnerships city_partner ON city_partner.id = ${partnerId}
    WHERE ${projectScope(sql`city_booking.projectId`)} AND (
      city_booking.campaign = city_partner.campaignKey OR city_booking.campaign = city_partner.name
      OR EXISTS (SELECT 1 FROM partner_aliases city_alias WHERE city_alias.partnershipId = city_partner.id
        AND city_alias.aliasValue = city_booking.campaign))))`;
}

export function requireGlobalCityAccess(): void {
  if (scopedProjectIds() !== undefined) throw new TRPCError({ code: 'FORBIDDEN',
    message: 'Esta operação abrange várias cidades e exige acesso global.' });
}

export function assertProjectAccess(projectId: number | null | undefined): void {
  const ids = scopedProjectIds();
  if (ids !== undefined && (projectId == null || !ids.includes(projectId))) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Este registo não pertence às tuas cidades autorizadas.' });
  }
}

export async function assertEmployeeAccess(employeeId: number): Promise<void> {
  if (scopedProjectIds() === undefined) return;
  const { getEmployeeById } = await import('./db');
  const person = await getEmployeeById(employeeId);
  assertProjectAccess(person?.employee.projectId);
}

/**
 * PDAs não têm cidade própria: um PDA é da(s) cidade(s) de quem já fez
 * check-in nele. Sem nenhum check-in só aparece a quem vê todas as cidades.
 */
export function pdaScope(pdaId: SQLWrapper): SQL {
  if (scopedProjectIds() === undefined) return sql`1 = 1`;
  return sql`EXISTS (SELECT 1 FROM pda_checkins city_pc WHERE city_pc.pdaId = ${pdaId}
    AND city_pc.employeeId IS NOT NULL AND ${employeeScope(sql`city_pc.employeeId`)})`;
}

/** Um utilizador Zello é da cidade do(s) PDA(s) onde está instalado. */
export function zelloPdaScope(zelloUsername: SQLWrapper): SQL {
  if (scopedProjectIds() === undefined) return sql`1 = 1`;
  return sql`EXISTS (SELECT 1 FROM pdas city_pda WHERE city_pda.zelloUsername = ${zelloUsername}
    AND ${pdaScope(sql`city_pda.id`)})`;
}

/**
 * Linha do GPS do dia (daily_driver_history) — a linha é da PRÓPRIA cidade
 * quando o funcionário resolvido é dessa cidade; sem funcionário (ninguém
 * com login no PDA), pela cidade do PDA desse Zello (se não der para saber,
 * só quem vê todas as cidades).
 */
export function gpsRowOwnScope(employeeId: SQLWrapper, zelloUsername: SQLWrapper): SQL {
  if (scopedProjectIds() === undefined) return sql`1 = 1`;
  return sql`((${employeeId} IS NOT NULL AND ${employeeScope(employeeId)}) OR (${employeeId} IS NULL AND ${zelloPdaScope(zelloUsername)}))`;
}

/** Linha visível: da própria cidade OU com uma parte (PDA partilhado) de alguém dela. */
export function gpsRowScope(historyId: SQLWrapper, employeeId: SQLWrapper, zelloUsername: SQLWrapper): SQL {
  if (scopedProjectIds() === undefined) return sql`1 = 1`;
  return sql`(${gpsRowOwnScope(employeeId, zelloUsername)} OR EXISTS (SELECT 1 FROM driver_day_shares city_sh
    WHERE city_sh.historyId = ${historyId} AND ${employeeScope(sql`city_sh.employeeId`)}))`;
}
