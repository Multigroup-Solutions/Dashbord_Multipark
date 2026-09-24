import { sql, type SQL } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "./db";
import { cityScope, projectScope } from "./cityScope";
import {
  CRM_PAGE_SIZE,
  type CrmCustomer,
  type CrmDetail,
  type CrmFilters,
  type CrmList,
} from "../shared/crm";

type Row = Record<string, any>;
async function query(statement: SQL): Promise<Row[]> {
  // CRM must never silently behave like a background job without a scope.
  if (!cityScope.getStore())
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Não foi possível verificar o acesso aos clientes.",
    });
  const db = await getDb();
  if (!db)
    throw new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message: "Os dados dos clientes estão temporariamente indisponíveis.",
    });
  try {
    const result = (await db.execute(statement)) as any;
    return Array.isArray(result[0]) ? result[0] : result;
  } catch (error: any) {
    // Drizzle error text contains query parameters, including client emails.
    console.error(
      "[CRM] Falha na leitura",
      error?.cause?.code ?? error?.code ?? "DB_ERROR"
    );
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Não foi possível consultar o histórico. Tenta novamente.",
    });
  }
}
const email = sql`LOWER(TRIM(b.clientEmail)) COLLATE utf8mb4_bin`;
const validEmail = sql`${email} REGEXP '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'`;
const dateText = (field: SQL) =>
  sql`DATE_FORMAT(${field}, '%Y-%m-%dT%H:%i:%sZ')`;
const nowSql = (now: Date) => now.toISOString().slice(0, 19).replace("T", " ");

/** Scope precedes every group, count, search and detail lookup. No writes/migrations. */
export function crmCte(search = "", now = new Date(), key?: string): SQL {
  const term = "%" + search.replace(/[\\%_]/g, "\\$&") + "%";
  return sql`WITH source AS (
    SELECT b.*, ${email} AS contactEmail,
      TRIM(CONCAT_WS(' ', NULLIF(TRIM(b.clientFirstName), ''), NULLIF(TRIM(b.clientLastName), ''))) AS contactName,
      UPPER(TRIM(COALESCE(b.status, ''))) = 'CHECKED_OUT' AS completedStay,
      UPPER(TRIM(COALESCE(b.status, ''))) LIKE 'CANCEL%' AS cancelledStay,
      NULLIF(UPPER(TRIM(b.currency)), '') AS moneyCurrency
    FROM multipark_bookings b
    WHERE ${projectScope(sql`b.projectId`)} AND ${validEmail}
      ${key ? sql`AND SHA2(${email}, 256) = ${key}` : sql``}
  ), contacts AS (
    SELECT SHA2(contactEmail, 256) AS contactKey, contactEmail,
      MIN(NULLIF(contactName, '')) AS contactName,
      COUNT(DISTINCT NULLIF(LOWER(contactName), '')) AS nameCount,
      COUNT(*) AS bookingCount, SUM(completedStay) AS completed, SUM(cancelledStay) AS cancelled,
      SUM(NOT cancelledStay AND NOT completedStay AND checkIn > ${nowSql(now)}) AS upcoming,
      SUM(completedStay AND checkIn >= DATE_SUB(${nowSql(now)}, INTERVAL 12 MONTH) AND checkIn <= ${nowSql(now)}) AS visitsLastYear,
      MIN(CASE WHEN completedStay AND checkIn <= ${nowSql(now)} THEN checkIn END) AS firstVisit,
      MAX(CASE WHEN completedStay AND checkIn <= ${nowSql(now)} THEN checkIn END) AS lastVisit,
      MIN(CASE WHEN NOT cancelledStay AND NOT completedStay AND checkIn > ${nowSql(now)} THEN checkIn END) AS nextVisit,
      COUNT(DISTINCT CASE WHEN completedStay AND checkIn <= ${nowSql(now)} THEN checkIn END) AS datedVisits,
      SUM(CASE WHEN completedStay THEN totalPrice ELSE 0 END) AS stayValue,
      SUM(completedStay AND (totalPrice IS NULL OR moneyCurrency IS NULL)) AS missingAmounts,
      COUNT(DISTINCT CASE WHEN completedStay THEN moneyCurrency END) AS currencyCount,
      MIN(CASE WHEN completedStay THEN moneyCurrency END) AS currency,
      MAX(CASE WHEN ${search === ""} OR contactEmail LIKE ${term} OR contactName LIKE ${term}
        OR clientPhone LIKE ${term} OR licensePlate LIKE ${term} THEN 1 ELSE 0 END) AS searchMatch,
      MAX(syncedAt) AS latestSync
    FROM source GROUP BY contactEmail
  )`;
}
const publicColumns = sql`contacts.*, ${dateText(sql`firstVisit`)} AS firstVisitText,
  ${dateText(sql`lastVisit`)} AS lastVisitText, ${dateText(sql`nextVisit`)} AS nextVisitText,
  CASE WHEN datedVisits > 1 THEN TIMESTAMPDIFF(SECOND, firstVisit, lastVisit) / 86400 / (datedVisits - 1) ELSE NULL END AS averageGapDays`;
