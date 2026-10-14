/**
 * Excessos de velocidade no GPS do Zello — regras ÚNICAS (Jorge, 14 out 2026:
 * "há gente a 141 e 149 km/h, e o limite em Portugal é 120"). PURAS: usadas
 * na recolha diária (server/jobs/dailyDriverCollection.ts → linha do dia e
 * partes por PDA), no Resumo do dia (shared/shiftDayReview.ts) e nos testes.
 *
 * UNIDADES: o Zello já devolve a velocidade em km/h (server/zelloGps.ts —
 * pedimos speedUnits=kmh). Aqui tudo é km/h e segundos.
 *
 * LIMITE: um só, em Definições → Parâmetros → "Limite de velocidade (GPS do Zello)"
 * (`gps.speedRule`): 120 km/h por omissão (o máximo legal em Portugal, nas
 * autoestradas), mais uma tolerância em % (0 por omissão). O GPS do Zello não
 * diz em que estrada se vai, por isso não há limites por tipo de via nem por
 * cidade: o limite é o de autoestrada — passar dele é excesso em qualquer
 * estrada. (A tabela antiga `speed_limits` deixou de ser lida: não tinha ecrã.)
 *
 * PICOS FALSOS (explícitos, em vez de deitar fora tudo acima de 150 km/h como
 * antes — um excesso real a 160 desaparecia):
 *  1. ponto impreciso (precisão > 100 m — zelloAccuracyOk) → a velocidade não conta;
 *  2. acima de GPS_ABSURD_KMH (250 km/h): nenhum carro nosso lá chega — erro;
 *  3. salto isolado: o ponto está acima dos DOIS vizinhos (até
 *     SPIKE_NEIGHBOUR_MAX_GAP_S de distância) e sobe e desce mais do que
 *     MAX_SPEED_JUMP_KMH_PER_S por segundo (ex.: 40 → 141 → 38 em 4 s) — um
 *     carro não acelera nem trava assim.
 *
 * EXCESSO (o que conta e dá aviso/pontos): pontos de confiança SEGUIDOS acima
 * do limite (com tolerância), juntando os que distam até EXCESS_MERGE_GAP_S
 * (uma autoestrada a 125–135 com uma descida curta é UM excesso). Conta quando
 * tem pelo menos `minPoints` pontos (2 por omissão: andou acima do limite
 * entre dois registos) — ou um só ponto confirmado pela POSIÇÃO (a distância ao
 * ponto vizinho a dividir pelo tempo também dá acima do limite).
 */

import { z } from "zod";

/** Chave da definição (Definições → Parâmetros → Operação). */
export const SPEED_RULE_SETTING_KEY = "gps.speedRule" as const;

export interface SpeedRule {
  /** km/h — o limite (120 = autoestrada em Portugal) */
  limitKmh: number;
  /** % acima do limite que ainda não é excesso (0 = nenhuma) */
  tolerancePercent: number;
  /** pontos seguidos acima do limite para contar um excesso (1 = qualquer ponto de confiança) */
  minPoints: number;
}

export const DEFAULT_SPEED_RULE: Readonly<SpeedRule> = { limitKmh: 120, tolerancePercent: 0, minPoints: 2 };

export const speedRuleSchema = z.object({
  limitKmh: z.number({ error: "Indica o limite em km/h." }).int("Número inteiro de km/h.").min(30, "Mínimo 30 km/h.").max(200, "Máximo 200 km/h."),
  tolerancePercent: z.number({ error: "Indica a tolerância em %." }).min(0, "Mínimo 0 %.").max(50, "Máximo 50 %."),
  minPoints: z.number({ error: "Indica quantos pontos seguidos." }).int("Número inteiro.").min(1, "Mínimo 1 ponto.").max(10, "Máximo 10 pontos."),
}).strict();

/**
 * Linhas do GPS recolhidas a partir desta versão (daily_driver_history.metricsVersion)
 * têm a máxima sem picos e os EXCESSOS desta regra; as anteriores tinham pontos
 * acima de um limite que, sem `speed_limits`, era 999 km/h.
 */
export const SPEED_EXCESS_METRICS_VERSION = 5;

