/**
 * Indicador de necessidade de pessoal do Extras-dia (pedido 7, Jorge, 7 out
 * 2026: "aparece que precisamos de 2 pessoas para as 2h no entanto já temos 2
 * pessoas que marcaram até às 3h"). Regras PURAS, partilhadas pelo servidor
 * (server/extrasDiaShift.ts) e pelo ecrã.
 *
 * Por hora operacional (3–26; 24–26 = 00h–02h do dia seguinte):
 *   precisas N (além do TL) · escalados M · disponíveis por escalar K
 *  - N vem da previsão (extras além do team leader);
 *  - M = linhas da escala (propostas incluídas) que cobrem a hora, sem o TL;
 *    quem foi mandado para casa conta até essa hora;
 *  - K = extras da cidade que ainda não estão na escala desse dia e que, pela
 *    disponibilidade (shared/availabilityWindow.ts → operationalDayWindows,
 *    semântica de calendário), podem nessa hora.
 * O aviso distingue "faltam escalar (há quem possa)" de "falta gente
 * (ninguém disponível)".
 */
import { inWindows, type HourWindow } from "./availabilityWindow";

export const STAFFING_FROM_HOUR = 3;
export const STAFFING_TO_HOUR = 27;

export interface StaffingRow {
  employeeId: number | null;
  isTeamLeader?: boolean | number;
  startHour: number;
  endHour: number;
  sentHomeHour?: number | null;
}

export interface StaffingCandidate {
  id: number;
  name: string;
  windows: readonly HourWindow[];
}

export interface StaffingHour {
  hour: number;
  needed: number;
  scheduled: number;
  /** Ids dos disponíveis por escalar nessa hora (ordem do nome). */
  availableIds: number[];
}

export interface StaffingGap {
  fromHour: number;
  /** Exclusivo. */
  toHour: number;
  /** Quantos faltam escalar (o máximo nessas horas). */
  missing: number;
  available: { id: number; name: string }[];
}

const isTl = (r: StaffingRow) => r.isTeamLeader === true || r.isTeamLeader === 1;

/** Escalados (sem o TL) a trabalhar na hora `h`. PURA. */
export function scheduledAt(rows: readonly StaffingRow[], h: number): number {
  return rows.filter((r) => !isTl(r) && r.startHour <= h && h < (r.sentHomeHour ?? r.endHour)).length;
}

/**
 * O indicador hora a hora. `rows` = a escala da cidade nesse dia;
 * `alreadyScheduled` = quem já está em QUALQUER linha desse dia (qualquer
 * cidade/turno) — não conta como "por escalar". PURA.
 */
export function staffingByHour(input: {
  needed: readonly number[];
  rows: readonly StaffingRow[];
  candidates: readonly StaffingCandidate[];
  alreadyScheduled?: ReadonlySet<number>;
  fromHour?: number;
  toHour?: number;
}): StaffingHour[] {
  const from = input.fromHour ?? STAFFING_FROM_HOUR;
  const to = Math.min(input.toHour ?? STAFFING_TO_HOUR, STAFFING_TO_HOUR);
  const taken = new Set<number>(input.alreadyScheduled ?? []);
  for (const r of input.rows) if (r.employeeId != null) taken.add(r.employeeId);
  const free = input.candidates
    .filter((c) => !taken.has(c.id))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "pt") || a.id - b.id);
  const out: StaffingHour[] = [];
  for (let h = from; h < to; h++) {
    out.push({
      hour: h,
      needed: Math.max(0, input.needed[h] ?? 0),
      scheduled: scheduledAt(input.rows, h),
      availableIds: free.filter((c) => inWindows(c.windows, h)).map((c) => c.id),
    });
  }
  return out;
}

/**
 * Horas em que faltam escalados, juntando horas seguidas com a mesma falta e
 * os mesmos disponíveis (assim cada aviso diz exatamente quem pode). PURA.
 */
export function staffingGaps(hours: readonly StaffingHour[], candidates: readonly StaffingCandidate[]): StaffingGap[] {
  const nameOf = new Map(candidates.map((c) => [c.id, c.name]));
  const gaps: Array<StaffingGap & { key: string }> = [];
  let cur: (StaffingGap & { key: string }) | null = null;
  for (const h of hours) {
    const missing = Math.max(0, h.needed - h.scheduled);
    if (missing === 0) { cur = null; continue; }
    const key = `${missing}|${h.availableIds.join(",")}`;
    if (cur && cur.toHour === h.hour && cur.key === key) { cur.toHour = h.hour + 1; continue; }
    cur = {
      fromHour: h.hour,
      toHour: h.hour + 1,
      missing,
      available: h.availableIds.map((id) => ({ id, name: nameOf.get(id) ?? `#${id}` })),
      key,
    };
    gaps.push(cur);
  }
  return gaps.map(({ key: _key, ...g }) => g);
}

const hh = (h: number) => `${String(((h % 24) + 24) % 24).padStart(2, "0")}h`;

/** "às 02h" (uma hora) · "das 01h às 03h" (várias). PURA. */
export function gapWhen(g: Pick<StaffingGap, "fromHour" | "toHour">): string {
  return g.toHour - g.fromHour <= 1 ? `às ${hh(g.fromHour)}` : `das ${hh(g.fromHour)} às ${hh(g.toHour)}`;
}

/** "Ana, Rui, Sofia e mais 2" (primeiros nomes). PURA. */
export function namesList(people: readonly { name: string }[], max = 4): string {
  const first = people.map((p) => p.name.trim().split(/\s+/)[0] || p.name);
  const shown = first.slice(0, max).join(", ");
  return first.length > max ? `${shown} e mais ${first.length - max}` : shown;
}

/**
 * O aviso de uma falta:
 *  - "Faltam escalar 2 às 02h (há 2 disponíveis: Ana, Rui)";
 *  - "Faltam escalar 2 às 02h (só há 1 disponível: Ana)";
 *  - "Falta gente às 02h (faltam 2; ninguém disponível)". PURA.
 */
export function describeStaffingGap(g: StaffingGap): string {
  const when = gapWhen(g);
  const k = g.available.length;
  if (k === 0) return `Falta gente ${when} (${g.missing === 1 ? "falta 1" : `faltam ${g.missing}`}; ninguém disponível)`;
  const verb = g.missing === 1 ? "Falta" : "Faltam";
  const avail = `${k < g.missing ? "só há" : "há"} ${k} ${k === 1 ? "disponível" : "disponíveis"}: ${namesList(g.available)}`;
  return `${verb} escalar ${g.missing} ${when} (${avail})`;
}

/** "precisas 2 (além do TL) · escalados 1 · disponíveis por escalar 2" PURA. */
export function describeStaffingHour(h: Pick<StaffingHour, "needed" | "scheduled" | "availableIds">): string {
  return `precisas ${h.needed} (além do TL) · escalados ${h.scheduled} · disponíveis por escalar ${h.availableIds.length}`;
}

/** Estado de uma hora para a cor do indicador. PURA. */
export function staffingHourState(h: Pick<StaffingHour, "needed" | "scheduled" | "availableIds">): "ok" | "fillable" | "short" | "idle" {
  if (h.needed <= 0) return "idle";
  if (h.scheduled >= h.needed) return "ok";
  return h.availableIds.length > 0 ? "fillable" : "short";
}
