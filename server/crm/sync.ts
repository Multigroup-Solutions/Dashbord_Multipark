/**
 * CRM — carga das fichas a partir das reservas (`multipark_bookings`), por
 * lotes, com cursor (trabalho `crm-sync` do agendador, de 15 em 15 min).
 *
 * A 1.ª corrida percorre todas as reservas (várias passagens do agendador,
 * cada uma até ao prazo); depois só as que mudaram desde o cursor
 * (`updatedAt`, `id`). É idempotente: uma reserva já ligada não se volta a
 * decidir (fusões e separações mudam as ligações à mão).
 *
 * Regras: shared/crmIdentity.ts. Decisão do lote: server/crm/plan.ts.
 * Cada lote grava em poucas instruções (inserções em bloco) e recalcula as
 * métricas só das fichas tocadas.
 */
import { sql } from "drizzle-orm";
import { GENERIC_EMAIL_MIN_NAMES, INTERNAL_EMAIL_DOMAINS } from "../../shared/crmIdentity";
import { cityLabel, countryFromPhone, type ParkUse } from "../../shared/crmGeo";
import { planBatch, type BookingRow, type ExistingClient } from "./plan";

export const CRM_SYNC_BATCH = 1500;

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const inList = (vals: (string | number)[]) => sql.join(vals.map((v) => sql`${v}`), sql`, `);
const chunks = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/** Cursor "AAAA-MM-DD HH:MM:SS|id" → partes (vazio = do princípio). */
export function parseCursor(c: string | null | undefined): { at: string; id: number } {
  const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\|(\d+)$/.exec(String(c ?? ""));
  return m ? { at: m[1], id: Number(m[2]) } : { at: "1970-01-01 00:00:00", id: 0 };
}

/** Emails usados por muitos nomes diferentes (balcão, agregadores) + domínios da casa. Cache 1 h. */
let genericCache: { at: number; set: Set<string> } | null = null;
export async function loadGenericEmails(db: any): Promise<Set<string>> {
  if (genericCache && Date.now() - genericCache.at < 60 * 60_000) return genericCache.set;
  const set = await queryGenericEmails(db);
  genericCache = { at: Date.now(), set };
  return set;
}

async function queryGenericEmails(db: any): Promise<Set<string>> {
  const r = rowsOf(await db.execute(sql`
    SELECT LOWER(TRIM(clientEmail)) AS e
    FROM multipark_bookings
    WHERE clientEmail LIKE '%@%'
    GROUP BY LOWER(TRIM(clientEmail))
    HAVING COUNT(DISTINCT LOWER(TRIM(CONCAT(COALESCE(clientFirstName, ''), ' ', COALESCE(clientLastName, ''))))) >= ${GENERIC_EMAIL_MIN_NAMES}`));
  const set = new Set<string>(r.map((x) => String(x.e)));
  const dom = rowsOf(await db.execute(sql`
    SELECT DISTINCT LOWER(TRIM(clientEmail)) AS e FROM multipark_bookings
    WHERE SUBSTRING_INDEX(LOWER(TRIM(clientEmail)), '@', -1) IN (${inList(INTERNAL_EMAIL_DOMAINS)})`));
  dom.forEach((x) => set.add(String(x.e)));
  return set;
}

async function loadBatch(db: any, cursor: { at: string; id: number }, limit: number) {
  const f = (c: string) => sql.raw(`DATE_FORMAT(${c}, '%Y-%m-%d %H:%i:%s')`);
  return rowsOf(await db.execute(sql`
    SELECT id, externalId, clientFirstName, clientLastName, clientEmail, clientPhone, clientNif, licensePlate,
      vehicleBrand, vehicleModel, vehicleColor, vehicleType, partnerId, partnerName, pro, origin,
      ${f("COALESCE(bookingCreatedAt, checkIn)")} AS seenAt, ${f("updatedAt")} AS cursorAt
    FROM multipark_bookings
    WHERE ((updatedAt > ${cursor.at}) OR (updatedAt = ${cursor.at} AND id > ${cursor.id}))
      -- 2 min de folga: uma transação que ainda não gravou não fica para trás do cursor
      AND updatedAt < NOW() - INTERVAL 2 MINUTE
    ORDER BY updatedAt, id
    LIMIT ${sql.raw(String(Math.trunc(limit)))}`));
}

