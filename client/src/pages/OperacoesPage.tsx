import AnomalyAlerts from "@/components/aiOps/AnomalyAlerts";
import { useAuth } from "@/_core/hooks/useAuth";
import { can } from "@shared/access";
import { useEffect, useState, useMemo } from "react";
import { usePersistedState } from "@/hooks/usePersistedState";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatValue } from "@/components/StatValue";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  LayoutDashboard, CalendarCheck, ArrowDownToLine, ArrowUpFromLine,
  XCircle, Euro, Activity, MapPin, Building2, PieChart as PieIcon, CalendarDays, AlertTriangle, RefreshCw,
} from "lucide-react";
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend } from "recharts";
import { QuickRangeBar, thisMonthRange, previousPeriod } from "@/components/QuickRangeBar";
import DateRangeNav from "@/components/DateRangeNav";
import ReservasDoDia from "@/components/operacoes/ReservasDoDia";
import OpsList, { defaultOpsShared, type OpsListShared } from "@/components/operacoes/OpsList";
import { OPS_LIST_KINDS, OPS_LIST_LABELS, OPS_LIST_MAX_DAYS, rangeDays } from "@shared/opsLists";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { cohortCancelRate } from "@shared/operationsDaily";
import { retryTransient } from "@/lib/queryRetry";

const PIE_COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#14b8a6"];

