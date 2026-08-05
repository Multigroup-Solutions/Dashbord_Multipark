import { useState, useMemo } from "react";
import { usePersistedState } from "@/hooks/usePersistedState";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  LayoutDashboard, CalendarCheck, ArrowDownToLine, ArrowUpFromLine,
  XCircle, Wrench, Euro, Activity, MapPin, Building2, PieChart as PieIcon,
} from "lucide-react";
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend } from "recharts";
import { QuickRangeBar, thisMonthRange, previousPeriod } from "@/components/QuickRangeBar";
import DateRangeNav from "@/components/DateRangeNav";
import MultiparkPage from "./MultiparkPage";
import ServicesPage from "./ServicesPage";

const PIE_COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#14b8a6"];

function MiniPie({ title, icon, data }: { title: string; icon?: React.ReactNode; data: Array<{ name: string; value: number }> }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-sm flex items-center gap-2">{icon}{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-12">Sem dados</p>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="45%" outerRadius={70}>
                {data.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={(v: any, n: any) => [`${v} (${total > 0 ? ((Number(v) / total) * 100).toFixed(0) : 0}%)`, n]} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
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

export default function OperacoesPage() {
  // A aba ativa persiste à navegação — voltar às Operações mantém onde estavas
  const [tab, setTab] = usePersistedState("operacoes.tab", "dashboard");
  return (
    <div className="p-4 md:p-6 space-y-6 max-w-[1400px] mx-auto">
      <div>
        <p className="text-sm text-muted-foreground">
          Reservas, recolhas, entregas, cancelamentos e serviços extras
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="dashboard"><LayoutDashboard className="w-4 h-4 mr-1" />Dashboard</TabsTrigger>
          <TabsTrigger value="reservas"><CalendarCheck className="w-4 h-4 mr-1" />Reservas</TabsTrigger>
          <TabsTrigger value="entradas"><ArrowDownToLine className="w-4 h-4 mr-1" />Recolhas</TabsTrigger>
          <TabsTrigger value="saidas"><ArrowUpFromLine className="w-4 h-4 mr-1" />Entregas</TabsTrigger>
          <TabsTrigger value="cancelados"><XCircle className="w-4 h-4 mr-1" />Cancelados</TabsTrigger>
          <TabsTrigger value="servicos"><Wrench className="w-4 h-4 mr-1" />Serviços</TabsTrigger>
        </TabsList>

        <TabsContent value="dashboard" className="mt-4">
          <OperacoesDashboard onJump={setTab} />
        </TabsContent>
        <TabsContent value="reservas" className="mt-4">
          <MultiparkPage sectionProp="reservas" />
        </TabsContent>
        <TabsContent value="entradas" className="mt-4">
          <MultiparkPage sectionProp="entradas" />
        </TabsContent>
        <TabsContent value="saidas" className="mt-4">
          <MultiparkPage sectionProp="saidas" />
        </TabsContent>
        <TabsContent value="cancelados" className="mt-4">
          <MultiparkPage sectionProp="cancelados" />
        </TabsContent>
        <TabsContent value="servicos" className="mt-4">
          <ServicesPage />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Dashboard simples ───────────────────────────────────────────────────────

function OperacoesDashboard({ onJump }: { onJump: (tab: string) => void }) {
  const [defFrom, defTo] = thisMonthRange();
  // Filtros persistem à navegação (padrão da app)
  const [from, setFrom] = usePersistedState("operacoes.dash.from", defFrom);
  const [to, setTo] = usePersistedState("operacoes.dash.to", defTo);
  const [activeRange, setActiveRange] = usePersistedState<string>("operacoes.dash.range", "thisMonth");
  const [compare, setCompare] = usePersistedState<boolean>("operacoes.dash.compare", false);
  const [dim, setDim] = usePersistedState<"city" | "parkName">("operacoes.dash.dim", "city");

  // Resumo AGREGADO no servidor (1 query em vez de 4×5.000 reservas completas)
  const summaryQ = trpc.multipark.operationsSummary.useQuery(
    { startDate: from, endDate: to },
    { refetchOnWindowFocus: false },
  );

  // Período anterior (mesma duração) — só corre quando "comparar" está ligado
  const [pf, pt] = previousPeriod(from, to);
  const prevQ = trpc.multipark.operationsSummary.useQuery(
    { startDate: pf, endDate: pt },
    { refetchOnWindowFocus: false, enabled: compare },
  );

  const actions = summaryQ.data?.actions;
  const stats = useMemo(() => ({
    reservas: actions?.creation?.count ?? 0, reservasReceita: actions?.creation?.revenue ?? 0,
    recolhas: actions?.checkin?.count ?? 0,
    entregas: actions?.checkout?.count ?? 0, entregasReceita: actions?.checkout?.revenue ?? 0,
    cancelados: actions?.cancelation?.count ?? 0, canceladosReceita: actions?.cancelation?.revenue ?? 0,
  }), [actions]);

  const prevActions = prevQ.data?.actions;
  const prevStats = useMemo(() => ({
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
      <Card>
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
            </div>
          </div>
        </CardContent>
      </Card>

      {/* KPIs clicáveis */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          icon={<CalendarCheck className="w-5 h-5 text-blue-600" />}
          label="Reservas criadas"
          value={stats.reservas}
          extra={fmtEur(stats.reservasReceita)}
          compareValue={compare ? prevStats.reservas : undefined}
          onClick={() => onJump("reservas")}
        />
        <KpiCard
          icon={<ArrowDownToLine className="w-5 h-5 text-emerald-600" />}
          label="Recolhas"
          value={stats.recolhas}
          compareValue={compare ? prevStats.recolhas : undefined}
          onClick={() => onJump("entradas")}
        />
        <KpiCard
          icon={<ArrowUpFromLine className="w-5 h-5 text-amber-600" />}
          label="Entregas"
          value={stats.entregas}
          extra={fmtEur(stats.entregasReceita)}
          compareValue={compare ? prevStats.entregas : undefined}
          onClick={() => onJump("saidas")}
        />
        <KpiCard
          icon={<XCircle className="w-5 h-5 text-red-600" />}
          label="Cancelados"
          value={stats.cancelados}
          extra={fmtEur(stats.canceladosReceita)}
          compareValue={compare ? prevStats.cancelados : undefined}
          invertDelta
          onClick={() => onJump("cancelados")}
        />
      </div>

      {/* Ratios */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Receita média / entrega</p>
            <p className="text-xl font-bold text-emerald-700">
              {stats.entregas > 0 ? fmtEur(stats.entregasReceita / stats.entregas) : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Taxa de cancelamento</p>
            <p className="text-xl font-bold text-red-700">
              {stats.reservas > 0 ? `${((stats.cancelados / stats.reservas) * 100).toFixed(1)}%` : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Conversão recolha → entrega</p>
            <p className="text-xl font-bold text-blue-700">
              {stats.recolhas > 0 ? `${((stats.entregas / stats.recolhas) * 100).toFixed(1)}%` : "—"}
            </p>
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
          <MiniPie title={`Reservas por ${dimLabel}`} icon={<CalendarCheck className="w-3.5 h-3.5 text-blue-600" />} data={pies.reservas} />
          <MiniPie title={`Recolhas por ${dimLabel}`} icon={<ArrowDownToLine className="w-3.5 h-3.5 text-emerald-600" />} data={pies.recolhas} />
          <MiniPie title={`Entregas por ${dimLabel}`} icon={<ArrowUpFromLine className="w-3.5 h-3.5 text-amber-600" />} data={pies.entregas} />
        </div>
      </div>

      <p className="text-xs text-muted-foreground flex items-center gap-1">
        <Activity className="w-3 h-3" />
        Clica num cartão para ir directo à tabela da secção
      </p>
    </div>
  );
}

function KpiCard({
  icon, label, value, extra, onClick, compareValue, invertDelta,
}: { icon: React.ReactNode; label: string; value: number; extra?: string; onClick?: () => void; compareValue?: number; invertDelta?: boolean }) {
  const delta = compareValue != null ? value - compareValue : null;
  const pct = compareValue != null && compareValue > 0 ? (delta! / compareValue) * 100 : null;
  // Para cancelados, subir é mau (invertDelta) → cor invertida.
  const positive = delta == null ? false : (invertDelta ? delta < 0 : delta > 0);
  const negative = delta == null ? false : (invertDelta ? delta > 0 : delta < 0);
  return (
    <Card
      className={onClick ? "cursor-pointer hover:shadow-md transition-shadow" : ""}
      onClick={onClick}
    >
      <CardContent className="p-4 flex items-center gap-3">
        <div className="p-2 rounded-lg bg-muted">{icon}</div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground truncate">{label}</p>
          <p className="text-2xl font-bold">{value}</p>
          {extra && <p className="text-xs text-muted-foreground truncate"><Euro className="w-3 h-3 inline" /> {extra}</p>}
          {delta != null && (
            <p className={"text-[11px] font-medium " + (positive ? "text-emerald-600" : negative ? "text-red-600" : "text-muted-foreground")}>
              {delta >= 0 ? "+" : ""}{delta}{pct != null && <> ({delta >= 0 ? "+" : ""}{pct.toFixed(0)}%)</>} <span className="text-muted-foreground font-normal">vs ant.</span>
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
