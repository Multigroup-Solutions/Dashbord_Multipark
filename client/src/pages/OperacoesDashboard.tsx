import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { fmtPTDate, fmtPTDateTime } from "@/lib/lisbonTime";
import { useDashboardFilters, DashboardFilterBar } from "@/components/DashboardFilterBar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from "lucide-react";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtNum = (n: number) => n.toLocaleString("pt-PT");
const fmtDateTime = (d: string | null | undefined) =>
  d ? fmtPTDateTime(d) : "—";

const DONUT_COLORS = ["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899"];

const SYNC_STATUS_MAP: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  success: { label: "OK", variant: "default" },
  completed: { label: "OK", variant: "default" },
  error: { label: "Erro", variant: "destructive" },
  failed: { label: "Falhou", variant: "destructive" },
  running: { label: "A correr", variant: "secondary" },
  pending: { label: "Pendente", variant: "outline" },
};

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
    <Card className="relative overflow-hidden">
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground font-medium">{label}</p>
            {loading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <p className="text-2xl font-bold text-foreground">{value}</p>
            )}
          </div>
          <div className={`h-10 w-10 rounded-xl flex items-center justify-center bg-primary/10`}>
            <Icon className={`h-5 w-5 ${color || "text-primary"}`} />
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
  // Default date range: 30 days ago to today
  const thirtyDaysAgo = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  }, []);
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const filters = useDashboardFilters({ from: thirtyDaysAgo, to: today });

  // ── Queries ──

  const { data: bookingStats, isLoading: bkLoading } = trpc.multipark.bookingStats.useQuery({
    from: filters.from,
    to: filters.to,
    projectId: filters.projectId,
  });

  // GPS de ontem (Zello): km, velocidades e condutores — substitui os antigos
  // KPIs mortos (viaturas/violações manuais, tabelas sempre vazias)
  const yesterdayStr = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }, []);
  const { data: gpsYesterday = [], isLoading: gpsLoading } =
    trpc.operational.driverHistory.byDate.useQuery({ date: yesterdayStr });

  const { data: syncLogs, isLoading: syncLoading } = trpc.multipark.syncLogs.useQuery();

  // ── Derived data ──

  // Area chart: reservas by day from bookingStats
  const areaChartData = useMemo(() => {
    if (!bookingStats?.byDay?.length) return [];
    return bookingStats.byDay.map((d) => ({
      ...d,
      label: new Date(d.date).toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit" }),
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

  // Sync logs (last 8)
  const recentSyncLogs = useMemo(() => {
    if (!syncLogs?.length) return [];
    return syncLogs.slice(0, 8);
  }, [syncLogs]);

  // ── Render ──

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-[1400px] mx-auto">
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

      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <KPICard
          icon={CalendarCheck}
          label="Reservas hoje"
          value={fmtNum(bookingStats?.reservasHoje ?? 0)}
          loading={bkLoading}
        />
        <KPICard
          icon={ArrowDownToLine}
          label="Check-ins hoje"
          value={fmtNum(bookingStats?.checkinHoje ?? 0)}
          loading={bkLoading}
          color="text-green-600"
        />
        <KPICard
          icon={ArrowUpFromLine}
          label="Check-outs hoje"
          value={fmtNum(bookingStats?.checkoutHoje ?? 0)}
          loading={bkLoading}
          color="text-blue-600"
        />
        <KPICard
          icon={XCircle}
          label="Cancelados hoje"
          value={fmtNum(bookingStats?.canceladosHoje ?? 0)}
          loading={bkLoading}
          color="text-red-600"
        />
        <KPICard
          icon={Car}
          label={`Km ontem (GPS · ${gpsAgg.drivers} condutores)`}
          value={`${fmtNum(Math.round(gpsAgg.km))} km`}
          loading={gpsLoading}
          color="text-emerald-600"
        />
        <KPICard
          icon={Shield}
          label="Vel. máxima ontem (GPS)"
          value={`${fmtNum(Math.round(gpsAgg.vmax))} km/h`}
          loading={gpsLoading}
          color="text-amber-600"
        />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Area chart: reservas por dia */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reservas — últimos 30 dias</CardTitle>
          </CardHeader>
          <CardContent>
            {bkLoading ? (
              <div className="flex items-center justify-center h-[260px]">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
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
                    label={({ name, value }) => `${name}: ${fmtNum(value)}`}
                  >
                    {cityDonutData.map((_, i) => (
                      <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: number) => fmtNum(v)} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Bottom row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
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
            ) : gpsAgg.perDriver.length === 0 ? (
              <p className="text-muted-foreground text-center py-12">Sem dados GPS de ontem.</p>
            ) : (
              <div className="space-y-1.5">
                {gpsAgg.perDriver.map((d, i) => {
                  const maxKm = gpsAgg.perDriver[0]?.km || 1;
                  return (
                    <div key={`${d.name}-${i}`} className="flex items-center gap-2">
                      <span className="text-xs w-36 truncate text-muted-foreground">{d.name}</span>
                      <div className="flex-1 h-4 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full bg-emerald-500"
                          style={{ width: `${(d.km / maxKm) * 100}%` }}
                        />
                      </div>
                      <span className="text-xs font-medium w-16 text-right">{d.km} km</span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Sync logs table */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <RefreshCw className="w-4 h-4" />
              Últimos sync logs
            </CardTitle>
          </CardHeader>
          <CardContent>
            {syncLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : recentSyncLogs.length === 0 ? (
              <p className="text-muted-foreground text-center py-8">Sem registos de sincronização.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="pb-2 font-medium text-muted-foreground">Tipo</th>
                      <th className="pb-2 font-medium text-muted-foreground">Estado</th>
                      <th className="pb-2 font-medium text-muted-foreground">Registos</th>
                      <th className="pb-2 font-medium text-muted-foreground">Data</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentSyncLogs.map((log: any) => {
                      const statusInfo = SYNC_STATUS_MAP[log.status] || {
                        label: log.status,
                        variant: "outline" as const,
                      };
                      return (
                        <tr key={log.id} className="border-b last:border-0">
                          <td className="py-2 font-medium">{log.syncType || "—"}</td>
                          <td className="py-2">
                            <Badge variant={statusInfo.variant} className="text-xs">
                              {log.status === "success" || log.status === "completed" ? (
                                <CheckCircle2 className="w-3 h-3 mr-1" />
                              ) : log.status === "error" || log.status === "failed" ? (
                                <AlertCircle className="w-3 h-3 mr-1" />
                              ) : null}
                              {statusInfo.label}
                            </Badge>
                          </td>
                          <td className="py-2 text-muted-foreground">
                            {log.recordsProcessed != null ? fmtNum(log.recordsProcessed) : "—"}
                          </td>
                          <td className="py-2 text-muted-foreground text-xs">
                            {fmtDateTime(log.startedAt)}
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
    </div>
  );
}
