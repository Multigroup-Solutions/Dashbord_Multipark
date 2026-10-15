/**
 * Dias livres HABITUAIS (Jorge, 8 out 2026): "um esboço da escala dele, onde
 * ele pode colocar os dias que tem livres. Não precisa de ser os dias exatos —
 * ex.: tenho livres as terças-feiras à tarde e as quartas de manhã, e todos os
 * fins de semana."
 *
 * Não são datas: dias da semana (Seg..Dom) × períodos do dia de calendário,
 * como a pessoa os pensa:
 *   Manhã = até às 12h · Tarde = 12h–19h · Noite = depois das 19h.
 *
 * É só uma DICA para quem escala (o resumo aparece quando a pessoa ainda não
 * preencheu a semana concreta). Nunca entra na escala automática nem muda a
 * disponibilidade por semana (extras_availability).
 *
 * Turnos do sistema (shared/availabilityWindow.ts): manhã 03h–15h, noite
 * 15h–03h. Cobertura (só para dicas): o turno da manhã ⇐ Manhã; o da noite ⇐
 * Tarde ou Noite.
 *
 * Guarda-se como JSON em texto ({"tue":["afternoon"],"sat":["morning",…]}),
 * sempre normalizado (só dias/períodos válidos, pela ordem da semana, sem
 * dias vazios). Tudo aqui é PURO.
 */
import { z } from "zod";

export const PATTERN_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type PatternDay = (typeof PATTERN_DAYS)[number];

export const PATTERN_PERIODS = ["morning", "afternoon", "night"] as const;
export type PatternPeriod = (typeof PATTERN_PERIODS)[number];

/** Dia da semana → períodos livres. Dias sem nada não aparecem. */
export type PatternSlots = Partial<Record<PatternDay, PatternPeriod[]>>;

export const PATTERN_DAY_LABELS: Record<PatternDay, { short: string; long: string }> = {
  mon: { short: "Seg", long: "Segunda" },
  tue: { short: "Ter", long: "Terça" },
  wed: { short: "Qua", long: "Quarta" },
  thu: { short: "Qui", long: "Quinta" },
  fri: { short: "Sex", long: "Sexta" },
  sat: { short: "Sáb", long: "Sábado" },
  sun: { short: "Dom", long: "Domingo" },
};

export const PATTERN_PERIOD_LABELS: Record<PatternPeriod, { label: string; word: string; hours: string; phrase: string }> = {
  morning: { label: "Manhã", word: "manhã", hours: "até às 12h", phrase: "de manhã" },
  afternoon: { label: "Tarde", word: "tarde", hours: "12h–19h", phrase: "à tarde" },
  night: { label: "Noite", word: "noite", hours: "depois das 19h", phrase: "à noite" },
};

/** Nota livre curta ("não posso em agosto"). */
export const PATTERN_NOTE_MAX = 300;

// ─── Validação (zod) ─────────────────────────────────────────────────────────

const periodsSchema = z.array(z.enum(PATTERN_PERIODS)).max(PATTERN_PERIODS.length);

/** Só os 7 dias; cada um com até 3 períodos válidos. Chaves desconhecidas são recusadas. */
export const patternSlotsSchema = z.strictObject({
  mon: periodsSchema.optional(),
  tue: periodsSchema.optional(),
  wed: periodsSchema.optional(),
  thu: periodsSchema.optional(),
  fri: periodsSchema.optional(),
  sat: periodsSchema.optional(),
  sun: periodsSchema.optional(),
});

/** O que se grava: a grelha e a nota (vazia = sem nota). */
export const patternInputSchema = z.object({
  slots: patternSlotsSchema,
  note: z.string().max(PATTERN_NOTE_MAX).nullable().optional(),
});
export type PatternInput = z.infer<typeof patternInputSchema>;

// ─── Forma canónica ──────────────────────────────────────────────────────────

/** Só dias e períodos válidos, sem repetidos, pela ordem da semana; dias vazios saem. */
export function normalizeSlots(input: unknown): PatternSlots {
  const out: PatternSlots = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  const src = input as Record<string, unknown>;
  for (const day of PATTERN_DAYS) {
    const raw = src[day];
    if (!Array.isArray(raw)) continue;
    const periods = PATTERN_PERIODS.filter((p) => raw.includes(p));
    if (periods.length) out[day] = periods;
  }
  return out;
}

