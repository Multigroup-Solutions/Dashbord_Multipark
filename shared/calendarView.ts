/**
 * Calendário (lote 45e, Jorge 7 out 2026: "Calendário como o Google Calendar,
 * dentro da Comunicação" — um calendário NOSSO que lê a agenda da própria
 * pessoa). Regras PURAS, iguais no cliente e no servidor:
 *
 *  - que calendários entram (os que a pessoa tem visíveis no Google, o
 *    principal e o "Multipark" que a app cria com turnos/formação/prazos);
 *  - evento do Google → evento da página (hora de Lisboa, cor, Meet; privado
 *    de um calendário partilhado sem detalhes → "Ocupado");
 *  - vistas Dia / Semana / Mês / Lista: intervalo, navegação ‹ Hoje ›, título
 *    ("outubro 2026");
 *  - posição na grelha das horas (minutos de relógio de Lisboa, mesmo nos
 *    dias de mudança de hora), colunas quando há sobreposição e faixas do
 *    "dia inteiro";
 *  - "Novo evento": validação de datas/horas (Lisboa) e convidados, e o corpo
 *    para a API do Google Calendar.
 */
import { z } from "zod";
import { addDays, daysInRange, lisbonDayOf, lisbonMidnightUtcMs, lisbonOffsetMs } from "./lisbonDay";
import { GOOGLE_CALENDAR_DESCRIPTION, GOOGLE_CALENDAR_TITLE, GOOGLE_TIMEZONE, lisbonLocalToUtcMs, meetLinkOf } from "./googleSync";

// ─── Constantes ─────────────────────────────────────────────────────────────

/** Intervalo máximo de um pedido (a vista Mês tem no máximo 6 semanas). */
export const CALENDAR_MAX_RANGE_DAYS = 42;
/** Calendários lidos de cada vez (cada um é um pedido à Google). */
export const CALENDAR_MAX_CALENDARS = 20;
/** Páginas de 250 eventos por calendário. */
export const CALENDAR_MAX_PAGES = 4;
export const CALENDAR_MAX_GUESTS = 20;
export const CALENDAR_BUSY_TITLE = "Ocupado";
export const CALENDAR_UNTITLED = "(Sem título)";
export const CALENDAR_DEFAULT_COLOR = "#039be5";
/** Duração máxima de um evento com horas (mais do que isso → dia inteiro). */
export const CALENDAR_MAX_TIMED_DAYS = 14;
export const CALENDAR_MAX_ALLDAY_DAYS = 31;

/** Cores dos eventos do Google (colorId 1–11). */
export const GOOGLE_EVENT_COLORS: Readonly<Record<string, string>> = {
  "1": "#7986cb", "2": "#33b679", "3": "#8e24aa", "4": "#e67c73", "5": "#f6bf26", "6": "#f4511e",
  "7": "#039be5", "8": "#616161", "9": "#3f51b5", "10": "#0b8043", "11": "#d50000",
};

export const PT_MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"] as const;
export const PT_WEEKDAYS_SHORT = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"] as const;
export const PT_WEEKDAYS_LONG = ["segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado", "domingo"] as const;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/;
const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** "2026-10-07" é um dia real do calendário? PURA. */
export function isRealDay(day: string | null | undefined): day is string {
  return !!day && DAY_RE.test(day) && addDays(day, 0) === day;
}

// ─── Tipos ──────────────────────────────────────────────────────────────────

export type CalendarViewReason = null | "not_connected" | "scope_missing" | "reauth_required" | "error";

export interface CalendarViewCalendar {
  id: string;
  name: string;
  color: string;
  primary: boolean;
  /** O calendário "Multipark" que a app cria (turnos, formação, prazos). */
  multipark: boolean;
}

export interface CalendarViewEvent {
  id: string;
  calendarId: string;
  title: string;
  /** ISO (UTC). Dia inteiro: meia-noite de Lisboa do 1.º dia; o fim é exclusivo. */
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  meetLink: string | null;
  htmlLink: string | null;
  color: string;
  /** Só se sabe que está ocupado (privado / só livre-ocupado). */
  busyOnly: boolean;
  /** A pessoa recusou o convite. */
  declined: boolean;
  description: string | null;
}

export interface CalendarViewResult {
  enabled: boolean;
  reason: CalendarViewReason;
  /** Detalhe curto do erro (reason "error"), para o ecrã. */
  error: string | null;
  calendars: CalendarViewCalendar[];
  events: CalendarViewEvent[];
  /** Calendários que não se conseguiram ler (os outros aparecem). */
  failedCalendars: Array<{ id: string; name: string }>;
  /** Havia mais eventos do que os lidos (limite de páginas). */
  truncated: boolean;
}

export function emptyCalendarView(reason: Exclude<CalendarViewReason, null>, error: string | null = null): CalendarViewResult {
  return { enabled: false, reason, error, calendars: [], events: [], failedCalendars: [], truncated: false };
}

