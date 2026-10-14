/**
 * GPS dos tempos de entrega e de recolha (plano 62, P4) — regras PURAS.
 *
 *  - detectStop: quando é que o condutor CHEGOU ao terminal (§4.4): parou na
 *    zona de chegada, ou saiu a pé; com pontos espaçados, o meio do intervalo
 *    e a precisão guardada;
 *  - detectExit: quando é que o carro SAIU de uma zona (terminal, P2, parque;
 *    §4.5) — a andar de carro, não a pé;
 *  - arrivalZoneFor: que zona é a de chegada (§4.3, por esta ordem: zona T1/T2
 *    do terminal, ponto da assinatura, círculo do aeroporto);
 *  - posição no início (`inicio_no_terminal`, coerência com o parque, §4.6);
 *  - zonas da operação (P2, PD, central…: definição `operations.parkZones`) e
 *    os avisos do editor (zonas que se tocam, rótulos T1/T2).
 *
 * "Dentro" = distância ao centro ≤ raio, só com pontos PRECISOS (≤ 100 m, do
 * Zello). Não se subtrai a imprecisão (ao contrário do `gpsInAirport` do
 * ponto): isso adiantava a chegada.
 *
 * Os PARÂMETROS são provisórios até a P0 correr em produção (§11.1): ficam
 * em constantes com nome para o PR dos parâmetros os trocar.
 */
import { distanceMeters, type AirportFence } from "./pontoTerminal";
import { matchKey } from "./textKey";

// ─── Parâmetros (provisórios até à P0) ──────────────────────────────────────

/** Parado (km/h). */
export const V_STOP_KMH = 3;
/** A pé (km/h): até aqui conta como "parou ou anda a pé". */
export const V_WALK_KMH = 7;
/** De carro (km/h): acima disto é uma saída de carro. */
export const V_CAR_KMH = 10;
/** Pontos densos: parado/a pé dentro da zona durante isto confirma a chegada. */
export const T_STOP_MIN_S = 60;
/** O ponto seguinte até isto confirma a chegada (pontos espaçados). */
export const T_CONFIRM_S = 6 * 60;
/** Intervalo normal entre pontos; até G_WEAK fica "precisão fraca"; acima, "buraco no GPS". */
export const G_GOOD_S = 6 * 60;
export const G_WEAK_S = 15 * 60;
/** Raio à volta do ponto da assinatura (estações, hotéis). */
export const R_SIGNATURE_M = 150;
/** Raio proposto para as zonas T1/T2 (só sugestão no editor). */
export const TERMINAL_ZONE_RADIUS_HINT_M = 200;
/** Posição no início: até isto do parque está bem; a mais de D_MISMATCH do parque e da linha = não bate. */
export const D_PARK_OK_M = 500;
export const D_START_ROW_OK_M = 300;
export const D_MISMATCH_M = 1000;
/** "Em entrega" marcado no terminal sem GPS: a linha a ≥ isto do parque. */
export const D_START_FAR_FROM_PARK_M = 1000;
/** Saída de carro: a mais de raio + isto do centro (mesmo devagar). */
export const D_EXIT_MARGIN_M = 300;
/** Zona "parque" à volta do Park (ou da garagem de origem) para a saída do parque. */
export const PARK_EXIT_RADIUS_M = 300;
/** Sem chegada: se o trajeto nunca se afasta isto da posição no início → "gps_parado". */
export const MOVE_PROOF_M = 500;
/** Último ponto antes da assinatura: conta como chegada se a assinatura vier até isto depois. */
export const STOP_LAST_POINT_MAX_MIN = 20;
/** Os pontos contam até isto depois da assinatura. */
export const AFTER_SIGNATURE_S = 120;
/** Procura da saída de uma zona: até isto depois do início. */
export const EXIT_SEARCH_MAX_MIN = 120;

// ─── Tipos ──────────────────────────────────────────────────────────────────