/** Texto da BD → grelha (texto estragado = grelha vazia, nunca erro). */
export function parseSlots(json: string | null | undefined): PatternSlots {
  if (!json) return {};
  try {
    return normalizeSlots(JSON.parse(json));
  } catch {
    return {};
  }
}

/** Grelha → texto para a BD (sempre normalizado). */
export function serializeSlots(slots: PatternSlots): string {
  return JSON.stringify(normalizeSlots(slots));
}

export function isEmptyPattern(slots: PatternSlots): boolean {
  return PATTERN_DAYS.every((d) => !slots[d]?.length);
}

export function hasSlot(slots: PatternSlots, day: PatternDay, period: PatternPeriod): boolean {
  return !!slots[day]?.includes(period);
}

/** Liga/desliga uma casa da grelha. */
export function toggleSlot(slots: PatternSlots, day: PatternDay, period: PatternPeriod): PatternSlots {
  const cur = slots[day] ?? [];
  const next = cur.includes(period) ? cur.filter((p) => p !== period) : [...cur, period];
  return normalizeSlots({ ...slots, [day]: next });
}

// ─── Atalhos ─────────────────────────────────────────────────────────────────

export type PatternShortcut = "weekends" | "weekdays" | "everyday" | "clear";

export const PATTERN_SHORTCUTS: ReadonlyArray<{ id: PatternShortcut; label: string }> = [
  { id: "weekends", label: "Fins de semana" },
  { id: "weekdays", label: "Dias úteis" },
  { id: "everyday", label: "Todos os dias" },
  { id: "clear", label: "Limpar" },
];

const SHORTCUT_DAYS: Record<Exclude<PatternShortcut, "clear">, readonly PatternDay[]> = {
  weekends: ["sat", "sun"],
  weekdays: ["mon", "tue", "wed", "thu", "fri"],
  everyday: PATTERN_DAYS,
};

/** Os dias do atalho já estão todos marcados o dia todo? ("Limpar" = a grelha está vazia.) */
export function shortcutActive(slots: PatternSlots, id: PatternShortcut): boolean {
  if (id === "clear") return isEmptyPattern(slots);
  return SHORTCUT_DAYS[id].every((d) => (slots[d]?.length ?? 0) === PATTERN_PERIODS.length);
}

/**
 * "Fins de semana" / "Dias úteis" / "Todos os dias" marcam esses dias o dia
 * todo e SOMAM ao que já está ("terças à tarde" + "Fins de semana" ficam os
 * dois). Se esses dias já estavam todos marcados, desmarcam-nos (tocar outra
 * vez desfaz). "Limpar" tira tudo.
 */
export function applyShortcut(slots: PatternSlots, id: PatternShortcut): PatternSlots {
  if (id === "clear") return {};
  const days = SHORTCUT_DAYS[id];
  const next: PatternSlots = { ...normalizeSlots(slots) };
  const undo = shortcutActive(next, id);
  for (const d of days) {
    if (undo) delete next[d];
    else next[d] = [...PATTERN_PERIODS];
  }
  return normalizeSlots(next);
}

// ─── Resumo legível ──────────────────────────────────────────────────────────

/** "a", "a e b", "a, b e c". */
function joinPt(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
}

/** "manhã", "tarde e noite", "todo o dia" (vazio = ""). */
export function describePeriods(periods: readonly PatternPeriod[]): string {
  const ps = PATTERN_PERIODS.filter((p) => periods.includes(p));
  if (ps.length === PATTERN_PERIODS.length) return "todo o dia";
  return joinPt(ps.map((p) => PATTERN_PERIOD_LABELS[p].word));
}

/** "Seg a Sex" (3 ou mais seguidos), "Sáb e Dom", "Seg, Qua e Sex". */
function describeDays(days: readonly PatternDay[]): string {
  const idx = days.map((d) => PATTERN_DAYS.indexOf(d)).sort((a, b) => a - b);
  const short = (i: number) => PATTERN_DAY_LABELS[PATTERN_DAYS[i]].short;
  const parts: string[] = [];
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++;
    if (j - i >= 2) parts.push(`${short(idx[i])} a ${short(idx[j])}`);
    else for (let k = i; k <= j; k++) parts.push(short(idx[k]));
    i = j + 1;
  }
  return joinPt(parts);
}