function toBookingRow(r: any): BookingRow {
  return {
    externalId: String(r.externalId), firstName: r.clientFirstName ?? null, lastName: r.clientLastName ?? null,
    email: r.clientEmail ?? null, phone: r.clientPhone ?? null, nif: r.clientNif ?? null, plate: r.licensePlate ?? null,
    brand: r.vehicleBrand ?? null, model: r.vehicleModel ?? null, color: r.vehicleColor ?? null, vehicleType: r.vehicleType ?? null,
    partnerId: r.partnerId ?? null, partnerName: r.partnerName ?? null, pro: Number(r.pro) === 1, origin: r.origin ?? null,
    seenAt: r.seenAt ?? null,
  };
}

/** Fichas ativas que partilham email, telefone ou matrícula com o lote. */
async function loadCandidates(db: any, emails: string[], phones: string[], plates: string[]): Promise<ExistingClient[]> {
  const ids = new Set<number>();
  for (const part of chunks(emails, 800)) rowsOf(await db.execute(sql`SELECT clientId FROM crm_client_emails WHERE generic = 0 AND email IN (${inList(part)})`)).forEach((x) => ids.add(Number(x.clientId)));
  for (const part of chunks(phones, 800)) rowsOf(await db.execute(sql`SELECT clientId FROM crm_client_phones WHERE phone IN (${inList(part)})`)).forEach((x) => ids.add(Number(x.clientId)));
  for (const part of chunks(plates, 800)) rowsOf(await db.execute(sql`SELECT clientId FROM crm_client_vehicles WHERE plate IN (${inList(part)})`)).forEach((x) => ids.add(Number(x.clientId)));
  if (!ids.size) return [];
  const list = [...ids];
  const out = new Map<number, ExistingClient>();
  for (const part of chunks(list, 800)) {
    for (const c of rowsOf(await db.execute(sql`SELECT id, displayName, firstName, lastName, DATE_FORMAT(lastSeenAt, '%Y-%m-%d %H:%i:%s') AS lastSeenAt FROM crm_clients WHERE status = 'active' AND id IN (${inList(part)})`))) {
      const names = [c.displayName, [c.firstName, c.lastName].filter(Boolean).join(" ")].filter((n) => n && String(n).trim()) as string[];
      out.set(Number(c.id), { id: Number(c.id), displayName: c.displayName ?? null, names: [...new Set(names)], emails: [], phones: [], plates: [], lastSeen: c.lastSeenAt ?? null });
    }
    for (const e of rowsOf(await db.execute(sql`SELECT clientId, email FROM crm_client_emails WHERE generic = 0 AND clientId IN (${inList(part)})`))) out.get(Number(e.clientId))?.emails.push(String(e.email));
    for (const p of rowsOf(await db.execute(sql`SELECT clientId, phone FROM crm_client_phones WHERE clientId IN (${inList(part)})`))) out.get(Number(p.clientId))?.phones.push(String(p.phone));
    for (const v of rowsOf(await db.execute(sql`SELECT clientId, plate FROM crm_client_vehicles WHERE clientId IN (${inList(part)})`))) out.get(Number(v.clientId))?.plates.push(String(v.plate));
  }
  return [...out.values()];
}

const v = (x: unknown) => (x === undefined ? null : x);