function MiniPie({ title, icon, data, loading }: { title: string; icon?: React.ReactNode; data: Array<{ name: string; value: number }>; loading?: boolean }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-sm flex items-center gap-2">{icon}{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-xs text-muted-foreground text-center py-12">A carregar…</p>
        ) : total === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-12">Sem dados</p>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="45%" outerRadius={70}>
                {data.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={(v: any, n: any) => [`${v} (${total > 0 ? ((Number(v) / total) * 100).toFixed(0) : 0}%)`, n]} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

const fmtEur = (v: number | string | null | undefined) => {
  const n = typeof v === "string" ? parseFloat(v) : (v ?? 0);
  return n.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
};

/** Alertas de reservas por parque/canal (anomalias) — só a quem vê Reservas & Operações. 42d: pequenos e de lado. */
function BookingAlerts() {
  const { user } = useAuth();
  return <AnomalyAlerts domain="bookings" className="lg:sticky lg:top-4" enabled={!!user && can(user as any, "reservas_operacoes", "view")} />;
}

const OPERACOES_TABS = ["dashboard", "dia", ...OPS_LIST_KINDS];

/**
 * Aba pedida no link (`?tab=dia`, `?tab=cancelados`, pesquisa global, links
 * antigos). A pesquisa (`q`) e o dia (`de`) servem de semente às listas.
 */
function tabFromUrl(): string | null {
  const tab = new URLSearchParams(window.location.search).get("tab");
  if (!tab) return null;
  return OPERACOES_TABS.includes(tab) ? tab : null;
}

/** Semente das listas por período a partir do link (`?q=…&de=AAAA-MM-DD`). */
function listSeedFromUrl(): OpsListShared {
  try {
    const p = new URLSearchParams(window.location.search);
    const de = p.get("de");
    return defaultOpsShared({ day: de && /^\d{4}-\d{2}-\d{2}$/.test(de) ? de : null, q: (p.get("q") ?? "").slice(0, 100) });
  } catch {
    return defaultOpsShared();
  }
}

export default function OperacoesPage() {
  const [urlTab] = useState(tabFromUrl);
  // A aba ativa persiste à navegação — voltar às Operações mantém onde estavas
  const [storedTab, setTab] = usePersistedState("operacoes.tab", urlTab ?? "dashboard");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (urlTab) setTab(urlTab); }, [urlTab]);
  // "Serviços" saiu daqui (fica no menu, em /servicos) → Dashboard.
  const tab = OPERACOES_TABS.includes(storedTab) ? storedTab : "dashboard";
  // Filtros das listas por período, PARTILHADOS entre Reservas / Recolhas /
  // Entregas / Cancelados (mudar de aba mantém o período). Abrem em HOJE, ou no
  // período do Dashboard quando se chega por um cartão.
  const [listShared, setListShared] = useState<OpsListShared>(listSeedFromUrl);
  const patchShared = (patch: Partial<OpsListShared>) => setListShared((s) => ({ ...s, ...patch }));
  // Cartão do Dashboard → lista no MESMO período (se couber nos 62 dias das listas).
  const jumpToList = (target: string, range: { from: string; to: string }) => {
    const n = rangeDays(range.from, range.to);
    if (n > 0 && n <= OPS_LIST_MAX_DAYS) patchShared({ from: range.from, to: range.to });
    setTab(target);
  };
  return (
    <div className="space-y-6 max-w-[1400px] mx-auto">
      <div>
        <p className="text-sm text-muted-foreground">
          Reservas, recolhas, entregas e cancelamentos — dias de Lisboa, valores c/ IVA. As listas e as "Reservas do dia" leem a Multipark em tempo real.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="dashboard"><LayoutDashboard className="w-4 h-4 mr-1" />Dashboard</TabsTrigger>
          <TabsTrigger value="dia"><CalendarDays className="w-4 h-4 mr-1" />Reservas do dia</TabsTrigger>
          <TabsTrigger value="reservas"><CalendarCheck className="w-4 h-4 mr-1" />{OPS_LIST_LABELS.reservas}</TabsTrigger>
          <TabsTrigger value="entradas"><ArrowDownToLine className="w-4 h-4 mr-1" />{OPS_LIST_LABELS.entradas}</TabsTrigger>
          <TabsTrigger value="saidas"><ArrowUpFromLine className="w-4 h-4 mr-1" />{OPS_LIST_LABELS.saidas}</TabsTrigger>
          <TabsTrigger value="cancelados"><XCircle className="w-4 h-4 mr-1" />{OPS_LIST_LABELS.cancelados}</TabsTrigger>
        </TabsList>

        <TabsContent value="dashboard" className="mt-4">
          {/* 42d: os alertas ficam de lado (no telemóvel, por cima e encolhíveis) */}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start">
            <div className="min-w-0"><OperacoesDashboard onJump={jumpToList} /></div>
            <aside className="order-first min-w-0 lg:order-last"><BookingAlerts /></aside>
          </div>
        </TabsContent>
        <TabsContent value="dia" className="mt-4">
          <ReservasDoDia />
        </TabsContent>
        {OPS_LIST_KINDS.map((k) => (
          <TabsContent key={k} value={k} className="mt-4">
            {tab === k && <OpsList kind={k} shared={listShared} onShared={patchShared} />}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

// ─── Dashboard simples ───────────────────────────────────────────────────────

function OperacoesDashboard({ onJump }: { onJump: (tab: string, range: { from: string; to: string }) => void }) {
  const [defFrom, defTo] = thisMonthRange();
  // Datas PARTILHADAS com as folhas (mesmas keys) — mudar o período aqui ou
  // numa folha mantém-no em todas as abas das Operações
  const [from, setFrom] = usePersistedState("mpk.shared.start", defFrom);
  const [to, setTo] = usePersistedState("mpk.shared.end", defTo);
  const [activeRange, setActiveRange] = usePersistedState<string>("mpk.shared.range", "thisMonth");
  const [compare, setCompare] = usePersistedState<boolean>("operacoes.dash.compare", false);
  const [dim, setDim] = usePersistedState<"city" | "parkName">("operacoes.dash.dim", "city");

  // Resumo AGREGADO no servidor (1 query em vez de 4×5.000 reservas completas)
  const globalFilters = useGlobalFilters();
  const summaryQ = trpc.multipark.operationsSummary.useQuery(
    { startDate: from, endDate: to, projectId: globalFilters.projectId },
    { refetchOnWindowFocus: false, retry: retryTransient },
  );

  // Período anterior (mesma duração) — só corre quando "comparar" está ligado
  const [pf, pt] = previousPeriod(from, to);
  const prevQ = trpc.multipark.operationsSummary.useQuery(
    { startDate: pf, endDate: pt, projectId: globalFilters.projectId },
    { refetchOnWindowFocus: false, enabled: compare, retry: retryTransient },
  );
  // Sem resposta (ou sem o período anterior) não há números: nunca zeros a fingir.
  const ready = !!summaryQ.data;
  const prevReady = compare && !!prevQ.data;
  const jump = (tab: string) => onJump(tab, { from, to });

  const actions = summaryQ.data?.actions;
  const stats = useMemo(() => ({
    // Criadas no período (TODAS, como na folha Reservas) e, dessas, as não canceladas
    criadas: actions?.createdAll?.count ?? 0,
    reservas: actions?.creation?.count ?? 0, reservasReceita: actions?.creation?.revenue ?? 0,
    recolhas: actions?.checkin?.count ?? 0,
    entregas: actions?.checkout?.count ?? 0, entregasReceita: actions?.checkout?.revenue ?? 0,
    cancelados: actions?.cancelation?.count ?? 0, canceladosReceita: actions?.cancelation?.revenue ?? 0,
  }), [actions]);

  const prevActions = prevQ.data?.actions;
  const prevStats = useMemo(() => ({
    criadas: prevActions?.createdAll?.count ?? 0,
    reservas: prevActions?.creation?.count ?? 0,
    recolhas: prevActions?.checkin?.count ?? 0,
    entregas: prevActions?.checkout?.count ?? 0,
    cancelados: prevActions?.cancelation?.count ?? 0,
  }), [prevActions]);

  const toPie = (rows: Array<{ name: string; count: number }> | undefined, topN = 8) => {
    const arr = (rows ?? []).map((r) => ({ name: r.name, value: r.count }));
    if (arr.length <= topN) return arr;
    const top = arr.slice(0, topN);
    const rest = arr.slice(topN).reduce((s, x) => s + x.value, 0);
    if (rest > 0) top.push({ name: "Outros", value: rest });
    return top;
  };
  const pies = useMemo(() => ({
    reservas: toPie(dim === "city" ? actions?.creation?.byCity : actions?.creation?.byPark),
    recolhas: toPie(dim === "city" ? actions?.checkin?.byCity : actions?.checkin?.byPark),
    entregas: toPie(dim === "city" ? actions?.checkout?.byCity : actions?.checkout?.byPark),
  }), [actions, dim]);

  const isLoading = summaryQ.isLoading;
  const dimLabel = dim === "city" ? "cidade" : "parque";

  return (
    <div className="space-y-6">
      {/* Filtros */}
      <Card className="py-0 gap-0">
        <CardContent className="p-4 space-y-3">
          <QuickRangeBar
            active={activeRange}
            onPick={(f, t, id) => { setFrom(f); setTo(t); setActiveRange(id); }}
          />
          <div className="flex flex-wrap items-end gap-3">
            <DateRangeNav
              start={from}
              end={to}
              gran={(activeRange === "thisWeek" || activeRange === "lastWeek" ? "week" : activeRange === "thisMonth" || activeRange === "lastMonth" ? "month" : "custom") as any}
              showAll={false}
              onChange={(s, e) => { setFrom(s); setTo(e); setActiveRange(""); }}
            />
            <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none ml-1 mb-2">
              <input type="checkbox" checked={compare} onChange={e => setCompare(e.target.checked)} />
              Comparar com período anterior
            </label>
            <div className="text-xs text-muted-foreground ml-auto mb-2">
              {isLoading ? "A carregar..." : `${from} → ${to}`}
              {compare && <span className="block">vs {pf} → {pt}</span>}
              {compare && prevQ.error && <span className="block text-amber-700">Sem o período anterior (a Multipark não respondeu).</span>}
            </div>
          </div>
        </CardContent>
      </Card>

      {summaryQ.error && !ready && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="p-4 text-sm flex flex-wrap items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">Não foi possível ler as reservas da Multipark.</p>
              <p className="text-muted-foreground">{summaryQ.error.message}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => summaryQ.refetch()} disabled={summaryQ.isFetching}>
              <RefreshCw className={`w-4 h-4 mr-1 ${summaryQ.isFetching ? "animate-spin" : ""}`} /> Tentar de novo
            </Button>
          </CardContent>
        </Card>
      )}

      {!summaryQ.error || ready ? (<>
      {/* KPIs clicáveis — só parques NOSSOS, sem compras online por acabar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          icon={<CalendarCheck className="w-5 h-5 text-blue-600" />}
          label="Reservas criadas"
          value={ready ? stats.criadas : null}
          sub={ready ? `${stats.reservas} não canceladas · ${stats.criadas - stats.reservas} já canceladas` : undefined}
          extra={ready ? `${fmtEur(stats.reservasReceita)} c/ IVA (não canceladas)` : undefined}
          compareValue={prevReady ? prevStats.criadas : undefined}
          onClick={() => jump("reservas")}
        />
        <KpiCard
          icon={<ArrowDownToLine className="w-5 h-5 text-emerald-600" />}
          label="Recolhas"
          value={ready ? stats.recolhas : null}
          compareValue={prevReady ? prevStats.recolhas : undefined}
          onClick={() => jump("entradas")}
        />
        <KpiCard
          icon={<ArrowUpFromLine className="w-5 h-5 text-amber-600" />}
          label="Entregas"
          value={ready ? stats.entregas : null}
          extra={ready ? `${fmtEur(stats.entregasReceita)} c/ IVA` : undefined}
          compareValue={prevReady ? prevStats.entregas : undefined}
          onClick={() => jump("saidas")}
        />
        <KpiCard
          icon={<XCircle className="w-5 h-5 text-red-600" />}
          label="Cancelamentos no período"
          value={ready ? stats.cancelados : null}
          extra={ready ? `${fmtEur(stats.canceladosReceita)} c/ IVA` : undefined}
          compareValue={prevReady ? prevStats.cancelados : undefined}
          invertDelta
          onClick={() => jump("cancelados")}
        />
      </div>

      {/* Rácios */}
      <div className="grid grid-cols-2 gap-3">
        <Card className="py-0 gap-0 min-w-0">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Receita média / entrega (c/ IVA)</p>
            <p className="text-xl font-bold text-emerald-700 tabular-nums truncate">
              {stats.entregas > 0 ? fmtEur(stats.entregasReceita / stats.entregas) : "—"}
            </p>
          </CardContent>
        </Card>
        <Card className="py-0 gap-0 min-w-0">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Taxa de cancelamento</p>
            <p className="text-xl font-bold text-red-700 tabular-nums">
              {(() => { const r = cohortCancelRate(stats.criadas, stats.criadas - stats.reservas); return r == null ? "—" : `${(r * 100).toFixed(1)}%`; })()}
            </p>
            <p className="text-[11px] leading-snug text-muted-foreground">das reservas criadas no período, quantas estão canceladas</p>
          </CardContent>
        </Card>
      </div>

      {/* Gráficos por cidade / parque */}
      <div className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm font-medium flex items-center gap-2">
            <PieIcon className="w-4 h-4" /> Distribuição por {dimLabel}
          </p>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => setDim("city")}
              className={"text-xs px-2.5 py-1 rounded border transition-colors flex items-center gap-1 " + (dim === "city" ? "bg-primary text-primary-foreground border-primary" : "bg-muted/40 hover:bg-muted")}
            >
              <MapPin className="w-3 h-3" /> Cidade
            </button>
            <button
              type="button"
              onClick={() => setDim("parkName")}
              className={"text-xs px-2.5 py-1 rounded border transition-colors flex items-center gap-1 " + (dim === "parkName" ? "bg-primary text-primary-foreground border-primary" : "bg-muted/40 hover:bg-muted")}
            >
              <Building2 className="w-3 h-3" /> Parque
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <MiniPie title={`Reservas não canceladas por ${dimLabel}`} icon={<CalendarCheck className="w-3.5 h-3.5 text-blue-600" />} data={pies.reservas} loading={!ready} />
          <MiniPie title={`Recolhas por ${dimLabel}`} icon={<ArrowDownToLine className="w-3.5 h-3.5 text-emerald-600" />} data={pies.recolhas} loading={!ready} />
          <MiniPie title={`Entregas por ${dimLabel}`} icon={<ArrowUpFromLine className="w-3.5 h-3.5 text-amber-600" />} data={pies.entregas} loading={!ready} />
        </div>
      </div>
      </>) : null}

      <p className="text-xs text-muted-foreground flex items-center gap-1">
        <Activity className="w-3 h-3" />
        Só parques nossos e sem as compras online por acabar. Clica num cartão para abrir a lista no mesmo período (até {OPS_LIST_MAX_DAYS} dias); a lista mostra também os parques Marketplace e diz quantas são dos nossos.
      </p>
    </div>
  );
}

function KpiCard({
  icon, label, value, sub, extra, onClick, compareValue, invertDelta,
}: { icon: React.ReactNode; label: string; value: number | null; sub?: string; extra?: string; onClick?: () => void; compareValue?: number; invertDelta?: boolean }) {
  const delta = compareValue != null && value != null ? value - compareValue : null;
  const pct = compareValue != null && compareValue > 0 ? (delta! / compareValue) * 100 : null;
  // Para cancelados, subir é mau (invertDelta) → cor invertida.
  const positive = delta == null ? false : (invertDelta ? delta < 0 : delta > 0);
  const negative = delta == null ? false : (invertDelta ? delta > 0 : delta < 0);
  return (
    <Card
      className={"py-0 gap-0 min-w-0 " + (onClick ? "cursor-pointer hover:shadow-md transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" : "")}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
    >
      {/* Em telemóvel (2 colunas estreitas) o ícone fica por cima do texto —
          lado a lado, o rótulo e os valores ficavam cortados a ~75px. */}
      <CardContent className="p-4 flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-3">
        <div className="p-2 rounded-lg bg-muted self-start shrink-0">{icon}</div>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground leading-snug">{label}</p>
          <StatValue value={value == null ? "…" : value.toLocaleString("pt-PT")} min={18} max={24} />
          {sub && <p className="text-[11px] leading-snug text-muted-foreground tabular-nums">{sub}</p>}
          {extra && <p className="text-xs leading-snug text-muted-foreground tabular-nums mt-0.5"><Euro className="w-3 h-3 inline -mt-0.5" aria-hidden /> {extra}</p>}
          {delta != null && (
            <p className={"text-[11px] font-medium tabular-nums " + (positive ? "text-emerald-700" : negative ? "text-red-600" : "text-muted-foreground")}>
              {delta >= 0 ? "+" : ""}{delta}{pct != null && <> ({delta >= 0 ? "+" : ""}{pct.toFixed(0)}%)</>} <span className="text-muted-foreground font-normal">vs ant.</span>
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
