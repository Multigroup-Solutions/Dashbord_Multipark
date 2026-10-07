/**
 * Lote 43a — cores da velocidade no mapa do trajeto (Histórico Diário): um só
 * tom (azul) do mais claro ao mais escuro conforme a velocidade, e vermelho
 * acima do limite dos excessos (o limite das Definições, com a tolerância).
 * PURAS.
 */
export interface TrackPointView { lat: number; lng: number; speed: number; ts: number }
export interface SpeedBand { key: string; label: string; color: string; over: boolean }

const BLUE = ["#86b6ef", "#5598e7", "#256abf", "#104281"] as const; // rampa ordinal validada (dataviz: um tom, claro → escuro)
const OVER = "#dc2626";

/** As faixas: 0–30, 30–60, 60–90, 90–limite e acima do limite (sem limite: 90+). PURA. */
export function SPEED_BANDS(threshold: number | null): SpeedBand[] {
  const lim = threshold != null && threshold > 90 ? Math.round(threshold) : null;
  return [
    { key: "b0", label: "até 30 km/h", color: BLUE[0], over: false },
    { key: "b1", label: "30–60", color: BLUE[1], over: false },
    { key: "b2", label: "60–90", color: BLUE[2], over: false },
    { key: "b3", label: lim ? `90–${lim}` : "90+", color: BLUE[3], over: false },
    ...(lim ? [{ key: "over", label: `acima de ${lim} (excesso)`, color: OVER, over: true }] : []),
  ];
}

/** A faixa de uma velocidade. PURA. */
export function speedBand(speed: number, threshold: number | null): SpeedBand {
  const bands = SPEED_BANDS(threshold);
  const lim = threshold != null && threshold > 90 ? threshold : null;
  if (lim != null && speed > lim) return bands[4];
  if (speed < 30) return bands[0];
  if (speed < 60) return bands[1];
  if (speed < 90) return bands[2];
  return bands[3];
}
