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

export function campaignScope(type: SQLWrapper, id: SQLWrapper): SQL {
  if (scopedProjectIds() === undefined) return sql`1 = 1`;
  return sql`((${type} = 'internal' AND EXISTS (SELECT 1 FROM internal_campaigns city_campaign
    WHERE city_campaign.id = ${id} AND ${projectScope(sql`city_campaign.projectId`)}))
    OR (${type} = 'ad' AND EXISTS (SELECT 1 FROM campaigns city_campaign
    WHERE city_campaign.id = ${id} AND ${projectScope(sql`city_campaign.projectId`)})))`;
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
