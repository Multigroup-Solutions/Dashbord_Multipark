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
 *   - **Semântica do filtro = SOBREPOSIÇÃO, não cobertura total** (Jorge,
 *     2026-09-17): "das 2h às 10h" mostra quem pode em ALGUM momento entre as
 *     2h e as 10h — quem só pode das 5h às 10h conta. Alargar a janela pedida
 *     nunca pode fazer desaparecer gente (era o que acontecia com a regra
 *     "tem de cobrer o pedido inteiro": 5h–10h dava 5 pessoas, 2h–10h dava 2).
 *     Tocar sem sobrepor não conta (manhã 03–15 vs pedido 15–20 → não).
 *   - **Semântica de CALENDÁRIO em todo o lado** (Jorge, 7 out 2026, opção B
 *     do pedido 7): o que o extra marca num dia é ESSE dia de calendário —
 *     "terça 00h–03h" é a madrugada de terça (noite de segunda para a escala).
 *     O dia OPERACIONAL D (03h de D → 03h de D+1, horas 3–27) junta as horas
 *     [3, 24) das linhas de D, as horas [0, 3) das linhas de D+1 (como 24–27)
 *     e a ponta de uma linha de D−1 que atravesse a meia-noite para lá das 03h.
 *     Uma só função (`operationalDayWindows`) serve a grelha/filtro, a escala
 *     automática, o "Preencher com disponíveis" e os candidatos do Extras-dia.
 */

export const SHIFT_MORNING = { from: 3, to: 15 } as const;
export const SHIFT_NIGHT = { from: 15, to: 27 } as const; // 15h → 03h do dia seguinte
/** Dia operacional em horas estendidas: 03h do dia → 03h do dia seguinte. */
export const OPERATIONAL_DAY = { from: 3, to: 27 } as const;

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
 * Janelas em que a pessoa disse estar disponível nesse dia (horas estendidas,
 * relativas às 00h desse dia de calendário), já fundidas quando se tocam.
 * Vazio = não marcou nada nesse dia.
 *
 *  - das + às → a janela exata (os turnos não a alargam);
 *  - só turnos → os turnos;
 *  - uma hora sozinha com turnos → os turnos (a hora solta é ruído);
 *  - uma hora sozinha SEM turnos → janela aberta: "a partir das X" vai até ao
 *    fim da noite (03h do dia seguinte); "até às Y" começa às 03h desse dia.
 *    (Antes a grelha ignorava-a e a escala lia-a como aberta — divergiam.)
 */
export function dayWindows(d: Pick<AvailabilityDayLike, "morning" | "night" | "fromHour" | "toHour">): HourWindow[] {
  if (isHour(d.fromHour) && isHour(d.toHour)) return [toExtendedWindow(d.fromHour, d.toHour)];
  const windows: HourWindow[] = [];
  if (d.morning) windows.push({ ...SHIFT_MORNING });
  if (d.night) windows.push({ ...SHIFT_NIGHT });
  if (windows.length) return mergeWindows(windows);
  if (isHour(d.fromHour)) return [{ from: d.fromHour, to: OPERATIONAL_DAY.to }];
  if (isHour(d.toHour)) return [{ from: OPERATIONAL_DAY.from, to: d.toHour <= OPERATIONAL_DAY.from ? d.toHour + 24 : d.toHour }];
  return [];
}

const shiftWindows = (windows: HourWindow[], by: number): HourWindow[] => windows.map((w) => ({ from: w.from + by, to: w.to + by }));

