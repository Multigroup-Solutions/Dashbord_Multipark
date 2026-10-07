// Calendário (lote 45e, Jorge 7 out 2026: "Calendário como o Google Calendar,
// dentro da Comunicação" — um calendário NOSSO que lê a agenda da pessoa).
// Lê ao vivo o Google Calendar da PRÓPRIA pessoa (só ela vê os seus; nada fica
// guardado no dashboard): os calendários que tem visíveis no Google, o
// principal e o "Multipark" (turnos, formação, prazos). Vistas Dia / Semana /
// Mês (no telemóvel Dia / Lista), "Novo evento" no calendário principal.
// Erro de leitura ≠ calendário vazio: diz que não conseguiu ler e deixa
// tentar de novo. Horas sempre de Lisboa.
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useIsMobile } from "@/hooks/useMobile";
import { useSidebar } from "@/components/ui/sidebar";
import { toast } from "sonner";
import {
  AlertTriangle, AlignLeft, CalendarDays, ChevronLeft, ChevronRight, ExternalLink, Layers, Loader2, MapPin, Plus, RefreshCw, Users, Video,
} from "lucide-react";
import { GoogleAccountCard, useGoogleOAuthReturnToast } from "@/components/GoogleAccountCard";
import { googleFeaturesHref } from "@/components/google/GoogleSyncCard";
import { lisbonDayOf } from "@shared/lisbonDay";
import {
  CALENDAR_MAX_GUESTS, CALENDAR_VIEW_LABELS, PT_WEEKDAYS_SHORT, addLocalMinutes, allDayLanes, daySegments, eventWhenLabel, eventsOnDay, isAllDayLike,
  isRealDay, layoutDay, lisbonHHMM, lisbonWallMinutes, localMinutesBetween, monthGridDays, readableTextOn, safeHttpsUrl, shiftAnchor, splitGuests,
  validateNewCalendarEvent, viewDays, viewTitle, weekdayIndex,
  type CalendarView, type CalendarViewCalendar, type CalendarViewEvent, type CalendarViewReason, type CreateCalendarEventInput, type DaySegment,
} from "@shared/calendarView";

type PlacedSegment = DaySegment<CalendarViewEvent> & { col: number; cols: number };

const HOUR_PX = 48;
const SCROLL_TO_HOUR = 7;
const LS_HIDDEN = "mp.calendario.escondidos";
const LS_VIEW = "mp.calendario.vista";
const DESKTOP_VIEWS: CalendarView[] = ["day", "week", "month"];
const MOBILE_VIEWS: CalendarView[] = ["day", "list"];
const MINI_WEEKDAYS = ["S", "T", "Q", "Q", "S", "S", "D"];

