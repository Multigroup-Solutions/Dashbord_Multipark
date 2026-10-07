import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import BookingDetailDialog from "@/components/BookingDetailDialog";
import { fmtPTTime } from "@/lib/lisbonTime";
import { addDays, lisbonDayOf } from "@shared/lisbonDay";
import {
  BOOKING_STATUSES, BOOKING_STATUS_COLORS, compareGroups, DAY_BUCKET_LABELS, DAY_BUCKETS, filterMovements, groupMovements, phaseLabel, statusLabel, summarizeByCity, summarizeDay,
  type BookingStatus, type CityDay, type DayMovement, type MovementKind,
} from "@shared/reservasDoDia";
import { ORIGIN_LABELS } from "@shared/multiparkParks";
import type { CityKey } from "@shared/city";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import {
  ArrowDownToLine, ArrowUpFromLine, CalendarDays, ChevronLeft, ChevronRight, Plane, RefreshCw, Search, XCircle, AlertTriangle,
} from "lucide-react";

const fmtEur = (v: number | null | undefined) =>
  v == null ? "—" : v.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });

const todayLisbon = () => lisbonDayOf(Date.now());

/** "domingo, 27 de setembro de 2026" (o dia é de calendário: meio-dia UTC não muda de data). */
function longDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("pt-PT", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** Pesquisa global / links antigos: `?de=AAAA-MM-DD&q=…&tab=entradas|saidas`. */
function seedFromUrl(): { day: string | null; q: string; kind: "todas" | MovementKind } {
  try {
    const p = new URLSearchParams(window.location.search);
    const de = p.get("de");
    const tab = p.get("tab");
    return {
      day: de && /^\d{4}-\d{2}-\d{2}$/.test(de) ? de : null,
      q: (p.get("q") ?? "").slice(0, 100),
      kind: tab === "entradas" ? "entrada" : tab === "saidas" ? "saida" : "todas",
    };
  } catch {
    return { day: null, q: "", kind: "todas" };
  }
}

/**
 * "Reservas do dia": as entradas e saídas de UM dia (Lisboa), lidas ao vivo da
 * BD da Multipark. Abre sempre em hoje; os filtros correm aqui (o dia já está
 * todo carregado). Só operação: um bloco por parque (as marcas nossas por
 * marca + cidade primeiro), sem o canal da contabilidade.
 *
 * 42d (Jorge, 7 out 2026): por CIDADE (Lisboa, Porto, Faro), com as 24 horas
 * — o que entra e o que sai em cada uma (carrega numa hora para ver só essa) —
 * e por marca, com o Marketplace à parte: os parques que não são nossos
 * (Travelparking, Boardingpark…) e as reservas das nossas marcas que vieram
 * pelo Marketplace. A cidade e a marca do topo também filtram.
 */
export default function ReservasDoDia() {
  const [seed] = useState(seedFromUrl);
  const [day, setDay] = useState<string>(seed.day ?? todayLisbon());
  const [kind, setKind] = useState<"todas" | MovementKind>(seed.kind);
  const [parkId, setParkId] = useState<string>("");
  const [state, setState] = useState<string>("ativas");
  const [search, setSearch] = useState(seed.q);
  const [open, setOpen] = useState<DayMovement | null>(null);
  const [city, setCity] = useState<CityKey | "">("");
  const [hour, setHour] = useState<number | null>(null);
  const { projectId } = useGlobalFilters();

  const isToday = day === todayLisbon();
  const q = trpc.multipark.reservasDoDia.useQuery(
    { day, projectId: projectId ?? undefined },
    { refetchOnWindowFocus: isToday, refetchInterval: isToday ? 60_000 : false, placeholderData: (prev) => prev },
  );
  const data = q.data?.available ? q.data : null;
  const movements: DayMovement[] = (data?.movements as DayMovement[] | undefined) ?? [];

  // O parque escolhido pode não existir noutro âmbito/dia — não fica preso.
  useEffect(() => {
    if (parkId && data && !data.parks.some((p) => p.id === parkId)) setParkId("");
  }, [data, parkId]);

  // 42d: por cidade (os números de cima seguem a cidade escolhida) e por hora
  const cityDays = useMemo(() => summarizeByCity(movements), [movements]);
  const cityMoves = useMemo(() => (city ? movements.filter((m) => m.booking.cityKey === city) : movements), [movements, city]);
  const summary = useMemo(() => summarizeDay(cityMoves), [cityMoves]);
  const filtered = useMemo(() => filterMovements(movements, { kind, parkId, state, search, city, hour }), [movements, kind, parkId, state, search, city, hour]);
  const sections = useMemo(() => groupMovements(filtered), [filtered]);

  // Lista de parques do filtro: agrupada como a página (marcas nossas primeiro).
  const parksByGroup = useMemo(() => {
    const out = new Map<string, { label: string; order: number; parks: Array<{ id: string; name: string; cityName: string | null }> }>();
    for (const p of data?.parks ?? []) {
      let g = out.get(p.groupKey);
      if (!g) out.set(p.groupKey, (g = { label: p.groupLabel, order: p.groupOrder, parks: [] }));
      g.parks.push(p);
    }
    return [...out.values()].sort(compareGroups);
  }, [data]);

  return (
    <div className="space-y-4 min-w-0">
      {/* Dia */}
      <Card className="py-0 gap-0">
        <CardContent className="p-3 sm:p-4 flex flex-wrap items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Dia anterior" onClick={() => setDay((d) => addDays(d, -1))}>
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <Input
            type="date"
            value={day}
            onChange={(e) => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) setDay(e.target.value); }}
            className="w-40"
            aria-label="Dia"
          />
          <Button variant="outline" size="icon" aria-label="Dia seguinte" onClick={() => setDay((d) => addDays(d, 1))}>
            <ChevronRight className="w-4 h-4" />
          </Button>
          <Button variant={isToday ? "selected" : "outline"} size="sm" onClick={() => setDay(todayLisbon())} disabled={isToday}>
            Hoje
          </Button>
          <span className="text-sm text-muted-foreground flex items-center gap-1.5 min-w-0">
            <CalendarDays className="w-4 h-4 shrink-0" />
            <span className="truncate first-letter:uppercase">{longDay(day)}</span>
            {isToday && <Badge variant="outline" className="text-[11px]">hoje</Badge>}
          </span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={`w-4 h-4 mr-1 ${q.isFetching ? "animate-spin" : ""}`} /> Atualizar
          </Button>
        </CardContent>
      </Card>

      {q.data && !q.data.available && (
        <Card className="border-amber-300 bg-amber-50/60 dark:bg-amber-950/20">
          <CardContent className="p-4 text-sm flex gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Reservas indisponíveis</p>
              <p className="text-muted-foreground">{q.data.reason}</p>
            </div>
          </CardContent>
        </Card>
      )}
      {q.error && <p className="text-sm text-destructive">Erro a carregar as reservas: {q.error.message}</p>}

      {/* Contadores do dia */}
      {data && (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            <Counter icon={<ArrowDownToLine className="w-4 h-4 text-emerald-600" />} label="Entradas" value={summary.entradas} sub={summary.entradasPorFazer ? `${summary.entradasPorFazer} por fazer` : undefined} onClick={() => setKind(kind === "entrada" ? "todas" : "entrada")} active={kind === "entrada"} />
            <Counter icon={<ArrowUpFromLine className="w-4 h-4 text-amber-600" />} label="Saídas" value={summary.saidas} sub={summary.saidasPorFazer ? `${summary.saidasPorFazer} por fazer` : undefined} onClick={() => setKind(kind === "saida" ? "todas" : "saida")} active={kind === "saida"} />
            <Counter icon={<XCircle className="w-4 h-4 text-red-600" />} label="Canceladas" value={summary.canceladas} onClick={() => setState(state === "CANCELLED" ? "ativas" : "CANCELLED")} active={state === "CANCELLED"} />
          </div>
          {summary.pendentes > 0 && (
            <button
              type="button"
              onClick={() => setState(state === "PENDING" ? "ativas" : "PENDING")}
              aria-pressed={state === "PENDING"}
              className={`text-xs rounded-md border px-2 py-1 transition-colors ${state === "PENDING" ? "bg-primary/10 ring-1 ring-primary" : "bg-background hover:bg-muted"} text-muted-foreground`}
              title="Compras online que o cliente ainda não pagou (estado Pendente). Contam nas entradas e saídas até a Multipark as passar a recolhidas ou canceladas."
            >
              Destas, {summary.pendentes} {summary.pendentes === 1 ? "é compra online por pagar" : "são compras online por pagar"}{state === "PENDING" ? " — a mostrar só essas" : " — ver"}
            </button>
          )}
          <CityBoard cities={cityDays} city={city} onCity={(c) => { setCity(c); setHour(null); }} hour={hour} onHour={setHour} />
        </div>
      )}

      {/* Filtros */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label className="text-xs mb-1 block">Movimento</Label>
          <div className="inline-flex rounded-md border overflow-hidden" role="group">
            {([["todas", "Todas"], ["entrada", "Entradas"], ["saida", "Saídas"]] as const).map(([v, l]) => (
              <button
                key={v}
                type="button"
                onClick={() => setKind(v)}
                aria-pressed={kind === v}
                className={`text-xs px-3 h-9 border-l first:border-l-0 transition-colors ${kind === v ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted"}`}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
        <div>
          <Label className="text-xs mb-1 block">Parque</Label>
          <Select value={parkId || "all"} onValueChange={(v) => setParkId(v === "all" ? "" : v)}>
            <SelectTrigger className="w-52 max-w-full"><SelectValue placeholder="Todos" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os parques</SelectItem>
              {parksByGroup.map(({ label, parks }) => (
                <SelectGroup key={label}>
                  <SelectLabel>{label}</SelectLabel>
                  {parks.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}{p.cityName && !p.name.toLowerCase().includes(p.cityName.toLowerCase()) ? ` · ${p.cityName}` : ""}</SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs mb-1 block">Estado</Label>
          <Select value={state} onValueChange={setState}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ativas">Sem canceladas</SelectItem>
              <SelectItem value="todas">Todas</SelectItem>
              {BOOKING_STATUSES.map((s) => <SelectItem key={s} value={s}>{statusLabel(s)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="max-w-full">
          <Label className="text-xs mb-1 block">Pesquisar</Label>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-muted-foreground" />
            <Input placeholder="N.º, matrícula ou nome" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8 w-56 max-w-full" />
          </div>
        </div>
      </div>

      {data && data.excludedParks > 0 && (
        <p className="text-xs text-muted-foreground">
          {data.excludedParks === 1 ? "1 parque não aparece" : `${data.excludedParks} parques não aparecem`} (a operação não os faz — Definições → Parâmetros → Operação).
        </p>
      )}

      {data?.truncated && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          O dia tem mais de {data.limit} reservas — só aparecem as primeiras {data.limit}. Usa o filtro de parque.
        </p>
      )}

      {q.isLoading ? (
        <div className="flex items-center justify-center py-12"><RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : data && filtered.length === 0 ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground">
          {movements.length === 0 ? "Sem entradas nem saídas neste dia." : "Nenhuma reserva com estes filtros."}
        </CardContent></Card>
      ) : data ? (
        <div className="space-y-3">
          {/* Marcas nossas agrupam vários parques: mostra-se a coluna Parque. */}
          {sections.map((s) => <GroupTable key={s.key} label={s.label} rows={s.rows} onOpen={setOpen} showPark={s.ours} />)}
        </div>
      ) : null}

      {open && (
        <BookingDetailDialog
          booking={{
            externalId: open.booking.id,
            bookingNumber: open.booking.code,
            status: open.booking.status,
            parkName: open.booking.parkName,
            city: open.booking.parkCity,
            vehicleType: open.booking.vehicleType,
            clientFirstName: open.booking.clientName,
            clientEmail: open.booking.clientEmail,
            clientPhone: open.booking.clientPhone,
            licensePlate: open.booking.plate,
            vehicleBrand: open.booking.vehicleBrand,
            vehicleModel: open.booking.vehicleModel,
            vehicleColor: open.booking.vehicleColor,
            currentGarage: open.booking.garage,
            currentSpot: open.booking.spot,
            checkIn: open.booking.checkIn,
            checkOut: open.booking.checkOut,
            returnFlight: open.booking.returnFlight,
            departingFlight: open.booking.departingFlight,
            deliveryType: open.booking.deliveryType,
            totalPrice: open.booking.price,
            totalPaid: open.booking.paid,
            remainingToPay: open.booking.toPay,
            paymentMethod: open.booking.paymentMethod,
            origin: open.booking.origin ? ORIGIN_LABELS[open.booking.origin] ?? open.booking.origin : null,
            partnerName: open.booking.partnerName,
            checkinAgentName: open.booking.checkInDriverName,
            checkoutAgentName: open.booking.checkOutDriverName,
            bookingCreatedAt: open.booking.createdAt,
            remarks: [open.booking.remarks, open.booking.cancelReason ? `Cancelada: ${open.booking.cancelReason}` : null].filter(Boolean).join(" · ") || null,
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

/** 42d: escolher a cidade; por cidade, as marcas (Marketplace à parte) e as 24 horas. */
function CityBoard({ cities, city, onCity, hour, onHour }: { cities: CityDay[]; city: CityKey | ""; onCity: (c: CityKey | "") => void; hour: number | null; onHour: (h: number | null) => void }) {
  const shown = city ? cities.filter((c) => c.city === city) : cities;
  const chip = (active: boolean) => `text-xs rounded-md border px-2.5 py-1 transition-colors ${active ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-muted"}`;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Cidade">
        <button type="button" className={chip(!city)} aria-pressed={!city} onClick={() => onCity("")}>Todas</button>
        {cities.filter((c) => c.city).map((c) => (
          <button key={c.city} type="button" className={chip(city === c.city)} aria-pressed={city === c.city} onClick={() => onCity(city === c.city ? "" : c.city!)}>
            <span className="font-medium">{c.label}</span>
            <span className="ml-1.5 tabular-nums">↓{c.entradas}</span>
            <span className="ml-1 tabular-nums">↑{c.saidas}</span>
          </button>
        ))}
        {hour != null && (
          <button type="button" className={chip(true)} onClick={() => onHour(null)} title="Tirar o filtro da hora">{String(hour).padStart(2, "0")}h ✕</button>
        )}
      </div>
      {shown.map((c) => <CityCard key={c.city ?? "sem"} c={c} hour={hour} onHour={onHour} />)}
    </div>
  );
}

function CityCard({ c, hour, onHour }: { c: CityDay; hour: number | null; onHour: (h: number | null) => void }) {
  const maxH = Math.max(1, ...c.hours.map((h) => Math.max(h.entradas, h.saidas)));
  const shade = (n: number, kind: "in" | "out") => (n === 0 ? "" : kind === "in"
    ? (n / maxH > 0.66 ? "bg-emerald-200 dark:bg-emerald-900/60" : n / maxH > 0.33 ? "bg-emerald-100 dark:bg-emerald-900/40" : "bg-emerald-50 dark:bg-emerald-950/40")
    : (n / maxH > 0.66 ? "bg-amber-200 dark:bg-amber-900/60" : n / maxH > 0.33 ? "bg-amber-100 dark:bg-amber-900/40" : "bg-amber-50 dark:bg-amber-950/40"));
  const mp = c.byBucket.marketplace;
  return (
    <Card className="py-0 gap-0 overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/40 px-3 py-2 text-sm">
        <span className="font-semibold">{c.label}</span>
        <span className="text-xs text-emerald-700 tabular-nums">↓ {c.entradas} entram{c.entradasPorFazer ? ` (${c.entradasPorFazer} por fazer)` : ""}</span>
        <span className="text-xs text-amber-700 tabular-nums">↑ {c.saidas} saem{c.saidasPorFazer ? ` (${c.saidasPorFazer} por fazer)` : ""}</span>
      </div>
      <div className="space-y-2 p-3">
        {/* marcas e Marketplace */}
        <div className="flex flex-wrap gap-1.5">
          {DAY_BUCKETS.map((b) => {
            const x = c.byBucket[b];
            if (!x.entradas && !x.saidas) return null;
            return (
              <Badge key={b} variant="outline" className={`px-2 py-1 text-xs font-normal ${b === "marketplace" ? "border-violet-300" : ""}`}>
                <span className="mr-1.5 font-medium">{DAY_BUCKET_LABELS[b]}</span>
                <span className="tabular-nums text-emerald-700">↓{x.entradas}</span>
                <span className="ml-1.5 tabular-nums text-amber-700">↑{x.saidas}</span>
              </Badge>
            );
          })}
        </div>
        {(mp.entradas > 0 || mp.saidas > 0) && (
          <p className="text-[11px] leading-snug text-muted-foreground">
            <span className="font-medium text-foreground">Marketplace:</span>{" "}
            {c.marketplaceParks.map((p, i) => (
              <span key={p.name}>{i > 0 && " · "}{p.name} <span className="tabular-nums text-emerald-700">↓{p.entradas}</span> <span className="tabular-nums text-amber-700">↑{p.saidas}</span></span>
            ))}
          </p>
        )}
        {/* as 24 horas */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] table-fixed text-center text-[11px]">
            <thead>
              <tr className="text-muted-foreground">
                <th className="w-14 text-left font-medium">Hora</th>
                {c.hours.map((h) => (
                  <th key={h.hour} className="font-medium">
                    <button type="button" className={`w-full rounded tabular-nums hover:bg-muted ${hour === h.hour ? "bg-primary text-primary-foreground" : ""}`} onClick={() => onHour(hour === h.hour ? null : h.hour)} title={`Ver só as ${String(h.hour).padStart(2, "0")}h`}>
                      {String(h.hour).padStart(2, "0")}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(["in", "out"] as const).map((k) => (
                <tr key={k}>
                  <td className={`text-left font-medium ${k === "in" ? "text-emerald-700" : "text-amber-700"}`}>{k === "in" ? "↓ Entram" : "↑ Saem"}</td>
                  {c.hours.map((h) => {
                    const n = k === "in" ? h.entradas : h.saidas;
                    const left = k === "in" ? h.entradasPorFazer : h.saidasPorFazer;
                    return (
                      <td key={h.hour} className="p-0.5">
                        <button type="button" onClick={() => onHour(hour === h.hour ? null : h.hour)}
                          className={`w-full rounded py-1 tabular-nums ${shade(n, k)} ${hour === h.hour ? "ring-1 ring-primary" : ""} ${n === 0 ? "text-muted-foreground/50" : "font-semibold"}`}
                          title={`${String(h.hour).padStart(2, "0")}h: ${n} ${k === "in" ? "entram" : "saem"}${left ? ` (${left} por fazer)` : ""}`}>
                          {n === 0 ? "·" : n}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

function Counter({ icon, label, value, sub, onClick, active }: { icon: React.ReactNode; label: string; value: number; sub?: string; onClick: () => void; active: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`text-left rounded-lg border p-3 min-w-0 transition-colors ${active ? "border-primary bg-primary/5" : "bg-card hover:bg-muted/40"}`}
    >
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">{icon}{label}</span>
      <span className="block text-2xl font-bold tabular-nums leading-tight">{value.toLocaleString("pt-PT")}</span>
      {sub && <span className="block text-[11px] text-muted-foreground">{sub}</span>}
    </button>
  );
}

function GroupTable({ label, rows, onOpen, showPark }: { label: string; rows: DayMovement[]; onOpen: (m: DayMovement) => void; showPark?: boolean }) {
  const ins = rows.filter((r) => r.kind === "entrada").length;
  return (
    <Card className="py-0 gap-0 overflow-hidden">
      <div className="px-3 py-2 border-b bg-muted/40 flex items-center gap-3 text-sm">
        <span className="font-semibold">{label}</span>
        <span className="text-xs text-emerald-700 tabular-nums">{ins} entradas</span>
        <span className="text-xs text-amber-700 tabular-nums">{rows.length - ins} saídas</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="p-2 font-medium">Hora</th>
              <th className="p-2 font-medium">Reserva</th>
              <th className="p-2 font-medium">Cliente</th>
              <th className="p-2 font-medium">Carro</th>
              {showPark && <th className="p-2 font-medium">Parque</th>}
              <th className="p-2 font-medium">Estado</th>
              <th className="p-2 font-medium">Voo</th>
              <th className="p-2 font-medium">Entrega</th>
              <th className="p-2 font-medium">Lugar</th>
              <th className="p-2 font-medium text-right">Valor</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const b = m.booking;
              const cancelled = b.status === "CANCELLED";
              const phase = phaseLabel(b);
              return (
                <tr
                  key={m.key}
                  className={`border-t cursor-pointer hover:bg-muted/30 ${cancelled ? "opacity-60" : ""}`}
                  onClick={() => onOpen(m)}
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter") onOpen(m); }}
                >
                  <td className="p-2 whitespace-nowrap">
                    <span className={`inline-flex items-center gap-1 font-medium tabular-nums ${m.kind === "entrada" ? "text-emerald-700" : "text-amber-700"}`}>
                      {m.kind === "entrada" ? <ArrowDownToLine className="w-3.5 h-3.5" /> : <ArrowUpFromLine className="w-3.5 h-3.5" />}
                      {fmtPTTime(m.at)}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">{m.kind === "entrada" ? "Entrada" : "Saída"}{m.done ? " · feita" : ""}</span>
                  </td>
                  <td className="p-2 font-mono text-xs whitespace-nowrap">{b.code ?? b.id.slice(0, 10)}{b.pro && <Badge variant="outline" className="ml-1 text-[10px]">PRO</Badge>}</td>
                  <td className="p-2 text-xs max-w-[160px]"><span className="truncate block" title={b.clientName ?? undefined}>{b.clientName ?? "—"}</span></td>
                  <td className="p-2 text-xs whitespace-nowrap">
                    <span className="font-mono">{b.plate ?? "—"}</span>
                    {(b.vehicleBrand || b.vehicleModel) && <span className="block text-[11px] text-muted-foreground">{[b.vehicleBrand, b.vehicleModel].filter(Boolean).join(" ")}</span>}
                  </td>
                  {showPark && <td className="p-2 text-xs whitespace-nowrap">{b.parkName ?? "—"}{b.parkCity && <span className="block text-[11px] text-muted-foreground">{b.parkCity}</span>}</td>}
                  <td className="p-2">
                    <Badge className={BOOKING_STATUS_COLORS[b.status as BookingStatus] ?? "bg-gray-100 text-gray-800"}>{statusLabel(b.status)}</Badge>
                    {phase && <span className="block text-[11px] text-muted-foreground mt-0.5">{phase}</span>}
                  </td>
                  <td className="p-2 text-xs whitespace-nowrap">
                    {m.flight ? (
                      <>
                        <span className="inline-flex items-center gap-1 font-mono"><Plane className="w-3 h-3" />{m.flight}</span>
                        {m.flightEta && <span className="block text-[11px] text-muted-foreground">ETA {fmtPTTime(m.flightEta)}</span>}
                      </>
                    ) : "—"}
                  </td>
                  <td className="p-2 text-xs max-w-[140px]">
                    <span className="truncate block" title={b.deliveryType ?? undefined}>{b.deliveryType ?? "—"}</span>
                    {b.extrasCount > 0 && <span className="block text-[11px] text-muted-foreground">{b.extrasCount} extra{b.extrasCount > 1 ? "s" : ""}{b.extrasPending ? ` · ${b.extrasPending} por fazer` : ""}</span>}
                  </td>
                  <td className="p-2 text-xs whitespace-nowrap">{[b.garage, b.spot].filter(Boolean).join(" · ") || "—"}</td>
                  <td className="p-2 text-xs text-right whitespace-nowrap tabular-nums">
                    {fmtEur(b.price)}
                    {b.toPay != null && b.toPay > 0
                      ? <span className="block text-[11px] text-amber-700">falta {fmtEur(b.toPay)}</span>
                      : b.price != null && b.price > 0 && <span className="block text-[11px] text-emerald-700">pago</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
