import { trpc } from "@/lib/trpc";
import { fmtPTDate, fmtPTDateTime } from "@/lib/lisbonTime";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { useDashboardFilters, DashboardFilterBar } from "@/components/DashboardFilterBar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import {
  AlertTriangle,
  Star,
  Clock,
  MessageSquare,
  Package,
  ShieldAlert,
  AlertCircle,
  CheckCircle2,
  Hourglass,
  Loader2,
} from "lucide-react";

const DONUT_COLORS = ["#3b82f6", "#f59e0b", "#10b981", "#a855f7", "#6b7280"];
const BAR_COLORS: Record<number, string> = {
  1: "#ef4444",
  2: "#f97316",
  3: "#eab308",
  4: "#84cc16",
  5: "#22c55e",
};
const SEVERITY_COLORS: Record<string, string> = {
  low: "#94a3b8",
  medium: "#3b82f6",
  high: "#f97316",
  critical: "#ef4444",
};
const SEVERITY_LABELS: Record<string, string> = {
  low: "Baixa",
  medium: "Média",
  high: "Alta",
  critical: "Crítica",
};

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  new: { label: "Novo", color: "bg-blue-100 text-blue-800" },
  analyzing: { label: "Em Análise", color: "bg-yellow-100 text-yellow-800" },
  waiting_client: { label: "Aguarda Cliente", color: "bg-purple-100 text-purple-800" },
  resolved: { label: "Resolvido", color: "bg-green-100 text-green-800" },
  closed: { label: "Fechado", color: "bg-gray-100 text-gray-800" },
  converted: { label: "Convertido", color: "bg-violet-100 text-violet-800" },
};

