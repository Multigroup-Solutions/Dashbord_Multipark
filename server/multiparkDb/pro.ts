/**
 * Clientes Pro e a sua CONTA CORRENTE lidos da BD da Multipark (só leitura),
 * para a sincronização da nossa conta corrente (server/crm/proSync.ts).
 * Segue as regras de read.ts: SQL parametrizado, construtores e mapeadores
 * PUROS, LIMIT sempre. Regras de valores: shared/crmPro.ts.
 *
 * Cinco leituras pequenas (os Pro são poucos: ~21 clientes, ~1 % das reservas):
 *   1. "ProClient" (um por cliente e parque) + "Park" + "Client";
 *   2. reservas Pro ("proClientId" preenchido ou "pro") com as somas das
 *      linhas de preço ("BookingPricing": total, amountPaid);
 *   3. pagamentos datados dessas reservas ("BookingPricingPayment");
 *   4. acertos de Pro ("EntitySettlement", entityType PRO_CLIENT);
 *   5. cobranças online ("ProPayment").
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList, safeMultiparkRead, type MultiparkRead } from "./read";
import { bookingOwed, lisbonMonth, parseMpPeriodKey } from "../../shared/crmPro";

export const PRO_BOOKINGS_LIMIT = 20_000;
export const PRO_ROWS_LIMIT = 50_000;

const ts = (expr: string) => `to_char(${expr}, 'YYYY-MM-DD HH24:MI:SS')`;
const PRO_BOOKING = `(b."proClientId" IS NOT NULL OR b."pro" = true)`;

// ─── SQL (PURO) ─────────────────────────────────────────────────────────────

export function buildProClientsSql(): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const lim = p.add(5000);
  return {
    sql: [
      `SELECT pc."id" AS pro_client_id, pc."clientId" AS client_id, pc."parkId" AS park_id, pc."discount" AS discount,`,
      `  pc."active" AS active, ${ts(`pc."deactivatedAt"`)} AS deactivated_at, ${ts(`pc."createdAt"`)} AS created_at,`,
      `  NULLIF(pc."name", '') AS pro_name, NULLIF(pc."taxName", '') AS pc_tax_name, NULLIF(pc."taxNumber", '') AS pc_tax_number,`,
      `  p."name" AS park_name, p."city" AS park_city,`,
      `  c."firstName" AS first_name, c."lastName" AS last_name, NULLIF(c."email", '') AS email, NULLIF(c."phoneNumber", '') AS phone,`,
      `  NULLIF(c."nif", '') AS nif, NULLIF(c."taxName", '') AS tax_name, c."autoBillingEnabled" AS auto_billing,`,
      `  (c."anonymizedAt" IS NOT NULL) AS anonymized`,
      `FROM "ProClient" pc`,
      `LEFT JOIN "Park" p ON p."id" = pc."parkId"`,
      `LEFT JOIN "Client" c ON c."id" = pc."clientId"`,
      `ORDER BY pc."createdAt"`,
      `LIMIT ${lim}`,
    ].join("\n"),
    params: p.values,
  };
}

export function buildProBookingsSql(limit = PRO_BOOKINGS_LIMIT): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const lim = p.add(Math.min(Math.max(Math.floor(limit), 1), PRO_BOOKINGS_LIMIT + 1));
  return {
    sql: [
      `WITH pb AS (SELECT b."id" FROM "Booking" b WHERE ${PRO_BOOKING} ORDER BY b."createdAt" DESC LIMIT ${lim}),`,
      `pr AS (SELECT y."bookingId" AS booking_id, count(*) AS lines, SUM(y."total") AS total, SUM(y."amountPaid") AS paid,`,
      `  MAX(y."updatedAt") FILTER (WHERE y."amountPaid" > 0) AS paid_updated_at`,
      `  FROM "BookingPricing" y WHERE y."bookingId" IN (SELECT pb."id" FROM pb) GROUP BY y."bookingId")`,
      `SELECT b."id" AS id, NULLIF(b."allocation", '') AS code, b."status"::text AS status,`,
      `  ${ts(`b."checkIn"`)} AS check_in, ${ts(`b."checkOut"`)} AS check_out, ${ts(`b."createdAt"`)} AS created_at,`,
      `  b."parkId" AS park_id, b."clientId" AS client_id, b."proClientId" AS pro_client_id, b."pro" AS pro,`,
      `  b."bookingPrice" AS booking_price, b."discountAmount" AS discount_amount,`,
      `  COALESCE(pr.lines, 0) AS pricing_lines, pr.total AS pricing_total, COALESCE(pr.paid, 0) AS paid, ${ts(`pr.paid_updated_at`)} AS paid_updated_at,`,
      `  NULLIF(v."licensePlate", '') AS plate,`,
      `  NULLIF(TRIM(CONCAT(tc."firstName", ' ', tc."lastName")), '') AS traveler_name,`,
      // parque REAL da reserva (a cidade decide quem a vê)
      `  bpk."name" AS park_name, bpk."city" AS park_city,`,
      // dono da reserva (a conta): para os Pro antigos, sem ProClient
      `  NULLIF(TRIM(CONCAT(oc."firstName", ' ', oc."lastName")), '') AS owner_name, NULLIF(oc."email", '') AS owner_email,`,
      `  NULLIF(oc."phoneNumber", '') AS owner_phone, NULLIF(oc."nif", '') AS owner_nif, (oc."anonymizedAt" IS NOT NULL) AS owner_anonymized`,
      `FROM pb`,
      `JOIN "Booking" b ON b."id" = pb."id"`,
      `LEFT JOIN pr ON pr.booking_id = b."id"`,
      `LEFT JOIN "Park" bpk ON bpk."id" = b."parkId"`,
      `LEFT JOIN "Client" oc ON oc."id" = b."clientId"`,
      `LEFT JOIN "BookingVehicle" v ON v."id" = b."vehicleId"`,
      `LEFT JOIN "Client" tc ON tc."id" = COALESCE(b."customerId", b."clientId")`,
    ].join("\n"),
    params: p.values,
  };
}

export function buildProPricingPaymentsSql(): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const lim = p.add(PRO_ROWS_LIMIT + 1);
  return {
    sql: [
      `SELECT pp."id" AS id, y."bookingId" AS booking_id, pp."amount" AS amount, NULLIF(pp."paymentMethod", '') AS method, ${ts(`pp."recordedAt"`)} AS recorded_at`,
      `FROM "BookingPricingPayment" pp`,
      `JOIN "BookingPricing" y ON y."id" = pp."pricingId"`,
      `JOIN "Booking" b ON b."id" = y."bookingId"`,
      `WHERE ${PRO_BOOKING}`,
      `ORDER BY pp."recordedAt" DESC`,
      `LIMIT ${lim}`,
    ].join("\n"),
    params: p.values,
  };
}

export function buildProSettlementsSql(): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const type = p.add("PRO_CLIENT");
  const lim = p.add(PRO_ROWS_LIMIT + 1);
  return {
    sql: [
      `SELECT s."id" AS id, s."entityId" AS entity_id, s."parkId" AS park_id, s."scopeKey" AS scope_key, s."periodKey" AS period_key,`,
      `  ${ts(`s."paidAt"`)} AS paid_at, NULLIF(s."method", '') AS method, s."amount" AS amount, s."source"::text AS source,`,
      `  spk."name" AS park_name, spk."city" AS park_city`,
      `FROM "EntitySettlement" s`,
      `LEFT JOIN "Park" spk ON spk."id" = s."parkId"`,
      `WHERE s."entityType"::text = ${type}`,
      `ORDER BY s."paidAt" DESC`,
      `LIMIT ${lim}`,
    ].join("\n"),
    params: p.values,
  };
}

export function buildProOnlinePaymentsSql(): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const lim = p.add(PRO_ROWS_LIMIT + 1);
  return {
    sql: [
      `SELECT pp."id" AS id, pp."clientId" AS client_id, pp."amount" AS amount, pp."status"::text AS status, NULLIF(pp."paymentMethod", '') AS method,`,
      `  ${ts(`pp."periodStart"`)} AS period_start, ${ts(`pp."periodEnd"`)} AS period_end, ${ts(`pp."createdAt"`)} AS created_at,`,
      `  pp."isMitCharge" AS mit,`,
      // cliente da cobrança (Pro antigo, sem ProClient): conta própria
      `  (c."id" IS NOT NULL) AS client_found, NULLIF(TRIM(CONCAT(c."firstName", ' ', c."lastName")), '') AS client_name,`,
      `  NULLIF(c."email", '') AS client_email, NULLIF(c."phoneNumber", '') AS client_phone, NULLIF(c."nif", '') AS client_nif,`,
      `  (c."anonymizedAt" IS NOT NULL) AS client_anonymized`,
      `FROM "ProPayment" pp`,
      `LEFT JOIN "Client" c ON c."id" = pp."clientId"`,
      `ORDER BY pp."createdAt" DESC`,
      `LIMIT ${lim}`,
    ].join("\n"),
    params: p.values,
  };
}

// ─── Linhas → conta corrente (PURO) ─────────────────────────────────────────

export interface ProParkOut {
  proClientId: string; parkId: string | null; parkName: string | null; city: string | null; name: string | null;
  discount: number | null; active: boolean; deactivatedAt: string | null; mpCreatedAt: string | null;
}
export interface ProAccountOut {
  mpClientId: string; name: string | null; email: string | null; phone: string | null; nif: string | null; taxName: string | null;
  autoBilling: boolean; active: boolean; parks: ProParkOut[];
  /** Pro antigo: tem reservas Pro ou cobranças online mas nenhum ProClient hoje (modelo anterior a abril 2026) */
  legacy: boolean;
}
export interface ProLedgerOut {
  mpClientId: string; kind: "booking" | "payment" | "paid_undated" | "settlement" | "online"; sourceId: string;
  entryAt: string; periodKey: string; mpPeriodKey: string | null; parkId: string | null; parkName: string | null; city: string | null;
  bookingExternalId: string | null; bookingCode: string | null; checkIn: string | null; checkOut: string | null;
  plate: string | null; travelerName: string | null; description: string | null;
  debit: number; credit: number; paidAmount: number | null; listPrice: number | null; discountAmount: number | null; infoAmount: number | null;
  status: string | null; method: string | null;
}
export interface ProDiagnostics {
  proClients: number; accounts: number; bookings: number; bookingsWithoutAccount: number; payments: number; undatedPaid: number;
  settlements: number; settlementsWithoutAccount: number; settlementPeriodShapes: Record<string, number>; settlementPeriodUnparsed: number;
  online: number; onlineWithoutAccount: number; pricingDiffersFromPrice: number; truncated: boolean;
  /** contas "Pro antigo" criadas a partir de reservas/cobranças sem ProClient */
  legacyAccounts: number;
}
export interface ProSnapshot { accounts: ProAccountOut[]; ledger: ProLedgerOut[]; diagnostics: ProDiagnostics }

