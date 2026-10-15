/**
 * Zonas da operação a partir das GARAGENS da Multipark (plano 62, P5; Q6 do
 * Jorge: "a Multipark já tem as coordenadas") — SÓ LEITURA:
 *  - readGarageCoords: cada garagem com o centro do `mapLink` ("Garage" não
 *    tem lat/lng; só o "Park" tem) e a cidade pelo parque. É a base das zonas
 *    (shared/serviceGps.ts → effectiveParkZones); as Definições guardam só as
 *    exceções;
 *  - "Sugerir" (recurso para as garagens sem coordenadas): centros propostos,
 *    nada se grava (quem vê carrega em Guardar). Por esta ordem:
 *   a) o link do mapa da garagem (`Garage.mapLink`), quando tem coordenadas;
 *   b) a MEDIANA das posições da app nas linhas MOVEMENT que acabam nessa
 *      garagem nas últimas 4 semanas (só a mediana e a contagem, nunca as linhas).
 *   O centro do parque (`Park.lat/lng`) já NÃO se propõe: a P0 mostrou que fica
 *   junto ao aeroporto, não na garagem (uma zona lá era uma garagem no terminal).
 * A cidade das medianas sai da latitude (Porto ~41°, Lisboa ~38,7°, Faro
 * ~37°): assim uma garagem com o mesmo nome em duas cidades não se mistura,
 * sem juntar a "History" a outras tabelas.
 * SQL parametrizado, sem barras invertidas; construtores e mapeadores PUROS.
 */
import { type SqlParam } from "./client";
import { ParamList } from "./read";
import { MOVEMENT_PATTERNS } from "../../shared/multiparkMovements";
import { resolveParkCity } from "../../shared/multiparkParks";
import { kindOfGarageName, mapLinkCoords, mapLinkKind, type GarageCoord, type LatLng, type ParkZoneCity, type ParkZoneKind } from "../../shared/serviceGps";
import { matchKey } from "../../shared/textKey";

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

const num = (v: unknown) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown) => (v == null || String(v).trim() === "" ? null : String(v).trim());
const CITY: Record<string, ParkZoneCity> = { lisboa: "lisbon", porto: "porto", faro: "faro" };

export const SUGGEST_WINDOW_DAYS = 28;

/** Garagens (nome, parque, link do mapa). PURA. */
export function buildGaragesSql(): { sql: string; params: SqlParam[] } {
  return { sql: `SELECT g."id" AS id, g."name" AS name, g."parkId" AS park_id, NULLIF(g."mapLink", '') AS map_link FROM "Garage" g ORDER BY g."name" LIMIT 500`, params: [] };
}

/** Parques com o centro (lat/lng). PURA. */
export function buildParkCentersSql(): { sql: string; params: SqlParam[] } {
  return { sql: `SELECT p."id" AS id, p."name" AS name, p."city" AS city, NULLIF(p."address", '') AS address, p."lat" AS lat, p."lng" AS lng FROM "Park" p ORDER BY p."name" LIMIT 500`, params: [] };
}

/**
 * Mediana das posições da app nas linhas MOVEMENT que ACABAM em cada garagem
 * (garageName.to), por cidade (pela latitude), desde `sinceUtc`. PURA.
 */
export function buildMovementGarageMediansSql(sinceUtc: string): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const to = p.add(MOVEMENT_PATTERNS.side("garageName", "to"));
  const since = p.add(sinceUtc);
  const sql = [
    `SELECT x.city AS city, x.garage AS garage, count(*) AS n,`,
    `       percentile_cont(0.5) WITHIN GROUP (ORDER BY x.lat) AS lat,`,
    `       percentile_cont(0.5) WITHIN GROUP (ORDER BY x.lng) AS lng`,
    `  FROM (`,
    `    SELECT upper(btrim(btrim(substring(h."modifiedFields" from ${to}), '"'))) AS garage, h."lat" AS lat, h."lng" AS lng,`,
    `           CASE WHEN h."lat" > 40.5 THEN 'porto' WHEN h."lat" < 37.6 THEN 'faro' ELSE 'lisbon' END AS city`,
    `      FROM "History" h`,
    `     WHERE h."actionTime" >= ${since}::timestamp`,
    `       AND upper(h."changeType"::text) = 'MOVEMENT'`,
    `       AND h."lat" IS NOT NULL AND h."lng" IS NOT NULL AND h."lat" <> 0`,
    `  ) x`,
    ` WHERE x.garage IS NOT NULL AND x.garage <> '' AND x.garage <> 'NULL'`,
    ` GROUP BY x.city, x.garage`,
    ` ORDER BY n DESC`,
    ` LIMIT 300`,
  ].join("\n");
  return { sql, params: p.values };
}

export interface ZoneSuggestion {
  garage: string;
  /** Tipo proposto pelo nome (P2 → p2, PD → pd, CENTRAL → central, COBERTO → coberto). */
  kind: ParkZoneKind;
  lat: number;
  lng: number;
  source: "mapa" | "app";
  /** Linhas da app na mediana (fonte "app"). */
  n: number | null;
  parkName: string | null;
}

export { kindOfGarageName };

/**
 * Q6: as garagens da Multipark com o centro tirado do `mapLink` (a tabela
 * "Garage" não tem lat/lng; null = sem coordenadas) e a cidade pelo parque. PURA.
 */
