import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { can, canTouchPermission } from "@shared/access";
import { addDays as addDaysIso, lisbonDayOf } from "@shared/lisbonDay";
import { atLeast, useConfirm } from "./training/shared";
import { createContext, useContext } from "react";
import { usePersistedState } from "@/hooks/usePersistedState";
import { useOpenEmployee } from "@/hooks/useOpenEmployee";
import { fmtPTDate } from "@/lib/lisbonTime";
import { useGlobalFilters } from '@/contexts/GlobalFiltersContext';
import { buildAvailabilityMessage, AVAILABILITY_KINDS, type AvailabilityMessageKind } from "@shared/availabilityMessages";
import { useTableSort, Th } from "@/components/SortableTable";
import { UniDateNav, mondayOf } from "@/components/DateRangeNav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Fragment, useCallback, useEffect, useState, useMemo } from "react";
import { toast } from "sonner";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Droplets,
  Users,
  Euro,
  Clock,
  CalendarDays,
  Plus,
  Home,
  Trash2,
  ChevronRight,
  ChevronDown,
  Send,
  Mail,
  CheckCircle2,
  Sun,
  Moon,
  MessageCircle,
  XCircle,
  AlertTriangle,
  MapPin,
  Search,
  X,
  Pencil,
  Wand2,
  Sparkles,
  PauseCircle,
  BellOff,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PressureTab, TightHourBadge } from "./extrasDia/PressureTab";
import { PersonPicker, type PickerCandidate } from "./extrasDia/PersonPicker";
import { LicenceWarning } from "./extrasDia/LicenceWarning";
import { QuickNoteButton } from "./extrasDia/QuickNoteButton";
import { StaffingBanner, StaffingGapList } from "./extrasDia/StaffingIndicator";
import { NotifyShiftDialog } from "./extrasDia/NotifyShiftDialog";
import { extraCityGroupKey, tightHoursForDay, type PressureSlot, type TightReason } from "@shared/extrasPressure";
import { assignmentWhoLine, describeGap, describePickupPairing } from "@shared/extrasSchedule";
import { AvailabilityDayFields, isDayMarked, type AvailabilityDayState } from "@/components/AvailabilityDayFields";
import {
  CITY_KEYS,
  CITY_LABELS,
  CITY_SOURCE_LABELS,
  matchCityKey,
  type CityKey,
} from "@shared/city";
import {
  HOUR_OPTIONS,
  availabilityCellDisplay,
  formatHourWindow,
  isAvailableOnDay,
  matchesAvailabilityWindow,
} from "@shared/availabilityWindow";
import {
  DEFAULT_WHATSAPP_TEMPLATE_ID,
  WHATSAPP_TEMPLATES,
  findWhatsAppTemplate,
  firstNameOf,
} from "@shared/whatsappTemplate";
import { broadcastConfirmText, needsBroadcastConfirm } from "@shared/whatsappBroadcastRules";
import { matchesContactQuery, nameMatchScore } from "@shared/contactSearch";
import { driverCityFrom, driverCityLabel, type City } from "@shared/driverTemplates";
import { DriverCityPanel, planEntries, useDriverCity, type DriverCityRecipient } from "@/components/whatsapp/DriverCityPanel";
import { contactPrefsLabel } from "@shared/contactPrefs";
import {
  AVAILABILITY_PAGE_SIZE,
  AVAILABILITY_STATUS_LABELS,
  availabilityStatus,
  countAvailabilityStatuses,
  defaultOpenGroups,
  groupByCity,
  matchesAvailabilityStatus,
  sortByAvailability,
  visibleSlice,
  type AvailabilityStatusFilter,
  type CityGroupKey,
} from "@shared/availabilityGroups";

// Valores por defeito — as taxas vivas vêm de `extra_rates` (a mesma fonte do
// servidor: server/extraRates.ts). A escala é a ESTIMATIVA do custo do dia;
// o extra recebe pelo ponto (horas de ponto × a mesma taxa).
const LEVELS = [
  { id: "junior", label: "Júnior", hourlyRate: 4.5 },
  { id: "senior", label: "Sénior", hourlyRate: 5 },
  { id: "terminal", label: "Terminal", hourlyRate: 5.5 },
  { id: "master", label: "Master", hourlyRate: 6 },
] as const;
type LevelId = (typeof LEVELS)[number]["id"];

/**
 * Quem pode o quê no Extras Dia (shared/access.ts + shared/extrasCostView.ts):
 * editar a escala; ver custos e taxas dos extras; ver o custo do TL (salário).
 * O servidor já tira os euros a quem não os vê — o ecrã esconde as colunas.
 */
type ExtrasAccess = { canEdit: boolean; costs: boolean; salaries: boolean };
const ExtrasAccessContext = createContext<ExtrasAccess>({ canEdit: false, costs: false, salaries: false });
/** Taxas €/h em vigor, vindas na previsão (null = a conta não vê custos). */
const RatesContext = createContext<Record<string, number> | null>(null);

/** Os 4 níveis com as taxas em vigor (as mesmas do servidor). Antes vinham de
 *  uma rota só de administração e os outros viam as taxas de origem. */
function useLiveLevels() {
  const rates = useContext(RatesContext);
  return useMemo(() => LEVELS.map(l => ({ ...l, hourlyRate: rates?.[l.id] ?? l.hourlyRate })), [rates]);
}

// Início: 03h–02h+1 (3–26). O dia operacional começa às 03h; da 0h às 3h é a
// noite do dia anterior (o servidor recusa um início antes das 03h).
const HOURS_24 = Array.from({ length: 24 }, (_, i) => i + 3);
// 1-27 para fim do turno (27 = 03:00 do dia seguinte).
const HOURS_25 = Array.from({ length: 28 }, (_, i) => i);

type ShiftId = "morning" | "night";

const SHIFTS: { id: ShiftId; label: string; defaultStart: number; defaultEnd: number }[] = [
  { id: "morning", label: "Manhã (03–15)", defaultStart: 3, defaultEnd: 15 },
  { id: "night", label: "Noite (15–03+1)", defaultStart: 15, defaultEnd: 27 },
];

const fmtEur = (n: number) =>
  n.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });

const fmtHour = (h: number) => {
  if (h < 24) return `${String(h).padStart(2, "0")}h`;
  return `${String(h - 24).padStart(2, "0")}h+1`;
};
const fmtDate = (s: string) => {
  const d = new Date(s + "T00:00:00");
  return d.toLocaleDateString("pt-PT", { weekday: "long", day: "2-digit", month: "long" });
};
/** 'YYYY-MM-DD' → 'DD/MM' (sem Date: a string ISO já traz o que precisamos). */
const ddmm = (isoDay: string) => `${isoDay.slice(8, 10)}/${isoDay.slice(5, 7)}`;

/** Hoje em Lisboa (nunca o relógio do browser). */
function todayISO(): string {
  return lisbonDayOf(Date.now());
}

function baseDateFromUrl(): string | null {
  // 20d: "?dia=" (pesquisa, avisos) e "?date=" (eventos do Google Calendar já criados) — os dois abrem o dia.
  const qs = new URLSearchParams(window.location.search);
  const dia = qs.get("dia") ?? qs.get("date");
  if (!dia) return null;
  if (dia === "amanha") return todayISO();
  const target = dia === "hoje" ? todayISO() : /^\d{4}-\d{2}-\d{2}$/.test(dia) ? dia : null;
  if (!target) return null;
  return addDaysIso(target, -1);
}

// Cidade ativa do Extras-Dia (Lisboa/Porto/Faro) — contexto para não arrastar
// a prop por 4 níveis até aos slots.
type ExtraCityId = "lisbon" | "porto" | "faro";
const CITY_OPTIONS: Array<{ id: ExtraCityId; label: string }> = [
  { id: "lisbon", label: "Lisboa" },
  { id: "porto", label: "Porto" },
  { id: "faro", label: "Faro" },
];
const ExtrasCityContext = createContext<ExtraCityId>("lisbon");