/** Intervalo pedido inválido? → mensagem; ok → null. PURA. */
export function calendarRangeError(fromDay: string, toDay: string): string | null {
  if (!isRealDay(fromDay) || !isRealDay(toDay)) return "Dia inválido.";
  if (toDay < fromDay) return "Intervalo inválido.";
  if (daysInRange(fromDay, toDay).length > CALENDAR_MAX_RANGE_DAYS) return `No máximo ${CALENDAR_MAX_RANGE_DAYS} dias de cada vez.`;
  return null;
}

// ─── Calendários ────────────────────────────────────────────────────────────

export interface CalendarListEntryLike {
  id?: string | null;
  summary?: string | null;
  summaryOverride?: string | null;
  description?: string | null;
  backgroundColor?: string | null;
  primary?: boolean | null;
  selected?: boolean | null;
  hidden?: boolean | null;
  deleted?: boolean | null;
  accessRole?: string | null;
}

export type PickedCalendar = CalendarViewCalendar & { accessRole: string | null };

const isHexColor = (c: string | null | undefined): c is string => !!c && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(c);

/** O calendário secundário "Multipark" criado pela app (dono = a pessoa). PURA. */
export function isMultiparkCalendar(c: CalendarListEntryLike): boolean {
  if (c.accessRole !== "owner" || c.primary) return false;
  return (c.description ?? "") === GOOGLE_CALENDAR_DESCRIPTION || (c.summary ?? "").trim() === GOOGLE_CALENDAR_TITLE;
}

/**
 * Que calendários a página lê: os que a pessoa tem visíveis no Google
 * (selected), o principal e o "Multipark"; nunca os apagados. Principal
 * primeiro, depois o Multipark, depois os outros pela ordem do Google.
 * Sem principal na lista (não devia acontecer) → acrescenta "primary". PURA.
 */
export function pickViewCalendars(list: readonly CalendarListEntryLike[], max = CALENDAR_MAX_CALENDARS): PickedCalendar[] {
  const out: PickedCalendar[] = [];
  const seen = new Set<string>();
  for (const c of list) {
    const id = String(c.id ?? "").trim();
    if (!id || c.deleted || seen.has(id)) continue;
    const multipark = isMultiparkCalendar(c);
    if (!(c.primary || c.selected || multipark)) continue;
    seen.add(id);
    out.push({
      id,
      name: (c.summaryOverride || c.summary || id).trim().slice(0, 120),
      color: isHexColor(c.backgroundColor) ? c.backgroundColor : CALENDAR_DEFAULT_COLOR,
      primary: !!c.primary,
      multipark,
      accessRole: c.accessRole ?? null,
    });
  }
  if (!out.some((c) => c.primary)) out.unshift({ id: "primary", name: "O meu calendário", color: CALENDAR_DEFAULT_COLOR, primary: true, multipark: false, accessRole: "owner" });
  const rank = (c: PickedCalendar) => (c.primary ? 0 : c.multipark ? 1 : 2);
  return out
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map((x) => x.c)
    .slice(0, max);
}

// ─── Eventos ────────────────────────────────────────────────────────────────

export interface GoogleEventLike {
  id?: string | null;
  status?: string | null;
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  start?: { date?: string | null; dateTime?: string | null } | null;
  end?: { date?: string | null; dateTime?: string | null } | null;
  htmlLink?: string | null;
  hangoutLink?: string | null;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string | null; uri?: string | null }> | null } | null;
  colorId?: string | null;
  visibility?: string | null;
  eventType?: string | null;
  attendees?: Array<{ self?: boolean | null; responseStatus?: string | null }> | null;
}

