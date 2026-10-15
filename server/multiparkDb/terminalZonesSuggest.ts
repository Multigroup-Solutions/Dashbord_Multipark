/**
 * "Sugerir T1/T2" (plano 62, P3b; auditoria dos parâmetros) — SÓ LEITURA.
 *
 * A P0 mostrou que não há zonas T1/T2 em nenhuma cidade (Definições →
 * Parâmetros → Extras-dia → "Aeroportos (terminal no ponto)") e que o centro
 * do aeroporto do Porto está a 1,8 km das assinaturas. As zonas propõem-se a
 * partir das POSIÇÕES DAS ASSINATURAS da app (linhas CHECK_OUT e CHECK_IN da
 * History, com a lat/lng do telemóvel de quem assinou) das últimas 4 semanas,
 * agrupadas pela classe da entrega da reserva (T1/T2, a mesma regra dos
 * tempos: terminalClassOf). Por (cidade, classe): a mediana da latitude e da
 * longitude, e quão juntas estão as assinaturas (p50/p90 da distância).
 *
 * Só os parques que operamos (os outros podem assinar noutro sítio); só as
 * assinaturas a ≤ TERMINAL_SUGGEST_MAX_FROM_AIRPORT_M do centro do aeroporto
 * da cidade (as entregas em hotéis, com outro "tipo de entrega", contam como
 * T1 pela regra das classes). Nada se grava: o super admin vê, carrega em
 * "Usar" e depois em Guardar. Só as medianas saem daqui (nunca as linhas).
 * SQL parametrizado, sem barras invertidas; o agregador é PURO.
 */
import type { SqlParam } from "./client";
import { ParamList } from "./read";
import { classifyPark, marketplaceOperated } from "../../shared/multiparkParks";
import { distanceMeters, type AirportFence } from "../../shared/pontoTerminal";
import { median, TERMINAL_ZONE_RADIUS_HINT_M, type ParkZoneCity } from "../../shared/serviceGps";
import { buildServiceParksSql } from "./serviceRows";
import { terminalClassOf } from "../serviceTimesJob";

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

export const TERMINAL_SUGGEST_DAYS = 28;
export const TERMINAL_SUGGEST_MAX_ROWS = 20_000;
/** Mínimo de assinaturas para propor uma zona. */
export const TERMINAL_SUGGEST_MIN_N = 20;
/** Assinaturas mais longe do que isto do centro do aeroporto não contam (hotéis, estações mal classificadas). */
export const TERMINAL_SUGGEST_MAX_FROM_AIRPORT_M = 4_000;
/** "Juntas" = a ≤ isto da mediana. */
export const TERMINAL_SUGGEST_NEAR_M = 300;

const CITY: Record<string, ParkZoneCity> = { lisboa: "lisbon", porto: "porto", faro: "faro" };
const str = (v: unknown) => (v == null || String(v).trim() === "" ? null : String(v).trim());
const num = (v: unknown) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Posições das assinaturas (CHECK_OUT e CHECK_IN) desde `sinceUtc`, com o parque e o tipo de entrega da reserva. PURA. */
export function buildSignaturePositionsSql(sinceUtc: string, limit = TERMINAL_SUGGEST_MAX_ROWS): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const since = p.add(sinceUtc);
  const out = p.add("CHECK_OUT"), inn = p.add("CHECK_IN");
  const lim = p.add(Math.min(Math.max(Math.floor(limit), 1), TERMINAL_SUGGEST_MAX_ROWS));
  const sql = [
    `SELECT b."parkId" AS park_id, NULLIF(b."deliveryType", '') AS delivery_type, upper(h."changeType"::text) AS change_type, h."lat" AS lat, h."lng" AS lng`,
    `  FROM "History" h JOIN "Booking" b ON b."id" = h."bookingId"`,
    ` WHERE h."actionTime" >= ${since}::timestamp`,
    `   AND upper(h."changeType"::text) IN (${out}, ${inn})`,
    `   AND h."lat" IS NOT NULL AND h."lng" IS NOT NULL AND h."lat" <> 0`,
    ` ORDER BY h."actionTime" DESC`,
    ` LIMIT ${lim}`,
  ].join("\n");
  return { sql, params: p.values };
}

export interface TerminalZoneSuggestion {
  label: "T1" | "T2";
  lat: number;
  lng: number;
  /** Raio proposto (o de omissão das zonas T1/T2: apertado, a fila de trânsito dentro conta como chegada). */
  radiusM: number;
  n: number;
  checkouts: number;
  checkins: number;
  /** Distância das assinaturas à mediana (m). */
  p50M: number;
  p90M: number;
  /** Fração das assinaturas a ≤ TERMINAL_SUGGEST_NEAR_M da mediana. */
  near: number;
}