export default function SuporteDashboard() {
  const filters = useDashboardFilters();
  const globalFilters = useGlobalFilters();

  const { data: complaintStats, isLoading: loadingComplaints } = trpc.complaints.stats.useQuery();
  const { data: reviewStats, isLoading: loadingReviews } = trpc.reviews.stats.useQuery();
  const { data: incidentStats, isLoading: loadingIncidents } = trpc.incidents.stats.useQuery({});
  const { data: lostFoundItems = [], isLoading: loadingLostFound } = trpc.lostFound.list.useQuery(
    globalFilters.projectId !== undefined ? { projectId: globalFilters.projectId } : undefined
  );
  const { data: pendingComplaints = [] } = trpc.complaints.list.useQuery(
    globalFilters.projectId !== undefined
      ? { status: "new", projectId: globalFilters.projectId }
      : { status: "new" }
  );

  const isLoading = loadingComplaints || loadingReviews || loadingIncidents || loadingLostFound;

  // Derived data
  const openLostFound = useMemo(
    () => lostFoundItems.filter((i: any) => i.status === "new" || i.status === "investigating").length,
    [lostFoundItems]
  );

  const openComplaints = (complaintStats?.new ?? 0) + (complaintStats?.analyzing ?? 0) + (complaintStats?.waitingClient ?? 0);

  // Chart data: Reclamacoes por estado (donut)
  const complaintDonutData = useMemo(() => {
    if (!complaintStats) return [];
    return [
      { name: "Novas", value: complaintStats.new },
      { name: "Em Análise", value: complaintStats.analyzing },
      { name: "Aguarda Cliente", value: complaintStats.waitingClient },
      { name: "Resolvidas", value: complaintStats.resolved },
      { name: "Fechadas", value: complaintStats.closed },
    ].filter(d => d.value > 0);
  }, [complaintStats]);

  // Chart data: star distribution (bar)
  const starBarData = useMemo(() => {
    if (!reviewStats) return [];
    return [
      { stars: "1\u2605", count: reviewStats.star1, fill: BAR_COLORS[1] },
      { stars: "2\u2605", count: reviewStats.star2, fill: BAR_COLORS[2] },
      { stars: "3\u2605", count: reviewStats.star3, fill: BAR_COLORS[3] },
      { stars: "4\u2605", count: reviewStats.star4, fill: BAR_COLORS[4] },
      { stars: "5\u2605", count: reviewStats.star5, fill: BAR_COLORS[5] },
    ];
  }, [reviewStats]);

  // Chart data: incidents by severity (bar)
  const severityBarData = useMemo(() => {
    if (!incidentStats) return [];
    // Count by severity from byType isn't available directly;
    // we use the stats shape. Let's build from the overall stats.
    // incidentStats only has: total, open, resolved, critical, byType
    // We don't have per-severity counts from the stats endpoint,
    // so we'll show byType instead as a useful alternative
    return Object.entries(incidentStats.byType || {})
      .map(([type, count]) => ({
        name: TYPE_LABELS[type] || type,
        count: count as number,
      }))
      .sort((a, b) => b.count - a.count);
  }, [incidentStats]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ShieldAlert className="w-6 h-6 text-primary" />
          Dashboard Suporte
        </h1>
        <p className="text-muted-foreground">
          Visão geral de reclamações, reviews, ocorrências e perdidos & achados
        </p>
      </div>

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
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
        <Card className="relative overflow-hidden">
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1 min-w-0">
                <p className="text-xs sm:text-sm text-muted-foreground font-medium break-words">Reclamações Abertas</p>
                <p className="text-2xl font-bold text-foreground tabular-nums truncate">{openComplaints}</p>
                <p className="text-xs text-muted-foreground">{complaintStats?.total ?? 0} total</p>
              </div>
              <div className="h-8 w-8 sm:h-10 sm:w-10 shrink-0 rounded-xl flex items-center justify-center bg-red-100">
                <AlertTriangle className="h-5 w-5 text-red-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden">
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1 min-w-0">
                <p className="text-xs sm:text-sm text-muted-foreground font-medium break-words">Rating Médio Google</p>
                <p className="text-2xl font-bold text-foreground">
                  {reviewStats?.avg ?? 0}<span className="text-lg text-muted-foreground">/5</span>
                </p>
                <div className="flex gap-0.5">
                  {[1, 2, 3, 4, 5].map(i => (
                    <Star
                      key={i}
                      className={`w-3 h-3 ${i <= Math.round(reviewStats?.avg ?? 0) ? "fill-amber-400 text-amber-400" : "text-gray-300"}`}
                    />
                  ))}
                </div>
              </div>
              <div className="h-8 w-8 sm:h-10 sm:w-10 shrink-0 rounded-xl flex items-center justify-center bg-amber-100">
                <Star className="h-5 w-5 text-amber-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden">
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1 min-w-0">
                <p className="text-xs sm:text-sm text-muted-foreground font-medium break-words">Reviews Pendentes</p>
                <p className="text-2xl font-bold text-yellow-700 tabular-nums truncate">{reviewStats?.pending ?? 0}</p>
                <p className="text-xs text-muted-foreground">sem resposta</p>
              </div>
              <div className="h-8 w-8 sm:h-10 sm:w-10 shrink-0 rounded-xl flex items-center justify-center bg-yellow-100">
                <MessageSquare className="h-5 w-5 text-yellow-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden">
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1 min-w-0">
                <p className="text-xs sm:text-sm text-muted-foreground font-medium break-words">Ocorrências Abertas</p>
                <p className="text-2xl font-bold text-orange-700 tabular-nums truncate">{incidentStats?.open ?? 0}</p>
                <p className="text-xs text-muted-foreground">{incidentStats?.total ?? 0} total</p>
              </div>
              <div className="h-8 w-8 sm:h-10 sm:w-10 shrink-0 rounded-xl flex items-center justify-center bg-orange-100">
                <AlertCircle className="h-5 w-5 text-orange-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden">
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1 min-w-0">
                <p className="text-xs sm:text-sm text-muted-foreground font-medium break-words">Itens Perdidos</p>
                <p className="text-2xl font-bold text-blue-700 tabular-nums truncate">{openLostFound}</p>
                <p className="text-xs text-muted-foreground">abertos</p>
              </div>
              <div className="h-8 w-8 sm:h-10 sm:w-10 shrink-0 rounded-xl flex items-center justify-center bg-blue-100">
                <Package className="h-5 w-5 text-blue-600" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Reclamacoes por estado - Donut */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reclamações por Estado</CardTitle>
          </CardHeader>
          <CardContent>
            {complaintDonutData.length === 0 ? (
              <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
                Sem dados de reclamações
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={complaintDonutData}
                    cx="50%"
                    cy="50%"
                    innerRadius="50%"
                    outerRadius="80%"
                    paddingAngle={3}
                    dataKey="value"
                    nameKey="name"
                  >
                    {complaintDonutData.map((_, idx) => (
                      <Cell key={idx} fill={DONUT_COLORS[idx % DONUT_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend
                    wrapperStyle={{ fontSize: 12 }}
                    formatter={(value: string, entry: any) => (
                      <span className="text-foreground">
                        {value}: <span className="font-semibold tabular-nums">{entry?.payload?.value}</span>
                      </span>
                    )}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Distribuicao de ratings Google - Bar */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Distribuição de Ratings Google</CardTitle>
          </CardHeader>
          <CardContent>
            {starBarData.every(d => d.count === 0) ? (
              <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
                Sem dados de reviews
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={starBarData}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="stars" />
                  <YAxis allowDecimals={false} />
                  <Tooltip formatter={(value: number) => [value, "Reviews"]} />
                  <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                    {starBarData.map((entry, idx) => (
                      <Cell key={idx} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Ocorrencias por tipo - Bar */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Ocorrências por Tipo</CardTitle>
          </CardHeader>
          <CardContent>
            {severityBarData.length === 0 ? (
              <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
                Sem dados de ocorrências
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={severityBarData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} />
                  <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 12 }} />
                  <Tooltip formatter={(value: number) => [value, "Ocorrências"]} />
                  <Bar dataKey="count" fill="#f97316" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Ultimas reclamacoes pendentes - Mini table */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Últimas Reclamações Pendentes
            </CardTitle>
          </CardHeader>
          <CardContent>
            {pendingComplaints.length === 0 ? (
              <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
                <div className="text-center">
                  <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-green-500" />
                  <p>Sem reclamações pendentes</p>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {(pendingComplaints as any[]).slice(0, 5).map((c: any) => (
                  <div
                    key={c.id}
                    className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5 min-w-0">
                        <span className="font-medium text-sm truncate" title={c.title || c.clientName}>#{c.id} {c.title || c.clientName}</span>
                        {STATUS_LABELS[c.complaintStatus ?? c.status] && (
                          <Badge className={`shrink-0 ${STATUS_LABELS[c.complaintStatus ?? c.status].color}`}>
                            {STATUS_LABELS[c.complaintStatus ?? c.status].label}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-x-3 gap-y-0.5 flex-wrap text-xs text-muted-foreground min-w-0">
                        {c.clientName && <span className="truncate max-w-full">{c.clientName}</span>}
                        {c.vehiclePlate && <span>{c.vehiclePlate}</span>}
                        {c.createdAt && (
                          <span>{fmtPTDate(c.createdAt)}</span>
                        )}
                      </div>
                    </div>
                    {(c.complaintPriority ?? c.priority) && (
                      <Badge
                        variant="outline"
                        className={`text-[11px] ml-2 shrink-0 ${
                          (c.complaintPriority ?? c.priority) === "urgent"
                            ? "border-red-300 text-red-700"
                            : (c.complaintPriority ?? c.priority) === "high"
                              ? "border-orange-300 text-orange-700"
                              : ""
                        }`}
                      >
                        {(c.complaintPriority ?? c.priority) === "urgent" ? "Urgente" : (c.complaintPriority ?? c.priority) === "high" ? "Alta" : (c.complaintPriority ?? c.priority) === "medium" ? "Média" : "Baixa"}
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

const TYPE_LABELS: Record<string, string> = {
  vidro_aberto: "Vidro Aberto",
  mal_estacionado: "Mal Estacionado",
  dano: "Dano",
  chave_errada: "Chave Errada",
  combustivel: "Combustível",
  limpeza: "Limpeza",
  documentos: "Documentos",
  outro: "Outro",
};
