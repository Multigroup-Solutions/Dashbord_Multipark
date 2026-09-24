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
/** Acima disto é ruído (não há condutores a 150 km/h num parque). */
export const MAX_PLAUSIBLE_KMH = 150;

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
    const byEmp = acc.get(c.zello) ?? new Map<number, number>();
    byEmp.set(c.employeeId, (byEmp.get(c.employeeId) ?? 0) + (to - from));
    acc.set(c.zello, byEmp);
  }
  const out = new Map<string, number>();
  for (const [zello, byEmp] of acc) {
    let best: [number, number] | null = null;
    for (const [emp, ms] of byEmp) if (!best || ms > best[1]) best = [emp, ms];
    if (best) out.set(zello, best[0]);
  }
  return out;
}
