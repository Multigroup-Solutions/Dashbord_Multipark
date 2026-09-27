import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import BookingDetailDialog from "@/components/BookingDetailDialog";
import ParkClassificationDialog from "@/components/operacoes/ParkClassificationDialog";
import { fmtPTTime } from "@/lib/lisbonTime";
import { addDays, lisbonDayOf } from "@shared/lisbonDay";
import {
  BOOKING_CHANNEL_LABELS, BOOKING_STATUSES, BOOKING_STATUS_COLORS, filterMovements, phaseLabel, statusLabel, summarizeDay,
  type BookingChannel, type BookingStatus, type DayMovement, type MovementKind,
} from "@shared/reservasDoDia";
import { MARKETPLACE_GROUP_KEY, allParkGroups } from "@shared/multiparkParks";
import {
  ArrowDownToLine, ArrowUpFromLine, CalendarDays, ChevronLeft, ChevronRight, Plane, RefreshCw, Search, XCircle, AlertTriangle, Tags,
} from "lucide-react";

/** Cores do distintivo do canal (contabilidade). */
const CHANNEL_BADGE: Record<BookingChannel, string> = {
  direto: "border-sky-200 text-sky-700",
  parceiro: "border-violet-200 text-violet-700",
  marketplace: "border-rose-200 text-rose-700",
};

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
 * todo carregado).
 */
export default function ReservasDoDia() {
  const [seed] = useState(seedFromUrl);
  const [day, setDay] = useState<string>(seed.day ?? todayLisbon());
  const [kind, setKind] = useState<"todas" | MovementKind>(seed.kind);
  const [parkId, setParkId] = useState<string>("");
  const [state, setState] = useState<string>("ativas");
  const [channel, setChannel] = useState<BookingChannel | "">("");
  const [showParks, setShowParks] = useState(false);
  const [search, setSearch] = useState(seed.q);
  const [open, setOpen] = useState<DayMovement | null>(null);

  const isToday = day === todayLisbon();
  const q = trpc.multipark.reservasDoDia.useQuery(
    { day },
    { refetchOnWindowFocus: isToday, refetchInterval: isToday ? 60_000 : false, placeholderData: (prev) => prev },
  );
  const data = q.data?.available ? q.data : null;
  const movements: DayMovement[] = (data?.movements as DayMovement[] | undefined) ?? [];

  // O parque escolhido pode não existir noutro âmbito/dia — não fica preso.
  useEffect(() => {
    if (parkId && data && !data.parks.some((p) => p.id === parkId)) setParkId("");
  }, [data, parkId]);

  const summary = useMemo(() => summarizeDay(movements), [movements]);
  const filtered = useMemo(() => filterMovements(movements, { kind, parkId, state, search, channel }), [movements, kind, parkId, state, search, channel]);

  const sections = useMemo(() => {
    const groups = allParkGroups();
    const byKey = new Map<string, DayMovement[]>();
    for (const m of filtered) {
      const k = groups.some((g) => g.key === m.booking.groupKey) ? m.booking.groupKey : MARKETPLACE_GROUP_KEY;
      (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(m);
    }
    return groups.map((g) => ({ ...g, rows: byKey.get(g.key) ?? [] })).filter((g) => g.rows.length > 0);
  }, [filtered]);
  const ourSections = sections.filter((s) => s.ours);
  const marketSections = sections.filter((s) => !s.ours);

  const parksByGroup = useMemo(() => {
    const out = new Map<string, Array<{ id: string; name: string; cityName: string | null }>>();
    for (const p of data?.parks ?? []) (out.get(p.label) ?? out.set(p.label, []).get(p.label)!).push(p);
    return [...out.entries()];
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
          <Button variant={isToday ? "secondary" : "outline"} size="sm" onClick={() => setDay(todayLisbon())} disabled={isToday}>
            Hoje
          </Button>
          <span className="text-sm text-muted-foreground flex items-center gap-1.5 min-w-0">
            <CalendarDays className="w-4 h-4 shrink-0" />
            <span className="truncate first-letter:uppercase">{longDay(day)}</span>
            {isToday && <Badge variant="outline" className="text-[11px]">hoje</Badge>}
          </span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setShowParks(true)} title="Como cada parque é classificado (nosso / Marketplace)">
            <Tags className="w-4 h-4 mr-1" /> Classificação dos parques
          </Button>
          <Button variant="ghost" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
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
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground mr-0.5">Canal:</span>
            {summary.channels.map((c) => (
              <button
                key={c.channel}
                type="button"
                onClick={() => setChannel(channel === c.channel ? "" : c.channel)}
                aria-pressed={channel === c.channel}
                className={`inline-flex items-center rounded-md border text-xs py-1 px-2 transition-colors ${CHANNEL_BADGE[c.channel]} ${channel === c.channel ? "bg-primary/10 ring-1 ring-primary" : "bg-background hover:bg-muted"}`}
              >
                <span className="font-medium mr-1.5">{c.label}</span>
                <span className="tabular-nums">↓{c.entradas}</span>
                <span className="tabular-nums ml-1.5">↑{c.saidas}</span>
              </button>
            ))}
            {channel && <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setChannel("")}>Todos os canais</Button>}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {summary.groups.filter((g) => g.entradas + g.saidas > 0).map((g) => (
              <Badge key={g.key} variant="outline" className={`text-xs py-1 px-2 font-normal ${g.ours ? "" : "border-dashed"}`}>
                <span className="font-medium mr-1.5">{g.label}</span>
                <span className="text-emerald-700 tabular-nums">↓{g.entradas}</span>
                <span className="text-amber-700 tabular-nums ml-1.5">↑{g.saidas}</span>
              </Badge>
            ))}
          </div>
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
              {parksByGroup.map(([label, parks]) => (
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
        <div className="space-y-5">
          {ourSections.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Parques nossos</h3>
              {ourSections.map((s) => <GroupTable key={s.key} label={s.label} rows={s.rows} onOpen={setOpen} />)}
            </div>
          )}
          {marketSections.map((s) => (
            <div key={s.key} className="space-y-3">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Marketplace</h3>
              <GroupTable label={s.label} rows={s.rows} onOpen={setOpen} showPark />
            </div>
          ))}
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
            origin: `${BOOKING_CHANNEL_LABELS[open.booking.channel]} · ${open.booking.channelDetail}`,
            partnerName: open.booking.partnerName,
            checkinAgentName: open.booking.checkInDriverName,
            checkoutAgentName: open.booking.checkOutDriverName,
            bookingCreatedAt: open.booking.createdAt,
            remarks: [open.booking.remarks, open.booking.cancelReason ? `Cancelada: ${open.booking.cancelReason}` : null].filter(Boolean).join(" · ") || null,
          }}
          onClose={() => setOpen(null)}
        />
      )}
      <ParkClassificationDialog open={showParks} onOpenChange={setShowParks} />
    </div>
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
              <th className="p-2 font-medium">Canal</th>
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
                  <td className="p-2 text-xs max-w-[160px]">
                    <Badge variant="outline" className={`text-[11px] max-w-full ${CHANNEL_BADGE[b.channel]}`} title={b.channelBadge}>
                      <span className="truncate">{b.channelBadge}</span>
                    </Badge>
                    <span className="truncate block text-[11px] text-muted-foreground" title={b.channelDetail}>{b.channelDetail}</span>
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
