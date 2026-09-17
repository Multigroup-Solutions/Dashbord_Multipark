/**
 * Janela horária de disponibilidade — "quem pode trabalhar das X às Y?"
 *
 * Vocabulário PARTILHADO entre o filtro da tabela de extras (cliente) e
 * qualquer consumidor futuro no servidor. Trabalha sobre a MESMA forma de dia
 * que `getWeekOverview().extras[].days` devolve (manhã/noite + horas opcionais).
 *
 * Convenções (as da app, ver `AvailabilityDayFields`):
 *   - Turno "Manhã" = 03h–15h; turno "Noite" = 15h–03h do dia seguinte.
 *   - Horas em formato ESTENDIDO: `to <= from` significa que atravessa a
 *     meia-noite, e conta-se `to + 24` (ex.: 18h–02h → 18→26). É a mesma
 *     convenção do `SLOT_RANGES` do intake do site.
 *   - Quando a pessoa indicou horas (das/às), essas horas são a janela EXATA
 *     — os interruptores manhã/noite são a versão grosseira e não alargam o
 *     que a pessoa disse. Sem horas, valem os turnos.
 *   - Um pedido cobre-se quando UMA janela contínua da pessoa contém o pedido
 *     inteiro. Duas janelas encostadas (manhã+noite sem horas) fundem-se
 *     antes de comparar, senão "10h–18h" falhava para quem marcou os dois.
 */

export const SHIFT_MORNING = { from: 3, to: 15 } as const;
export const SHIFT_NIGHT = { from: 15, to: 27 } as const; // 15h → 03h do dia seguinte

export type AvailabilityDayLike = {
  day: string; // YYYY-MM-DD
  morning: boolean;
  night: boolean;
  fromHour: number | null;
  toHour: number | null;
};

export type HourWindow = { from: number; to: number }; // horas estendidas (to pode ser > 24)

/** 0..23, para os seletores de hora. */
export const HOUR_OPTIONS: readonly number[] = Array.from({ length: 24 }, (_, i) => i);

/** Hora inteira válida 0–23 (o que os `<Select>` de hora produzem). */
export function isHour(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 23;
}

/**
 * Normaliza um par das/às para horas estendidas. `to <= from` atravessa a
 * meia-noite (8→8 conta como 24h; 18→2 → 18→26).
 */
export function toExtendedWindow(from: number, to: number): HourWindow {
  return { from, to: to <= from ? to + 24 : to };
}

/**
 * Janelas em que a pessoa disse estar disponível nesse dia (horas estendidas),
 * já fundidas quando se tocam. Vazio = não marcou nada nesse dia.
 */
export function dayWindows(d: Pick<AvailabilityDayLike, "morning" | "night" | "fromHour" | "toHour">): HourWindow[] {
  if (isHour(d.fromHour) && isHour(d.toHour)) return [toExtendedWindow(d.fromHour, d.toHour)];
  const windows: HourWindow[] = [];
  if (d.morning) windows.push({ ...SHIFT_MORNING });
  if (d.night) windows.push({ ...SHIFT_NIGHT });
  return mergeWindows(windows);
}

/** Funde janelas que se sobrepõem ou se tocam (ordena primeiro). */
export function mergeWindows(windows: HourWindow[]): HourWindow[] {
  const sorted = [...windows].sort((a, b) => a.from - b.from);
  const out: HourWindow[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.from <= last.to) last.to = Math.max(last.to, w.to);
    else out.push({ ...w });
  }
  return out;
}

/** `outer` contém `inner` por inteiro. */
export function windowCovers(outer: HourWindow, inner: HourWindow): boolean {
  return outer.from <= inner.from && outer.to >= inner.to;
}

/**
 * A pessoa cobre o pedido `wanted` (horas estendidas do dia `index`)?
 * Considera também a janela do dia ANTERIOR quando esta atravessa a meia-noite
 * — quem marcou "noite" na segunda cobre um pedido "00h–02h" de terça.
 */
export function coversOnDay(days: AvailabilityDayLike[], index: number, wanted: HourWindow): boolean {
  const today = days[index];
  if (!today) return false;
  if (dayWindows(today).some((w) => windowCovers(w, wanted))) return true;
  const previous = days[index - 1];
  if (!previous) return false;
  return dayWindows(previous)
    .map((w) => ({ from: w.from - 24, to: w.to - 24 }))
    .some((w) => windowCovers(w, wanted));
}

/**
 * Filtro "disponível das X às Y": com `day` (YYYY-MM-DD) só esse dia conta;
 * com `day = null`, basta cobrir o pedido em QUALQUER dia da semana.
 * `days` tem de vir por ordem cronológica (é assim que a overview a devolve).
 */
export function matchesAvailabilityWindow(
  days: AvailabilityDayLike[],
  day: string | null,
  fromHour: number,
  toHour: number,
): boolean {
  const wanted = toExtendedWindow(fromHour, toHour);
  if (day) {
    const index = days.findIndex((d) => d.day === day);
    return index >= 0 && coversOnDay(days, index, wanted);
  }
  return days.some((_, i) => coversOnDay(days, i, wanted));
}

/**
 * Filtro só por dia (sem horas): marcou QUALQUER coisa nesse dia — turno ou
 * horas. É o que "quem pode na quarta?" quer dizer quando não há horário.
 */
export function isAvailableOnDay(days: AvailabilityDayLike[], day: string): boolean {
  const d = days.find((x) => x.day === day);
  return !!d && dayWindows(d).length > 0;
}

/** "08h–18h" / "18h–02h (dia seguinte)" — rótulo humano do pedido. */
export function formatHourWindow(fromHour: number, toHour: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(fromHour)}h–${pad(toHour)}h${toHour <= fromHour ? " (dia seguinte)" : ""}`;
}
