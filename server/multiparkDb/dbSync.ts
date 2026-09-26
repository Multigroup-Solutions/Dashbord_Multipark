/**
 * multipark-db-sync — sync incremental a partir da BD da Multipark (só
 * corre com o interruptor MULTIPARK_SOURCE = BD; ver ./source.ts).
 *
 * Porque continuamos a GRAVAR em multipark_bookings (espelho local) em vez de
 * ler a BD deles em cada página: todo o dashboard (finanças, avaliação,
 * operações, parcerias, marketing) faz JOINs com tabelas nossas (projetos,
 * parceiros, fichas, despesas…) e precisa de colunas só nossas (projectId,
 * campanha resolvida, atribuição Ads, estado de enriquecimento). Ler ao vivo
 * seria mais lento, poria carga na BD de produção da Multipark em cada
 * clique e deixava o dashboard em baixo quando a BD deles estivesse em baixo.
 * Ver docs/multipark-db/README.md.
 *
 * Fluxos (cada um com o seu cursor em multipark_db_cursors):
 *   - bookings: reservas alteradas desde o cursor (updatedAt, id) →
 *     bookingToRecord + upsert + extras + detalhe (mesmo código da API);
 *   - movements: movimentos desde o cursor → multipark_booking_history +
 *     resumo na reserva (agente do check-in/out, garagem, lugar, km) +
 *     anexar agentes às fichas por email;
 *   - drivers (de hora a hora): condutores → multipark_agents + anexar por email;
 *   - partners (de hora a hora): descoberta de parceiros (como o multipark-sync).
 *
 * Retomável dentro do orçamento do tick: grava o cursor depois de cada
 * página; se ainda houver páginas, devolve done:false e o agendador volta a
 * chamar no tick seguinte.
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { multiparkBookingHistory, multiparkBookings } from "../../drizzle/schema";
import { MULTIPARK_DB_MAPPED } from "./queries";
import { withSyncLock } from "../syncLock";
import { initialCursor, type MultiparkSource, type SourceCursor, type SourceDriver, type SourceMovement } from "./source";

export type DbStream = "bookings" | "movements" | "drivers" | "partners";

export const BOOKINGS_PAGE = 200;
export const MOVEMENTS_PAGE = 500;
/** Condutores e parceiros: no máximo de hora a hora. */
export const HOURLY_MS = 60 * 60_000;
/** Não arranca uma página nova com menos do que isto até ao prazo. */
export const PAGE_MARGIN_MS = 10_000;
/** Primeira corrida (sem cursor): quantos dias para trás. */
export const initialDays = () => Math.max(0, Math.min(365, Number(process.env.MULTIPARK_DB_INITIAL_DAYS || 3)));

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const nowMysql = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const errText = (err: unknown) => String((err as any)?.message ?? err).slice(0, 300);

// ─── Resumo dos movimentos (PURA; mesma regra do syncBookingHistory) ────────

export interface MovementSummary {
  checkinAgentName?: string;
  checkinAgentUserId?: string;
  checkoutAgentName?: string;
  checkoutAgentUserId?: string;
  currentGarage?: string;
  currentSpot?: string;
  lastKnownMileage?: number;
}

/**
 * Por ordem de actionTime (e id), o último CHECK_IN/CHECK_OUT dá o agente e
 * os modifiedFields dão garagem/lugar/km — igual a syncBookingHistory em
 * server/jobs/multiparkBookingSync.ts. Só devolve o que apareceu. PURA.
 */