/** Só links https (o que vem da Google vai para um href). PURA. */
export function safeHttpsUrl(u: string | null | undefined): string | null {
  const s = String(u ?? "").trim();
  if (!/^https:\/\/[^\s"'<>]+$/i.test(s) || s.length > 2000) return null;
  return s;
}

/** Descrição do Google (pode ter HTML) → texto simples, curto. PURA. */
export function plainDescription(raw: string | null | undefined, max = 1500): string | null {
  if (!raw) return null;
  const t = String(raw)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t ? t.slice(0, max) : null;
}

/**
 * Evento do Google → evento da página. Cancelados e "local de trabalho" ficam
 * de fora. Privado de um calendário partilhado (sem título) ou calendário só
 * de livre/ocupado → "Ocupado", sem local, Meet, descrição nem link. PURA.
 */
export function viewEventOf(e: GoogleEventLike, cal: { id: string; color: string; accessRole?: string | null }): CalendarViewEvent | null {
  const id = String(e?.id ?? "");
  if (!id || e.status === "cancelled" || e.eventType === "workingLocation") return null;
  const allDay = !!e.start?.date && !e.start?.dateTime;
  let startMs: number;
  let endMs: number;
  if (allDay) {
    const sd = String(e.start?.date ?? "");
    if (!isRealDay(sd)) return null;
    const ed = isRealDay(e.end?.date) && e.end!.date! > sd ? e.end!.date! : addDays(sd, 1);
    startMs = lisbonMidnightUtcMs(sd);
    endMs = lisbonMidnightUtcMs(ed);
  } else {
    startMs = Date.parse(String(e.start?.dateTime ?? ""));
    if (!Number.isFinite(startMs)) return null;
    endMs = Date.parse(String(e.end?.dateTime ?? ""));
    if (!Number.isFinite(endMs) || endMs < startMs) endMs = startMs;
  }
  const title = String(e.summary ?? "").trim();
  const busyOnly = cal.accessRole === "freeBusyReader" || (!title && (e.visibility === "private" || e.visibility === "confidential"));
  const declined = (e.attendees ?? []).some((a) => !!a?.self && a.responseStatus === "declined");
  const own = !busyOnly && e.colorId ? GOOGLE_EVENT_COLORS[String(e.colorId)] : undefined;
  return {
    id,
    calendarId: cal.id,
    title: busyOnly ? CALENDAR_BUSY_TITLE : (title || CALENDAR_UNTITLED).slice(0, 250),
    start: iso(startMs),
    end: iso(endMs),
    allDay,
    location: busyOnly ? null : (String(e.location ?? "").trim().slice(0, 250) || null),
    meetLink: busyOnly ? null : safeHttpsUrl(meetLinkOf(e)),
    htmlLink: busyOnly ? null : safeHttpsUrl(e.htmlLink),
    color: own ?? cal.color,
    busyOnly,
    declined,
    description: busyOnly ? null : plainDescription(e.description),
  };
}

/** Ordem da página: início, depois os mais longos primeiro, depois o título. PURA. */
export function compareViewEvents(a: Pick<CalendarViewEvent, "start" | "end" | "title">, b: Pick<CalendarViewEvent, "start" | "end" | "title">): number {
  return Date.parse(a.start) - Date.parse(b.start) || Date.parse(b.end) - Date.parse(a.end) || a.title.localeCompare(b.title, "pt");
}

// ─── Relógio de Lisboa ──────────────────────────────────────────────────────

/** Minutos desde a meia-noite no relógio de Lisboa (0–1439). PURA. */
export function lisbonWallMinutes(ms: number): number {
  const local = ms + lisbonOffsetMs(ms);
  return Math.floor((((local % DAY_MS) + DAY_MS) % DAY_MS) / 60_000);
}

/** "14:05" (hora de Lisboa). PURA. */
export function lisbonHHMM(ms: number): string {
  const m = lisbonWallMinutes(ms);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Dia + "HH:MM" de Lisboa → ms UTC (null se inválido). PURA. */
export function lisbonDayTimeToUtcMs(day: string, hhmm: string): number | null {
  if (!isRealDay(day) || !HM_RE.test(hhmm)) return null;
  const ms = lisbonLocalToUtcMs(`${day}T${hhmm}`);
  return Number.isFinite(ms) ? ms : null;
}

/** Dia + "HH:MM" + N minutos, no relógio (o dia muda à meia-noite). PURA. */
export function addLocalMinutes(day: string, hhmm: string, minutes: number): { day: string; time: string } {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + Math.round(minutes);
  const dayShift = Math.floor(total / 1440);
  const rest = total - dayShift * 1440;
  return { day: addDays(day, dayShift), time: `${String(Math.floor(rest / 60)).padStart(2, "0")}:${String(rest % 60).padStart(2, "0")}` };
}

/** Minutos de relógio entre dois (dia, "HH:MM"). PURA. */
export function localMinutesBetween(d1: string, t1: string, d2: string, t2: string): number {
  const [y1, mo1, dd1] = d1.split("-").map(Number);
  const [y2, mo2, dd2] = d2.split("-").map(Number);
  const days = Math.round((Date.UTC(y2, mo2 - 1, dd2) - Date.UTC(y1, mo1 - 1, dd1)) / DAY_MS);
  const [h1, m1] = t1.split(":").map(Number);
  const [h2, m2] = t2.split(":").map(Number);
  return days * 1440 + (h2 * 60 + m2) - (h1 * 60 + m1);
}

/** 0 = segunda … 6 = domingo. PURA. */
export function weekdayIndex(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

const dayNum = (day: string) => Number(day.slice(8, 10));
const monthOf = (day: string) => Number(day.slice(5, 7)) - 1;
const yearOf = (day: string) => Number(day.slice(0, 4));

// ─── Vistas e navegação ─────────────────────────────────────────────────────

export const CALENDAR_VIEWS = ["day", "week", "month", "list"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];
export const CALENDAR_VIEW_LABELS: Record<CalendarView, string> = { day: "Dia", week: "Semana", month: "Mês", list: "Lista" };
/** A vista Lista mostra esta quantidade de dias a partir do dia escolhido. */
export const CALENDAR_LIST_DAYS = 7;

export function weekStartOf(day: string): string {
  return addDays(day, -weekdayIndex(day));
}

function firstOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function addMonths(day: string, n: number): string {
  const y = yearOf(day);
  const m = monthOf(day) + n;
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 10);
}

/** Dias da grelha do mês: semanas completas (seg–dom) que cobrem o mês (4 a 6). PURA. */
export function monthGridDays(anchor: string): string[] {
  const first = firstOfMonth(anchor);
  const last = addDays(addMonths(first, 1), -1);
  return daysInRange(weekStartOf(first), addDays(last, 6 - weekdayIndex(last)));
}

/** Dias que a vista mostra. PURA. */
export function viewDays(view: CalendarView, anchor: string): string[] {
  if (view === "day") return [anchor];
  if (view === "week") return daysInRange(weekStartOf(anchor), addDays(weekStartOf(anchor), 6));
  if (view === "list") return daysInRange(anchor, addDays(anchor, CALENDAR_LIST_DAYS - 1));
  return monthGridDays(anchor);
}

/** ‹ / › : um dia, uma semana, um mês (1.º dia) ou a próxima lista. PURA. */
export function shiftAnchor(view: CalendarView, anchor: string, dir: -1 | 1): string {
  if (view === "day") return addDays(anchor, dir);
  if (view === "week") return addDays(anchor, 7 * dir);
  if (view === "list") return addDays(anchor, CALENDAR_LIST_DAYS * dir);
  return addMonths(firstOfMonth(anchor), dir);
}

const monthYear = (day: string) => `${PT_MONTHS[monthOf(day)]} ${yearOf(day)}`;

/** "outubro 2026"; semana entre meses "setembro – outubro 2026"; dia "7 de outubro 2026". PURA. */
export function viewTitle(view: CalendarView, anchor: string): string {
  if (view === "day") return `${dayNum(anchor)} de ${PT_MONTHS[monthOf(anchor)]} ${yearOf(anchor)}`;
  if (view === "month") return monthYear(anchor);
  const days = viewDays(view, anchor);
  const a = days[0];
  const b = days[days.length - 1];
  if (a.slice(0, 7) === b.slice(0, 7)) return monthYear(a);
  if (yearOf(a) === yearOf(b)) return `${PT_MONTHS[monthOf(a)]} – ${PT_MONTHS[monthOf(b)]} ${yearOf(b)}`;
  return `${monthYear(a)} – ${monthYear(b)}`;
}

/** "quarta-feira, 7 de outubro". PURA. */
export function longDayLabel(day: string): string {
  return `${PT_WEEKDAYS_LONG[weekdayIndex(day)]}, ${dayNum(day)} de ${PT_MONTHS[monthOf(day)]}`;
}

/** Último dia (Lisboa) que o evento ocupa (o fim é exclusivo). PURA. */
export function lastDayOf(ev: Pick<CalendarViewEvent, "start" | "end">): string {
  const s = Date.parse(ev.start);
  const e = Date.parse(ev.end);
  return lisbonDayOf(Math.max(s, e - 1));
}

/** Quando é (painel de detalhes). PURA. */
export function eventWhenLabel(ev: Pick<CalendarViewEvent, "start" | "end" | "allDay">): string {
  const s = Date.parse(ev.start);
  const e = Date.parse(ev.end);
  const d1 = lisbonDayOf(s);
  const d2 = lastDayOf(ev);
  const short = (d: string) => `${dayNum(d)} de ${PT_MONTHS[monthOf(d)]}`;
  if (ev.allDay) return d1 === d2 ? `${longDayLabel(d1)} · dia inteiro` : `${short(d1)} – ${short(d2)} · dia inteiro`;
  if (d1 === d2) return `${longDayLabel(d1)} · ${lisbonHHMM(s)} – ${lisbonHHMM(e)}`;
  return `${short(d1)}, ${lisbonHHMM(s)} – ${short(d2)}, ${lisbonHHMM(e)}`;
}

// ─── Grelha das horas ───────────────────────────────────────────────────────

/** Vai para a faixa "dia inteiro": dia inteiro ou 24 h ou mais (como no Google). PURA. */
export function isAllDayLike(ev: Pick<CalendarViewEvent, "start" | "end" | "allDay">): boolean {
  return ev.allDay || Date.parse(ev.end) - Date.parse(ev.start) >= DAY_MS;
}

export interface DaySegment<E> {
  event: E;
  day: string;
  /** Minutos de relógio de Lisboa (0–1440). */
  startMin: number;
  endMin: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/** Bocados de um evento com horas em cada dia mostrado (um evento das 22h às 2h fica em dois dias). PURA. */
export function daySegments<E extends Pick<CalendarViewEvent, "start" | "end">>(ev: E, days: readonly string[]): DaySegment<E>[] {
  const s = Date.parse(ev.start);
  const e = Math.max(s, Date.parse(ev.end));
  const out: DaySegment<E>[] = [];
  for (const day of days) {
    const ds = lisbonMidnightUtcMs(day);
    const de = lisbonMidnightUtcMs(addDays(day, 1));
    const overlaps = s < de && (e > ds || (e === s && s >= ds));
    if (!overlaps) continue;
    const startMin = s <= ds ? 0 : lisbonWallMinutes(s);
    const endMin = e >= de ? 1440 : Math.max(startMin, lisbonWallMinutes(e));
    out.push({ event: ev, day, startMin, endMin, continuesBefore: s < ds, continuesAfter: e > de });
  }
  return out;
}

/**
 * Colunas lado a lado quando os eventos se sobrepõem (como no Google): cada
 * grupo de eventos que se tocam divide a largura pelo número de colunas que
 * precisa. `minMinutes` = altura mínima visível (um evento de 5 min ocupa
 * espaço de ~20). PURA.
 */
export function layoutDay<T extends { startMin: number; endMin: number }>(segs: readonly T[], minMinutes = 20): Array<T & { col: number; cols: number }> {
  const sorted = [...segs].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const out: Array<T & { col: number; cols: number }> = [];
  let group: Array<T & { col: number; cols: number }> = [];
  let colEnds: number[] = [];
  let groupEnd = -1;
  const flush = () => {
    for (const g of group) g.cols = colEnds.length;
    out.push(...group);
    group = [];
    colEnds = [];
  };
  for (const s of sorted) {
    const end = Math.max(s.endMin, s.startMin + minMinutes);
    if (group.length && s.startMin >= groupEnd) flush();
    let col = colEnds.findIndex((c) => c <= s.startMin);
    if (col === -1) { col = colEnds.length; colEnds.push(end); } else colEnds[col] = end;
    group.push({ ...s, col, cols: 1 });
    groupEnd = group.length === 1 ? end : Math.max(groupEnd, end);
  }
  if (group.length) flush();
  return out;
}

export interface AllDayBar<E> { event: E; startCol: number; span: number; lane: number; continuesBefore: boolean; continuesAfter: boolean }

/** Faixas do "dia inteiro" nos dias mostrados (barras que atravessam dias, sem se sobreporem). PURA. */
export function allDayLanes<E extends Pick<CalendarViewEvent, "start" | "end" | "title">>(events: readonly E[], days: readonly string[]): AllDayBar<E>[] {
  if (!days.length) return [];
  const first = days[0];
  const last = days[days.length - 1];
  const bars: Array<Omit<AllDayBar<E>, "lane">> = [];
  for (const ev of events) {
    const d1 = lisbonDayOf(Date.parse(ev.start));
    const d2 = lastDayOf(ev);
    if (d2 < first || d1 > last) continue;
    const startCol = d1 < first ? 0 : days.indexOf(d1);
    const endCol = d2 > last ? days.length - 1 : days.indexOf(d2);
    if (startCol < 0 || endCol < startCol) continue;
    bars.push({ event: ev, startCol, span: endCol - startCol + 1, continuesBefore: d1 < first, continuesAfter: d2 > last });
  }
  bars.sort((a, b) => a.startCol - b.startCol || b.span - a.span || a.event.title.localeCompare(b.event.title, "pt"));
  const laneEnds: number[] = [];
  return bars.map((b) => {
    let lane = laneEnds.findIndex((end) => end < b.startCol);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(b.startCol + b.span - 1); } else laneEnds[lane] = b.startCol + b.span - 1;
    return { ...b, lane };
  });
}

/** Eventos que tocam um dia (Mês e Lista): dia inteiro primeiro, depois por hora. PURA. */
export function eventsOnDay<E extends Pick<CalendarViewEvent, "start" | "end" | "allDay" | "title">>(events: readonly E[], day: string): E[] {
  const ds = lisbonMidnightUtcMs(day);
  const de = lisbonMidnightUtcMs(addDays(day, 1));
  return events
    .filter((ev) => {
      const s = Date.parse(ev.start);
      const e = Math.max(s, Date.parse(ev.end));
      return s < de && (e > ds || (e === s && s >= ds));
    })
    .sort((a, b) => Number(isAllDayLike(b)) - Number(isAllDayLike(a)) || compareViewEvents(a, b));
}

/** Cor do texto legível sobre uma cor de fundo (#rrggbb). PURA. */
export function readableTextOn(hex: string): "#ffffff" | "#1f1f1f" {
  let h = String(hex ?? "").replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) return "#ffffff";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.45 ? "#1f1f1f" : "#ffffff";
}

// ─── Novo evento ────────────────────────────────────────────────────────────

// Repetição (Jorge, 14 out 2026: "eventos que se repetem"). O cliente só manda
// a ESCOLHA (frequência + fim); a regra RRULE é montada aqui, a partir do dia
// de início — nunca se aceita uma RRULE em texto vinda do browser.
export const CALENDAR_REPEAT_FREQS = ["daily", "weekly", "monthly", "yearly"] as const;
export type CalendarRepeatFreq = (typeof CALENDAR_REPEAT_FREQS)[number];
/** "Termina após N vezes": de 2 a isto. */
export const CALENDAR_MAX_REPEAT_COUNT = 730;
/** "Termina em": no máximo isto depois do início. */
export const CALENDAR_MAX_REPEAT_YEARS = 5;

export const calendarRecurrenceSchema = z.object({
  freq: z.enum(CALENDAR_REPEAT_FREQS),
  end: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("never") }).strict(),
    z.object({ kind: z.literal("until"), untilDay: z.string().regex(DAY_RE, "Data inválida.") }).strict(),
    z.object({ kind: z.literal("count"), count: z.number().int().min(2, "Repete pelo menos 2 vezes.").max(CALENDAR_MAX_REPEAT_COUNT, `No máximo ${CALENDAR_MAX_REPEAT_COUNT} vezes.`) }).strict(),
  ]).default({ kind: "never" }),
}).strict();
export type CalendarRecurrenceInput = z.input<typeof calendarRecurrenceSchema>;