/** "AAAA-MM-DD" + n dias (UTC ao meio-dia: imune à hora de verão). */
function addDayIso(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Tudo o que a pessoa marcou à volta do dia de calendário `day`, em horas
 * relativas às 00h desse dia: as linhas do dia anterior (−24), do próprio dia
 * e do dia seguinte (+24). É a ÚNICA leitura de calendário — o filtro da
 * grelha e o dia operacional da escala saem daqui. `days` pode vir por
 * qualquer ordem (procura-se pela data).
 */
export function windowsAroundDay(days: readonly AvailabilityDayLike[], day: string): HourWindow[] {
  const at = (iso: string) => days.find((d) => d.day === iso);
  const prev = at(addDayIso(day, -1));
  const cur = at(day);
  const next = at(addDayIso(day, 1));
  return mergeWindows([
    ...(prev ? shiftWindows(dayWindows(prev), -24) : []),
    ...(cur ? dayWindows(cur) : []),
    ...(next ? shiftWindows(dayWindows(next), 24) : []),
  ]);
}

/**
 * Janelas da pessoa no dia OPERACIONAL `day` (03h de `day` → 03h do dia
 * seguinte = horas 3–27). Ex.: "terça 00h–03h" conta para a noite de
 * segunda (24–27); "segunda 02h–10h" dá 03–10 na segunda e 26–27 no domingo.
 * Vazio = não pode nesse dia operacional. PURA.
 */
export function operationalDayWindows(days: readonly AvailabilityDayLike[], day: string): HourWindow[] {
  const out: HourWindow[] = [];
  for (const w of windowsAroundDay(days, day)) {
    const from = Math.max(OPERATIONAL_DAY.from, w.from);
    const to = Math.min(OPERATIONAL_DAY.to, w.to);
    if (to > from) out.push({ from, to });
  }
  return out;
}

/** Pode na hora operacional `hour` (3–26) do dia operacional? PURA. */
export function inWindows(windows: readonly HourWindow[], hour: number): boolean {
  return windows.some((w) => w.from <= hour && hour < w.to);
}

const hh = (h: number) => `${String(((h % 24) + 24) % 24).padStart(2, "0")}h`;

/** "18h–01h", "03h–15h e 20h–03h" (horas estendidas → relógio). Vazio = "". PURA. */
export function describeWindows(windows: readonly HourWindow[]): string {
  return windows.map((w) => `${hh(w.from)}–${hh(w.to)}`).join(" e ");
}

/**
 * O que a célula da grelha mostra para um dia: com horas indicadas, as horas
 * reais (sem sol/lua — o slot do site "18H-01H" ficava com a lua de
 * "Noite 15h–03h" e parecia cobrir até às 03h); só com turnos, os ícones. PURA.
 */
export function availabilityCellDisplay(d: Pick<AvailabilityDayLike, "morning" | "night" | "fromHour" | "toHour">): { morning: boolean; night: boolean; hours: string | null } {
  const exact = isHour(d.fromHour) && isHour(d.toHour);
  const hasShift = d.morning || d.night;
  const single = !hasShift && (isHour(d.fromHour) || isHour(d.toHour));
  return {
    morning: !exact && d.morning,
    night: !exact && d.night,
    hours: exact || single ? describeWindows(dayWindows(d)) : null,
  };
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

/** `outer` contém `inner` por inteiro (mantido para quem precise de cobertura total). */
export function windowCovers(outer: HourWindow, inner: HourWindow): boolean {
  return outer.from <= inner.from && outer.to >= inner.to;
}

/** As duas janelas partilham pelo menos uma hora (tocar nas pontas não conta). */
export function windowsOverlap(a: HourWindow, b: HourWindow): boolean {
  return a.from < b.to && b.from < a.to;
}

/**
 * A pessoa pode em algum momento do pedido `wanted` (horas estendidas do dia
 * `index`)? Lê o calendário à volta do dia (`windowsAroundDay`): quem marcou
 * "noite" na segunda conta para um pedido "00h–04h" de terça, e quem marcou
 * "quarta 00h–03h" conta para um pedido "terça 22h–02h".
 */
export function overlapsOnDay(days: AvailabilityDayLike[], index: number, wanted: HourWindow): boolean {
  const today = days[index];
  if (!today) return false;
  return windowsAroundDay(days, today.day).some((w) => windowsOverlap(w, wanted));
}

/**
 * Filtro "disponível das X às Y": com `day` (YYYY-MM-DD) só esse dia conta;
 * com `day = null`, basta poder em QUALQUER dia da semana.
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
    return index >= 0 && overlapsOnDay(days, index, wanted);
  }
  return days.some((_, i) => overlapsOnDay(days, i, wanted));
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
