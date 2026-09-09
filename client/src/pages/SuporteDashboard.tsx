import { trpc } from "@/lib/trpc";
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

import { CHART_PALETTE, CHART_PRIMARY, CHART_SEMANTIC } from "@/lib/chart-theme";

const DONUT_COLORS = CHART_PALETTE;
const BAR_COLORS: Record<number, string> = {
  1: CHART_SEMANTIC.danger,
  2: "#F97316",
  3: CHART_SEMANTIC.warning,
  4: "#84CC16",
  5: CHART_SEMANTIC.success,
};
const SEVERITY_COLORS: Record<string, string> = {
  low: CHART_SEMANTIC.muted,
  medium: CHART_PRIMARY,
  high: CHART_SEMANTIC.warning,
  critical: CHART_SEMANTIC.danger,
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
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card className="relative overflow-hidden">
          <CardContent className="pt-6">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground font-medium">Reclamações Abertas</p>
                <p className="text-2xl font-bold text-foreground">{openComplaints}</p>
                <p className="text-xs text-muted-foreground">{complaintStats?.total ?? 0} total</p>
              </div>
              <div className="h-10 w-10 rounded-xl flex items-center justify-center bg-red-100">
                <AlertTriangle className="h-5 w-5 text-red-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden">
          <CardContent className="pt-6">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground font-medium">Rating Médio Google</p>
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
              <div className="h-10 w-10 rounded-xl flex items-center justify-center bg-amber-100">
                <Star className="h-5 w-5 text-amber-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden">
          <CardContent className="pt-6">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground font-medium">Reviews Pendentes</p>
                <p className="text-2xl font-bold text-yellow-600">{reviewStats?.pending ?? 0}</p>
                <p className="text-xs text-muted-foreground">sem resposta</p>
              </div>
              <div className="h-10 w-10 rounded-xl flex items-center justify-center bg-yellow-100">
                <MessageSquare className="h-5 w-5 text-yellow-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden">
          <CardContent className="pt-6">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground font-medium">Ocorrências Abertas</p>
                <p className="text-2xl font-bold text-orange-600">{incidentStats?.open ?? 0}</p>
                <p className="text-xs text-muted-foreground">{incidentStats?.total ?? 0} total</p>
              </div>
              <div className="h-10 w-10 rounded-xl flex items-center justify-center bg-orange-100">
                <AlertCircle className="h-5 w-5 text-orange-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden">
          <CardContent className="pt-6">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground font-medium">Itens Perdidos</p>
                <p className="text-2xl font-bold text-blue-600">{openLostFound}</p>
                <p className="text-xs text-muted-foreground">abertos</p>
              </div>
              <div className="h-10 w-10 rounded-xl flex items-center justify-center bg-blue-100">
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
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie
                    data={complaintDonutData}
                    cx="50%"
                    cy="50%"
                    innerRadius={55}
                    outerRadius={90}
                    paddingAngle={3}
                    dataKey="value"
                    nameKey="name"
                    label={({ name, value }) => `${name}: ${value}`}
                  >
                    {complaintDonutData.map((_, idx) => (
                      <Cell key={idx} fill={DONUT_COLORS[idx % DONUT_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
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
                  <Bar dataKey="count" fill={CHART_SEMANTIC.warning} radius={[0, 6, 6, 0]} />
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
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="font-medium text-sm truncate">#{c.id} {c.title || c.clientName}</span>
                        <Badge className={STATUS_LABELS[c.status]?.color || "bg-gray-100"} >
                          {STATUS_LABELS[c.status]?.label || c.status}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        {c.clientName && <span>{c.clientName}</span>}
                        {c.vehiclePlate && <span>{c.vehiclePlate}</span>}
                        {c.createdAt && (
                          <span>{new Date(c.createdAt).toLocaleDateString("pt-PT")}</span>
                        )}
                      </div>
                    </div>
                    {c.priority && (
                      <Badge
                        variant="outline"
                        className={`text-[10px] ml-2 shrink-0 ${
                          c.priority === "urgent"
                            ? "border-red-300 text-red-700"
                            : c.priority === "high"
                              ? "border-orange-300 text-orange-700"
                              : ""
                        }`}
                      >
                        {c.priority === "urgent" ? "Urgente" : c.priority === "high" ? "Alta" : c.priority === "medium" ? "Média" : "Baixa"}
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
