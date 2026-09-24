/**
 * Passagem de turno — RESUMO AUTOMÁTICO (rascunho) do turno.
 *
 * `buildHandoverDraft({ date, shift, city })` junta, para o team leader que
 * fecha o turno, tudo o que o turno seguinte precisa de saber: recolhas e
 * entregas do próximo turno por hora (com voos e valor a cobrar), entregas
 * pendentes, reclamações, perdidos e achados, ocorrências, WhatsApp por ler,
 * PDAs ainda com check-in, picagens sem saída, alertas de velocidade/GPS e
 * quem está de turno agora vs a seguir (com team leader).
 *
 * Regras: SQL sempre parametrizado (drizzle `sql`); cidade SEMPRE explícita
 * (projectos da árvore da cidade) E o âmbito do utilizador (projectScope…);
 * ONLY_FULL_GROUP_BY — só agregados ou colunas agrupadas.
 */
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "./db";
import { projectScope, employeeScope, pdaScope } from "./cityScope";
import { buildHandoverCurrent } from "./shiftHandoverSql";
import { handoverCityKey, type HandoverCity, type HandoverShift } from "../shared/shiftHandover";
import {
  extractNoteItems,
  lisbonHourInShift,
  mergeCarryOver,
  nextShiftOf,
  openItemKey,
  parseOpenItems,
  previousShiftOf,
  shiftHours,
  shiftWindowUtc,
  coveredCarsPending,
  type CoveredCarCandidate,
  type DraftBookingRow,
  type HandoverDraftCounts,
  type OpenItem,
  type ShiftRef,
} from "../shared/shiftHandoverAuto";

// ─── Helpers puros ───────────────────────────────────────────────────────────

/** Projetos da árvore de uma cidade (nó `city` + descendentes). */
export function cityProjectIdsFrom(projects: Array<{ id: number; parentId: number | null; name: string; level: string }>, city: HandoverCity): number[] {
  const ids = new Set<number>();
  const add = (id: number) => {
    if (ids.has(id)) return;
    ids.add(id);
    for (const p of projects) if (p.parentId === id) add(p.id);
  };
  for (const p of projects) if (p.level === "city" && handoverCityKey(p.name) === city) add(p.id);
  return [...ids];
}

/** Contagem por hora (Lisboa) das recolhas/entregas do turno seguinte. */
export function bucketByHour(next: ShiftRef, checkinsMs: number[], checkoutsMs: number[]): Array<{ hour: number; label: string; checkins: number; checkouts: number }> {
  const h = shiftHours(next.shift);
  const rows = Array.from({ length: h.end - h.start }, (_, i) => {
    const hour = h.start + i;
    return { hour, label: `${String(hour % 24).padStart(2, "0")}h`, checkins: 0, checkouts: 0 };
  });
  const put = (ms: number, k: "checkins" | "checkouts") => {
    const hr = lisbonHourInShift(next.date, ms);
    const row = rows[hr - h.start];
    if (row) row[k]++;
  };
  checkinsMs.forEach((m) => put(m, "checkins"));
  checkoutsMs.forEach((m) => put(m, "checkouts"));
  return rows;
}