/** "Todos os dias" / "Dias úteis" / "Fins de semana" quando os dias são exatamente esses. */
function namedDays(days: readonly PatternDay[]): string | null {
  const key = [...days].sort((a, b) => PATTERN_DAYS.indexOf(a) - PATTERN_DAYS.indexOf(b)).join(",");
  if (key === PATTERN_DAYS.join(",")) return "Todos os dias";
  if (key === SHORTCUT_DAYS.weekdays.join(",")) return "Dias úteis";
  if (key === SHORTCUT_DAYS.weekends.join(",")) return "Fins de semana";
  return null;
}

/**
 * Resumo da grelha. Junta os dias com os mesmos períodos, pela ordem do
 * primeiro dia de cada grupo:
 *   - completo: "Ter tarde · Qua manhã · Sáb e Dom todo o dia";
 *   - curto (`short`, para listas): usa "Fins de semana", "Dias úteis" e
 *     "Todos os dias" — "Ter tarde · Fins de semana" (o dia todo não se diz),
 *     "Dias úteis de manhã".
 * Grelha vazia = "".
 */
export function summarizePattern(slots: PatternSlots, opts: { short?: boolean } = {}): string {
  const clean = normalizeSlots(slots);
  const groups: Array<{ periods: PatternPeriod[]; days: PatternDay[] }> = [];
  for (const day of PATTERN_DAYS) {
    const ps = clean[day];
    if (!ps) continue;
    const key = ps.join(",");
    const g = groups.find((x) => x.periods.join(",") === key);
    if (g) g.days.push(day);
    else groups.push({ periods: ps, days: [day] });
  }
  return groups
    .map((g) => {
      const named = opts.short ? namedDays(g.days) : null;
      if (named) {
        if (g.periods.length === PATTERN_PERIODS.length) return named;
        return `${named} ${joinPt(g.periods.map((p) => PATTERN_PERIOD_LABELS[p].phrase))}`;
      }
      return `${describeDays(g.days)} ${describePeriods(g.periods)}`;
    })
    .join(" · ");
}

// ─── Datas e turnos do sistema (só para dicas) ───────────────────────────────

/** Dia da semana de uma data "AAAA-MM-DD" (ao meio-dia UTC: imune à hora de verão). */
export function patternDayOf(isoDate: string): PatternDay | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const d = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== isoDate) return null;
  return PATTERN_DAYS[(d.getUTCDay() + 6) % 7];
}

export type SystemShift = "morning" | "night";

/** Turno da manhã (03h–15h) ⇐ Manhã; turno da noite (15h–03h) ⇐ Tarde ou Noite. */
export const SHIFT_COVERED_BY: Record<SystemShift, readonly PatternPeriod[]> = {
  morning: ["morning"],
  night: ["afternoon", "night"],
};

/** O padrão diz que costuma estar livre nesse turno, nesse dia da semana? (só dica) */
export function patternCoversShift(slots: PatternSlots, day: PatternDay, shift: SystemShift): boolean {
  return SHIFT_COVERED_BY[shift].some((p) => hasSlot(slots, day, p));
}

/** O mesmo, para uma data concreta. Data inválida = false. */
export function patternCoversShiftOn(slots: PatternSlots, isoDate: string, shift: SystemShift): boolean {
  const day = patternDayOf(isoDate);
  return day ? patternCoversShift(slots, day, shift) : false;
}

export interface PatternDayHint {
  /** "Qui tarde e noite" — vazio quando não costuma estar livre nesse dia da semana. */
  text: string;
  /** Costuma estar livre no turno da manhã / da noite desse dia. */
  morning: boolean;
  night: boolean;
}

/** Dica para uma data (Extras-Dia): o que o padrão diz desse dia da semana. null = sem padrão ou data inválida. */
export function patternHintFor(slots: PatternSlots, isoDate: string): PatternDayHint | null {
  const day = patternDayOf(isoDate);
  if (!day || isEmptyPattern(slots)) return null;
  const periods = slots[day] ?? [];
  return {
    text: periods.length ? `${PATTERN_DAY_LABELS[day].short} ${describePeriods(periods)}` : "",
    morning: patternCoversShift(slots, day, "morning"),
    night: patternCoversShift(slots, day, "night"),
  };
}
