import { classifyBookingOrigin as classifyOrigin } from "@shared/bookingOrigin";
import { ORIGIN_GROUPS, ORIGIN_GROUP_LABELS, CHANNEL_LABELS, type OriginGroup } from "@shared/originGroup";
import { OpsDailyPanel } from "@/components/operacoes/OpsDailyPanel";
import { SyncHealthPanel } from "@/components/operacoes/SyncHealthPanel";
import { can, scopeFor } from "@shared/access";
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
import BookingDetailDialog from "@/components/BookingDetailDialog";
import { toast } from "sonner";
import { useState, useMemo, useEffect } from "react";
import { useParams } from "wouter";
import { usePersistedState } from "@/hooks/usePersistedState";
import { fmtBookingDateTime, fmtBookingDate, fmtBookingHHmm } from "@/lib/lisbonTime";
import {
  ParkingCircle, Wifi, RefreshCw, Calendar, Car, Truck, Bike,
  MapPin, Clock, CheckCircle2, XCircle, AlertCircle, BarChart3, History, Building2,
  TrendingUp, DollarSign, ArrowDownToLine, ArrowUpFromLine,
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
    subtitle: "Estado da sincronização com a API MultiPark e reparação de períodos",
    icon: RefreshCw,
  },
};

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function MultiparkPage({ sectionProp }: { sectionProp?: string } = {}) {
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
        </div>

        {/* Content based on section */}
        {section === "sync" ? (
          <div className="space-y-6">
            <SyncTab />
          </div>
        ) : config.actionType ? (
          <ActionTypeTab actionType={config.actionType} />
        ) : null}
      </div>
    </>
  );
}

// ─── Action Type Tab (BD local; filtros e totais no SERVIDOR) ────────────────
const PAGE_SIZE = 500;