/** Recalcula as métricas em cache de um conjunto de fichas. */
export async function recomputeMetrics(db: any, clientIds: number[]): Promise<void> {
  const ids = [...new Set(clientIds.filter((i) => i > 0))];
  for (const part of chunks(ids, 500)) {
    const agg = rowsOf(await db.execute(sql`
      SELECT l.clientId,
        COUNT(*) AS bookings,
        SUM(UPPER(COALESCE(b.status, '')) LIKE '%CANCEL%') AS cancelled,
        SUM(UPPER(COALESCE(b.status, '')) IN ('CHECKED_IN', 'CHECKING_OUT', 'PENDING_CHECKOUT', 'CHECKED_OUT')) AS completed,
        SUM(UPPER(COALESCE(b.status, '')) NOT LIKE '%CANCEL%' AND b.checkIn > UTC_TIMESTAMP()) AS upcoming,
        SUM(b.partnerId IS NOT NULL OR b.pro = 1) AS partnerBookings,
        SUM(CASE WHEN UPPER(COALESCE(b.status, '')) IN ('CHECKED_IN', 'CHECKING_OUT', 'PENDING_CHECKOUT', 'CHECKED_OUT') THEN b.totalPrice END) AS totalSpent,
        DATE_FORMAT(MIN(CASE WHEN UPPER(COALESCE(b.status, '')) IN ('CHECKED_IN', 'CHECKING_OUT', 'PENDING_CHECKOUT', 'CHECKED_OUT') THEN b.checkIn END), '%Y-%m-%d %H:%i:%s') AS firstVisit,
        DATE_FORMAT(MAX(CASE WHEN UPPER(COALESCE(b.status, '')) IN ('CHECKED_IN', 'CHECKING_OUT', 'PENDING_CHECKOUT', 'CHECKED_OUT') THEN b.checkIn END), '%Y-%m-%d %H:%i:%s') AS lastVisit,
        DATE_FORMAT(MIN(CASE WHEN UPPER(COALESCE(b.status, '')) NOT LIKE '%CANCEL%' AND b.checkIn > UTC_TIMESTAMP() THEN b.checkIn END), '%Y-%m-%d %H:%i:%s') AS nextCheckIn,
        SUBSTRING(GROUP_CONCAT(DISTINCT b.city ORDER BY b.city SEPARATOR ','), 1, 128) AS cities,
        MAX(b.pro) AS anyPro
      FROM crm_booking_links l
      JOIN multipark_bookings b ON b.externalId = l.bookingExternalId
      WHERE l.role = 'traveler' AND l.clientId IN (${inList(part)})
      GROUP BY l.clientId`));
    // parques usados (vários por cliente), do mais usado para o menos
    const parks = rowsOf(await db.execute(sql`
      SELECT l.clientId, b.parkName, MAX(b.city) AS city, COUNT(*) AS n
      FROM crm_booking_links l JOIN multipark_bookings b ON b.externalId = l.bookingExternalId
      WHERE l.role = 'traveler' AND l.clientId IN (${inList(part)}) AND b.parkName IS NOT NULL
      GROUP BY l.clientId, b.parkName`));
    const parksOf = new Map<number, ParkUse[]>();
    for (const p of parks) {
      const list = parksOf.get(Number(p.clientId)) ?? [];
      list.push({ park: String(p.parkName), city: cityLabel(p.city), bookings: Number(p.n) });
      parksOf.set(Number(p.clientId), list);
    }
    const parksJsonOf = (id: number) => {
      const list = (parksOf.get(id) ?? []).sort((a, b) => b.bookings - a.bookings);
      let json = JSON.stringify(list);
      while (json.length > 1990 && list.length > 1) { list.pop(); json = JSON.stringify(list); }
      return list.length ? json : null;
    };
    const flags = rowsOf(await db.execute(sql`
      SELECT c.id,
        (SELECT p.phone FROM crm_client_phones p WHERE p.clientId = c.id ORDER BY p.isPrimary DESC, p.lastSeenAt DESC LIMIT 1) AS bestPhone,
        (SELECT e.email FROM crm_client_emails e WHERE e.clientId = c.id AND e.generic = 0 ORDER BY e.isPrimary DESC, e.lastSeenAt DESC LIMIT 1) AS bestEmail,
        (SELECT COUNT(*) FROM crm_client_emails e WHERE e.clientId = c.id AND e.generic = 0) AS goodEmails,
        (SELECT COUNT(*) FROM crm_client_emails e WHERE e.clientId = c.id AND e.generic = 1) AS genericEmails
      FROM crm_clients c WHERE c.id IN (${inList(part)})`));
    const flagOf = new Map(flags.map((f) => [Number(f.id), f]));
    const aggOf = new Map(agg.map((a) => [Number(a.clientId), a]));
    // só fichas que existem (o INSERT … ON DUPLICATE criaria uma ficha fantasma)
    const existing = part.filter((id) => flagOf.has(id));
    if (!existing.length) continue;
    const values = existing.map((id) => {
      const a = aggOf.get(id) ?? {};
      const f = flagOf.get(id) ?? {};
      const good = Number(f.goodEmails ?? 0), gen = Number(f.genericEmails ?? 0);
      const top = (parksOf.get(id) ?? []).sort((x, y) => y.bookings - x.bookings)[0]?.park ?? null;
      const country = countryFromPhone(f.bestPhone ?? null);
      return sql`(${id}, ${Number(a.bookings ?? 0)}, ${Number(a.cancelled ?? 0)}, ${Number(a.completed ?? 0)}, ${Number(a.upcoming ?? 0)},
        ${Number(a.partnerBookings ?? 0)}, ${a.totalSpent == null ? null : Number(a.totalSpent)}, ${v(a.firstVisit)}, ${v(a.lastVisit)},
        ${v(a.nextCheckIn)}, ${top ? top.slice(0, 128) : null}, ${parksJsonOf(id)}, ${v(a.cities)}, ${country}, ${good === 0 ? 1 : 0}, ${good === 0 && gen > 0 ? 1 : 0},
        ${Number(a.anyPro ?? 0) === 1 ? 1 : 0}, ${v(f.bestEmail)}, ${v(f.bestPhone)}, UTC_TIMESTAMP())`;
    });
    await db.execute(sql`
      INSERT INTO crm_clients (id, bookings, cancelled, completed, upcoming, partnerBookings, totalSpent, firstVisit, lastVisit,
        nextCheckIn, preferredPark, parksJson, cities, country, noEmail, genericEmailOnly, isPro, primaryEmail, primaryPhone, metricsAt)
      VALUES ${sql.join(values, sql`, `)}
      ON DUPLICATE KEY UPDATE
        bookings = VALUES(bookings), cancelled = VALUES(cancelled), completed = VALUES(completed), upcoming = VALUES(upcoming),
        partnerBookings = VALUES(partnerBookings), totalSpent = VALUES(totalSpent), firstVisit = VALUES(firstVisit),
        lastVisit = VALUES(lastVisit), nextCheckIn = VALUES(nextCheckIn), preferredPark = VALUES(preferredPark),
        parksJson = VALUES(parksJson), cities = VALUES(cities), country = COALESCE(VALUES(country), country),
        noEmail = VALUES(noEmail), genericEmailOnly = VALUES(genericEmailOnly),
        isPro = IF(proManual = 1, isPro, GREATEST(isPro, VALUES(isPro))),
        primaryEmail = VALUES(primaryEmail), primaryPhone = VALUES(primaryPhone), metricsAt = VALUES(metricsAt)`);
  }
}