/** Ponto do Zello (ts em segundos epoch, velocidade em km/h). */
export interface GpsFix { ts: number; speed: number; lat: number | null; lon: number | null; accurate: boolean }
export interface LatLng { lat: number; lng: number }
export interface Zone { label?: string | null; lat: number; lng: number; radiusM: number }

const ms = (p: GpsFix) => p.ts * 1000;
const usable = (p: GpsFix) => p.accurate && p.lat != null && p.lon != null && Number.isFinite(p.lat) && Number.isFinite(p.lon);
const distTo = (p: GpsFix, c: LatLng) => distanceMeters(p.lat as number, p.lon as number, c.lat, c.lng);

/** O ponto está dentro da zona (preciso e a ≤ raio do centro)? PURA. */
export function insideZone(p: GpsFix, z: Zone): boolean {
  return usable(p) && distTo(p, z) <= z.radiusM;
}

/** Uma posição (lat/lng de uma linha da app) dentro da zona? PURA. */
export function latLngInside(pos: LatLng | null | undefined, z: Zone): boolean {
  return !!pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lng) && distanceMeters(pos.lat, pos.lng, z.lat, z.lng) <= z.radiusM;
}

/** Pontos usáveis, por ordem, numa janela [from, to] (ms). PURA. */
export function fixesIn(points: readonly GpsFix[], fromMs: number, toMs: number): GpsFix[] {
  return points.filter((p) => usable(p) && ms(p) >= fromMs && ms(p) <= toMs).sort((a, b) => a.ts - b.ts);
}

// ─── Zona de chegada (§4.3) ─────────────────────────────────────────────────

/** Classe do destino (server/extrasDia.ts → classifyDeliveryType). */
export type TerminalClass = "t1" | "t2" | "vip" | "other" | "unknown";

/** Rótulo de uma zona → T1/T2 ("T1", "Terminal 1", "t 2"…), ou null. PURA. */
export function terminalLabelOf(label: string | null | undefined): "t1" | "t2" | null {
  const k = matchKey(label);
  if (k === "t1" || k === "terminal1") return "t1";
  if (k === "t2" || k === "terminal2") return "t2";
  return null;
}

export type ArrivalZone =
  | { kind: "zona"; zone: Zone; source: "gps_zona" | "gps_ponto_assinatura" | "gps_aeroporto"; flags: string[] }
  | { kind: "sem_zona"; status: "sem_destino" | "destino_ambiguo" };

/**
 * A zona de chegada de uma entrega (§4.3), por esta ordem:
 *  1. a zona do terminal da classe (rótulo T1/T2; VIP e sem tipo usam a T1).
 *     Cidade com UMA só zona: serve a T1/VIP/sem tipo, com ou sem rótulo.
 *     Lisboa com zonas sem rótulo não adivinha → passo 2;
 *  2. o ponto da assinatura (lat/lng da linha CHECK_OUT) com R_SIGNATURE_M;
 *  3. o círculo do aeroporto — só para as classes do aeroporto, nunca para
 *     "Outro" (Oriente, Sete Rios, estação), e só se nenhum parque da cidade
 *     cair lá dentro (`precisao_fraca`; com parque → `destino_ambiguo`);
 *  4. nenhuma → `sem_destino`.
 * PURA.
 */
