/**
 * Sonda de validação do mapeamento (README, passo 3) — corre na Vercel, onde
 * está a DATABASE_URL_MULTIPARK. SÓ LÊ (as duas BD) e não grava nada.
 *
 * Pega em reservas recentes que já temos em multipark_bookings (vindas da
 * API) e compara-as com a BD da Multipark lida pelo BOOKING_QUERY mapeado:
 *   - datas nos dois DATE_MODE ("utc" e "lisbon_wallclock") → qual bate;
 *   - ids: a reserva existe com o mesmo id? os movimentos ("History") têm os
 *     mesmos ids que o historyId que a API nos deu?
 *   - estado, preços, parque, tipo, voos, parceiro/campanha, pagamento.
 * Dados pessoais (email, telefone, matrícula) saem SÓ como igual/diferente.
 * Também corre uma vez cada consulta do sync (incremental, período, agentes)
 * para confirmar que o SQL é aceite pelo Postgres deles.
 */
import { sql } from "drizzle-orm";
import { multiparkDbQuery, redactSecrets } from "./client";
import {
  BOOKING_QUERY, MOVEMENT_QUERY, bookingsByPeriodSql, byColumnSql, byIdSql, changedSinceSql, driversSql,
  mapBookingRow, mapMovementRow, toApiDate, toMysqlUtc, type BookingRow, type MovementRow,
} from "./queries";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const errText = (err: unknown) => redactSecrets(err).slice(0, 300);
const min16 = (v: unknown) => (v == null ? null : String(v).replace("T", " ").slice(0, 16));
const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
const sameNum = (a: unknown, b: unknown) => {
  const x = num(a), y = num(b);
  return x == null || y == null ? x === y : Math.abs(x - y) < 0.005;
};
const sameText = (a: unknown, b: unknown) =>
  (a == null || a === "" ? null : String(a).trim().toLowerCase()) === (b == null || b === "" ? null : String(b).trim().toLowerCase());

/** Data da BD → "AAAA-MM-DD HH:MM" nos dois modos (o nosso checkIn tem este formato). */
function bothModes(v: unknown): { utc: string | null; lisbon: string | null } {
  return { utc: min16(toMysqlUtc(v)), lisbon: min16(toApiDate(v, "lisbon_wallclock")) };
}

export interface ProbeOptions { sample?: number; days?: number }