function readLocal(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function writeLocal(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* sem localStorage — só não fica lembrado */ }
}
function readHidden(): Set<string> {
  try {
    const v = JSON.parse(readLocal(LS_HIDDEN) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  } catch { return new Set(); }
}

type NewEventInitial = { startDay: string; startTime: string; endDay: string; endTime: string; allDay: boolean };

/** Hora cheia seguinte (ou 09:00 noutro dia), com 1 hora. */
function defaultNewEvent(day: string, today: string, nowMs: number): NewEventInitial {
  let startDay = day;
  let startTime = "09:00";
  if (day === today) {
    const next = Math.min(23, Math.floor(lisbonWallMinutes(nowMs) / 60) + 1);
    startTime = `${String(next).padStart(2, "0")}:00`;
  }
  const end = addLocalMinutes(startDay, startTime, 60);
  return { startDay, startTime, endDay: end.day, endTime: end.time, allDay: false };
}

export default function CalendarioPage() {
  const isMobile = useIsMobile();
  // Como nas caixas de email: no PC o menu recolhe ao entrar e volta como estava ao sair.
  const sidebar = useSidebar();
  const sidebarWasOpen = useRef<boolean | null>(null);
  useEffect(() => {
    if (sidebar.isMobile) return;
    sidebarWasOpen.current = sidebar.open;
    if (sidebar.open) sidebar.setOpen(false);
    return () => { if (sidebarWasOpen.current) sidebar.setOpen(true); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebar.isMobile]);

  const utils = trpc.useUtils();
  useGoogleOAuthReturnToast(() => { utils.googleCalendar.myEvents.invalidate(); utils.googleAccount.status.invalidate(); });

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  const today = lisbonDayOf(nowMs);

  const search = useSearch();
  const [anchor, setAnchor] = useState<string>(() => {
    const d = new URLSearchParams(search).get("dia");
    return isRealDay(d) ? d : lisbonDayOf(Date.now());
  });
  const [view, setViewState] = useState<CalendarView>(() => {
    const saved = readLocal(LS_VIEW) as CalendarView | null;
    const mobile = typeof window !== "undefined" && window.innerWidth < 768;
    const allowed = mobile ? MOBILE_VIEWS : DESKTOP_VIEWS;
    return saved && allowed.includes(saved) ? saved : mobile ? "list" : "week";
  });
  const views = isMobile ? MOBILE_VIEWS : DESKTOP_VIEWS;
  const effView: CalendarView = views.includes(view) ? view : isMobile ? "list" : "week";
  const setView = (v: CalendarView) => { setViewState(v); writeLocal(LS_VIEW, v); };

  const [hidden, setHidden] = useState<Set<string>>(() => readHidden());
  const toggleCalendar = (id: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      writeLocal(LS_HIDDEN, JSON.stringify(Array.from(next)));
      return next;
    });
  };

  const days = useMemo(() => viewDays(effView, anchor), [effView, anchor]);
  const fromDay = days[0];
  const toDay = days[days.length - 1];
  const q = trpc.googleCalendar.myEvents.useQuery(
    { fromDay, toDay },
    { staleTime: 60_000, refetchInterval: 5 * 60_000, retry: false, placeholderData: (prev) => prev },
  );
  const data = q.data;
  const stale = q.isPlaceholderData;
  const calendars = data?.calendars ?? [];
  const calById = useMemo(() => new Map(calendars.map((c) => [c.id, c])), [calendars]);
  const events = useMemo(() => (data?.events ?? []).filter((e) => !hidden.has(e.calendarId)), [data?.events, hidden]);

  const [selected, setSelected] = useState<CalendarViewEvent | null>(null);
  const [newEvent, setNewEvent] = useState<NewEventInitial | null>(null);
  const [calendarsOpen, setCalendarsOpen] = useState(false);

  const openNew = (init?: Partial<NewEventInitial> & { startDay: string }) => {
    if (!init) { setNewEvent(defaultNewEvent(anchor, today, Date.now())); return; }
    const startTime = init.startTime ?? "09:00";
    const end = addLocalMinutes(init.startDay, startTime, 60);
    setNewEvent({ startDay: init.startDay, startTime, endDay: init.endDay ?? end.day, endTime: init.endTime ?? end.time, allDay: !!init.allDay });
  };
  const goToDay = (day: string) => { setAnchor(day); setView("day"); };

  const reason: CalendarViewReason = data?.reason ?? null;
  const needsGoogle = reason === "not_connected" || reason === "scope_missing" || reason === "reauth_required";
  const readFailed = !!q.error || reason === "error";

  const title = viewTitle(effView, anchor);

  // ── Conteúdo principal ──
  let body: React.ReactNode;
  if (q.isLoading && !data) {
    body = <div className="flex flex-1 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>;
  } else if (needsGoogle) {
    body = <ConnectPanel reason={reason} />;
  } else if (readFailed) {
    body = (
      <div className="flex flex-1 items-start justify-center p-6">
        <div role="alert" className="flex max-w-lg flex-wrap items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">Não foi possível ler o calendário.</p>
            <p className="text-xs opacity-90">{q.error?.message ?? data?.error ?? "A Google não respondeu."} Isto não quer dizer que a tua agenda está vazia.</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`} aria-hidden />Tentar de novo
          </Button>
        </div>
      </div>
    );
  } else if (effView === "month") {
    body = <MonthGrid days={days} anchor={anchor} today={today} events={events} onSelect={setSelected} onDay={goToDay} />;
  } else if (effView === "list") {
    body = <AgendaList days={days} today={today} events={events} calById={calById} onSelect={setSelected} />;
  } else {
    body = (
      <TimeGrid
        key={effView}
        days={days}
        today={today}
        nowMs={nowMs}
        events={events}
        onSelect={setSelected}
        onSlot={(day, minutes) => openNew({ startDay: day, startTime: `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}` })}
        onDay={goToDay}
      />
    );
  }

  const calendarList = (
    <CalendarList calendars={calendars} hidden={hidden} onToggle={toggleCalendar} />
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-1 flex items-center gap-2 text-lg font-bold"><CalendarDays className="h-5 w-5 text-primary" /> Calendário</h1>
        <Button size="sm" variant="outline" onClick={() => setAnchor(today)} disabled={!!needsGoogle}>Hoje</Button>
        <div className="flex items-center">
          <Button size="icon-sm" variant="ghost" aria-label="Anterior" onClick={() => setAnchor((a) => shiftAnchor(effView, a, -1))} disabled={!!needsGoogle}><ChevronLeft className="h-4 w-4" /></Button>
          <Button size="icon-sm" variant="ghost" aria-label="Seguinte" onClick={() => setAnchor((a) => shiftAnchor(effView, a, 1))} disabled={!!needsGoogle}><ChevronRight className="h-4 w-4" /></Button>
        </div>
        <span className="text-base font-semibold">{title}</span>
        {(q.isFetching || stale) && !q.isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="A atualizar" />}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {!needsGoogle && (
            <Button size="icon-sm" variant="ghost" title="Atualizar" aria-label="Atualizar" onClick={() => q.refetch()} disabled={q.isFetching}>
              <RefreshCw className={`h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} />
            </Button>
          )}
          {isMobile && !needsGoogle && (
            <Button size="sm" variant="ghost" onClick={() => setCalendarsOpen(true)}><Layers className="mr-1 h-4 w-4" />Calendários</Button>
          )}
          <div className="flex overflow-hidden rounded-md border border-primary" role="group" aria-label="Vista">
            {views.map((v) => (
              <button key={v} type="button" onClick={() => setView(v)} aria-pressed={effView === v}
                className={`px-3 py-1 text-xs font-medium ${effView === v ? "bg-primary text-primary-foreground" : "bg-white text-primary hover:bg-primary/10 dark:bg-transparent"}`}>
                {CALENDAR_VIEW_LABELS[v]}
              </button>
            ))}
          </div>
          {isMobile && !needsGoogle && (
            <Button size="sm" variant="selected" onClick={() => openNew()}><Plus className="mr-1 h-4 w-4" />Novo</Button>
          )}
        </div>
      </div>

      {data?.enabled && (data.failedCalendars.length > 0 || data.truncated) && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            {data.failedCalendars.length > 0 && <>Não foi possível ler: {data.failedCalendars.map((c) => c.name).join(", ")}. </>}
            {data.truncated && <>Há mais eventos nestes dias do que os mostrados — escolhe uma vista mais curta.</>}
          </span>
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => q.refetch()} disabled={q.isFetching}>Tentar de novo</Button>
        </div>
      )}

      <Card className="overflow-hidden p-0">
        <div className="flex h-[calc(100vh-9.5rem)] min-h-[480px]">
          {!isMobile && (
            <aside className="flex w-56 shrink-0 flex-col gap-3 overflow-y-auto border-r p-3" aria-label="Calendários">
              <Button className="justify-start rounded-full shadow-sm" variant="selected" onClick={() => openNew()} disabled={!!needsGoogle || readFailed}>
                <Plus className="mr-1 h-4 w-4" />Novo evento
              </Button>
              <MiniMonth anchor={anchor} today={today} highlight={days} onPick={(d) => setAnchor(d)} />
              {!needsGoogle && calendarList}
              <p className="mt-auto text-[11px] leading-snug text-muted-foreground">Lido ao vivo do teu Google Calendar. Só tu vês a tua agenda.</p>
            </aside>
          )}
          <div className="relative flex min-w-0 flex-1 flex-col">
            {body}
            {/* A carregar outros dias ≠ dias vazios */}
            {stale && !needsGoogle && !readFailed && (
              <div className="pointer-events-none absolute left-1/2 top-2 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full border bg-background/95 px-3 py-1 text-xs text-muted-foreground shadow" role="status">
                <Loader2 className="h-3 w-3 animate-spin" />A carregar…
              </div>
            )}
          </div>
        </div>
      </Card>

      <Dialog open={calendarsOpen} onOpenChange={setCalendarsOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Calendários</DialogTitle><DialogDescription>Escolhe o que aparece. Só tu vês a tua agenda.</DialogDescription></DialogHeader>
          {calendarList}
        </DialogContent>
      </Dialog>

      <EventDetails event={selected} calendar={selected ? calById.get(selected.calendarId) ?? null : null} onClose={() => setSelected(null)} />

      <NewEventDialog
        initial={newEvent}
        onClose={() => setNewEvent(null)}
        onCreated={(startDay) => {
          setNewEvent(null);
          if (!days.includes(startDay)) setAnchor(startDay);
          utils.googleCalendar.myEvents.invalidate();
        }}
      />
    </div>
  );
}