export default function ExtrasDiaPage() {
  const globalFilters = useGlobalFilters();
  const [savedCity, setSavedCity] = usePersistedState<ExtraCityId>("extrasdia.city", "lisbon");
  const allowedCities = CITY_OPTIONS.filter(c => globalFilters.cities.some(p => p.name.toLowerCase() === c.label.toLowerCase()));
  const selectedName = globalFilters.cities.find(p => p.id === globalFilters.cityId)?.name;
  const city = allowedCities.find(c => c.label === selectedName)?.id ?? allowedCities.find(c => c.id === savedCity)?.id ?? allowedCities[0]?.id ?? 'lisbon';
  const setCity = (value: ExtraCityId) => {
    const choice = allowedCities.find(c => c.id === value);
    if (!choice) return;
    setSavedCity(value);
    globalFilters.setCityId(globalFilters.cities.find(p => p.name === choice.label)!.id);
  };
  // ?dia=amanha|hoje|AAAA-MM-DD (pesquisa global): a escala mostrada é a de
  // baseDate + 1 (previsão do dia seguinte), por isso baseDate = dia − 1.
  const [baseDate, setBaseDate] = useState(() => baseDateFromUrl() ?? todayISO());

  const [tab, setTab] = usePersistedState<"dia" | "pressao">("extrasdia.tab", "dia");
  const { user } = useAuth();
  const costQ = trpc.extrasDia.costAccess.useQuery(undefined, { staleTime: 5 * 60_000 });
  const access: ExtrasAccess = {
    canEdit: !!user && can(user as any, "extras_dia", "edit"),
    costs: costQ.data?.costs ?? false,
    salaries: costQ.data?.salaries ?? false,
  };
  const forecastQ = trpc.extrasDia.forecast.useQuery({ baseDate, city }, { enabled: !globalFilters.isLoading && allowedCities.length > 0 });
  const { data, isLoading, error } = forecastQ;
  const targetDate = data?.targetDate ?? "";
  // "hora apertada": histórico de 60 dias (trabalho extras-pressure) da cidade.
  const pressureQ = trpc.extrasDia.pressure.useQuery(undefined, { staleTime: 10 * 60_000 });
  const tightHours = useMemo(() => {
    if (!data || !pressureQ.data?.available) return new Map<number, TightReason>();
    const key = extraCityGroupKey(city);
    const slots = (pressureQ.data.slots as PressureSlot[]).filter((s) => s.group === key);
    return tightHoursForDay(slots, data.targetDate, data.hourly.map((h) => h.hour));
  }, [data, pressureQ.data, city]);
  const assignmentsQ = trpc.extrasDia.assignments.useQuery(
    { date: targetDate, city },
    { enabled: !!targetDate },
  );
  const assignments = assignmentsQ.data ?? [];
  // Pedido 4 (7 out 2026): quantas notas internas tem o dia (escrevem-se no separador Pressão).
  const dayNotesQ = trpc.extrasDia.dayNotes.list.useQuery({ city, from: targetDate, to: targetDate }, { enabled: !!targetDate });
  const dayNotesCount = dayNotesQ.data?.length ?? 0;

  const actuals = useMemo(() => {
    const cost = assignments.reduce((s, a) => s + (a.cost ?? 0), 0);
    const hours = assignments.reduce((s, a) => s + a.hoursBilled, 0);
    // Custos que esta conta não vê (ex.: o do TL, que vem do salário).
    const hiddenCost = assignments.some((a) => a.cost == null);
    return { cost, hours, count: assignments.length, hiddenCost };
  }, [assignments]);

  const peakHour = useMemo(() => {
    if (!data) return null;
    let max = 0;
    let hour = -1;
    for (const row of data.hourly) {
      const total = row.checkins + row.checkouts;
      if (total > max) {
        max = total;
        hour = row.hour;
      }
    }
    return hour >= 0 ? { hour, total: max } : null;
  }, [data]);

  return (
    <ExtrasCityContext.Provider value={city}>
    <ExtrasAccessContext.Provider value={access}>
    <RatesContext.Provider value={(data?.rates as Record<string, number> | null | undefined) ?? null}>
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CalendarDays className="h-6 w-6 text-blue-600" />
            Extras Dia — {allowedCities.find(c => c.id === city)?.label ?? 'Sem cidade atribuída'}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Planeamento de chegadas, saídas, lavagens e condutores para o dia seguinte.
          </p>
          {data && describePickupPairing(data.pickupPairing) && (
            <p className="text-xs text-muted-foreground mt-1">🔁 {describePickupPairing(data.pickupPairing)}</p>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor="baseDate" className="text-xs">Data base</Label>
          <UniDateNav date={baseDate} onChange={setBaseDate} />
          <Select value={city} disabled={allowedCities.length <= 1} onValueChange={(v) => setCity(v as ExtraCityId)}>
            <SelectTrigger className="w-32 h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {allowedCities.map((c) => <SelectItem key={c.id} value={c.id}>📍 {c.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "dia" | "pressao")}>
        <TabsList>
          <TabsTrigger value="dia">Dia</TabsTrigger>
          <TabsTrigger value="pressao">Pressão</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "pressao" && <PressureTab city={city} targetDate={targetDate || addDaysIso(baseDate, 1)} canEdit={access.canEdit} />}

      {tab === "dia" && isLoading && (
        <div className="text-sm text-muted-foreground">A carregar previsão...</div>
      )}
      {tab === "dia" && error && (
        <QueryErrorNote error={error} onRetry={() => forecastQ.refetch()} retrying={forecastQ.isFetching} what="a previsão" />
      )}

      {tab === "dia" && data && (
        <>
          <div className="text-sm text-muted-foreground">
            A mostrar previsão para <strong>{fmtDate(data.targetDate)}</strong>
            {peakHour && (
              <span className="ml-2">
                · Hora de pico: <strong>{fmtHour(peakHour.hour)}</strong> ({peakHour.total} operações)
              </span>
            )}
            <span className="ml-2">
              · Parques: <strong>{data.parksQueried.length}</strong>
            </span>
            <span className="ml-2">
              ·{" "}
              <button type="button" className="underline-offset-2 hover:underline" onClick={() => setTab("pressao")} title="Notas internas deste dia de trabalho (separador Pressão)">
                Notas do dia: <strong>{dayNotesCount}</strong>
              </button>
            </span>
          </div>

          {data.parksFailed.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50/60 p-3 text-xs">
              <div className="font-medium mb-1">Avisos ({data.parksFailed.length})</div>
              <ul className="space-y-0.5 text-amber-900">
                {data.parksFailed.slice(0, 5).map((f, i) => (
                  <li key={i}>
                    <span className="font-mono">{f.park}</span>: {f.error}
                  </li>
                ))}
                {data.parksFailed.length > 5 && (
                  <li>... e mais {data.parksFailed.length - 5}</li>
                )}
              </ul>
            </div>
          )}

          {data.bookingsTruncated && (
            <div className="rounded-md border border-amber-300 bg-amber-50/60 p-3 text-sm text-amber-900">
              <AlertTriangle className="inline h-4 w-4 mr-1 align-text-bottom" />
              Previsão incompleta: a leitura das reservas foi cortada no limite. Os números podem estar abaixo do real; a proposta automática e os avisos de falta de gente ficam parados.
            </div>
          )}

          {data.bookingSource === "copy" && (
            <div className="rounded-md border border-amber-300 bg-amber-50/60 p-3 text-sm text-amber-900">
              <AlertTriangle className="inline h-4 w-4 mr-1 align-text-bottom" />
              Reservas da cópia local, não da BD da Multipark ao vivo. {data.bookingSourceNotice}
            </div>
          )}

          {data.parksQueried.length === 0 && (
            <div className="rounded-md border border-red-300 bg-red-50/60 p-3 text-sm">
              {data.bookingSource === "multipark-db"
                ? "A BD da Multipark não tem parques nossos nesta cidade (ver Operações → Classificação dos parques)."
                : "Sem reservas desta cidade na cópia local."}
            </div>
          )}


          {/* KPI cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard
              icon={<ArrowDownToLine className="h-4 w-4 text-emerald-600" />}
              label="Recolhas"
              value={data.totals.checkins}
              breakdown={data.spotTypeByDirection?.checkin}
            />
            <KpiCard
              icon={<ArrowUpFromLine className="h-4 w-4 text-orange-600" />}
              label="Entregas"
              value={data.totals.checkouts}
              breakdown={data.spotTypeByDirection?.checkout}
            />
            <KpiCard
              icon={<Users className="h-4 w-4 text-blue-600" />}
              label={actuals.count > 0 ? "Pessoas escaladas" : "Condutores (pico)"}
              value={actuals.count > 0 ? actuals.count : data.allocation.cheapest.peakDrivers}
              hint={
                actuals.count > 0
                  ? `${actuals.hours}h pagas · pico previsto ${data.allocation.cheapest.peakDrivers}`
                  : `${data.allocation.cheapest.totalDriverHours}h totais`
              }
            />
            {access.costs && (
              <KpiCard
                icon={<Euro className="h-4 w-4 text-purple-600" />}
                // É o custo da ESCALA (estimativa): o extra recebe pelo ponto.
                label={actuals.count > 0 ? "Custo escalado (estimativa)" : "Estimativa (Júnior)"}
                value={fmtEur(actuals.count > 0 ? actuals.cost : data.allocation.cheapest.totalCost)}
                hint={
                  actuals.count > 0
                    ? `Previsão: ${fmtEur(data.allocation.cheapest.totalCost)}${actuals.hiddenCost ? " · sem o custo do TL" : ""} · pago pelo ponto`
                    : undefined
                }
              />
            )}
          </div>

          {/* Hourly table */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Por hora — {fmtDate(data.targetDate)}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                As 24 horas do dia operacional (das 03h às 03h). Condutores = extras precisos em cada hora, além do team leader.
                Clica numa hora para ver os blocos de 20min. Clica num bloco para ver as reservas.
                <span className="inline-block w-3 h-3 rounded-sm bg-yellow-100 border border-yellow-300 align-text-bottom mx-1"></span>
                hora com Terminal 2 (30min/reserva) ·
                <span className="inline-block w-3 h-3 rounded-sm bg-red-100 border border-red-300 align-text-bottom mx-1"></span>
                hora com serviço fora do aeroporto (60min/reserva — Lisboa: Oriente, Sete Rios, Rossio, Entrecampos; Faro: estação)
              </p>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs uppercase text-muted-foreground">
                      <th className="text-left py-2 px-2 w-6"></th>
                      <th className="text-left py-2 px-2">Hora</th>
                      <th className="text-right py-2 px-2">Chegadas</th>
                      <th className="text-right py-2 px-2">Saídas</th>
                      <th className="text-right py-2 px-2">Total</th>
                      <th className="py-2 px-2 hidden sm:table-cell w-[28%]"><span className="sr-only">Carga</span></th>
                      <th className="text-right py-2 px-2" title={`Extras precisos nessa hora, além do team leader. ${data.crewRuleText} (Definições → Parâmetros → Extras-dia)`}>Condutores</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* 44a (Jorge, 7 out 2026: "passa a ter as 24 horas, mesmo que não haja entregas e recolhas, das 3 às 3") */}
                    {(() => {
                      const rows = data.hourly.filter(h => h.hour >= 3 && h.hour < 27);
                      const maxTotal = Math.max(1, ...rows.map(h => h.checkins + h.checkouts));
                      return rows.map(row => (
                        <Fragment key={row.hour}>
                          {(row.hour === 3 || row.hour === 15) && (
                            <tr className="bg-muted/40">
                              <td colSpan={7} className="py-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                {row.hour === 3 ? "Manhã · 03h–15h" : "Noite · 15h–03h"}
                              </td>
                            </tr>
                          )}
                          <HourRow
                            row={row}
                            targetDate={data.targetDate}
                            isPeak={peakHour?.hour === row.hour}
                            tight={tightHours.get(row.hour) ?? null}
                            maxTotal={maxTotal}
                          />
                        </Fragment>
                      ));
                    })()}
                    {data.hourly.every(h => h.checkins + h.checkouts === 0) && (
                      <tr>
                        <td colSpan={7} className="py-6 text-center text-muted-foreground">
                          Sem operações previstas neste dia.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Lavagens */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Droplets className="h-4 w-4 text-cyan-600" />
                Lavagens
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <WashTile
                  title="Saídas hoje com lavagem"
                  date={data.washes.base.date}
                  count={data.washes.base.exitsWithWash}
                />
                <WashTile
                  title="Saídas amanhã com lavagem"
                  date={data.washes.target.date}
                  count={data.washes.target.exitsWithWash}
                  highlight
                />
                <WashTile
                  title="Saídas depois de amanhã"
                  date={data.washes.next.date}
                  count={data.washes.next.exitsWithWash}
                />
              </div>
              <p className="text-xs text-muted-foreground mt-3">
                Lavagens não consomem condutores. Os carros listados em "amanhã" / "depois de
                amanhã" precisam de ser lavados antes da entrega.
              </p>
            </CardContent>
          </Card>

          {/* Proposta automática + confirmação + avisos */}
          <SchedulePanel targetDate={data.targetDate} />

          {/* Equipa do dia (real) — vem antes da estimativa */}
          {SHIFTS.map(s => (
            <TeamSection
              key={s.id}
              targetDate={data.targetDate}
              shift={s.id}
              shiftLabel={s.label}
              defaultStart={s.defaultStart}
              defaultEnd={s.defaultEnd}
            />
          ))}

          {/* Estimativa de referência — vazia/colapsa quando há atribuições */}
          {(() => {
            const remainingSuggested = data.allocation.cheapest.shifts.slice(actuals.count);
            const remainingHours = remainingSuggested.reduce((s, x) => s + x.hours, 0);
            const remainingCost = remainingSuggested.reduce((s, x) => s + x.cost, 0);
            const allCovered = data.allocation.cheapest.shifts.length > 0 && actuals.count >= data.allocation.cheapest.shifts.length;

            return (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Users className="h-4 w-4" />
                    Estimativa de referência (extras além do TL · turnos 3–12h)
                  </CardTitle>
                  {actuals.count > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {allCovered
                        ? "Todos os slots previstos já estão cobertos pela equipa acima."
                        : `${actuals.count} de ${data.allocation.cheapest.shifts.length} slots previstos cobertos pela equipa. Restam ${remainingSuggested.length} por escalar.`}
                    </p>
                  )}
                </CardHeader>
                <CardContent className="space-y-4">
                  {data.allocation.cheapest.shifts.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Sem turnos necessários previstos.</p>
                  ) : (
                    <div>
                      <h3 className="font-medium text-sm mb-2">
                        {actuals.count > 0 ? "Slots ainda por cobrir" : access.costs ? "Turnos propostos (Júnior — mais barato)" : "Turnos propostos"}
                      </h3>
                      {remainingSuggested.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Sem slots por cobrir.</p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b text-xs uppercase text-muted-foreground">
                                <th className="text-left py-2 px-2">#</th>
                                <th className="text-left py-2 px-2">Tipo</th>
                                <th className="text-right py-2 px-2">Início</th>
                                <th className="text-right py-2 px-2">Fim</th>
                                <th className="text-right py-2 px-2">Horas</th>
                                {access.costs && <th className="text-right py-2 px-2">€/h</th>}
                                {access.costs && <th className="text-right py-2 px-2">Custo</th>}
                              </tr>
                            </thead>
                            <tbody>
                              {remainingSuggested.map((s, i) => (
                                <tr key={i} className="border-b text-muted-foreground">
                                  <td className="py-1.5 px-2">{actuals.count + i + 1}</td>
                                  <td className="py-1.5 px-2">{s.label}</td>
                                  <td className="py-1.5 px-2 text-right font-mono">{fmtHour(s.startHour)}</td>
                                  <td className="py-1.5 px-2 text-right font-mono">{fmtHour(s.endHour)}</td>
                                  <td className="py-1.5 px-2 text-right">{s.hours}h</td>
                                  {access.costs && <td className="py-1.5 px-2 text-right">{fmtEur(s.hourlyRate)}</td>}
                                  {access.costs && <td className="py-1.5 px-2 text-right">{fmtEur(s.cost)}</td>}
                                </tr>
                              ))}
                              <tr className="font-semibold bg-muted/40">
                                <td colSpan={4} className="py-2 px-2 text-right">Em falta</td>
                                <td className="py-2 px-2 text-right">{remainingHours}h</td>
                                {access.costs && <td></td>}
                                {access.costs && <td className="py-2 px-2 text-right">{fmtEur(remainingCost)}</td>}
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {access.costs && <div>
                    <h3 className="font-medium text-sm mb-2">Estimativa por nível (referência)</h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                      {data.allocation.bySingleLevel.map(l => (
                        <div
                          key={l.level}
                          className="border rounded-md p-3 bg-card"
                        >
                          <div className="text-xs text-muted-foreground">{l.label}</div>
                          <div className="text-lg font-semibold">{fmtEur(l.totalCost)}</div>
                          <div className="text-xs text-muted-foreground">{l.totalHours}h totais</div>
                        </div>
                      ))}
                    </div>
                  </div>}
                </CardContent>
              </Card>
            );
          })()}
        </>
      )}
    </div>
    </RatesContext.Provider>
    </ExtrasAccessContext.Provider>
  </ExtrasCityContext.Provider>
  );
}

// ─── Proposta automática da escala ────────────────────────────────────────────

const SCHEDULE_STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  none: { label: "Sem proposta", cls: "bg-muted text-muted-foreground" },
  // Só suspenso (sem proposta): a proposta automática ainda corre.
  hold: { label: "Sem proposta", cls: "bg-muted text-muted-foreground" },
  proposing: { label: "A propor…", cls: "bg-muted text-muted-foreground" },
  proposed: { label: "Proposta por confirmar", cls: "bg-violet-100 text-violet-800 border-violet-200" },
  confirmed: { label: "Escala confirmada", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" },
};

function SchedulePanel({ targetDate }: { targetDate: string }) {
  const utils = trpc.useUtils();
  const city = useContext(ExtrasCityContext);
  const { canEdit } = useContext(ExtrasAccessContext);
  // Dias passados: não se confirma nem se avisa ninguém (o servidor também recusa).
  const pastDay = !!targetDate && targetDate < todayISO();
  const q = trpc.extrasDia.schedule.useQuery({ date: targetDate, city }, { enabled: !!targetDate });
  // Pedido 7: as faltas dizem se há quem escalar ("faltam escalar 2 às 02h (há 2 disponíveis: …)") ou não.
  const staffingQ = trpc.extrasDia.staffing.useQuery({ date: targetDate, city }, { enabled: !!targetDate });
  const refresh = () => {
    utils.extrasDia.schedule.invalidate();
    utils.extrasDia.assignments.invalidate();
    utils.extrasDia.coverage.invalidate();
    utils.extrasDia.staffing.invalidate();
    utils.extrasDia.notices.invalidate();
  };
  const propose = trpc.extrasDia.propose.useMutation({
    onSuccess: (r) => {
      refresh();
      if (r.gaps.length) toast.warning(`${r.proposed} condutor(es) propostos — ${r.gaps.map(describeGap).join("; ")}.`);
      else toast.success(r.proposed ? `${r.proposed} condutor(es) propostos. Revê e confirma.` : "Nada a propor — a previsão já está coberta.");
    },
    onError: (e) => toast.error(e.message),
  });
  const confirm = trpc.extrasDia.confirmSchedule.useMutation({
    onSuccess: (r) => {
      refresh();
      const n = r.notifications;
      const parts: string[] = [];
      if (n?.whatsapp) parts.push(`${n.whatsapp.sent} WhatsApp`);
      if (n?.email) parts.push(`${n.email.sent} email(s)`);
      const extra = [...(n?.warnings ?? []), ...(n?.errors ?? [])];
      toast.success(`Escala confirmada${parts.length ? ` · avisos enviados: ${parts.join(", ")}` : ""}${extra.length ? ` · ${extra.join(" · ")}` : ""}`);
    },
    onError: (e) => toast.error(e.message),
  });
  const hold = trpc.extrasDia.setScheduleHold.useMutation({
    onSuccess: (r) => { refresh(); toast.success(r.hold ? "Envio automático suspenso para este dia." : "Envio automático retomado."); },
    onError: (e) => toast.error(e.message),
  });
  const ask = trpc.extrasDia.requestMissingAvailability.useMutation({
    onSuccess: (r) => {
      if (r.targets === 0) toast.info("Todos os extras desta cidade já responderam.");
      else toast.success(`Pedido enviado a ${r.targets} extra(s) · ${r.emailSent} email(s), ${r.whatsappSent} WhatsApp.`);
    },
    onError: (e) => toast.error(e.message),
  });

  const d = q.data;
  const st = SCHEDULE_STATUS_LABEL[d?.state?.status ?? "none"] ?? SCHEDULE_STATUS_LABEL.none;
  const held = !!d?.state?.holdAuto;
  const busy = propose.isPending || confirm.isPending || hold.isPending;
  const sentCount = (d?.notifications ?? []).filter((n) => n.kind === "scheduled" && n.status === "sent").length;
  const rows = (d?.proposedCount ?? 0) + (d?.confirmedCount ?? 0);

  return (
    <Card className="border-violet-200">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <CardTitle className="text-base flex items-center gap-2 flex-wrap">
              <Sparkles className="h-4 w-4 text-violet-600" />
              Escala automática — {fmtDate(targetDate)}
              <Badge variant="outline" className={st.cls}>{st.label}</Badge>
              {held && <Badge variant="outline" className="bg-amber-100 text-amber-900 border-amber-200">envio automático suspenso</Badge>}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Pico de {d?.neededPeak ?? "—"} extra(s) além do TL ·{" "}
              {d ? `${d.availableCount} extra(s) disponíveis, ${d.noAnswerCount} sem resposta` : "…"}
            </p>
            {d && (
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Proposta automática às {d.settings.autoProposeAt}
                {d.settings.autoConfirm ? ` · confirmação e avisos (WhatsApp + email) automáticos às ${d.settings.autoConfirmAt}` : " · confirmação automática desligada"}
                {" "}(hora de Lisboa, no dia anterior).
              </p>
            )}
          </div>
          {canEdit && <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy || !targetDate} onClick={() => propose.mutate({ date: targetDate, city })}
              title="Preenche as horas em falta com os extras disponíveis (substitui só a proposta automática anterior; não mexe no que está confirmado nem em quem foi posto à mão)">
              <Wand2 className="h-4 w-4 mr-1" />{propose.isPending ? "A propor…" : "Proposta automática"}
            </Button>
            <Button size="sm" disabled={busy || !targetDate || rows === 0 || pastDay}
              onClick={() => confirm.mutate({ date: targetDate, city })}
              title={pastDay ? "Esse dia já passou" : "Confirma todas as propostas e avisa cada extra por WhatsApp e email (quem já foi avisado não recebe outra vez)"}>
              <CheckCircle2 className="h-4 w-4 mr-1" />{confirm.isPending ? "A confirmar…" : `Confirmar escala${d?.proposedCount ? ` (${d.proposedCount})` : ""}`}
            </Button>
            <label className="flex items-center gap-2 text-xs border rounded-md px-2 py-1.5" title="O cron não confirma nem envia avisos deste dia/cidade enquanto estiver suspenso">
              <Switch checked={held} disabled={busy || !targetDate} onCheckedChange={(v) => hold.mutate({ date: targetDate, city, hold: v })} aria-label="Suspender envio automático" />
              <PauseCircle className="h-3.5 w-3.5" /> Suspender envio automático
            </label>
          </div>}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {q.isLoading && <div className="text-sm text-muted-foreground">A carregar…</div>}
        {q.error && <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="o estado da escala" />}
        {d && d.gaps.length > 0 && (
          <div className="rounded-md border-2 border-red-400 bg-red-50 p-3 text-sm text-red-900 dark:bg-red-950/40 dark:text-red-200">
            <div className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="h-4 w-4 shrink-0" /> Falta de gente
            </div>
            {staffingQ.data ? (
              <StaffingGapList gaps={staffingQ.data.gaps} className="mt-1" />
            ) : (
              <ul className="mt-1 space-y-0.5">
                {d.gaps.map((g, i) => <li key={i}>• {describeGap(g).replace(/^./, (c) => c.toUpperCase())}</li>)}
              </ul>
            )}
            {canEdit && (
              <Button size="sm" variant="outline" className="mt-2 h-auto min-h-8 max-w-full whitespace-normal text-left py-1.5 bg-white dark:bg-transparent" disabled={ask.isPending || d.noAnswerCount === 0}
                onClick={() => ask.mutate({ date: targetDate, city })}>
                <Send className="h-4 w-4 mr-1" />
                {ask.isPending ? "A enviar…" : `Pedir disponibilidade a quem não respondeu (${d.noAnswerCount})`}
              </Button>
            )}
          </div>
        )}
        {d && d.gaps.length === 0 && d.neededPeak > 0 && (
          <div className="rounded-md border border-emerald-300 bg-emerald-50/60 p-2 text-xs text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
            Todas as horas previstas estão cobertas pela escala.
          </div>
        )}
        {d?.state?.summary && <p className="text-xs text-muted-foreground">{d.state.summary}</p>}
        {d?.state?.status === "confirmed" && (
          <p className="text-xs text-muted-foreground">
            Confirmada {d.state.confirmedBy === "auto" ? "automaticamente" : "manualmente"} · {sentCount} aviso(s) enviado(s).
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Equipa do dia (atribuições) ───────────────────────────────────────────────

function TeamSection({
  targetDate,
  shift,
  shiftLabel,
  defaultStart,
  defaultEnd,
}: {
  targetDate: string;
  shift: ShiftId;
  shiftLabel: string;
  defaultStart: number;
  defaultEnd: number;
}) {
  const utils = trpc.useUtils();
  const city = useContext(ExtrasCityContext);
  const assignmentsQuery = trpc.extrasDia.assignments.useQuery({ date: targetDate, city });
  const access = useContext(ExtrasAccessContext);
  const { canEdit } = access;
  const pastDay = !!targetDate && targetDate < todayISO();
  const candidatesQuery = trpc.extrasDia.candidates.useQuery({ date: targetDate }, { enabled: canEdit });
  // TL: só chefias + quem tem a permissão extras_dia.team_leader (regra Jorge:
  // "só devia aparecer aqueles que têm permissão de ser team leader")
  const tlCandidatesQuery = trpc.extrasDia.candidates.useQuery({ date: targetDate, forTeamLeader: true }, { enabled: canEdit });

  // Formação obrigatória em falta: o servidor recusa (PRECONDITION_FAILED);
  // um admin pode forçar (fica registado no log de atividade).
  const { user } = useAuth();
  const canForceTraining = atLeast(user?.role, "admin");
  const [confirmForce, confirmForceUi] = useConfirm();
  // Remover pergunta antes (a linha vai para o arquivo e, se já foi avisada, a pessoa recebe aviso de que saiu).
  const [confirmDel, confirmDelUi] = useConfirm();
  const askRemove = async (a: { id: number; personName: string; startHour: number; endHour: number }) => {
    const ok = await confirmDel({
      title: `Tirar ${a.personName} da escala?`,
      description: `${fmtHour(a.startHour)}–${fmtHour(a.endHour)}. Se a pessoa já tinha sido avisada, recebe um aviso de que saiu. A linha fica guardada no arquivo.`,
      confirmLabel: "Tirar da escala",
      destructive: true,
    });
    if (ok) del.mutate({ id: a.id });
  };
  const upsert = trpc.extrasDia.upsertAssignment.useMutation({
    onSuccess: () => {
      utils.extrasDia.assignments.invalidate();
      utils.extrasDia.coverage.invalidate();
      utils.extrasDia.staffing.invalidate();
      utils.extrasDia.schedule.invalidate();
      toast.success("Turno guardado");
    },
    onError: (e) => { if (!(canForceTraining && e.data?.code === "PRECONDITION_FAILED")) toast.error(e.message); },
  });
  type UpsertInput = Parameters<typeof upsert.mutateAsync>[0];
  const saveAssignment = async (values: UpsertInput) => {
    try {
      return await upsert.mutateAsync(values);
    } catch (e: any) {
      if (canForceTraining && e?.data?.code === "PRECONDITION_FAILED") {
        const ok = await confirmForce({ title: "Formação obrigatória em falta", description: e.message, confirmLabel: "Forçar mesmo sem formação", destructive: true });
        if (ok) return await upsert.mutateAsync({ ...values, override: true });
      }
      throw e;
    }
  };
  // 44a: dar a permissão de TL daqui mesmo (antes era preciso ir às Permissões).
  const canAllowTl = canTouchPermission(user ?? null, "extras_dia.team_leader");
  const allowTl = trpc.extrasDia.allowTeamLeader.useMutation({
    onSuccess: (r) => {
      utils.extrasDia.candidates.invalidate();
      toast.success(`${r.name} já pode ser Team Leader na escala`);
    },
    onError: (e) => toast.error(e.message),
  });
  const del = trpc.extrasDia.deleteAssignment.useMutation({
    onSuccess: (r) => {
      utils.extrasDia.assignments.invalidate();
      utils.extrasDia.coverage.invalidate();
      utils.extrasDia.staffing.invalidate();
      utils.extrasDia.schedule.invalidate();
      const told = [r.notified?.whatsapp === "sent" ? "WhatsApp" : null, r.notified?.email === "sent" ? "email" : null].filter(Boolean);
      toast.success(told.length ? `Turno removido — a pessoa foi avisada por ${told.join(" e ")}.` : "Turno removido");
    },
    onError: (e) => toast.error(e.message),
  });

  // Automação: avisos (WhatsApp + email) e preenchimento. A falta de gente por
  // hora é o StaffingBanner (pedido 7: escalados vs disponíveis por escalar).
  const noticesQ = trpc.extrasDia.notices.useQuery({ date: targetDate, city });
  // Estado dos avisos por canal e versão (o email não está em `notices`, que é o histórico do WhatsApp).
  const scheduleQ = trpc.extrasDia.schedule.useQuery({ date: targetDate, city }, { enabled: !!targetDate });
  const autofill = trpc.extrasDia.autofill.useMutation({
    onSuccess: (r) => {
      utils.extrasDia.assignments.invalidate();
      utils.extrasDia.coverage.invalidate();
      utils.extrasDia.staffing.invalidate();
      utils.extrasDia.schedule.invalidate();
      if (r.created.length === 0 && r.unfilled.length === 0) toast.info("A escala já cobre a previsão deste turno.");
      else if (r.unfilled.length === 0) toast.success(`${r.created.length} extra(s) escalado(s) com base na disponibilidade.`);
      else toast.warning(`${r.created.length} escalado(s); faltam ${r.unfilled.length} turno(s) sem ninguém disponível.`);
    },
    onError: (e) => toast.error(e.message),
  });
  // Pedido 8: "Avisar este turno" abre a pré-visualização (texto de cada pessoa, canais, quem fica de fora).
  const [notifyOpen, setNotifyOpen] = useState(false);
  const noticeByAssignment = useMemo(
    () => new Map((noticesQ.data ?? []).map((n) => [n.assignmentId, n])),
    [noticesQ.data],
  );
  const emailNotices = scheduleQ.data?.notifications;
  const emailNoticeFor = useCallback(
    (a: { id: number; version?: number }) =>
      (emailNotices ?? []).find((n) => n.assignmentId === a.id && n.version === (a.version ?? 1) && n.kind === "scheduled" && n.channel === "email") ?? null,
    [emailNotices],
  );
  const [shiftFrom, shiftTo] = shift === "morning" ? [3, 15] : [15, 27];

  const allAssignments = assignmentsQuery.data ?? [];
  const allCandidates = candidatesQuery.data ?? [];
  const allTlCandidates = tlCandidatesQuery.data ?? [];
  // Mostra TODOS os extras ativos para podermos tentar/insistir com mais gente:
  // disponíveis primeiro, depois sem-resposta, depois quem disse que não pode;
  // em cada grupo os extras antes dos funcionários (estes só entram à mão e
  // não recebem avisos — 2 out 2026). Sem cidade: o servidor recusa.
  const sortCandidates = (list: typeof allCandidates) => {
    const rank = (s?: string | null) => (s === "available" ? 0 : s === "no_response" ? 1 : 2);
    const staff = (c: (typeof allCandidates)[number]) => ((c.position ?? "").toLowerCase() === "extra" ? 0 : 1);
    return list
      .slice()
      .sort((a, b) => {
        const r = rank(a.availability?.status) - rank(b.availability?.status);
        return r !== 0 ? r : staff(a) - staff(b) || a.fullName.localeCompare(b.fullName);
      });
  };
  const candidates = useMemo(() => sortCandidates(allCandidates), [allCandidates]);
  const tlCandidates = useMemo(() => sortCandidates(allTlCandidates), [allTlCandidates]);
  // 44a: no TL também aparece o resto do RH (sem a permissão) — dá-se daqui.
  const tlOthers = useMemo(() => {
    const ok = new Set(allTlCandidates.map(c => c.id));
    return candidates.filter(c => !ok.has(c.id));
  }, [candidates, allTlCandidates]);

  const assignments = allAssignments.filter(a => a.shift === shift);
  const tl = assignments.find(a => a.isTeamLeader);
  const drivers = assignments.filter(a => !a.isTeamLeader);

  const totalCost = assignments.reduce((s, a) => s + (a.cost ?? 0), 0);
  const costHidden = assignments.some((a) => a.cost == null);
  const totalHours = drivers.reduce((s, a) => s + a.hoursBilled, 0);

  const [adding, setAdding] = useState(false);
  const [addingTL, setAddingTL] = useState(false);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Users className={`h-4 w-4 ${shift === "morning" ? "text-blue-600" : "text-indigo-600"}`} />
              Equipa {shiftLabel} — {fmtDate(targetDate)}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Atribui pessoas, edita horários e "manda para casa" quando não há trabalho.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="text-right">
              {access.costs && (
                <>
                  <div className="text-xs text-muted-foreground">Custo escalado (estimativa)</div>
                  <div className="text-lg font-bold">{fmtEur(totalCost)}</div>
                  {costHidden && <div className="text-[11px] text-muted-foreground">sem o custo do TL</div>}
                </>
              )}
              <div className="text-xs text-muted-foreground">{totalHours}h pagas</div>
            </div>
            {canEdit && <Button
              size="sm"
              variant="outline"
              title="Escala quem disse que está disponível, pelos turnos que a previsão sugere"
              disabled={autofill.isPending || pastDay}
              onClick={() => autofill.mutate({ date: targetDate, city, shift })}
            >
              <Wand2 className="h-4 w-4 mr-1" /> {autofill.isPending ? "A preencher…" : "Preencher com disponíveis"}
            </Button>}
            {canEdit && <Button
              size="sm"
              variant="outline"
              title={pastDay ? "Esse dia já passou" : "Mostra o aviso de trabalho de cada pessoa (dia e horas dela) e envia por WhatsApp e email a quem deste turno está confirmado e ainda não foi avisado"}
              disabled={assignments.length === 0 || pastDay}
              onClick={() => setNotifyOpen(true)}
            >
              <MessageCircle className="h-4 w-4 mr-1" /> Avisar este turno
            </Button>}
            {canEdit && <Button size="sm" variant="default" onClick={() => setAdding(v => !v)}>
              <Plus className="h-4 w-4 mr-1" /> {adding ? "Cancelar" : "Adicionar"}
            </Button>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {confirmForceUi}
        {confirmDelUi}
        {canEdit && (
          <NotifyShiftDialog open={notifyOpen} onOpenChange={setNotifyOpen} date={targetDate} city={city} shift={shift} shiftLabel={shiftLabel} />
        )}
        {assignmentsQuery.error && <QueryErrorNote error={assignmentsQuery.error} onRetry={() => assignmentsQuery.refetch()} retrying={assignmentsQuery.isFetching} what="a equipa deste turno" />}
        {noticesQ.error && <QueryErrorNote error={noticesQ.error} onRetry={() => noticesQ.refetch()} retrying={noticesQ.isFetching} what="os avisos enviados" />}
        {(candidatesQuery.error || tlCandidatesQuery.error) && (adding || addingTL) && (
          <QueryErrorNote error={(candidatesQuery.error ?? tlCandidatesQuery.error)!} onRetry={() => { void candidatesQuery.refetch(); void tlCandidatesQuery.refetch(); }} retrying={candidatesQuery.isFetching || tlCandidatesQuery.isFetching} what="a lista de pessoas" />
        )}
        <StaffingBanner date={targetDate} city={city} fromHour={shiftFrom} toHour={shiftTo} />
        {/* TL banner */}
        <div className="rounded-md border border-amber-300 bg-amber-50/60 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wide text-amber-900">Team Leader (obrigatório)</div>
              {tl ? (
                <div className="font-semibold flex items-center gap-2 min-w-0">
                  <Avatar className="h-6 w-6">
                    <AvatarImage src={(tl as any).photoUrl ?? undefined} className="object-cover" />
                    <AvatarFallback className="text-[11px]">{tl.personName.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <span className="truncate" title={tl.personName}>{tl.personName}</span>{" "}
                  <span className="font-normal text-sm text-muted-foreground">
                    · {fmtHour(tl.startHour)}–{fmtHour(tl.sentHomeHour ?? tl.endHour)}{tl.cost != null && access.costs ? ` · ${fmtEur(tl.cost)}/dia` : ""}
                  </span>
                </div>
              ) : (
                <div className="text-sm text-amber-900">
                  Ainda não há TL definido. Define para arrancar.
                </div>
              )}
            </div>
            {!tl && canEdit && (
              <Button size="sm" variant="outline" onClick={() => setAddingTL(v => !v)}>
                {addingTL ? "Cancelar" : "Definir Team Leader"}
              </Button>
            )}
            {tl && canEdit && (
              <Button size="sm" variant="ghost" aria-label={`Tirar ${tl.personName} de Team Leader`} onClick={() => void askRemove(tl)}>
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
          </div>

          {addingTL && !tl && (
            <div className="mt-3">
              <AssignmentForm
                targetDate={targetDate}
                candidates={tlCandidates}
                others={tlOthers}
                city={city}
                canAllowTl={canAllowTl}
                onAllowTl={(id) => allowTl.mutate({ employeeId: id })}
                allowingTl={allowTl.isPending}
                asTeamLeader
                shift={shift}
                defaultStart={defaultStart}
                defaultEnd={defaultEnd}
                onSubmit={async (values) => {
                  await saveAssignment({ ...values, city });
                  setAddingTL(false);
                }}
                onCancel={() => setAddingTL(false)}
                submitting={upsert.isPending}
              />
            </div>
          )}
        </div>

        {adding && (
          <AssignmentForm
            targetDate={targetDate}
            candidates={candidates}
            city={city}
            shift={shift}
            defaultStart={defaultStart}
            defaultEnd={defaultEnd}
            onSubmit={async (values) => {
              await saveAssignment({ ...values, city });
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
            submitting={upsert.isPending}
          />
        )}

        {assignmentsQuery.isLoading && (
          <div className="text-sm text-muted-foreground">A carregar...</div>
        )}

        {!assignmentsQuery.isLoading && !assignmentsQuery.error && drivers.length === 0 && !adding && (
          <div className="text-sm text-muted-foreground py-4 text-center">
            Nenhum condutor escalado.{canEdit ? ' Clica em "Adicionar" para começar.' : ""}
          </div>
        )}

        {drivers.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs uppercase text-muted-foreground">
                  <th className="text-left py-2 px-2">Pessoa</th>
                  <th className="text-left py-2 px-2 hidden sm:table-cell">Nível</th>
                  <th className="text-right py-2 px-2"><span className="sm:hidden">Horas</span><span className="hidden sm:inline">Início</span></th>
                  <th className="text-right py-2 px-2 hidden sm:table-cell">Fim</th>
                  <th className="text-right py-2 px-2 hidden sm:table-cell">Mandado p/ casa</th>
                  <th className="text-right py-2 px-2 hidden sm:table-cell">Horas pagas</th>
                  {access.costs && <th className="text-right py-2 px-2 hidden sm:table-cell">Custo</th>}
                  {/* Sem <span sr-only>: absoluto, saía do contentor que rola e alargava a página no telemóvel. */}
                  {canEdit && <th className="text-right py-2 px-2 hidden sm:table-cell" aria-label="Ações" />}
                </tr>
              </thead>
              <tbody>
                {drivers.map((a) => (
                  <AssignmentRow
                    key={a.id}
                    assignment={a}
                    notice={rowNotice(noticeByAssignment.get(a.id) ?? null, emailNoticeFor(a))}
                    onSave={(payload) => { void saveAssignment({ ...payload, id: a.id, city }).catch(() => {}); }}
                    onDelete={() => void askRemove(a)}
                    busy={upsert.isPending || del.isPending}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface AssignmentFormValues {
  assignmentDate: string;
  employeeId: number | null;
  personName: string;
  level: LevelId | null;
  isTeamLeader: boolean;
  shift: ShiftId;
  startHour: number;
  endHour: number;
  sentHomeHour: number | null;
}

function AssignmentForm({
  targetDate,
  candidates,
  others,
  city,
  asTeamLeader,
  canAllowTl,
  onAllowTl,
  allowingTl,
  shift,
  defaultStart,
  defaultEnd,
  onSubmit,
  onCancel,
  submitting,
}: {
  targetDate: string;
  candidates: (PickerCandidate & { suggestedLevel: LevelId })[];
  /** 44a: só no TL — gente do RH ainda sem a permissão de TL. */
  others?: (PickerCandidate & { suggestedLevel: LevelId })[];
  city: ExtraCityId;
  asTeamLeader?: boolean;
  canAllowTl?: boolean;
  onAllowTl?: (employeeId: number) => void | Promise<void>;
  allowingTl?: boolean;
  shift: ShiftId;
  defaultStart: number;
  defaultEnd: number;
  onSubmit: (values: AssignmentFormValues) => void | Promise<void>;
  onCancel: () => void;
  submitting: boolean;
}) {
  const levels = useLiveLevels();
  const { costs } = useContext(ExtrasAccessContext);
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [personName, setPersonName] = useState("");
  const [level, setLevel] = useState<LevelId>("junior");
  const [startHour, setStartHour] = useState(defaultStart);
  const [endHour, setEndHour] = useState(defaultEnd);

  const span = endHour - startHour;
  const rate = levels.find(l => l.id === level)?.hourlyRate ?? 0;
  const previewCost = Math.max(0, span) * rate;
  // 44a: só gente do RH (sem nome livre). No TL, quem ainda não tem a permissão tem de a receber primeiro.
  const pickedOther = employeeId != null && !candidates.some(c => c.id === employeeId) ? (others ?? []).find(c => c.id === employeeId) ?? null : null;
  const valid = employeeId != null && !pickedOther && span >= 3 && span <= 12;

  return (
    <div className="border rounded-md p-3 bg-muted/30 space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="space-y-1 md:col-span-2">
          <Label className="text-xs">Pessoa (RH)</Label>
          <PersonPicker
            candidates={candidates}
            others={others}
            city={city}
            value={employeeId}
            onPick={(c) => {
              const full = [...candidates, ...(others ?? [])].find(x => x.id === c.id);
              setEmployeeId(c.id);
              setPersonName(c.fullName);
              if (full) setLevel(full.suggestedLevel);
            }}
          />
          <LicenceWarning status={[...candidates, ...(others ?? [])].find(x => x.id === employeeId)?.licence} name={personName} />
          {pickedOther && (
            <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-2 py-1.5 text-xs space-y-1">
              <div><strong>{pickedOther.fullName}</strong> ainda não pode ser Team Leader na escala.</div>
              {pickedOther.hasAccount === false ? (
                <div className="text-muted-foreground">Não tem conta no dashboard (a permissão é da conta): muda o posto no RH para Team Leader ou cria-lhe a conta em Utilizadores.</div>
              ) : canAllowTl ? (
                <Button size="sm" variant="outline" className="h-7 text-xs" disabled={allowingTl} onClick={() => void onAllowTl?.(pickedOther.id)}>
                  {allowingTl ? "A dar a permissão…" : "Permitir ser TL"}
                </Button>
              ) : (
                <div className="text-muted-foreground">Pede a quem gere as Permissões ("Pode ser Team Leader na escala").</div>
              )}
            </div>
          )}
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Nível</Label>
          {asTeamLeader ? (
            <div className="h-9 px-3 flex items-center text-sm border rounded-md bg-muted/60">
              Team Leader
            </div>
          ) : (
            <Select value={level} onValueChange={v => setLevel(v as LevelId)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {levels.map(l => (
                  <SelectItem key={l.id} value={l.id}>
                    {costs ? `${l.label} (${fmtEur(l.hourlyRate)}/h)` : l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
        <div className="space-y-1">
          <Label className="text-xs">Início</Label>
          <Select value={String(startHour)} onValueChange={v => setStartHour(parseInt(v, 10))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {HOURS_24.map(h => (
                <SelectItem key={h} value={String(h)}>{fmtHour(h)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Fim</Label>
          <Select value={String(endHour)} onValueChange={v => setEndHour(parseInt(v, 10))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {HOURS_25.map(h => (
                <SelectItem key={h} value={String(h)}>{fmtHour(h)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="text-sm">
          <div className="text-xs text-muted-foreground">Pré-visualização</div>
          {asTeamLeader ? (
            <div className="font-semibold">
              {span}h{costs ? " · custo diário do TL pelo salário" : ""}
            </div>
          ) : (
            <div className="font-semibold">
              {costs ? `${span}h × ${fmtEur(rate)} = ${fmtEur(previewCost)} (estimativa)` : `${span}h`}
            </div>
          )}
          {span < 3 && <div className="text-xs text-red-600">Mínimo 3h</div>}
          {span > 12 && <div className="text-xs text-red-600">Máximo 12h</div>}
          {employeeId == null && (
            <div className="text-xs text-muted-foreground">Escolhe a pessoa do RH.</div>
          )}
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} size="sm">Cancelar</Button>
        <Button
          size="sm"
          disabled={!valid || submitting}
          onClick={() => onSubmit({
            assignmentDate: targetDate,
            employeeId,
            personName: personName.trim(),
            level: asTeamLeader ? null : level,
            isTeamLeader: !!asTeamLeader,
            shift,
            startHour,
            endHour,
            sentHomeHour: null,
          })}
        >
          {asTeamLeader ? "Definir TL" : "Adicionar"}
        </Button>
      </div>
    </div>
  );
}

/** Aviso de uma linha: o do WhatsApp (com sim/não) e, à parte, o estado do email desta versão (pedido 8). */
type RowNotice = {
  status: string | null;
  confirmedAt: string | null;
  declinedAt: string | null;
  /** Carregou em "Preciso de alterar" no turno_confirmado. */
  changeRequestedAt?: string | null;
  error: string | null;
  outdated?: boolean;
  email?: { status: string; detail: string | null } | null;
};

function rowNotice(
  wa: { status: string; confirmedAt: string | null; declinedAt: string | null; changeRequestedAt?: string | null; error: string | null; outdated?: boolean } | null,
  email: { status: string; detail: string | null } | null,
): RowNotice | null {
  if (!wa && !email) return null;
  return wa ? { ...wa, email } : { status: null, confirmedAt: null, declinedAt: null, error: null, email };
}

function EmailNoticeBadge({ email }: { email: { status: string; detail: string | null } }) {
  if (email.status === "sent") return <Badge variant="secondary" className="gap-1 text-[11px]" title="Aviso de trabalho enviado por email (estas horas)"><Mail className="h-3 w-3" />email</Badge>;
  if (email.status === "sending") return null;
  const failed = email.status === "failed";
  return (
    <Badge variant="outline" className={`gap-1 text-[11px] ${failed ? "border-red-300 text-red-700" : "text-muted-foreground"}`} title={email.detail ?? (failed ? "Falhou o envio do email" : "Email não enviado")}>
      <Mail className="h-3 w-3" />{failed ? "email falhou" : "sem email"}
    </Badge>
  );
}

function NoticeBadge({ notice }: { notice: RowNotice | null }) {
  if (!notice) return null;
  const email = notice.email ? <EmailNoticeBadge email={notice.email} /> : null;
  if (!notice.status) return email;
  // Mudaram as horas/pessoa depois do aviso: o que foi dito já não vale.
  const wa = notice.outdated
    ? <Badge variant="outline" className="text-[11px] border-amber-300 text-amber-800" title="O aviso foi das horas antigas — avisa outra vez">aviso desatualizado</Badge>
    : notice.changeRequestedAt
    ? <Badge className="bg-amber-500 text-[11px]" title="Carregou em Preciso de alterar na confirmação do turno">alteração pedida</Badge>
    : notice.declinedAt
      ? <Badge variant="destructive" className="text-[11px]" title="Respondeu que não pode">✗ não pode</Badge>
      : notice.confirmedAt
        ? <Badge className="bg-emerald-700 text-[11px]" title="Confirmou pelo WhatsApp">✓ confirmou</Badge>
        : notice.status === "sent"
          ? <Badge variant="secondary" className="text-[11px]" title="Aviso enviado por WhatsApp — à espera de resposta">avisado</Badge>
          : <Badge variant="outline" className="text-[11px] border-red-300 text-red-700" title={notice.error ?? "Falhou o envio"}>aviso falhou</Badge>;
  return <>{wa}{email}</>;
}

function AssignmentRow({
  assignment,
  notice = null,
  onSave,
  onDelete,
  busy,
}: {
  notice?: RowNotice | null;
  assignment: {
    id: number;
    assignmentDate: string;
    employeeId: number | null;
    personName: string;
    level: LevelId | null;
    isTeamLeader: boolean;
    shift: ShiftId;
    startHour: number;
    endHour: number;
    sentHomeHour: number | null;
    notes: string | null;
    hoursBilled: number;
    /** null = esta conta não vê o custo. */
    cost: number | null;
    status?: "proposed" | "confirmed";
    proposalReason?: string | null;
    source?: string;
    createdByName?: string | null;
    updatedByName?: string | null;
    createdById?: number | null;
    updatedById?: number | null;
  };
  onSave: (payload: AssignmentFormValues) => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const a = assignment;
  const levels = useLiveLevels();
  const { canEdit, costs } = useContext(ExtrasAccessContext);
  const openEmployeeRow = useOpenEmployee();
  const [editing, setEditing] = useState(false);
  const [level, setLevel] = useState<LevelId>((a.level ?? "junior") as LevelId);
  const [startHour, setStartHour] = useState(a.startHour);
  const [endHour, setEndHour] = useState(a.endHour);
  const [sentHomeHour, setSentHomeHour] = useState<number | null>(a.sentHomeHour);

  const span = (sentHomeHour ?? endHour) - startHour;
  const rate = levels.find(l => l.id === level)?.hourlyRate ?? 0;
  const computedCost = Math.max(0, span) * rate;

  if (!editing) {
    return (
      <tr className="border-b hover:bg-muted/30">
        <td className="py-2 px-2">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Avatar className="h-6 w-6">
              <AvatarImage src={(a as any).photoUrl ?? undefined} className="object-cover" />
              <AvatarFallback className="text-[11px]">{a.personName.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            {a.employeeId ? (
              <button type="button" className="hover:underline" title="Abrir ficha do funcionário" onClick={() => openEmployeeRow(a.employeeId!)}>
                {a.personName}
              </button>
            ) : a.personName}
            <NoticeBadge notice={notice} />
            {a.employeeId != null && <QuickNoteButton employeeId={a.employeeId} name={a.personName} workDate={a.assignmentDate} assignmentId={a.id} />}
            {a.status === "proposed" && (
              <Badge variant="outline" className="text-[11px] border-violet-300 text-violet-700" title="Proposta automática — ainda por confirmar">proposta</Badge>
            )}
          </span>
          {a.proposalReason && (
            <div className="text-[11px] text-muted-foreground mt-0.5 max-w-[16rem] sm:max-w-md leading-snug break-words" title="Porquê esta pessoa">
              {a.proposalReason}
            </div>
          )}
          {assignmentWhoLine(a) && <div className="text-[11px] text-muted-foreground mt-0.5 break-words">{assignmentWhoLine(a)}</div>}
          {/* No telemóvel as colunas do nível e das horas pagas escondem-se: vão aqui. */}
          <div className="sm:hidden text-[11px] text-muted-foreground mt-0.5">
            {levels.find(l => l.id === a.level)?.label} · {a.hoursBilled}h pagas{a.sentHomeHour != null ? ` · p/ casa ${fmtHour(a.sentHomeHour)}` : ""}{costs && a.cost != null ? ` · ${fmtEur(a.cost)}` : ""}
          </div>
          {canEdit && (
            <div className="sm:hidden flex gap-1 mt-1">
              <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => setEditing(true)}>Editar</Button>
              <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onDelete} disabled={busy} aria-label={`Tirar ${a.personName} da escala`}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          )}
        </td>
        <td className="py-2 px-2 hidden sm:table-cell">
          <Badge variant="secondary">{levels.find(l => l.id === a.level)?.label}</Badge>
        </td>
        <td className="py-2 px-2 text-right font-mono whitespace-nowrap">
          {fmtHour(a.startHour)}<span className="sm:hidden">–{fmtHour(a.endHour)}</span>
        </td>
        <td className="py-2 px-2 text-right font-mono hidden sm:table-cell">{fmtHour(a.endHour)}</td>
        <td className="py-2 px-2 text-right font-mono hidden sm:table-cell">
          {a.sentHomeHour != null ? fmtHour(a.sentHomeHour) : "—"}
        </td>
        <td className="py-2 px-2 text-right hidden sm:table-cell">{a.hoursBilled}h</td>
        {costs && <td className="py-2 px-2 text-right font-semibold hidden sm:table-cell">{a.cost != null ? fmtEur(a.cost) : "—"}</td>}
        {canEdit && <td className="py-2 px-2 text-right hidden sm:table-cell">
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)} aria-label={`Editar ${a.personName}`}>Editar</Button>
            <Button size="sm" variant="ghost" className="px-2" onClick={onDelete} disabled={busy} aria-label={`Tirar ${a.personName} da escala`}>
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </td>}
      </tr>
    );
  }

  return (
    <tr className="border-b bg-muted/20">
      <td className="py-2 px-2">
        {a.personName}
        <div className="sm:hidden mt-1 flex flex-wrap gap-1">
          <Select value={level} onValueChange={v => setLevel(v as LevelId)}>
            <SelectTrigger className="h-8 w-28" aria-label="Nível"><SelectValue /></SelectTrigger>
            <SelectContent>
              {levels.map(l => (
                <SelectItem key={l.id} value={l.id}>{l.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={sentHomeHour == null ? "none" : String(sentHomeHour)}
            onValueChange={v => setSentHomeHour(v === "none" ? null : parseInt(v, 10))}
          >
            <SelectTrigger className="h-8 w-28" aria-label="Mandado para casa"><SelectValue placeholder="p/ casa —" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">— Não vai p/ casa —</SelectItem>
              {HOURS_25.filter(h => h >= startHour && h <= endHour).map(h => (
                <SelectItem key={h} value={String(h)}>p/ casa {fmtHour(h)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </td>
      <td className="py-2 px-2 hidden sm:table-cell">
        <Select value={level} onValueChange={v => setLevel(v as LevelId)}>
          <SelectTrigger className="h-8 w-24"><SelectValue /></SelectTrigger>
          <SelectContent>
            {levels.map(l => (
              <SelectItem key={l.id} value={l.id}>{l.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </td>
      <td className="py-2 px-2 text-right">
        <Select value={String(startHour)} onValueChange={v => setStartHour(parseInt(v, 10))}>
          <SelectTrigger className="h-8 w-[4.5rem] sm:w-20" aria-label="Início"><SelectValue /></SelectTrigger>
          <SelectContent>
            {HOURS_24.map(h => <SelectItem key={h} value={String(h)}>{fmtHour(h)}</SelectItem>)}
          </SelectContent>
        </Select>
        {/* No telemóvel o fim vai por baixo do início (a coluna "Fim" esconde-se). */}
        <div className="sm:hidden mt-1">
          <Select value={String(endHour)} onValueChange={v => setEndHour(parseInt(v, 10))}>
            <SelectTrigger className="h-8 w-[4.5rem]" aria-label="Fim"><SelectValue /></SelectTrigger>
            <SelectContent>
              {HOURS_25.map(h => <SelectItem key={h} value={String(h)}>{fmtHour(h)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </td>
      <td className="py-2 px-2 text-right hidden sm:table-cell">
        <Select value={String(endHour)} onValueChange={v => setEndHour(parseInt(v, 10))}>
          <SelectTrigger className="h-8 w-[4.5rem] sm:w-20" aria-label="Fim"><SelectValue /></SelectTrigger>
          <SelectContent>
            {HOURS_25.map(h => <SelectItem key={h} value={String(h)}>{fmtHour(h)}</SelectItem>)}
          </SelectContent>
        </Select>
      </td>
      <td className="py-2 px-2 text-right hidden sm:table-cell">
        <Select
          value={sentHomeHour == null ? "none" : String(sentHomeHour)}
          onValueChange={v => setSentHomeHour(v === "none" ? null : parseInt(v, 10))}
        >
          <SelectTrigger className="h-8 w-24"><SelectValue placeholder="—" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">— Não —</SelectItem>
            {HOURS_25
              .filter(h => h >= startHour && h <= endHour)
              .map(h => (
                <SelectItem key={h} value={String(h)}>
                  <span className="flex items-center gap-1"><Home className="h-3 w-3" />{fmtHour(h)}</span>
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </td>
      <td className="py-2 px-2 text-right hidden sm:table-cell">{Math.max(0, span)}h</td>
      {costs && <td className="py-2 px-2 text-right font-semibold hidden sm:table-cell">{fmtEur(computedCost)}</td>}
      <td className="py-2 px-2 text-right">
        <div className="flex flex-col sm:flex-row justify-end gap-1">
          <Button
            size="sm"
            disabled={busy || endHour - startHour < 3 || endHour - startHour > 12}
            onClick={() => {
              onSave({
                assignmentDate: a.assignmentDate,
                employeeId: a.employeeId,
                personName: a.personName,
                level,
                isTeamLeader: false,
                shift: a.shift,
                startHour,
                endHour,
                sentHomeHour,
              });
              setEditing(false);
            }}
          >
            Guardar
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancelar
          </Button>
        </div>
      </td>
    </tr>
  );
}

function KpiCard({
  icon,
  label,
  value,
  hint,
  breakdown,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  hint?: string;
  breakdown?: { covered: number; uncovered: number; indoor: number; unknown: number };
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className="text-2xl font-bold mt-1 tabular-nums truncate" title={typeof value === "string" || typeof value === "number" ? String(value) : undefined}>{value}</div>
        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
        {breakdown && (breakdown.uncovered + breakdown.covered + breakdown.indoor + breakdown.unknown > 0) && (
          <div className="text-[11px] text-muted-foreground mt-1 leading-tight">
            {breakdown.uncovered > 0 && <span>{breakdown.uncovered} desc.</span>}
            {breakdown.covered > 0 && <span className="ml-1">{breakdown.covered} cob.</span>}
            {breakdown.indoor > 0 && <span className="ml-1">{breakdown.indoor} ind.</span>}
            {breakdown.unknown > 0 && <span className="ml-1">{breakdown.unknown} ?</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Hour / Slot drill-down ──────────────────────────────────────────────────

const fmtHM = (h: number, m: number) =>
  `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

function HourRow({
  row,
  targetDate,
  isPeak,
  tight,
  maxTotal,
}: {
  tight?: TightReason | null;
  /** 44a: a hora com mais carros do dia (escala da barra). */
  maxTotal: number;
  row: {
    hour: number;
    checkins: number;
    checkouts: number;
    driversNeeded: number;
    hasT2: boolean;
    hasOther: boolean;
    slots: { hour: number; slot: number; checkins: number; checkouts: number; weightedDemand: number; driversNeeded: number }[];
  };
  targetDate: string;
  isPeak: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const total = row.checkins + row.checkouts;
  // Prioridade: Outro (vermelho) > T2 (amarelo) > pico (azul) > default
  const rowBg = row.hasOther
    ? "bg-red-50 hover:bg-red-100/70"
    : row.hasT2
      ? "bg-yellow-50 hover:bg-yellow-100/70"
      : isPeak
        ? "bg-blue-50/50 hover:bg-muted/40"
        : "hover:bg-muted/40";
  return (
    <>
      <tr
        className={`border-b cursor-pointer ${rowBg}`}
        onClick={() => setExpanded(v => !v)}
      >
        <td className="py-1.5 px-2 text-muted-foreground">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </td>
        <td className="py-1.5 px-2 font-mono whitespace-nowrap">{fmtHour(row.hour)}{tight && <TightHourBadge reason={tight} />}</td>
        <td className="py-1.5 px-2 text-right text-emerald-700 tabular-nums">{row.checkins || ""}</td>
        <td className="py-1.5 px-2 text-right text-orange-700 tabular-nums">{row.checkouts || ""}</td>
        <td className={`py-1.5 px-2 text-right tabular-nums ${total ? "font-semibold" : "text-muted-foreground/50"}`}>{total || "·"}</td>
        <td className="py-1.5 px-2 hidden sm:table-cell" aria-hidden>
          {/* 44a: barra da carga — chegadas (verde) + saídas (laranja), à escala da hora mais cheia */}
          {total > 0 && (
            <div className="flex h-2.5 gap-[2px]" style={{ width: `${Math.max(4, (total / maxTotal) * 100)}%` }}>
              {row.checkins > 0 && <div className="h-full rounded-l-sm bg-emerald-600" style={{ flexGrow: row.checkins }} />}
              {row.checkouts > 0 && <div className="h-full rounded-r-sm bg-orange-500" style={{ flexGrow: row.checkouts }} />}
            </div>
          )}
        </td>
        <td className="py-1.5 px-2 text-right">
          {row.driversNeeded ? <Badge variant="secondary" className="tabular-nums">{row.driversNeeded}</Badge> : <span className="text-muted-foreground/50">·</span>}
        </td>
      </tr>
      {expanded && row.slots.map(s => (
        <SlotRow key={s.slot} slot={s} targetDate={targetDate} />
      ))}
    </>
  );
}

function SlotRow({
  slot,
  targetDate,
}: {
  slot: { hour: number; slot: number; checkins: number; checkouts: number; weightedDemand: number; driversNeeded: number };
  targetDate: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const minuteStart = slot.slot * 20;
  const minuteEnd = minuteStart + 20;
  const label = `${fmtHM(slot.hour, minuteStart)}–${fmtHM(slot.hour, minuteEnd)}`;
  const total = slot.checkins + slot.checkouts;
  const hasData = total > 0;

  return (
    <>
      <tr
        className={`border-b ${hasData ? "cursor-pointer hover:bg-muted/30" : ""} bg-muted/10`}
        onClick={() => hasData && setExpanded(v => !v)}
      >
        <td className="py-1 px-2 pl-6 text-muted-foreground">
          {hasData && (expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />)}
        </td>
        <td className="py-1 px-2 font-mono text-xs text-muted-foreground">{label}</td>
        <td className="py-1 px-2 text-right text-emerald-700 text-xs">{slot.checkins || ""}</td>
        <td className="py-1 px-2 text-right text-orange-700 text-xs">{slot.checkouts || ""}</td>
        <td className="py-1 px-2 text-right text-xs">{total || ""}</td>
        <td className="py-1 px-2 hidden sm:table-cell" />
        <td className="py-1 px-2 text-right text-xs text-muted-foreground" title="Condutores se este ritmo de 20 min durasse a hora inteira">
          {slot.driversNeeded || ""}
          {slot.weightedDemand > total && total > 0 && (
            <span className="ml-1 text-amber-700" title="Procura aumentada por T2 / fora do aeroporto">⚠</span>
          )}
        </td>
      </tr>
      {expanded && hasData && (
        <tr>
          <td colSpan={7} className="bg-blue-50/30 px-6 py-2">
            <SlotBookings targetDate={targetDate} hour={slot.hour} slot={slot.slot} />
          </td>
        </tr>
      )}
    </>
  );
}

function SlotBookings({
  targetDate,
  hour,
  slot,
}: {
  targetDate: string;
  hour: number;
  slot: number;
}) {
  const cityCtx = useContext(ExtrasCityContext);
  const checkinsQ = trpc.extrasDia.bookingsInSlot.useQuery(
    { date: targetDate, hour, slot, type: "checkin", city: cityCtx },
  );
  const checkoutsQ = trpc.extrasDia.bookingsInSlot.useQuery(
    { date: targetDate, hour, slot, type: "checkout", city: cityCtx },
  );

  const checkins = checkinsQ.data ?? [];
  const checkouts = checkoutsQ.data ?? [];
  const loading = checkinsQ.isLoading || checkoutsQ.isLoading;
  const failed = checkinsQ.error ?? checkoutsQ.error;
  if (failed) {
    return <QueryErrorNote error={failed} onRetry={() => { void checkinsQ.refetch(); void checkoutsQ.refetch(); }} retrying={checkinsQ.isFetching || checkoutsQ.isFetching} what="as reservas deste intervalo" />;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
      <BookingList title="Chegadas" tone="emerald" items={checkins} loading={loading} />
      <BookingList title="Saídas" tone="orange" items={checkouts} loading={loading} />
    </div>
  );
}

function BookingList({
  title,
  tone,
  items,
  loading,
}: {
  title: string;
  tone: "emerald" | "orange";
  items: { id: number; clientName: string; licensePlate: string | null; parkName: string | null; time: string; bookingNumber: string | null; deliveryType: string | null }[];
  loading: boolean;
}) {
  const accent = tone === "emerald" ? "text-emerald-700" : "text-orange-700";
  return (
    <div>
      <div className={`font-semibold mb-1 ${accent}`}>{title}</div>
      {loading && <div className="text-muted-foreground">A carregar...</div>}
      {!loading && items.length === 0 && (
        <div className="text-muted-foreground">Sem reservas neste intervalo.</div>
      )}
      {items.length > 0 && (
        <ul className="space-y-0.5">
          {items.map(b => (
            <li key={b.id} className="flex flex-wrap items-center gap-x-2">
              <span className="font-mono">{b.time}</span>
              <span className="font-mono text-muted-foreground">{b.licensePlate || "—"}</span>
              <span>{b.clientName}</span>
              {b.deliveryType && (
                <Badge variant="outline" className="text-[11px] py-0 h-5">
                  {b.deliveryType}
                </Badge>
              )}
              {b.parkName && (
                <span className="text-muted-foreground">· {b.parkName}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WashTile({
  title,
  date,
  count,
  highlight,
}: {
  title: string;
  date: string;
  count: number;
  highlight?: boolean;
}) {
  return (
    <div
      className={`border rounded-md p-3 ${
        highlight ? "bg-cyan-50/60 border-cyan-200" : "bg-card"
      }`}
    >
      <div className="text-xs text-muted-foreground">{title}</div>
      <div className="text-xs text-muted-foreground">{fmtDate(date)}</div>
      <div className="text-2xl font-bold mt-1">{count}</div>
    </div>
  );
}

// ─── Disponibilidade semanal dos extras (backoffice) ─────────────────────────
/**
 * Pesquisa livre por pessoa na tabela de extras — nome (sem acentos/maiúsculas)
 * ou número. Reutiliza o `matchesContactQuery` do inbox WhatsApp; a única
 * diferença é o número ser tentado nas DUAS formas que a ficha tem: o E.164
 * normalizado pelo servidor e o texto em bruto (só assim se encontra quem tem o
 * número escrito de forma que a normalização não reconhece).
 */
function matchesExtraQuery(
  query: string,
  ex: { fullName: string; phone: string | null; phoneE164: string | null },
): boolean {
  if (matchesContactQuery(query, { name: ex.fullName, phone: ex.phoneE164 })) return true;
  return !!ex.phone && matchesContactQuery(query, { name: ex.fullName, phone: ex.phone });
}

// Exportada: rende na página Disponibilidade (hub de gestão), não aqui — a
// Extras Dia ficou só com previsão + equipa do dia (pedido do Jorge, jul 2026).
export function AvailabilitySection() {
  const hints = trpc.extrasAvailability.weekHints.useQuery();
  const [weekStart, setWeekStart] = useState<string>("");
  const [note, setNote] = useState("");
  // Tipo de pedido (templates do Jorge): semana / dia+turno / que-horas / das X às Y
  const [msgKind, setMsgKind] = useState<AvailabilityMessageKind>("week");
  const [msgDate, setMsgDate] = useState(() => { const d = new Date(); d.setDate(d.getDate() + 1); const pad = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; });
  const [msgShift, setMsgShift] = useState<"morning" | "afternoon" | "night">("morning");
  const [msgFrom, setMsgFrom] = useState(8);
  const [msgTo, setMsgTo] = useState(20);
  const msgDateLabel = useMemo(() => {
    const today = new Date(); const pad = (n: number) => String(n).padStart(2, "0");
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const dm = msgDate.slice(8, 10) + "/" + msgDate.slice(5, 7);
    if (msgDate === iso(today)) return `hoje (${dm})`;
    if (msgDate === iso(tomorrow)) return `amanhã (${dm})`;
    return `dia ${dm}`;
  }, [msgDate]);
  // `msgParams`/`msgPreview` ficam mais abaixo: precisam do rótulo da semana,
  // que vem da overview.
  const msgInput = useMemo(() => msgKind === "week" ? null : ({
    kind: msgKind, dateLabel: msgDateLabel, targetDate: msgDate || null,
    ...(msgKind === "day_shift" ? { shift: msgShift } : {}),
    ...(msgKind === "day_range" ? { fromHour: msgFrom, toHour: msgTo } : {}),
  }), [msgKind, msgDateLabel, msgDate, msgShift, msgFrom, msgTo]);
  const [testEmail, setTestEmail] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  // Estado da resposta nesta semana (Jorge, set 2026 — substitui as caixas
  // "só quem marcou" e "ainda não respondeu"): todos / disponíveis /
  // indisponíveis (responderam sem dias) / sem resposta. Regra em
  // shared/availabilityGroups.ts.
  const [statusFilter, setStatusFilter] = useState<AvailabilityStatusFilter>("all");
  // Filtro de acompanhamento (Jorge, 2026-09-09): a quem NÃO foi enviada
  // mensagem nas últimas 24h (WhatsApp ou email — `contactedWithin24h` vem do servidor).
  const [onlyNotContacted24h, setOnlyNotContacted24h] = useState(false);
  // Painel "mensagem + teste" — fechado por defeito para a página não abrir
  // com tudo à vista; os botões de envio ficam sempre visíveis.
  const [showCompose, setShowCompose] = useState(false);
  // Filtro de cidade. "all" = sem filtro; "none" = fichas sem cidade
  // identificada (ver server/employeeCity.ts — a cidade é DERIVADA).
  const [pickedCity, setCityFilter] = useState<CityKey | "all" | "none">("all");
  // Cidade escolhida em cima (filtro global — Jorge, 2 out 2026: "aqui só deve
  // aparecer a cidade escolhida"): manda sobre os botões de cidade.
  const globalFilters = useGlobalFilters();
  const globalCity = useMemo<CityKey | null>(() => {
    const name = globalFilters.cities.find((p) => p.id === globalFilters.cityId)?.name;
    return name ? matchCityKey(name) : null;
  }, [globalFilters.cities, globalFilters.cityId]);
  const cityFilter: CityKey | "all" | "none" = globalCity ?? pickedCity;
  // Filtro "disponível das X às Y" (Jorge, 2026-09-17): dia opcional + horas.
  // Com as duas horas → quem pode em ALGUM momento desse horário (sobreposição,
  // não cobertura total: alargar a janela nunca esconde ninguém), num dia certo
  // ou em qualquer dia da semana; só com dia → quem marcou algo nesse dia. A
  // regra vive em shared/availabilityWindow.ts (turnos 03–15 / 15–03, horas mandam).
  const [windowDay, setWindowDay] = useState<string>("any");
  const [windowFrom, setWindowFrom] = useState<number | null>(null);
  const [windowTo, setWindowTo] = useState<number | null>(null);
  // Pesquisa por pessoa (nome ou número). Filtro LOCAL sobre a lista já
  // carregada — a `overview` traz todos os extras ativos de uma vez, por isso
  // não há pedido nenhum a debouncear.
  const [search, setSearch] = useState("");

  // assim que chegam as sugestões, default = próxima segunda
  const effectiveWeek = weekStart || hints.data?.next || "";

  const overview = trpc.extrasAvailability.overview.useQuery(
    { weekStart: effectiveWeek },
    { enabled: !!effectiveWeek },
  );

  const send = trpc.extrasAvailability.sendRequest.useMutation({
    onSuccess: (r) => {
      toast.success(`Pedido enviado: ${r.sent} extras${r.failed ? `, ${r.failed} falhas` : ""}${r.noEmail ? `, ${r.noEmail} sem email` : ""}${r.optedOut ? `, ${r.optedOut} com "Não enviar email"` : ""}`);
      overview.refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const o = overview.data;

  // Semana selecionada em cima, em texto (pedido Jorge 2026-09-10: a mensagem
  // usa a semana escolhida, ninguém a escreve à mão).
  //   - `weekLabel`: a MESMA fórmula do email no servidor
  //     (`sendAvailabilityRequest`: "Segunda 14/09 a Domingo 20/09") — a
  //     pré-visualização diz exatamente o que o email vai dizer.
  //   - `weekShortLabel`: forma curta "14/09 a 20/09" para o {{semana}} do
  //     template WhatsApp ("semana de 14/09 a 20/09").
  // Sem overview ainda, cai no ISO da semana em vez de "a próxima semana".
  const weekHeaders = o?.dayHeaders ?? [];
  const weekLabel = weekHeaders.length
    ? `${weekHeaders[0].label} a ${weekHeaders[weekHeaders.length - 1].label}`
    : effectiveWeek;
  const weekShortLabel = weekHeaders.length
    ? `${ddmm(weekHeaders[0].day)} a ${ddmm(weekHeaders[weekHeaders.length - 1].day)}`
    : effectiveWeek;
  const msgParams = useMemo(() => ({
    kind: msgKind, dateLabel: msgDateLabel, shift: msgShift,
    fromHour: msgFrom, toHour: msgTo, note: note.trim() || null,
    weekLabel: weekLabel || undefined,
  }), [msgKind, msgDateLabel, msgShift, msgFrom, msgTo, note, weekLabel]);
  const msgPreview = useMemo(() => buildAvailabilityMessage(msgParams), [msgParams]);
  // Última vez que cada extra trabalhou (histórico Multipark/ponto/extras-dia)
  const lastWorked = trpc.rh.lastWorkedMap.useQuery();
  const trimmedSearch = search.trim();
  // Os TRÊS filtros COMPÕEM-SE (AND): cidade → disponibilidade → pesquisa; só
  // depois é que cada linha recebe o `lastWorked` (é coluna, não filtro). O
  // conjunto resultante é o que a tabela mostra E o alvo de "a todos" (email e
  // WhatsApp) — invariante "o que envio é o que vejo".
  const windowHoursActive = windowFrom != null && windowTo != null;
  const windowDayOnly = !windowHoursActive && windowDay !== "any";
  const windowFilterActive = windowHoursActive || windowDayOnly;
  const matchesWindow = useCallback(
    (e: { days: NonNullable<typeof o>["extras"][number]["days"] }) => {
      if (windowHoursActive) return matchesAvailabilityWindow(e.days, windowDay === "any" ? null : windowDay, windowFrom!, windowTo!);
      if (windowDayOnly) return isAvailableOnDay(e.days, windowDay);
      return true;
    },
    [windowHoursActive, windowDayOnly, windowDay, windowFrom, windowTo],
  );
  const shownExtras = useMemo(() => {
    if (!o) return [];
    let list = o.extras;
    if (cityFilter === "none") list = list.filter(e => e.city === null);
    else if (cityFilter !== "all") list = list.filter(e => e.city === cityFilter);
    if (statusFilter !== "all") list = list.filter(e => matchesAvailabilityStatus(e, statusFilter));
    if (onlyNotContacted24h) list = list.filter(e => !e.contactedWithin24h);
    if (windowFilterActive) list = list.filter(matchesWindow);
    if (trimmedSearch) list = list.filter(e => matchesExtraQuery(trimmedSearch, e));
    // Disponíveis → sem resposta → indisponíveis (a ordenação da tabela continua a mandar se a pessoa a escolher).
    let sorted = sortByAvailability(list);
    // 44a (Jorge: "começa sempre com o A e o B"): a pesquisar, quem começa pelo que se escreveu vem primeiro.
    if (trimmedSearch) {
      const score = (e: (typeof sorted)[number]) => nameMatchScore(trimmedSearch, e.fullName) || 1; // 0 = bateu pelo número
      sorted = sorted.map((e, i) => ({ e, i, s: score(e) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.e);
    }
    return sorted.map(e => ({ ...e, lastWorked: lastWorked.data?.[e.employeeId] ?? "" }));
  }, [o, cityFilter, statusFilter, onlyNotContacted24h, windowFilterActive, matchesWindow, trimmedSearch, lastWorked.data]);
  // Contagem do universo para o rótulo do filtro de horário (como os de cidade).
  const windowMatchCount = useMemo(
    () => (windowFilterActive ? (o?.extras ?? []).filter(matchesWindow).length : 0),
    [o, windowFilterActive, matchesWindow],
  );
  // Contagens do universo para os rótulos dos filtros (como os botões de cidade).
  const statusCounts = useMemo(() => countAvailabilityStatuses(o?.extras ?? []), [o]);
  const notContacted24hCount = useMemo(() => (o?.extras ?? []).filter(e => !e.contactedWithin24h).length, [o]);
  // A ordenação da tabela só REORDENA `shownExtras` (não filtra), por isso o
  // conjunto continua a ser o mesmo para a seleção, os totais e o alvo do envio.
  const availSort = useTableSort(shownExtras);
  const openEmployee = useOpenEmployee();

  // ── Secções por cidade (Jorge, set 2026: "aparece tudo de uma vez") ──
  // Agrupa a lista JÁ ordenada; secções fechadas por defeito menos a mais
  // relevante, e cada uma mostra 25 linhas de cada vez. Só muda o que se VÊ:
  // o conjunto filtrado (seleção "todos", totais e envio) é o mesmo.
  const groups = useMemo(() => groupByCity(availSort.sorted), [availSort.sorted]);
  const searching = trimmedSearch.length > 0;
  const [explicitOpen, setExplicitOpen] = useState<Set<CityGroupKey> | null>(null);
  const [shownPerGroup, setShownPerGroup] = useState<Partial<Record<CityGroupKey, number>>>({});
  // Mudar de filtro volta às secções por defeito e à 1ª "página" de cada uma.
  useEffect(() => {
    setExplicitOpen(null);
    setShownPerGroup({});
  }, [cityFilter, statusFilter, searching, effectiveWeek, windowDay, windowFrom, windowTo, onlyNotContacted24h]);
  const openGroups = useMemo(
    () => explicitOpen ?? defaultOpenGroups(groups, { preferred: cityFilter === "all" ? null : cityFilter, searching }),
    [explicitOpen, groups, cityFilter, searching],
  );
  const setOpenGroups = (next: Set<CityGroupKey>) => setExplicitOpen(next);
  function toggleGroup(key: CityGroupKey) {
    const next = new Set(openGroups);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExplicitOpen(next);
  }
  function showMore(key: CityGroupKey, by: number) {
    setShownPerGroup(prev => ({ ...prev, [key]: (prev[key] ?? AVAILABILITY_PAGE_SIZE) + by }));
  }
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
  const cityGroupLabel = (key: CityGroupKey) => (key === "none" ? "Sem cidade" : CITY_LABELS[key]);

  // ── Marcar disponibilidade POR um extra (backoffice, pedido Jorge 2026-09-10) ──
  // O diálogo edita a semana SELECIONADA em cima, com os mesmos campos que o
  // extra tem na página dele (`AvailabilityDayFields`). Estado inicial = o que
  // a overview já traz para essa pessoa; guardar substitui a semana inteira
  // (mesma semântica de `setMyWeek`) e refresca a tabela.
  type OverviewExtraRow = NonNullable<typeof o>["extras"][number];
  const [availEdit, setAvailEdit] = useState<null | {
    employeeId: number;
    fullName: string;
    days: AvailabilityDayState[];
  }>(null);
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
  function openAvailabilityEditor(ex: OverviewExtraRow) {
    // Sempre os 7 dias da semana visível, com o que a pessoa já tiver marcado.
    const days: AvailabilityDayState[] = (o?.dayHeaders ?? []).map((h) => {
      const d = ex.days.find((x) => x.day === h.day);
      return {
        day: h.day,
        label: h.label,
        morning: !!d?.morning,
        night: !!d?.night,
        fromHour: d?.fromHour ?? null,
        toHour: d?.toHour ?? null,
        note: d?.note ?? null,
      };
    });
    setAvailEdit({ employeeId: ex.employeeId, fullName: ex.fullName, days });
  }
  function patchAvailDay(day: string, patch: Partial<AvailabilityDayState>) {
    setAvailEdit((prev) =>
      prev ? { ...prev, days: prev.days.map((d) => (d.day === day ? { ...d, ...patch } : d)) } : prev,
    );
  }
  const availEditAnyMarked = !!availEdit?.days.some(isDayMarked);

  /**
   * Selecionados que a pesquisa atual esconde. A pesquisa é uma ferramenta de
   * PROCURA (procurar → marcar → procurar outro → marcar), por isso NÃO limpa a
   * seleção como o filtro de cidade faz; em troca, quem está marcado fora da
   * vista tem de estar à vista em número — senão o envio incluiria gente que a
   * tabela não mostra sem o dizer.
   */
  const hiddenSelectedCount = useMemo(() => {
    if (selectedIds.size === 0) return 0;
    const visible = new Set(shownExtras.map(e => e.employeeId));
    let count = 0;
    for (const id of selectedIds) if (!visible.has(id)) count++;
    return count;
  }, [selectedIds, shownExtras]);

  // Contagens do cabeçalho seguem o conjunto FILTRADO (as do servidor são
  // sempre o universo completo e mentiriam com um filtro aplicado).
  const shownResponded = shownExtras.filter(e => e.responded).length;
  const shownWithPhone = shownExtras.filter(e => !!e.phoneE164).length;
  // Totais por dia recalculados sobre o conjunto visível — os do servidor
  // contam o universo todo e deixariam de bater certo com a tabela filtrada.
  const perDayTotals = useCallback(
    (rows: typeof shownExtras) =>
      (o?.dayHeaders ?? []).map(h => {
        let morning = 0;
        let night = 0;
        for (const e of rows) {
          const d = e.days.find(x => x.day === h.day);
          if (d?.morning) morning++;
          if (d?.night) night++;
        }
        return { day: h.day, morning, night };
      }),
    [o],
  );
  const shownPerDay = useMemo(() => perDayTotals(shownExtras), [perDayTotals, shownExtras]);
  const cityCounts = useMemo(() => {
    const counts = { all: o?.extras.length ?? 0, none: 0 } as Record<string, number>;
    for (const key of CITY_KEYS) counts[key] = 0;
    for (const e of o?.extras ?? []) counts[e.city ?? "none"]++;
    return counts;
  }, [o]);

  // Mudar a cidade em cima também muda o alvo → limpa a seleção.
  useEffect(() => { setSelectedIds(new Set()); }, [globalCity]);
  /** Mudar de alvo limpa a seleção — nunca enviar a quem já não se vê. */
  function changeCityFilter(next: CityKey | "all" | "none") {
    setCityFilter(next);
    setSelectedIds(new Set());
  }
  // O filtro de horário também muda o alvo → mesma regra do de cidade.
  function changeWindowDay(next: string) {
    setWindowDay(next);
    setSelectedIds(new Set());
  }
  function changeWindowHour(which: "from" | "to", raw: string) {
    const n = raw === "" ? null : Number(raw);
    (which === "from" ? setWindowFrom : setWindowTo)(n);
    setSelectedIds(new Set());
  }
  function clearWindowFilter() {
    setWindowDay("any");
    setWindowFrom(null);
    setWindowTo(null);
    setSelectedIds(new Set());
  }

  // ── WhatsApp broadcast ────────────────────────────────────────────────────
  const [waOpen, setWaOpen] = useState(false);
  // Template escolhido no diálogo. Nome e língua são os aprovados na Meta —
  // vêm do catálogo (shared/whatsappTemplate.ts), nunca escritos à mão aqui.
  const [waTemplateId, setWaTemplateId] = useState<string>(DEFAULT_WHATSAPP_TEMPLATE_ID);
  const waTemplate = findWhatsAppTemplate(waTemplateId) ?? WHATSAPP_TEMPLATES[0];
  // Valor partilhado (semana ou dia, conforme o template) — guardado POR
  // template para não se perder ao espreitar o outro e voltar.
  const [waParams, setWaParams] = useState<Record<string, string>>({});
  // O campo "Semana" nasce preenchido com a semana selecionada em cima e
  // acompanha-a enquanto o utilizador não escrever nada; o que ele escrever
  // (ou colar via "Usar este texto no WhatsApp") manda. `undefined` = nunca
  // tocado → segue a seleção; string (mesmo vazia) = valor do utilizador.
  const waWeekDefault = waTemplate.sharedParam?.kind === "week" && weekShortLabel ? `semana de ${weekShortLabel}` : "";
  const waParam2IsDefault = waParams[waTemplate.id] === undefined && !!waWeekDefault;
  const waParam2 = waParams[waTemplate.id] ?? waWeekDefault;
  const setWaParam2 = (value: string) =>
    setWaParams(prev => ({ ...prev, [waTemplate.id]: value }));
  /**
   * "Usar este texto no WhatsApp" (seletor de tipo de pedido, acima): o texto
   * composto é um PEDIDO DE DISPONIBILIDADE, por isso seleciona esse template e
   * escreve no campo DELE — sem isto, com "Aviso de trabalho" escolhido, a frase
   * ia parar ao campo do dia.
   */
  const applyMessageTextToWhatsApp = (text: string) => {
    setWaTemplateId(DEFAULT_WHATSAPP_TEMPLATE_ID);
    setWaParams(prev => ({ ...prev, [DEFAULT_WHATSAPP_TEMPLATE_ID]: text }));
  };
  const [waTestPhone, setWaTestPhone] = useState("");
  type WaRecipient = {
    employeeId: number | null;
    name: string | null;
    phone: string;
    phoneE164: string | null;
    status: "sent" | "failed" | "invalid_phone" | "opted_out" | "duplicate_phone" | "recent_template";
    error?: string;
    city?: City;
  };
  const [waResult, setWaResult] = useState<
    null | { total: number; sent: number; failed: number; invalidPhone: number; optedOut: number; recentTemplate?: number; recipients: WaRecipient[] }
  >(null);
  // D32: enviar a várias pessoas passa por um passo "Confirmar".
  const [waConfirm, setWaConfirm] = useState(false);

  // Código único de cada envio (17b): carregar outra vez depois de um corte
  // (60 s da Vercel) retoma a mesma difusão — quem já recebeu não recebe 2×.
  const [waSendKey, setWaSendKey] = useState(() => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
  // Depois do envio real o botão fica "Enviado": um 2.º clique não manda outra vez a todos.
  const [waSentReal, setWaSentReal] = useState(false);
  const broadcast = trpc.whatsapp.sendBroadcast.useMutation({
    onSuccess: (r, v) => {
      setWaResult(r);
      if (!v.testPhone) setWaSentReal(true);
      toast.success(
        `WhatsApp: ${r.sent} enviados${r.failed ? `, ${r.failed} falhas` : ""}${r.invalidPhone ? `, ${r.invalidPhone} sem número` : ""}${r.optedOut ? `, ${r.optedOut} não querem mensagens` : ""}${r.recentTemplate ? `, ${r.recentTemplate} já o tinham recebido nas últimas 24 h` : ""}`,
      );
      overview.refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  // Alvo do broadcast = selecionados (se houver) ou todos os mostrados.
  // Com seleção, o alvo sai da lista COMPLETA e não da filtrada: quem foi
  // marcado e depois saiu da pesquisa continua a ser enviado (é o que
  // `submitBroadcast` manda), e as contagens do diálogo têm de dizer o mesmo.
  // `phoneE164` vem calculado do servidor — a MESMA normalização que o envio
  // usa, para o resumo "válidos/inválidos" nunca divergir do resultado real.
  const waTargets = selectedIds.size > 0
    ? (o?.extras ?? []).filter(e => selectedIds.has(e.employeeId))
    : shownExtras;
  const waValidCount = waTargets.filter(e => !!e.phoneE164).length;
  const waInvalidCount = waTargets.length - waValidCount;
  // Mudou o template, o campo ou o alvo → volta a pedir confirmação.
  useEffect(() => { setWaConfirm(false); }, [waTemplateId, waParam2, waValidCount]);

  // Cidade do template de cada destinatário (registo shared/driverTemplates.ts):
  // a do extra; sem ela, a do utilizador; senão fica por escolher. A
  // pré-visualização do texto REAL aprovado na Meta, por cidade, vive no painel.
  const waCityKey = waTargets.map(e => `${e.employeeId}:${e.city ?? ""}`).join(",");
  const waCityRecipients = useMemo<DriverCityRecipient[]>(
    () => waTargets.map(e => ({ id: e.employeeId, city: driverCityFrom(e.city), name: firstNameOf(e.fullName) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [waCityKey],
  );
  const waCity = useDriverCity({ templateId: waTemplate.id, open: waOpen, recipients: waCityRecipients });

  // Só falta o campo quando o template TEM campo — os sem parâmetros (ex.:
  // "Morada e regras") nunca preenchem `waParam2` e têm de poder ser enviados.
  const waMissingParam = !!waTemplate.sharedParam && !waParam2.trim();

  function submitBroadcast(testPhone?: string) {
    // Templates sem parâmetros (ex.: "Morada e regras") não têm campo a preencher.
    const bodyParam2 = waTemplate.sharedParam ? waParam2.trim() : "";
    if (waTemplate.sharedParam && !bodyParam2) {
      toast.error(`Preenche o campo “${waTemplate.sharedParam.label}”.`);
      return;
    }
    if (testPhone && !waCity.testCity) {
      toast.error("Escolhe a cidade do template a testar.");
      return;
    }
    if (!testPhone && waCity.blockReason) {
      toast.error(waCity.blockReason);
      return;
    }
    setWaResult(null);
    // Invariante mantida (Decisão 1 do Jorge): "a todos" = o conjunto MOSTRADO
    // na tabela (o que envio é o que vejo). O alvo é `waTargets`, já agrupado
    // por cidade no painel. Envio de teste ignora o alvo.
    broadcast.mutate({
      templateId: waTemplate.id,
      bodyParam2: bodyParam2 || null,
      // O botão com link do formulário é detetado pelos metadados do template
      // na Meta (server/whatsappTemplateMeta.ts), sem override manual na UI.
      cities: testPhone ? undefined : planEntries(waCity.plan).map(e => ({ employeeId: e.id, city: e.city })),
      testCity: testPhone ? waCity.testCity : undefined,
      weekStart: effectiveWeek || null,
      note: note.trim() || null,
      testPhone: testPhone ? testPhone.trim() : undefined,
      sendKey: testPhone ? undefined : waSendKey,
    });
  }

  type ShownExtra = (typeof shownExtras)[number];
  const renderExtraRow = (ex: ShownExtra) => (
    <tr key={ex.employeeId} className="border-b last:border-0">
      <td className="py-1 pr-1">
        <input
          type="checkbox"
          checked={selectedIds.has(ex.employeeId)}
          onChange={(e) => {
            setSelectedIds((prev) => {
              const next = new Set(prev);
              if (e.target.checked) next.add(ex.employeeId);
              else next.delete(ex.employeeId);
              return next;
            });
          }}
        />
      </td>
      <td className="py-1 pr-2 whitespace-nowrap">
        <span className="flex items-center gap-1">
          {ex.responded
            ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
            : <span className="h-3.5 w-3.5 inline-block rounded-full border border-muted-foreground/30" />}
          <button
            type="button"
            className="hover:underline text-left"
            title="Abrir ficha do funcionário"
            onClick={() => openEmployee(ex.employeeId)}
          >
            {ex.fullName}
          </button>
          {(ex.noAutoWhatsapp || ex.noAutoEmail) && (
            <span
              className="inline-flex items-center gap-0.5 rounded border px-1 text-[10px] text-amber-700 dark:text-amber-400"
              title={`Ficha com "${contactPrefsLabel(ex) ?? ""}": não recebe pedidos nem avisos por ${ex.noAutoWhatsapp && ex.noAutoEmail ? "WhatsApp nem email" : ex.noAutoWhatsapp ? "WhatsApp" : "email"}.`}
            >
              <BellOff className="h-3 w-3" />{ex.noAutoWhatsapp && ex.noAutoEmail ? "nada" : ex.noAutoWhatsapp ? "sem WA" : "sem email"}
            </span>
          )}
          <button
            type="button"
            className="text-muted-foreground/60 hover:text-foreground"
            title="Marcar a disponibilidade desta semana por este extra"
            aria-label={`Marcar disponibilidade de ${ex.fullName}`}
            onClick={() => openAvailabilityEditor(ex)}
          >
            <Pencil className="h-3 w-3" />
          </button>
        </span>
      </td>
      <td className="py-1 pr-2 whitespace-nowrap text-xs text-muted-foreground">
        {(ex as any).lastWorked ? fmtPTDate((ex as any).lastWorked) : "nunca"}
      </td>
      <td className="py-1 pr-2 whitespace-nowrap text-xs">
        {ex.city ? (
          <span
            className="text-muted-foreground"
            title={ex.citySource ? `Cidade obtida da ${CITY_SOURCE_LABELS[ex.citySource]}` : undefined}
          >
            {CITY_LABELS[ex.city]}
          </span>
        ) : (
          <span className="text-muted-foreground/40" title="Sem projeto, candidatura ou morada que identifique a cidade">
            —
          </span>
        )}
      </td>
      <td className="py-1 pr-2 whitespace-nowrap text-xs">
        {ex.phoneE164 ? (
          <span className="text-muted-foreground" title={ex.phone ?? undefined}>{ex.phoneE164}</span>
        ) : (
          <Badge
            variant="outline"
            className="border-amber-400 text-amber-700 gap-1 font-normal"
            title={ex.phone ? `Número não reconhecido: ${ex.phone}` : "Ficha sem telefone"}
          >
            <AlertTriangle className="h-3 w-3" /> {ex.phone ? "número não reconhecido" : "sem número"}
          </Badge>
        )}
      </td>
      {ex.days.map((d) => (
        <td key={d.day} className="px-1 text-center align-top">
          {/* A célula é um botão: clicar num dia abre o editor
              da semana desta pessoa (o lápis ao lado do nome
              faz o mesmo). */}
          <button
            type="button"
            className="w-full min-h-6 rounded px-0.5 hover:bg-muted/60"
            title={d.note ? `${d.note} — clicar para editar` : "Editar disponibilidade"}
            onClick={() => openAvailabilityEditor(ex)}
          >
            {(d.morning || d.night || d.fromHour != null || d.toHour != null) ? (() => {
              // Pedido 7: com horas, mostram-se as horas reais (o slot do site "18H-01H"
              // aparecia com a lua de "Noite 15h–03h" e parecia cobrir até às 03h).
              const cell = availabilityCellDisplay(d);
              return (
                <span className="inline-flex flex-col items-center leading-tight">
                  <span className="inline-flex gap-0.5 justify-center items-center">
                    {cell.morning && <Sun className="h-3.5 w-3.5 text-amber-500" />}
                    {cell.night && <Moon className="h-3.5 w-3.5 text-indigo-500" />}
                    {d.note && <span className="text-muted-foreground text-xs" aria-label="tem nota">✱</span>}
                  </span>
                  {cell.hours && (
                    <span className="text-[11px] text-muted-foreground whitespace-nowrap">{cell.hours}</span>
                  )}
                </span>
              );
            })() : (
              <span className="text-muted-foreground/50" aria-hidden>·</span>
            )}
          </button>
        </td>
      ))}
    </tr>
  );

  return (
    <Card className="border-blue-200">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Mail className="h-4 w-4 text-blue-600" />
          Disponibilidade dos extras
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-end gap-3 flex-wrap">
          <div className="space-y-1">
            <Label className="text-xs">Semana</Label>
            <UniDateNav date={effectiveWeek} defaultGran="week" onChange={(d) => setWeekStart(mondayOf(new Date(d + "T00:00:00")))} />
          </div>
          {hints.data && (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setWeekStart(hints.data!.next)}>
                Próxima semana
              </Button>
            </div>
          )}
        </div>

        {/* Mensagem + teste: fechado por defeito (a página não abre com
            tudo à vista). O texto escolhido vale mesmo com o painel fechado. */}
        <div className="rounded-md border">
          <button
            type="button"
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left"
            onClick={() => setShowCompose((v) => !v)}
            aria-expanded={showCompose}
          >
            {showCompose ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <span className="font-medium shrink-0">Mensagem e envio de teste</span>
            <span className="text-xs text-muted-foreground truncate min-w-0" title={AVAILABILITY_KINDS.find((k) => k.id === msgKind)?.label ?? msgKind}>
              · {AVAILABILITY_KINDS.find((k) => k.id === msgKind)?.label ?? msgKind}{note.trim() ? " · com nota" : ""}
            </span>
          </button>
          {showCompose && (
            <div className="px-3 pb-3 space-y-4">
              <div className="space-y-1">
                <Label className="text-xs">Mensagem opcional no email</Label>
                <Input
                  placeholder="Ex: Reforço para o fim de semana do festival..."
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />

                {/* Tipo de pedido (templates) + pré-visualização */}
                <div className="w-full space-y-2 border rounded-lg p-3 bg-muted/20">
                  <div className="flex flex-wrap items-end gap-2">
                    <div>
                      <Label className="text-xs mb-1 block">Tipo de pedido</Label>
                      <Select value={msgKind} onValueChange={(v) => setMsgKind(v as AvailabilityMessageKind)}>
                        <SelectTrigger className="w-full sm:w-72 h-9"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {AVAILABILITY_KINDS.map((k) => <SelectItem key={k.id} value={k.id}>{k.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    {msgKind !== "week" && (
                      <div>
                        <Label className="text-xs mb-1 block">Dia</Label>
                        <Input type="date" value={msgDate} onChange={(e) => setMsgDate(e.target.value)} className="w-40 h-9" />
                      </div>
                    )}
                    {msgKind === "day_shift" && (
                      <div>
                        <Label className="text-xs mb-1 block">Turno</Label>
                        <Select value={msgShift} onValueChange={(v) => setMsgShift(v as any)}>
                          <SelectTrigger className="w-32 h-9"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="morning">Manhã</SelectItem>
                            <SelectItem value="afternoon">Tarde</SelectItem>
                            <SelectItem value="night">Noite</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {msgKind === "day_range" && (
                      <>
                        <div><Label className="text-xs mb-1 block">Das</Label><Input type="number" min={0} max={23} value={msgFrom} onChange={(e) => setMsgFrom(parseInt(e.target.value) || 0)} className="w-20 h-9" /></div>
                        <div><Label className="text-xs mb-1 block">Às</Label><Input type="number" min={0} max={27} value={msgTo} onChange={(e) => setMsgTo(parseInt(e.target.value) || 0)} className="w-20 h-9" /></div>
                      </>
                    )}
                  </div>
                  <div className="text-xs bg-background border rounded p-2">
                    <p className="font-semibold">{msgPreview.subject}</p>
                    <p className="text-muted-foreground mt-0.5">{msgPreview.lines.join(" ")} <span className="text-primary font-medium">{msgPreview.cta} [link]</span></p>
                    <button
                      type="button"
                      className="text-[11px] text-blue-600 hover:underline mt-1"
                      onClick={() => applyMessageTextToWhatsApp(msgPreview.text)}
                    >
                      Usar este texto no WhatsApp ({"{"}{"{"}2{"}"}{"}"})
                    </button>
                  </div>
                </div>
              </div>

              {/* Teste: enviar só para um endereço (não toca nos extras) */}
              <div className="rounded-md border border-dashed p-3 space-y-2">
                <Label className="text-xs font-medium">Testar primeiro (envia só para 1 email)</Label>
                <div className="flex gap-2 flex-wrap">
                  <Input
                    type="email"
                    placeholder="o-teu-email@multipark.pt"
                    className="w-full sm:w-64"
                    value={testEmail}
                    onChange={(e) => setTestEmail(e.target.value)}
                  />
                  <Button
                    variant="outline"
                    disabled={!effectiveWeek || !testEmail.includes("@") || send.isPending}
                    onClick={() => send.mutate({
                      weekStart: effectiveWeek,
                      origin: window.location.origin,
                      note: note.trim() || null,
                      testEmail: testEmail.trim(),
                      message: msgInput,
                    })}
                  >
                    <Send className="h-4 w-4 mr-2" /> Enviar teste
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Envio real: a todos OU só aos selecionados na tabela abaixo */}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!effectiveWeek || send.isPending || shownExtras.length === 0}
            onClick={() => {
              // "A todos" = o conjunto VISÍVEL (mesma invariante do WhatsApp).
              // Manda-se sempre a lista explícita: com um filtro de cidade
              // aplicado, deixar o servidor decidir "todos" enviaria a gente
              // que não está na tabela.
              const ids = selectedIds.size > 0 ? Array.from(selectedIds) : shownExtras.map(e => e.employeeId);
              const alvo = selectedIds.size > 0
                ? `aos ${ids.length} extras selecionados`
                : `aos ${ids.length} extras filtrados na tabela`;
              if (!confirm(`Enviar pedido de disponibilidade ${alvo} para a semana de ${effectiveWeek}?`)) return;
              send.mutate({
                weekStart: effectiveWeek,
                origin: window.location.origin,
                note: note.trim() || null,
                employeeIds: ids,
                message: msgInput,
              });
            }}
          >
            {send.isPending ? <Clock className="h-4 w-4 mr-2 animate-spin" /> : <Mail className="h-4 w-4 mr-2" />}
            {selectedIds.size > 0 ? `Email aos ${selectedIds.size} selecionados` : `Email aos ${shownExtras.length} filtrados`}
          </Button>

          {/* WhatsApp: abre um dialog dedicado (template + teste + resultado) */}
          <Button
            variant="outline"
            className="border-green-600 text-green-700 hover:bg-green-50 dark:hover:bg-green-950"
            onClick={() => { setWaResult(null); setWaSentReal(false); setWaConfirm(false); setWaSendKey(globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`); setWaOpen(true); }}
          >
            <MessageCircle className="h-4 w-4 mr-2" />
            {selectedIds.size > 0 ? `WhatsApp aos ${selectedIds.size} selecionados` : `WhatsApp aos ${shownExtras.length} filtrados`}
          </Button>
        </div>

        {o && (
          <div className="space-y-3 pt-2">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-sm text-muted-foreground">
                {shownExtras.length}
                {shownExtras.length !== o.totalExtras ? ` de ${o.totalExtras}` : ""} extras ativos ·{" "}
                {shownResponded} responderam para {o.weekStart} – {o.weekEnd} ·{" "}
                <span className={shownWithPhone === 0 ? "text-amber-700" : undefined}>
                  {shownWithPhone} com número válido
                </span>
              </div>
              <div className="flex items-center gap-4 flex-wrap">
                {/* Estado da resposta — compõe em AND com os restantes e limpa a
                    seleção (o alvo mudou — não enviar a quem já não se vê). */}
                <Select
                  value={statusFilter}
                  onValueChange={(v) => { setStatusFilter(v as AvailabilityStatusFilter); setSelectedIds(new Set()); }}
                >
                  <SelectTrigger className="h-8 w-48 text-xs" aria-label="Estado da resposta">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos os estados ({statusCounts.all})</SelectItem>
                    {(["available", "unavailable", "no_answer"] as const).map((k) => (
                      <SelectItem key={k} value={k}>{AVAILABILITY_STATUS_LABELS[k]} ({statusCounts[k]})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <label
                  className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer"
                  title="Sem WhatsApp nem email enviados por nós nas últimas 24 horas"
                >
                  <input
                    type="checkbox"
                    checked={onlyNotContacted24h}
                    onChange={(e) => { setOnlyNotContacted24h(e.target.checked); setSelectedIds(new Set()); }}
                  />
                  Sem mensagem nas últimas 24h <span className="text-muted-foreground">({notContacted24hCount})</span>
                </label>
              </div>
            </div>

            {/* Pesquisa por pessoa — compõe-se (AND) com o filtro de cidade e
                com o de disponibilidade. Filtro local, sem pedido ao servidor. */}
            <div className="space-y-1">
              <div className="relative max-w-sm">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input
                  type="text"
                  placeholder="Pesquisar pessoa por nome ou número…"
                  aria-label="Pesquisar extras por nome ou número"
                  className="h-9 pl-8 pr-8"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {trimmedSearch.length > 0 && (
                  <button
                    type="button"
                    aria-label="Limpar pesquisa"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setSearch("")}
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              {hiddenSelectedCount > 0 && (
                <p className="text-xs text-amber-700">
                  {hiddenSelectedCount} selecionado(s) fora dos filtros atuais — continuam incluídos no envio.
                </p>
              )}
            </div>

            {/* Filtro por cidade. A cidade é DERIVADA (projeto → candidatura →
                morada); "sem cidade" é um estado real e filtrável, não um erro. */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
              {(globalCity
                ? [{ key: globalCity, label: CITY_LABELS[globalCity] }]
                : [
                    { key: "all" as const, label: "Todas" },
                    ...CITY_KEYS.map(k => ({ key: k, label: CITY_LABELS[k] })),
                    { key: "none" as const, label: "Sem cidade" },
                  ]).map(({ key, label }) => (
                <Button
                  key={key}
                  size="sm"
                  variant={cityFilter === key ? "selected" : "outline"}
                  className="h-7 text-xs"
                  onClick={() => changeCityFilter(key)}
                >
                  {label}
                  <span className="ml-1 opacity-90 tabular-nums">{cityCounts[key] ?? 0}</span>
                </Button>
              ))}
            </div>

            {/* Filtro "disponível das X às Y" — dia opcional. Compõe em AND com
                os restantes e limpa a seleção (o alvo mudou). Conta quem tem
                disponibilidade em algum momento da janela (regra em
                shared/availabilityWindow.ts). */}
            <div className="flex items-center gap-2 flex-wrap">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Disponível</span>
              <Select value={windowDay} onValueChange={changeWindowDay}>
                <SelectTrigger className="h-7 w-48 text-xs" aria-label="Dia da semana">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Qualquer dia da semana</SelectItem>
                  {o.dayHeaders.map((h) => (
                    <SelectItem key={h.day} value={h.day}>{h.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">das</span>
              <Select value={windowFrom == null ? "" : String(windowFrom)} onValueChange={(v) => changeWindowHour("from", v)}>
                <SelectTrigger className="h-7 w-20 text-xs" aria-label="Hora de início">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  {HOUR_OPTIONS.map((h) => (
                    <SelectItem key={h} value={String(h)}>{String(h).padStart(2, "0")}h</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">às</span>
              <Select value={windowTo == null ? "" : String(windowTo)} onValueChange={(v) => changeWindowHour("to", v)}>
                <SelectTrigger className="h-7 w-20 text-xs" aria-label="Hora de fim">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  {HOUR_OPTIONS.map((h) => (
                    <SelectItem key={h} value={String(h)}>{String(h).padStart(2, "0")}h</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {windowFilterActive ? (
                <span className="text-xs text-muted-foreground">
                  {windowHoursActive ? formatHourWindow(windowFrom!, windowTo!) : "qualquer hora"} ·{" "}
                  <span className={windowMatchCount === 0 ? "text-amber-700" : "text-foreground font-medium"}>
                    {windowMatchCount} {windowMatchCount === 1 ? "disponível" : "disponíveis"}
                  </span>
                </span>
              ) : (windowFrom != null || windowTo != null) ? (
                <span className="text-xs text-muted-foreground">escolhe as duas horas para filtrar</span>
              ) : null}
              {(windowFilterActive || windowFrom != null || windowTo != null) && (
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={clearWindowFilter}>
                  <X className="h-3.5 w-3.5 mr-1" /> Limpar
                </Button>
              )}
            </div>

            {/* Seleção de todos os FILTRADOS (inclui secções fechadas e linhas
                ainda por mostrar — é o mesmo conjunto do envio "a todos"). */}
            <div className="flex items-center justify-between gap-2 flex-wrap text-xs">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={shownExtras.length > 0 && shownExtras.every(x => selectedIds.has(x.employeeId))}
                  onChange={(e) => toggleMany(shownExtras, e.target.checked)}
                />
                Selecionar todos os {shownExtras.length} filtrados
              </label>
              {groups.length > 1 && (
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setOpenGroups(new Set(groups.map(g => g.key)))}>
                    Abrir todas
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setOpenGroups(new Set())}>
                    Fechar todas
                  </Button>
                </div>
              )}
            </div>

            {/* Totais por dia de TODO o conjunto filtrado (as secções abaixo
                trazem os seus). Só faz falta com mais de uma secção. */}
            {groups.length > 1 && (
              <div className="overflow-x-auto rounded-md border bg-muted/20">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="py-1 px-2 text-left font-medium whitespace-nowrap">Disponíveis (todos os filtrados)</th>
                      {o.dayHeaders.map((h) => (
                        <th key={h.day} className="px-1 text-center font-normal whitespace-nowrap">{h.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="font-medium">
                      <td className="py-1 px-2" />
                      {shownPerDay.map((p) => (
                        <td key={p.day} className="px-1 text-center">
                          <span className="text-amber-700">{p.morning}</span>
                          {" / "}
                          <span className="text-indigo-600">{p.night}</span>
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            {shownExtras.length === 0 && (
              <div className="py-6 text-center text-sm text-muted-foreground border rounded-md">
                {trimmedSearch
                  ? `Sem resultados para “${trimmedSearch}”.`
                  : windowFilterActive
                    ? windowHoursActive
                      ? `Ninguém disponível das ${formatHourWindow(windowFrom!, windowTo!)}${windowDay !== "any" ? " nesse dia" : " em nenhum dia da semana"}.`
                      : "Ninguém marcou disponibilidade nesse dia."
                    : cityFilter !== "all"
                      ? "Nenhum extra neste filtro de cidade."
                      : statusFilter !== "all"
                        ? `Nenhum extra com o estado “${AVAILABILITY_STATUS_LABELS[statusFilter]}” nesta semana.`
                        : "Não há extras ativos (RH → colaboradores com função “extra”)."}
              </div>
            )}

            {/* Secções por cidade — fechadas por defeito, menos a mais
                relevante; cada uma mostra 25 de cada vez ("Mostrar mais"). */}
            <div className="space-y-2">
              {groups.map((g) => {
                const open = openGroups.has(g.key);
                const { visible, remaining } = visibleSlice(g.rows, shownPerGroup[g.key] ?? AVAILABILITY_PAGE_SIZE);
                const groupCounts = countAvailabilityStatuses(g.rows);
                const groupPerDay = perDayTotals(g.rows);
                const allInGroup = g.rows.every(x => selectedIds.has(x.employeeId));
                const selectedInGroup = g.rows.filter(x => selectedIds.has(x.employeeId)).length;
                return (
                  <div key={g.key} className="rounded-md border">
                    <div className="flex items-center gap-2 px-2 py-2 bg-muted/30">
                      <input
                        type="checkbox"
                        aria-label={`Selecionar todos de ${cityGroupLabel(g.key)}`}
                        title="Selecionar todos desta secção"
                        checked={g.rows.length > 0 && allInGroup}
                        onChange={(e) => toggleMany(g.rows, e.target.checked)}
                      />
                      <button
                        type="button"
                        className="flex-1 flex items-center gap-2 text-left min-w-0"
                        onClick={() => toggleGroup(g.key)}
                        aria-expanded={open}
                      >
                        {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                        <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="font-medium text-sm">{cityGroupLabel(g.key)}</span>
                        <span className="text-xs text-muted-foreground">{g.rows.length}</span>
                        <span className="text-[11px] text-muted-foreground truncate hidden sm:inline">
                          · <span className="text-green-700">{groupCounts.available} disp.</span>
                          {" · "}{groupCounts.unavailable} indisp.
                          {" · "}{groupCounts.no_answer} sem resposta
                        </span>
                        {selectedInGroup > 0 && (
                          <Badge variant="secondary" className="h-5 px-1.5 text-[11px] ml-auto shrink-0">{selectedInGroup} selec.</Badge>
                        )}
                      </button>
                    </div>
                    {open && (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm border-collapse">
                          <thead>
                            <tr className="text-left text-xs text-muted-foreground border-b">
                              <th className="py-1 px-1 w-6" />
                              <Th k="fullName" label="Extra" sortKey={availSort.sortKey} sortDir={availSort.sortDir} onToggle={availSort.toggle} />
                              <Th k="lastWorked" label="Últ. trabalho" sortKey={availSort.sortKey} sortDir={availSort.sortDir} onToggle={availSort.toggle} />
                              <Th k="city" label="Cidade" sortKey={availSort.sortKey} sortDir={availSort.sortDir} onToggle={availSort.toggle} />
                              <Th k="phoneE164" label="Telefone" sortKey={availSort.sortKey} sortDir={availSort.sortDir} onToggle={availSort.toggle} />
                              {o.dayHeaders.map((h) => (
                                <th key={h.day} className="px-1 text-center whitespace-nowrap">{h.label}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {/* 44a: na ordem por omissão, um separador por estado — senão o alfabeto
                                recomeçava 3 vezes sem se perceber porquê. */}
                            {visible.map((ex, i) => {
                              const st = availabilityStatus(ex);
                              const divider = !availSort.sortKey && !searching && (i === 0 || availabilityStatus(visible[i - 1]) !== st);
                              return (
                                <Fragment key={ex.employeeId}>
                                  {divider && (
                                    <tr className="bg-muted/40">
                                      <td colSpan={5 + o.dayHeaders.length} className="py-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                        {AVAILABILITY_STATUS_LABELS[st]} · {groupCounts[st]}
                                      </td>
                                    </tr>
                                  )}
                                  {renderExtraRow(ex)}
                                </Fragment>
                              );
                            })}
                            {/* Totais por dia desta secção — 5 células fixas antes
                                dos dias (seleção, Extra, Últ. trabalho, Cidade,
                                Telefone), senão ficam desalinhados. */}
                            <tr className="font-medium border-t-2">
                              <td className="py-1 px-1" />
                              <td className="py-1 pr-2 text-xs">Disponíveis</td>
                              <td className="py-1 pr-2" />
                              <td className="py-1 pr-2" />
                              <td className="py-1 pr-2" />
                              {groupPerDay.map((p) => (
                                <td key={p.day} className="px-1 text-center text-xs">
                                  <span className="text-amber-700">{p.morning}</span>
                                  {" / "}
                                  <span className="text-indigo-600">{p.night}</span>
                                </td>
                              ))}
                            </tr>
                          </tbody>
                        </table>
                        {remaining > 0 && (
                          <div className="flex items-center justify-center gap-2 py-2 border-t">
                            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => showMore(g.key, AVAILABILITY_PAGE_SIZE)}>
                              Mostrar mais {Math.min(AVAILABILITY_PAGE_SIZE, remaining)}
                            </Button>
                            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => showMore(g.key, remaining)}>
                              Mostrar todos ({g.rows.length})
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="text-xs text-muted-foreground">
              <Sun className="h-3 w-3 inline text-amber-500" /> manhã · <Moon className="h-3 w-3 inline text-indigo-500" /> noite · horas = janela exata indicada pela pessoa (manda sobre os turnos; "00h–03h" é a madrugada desse dia, ou seja a noite do dia anterior) · ✱ tem nota (passa o rato por cima) · totais = nº disponíveis por turno
            </div>
          </div>
        )}

        {/* ── Dialog: marcar disponibilidade POR um extra ─────────────────── */}
        <Dialog
          open={availEdit != null}
          onOpenChange={(open) => { if (!open && !setForEmployee.isPending) setAvailEdit(null); }}
        >
          <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CalendarDays className="h-5 w-5 text-primary" />
                Disponibilidade de {availEdit?.fullName}
              </DialogTitle>
              <DialogDescription>
                Semana de {weekShortLabel}. Substitui o que estiver marcado para esta semana e passa a contar
                como resposta na tabela.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2">
              {availEdit?.days.map((d) => (
                <div
                  key={d.day}
                  className={`rounded-md border p-2 space-y-1 ${isDayMarked(d) ? "border-primary/50 bg-primary/5" : ""}`}
                >
                  <div className="text-sm font-medium">{d.label}</div>
                  <AvailabilityDayFields
                    day={d}
                    compact
                    disabled={setForEmployee.isPending}
                    onChange={(patch) => patchAvailDay(d.day, patch)}
                  />
                </div>
              ))}
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => setAvailEdit(null)} disabled={setForEmployee.isPending}>
                Cancelar
              </Button>
              <Button
                disabled={!availEdit || !effectiveWeek || setForEmployee.isPending}
                onClick={() =>
                  availEdit &&
                  setForEmployee.mutate({
                    employeeId: availEdit.employeeId,
                    weekStart: effectiveWeek,
                    days: availEdit.days.map((d) => ({
                      day: d.day,
                      morning: d.morning,
                      night: d.night,
                      fromHour: d.fromHour,
                      toHour: d.toHour,
                      note: d.note,
                    })),
                  })
                }
              >
                {setForEmployee.isPending ? <Clock className="h-4 w-4 mr-2 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
                {availEditAnyMarked ? "Guardar disponibilidade" : "Guardar (sem disponibilidade)"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* ── Dialog do broadcast WhatsApp ─────────────────────────────────── */}
        <Dialog open={waOpen} onOpenChange={(open) => { if (!broadcast.isPending) setWaOpen(open); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <MessageCircle className="h-5 w-5 text-green-600" />
                Enviar WhatsApp
              </DialogTitle>
              <DialogDescription>
                {selectedIds.size > 0
                  ? `${selectedIds.size} extra(s) selecionado(s)`
                  : `Todos os ${shownExtras.length} extras filtrados`}
                {waInvalidCount > 0 ? ` · ${waInvalidCount} sem número válido` : ""}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {/* Que mensagem enviar. Os templates vêm do catálogo partilhado;
                  cada um traz o nome/língua aprovados e o rótulo do seu campo. */}
              <div className="space-y-1">
                <Label className="text-xs">Mensagem</Label>
                <Select
                  value={waTemplate.id}
                  onValueChange={(id) => { setWaTemplateId(id); setWaResult(null); }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WHATSAPP_TEMPLATES.map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{waTemplate.description}</p>
              </div>

              {/* Templates sem parâmetros não têm campo — o texto é fixo na Meta. */}
              {waTemplate.sharedParam && (
              <div className="space-y-1">
                <Label className="text-xs">{waTemplate.sharedParam.label}</Label>
                <Input
                  autoFocus
                  placeholder={waTemplate.sharedParam.placeholder}
                  value={waParam2}
                  onChange={(e) => setWaParam2(e.target.value)}
                />
                {waParam2IsDefault && (
                  <p className="text-[11px] text-muted-foreground">
                    Preenchido com a semana selecionada em cima — podes editar.
                  </p>
                )}
                {/* Preenchimento rápido pelos dias da semana visível na tabela
                    (mesmo padrão dos botões "Esta semana"/"Próxima semana"). */}
                {waTemplate.sharedParam.kind === "day" && !!o?.dayHeaders.length && (
                  <div className="flex flex-wrap gap-1 pt-1">
                    {o.dayHeaders.map((h) => (
                      <Button
                        key={h.day}
                        type="button"
                        size="sm"
                        variant={waParam2 === h.label ? "selected" : "outline"}
                        className="h-7 text-xs"
                        onClick={() => setWaParam2(h.label)}
                      >
                        {h.label}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
              )}

              {/* Cidade do template (por defeito a de cada extra), contagens por
                  cidade e o texto REAL aprovado na Meta de cada cidade, já com o
                  nome do 1.º destinatário e o campo acima substituídos. */}
              <DriverCityPanel state={waCity} sharedValue={waParam2} noun="motorista(s)" />

              <div className="space-y-1">
                <Label className="text-xs">Número de teste</Label>
                <div className="flex gap-2">
                  <Input
                    placeholder="+351912345678"
                    value={waTestPhone}
                    onChange={(e) => setWaTestPhone(e.target.value)}
                  />
                  <Button
                    variant="outline"
                    className="shrink-0"
                    disabled={waMissingParam || !waTestPhone.trim() || !waCity.testCity || broadcast.isPending}
                    onClick={() => submitBroadcast(waTestPhone)}
                  >
                    {broadcast.isPending ? <Clock className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
                    Enviar teste{waCity.testCity ? ` (${driverCityLabel(waCity.testCity)})` : ""}
                  </Button>
                </div>
              </div>

              {/* Resultado por destinatário (só depois de enviar) */}
              {waResult && (
                <div className="rounded-md border p-3 space-y-2">
                  <div className="text-sm font-medium">
                    {waResult.sent} enviados · {waResult.failed} falhas · {waResult.invalidPhone} sem número
                    {waResult.optedOut ? ` · ${waResult.optedOut} não querem mensagens` : ""}
                    {waResult.recentTemplate ? ` · ${waResult.recentTemplate} já o tinham recebido nas últimas 24 h` : ""}
                  </div>
                  <div className="max-h-48 overflow-y-auto text-xs divide-y">
                    {waResult.recipients.map((r, i) => (
                      <div key={i} className="flex items-center gap-2 py-1">
                        {r.status === "sent" && <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />}
                        {r.status === "failed" && <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />}
                        {(r.status === "invalid_phone" || r.status === "opted_out" || r.status === "duplicate_phone" || r.status === "recent_template") && (
                          <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                        )}
                        <span className="flex-1 truncate">
                          {r.name || r.phone}
                          {r.phoneE164 ? <span className="text-muted-foreground"> · {r.phoneE164}</span> : null}
                          {r.city ? <span className="text-muted-foreground"> · {driverCityLabel(r.city)}</span> : null}
                        </span>
                        {r.error && <span className="text-red-500 truncate max-w-[45%]">{r.error}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {waConfirm && !waSentReal && (
              <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
                {broadcastConfirmText(waTemplate.label, waValidCount)}
              </div>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={() => (waConfirm ? setWaConfirm(false) : setWaOpen(false))} disabled={broadcast.isPending}>
                {waConfirm && !waSentReal ? "Voltar" : "Fechar"}
              </Button>
              <Button
                className="bg-green-700 hover:bg-green-800 text-white"
                disabled={waMissingParam || broadcast.isPending || waValidCount === 0 || waSentReal || !!waCity.blockReason}
                onClick={() => {
                  // D32: a várias pessoas, primeiro "Confirmar".
                  if (!waConfirm && needsBroadcastConfirm(waValidCount)) { setWaConfirm(true); return; }
                  setWaConfirm(false);
                  submitBroadcast();
                }}
                title={waSentReal ? "Já enviado — fecha e abre o diálogo para um envio novo" : undefined}
              >
                {broadcast.isPending ? <Clock className="h-4 w-4 mr-2 animate-spin" /> : <MessageCircle className="h-4 w-4 mr-2" />}
                {waSentReal ? "Enviado" : waConfirm ? `Confirmar envio a ${waValidCount}` : `Enviar a ${waValidCount} extra(s)`}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
