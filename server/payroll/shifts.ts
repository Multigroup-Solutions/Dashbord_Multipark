/**
 * TURNOS a partir dos registos de ponto — regras puras.
 *
 * Antes, o payroll classificava TODO o turno pela hora do check-out: um turno
 * 20h→08h dava 12 h "normais" e 0 noturnas. Aqui cada turno é repartido pelos
 * intervalos REAIS (minuto a minuto, em Europe/Lisbon): noite 22h–07h, fim de
 * semana sábado/domingo (prevalece sobre a noite), resto normal. Um turno que
 * atravessa a meia-noite, o fim de semana ou o mês é dividido corretamente.
 */

export interface TimeRecordLike {
  id: number;
  type: "check_in" | "check_out";
  recordedAt: string;                 // "YYYY-MM-DD HH:MM:SS" (UTC, como está na BD)
  hoursWorked?: string | number | null;
  notes?: string | null;
  reviewStatus?: "ok" | "suspicious" | "approved" | "rejected" | null;
}

export type ShiftStatus = "ok" | "open" | "suspicious" | "approved" | "rejected";

export interface Shift {
  inId: number;
  outId: number | null;
  inAt: string;
  outAt: string | null;
  hours: number;                       // horas efetivas (0 se aberto)
  status: ShiftStatus;
  /** dia de calendário (Lisboa) em que o turno COMEÇOU */
  day: string;
  split: { normal: number; night: number; weekend: number };
  daysTouched: string[];               // dias de calendário abrangidos (Lisboa)
  notes: string | null;
}

const NIGHT_START = 22, NIGHT_END = 7;

const lisbonFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", weekday: "short", hour12: false,
});

/** Dia, hora e dia-da-semana em Lisboa para um instante. */
export function lisbonParts(d: Date): { day: string; hour: number; weekend: boolean } {
  const p = lisbonFmt.formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  const hour = Number(g("hour")) % 24;
  const wd = g("weekday");
  return { day: `${g("year")}-${g("month")}-${g("day")}`, hour, weekend: wd === "Sat" || wd === "Sun" };
}

export function parseDbDate(s: string): Date {
  // a BD guarda "YYYY-MM-DD HH:MM:SS" em UTC
  return new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
}

/**
 * Reparte [inAt, outAt) em normal / noite / fim de semana, minuto a minuto.
 * Fim de semana prevalece sobre a noite (buckets mutuamente exclusivos).
 */
export function splitShiftHours(inAt: Date, outAt: Date): { normal: number; night: number; weekend: number; days: string[] } {
  let normalMin = 0, nightMin = 0, weekendMin = 0;
  const days = new Set<string>();
  const totalMin = Math.max(0, Math.round((outAt.getTime() - inAt.getTime()) / 60000));
  // passo de 1 minuto; turnos ≤ 24 h → ≤ 1440 iterações
  for (let m = 0; m < totalMin; m++) {
    const t = new Date(inAt.getTime() + m * 60000 + 30000); // meio do minuto
    const { day, hour, weekend } = lisbonParts(t);
    days.add(day);
    if (weekend) weekendMin++;
    else if (hour >= NIGHT_START || hour < NIGHT_END) nightMin++;
    else normalMin++;
  }
  const r = (v: number) => Math.round((v / 60) * 100) / 100;
  return { normal: r(normalMin), night: r(nightMin), weekend: r(weekendMin), days: Array.from(days).sort() };
}

/**
 * Emparelha entradas e saídas em turnos, por ordem cronológica.
 *  - check_in seguido de check_out → turno fechado (hours = do registo de
 *    saída se existir, senão diferença real);
 *  - check_in sem saída → turno ABERTO (0 h, não conta dia nem subsídio);
 *  - check_out sem entrada → ignorado (fica em `orphans`);
 *  - "[SUSPEITO]" nas notas ou reviewStatus=suspicious → status suspicious
 *    (excluído das horas aprovadas até revisão); approved conta; rejected não.
 */
export function pairShifts(records: TimeRecordLike[]): { shifts: Shift[]; orphans: TimeRecordLike[] } {
  const sorted = [...records].sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : a.id - b.id));
  const shifts: Shift[] = [];
  const orphans: TimeRecordLike[] = [];
  let open: TimeRecordLike | null = null;
  const statusOf = (rec: TimeRecordLike | null, out: TimeRecordLike | null): ShiftStatus => {
    const rs = out?.reviewStatus ?? rec?.reviewStatus ?? null;
    if (rs === "approved") return "approved";
    if (rs === "rejected") return "rejected";
    const notes = `${rec?.notes ?? ""} ${out?.notes ?? ""}`;
    if (rs === "suspicious" || /\[SUSPEITO\]/.test(notes)) return "suspicious";
    return "ok";
  };
  for (const r of sorted) {
    if (r.type === "check_in") {
      if (open) {
        // entrada sobre entrada: a anterior fica aberta
        const inD = parseDbDate(open.recordedAt);
        const { day } = lisbonParts(inD);
        shifts.push({ inId: open.id, outId: null, inAt: open.recordedAt, outAt: null, hours: 0, status: "open", day, split: { normal: 0, night: 0, weekend: 0 }, daysTouched: [day], notes: open.notes ?? null });
      }
      open = r;
      continue;
    }
    if (!open) { orphans.push(r); continue; }
    const inD = parseDbDate(open.recordedAt), outD = parseDbDate(r.recordedAt);
    const recHours = r.hoursWorked != null ? Number(r.hoursWorked) : NaN;
    const realHours = Math.max(0, (outD.getTime() - inD.getTime()) / 3600000);
    // a saída pode ter sido "cortada a 12h" (hoursWorked < real): respeita o registo
    const hours = Number.isFinite(recHours) && recHours > 0 ? Math.min(recHours, Math.max(realHours, recHours)) : Math.round(realHours * 100) / 100;
    const effectiveOut = Number.isFinite(recHours) && recHours > 0 && recHours < realHours - 0.01 ? new Date(inD.getTime() + recHours * 3600000) : outD;
    const sp = splitShiftHours(inD, effectiveOut);
    const { day } = lisbonParts(inD);
    shifts.push({
      inId: open.id, outId: r.id, inAt: open.recordedAt, outAt: r.recordedAt, hours: Math.round(hours * 100) / 100,
      status: statusOf(open, r), day, split: { normal: sp.normal, night: sp.night, weekend: sp.weekend }, daysTouched: sp.days,
      notes: [open.notes, r.notes].filter(Boolean).join(" · ") || null,
    });
    open = null;
  }
  if (open) {
    const inD = parseDbDate(open.recordedAt);
    const { day } = lisbonParts(inD);
    shifts.push({ inId: open.id, outId: null, inAt: open.recordedAt, outAt: null, hours: 0, status: "open", day, split: { normal: 0, night: 0, weekend: 0 }, daysTouched: [day], notes: open.notes ?? null });
  }
  return { shifts, orphans };
}

/** Só os turnos que contam para pagamento (fechados e não suspeitos/rejeitados). */
export function countableShifts(shifts: Shift[]): Shift[] {
  return shifts.filter((s) => s.outId != null && (s.status === "ok" || s.status === "approved"));
}