/**
 * `upcoming`/`nextCheckIn` só mudam quando uma reserva muda: uma "próxima
 * reserva" que já passou sem mexer (não veio) fica para trás. Uma vez por
 * dia (crm-suggestions) recalcula essas fichas. Devolve quantas.
 */
export async function recomputeStaleUpcoming(db: any, o: { deadlineAt: number }): Promise<number> {
  const ids = rowsOf(await db.execute(sql`SELECT id FROM crm_clients
    WHERE status = 'active' AND upcoming > 0 AND nextCheckIn IS NOT NULL AND nextCheckIn < UTC_TIMESTAMP() LIMIT 20000`)).map((r) => Number(r.id));
  let n = 0;
  for (const part of chunks(ids, 500)) {
    if (Date.now() > o.deadlineAt) break;
    await recomputeMetrics(db, part);
    n += part.length;
  }
  return n;
}

export interface CrmSyncResult {
  ok: boolean;
  batches: number;
  rows: number;
  created: number;
  linked: number;
  kept: number;
  genericEmails: number;
  cursor: string | null;
  done: boolean;
  ms: number;
}

/** Identificadores retirados à mão destas fichas ("id|kind|valor"). */
async function loadBlocked(db: any, clientIds: number[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunks(clientIds, 800)) {
    for (const b of rowsOf(await db.execute(sql`SELECT clientId, kind, value FROM crm_blocked_identifiers WHERE clientId IN (${inList(part)})`))) {
      out.add(`${Number(b.clientId)}|${b.kind}|${b.value}`);
    }
  }
  return out;
}