/** Acima disto (km/h) é erro do GPS — nenhum carro nosso lá chega. */
export const GPS_ABSURD_KMH = 250;
/** Subir e descer mais do que isto por segundo, isolado, é pico falso (≈ 4 m/s², mais do que um carro normal). */
export const MAX_SPEED_JUMP_KMH_PER_S = 15;
/** Vizinhos a mais do que isto (s) já não servem para dizer que é um pico. */
export const SPIKE_NEIGHBOUR_MAX_GAP_S = 60;
/** Dois pontos acima do limite a até isto (s) um do outro são o mesmo excesso. */
export const EXCESS_MERGE_GAP_S = 120;
/** A posição só confirma uma velocidade com pelo menos isto (s) entre os pontos (menos, o GPS a tremer engana). */
export const POSITION_MIN_GAP_S = 5;
/** …e no máximo isto (s). */
export const POSITION_MAX_GAP_S = 120;

/** Limite com a tolerância (km/h). PURA. */
export function speedThresholdOf(r: Pick<SpeedRule, "limitKmh" | "tolerancePercent">): number {
  const v = Number(r.limitKmh) * (1 + (Number(r.tolerancePercent) || 0) / 100);
  return Math.round(v * 100) / 100;
}

/** Um ponto do GPS (ts em segundos; velocidade em km/h). */
export interface SpeedPoint { ts: number; speed: number; accurate: boolean; lat?: number | null; lon?: number | null }

export type SpikeReason = "absurd" | "jump";

const hasSpeed = (p: SpeedPoint) => p.accurate && p.speed > 0;

/**
 * Picos falsos (índice → motivo), com os pontos ORDENADOS pelo tempo. Só os
 * pontos precisos com velocidade entram (os imprecisos já não contam). PURA.
 */
export function speedSpikes(points: readonly SpeedPoint[]): Map<number, SpikeReason> {
  const out = new Map<number, SpikeReason>();
  const idx: number[] = [];
  points.forEach((p, i) => { if (p.accurate) idx.push(i); });
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const p = points[i];
    if (!hasSpeed(p)) continue;
    if (p.speed > GPS_ABSURD_KMH) { out.set(i, "absurd"); continue; }
    const prev = k > 0 ? points[idx[k - 1]] : null;
    const next = k + 1 < idx.length ? points[idx[k + 1]] : null;
    if (!prev || !next) continue;
    const dtPrev = p.ts - prev.ts, dtNext = next.ts - p.ts;
    if (dtPrev <= 0 || dtNext <= 0 || dtPrev > SPIKE_NEIGHBOUR_MAX_GAP_S || dtNext > SPIKE_NEIGHBOUR_MAX_GAP_S) continue;
    const up = (p.speed - prev.speed) / Math.max(1, dtPrev);
    const down = (p.speed - next.speed) / Math.max(1, dtNext);
    if (up > MAX_SPEED_JUMP_KMH_PER_S && down > MAX_SPEED_JUMP_KMH_PER_S) out.set(i, "jump");
  }
  return out;
}

/** Velocidade de um ponto em que se pode confiar (0 = não conta: imprecisa, sem velocidade ou pico falso). PURA. */
export function trustedSpeedOf(points: readonly SpeedPoint[], i: number, spikes: ReadonlyMap<number, SpikeReason>): number {
  const p = points[i];
  return p && hasSpeed(p) && !spikes.has(i) ? p.speed : 0;
}

/**
 * Velocidade máxima sem picos falsos (e o instante). Com a `rule`, um ponto
 * acima do limite só conta se fizer parte de um EXCESSO (shared → speedExcesses):
 * a máxima mostrada nunca é um ponto solto por confirmar. PURA.
 */