export function garageCoordsOf(garages: Array<Record<string, unknown>>, parks: Array<Record<string, unknown>>): GarageCoord[] {
  const cityOfPark = new Map<string, { city: ParkZoneCity | null; name: string | null }>();
  for (const p of parks) {
    const id = str(p.id);
    if (!id) continue;
    const c = resolveParkCity({ city: str(p.city), name: str(p.name), address: str(p.address) }).city;
    cityOfPark.set(id, { city: c ? CITY[c] ?? null : null, name: str(p.name) });
  }
  const out: GarageCoord[] = [];
  for (const g of garages) {
    const name = str(g.name);
    const park = cityOfPark.get(String(g.park_id ?? ""));
    if (!name || !park?.city) continue;
    const c = mapLinkCoords(str(g.map_link));
    // link curto (maps.app.goo.gl): o servidor não o abre — fica sem coordenadas e o editor diz como resolver
    out.push({ garage: name, city: park.city, lat: c?.lat ?? null, lng: c?.lng ?? null, parkName: park.name, link: mapLinkKind(str(g.map_link)) });
  }
  return out;
}

/** Garagens da Multipark (Garage + Park; leituras pequenas). Lança se a Multipark não responder. */
export async function readGarageCoords(query: Query): Promise<GarageCoord[]> {
  const g = buildGaragesSql(), p = buildParkCentersSql();
  const [garages, parks] = await Promise.all([query<Record<string, unknown>>(g.sql, g.params), query<Record<string, unknown>>(p.sql, p.params)]);
  return garageCoordsOf(garages, parks);
}


/**
 * Junta as fontes: uma sugestão por (cidade, garagem), pela ordem mapa → app
 * (sem nenhuma das duas, não se propõe nada: nunca o Park.lat/lng). Garagens
 * de parques sem cidade reconhecida ficam de fora. PURA.
 */
export function suggestZoneCenters(input: {
  garages: Array<Record<string, unknown>>;
  parks: Array<Record<string, unknown>>;
  medians: Array<Record<string, unknown>>;
}): Record<ParkZoneCity, ZoneSuggestion[]> {
  const out: Record<ParkZoneCity, ZoneSuggestion[]> = { lisbon: [], porto: [], faro: [] };
  const parks = new Map<string, { name: string | null; city: ParkZoneCity | null; lat: number | null; lng: number | null }>();
  for (const p of input.parks) {
    const id = str(p.id);
    if (!id) continue;
    const c = resolveParkCity({ city: str(p.city), name: str(p.name), address: str(p.address) }).city;
    parks.set(id, { name: str(p.name), city: c ? CITY[c] ?? null : null, lat: num(p.lat), lng: num(p.lng) });
  }
  const medians = new Map<string, { lat: number; lng: number; n: number }>();
  for (const m of input.medians) {
    const city = str(m.city), garage = str(m.garage), lat = num(m.lat), lng = num(m.lng);
    if (!city || !garage || lat == null || lng == null) continue;
    medians.set(`${city}|${matchKey(garage)}`, { lat, lng, n: Math.round(num(m.n) ?? 0) });
  }
  const seen = new Set<string>();
  const push = (city: ParkZoneCity, s: ZoneSuggestion) => {
    const k = `${city}|${matchKey(s.garage)}`;
    if (seen.has(k)) return;
    seen.add(k);
    out[city].push(s);
  };
  for (const g of input.garages) {
    const name = str(g.name);
    const park = parks.get(String(g.park_id ?? ""));
    if (!name || !park?.city) continue;
    const kind = kindOfGarageName(name);
    const fromMap: LatLng | null = mapLinkCoords(str(g.map_link));
    const fromApp = medians.get(`${park.city}|${matchKey(name)}`);
    if (fromMap) push(park.city, { garage: name, kind, lat: fromMap.lat, lng: fromMap.lng, source: "mapa", n: null, parkName: park.name });
    else if (fromApp) push(park.city, { garage: name, kind, lat: fromApp.lat, lng: fromApp.lng, source: "app", n: fromApp.n, parkName: park.name });
  }
  // garagens que só aparecem nos movimentos (ex.: um "P2" sem linha em "Garage")
  for (const [k, m] of medians) {
    const [city, key] = k.split("|");
    if (!(city in out) || seen.has(k)) continue;
    const raw = input.medians.find((r) => str(r.city) === city && matchKey(str(r.garage)) === key);
    const name = str(raw?.garage) ?? key.toUpperCase();
    push(city as ParkZoneCity, { garage: name, kind: kindOfGarageName(name), lat: m.lat, lng: m.lng, source: "app", n: m.n, parkName: null });
  }
  for (const c of Object.keys(out) as ParkZoneCity[]) out[c].sort((a, b) => a.garage.localeCompare(b.garage, "pt"));
  return out;
}

/** Lê as três fontes e junta-as. Lança se a Multipark não responder (quem chama usa safeMultiparkRead). */
export async function readZoneSuggestions(query: Query, nowMs: number): Promise<Record<ParkZoneCity, ZoneSuggestion[]>> {
  const since = new Date(nowMs - SUGGEST_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  const g = buildGaragesSql(), p = buildParkCentersSql(), m = buildMovementGarageMediansSql(since);
  const [garages, parks, medians] = await Promise.all([
    query<Record<string, unknown>>(g.sql, g.params),
    query<Record<string, unknown>>(p.sql, p.params),
    query<Record<string, unknown>>(m.sql, m.params),
  ]);
  return suggestZoneCenters({ garages, parks, medians });
}