export function arrivalZoneFor(o: { terminalClass: TerminalClass; airport: AirportFence | null | undefined; signature: LatLng | null | undefined; parks?: readonly LatLng[] }): ArrivalZone {
  const airportClass = o.terminalClass !== "other";
  const zones = o.airport?.zones ?? [];
  if (airportClass && zones.length) {
    const want = o.terminalClass === "t2" ? "t2" : "t1";
    const labeled = zones.find((z) => terminalLabelOf(z.label) === want);
    if (labeled) return { kind: "zona", zone: labeled, source: "gps_zona", flags: [] };
    if (zones.length === 1 && want === "t1") return { kind: "zona", zone: zones[0], source: "gps_zona", flags: [] };
  }
  if (o.signature && Number.isFinite(o.signature.lat) && Number.isFinite(o.signature.lng)) {
    return { kind: "zona", zone: { label: "assinatura", lat: o.signature.lat, lng: o.signature.lng, radiusM: R_SIGNATURE_M }, source: "gps_ponto_assinatura", flags: [] };
  }
  if (airportClass && o.airport && Number.isFinite(o.airport.lat) && Number.isFinite(o.airport.lng)) {
    const a = o.airport;
    if ((o.parks ?? []).some((p) => distanceMeters(p.lat, p.lng, a.lat, a.lng) <= a.radiusM)) return { kind: "sem_zona", status: "destino_ambiguo" };
    return { kind: "zona", zone: { label: "aeroporto", lat: a.lat, lng: a.lng, radiusM: a.radiusM }, source: "gps_aeroporto", flags: ["precisao_fraca"] };
  }
  return { kind: "sem_zona", status: "sem_destino" };
}

/** Zona T1 ou T2 da cidade (com rótulo; uma só zona serve ao T1). PURA. */
export function terminalZoneFor(airport: AirportFence | null | undefined, which: "t1" | "t2"): Zone | null {
  const zones = airport?.zones ?? [];
  const labeled = zones.find((z) => terminalLabelOf(z.label) === which);
  if (labeled) return labeled;
  if (which === "t1" && zones.length === 1) return zones[0];
  return null;
}

// ─── Posição no início e coerência (§4.6) ───────────────────────────────────

/** O último ponto até `at` (no máximo `maxBeforeS` antes). PURA. */
export function positionAt(points: readonly GpsFix[], at: number, maxBeforeS = G_GOOD_S): GpsFix | null {
  let best: GpsFix | null = null;
  for (const p of points) {
    if (!usable(p)) continue;
    const t = ms(p);
    if (t <= at && t >= at - maxBeforeS * 1000 && (!best || p.ts > best.ts)) best = p;
  }
  return best;
}

/**
 * A posição no início bate com a reserva? Perto do parque (≤ 500 m) ou da
 * linha "em entrega" (≤ 300 m) = ok; a mais de 1 km dos dois = `gps_nao_bate`;
 * no meio = `duvidosa`. Sem referências = ok. PURA.
 */
export function startCoherence(pos: LatLng | null, park: LatLng | null | undefined, startRow: LatLng | null | undefined): "ok" | "duvidosa" | "gps_nao_bate" {
  if (!pos) return "ok";
  const d = (c: LatLng | null | undefined) => (c && Number.isFinite(c.lat) && Number.isFinite(c.lng) ? distanceMeters(pos.lat, pos.lng, c.lat, c.lng) : null);
  const dp = d(park), dr = d(startRow);
  if (dp == null && dr == null) return "ok";
  if ((dp != null && dp <= D_PARK_OK_M) || (dr != null && dr <= D_START_ROW_OK_M)) return "ok";
  if ((dp == null || dp > D_MISMATCH_M) && (dr == null || dr > D_MISMATCH_M)) return "gps_nao_bate";
  return "duvidosa";
}

// ─── Paragem no destino (§4.4) ──────────────────────────────────────────────

export type StopResult =
  | { kind: "chegada"; at: number; precisionS: number; flags: string[] }
  | { kind: "inicio_no_terminal"; flags: string[] }
  | { kind: "sem_chegada"; status: "sem_pontos" | "buraco_no_gps" | "gps_nao_bate" | "gps_parado" | "sem_paragem" | "destino_ambiguo" | "chegada_depois_da_assinatura"; flags: string[] };

