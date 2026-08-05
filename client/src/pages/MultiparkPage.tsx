import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { QuickRangeBar, thisMonthRange } from "@/components/QuickRangeBar";
import DateRangeNav from "@/components/DateRangeNav";
import { useTableSort, Th } from "@/components/SortableTable";
import { toast } from "sonner";
import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { useParams } from "wouter";
import { usePersistedState } from "@/hooks/usePersistedState";
import { fmtBookingDateTime, fmtBookingDate, fmtBookingHHmm } from "@/lib/lisbonTime";
import {
  ParkingCircle, Wifi, WifiOff, RefreshCw, Calendar, Car, Truck, Bike,
  MapPin, Clock, CheckCircle2, XCircle, AlertCircle, BarChart3, History, Building2,
  Upload, TrendingUp, DollarSign, ArrowDownToLine, ArrowUpFromLine, FileSpreadsheet,
  Filter, Download, Search, Users, CreditCard, Percent, CalendarDays, CalendarCheck,
} from "lucide-react";

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmtEur = (v: number | string | null | undefined) => {
  const n = typeof v === "string" ? parseFloat(v) : (v ?? 0);
  return n.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
};
const fmtCents = (cents: number) => (cents / 100).toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
const fmtNum = (n: number) => n.toLocaleString("pt-PT");
const fmtDate = (d: string | null | undefined) => d ? new Date(d).toLocaleDateString("pt-PT") : "—";
const fmtDateTime = (d: string | null | undefined) => d ? new Date(d).toLocaleString("pt-PT") : "—";

const PARKING_LABELS: Record<string, string> = {
  COVERED: "Coberto", UNCOVERED: "Descoberto", INDOOR: "Interior", VIP: "VIP", INTERIOR: "Interior", EXTERIOR: "Exterior",
};
const VEHICLE_LABELS: Record<string, string> = {
  MOTORCYCLE: "Mota", CAR: "Carro", VAN: "Carrinha", TRUCK: "Camião",
};
const STATUS_MAP: Record<string, { label: string; color: string }> = {
  BOOKED: { label: "Reservada", color: "bg-blue-100 text-blue-800" },
  PENDING: { label: "Pendente", color: "bg-yellow-100 text-yellow-800" },
  PENDING_PAYMENT: { label: "Pend. Pagamento", color: "bg-yellow-100 text-yellow-800" },
  CONFIRMED: { label: "Confirmada", color: "bg-blue-100 text-blue-800" },
  CHECKED_IN: { label: "Check-in", color: "bg-green-100 text-green-800" },
  MOVING: { label: "Em Movimento", color: "bg-green-100 text-green-700" },
  CHECKED_OUT: { label: "Check-out", color: "bg-purple-100 text-purple-800" },
  PENDING_CHECKOUT: { label: "Pend. Check-out", color: "bg-purple-100 text-purple-700" },
  CANCELLED: { label: "Cancelada", color: "bg-red-100 text-red-800" },
  COMPLETED: { label: "Concluída", color: "bg-gray-100 text-gray-800" },
};

// ─── Section config ───────────────────────────────────────────────────────────
const SECTION_CONFIG: Record<string, {
  title: string;
  subtitle: string;
  icon: React.ElementType;
  actionType?: "creation" | "checkin" | "checkout" | "cancelation";
}> = {
  reservas: {
    title: "Reservas",
    subtitle: "Reservas criadas no período seleccionado",
    icon: CalendarCheck,
    actionType: "creation",
  },
  entradas: {
    title: "Recolhas",
    subtitle: "Recolhas realizadas no período seleccionado",
    icon: ArrowDownToLine,
    actionType: "checkin",
  },
  saidas: {
    title: "Entregas",
    subtitle: "Entregas realizadas no período seleccionado",
    icon: ArrowUpFromLine,
    actionType: "checkout",
  },
  cancelados: {
    title: "Cancelados",
    subtitle: "Reservas canceladas no período seleccionado",
    icon: XCircle,
    actionType: "cancelation",
  },
  sync: {
    title: "Sincronização",
    subtitle: "Sincronizar dados da API e importar Excel",
    icon: RefreshCw,
  },
};

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function MultiparkPage({ sectionProp }: { sectionProp?: string } = {}) {
  const { user } = useAuth();
  const params = useParams<{ section?: string }>();
  const section = sectionProp || params.section || "reservas";
  const config = SECTION_CONFIG[section] || SECTION_CONFIG.reservas;
  const Icon = config.icon;

  return (
    <>
      <div className="p-4 md:p-6 space-y-6 max-w-[1400px] mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <p className="text-sm text-muted-foreground">{config.subtitle}</p>
          </div>
          <ConnectionStatus />
        </div>

        {/* Content based on section */}
        {section === "sync" ? (
          <div className="space-y-6">
            <SyncTab />
            <ImportTab />
          </div>
        ) : config.actionType ? (
          <ActionTypeTab actionType={config.actionType} />
        ) : null}
      </div>
    </>
  );
}