const pct = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];

/**
 * As zonas T1/T2 propostas, por cidade (Porto e Faro só têm T1). PURA.
 * `airports` (opcional): o centro de cada aeroporto, para deixar de fora as
 * assinaturas longe dele.
 */
export function suggestTerminalZones(input: {
  rows: Array<Record<string, unknown>>;
  parks: Array<Record<string, unknown>>;
  excludedParks?: readonly string[];
  airports?: Partial<Record<ParkZoneCity, AirportFence | null | undefined>> | null;
}): Record<ParkZoneCity, TerminalZoneSuggestion[]> {
  const ex = new Set(input.excludedParks ?? []);
  const parks = new Map<string, { city: ParkZoneCity | null; operated: boolean }>();
  for (const r of input.parks) {
    const id = str(r.id);
    if (!id) continue;
    const name = String(r.name ?? id);
    const cls = classifyPark({ name, city: str(r.city), address: str(r.address), firebaseBrand: str(r.firebase_brand), listingType: str(r.listing_type) });
    parks.set(id, { city: cls.city ? CITY[cls.city] ?? null : null, operated: marketplaceOperated({ id, name, ours: cls.ours }, ex) && !ex.has(id) });
  }
  const groups = new Map<string, { city: ParkZoneCity; label: "T1" | "T2"; pts: Array<{ lat: number; lng: number }>; out: number; in: number }>();
  for (const r of input.rows) {
    const park = parks.get(String(r.park_id ?? ""));
    if (!park?.operated || !park.city) continue;
    const lat = num(r.lat), lng = num(r.lng);
    if (lat == null || lng == null || (lat === 0 && lng === 0) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const a = input.airports?.[park.city];
    if (a && Number.isFinite(a.lat) && Number.isFinite(a.lng) && distanceMeters(lat, lng, a.lat, a.lng) > TERMINAL_SUGGEST_MAX_FROM_AIRPORT_M) continue;
    const cls = terminalClassOf(str(r.delivery_type), park.city);
    if (cls !== "t1" && cls !== "t2") continue;
    const label = cls === "t2" ? "T2" : "T1";
    const k = `${park.city}|${label}`;
    const g = groups.get(k) ?? { city: park.city, label, pts: [], out: 0, in: 0 };
    g.pts.push({ lat, lng });
    if (String(r.change_type ?? "").toUpperCase() === "CHECK_IN") g.in++; else g.out++;
    groups.set(k, g);
  }
  const out: Record<ParkZoneCity, TerminalZoneSuggestion[]> = { lisbon: [], porto: [], faro: [] };
  for (const g of groups.values()) {
    if (g.pts.length < TERMINAL_SUGGEST_MIN_N) continue;
    const lat = median(g.pts.map((p) => p.lat)), lng = median(g.pts.map((p) => p.lng));
    if (lat == null || lng == null) continue;
    const d = g.pts.map((p) => distanceMeters(p.lat, p.lng, lat, lng)).sort((a, b) => a - b);
    out[g.city].push({
      label: g.label, lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, radiusM: TERMINAL_ZONE_RADIUS_HINT_M,
      n: g.pts.length, checkouts: g.out, checkins: g.in, p50M: Math.round(pct(d, 0.5)), p90M: Math.round(pct(d, 0.9)),
      near: d.filter((x) => x <= TERMINAL_SUGGEST_NEAR_M).length / d.length,
    });
  }
  for (const c of Object.keys(out) as ParkZoneCity[]) out[c].sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

/** Lê as assinaturas e os parques e propõe as zonas. Lança se a Multipark não responder (quem chama usa safeMultiparkRead). */
export async function readTerminalZoneSuggestions(query: Query, nowMs: number, o: { excludedParks?: readonly string[]; airports?: Partial<Record<ParkZoneCity, AirportFence | null | undefined>> | null } = {}): Promise<Record<ParkZoneCity, TerminalZoneSuggestion[]>> {
  const since = new Date(nowMs - TERMINAL_SUGGEST_DAYS * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  const s = buildSignaturePositionsSql(since), p = buildServiceParksSql();
  const [rows, parks] = await Promise.all([query<Record<string, unknown>>(s.sql, s.params), query<Record<string, unknown>>(p.sql, p.params)]);
  return suggestTerminalZones({ rows, parks, excludedParks: o.excludedParks, airports: o.airports });
}
