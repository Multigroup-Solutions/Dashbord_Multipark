/**
 * TURNOS a partir dos registos de ponto — regras puras.
 *
 * Antes, o payroll classificava TODO o turno pela hora do check-out: um turno
 * 20h→08h dava 12 h "normais" e 0 noturnas. Aqui cada turno é repartido pelos
 * intervalos REAIS (minuto a minuto, em Europe/Lisbon): noite 22h–07h, fim de
 * semana sábado/domingo (prevalece sobre a noite), resto normal. Um turno que
 * atravessa a meia-noite, o fim de semana ou o mês é dividido corretamente.
 */

import { pontoShiftHours } from "../../shared/pontoHours";
import { addDays, lisbonDayRangeUtc } from "../../shared/lisbonDay";

export interface TimeRecordLike {
  id: number;
  type: "check_in" | "check_out";
  recordedAt: string;                 // "YYYY-MM-DD HH:MM:SS" (UTC, como está na BD)
  hoursWorked?: string | number | null;
  notes?: string | null;
  reviewStatus?: "ok" | "suspicious" | "approved" | "rejected" | null;
  /** 0555 — terminal (aeroporto): na saída é o estado do troço (shared/pontoTerminal.ts) */
  terminalStatus?: string | null;
  /** 0575 — "partial": o terminal conta até aqui (UTC); o resto é hora normal */
  terminalUntil?: string | null;
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
  /** estado de terminal do troço (o da SAÍDA); null = normal ou aberto */
  terminalStatus?: string | null;
  /** "partial": até quando conta o terminal (UTC, o da SAÍDA) */
  terminalUntil?: string | null;
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

/** Turno máx. 12 h: entrada aberta há mais de 16 h = check-out esquecido. */
export const CHECKOUT_FORGOTTEN_AFTER_H = 16;
export const CHECKOUT_FORGOTTEN_CAP_H = 12;

/**
 * Horas da saída do ponto a partir da entrada como está na BD (texto UTC).
 * Nunca `new Date("YYYY-MM-DD HH:MM:SS")`: isso lê a hora local do servidor
 * (em Lisboa, no verão, dava +1 h a cada turno).
 * Esquecida (>16 h) → corta às 12 h, sem extraordinárias.
 */
export function checkoutHours(checkInAt: string, nowMs: number): { inAt: Date; outAt: Date; hoursWorked: string; forgotten: boolean } {
  const inAt = parseDbDate(checkInAt);
  const diff = (nowMs - inAt.getTime()) / 3600000;
  if (diff > CHECKOUT_FORGOTTEN_AFTER_H) {
    return { inAt, outAt: new Date(inAt.getTime() + CHECKOUT_FORGOTTEN_CAP_H * 3600000), hoursWorked: CHECKOUT_FORGOTTEN_CAP_H.toFixed(2), forgotten: true };
  }
  return { inAt, outAt: new Date(nowMs), hoursWorked: diff.toFixed(2), forgotten: false };
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
export function pairShifts(records: TimeRecordLike[], opts: { split?: boolean } = {}): { shifts: Shift[]; orphans: TimeRecordLike[] } {
  // `split: false` (plano 64): sem a divisão noite/fim de semana, que é minuto
  // a minuto e pesa em muitas fichas — as horas, o estado e o dia ficam iguais
  // (não dependem dela). Só para quem não usa `split`/`daysTouched`.
  const withSplit = opts.split !== false;
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
    const realHours = Math.max(0, (outD.getTime() - inD.getTime()) / 3600000);
    // regra única (shared/pontoHours.ts): aprovado com horas corrigidas (mesmo 0)
    // vale; a saída "cortada a 12h" também; senão a diferença real
    const hours = pontoShiftHours({ inRec: open, outRec: r, realHours });
    // horas abaixo das reais: a divisão noite/fim de semana só conta até lá
    const effectiveOut = hours < realHours - 0.01 ? new Date(inD.getTime() + hours * 3600000) : outD;
    const { day } = lisbonParts(inD);
    const sp = withSplit ? splitShiftHours(inD, effectiveOut) : { normal: 0, night: 0, weekend: 0, days: [day] };
    shifts.push({
      inId: open.id, outId: r.id, inAt: open.recordedAt, outAt: r.recordedAt, hours: Math.round(hours * 100) / 100,
      status: statusOf(open, r), day, split: { normal: sp.normal, night: sp.night, weekend: sp.weekend }, daysTouched: sp.days,
      notes: [open.notes, r.notes].filter(Boolean).join(" · ") || null,
      terminalStatus: r.terminalStatus ?? null,
      terminalUntil: r.terminalUntil ?? null,
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

/**
 * Resumo do ponto de UM mês com a regra da folha (ficha → Ponto, rh.timeRecords.monthlyHours):
 * turnos que COMEÇAM entre `firstDay` e `lastDay` (dias de Lisboa); contam os
 * fechados e não suspeitos/rejeitados; à parte os suspeitos (não pagos até
 * revisão) e as entradas sem saída. Antes a ficha somava as horas de todas as
 * saídas do mês, também as suspeitas e as rejeitadas, e não batia com a folha.
 */
export function pontoMonthSummary(records: TimeRecordLike[], firstDay: string, lastDay: string): {
  totalHours: number; shifts: number; suspiciousHours: number; suspiciousShifts: number; openShifts: number;
} {
  // só horas, estado e dia: sem a divisão noite/fim de semana (os mesmos números, bem mais rápido)
  const month = pairShifts(records, { split: false }).shifts.filter((s) => s.day >= firstDay && s.day <= lastDay);
  const countable = countableShifts(month);
  const suspicious = month.filter((s) => s.status === "suspicious");
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    totalHours: r2(countable.reduce((t, s) => t + s.hours, 0)),
    shifts: countable.length,
    suspiciousHours: r2(suspicious.reduce((t, s) => t + s.hours, 0)),
    suspiciousShifts: suspicious.length,
    openShifts: month.filter((s) => s.status === "open").length,
  };
}

/**
 * A janela de UM mês do ponto (plano 64, D2) — a mesma para a ficha → Ponto
 * (`getMonthlyHours`) e para o RH → "Horas este mês":
 *  - `firstDay`/`lastDay`: o mês em dias de Lisboa (os turnos contam no dia em
 *    que COMEÇAM);
 *  - `readFrom`/`readUntil`: o que se lê da BD, `[dia 1 − 1, último + 1]` em
 *    UTC (`>= readFrom AND < readUntil`) — o turno da véspera que acaba no
 *    dia 1 (é do mês anterior) e o do último dia que acaba no seguinte (é
 *    deste). PURA.
 */
export function pontoMonthWindow(year: number, month: number): { firstDay: string; lastDay: string; readFrom: string; readUntil: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const firstDay = `${year}-${pad(month)}-01`;
  const lastDay = `${year}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;
  return {
    firstDay, lastDay,
    readFrom: lisbonDayRangeUtc(addDays(firstDay, -1)).start,
    readUntil: lisbonDayRangeUtc(addDays(lastDay, 1)).end,
  };
}

/**
 * Horas do ponto de VÁRIAS fichas num período (plano 64, D2): soma, ficha a
 * ficha, o `pontoMonthSummary` (a regra da folha e da ficha → Ponto). Nunca
 * emparelha picagens de fichas diferentes. PURA.
 */
export function pontoMonthTotals(records: ReadonlyArray<TimeRecordLike & { employeeId: number }>, firstDay: string, lastDay: string): {
  totalHours: number; suspiciousHours: number; openShifts: number; employees: number; byEmployee: Map<number, ReturnType<typeof pontoMonthSummary>>;
} {
  const byEmp = new Map<number, TimeRecordLike[]>();
  for (const r of records) {
    const list = byEmp.get(r.employeeId);
    if (list) list.push(r); else byEmp.set(r.employeeId, [r]);
  }
  const byEmployee = new Map<number, ReturnType<typeof pontoMonthSummary>>();
  let total = 0, suspicious = 0, open = 0, employees = 0;
  for (const [id, list] of byEmp) {
    const s = pontoMonthSummary(list, firstDay, lastDay);
    byEmployee.set(id, s);
    total += s.totalHours; suspicious += s.suspiciousHours; open += s.openShifts;
    if (s.shifts > 0) employees++;
  }
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return { totalHours: r2(total), suspiciousHours: r2(suspicious), openShifts: open, employees, byEmployee };
}

/**
 * As picagens que a ficha → Ponto mostra num mês (ids): as dos turnos que
 * COMEÇAM entre `firstDay` e `lastDay` (dias de Lisboa) — com a saída, mesmo
 * que caia no dia seguinte — e as soltas (saída sem entrada) dentro do mês
 * [`start`, `end`) UTC. A lista soma assim o mesmo que `pontoMonthSummary` e a
 * folha: a saída de um turno da noite de dia 31 aparece no mês em que entrou.
 */
export function pontoMonthRecordIds(records: TimeRecordLike[], firstDay: string, lastDay: string, start: string, end: string): Set<number> {
  const { shifts, orphans } = pairShifts(records);
  const ids = new Set<number>();
  for (const s of shifts) {
    if (s.day < firstDay || s.day > lastDay) continue;
    ids.add(s.inId);
    if (s.outId != null) ids.add(s.outId);
  }
  for (const o of orphans) if (o.recordedAt >= start && o.recordedAt < end) ids.add(o.id);
  return ids;
}