/**
 * Quando é que o condutor chegou (§4.4). `points` = os pontos "meus" (já
 * filtrados por quem tinha o Zello); `startAt` = S (em entrega), `endAt` = E
 * (assinatura). Passos:
 *  1. sem pontos depois de S → `sem_pontos`;
 *  6. (primeiro) a posição EM S — o último ponto ≤ S até G_GOOD antes — já na
 *     zona → `inicio_no_terminal`; sem esse ponto, a lat/lng da linha "em
 *     entrega" na zona e a ≥ 1 km do parque. Um parque perto do aeroporto que
 *     faz o 1.º ponto DEPOIS de S cair na zona é uma chegada rápida, não isto;
 *  2–3. candidatos = pontos dentro da zona a ≤ V_WALK, confirmados por (a)
 *     pontos densos parados na zona durante T_STOP_MIN, (b) o ponto seguinte
 *     (até T_CONFIRM) a ≤ V_WALK (dentro, ou fora a pé), ou (c) ser o último
 *     ponto antes da assinatura, a ≤ 20 min dela. Passar pela zona a andar não conta;
 *  4. nenhum → `sem_paragem` (ou `gps_parado`, se nunca se afastou 500 m);
 *  5. A = meio do intervalo se o ponto anterior ia a andar (nunca antes de S),
 *     senão o próprio ponto; intervalo > G_WEAK → `buraco_no_gps`, > G_GOOD → `precisao_fraca`;
 *  7. A > E + 60 s → `chegada_depois_da_assinatura`; E < A ≤ E + 60 s → A = E.
 * PURA.
 */
export function detectStop(o: {
  points: readonly GpsFix[];
  startAt: number;
  endAt: number;
  zone: Zone;
  park?: LatLng | null;
  startRow?: LatLng | null;
}): StopResult {
  const S = o.startAt, E = o.endAt, z = o.zone;
  const pts = fixesIn(o.points, S - G_GOOD_S * 1000, E + AFTER_SIGNATURE_S * 1000);
  const after = pts.filter((p) => ms(p) >= S);
  if (!after.length) return { kind: "sem_chegada", status: "sem_pontos", flags: [] };
  const flags: string[] = [];
  const parkInZone = !!o.park && latLngInside(o.park, z);

  // 6. posição em S
  const q = positionAt(pts, S);
  if (q ? insideZone(q, z) : (latLngInside(o.startRow, z) && (!o.park || distanceMeters(o.startRow!.lat, o.startRow!.lng, o.park.lat, o.park.lng) >= D_START_FAR_FROM_PARK_M))) {
    if (parkInZone) return { kind: "sem_chegada", status: "destino_ambiguo", flags };
    return { kind: "inicio_no_terminal", flags };
  }
  const pos0 = q ?? after[0];
  const coh = startCoherence({ lat: pos0.lat as number, lng: pos0.lon as number }, o.park, o.startRow);
  if (coh === "gps_nao_bate") return { kind: "sem_chegada", status: "gps_nao_bate", flags };
  if (coh === "duvidosa") flags.push("posicao_duvidosa");

  // 2–3. candidatos confirmados
  let hit = -1;
  for (let i = 0; i < after.length; i++) {
    const p = after[i];
    if (!(insideZone(p, z) && p.speed <= V_WALK_KMH)) continue;
    const t = ms(p);
    const rest = after.slice(i + 1);
    const win = rest.filter((x) => ms(x) <= t + T_STOP_MIN_S * 1000);
    const dense = win.length > 0 && win.every((x) => insideZone(x, z) && x.speed <= V_WALK_KMH);
    const nx = rest[0];
    const nextOk = !!nx && ms(nx) - t <= T_CONFIRM_S * 1000 && nx.speed <= V_WALK_KMH;
    const lastBeforeE = !rest.some((x) => ms(x) <= E) && E - t <= STOP_LAST_POINT_MAX_MIN * 60_000 && t <= E + AFTER_SIGNATURE_S * 1000;
    if (dense || nextOk || lastBeforeE) { hit = i; break; }
  }
  if (hit < 0) {
    // sem chegada: o GPS andou? (com chegada o movimento já está provado)
    const moved = after.some((p) => distanceMeters(p.lat as number, p.lon as number, pos0.lat as number, pos0.lon as number) >= MOVE_PROOF_M);
    return { kind: "sem_chegada", status: moved ? "sem_paragem" : "gps_parado", flags };
  }
  if (parkInZone) return { kind: "sem_chegada", status: "destino_ambiguo", flags };

  // 5. instante e precisão — desde o 1.º ponto da paragem (os anteriores, já
  // parados na zona mas por confirmar, contam: pontos espaçados)
  while (hit > 0 && insideZone(after[hit - 1], z) && after[hit - 1].speed <= V_WALK_KMH) hit--;
  const pi = after[hit];
  const ti = ms(pi);
  const idx = pts.indexOf(pi);
  const prev = idx > 0 ? pts[idx - 1] : null;
  const lo = prev ? Math.max(S, ms(prev)) : S;
  const gap = ti - lo;
  if (gap > G_WEAK_S * 1000) return { kind: "sem_chegada", status: "buraco_no_gps", flags };
  if (gap > G_GOOD_S * 1000) flags.push("precisao_fraca");
  let A: number;
  let precisionS: number;
  if (prev && prev.speed > V_WALK_KMH) {
    A = Math.max(S, Math.round((ms(prev) + ti) / 2));
    precisionS = Math.round((ti - lo) / 2000);
  } else {
    A = ti;
    precisionS = Math.round(gap / 1000);
  }
  if (pi.speed > V_STOP_KMH) flags.push("chegada_a_pe");

  // 7. depois da assinatura
  if (A > E) {
    if (A - E > 60_000) return { kind: "sem_chegada", status: "chegada_depois_da_assinatura", flags };
    A = E;
    flags.push("chegada_ajustada");
  }
  return { kind: "chegada", at: A, precisionS, flags };
}

