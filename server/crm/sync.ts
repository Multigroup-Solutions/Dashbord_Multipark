/**
 * CRM — carga das fichas a partir das reservas da BD da Multipark AO VIVO
 * (server/multiparkDb/crmLive.ts), por lotes, com cursor (trabalho `crm-sync`
 * do agendador, de 15 em 15 min). Fase 1 (29 set 2026): nada vem da cópia
 * `multipark_bookings`; são os clientes de TODAS as reservas nossas (parques
 * nossos + o que vendemos no marketplace).
 *
 * A 1.ª corrida percorre todas as reservas (várias passagens do agendador,
 * cada uma até ao prazo); depois só as que mudaram desde o cursor
 * ("updatedAt", id da Multipark). É idempotente: uma reserva já ligada não se
 * volta a decidir (fusões e separações mudam as ligações à mão).
 * Na nossa BD fica só o CRM (fichas, contactos, carros, ligações) e um RESUMO
 * por ficha (contagens, datas, cidades, parques, canais, parceiros).
 *
 * Regras: shared/crmIdentity.ts. Decisão do lote: server/crm/plan.ts.
 * Cada lote grava em poucas instruções (inserções em bloco) e recalcula as
 * métricas só das fichas tocadas.
 */
import { sql } from "drizzle-orm";
import { GENERIC_EMAIL_MIN_NAMES, INTERNAL_EMAIL_DOMAINS } from "../../shared/crmIdentity";
import { cityLabel, countryFromPhone, type ParkUse } from "../../shared/crmGeo";
import { planBatch, type BookingRow, type ExistingClient } from "./plan";
import { safeDateTime } from "./summary";

export const CRM_SYNC_BATCH = 1500;

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const inList = (vals: (string | number)[]) => sql.join(vals.map((v) => sql`${v}`), sql`, `);
const chunks = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/** Cursor "AAAA-MM-DD HH:MM:SS[.mmm]|id" → partes (vazio = do princípio). O id é o da Multipark (texto). */
export function parseCursor(c: string | null | undefined): { at: string; id: string } {
  const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)\|(.+)$/.exec(String(c ?? ""));
  return m ? { at: m[1], id: m[2] } : { at: "1970-01-01 00:00:00", id: "" };
}

/** Parques nossos (ids da Multipark) — os clientes do CRM são os das reservas nossas. */
async function ourParkIds(): Promise<string[]> {
  const { loadLiveContext } = await import("../finance/liveBookings");
  return [...(await loadLiveContext()).ourParks.keys()];
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
  // emails de reservas nossas com muitos nomes diferentes — BD da Multipark ao vivo
  const [{ buildGenericEmailsSql }, { multiparkDbQuery }] = await Promise.all([import("../multiparkDb/crmLive"), import("../multiparkDb/client")]);
  const { sql: q, params } = buildGenericEmailsSql({ minNames: GENERIC_EMAIL_MIN_NAMES, ourParkIds: await ourParkIds() });
  const set = new Set<string>((await multiparkDbQuery<Record<string, unknown>>(q, params)).map((x) => String(x.email ?? "")).filter(Boolean));
  // e os da casa que já estão nas fichas
  const dom = rowsOf(await db.execute(sql`SELECT DISTINCT email AS e FROM crm_client_emails
    WHERE SUBSTRING_INDEX(email, '@', -1) IN (${inList([...INTERNAL_EMAIL_DOMAINS])})`));
  dom.forEach((x) => set.add(String(x.e)));
  return set;
}

async function loadBatch(cursor: { at: string; id: string }, limit: number) {
  const [{ buildCrmBatchSql, mapCrmBatchRow }, { multiparkDbQuery }] = await Promise.all([import("../multiparkDb/crmLive"), import("../multiparkDb/client")]);
  const { sql: q, params } = buildCrmBatchSql({ cursor, limit, ourParkIds: await ourParkIds() });
  return (await multiparkDbQuery<Record<string, unknown>>(q, params)).map(mapCrmBatchRow);
}