export function summarizeMovements(movements: SourceMovement[]): MovementSummary {
  const sorted = [...movements].sort((a, b) => (a.actionTime ?? "").localeCompare(b.actionTime ?? "") || a.id.localeCompare(b.id));
  const out: MovementSummary = {};
  for (const m of sorted) {
    if (m.changeType === "CHECK_IN") {
      if (m.agentName) out.checkinAgentName = m.agentName;
      if (m.agentUserId) out.checkinAgentUserId = m.agentUserId;
    } else if (m.changeType === "CHECK_OUT") {
      if (m.agentName) out.checkoutAgentName = m.agentName;
      if (m.agentUserId) out.checkoutAgentUserId = m.agentUserId;
    }
    if (m.modifiedFields) {
      try {
        const mf = JSON.parse(m.modifiedFields);
        if (mf.garagem) out.currentGarage = String(mf.garagem).slice(0, 64);
        if (mf.lugar) out.currentSpot = String(mf.lugar).slice(0, 64);
        if (mf.km !== undefined) {
          const km = parseInt(String(mf.km), 10);
          if (Number.isFinite(km)) out.lastKnownMileage = km;
        }
      } catch { /* modifiedFields que não é JSON: ignora (como na API) */ }
    }
  }
  return out;
}

// ─── Cursores (multipark_db_cursors, migração 0205) ─────────────────────────

interface CursorState { cursor: SourceCursor | null; lastRunAt: string | null }

async function loadCursor(stream: DbStream): Promise<CursorState> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const r = rowsOf(await db.execute(sql`SELECT cursorAt, cursorId, DATE_FORMAT(lastRunAt, '%Y-%m-%d %H:%i:%s') AS lastRunAt
    FROM multipark_db_cursors WHERE stream = ${stream} LIMIT 1`))[0];
  return {
    cursor: r?.cursorAt ? { at: String(r.cursorAt), id: String(r.cursorId ?? "") } : null,
    lastRunAt: r?.lastRunAt ? String(r.lastRunAt) : null,
  };
}

async function saveCursor(stream: DbStream, o: { cursor?: SourceCursor | null; rows?: number; status: "ok" | "partial" | "error"; error?: string | null }): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const now = nowMysql();
  const at = o.cursor ? o.cursor.at.slice(0, 40) : null;
  const id = o.cursor ? o.cursor.id.slice(0, 128) : null;
  const err = o.error ? o.error.slice(0, 500) : null;
  const ok = o.status === "error" ? null : now;
  await db.execute(sql`INSERT INTO multipark_db_cursors (stream, cursorAt, cursorId, lastRunAt, lastOkAt, lastStatus, lastError, rowsTotal)
    VALUES (${stream}, ${at}, ${id}, ${now}, ${ok}, ${o.status}, ${err}, ${o.rows ?? 0})
    ON DUPLICATE KEY UPDATE
      cursorAt = COALESCE(VALUES(cursorAt), cursorAt), cursorId = IF(VALUES(cursorAt) IS NULL, cursorId, VALUES(cursorId)),
      lastRunAt = VALUES(lastRunAt), lastOkAt = COALESCE(VALUES(lastOkAt), lastOkAt),
      lastStatus = VALUES(lastStatus), lastError = VALUES(lastError), rowsTotal = rowsTotal + VALUES(rowsTotal)`);
}

const dueHourly = (lastRunAt: string | null, now: number) => !lastRunAt || now - Date.parse(`${lastRunAt.replace(" ", "T")}Z`) >= HOURLY_MS;

// ─── Gravação ───────────────────────────────────────────────────────────────

