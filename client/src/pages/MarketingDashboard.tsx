import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { useDashboardFilters, DashboardFilterBar } from "@/components/DashboardFilterBar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend,
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  BarChart, Bar,
} from "recharts";
import {
  DollarSign, Megaphone, CalendarCheck, TrendingDown,
  Eye, MousePointerClick, Percent,
} from "lucide-react";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const PLATFORM_LABELS: Record<string, string> = {
  google_ads: "Google Ads",
  meta_ads: "Meta Ads",
  instagram: "Instagram",
  other: "Outro",
};

import {
  PLATFORM_COLORS as PLATFORM_COLORS_SHARED,
  CHART_PALETTE,
} from "@/lib/chart-theme";

// Cores oficiais das plataformas — mantidas para reconhecimento visual.
const PLATFORM_COLORS: Record<string, string> = {
  google_ads: PLATFORM_COLORS_SHARED.google_ads,
  meta_ads: PLATFORM_COLORS_SHARED.meta_ads,
  instagram: PLATFORM_COLORS_SHARED.instagram,
  other: PLATFORM_COLORS_SHARED.other,
};

const CHART_COLORS = [
  PLATFORM_COLORS.google_ads,
  PLATFORM_COLORS.meta_ads,
  PLATFORM_COLORS.instagram,
  ...CHART_PALETTE.slice(1, 5),
];

const formatEUR = (value: number) =>
  new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(value);

// ─── MAIN PAGE ───────────────────────────────────────────────────────────────

