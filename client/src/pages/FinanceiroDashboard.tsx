import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import {
  Euro,
  Clock,
  AlertCircle,
  TrendingUp,
  TrendingDown,
  Loader2,
  CheckCircle2,
  Wallet,
} from "lucide-react";
import { format } from "date-fns";
import { pt } from "date-fns/locale";
import {
  useDashboardFilters,
  DashboardFilterBar,
} from "@/components/DashboardFilterBar";
import MarketingSummaryCard from "@/components/marketing/MarketingSummaryCard";
import FitAmount from "@/components/finance/FitAmount";
import { AXIS_TICK, CHART_PALETTE, CHART_TOOLTIP_STYLE, CHART_TOOLTIP_ITEM, eurAxis, eurFull } from "@/lib/financeFormat";

const COLORS = CHART_PALETTE;

const EVOLUTION_LABEL: Record<string, string> = {
  receita: "Entregues s/ IVA",
  despesas: "Custos s/ IVA",
  receitaPrevista: "Receita esperada",
  custosPrevistos: "Custos previstos",
};

const fmt = eurFull;

/** Legenda em HTML (quebra de linha sem sobrepor o gráfico) com a quota. */
function DonutLegend({ items }: { items: { name: string; value: number }[] }) {
  const total = items.reduce((s, d) => s + d.value, 0) || 1;
  return (
    <ul className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-x-5 gap-y-1.5 text-xs">
      {items.map((d, i) => (
        <li key={d.name} className="flex items-center gap-2 min-w-0" title={`${d.name}: ${fmt(d.value)}`}>
          <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
          <span className="truncate text-muted-foreground">{d.name}</span>
          <span className="ml-auto shrink-0 tabular-nums font-medium text-foreground">
            {((d.value / total) * 100).toFixed(0)}%
          </span>
        </li>
      ))}
    </ul>
  );
}