// ─── Saída de uma zona (§4.5) ───────────────────────────────────────────────

export type ExitResult =
  | { kind: "saida"; at: number; precisionS: number; flags: string[] }
  | { kind: "sem_saida"; status: "sem_pontos" | "nunca_na_zona" | "sem_saida" | "buraco_no_gps"; flags: string[] };

/**
 * Quando é que o carro saiu da zona (terminal depois do check-in; P2; o
 * parque no "em entrega" marcado no terminal). X = o meio entre o último ponto
 * dentro e o 1.º ponto fora "de carro" (> V_CAR, ou a mais de raio +
 * D_EXIT_MARGIN do centro), confirmado pelo ponto seguinte também fora. Sair a
 * pé e voltar não é saída. Sem pontos dentro mas com a posição do check-in na
 * zona: conta como dentro em `fromAt`. Intervalo > G_WEAK → `buraco_no_gps`.
 * PURA.
 */
export function detectExit(o: { points: readonly GpsFix[]; fromAt: number; untilAt?: number; zone: Zone; startPos?: LatLng | null }): ExitResult {
  const z = o.zone;
  const until = o.untilAt ?? o.fromAt + EXIT_SEARCH_MAX_MIN * 60_000;
  const pts = fixesIn(o.points, o.fromAt - G_GOOD_S * 1000, until);
  const after = pts.filter((p) => ms(p) >= o.fromAt);
  if (!after.length) return { kind: "sem_saida", status: "sem_pontos", flags: [] };
  const flags: string[] = [];
  const q = positionAt(pts, o.fromAt);
  let lastIn: number | null = (q && insideZone(q, z)) || latLngInside(o.startPos, z) ? o.fromAt : null;
  const isCar = (p: GpsFix) => p.speed > V_CAR_KMH || distTo(p, z) > z.radiusM + D_EXIT_MARGIN_M;
  for (let i = 0; i < after.length; i++) {
    const p = after[i];
    const t = ms(p);
    if (insideZone(p, z)) { lastIn = t; continue; }
    if (lastIn == null || !isCar(p)) continue;
    const nx = after[i + 1];
    const farAway = distTo(p, z) > z.radiusM + D_EXIT_MARGIN_M;
    if (nx ? insideZone(nx, z) : !farAway) continue;
    const gap = t - lastIn;
    if (gap > G_WEAK_S * 1000) return { kind: "sem_saida", status: "buraco_no_gps", flags };
    if (gap > G_GOOD_S * 1000) flags.push("precisao_fraca");
    return { kind: "saida", at: Math.round((lastIn + t) / 2), precisionS: Math.round(gap / 2000), flags };
  }
  return { kind: "sem_saida", status: lastIn == null ? "nunca_na_zona" : "sem_saida", flags };
}

