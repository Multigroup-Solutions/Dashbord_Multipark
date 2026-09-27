/**
 * PARCERIAS — tab "Pró e avenças": SÓ INFORMATIVA (não é contabilidade; a
 * conta corrente dos Pro é do CRM — server/crm/pro*, shared/crmPro.ts).
 * Lida AO VIVO da BD da Multipark (só leitura), regras de read.ts.
 *
 * Contas:
 *   - Pro = "ProClient" agrupado por cliente ("clientId"; um por parque);
 *   - avença = "ClientPlan" (+ "Allowance".name, preço por período, cadência).
 * Reservas (sem canceladas nem pendentes), somadas em SQL por conta e mês de
 * Lisboa, a ENTRAR (mês da entrada) e a SAIR (mês da saída):
 *   - com "clientPlanId" → a avença;
 *   - senão Pro ("proClientId" ou "pro") → o cliente do ProClient (ou da reserva).
 * Valor = "bookingPrice" (informativo).
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList, safeMultiparkRead, type MultiparkRead } from "./read";
import { buildParksSql, mapParks } from "./dayBookings";
import { LIVE, livePeriods, type LivePeriods } from "./partnerships";

type Row = Record<string, unknown>;
type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

export const PRO_ACCOUNTS_LIMIT = 5000;
export const PRO_MONTH_ROWS_LIMIT = 20_000;

const lisbonMonthOf = (col: string) => `to_char((${col} AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Lisbon', 'YYYY-MM')`;

// ─── SQL (PURO) ─────────────────────────────────────────────────────────────

export function buildProAccountsSql(parkIds: string[]): { sql: string; params: SqlParam[] } {
  if (!parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const parks = parkIds.map((id) => p.add(id)).join(", ");
  const lim = p.add(PRO_ACCOUNTS_LIMIT);
  return {
    sql: [
      `SELECT pc."clientId" AS client_id, MAX(NULLIF(pc."name", '')) AS pro_name, MAX(NULLIF(pc."taxName", '')) AS tax_name,`,
      `  bool_or(pc."active") AS active, MAX(pc."discount") AS discount, string_agg(DISTINCT pc."parkId", ',') AS park_ids,`,
      `  MAX(NULLIF(TRIM(CONCAT(c."firstName", ' ', c."lastName")), '')) AS client_name`,
      `FROM "ProClient" pc`,
      `LEFT JOIN "Client" c ON c."id" = pc."clientId"`,
      `WHERE pc."parkId" IN (${parks})`,
      `GROUP BY pc."clientId"`,
      `LIMIT ${lim}`,
    ].join("\n"),
    params: p.values,
  };
}

export function buildPlansSql(parkIds: string[]): { sql: string; params: SqlParam[] } {
  if (!parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const parks = parkIds.map((id) => p.add(id)).join(", ");
  const lim = p.add(PRO_ACCOUNTS_LIMIT);
  return {
    sql: [
      `SELECT cp."id" AS plan_id, cp."clientId" AS client_id, cp."parkId" AS park_id, cp."status"::text AS status,`,
      `  cp."pricePerPeriod" AS price, cp."cadence"::text AS cadence, NULLIF(a."name", '') AS allowance_name,`,
      `  NULLIF(TRIM(CONCAT(c."firstName", ' ', c."lastName")), '') AS client_name`,
      `FROM "ClientPlan" cp`,
      `LEFT JOIN "Allowance" a ON a."id" = cp."allowanceId"`,
      `LEFT JOIN "Client" c ON c."id" = cp."clientId"`,
      `WHERE cp."parkId" IN (${parks})`,
      `LIMIT ${lim}`,
    ].join("\n"),
    params: p.values,
  };
}

/** Reservas Pro/avença por (conta, sentido, mês de Lisboa) nos últimos 12 meses. */
export function buildProMonthsSql(parkIds: string[], per: LivePeriods): { sql: string; params: SqlParam[] } {
  if (!parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const since = p.add(per.since12), until = p.add(per.until);
  const parks = parkIds.map((id) => p.add(id)).join(", ");
  const lim = p.add(PRO_MONTH_ROWS_LIMIT);
  const inRange = (col: string) => `${col} >= ${since}::timestamp AND ${col} < ${until}::timestamp`;
  return {
    sql: [
      `WITH pb AS (`,
      `  SELECT b."checkIn" AS check_in, b."checkOut" AS check_out, b."bookingPrice" AS price,`,
      `    CASE WHEN b."clientPlanId" IS NOT NULL THEN 'plan' ELSE 'pro' END AS kind,`,
      `    COALESCE(b."clientPlanId", pc."clientId", b."clientId") AS account`,
      `  FROM "Booking" b`,
      `  LEFT JOIN "ProClient" pc ON pc."id" = b."proClientId"`,
      `  WHERE (b."clientPlanId" IS NOT NULL OR b."proClientId" IS NOT NULL OR b."pro" = true)`,
      `    AND ${LIVE} AND b."parkId" IN (${parks})`,
      `    AND ((${inRange(`b."checkIn"`)}) OR (${inRange(`b."checkOut"`)}))`,
      `)`,
      `SELECT * FROM (`,
      `  SELECT kind, account, 'in' AS dir, ${lisbonMonthOf("check_in")} AS month, count(*) AS bookings, SUM(price) AS value`,
      `  FROM pb WHERE ${inRange("check_in")} GROUP BY 1, 2, 3, 4`,
      `  UNION ALL`,
      `  SELECT kind, account, 'out' AS dir, ${lisbonMonthOf("check_out")} AS month, count(*) AS bookings, SUM(price) AS value`,
      `  FROM pb WHERE ${inRange("check_out")} GROUP BY 1, 2, 3, 4`,
      `) u`,
      `LIMIT ${lim}`,
    ].join("\n"),
    params: p.values,
  };
}

// ─── Mapeadores (PUROS) ─────────────────────────────────────────────────────

export interface ProMonth { month: string; inBookings: number; inValue: number | null; outBookings: number; outValue: number | null }
export interface ProSums { inBookings: number; inValue: number | null; outBookings: number; outValue: number | null }
export interface ProLiveRow {
  kind: "pro" | "plan";
  /** Pro: "Client".id; avença: "ClientPlan".id. */
  key: string;
  /** "Client".id na Multipark (liga à conta Pro do CRM). */
  mpClientId: string | null;
  name: string;
  detail: string | null;
  active: boolean;
  parks: string[];
  /** Avença: preço por período e cadência (condições comerciais). */
  price: number | null;
  cadence: string | null;
  /** Meses com movimento (mais recente primeiro), só os 12 meses pedidos. */
  months: ProMonth[];
  thisMonth: ProSums;
  last12: ProSums;
}

const EMPTY: ProSums = { inBookings: 0, inValue: 0, outBookings: 0, outValue: 0 };

/** Contas + meses → linhas da tab. PURA. */
export function mapProLive(input: { accounts: Row[]; plans: Row[]; months: Row[]; parkName: Map<string, string>; thisMonth: string }): ProLiveRow[] {
  const rows = new Map<string, ProLiveRow>();
  const parkNames = (ids: string[]) => [...new Set(ids.map((id) => input.parkName.get(id) ?? id))].sort((a, b) => a.localeCompare(b, "pt"));
  for (const a of input.accounts) {
    const id = str(a.client_id);
    if (!id) continue;
    const discount = num(a.discount);
    rows.set(`pro:${id}`, {
      kind: "pro", key: id, mpClientId: id, name: str(a.pro_name) ?? str(a.tax_name) ?? str(a.client_name) ?? "Cliente Pro",
      detail: discount != null ? `desconto ${discount} %` : null, active: bool(a.active),
      parks: parkNames(String(a.park_ids ?? "").split(",").map((x) => x.trim()).filter(Boolean)),
      price: null, cadence: null, months: [], thisMonth: { ...EMPTY }, last12: { ...EMPTY },
    });
  }
  for (const pl of input.plans) {
    const id = str(pl.plan_id);
    if (!id) continue;
    const status = str(pl.status);
    rows.set(`plan:${id}`, {
      kind: "plan", key: id, mpClientId: str(pl.client_id), name: str(pl.client_name) ?? "Cliente com avença",
      detail: [str(pl.allowance_name), status].filter(Boolean).join(" · ") || null, active: status === "ACTIVE",
      parks: parkNames([str(pl.park_id)].filter((x): x is string => !!x)),
      price: num(pl.price), cadence: str(pl.cadence), months: [], thisMonth: { ...EMPTY }, last12: { ...EMPTY },
    });
  }
  for (const m of input.months) {
    const kind = str(m.kind) === "plan" ? "plan" : "pro";
    const key = str(m.account), month = str(m.month);
    if (!key || !month) continue;
    let r = rows.get(`${kind}:${key}`);
    if (!r) {
      // reserva Pro sem ProClient no âmbito (ex.: Pro antigo): conta própria
      r = { kind, key, mpClientId: kind === "pro" ? key : null, name: kind === "pro" ? "Pro sem registo ProClient" : "Avença sem registo", detail: null, active: false, parks: [], price: null, cadence: null, months: [], thisMonth: { ...EMPTY }, last12: { ...EMPTY } };
      rows.set(`${kind}:${key}`, r);
    }
    let mm = r.months.find((x) => x.month === month);
    if (!mm) { mm = { month, inBookings: 0, inValue: 0, outBookings: 0, outValue: 0 }; r.months.push(mm); }
    const n = num(m.bookings) ?? 0, v = num(m.value) ?? 0;
    const dir = str(m.dir) === "out" ? "out" : "in";
    for (const t of month === input.thisMonth ? [mm, r.thisMonth, r.last12] : [mm, r.last12]) {
      if (dir === "in") { t.inBookings += n; t.inValue = round((t.inValue ?? 0) + v); }
      else { t.outBookings += n; t.outValue = round((t.outValue ?? 0) + v); }
    }
  }
  return [...rows.values()]
    .map((r) => ({ ...r, months: r.months.sort((a, b) => b.month.localeCompare(a.month)) }))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "pro" ? -1 : 1) || b.last12.inBookings - a.last12.inBookings || a.name.localeCompare(b.name, "pt"));
}