export const createCalendarEventSchema = z.object({
  title: z.string().trim().min(1, "Indica o título.").max(200),
  allDay: z.boolean().default(false),
  /** Dias de Lisboa ("YYYY-MM-DD"); com dia inteiro, o fim é o último dia (inclusive). */
  startDay: z.string().regex(DAY_RE, "Data inválida."),
  endDay: z.string().regex(DAY_RE, "Data inválida."),
  /** "HH:MM" de Lisboa (obrigatório sem dia inteiro). */
  startTime: z.string().regex(HM_RE, "Hora inválida.").optional(),
  endTime: z.string().regex(HM_RE, "Hora inválida.").optional(),
  location: z.string().trim().max(250).optional(),
  description: z.string().max(4000).optional(),
  guests: z.array(z.string().trim().max(254)).max(CALENDAR_MAX_GUESTS, `No máximo ${CALENDAR_MAX_GUESTS} convidados.`).default([]),
  withMeet: z.boolean().default(false),
  /** Repetição (opcional; sem ela → "Não se repete"). */
  recurrence: calendarRecurrenceSchema.nullish(),
});
export type CreateCalendarEventInput = z.input<typeof createCalendarEventSchema>;

/** Texto livre ("a@x.pt, b@y.pt; c@z.pt") → lista de emails. PURA. */
export function splitGuests(raw: string): string[] {
  return String(raw ?? "").split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
}

