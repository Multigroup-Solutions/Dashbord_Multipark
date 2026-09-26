/**
 * Fonte das reservas/movimentos/condutores da Multipark: a API (hoje) ou a
 * BD da aplicação Multipark (DATABASE_URL_MULTIPARK, só leitura).
 *
 * O interruptor MULTIPARK_SOURCE (Definições → Automações, só super_admin;
 * ou env MULTIPARK_SOURCE=api|db) escolhe qual. Omissão: "api" — e com "api"
 * NADA muda: os trabalhos de sempre (multipark-sync, multipark-future,
 * reconciliação no daily-ops) correm exatamente como antes e o novo
 * multipark-db-sync nem entra no plano do agendador.
 *
 * Com "db" (e a BD pronta: env + consultas mapeadas — senão continua a API):
 * o multipark-db-sync (de 5 em 5 min, incremental por cursor) substitui
 * multipark-sync + multipark-future + reconciliação. A fila do webhook
 * (multipark-deliveries) continua até o Jorge a desligar.
 *
 * O ApiSource é um adaptador sobre o código da API que já existe — os
 * trabalhos atuais NÃO passam por ele (continuam a chamar a API diretamente,
 * sem alterações); serve para comparar a API com a BD durante a transição
 * (mesma interface). A API não tem "alterações desde X" nem lista de
 * condutores: esses métodos lançam MultiparkSourceUnsupportedError.
 */
import type { BookingActionType, BookingHistoryEntry, MultiparkBooking } from "../multipark";
import type { MultiparkDbClient } from "./client";
import { parseBookingDate } from "../bookingRefresh";
import { ensureFeatureFlagOverrides, isFeatureEnabled, resolveFeatureFlag } from "../_core/featureFlags";
import { normalizeFlagEnv } from "../../shared/appSettings";
import {
  BOOKING_QUERY, MOVEMENT_QUERY, MULTIPARK_DB_MAPPED,
  bookingsByPeriodSql, byColumnSql, byIdSql, changedSinceSql, driversSql,
  mapBookingRow, mapDriverRow, mapMovementRow, toMysqlUtc,
  type BookingRow, type DriverRow, type MappedEntity, type MovementRow,
  type SourceCursor, type SourceDriver, type SourceMovement,
} from "./queries";

export type { SourceCursor, SourceDriver, SourceMovement } from "./queries";

export type MultiparkSourceKind = "api" | "db";

/** Nome do interruptor (catálogo em shared/appSettings.ts). */
export const MULTIPARK_SOURCE_FLAG = "MULTIPARK_SOURCE";

export interface SourcePage<T> {
  items: T[];
  /** Cursor do último item (para o pedido seguinte); null se a página veio vazia. */
  next: SourceCursor | null;
  /** Veio uma página cheia → há (provavelmente) mais. */
  more: boolean;
}

export interface BookingHint { parkId?: string | null; parkName?: string | null; city?: string | null }

/** O que o dashboard precisa da Multipark (derivado do multiparkBookingSync). */
export interface MultiparkSource {
  kind: MultiparkSourceKind;
  /** Reservas criadas/alteradas depois do cursor (incremental). */
  listBookingsChangedSince(since: SourceCursor, limit: number): Promise<SourcePage<MultiparkBooking>>;
  /** Reservas com a ação (criação, check-in, check-out, cancelamento) em [from, to] (dias). */
  listBookingsByPeriod(from: string, to: string, action: BookingActionType): Promise<MultiparkBooking[]>;
  /** Detalhe de uma reserva (formato /bookings/:id). */
  getBooking(id: string, hint?: BookingHint): Promise<MultiparkBooking | null>;
  /** Movimentos (check-in/out, lugar, km…) com quem e quando, depois do cursor. */
  listMovements(since: SourceCursor, limit: number): Promise<SourcePage<SourceMovement>>;
  /** Todos os movimentos de uma reserva (/bookings/:id/history). */
  listBookingMovements(bookingId: string, hint?: BookingHint): Promise<SourceMovement[]>;
  /** Condutores/agentes da app Multipark. */
  listDrivers(): Promise<SourceDriver[]>;
}

export class MultiparkSourceUnsupportedError extends Error {
  code = "SOURCE_UNSUPPORTED" as const;
  constructor(message: string) { super(message); this.name = "MultiparkSourceUnsupportedError"; }
}

export class MultiparkDbNotMappedError extends Error {
  code = "DB_NOT_MAPPED" as const;
  constructor(entity: MappedEntity) {
    super(`BD Multipark: "${entity}" ainda está por mapear — preencher server/multiparkDb/queries.ts (ver docs/multipark-db/README.md).`);
    this.name = "MultiparkDbNotMappedError";
  }
}

// ─── Escolha da fonte ───────────────────────────────────────────────────────

