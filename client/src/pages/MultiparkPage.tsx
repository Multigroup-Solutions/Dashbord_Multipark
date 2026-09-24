import { classifyBookingOrigin as classifyOrigin } from "@shared/bookingOrigin";
import { ORIGIN_GROUPS, ORIGIN_GROUP_LABELS, CHANNEL_LABELS, type OriginGroup } from "@shared/originGroup";
import { OpsDailyPanel } from "@/components/operacoes/OpsDailyPanel";
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
          {/* Teste à API da Multipark: só admin (a rota é admin-only; ao
              backoffice aparecia sempre "Desconectado" a vermelho) */}
          {(user?.role === "admin" || user?.role === "super_admin") && <ConnectionStatus />}
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

// ─── Sync Tab ────────────────────────────────────────────────────────────────
function SyncTab() {
  const today = new Date();
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const [syncFrom, setSyncFrom] = useState(weekAgo.toISOString().slice(0, 10));
  const [syncTo, setSyncTo] = useState(today.toISOString().slice(0, 10));
  const [lastSyncResult, setLastSyncResult] = useState<any>(null);

  const { data: logs = [], isLoading, refetch } = trpc.multipark.syncLogs.useQuery();
  const coverage = trpc.multipark.syncCoverage.useQuery(undefined, { refetchInterval: 60_000 });
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
    // O servidor recusa mais de 31 dias por pedido (a API Multipark cobra
    // por chamada e períodos longos prendem a função) — avisa já aqui.
    const days = Math.round((new Date(syncTo).getTime() - new Date(syncFrom).getTime()) / 86_400_000) + 1;
    if (days > 31) {
      toast.error(`O período tem ${days} dias. Máximo: 31 dias por sincronização — divide em partes.`);
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
        <CardHeader><CardTitle className="text-sm">Cobertura da sincronização</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {coverage.isLoading ? <p>A verificar parques e notificações…</p> : coverage.error ?
            <p className="text-destructive">Não foi possível verificar a sincronização. Os dados podem estar desatualizados.</p> : coverage.data && <>
            <p>{coverage.data.parks.filter(p => p.state === "configured").length} parques com chave configurada. A existência da chave não confirma que o acesso esteja válido.</p>
            {coverage.data.parks.filter(p => p.state !== "configured").map(p => <p key={p.id} className={p.state === "missing_key" ? "text-destructive" : "text-muted-foreground"}>
              <strong>{p.name} — {p.city}:</strong> {p.state === "missing_key" ? "falta configurar o acesso; as reservas deste parque não estão cobertas." : "excluído da sincronização; requer revisão se tiver atividade."}
            </p>)}
            <p>Notificações: {coverage.data.queue.pending} por processar · {coverage.data.queue.processing} em processamento · {coverage.data.queue.failed} a aguardar nova tentativa.</p>
            {coverage.data.queue.detailFailures > 0 && <p className="text-destructive">{coverage.data.queue.detailFailures} reservas com falha na atualização dos detalhes. A última informação válida é preservada e haverá nova tentativa.</p>}
            {coverage.data.queue.historyFailures > 0 && <p className="text-destructive">{coverage.data.queue.historyFailures} reservas com falha na atualização do histórico. Os movimentos guardados são preservados e haverá nova tentativa.</p>}
            <p className="text-xs text-muted-foreground">As notificações e os detalhes são tratados automaticamente em ciclos de cinco minutos, sujeitos à disponibilidade da origem e ao agendamento.</p>
          </>}
        </CardContent>
      </Card>
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
            <p>A importação de reservas corre automaticamente; as notificações e os detalhes têm um ciclo próprio de cinco minutos.</p>
            <p>Usa este formulário para importar histórico mais antigo ou forçar uma atualização.</p>
          </div>

          <div className="border-t pt-3 flex items-center justify-between gap-3">
            <div className="text-sm">
              <div className="font-medium">Enriquecer reservas (recolha/entrega)</div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Vai à API individual de cada reserva e guarda <strong>deliveryType</strong>{" "}
                (Terminal 1, Oriente, etc.), <strong>voos</strong> e <strong>notas do cliente</strong>.
                A atualização é automática. Este botão permite antecipar um lote de até 200 reservas.
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