/**
 * Sem trinco entre a carga e as fusões: se uma fusão acabar entre a leitura
 * das fichas e a escrita do lote, ligações/emails/telefones/carros podem cair
 * na ficha absorvida. Passam para a que ficou (segue fusões em cadeia).
 * Devolve as fichas que receberam alguma coisa (para recalcular).
 */
export async function healMergedLeftovers(db: any): Promise<number[]> {
  const merged = rowsOf(await db.execute(sql`SELECT c.id, c.mergedInto FROM crm_clients c
    WHERE c.status = 'merged' AND c.mergedInto IS NOT NULL AND (
      EXISTS (SELECT 1 FROM crm_booking_links l WHERE l.clientId = c.id)
      OR EXISTS (SELECT 1 FROM crm_client_emails e WHERE e.clientId = c.id)
      OR EXISTS (SELECT 1 FROM crm_client_phones p WHERE p.clientId = c.id)
      OR EXISTS (SELECT 1 FROM crm_client_vehicles v WHERE v.clientId = c.id))`));
  if (!merged.length) return [];
  const into = new Map<number, number>();
  for (const r of rowsOf(await db.execute(sql`SELECT id, mergedInto FROM crm_clients WHERE status = 'merged' AND mergedInto IS NOT NULL`))) {
    into.set(Number(r.id), Number(r.mergedInto));
  }
  const finalOf = (id: number) => { let x = id; for (let i = 0; i < 20 && into.has(x); i++) x = into.get(x)!; return x; };
  const out = new Set<number>();
  for (const r of merged) {
    const m = Number(r.id), s = finalOf(m);
    if (!s || s === m) continue;
    // trinco na linha da absorvida: uma separação (que também a tranca) não corre ao mesmo tempo
    await db.transaction(async (tx: any) => {
      const [cur] = rowsOf(await tx.execute(sql`SELECT status, mergedInto FROM crm_clients WHERE id = ${m} FOR UPDATE`));
      if (!cur || cur.status !== "merged") return; // entretanto separada: fica como está
      await tx.execute(sql`UPDATE crm_booking_links SET clientId = ${s} WHERE clientId = ${m}`);
      for (const t of ["crm_client_emails", "crm_client_phones", "crm_client_vehicles"]) {
        // o que a que ficou ainda não tem muda; o repetido (já lá está) sai da absorvida
        await tx.execute(sql`UPDATE IGNORE ${sql.raw(t)} SET clientId = ${s}${t === "crm_client_vehicles" ? sql`` : sql`, isPrimary = 0`} WHERE clientId = ${m}`);
        await tx.execute(sql`DELETE FROM ${sql.raw(t)} WHERE clientId = ${m}`);
      }
      out.add(s);
    });
  }
  return [...out];
}

