/**
 * Leitura dos pontos GPS do Zello — regras ÚNICAS (Fase 0, 24 set 2026).
 *
 * A API do Zello Work devolve a velocidade JÁ em km/h (por omissão e porque
 * pedimos `speedUnits=kmh`) — ver https://zellowork.com/api.htm. O código
 * multiplicava por 3,6 como se viesse em m/s: 50 km/h apareciam como 180 e
 * tudo acima de 150 era deitado fora como "ruído". Daí as velocidades malucas.
 *
 * Também: a API usa camelCase (`batteryLevel`, `lastReport`) e cada ponto traz
 * `accuracy` (metros) — pontos imprecisos não entram nos km nem na velocidade
 * calculada entre pontos (o GPS parado a "tremer" gerava picos).
 */
import { zelloKey } from "../shared/zelloKey";
import { MAX_PLAUSIBLE_KMH, STOPPED_SPEED_KMH } from "../shared/gpsRules";
import { speedExcesses, speedSpikes, trustedMaxSpeed, type SpeedRule } from "../shared/speedRules";

/**
 * 14 out 2026: o 3.º argumento das contas de velocidade é a REGRA do limite
 * (shared/speedRules.ts); um número sozinho = esse limite, sem tolerância, e
 * qualquer ponto de confiança acima dele conta (como antes, mas por excesso
 * — pontos seguidos são UM excesso — e sem os picos falsos).
 */
export function asSpeedRule(r: SpeedRule | number): SpeedRule {
  return typeof r === "number" ? { limitKmh: r, tolerancePercent: 0, minPoints: 1 } : r;
}

