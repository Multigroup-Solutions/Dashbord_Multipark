import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { useOpenEmployee } from "@/hooks/useOpenEmployee";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { useTableSort } from "@/components/SortableTable";
import { UniDateNav, mondayOf } from "@/components/DateRangeNav";
import { AvailabilityDayFields, isDayMarked, type AvailabilityDayState } from "@/components/AvailabilityDayFields";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  CalendarDays,
  CheckCircle2,
  Clock,
  Loader2,
  Mail,
  MapPin,
  MessageCircle,
  Moon,
  Search,
  SlidersHorizontal,
  Sun,
  Users,
  X,
} from "lucide-react";
import { can } from "@shared/access";
import { CITY_KEYS, CITY_LABELS, matchCityKey, type CityKey } from "@shared/city";
import { HOUR_OPTIONS } from "@shared/availabilityWindow";
import { AVAILABILITY_STATUS_LABELS, type AvailabilityStatusFilter } from "@shared/availabilityGroups";
import {
  DEFAULT_AVAILABILITY_FILTERS,
  applyAvailabilityFilters,
  availabilityPopoverFilterCount,
  availabilitySendTarget,
  availabilityStatusTiles,
  availabilityWindowMode,
  closedSectionsNote,
  emptyAvailabilityMessage,
  hasActiveAvailabilityFilters,
  hiddenGridRowIds,
  matchesWindowFilter,
  perDayShiftTotals,
  sendAllLabel,
  sendBlockReason,
  sendNeedsAllConfirm,
  sendTargetBreakdown,
  sendTargetPhrase,
  sendTargetShort,
  shortDayHeader,
  toggleStatusTile,
  windowFilterLabel,
  type AvailabilityCityFilter,
  type AvailabilityFilters,
} from "@shared/availabilityFilters";
import { AvailabilityGrid, STATUS_TONE, TriCheckbox, type GridOpenState } from "./AvailabilityGrid";
import { AvailabilityEmailDialog } from "./AvailabilityEmailDialog";
import { AvailabilityWhatsAppDialog } from "./AvailabilityWhatsAppDialog";
import type { OverviewExtra } from "./availabilityTypes";

const ddmm = (isoDay: string) => `${isoDay.slice(8, 10)}/${isoDay.slice(5, 7)}`;