// ─── Sem conta / sem Calendário / religar ───────────────────────────────────

function ConnectPanel({ reason }: { reason: CalendarViewReason }) {
  const activate = googleFeaturesHref(["calendar"], "/calendario");
  return (
    <div className="flex flex-1 items-start justify-center overflow-y-auto p-6">
      <div className="w-full max-w-md space-y-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">A tua agenda Google, aqui dentro</h2>
          <p className="text-sm text-muted-foreground">
            {reason === "not_connected" && "Liga a tua conta Google @multipark (com o Calendário) para veres aqui os teus eventos, os turnos e prazos do calendário Multipark, e para criares eventos e reuniões com Meet."}
            {reason === "scope_missing" && "A tua conta Google está ligada, mas falta autorizar o Calendário."}
            {reason === "reauth_required" && "A autorização da tua conta Google expirou ou foi revogada. Volta a ligar para veres a tua agenda."}
          </p>
        </div>
        {reason === "scope_missing" && (
          <Button asChild variant="selected"><a href={activate}><CalendarDays className="mr-1 h-4 w-4" />Ativar Calendário</a></Button>
        )}
        <GoogleAccountCard compact returnTo="/calendario" features={["gmail", "calendar"]} />
        {reason === "reauth_required" && (
          <p className="text-xs text-muted-foreground">Se a conta aparecer como ligada, <a className="text-primary underline" href={activate}>volta a autorizar o Calendário</a>.</p>
        )}
        <p className="text-[11.5px] text-muted-foreground">Só tu vês a tua agenda. O dashboard lê-a no momento e não guarda os teus eventos.</p>
      </div>
    </div>
  );
}