function ActionTypeTab({ actionType }: { actionType: "creation" | "checkin" | "checkout" | "cancelation" }) {
  const globalFilters = useGlobalFilters();
  const utils = trpc.useUtils();
  const [defFrom, defTo] = thisMonthRange();
  // Filtros PARTILHADOS entre as abas das Operações (pedido do Jorge:
  // "ponho um filtro nas Reservas e mudo para Recolhas — ele fica"):
  // datas, projeto, pesquisa, grupo e canal seguem contigo de aba para aba.
  const [startDate, setStartDate] = usePersistedState("mpk.shared.start", defFrom);
  const [endDate, setEndDate] = usePersistedState("mpk.shared.end", defTo);
  const [activeRange, setActiveRange] = usePersistedState<string>("mpk.shared.range", "thisMonth");
  const [searchTerm, setSearchTerm] = usePersistedState("mpk.shared.search", "");
  const [projectId, setProjectId] = usePersistedState<string>("mpk.shared.project", "");
  const [lastGlobalProject, setLastGlobalProject] = usePersistedState<string>("mpk.shared.globalProject", "__initial__");
  // Grupo (Lisboa/Porto/Faro/Marketplace) e canal de venda (secundário)
  const [groupFilter, setGroupFilter] = usePersistedState<string>("mpk.shared.group", "all");
  const [channelFilter, setChannelFilter] = usePersistedState<string>("mpk.shared.channel", "all");
  // Estado real vs previsto: por aba ("recolhidas" não faz sentido nas entregas).
  const [stateFilter, setStateFilter] = usePersistedState<string>(`mpk.${actionType}.state`, "all");
  const [detailExternalId, setDetailExternalId] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [exporting, setExporting] = useState(false);

  // Pesquisa vai ao servidor com um pequeno atraso (não a cada tecla)
  const [debouncedSearch, setDebouncedSearch] = useState(searchTerm);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchTerm), 350);
    return () => clearTimeout(t);
  }, [searchTerm]);

  // Limpar o filtro global também limpa a seleção local da aba.
  useEffect(() => {
    const next = globalFilters.projectId !== undefined ? String(globalFilters.projectId) : "";
    if (next !== lastGlobalProject) {
      setProjectId(next);
      setLastGlobalProject(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalFilters.projectId, lastGlobalProject]);
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

  const baseInput = {
    startDate, endDate, actionType,
    projectId: projectId ? Number(projectId) : undefined,
    group: groupFilter as any,
    channel: channelFilter,
    state: (actionType === "cancelation" ? "all" : stateFilter) as any,
    search: debouncedSearch || undefined,
  };
  // Nova pesquisa/filtro → volta à primeira página
  const filterKey = JSON.stringify(baseInput);
  useEffect(() => { setLimit(PAGE_SIZE); }, [filterKey]);

  const { data, isLoading, isFetching, refetch } = trpc.multipark.localBookingsByAction.useQuery(
    { ...baseInput, limit },
    { refetchOnWindowFocus: false, placeholderData: (prev) => prev },
  );
  const bookings: any[] = data?.bookings ?? [];
  const total = data?.total ?? 0;
  const totals = data?.summary ?? { revenue: 0, byPark: {}, partnerTotal: 0, toCollect: 0, paidOnline: 0, paidMB: 0, paidCash: 0, paidOther: 0, cancelledCount: 0, cancelledValue: 0 };

  const detailQ = trpc.multipark.bookingByExternalId.useQuery(
    { externalId: detailExternalId ?? "" },
    { enabled: !!detailExternalId },
  );
  const detailRow = bookings.find((b) => b.externalId === detailExternalId);

  // Ordenação por coluna (setas nos cabeçalhos) — dentro da página carregada
  const { sorted: sortedBookings, sortKey, sortDir, toggle } = useTableSort(bookings as any[]);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = await utils.multipark.localBookingsByAction.fetch({ ...baseInput, limit: 20000, offset: 0 });
      const headers = ["Reserva","Cliente","Email","Matrícula","Parque","Cidade","Grupo","Canal","Check-in","Check-out","Tipo Recolha/Entrega","Estado","Tipo Parque","Preço (c/ IVA)","Delivery","Extras","Desconto","Campanha"];
      const rows = (all.bookings as any[]).map(b => [
        b.bookingNumber || b.externalId || "",
        `${b.clientFirstName || ""} ${b.clientLastName || ""}`.trim().replace(/;/g, ","),
        (b.clientEmail || "").replace(/;/g, ","),
        b.licensePlate || "",
        (b.parkName || "").replace(/;/g, ","),
        b.city || "",
        ORIGIN_GROUP_LABELS[b.group as OriginGroup] ?? "",
        CHANNEL_LABELS[b.channel] ?? b.channel ?? "",
        b.checkIn || "",
        b.checkOut || "",
        b.deliveryType || "",
        b.status || "",
        b.parkingType || "",
        parseFloat(b.totalPrice || "0").toFixed(2),
        parseFloat(b.deliveryCharges || "0").toFixed(2),
        parseFloat(b.extrasTotal || "0").toFixed(2),
        parseFloat(b.discount || "0").toFixed(2),
        (b.campaign || "").replace(/;/g, ","),
      ]);
      const csv = [headers.join(";"), ...rows.map(r => r.join(";"))].join("\n");
      const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `reservas_${actionType}_${startDate}_${endDate}.csv`; a.click();
      URL.revokeObjectURL(url);
      if (all.hasMore) toast.warning("CSV limitado às primeiras 20.000 linhas — encurta o período.");
    } catch (e: any) {
      toast.error(e?.message ?? "Erro ao exportar");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4 min-w-0">
      {/* Atalhos de período */}
      <QuickRangeBar
        active={activeRange}
        onPick={(f, t, id) => { setStartDate(f); setEndDate(t); setActiveRange(id); }}
      />

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="mb-0.5 max-w-full">
          <DateRangeNav
            start={startDate}
            end={endDate}
            gran={(activeRange === "thisWeek" || activeRange === "lastWeek" ? "week" : activeRange === "thisMonth" || activeRange === "lastMonth" ? "month" : "custom") as any}
            showAll={false}
            onChange={(s, e) => { setStartDate(s); setEndDate(e); setActiveRange(""); }}
          />
        </div>
        {actionType !== "cancelation" && (
          <div>
            <Label className="text-xs mb-1 block">Estado</Label>
            <Select value={stateFilter} onValueChange={setStateFilter}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas</SelectItem>
                {actionType === "creation" ? <>
                  <SelectItem value="active">Não canceladas</SelectItem>
                  <SelectItem value="cancelled">Canceladas</SelectItem>
                </> : <>
                  <SelectItem value="done">{actionType === "checkin" ? "Recolhidas" : "Entregues"}</SelectItem>
                  <SelectItem value="pending">{actionType === "checkin" ? "Por recolher" : "Por entregar"}</SelectItem>
                </>}
              </SelectContent>
            </Select>
          </div>
        )}
        <div>
          <Label className="text-xs mb-1 block">Grupo</Label>
          <Select value={groupFilter} onValueChange={setGroupFilter}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os grupos</SelectItem>
              {ORIGIN_GROUPS.map((g) => (
                <SelectItem key={g} value={g}>{ORIGIN_GROUP_LABELS[g]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs mb-1 block">Canal</Label>
          <Select value={channelFilter} onValueChange={setChannelFilter}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os canais</SelectItem>
              {Object.entries(CHANNEL_LABELS).map(([id, label]) => (
                <SelectItem key={id} value={id}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs mb-1 block">Grupo / Projeto</Label>
          <Select value={projectId} onValueChange={v => setProjectId(v === "all" ? "" : v)}>
            <SelectTrigger className="w-56 max-w-full"><SelectValue placeholder="Todos" /></SelectTrigger>
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
        <div className="max-w-full">
          <Label className="text-xs mb-1 block">Pesquisar</Label>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-muted-foreground" />
            <Input
              placeholder="Nome, matrícula, email..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-8 w-56 max-w-full"
            />
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`w-4 h-4 mr-1 ${isFetching ? "animate-spin" : ""}`} />
          Atualizar
        </Button>
        <Button variant="outline" size="sm" disabled={total === 0 || exporting} onClick={exportCsv}>
          <Download className="w-4 h-4 mr-1" /> {exporting ? "A exportar…" : "CSV"}
        </Button>
      </div>

      {actionType === "creation" && data && (
        <p className="text-sm text-muted-foreground">
          <b className="text-foreground">{total}</b> reservas criadas: <b className="text-foreground">{data.active}</b> não canceladas e <b className="text-foreground">{data.cancelled}</b> canceladas.
          {" "}Valor cancelado: {fmtEur(totals.cancelledValue)} (c/ IVA). Os valores financeiros abaixo referem-se apenas às não canceladas.
        </p>
      )}
      {actionType === "cancelation" && data && data.approxDates > 0 && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          {data.approxDates} de {total} sem data de cancelamento na Multipark — datadas pela última alteração da reserva (aproximado, assinaladas com ≈).
        </p>
      )}
      {/* Summary cards (valores c/ IVA) */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="text-xl font-bold">{total}</p>
            {(actionType === "checkin" || actionType === "checkout") && stateFilter === "all" && data && (
              <p className="text-[10px] text-muted-foreground mt-0.5">
                <span className="text-emerald-700">{data.done} {actionType === "checkin" ? "recolhidas" : "entregues"}</span>
                {" · "}
                <span className="text-amber-700">{data.pending} {actionType === "checkin" ? "por recolher" : "por entregar"}</span>
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">{actionType === "creation" ? "Valor não cancelado" : actionType === "cancelation" ? "Valor cancelado" : "Receita bruta"} <span className="text-[10px]">(c/ IVA)</span></p>
            <p className="text-xl font-bold text-green-600">{fmtEur(totals.revenue)}</p>
          </CardContent>
        </Card>
        {totals.partnerTotal > 0 && (
          <Card>
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">Parceiros <span className="text-[10px]">(c/ IVA)</span></p>
              <p className="text-xl font-bold text-orange-600">-{fmtEur(totals.partnerTotal)}</p>
            </CardContent>
          </Card>
        )}
        {totals.partnerTotal > 0 && (
          <Card className="border-green-200 bg-green-50">
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">Receita após parceiros <span className="text-[10px]">(c/ IVA)</span></p>
              <p className="text-xl font-bold text-green-700">{fmtEur(totals.revenue - totals.partnerTotal)}</p>
            </CardContent>
          </Card>
        )}
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Pago Online</p>
            <p className="text-xl font-bold text-sky-700">{fmtEur(totals.paidOnline)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Pago Multibanco</p>
            <p className="text-xl font-bold text-indigo-700">{fmtEur(totals.paidMB)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Pago Dinheiro</p>
            <p className="text-xl font-bold text-emerald-700">{fmtEur(totals.paidCash)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Outros meios</p>
            <p className="text-xl font-bold text-slate-700">{fmtEur(totals.paidOther)}</p>
            <p className="text-[10px] text-muted-foreground">agregadores, agências, prós…</p>
          </CardContent>
        </Card>
        <Card className="border-amber-300 bg-amber-50/60">
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Falta pagar</p>
            <p className="text-xl font-bold text-amber-700">{fmtEur(totals.toCollect)}</p>
            <p className="text-[10px] text-muted-foreground">caixa prevista do período (c/ IVA)</p>
          </CardContent>
        </Card>
      </div>

      {/* Gráfico diário por grupo + custos por cidade + origens */}
      {data && (
        <OpsDailyPanel
          actionType={actionType}
          startDate={startDate}
          endDate={endDate}
          projectId={projectId ? Number(projectId) : undefined}
          daily={data.daily as any}
          origins={actionType === "creation" ? (data.origins as any) : undefined}
          activeGroup={groupFilter}
          onPickGroup={setGroupFilter}
        />
      )}

      {data?.scanTruncated && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          ⚠ O período tem mais de 50.000 reservas — os totais consideram só as 50.000 mais recentes. Encurta o período.
        </p>
      )}

      {/* Per-park breakdown */}
      {Object.keys(totals.byPark).length > 1 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(totals.byPark as Record<string, any>).map(([park, pd]) => (
            <Badge key={park} variant="outline" className="text-xs py-1 px-2">
              {park}: {pd.count} ({fmtEur(pd.revenue)})
              {pd.partnerName && (
                <span className="text-orange-600 ml-1">
                  | {pd.partnerName}: {fmtEur(pd.partnerShare)}
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
                    {actionType === "cancelation" && <Th k="day" label="Cancelada" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />}
                    <Th k="group" label="Grupo / canal" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                    <Th k="status" label="Estado" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                    <Th k="totalPrice" label="Preço (c/ IVA)" align="right" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
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
                    const o = classifyOrigin(b);
                    const color = o.group === "parceiro" ? "border-rose-200 text-rose-700"
                      : o.group === "campanha" ? "border-violet-200 text-violet-700"
                      : o.group === "telefone" ? "border-amber-200 text-amber-700"
                      : "";

                    return (
                      <tr
                        key={b.id || i}
                        className={`border-t cursor-pointer ${isNonValet ? "bg-red-50 hover:bg-red-100/70" : "hover:bg-muted/30"}`}
                        onClick={() => b.externalId && setDetailExternalId(b.externalId)}
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
                        {actionType === "cancelation" && (
                          <td className="p-2 text-xs whitespace-nowrap" title={b.approxDate ? "Sem data de cancelamento — última alteração da reserva" : undefined}>
                            {b.approxDate ? "≈ " : ""}{fmtBookingDateTime(b.cancelledAt ?? b.updatedAt)}
                          </td>
                        )}
                        <td className="p-2 text-xs max-w-[170px]">
                          <span className="block text-[11px] font-medium">{ORIGIN_GROUP_LABELS[b.group as OriginGroup] ?? "—"}</span>
                          <Badge variant="outline" className={`text-[10px] ${color}`} title={b.originUrl ?? undefined}>{o.label}</Badge>
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
            <div className="flex items-center justify-between gap-2 flex-wrap px-3 py-2 border-t text-xs text-muted-foreground">
              <span>A mostrar {bookings.length} de {total}</span>
              {data?.hasMore && (
                <Button variant="outline" size="sm" disabled={isFetching} onClick={() => setLimit((l) => l + PAGE_SIZE)}>
                  {isFetching ? "A carregar…" : `Mostrar mais ${Math.min(PAGE_SIZE, total - bookings.length)}`}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {detailExternalId && (detailQ.data || detailRow) && (
        <BookingDetailDialog
          booking={{ ...(detailRow ?? {}), ...(detailQ.data ?? {}), salesPartnerName: detailRow?.salesPartnerName, salesPartnerRate: detailRow?.salesPartnerRate, salesPartnerCommission: detailRow?.salesPartnerCommission }}
          onClose={() => setDetailExternalId(null)}
        />
      )}
    </div>
  );
}

// ─── Sync Tab ────────────────────────────────────────────────────────────────
const LOG_TYPE_LABEL: Record<string, string> = {
  api_sync_recent: "Recente",
  api_sync_future: "Futuro",
  manual: "Reparar",
  api_sync: "API (antigo)",
  api_sync_recovery: "Recuperação (antigo)",
  excel_import: "Excel (antigo)",
};

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function SyncTab() {
  const { user } = useAuth();
  // Ações (reparar, testar) só com alcance NACIONAL — um supervisor de cidade
  // vê o estado mas não lança um sync de todos os parques. O servidor recusa na mesma.
  const canAct = can(user, "sincronizacao", "edit") && scopeFor(user, "sincronizacao") === "national";
  const canTest = can(user, "sincronizacao", "manage") && scopeFor(user, "sincronizacao") === "national";

  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const [syncFrom, setSyncFrom] = useState(isoDay(yesterday));
  const [syncTo, setSyncTo] = useState(isoDay(today));
  const [lastSyncResult, setLastSyncResult] = useState<any>(null);
  const [logType, setLogType] = useState<"all" | "recent" | "future" | "manual">("all");

  const { data: logs = [], isLoading, refetch } = trpc.multipark.syncLogs.useQuery({ type: logType, limit: 50 });
  const coverage = trpc.multipark.syncCoverage.useQuery(undefined, { refetchInterval: 60_000 });
  const parkTest = trpc.multipark.testConnection.useQuery(undefined, { enabled: false, retry: false, refetchOnWindowFocus: false });
  const syncMut = trpc.multipark.triggerSync.useMutation();
  const utils = trpc.useUtils();

  const handleSync = async () => {
    if (!syncFrom || !syncTo) {
      toast.error("Seleciona as datas de início e fim");
      return;
    }
    const days = Math.round((new Date(syncTo).getTime() - new Date(syncFrom).getTime()) / 86_400_000) + 1;
    if (days < 1) { toast.error("A data final é anterior à inicial."); return; }
    if (days > 3) {
      toast.error(`O período tem ${days} dias. Máximo: 3 dias por reparação.`);
      return;
    }
    try {
      const result = await syncMut.mutateAsync({ startDate: syncFrom, endDate: syncTo });
      setLastSyncResult(result);
      if (result.success) toast.success(`Período reparado: ${result.processed} processadas, ${result.created} novas`);
      else if (result.partial) toast.warning(`Reparação parcial: ${result.skippedJobs} trabalho(s) ficaram por fazer — carrega outra vez.`);
      else toast.warning(`Reparação com avisos: ${result.errors?.length || 0} erros`);
      utils.multipark.syncLogs.invalidate();
      utils.multipark.dataHealth.invalidate();
      utils.multipark.bookings.invalidate();
      utils.multipark.bookingStats.invalidate();
      refetch();
    } catch (err: any) {
      toast.error(err.message || "Erro na sincronização");
    }
  };

  return (
    <div className="space-y-4 mt-4">
      <SyncHealthPanel />

      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-sm">Cobertura da sincronização</CardTitle>
          {canTest && (
            <Button size="sm" variant="outline" className="gap-2" disabled={parkTest.isFetching} onClick={() => parkTest.refetch()}>
              {parkTest.isFetching ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
              Testar ligação por parque
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {coverage.isLoading ? <p>A verificar parques e notificações…</p> : coverage.error ?
            <p className="text-destructive">Não foi possível verificar a sincronização. Os dados podem estar desatualizados.</p> : coverage.data && <>
            <p>{coverage.data.parks.filter(p => p.state === "configured").length} parques com chave configurada.{canTest ? " Usa \"Testar ligação por parque\" para confirmar que cada chave funciona (um pedido mínimo à API por parque)." : ""}</p>
            {coverage.data.parks.filter(p => p.state !== "configured").map(p => <p key={p.id} className={p.state === "missing_key" ? "text-destructive" : "text-muted-foreground"}>
              <strong>{p.name} — {p.city}:</strong> {p.state === "missing_key" ? "falta configurar o acesso; as reservas deste parque não estão cobertas." : "excluído da sincronização; requer revisão se tiver atividade."}
            </p>)}
            <p>Notificações: {coverage.data.queue.pending} por processar · {coverage.data.queue.processing} em processamento · {coverage.data.queue.failed} a aguardar nova tentativa · {coverage.data.queue.dead} em dead-letter.</p>
            {coverage.data.queue.detailFailures > 0 && <p className="text-destructive">{coverage.data.queue.detailFailures} reservas com falha na atualização dos detalhes. A última informação válida é preservada e haverá nova tentativa.</p>}
            {coverage.data.queue.historyFailures > 0 && <p className="text-destructive">{coverage.data.queue.historyFailures} reservas com falha na atualização do histórico. Os movimentos guardados são preservados e haverá nova tentativa.</p>}
            <p className="text-xs text-muted-foreground">As notificações, os detalhes e o histórico são tratados automaticamente de cinco em cinco minutos; o sync recente corre de hora a hora e o futuro de duas em duas horas.</p>
          </>}
          {parkTest.error && <p className="text-destructive text-xs">Teste falhou: {parkTest.error.message}</p>}
          {parkTest.data && (
            <div className="border-t pt-2">
              <p className="text-xs text-muted-foreground mb-2">Teste de {fmtBookingDateTime(parkTest.data.testedAt)} — {parkTest.data.message}{parkTest.data.version ? ` · API v${parkTest.data.version}` : ""}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1">
                {parkTest.data.parks.map(p => (
                  <div key={p.id} className="flex items-center gap-2 text-xs">
                    {p.state === "ok" ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" />
                      : p.state === "excluded" ? <AlertCircle className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      : <XCircle className="w-3.5 h-3.5 text-red-600 shrink-0" />}
                    <span className={p.state === "ok" ? "" : p.state === "excluded" ? "text-muted-foreground" : "text-red-700"}>
                      {p.name} — {p.city}
                      {p.state === "error" ? ` · ${p.errorCode}` : p.state === "missing_key" ? " · sem chave" : p.state === "excluded" ? " · excluído" : ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {canAct && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <RefreshCw className="w-4 h-4" /> Reparar período
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Volta a pedir à API MultiPark as criações, check-ins, check-outs e cancelamentos de um período curto
              (máximo 3 dias) — por exemplo, quando a reconciliação mostra reservas em falta. Os dados existentes são
              atualizados, sem duplicação. Se já houver uma sincronização a correr, espera um minuto.
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
                Reparar
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Resultado da última reparação */}
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
                <p className="font-medium">{lastSyncResult.success ? "Período reparado" : lastSyncResult.partial ? "Reparação parcial (prazo esgotado)" : "Reparação com avisos"}</p>
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

      {/* Registo das sincronizações */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <History className="w-4 h-4" /> Histórico de sincronizações
          </CardTitle>
          <Select value={logType} onValueChange={(v) => setLogType(v as typeof logType)}>
            <SelectTrigger className="w-40 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os tipos</SelectItem>
              <SelectItem value="recent">Recente</SelectItem>
              <SelectItem value="future">Futuro</SelectItem>
              <SelectItem value="manual">Reparar (manual)</SelectItem>
            </SelectContent>
          </Select>
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
                    <th className="text-left p-2 font-medium">Janela</th>
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
                        <Badge variant="outline" className="text-xs">{LOG_TYPE_LABEL[log.syncType] ?? log.syncType}</Badge>
                      </td>
                      <td className="p-2 text-xs text-muted-foreground whitespace-nowrap">
                        {log.windowStart ? `${String(log.windowStart).slice(0, 10)} → ${String(log.windowEnd ?? "").slice(0, 10)}` : "—"}
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
                      <td className="p-2 text-xs text-red-600 max-w-[240px] truncate" title={log.errorMessage || ""}>
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