/** Um lote: decide e grava. Devolve o novo cursor (ou null se não havia nada). */
async function runOneBatch(db: any, cursor: { at: string; id: number }, generic: Set<string>, limit: number) {
  const raw = await loadBatch(db, cursor, limit);
  if (!raw.length) return null;
  const rows = raw.map(toBookingRow);
  const last = raw[raw.length - 1];
  const nextCursor = `${last.cursorAt}|${last.id}`;

  const linkRows = new Map<string, number>();
  for (const part of chunks(rows.map((r) => r.externalId), 800)) {
    for (const l of rowsOf(await db.execute(sql`SELECT bookingExternalId, clientId FROM crm_booking_links WHERE role = 'traveler' AND bookingExternalId IN (${inList(part)})`))) {
      linkRows.set(String(l.bookingExternalId), Number(l.clientId));
    }
  }
  const { emailKey, phoneKey, plateKey } = await import("../../shared/crmIdentity");
  const emails = [...new Set(rows.map((r) => emailKey(r.email)).filter((e) => e && !generic.has(e)))];
  const phones = [...new Set(rows.map((r) => phoneKey(r.phone)).filter(Boolean))];
  const plates = [...new Set(rows.map((r) => plateKey(r.plate)).filter(Boolean))];
  const candidates = await loadCandidates(db, emails, phones, plates);
  const plan = planBatch(rows, generic, linkRows, candidates);

  // 1) fichas novas (syncKey = 1.ª reserva) → ids reais
  const idOf = new Map<number, number>();
  if (plan.newClients.length) {
    for (const part of chunks(plan.newClients, 400)) {
      await db.execute(sql`
        INSERT INTO crm_clients (syncKey, kind, source, displayName, firstName, lastName, primaryEmail, primaryPhone, nif, isPro,
          originPartnerId, originPartnerName, originChannel, lastSeenAt)
        VALUES ${sql.join(part.map((c) => sql`(${c.syncKey}, 'person', 'bookings', ${c.displayName}, ${c.firstName}, ${c.lastName},
          ${c.primaryEmail}, ${c.primaryPhone}, ${c.nif}, ${c.isPro ? 1 : 0}, ${c.originPartnerId}, ${c.originPartnerName},
          ${c.originChannel}, ${c.seenAt})`), sql`, `)}
        ON DUPLICATE KEY UPDATE id = id`);
      for (const r of rowsOf(await db.execute(sql`SELECT id, syncKey FROM crm_clients WHERE syncKey IN (${inList(part.map((c) => c.syncKey))})`))) {
        const nc = part.find((c) => c.syncKey === r.syncKey);
        if (nc) idOf.set(nc.tempId, Number(r.id));
      }
    }
  }
  const real = (id: number) => (id > 0 ? id : idOf.get(id) ?? 0);

  // 2) fichas existentes: completar o que falta (nunca sobrepõe o que já lá está)
  if (plan.touched.length) {
    for (const part of chunks(plan.touched, 400)) {
      await db.execute(sql`
        INSERT INTO crm_clients (id, displayName, firstName, lastName, nif, isPro, lastSeenAt)
        VALUES ${sql.join(part.map((t) => sql`(${t.clientId}, ${t.displayName}, ${t.firstName}, ${t.lastName}, ${t.nif}, ${t.isPro ? 1 : 0}, ${t.seenAt})`), sql`, `)}
        ON DUPLICATE KEY UPDATE
          displayName = COALESCE(displayName, VALUES(displayName)), firstName = COALESCE(firstName, VALUES(firstName)),
          lastName = COALESCE(lastName, VALUES(lastName)), nif = COALESCE(nif, VALUES(nif)),
          isPro = IF(proManual = 1, isPro, GREATEST(isPro, VALUES(isPro))),
          lastSeenAt = IF(lastSeenAt IS NULL OR VALUES(lastSeenAt) > lastSeenAt, VALUES(lastSeenAt), lastSeenAt)`);
    }
  }

  // 3) emails, telefones, carros, ligações — menos o que foi retirado à mão da ficha
  const blocked = await loadBlocked(db, [...new Set([...plan.emails, ...plan.phones, ...plan.vehicles].map((x) => x.clientId).filter((id) => id > 0))]);
  const ok = (clientId: number, kind: string, value: string) => !blocked.has(`${clientId}|${kind}|${value}`);
  const emailsRows = plan.emails.filter((e) => ok(e.clientId, "email", e.email)).map((e) => ({ ...e, clientId: real(e.clientId) })).filter((e) => e.clientId);
  for (const part of chunks(emailsRows, 500)) {
    await db.execute(sql`
      INSERT INTO crm_client_emails (clientId, email, generic, source, firstSeenAt, lastSeenAt)
      VALUES ${sql.join(part.map((e) => sql`(${e.clientId}, ${e.email}, ${e.generic ? 1 : 0}, 'bookings', ${e.seenAt}, ${e.seenAt})`), sql`, `)}
      ON DUPLICATE KEY UPDATE generic = GREATEST(generic, VALUES(generic)),
        firstSeenAt = IF(firstSeenAt IS NULL OR VALUES(firstSeenAt) < firstSeenAt, VALUES(firstSeenAt), firstSeenAt),
        lastSeenAt = IF(lastSeenAt IS NULL OR VALUES(lastSeenAt) > lastSeenAt, VALUES(lastSeenAt), lastSeenAt)`);
  }
  const phoneRows = plan.phones.filter((p) => ok(p.clientId, "phone", p.phone)).map((p) => ({ ...p, clientId: real(p.clientId) })).filter((p) => p.clientId);
  for (const part of chunks(phoneRows, 500)) {
    await db.execute(sql`
      INSERT INTO crm_client_phones (clientId, phone, source, firstSeenAt, lastSeenAt)
      VALUES ${sql.join(part.map((p) => sql`(${p.clientId}, ${p.phone}, 'bookings', ${p.seenAt}, ${p.seenAt})`), sql`, `)}
      ON DUPLICATE KEY UPDATE
        firstSeenAt = IF(firstSeenAt IS NULL OR VALUES(firstSeenAt) < firstSeenAt, VALUES(firstSeenAt), firstSeenAt),
        lastSeenAt = IF(lastSeenAt IS NULL OR VALUES(lastSeenAt) > lastSeenAt, VALUES(lastSeenAt), lastSeenAt)`);
  }
  const vehRows = plan.vehicles.filter((x) => ok(x.clientId, "plate", x.plate)).map((x) => ({ ...x, clientId: real(x.clientId) })).filter((x) => x.clientId);
  for (const part of chunks(vehRows, 400)) {
    await db.execute(sql`
      INSERT INTO crm_client_vehicles (clientId, plate, plateDisplay, brand, model, color, vehicleType, firstSeenAt, lastSeenAt)
      VALUES ${sql.join(part.map((x) => sql`(${x.clientId}, ${x.plate}, ${x.plateDisplay}, ${x.brand}, ${x.model}, ${x.color}, ${x.vehicleType}, ${x.seenAt}, ${x.seenAt})`), sql`, `)}
      ON DUPLICATE KEY UPDATE
        brand = COALESCE(VALUES(brand), brand), model = COALESCE(VALUES(model), model), color = COALESCE(VALUES(color), color),
        vehicleType = COALESCE(VALUES(vehicleType), vehicleType),
        firstSeenAt = IF(firstSeenAt IS NULL OR VALUES(firstSeenAt) < firstSeenAt, VALUES(firstSeenAt), firstSeenAt),
        lastSeenAt = IF(lastSeenAt IS NULL OR VALUES(lastSeenAt) > lastSeenAt, VALUES(lastSeenAt), lastSeenAt)`);
  }
  const linkRowsNew = plan.links.filter((l) => l.rule !== "kept").map((l) => ({ ...l, clientId: real(l.clientId) })).filter((l) => l.clientId);
  for (const part of chunks(linkRowsNew, 500)) {
    await db.execute(sql`
      INSERT INTO crm_booking_links (bookingExternalId, clientId, role, rule)
      VALUES ${sql.join(part.map((l) => sql`(${l.bookingExternalId}, ${l.clientId}, 'traveler', ${l.rule})`), sql`, `)}
      ON DUPLICATE KEY UPDATE clientId = clientId`);
  }

  // 4) o que caiu numa ficha entretanto junta a outra (corrida com uma fusão) passa para a que ficou
  const healed = await healMergedLeftovers(db);

  // 5) métricas das fichas tocadas (+ contagem de reservas por carro)
  const touchedIds = [...new Set([...plan.links.map((l) => real(l.clientId)), ...healed].filter(Boolean))];
  await recomputeMetrics(db, touchedIds);
  for (const part of chunks(touchedIds, 500)) {
    // mesma limpeza que plateKey (espaços . - _ /)
    await db.execute(sql`
      UPDATE crm_client_vehicles v
      JOIN (SELECT l.clientId, UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(b.licensePlate, '-', ''), ' ', ''), '.', ''), '_', ''), '/', '')) AS plate, COUNT(*) AS n
            FROM crm_booking_links l JOIN multipark_bookings b ON b.externalId = l.bookingExternalId
            WHERE l.role = 'traveler' AND l.clientId IN (${inList(part)}) AND b.licensePlate IS NOT NULL
            GROUP BY l.clientId, plate) x ON x.clientId = v.clientId AND x.plate = v.plate
      SET v.bookings = x.n`);
  }
  return { cursor: nextCursor, rows: rows.length, plan };
}