/** Convidados: minúsculas, sem repetidos, sem o próprio, emails válidos, no máximo 20. PURA. */
export function normalizeGuests(raw: readonly string[], ownEmail?: string | null): { ok: true; guests: string[] } | { ok: false; error: string } {
  const own = String(ownEmail ?? "").trim().toLowerCase();
  const out: string[] = [];
  for (const g of raw) {
    const e = String(g ?? "").trim().replace(/^<|>$/g, "").toLowerCase();
    if (!e) continue;
    if (!EMAIL_RE.test(e) || e.length > 254) return { ok: false, error: `Email de convidado inválido: ${e.slice(0, 80)}` };
    if (e === own || out.includes(e)) continue;
    out.push(e);
  }
  if (out.length > CALENDAR_MAX_GUESTS) return { ok: false, error: `No máximo ${CALENDAR_MAX_GUESTS} convidados.` };
  return { ok: true, guests: out };
}

// ─── Repetição: etiquetas e regra RRULE ─────────────────────────────────────

const RRULE_BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
/** "20261231T235959Z" (formato básico UTC do RFC 5545). PURA. */
export function rruleUtcBasic(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}
const ptDate = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
/** "à terça-feira" / "ao sábado". */
const weekdayWithArticle = (day: string) => {
  const i = weekdayIndex(day);
  return `${i >= 5 ? "ao" : "à"} ${PT_WEEKDAYS_LONG[i]}`;
};