const number = (v: unknown) => Number(v ?? 0);
export function mapCrmCustomer(r: Row, money: boolean): CrmCustomer {
  const completeMoney =
    money && number(r.missingAmounts) === 0 && number(r.currencyCount) === 1;
  return {
    key: r.contactKey,
    email: r.contactEmail,
    name:
      number(r.nameCount) > 1
        ? "Contacto com vários nomes"
        : r.contactName || r.contactEmail,
    nameCount: number(r.nameCount),
    bookingCount: number(r.bookingCount),
    completed: number(r.completed),
    cancelled: number(r.cancelled),
    upcoming: number(r.upcoming),
    visitsLastYear: number(r.visitsLastYear),
    firstVisit: r.firstVisitText ?? null,
    lastVisit: r.lastVisitText ?? null,
    nextVisit: r.nextVisitText ?? null,
    averageGapDays:
      r.averageGapDays == null ? null : Math.round(number(r.averageGapDays)),
    stayValue: completeMoney ? number(r.stayValue) : null,
    averageValue:
      completeMoney && number(r.completed) > 0
        ? number(r.stayValue) / number(r.completed)
        : null,
    currency: completeMoney ? r.currency : null,
    missingAmounts: money ? number(r.missingAmounts) : 0,
    needsReview: number(r.nameCount) !== 1,
  };
}
export async function listCrmCustomers(
  input: CrmFilters,
  canViewMoney: boolean,
  now = new Date()
): Promise<CrmList> {
  if (!canViewMoney && input.sort === "value")
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Sem acesso a totais financeiros.",
    });
  const filters: SQL[] = [sql`searchMatch = 1`];
  if (input.segment === "returning")
    filters.push(sql`completed >= 2 AND nameCount = 1`);
  if (input.segment === "first_visit") filters.push(sql`completed = 1`);
  if (input.segment === "review") filters.push(sql`nameCount <> 1`);
  if (input.segment === "inactive")
    filters.push(
      sql`lastVisit < DATE_SUB(${nowSql(now)}, INTERVAL ${input.inactiveDays} DAY) AND nextVisit IS NULL`
    );
  if (input.recentDays)
    filters.push(
      sql`lastVisit >= DATE_SUB(${nowSql(now)}, INTERVAL ${input.recentDays} DAY)`
    );
  const where = sql.join(filters, sql` AND `);
  const order =
    input.sort === "visits"
      ? sql`completed DESC`
      : input.sort === "value"
        ? sql`CASE WHEN currencyCount = 1 AND currency = 'EUR' AND missingAmounts = 0 THEN stayValue END DESC`
        : sql`lastVisit DESC`;
  const [items, counts, overview, missing] = await Promise.all([
    query(sql`${crmCte(input.search, now)} SELECT ${publicColumns} FROM contacts WHERE ${where}
      ORDER BY ${order}, contactKey LIMIT ${CRM_PAGE_SIZE} OFFSET ${(input.page - 1) * CRM_PAGE_SIZE}`),
    query(
      sql`${crmCte(input.search, now)} SELECT COUNT(*) AS total FROM contacts WHERE ${where}`
    ),
    query(sql`${crmCte("", now)} SELECT COUNT(*) AS contacts, SUM(completed >= 2 AND nameCount = 1) AS returning,
      SUM(nameCount <> 1) AS review, ${dateText(sql`MAX(latestSync)`)} AS latestSync FROM contacts`),
    query(
      sql`SELECT COUNT(*) AS n FROM multipark_bookings b WHERE ${projectScope(sql`b.projectId`)} AND (${email} IS NULL OR NOT (${validEmail}))`
    ),
  ]);
  return {
    items: items.map(r => mapCrmCustomer(r, canViewMoney)),
    total: number(counts[0]?.total),
    page: input.page,
    pageSize: CRM_PAGE_SIZE,
    canViewMoney,
    asOf: now.toISOString(),
    overview: {
      contacts: number(overview[0]?.contacts),
      returning: number(overview[0]?.returning),
      review: number(overview[0]?.review),
      missingEmailBookings: number(missing[0]?.n),
      latestSync: overview[0]?.latestSync ?? null,
    },
  };
}