async function persistMovements(movements: SourceMovement[]): Promise<{ saved: number; errors: string[] }> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const errors: string[] = [];
  let saved = 0;
  const byBooking = new Map<string, SourceMovement[]>();
  for (const m of movements) {
    try {
      const values = {
        bookingExternalId: m.bookingId,
        historyId: m.id,
        changeType: m.changeType,
        actionTime: m.actionTime,
        remarks: m.remarks,
        agentName: m.agentName,
        agentUserId: m.agentUserId,
        agentEmail: m.agentEmail,
        modifiedFields: m.modifiedFields,
        platform: m.platform,
      };
      await db.insert(multiparkBookingHistory).values(values).onDuplicateKeyUpdate({ set: values });
      saved++;
      const list = byBooking.get(m.bookingId) ?? [];
      list.push(m);
      byBooking.set(m.bookingId, list);
    } catch (err) {
      errors.push(`Movimento ${m.id}: ${errText(err)}`);
    }
  }
  for (const [bookingId, list] of Array.from(byBooking.entries())) {
    const summary = summarizeMovements(list);
    if (!Object.keys(summary).length) continue;
    try {
      await db.update(multiparkBookings).set(summary).where(eq(multiparkBookings.externalId, bookingId));
    } catch (err) {
      errors.push(`Resumo ${bookingId}: ${errText(err)}`);
    }
  }
  const seen = movements.filter((m) => m.agentUserId).map((m) => ({ agentUserId: m.agentUserId!, agentName: m.agentName, agentEmail: m.agentEmail }));
  if (seen.length) {
    try {
      const { autoAttachAgentsByEmail } = await import("../identityReconcile");
      await autoAttachAgentsByEmail(db, seen);
    } catch { /* melhor esforço, como no histórico pela API */ }
  }
  return { saved, errors };
}

async function persistDrivers(drivers: SourceDriver[]): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  let saved = 0;
  for (const d of drivers) {
    await db.execute(sql`INSERT INTO multipark_agents (agentUserId, agentName, email, role, active, parkId, city, sourceUpdatedAt)
      VALUES (${d.id}, ${d.name}, ${d.email}, ${d.role}, ${d.active ? 1 : 0}, ${d.parkId}, ${d.city}, ${d.updatedAt})
      ON DUPLICATE KEY UPDATE agentName = VALUES(agentName), email = VALUES(email), role = VALUES(role), active = VALUES(active),
        parkId = VALUES(parkId), city = VALUES(city), sourceUpdatedAt = VALUES(sourceUpdatedAt)`);
    saved++;
  }
  try {
    const { autoAttachAgentsByEmail } = await import("../identityReconcile");
    await autoAttachAgentsByEmail(db, drivers.filter((d) => d.active).map((d) => ({ agentUserId: d.id, agentName: d.name, agentEmail: d.email })));
  } catch { /* melhor esforço */ }
  return saved;
}

// ─── Corrida ────────────────────────────────────────────────────────────────

export interface StreamReport { read: number; saved: number; errors: number; done: boolean; error?: string | null }

export interface DbSyncResult {
  busy?: boolean;
  done: boolean;
  bookings: StreamReport & { created: number };
  movements: StreamReport;
  drivers: StreamReport | null;
  partners: Record<string, unknown> | null;
  /** Falhas de um fluxo inteiro (ex.: "por mapear", BD indisponível). */
  streamErrors: string[];
  /** Falhas de itens (a corrida avança; ficam registadas). */
  itemErrors: string[];
  durationMs: number;
}

const emptyStream = (): StreamReport => ({ read: 0, saved: 0, errors: 0, done: false });

/** Com o trinco da sincronização Multipark (mesmo do multipark-sync). */
export async function runMultiparkDbSync(o: { deadlineAt: number; source?: MultiparkSource }): Promise<DbSyncResult> {
  const t0 = Date.now();
  const locked = await withSyncLock("cron_db", () => runUnlocked(o, t0));
  if (locked.busy) {
    return { busy: true, done: true, bookings: { ...emptyStream(), created: 0 }, movements: emptyStream(), drivers: null, partners: null, streamErrors: [], itemErrors: [], durationMs: Date.now() - t0 };
  }
  return locked.value;
}

