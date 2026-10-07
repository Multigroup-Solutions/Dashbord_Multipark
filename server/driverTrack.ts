/**
 * Lote 43a — Histórico Diário → Trajeto (Jorge, 7 out 2026: "crie qualquer
 * coisa que isto leia logo o JSON e que nos ponha as velocidades num mapa"):
 * lê o GeoJSON do Zello guardado na recolha (no servidor: o ficheiro é
 * privado) e devolve os pontos do dia, já poucos para o mapa. Só leitura.
 */
import { gpsPointsFromGeoJson, MAX_PLAUSIBLE_KMH, type GpsPoint } from "./zelloGps";

export interface TrackPoint { lat: number; lng: number; speed: number; ts: number }
export interface DriverTrack {
  id: number;
  name: string;
  date: string;
  points: TrackPoint[];
  /** pontos com posição no ficheiro (antes de reduzir) */
  total: number;
  maxSpeed: number;
  maxAt: number | null;
  threshold: number | null;
}

/** No máximo tantos pontos no mapa (um dia pode ter dezenas de milhares). */
export const TRACK_MAX_POINTS = 2500;

/**
 * Pontos com posição e precisão aceitável → no máximo `max`, por igual ao
 * longo do dia, guardando SEMPRE o primeiro, o último e os que passaram o
 * limite de velocidade (os excessos não desaparecem por reduzir). Velocidades
 * acima do plausível (erro do GPS) contam como 0. PURA.
 */
export function downsampleTrack(points: readonly GpsPoint[], max: number, threshold: number | null): TrackPoint[] {
  const ok = points.filter((p) => p.accurate && p.lat != null && p.lon != null)
    .map((p) => ({ lat: p.lat!, lng: p.lon!, speed: p.speed > MAX_PLAUSIBLE_KMH ? 0 : Math.round(p.speed), ts: p.ts }));
  if (ok.length <= max) return ok;
  const keep = new Set<number>([0, ok.length - 1]);
  if (threshold != null) ok.forEach((p, i) => { if (p.speed > threshold) keep.add(i); });
  const room = Math.max(0, max - keep.size);
  const step = ok.length / Math.max(1, room);
  for (let i = 0; i < room; i++) keep.add(Math.min(ok.length - 1, Math.floor(i * step)));
  return [...keep].sort((a, b) => a - b).slice(0, Math.max(max, keep.size)).map((i) => ok[i]);
}

export type TrackResult = { ok: true; track: DriverTrack } | { ok: false; reason: string };

/** O trajeto de uma linha do Histórico Diário (no âmbito de quem pede). */
export async function loadDriverTrack(id: number): Promise<TrackResult> {
  const { getDailyDriverHistoryRow } = await import("./db");
  const row: any = await getDailyDriverHistoryRow(id);
  if (!row) return { ok: false, reason: "Este registo não existe ou não está no teu acesso." };
  if (!row.geoJsonUrl) return { ok: false, reason: "Este dia não tem trajeto guardado (sem pontos GPS na recolha)." };
  const { storageReadableUrl } = await import("./storageSign");
  let data: any;
  try {
    const res = await fetch(await storageReadableUrl(String(row.geoJsonUrl)), { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { ok: false, reason: `Não deu para ler o trajeto (HTTP ${res.status}).` };
    data = await res.json();
  } catch (err) {
    return { ok: false, reason: `Não deu para ler o trajeto: ${String((err as Error)?.message ?? err).slice(0, 120)}` };
  }
  const { speedThreshold } = await import("./dayActivity");
  const threshold = await speedThreshold().catch(() => null);
  const all = gpsPointsFromGeoJson(data);
  const points = downsampleTrack(all, TRACK_MAX_POINTS, threshold);
  let maxSpeed = 0, maxAt: number | null = null;
  for (const p of points) if (p.speed > maxSpeed) { maxSpeed = p.speed; maxAt = p.ts; }
  const date = typeof row.date === "string" ? row.date.slice(0, 10) : new Date(row.date).toISOString().slice(0, 10);
  return {
    ok: true,
    track: {
      id, name: String(row.employeeName || row.displayName || row.zelloUsername), date,
      points, total: all.filter((p) => p.lat != null).length, maxSpeed, maxAt, threshold,
    },
  };
}