/**
 * Fonte a partir da env MULTIPARK_SOURCE ("db"/"api" ou on/off) e da
 * sobreposição das Definições. PURA. Precedência igual à dos outros
 * interruptores: Definições → env → omissão ("api").
 */
export function resolveMultiparkSource(envRaw: string | null | undefined, override: boolean | null | undefined): MultiparkSourceKind {
  return resolveFeatureFlag(normalizeFlagEnv(MULTIPARK_SOURCE_FLAG, envRaw), override, false) ? "db" : "api";
}

/**
 * A BD está pronta para ser a fonte? Precisa da env DATABASE_URL_MULTIPARK e
 * do mapeamento das reservas e dos movimentos (queries.ts). PURA.
 */
export function dbSourceReadiness(env: Record<string, string | undefined>, mapped: { bookings: boolean; movements: boolean } = MULTIPARK_DB_MAPPED): string | null {
  if (!String(env.DATABASE_URL_MULTIPARK ?? "").trim()) return "DATABASE_URL_MULTIPARK não está definida";
  if (!mapped.bookings || !mapped.movements) return "consultas da BD Multipark por mapear (server/multiparkDb/queries.ts)";
  return null;
}

/**
 * Fonte pedida (interruptor) e fonte EFETIVA: pedir "db" sem a BD pronta
 * (sem env ou por mapear) fica na API — ligar o interruptor cedo demais
 * nunca desliga o multipark-sync sem ter o substituto a funcionar. PURA.
 */
export function effectiveMultiparkSource(requested: MultiparkSourceKind, notReady: string | null): { source: MultiparkSourceKind; reason: string | null } {
  if (requested === "db" && notReady) return { source: "api", reason: `pedida a BD, mas ${notReady} — continua a API` };
  return { source: requested, reason: null };
}

/** Fonte pedida no interruptor (Definições → env → "api"). Nunca lança; em dúvida, "api". */
export async function requestedMultiparkSource(env: Record<string, string | undefined> = process.env): Promise<MultiparkSourceKind> {
  try {
    await ensureFeatureFlagOverrides();
    const envRaw = normalizeFlagEnv(MULTIPARK_SOURCE_FLAG, env[MULTIPARK_SOURCE_FLAG]);
    return isFeatureEnabled(MULTIPARK_SOURCE_FLAG, { defaultEnabled: false, env: { [MULTIPARK_SOURCE_FLAG]: envRaw } }) ? "db" : "api";
  } catch {
    return "api";
  }
}

/** Fonte EFETIVA agora (o que os trabalhos usam). Nunca lança; em dúvida, "api". */
export async function getMultiparkSourceKind(env: Record<string, string | undefined> = process.env): Promise<MultiparkSourceKind> {
  return effectiveMultiparkSource(await requestedMultiparkSource(env), dbSourceReadiness(env)).source;
}

// ─── ApiSource (adaptador sobre server/multipark.ts, sem mudar nada) ────────

/** Entrada do /bookings/:id/history → SourceMovement. PURA. */
export function apiHistoryToMovement(bookingId: string, e: BookingHistoryEntry): SourceMovement | null {
  if (!e?.id) return null;
  const mf = (e as any).modifiedFields;
  return {
    id: String(e.id).slice(0, 128),
    bookingId: String(e.booking?.id ?? bookingId).slice(0, 128),
    changeType: e.changeType ? String(e.changeType).slice(0, 32) : null,
    actionTime: typeof e.actionTime === "string" ? parseBookingDate(e.actionTime) : null,
    agentUserId: (e.userId ?? e.user?.id) ? String(e.userId ?? e.user?.id).slice(0, 128) : null,
    agentName: e.agentName ? String(e.agentName).slice(0, 256) : null,
    agentEmail: e.user?.email ? String(e.user.email).toLowerCase().slice(0, 320) : null,
    remarks: e.remarks ?? null,
    modifiedFields: mf == null || mf === "" ? null : typeof mf === "string" ? mf : JSON.stringify(mf),
    platform: e.platform ? String(e.platform).slice(0, 32) : null,
  };
}
export function createApiSource(): MultiparkSource {
  const api = () => import("../multipark");
  const keyFor = async (hint?: BookingHint) => {
    const m = await api();
    const park = hint ? m.matchParkConfig(hint) : undefined;
    return park ? m.getParkApiKey(park) : undefined;
  };
  return {
    kind: "api",
    async listBookingsChangedSince() {
      throw new MultiparkSourceUnsupportedError("A API Multipark não tem \"alterações desde\" — usar listBookingsByPeriod.");
    },
    async listBookingsByPeriod(from, to, action) {
      const m = await api();
      const parks = m.getConfiguredParks();
      const out = new Map<string, MultiparkBooking>();
      for (const park of parks.length ? parks : [null]) {
        const report = await m.getBookingsReport(from, to, action, park ? m.getParkApiKey(park) : undefined);
        for (const b of Array.isArray(report?.bookings) ? report.bookings : []) if (b?.id) out.set(b.id, b);
      }
      return Array.from(out.values());
    },
    async getBooking(id, hint) {
      const m = await api();
      const key = await keyFor(hint);
      if (key) return m.getBooking(id, key, { maxAttempts: 1, timeoutMs: 8000 });
      return (await m.getBookingTryAllParks(id))?.booking ?? null;
    },
    async listMovements() {
      throw new MultiparkSourceUnsupportedError("A API Multipark só dá o histórico por reserva ou por agente — usar listBookingMovements.");
    },
    async listBookingMovements(bookingId, hint) {
      const m = await api();
      const r = await m.getBookingHistory(bookingId, await keyFor(hint), { maxAttempts: 1, timeoutMs: 8000 });
      return (r?.history ?? []).map((e) => apiHistoryToMovement(bookingId, e)).filter((x): x is SourceMovement => !!x);
    },
    async listDrivers() {
      throw new MultiparkSourceUnsupportedError("A API Multipark não tem lista de condutores.");
    },
  };
}