function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  iconBg,
  iconColor,
  className,
}: {
  className?: string;
  title: string;
  value: number;
  subtitle?: string;
  icon: any;
  iconBg?: string;
  iconColor?: string;
}) {
  return (
    <Card className={`relative overflow-hidden min-w-0 ${className ?? ""}`}>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 min-w-0 flex-1">
            <p className="text-sm text-muted-foreground font-medium">{title}</p>
            <FitAmount value={value} className={`text-xl xl:text-2xl font-bold ${value < 0 ? "text-destructive" : "text-foreground"}`} />
            {subtitle && (
              <p className="text-xs text-muted-foreground">{subtitle}</p>
            )}
          </div>
          <div
            className={`h-10 w-10 shrink-0 rounded-xl flex items-center justify-center ${iconBg ?? "bg-primary/10"}`}
          >
            <Icon className={`h-5 w-5 ${iconColor ?? "text-primary"}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SkeletonCard() {
  return (
    <Card className="relative overflow-hidden">
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div className="space-y-2">
            <div className="h-4 w-24 bg-muted rounded animate-pulse" />
            <div className="h-7 w-32 bg-muted rounded animate-pulse" />
            <div className="h-3 w-16 bg-muted rounded animate-pulse" />
          </div>
          <div className="h-10 w-10 rounded-xl bg-muted animate-pulse" />
        </div>
      </CardContent>
    </Card>
  );
}

function SkeletonChart({ height = 240 }: { height?: number }) {
  return (
    <div className="flex items-center justify-center" style={{ height }}>
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

export default function FinanceiroDashboard() {
  const filters = useDashboardFilters();
  const { user } = useAuth();
  // expenses.stats/upcomingPayments são admin-only no servidor
  const isAdmin = ["admin", "super_admin"].includes(user?.role ?? "");

  // Receita, custos e margem: o MESMO motor da Faturação (entregues
  // CHECKED_OUT, tudo sem IVA, receita e custos no MESMO período).
  const { data: fin, isLoading: finLoading } = trpc.invoices.financeSummary.useQuery(
    { from: filters.from, to: filters.to, projectId: filters.projectId },
    { enabled: isAdmin },
  );

  // Reservas CRIADAS no período (outra base: data de criação, c/ IVA) — só
  // para as distribuições por cidade/marca, identificadas como tal.
  const { data: bookingStats, isLoading: bookingLoading } =
    trpc.multipark.bookingStats.useQuery({
      from: filters.from,
      to: filters.to,
      projectId: filters.projectId,
    });

  // Expense stats
  const { data: expenseStats, isLoading: expenseLoading } =
    trpc.expenses.stats.useQuery(undefined, { enabled: isAdmin });

  // Upcoming payments
  const { data: upcoming, isLoading: upcomingLoading } =
    trpc.expenses.upcomingPayments.useQuery(undefined, { enabled: isAdmin });

  const isLoading = finLoading || (isAdmin && expenseLoading);

  // KPI values — base da Faturação (s/ IVA, mesmo período)
  const receitaPeriodo = fin?.revenue.producedNet ?? 0;
  const custosPeriodo = fin?.costs.totalNet ?? 0;
  const pendente = expenseStats?.pending?.total ?? 0;
  const emAtraso = expenseStats?.overdue?.total ?? 0;
  const margem = fin?.margin.margin ?? 0;

  // Expense KPIs
  const totalDespesasAnual = expenseStats?.yearly?.total ?? 0;
  const totalDespesasCount = expenseStats?.yearly?.count ?? 0;
  const pagoDespesas = totalDespesasAnual - pendente - emAtraso;

  // Expense status data for mini bar
  const statusData = [
    { name: "Pago", value: Math.max(0, pagoDespesas), color: "var(--chart-2)" },
    { name: "Pendente", value: pendente, color: "var(--chart-4)" },
    { name: "Em Atraso", value: emAtraso, color: "var(--destructive)" },
  ].filter(s => s.value > 0);

  const totalStatusValue = statusData.reduce((s, d) => s + d.value, 0);

  // Revenue by city (donut)
  const byCityData = (bookingStats?.byCity ?? []).map((c: any) => ({
    name: c.name ?? "Desconhecido",
    value: c.revenue ?? 0,
    bookings: c.bookings ?? 0,
  }));

  // Revenue by brand (donut)
  const byBrandData = (bookingStats?.byBrand ?? []).map((b: any) => ({
    name: b.name ?? "Desconhecido",
    value: b.revenue ?? 0,
    bookings: b.bookings ?? 0,
  }));

  // Evolução mensal: receita entregue s/ IVA vs custos s/ IVA do motor (os
  // mesmos meses, a mesma base); meses futuros só com previsão.
  const monthlyEvolution = (fin?.monthly ?? []).map((m) => ({
    month: m.month,
    receita: m.revenueNet,
    despesas: m.costsNet,
    receitaPrevista: m.revenueForecastNet,
    custosPrevistos: m.costForecast,
  }));

  // Expenses by category (pie)
  const categoryData = (expenseStats?.byCategory ?? []).map((c: any) => ({
    name: c.categoryName ?? "Sem categoria",
    value: c.total ?? 0,
    count: c.count,
  }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <p className="text-sm text-muted-foreground">
          Receita, custos e margem com a MESMA base da Faturação (entregues CHECKED_OUT, sem IVA, mesmo período)
        </p>
      </div>

      {/* Filter Bar */}
      <DashboardFilterBar
        from={filters.from}
        to={filters.to}
        onFromChange={filters.setFrom}
        onToChange={filters.setTo}
        cityId={filters.cityId}
        onCityChange={filters.setCityId}
        brandId={filters.brandId}
        onBrandChange={filters.setBrandId}
        showPeriod
        period={filters.period}
        onPeriodChange={filters.setPeriod}
      />

      {/* ═══ MARKETING (resumo; detalhe em Financeiro → Marketing) ═══ */}
      <MarketingSummaryCard from={filters.from} to={filters.to} projectId={filters.projectId} />

      {/* ═══ DESPESAS DASHBOARD ═══ */}
      <Card className="border-dashed">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Wallet className="h-4 w-4 text-red-500" />
            Dashboard de Despesas
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {expenseLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[1,2,3,4].map(i => <SkeletonCard key={i} />)}
            </div>
          ) : (
            <>
              {/* Expense KPIs */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <div className="p-3 rounded-lg bg-muted/50 border min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Euro className="h-3.5 w-3.5 text-blue-500" />
                    <span className="text-xs text-muted-foreground">Total Despesas</span>
                  </div>
                  <FitAmount value={totalDespesasAnual} className="text-lg sm:text-xl font-bold" />
                  <p className="text-xs text-muted-foreground">{totalDespesasCount} registos</p>
                </div>
                <div className="p-3 rounded-lg bg-muted/50 border min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                    <span className="text-xs text-muted-foreground">Pago</span>
                  </div>
                  <FitAmount value={Math.max(0, pagoDespesas)} className="text-lg sm:text-xl font-bold text-green-700 dark:text-green-400" />
                </div>
                <div className="p-3 rounded-lg bg-muted/50 border min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Clock className="h-3.5 w-3.5 text-yellow-500" />
                    <span className="text-xs text-muted-foreground">Pendente</span>
                  </div>
                  <FitAmount value={pendente} className="text-lg sm:text-xl font-bold text-amber-700 dark:text-amber-400" />
                  <p className="text-xs text-muted-foreground">{expenseStats?.pending?.count ?? 0} despesa(s)</p>
                </div>
                <div className="p-3 rounded-lg bg-muted/50 border min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <AlertCircle className="h-3.5 w-3.5 text-red-500" />
                    <span className="text-xs text-muted-foreground">Em Atraso</span>
                  </div>
                  <FitAmount value={emAtraso} className="text-lg sm:text-xl font-bold text-destructive" />
                  <p className="text-xs text-muted-foreground">{expenseStats?.overdue?.count ?? 0} despesa(s)</p>
                </div>
              </div>

              {/* Status progress bar */}
              {totalStatusValue > 0 && (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {statusData.map(s => (
                      <div key={s.name} className="flex items-center gap-1.5">
                        <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: s.color }} />
                        <span>{s.name}: {((s.value / totalStatusValue) * 100).toFixed(0)}%</span>
                      </div>
                    ))}
                  </div>
                  <div className="h-3 rounded-full overflow-hidden flex bg-muted">
                    {statusData.map(s => (
                      <div
                        key={s.name}
                        className="h-full transition-all"
                        style={{
                          width: `${(s.value / totalStatusValue) * 100}%`,
                          backgroundColor: s.color,
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Category + Monthly mini charts side by side */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Monthly trend mini bar */}
                {(expenseStats?.monthlyTrend ?? []).length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">Despesas Mensais</p>
                    <ResponsiveContainer width="100%" height={140}>
                      <BarChart data={(expenseStats?.monthlyTrend ?? []).map((m: any) => ({ month: m.month, total: m.total ?? 0 }))} margin={{ top: 4, right: 4, left: 0, bottom: 4 }}>
                        <XAxis dataKey="month" tick={AXIS_TICK} interval="preserveStartEnd" minTickGap={8} />
                        <YAxis tick={AXIS_TICK} tickFormatter={eurAxis} width={64} />
                        <Tooltip formatter={(v: any) => [fmt(parseFloat(String(v))), "Total"]} contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_TOOLTIP_ITEM} cursor={{ fill: "var(--muted)" }} />
                        <Bar dataKey="total" fill="var(--chart-1)" radius={[3, 3, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
                {/* Category breakdown mini */}
                {categoryData.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">Por Categoria (Top 5)</p>
                    <div className="space-y-1.5">
                      {categoryData
                        .sort((a: any, b: any) => b.value - a.value)
                        .slice(0, 5)
                        .map((c: any, i: number) => {
                          const maxVal = categoryData[0]?.value || 1;
                          return (
                            <div key={c.name} className="flex items-center gap-2 min-w-0">
                              <span className="text-xs w-24 sm:w-32 shrink-0 truncate text-muted-foreground" title={c.name}>{c.name}</span>
                              <div className="flex-1 min-w-8 h-3 bg-muted rounded-full overflow-hidden">
                                <div
                                  className="h-full rounded-full"
                                  style={{
                                    width: `${(c.value / maxVal) * 100}%`,
                                    backgroundColor: COLORS[i % COLORS.length],
                                  }}
                                />
                              </div>
                              <span className="text-xs font-medium shrink-0 text-right tabular-nums">{fmt(c.value)}</span>
                            </div>
                          );
                        })}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ═══ DASHBOARD FINANCEIRO GERAL ═══ */}

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
        {isLoading ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : (
          <>
            <StatCard
              title={fin?.isCurrentPeriod ? "Entregues s/ IVA (até hoje)" : "Entregues s/ IVA"}
              value={receitaPeriodo}
              subtitle={`${fin?.revenue.producedCount ?? 0} carros saídos (CHECKED_OUT) · base da Faturação`}
              icon={Euro}
              className="lg:col-span-2"
              iconBg="bg-emerald-100"
              iconColor="text-emerald-600"
            />
            <StatCard
              title={fin?.isCurrentPeriod ? "Custos s/ IVA (até hoje)" : "Custos s/ IVA"}
              value={custosPeriodo}
              subtitle="despesas + pessoal + TSU + equipa do dia + comissões, no mesmo período"
              icon={TrendingDown}
              className="lg:col-span-2"
              iconBg="bg-red-100"
              iconColor="text-red-600"
            />
            <StatCard
              title="Pendente (dívida atual)"
              value={pendente}
              subtitle={`${expenseStats?.pending?.count ?? 0} despesa(s) — não depende do período`}
              icon={Clock}
              className="sm:col-span-2 lg:col-span-2"
              iconBg="bg-yellow-100"
              iconColor="text-yellow-600"
            />
            <StatCard
              title="Em Atraso (dívida atual)"
              value={emAtraso}
              subtitle={`${expenseStats?.overdue?.count ?? 0} despesa(s) — não depende do período`}
              icon={AlertCircle}
              className="lg:col-span-3"
              iconBg="bg-orange-100"
              iconColor="text-orange-600"
            />
            <StatCard
              title={fin?.isCurrentPeriod ? "Margem realizada" : "Margem s/ IVA"}
              value={margem}
              subtitle={fin?.projection.applies
                ? `${fin.margin.marginPct != null ? fin.margin.marginPct.toFixed(1) + "% · " : ""}fecho previsto: ${fmt(fin.projection.margin)}`
                : `${fin?.margin.marginPct != null ? fin.margin.marginPct.toFixed(1) + "% · " : ""}entregues − custos (igual à Faturação)`}
              icon={TrendingUp}
              className="lg:col-span-3"
              iconBg={margem >= 0 ? "bg-emerald-100" : "bg-red-100"}
              iconColor={margem >= 0 ? "text-emerald-600" : "text-red-600"}
            />
          </>
        )}
      </div>

      {/* Charts Row 1: Donut charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Revenue by city */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">
              Reservas criadas por cidade
            </CardTitle>
            <p className="text-xs text-muted-foreground">Valor c/ IVA das reservas CRIADAS no período (outra base — não é a receita da Faturação)</p>
          </CardHeader>
          <CardContent>
            {bookingLoading ? (
              <SkeletonChart />
            ) : byCityData.length === 0 ? (
              <div className="flex items-center justify-center h-60 text-muted-foreground text-sm">
                Sem dados disponíveis
              </div>
            ) : (
              <>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={byCityData}
                    cx="50%"
                    cy="50%"
                    innerRadius={58}
                    outerRadius={90}
                    paddingAngle={3}
                    dataKey="value"
                  >
                    {byCityData.map((_: any, i: number) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(v: any, _name: any, props: any) => [
                      `${fmt(parseFloat(String(v)))} (${props.payload.bookings} reservas)`,
                      props.payload.name,
                    ]}
                    contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_TOOLTIP_ITEM}
                  />
                </PieChart>
              </ResponsiveContainer>
              <DonutLegend items={byCityData} />
              </>
            )}
          </CardContent>
        </Card>

        {/* Revenue by brand */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">
              Reservas criadas por marca
            </CardTitle>
            <p className="text-xs text-muted-foreground">Valor c/ IVA das reservas CRIADAS no período (outra base — não é a receita da Faturação)</p>
          </CardHeader>
          <CardContent>
            {bookingLoading ? (
              <SkeletonChart />
            ) : byBrandData.length === 0 ? (
              <div className="flex items-center justify-center h-60 text-muted-foreground text-sm">
                Sem dados disponíveis
              </div>
            ) : (
              <>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={byBrandData}
                    cx="50%"
                    cy="50%"
                    innerRadius={58}
                    outerRadius={90}
                    paddingAngle={3}
                    dataKey="value"
                  >
                    {byBrandData.map((_: any, i: number) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(v: any, _name: any, props: any) => [
                      `${fmt(parseFloat(String(v)))} (${props.payload.bookings} reservas)`,
                      props.payload.name,
                    ]}
                    contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_TOOLTIP_ITEM}
                  />
                </PieChart>
              </ResponsiveContainer>
              <DonutLegend items={byBrandData} />
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Charts Row 2: Monthly evolution + Category pie */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Monthly evolution area chart */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base font-semibold">
              Evolução mensal: entregues vs custos (s/ IVA)
            </CardTitle>
            <p className="text-xs text-muted-foreground">Mesma base e mesmos meses da Faturação; nos meses futuros só a previsão (tracejado)</p>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <SkeletonChart />
            ) : monthlyEvolution.length === 0 ? (
              <div className="flex items-center justify-center h-60 text-muted-foreground text-sm">
                Sem dados mensais disponíveis
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart
                  data={monthlyEvolution}
                  margin={{ top: 4, right: 4, left: 0, bottom: 4 }}
                >
                  <defs>
                    <linearGradient
                      id="colorReceita"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="5%"
                        stopColor="var(--chart-2)"
                        stopOpacity={0.3}
                      />
                      <stop
                        offset="95%"
                        stopColor="var(--chart-2)"
                        stopOpacity={0}
                      />
                    </linearGradient>
                    <linearGradient
                      id="colorDespesas"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="5%"
                        stopColor="var(--destructive)"
                        stopOpacity={0.3}
                      />
                      <stop
                        offset="95%"
                        stopColor="var(--destructive)"
                        stopOpacity={0}
                      />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    dataKey="month"
                    tick={AXIS_TICK}
                    interval="preserveStartEnd"
                    minTickGap={12}
                  />
                  <YAxis
                    tick={AXIS_TICK}
                    tickFormatter={eurAxis}
                    width={68}
                  />
                  <Tooltip
                    formatter={(v: any, name: string) => [
                      fmt(parseFloat(String(v))),
                      EVOLUTION_LABEL[name] ?? name,
                    ]}
                    contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_TOOLTIP_ITEM}
                  />
                  <Legend iconSize={10} wrapperStyle={{ fontSize: "12px", paddingTop: 8 }} formatter={(value) => <span className="text-foreground">{EVOLUTION_LABEL[value] ?? value}</span>} />
                  <Area
                    type="monotone"
                    dataKey="receita"
                    stroke="var(--chart-2)"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorReceita)"
                  />
                  <Area
                    type="monotone"
                    dataKey="despesas"
                    stroke="var(--destructive)"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorDespesas)"
                  />
                  <Area type="monotone" dataKey="receitaPrevista" stroke="var(--chart-2)" strokeDasharray="4 4" strokeWidth={1.5} fillOpacity={0} />
                  <Area type="monotone" dataKey="custosPrevistos" stroke="var(--destructive)" strokeDasharray="4 4" strokeWidth={1.5} fillOpacity={0} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Expenses by category pie */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">
              Despesas por Categoria
            </CardTitle>
          </CardHeader>
          <CardContent>
            {expenseLoading ? (
              <SkeletonChart />
            ) : categoryData.length === 0 ? (
              <div className="flex items-center justify-center h-60 text-muted-foreground text-sm">
                Sem dados disponíveis
              </div>
            ) : (
              <>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={categoryData}
                    cx="50%"
                    cy="50%"
                    innerRadius={58}
                    outerRadius={90}
                    paddingAngle={3}
                    dataKey="value"
                  >
                    {categoryData.map((_: any, i: number) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(v: any) => [fmt(parseFloat(String(v)))]}
                    contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_TOOLTIP_ITEM}
                  />
                </PieChart>
              </ResponsiveContainer>
              <DonutLegend items={categoryData} />
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Upcoming payments table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Clock className="h-4 w-4 text-yellow-500" />
            Pagamentos nos próximos 7 dias
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isAdmin && upcomingLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border"
                >
                  <div className="space-y-2 flex-1">
                    <div className="h-4 w-40 bg-muted rounded animate-pulse" />
                    <div className="h-3 w-28 bg-muted rounded animate-pulse" />
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="h-4 w-16 bg-muted rounded animate-pulse" />
                    <div className="h-5 w-14 bg-muted rounded animate-pulse" />
                  </div>
                </div>
              ))}
            </div>
          ) : !upcoming || upcoming.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              Nenhum pagamento pendente nos próximos 7 dias
            </div>
          ) : (
            <div className="space-y-3">
              {upcoming.map(({ expense, project }: any) => {
                const daysLeft = Math.ceil(
                  (new Date(expense.paymentDueDate).getTime() - Date.now()) /
                    (1000 * 60 * 60 * 24)
                );
                return (
                  <div
                    key={expense.id}
                    className="flex items-center justify-between gap-3 p-3 rounded-lg bg-muted/50 border"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm text-foreground truncate">
                        {expense.supplier ?? "Sem fornecedor"}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {project?.name ?? "Sem projeto"} · Vence em{" "}
                        {format(new Date(expense.paymentDueDate), "dd MMM", {
                          locale: pt,
                        })}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-3 shrink-0">
                      <span className="font-semibold text-sm tabular-nums">
                        {fmt(parseFloat(String(expense.amount)))}
                      </span>
                      <Badge
                        variant="outline"
                        className={
                          daysLeft <= 1
                            ? "border-red-300 text-red-700 bg-red-50"
                            : daysLeft <= 3
                              ? "border-yellow-300 text-yellow-700 bg-yellow-50"
                              : "border-blue-300 text-blue-700 bg-blue-50"
                        }
                      >
                        {daysLeft === 0
                          ? "Hoje"
                          : daysLeft === 1
                            ? "Amanhã"
                            : `${daysLeft} dias`}
                      </Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
