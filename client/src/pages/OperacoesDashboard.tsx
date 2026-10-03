import { useMemo } from "react";
import { useIsMobile } from "@/hooks/useMobile";
import { trpc } from "@/lib/trpc";
import { isForbidden, retryTransient } from "@/lib/queryRetry";
import { addDays, lisbonDayOf } from "@shared/lisbonDay";
import { Button } from "@/components/ui/button";
import { useDashboardFilters, DashboardFilterBar } from "@/components/DashboardFilterBar";
import { StatValue } from "@/components/StatValue";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import {
  CalendarCheck,
  ArrowDownToLine,
  ArrowUpFromLine,
  XCircle,
  Car,
  Shield,
  Loader2,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtNum = (n: number) => n.toLocaleString("pt-PT");

const DONUT_COLORS = ["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899"];

const FLEET_STATUS_LABELS: Record<string, string> = {
  active: "Ativas",
  maintenance: "Manutenção",
  inactive: "Inativas",
};

const FLEET_STATUS_COLORS: Record<string, string> = {
  active: "#10b981",
  maintenance: "#f59e0b",
  inactive: "#ef4444",
};

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function KPICard({
  icon: Icon,
  label,
  value,
  loading,
  color,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  loading?: boolean;
  color?: string;
}) {
  return (
    <Card className="relative overflow-hidden py-0 gap-0 min-w-0">
      <CardContent className="p-4 sm:p-5">
        {/* Em telemóvel o ícone vai para cima: lado a lado sobravam ~70px para o valor */}
        <div className="flex flex-col-reverse items-start gap-2 sm:flex-row sm:justify-between">
          <div className="space-y-1 min-w-0 w-full sm:flex-1">
            <p className="text-sm text-muted-foreground font-medium leading-snug line-clamp-2" title={label}>{label}</p>
            {loading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <StatValue value={value} min={18} max={24} className="text-foreground" />
            )}
          </div>
          <div className={`h-9 w-9 sm:h-10 sm:w-10 shrink-0 rounded-xl flex items-center justify-center bg-primary/10`}>
            <Icon className={`h-5 w-5 ${color || "text-primary"}`} aria-hidden />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Custom Tooltip ───────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-background border rounded-lg shadow-sm p-3 text-sm">
      <p className="font-medium mb-1">{label}</p>
      {payload.map((entry: any, i: number) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full" style={{ backgroundColor: entry.color }} />
          <span className="text-muted-foreground">{entry.name}:</span>
          <span className="font-medium">{fmtNum(entry.value)}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function OperacoesDashboard() {
  const isMobile = useIsMobile();
  // Por omissão: os últimos 30 dias (dias de Lisboa, hoje incluído).
  const today = useMemo(() => lisbonDayOf(Date.now()), []);
  const thirtyDaysAgo = useMemo(() => addDays(today, -29), [today]);

  const filters = useDashboardFilters({ from: thirtyDaysAgo, to: today });

  // ── Queries ──

  // 22a (D5): só contagens — basta o módulo dos painéis, sem os totais financeiros
  const bk = trpc.multipark.opsBookingCounts.useQuery(
    { from: filters.from, to: filters.to, projectId: filters.projectId },
    { retry: retryTransient },
  );
  const bookingStats = bk.data;
  const bkLoading = bk.isLoading;
  // Erro ≠ zero: sem números mostra-se "—" e o motivo, nunca 0.
  const bkError = bk.error && !bookingStats ? bk.error : null;
  const bkValue = (n: number | undefined) => (bookingStats ? fmtNum(n ?? 0) : "—");

  // GPS de ontem (Zello): km, velocidades e condutores — substitui os antigos
  // KPIs mortos (viaturas/violações manuais, tabelas sempre vazias)
  // Ontem no calendário de Lisboa (antes era UTC). Os dados de ontem são os da
  // recolha provisória (23:15–23:55); a final (D-2) substitui-os 2 dias depois.
  const yesterdayStr = useMemo(() => addDays(lisbonDayOf(Date.now()), -1), []);
  const gpsQ = trpc.operational.driverHistory.byDate.useQuery({ date: yesterdayStr }, { retry: retryTransient });
  const gpsYesterday = gpsQ.data ?? [];
  const gpsLoading = gpsQ.isLoading;
  const gpsError = gpsQ.error && !gpsQ.data ? gpsQ.error : null;

  // ── Derived data ──

  // Area chart: reservas by day from bookingStats
  const areaChartData = useMemo(() => {
    if (!bookingStats?.byDay?.length) return [];
    // "YYYY-MM-DD" (dia de Lisboa) → "dd/mm", sem passar por Date (fuso do browser).
    return bookingStats.byDay.map((d) => ({
      ...d,
      label: `${d.date.slice(8, 10)}/${d.date.slice(5, 7)}`,
    }));
  }, [bookingStats]);

  // Donut: reservas por cidade from bookingStats
  const cityDonutData = useMemo(() => {
    if (!bookingStats?.byCity?.length) return [];
    return bookingStats.byCity.map((c) => ({
      name: c.name,
      value: c.bookings,
    }));
  }, [bookingStats]);

  // GPS ontem: agregados + km por condutor
  const gpsAgg = useMemo(() => {
    const rows = (gpsYesterday as any[]) ?? [];
    const km = rows.reduce((s, r) => s + parseFloat(String(r.totalKm ?? 0)), 0);
    const vmax = rows.reduce((m, r) => Math.max(m, parseFloat(String(r.maxSpeed ?? 0))), 0);
    const drivers = rows.filter((r) => parseFloat(String(r.totalKm ?? 0)) > 0.5).length;
    const perDriver = rows
      .map((r) => ({
        name: r.employeeName || r.displayName || r.zelloUsername,
        km: Math.round(parseFloat(String(r.totalKm ?? 0)) * 10) / 10,
      }))
      .filter((r) => r.km > 0.5)
      .sort((a, b) => b.km - a.km)
      .slice(0, 12);
    return { km, vmax, drivers, perDriver };
  }, [gpsYesterday]);

  // ── Render ──

  return (
    <div className="space-y-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard Operações</h1>
        <p className="text-muted-foreground">
          Visão geral operacional e MultiPark
        </p>
      </div>

      {/* Filters */}
      <DashboardFilterBar
        from={filters.from}
        to={filters.to}
        onFromChange={filters.setFrom}
        onToChange={filters.setTo}
        cityId={filters.cityId}
        onCityChange={filters.setCityId}
        brandId={filters.brandId}
        onBrandChange={filters.setBrandId}
      />

      {bkError && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="p-4 text-sm flex flex-wrap items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              {isForbidden(bkError) ? (
                <>
                  <p className="font-medium">Sem acesso aos números das reservas.</p>
                  <p className="text-muted-foreground">Estes cartões pedem a permissão de ver os totais do Financeiro. As listas das Operações (/operacoes) mostram as reservas a quem vê Reservas &amp; Operações.</p>
                </>
              ) : (
                <>
                  <p className="font-medium">Não foi possível ler as reservas da Multipark.</p>
                  <p className="text-muted-foreground">{bkError.message}</p>
                </>
              )}
            </div>
            {!isForbidden(bkError) && (
              <Button variant="outline" size="sm" onClick={() => bk.refetch()} disabled={bk.isFetching}>
                <RefreshCw className={`w-4 h-4 mr-1 ${bk.isFetching ? "animate-spin" : ""}`} /> Tentar de novo
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* KPIs (reservas: parques nossos, sem compras online por acabar) */}
      <div className="grid grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6 gap-3 sm:gap-4">
        <KPICard
          icon={CalendarCheck}
          label="Reservas hoje"
          value={bkValue(bookingStats?.reservasHoje)}
          loading={bkLoading}
        />
        <KPICard
          icon={ArrowDownToLine}
          label="Check-ins hoje"
          value={bkValue(bookingStats?.checkinHoje)}
          loading={bkLoading}
          color="text-green-600"
        />
        <KPICard
          icon={ArrowUpFromLine}
          label="Check-outs hoje"
          value={bkValue(bookingStats?.checkoutHoje)}
          loading={bkLoading}
          color="text-blue-600"
        />
        <KPICard
          icon={XCircle}
          label="Cancelados hoje"
          value={bkValue(bookingStats?.canceladosHoje)}
          loading={bkLoading}
          color="text-red-600"
        />
        <KPICard
          icon={Car}
          label={gpsError ? "Km ontem (GPS)" : `Km ontem (GPS · ${gpsAgg.drivers} condutores)`}
          value={gpsError ? "—" : `${fmtNum(Math.round(gpsAgg.km))} km`}
          loading={gpsLoading}
          color="text-emerald-600"
        />
        <KPICard
          icon={Shield}
          label="Vel. máxima ontem (GPS)"
          value={gpsError ? "—" : `${fmtNum(Math.round(gpsAgg.vmax))} km/h`}
          loading={gpsLoading}
          color="text-amber-600"
        />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Area chart: reservas por dia */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reservas criadas por dia</CardTitle>
          </CardHeader>
          <CardContent>
            {bkLoading ? (
              <div className="flex items-center justify-center h-[260px]">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : bkError ? (
              <p className="text-muted-foreground text-center py-16">Sem números (ver o aviso acima).</p>
            ) : areaChartData.length === 0 ? (
              <p className="text-muted-foreground text-center py-16">Sem dados de reservas.</p>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={areaChartData}>
                  <defs>
                    <linearGradient id="colorReservas" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip content={<ChartTooltip />} />
                  <Area
                    type="monotone"
                    dataKey="reservas"
                    name="Reservas"
                    stroke="#6366f1"
                    fill="url(#colorReservas)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Donut: reservas por cidade */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reservas por cidade</CardTitle>
          </CardHeader>
          <CardContent>
            {bkLoading ? (
              <div className="flex items-center justify-center h-[260px]">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : bkError ? (
              <p className="text-muted-foreground text-center py-16">Sem números (ver o aviso acima).</p>
            ) : cityDonutData.length === 0 ? (
              <p className="text-muted-foreground text-center py-16">Sem dados por cidade.</p>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie
                    data={cityDonutData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={3}
                    dataKey="value"
                    nameKey="name"
                    label={isMobile ? false : ({ name, value }) => `${name}: ${fmtNum(value)}`}
                  >
                    {cityDonutData.map((_, i) => (
                      <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: number) => fmtNum(v)} />
                  {/* Em telemóvel os rótulos à volta do donut saíam do cartão — os valores vão para a legenda */}
                  <Legend formatter={isMobile ? (v: string, e: any) => `${v}: ${fmtNum(e?.payload?.value ?? 0)}` : undefined} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Bottom row */}
      <div className="grid grid-cols-1 gap-6">
        {/* Km por condutor — ontem (GPS Zello) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Car className="w-4 h-4" />
              Km por condutor — ontem (GPS)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {gpsLoading ? (
              <div className="flex items-center justify-center h-[240px]">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : gpsError ? (
              <p className="text-muted-foreground text-center py-12">
                {isForbidden(gpsError) ? "Sem acesso ao GPS dos condutores." : `Não foi possível ler o GPS de ontem: ${gpsError.message}`}
              </p>
            ) : gpsAgg.perDriver.length === 0 ? (
              <p className="text-muted-foreground text-center py-12">Sem dados GPS de ontem (a recolha provisória corre às 23:15; a final 2 dias depois).</p>
            ) : (
              <div className="space-y-1.5">
                {gpsAgg.perDriver.map((d, i) => {
                  const maxKm = gpsAgg.perDriver[0]?.km || 1;
                  return (
                    <div key={`${d.name}-${i}`} className="flex items-center gap-2">
                      <span className="text-xs w-28 sm:w-36 shrink-0 truncate text-muted-foreground" title={d.name}>{d.name}</span>
                      <div className="flex-1 min-w-0 h-4 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full bg-emerald-500"
                          style={{ width: `${(d.km / maxKm) * 100}%` }}
                        />
                      </div>
                      <span className="text-xs font-medium shrink-0 min-w-16 text-right tabular-nums whitespace-nowrap">{d.km.toLocaleString("pt-PT", { maximumFractionDigits: 1 })} km</span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