/** HH:MM de Lisboa de um instante. */
export function lisbonHHMM(ms: number): string {
  return new Intl.DateTimeFormat("pt-PT", { timeZone: "Europe/Lisbon", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
}

/** Pendentes que o rascunho consegue confirmar como ainda abertos. */
export function draftOpenItems(d: {
  complaints: Array<{ id: number; title: string }>;
  lostFound: Array<{ id: number; clientName: string; description: string }>;
  pdas: Array<{ id: number; pdaName: string | null; employeeName: string | null }>;
  incidents: Array<{ id: number; description: string; plate: string | null }>;
  pendingDeliveries: Array<{ externalId: string; bookingNumber: string | null; plate: string | null }>;
}, since: string): OpenItem[] {
  const item = (kind: OpenItem["kind"], refId: number | string, text: string): OpenItem =>
    ({ key: openItemKey(kind, refId), kind, refId, text: text.slice(0, 300), resolved: false, since });
  return [
    ...d.complaints.map((c) => item("complaint", c.id, `#${c.id} ${c.title}`)),
    ...d.lostFound.map((l) => item("lost_found", l.id, `#${l.id} ${l.clientName} — ${l.description.slice(0, 120)}`)),
    ...d.incidents.map((i) => item("incident", i.id, `#${i.id}${i.plate ? ` ${i.plate}` : ""} — ${i.description.slice(0, 120)}`)),
    ...d.pdas.map((p) => item("pda", p.id, `${p.pdaName ?? "PDA"} com check-in de ${p.employeeName ?? "?"}`)),
    ...d.pendingDeliveries.map((b) => item("delivery", b.externalId, `Entrega pendente ${b.bookingNumber ?? b.externalId}${b.plate ? ` (${b.plate})` : ""}`)),
  ];
}

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface DraftPerson { name: string; employeeId: number | null; isTeamLeader: boolean; startHour: number; endHour: number }

export interface HandoverDraft {
  key: { date: string; shift: HandoverShift; city: HandoverCity };
  next: ShiftRef;
  window: { start: string; end: string };
  nextWindow: { start: string; end: string };
  generatedAt: string;
  counts: HandoverDraftCounts;
  byHour: Array<{ hour: number; label: string; checkins: number; checkouts: number }>;
  checkins: DraftBookingRow[];
  checkouts: DraftBookingRow[];
  coveredCheckinsNext: number;
  /** Carros p/ coberto (automático): lugar coberto, no parque, ainda sem movimento. Regra em shared/shiftHandoverAuto.ts. */
  coveredCars: { count: number; list: Array<{ externalId: string; bookingNumber: string | null; plate: string | null; park: string | null; checkIn: string }> };
  pendingDeliveries: Array<{ externalId: string; bookingNumber: string | null; plate: string | null; clientName: string; since: string }>;
  complaints: Array<{ id: number; title: string; status: string; priority: string; createdAt: string; isNew: boolean }>;
  lostFound: Array<{ id: number; clientName: string; description: string; status: string }>;
  incidents: Array<{ id: number; type: string; severity: string; description: string; plate: string | null }>;
  whatsapp: Array<{ id: number; name: string; unreadCount: number }>;
  pdas: Array<{ id: number; pdaName: string | null; employeeName: string | null; since: string }>;
  clockIns: Array<{ employeeId: number; name: string; since: string }>;
  speed: Array<{ name: string; speed: number; limit: number; at: string }>;
  gps: Array<{ name: string; type: string; at: string }>;
  people: { current: DraftPerson[]; next: DraftPerson[] };
  previous: {
    id: number; date: string; shift: HandoverShift; authorName: string | null; createdById: number | null;
    notes: string | null; aiSummary: string | null; openItems: OpenItem[];
    ackByName: string | null; acked: boolean;
  } | null;
  carryOver: OpenItem[];
}

const LIST_LIMIT = 80;
const rowsOf = (res: unknown): any[] => (Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : []) as any[];
const inIds = (col: SQL, ids: number[]): SQL => (ids.length ? sql`${col} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})` : sql`1 = 0`);
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const numOrNull = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const fullName = (a: unknown, b: unknown) => [a, b].filter((x) => typeof x === "string" && x.trim()).join(" ").trim() || "—";
const tsHHMM = (unix: unknown) => (unix == null ? "" : lisbonHHMM(Number(unix) * 1000));

// ─── Rascunho (BD) ───────────────────────────────────────────────────────────

export async function buildHandoverDraft(key: { date: string; shift: HandoverShift; city: HandoverCity }, nowMs: number = Date.now()): Promise<HandoverDraft | null> {
  const db = await getDb();
  if (!db) return null;
  const cur: ShiftRef = { date: key.date, shift: key.shift };
  const next = nextShiftOf(cur);
  const win = shiftWindowUtc(cur);
  const nwin = shiftWindowUtc(next);
  const { projects } = await import("../drizzle/schema");
  const allProjects = await db.select({ id: projects.id, parentId: projects.parentId, name: projects.name, level: projects.level }).from(projects);
  const cityIds = cityProjectIdsFrom(allProjects as any, key.city);
  const inCity = (col: SQL) => sql`(${inIds(col, cityIds)} AND ${projectScope(col)})`;
  const empInCity = (empId: SQL) => sql`EXISTS (SELECT 1 FROM employees ho_e WHERE ho_e.id = ${empId} AND ${inIds(sql`ho_e.projectId`, cityIds)} AND ${employeeScope(sql`ho_e.id`)})`;
  const nowTs = new Date(nowMs).toISOString().slice(0, 19).replace("T", " ");
  const upTo = nowMs < win.endMs ? nowTs : win.end;

  const safe = async <T,>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch (err: any) {
      console.warn(`[handover draft] ${label}:`, String(err?.cause?.message ?? err?.message ?? err).slice(0, 200));
      return fallback;
    }
  };

  // Recolhas (checkIn) e entregas (checkOut) do turno seguinte
  const bookingsIn = (field: "checkIn" | "checkOut") => safe(`bookings ${field}`, async () => rowsOf(await db.execute(sql`
    SELECT b.externalId, b.bookingNumber, b.clientFirstName, b.clientLastName, b.licensePlate,
      UNIX_TIMESTAMP(${sql.identifier(field)}) AS t, b.remainingToPay, b.spotType, b.deliveryType,
      ${field === "checkIn" ? sql`COALESCE(NULLIF(b.departingFlight, ''), b.departureFlight)` : sql`COALESCE(NULLIF(b.returnFlight, ''), b.arrivalFlight)`} AS flight
    FROM multipark_bookings b
    WHERE ${sql.identifier(field)} >= ${nwin.start} AND ${sql.identifier(field)} < ${nwin.end}
      AND (b.status IS NULL OR b.status <> 'CANCELLED')
      AND ${inCity(sql`b.projectId`)}
    ORDER BY t LIMIT 1000`)), [] as any[]);
  const [ciRows, coRows] = await Promise.all([bookingsIn("checkIn"), bookingsIn("checkOut")]);
  const toBooking = (r: any): DraftBookingRow => ({
    externalId: String(r.externalId), bookingNumber: r.bookingNumber ?? null, time: tsHHMM(r.t),
    clientName: fullName(r.clientFirstName, r.clientLastName), plate: r.licensePlate ?? null,
    flight: r.flight ?? null, remainingToPay: numOrNull(r.remainingToPay), spotType: r.spotType ?? null, deliveryType: r.deliveryType ?? null,
  });

  // Entregas pendentes: PENDING_CHECKOUT sem CHECK_OUT posterior (últimas 24h do turno)
  const pendingSince = new Date(win.startMs - 12 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
  const pending = await safe("pending deliveries", async () => rowsOf(await db.execute(sql`
    SELECT h.bookingExternalId AS externalId, UNIX_TIMESTAMP(MIN(h.actionTime)) AS t,
      b.bookingNumber, b.licensePlate, b.clientFirstName, b.clientLastName
    FROM multipark_booking_history h
    JOIN multipark_bookings b ON b.externalId = h.bookingExternalId
    WHERE h.changeType = 'PENDING_CHECKOUT' AND h.actionTime >= ${pendingSince} AND h.actionTime < ${upTo}
      AND (b.status IS NULL OR b.status <> 'CANCELLED')
      AND ${inCity(sql`b.projectId`)}
      AND NOT EXISTS (SELECT 1 FROM multipark_booking_history c
        WHERE c.bookingExternalId = h.bookingExternalId AND c.changeType = 'CHECK_OUT' AND c.actionTime >= h.actionTime)
    GROUP BY h.bookingExternalId, b.bookingNumber, b.licensePlate, b.clientFirstName, b.clientLastName
    ORDER BY t LIMIT 200`)), [] as any[]);

  // Carros p/ coberto: reservas de lugar coberto ainda no parque (CHECKED_IN,
  // recebidas nos últimos 60 dias) — o filtro "sem movimento depois do
  // check-in" é o helper puro `coveredCarsPending`.
  const coveredSince = new Date(nowMs - 60 * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  const coveredRows = await safe("covered cars", async () => rowsOf(await db.execute(sql`
    SELECT b.externalId, b.bookingNumber, b.licensePlate, b.parkName, b.status, b.spotType, b.parkingType,
      UNIX_TIMESTAMP(COALESCE(
        (SELECT MAX(h.actionTime) FROM multipark_booking_history h WHERE h.bookingExternalId = b.externalId AND h.changeType IN ('CHECK_IN', 'CHECKIN')),
        b.checkIn)) AS ciT,
      UNIX_TIMESTAMP((SELECT MAX(m.actionTime) FROM multipark_booking_history m WHERE m.bookingExternalId = b.externalId AND m.changeType IN ('MOVEMENT', 'MOVE'))) AS mvT
    FROM multipark_bookings b
    WHERE UPPER(b.status) = 'CHECKED_IN'
      AND (b.spotType = 'covered' OR UPPER(b.parkingType) = 'COVERED')
      AND b.checkIn >= ${coveredSince}
      AND ${inCity(sql`b.projectId`)}
    ORDER BY b.checkIn LIMIT 500`)), [] as any[]);
  const coveredPending = coveredCarsPending(coveredRows.map((r): CoveredCarCandidate => ({
    externalId: String(r.externalId), bookingNumber: r.bookingNumber ?? null, plate: r.licensePlate ?? null, parkName: r.parkName ?? null,
    status: r.status ?? null, spotType: r.spotType ?? null, parkingType: r.parkingType ?? null,
    checkInMs: r.ciT == null ? null : num(r.ciT) * 1000, lastMoveMs: r.mvT == null ? null : num(r.mvT) * 1000,
  })), nowMs);

  // Reclamações novas no turno + abertas
  const complaintsRows = await safe("complaints", async () => rowsOf(await db.execute(sql`
    SELECT id, title, complaint_status AS status, complaint_priority AS priority, UNIX_TIMESTAMP(createdAt) AS t,
      (createdAt >= ${win.start} AND createdAt < ${win.end}) AS isNew
    FROM complaints
    WHERE ${inCity(sql`complaints.projectId`)}
      AND (complaint_status IN ('new', 'analyzing', 'waiting_client') OR (createdAt >= ${win.start} AND createdAt < ${win.end}))
    ORDER BY createdAt DESC LIMIT 300`)), [] as any[]);

  const lostRows = await safe("lost&found", async () => rowsOf(await db.execute(sql`
    SELECT id, clientName, description, status FROM lost_found_items
    WHERE status IN ('new', 'investigating', 'found') AND ${inCity(sql`lost_found_items.projectId`)}
    ORDER BY createdAt DESC LIMIT 200`)), [] as any[]);

  const incidentRows = await safe("incidents", async () => rowsOf(await db.execute(sql`
    SELECT id, incidentType, severity, description, vehiclePlate FROM incidents
    WHERE status IN ('open', 'investigating') AND ${inCity(sql`incidents.projectId`)}
    ORDER BY createdAt DESC LIMIT 200`)), [] as any[]);

  // PDAs ainda com check-in (pessoa da cidade)
  const pdaRows = await safe("pdas", async () => rowsOf(await db.execute(sql`
    SELECT pc.id, p.name AS pdaName, e.fullName AS employeeName, UNIX_TIMESTAMP(pc.checkinAt) AS t
    FROM pda_checkins pc
    LEFT JOIN pdas p ON p.id = pc.pdaId
    LEFT JOIN employees e ON e.id = pc.employeeId
    WHERE pc.checkin_status = 'checked_in' AND ${pdaScope(sql`pc.pdaId`)}
      AND pc.employeeId IS NOT NULL AND ${empInCity(sql`pc.employeeId`)}
    ORDER BY pc.checkinAt LIMIT 200`)), [] as any[]);

  // Picagens de entrada sem saída (última picagem das últimas 20h é entrada)
  const clockSince = new Date(nowMs - 20 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
  const clockRows = await safe("time_records", async () => rowsOf(await db.execute(sql`
    SELECT tr.employeeId, e.fullName AS name, UNIX_TIMESTAMP(tr.recordedAt) AS t
    FROM time_records tr
    JOIN employees e ON e.id = tr.employeeId
    WHERE tr.type = 'check_in' AND tr.recordedAt >= ${clockSince} AND ${empInCity(sql`tr.employeeId`)}
      AND NOT EXISTS (SELECT 1 FROM time_records t2 WHERE t2.employeeId = tr.employeeId
        AND t2.recordedAt >= tr.recordedAt AND t2.id <> tr.id)
    ORDER BY tr.recordedAt LIMIT 200`)), [] as any[]);

  // Velocidade e GPS no turno
  const speedRows = await safe("speed", async () => rowsOf(await db.execute(sql`
    SELECT COALESCE(sv.displayName, sv.zelloUsername) AS name, sv.speed, sv.speedLimit, UNIX_TIMESTAMP(sv.occurredAt) AS t
    FROM speed_violations sv
    WHERE sv.occurredAt >= ${win.start} AND sv.occurredAt < ${win.end}
      AND EXISTS (SELECT 1 FROM employees ho_z WHERE ho_z.zelloUsername = sv.zelloUsername
        AND ${inIds(sql`ho_z.projectId`, cityIds)} AND ${employeeScope(sql`ho_z.id`)})
    ORDER BY sv.occurredAt DESC LIMIT 200`)), [] as any[]);
  const gpsRows = await safe("gps", async () => rowsOf(await db.execute(sql`
    SELECT COALESCE(g.displayName, g.zelloUsername) AS name, g.alertType, UNIX_TIMESTAMP(g.occurredAt) AS t
    FROM gps_alerts g
    WHERE g.occurredAt >= ${win.start} AND g.occurredAt < ${win.end}
      AND ((g.employeeId IS NOT NULL AND ${empInCity(sql`g.employeeId`)})
        OR (g.employeeId IS NULL AND EXISTS (SELECT 1 FROM employees ho_z WHERE ho_z.zelloUsername = g.zelloUsername
          AND ${inIds(sql`ho_z.projectId`, cityIds)} AND ${employeeScope(sql`ho_z.id`)})))
    ORDER BY g.occurredAt DESC LIMIT 200`)), [] as any[]);

  // WhatsApp por ler (conversas visíveis ao utilizador; das pessoas da cidade ou sem ficha)
  const whatsapp = await safe("whatsapp", async () => {
    const { listConversations } = await import("./whatsappInbox");
    const convs = (await listConversations()).filter((c) => c.unreadCount > 0);
    const empIds = [...new Set(convs.map((c) => c.employeeId).filter((x): x is number => x != null))];
    const empCity = new Set<number>();
    if (empIds.length) {
      for (const r of rowsOf(await db.execute(sql`SELECT id FROM employees WHERE ${inIds(sql`id`, empIds)} AND ${inIds(sql`projectId`, cityIds)}`))) empCity.add(Number(r.id));
    }
    return convs.filter((c) => c.employeeId == null || empCity.has(c.employeeId)).map((c) => ({ id: c.id, name: c.name, unreadCount: c.unreadCount }));
  }, [] as HandoverDraft["whatsapp"]);

  // Escala: turno atual e seguinte (com team leader)
  const people = await safe("assignments", async () => {
    const rows = rowsOf(await db.execute(sql`
      SELECT assignmentDate, shift, personName, employeeId, isTeamLeader, startHour, endHour FROM extras_dia_assignments
      WHERE city = ${key.city} AND ((assignmentDate = ${cur.date} AND shift = ${cur.shift}) OR (assignmentDate = ${next.date} AND shift = ${next.shift}))
      ORDER BY isTeamLeader DESC, startHour, personName`));
    const map = (r: any): DraftPerson => ({ name: r.personName, employeeId: r.employeeId == null ? null : Number(r.employeeId), isTeamLeader: Number(r.isTeamLeader) === 1, startHour: num(r.startHour), endHour: num(r.endHour) });
    return {
      current: rows.filter((r) => r.assignmentDate === cur.date && r.shift === cur.shift).map(map),
      next: rows.filter((r) => r.assignmentDate === next.date && r.shift === next.shift).map(map),
    };
  }, { current: [] as DraftPerson[], next: [] as DraftPerson[] });

  // Passagem anterior (pendentes por resolver)
  const prevRef = previousShiftOf(cur);
  const previous = await safe("previous", async () => {
    const r = rowsOf(await db.execute(buildHandoverCurrent({ handoverDate: prevRef.date, shift: prevRef.shift, city: key.city })))[0];
    if (!r) return null;
    const items = parseOpenItems(r.openItems);
    const notesItems = items.length ? [] : extractNoteItems(r.notes, `${prevRef.date} ${prevRef.shift}`);
    return {
      id: Number(r.id), date: prevRef.date, shift: prevRef.shift,
      authorName: r.createdByName ?? r.filledByName ?? null, createdById: r.createdById == null ? null : Number(r.createdById),
      notes: r.notes ?? null, aiSummary: r.aiSummary ?? null, ackByName: r.ackByName ?? null, acked: r.ackAt != null,
      openItems: [...items, ...notesItems].filter((i) => !i.resolved),
    };
  }, null as HandoverDraft["previous"]);

  const checkins = ciRows.map(toBooking);
  const checkouts = coRows.map(toBooking);
  const complaints = complaintsRows.map((r) => ({
    id: Number(r.id), title: String(r.title ?? ""), status: String(r.status), priority: String(r.priority),
    createdAt: tsHHMM(r.t), isNew: Number(r.isNew) === 1,
  }));
  const openComplaints = complaints.filter((c) => ["new", "analyzing", "waiting_client"].includes(c.status));
  const lostFound = lostRows.map((r) => ({ id: Number(r.id), clientName: String(r.clientName ?? ""), description: String(r.description ?? ""), status: String(r.status) }));
  const incidents = incidentRows.map((r) => ({ id: Number(r.id), type: String(r.incidentType), severity: String(r.severity), description: String(r.description ?? ""), plate: r.vehiclePlate ?? null }));
  const pdas = pdaRows.map((r) => ({ id: Number(r.id), pdaName: r.pdaName ?? null, employeeName: r.employeeName ?? null, since: tsHHMM(r.t) }));
  const pendingDeliveries = pending.map((r) => ({
    externalId: String(r.externalId), bookingNumber: r.bookingNumber ?? null, plate: r.licensePlate ?? null,
    clientName: fullName(r.clientFirstName, r.clientLastName), since: tsHHMM(r.t),
  }));

  const counts: HandoverDraftCounts = {
    checkinsNext: checkins.length,
    checkoutsNext: checkouts.length,
    pendingDeliveries: pendingDeliveries.length,
    complaintsNew: complaints.filter((c) => c.isNew).length,
    complaintsOpen: openComplaints.length,
    lostFoundOpen: lostFound.length,
    incidentsOpen: incidents.length,
    whatsappUnread: whatsapp.reduce((s, c) => s + c.unreadCount, 0),
    pdasCheckedIn: pdas.length,
    clockInsOpen: clockRows.length,
    speedAlerts: speedRows.length,
    gpsAlerts: gpsRows.length,
    toCollectEur: Math.round(checkouts.reduce((s, b) => s + Math.max(0, b.remainingToPay ?? 0), 0) * 100) / 100,
  };

  const since = `${cur.date} ${cur.shift}`;
  const draftItems = draftOpenItems({ complaints: openComplaints, lostFound, pdas, incidents, pendingDeliveries }, since);
  const carryOver = mergeCarryOver({ previous: previous?.openItems ?? [], draft: draftItems, nowIso: new Date(nowMs).toISOString() });

  return {
    key,
    next,
    window: { start: win.start, end: win.end },
    nextWindow: { start: nwin.start, end: nwin.end },
    generatedAt: new Date(nowMs).toISOString(),
    counts,
    byHour: bucketByHour(next, ciRows.map((r) => num(r.t) * 1000), coRows.map((r) => num(r.t) * 1000)),
    checkins: checkins.slice(0, LIST_LIMIT),
    checkouts: checkouts.slice(0, LIST_LIMIT),
    coveredCheckinsNext: checkins.filter((b) => b.spotType === "covered").length,
    coveredCars: {
      count: coveredPending.length,
      list: coveredPending.slice(0, LIST_LIMIT).map((b) => ({
        externalId: b.externalId, bookingNumber: b.bookingNumber, plate: b.plate, park: b.parkName,
        checkIn: b.checkInMs == null ? "" : `${new Date(b.checkInMs).toLocaleDateString("pt-PT", { timeZone: "Europe/Lisbon", day: "2-digit", month: "2-digit" })} ${lisbonHHMM(b.checkInMs)}`,
      })),
    },
    pendingDeliveries: pendingDeliveries.slice(0, LIST_LIMIT),
    complaints: complaints.slice(0, LIST_LIMIT),
    lostFound: lostFound.slice(0, LIST_LIMIT),
    incidents: incidents.slice(0, LIST_LIMIT),
    whatsapp: whatsapp.slice(0, LIST_LIMIT),
    pdas: pdas.slice(0, LIST_LIMIT),
    clockIns: clockRows.slice(0, LIST_LIMIT).map((r) => ({ employeeId: Number(r.employeeId), name: String(r.name ?? ""), since: tsHHMM(r.t) })),
    speed: speedRows.slice(0, LIST_LIMIT).map((r) => ({ name: String(r.name ?? ""), speed: Math.round(num(r.speed)), limit: num(r.speedLimit), at: tsHHMM(r.t) })),
    gps: gpsRows.slice(0, LIST_LIMIT).map((r) => ({ name: String(r.name ?? ""), type: String(r.alertType), at: tsHHMM(r.t) })),
    people,
    previous,
    carryOver,
  };
}

/** Fotografia compacta para guardar com a passagem (`autoSummary`). */
export function draftSnapshot(d: HandoverDraft): string {
  return JSON.stringify({
    generatedAt: d.generatedAt,
    next: d.next,
    counts: d.counts,
    byHour: d.byHour,
    coveredCheckinsNext: d.coveredCheckinsNext,
    coveredCars: d.coveredCars?.count ?? 0,
    people: d.people,
    checkouts: d.checkouts.slice(0, 40),
    pendingDeliveries: d.pendingDeliveries.slice(0, 40),
    complaints: d.complaints.slice(0, 40),
    lostFound: d.lostFound.slice(0, 40),
    pdas: d.pdas.slice(0, 40),
    clockIns: d.clockIns.slice(0, 40),
  });
}