/** Sem totais financeiros: sem euros nem preços. PURA. */
export function hideProMoney(rows: ProLiveRow[], canSeeTotals: boolean): ProLiveRow[] {
  if (canSeeTotals) return rows;
  const s = <T extends ProSums>(x: T): T => ({ ...x, inValue: null, outValue: null });
  return rows.map((r) => ({ ...r, price: null, thisMonth: s(r.thisMonth), last12: s(r.last12), months: r.months.map(s) }));
}

// ─── Leitura (nunca lança) ──────────────────────────────────────────────────

export interface ProLive { periods: Pick<LivePeriods, "thisMonth" | "from12">; rows: ProLiveRow[] }

export async function readProLive(cities: string[] | undefined, query: Query = multiparkDbQuery, now: Date = new Date()): Promise<MultiparkRead<ProLive>> {
  return safeMultiparkRead("pró e avenças", async () => {
    const per = livePeriods(now);
    const periods = { thisMonth: per.thisMonth, from12: per.from12 };
    const parks = mapParks(await query(buildParksSql().sql), cities);
    if (!parks.length) return { periods, rows: [] };
    const ids = parks.map((p) => p.id);
    const a = buildProAccountsSql(ids), pl = buildPlansSql(ids), m = buildProMonthsSql(ids, per);
    const [accounts, plans, months] = [await query(a.sql, a.params), await query(pl.sql, pl.params), await query(m.sql, m.params)];
    return { periods, rows: mapProLive({ accounts, plans, months, parkName: new Map(parks.map((p) => [p.id, p.name])), thisMonth: per.thisMonth }) };
  });
}

// ─── Ajudantes ──────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function bool(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "t" || v === "true";
}
const round = (n: number) => Math.round(n * 100) / 100;