// ─── Lista de calendários (mostrar / esconder) ──────────────────────────────

function CalendarList({ calendars, hidden, onToggle }: { calendars: CalendarViewCalendar[]; hidden: Set<string>; onToggle: (id: string) => void }) {
  if (!calendars.length) return null;
  return (
    <div className="space-y-1">
      <div className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Os meus calendários</div>
      {calendars.map((c) => {
        const on = !hidden.has(c.id);
        return (
          <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-[13px] hover:bg-accent">
            <Checkbox checked={on} onCheckedChange={() => onToggle(c.id)} aria-label={`Mostrar ${c.name}`}
              style={{ backgroundColor: on ? c.color : undefined, borderColor: c.color, color: readableTextOn(c.color) }} />
            <span className="min-w-0 flex-1 truncate" title={c.name}>{c.primary ? `${c.name}` : c.name}</span>
            {c.multipark && <span className="shrink-0 rounded bg-primary/10 px-1 text-[10px] font-semibold text-primary" title="Turnos, formação e prazos do dashboard">dashboard</span>}
          </label>
        );
      })}
    </div>
  );
}

// ─── Mês pequeno (navegar) ──────────────────────────────────────────────────

function MiniMonth({ anchor, today, highlight, onPick }: { anchor: string; today: string; highlight: string[]; onPick: (day: string) => void }) {
  const [month, setMonth] = useState(() => `${anchor.slice(0, 7)}-01`);
  useEffect(() => { setMonth(`${anchor.slice(0, 7)}-01`); }, [anchor]);
  const days = useMemo(() => monthGridDays(month), [month]);
  const hl = useMemo(() => new Set(highlight), [highlight]);
  return (
    <div className="select-none">
      <div className="mb-1 flex items-center justify-between">
        <span className="pl-1 text-[13px] font-semibold">{viewTitle("month", month)}</span>
        <div className="flex">
          <button type="button" className="rounded p-1 hover:bg-accent" aria-label="Mês anterior" onClick={() => setMonth((m) => shiftAnchor("month", m, -1))}><ChevronLeft className="h-3.5 w-3.5" /></button>
          <button type="button" className="rounded p-1 hover:bg-accent" aria-label="Mês seguinte" onClick={() => setMonth((m) => shiftAnchor("month", m, 1))}><ChevronRight className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      <div className="grid grid-cols-7 text-center text-[10px] text-muted-foreground">
        {MINI_WEEKDAYS.map((w, i) => <span key={i} className="py-0.5">{w}</span>)}
      </div>
      <div className="grid grid-cols-7 text-center text-[11px]">
        {days.map((d) => {
          const inMonth = d.slice(0, 7) === month.slice(0, 7);
          const isToday = d === today;
          return (
            <button key={d} type="button" onClick={() => onPick(d)}
              className={`mx-auto my-px flex h-6 w-6 items-center justify-center rounded-full ${isToday ? "bg-primary font-semibold text-primary-foreground" : hl.has(d) ? "bg-primary/15 text-primary" : "hover:bg-accent"} ${!inMonth && !isToday ? "text-muted-foreground/60" : ""}`}>
              {Number(d.slice(8, 10))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Dia / Semana: grelha das horas ─────────────────────────────────────────

function eventTimeRange(ev: CalendarViewEvent): string {
  return `${lisbonHHMM(Date.parse(ev.start))} – ${lisbonHHMM(Date.parse(ev.end))}`;
}

function TimeGrid({ days, today, nowMs, events, onSelect, onSlot, onDay }: {
  days: string[]; today: string; nowMs: number; events: CalendarViewEvent[];
  onSelect: (e: CalendarViewEvent) => void; onSlot: (day: string, minutes: number) => void; onDay: (day: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // Abre nas 07:00 (como o Google: o dia de trabalho à vista, 0–24 com scroll).
    if (scrollRef.current) scrollRef.current.scrollTop = SCROLL_TO_HOUR * HOUR_PX;
  }, []);

  const allDay = useMemo(() => events.filter(isAllDayLike), [events]);
  const timed = useMemo(() => events.filter((e) => !isAllDayLike(e)), [events]);
  const bars = useMemo(() => allDayLanes(allDay, days), [allDay, days]);
  const lanes = bars.reduce((m, b) => Math.max(m, b.lane + 1), 0);
  const perDay = useMemo(() => {
    const map = new Map<string, PlacedSegment[]>();
    const segs = timed.flatMap((e) => daySegments(e, days));
    for (const d of days) map.set(d, layoutDay(segs.filter((s) => s.day === d), 20));
    return map;
  }, [timed, days]);
  const nowMin = lisbonWallMinutes(nowMs);
  const cols = { gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` };

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      {/* Cabeçalho fixo: dias + faixa do dia inteiro */}
      <div className="sticky top-0 z-40 border-b bg-background">
        <div className="flex">
          <div className="w-14 shrink-0" />
          <div className="grid flex-1" style={cols}>
            {days.map((d) => {
              const isToday = d === today;
              return (
                <button key={d} type="button" onClick={() => onDay(d)} className="flex flex-col items-center py-1.5 hover:bg-accent/50" title="Ver o dia">
                  <span className={`text-[11px] font-medium uppercase ${isToday ? "text-primary" : "text-muted-foreground"}`}>{PT_WEEKDAYS_SHORT[weekdayIndex(d)]}</span>
                  <span className={`flex h-8 w-8 items-center justify-center rounded-full text-lg ${isToday ? "bg-primary font-semibold text-primary-foreground" : "text-foreground"}`}>{Number(d.slice(8, 10))}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex border-t">
          <div className="flex w-14 shrink-0 items-start justify-end pr-1.5 pt-1 text-[10px] text-muted-foreground">{lanes ? "dia inteiro" : ""}</div>
          <div className="relative max-h-[92px] flex-1 overflow-y-auto" style={{ height: Math.max(lanes, 1) * 22 + 4 }}>
            <div className="absolute inset-0 grid" style={cols}>
              {days.map((d) => <div key={d} className="border-l" />)}
            </div>
            {bars.map((b) => (
              <button key={`${b.event.calendarId}:${b.event.id}`} type="button" onClick={() => onSelect(b.event)}
                className={`absolute truncate rounded px-1.5 text-left text-[11.5px] font-medium leading-5 shadow-sm ${b.event.declined ? "line-through opacity-60" : ""}`}
                style={{
                  top: b.lane * 22 + 2, height: 20,
                  left: `calc(${(b.startCol / days.length) * 100}% + 2px)`, width: `calc(${(b.span / days.length) * 100}% - 4px)`,
                  backgroundColor: b.event.color, color: readableTextOn(b.event.color),
                }}
                title={b.event.title}>
                {b.continuesBefore ? "‹ " : ""}{b.event.allDay ? "" : `${lisbonHHMM(Date.parse(b.event.start))} `}{b.event.title}{b.continuesAfter ? " ›" : ""}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Horas */}
      <div className="relative flex" style={{ height: 24 * HOUR_PX }}>
        <div className="relative w-14 shrink-0">
          {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
            <span key={h} className="absolute right-1.5 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground" style={{ top: h * HOUR_PX }}>
              {String(h).padStart(2, "0")}:00
            </span>
          ))}
        </div>
        <div className="grid flex-1" style={{ ...cols, backgroundImage: `repeating-linear-gradient(to bottom, var(--border) 0, var(--border) 1px, transparent 1px, transparent ${HOUR_PX}px)` }}>
          {days.map((d) => (
            <div key={d} className="relative border-l"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const minutes = Math.max(0, Math.min(23 * 60 + 30, Math.floor(((e.clientY - rect.top) / HOUR_PX) * 2) * 30));
                onSlot(d, minutes);
              }}>
              {(perDay.get(d) ?? []).map((s) => {
                const top = (s.startMin / 60) * HOUR_PX;
                const height = Math.max(((s.endMin - s.startMin) / 60) * HOUR_PX - 2, 18);
                const ev = s.event;
                const fg = readableTextOn(ev.color);
                return (
                  <button key={`${ev.calendarId}:${ev.id}:${d}`} type="button"
                    onClick={(e) => { e.stopPropagation(); onSelect(ev); }}
                    className={`absolute z-10 overflow-hidden rounded-md px-1.5 py-0.5 text-left text-[11.5px] leading-tight shadow-sm ring-1 ring-background hover:z-20 focus:z-20 ${ev.declined ? "opacity-60" : ""} ${ev.busyOnly ? "opacity-80" : ""}`}
                    style={{
                      top, height,
                      left: `calc(${(s.col / s.cols) * 100}% + 1px)`, width: `calc(${100 / s.cols}% - 3px)`,
                      backgroundColor: ev.color, color: fg,
                    }}
                    title={`${ev.title} · ${eventTimeRange(ev)}`}>
                    {height < 34 ? (
                      <div className={`truncate ${ev.declined ? "line-through" : ""}`}><span className="font-semibold">{ev.title}</span>, {lisbonHHMM(Date.parse(ev.start))}</div>
                    ) : (
                      <>
                        <div className={`font-semibold ${ev.declined ? "line-through" : ""} ${height < 52 ? "truncate" : "line-clamp-2"}`}>{ev.title}</div>
                        <div className="truncate opacity-90">{eventTimeRange(ev)}</div>
                        {ev.location && height >= 64 && <div className="truncate opacity-90">{ev.location}</div>}
                      </>
                    )}
                  </button>
                );
              })}
              {d === today && (
                <div className="pointer-events-none absolute left-0 right-0 z-30" style={{ top: (nowMin / 60) * HOUR_PX }} aria-hidden>
                  <div className="relative h-0.5 bg-red-500"><span className="absolute -left-1.5 -top-[5px] h-3 w-3 rounded-full bg-red-500" /></div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Mês ────────────────────────────────────────────────────────────────────

function MonthGrid({ days, anchor, today, events, onSelect, onDay }: {
  days: string[]; anchor: string; today: string; events: CalendarViewEvent[]; onSelect: (e: CalendarViewEvent) => void; onDay: (day: string) => void;
}) {
  const weeks: string[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  const month = anchor.slice(0, 7);
  const MAX = 3;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid grid-cols-7 border-b">
        {PT_WEEKDAYS_SHORT.map((w) => <div key={w} className="border-l py-1 text-center text-[11px] font-medium uppercase text-muted-foreground first:border-l-0">{w}</div>)}
      </div>
      <div className="grid min-h-0 flex-1 overflow-y-auto" style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(84px, 1fr))` }}>
        {weeks.map((w) => (
          <div key={w[0]} className="grid grid-cols-7 border-b last:border-b-0">
            {w.map((d) => {
              const list = eventsOnDay(events, d);
              const inMonth = d.slice(0, 7) === month;
              const isToday = d === today;
              return (
                <div key={d} className={`flex min-w-0 flex-col gap-0.5 overflow-hidden border-l p-1 first:border-l-0 ${inMonth ? "" : "bg-muted/30"}`}>
                  <button type="button" onClick={() => onDay(d)} title="Ver o dia"
                    className={`mx-auto flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[12px] ${isToday ? "bg-primary font-semibold text-primary-foreground" : inMonth ? "hover:bg-accent" : "text-muted-foreground hover:bg-accent"}`}>
                    {Number(d.slice(8, 10)) === 1 ? `1 ${["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"][Number(d.slice(5, 7)) - 1]}` : Number(d.slice(8, 10))}
                  </button>
                  {list.slice(0, MAX).map((ev) => {
                    const full = isAllDayLike(ev);
                    return (
                      <button key={`${ev.calendarId}:${ev.id}`} type="button" onClick={() => onSelect(ev)} title={ev.title}
                        className={`flex min-w-0 items-center gap-1 truncate rounded px-1 text-left text-[11px] leading-[18px] ${full ? "font-medium" : "hover:bg-accent"} ${ev.declined ? "line-through opacity-60" : ""}`}
                        style={full ? { backgroundColor: ev.color, color: readableTextOn(ev.color) } : undefined}>
                        {!full && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: ev.color }} />}
                        {!full && <span className="shrink-0 tabular-nums text-muted-foreground">{lisbonHHMM(Date.parse(ev.start))}</span>}
                        <span className="truncate">{ev.title}</span>
                      </button>
                    );
                  })}
                  {list.length > MAX && (
                    <button type="button" onClick={() => onDay(d)} className="truncate rounded px-1 text-left text-[11px] font-medium text-muted-foreground hover:bg-accent">+{list.length - MAX} mais</button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Lista (telemóvel) ──────────────────────────────────────────────────────

function AgendaList({ days, today, events, calById, onSelect }: {
  days: string[]; today: string; events: CalendarViewEvent[]; calById: Map<string, CalendarViewCalendar>; onSelect: (e: CalendarViewEvent) => void;
}) {
  const groups = days.map((d) => ({ day: d, list: eventsOnDay(events, d) })).filter((g) => g.list.length > 0);
  if (!groups.length) {
    return <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">Sem eventos de {Number(days[0].slice(8, 10))} a {Number(days[days.length - 1].slice(8, 10))} — a agenda está livre.</div>;
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {groups.map((g) => (
        <section key={g.day} className="border-b px-3 py-2">
          <h3 className={`mb-1 text-[12px] font-semibold uppercase tracking-wide ${g.day === today ? "text-primary" : "text-muted-foreground"}`}>
            {g.day === today ? "Hoje · " : ""}{PT_WEEKDAYS_SHORT[weekdayIndex(g.day)]}, {Number(g.day.slice(8, 10))}/{g.day.slice(5, 7)}
          </h3>
          <ul className="space-y-1">
            {g.list.map((ev) => {
              const full = isAllDayLike(ev);
              const s = Date.parse(ev.start);
              return (
                <li key={`${ev.calendarId}:${ev.id}`}>
                  <button type="button" onClick={() => onSelect(ev)} className="flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-left hover:bg-accent">
                    <span className="w-24 shrink-0 text-[12px] tabular-nums text-muted-foreground">
                      {full ? "Dia inteiro" : lisbonDayOf(s) === g.day ? eventTimeRange(ev) : `até ${lisbonHHMM(Date.parse(ev.end))}`}
                    </span>
                    <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: ev.color }} />
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-[13.5px] font-medium ${ev.declined ? "line-through opacity-60" : ""}`}>{ev.title}</span>
                      <span className="block truncate text-[11.5px] text-muted-foreground">
                        {[ev.location, ev.meetLink ? "Google Meet" : null, calById.get(ev.calendarId)?.name].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ─── Detalhes do evento ─────────────────────────────────────────────────────

function EventDetails({ event, calendar, onClose }: { event: CalendarViewEvent | null; calendar: CalendarViewCalendar | null; onClose: () => void }) {
  const ev = event;
  const locationUrl = ev?.location ? safeHttpsUrl(ev.location) : null;
  return (
    <Dialog open={!!ev} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        {ev && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-start gap-2 pr-6">
                <span className="mt-1.5 h-3.5 w-3.5 shrink-0 rounded" style={{ backgroundColor: ev.color }} />
                <span className={`break-words ${ev.declined ? "line-through" : ""}`}>{ev.title}</span>
              </DialogTitle>
              <DialogDescription>{eventWhenLabel(ev)}</DialogDescription>
            </DialogHeader>
            <div className="space-y-2.5 text-sm">
              {ev.declined && <p className="text-xs text-muted-foreground">Recusaste este convite.</p>}
              {ev.busyOnly && <p className="text-xs text-muted-foreground">Evento privado: só se sabe que está ocupado.</p>}
              {ev.meetLink && (
                <div className="flex items-center gap-2">
                  <Video className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <Button asChild size="sm" variant="selected"><a href={ev.meetLink} target="_blank" rel="noopener noreferrer">Entrar</a></Button>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">{ev.meetLink.replace(/^https:\/\//, "")}</span>
                </div>
              )}
              {ev.location && (
                <div className="flex items-start gap-2">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <a className="min-w-0 break-words text-primary hover:underline" target="_blank" rel="noopener noreferrer"
                    href={locationUrl ?? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.location)}`}>{ev.location}</a>
                </div>
              )}
              {ev.description && (
                <div className="flex items-start gap-2">
                  <AlignLeft className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <p className="max-h-48 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words text-[13px]">{ev.description}</p>
                </div>
              )}
              {calendar && (
                <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <CalendarDays className="h-4 w-4 shrink-0" />
                  <span className="truncate">{calendar.name}{calendar.multipark ? " (turnos, formação e prazos do dashboard)" : ""}</span>
                </div>
              )}
            </div>
            {ev.htmlLink && (
              <DialogFooter>
                <Button asChild variant="outline" size="sm">
                  <a href={ev.htmlLink} target="_blank" rel="noopener noreferrer"><ExternalLink className="mr-1 h-4 w-4" />Abrir no Google Calendar</a>
                </Button>
              </DialogFooter>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Novo evento ────────────────────────────────────────────────────────────

function NewEventDialog({ initial, onClose, onCreated }: { initial: NewEventInitial | null; onClose: () => void; onCreated: (startDay: string) => void }) {
  const [title, setTitle] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [startDay, setStartDay] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endDay, setEndDay] = useState("");
  const [endTime, setEndTime] = useState("10:00");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [guestsText, setGuestsText] = useState("");
  const [withMeet, setWithMeet] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!initial) return;
    setTitle(""); setAllDay(initial.allDay); setStartDay(initial.startDay); setStartTime(initial.startTime);
    setEndDay(initial.endDay); setEndTime(initial.endTime); setLocation(""); setDescription(""); setGuestsText(""); setWithMeet(false); setError(null);
  }, [initial]);

  const create = trpc.googleCalendar.createEvent.useMutation({
    onSuccess: (r) => {
      toast.success(r.guests ? `Evento criado no teu Google Calendar e convite enviado a ${r.guests} pessoa(s).` : "Evento criado no teu Google Calendar.");
      onCreated(startDay);
    },
    onError: (e) => setError(e.message),
  });

  // Mudar o início leva o fim atrás (mantém a duração), como no Google.
  const changeStart = (day: string, time: string) => {
    if (isRealDay(startDay) && isRealDay(endDay) && /^\d{2}:\d{2}$/.test(startTime) && /^\d{2}:\d{2}$/.test(endTime) && isRealDay(day) && /^\d{2}:\d{2}$/.test(time)) {
      const dur = Math.max(allDay ? 0 : 15, localMinutesBetween(startDay, startTime, endDay, endTime));
      const end = addLocalMinutes(day, time, dur);
      setEndDay(end.day);
      if (!allDay) setEndTime(end.time);
    }
    setStartDay(day);
    setStartTime(time);
  };

  const guests = splitGuests(guestsText);
  const payload: CreateCalendarEventInput = {
    title, allDay, startDay, endDay,
    ...(allDay ? {} : { startTime, endTime }),
    ...(location.trim() ? { location: location.trim() } : {}),
    ...(description.trim() ? { description } : {}),
    guests, withMeet,
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const check = validateNewCalendarEvent(payload, { nowMs: Date.now() });
    if (!check.ok) { setError(check.error); return; }
    setError(null);
    create.mutate(payload);
  };

  return (
    <Dialog open={!!initial} onOpenChange={(o) => { if (!o && !create.isPending) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Novo evento</DialogTitle>
          <DialogDescription>Fica no teu Google Calendar (calendário principal). Horas de Lisboa.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <Input autoFocus placeholder="Título" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} aria-label="Título" className="text-base" />
          <div className="flex items-center gap-2">
            <Switch id="cal-allday" checked={allDay} onCheckedChange={(v) => setAllDay(!!v)} />
            <Label htmlFor="cal-allday" className="text-sm font-normal">Dia inteiro</Label>
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <div className="space-y-1">
              <Label htmlFor="cal-start-day" className="text-xs text-muted-foreground">Início</Label>
              <Input id="cal-start-day" type="date" value={startDay} onChange={(e) => changeStart(e.target.value, startTime)} />
            </div>
            {!allDay && (
              <div className="space-y-1">
                <Label htmlFor="cal-start-time" className="text-xs text-muted-foreground">Hora</Label>
                <Input id="cal-start-time" type="time" step={300} value={startTime} onChange={(e) => changeStart(startDay, e.target.value)} className="w-28" />
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="cal-end-day" className="text-xs text-muted-foreground">Fim</Label>
              <Input id="cal-end-day" type="date" value={endDay} min={startDay || undefined} onChange={(e) => setEndDay(e.target.value)} />
            </div>
            {!allDay && (
              <div className="space-y-1">
                <Label htmlFor="cal-end-time" className="text-xs text-muted-foreground">Hora</Label>
                <Input id="cal-end-time" type="time" step={300} value={endTime} onChange={(e) => setEndTime(e.target.value)} className="w-28" />
              </div>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="cal-guests" className="flex items-center gap-1 text-xs text-muted-foreground"><Users className="h-3.5 w-3.5" />Convidados (opcional)</Label>
            <Input id="cal-guests" placeholder="emails separados por vírgulas" value={guestsText} onChange={(e) => setGuestsText(e.target.value)} />
            {guests.length > 0 && (
              <p className={`text-[11.5px] ${guests.length > CALENDAR_MAX_GUESTS ? "text-red-600" : "text-muted-foreground"}`}>
                {guests.length} convidado(s) — recebem o convite por email do Google. Máximo {CALENDAR_MAX_GUESTS}.
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Switch id="cal-meet" checked={withMeet} onCheckedChange={(v) => setWithMeet(!!v)} />
            <Label htmlFor="cal-meet" className="flex items-center gap-1 text-sm font-normal"><Video className="h-4 w-4 text-muted-foreground" />Adicionar videochamada Google Meet</Label>
          </div>
          <div className="space-y-1">
            <Label htmlFor="cal-location" className="flex items-center gap-1 text-xs text-muted-foreground"><MapPin className="h-3.5 w-3.5" />Local (opcional)</Label>
            <Input id="cal-location" value={location} onChange={(e) => setLocation(e.target.value)} maxLength={250} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cal-desc" className="flex items-center gap-1 text-xs text-muted-foreground"><AlignLeft className="h-3.5 w-3.5" />Descrição (opcional)</Label>
            <Textarea id="cal-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} />
          </div>
          {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={create.isPending}>Cancelar</Button>
            <Button type="submit" variant="selected" disabled={create.isPending}>
              {create.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}Guardar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