/**
 * T2 (§3.4): a chegada do condutor à zona T2 que dura até ao check-in (a
 * ÚLTIMA chegada antes de `untilAt`), procurada em [fromAt, untilAt]. Já lá
 * desde o início da janela → `alreadyThere`. O último ponto fora da zona →
 * `sem_paragem`. PURA.
 */
export function lastZoneArrival(o: { points: readonly GpsFix[]; fromAt: number; untilAt: number; zone: Zone }): { kind: "chegada"; at: number; alreadyThere: boolean } | { kind: "sem_chegada"; status: "sem_pontos" | "sem_paragem" } {
  const pts = fixesIn(o.points, o.fromAt, o.untilAt);
  if (!pts.length) return { kind: "sem_chegada", status: "sem_pontos" };
  if (!insideZone(pts[pts.length - 1], o.zone)) return { kind: "sem_chegada", status: "sem_paragem" };
  let j = pts.length - 1;
  while (j > 0 && insideZone(pts[j - 1], o.zone)) j--;
  if (j === 0) return { kind: "chegada", at: ms(pts[0]), alreadyThere: true };
  const prev = pts[j - 1];
  const at = prev.speed > V_WALK_KMH ? Math.round((ms(prev) + ms(pts[j])) / 2) : ms(pts[j]);
  return { kind: "chegada", at, alreadyThere: false };
}

// ─── Zonas da operação (P5: garagens da Multipark + operations.parkZones) ───
//
// Q6 (Jorge, 14 out 2026): "a Multipark já tem as coordenadas." As zonas dos
// parques (P2, PD, central, coberto…) vêm das GARAGENS da BD da Multipark (só
// leitura): na tabela "Garage" a única coordenada é o `mapLink` (texto; não há
// colunas lat/lng — só o "Park" as tem), por isso o centro sai das
// coordenadas do link (mapLinkCoords) e o raio é o de omissão do tipo. A
// definição `operations.parkZones` passa a ser só de EXCEÇÕES: ajustar o raio,
// corrigir o centro ou o tipo de uma garagem, ou acrescentar uma zona (com
// centro) para uma garagem sem coordenadas — o "Sugerir" ajuda aí.

export const PARK_ZONE_KINDS = ["p2", "pd", "central", "coberto", "outra"] as const;
export type ParkZoneKind = (typeof PARK_ZONE_KINDS)[number];
export const PARK_ZONE_KIND_LABELS: Record<ParkZoneKind, string> = {
  p2: "P2 (provisório)",
  pd: "PD",
  central: "Central",
  coberto: "Coberto (interior)",
  outra: "Outra",
};

export interface ParkZone {
  label: string;
  kind: ParkZoneKind;
  lat: number;
  lng: number;
  radiusM: number;
  /** Nomes das garagens da app que ficam nesta zona. */
  garages: string[];
}
export type ParkZoneCity = "lisbon" | "porto" | "faro";
export type ParkZonesMap = Record<ParkZoneCity, ParkZone[]>;
export const PARK_ZONE_CITIES: readonly ParkZoneCity[] = ["lisbon", "porto", "faro"];
export const PARK_ZONE_RADIUS = { min: 50, max: 1000 } as const;
/** Raio de omissão de uma zona feita a partir de uma garagem da Multipark (provisório até à P0). */
export const DEFAULT_GARAGE_ZONE_RADIUS_M: Record<ParkZoneKind, number> = { p2: 150, pd: 200, central: 200, coberto: 150, outra: 150 };