type RecurrenceChoice = { freq: CalendarRepeatFreq; end?: { kind: "never" } | { kind: "until"; untilDay: string } | { kind: "count"; count: number } };

/** O texto de cada opção do "Repete", a partir do dia de início ("Todas as semanas à terça-feira"). PURA. */
export function calendarRepeatLabel(freq: CalendarRepeatFreq, startDay: string): string {
  if (freq === "daily") return "Todos os dias";
  if (!isRealDay(startDay)) return { weekly: "Todas as semanas", monthly: "Todos os meses", yearly: "Todos os anos" }[freq];
  if (freq === "weekly") return `Todas as semanas ${weekdayWithArticle(startDay)}`;
  if (freq === "monthly") return `Todos os meses no dia ${dayNum(startDay)}`;
  return `Todos os anos a ${dayNum(startDay)} de ${PT_MONTHS[monthOf(startDay)]}`;
}

/**
 * Aviso para os dias que não existem em todos os meses/anos (regra do RFC 5545,
 * igual no Google): "todos os meses no dia 31" salta os meses sem dia 31 (não
 * passa para o último dia do mês); 29 de fevereiro só nos anos bissextos. PURA.
 */
export function calendarRepeatNote(freq: CalendarRepeatFreq, startDay: string): string | null {
  if (!isRealDay(startDay)) return null;
  if (freq === "monthly" && dayNum(startDay) >= 29) return `Nos meses sem dia ${dayNum(startDay)}, não há evento.`;
  if (freq === "yearly" && startDay.slice(5) === "02-29") return "Só nos anos bissextos.";
  return null;
}