export function trustedMaxSpeed(
  points: readonly SpeedPoint[],
  o: { include?: (i: number) => boolean; spikes?: ReadonlyMap<number, SpikeReason>; rule?: SpeedRule } = {},
): { maxSpeed: number; maxAt: number | null } {
  const spikes = o.spikes ?? speedSpikes(points);
  const threshold = o.rule ? speedThresholdOf(o.rule) : Number.POSITIVE_INFINITY;
  const inExcess = o.rule ? new Set(speedExcesses(points, o.rule, { include: o.include, spikes }).flatMap((e) => e.indices)) : null;
  let maxSpeed = 0, maxAt: number | null = null;
  points.forEach((p, i) => {
    if (o.include && !o.include(i)) return;
    const v = trustedSpeedOf(points, i, spikes);
    if (v > threshold && inExcess && !inExcess.has(i)) return;
    if (v > maxSpeed) { maxSpeed = v; maxAt = p.ts; }
  });
  return { maxSpeed: Math.round(maxSpeed * 100) / 100, maxAt };
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371, dLat = ((lat2 - lat1) * Math.PI) / 180, dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Velocidade pela posição entre dois pontos (km/h), ou null quando não dá para a medir bem. PURA. */
export function impliedSpeedKmh(a: SpeedPoint, b: SpeedPoint): number | null {
  const dt = Math.abs(b.ts - a.ts);
  if (!a.accurate || !b.accurate || a.lat == null || a.lon == null || b.lat == null || b.lon == null) return null;
  if (dt < POSITION_MIN_GAP_S || dt > POSITION_MAX_GAP_S) return null;
  return (haversineKm(a.lat, a.lon, b.lat, b.lon) / dt) * 3600;
}

export interface SpeedExcess {
  /** início e fim (s) dos pontos acima do limite */
  startTs: number;
  endTs: number;
  maxSpeed: number;
  maxAt: number;
  /** pontos de confiança acima do limite */
  points: number;
  lat: number | null;
  lon: number | null;
  /** "points" = pontos suficientes; "position" = um ponto, confirmado pela distância percorrida */
  confirmedBy: "points" | "position";
  /** índices (na lista dada) dos pontos acima do limite deste excesso */
  indices: number[];
}

/**
 * Excessos de velocidade (pontos ORDENADOS pelo tempo). `include` limita a
 * uma pessoa ou a uma janela (os picos decidem-se com todos os pontos). PURA.
 */
export function speedExcesses(
  points: readonly SpeedPoint[],
  rule: SpeedRule,
  o: { include?: (i: number) => boolean; spikes?: ReadonlyMap<number, SpikeReason> } = {},
): SpeedExcess[] {
  const threshold = speedThresholdOf(rule);
  const minPoints = Math.max(1, Math.floor(Number(rule.minPoints) || 1));
  const spikes = o.spikes ?? speedSpikes(points);
  const out: SpeedExcess[] = [];
  let cur: { start: number; end: number; max: number; maxAt: number; maxIdx: number; n: number; lastAbove: number; firstIdx: number; indices: number[] } | null = null;
  const confirmedByPosition = (i: number): boolean => {
    const p = points[i];
    const near = [i - 1, i + 1].map((j) => points[j]).filter((q): q is SpeedPoint => !!q);
    return near.some((q) => { const v = impliedSpeedKmh(q, p); return v != null && v > threshold && v <= GPS_ABSURD_KMH; });
  };
  const close = () => {
    if (!cur) return;
    const byPoints = cur.n >= minPoints;
    if (byPoints || (cur.n === 1 && confirmedByPosition(cur.firstIdx))) {
      const mp = points[cur.maxIdx];
      out.push({ startTs: cur.start, endTs: cur.end, maxSpeed: Math.round(cur.max * 100) / 100, maxAt: cur.maxAt, points: cur.n,
        lat: mp.lat ?? null, lon: mp.lon ?? null, confirmedBy: byPoints ? "points" : "position", indices: cur.indices });
    }
    cur = null;
  };
  points.forEach((p, i) => {
    if (o.include && !o.include(i)) return;
    const v = trustedSpeedOf(points, i, spikes);
    if (!(v > threshold)) return;
    if (cur && p.ts - cur.lastAbove <= EXCESS_MERGE_GAP_S) {
      cur.n++; cur.end = p.ts; cur.lastAbove = p.ts; cur.indices.push(i);
      if (v > cur.max) { cur.max = v; cur.maxAt = p.ts; cur.maxIdx = i; }
      return;
    }
    close();
    cur = { start: p.ts, end: p.ts, max: v, maxAt: p.ts, maxIdx: i, n: 1, lastAbove: p.ts, firstIdx: i, indices: [i] };
  });
  close();
  return out;
}