function toBookingRow(r: import("../multiparkDb/crmLive").CrmBatchRow): BookingRow {
  return {
    externalId: r.id, firstName: r.firstName, lastName: r.lastName,
    email: r.email, phone: r.phone, nif: r.nif, plate: r.plate,
    brand: r.brand, model: r.model, color: r.color, vehicleType: r.vehicleType,
    partnerId: r.partnerId, partnerName: r.partnerName, pro: r.pro, origin: r.origin,
    seenAt: safeDateTime(r.seenAt),
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
    // empresas nunca são "quem viajou": funcionários que reservam com o email e o
    // telefone da empresa (conta Pro) ficam com ficha própria, não na da empresa
    for (const c of rowsOf(await db.execute(sql`SELECT id, displayName, firstName, lastName, DATE_FORMAT(lastSeenAt, '%Y-%m-%d %H:%i:%s') AS lastSeenAt FROM crm_clients WHERE status = 'active' AND kind <> 'company' AND id IN (${inList(part)})`))) {
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

/**
 * Recalcula o RESUMO em cache de um conjunto de fichas: as reservas de cada
 * uma (ligações "traveler") lidas AO VIVO da Multipark (server/crm/summary.ts).
 * Também atualiza as reservas por carro e os consentimentos por defeito.
 */
export async function recomputeMetrics(db: any, clientIds: number[]): Promise<void> {
  const ids = [...new Set(clientIds.filter((i) => i > 0))];
  const { readCrmBookingFacts } = await import("../multiparkDb/crmLive");
  const { summarizeBookings, parksJsonOf } = await import("./summary");
  const nowUtc = new Date().toISOString().slice(0, 19).replace("T", " ");
  for (const part of chunks(ids, 300)) {
    const links = rowsOf(await db.execute(sql`SELECT clientId, bookingExternalId FROM crm_booking_links
      WHERE role = 'traveler' AND clientId IN (${inList(part)})`));
    const factList = links.length ? await readCrmBookingFacts(links.map((l) => String(l.bookingExternalId))) : [];
    const factOf = new Map(factList.map((f) => [f.id, f]));
    const byClient = new Map<number, typeof factList>();
    for (const l of links) {
      const f = factOf.get(String(l.bookingExternalId));
      if (!f) continue; // reserva que já não é nossa / não existe: não conta
      const list = byClient.get(Number(l.clientId)) ?? [];
      list.push(f);
      byClient.set(Number(l.clientId), list);
    }
    const flags = rowsOf(await db.execute(sql`
      SELECT c.id,
        (SELECT p.phone FROM crm_client_phones p WHERE p.clientId = c.id ORDER BY p.isPrimary DESC, p.lastSeenAt DESC LIMIT 1) AS bestPhone,
        (SELECT e.email FROM crm_client_emails e WHERE e.clientId = c.id AND e.generic = 0 ORDER BY e.isPrimary DESC, e.lastSeenAt DESC LIMIT 1) AS bestEmail,
        (SELECT COUNT(*) FROM crm_client_emails e WHERE e.clientId = c.id AND e.generic = 0) AS goodEmails,
        (SELECT COUNT(*) FROM crm_client_emails e WHERE e.clientId = c.id AND e.generic = 1) AS genericEmails
      FROM crm_clients c WHERE c.id IN (${inList(part)})`));
    const flagOf = new Map(flags.map((f) => [Number(f.id), f]));
    // só fichas que existem (o INSERT … ON DUPLICATE criaria uma ficha fantasma)
    const existing = part.filter((id) => flagOf.has(id));
    if (!existing.length) continue;
    const sums = new Map(existing.map((id) => [id, summarizeBookings(byClient.get(id) ?? [], nowUtc)]));
    const values = existing.map((id) => {
      const a = sums.get(id)!;
      const f = flagOf.get(id) ?? {};
      const good = Number(f.goodEmails ?? 0), gen = Number(f.genericEmails ?? 0);
      const country = countryFromPhone(f.bestPhone ?? null);
      return sql`(${id}, ${a.bookings}, ${a.cancelled}, ${a.completed}, ${a.upcoming},
        ${a.partnerBookings}, ${a.totalSpent}, ${a.firstVisit}, ${a.lastVisit},
        ${a.nextCheckIn}, ${a.preferredPark ? a.preferredPark.slice(0, 128) : null}, ${parksJsonOf(a.parks)}, ${a.cities}, ${a.cityKeys}, ${a.channels}, ${a.partners},
        ${country}, ${good === 0 ? 1 : 0}, ${good === 0 && gen > 0 ? 1 : 0},
        ${a.anyPro ? 1 : 0}, ${v(f.bestEmail)}, ${v(f.bestPhone)}, UTC_TIMESTAMP())`;
    });
    const upsert = (vals: typeof values) => db.execute(sql`
      INSERT INTO crm_clients (id, bookings, cancelled, completed, upcoming, partnerBookings, totalSpent, firstVisit, lastVisit,
        nextCheckIn, preferredPark, parksJson, cities, cityKeys, channels, partners, country, noEmail, genericEmailOnly, isPro, primaryEmail, primaryPhone, metricsAt)
      VALUES ${sql.join(vals, sql`, `)}
      ON DUPLICATE KEY UPDATE
        bookings = VALUES(bookings), cancelled = VALUES(cancelled), completed = VALUES(completed), upcoming = VALUES(upcoming),
        partnerBookings = VALUES(partnerBookings), totalSpent = VALUES(totalSpent), firstVisit = VALUES(firstVisit),
        lastVisit = VALUES(lastVisit), nextCheckIn = VALUES(nextCheckIn), preferredPark = VALUES(preferredPark),
        parksJson = VALUES(parksJson), cities = VALUES(cities), cityKeys = VALUES(cityKeys), channels = VALUES(channels), partners = VALUES(partners),
        country = COALESCE(VALUES(country), country),
        noEmail = VALUES(noEmail), genericEmailOnly = VALUES(genericEmailOnly),
        isPro = IF(proManual = 1, isPro, GREATEST(isPro, VALUES(isPro))),
        primaryEmail = VALUES(primaryEmail), primaryPhone = VALUES(primaryPhone), metricsAt = VALUES(metricsAt)`);
    try {
      await upsert(values);
    } catch (err) {
      // Uma ficha com um valor que o MySQL recusa não pode parar o lote todo
      // (o cursor ficava preso e não entravam contactos novos): uma a uma,
      // e as que falham ficam registadas e sem resumo (metricsAt vazio).
      const { dbErrorReason } = await import("./proSync");
      console.warn("[crm-sync] resumo em bloco falhou, a gravar uma a uma:", dbErrorReason(err));
      for (let i = 0; i < values.length; i++) {
        try { await upsert([values[i]]); } catch (e) { console.warn(`[crm-sync] resumo da ficha ${existing[i]} falhou:`, dbErrorReason(e)); }
      }
    }
    // reservas por carro (mesma chave que plateKey) — em bloco, só nos carros que já existem
    const plateRows = existing.flatMap((id) => [...sums.get(id)!.plates].map(([plate, nb]) => ({ id, plate, nb })));
    for (const pr of chunks(plateRows, 300)) {
      const derived = sql.join(pr.map((x, i) => (i === 0
        ? sql`SELECT ${x.id} AS clientId, ${x.plate} AS plate, ${x.nb} AS n`
        : sql`SELECT ${x.id}, ${x.plate}, ${x.nb}`)), sql` UNION ALL `);
      await db.execute(sql`UPDATE crm_client_vehicles v JOIN (${derived}) x ON x.clientId = v.clientId AND x.plate = v.plate SET v.bookings = x.n`);
    }
    // Consentimentos: ligados por defeito para quem tem reservas (termos e condições
    // e o próprio serviço — recolha, entrega, fatura). Só onde ninguém decidiu (NULL):
    // o que foi desligado à mão fica desligado.
    await db.execute(sql`UPDATE crm_clients SET
        consentEmail = COALESCE(consentEmail, 1), consentWhatsapp = COALESCE(consentWhatsapp, 1), consentSms = COALESCE(consentSms, 1)
      WHERE id IN (${inList(existing)}) AND bookings > 0 AND (consentEmail IS NULL OR consentWhatsapp IS NULL OR consentSms IS NULL)`);
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
  const TABLES = [
    { t: "crm_client_emails", kind: "email", col: "email", primary: true },
    { t: "crm_client_phones", kind: "phone", col: "phone", primary: true },
    { t: "crm_client_vehicles", kind: "plate", col: "plate", primary: false },
  ] as const;
  const out = new Set<number>();
  for (const r of merged) {
    const m = Number(r.id);
    try {
      // trinco na linha da absorvida: uma separação (que também a tranca) não corre ao mesmo tempo
      await db.transaction(async (tx: any) => {
        const [cur] = rowsOf(await tx.execute(sql`SELECT status, mergedInto FROM crm_clients WHERE id = ${m} FOR UPDATE`));
        if (!cur || cur.status !== "merged" || !cur.mergedInto) return; // entretanto separada: fica como está
        // destino lido agora (segue fusões em cadeia até uma ficha ativa)
        let s = Number(cur.mergedInto);
        for (let i = 0; i < 20; i++) {
          const [n] = rowsOf(await tx.execute(sql`SELECT status, mergedInto FROM crm_clients WHERE id = ${s}`));
          if (!n) return;
          if (n.status === "active") break;
          if (n.status !== "merged" || !n.mergedInto) return;
          s = Number(n.mergedInto);
        }
        if (s === m) return;
        // mesma ordem que a fusão (emails, telefones, carros, depois reservas)
        for (const x of TABLES) {
          const t = sql.raw(x.t), col = sql.raw(x.col);
          // o que foi retirado à mão da que ficou não volta por aqui
          await tx.execute(sql`DELETE ${t} FROM ${t} JOIN crm_blocked_identifiers b ON b.clientId = ${s} AND b.kind = ${x.kind} AND b.value = ${t}.${col}
            WHERE ${t}.clientId = ${m}`);
          // o que a que ficou ainda não tem muda; o repetido (já lá está) sai da absorvida
          await tx.execute(sql`UPDATE IGNORE ${t} SET clientId = ${s}${x.primary ? sql`, isPrimary = 0` : sql``} WHERE clientId = ${m}`);
          await tx.execute(sql`DELETE FROM ${t} WHERE clientId = ${m}`);
        }
        await tx.execute(sql`UPDATE crm_booking_links SET clientId = ${s} WHERE clientId = ${m}`);
        out.add(s);
      });
    } catch (err: any) {
      // ex.: deadlock com uma fusão ao mesmo tempo — fica para o próximo lote, a carga continua
      console.warn(`[crm-sync] arrumar sobras da ficha ${m} ficou para depois:`, String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
    }
  }
  return [...out];
}

/** Um lote: decide e grava. Devolve o novo cursor (ou null se não havia nada). */
async function runOneBatch(db: any, cursor: { at: string; id: string }, generic: Set<string>, limit: number) {
  const raw = await loadBatch(cursor, limit);
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
  return { cursor: nextCursor, rows: rows.length, plan };
}

/**
 * O cursor incremental vive em `multipark_db_cursors` (stream "crm-bookings"):
 * o do agendador só serve para retomar uma corrida a meio e apaga-se quando
 * ela acaba — aqui é preciso lembrar onde se ficou entre corridas.
 */
// Fase 1: novo cursor (ids e datas da BD da Multipark) — a 1.ª corrida revê
// todas as reservas; as já ligadas ficam como estão (idempotente).
export const CRM_CURSOR_STREAM = "crm-bookings-live";

async function loadCrmCursor(db: any): Promise<string | null> {
  const r = rowsOf(await db.execute(sql`SELECT cursorAt, cursorId FROM multipark_db_cursors WHERE stream = ${CRM_CURSOR_STREAM} LIMIT 1`))[0];
  return r?.cursorAt ? `${r.cursorAt}|${r.cursorId ?? ""}` : null;
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
  // Emails da casa que já estavam nas fichas (antes da lista única de domínios):
  // passam a genéricos — deixam de ligar reservas e de contar como email do cliente.
  await markHouseEmailsGeneric(db).catch((err) => console.warn("[crm-sync] emails da casa:", String(err?.message ?? err).slice(0, 160)));
  // fichas com o resumo por fazer (ex.: a Multipark falhou depois de uma junção)
  try {
    const pending = rowsOf(await db.execute(sql`SELECT id FROM crm_clients WHERE status = 'active' AND metricsAt IS NULL LIMIT 500`)).map((r) => Number(r.id));
    if (pending.length) await recomputeMetrics(db, pending);
  } catch (err: any) { console.warn("[crm-sync] resumos por fazer:", String(err?.message ?? err).slice(0, 160)); }
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


/** Emails de domínios da casa (e subdomínios) nas fichas → genéricos. Idempotente. */
export async function markHouseEmailsGeneric(db: any): Promise<number> {
  const doms = [...INTERNAL_EMAIL_DOMAINS];
  const conds = sql.join(doms.map((d) => sql`(SUBSTRING_INDEX(email, '@', -1) = ${d} OR SUBSTRING_INDEX(email, '@', -1) LIKE ${`%.${d}`})`), sql` OR `);
  const res: any = await db.execute(sql`UPDATE crm_client_emails SET generic = 1 WHERE generic = 0 AND (${conds})`);
  return Number((Array.isArray(res) ? res[0] : res)?.affectedRows ?? 0);
}