/** "Todas as semanas à terça-feira · até 31/12/2026" / "· 10 vezes". PURA. */
export function describeCalendarRecurrence(rec: RecurrenceChoice, startDay: string): string {
  const base = calendarRepeatLabel(rec.freq, startDay);
  const end = rec.end ?? { kind: "never" as const };
  if (end.kind === "until") return `${base} · até ${ptDate(end.untilDay)}`;
  if (end.kind === "count") return `${base} · ${end.count} vezes`;
  return base;
}

/**
 * A regra RRULE para o Google (`recurrence: ["RRULE:…"]`), montada só a partir
 * da escolha validada e do dia de início:
 *  - semanal → BYDAY do dia da semana do início; mensal → BYMONTHDAY do dia do
 *    início (29–31: os meses sem esse dia ficam sem evento); anual → o mês e o
 *    dia vêm do início;
 *  - "Termina em <dia>" → UNTIL: com horas, o fim desse dia em Lisboa, em UTC
 *    ("20261231T235959Z"); dia inteiro → a data ("20261231"), como o Google faz;
 *  - "Termina após N vezes" → COUNT. PURA.
 */
export function buildCalendarRRule(rec: RecurrenceChoice, o: { startDay: string; allDay: boolean }): string {
  const parts = [`FREQ=${rec.freq.toUpperCase()}`];
  if (rec.freq === "weekly") parts.push(`BYDAY=${RRULE_BYDAY[weekdayIndex(o.startDay)]}`);
  if (rec.freq === "monthly") parts.push(`BYMONTHDAY=${dayNum(o.startDay)}`);
  const end = rec.end ?? { kind: "never" as const };
  if (end.kind === "until") {
    parts.push(`UNTIL=${o.allDay ? end.untilDay.replace(/-/g, "") : rruleUtcBasic(lisbonMidnightUtcMs(addDays(end.untilDay, 1)) - 1000)}`);
  } else if (end.kind === "count") parts.push(`COUNT=${end.count}`);
  return `RRULE:${parts.join(";")}`;
}

/** Quantos dias pode durar cada ocorrência sem chegar à seguinte. */
const REPEAT_PERIOD_DAYS: Record<CalendarRepeatFreq, number> = { daily: 1, weekly: 7, monthly: 28, yearly: 365 };

/** Valida a repetição de um evento já validado (escolha estrita, fim depois do início, nem demasiado longe). PURA. */
function validateRecurrence(
  raw: unknown,
  ev: { startDay: string; endDay: string; allDay: boolean; startMs: number; endMs: number },
): { ok: true; rule: string; label: string } | { ok: false; error: string } {
  const r = calendarRecurrenceSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    const own = !!issue && (issue.path.includes("count") || issue.path.includes("untilDay"));
    return { ok: false, error: own ? issue.message : "Repetição inválida." };
  }
  const rec = r.data;
  const period = REPEAT_PERIOD_DAYS[rec.freq];
  const tooLong = ev.allDay ? daysInRange(ev.startDay, ev.endDay).length > period : ev.endMs - ev.startMs > period * DAY_MS;
  if (tooLong) return { ok: false, error: `${calendarRepeatLabel(rec.freq, ev.startDay)}: cada evento tem de acabar antes de começar o seguinte.` };
  if (rec.end.kind === "until") {
    const u = rec.end.untilDay;
    if (!isRealDay(u)) return { ok: false, error: "Data inválida." };
    if (u < ev.startDay) return { ok: false, error: "A repetição tem de terminar depois do início." };
    const limit = `${yearOf(ev.startDay) + CALENDAR_MAX_REPEAT_YEARS}${ev.startDay.slice(4)}`;
    if (u > limit) return { ok: false, error: `A repetição termina no máximo ${CALENDAR_MAX_REPEAT_YEARS} anos depois do início.` };
  }
  return { ok: true, rule: buildCalendarRRule(rec, { startDay: ev.startDay, allDay: ev.allDay }), label: describeCalendarRecurrence(rec, ev.startDay) };
}