async function runUnlocked(o: { deadlineAt: number; source?: MultiparkSource }, t0: number): Promise<DbSyncResult> {
  const source = o.source ?? (await import("./source")).createDbSource();
  const hasTime = () => Date.now() < o.deadlineAt - PAGE_MARGIN_MS;
  const streamErrors: string[] = [];
  const itemErrors: string[] = [];

  // 1) Reservas.
  const bookings = { ...emptyStream(), created: 0 };
  try {
    const { saveBookingFromSource } = await import("../jobs/multiparkBookingSync");
    let cursor = (await loadCursor("bookings")).cursor ?? initialCursor(Date.now(), initialDays());
    while (hasTime()) {
      const page = await source.listBookingsChangedSince(cursor, BOOKINGS_PAGE);
      bookings.read += page.items.length;
      let saved = 0;
      for (const b of page.items) {
        try {
          const r = await saveBookingFromSource(b);
          saved++;
          if (r.action === "created") bookings.created++;
        } catch (err) {
          bookings.errors++;
          itemErrors.push(`Reserva ${b.id}: ${errText(err)}`);
        }
      }
      bookings.saved += saved;
      if (page.next) cursor = page.next;
      await saveCursor("bookings", { cursor: page.next, rows: saved, status: page.more ? "partial" : "ok" });
      if (!page.more) { bookings.done = true; break; }
    }
  } catch (err) {
    bookings.error = errText(err);
    streamErrors.push(`reservas: ${bookings.error}`);
    try { await saveCursor("bookings", { status: "error", error: bookings.error }); } catch { /* registo */ }
  }

  // 2) Movimentos (check-in/out, lugar, km — com quem e quando).
  const movements = emptyStream();
  try {
    let cursor = (await loadCursor("movements")).cursor ?? initialCursor(Date.now(), initialDays());
    while (hasTime()) {
      const page = await source.listMovements(cursor, MOVEMENTS_PAGE);
      movements.read += page.items.length;
      const r = await persistMovements(page.items);
      movements.saved += r.saved;
      movements.errors += r.errors.length;
      itemErrors.push(...r.errors);
      if (page.next) cursor = page.next;
      await saveCursor("movements", { cursor: page.next, rows: r.saved, status: page.more ? "partial" : "ok" });
      if (!page.more) { movements.done = true; break; }
    }
  } catch (err) {
    movements.error = errText(err);
    streamErrors.push(`movimentos: ${movements.error}`);
    try { await saveCursor("movements", { status: "error", error: movements.error }); } catch { /* registo */ }
  }

  // 3) Condutores (de hora a hora).
  let drivers: StreamReport | null = null;
  try {
    // Condutores são opcionais: por mapear → não corre (sem erro).
    if (MULTIPARK_DB_MAPPED.drivers && hasTime() && dueHourly((await loadCursor("drivers")).lastRunAt, Date.now())) {
      drivers = emptyStream();
      const list = await source.listDrivers();
      drivers.read = list.length;
      drivers.saved = await persistDrivers(list);
      drivers.done = true;
      await saveCursor("drivers", { rows: drivers.saved, status: "ok" });
    }
  } catch (err) {
    drivers = { ...(drivers ?? emptyStream()), error: errText(err) };
    streamErrors.push(`condutores: ${drivers.error}`);
    try { await saveCursor("drivers", { status: "error", error: drivers.error }); } catch { /* registo */ }
  }

  // 4) Descoberta de parceiros (de hora a hora; era feita pelo multipark-sync).
  let partners: Record<string, unknown> | null = null;
  try {
    if (hasTime() && dueHourly((await loadCursor("partners")).lastRunAt, Date.now())) {
      const { syncPartnersFromApi } = await import("../partnerSync");
      const r = await syncPartnersFromApi({ maxLookups: 5 });
      partners = { created: r.created, linkedToExisting: r.linkedToExisting, proCreated: r.proCreated, unresolved: r.unresolved.length };
      await saveCursor("partners", { status: "ok" });
    }
  } catch (err) {
    partners = { error: errText(err) };
    try { await saveCursor("partners", { status: "error", error: errText(err) }); } catch { /* registo */ }
  }

  return {
    done: bookings.done && movements.done,
    bookings,
    movements,
    drivers,
    partners,
    streamErrors,
    itemErrors: itemErrors.slice(0, 50),
    durationMs: Date.now() - t0,
  };
}