export async function runMultiparkDbProbe(opts: ProbeOptions = {}) {
  const sample = Math.max(1, Math.min(20, Math.trunc(opts.sample ?? 10)));
  const days = Math.max(1, Math.min(60, Math.trunc(opts.days ?? 14)));
  const { getDb } = await import("../db");
  const db = await getDb();
  if (!db) throw new Error("BD do dashboard indisponível.");

  // ── Amostra: reservas recentes com histórico já lido + algumas canceladas / com parceiro.
  const pick = async (where: ReturnType<typeof sql>, n: number) => rowsOf(await db.execute(sql`
    SELECT externalId, bookingNumber, status, parkId, parkingType, vehicleType,
      DATE_FORMAT(checkIn, '%Y-%m-%d %H:%i') AS checkIn, DATE_FORMAT(checkOut, '%Y-%m-%d %H:%i') AS checkOut,
      DATE_FORMAT(bookingCreatedAt, '%Y-%m-%d %H:%i') AS createdAt, DATE_FORMAT(sourceUpdatedAt, '%Y-%m-%d %H:%i') AS sourceUpdatedAt,
      DATE_FORMAT(cancelledAt, '%Y-%m-%d %H:%i') AS cancelledAt,
      totalPrice, totalPaid, remainingToPay, paymentMethod, deliveryType, returnFlight, departingFlight,
      partnerId, campaignId, clientEmail, clientPhone, licensePlate, pro
    FROM multipark_bookings
    WHERE checkIn >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${sql.raw(String(days))} DAY) AND ${where}
    ORDER BY checkIn DESC LIMIT ${sql.raw(String(Math.trunc(n)))}`));
  const main = await pick(sql`status = 'CHECKED_OUT' AND historyFetchedAt IS NOT NULL`, sample);
  const cancelled = await pick(sql`status = 'CANCELLED'`, 3);
  const partner = await pick(sql`partnerId IS NOT NULL AND status <> 'CANCELLED'`, 3);
  const seen = new Set<string>();
  const ours = [...main, ...cancelled, ...partner].filter((r) => (seen.has(r.externalId) ? false : (seen.add(r.externalId), true)));

  const tally: Record<string, { same: number; diff: number; skipped: number }> = {};
  const count = (field: string, same: boolean | null) => {
    const t = (tally[field] ??= { same: 0, diff: 0, skipped: 0 });
    if (same === null) t.skipped++; else if (same) t.same++; else t.diff++;
  };
  const bookings: any[] = [];
  const history = { ours: 0, db: 0, idsInBoth: 0, oursMissingInDb: 0, typeSame: 0, timeUtc: 0, timeLisbon: 0, examples: [] as any[] };

  for (const o of ours) {
    const id = String(o.externalId);
    const q = byIdSql("postgres", BOOKING_QUERY, BOOKING_QUERY.cursorId, id);
    let row: BookingRow | undefined;
    let raw: any;
    try {
      row = (await multiparkDbQuery<BookingRow>(q.sql, q.params))[0];
      raw = (await multiparkDbQuery(
        `SELECT b."checkIn" AS "checkIn", b."checkOut" AS "checkOut", b."bookingPrice" AS "bookingPrice" FROM "Booking" b WHERE b."id" = $1`, [id],
      ))[0];
    } catch (err) {
      bookings.push({ id, error: errText(err) });
      continue;
    }
    if (!row) { bookings.push({ id, found: false }); count("found", false); continue; }
    count("found", true);
    const { booking: m } = mapBookingRow(row, "utc");
    const ci = bothModes(row.check_in), co = bothModes(row.check_out), cr = bothModes(row.created_at), up = bothModes(row.updated_at);
    const rawCi = bothModes(raw?.checkIn);
    const dateCmp = {
      checkIn: { ours: o.checkIn, utc: ci.utc === o.checkIn, lisbon: ci.lisbon === o.checkIn },
      checkOut: { ours: o.checkOut, utc: co.utc === o.checkOut, lisbon: co.lisbon === o.checkOut },
      createdAt: { ours: o.createdAt, utc: cr.utc === o.createdAt, lisbon: cr.lisbon === o.createdAt },
      sourceUpdatedAt: { ours: o.sourceUpdatedAt, utc: up.utc === o.sourceUpdatedAt, lisbon: up.lisbon === o.sourceUpdatedAt },
      // A outra coluna ("checkIn" sem "Date") — para saber qual das duas a API usa.
      rawCheckInColumn: { utc: rawCi.utc, lisbon: rawCi.lisbon, equalsCheckInDate: rawCi.utc === ci.utc },
      dbCheckInDate: ci,
    };
    for (const k of ["checkIn", "checkOut", "createdAt", "sourceUpdatedAt"] as const) {
      count(`date.${k}.utc`, o[k] ? (dateCmp as any)[k].utc : null);
      count(`date.${k}.lisbon`, o[k] ? (dateCmp as any)[k].lisbon : null);
    }
    const f = {
      status: sameText(o.status, m.status),
      bookingNumber_allocation: sameText(o.bookingNumber, row.allocation),
      parkId: sameText(o.parkId, m.parkId),
      parkingType: sameText(o.parkingType, m.parkingType),
      vehicleType: sameText(o.vehicleType, m.vehicleType),
      totalPrice: sameNum(o.totalPrice, row.total_price),
      totalPrice_vs_bookingPrice: sameNum(o.totalPrice, raw?.bookingPrice),
      totalPaid: o.totalPaid == null ? null : sameNum(o.totalPaid, row.total_paid),
      remainingToPay: o.remainingToPay == null ? null : sameNum(o.remainingToPay, row.remaining_to_pay),
      paymentMethod: o.paymentMethod == null ? null : sameText(o.paymentMethod, row.payment_method),
      deliveryType: o.deliveryType == null ? null : sameText(o.deliveryType, row.delivery_type),
      returnFlight: o.returnFlight == null ? null : sameText(o.returnFlight, row.return_flight),
      departingFlight: o.departingFlight == null ? null : sameText(o.departingFlight, row.departing_flight),
      partnerId: sameText(o.partnerId, row.partner_id),
      campaignId: o.campaignId == null ? null : sameText(o.campaignId, row.campaign_id),
      cancelledAt: o.cancelledAt == null ? null : (bothModes(row.cancelled_at).utc === o.cancelledAt || bothModes(row.cancelled_at).lisbon === o.cancelledAt),
      clientEmail: o.clientEmail == null ? null : sameText(o.clientEmail, row.client_email),
      clientPhone: o.clientPhone == null ? null : sameText(o.clientPhone, row.client_phone),
      licensePlate: o.licensePlate == null ? null : sameText(o.licensePlate, row.license_plate),
      pro: sameText(Number(o.pro) ? "1" : "0", m.pro ? "1" : "0"),
    };
    for (const [k, v] of Object.entries(f)) count(k, v);
    // Valores não pessoais que ajudam a acertar o mapeamento quando diferem.
    const hints: Record<string, unknown> = {};
    if (f.totalPrice === false) hints.totalPrice = { ours: o.totalPrice, mapped: row.total_price, bookingPrice: raw?.bookingPrice };
    if (f.totalPaid === false) hints.totalPaid = { ours: o.totalPaid, mapped: row.total_paid };
    if (f.paymentMethod === false) hints.paymentMethod = { ours: o.paymentMethod, mapped: row.payment_method };
    if (f.deliveryType === false) hints.deliveryType = { ours: o.deliveryType, mapped: row.delivery_type };
    if (f.parkingType === false) hints.parkingType = { ours: o.parkingType, mapped: m.parkingType };
    if (f.status === false) hints.status = { ours: o.status, mapped: m.status };

    // Movimentos: ids, tipo e hora.
    const oursH = rowsOf(await db.execute(sql`SELECT historyId, changeType, DATE_FORMAT(actionTime, '%Y-%m-%d %H:%i') AS actionTime
      FROM multipark_booking_history WHERE bookingExternalId = ${id}`));
    let dbH: MovementRow[] = [];
    try {
      const hq = byColumnSql("postgres", MOVEMENT_QUERY, MOVEMENT_QUERY.columns.booking_id!, id);
      dbH = await multiparkDbQuery<MovementRow>(hq.sql, hq.params);
    } catch (err) {
      hints.historyError = errText(err);
    }
    const dbById = new Map(dbH.map((h) => [String(h.id), h]));
    history.ours += oursH.length;
    history.db += dbH.length;
    for (const h of oursH) {
      const d = dbById.get(String(h.historyId));
      if (!d) { history.oursMissingInDb++; continue; }
      history.idsInBoth++;
      const mm = mapMovementRow(d).movement;
      if (sameText(mm.changeType, h.changeType)) history.typeSame++;
      const t = bothModes(d.action_time);
      if (t.utc === h.actionTime) history.timeUtc++;
      if (t.lisbon === h.actionTime) history.timeLisbon++;
      if (history.examples.length < 5) history.examples.push({ ours: { type: h.changeType, at: h.actionTime }, db: { type: mm.changeType, utc: t.utc, lisbon: t.lisbon, agent: mm.agentUserId ? "sim" : "não" } });
    }
    bookings.push({ id, status: o.status, dates: dateCmp, fields: f, ...(Object.keys(hints).length ? { hints } : {}), history: { ours: oursH.length, db: dbH.length } });
  }

  // ── As consultas do sync são aceites? (só contagens e cursores; sem dados pessoais)
  const queries: Record<string, unknown> = {};
  const tryQ = async (name: string, fn: () => Promise<unknown>) => {
    const t0 = Date.now();
    try { const out = (await fn()) as object; queries[name] = { ok: true, ms: Date.now() - t0, ...out }; }
    catch (err) { queries[name] = { ok: false, ms: Date.now() - t0, error: errText(err) }; }
  };
  const since = new Date(Date.now() - 2 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
  await tryQ("bookingsChangedSince2h", async () => {
    const q = changedSinceSql("postgres", BOOKING_QUERY, { at: since, id: "" }, 200);
    const r = await multiparkDbQuery<BookingRow>(q.sql, q.params);
    return { rows: r.length, firstCursor: r[0]?.cursor_at ?? null, lastCursor: r.at(-1)?.cursor_at ?? null };
  });
  await tryQ("movementsChangedSince2h", async () => {
    const q = changedSinceSql("postgres", MOVEMENT_QUERY, { at: since, id: "" }, 500);
    const r = await multiparkDbQuery<MovementRow>(q.sql, q.params);
    const types: Record<string, number> = {};
    for (const x of r) types[String(x.change_type)] = (types[String(x.change_type)] ?? 0) + 1;
    return { rows: r.length, types };
  });
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  await tryQ(`period.checkin.${yesterday}`, async () => {
    const q = bookingsByPeriodSql("postgres", yesterday, yesterday, "checkin");
    const r = await multiparkDbQuery<BookingRow>(q.sql, q.params);
    const oursN = rowsOf(await db.execute(sql`SELECT COUNT(*) AS n FROM multipark_bookings WHERE DATE(checkIn) = ${yesterday}`))[0]?.n;
    const oursIds = new Set(rowsOf(await db.execute(sql`SELECT externalId FROM multipark_bookings WHERE DATE(checkIn) = ${yesterday}`)).map((x) => String(x.externalId)));
    const dbIds = new Set(r.map((x) => String(x.id)));
    let both = 0; for (const x of dbIds) if (oursIds.has(x)) both++;
    return { db: r.length, ours: Number(oursN ?? 0), inBoth: both, onlyDb: dbIds.size - both, onlyOurs: oursIds.size - both };
  });
  await tryQ("drivers", async () => {
    const q = driversSql();
    const r = await multiparkDbQuery<any>(q.sql, q.params);
    const roles: Record<string, number> = {};
    for (const x of r) roles[String(x.role)] = (roles[String(x.role)] ?? 0) + 1;
    const known = rowsOf(await db.execute(sql`SELECT DISTINCT agentUserId FROM multipark_booking_history WHERE agentUserId IS NOT NULL AND actionTime >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)`)).map((x) => String(x.agentUserId));
    const ids = new Set(r.map((x) => String(x.id)));
    return {
      rows: r.length, withEmail: r.filter((x) => x.email).length, active: r.filter((x) => x.active === true || x.active === "t").length, roles,
      agentsInOurHistory30d: known.length, ofThoseFoundInDb: known.filter((k) => ids.has(k)).length,
    };
  });

  const verdict = {
    dateMode: (() => {
      const u = tally["date.checkIn.utc"]?.same ?? 0, l = tally["date.checkIn.lisbon"]?.same ?? 0;
      return u > l ? "utc" : l > u ? "lisbon_wallclock" : "indefinido";
    })(),
    bookingIdsSame: (tally.found?.diff ?? 0) === 0 && (tally.found?.same ?? 0) > 0,
    historyIdsSame: history.ours > 0 && history.oursMissingInDb === 0,
  };
  // Interruptor: o que está pedido (Definições/env) e a fonte efetiva agora.
  const src = await import("./source");
  const requested = await src.requestedMultiparkSource();
  const source = { requested, effective: src.effectiveMultiparkSource(requested, src.dbSourceReadiness(process.env)) };
  return { ok: true, ranAt: new Date().toISOString(), sample: ours.length, source, verdict, tally, history, queries, bookings };
}