export interface ValidNewEvent {
  title: string;
  allDay: boolean;
  startMs: number;
  endMs: number;
  startDay: string;
  /** Dia a seguir ao último (a API do Google usa o fim exclusivo). */
  endDayExclusive: string;
  guests: string[];
  location: string | null;
  description: string | null;
  withMeet: boolean;
  /** `["RRULE:…"]` (montada aqui, nunca vinda do browser) ou null quando não se repete. */
  recurrence: string[] | null;
  /** "Todas as semanas à terça-feira · até 31/12/2026" (ou null). */
  recurrenceLabel: string | null;
}

/**
 * Valida o "Novo evento" (datas reais, hora de Lisboa, fim depois do início,
 * durações razoáveis, nem há mais de um ano nem daqui a mais de cinco, e os
 * convidados). PURA.
 */
export function validateNewCalendarEvent(input: CreateCalendarEventInput, o: { nowMs: number; ownEmail?: string | null }): { ok: true; value: ValidNewEvent } | { ok: false; error: string } {
  const title = String(input.title ?? "").trim();
  if (!title) return { ok: false, error: "Indica o título." };
  if (!isRealDay(input.startDay) || !isRealDay(input.endDay)) return { ok: false, error: "Data inválida." };
  if (input.endDay < input.startDay) return { ok: false, error: "O fim tem de ser depois do início." };
  let startMs: number;
  let endMs: number;
  const allDay = !!input.allDay;
  if (allDay) {
    if (daysInRange(input.startDay, input.endDay).length > CALENDAR_MAX_ALLDAY_DAYS) return { ok: false, error: `Um evento de dia inteiro dura no máximo ${CALENDAR_MAX_ALLDAY_DAYS} dias.` };
    startMs = lisbonMidnightUtcMs(input.startDay);
    endMs = lisbonMidnightUtcMs(addDays(input.endDay, 1));
  } else {
    const s = input.startTime ? lisbonDayTimeToUtcMs(input.startDay, input.startTime) : null;
    const e = input.endTime ? lisbonDayTimeToUtcMs(input.endDay, input.endTime) : null;
    if (s == null || e == null) return { ok: false, error: "Indica a hora de início e de fim." };
    if (e <= s) return { ok: false, error: "O fim tem de ser depois do início." };
    if (e - s > CALENDAR_MAX_TIMED_DAYS * DAY_MS) return { ok: false, error: `Um evento com horas dura no máximo ${CALENDAR_MAX_TIMED_DAYS} dias — usa "dia inteiro".` };
    startMs = s;
    endMs = e;
  }
  if (startMs < o.nowMs - 366 * DAY_MS || startMs > o.nowMs + 5 * 366 * DAY_MS) return { ok: false, error: "Escolhe uma data entre o ano passado e daqui a cinco anos." };
  const g = normalizeGuests(input.guests ?? [], o.ownEmail);
  if (!g.ok) return g;
  let rec: { rule: string; label: string } | null = null;
  if (input.recurrence) {
    const r = validateRecurrence(input.recurrence, { startDay: input.startDay, endDay: input.endDay, allDay, startMs, endMs });
    if (!r.ok) return r;
    rec = r;
  }
  return {
    ok: true,
    value: {
      title: title.slice(0, 200),
      allDay,
      startMs,
      endMs,
      startDay: input.startDay,
      endDayExclusive: addDays(input.endDay, 1),
      guests: g.guests,
      location: String(input.location ?? "").trim().slice(0, 250) || null,
      description: String(input.description ?? "").trim().slice(0, 4000) || null,
      withMeet: !!input.withMeet,
      recurrence: rec ? [rec.rule] : null,
      recurrenceLabel: rec?.label ?? null,
    },
  };
}

/** Corpo do evento para o calendário principal da pessoa (Meet opcional). PURA. */
export function newCalendarEventBody(v: ValidNewEvent, o: { requestId: string; link?: string | null }) {
  return {
    summary: v.title,
    ...(v.description ? { description: v.description } : {}),
    ...(v.location ? { location: v.location } : {}),
    // A repetição é expandida no fuso de start/end (o Google exige-o nos eventos que se repetem).
    start: v.allDay ? { date: v.startDay, ...(v.recurrence ? { timeZone: GOOGLE_TIMEZONE } : {}) } : { dateTime: iso(v.startMs), timeZone: GOOGLE_TIMEZONE },
    end: v.allDay ? { date: v.endDayExclusive, ...(v.recurrence ? { timeZone: GOOGLE_TIMEZONE } : {}) } : { dateTime: iso(v.endMs), timeZone: GOOGLE_TIMEZONE },
    ...(v.recurrence ? { recurrence: v.recurrence } : {}),
    ...(v.guests.length ? { attendees: v.guests.map((email) => ({ email })) } : {}),
    ...(v.withMeet ? { conferenceData: { createRequest: { requestId: o.requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}),
    ...(o.link ? { source: { title: "Dashboard Multipark", url: o.link } } : {}),
    reminders: { useDefault: true },
  };
}