/**
 * Exceção gravada em `operations.parkZones` (Q6): `label` = o nome da garagem
 * (ou de uma zona nova). Sem centro, vale o da Multipark; sem raio, o de
 * omissão; sem tipo, o do nome da garagem.
 */
export interface ParkZoneException {
  label: string;
  kind?: ParkZoneKind;
  lat?: number;
  lng?: number;
  radiusM?: number;
  garages?: string[];
}
export type ParkZoneExceptionsMap = Record<ParkZoneCity, ParkZoneException[]>;
export const DEFAULT_PARK_ZONES: ParkZoneExceptionsMap = { lisbon: [], porto: [], faro: [] };

/** Uma garagem da Multipark com o centro tirado do `mapLink` (null = sem coordenadas). */
export interface GarageCoord { garage: string; city: ParkZoneCity; lat: number | null; lng: number | null; parkName?: string | null }

/** Tipo de zona pelo nome da garagem (P2 → p2, PD → pd, CENTRAL → central, COBERTO → coberto). PURA. */
export function kindOfGarageName(name: string | null | undefined): ParkZoneKind {
  const k = matchKey(name);
  if (/^p2/.test(k)) return "p2";
  if (/^central/.test(k)) return "central";
  if (/^pd/.test(k)) return "pd";
  if (/coberto|interior|indoor/.test(k)) return "coberto";
  return "outra";
}

export type EffectiveZoneSource = "multipark" | "multipark_ajustada" | "manual";
export interface EffectiveParkZone extends ParkZone { source: EffectiveZoneSource }

/**
 * As zonas em vigor (Q6): uma por garagem da Multipark com coordenadas (raio
 * de omissão do tipo), com as exceções por cima (mesmo nome, pela garagem ou
 * pelo rótulo); uma exceção que não bate com nenhuma garagem e tem centro é
 * uma zona manual; sem centro e sem garagem com coordenadas, fica de fora
 * (`withoutCoords`). PURA.
 */
export function effectiveParkZones(garages: readonly GarageCoord[], exceptions: Partial<ParkZoneExceptionsMap> | null | undefined): { zones: Record<ParkZoneCity, EffectiveParkZone[]>; withoutCoords: Array<{ city: ParkZoneCity; garage: string }> } {
  const zones: Record<ParkZoneCity, EffectiveParkZone[]> = { lisbon: [], porto: [], faro: [] };
  const withoutCoords: Array<{ city: ParkZoneCity; garage: string }> = [];
  for (const city of PARK_ZONE_CITIES) {
    const exc = exceptions?.[city] ?? [];
    const used = new Set<number>();
    const findExc = (name: string) => exc.findIndex((e, i) => !used.has(i) && (matchKey(e.label) === matchKey(name) || (e.garages ?? []).some((g) => matchKey(g) === matchKey(name))));
    const seen = new Set<string>();
    for (const g of garages.filter((x) => x.city === city)) {
      const key = matchKey(g.garage);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const i = findExc(g.garage);
      const e = i >= 0 ? exc[i] : null;
      if (i >= 0) used.add(i);
      const lat = e?.lat ?? g.lat, lng = e?.lng ?? g.lng;
      if (lat == null || lng == null) { withoutCoords.push({ city, garage: g.garage }); continue; }
      const kind = e?.kind ?? kindOfGarageName(g.garage);
      zones[city].push({
        label: e?.label ?? g.garage, kind, lat, lng, radiusM: e?.radiusM ?? DEFAULT_GARAGE_ZONE_RADIUS_M[kind],
        garages: [...new Set([g.garage, ...(e?.garages ?? [])])], source: e ? "multipark_ajustada" : "multipark",
      });
    }
    exc.forEach((e, i) => {
      if (used.has(i)) return;
      if (e.lat == null || e.lng == null) { withoutCoords.push({ city, garage: e.label }); return; }
      const kind = e.kind ?? kindOfGarageName(e.label);
      zones[city].push({ label: e.label, kind, lat: e.lat, lng: e.lng, radiusM: e.radiusM ?? DEFAULT_GARAGE_ZONE_RADIUS_M[kind], garages: e.garages?.length ? [...e.garages] : [e.label], source: "manual" });
    });
  }
  return { zones, withoutCoords };
}