/** Chip de filtro ligado, com "×" para o tirar. */
function ActiveChip({ children, onClear, label }: { children: ReactNode; onClear: () => void; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 h-7 pl-2.5 pr-1 rounded-full border border-primary/30 bg-primary/5 text-xs text-primary">
      {children}
      <button type="button" aria-label={`Tirar filtro: ${label}`} className="h-5 w-5 inline-flex items-center justify-center rounded-full hover:bg-primary/10" onClick={onClear}>
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

/**
 * Disponibilidade dos extras (hub de gestão, página Disponibilidade).
 *
 * 14 out 2026 (Jorge: "é uma grande confusão, não se percebe nada") — quatro
 * blocos, de cima para baixo:
 *   1. a semana + os quadrados Todos · Disponíveis · Indisponíveis · Sem
 *      resposta (carregar = filtrar) + quantos há por dia e turno;
 *   2. UMA barra de filtros: pesquisa, cidade (segue a de cima) e "Filtros"
 *      (disponível em dia/horas, sem mensagem nas últimas 24 h) com o número
 *      de filtros ligados — e os ligados aparecem em chips para tirar;
 *   3. a barra de envio: diz sempre PARA QUEM (selecionados ou filtrados) e
 *      abre o diálogo do email ou do WhatsApp (os dois com teste e "Confirmar");
 *   4. a grelha por cidade (AvailabilityGrid): "Disponíveis" aberta, "Sem
 *      resposta" e "Indisponíveis" fechadas com o número à vista.
 * Regras puras em shared/availabilityFilters.ts.
 */
export function AvailabilitySection() {
  const { user } = useAuth();
  // O servidor exige isto para enviar/marcar (requireAccess); o ecrã só não
  // oferece o que vai ser recusado.
  const canEdit = can(user as any, "disponibilidade_extras", "edit");
  const canWhatsApp = can(user as any, "whatsapp", "edit");

  const hints = trpc.extrasAvailability.weekHints.useQuery();
  const [weekStart, setWeekStart] = useState<string>("");
  // assim que chegam as sugestões, default = próxima segunda
  const effectiveWeek = weekStart || hints.data?.next || "";
  const overview = trpc.extrasAvailability.overview.useQuery({ weekStart: effectiveWeek }, { enabled: !!effectiveWeek });
  const o = overview.data;
  // Última vez que cada extra trabalhou (histórico Multipark/ponto/extras-dia)
  const lastWorked = trpc.rh.lastWorkedMap.useQuery();

  // ── Filtros ──
  const [filters, setFilters] = useState<AvailabilityFilters>(DEFAULT_AVAILABILITY_FILTERS);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  // Cidade escolhida em cima (filtro global — Jorge, 2 out 2026: "aqui só deve
  // aparecer a cidade escolhida"): manda sobre a cidade daqui.
  const globalFilters = useGlobalFilters();
  const globalCity = useMemo<CityKey | null>(() => {
    const name = globalFilters.cities.find((p) => p.id === globalFilters.cityId)?.name;
    return name ? matchCityKey(name) : null;
  }, [globalFilters.cities, globalFilters.cityId]);
  const cityFilter: AvailabilityCityFilter = globalCity ?? filters.city;
  const effective = useMemo<AvailabilityFilters>(() => ({ ...filters, city: cityFilter }), [filters, cityFilter]);
  /**
   * Muda um filtro. Tudo menos a pesquisa muda o ALVO do envio → limpa a
   * seleção (nunca enviar a quem já não se vê). A pesquisa é uma ferramenta
   * de procura (procurar → marcar → procurar outro → marcar): não limpa, e
   * quem fica marcado fora da vista conta-se à parte na barra de envio.
   */
  const patchFilters = useCallback((patch: Partial<AvailabilityFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    if (Object.keys(patch).some((k) => k !== "search")) setSelectedIds(new Set());
  }, []);
  // Mudar a cidade em cima também muda o alvo → limpa a seleção.
  useEffect(() => { setSelectedIds(new Set()); }, [globalCity]);
  // Mudar de semana também (auditoria 14 out 2026): o pedido é desta semana, a seleção era da outra.
  useEffect(() => { setSelectedIds(new Set()); }, [effectiveWeek]);
  // Com a cidade presa à de cima, pôr a daqui em "todas" não muda nada (a de cima manda).
  const clearAllFilters = () => patchFilters({ ...DEFAULT_AVAILABILITY_FILTERS });

  const universe = useMemo(() => o?.extras ?? [], [o]);
  // O conjunto que a grelha mostra E o alvo de "enviar aos filtrados" (o que envio é o que vejo).
  const shownExtras = useMemo(
    () => applyAvailabilityFilters(universe, effective).map((e) => ({ ...e, lastWorked: lastWorked.data?.[e.employeeId] ?? "" })),
    [universe, effective, lastWorked.data],
  );
  // A ordenação da coluna só REORDENA (não filtra): o conjunto é o mesmo para a seleção, os totais e o envio.
  const availSort = useTableSort(shownExtras);
  const openEmployee = useOpenEmployee();

  const tiles = useMemo(() => availabilityStatusTiles(universe, effective), [universe, effective]);
  const cityCounts = useMemo(() => {
    const counts = { all: universe.length, none: 0 } as Record<string, number>;
    for (const key of CITY_KEYS) counts[key] = 0;
    for (const e of universe) counts[e.city ?? "none"]++;
    return counts;
  }, [universe]);
  const notContacted24hCount = useMemo(() => universe.filter((e) => !e.contactedWithin24h).length, [universe]);
  const windowMode = availabilityWindowMode(filters);
  const windowMatchCount = useMemo(
    () => (windowMode === "day" || windowMode === "hours" ? universe.filter((e) => matchesWindowFilter(e.days, filters)).length : 0),
    [universe, filters, windowMode],
  );
  const popoverCount = availabilityPopoverFilterCount(effective);
  const anyFilter = hasActiveAvailabilityFilters(effective, { cityLocked: !!globalCity });
  const searching = filters.search.trim().length > 0;

  // Semana em texto. `weekLabel` = a MESMA fórmula do email no servidor
  // ("Segunda 14/09 a Domingo 20/09"); `weekShortLabel` = "14/09 a 20/09" para o WhatsApp.
  const dayHeaders = useMemo(() => o?.dayHeaders ?? [], [o]);
  const weekLabel = dayHeaders.length ? `${dayHeaders[0].label} a ${dayHeaders[dayHeaders.length - 1].label}` : effectiveWeek;
  const weekShortLabel = dayHeaders.length ? `${ddmm(dayHeaders[0].day)} a ${ddmm(dayHeaders[dayHeaders.length - 1].day)}` : effectiveWeek;
  const dayLabel = (day: string) => dayHeaders.find((h) => h.day === day)?.label ?? day;

  // Totais por dia do conjunto filtrado (os do servidor contam o universo e não batiam com a grelha).
  const shownPerDay = useMemo(() => perDayShiftTotals(dayHeaders.map((h) => h.day), shownExtras), [dayHeaders, shownExtras]);
  const shownResponded = shownExtras.filter((e) => e.responded).length;
  const shownWithPhone = shownExtras.filter((e) => !!e.phoneE164).length;

  // ── Destinatários (o mesmo para email e WhatsApp) ──
  const target = useMemo(
    () => availabilitySendTarget(universe, shownExtras, selectedIds, { filtersActive: anyFilter }),
    [universe, shownExtras, selectedIds, anyFilter],
  );
  const targetPhrase = sendTargetPhrase(target.scope, target.rows.length) + (target.scope === "all" && globalCity ? ` de ${CITY_LABELS[globalCity]}` : "");
  const targetWithPhone = target.rows.filter((e) => !!e.phoneE164).length;
  const shownSelectedCount = useMemo(() => shownExtras.filter((x) => selectedIds.has(x.employeeId)).length, [shownExtras, selectedIds]);
  const allShownSelected = shownExtras.length > 0 && shownSelectedCount === shownExtras.length;
  function toggleMany(rows: { employeeId: number }[], checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const x of rows) {
        if (checked) next.add(x.employeeId);
        else next.delete(x.employeeId);
      }
      return next;
    });
  }

  // ── Diálogos de envio ──
  const [note, setNote] = useState("");
  const [emailOpen, setEmailOpen] = useState(false);
  const [waOpen, setWaOpen] = useState(false);
  const [waPrefill, setWaPrefill] = useState<{ text: string; seq: number } | null>(null);
  const sendTextToWhatsApp = (text: string) => {
    setWaPrefill((prev) => ({ text, seq: (prev?.seq ?? 0) + 1 }));
    setEmailOpen(false);
    if (canWhatsApp) setWaOpen(true);
    else toast.error("Sem permissão para enviar WhatsApp.");
  };

  // ── Marcar disponibilidade POR um extra (backoffice, pedido Jorge 2026-09-10) ──
  // O diálogo edita a semana escolhida, com os mesmos campos que o extra tem na
  // página dele; guardar substitui a semana inteira (mesma semântica de `setMyWeek`).
  const [availEdit, setAvailEdit] = useState<null | { employeeId: number; fullName: string; days: AvailabilityDayState[] }>(null);
  const setForEmployee = trpc.extrasAvailability.setForEmployee.useMutation({
    onSuccess: (r) => {
      toast.success(
        r.saved > 0
          ? `Disponibilidade de ${r.employeeName} guardada (${r.saved} dia${r.saved === 1 ? "" : "s"}).`
          : `Disponibilidade de ${r.employeeName} limpa para esta semana.`,
      );
      setAvailEdit(null);
      overview.refetch();
    },
    onError: (e) => toast.error(e.message),
  });
  function openAvailabilityEditor(ex: OverviewExtra) {
    // Sempre os 7 dias da semana visível, com o que a pessoa já tiver marcado.
    const days: AvailabilityDayState[] = dayHeaders.map((h) => {
      const d = ex.days.find((x) => x.day === h.day);
      return { day: h.day, label: h.label, morning: !!d?.morning, night: !!d?.night, fromHour: d?.fromHour ?? null, toHour: d?.toHour ?? null, note: d?.note ?? null };
    });
    setAvailEdit({ employeeId: ex.employeeId, fullName: ex.fullName, days });
  }
  function patchAvailDay(day: string, patch: Partial<AvailabilityDayState>) {
    setAvailEdit((prev) => (prev ? { ...prev, days: prev.days.map((d) => (d.day === day ? { ...d, ...patch } : d)) } : prev));
  }
  const availEditAnyMarked = !!availEdit?.days.some(isDayMarked);

  const resetKey = [cityFilter, filters.status, searching, effectiveWeek, filters.windowDay, filters.windowFrom, filters.windowTo, filters.onlyNotContacted24h].join("|");
  const windowChip = windowFilterLabel(filters, dayLabel);

  // Abertura da grelha (cidades/secções) — aqui e não na grelha, para a barra
  // de envio saber quem vai no envio SEM se ver (secções fechadas).
  const [gridOpen, setGridOpen] = useState<GridOpenState>({ closedCities: new Set(), sectionOverrides: {}, shownPer: {} });
  useEffect(() => { setGridOpen({ closedCities: new Set(), sectionOverrides: {}, shownPer: {} }); }, [resetKey]);
  // Quem vai no envio sem estar à vista: cidade/secção fechada OU por mostrar ("Mostrar mais").
  const breakdown = useMemo(() => {
    const shownIds = new Set(shownExtras.map((e) => e.employeeId));
    const hidden = hiddenGridRowIds(availSort.sorted, gridOpen, { status: filters.status, searching });
    return sendTargetBreakdown(target.rows, shownIds, (row) => hidden.has(row.employeeId));
  }, [target.rows, shownExtras, availSort.sorted, gridOpen, searching, filters.status]);
  const closedNote = closedSectionsNote(breakdown.notVisible);
  // Travão "a todos os estados": sem seleção e com "Todos", primeiro escolhe-se
  // um estado ou marca-se gente; "Enviar a todos" destrava (e o diálogo confirma).
  const [allUnlocked, setAllUnlocked] = useState(false);
  useEffect(() => { setAllUnlocked(false); }, [resetKey, selectedIds]);
  const blockReason = sendBlockReason({ scope: target.scope, status: filters.status, count: target.rows.length, statesCount: breakdown.statesCount, unlocked: allUnlocked });
  const needsAllConfirm = sendNeedsAllConfirm(target.scope, filters.status, breakdown.statesCount);
  const STATUS_TILES: { key: AvailabilityStatusFilter; label: string; hint: string }[] = [
    { key: "all", label: "Todos", hint: "todos os estados" },
    { key: "available", label: AVAILABILITY_STATUS_LABELS.available, hint: "marcaram pelo menos um dia" },
    { key: "unavailable", label: AVAILABILITY_STATUS_LABELS.unavailable, hint: "disseram que não podem" },
    { key: "no_answer", label: AVAILABILITY_STATUS_LABELS.no_answer, hint: "ainda não responderam" },
  ];

  return (
    <div className="space-y-4">
      {/* ── 1. Semana + estado das respostas ─────────────────────────────── */}
      <Card className="rounded-[14px] gap-4 py-4 px-4 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-display text-lg font-semibold text-secondary-foreground flex items-center gap-2">
              <CalendarDays className="h-5 w-5 text-primary shrink-0" />
              Disponibilidade dos extras
            </h2>
            <p className="text-sm text-muted-foreground">
              {o ? <>Semana de {weekLabel}</> : "A carregar a semana…"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <UniDateNav date={effectiveWeek} defaultGran="week" onChange={(d) => setWeekStart(mondayOf(new Date(d + "T00:00:00")))} />
            {hints.data && effectiveWeek !== hints.data.next && (
              <Button variant="outline" size="sm" onClick={() => setWeekStart(hints.data!.next)}>Próxima semana</Button>
            )}
          </div>
        </div>

        {hints.error && !effectiveWeek && (
          <QueryErrorNote error={hints.error} onRetry={() => hints.refetch()} retrying={hints.isFetching} what="a semana a mostrar" />
        )}
        {overview.error && (
          <QueryErrorNote error={overview.error} onRetry={() => overview.refetch()} retrying={overview.isFetching} what="a disponibilidade dos extras" />
        )}
        {!o && !overview.error && !(hints.error && !effectiveWeek) && (
          <div className="py-8 flex items-center justify-center text-sm text-muted-foreground gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> A carregar…
          </div>
        )}

        {o && (
          <>
            {/* Os quadrados SÃO o filtro de estado: botões de ligar/desligar
                (aria-pressed), um de cada vez; carregar no escolhido volta a
                "Todos". Os números contam os outros filtros. */}
            <div role="group" aria-label="Estado da resposta nesta semana" className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {STATUS_TILES.map((t) => {
                const active = filters.status === t.key;
                const tone = t.key === "all" ? null : STATUS_TONE[t.key];
                return (
                  <button
                    key={t.key}
                    type="button"
                    aria-pressed={active}
                    aria-label={`${t.label}: ${tiles[t.key]} (${t.hint})`}
                    onClick={() => patchFilters({ status: toggleStatusTile(filters.status, t.key) })}
                    className={cn(
                      "rounded-[10px] border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      active ? "border-primary bg-primary/5 ring-1 ring-primary" : "bg-card hover:bg-muted/50",
                    )}
                  >
                    <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      {tone ? <span className={cn("h-2 w-2 rounded-full", tone.dot)} aria-hidden /> : <Users className="h-3 w-3" aria-hidden />}
                      {t.label}
                    </span>
                    <span className={cn("block font-display text-2xl font-semibold tabular-nums leading-tight", tone ? tone.text : "text-secondary-foreground")}>
                      {tiles[t.key]}
                    </span>
                    <span className="block text-[11px] leading-snug text-muted-foreground">{t.hint}</span>
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground -mt-1">
              A mostrar <b className="text-foreground">{shownExtras.length}</b>
              {shownExtras.length !== o.totalExtras ? ` de ${o.totalExtras}` : ""} extras · {shownResponded} responderam ·{" "}
              <span className={shownWithPhone === 0 && shownExtras.length > 0 ? "text-amber-700" : undefined}>{shownWithPhone} com número válido</span>
            </p>

            {/* Quantos há por dia e turno (nos filtrados) — o que mais interessa para escalar. */}
            {dayHeaders.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1.5">
                  Disponíveis por dia{anyFilter ? " (nos filtrados)" : ""} · <Sun className="inline h-3 w-3 text-amber-500" /> manhã · <Moon className="inline h-3 w-3 text-indigo-500" /> noite
                </p>
                <div className="grid grid-cols-7 gap-1">
                  {shownPerDay.map((p, i) => {
                    const short = shortDayHeader(dayHeaders[i].label);
                    const none = p.morning === 0 && p.night === 0;
                    return (
                      <div key={p.day} title={dayHeaders[i].label} className={cn("rounded-[10px] border px-1 py-1.5 text-center", none ? "bg-muted/40" : "bg-card")}>
                        <div className="text-[11px] font-semibold leading-tight">{short.weekday}</div>
                        <div className="text-[10px] text-muted-foreground leading-tight">{short.date}</div>
                        <div className="mt-1 flex flex-col sm:flex-row items-center justify-center gap-x-2 text-xs tabular-nums">
                          <span className="inline-flex items-center gap-0.5 text-amber-700 dark:text-amber-400"><Sun className="h-3 w-3" />{p.morning}</span>
                          <span className="inline-flex items-center gap-0.5 text-indigo-600 dark:text-indigo-400"><Moon className="h-3 w-3" />{p.night}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      {o && (
        <Card className="rounded-[14px] gap-0 py-0">
          {/* ── 2. Filtros ─────────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-2 p-3 sm:px-4 border-b">
            <div className="relative flex-1 min-w-[12rem]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                type="text"
                placeholder="Pesquisar por nome ou número…"
                aria-label="Pesquisar extras por nome ou número"
                className="h-9 pl-8 pr-8 rounded-[10px]"
                value={filters.search}
                onChange={(e) => patchFilters({ search: e.target.value })}
              />
              {searching && (
                <button
                  type="button"
                  aria-label="Limpar pesquisa"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => patchFilters({ search: "" })}
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* Cidade: com uma cidade escolhida em cima, é essa e só se mostra
                (como no WhatsApp). Com "todas" (e no telemóvel, onde o seletor
                de cima não aparece), escolhe-se aqui. A cidade é DERIVADA
                (projeto → candidatura → morada); "Sem cidade" é filtrável. */}
            {globalCity ? (
              <span
                className="inline-flex items-center gap-1 h-9 px-3 rounded-[10px] border bg-muted/40 text-sm"
                title={`Segue a cidade escolhida em cima (${CITY_LABELS[globalCity]}).`}
              >
                <MapPin className="h-3.5 w-3.5 text-primary" /> {CITY_LABELS[globalCity]}
                <span className="text-xs text-muted-foreground tabular-nums">{cityCounts[globalCity] ?? 0}</span>
              </span>
            ) : (
              <Select value={filters.city} onValueChange={(v) => patchFilters({ city: v as AvailabilityCityFilter })}>
                <SelectTrigger className="h-9 w-auto min-w-[10.5rem] rounded-[10px]" aria-label="Cidade">
                  <MapPin className="h-3.5 w-3.5 text-primary shrink-0" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[
                    { key: "all" as const, label: "Todas as cidades" },
                    ...CITY_KEYS.map((k) => ({ key: k, label: CITY_LABELS[k] })),
                    { key: "none" as const, label: "Sem cidade" },
                  ].map(({ key, label }) => (
                    <SelectItem key={key} value={key}>{label} ({cityCounts[key] ?? 0})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant={popoverCount > 0 ? "selected" : "outline"}
                  className="h-9 rounded-[10px] gap-1.5"
                  aria-label={popoverCount > 0 ? `Filtros (${popoverCount} ligados)` : "Filtros"}
                >
                  <SlidersHorizontal className="h-4 w-4" />
                  Filtros
                  {popoverCount > 0 && (
                    <span className="inline-flex items-center justify-center h-5 min-w-5 px-1 rounded-full bg-white text-primary text-[11px] font-semibold tabular-nums">
                      {popoverCount}
                    </span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80 p-3 space-y-4">
                {/* Disponível em: dia opcional + horas. Com as duas horas → quem
                    pode em ALGUM momento desse horário (sobreposição: alargar a
                    janela nunca esconde ninguém); só com o dia → quem marcou
                    algo nesse dia. Regra em shared/availabilityWindow.ts. */}
                <div className="space-y-2">
                  <Label className="text-xs font-semibold">Disponível em</Label>
                  <Select value={filters.windowDay} onValueChange={(v) => patchFilters({ windowDay: v })}>
                    <SelectTrigger className="h-8 w-full text-xs" aria-label="Dia da semana">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Qualquer dia da semana</SelectItem>
                      {dayHeaders.map((h) => <SelectItem key={h.day} value={h.day}>{h.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">das</span>
                    <Select value={filters.windowFrom == null ? "" : String(filters.windowFrom)} onValueChange={(v) => patchFilters({ windowFrom: v === "" ? null : Number(v) })}>
                      <SelectTrigger className="h-8 flex-1 text-xs" aria-label="Hora de início"><SelectValue placeholder="—" /></SelectTrigger>
                      <SelectContent>
                        {HOUR_OPTIONS.map((h) => <SelectItem key={h} value={String(h)}>{String(h).padStart(2, "0")}h</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <span className="text-xs text-muted-foreground">às</span>
                    <Select value={filters.windowTo == null ? "" : String(filters.windowTo)} onValueChange={(v) => patchFilters({ windowTo: v === "" ? null : Number(v) })}>
                      <SelectTrigger className="h-8 flex-1 text-xs" aria-label="Hora de fim"><SelectValue placeholder="—" /></SelectTrigger>
                      <SelectContent>
                        {HOUR_OPTIONS.map((h) => <SelectItem key={h} value={String(h)}>{String(h).padStart(2, "0")}h</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {windowMode === "incomplete"
                      ? "Escolhe as duas horas para filtrar."
                      : windowMode === "off"
                        ? "Sem dia nem horas: não filtra."
                        : <><b className={windowMatchCount === 0 ? "text-amber-700" : "text-foreground"}>{windowMatchCount} {windowMatchCount === 1 ? "disponível" : "disponíveis"}</b> {windowMode === "hours" ? "nesse horário" : "nesse dia"} (em todas as cidades).</>}
                  </p>
                  {windowMode !== "off" && (
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => patchFilters({ windowDay: "any", windowFrom: null, windowTo: null })}>
                      <X className="h-3.5 w-3.5" /> Limpar dia e horas
                    </Button>
                  )}
                </div>
                <div className="flex items-start justify-between gap-3 border-t pt-3">
                  <div className="min-w-0 space-y-0.5">
                    <Label htmlFor="avail-f-24h" className="text-xs cursor-pointer">
                      Sem mensagem nas últimas 24h <span className="text-muted-foreground font-normal tabular-nums">({notContacted24hCount})</span>
                    </Label>
                    <p className="text-[11px] leading-snug text-muted-foreground">Sem WhatsApp nem email enviados por nós nas últimas 24 horas.</p>
                  </div>
                  <Switch id="avail-f-24h" checked={filters.onlyNotContacted24h} onCheckedChange={(v) => patchFilters({ onlyNotContacted24h: v })} />
                </div>
              </PopoverContent>
            </Popover>

            {anyFilter && (
              <Button variant="ghost" size="sm" className="h-9 px-2 text-xs" onClick={clearAllFilters}>
                <X className="h-3.5 w-3.5" /> Limpar filtros
              </Button>
            )}
          </div>

          {/* Filtros ligados, à vista e com "×" (o que esconde gente nunca fica escondido). */}
          {(filters.status !== "all" || (!globalCity && filters.city !== "all") || windowChip || filters.onlyNotContacted24h) && (
            <div className="flex flex-wrap items-center gap-1.5 px-3 sm:px-4 py-2 border-b bg-muted/20">
              <span className="text-[11px] text-muted-foreground mr-0.5">Filtros ligados:</span>
              {filters.status !== "all" && (
                <ActiveChip label="estado" onClear={() => patchFilters({ status: "all" })}>{AVAILABILITY_STATUS_LABELS[filters.status]}</ActiveChip>
              )}
              {!globalCity && filters.city !== "all" && (
                <ActiveChip label="cidade" onClear={() => patchFilters({ city: "all" })}>
                  <MapPin className="h-3 w-3" /> {filters.city === "none" ? "Sem cidade" : CITY_LABELS[filters.city]}
                </ActiveChip>
              )}
              {windowChip && (
                <ActiveChip label="disponível em" onClear={() => patchFilters({ windowDay: "any", windowFrom: null, windowTo: null })}>
                  <Clock className="h-3 w-3" /> {windowChip}
                </ActiveChip>
              )}
              {filters.onlyNotContacted24h && (
                <ActiveChip label="sem mensagem 24h" onClear={() => patchFilters({ onlyNotContacted24h: false })}>Sem mensagem nas últimas 24h</ActiveChip>
              )}
            </div>
          )}

          {/* ── 3. Envio: diz SEMPRE para quem vai ─────────────────────────── */}
          <div
            className={cn(
              "sticky top-[4.5rem] z-30 flex flex-wrap items-center gap-x-3 gap-y-2 px-3 sm:px-4 py-2.5 border-b",
              target.scope === "selected" ? "bg-accent border-primary/30" : "bg-card",
            )}
          >
            <label className="flex items-center gap-2 text-xs cursor-pointer shrink-0" title={`Selecionar os ${shownExtras.length} filtrados`}>
              <TriCheckbox
                aria-label={`Selecionar os ${shownExtras.length} filtrados`}
                checked={allShownSelected}
                indeterminate={shownSelectedCount > 0}
                onChange={(e) => toggleMany(shownExtras, e.target.checked)}
                disabled={shownExtras.length === 0}
              />
              <span className="hidden sm:inline">Selecionar os {shownExtras.length}</span>
            </label>
            <div className="flex-1 min-w-[11rem] text-sm">
              <span className="text-muted-foreground">Para: </span>
              <b>{sendTargetShort(target.scope, target.rows.length)}{target.scope === "all" && globalCity ? ` de ${CITY_LABELS[globalCity]}` : ""}</b>
              <span className="text-xs text-muted-foreground"> · {targetWithPhone} com número válido</span>
              {/* Divisão por estado SEMPRE à vista (quem vai, mesmo nas secções fechadas). */}
              {breakdown.text && <span className="block text-xs text-muted-foreground">{breakdown.text}{closedNote ? <b className="text-amber-700 dark:text-amber-400"> · {closedNote}</b> : null}</span>}
              {blockReason && target.rows.length > 0 && (
                <span className="block text-xs text-amber-700 dark:text-amber-400">
                  Escolhe um estado nos quadrados em cima ou seleciona pessoas antes de enviar.{" "}
                  <button type="button" className="font-medium text-primary hover:underline" onClick={() => setAllUnlocked(true)}>
                    {sendAllLabel(target.scope, target.rows.length, breakdown.statesCount)}…
                  </button>
                </span>
              )}
              {target.scope === "selected" && (
                <button type="button" className="ml-2 text-xs text-primary hover:underline" onClick={() => setSelectedIds(new Set())}>
                  Limpar seleção
                </button>
              )}
              {target.hiddenSelected > 0 && (
                <span className="block text-xs text-amber-700">
                  {target.hiddenSelected} selecionado(s) fora dos filtros atuais — continuam incluídos no envio.
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-9 rounded-[10px]"
                disabled={!effectiveWeek || target.rows.length === 0 || !canEdit || !!blockReason}
                title={!canEdit ? "Sem permissão para enviar o pedido de disponibilidade" : blockReason ?? `Pedido por email ${targetPhrase}`}
                aria-label={`Pedido por email ${targetPhrase}`}
                onClick={() => setEmailOpen(true)}
              >
                <Mail className="h-4 w-4" /> Email
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-9 rounded-[10px] border-green-600 text-green-700 hover:bg-green-50 dark:text-green-400 dark:hover:bg-green-950"
                disabled={target.rows.length === 0 || !canWhatsApp || !!blockReason}
                title={!canWhatsApp ? "Sem permissão para enviar WhatsApp" : blockReason ?? `Pedido por WhatsApp ${targetPhrase}`}
                aria-label={`Pedido por WhatsApp ${targetPhrase}`}
                onClick={() => setWaOpen(true)}
              >
                <MessageCircle className="h-4 w-4" /> WhatsApp
              </Button>
            </div>
          </div>

          {/* ── 4. Grelha ──────────────────────────────────────────────────── */}
          <div className="p-3 sm:p-4 space-y-3">
            {shownExtras.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground border rounded-[14px] space-y-2">
                <p>{emptyAvailabilityMessage(effective)}</p>
                {anyFilter && <Button variant="outline" size="sm" onClick={clearAllFilters}>Limpar filtros</Button>}
              </div>
            ) : (
              <AvailabilityGrid
                rows={availSort.sorted}
                dayHeaders={dayHeaders}
                selectedIds={selectedIds}
                onToggleMany={toggleMany}
                sort={availSort}
                status={filters.status}
                searching={searching}
                openState={gridOpen}
                onOpenStateChange={setGridOpen}
                canEdit={canEdit}
                lastWorkedLoading={lastWorked.isLoading}
                onEdit={openAvailabilityEditor}
                onOpenEmployee={openEmployee}
              />
            )}
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              <Sun className="h-3 w-3 inline text-amber-500" /> manhã · <Moon className="h-3 w-3 inline text-indigo-500" /> noite · horas = janela exata indicada pela pessoa (manda sobre os turnos; "00h–03h" é a madrugada desse dia, ou seja a noite do dia anterior) · ✱ tem nota (passa o rato por cima) · "Habitual" = dias livres que a pessoa costuma ter (só uma dica) · {canEdit ? "carrega num dia ou no lápis para marcar por alguém" : "só leitura"}
            </p>
          </div>
        </Card>
      )}

      <AvailabilityEmailDialog
        open={emailOpen}
        onOpenChange={setEmailOpen}
        scope={target.scope}
        targetPhrase={targetPhrase}
        breakdown={breakdown.text}
        closedNote={closedNote}
        forceConfirm={needsAllConfirm}
        statesCount={breakdown.statesCount}
        targetIds={target.rows.map((e) => e.employeeId)}
        weekStart={effectiveWeek}
        weekLabel={weekLabel}
        note={note}
        onNoteChange={setNote}
        onUseInWhatsApp={sendTextToWhatsApp}
        onSent={() => overview.refetch()}
      />
      <AvailabilityWhatsAppDialog
        open={waOpen}
        onOpenChange={setWaOpen}
        targets={target.rows}
        targetPhrase={targetPhrase}
        breakdown={breakdown.text}
        closedNote={closedNote}
        forceConfirm={needsAllConfirm}
        scope={target.scope}
        statesCount={breakdown.statesCount}
        weekShortLabel={weekShortLabel}
        dayHeaders={dayHeaders}
        weekStart={effectiveWeek}
        note={note}
        prefill={waPrefill}
        onSent={() => overview.refetch()}
      />

      {/* ── Diálogo: marcar disponibilidade POR um extra ─────────────────── */}
      <Dialog open={availEdit != null} onOpenChange={(open) => { if (!open && !setForEmployee.isPending) setAvailEdit(null); }}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarDays className="h-5 w-5 text-primary" />
              Disponibilidade de {availEdit?.fullName}
            </DialogTitle>
            <DialogDescription>
              Semana de {weekShortLabel}. Substitui o que estiver marcado para esta semana e passa a contar como resposta na grelha.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {availEdit?.days.map((d) => (
              <div key={d.day} className={`rounded-[10px] border p-2 space-y-1 ${isDayMarked(d) ? "border-primary/50 bg-primary/5" : ""}`}>
                <div className="text-sm font-medium">{d.label}</div>
                <AvailabilityDayFields day={d} compact disabled={setForEmployee.isPending} onChange={(patch) => patchAvailDay(d.day, patch)} />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAvailEdit(null)} disabled={setForEmployee.isPending}>Cancelar</Button>
            <Button
              variant="selected"
              disabled={!availEdit || !effectiveWeek || setForEmployee.isPending}
              onClick={() =>
                availEdit &&
                setForEmployee.mutate({
                  employeeId: availEdit.employeeId,
                  weekStart: effectiveWeek,
                  days: availEdit.days.map((d) => ({ day: d.day, morning: d.morning, night: d.night, fromHour: d.fromHour, toHour: d.toHour, note: d.note })),
                })
              }
            >
              {setForEmployee.isPending ? <Clock className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {availEditAnyMarked ? "Guardar disponibilidade" : "Guardar (sem disponibilidade)"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