/** Velocidade de um report do Zello, em km/h. */
export function zelloSpeedKmh(props: Record<string, any> | null | undefined): number {
  const v = parseFloat(props?.speed);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Bateria (%) — aceita os dois formatos de nome. */
export function zelloBattery(props: Record<string, any> | null | undefined): number {
  return parseInt(props?.batteryLevel ?? props?.battery_level, 10) || 0;
}

/** Timestamp (epoch s) de um report. */
export function zelloTimestamp(props: Record<string, any> | null | undefined): number {
  return parseInt(props?.timestamp ?? props?.time ?? props?.lastReport ?? props?.last_report, 10) || 0;
}

/** Precisão máxima aceite (m) para um ponto contar nos km / velocidade implícita. */
export const MAX_ACCURACY_M = 100;
/** Intervalo mínimo (s) entre dois pontos para calcular velocidade implícita. */
export const MIN_IMPLICIT_GAP_S = 5;
// Acima de 150 km/h é ruído; abaixo de 2 km/h está parado — regras únicas em shared/gpsRules.ts.
export { MAX_PLAUSIBLE_KMH, STOPPED_SPEED_KMH };

export function zelloAccuracyOk(props: Record<string, any> | null | undefined): boolean {
  const a = parseFloat(props?.accuracy);
  return !Number.isFinite(a) || a <= 0 || a <= MAX_ACCURACY_M;
}

/**
 * Quem tinha cada Zello num dia: para cada utilizador Zello, o funcionário com
 * MAIS tempo de check-in no PDA nesse dia (os PDAs são partilhados entre turnos).
 * PURA. `dayStart`/`dayEnd` em ms; check-in aberto conta até `now`.
 */
export function holdersForDay(
  checkins: { zello: string | null; employeeId: number | null; start: number; end: number | null }[],
  dayStart: number,
  dayEnd: number,
  now: number = Date.now(),
): Map<string, number> {
  const acc = new Map<string, Map<number, number>>();
  for (const c of checkins) {
    if (!c.zello || c.employeeId == null) continue;
    const from = Math.max(c.start, dayStart);
    const to = Math.min(c.end ?? now, dayEnd);
    if (to <= from) continue;
    const k = zelloKey(c.zello); // 43b: a mesma chave em todo o lado
    const byEmp = acc.get(k) ?? new Map<number, number>();
    byEmp.set(c.employeeId, (byEmp.get(c.employeeId) ?? 0) + (to - from));
    acc.set(k, byEmp);
  }
  const out = new Map<string, number>();
  for (const [zello, byEmp] of acc) {
    let best: [number, number] | null = null;
    for (const [emp, ms] of byEmp) if (!best || ms > best[1]) best = [emp, ms];
    if (best) out.set(zello, best[0]);
  }
  return out;
}

// ─── Fase 3: GPS partido por quem tinha o PDA em cada minuto ────────────────

export interface GpsPoint { ts: number; speed: number; lat: number | null; lon: number | null; accurate: boolean }
export interface HolderInterval { employeeId: number; start: number; end: number } // ms
/**
 * `minutes` = tempo com o PDA (entre pontos); `movingMinutes` = desse, a andar
 * (> STOPPED_SPEED_KMH). 14 out 2026: `maxSpeed` sem picos falsos e
 * `violations` = EXCESSOS (shared/speedRules.ts → speedExcesses), não pontos.
 */
export interface HolderShare { employeeId: number; minutes: number; movingMinutes: number; km: number; maxSpeed: number; avgSpeed: number; violations: number; points: number }

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371, dLat = ((lat2 - lat1) * Math.PI) / 180, dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Pontos de um GeoJSON do Zello, ordenados (mesmas regras da recolha). */
export function gpsPointsFromGeoJson(data: any): GpsPoint[] {
  const out: GpsPoint[] = [];
  for (const f of data?.features ?? []) {
    const p = f?.properties ?? {};
    const ts = zelloTimestamp(p);
    if (ts <= 0) continue;
    let lat: number | null = null, lon: number | null = null;
    if (f.geometry?.type === "Point" && Array.isArray(f.geometry.coordinates)) {
      const [gLon, gLat] = f.geometry.coordinates;
      if (Number.isFinite(gLat) && Number.isFinite(gLon) && (gLat !== 0 || gLon !== 0)) { lat = gLat; lon = gLon; }
    }
    out.push({ ts, speed: zelloSpeedKmh(p), lat, lon, accurate: zelloAccuracyOk(p) });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/**
 * Parte os pontos de um dia pelos intervalos em que cada pessoa tinha o PDA.
 * Um segmento (km/minutos) só conta para alguém quando os DOIS pontos caem no
 * intervalo dessa pessoa; velocidades e excessos contam pelo ponto. PURA.
 * Pontos SEM dono (ninguém com login no PDA) e segmentos que atravessam uma
 * troca de pessoa não entram em nenhuma parte — ficam no "resto" do dia
 * (linha do dia − soma das partes, ver `leftoverFromShares`).
 */
export function splitByHolder(points: GpsPoint[], intervals: HolderInterval[], speedRule: SpeedRule | number, fallbackEmployeeId: number | null = null): HolderShare[] {
  const rule = asSpeedRule(speedRule);
  // os picos falsos decidem-se com TODOS os pontos (os vizinhos podem ser de outra pessoa)
  const spikes = speedSpikes(points);
  // 43b: fora dos check-ins o PDA é do DONO (o Zello fixo da ficha), quando o tem — "se é deles, é para ficar ligado"
  const holderAt = (tsSec: number): number | null => {
    const ms = tsSec * 1000;
    for (const i of intervals) if (ms >= i.start && ms < i.end) return i.employeeId;
    return fallbackEmployeeId;
  };
  const acc = new Map<number, { minutesS: number; movingS: number; km: number; sum: number; n: number; points: number }>();
  const get = (id: number) => {
    let a = acc.get(id);
    if (!a) { a = { minutesS: 0, movingS: 0, km: 0, sum: 0, n: 0, points: 0 }; acc.set(id, a); }
    return a;
  };
  const holders = points.map((p) => holderAt(p.ts));
  let prev: (GpsPoint & { holder: number | null }) | null = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const holder = holders[i];
    if (holder != null) {
      const a = get(holder);
      a.points++;
      if (p.accurate && p.speed > 0 && p.speed <= MAX_PLAUSIBLE_KMH) { a.sum += p.speed; a.n++; }
      if (prev && prev.holder === holder) {
        const dt = p.ts - prev.ts;
        if (dt > 0 && dt < 3600) {
          a.minutesS += dt;
          // mesma regra da linha do dia (processGeoJsonHistory): anda se o ponto anterior ia a > 2 km/h
          if (prev.speed > STOPPED_SPEED_KMH) a.movingS += dt;
          if (p.accurate && prev.accurate && p.lat != null && p.lon != null && prev.lat != null && prev.lon != null) {
            const km = haversineKm(prev.lat, prev.lon, p.lat, p.lon);
            if (km < 2 && (km / dt) * 3600 <= MAX_PLAUSIBLE_KMH) a.km += km;
          }
        }
      }
    }
    prev = { ...p, holder };
  }
  return [...acc.entries()].map(([employeeId, a]) => ({
    employeeId,
    minutes: Math.round(a.minutesS / 60),
    movingMinutes: Math.round(a.movingS / 60),
    km: Math.round(a.km * 100) / 100,
    // sem picos falsos; acima do limite só os pontos de um excesso confirmado
    maxSpeed: trustedMaxSpeed(points, { rule, spikes, include: (i) => holders[i] === employeeId }).maxSpeed,
    avgSpeed: a.n ? Math.round((a.sum / a.n) * 100) / 100 : 0,
    violations: speedExcesses(points, rule, { spikes, include: (i) => holders[i] === employeeId }).length,
    points: a.points,
  }));
}