export default function MarketingDashboard() {
  const filters = useDashboardFilters();
  const { from, to, projectId } = filters;

  const queryFilters = { from: from || undefined, to: to || undefined, projectId };

  // ─── Queries ────────────────────────────────────────────────────────────────
  const { data: dashboardStats } = trpc.marketing.dashboard.useQuery(queryFilters);
  const { data: allStats } = trpc.marketing.stats.all.useQuery(queryFilters);
  const { data: campaignsList } = trpc.marketing.campaigns.list.useQuery(
    projectId ? { projectId } : undefined,
  );
  const { data: expenses } = trpc.marketing.expenses.list.useQuery(
    { from: from || undefined, to: to || undefined, projectId } as any,
  );
  const { data: bookingStats } = trpc.multipark.bookingStats.useQuery(queryFilters);

  // ─── KPI computations ──────────────────────────────────────────────────────
  const totalMonthlySpend = (dashboardStats?.totalSpend ?? 0) + (dashboardStats?.totalMktExpenses ?? 0);

  const activeCampaigns = useMemo(() => {
    if (!campaignsList) return 0;
    return campaignsList.filter((c: any) => c.campaign.status === "active").length;
  }, [campaignsList]);

  const totalReservations = (bookingStats as any)?.reservasMes ?? (bookingStats as any)?.total ?? 0;

  const costPerReservation = totalReservations > 0 ? totalMonthlySpend / totalReservations : 0;

  const totalImpressions = dashboardStats?.totalImpressions ?? 0;
  const totalClicks = dashboardStats?.totalClicks ?? 0;
  const avgCTR = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;

  // ─── Platform spend donut ──────────────────────────────────────────────────
  const platformSpendData = useMemo(() => {
    if (!allStats) return [];
    const map = new Map<string, number>();
    allStats.forEach((s: any) => {
      const platform = s.campaign?.platform || "other";
      map.set(platform, (map.get(platform) || 0) + parseFloat(s.stat.spend || "0"));
    });
    if (expenses) {
      (expenses as any[]).forEach((e: any) => {
        const cat = e.category;
        if (cat === "google_ads" || cat === "meta_ads" || cat === "instagram") {
          map.set(cat, (map.get(cat) || 0) + parseFloat(e.amount || "0"));
        }
      });
    }
    return Array.from(map.entries())
      .filter(([, v]) => v > 0)
      .map(([platform, spend]) => ({
        name: PLATFORM_LABELS[platform] || platform,
        value: spend,
        platform,
      }));
  }, [allStats, expenses]);

  // ─── Daily impressions/clicks line chart ───────────────────────────────────
  const dailyData = useMemo(() => {
    if (!allStats) return [];
    const map = new Map<string, { date: string; impressions: number; clicks: number }>();
    allStats.forEach((s: any) => {
      const date = s.stat.date?.slice(0, 10);
      if (!date) return;
      const existing = map.get(date) || { date, impressions: 0, clicks: 0 };
      existing.impressions += s.stat.impressions || 0;
      existing.clicks += s.stat.clicks || 0;
      map.set(date, existing);
    });
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [allStats]);

  // ─── Top campaigns by CTR ─────────────────────────────────────────────────
  const topCampaignsByCTR = useMemo(() => {
    if (!allStats) return [];
    const map = new Map<number, { name: string; impressions: number; clicks: number }>();
    allStats.forEach((s: any) => {
      const id = s.campaign?.id;
      if (!id) return;
      const existing = map.get(id) || { name: s.campaign.name, impressions: 0, clicks: 0 };
      existing.impressions += s.stat.impressions || 0;
      existing.clicks += s.stat.clicks || 0;
      map.set(id, existing);
    });
    return Array.from(map.values())
      .filter((c) => c.impressions > 0)
      .map((c) => ({ ...c, ctr: (c.clicks / c.impressions) * 100 }))
      .sort((a, b) => b.ctr - a.ctr)
      .slice(0, 8);
  }, [allStats]);

  // ─── Loading state ─────────────────────────────────────────────────────────
  const isLoading = !dashboardStats;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Dashboard Marketing</h1>
        <p className="text-muted-foreground text-sm">Visao geral de marketing e campanhas</p>
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

      {/* Loading */}
      {isLoading && (
        <div className="flex justify-center py-20">
          <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
        </div>
      )}

      {!isLoading && (
        <>
          {/* KPI Row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            <KPICard
              icon={<DollarSign className="w-5 h-5" />}
              label="Gasto Total"
              value={formatEUR(totalMonthlySpend)}
              color="text-blue-600"
              bgColor="bg-blue-50"
            />
            <KPICard
              icon={<Megaphone className="w-5 h-5" />}
              label="Campanhas Ativas"
              value={String(activeCampaigns)}
              color="text-emerald-600"
              bgColor="bg-emerald-50"
            />
            <KPICard
              icon={<CalendarCheck className="w-5 h-5" />}
              label="Reservas no Periodo"
              value={String(totalReservations)}
              color="text-indigo-600"
              bgColor="bg-indigo-50"
            />
            <KPICard
              icon={<TrendingDown className="w-5 h-5" />}
              label="Custo por Reserva"
              value={formatEUR(costPerReservation)}
              color="text-amber-600"
              bgColor="bg-amber-50"
            />
            <KPICard
              icon={<Percent className="w-5 h-5" />}
              label="CTR Medio"
              value={`${avgCTR.toFixed(2)}%`}
              color="text-purple-600"
              bgColor="bg-purple-50"
            />
          </div>

          {/* Charts Row 1 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Gasto por plataforma (donut) */}
            <Card className="rounded-xl shadow-sm">
              <CardHeader>
                <CardTitle className="text-base">Gasto por Plataforma</CardTitle>
              </CardHeader>
              <CardContent>
                {platformSpendData.length === 0 ? (
                  <p className="text-muted-foreground text-center py-12 text-sm">Sem dados de gastos no periodo.</p>
                ) : (
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie
                        data={platformSpendData}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={110}
                        paddingAngle={2}
                        label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                      >
                        {platformSpendData.map((d, i) => (
                          <Cell
                            key={i}
                            fill={PLATFORM_COLORS[d.platform] || CHART_COLORS[i % CHART_COLORS.length]}
                          />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v: number) => formatEUR(v)} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            {/* Evolucao diaria impressoes/cliques */}
            <Card className="rounded-xl shadow-sm">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Eye className="w-4 h-4" /> Impressoes & Cliques (Diario)
                </CardTitle>
              </CardHeader>
              <CardContent>
                {dailyData.length === 0 ? (
                  <p className="text-muted-foreground text-center py-12 text-sm">Sem dados de impressoes no periodo.</p>
                ) : (
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={dailyData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 11 }}
                        tickFormatter={(v: string) => v.slice(5)}
                      />
                      <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
                      <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
                      <Tooltip
                        formatter={(v: number, name: string) => [
                          v.toLocaleString("pt-PT"),
                          name === "impressions" ? "Impressoes" : "Cliques",
                        ]}
                        labelFormatter={(label: string) => label}
                      />
                      <Legend
                        formatter={(value: string) => (value === "impressions" ? "Impressoes" : "Cliques")}
                      />
                      <Line
                        yAxisId="left"
                        type="monotone"
                        dataKey="impressions"
                        stroke="#4285F4"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4 }}
                      />
                      <Line
                        yAxisId="right"
                        type="monotone"
                        dataKey="clicks"
                        stroke="#E4405F"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Charts Row 2 - Top Campaigns by CTR */}
          <div className="grid grid-cols-1 gap-6">
            <Card className="rounded-xl shadow-sm">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <MousePointerClick className="w-4 h-4" /> Top Campanhas por CTR
                </CardTitle>
              </CardHeader>
              <CardContent>
                {topCampaignsByCTR.length === 0 ? (
                  <p className="text-muted-foreground text-center py-12 text-sm">Sem dados de campanhas no periodo.</p>
                ) : (
                  <ResponsiveContainer width="100%" height={Math.max(200, topCampaignsByCTR.length * 40 + 40)}>
                    <BarChart data={topCampaignsByCTR} layout="vertical" margin={{ left: 20, right: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v: number) => `${v.toFixed(1)}%`} />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={160}
                        tick={{ fontSize: 11 }}
                        tickFormatter={(v: string) => v.length > 25 ? `${v.slice(0, 25)}...` : v}
                      />
                      <Tooltip
                        formatter={(v: number) => [`${v.toFixed(2)}%`, "CTR"]}
                        labelFormatter={(label: string) => label}
                      />
                      <Bar dataKey="ctr" fill="#8B5CF6" radius={[0, 4, 4, 0]} barSize={24} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

// ─── KPI Card ────────────────────────────────────────────────────────────────

function KPICard({
  icon,
  label,
  value,
  color = "text-primary",
  bgColor = "bg-primary/10",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color?: string;
  bgColor?: string;
}) {
  return (
    <Card className="rounded-xl shadow-sm">
      <CardContent className="flex items-center gap-4 p-4">
        <div className={`p-2.5 rounded-lg ${bgColor} ${color}`}>{icon}</div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground truncate">{label}</p>
          <p className="text-lg font-bold truncate">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}