// ─── DbSource (BD da Multipark; consultas em ./queries.ts) ──────────────────

function assertMapped(entity: MappedEntity): void {
  if (!MULTIPARK_DB_MAPPED[entity]) throw new MultiparkDbNotMappedError(entity);
}

function page<T>(rows: Array<{ item: T; cursor: SourceCursor | null }>, limit: number): SourcePage<T> {
  let next: SourceCursor | null = null;
  for (const r of rows) if (r.cursor) next = r.cursor;
  return { items: rows.map((r) => r.item), next, more: rows.length >= limit };
}

/** `client` injetável (testes); omissão = pool de DATABASE_URL_MULTIPARK. */
export function createDbSource(client?: () => Promise<MultiparkDbClient>): MultiparkSource {
  const db = client ?? (async () => (await import("./client")).getMultiparkDb());
  return {
    kind: "db",
    async listBookingsChangedSince(since, limit) {
      assertMapped("bookings");
      const c = await db();
      const q = changedSinceSql(c.engine, BOOKING_QUERY, since, limit);
      const rows = await c.query<BookingRow>(q.sql, q.params);
      return page(rows.map((r) => { const m = mapBookingRow(r); return { item: m.booking, cursor: m.cursor }; }), limit);
    },
    async listBookingsByPeriod(from, to, action) {
      assertMapped("bookings");
      const c = await db();
      const q = bookingsByPeriodSql(c.engine, from, to, action);
      return (await c.query<BookingRow>(q.sql, q.params)).map((r) => mapBookingRow(r).booking);
    },
    async getBooking(id) {
      assertMapped("bookings");
      const c = await db();
      const q = byIdSql(c.engine, BOOKING_QUERY, BOOKING_QUERY.cursorId, id);
      const rows = await c.query<BookingRow>(q.sql, q.params);
      return rows.length === 1 ? mapBookingRow(rows[0]).booking : null;
    },
    async listMovements(since, limit) {
      assertMapped("movements");
      const c = await db();
      const q = changedSinceSql(c.engine, MOVEMENT_QUERY, since, limit);
      const rows = await c.query<MovementRow>(q.sql, q.params);
      return page(rows.map((r) => { const m = mapMovementRow(r); return { item: m.movement, cursor: m.cursor }; }), limit);
    },
    async listBookingMovements(bookingId) {
      assertMapped("movements");
      const c = await db();
      const bookingCol = MOVEMENT_QUERY.columns.booking_id;
      if (!bookingCol) throw new MultiparkDbNotMappedError("movements");
      const q = byColumnSql(c.engine, MOVEMENT_QUERY, bookingCol, bookingId);
      return (await c.query<MovementRow>(q.sql, q.params)).map((r) => mapMovementRow(r).movement);
    },
    async listDrivers() {
      assertMapped("drivers");
      const c = await db();
      const q = driversSql();
      return (await c.query<DriverRow>(q.sql, q.params)).map(mapDriverRow);
    },
  };
}

/** A fonte em vigor (interruptor MULTIPARK_SOURCE). */
export async function getMultiparkSource(): Promise<MultiparkSource> {
  return (await getMultiparkSourceKind()) === "db" ? createDbSource() : createApiSource();
}

/** Cursor inicial: `days` dias antes de `now` (UTC, texto com µs). PURA. */
export function initialCursor(now: number, days: number): SourceCursor {
  return { at: `${toMysqlUtc(new Date(now - days * 86_400_000))}.000000`, id: "" };
}