/**
 * O cursor incremental vive em `multipark_db_cursors` (stream "crm-bookings"):
 * o do agendador só serve para retomar uma corrida a meio e apaga-se quando
 * ela acaba — aqui é preciso lembrar onde se ficou entre corridas.
 */
export const CRM_CURSOR_STREAM = "crm-bookings";

async function loadCrmCursor(db: any): Promise<string | null> {
  const r = rowsOf(await db.execute(sql`SELECT cursorAt, cursorId FROM multipark_db_cursors WHERE stream = ${CRM_CURSOR_STREAM} LIMIT 1`))[0];
  return r?.cursorAt ? `${r.cursorAt}|${r.cursorId ?? 0}` : null;
}

async function saveCrmCursor(db: any, cursor: string | null, rows: number, status: "ok" | "partial" | "error", error?: string | null) {
  const c = cursor ? parseCursor(cursor) : null;
  await db.execute(sql`INSERT INTO multipark_db_cursors (stream, cursorAt, cursorId, lastRunAt, lastOkAt, lastStatus, lastError, rowsTotal)
    VALUES (${CRM_CURSOR_STREAM}, ${c?.at ?? null}, ${c ? String(c.id) : null}, UTC_TIMESTAMP(), ${status === "error" ? null : sql`UTC_TIMESTAMP()`}, ${status}, ${error ? error.slice(0, 500) : null}, ${rows})
    ON DUPLICATE KEY UPDATE
      cursorAt = COALESCE(VALUES(cursorAt), cursorAt), cursorId = IF(VALUES(cursorAt) IS NULL, cursorId, VALUES(cursorId)),
      lastRunAt = VALUES(lastRunAt), lastOkAt = COALESCE(VALUES(lastOkAt), lastOkAt),
      lastStatus = VALUES(lastStatus), lastError = VALUES(lastError), rowsTotal = rowsTotal + VALUES(rowsTotal)`);
}