// ─── Action Type Tab (queries API directly per actionType) ───────────────────
function ActionTypeTab({ actionType }: { actionType: "creation" | "checkin" | "checkout" | "cancelation" }) {
  const globalFilters = useGlobalFilters();
  const [defFrom, defTo] = thisMonthRange();
  // Filtros persistem à navegação (por tipo de ação: recolhas/entregas/…)
  const [startDate, setStartDate] = usePersistedState(`mpk.${actionType}.start`, defFrom);
  const [endDate, setEndDate] = usePersistedState(`mpk.${actionType}.end`, defTo);
  const [activeRange, setActiveRange] = usePersistedState<string>(`mpk.${actionType}.range`, "thisMonth");
  const [searchTerm, setSearchTerm] = usePersistedState(`mpk.${actionType}.search`, "");
  const [projectId, setProjectId] = usePersistedState<string>(`mpk.${actionType}.project`, "");
  const [originFilter, setOriginFilter] = usePersistedState<string>(`mpk.${actionType}.origin`, "all");
  const [detailBooking, setDetailBooking] = useState<any>(null);

  // Sync global filter to local project filter — só quando o header TEM filtro
  // ativo (antes esmagava o filtro persistido com "" a cada montagem)
  useEffect(() => {
    if (globalFilters.projectId !== undefined) {
      setProjectId(String(globalFilters.projectId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalFilters.projectId]);
  const { data: allProjects = [] } = trpc.projects.list.useQuery();

  const sortedProjects = useMemo(() => {
    const all = allProjects as any[];
    const result: { id: number; name: string; level: string; depth: number }[] = [];
    const addChildren = (parentId: number | null, depth: number) => {
      all.filter((p: any) => p.parentId === parentId).forEach((p: any) => {
        result.push({ id: p.id, name: p.name, level: p.level, depth });
        addChildren(p.id, depth + 1);
      });
    };
    addChildren(null, 0);
    return result;
  }, [allProjects]);

  const levelIcon = (level: string) => level === "group" ? "🏢" : level === "city" ? "📍" : level === "brand" ? "🏷" : "📁";

  const { data, isLoading, refetch } = trpc.multipark.localBookingsByAction.useQuery(
    { startDate, endDate, actionType, projectId: projectId ? Number(projectId) : undefined },
    { refetchOnWindowFocus: false }
  );

  // Custo extras-dia para o intervalo (apenas Recolhas/Entregas)
  const showExtrasDiaCost = actionType === "checkin" || actionType === "checkout";
  const { data: extrasDiaCost } = trpc.extrasDia.costForRange.useQuery(
    { startDate, endDate },
    { enabled: showExtrasDiaCost, refetchOnWindowFocus: false },
  );

  // Origens distintas no resultado (para o filtro "de onde vem a reserva")
  const ORIGIN_LABELS: Record<string, string> = {
    GENERAL_FORM: "Site (formulário)",
    API: "API / Agregador",
    BACKOFFICE: "Backoffice",
    PHONE: "Telefone",
  };
  const originOptions = useMemo(() => {
    const set = new Set<string>();
    for (const b of (data?.bookings ?? []) as any[]) {
      if (b.origin) set.add(b.origin);
    }
    return Array.from(set).sort();
  }, [data]);

  const bookings = useMemo(() => {
    let list: any[] = data?.bookings ?? [];
    if (originFilter === "partner") list = list.filter((b) => b.salesPartnerName);
    else if (originFilter === "none") list = list.filter((b) => !b.origin);
    else if (originFilter !== "all") list = list.filter((b) => b.origin === originFilter);
    if (!searchTerm) return list;
    const s = searchTerm.toLowerCase();
    return list.filter((b: any) =>
      (b.clientFirstName || "").toLowerCase().includes(s) ||
      (b.clientLastName || "").toLowerCase().includes(s) ||
      (b.licensePlate || "").toLowerCase().includes(s) ||
      (b.bookingNumber || "").toLowerCase().includes(s) ||
      (b.clientEmail || "").toLowerCase().includes(s)
    );
  }, [data, searchTerm, originFilter]);

  // Ordenação por coluna (setas nos cabeçalhos)
  const { sorted: sortedBookings, sortKey, sortDir, toggle } = useTableSort(bookings as any[]);

  // Aggregate totals (comissões de parceiros vêm do servidor — partnerships
  // novas por campanha, coerente com Faturação/Parcerias)
  const totals = useMemo(() => {
    let revenue = 0;
    let delivery = 0;
    let extras = 0;
    let discount = 0;
    let partnerTotal = 0;
    let toCollect = 0;
    const byPark: Record<string, { count: number; revenue: number; partnerShare: number; partnerName: string | null }> = {};

    for (const b of bookings as any[]) {
      const priceNum = parseFloat(b.totalPrice) || 0;
      revenue += priceNum;
      delivery += parseFloat(b.deliveryCharges) || 0;
      extras += parseFloat(b.extrasTotal) || 0;
      discount += parseFloat(b.discount) || 0;
      toCollect += parseFloat(b.remainingToPay) || 0;

      const park = b.parkName || "Desconhecido";
      const city = b.city || "";
      const displayName = city && !park.includes(city) ? `${park} ${city}` : park;
      if (!byPark[displayName]) byPark[displayName] = { count: 0, revenue: 0, partnerShare: 0, partnerName: null };
      byPark[displayName].count++;
      byPark[displayName].revenue += priceNum;

      const commission = Number(b.salesPartnerCommission ?? 0);
      if (commission > 0) {
        byPark[displayName].partnerShare += commission;
        byPark[displayName].partnerName = b.salesPartnerName ?? byPark[displayName].partnerName;
        partnerTotal += commission;
      }
    }

    return { revenue, delivery, extras, discount, byPark, partnerTotal, toCollect };
  }, [bookings]);

  return (
    <div className="space-y-4">
      {/* Atalhos de período */}
      <QuickRangeBar
        active={activeRange}
        onPick={(f, t, id) => { setStartDate(f); setEndDate(t); setActiveRange(id); }}
      />

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="mb-0.5">
          <DateRangeNav
            start={startDate}
            end={endDate}
            gran={(activeRange === "thisWeek" || activeRange === "lastWeek" ? "week" : activeRange === "thisMonth" || activeRange === "lastMonth" ? "month" : "custom") as any}
            showAll={false}
            onChange={(s, e) => { setStartDate(s); setEndDate(e); setActiveRange(""); }}
          />
        </div>
        <div>
          <Label className="text-xs mb-1 block">Origem</Label>
          <Select value={originFilter} onValueChange={setOriginFilter}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as origens</SelectItem>
              <SelectItem value="partner">Com parceiro/campanha</SelectItem>
              {originOptions.map((o) => (
                <SelectItem key={o} value={o}>{ORIGIN_LABELS[o] ?? o}</SelectItem>
              ))}
              <SelectItem value="none">Sem origem registada</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs mb-1 block">Grupo / Projeto</Label>
          <Select value={projectId} onValueChange={v => setProjectId(v === "all" ? "" : v)}>
            <SelectTrigger className="w-56"><SelectValue placeholder="Todos" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {sortedProjects.map(p => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {"  ".repeat(p.depth)}{levelIcon(p.level)} {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs mb-1 block">Pesquisar</Label>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-muted-foreground" />
            <Input
              placeholder="Nome, matrícula, email..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-8 w-56"
            />
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isLoading}>
          <RefreshCw className={`w-4 h-4 mr-1 ${isLoading ? "animate-spin" : ""}`} />
          Atualizar
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={bookings.length === 0}
          onClick={() => {
            const headers = ["Reserva","Cliente","Email","Matrícula","Parque","Cidade","Check-in","Check-out","Tipo Recolha/Entrega","Estado","Tipo Parque","Preço","Delivery","Extras","Desconto","Campanha"];
            const rows = (bookings as any[]).map(b => [
              b.bookingNumber || b.externalId || "",
              `${b.clientFirstName || ""} ${b.clientLastName || ""}`.trim().replace(/;/g, ","),
              (b.clientEmail || "").replace(/;/g, ","),
              b.licensePlate || "",
              (b.parkName || "").replace(/;/g, ","),
              b.city || "",
              b.checkIn || "",
              b.checkOut || "",
              b.deliveryType || "",
              b.status || "",
              b.parkingType || "",
              parseFloat(b.totalPrice || "0").toFixed(2),
              parseFloat(b.deliveryCharges || "0").toFixed(2),
              parseFloat(b.extrasTotal || "0").toFixed(2),
              parseFloat(b.discount || "0").toFixed(2),
              b.campaign || "",
            ]);
            const csv = [headers.join(";"), ...rows.map(r => r.join(";"))].join("\n");
            const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = `reservas_${actionType}_${startDate}_${endDate}.csv`; a.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download className="w-4 h-4 mr-1" /> CSV
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="text-xl font-bold">{bookings.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Receita Bruta</p>
            <p className="text-xl font-bold text-green-600">{fmtEur(totals.revenue)}</p>
          </CardContent>
        </Card>
        {totals.partnerTotal > 0 && (
          <Card>
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">Parceiros</p>
              <p className="text-xl font-bold text-orange-600">-{fmtEur(totals.partnerTotal)}</p>
            </CardContent>
          </Card>
        )}
        {totals.partnerTotal > 0 && (
          <Card className="border-green-200 bg-green-50">
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">Receita Líquida</p>
              <p className="text-xl font-bold text-green-700">{fmtEur(totals.revenue - totals.partnerTotal)}</p>
            </CardContent>
          </Card>
        )}
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Delivery</p>
            <p className="text-xl font-bold">{fmtEur(totals.delivery)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">
              Extras{showExtrasDiaCost ? " (extras-dia)" : ""}
            </p>
            {showExtrasDiaCost ? (
              <>
                <p className="text-xl font-bold">{fmtEur(extrasDiaCost?.total ?? 0)}</p>
                {extrasDiaCost && (extrasDiaCost.real > 0 || extrasDiaCost.estimate > 0) && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    real {fmtEur(extrasDiaCost.real)} ({(extrasDiaCost as any).daysWithReal ?? 0}d)
                    · estim. {fmtEur(extrasDiaCost.estimate)} ({(extrasDiaCost as any).daysWithEstimate ?? 0}d)
                  </p>
                )}
              </>
            ) : (
              <p className="text-xl font-bold">{fmtEur(totals.extras)}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Descontos</p>
            <p className="text-xl font-bold text-red-600">{fmtEur(totals.discount)}</p>
          </CardContent>
        </Card>
        {totals.toCollect > 0 && (
          <Card className="border-amber-300 bg-amber-50/60">
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">Por cobrar</p>
              <p className="text-xl font-bold text-amber-700">{fmtEur(totals.toCollect)}</p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Aviso do corte de 5.000 linhas (períodos grandes) */}
      {(data?.bookings?.length ?? 0) >= 5000 && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          ⚠ A mostrar as primeiras 5.000 reservas — o período escolhido tem mais. Encurta o período para ver tudo.
        </p>
      )}

      {/* Per-park breakdown */}
      {Object.keys(totals.byPark).length > 1 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(totals.byPark).map(([park, data]) => (
            <Badge key={park} variant="outline" className="text-xs py-1 px-2">
              {park}: {data.count} ({fmtEur(data.revenue)})
              {data.partnerName && (
                <span className="text-orange-600 ml-1">
                  | {data.partnerName}: {fmtEur(data.partnerShare)}
                </span>
              )}
            </Badge>
          ))}
        </div>
      )}

      {/* Legenda */}
      {bookings.some((b: any) => (b.parkingType ?? "").toUpperCase() !== "VALET") && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <div className="w-3 h-3 bg-red-50 border border-red-200 rounded" />
          <span>Reservas sem serviço de valet (tipo de parque diferente de VALET) — atenção operacional</span>
        </div>
      )}

      {/* Bookings table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : bookings.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            Sem resultados para o período seleccionado.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/50 text-left">
                    <Th k="bookingNumber" label="Reserva" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                    <Th k="clientFirstName" label="Cliente" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                    <Th k="licensePlate" label="Matrícula" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                    <Th k="parkName" label="Parque" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                    <Th k="checkIn" label="Recolha" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                    <Th k="checkOut" label="Entrega" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                    <Th k="origin" label="Origem" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                    <Th k="status" label="Estado" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                    <Th k="totalPrice" label="Preço" align="right" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                    <Th k="parkingType" label="Tipo" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                  </tr>
                </thead>
                <tbody>
                  {sortedBookings.map((b: any, i: number) => {
                    const status = b.status || "—";
                    const statusCfg = STATUS_MAP[status];
                    const parkName = b.parkName || "—";
                    const parkCity = b.city || "";
                    const isNonValet = (b.parkingType ?? "").toUpperCase() !== "VALET";
                    const clientName = `${b.clientFirstName || ""} ${b.clientLastName || ""}`.trim();
                    const toPay = parseFloat(b.remainingToPay) || 0;

                    return (
                      <tr
                        key={b.id || i}
                        className={`border-t cursor-pointer ${isNonValet ? "bg-red-50 hover:bg-red-100/70" : "hover:bg-muted/30"}`}
                        onClick={() => setDetailBooking(b)}
                      >
                        <td className="p-2 font-mono text-xs">{b.bookingNumber || b.externalId}</td>
                        <td className="p-2 text-xs max-w-[140px]">
                          <span className="truncate block">{clientName || <span className="text-muted-foreground">—</span>}</span>
                        </td>
                        <td className="p-2 font-mono text-xs">{b.licensePlate || "—"}</td>
                        <td className="p-2">
                          <span className="font-medium">{parkName}</span>
                          {parkCity && !parkName.includes(parkCity) && <span className="text-xs text-muted-foreground ml-1">{parkCity}</span>}
                        </td>
                        <td className="p-2 text-xs">{fmtBookingDateTime(b.checkIn)}</td>
                        <td className="p-2 text-xs">{fmtBookingDateTime(b.checkOut)}</td>
                        <td className="p-2 text-xs max-w-[130px]">
                          {b.salesPartnerName ? (
                            <Badge variant="outline" className="text-[10px] border-rose-200 text-rose-700">{b.salesPartnerName}</Badge>
                          ) : b.origin ? (
                            <Badge variant="outline" className="text-[10px]">{ORIGIN_LABELS[b.origin] ?? b.origin}</Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                          {b.campaign && !b.salesPartnerName && (
                            <span className="block text-[10px] text-muted-foreground truncate" title={b.campaign}>{b.campaign}</span>
                          )}
                        </td>
                        <td className="p-2">
                          <Badge className={statusCfg?.color || "bg-gray-100 text-gray-800"}>
                            {statusCfg?.label || status}
                          </Badge>
                        </td>
                        <td className="p-2 text-right font-medium">
                          {fmtEur(b.totalPrice)}
                          {toPay > 0 && <span className="block text-[10px] text-amber-700">falta {fmtEur(toPay)}</span>}
                        </td>
                        <td className="p-2 text-xs">
                          {b.parkingType || "—"}
                          {isNonValet && <span className="ml-1 text-red-600 font-semibold">⚠ não-valet</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {detailBooking && <BookingDetailDialog booking={detailBooking} onClose={() => setDetailBooking(null)} />}
    </div>
  );
}

// ─── Detalhe da reserva (clique na linha da folha) ───────────────────────────
// Mostra tudo o que a BD já tem sobre a reserva — cliente, carro, voos,
// pagamento, origem, agentes — sem ir à API.
function BookingDetailDialog({ booking: b, onClose }: { booking: any; onClose: () => void }) {
  const Row = ({ label, value, mono }: { label: string; value?: any; mono?: boolean }) => {
    if (value == null || value === "" || value === "—") return null;
    return (
      <div className="flex justify-between items-start gap-3 text-sm">
        <span className="text-muted-foreground shrink-0">{label}</span>
        <span className={`font-medium text-right min-w-0 break-words ${mono ? "font-mono text-xs" : ""}`}>{String(value)}</span>
      </div>
    );
  };
  const statusCfg = STATUS_MAP[b.status ?? ""];
  const toPay = parseFloat(b.remainingToPay) || 0;
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <Card className="w-full max-w-xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center justify-between gap-2 flex-wrap">
            <span className="font-mono">{b.bookingNumber || b.externalId}</span>
            <Badge className={statusCfg?.color || "bg-gray-100 text-gray-800"}>{statusCfg?.label || b.status}</Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground">{b.parkName} {b.city} · {b.parkingType ?? ""} {b.vehicleType ? `· ${VEHICLE_LABELS[b.vehicleType] ?? b.vehicleType}` : ""}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase">Cliente</p>
            <Row label="Nome" value={`${b.clientFirstName ?? ""} ${b.clientLastName ?? ""}`.trim()} />
            <Row label="Email" value={b.clientEmail} />
            <Row label="Telefone" value={b.clientPhone} />
            <Row label="NIF" value={b.clientNif} />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase">Viatura</p>
            <Row label="Matrícula" value={b.licensePlate} mono />
            <Row label="Marca/Modelo" value={[b.vehicleBrand, b.vehicleModel].filter(Boolean).join(" ")} />
            <Row label="Cor" value={b.vehicleColor} />
            <Row label="Localização atual" value={[b.currentGarage, b.currentSpot].filter(Boolean).join(" · ")} />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase">Datas & voos</p>
            <Row label="Recolha" value={fmtBookingDateTime(b.checkIn)} />
            <Row label="Entrega" value={fmtBookingDateTime(b.checkOut)} />
            <Row label="Voo chegada" value={b.arrivalFlight ?? b.returnFlight} mono />
            <Row label="Voo partida" value={b.departureFlight ?? b.departingFlight} mono />
            <Row label="Tipo entrega" value={b.deliveryType} />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase">Pagamento</p>
            <Row label="Preço total" value={fmtEur(b.totalPrice)} />
            <Row label="Estacionamento" value={b.parkingPrice != null ? fmtEur(b.parkingPrice) : null} />
            <Row label="Delivery" value={parseFloat(b.deliveryCharges) > 0 ? fmtEur(b.deliveryCharges) : null} />
            <Row label="Extras" value={parseFloat(b.extrasTotal) > 0 ? fmtEur(b.extrasTotal) : null} />
            <Row label="Desconto" value={parseFloat(b.discount) > 0 ? `−${fmtEur(b.discount)}` : null} />
            <Row label="Pago" value={b.totalPaid != null ? fmtEur(b.totalPaid) : null} />
            {toPay > 0 && <Row label="⚠ Por cobrar" value={fmtEur(toPay)} />}
            <Row label="Método" value={b.paymentMethod} />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase">Origem & operação</p>
            <Row label="Origem" value={b.origin} />
            <Row label="Campanha" value={b.campaignName ?? b.campaign} />
            <Row label="Parceiro" value={b.salesPartnerName ?? b.partnerName} />
            {Number(b.salesPartnerCommission ?? 0) > 0 && (
              <Row label="Comissão parceiro" value={`${fmtEur(b.salesPartnerCommission)} (${b.salesPartnerRate}%)`} />
            )}
            <Row label="Check-in por" value={b.checkinAgentName} />
            <Row label="Check-out por" value={b.checkoutAgentName} />
            <Row label="Criada em" value={fmtBookingDateTime(b.bookingCreatedAt)} />
            <Row label="Observações" value={b.remarks} />
          </div>
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={onClose}>Fechar</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Connection Status ────────────────────────────────────────────────────────
function ConnectionStatus() {
  const { data, isLoading, refetch } = trpc.multipark.testConnection.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  return (
    <div className="flex items-center gap-2">
      {isLoading ? (
        <Badge variant="outline" className="gap-1.5 py-1.5 px-3">
          <RefreshCw className="w-3.5 h-3.5 animate-spin" /> A verificar...
        </Badge>
      ) : data?.ok ? (
        <Badge className="bg-green-600 gap-1.5 py-1.5 px-3">
          <Wifi className="w-3.5 h-3.5" /> Conectado {data.version ? `(v${data.version})` : ""}
        </Badge>
      ) : (
        <Badge variant="destructive" className="gap-1.5 py-1.5 px-3">
          <WifiOff className="w-3.5 h-3.5" /> Desconectado
        </Badge>
      )}
      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => refetch()}>
        <RefreshCw className="w-4 h-4" />
      </Button>
    </div>
  );
}

// ─── Dashboard Tab (KPIs from snapshots) ─────────────────────────────────────
function DashboardTab() {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const [from, setFrom] = useState(monthStart.toISOString().slice(0, 10));
  const [to, setTo] = useState(today.toISOString().slice(0, 10));
  const [city, setCity] = useState<string>("all");

  const queryInput = useMemo(() => ({
    from: from || undefined,
    to: to ? to + "T23:59:59.999Z" : undefined,
    city: city && city !== "all" ? city : undefined,
  }), [from, to, city]);

  const { data: kpis, isLoading } = trpc.multipark.kpis.useQuery(queryInput);

  // Also fetch synced booking stats for comparison
  const { data: bookingStats } = trpc.multipark.bookingStats.useQuery();

  if (isLoading) return <div className="py-12 text-center text-muted-foreground">A carregar KPIs...</div>;

  if (!kpis || kpis.totalBookings === 0) {
    return (
      <div className="mt-4 space-y-4">
        <FilterBar from={from} to={to} city={city} onFromChange={setFrom} onToChange={setTo} onCityChange={setCity} cities={[]} />
        <Card className="border-dashed">
          <CardContent className="py-16 text-center">
            <FileSpreadsheet className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="font-semibold text-lg mb-2">Sem dados para o período selecionado</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Sincroniza as reservas via API ou importa um ficheiro Excel para ver os KPIs.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const cities = kpis.byCity.map(c => c.name);

  const topKpis = [
    { label: "Total Reservas", value: fmtNum(kpis.totalBookings), icon: ParkingCircle, color: "text-indigo-600 bg-indigo-100" },
    { label: "Receita Total", value: fmtCents(kpis.totalRevenue), icon: DollarSign, color: "text-green-600 bg-green-100" },
    { label: "Recolhas", value: fmtNum(kpis.checkins), icon: ArrowDownToLine, color: "text-blue-600 bg-blue-100" },
    { label: "Entregas", value: fmtNum(kpis.checkouts), icon: ArrowUpFromLine, color: "text-purple-600 bg-purple-100" },
    { label: "Reservados", value: fmtNum(kpis.reserved), icon: Calendar, color: "text-amber-600 bg-amber-100" },
    { label: "Cancelados", value: fmtNum(kpis.cancelled), icon: XCircle, color: "text-red-600 bg-red-100" },
  ];

  return (
    <div className="space-y-6 mt-4">
      <FilterBar from={from} to={to} city={city} onFromChange={setFrom} onToChange={setTo} onCityChange={setCity} cities={cities} />

      {/* Booking sync stats */}
      {bookingStats && bookingStats.total > 0 && (
        <Card className="border-indigo-200 bg-indigo-50/30">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <RefreshCw className="w-4 h-4 text-indigo-600" />
              <span className="text-sm font-medium text-indigo-900">Reservas sincronizadas via API</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div><span className="text-xl font-bold text-indigo-700">{bookingStats.total}</span><p className="text-xs text-indigo-600">Total</p></div>
              <div><span className="text-xl font-bold text-green-700">{bookingStats.reservasHoje}</span><p className="text-xs text-green-600">Hoje</p></div>
              <div><span className="text-xl font-bold text-blue-700">{bookingStats.checkinHoje}</span><p className="text-xs text-blue-600">Check-in hoje</p></div>
              <div><span className="text-xl font-bold text-purple-700">{bookingStats.reservasMes}</span><p className="text-xs text-purple-600">Este mês</p></div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {topKpis.map((k) => (
          <Card key={k.label}>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${k.color}`}>
                  <k.icon className="w-4 h-4" />
                </div>
              </div>
              <p className="text-xl font-bold">{k.value}</p>
              <p className="text-xs text-muted-foreground">{k.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Revenue by Park / City */}
      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Building2 className="w-4 h-4" /> Receita por Parque
            </CardTitle>
          </CardHeader>
          <CardContent>
            {kpis.byPark.length > 0 ? (
              <div className="space-y-3">
                {kpis.byPark.map((p) => {
                  const pct = kpis.totalRevenue > 0 ? (p.revenue / kpis.totalRevenue) * 100 : 0;
                  return (
                    <div key={p.name}>
                      <div className="flex items-center justify-between text-sm mb-1">
                        <span className="truncate font-medium">{p.name}</span>
                        <span className="text-muted-foreground ml-2 shrink-0">
                          {fmtCents(p.revenue)} ({fmtNum(p.bookings)} res.)
                        </span>
                      </div>
                      <div className="h-2 bg-muted rounded-full overflow-hidden">
                        <div className="h-full bg-indigo-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Sem dados</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <MapPin className="w-4 h-4" /> Receita por Cidade
            </CardTitle>
          </CardHeader>
          <CardContent>
            {kpis.byCity.length > 0 ? (
              <div className="space-y-3">
                {kpis.byCity.map((c) => {
                  const pct = kpis.totalRevenue > 0 ? (c.revenue / kpis.totalRevenue) * 100 : 0;
                  return (
                    <div key={c.name}>
                      <div className="flex items-center justify-between text-sm mb-1">
                        <span className="font-medium">{c.name}</span>
                        <span className="text-muted-foreground">
                          {fmtCents(c.revenue)} ({fmtNum(c.bookings)} res.)
                        </span>
                      </div>
                      <div className="h-2 bg-muted rounded-full overflow-hidden">
                        <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Sem dados</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Campaigns */}
      {Object.keys(kpis.campaigns).length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <TrendingUp className="w-4 h-4" /> Campanhas Externas (Agentes)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {Object.entries(kpis.campaigns)
                .sort((a, b) => (b[1] as number) - (a[1] as number))
                .map(([name, count]) => (
                  <Badge key={name} variant="outline" className="text-sm py-1 px-3">
                    {name}: <span className="font-bold ml-1">{fmtNum(count as number)}</span>
                  </Badge>
                ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Daily trend */}
      {kpis.byDay.length > 1 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <BarChart3 className="w-4 h-4" /> Evolução Diária
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left p-2 font-medium">Data</th>
                    <th className="text-right p-2 font-medium">Reservas</th>
                    <th className="text-right p-2 font-medium">Receita</th>
                    <th className="text-right p-2 font-medium">Check-ins</th>
                    <th className="text-right p-2 font-medium">Check-outs</th>
                  </tr>
                </thead>
                <tbody>
                  {kpis.byDay.map((d) => (
                    <tr key={d.date} className="border-t">
                      <td className="p-2">{new Date(d.date).toLocaleDateString("pt-PT")}</td>
                      <td className="p-2 text-right font-medium">{fmtNum(d.bookings)}</td>
                      <td className="p-2 text-right text-green-600">{fmtCents(d.revenue)}</td>
                      <td className="p-2 text-right">{fmtNum(d.checkins)}</td>
                      <td className="p-2 text-right">{fmtNum(d.checkouts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Bookings Tab (synced from API) ──────────────────────────────────────────
function BookingsTab({ statusFilter: statusFilterProp }: { statusFilter?: string[] }) {
  const today = new Date();
  // Filtros persistem à navegação (pedido do Jorge)
  const [from, setFrom] = usePersistedState("mpk.bookings.from", today.toISOString().slice(0, 10));
  const [to, setTo] = usePersistedState("mpk.bookings.to", today.toISOString().slice(0, 10));
  const [statusFilter, setStatusFilter] = usePersistedState<string>("mpk.bookings.status", "all");
  const [searchTerm, setSearchTerm] = usePersistedState("mpk.bookings.search", "");
  const [viewMode, setViewMode] = usePersistedState<"today" | "range" | "month">("mpk.bookings.view", "today");

  // Month selector
  const [selectedMonth, setSelectedMonth] = useState(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`);

  const queryDates = useMemo(() => {
    if (viewMode === "today") {
      const d = today.toISOString().slice(0, 10);
      return { from: d, to: d };
    }
    if (viewMode === "month") {
      const [y, m] = selectedMonth.split("-").map(Number);
      const start = new Date(y, m - 1, 1);
      const end = new Date(y, m, 0);
      return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
    }
    return { from, to };
  }, [viewMode, from, to, selectedMonth]);

  const { data: rawBookings = [], isLoading, refetch } = trpc.multipark.bookings.useQuery({
    from: queryDates.from,
    to: queryDates.to + "T23:59:59.999Z",
    status: statusFilter !== "all" ? statusFilter : undefined,
    search: searchTerm || undefined,
    limit: 1000,
  }, {
    // Com o webhook das Conexões, as reservas entram na BD em segundos —
    // refresca sozinho para não parecer que só chegam com o botão de sync.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  // Filter by section status (from sidebar nav)
  const bookings = useMemo(() => {
    if (!statusFilterProp?.length) return rawBookings;
    return rawBookings.filter(b => statusFilterProp.includes(b.status || ""));
  }, [rawBookings, statusFilterProp]);

  // Aggregate stats from visible bookings
  const stats = useMemo(() => {
    const s = {
      total: bookings.length,
      totalRevenue: 0,
      byStatus: {} as Record<string, number>,
      byPark: {} as Record<string, { count: number; revenue: number }>,
      byCity: {} as Record<string, { count: number; revenue: number }>,
      withDelivery: 0,
      avgPrice: 0,
    };
    for (const b of bookings) {
      const price = parseFloat(b.totalPrice || "0");
      s.totalRevenue += price;
      s.byStatus[b.status || "UNKNOWN"] = (s.byStatus[b.status || "UNKNOWN"] || 0) + 1;
      if (b.deliveryService) s.withDelivery++;

      const park = b.parkName || "Desconhecido";
      if (!s.byPark[park]) s.byPark[park] = { count: 0, revenue: 0 };
      s.byPark[park].count++;
      s.byPark[park].revenue += price;

      const city = b.city || "Desconhecida";
      if (!s.byCity[city]) s.byCity[city] = { count: 0, revenue: 0 };
      s.byCity[city].count++;
      s.byCity[city].revenue += price;
    }
    s.avgPrice = s.total > 0 ? s.totalRevenue / s.total : 0;
    return s;
  }, [bookings]);

  const viewLabel = viewMode === "today" ? "Hoje" : viewMode === "month"
    ? new Date(parseInt(selectedMonth.split("-")[0]), parseInt(selectedMonth.split("-")[1]) - 1).toLocaleDateString("pt-PT", { month: "long", year: "numeric" })
    : `${fmtDate(queryDates.from)} — ${fmtDate(queryDates.to)}`;

  return (
    <div className="space-y-4 mt-4">
      {/* View mode + filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label className="text-xs mb-1 block">Vista</Label>
          <Select value={viewMode} onValueChange={(v) => setViewMode(v as any)}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="today">Hoje</SelectItem>
              <SelectItem value="month">Por Mês</SelectItem>
              <SelectItem value="range">Intervalo</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {viewMode === "month" && (
          <div>
            <Label className="text-xs mb-1 block">Mês</Label>
            <Input type="month" value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)} className="w-44" />
          </div>
        )}
        {viewMode === "range" && (
          <>
            <div>
              <Label className="text-xs mb-1 block">De</Label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
            </div>
            <div>
              <Label className="text-xs mb-1 block">Até</Label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
            </div>
          </>
        )}

        {!statusFilterProp?.length && (
          <div>
            <Label className="text-xs mb-1 block">Estado</Label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                {Object.entries(STATUS_MAP).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div>
          <Label className="text-xs mb-1 block">Pesquisar</Label>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-muted-foreground" />
            <Input
              placeholder="Nome, matrícula, email..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-8 w-56"
            />
          </div>
        </div>

        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => refetch()}>
          <RefreshCw className="w-3.5 h-3.5" /> Atualizar
        </Button>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-2xl font-bold">{stats.total}</p>
            <p className="text-xs text-muted-foreground">Reservas ({viewLabel})</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-2xl font-bold text-green-600">{fmtEur(stats.totalRevenue)}</p>
            <p className="text-xs text-muted-foreground">Receita Total</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-2xl font-bold text-blue-600">{fmtEur(stats.avgPrice)}</p>
            <p className="text-xs text-muted-foreground">Ticket Médio</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-2xl font-bold text-purple-600">{stats.withDelivery}</p>
            <p className="text-xs text-muted-foreground">Com Entrega</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex flex-wrap gap-1">
              {Object.entries(stats.byStatus).map(([status, count]) => {
                const s = STATUS_MAP[status] || { label: status, color: "bg-gray-100 text-gray-800" };
                return (
                  <Badge key={status} className={`${s.color} text-xs`}>
                    {s.label}: {count}
                  </Badge>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Por estado</p>
          </CardContent>
        </Card>
      </div>

      {/* Revenue by park/city summary */}
      {stats.total > 0 && (
        <div className="grid md:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Por Parque</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {Object.entries(stats.byPark)
                  .sort((a, b) => b[1].revenue - a[1].revenue)
                  .map(([name, d]) => (
                    <div key={name} className="flex justify-between text-sm">
                      <span className="truncate font-medium">{name}</span>
                      <span className="text-muted-foreground shrink-0 ml-2">
                        {fmtEur(d.revenue)} ({d.count} res.)
                      </span>
                    </div>
                  ))}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Por Cidade</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {Object.entries(stats.byCity)
                  .sort((a, b) => b[1].revenue - a[1].revenue)
                  .map(([name, d]) => (
                    <div key={name} className="flex justify-between text-sm">
                      <span className="font-medium">{name}</span>
                      <span className="text-muted-foreground">
                        {fmtEur(d.revenue)} ({d.count} res.)
                      </span>
                    </div>
                  ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Bookings table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center justify-between">
            <span className="flex items-center gap-2">
              <CreditCard className="w-4 h-4" /> Reservas ({stats.total})
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-8 text-center text-muted-foreground">A carregar reservas...</div>
          ) : bookings.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              <Calendar className="w-10 h-10 mx-auto mb-3 opacity-50" />
              <p>Sem reservas para o período selecionado</p>
              <p className="text-xs mt-1">Usa a tab "Sincronização" para importar dados da API</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left p-2 font-medium">Reserva</th>
                    <th className="text-left p-2 font-medium">Cliente</th>
                    <th className="text-left p-2 font-medium">Viatura</th>
                    <th className="text-left p-2 font-medium">Parque</th>
                    <th className="text-left p-2 font-medium">Check-in</th>
                    <th className="text-left p-2 font-medium">Check-out</th>
                    <th className="text-right p-2 font-medium">Valor</th>
                    <th className="text-left p-2 font-medium">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {bookings.map((b: any) => {
                    const s = STATUS_MAP[b.status] || { label: b.status || "—", color: "bg-gray-100 text-gray-800" };
                    return (
                      <tr key={b.id} className="border-t hover:bg-muted/30">
                        <td className="p-2">
                          <span className="font-mono text-xs">{b.bookingNumber || b.externalId?.slice(0, 12)}</span>
                          {b.campaign && (
                            <Badge variant="outline" className="ml-1 text-[10px] py-0">{b.campaign}</Badge>
                          )}
                        </td>
                        <td className="p-2">
                          <div className="text-xs">
                            <span className="font-medium">{[b.clientFirstName, b.clientLastName].filter(Boolean).join(" ") || "—"}</span>
                            {b.clientEmail && <p className="text-muted-foreground truncate max-w-[150px]">{b.clientEmail}</p>}
                          </div>
                        </td>
                        <td className="p-2">
                          <span className="font-mono text-xs">{b.licensePlate || "—"}</span>
                          {b.vehicleBrand && <span className="text-muted-foreground text-xs ml-1">{b.vehicleBrand}</span>}
                        </td>
                        <td className="p-2 text-xs">
                          <span className="font-medium">{b.parkName || "—"}</span>
                          {b.city && <p className="text-muted-foreground">{b.city}</p>}
                        </td>
                        <td className="p-2 text-xs">
                          {fmtBookingDate(b.checkIn)}
                          {b.checkInTime && <span className="text-muted-foreground ml-1">{fmtBookingHHmm(b.checkInTime)}</span>}
                        </td>
                        <td className="p-2 text-xs">
                          {fmtBookingDate(b.checkOut)}
                          {b.checkOutTime && <span className="text-muted-foreground ml-1">{fmtBookingHHmm(b.checkOutTime)}</span>}
                        </td>
                        <td className="p-2 text-right font-medium text-green-700">
                          {fmtEur(b.totalPrice)}
                          {b.deliveryService ? (
                            <Badge variant="outline" className="ml-1 text-[10px] py-0">Entrega</Badge>
                          ) : null}
                        </td>
                        <td className="p-2">
                          <Badge className={`${s.color} text-[10px]`}>{s.label}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Filter Bar (reused in Dashboard) ────────────────────────────────────────
function FilterBar({ from, to, city, onFromChange, onToChange, onCityChange, cities }: {
  from: string; to: string; city: string;
  onFromChange: (v: string) => void; onToChange: (v: string) => void; onCityChange: (v: string) => void;
  cities: string[];
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div>
        <Label className="text-xs mb-1 block">De</Label>
        <Input type="date" value={from} onChange={(e) => onFromChange(e.target.value)} className="w-40" />
      </div>
      <div>
        <Label className="text-xs mb-1 block">Até</Label>
        <Input type="date" value={to} onChange={(e) => onToChange(e.target.value)} className="w-40" />
      </div>
      {cities.length > 0 && (
        <div>
          <Label className="text-xs mb-1 block">Cidade</Label>
          <Select value={city} onValueChange={onCityChange}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Todas" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas</SelectItem>
              {cities.map((c) => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}

// ─── Availability Tab ─────────────────────────────────────────────────────────
function AvailabilityTab() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayAfter = new Date();
  dayAfter.setDate(dayAfter.getDate() + 3);
  const dateFmt = (d: Date) => d.toISOString().split("T")[0];

  const [checkIn, setCheckIn] = useState(dateFmt(tomorrow));
  const [checkOut, setCheckOut] = useState(dateFmt(dayAfter));
  const [vehicleType, setVehicleType] = useState("CAR");
  const [parkingType, setParkingType] = useState("COVERED");
  const [doQuery, setDoQuery] = useState(false);

  const queryInput = useMemo(() => ({
    checkIn, checkOut,
    vehicleType: vehicleType as any,
    parkingType: parkingType as any,
  }), [checkIn, checkOut, vehicleType, parkingType]);

  const { data, isLoading, refetch } = trpc.multipark.checkAvailability.useQuery(queryInput, {
    enabled: doQuery,
    retry: false,
  });

  const handleCheck = () => {
    if (!checkIn || !checkOut) { toast.error("Seleciona as datas"); return; }
    setDoQuery(true);
    refetch();
  };

  return (
    <div className="space-y-6 mt-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Verificar Disponibilidade</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <Label className="text-xs">Check-in</Label>
              <Input type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Check-out</Label>
              <Input type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Veículo</Label>
              <Select value={vehicleType} onValueChange={setVehicleType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(VEHICLE_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Tipo</Label>
              <Select value={parkingType} onValueChange={setParkingType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(PARKING_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button onClick={handleCheck} disabled={isLoading} className="gap-2">
            {isLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Calendar className="w-4 h-4" />}
            Verificar
          </Button>
        </CardContent>
      </Card>

      {data && (
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className={`w-16 h-16 rounded-full flex items-center justify-center ${data.available ? "bg-green-100" : "bg-red-100"}`}>
                {data.available ? <CheckCircle2 className="w-8 h-8 text-green-600" /> : <XCircle className="w-8 h-8 text-red-600" />}
              </div>
              <div>
                <h3 className="text-lg font-bold">{data.available ? "Disponível" : "Sem disponibilidade"}</h3>
                <p className="text-sm text-muted-foreground">{data.message}</p>
                <p className="text-sm mt-1">
                  <span className="font-medium">{data.availableSpots}</span> de{" "}
                  <span className="font-medium">{data.totalSpots}</span> lugares livres
                </p>
              </div>
            </div>
            <div className="mt-4">
              <div className="h-3 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${data.availableSpots / data.totalSpots > 0.3 ? "bg-green-500" : data.availableSpots / data.totalSpots > 0.1 ? "bg-yellow-500" : "bg-red-500"}`}
                  style={{ width: `${((data.totalSpots - data.availableSpots) / data.totalSpots) * 100}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Ocupação: {((data.totalSpots - data.availableSpots) / data.totalSpots * 100).toFixed(0)}%
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Parks Tab ────────────────────────────────────────────────────────────────
function ParksTab() {
  const { data, isLoading } = trpc.multipark.listParks.useQuery();
  if (isLoading) return <div className="py-12 text-center text-muted-foreground">A carregar parques...</div>;
  const parks = (data as any)?.parks || data || [];

  return (
    <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {parks.map((park: any) => (
        <Card key={park.id} className="hover:shadow-md transition-shadow">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center shrink-0">
                <MapPin className="w-5 h-5 text-blue-600" />
              </div>
              <div className="min-w-0">
                <h3 className="font-semibold truncate">{park.name}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">{park.address}</p>
                {park.lat && park.lng && (
                  <a
                    href={`https://www.google.com/maps?q=${park.lat},${park.lng}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-600 hover:underline mt-1 inline-block"
                  >
                    Ver no Google Maps →
                  </a>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
      {parks.length === 0 && (
        <Card className="col-span-full">
          <CardContent className="py-12 text-center text-muted-foreground">
            Nenhum parque encontrado
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Sync Tab ────────────────────────────────────────────────────────────────
function SyncTab() {
  const today = new Date();
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const [syncFrom, setSyncFrom] = useState(weekAgo.toISOString().slice(0, 10));
  const [syncTo, setSyncTo] = useState(today.toISOString().slice(0, 10));
  const [lastSyncResult, setLastSyncResult] = useState<any>(null);

  const { data: logs = [], isLoading, refetch } = trpc.multipark.syncLogs.useQuery();
  const syncMut = trpc.multipark.triggerSync.useMutation();
  const enrichMut = trpc.multipark.enrichBatch.useMutation();
  const historyMut = trpc.multipark.syncHistoryBatch.useMutation();
  const utils = trpc.useUtils();

  const handleEnrich = async () => {
    try {
      const result = await enrichMut.mutateAsync({ limit: 200 });
      if (result.scanned === 0) {
        toast.info("Não há reservas por enriquecer.");
      } else {
        const noKey = (result as any).noKey ?? 0;
        toast.success(
          `Enriquecidas ${result.enriched} de ${result.scanned} reservas` +
          ` (${result.errors} erros API, ${noKey} sem chave).`
        );
      }
      utils.multipark.bookings.invalidate();
    } catch (err: any) {
      toast.error(err.message || "Erro a enriquecer");
    }
  };

  const handleSync = async () => {
    if (!syncFrom || !syncTo) {
      toast.error("Seleciona as datas de início e fim");
      return;
    }
    // Range muito grande? Pede confirmação — a API Multipark cobra por chamada
    // e períodos longos podem demorar minutos.
    const days = Math.round((new Date(syncTo).getTime() - new Date(syncFrom).getTime()) / 86_400_000) + 1;
    if (days > 31 && !confirm(`O período tem ${days} dias. A sincronização vai puxar todas as ações (criação/check-in/check-out/cancelamento) da API e pode demorar vários minutos. Continuar?`)) {
      return;
    }
    try {
      const result = await syncMut.mutateAsync({
        startDate: syncFrom,
        endDate: syncTo,
      });
      setLastSyncResult(result);
      if (result.success) {
        toast.success(`Sincronização concluída: ${result.processed} processadas, ${result.created} novas`);
      } else {
        toast.warning(`Sincronização parcial: ${result.errors?.length || 0} erros`);
      }
      utils.multipark.syncLogs.invalidate();
      utils.multipark.bookings.invalidate();
      utils.multipark.bookingStats.invalidate();
      utils.multipark.kpis.invalidate();
      refetch();
    } catch (err: any) {
      toast.error(err.message || "Erro na sincronização");
    }
  };

  return (
    <div className="space-y-4 mt-4">
      {/* Manual sync */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <RefreshCw className="w-4 h-4" /> Sincronizar Reservas da API
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Busca reservas diretamente da API MultiPark para o período selecionado.
            Inclui criações, check-ins, check-outs e cancelamentos. Dados existentes são atualizados, sem duplicação.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label className="text-xs mb-1 block">De</Label>
              <Input type="date" value={syncFrom} onChange={(e) => setSyncFrom(e.target.value)} className="w-40" />
            </div>
            <div>
              <Label className="text-xs mb-1 block">Até</Label>
              <Input type="date" value={syncTo} onChange={(e) => setSyncTo(e.target.value)} className="w-40" />
            </div>
            <Button onClick={handleSync} disabled={syncMut.isPending} className="gap-2">
              {syncMut.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              Sincronizar
            </Button>
          </div>

          <div className="bg-muted/50 rounded-lg p-3 text-xs text-muted-foreground space-y-1">
            <p>A sincronização automática corre a cada 15 minutos (últimos 2 dias).</p>
            <p>Usa este formulário para importar histórico mais antigo ou forçar uma atualização.</p>
          </div>

          <div className="border-t pt-3 flex items-center justify-between gap-3">
            <div className="text-sm">
              <div className="font-medium">Enriquecer reservas (recolha/entrega)</div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Vai à API individual de cada reserva e guarda <strong>deliveryType</strong>{" "}
                (Terminal 1, Oriente, etc.), <strong>voos</strong> e <strong>notas do cliente</strong>.
                Processa 200 reservas por execução. Corre várias vezes até não haver mais.
              </p>
            </div>
            <Button onClick={handleEnrich} disabled={enrichMut.isPending} variant="outline" className="gap-2 shrink-0">
              {enrichMut.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              Enriquecer 200
            </Button>
          </div>

          <div className="border-t pt-3 flex items-center justify-between gap-3">
            <div className="text-sm">
              <div className="font-medium">Histórico das reservas (timeline)</div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Para cada reserva (últimos 7d + próximos 30d), busca o histórico
                completo: check-in, movimentos, check-out, com <strong>agente responsável</strong>,{" "}
                <strong>garagem/lugar</strong> e <strong>quilometragem</strong>. 50 por execução.
              </p>
            </div>
            <Button
              onClick={async () => {
                try {
                  const r = await historyMut.mutateAsync({ limit: 50 });
                  if (r.scanned === 0) toast.info("Sem reservas pendentes de history.");
                  else toast.success(`History: ${r.fetched}/${r.scanned} (${r.errors} erros, ${r.noKey} sem chave)`);
                  utils.multipark.bookings.invalidate();
                } catch (e: any) { toast.error(e.message || "Erro"); }
              }}
              disabled={historyMut.isPending}
              variant="outline"
              className="gap-2 shrink-0"
            >
              {historyMut.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              Buscar history 50
            </Button>
          </div>
        </CardContent>
      </Card>

      <HistoricalBackfillCard />

      {/* Last sync result */}
      {lastSyncResult && (
        <Card className={lastSyncResult.success ? "border-green-200 bg-green-50/50" : "border-yellow-200 bg-yellow-50/50"}>
          <CardContent className="p-4">
            <div className="flex gap-3">
              {lastSyncResult.success ? (
                <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-5 h-5 text-yellow-600 shrink-0 mt-0.5" />
              )}
              <div className="text-sm w-full">
                <p className="font-medium">{lastSyncResult.success ? "Sincronização concluída" : "Sincronização com avisos"}</p>
                <div className="grid grid-cols-3 gap-4 mt-3">
                  <div>
                    <p className="text-2xl font-bold">{lastSyncResult.processed}</p>
                    <p className="text-xs text-muted-foreground">Processadas</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-green-700">{lastSyncResult.created}</p>
                    <p className="text-xs text-green-600">Novas</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-blue-700">{lastSyncResult.updated}</p>
                    <p className="text-xs text-blue-600">Atualizadas</p>
                  </div>
                </div>
                {lastSyncResult.errors?.length > 0 && (
                  <div className="mt-3 text-xs text-red-600">
                    <p className="font-medium">Erros:</p>
                    {lastSyncResult.errors.slice(0, 5).map((e: string, i: number) => (
                      <p key={i}>• {e}</p>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Sync log history */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <History className="w-4 h-4" /> Histórico de Operações
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground py-4 text-center">A carregar...</p>
          ) : logs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">Nenhuma operação registada</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left p-2 font-medium">Data</th>
                    <th className="text-left p-2 font-medium">Tipo</th>
                    <th className="text-left p-2 font-medium">Estado</th>
                    <th className="text-right p-2 font-medium">Processados</th>
                    <th className="text-right p-2 font-medium">Criados</th>
                    <th className="text-right p-2 font-medium">Atualizados</th>
                    <th className="text-left p-2 font-medium">Erro</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log: any) => (
                    <tr key={log.id} className="border-t">
                      <td className="p-2 text-xs">
                        {log.startedAt ? new Date(log.startedAt).toLocaleString("pt-PT") : "—"}
                      </td>
                      <td className="p-2">
                        <Badge variant="outline" className="text-xs">
                          {log.syncType === "excel_import" ? "Excel" : log.syncType === "api_sync" ? "API" : log.syncType === "manual" ? "Manual" : log.syncType}
                        </Badge>
                      </td>
                      <td className="p-2">
                        {log.status === "success" ? (
                          <Badge className="bg-green-600 text-xs">OK</Badge>
                        ) : log.status === "partial" ? (
                          <Badge className="bg-yellow-600 text-xs">Parcial</Badge>
                        ) : (
                          <Badge variant="destructive" className="text-xs">Erro</Badge>
                        )}
                      </td>
                      <td className="p-2 text-right">{log.recordsProcessed ?? 0}</td>
                      <td className="p-2 text-right">{log.recordsCreated ?? 0}</td>
                      <td className="p-2 text-right">{log.recordsUpdated ?? 0}</td>
                      <td className="p-2 text-xs text-red-600 max-w-[200px] truncate">
                        {log.errorMessage || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Import Tab ──────────────────────────────────────────────────────────────
function ImportTab() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [lastResult, setLastResult] = useState<any>(null);
  const importMut = trpc.multipark.importExcel.useMutation();
  const utils = trpc.useUtils();

  const handleFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith(".xlsx") && !file.name.endsWith(".xls")) {
      toast.error("Ficheiro tem que ser Excel (.xlsx ou .xls)");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error("Ficheiro demasiado grande (máx 10MB)");
      return;
    }

    setImporting(true);
    try {
      const buffer = await file.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), "")
      );
      const result = await importMut.mutateAsync({
        fileBase64: base64,
        filename: file.name,
      });
      setLastResult(result);
      toast.success(`Importação concluída: ${result.rowsParsed} reservas → ${result.snapshotsCreated + result.snapshotsUpdated} snapshots`);
      utils.multipark.kpis.invalidate();
      utils.multipark.syncLogs.invalidate();
    } catch (err: any) {
      toast.error(err.message || "Erro na importação");
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [importMut, utils]);

  return (
    <div className="space-y-6 mt-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Upload className="w-4 h-4" /> Importar Excel do MultiPark
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Exporta as reservas do backoffice MultiPark em Excel e importa aqui para KPIs agregados.
            Para reservas individuais, usa a sincronização via API na tab "Sincronização".
          </p>

          <div
            className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer hover:border-indigo-400 hover:bg-indigo-50/50 transition-colors"
            onClick={() => fileRef.current?.click()}
          >
            {importing ? (
              <div className="flex flex-col items-center gap-3">
                <RefreshCw className="w-10 h-10 text-indigo-500 animate-spin" />
                <p className="text-sm font-medium">A processar ficheiro...</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <FileSpreadsheet className="w-10 h-10 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Clica para selecionar ficheiro Excel</p>
                  <p className="text-xs text-muted-foreground mt-1">Formatos: .xlsx, .xls (máx 10MB)</p>
                </div>
              </div>
            )}
          </div>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleFile} />
        </CardContent>
      </Card>

      {lastResult && (
        <Card className="border-green-200 bg-green-50/50">
          <CardContent className="p-4">
            <div className="flex gap-3">
              <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-green-900">Importação concluída</p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-3">
                  <div><p className="text-2xl font-bold text-green-700">{lastResult.rowsParsed}</p><p className="text-xs text-green-600">Reservas processadas</p></div>
                  <div><p className="text-2xl font-bold text-green-700">{lastResult.totalGroups}</p><p className="text-xs text-green-600">Grupos (dia/parque)</p></div>
                  <div><p className="text-2xl font-bold text-green-700">{lastResult.snapshotsCreated}</p><p className="text-xs text-green-600">Snapshots criados</p></div>
                  <div><p className="text-2xl font-bold text-green-700">{lastResult.snapshotsUpdated}</p><p className="text-xs text-green-600">Snapshots atualizados</p></div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Backfill histórico: itera dia-a-dia chamando admin.runHistoricalDaySync ─

function HistoricalBackfillCard() {
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(yearStart);
  const [to, setTo] = useState(today);
  const [running, setRunning] = useState(false);
  const [stop, setStop] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; lastDate: string; totalProcessed: number; totalCreated: number; totalUpdated: number; totalEnriched: number; totalHistory: number; errors: string[] }>({
    done: 0, total: 0, lastDate: "", totalProcessed: 0, totalCreated: 0, totalUpdated: 0, totalEnriched: 0, totalHistory: 0, errors: [],
  });
  const daySyncMut = trpc.admin.runHistoricalDaySync.useMutation();
  const utils = trpc.useUtils();

  const dayList = (a: string, b: string): string[] => {
    const out: string[] = [];
    const start = new Date(a + "T00:00:00");
    const end = new Date(b + "T00:00:00");
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return out;
    const d = new Date(start);
    while (d <= end) {
      out.push(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }
    return out;
  };

  const run = async () => {
    const days = dayList(from, to);
    if (days.length === 0) { toast.error("Range inválido"); return; }
    setRunning(true);
    setStop(false);
    setProgress({ done: 0, total: days.length, lastDate: "", totalProcessed: 0, totalCreated: 0, totalUpdated: 0, totalEnriched: 0, totalHistory: 0, errors: [] });
    let totalProcessed = 0, totalCreated = 0, totalUpdated = 0, totalEnriched = 0, totalHistory = 0;
    const errors: string[] = [];
    for (let i = 0; i < days.length; i++) {
      if (stop) break;
      const date = days[i];
      try {
        const r = await daySyncMut.mutateAsync({ date });
        totalProcessed += r.report.processed;
        totalCreated += r.report.created;
        totalUpdated += r.report.updated;
        totalEnriched += r.enriched;
        totalHistory += r.historyFetched;
        if (r.report.errors.length > 0) errors.push(`${date}: ${r.report.errors.slice(0, 2).join(" | ")}`);
      } catch (e: any) {
        errors.push(`${date}: ${e?.message ?? "erro"}`);
      }
      setProgress({ done: i + 1, total: days.length, lastDate: date, totalProcessed, totalCreated, totalUpdated, totalEnriched, totalHistory, errors });
    }
    setRunning(false);
    utils.multipark.bookings.invalidate();
    utils.multipark.bookingStats.invalidate();
    utils.multipark.kpis.invalidate();
    utils.multipark.syncLogs.invalidate();
    toast.success(`Histórico concluído: ${totalProcessed} reservas processadas (${totalCreated} novas) em ${days.length} dias`);
  };

  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <Card className="border-blue-200 bg-blue-50/30">
      <CardHeader>
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Download className="w-4 h-4 text-blue-600" /> Importar Histórico (1× para puxar tudo desde o início do ano)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Itera dia-a-dia o range escolhido. Cada dia faz <strong>report + enrich + history</strong> em paralelo
          (cabe nos 60s do Vercel). Podes parar a qualquer altura e retomar depois mudando "De".
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label className="text-xs mb-1 block">De</Label>
            <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="w-40" disabled={running} />
          </div>
          <div>
            <Label className="text-xs mb-1 block">Até</Label>
            <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="w-40" disabled={running} />
          </div>
          {!running ? (
            <Button onClick={run} className="gap-2">
              <Download className="w-4 h-4" /> Importar {dayList(from, to).length} dias
            </Button>
          ) : (
            <Button variant="destructive" onClick={() => setStop(true)}>
              <XCircle className="w-4 h-4 mr-1" /> Parar
            </Button>
          )}
        </div>

        {(running || progress.done > 0) && (
          <div className="space-y-2 text-sm">
            <div className="h-2 bg-blue-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-600 transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {progress.done}/{progress.total} dias ({pct}%){progress.lastDate ? ` · último: ${progress.lastDate}` : ""}
            </p>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
              <div><strong>{progress.totalProcessed}</strong> processadas</div>
              <div className="text-green-700"><strong>{progress.totalCreated}</strong> novas</div>
              <div className="text-blue-700"><strong>{progress.totalUpdated}</strong> actualizadas</div>
              <div><strong>{progress.totalEnriched}</strong> enriquecidas</div>
              <div><strong>{progress.totalHistory}</strong> history</div>
            </div>
            {progress.errors.length > 0 && (
              <div className="text-xs text-red-600 mt-2">
                <p className="font-medium">{progress.errors.length} dias com avisos:</p>
                {progress.errors.slice(0, 5).map((e, i) => <p key={i}>• {e}</p>)}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