type Row = Record<string, unknown>;

/** Forma de um período sem os valores (dígitos → 9, letras → a): para o registo. PURA. */
export function periodShape(s: string | null | undefined): string {
  return String(s ?? "").slice(0, 40).replace(/\d/g, "9").replace(/[a-z]/gi, "a") || "(vazio)";
}

export function mapProSnapshot(input: {
  proClients: Row[]; bookings: Row[]; payments: Row[]; settlements: Row[]; online: Row[]; truncated?: boolean;
}): ProSnapshot {
  // 1) contas (uma por "Client") com os parques
  const accounts = new Map<string, ProAccountOut>();
  const accountOfProClient = new Map<string, string>();
  const parkOfId = new Map<string, { name: string | null; city: string | null }>();
  for (const r of input.proClients) {
    const pcId = str(r.pro_client_id), clientId = str(r.client_id);
    if (!pcId || !clientId) continue;
    accountOfProClient.set(pcId, clientId);
    const parkId = str(r.park_id);
    if (parkId) parkOfId.set(parkId, { name: str(r.park_name), city: str(r.park_city) });
    let a = accounts.get(clientId);
    if (!a) {
      const anonymized = bool(r.anonymized);
      const person = anonymized ? null : str([r.first_name, r.last_name].map((x) => str(x) ?? "").join(" "));
      a = {
        mpClientId: clientId, name: str(r.pro_name) ?? person, email: anonymized ? null : str(r.email), phone: anonymized ? null : str(r.phone),
        nif: str(r.pc_tax_number) ?? str(r.nif), taxName: str(r.pc_tax_name) ?? str(r.tax_name), autoBilling: bool(r.auto_billing), active: false, parks: [], legacy: false,
      };
      accounts.set(clientId, a);
    } else {
      a.name = a.name ?? str(r.pro_name);
      a.nif = a.nif ?? str(r.pc_tax_number);
      a.taxName = a.taxName ?? str(r.pc_tax_name);
    }
    const active = bool(r.active);
    if (active) a.active = true;
    a.parks.push({
      proClientId: pcId, parkId, parkName: str(r.park_name), city: str(r.park_city), name: str(r.pro_name),
      discount: num(r.discount), active, deactivatedAt: str(r.deactivated_at), mpCreatedAt: str(r.created_at),
    });
  }
  const accountFor = (proClientId: string | null, clientId: string | null) =>
    (proClientId && (accountOfProClient.get(proClientId) ?? (accounts.has(proClientId) ? proClientId : null))) ||
    (clientId && accounts.has(clientId) ? clientId : null);

  const ledger: ProLedgerOut[] = [];
  const diag: ProDiagnostics = {
    proClients: input.proClients.length, accounts: accounts.size, bookings: 0, bookingsWithoutAccount: 0, payments: 0, undatedPaid: 0,
    settlements: 0, settlementsWithoutAccount: 0, settlementPeriodShapes: {}, settlementPeriodUnparsed: 0,
    online: 0, onlineWithoutAccount: 0, pricingDiffersFromPrice: 0, truncated: !!input.truncated, legacyAccounts: 0,
  };
  /** Conta "Pro antigo" (cliente sem ProClient hoje): não se perdem reservas nem dívida. */
  const legacyAccount = (clientId: string, c: { name: unknown; email: unknown; phone: unknown; nif: unknown; anonymized: unknown }) => {
    let a = accounts.get(clientId);
    if (!a) {
      const anon = bool(c.anonymized);
      a = {
        mpClientId: clientId, name: anon ? null : str(c.name), email: anon ? null : str(c.email), phone: anon ? null : str(c.phone),
        nif: str(c.nif), taxName: null, autoBilling: false, active: false, parks: [], legacy: true,
      };
      accounts.set(clientId, a);
      diag.legacyAccounts++;
    }
    return clientId;
  };
  const base = { mpPeriodKey: null, parkId: null, parkName: null, city: null, bookingExternalId: null, bookingCode: null, checkIn: null, checkOut: null,
    plate: null, travelerName: null, description: null, debit: 0, credit: 0, paidAmount: null, listPrice: null, discountAmount: null, infoAmount: null, status: null, method: null };

  // 2) reservas (débito) e o pago sem data
  const bookingInfo = new Map<string, {
    account: string; periodKey: string; parkId: string | null; parkName: string | null; city: string | null; code: string | null; paid: number;
    /** data para o "pago sem data": última alteração do pago, senão a saída, senão a entrada */
    paidUpdatedAt: string;
  }>();
  for (const r of input.bookings) {
    const id = str(r.id);
    if (!id) continue;
    const ownerId = str(r.client_id);
    const account = accountFor(str(r.pro_client_id), bool(r.pro) ? ownerId : null)
      ?? (ownerId ? legacyAccount(ownerId, { name: r.owner_name, email: r.owner_email, phone: r.owner_phone, nif: r.owner_nif, anonymized: r.owner_anonymized }) : null);
    if (!account) { diag.bookingsWithoutAccount++; continue; }
    const checkIn = str(r.check_in), created = str(r.created_at);
    const entryAt = checkIn ?? created;
    const periodKey = lisbonMonth(entryAt);
    if (!entryAt || !periodKey) continue;
    const status = str(r.status);
    const cancelled = String(status ?? "").toUpperCase().includes("CANCEL");
    const paid = round(num(r.paid) ?? 0);
    const lines = num(r.pricing_lines) ?? 0, total = num(r.pricing_total), price = num(r.booking_price);
    if (lines > 0 && total != null && price != null && Math.abs(total - price) > 0.01) diag.pricingDiffersFromPrice++;
    const parkId = str(r.park_id);
    // parque real da reserva (junção a "Park"); recurso: os parques do ProClient
    const park = { name: str(r.park_name) ?? (parkId ? parkOfId.get(parkId)?.name ?? null : null), city: str(r.park_city) ?? (parkId ? parkOfId.get(parkId)?.city ?? null : null) };
    const code = str(r.code);
    ledger.push({
      ...base, mpClientId: account, kind: "booking", sourceId: id, entryAt, periodKey, parkId, parkName: park.name, city: park.city,
      bookingExternalId: id, bookingCode: code, checkIn, checkOut: str(r.check_out), plate: str(r.plate), travelerName: str(r.traveler_name),
      debit: bookingOwed({ pricingLines: lines, pricingTotal: total == null ? null : round(total), bookingPrice: price, paid, cancelled }),
      paidAmount: paid, listPrice: price == null ? null : round(price), discountAmount: num(r.discount_amount) == null ? null : round(num(r.discount_amount)!),
      status, description: code ? `Reserva ${code}` : "Reserva",
    });
    bookingInfo.set(id, {
      account, periodKey, parkId, parkName: park.name, city: park.city, code, paid,
      // data ESTÁVEL (a última alteração das linhas mudava com qualquer edição e passava o valor de ano)
      paidUpdatedAt: str(r.check_out) ?? entryAt,
    });
    diag.bookings++;
  }

  // 3) pagamentos datados (crédito, no mês da reserva que pagam)
  const datedByBooking = new Map<string, number>();
  for (const r of input.payments) {
    const id = str(r.id), bookingId = str(r.booking_id);
    const b = bookingId ? bookingInfo.get(bookingId) : undefined;
    const amount = round(num(r.amount) ?? 0);
    const at = str(r.recorded_at);
    if (!id || !b || !at || amount === 0) continue;
    datedByBooking.set(bookingId!, round((datedByBooking.get(bookingId!) ?? 0) + amount));
    ledger.push({
      ...base, mpClientId: b.account, kind: "payment", sourceId: id, entryAt: at, periodKey: b.periodKey, parkId: b.parkId, parkName: b.parkName, city: b.city,
      bookingExternalId: bookingId, bookingCode: b.code, credit: amount, method: str(r.method), description: b.code ? `Pagamento da reserva ${b.code}` : "Pagamento",
    });
    diag.payments++;
  }
  // o crédito total de cada reserva bate SEMPRE com o pago dela ("amountPaid"):
  // o que falta sem data entra como "pago (sem data)"; o que sobra (pago
  // corrigido para baixo, reembolso sem pagamento negativo) entra como correção
  for (const [bookingId, b] of bookingInfo) {
    const rest = round(b.paid - (datedByBooking.get(bookingId) ?? 0));
    if (Math.abs(rest) <= 0.005) continue;
    const label = rest > 0 ? "sem data do pagamento" : "pago corrigido na Multipark";
    ledger.push({
      ...base, mpClientId: b.account, kind: "paid_undated", sourceId: bookingId, entryAt: b.paidUpdatedAt, periodKey: b.periodKey,
      parkId: b.parkId, parkName: b.parkName, city: b.city, bookingExternalId: bookingId, bookingCode: b.code, credit: rest,
      description: b.code ? `Pago na reserva ${b.code} (${label})` : `Pago (${label})`,
    });
    diag.undatedPaid++;
  }

  // 4) acertos: marca "período pago" (não conta no saldo)
  for (const r of input.settlements) {
    const id = str(r.id), at = str(r.paid_at);
    if (!id || !at) continue;
    diag.settlements++;
    const raw = str(r.period_key);
    const shape = periodShape(raw);
    diag.settlementPeriodShapes[shape] = (diag.settlementPeriodShapes[shape] ?? 0) + 1;
    const account = accountFor(str(r.entity_id), str(r.entity_id));
    if (!account) { diag.settlementsWithoutAccount++; continue; }
    const pk = parseMpPeriodKey(raw);
    if (!pk) diag.settlementPeriodUnparsed++;
    const parkId = str(r.park_id);
    const park = { name: str(r.park_name) ?? (parkId ? parkOfId.get(parkId)?.name ?? null : null), city: str(r.park_city) ?? (parkId ? parkOfId.get(parkId)?.city ?? null : null) };
    ledger.push({
      ...base, mpClientId: account, kind: "settlement", sourceId: id, entryAt: at, periodKey: pk ?? "", mpPeriodKey: raw,
      parkId, parkName: park.name, city: park.city, infoAmount: num(r.amount) == null ? null : round(num(r.amount)!),
      method: str(r.method), status: str(r.source), description: `Período ${raw ?? "?"} registado como pago na Multipark`,
    });
  }

  // 5) cobranças online (marca; não conta no saldo)
  for (const r of input.online) {
    const id = str(r.id), at = str(r.created_at);
    if (!id || !at) continue;
    diag.online++;
    const cid = str(r.client_id);
    const account = accountFor(cid, cid)
      ?? (cid && bool(r.client_found) ? legacyAccount(cid, { name: r.client_name, email: r.client_email, phone: r.client_phone, nif: r.client_nif, anonymized: r.client_anonymized }) : null);
    if (!account) { diag.onlineWithoutAccount++; continue; }
    const start = str(r.period_start), end = str(r.period_end);
    ledger.push({
      ...base, mpClientId: account, kind: "online", sourceId: id, entryAt: at, periodKey: lisbonMonth(start) ?? "",
      infoAmount: round(num(r.amount) ?? 0), status: str(r.status), method: str(r.method) ?? (bool(r.mit) ? "cobrança automática" : null),
      description: `Cobrança online ${start?.slice(0, 10) ?? "?"} → ${end?.slice(0, 10) ?? "?"}`,
    });
  }

  diag.accounts = accounts.size;
  return { accounts: [...accounts.values()], ledger, diagnostics: diag };
}

// ─── Leitura (nunca lança) ──────────────────────────────────────────────────

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

export async function readMultiparkPro(query: Query = multiparkDbQuery): Promise<MultiparkRead<ProSnapshot>> {
  return safeMultiparkRead("clientes Pro", async () => {
    const run = (b: { sql: string; params: SqlParam[] }) => query<Row>(b.sql, b.params);
    const proClients = await run(buildProClientsSql());
    const bookings = await run(buildProBookingsSql(PRO_BOOKINGS_LIMIT + 1));
    const payments = await run(buildProPricingPaymentsSql());
    const settlements = await run(buildProSettlementsSql());
    const online = await run(buildProOnlinePaymentsSql());
    const truncated = bookings.length > PRO_BOOKINGS_LIMIT || payments.length > PRO_ROWS_LIMIT || settlements.length > PRO_ROWS_LIMIT || online.length > PRO_ROWS_LIMIT;
    return mapProSnapshot({
      proClients, bookings: bookings.slice(0, PRO_BOOKINGS_LIMIT), payments: payments.slice(0, PRO_ROWS_LIMIT),
      settlements: settlements.slice(0, PRO_ROWS_LIMIT), online: online.slice(0, PRO_ROWS_LIMIT), truncated,
    });
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