/**
 * Corre lotes até ao prazo. `done` = apanhou todas as reservas até agora.
 * `restart` recomeça do princípio (reprocessa tudo; as ligações existentes ficam).
 */
export async function runCrmSync(o: { deadlineAt: number; batchSize?: number; restart?: boolean }): Promise<CrmSyncResult> {
  const t0 = Date.now();
  const { getDb } = await import("../db");
  const db = await getDb();
  if (!db) throw new Error("BD do dashboard indisponível.");
  const limit = Math.max(100, Math.min(3000, o.batchSize ?? CRM_SYNC_BATCH));
  const generic = await loadGenericEmails(db);
  let cursorStr = o.restart ? null : await loadCrmCursor(db);
  const res: CrmSyncResult = { ok: true, batches: 0, rows: 0, created: 0, linked: 0, kept: 0, genericEmails: generic.size, cursor: cursorStr, done: false, ms: 0 };
  try {
    // Margem para o último lote: não começa um novo se faltam < 12 s.
    while (Date.now() < o.deadlineAt - 12_000) {
      const b = await runOneBatch(db, parseCursor(cursorStr), generic, limit);
      if (!b) { res.done = true; break; }
      res.batches++;
      res.rows += b.rows;
      res.created += b.plan.stats.created;
      res.linked += b.plan.stats.linked;
      res.kept += b.plan.stats.kept;
      cursorStr = b.cursor;
      await saveCrmCursor(db, cursorStr, b.rows, "partial");
      if (b.rows < limit) { res.done = true; break; }
    }
    await saveCrmCursor(db, cursorStr, 0, res.done ? "ok" : "partial");
  } catch (err: any) {
    await saveCrmCursor(db, cursorStr, 0, "error", String(err?.message ?? err)).catch(() => {});
    throw err;
  }
  res.cursor = cursorStr;
  res.ms = Date.now() - t0;
  return res;
}