/** Dois círculos tocam-se (distância entre centros ≤ soma dos raios)? PURA. */
export function zonesTouch(a: Zone, b: Zone): boolean {
  return distanceMeters(a.lat, a.lng, b.lat, b.lng) <= a.radiusM + b.radiusM;
}

/**
 * Zonas P2 que tocam numa zona do terminal (§5.2): RECUSADAS ao gravar
 * (a saída do terminal e a paragem no P2 ficavam indistinguíveis). PURA.
 */
export function p2TerminalConflicts(zones: Partial<ParkZonesMap> | null | undefined, airports: Partial<Record<string, AirportFence>> | null | undefined): Array<{ city: string; p2: string; terminal: string; distanceM: number }> {
  const out: Array<{ city: string; p2: string; terminal: string; distanceM: number }> = [];
  for (const city of PARK_ZONE_CITIES) {
    // todas as zonas do terminal (com ou sem rótulo): o ponto usa-as todas
    const tz = airports?.[city]?.zones ?? [];
    for (const p of (zones?.[city] ?? []).filter((x) => x.kind === "p2")) {
      for (const t of tz) {
        if (zonesTouch(p, t)) out.push({ city, p2: p.label, terminal: String(t.label ?? "") || "sem nome", distanceM: Math.round(distanceMeters(p.lat, p.lng, t.lat, t.lng)) });
      }
    }
  }
  return out;
}

/** Avisos do editor (não bloqueiam): zonas de tipos diferentes que se tocam. PURA. */
export function parkZoneOverlaps(zones: Partial<ParkZonesMap> | null | undefined): Array<{ city: string; a: string; b: string }> {
  const out: Array<{ city: string; a: string; b: string }> = [];
  for (const city of PARK_ZONE_CITIES) {
    const list = zones?.[city] ?? [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[i].kind !== list[j].kind && zonesTouch(list[i], list[j])) out.push({ city, a: list[i].label, b: list[j].label });
      }
    }
  }
  return out;
}

/** Zonas do terminal sem rótulo T1/T2 (aviso no editor dos aeroportos; não bloqueia). PURA. */
export function unlabeledTerminalZones(airports: Partial<Record<string, AirportFence>> | null | undefined): Array<{ city: string; index: number; label: string }> {
  const out: Array<{ city: string; index: number; label: string }> = [];
  for (const [city, fence] of Object.entries(airports ?? {})) {
    (fence?.zones ?? []).forEach((z, index) => { if (terminalLabelOf(z.label) == null) out.push({ city, index, label: String(z.label ?? "") }); });
  }
  return out;
}

/** A zona P2 da cidade (a 1.ª do tipo p2), se houver. PURA. */
export function p2ZoneOf(zones: Partial<ParkZonesMap> | null | undefined, city: ParkZoneCity | null): ParkZone | null {
  if (!city) return null;
  return (zones?.[city] ?? []).find((z) => z.kind === "p2") ?? null;
}

// ─── "Sugerir" (centros das zonas) ──────────────────────────────────────────

/** Coordenadas num link de mapa ("@38.77,-9.13", "q=38.77,-9.13", "ll=…", "query=…"). PURA. */
export function mapLinkCoords(link: string | null | undefined): LatLng | null {
  const s = String(link ?? "");
  const m = /@(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/.exec(s) ?? /[?&](?:q|ll|query|center|destination)=(-?\d{1,2}\.\d+)(?:,|%2C)\s*(-?\d{1,3}\.\d+)/i.exec(s);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

/** Mediana (null sem valores). PURA. */
export function median(values: readonly number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