export async function getCrmCustomer(
  key: string,
  bookingPage: number,
  canViewMoney: boolean,
  now = new Date()
): Promise<CrmDetail> {
  const [row] = await query(
    sql`${crmCte("", now, key)} SELECT ${publicColumns} FROM contacts`
  );
  if (!row)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Cliente não encontrado no âmbito autorizado.",
    });
  const customer = mapCrmCustomer(row, canViewMoney);
  const [bookings, monthly, contacts, vehicles, interactions] =
    await Promise.all([
      query(sql`${crmCte("", now, key)} SELECT externalId, bookingNumber AS number, contactName AS name, status, city, parkName AS park,
      ${dateText(sql`checkIn`)} AS checkIn, ${dateText(sql`checkOut`)} AS checkOut, licensePlate AS plate,
      totalPrice AS value, moneyCurrency AS currency FROM source
      ORDER BY checkIn DESC, externalId LIMIT ${CRM_PAGE_SIZE} OFFSET ${(bookingPage - 1) * CRM_PAGE_SIZE}`),
      query(sql`${crmCte("", now, key)} SELECT DATE_FORMAT(checkIn, '%Y-%m') AS month, COUNT(*) AS visits,
      SUM(totalPrice) AS value, moneyCurrency AS currency, SUM(totalPrice IS NULL) AS missing
      FROM source WHERE completedStay AND checkIn BETWEEN DATE_FORMAT(DATE_SUB(${nowSql(now)}, INTERVAL 11 MONTH), '%Y-%m-01') AND ${nowSql(now)}
      GROUP BY DATE_FORMAT(checkIn, '%Y-%m'), moneyCurrency ORDER BY month`),
      query(
        sql`${crmCte("", now, key)} SELECT DISTINCT contactName AS name, clientPhone AS phone FROM source ORDER BY name, phone`
      ),
      query(sql`${crmCte("", now, key)} SELECT licensePlate AS plate, MAX(vehicleBrand) AS brand, MAX(vehicleModel) AS model,
      COUNT(*) AS bookings FROM source WHERE NULLIF(TRIM(licensePlate),'') IS NOT NULL GROUP BY licensePlate ORDER BY bookings DESC, plate`),
      query(sql`SELECT * FROM (
      SELECT CONCAT('complaint-', c.id) AS id, 'complaint' AS kind, c.title, c.complaint_status AS status,
        ${dateText(sql`c.createdAt`)} AS date, '/reclamacoes' AS href FROM complaints c
        WHERE LOWER(TRIM(c.clientEmail)) COLLATE utf8mb4_bin = ${customer.email} AND ${projectScope(sql`c.projectId`)}
      UNION ALL SELECT CONCAT('lost-', l.id), 'lost', l.description, l.status, ${dateText(sql`l.createdAt`)}, '/perdidos-achados'
        FROM lost_found_items l WHERE LOWER(TRIM(l.clientEmail)) COLLATE utf8mb4_bin = ${customer.email} AND ${projectScope(sql`l.projectId`)}
      UNION ALL SELECT CONCAT('review-', r.id), 'review', CONCAT('Avaliação: ', r.rating, '/5'), r.status, ${dateText(sql`r.createdAt`)}, '/criticas'
        FROM google_reviews r WHERE LOWER(TRIM(r.reviewerEmail)) COLLATE utf8mb4_bin = ${customer.email} AND ${projectScope(sql`r.projectId`)}
    ) events ORDER BY date DESC, id LIMIT 51`),
    ]);
  return {
    customer,
    bookings: bookings.map(r => ({
      ...r,
      value: canViewMoney && r.value != null ? number(r.value) : null,
      currency: canViewMoney ? r.currency : null,
    })) as CrmDetail["bookings"],
    bookingPage,
    bookingTotal: customer.bookingCount,
    monthly: monthly.map(r => ({
      month: r.month,
      visits: number(r.visits),
      currency: canViewMoney ? r.currency : null,
      value:
        canViewMoney && r.currency && !number(r.missing)
          ? number(r.value)
          : null,
    })),
    contacts: contacts as CrmDetail["contacts"],
    vehicles: vehicles.map(r => ({
      ...r,
      bookings: number(r.bookings),
    })) as CrmDetail["vehicles"],
    interactions: interactions.slice(0, 50) as CrmDetail["interactions"],
    interactionsTruncated: interactions.length > 50,
    canViewMoney,
  };
}
