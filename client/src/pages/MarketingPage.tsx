import { useState, useMemo, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, LineChart, Line,
} from "recharts";
import {
  Megaphone, TrendingUp, Target, DollarSign, Plus, Trash2,
  Upload, Eye, BarChart3, Receipt, ArrowUpRight, MousePointerClick, FileSpreadsheet,
  AlertTriangle, CheckCircle2, Info, Loader2,
} from "lucide-react";

const PLATFORM_LABELS: Record<string, string> = {
  google_ads: "Google Ads",
  meta_ads: "Meta Ads",
  instagram: "Instagram",
  other: "Outro",
};
import {
  PLATFORM_COLORS as PLATFORM_COLORS_SHARED,
  CHART_PALETTE,
  CHART_SEMANTIC,
} from "@/lib/chart-theme";

const PLATFORM_COLORS: Record<string, string> = {
  google_ads: PLATFORM_COLORS_SHARED.google_ads,
  meta_ads: PLATFORM_COLORS_SHARED.meta_ads,
  instagram: PLATFORM_COLORS_SHARED.instagram,
  other: PLATFORM_COLORS_SHARED.other,
};
const MKT_CAT_LABELS: Record<string, string> = {
  google_ads: "Google Ads",
  meta_ads: "Meta Ads",
  influencer: "Influencers",
  print: "Impressão",
  merchandise: "Merchandise",
  event: "Eventos",
  other: "Outro",
};
const STATUS_LABELS: Record<string, string> = {
  active: "Ativa",
  paused: "Pausada",
  completed: "Concluída",
};
const CHART_COLORS = [
  PLATFORM_COLORS.google_ads,
  PLATFORM_COLORS.meta_ads,
  PLATFORM_COLORS.instagram,
  ...CHART_PALETTE.slice(1, 5),
];

export default function MarketingPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState("dashboard");

  return (
    <>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-muted-foreground">Campanhas, custos e performance</p>
          </div>
        </div>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="dashboard"><BarChart3 className="w-4 h-4 mr-1" />Dashboard</TabsTrigger>
            <TabsTrigger value="campaigns"><Megaphone className="w-4 h-4 mr-1" />Campanhas</TabsTrigger>
            <TabsTrigger value="expenses"><Receipt className="w-4 h-4 mr-1" />Despesas Mkt</TabsTrigger>
          </TabsList>

          <TabsContent value="dashboard"><DashboardTab /></TabsContent>
          <TabsContent value="campaigns"><CampaignsTab /></TabsContent>
          <TabsContent value="expenses"><MktExpensesTab /></TabsContent>
        </Tabs>
      </div>
    </>
  );
}

// ─── DASHBOARD ───────────────────────────────────────────────────────────────

function DashboardTab() {
  const globalFilters = useGlobalFilters();
  const thisMonth = new Date();
  const firstDay = new Date(thisMonth.getFullYear(), thisMonth.getMonth(), 1).toISOString().slice(0, 10);
  const lastDay = new Date(thisMonth.getFullYear(), thisMonth.getMonth() + 1, 0).toISOString().slice(0, 10);
  const [from, setFrom] = useState(firstDay);
  const [to, setTo] = useState(lastDay);
  const [projectId, setProjectId] = useState<string>("");

  // Sync global filter to local project filter
  useEffect(() => {
    if (globalFilters.projectId !== undefined) {
      setProjectId(String(globalFilters.projectId));
    } else {
      setProjectId("");
    }
  }, [globalFilters.projectId]);

  const pid = projectId ? Number(projectId) : undefined;
  const queryFilters = { from: from || undefined, to: to || undefined, projectId: pid };
  const { data: projects = [] } = trpc.projects.list.useQuery();
  const { data: stats } = trpc.marketing.dashboard.useQuery(queryFilters);
  const { data: allStats } = trpc.marketing.stats.all.useQuery(queryFilters);
  const { data: bookingRevenue } = trpc.marketing.bookingRevenue.useQuery(queryFilters);

  const projectOptions = (projects as any[]);

  const sortedProjects = useMemo(() => {
    const all = projectOptions || [];
    const result: { id: number; name: string; level: string; depth: number }[] = [];
    const addChildren = (parentId: number | null, depth: number) => {
      all.filter((p: any) => p.parentId === parentId).forEach((p: any) => {
        result.push({ id: p.id, name: p.name, level: p.level, depth });
        addChildren(p.id, depth + 1);
      });
    };
    addChildren(null, 0);
    return result;
  }, [projectOptions]);

  const levelIcon = (level: string) => level === "group" ? "🏢" : level === "city" ? "📍" : level === "brand" ? "🏷" : "📁";

  const monthlyData = useMemo(() => {
    if (!allStats) return [];
    const map = new Map<string, { month: string; spend: number; reservations: number; value: number }>();
    allStats.forEach((s: any) => {
      const d = new Date(s.stat.date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const existing = map.get(key) || { month: key, spend: 0, reservations: 0, value: 0 };
      existing.spend += parseFloat(s.stat.spend || "0");
      existing.reservations += s.stat.conversions || 0;
      existing.value += parseFloat(s.stat.conversionValue || "0");
      map.set(key, existing);
    });
    return Array.from(map.values()).sort((a, b) => a.month.localeCompare(b.month));
  }, [allStats]);

  const platformData = useMemo(() => {
    if (!allStats) return [];
    const map = new Map<string, { platform: string; spend: number; reservations: number }>();
    allStats.forEach((s: any) => {
      const p = s.campaign?.platform || "other";
      const existing = map.get(p) || { platform: p, spend: 0, reservations: 0 };
      existing.spend += parseFloat(s.stat.spend || "0");
      existing.reservations += s.stat.conversions || 0;
      map.set(p, existing);
    });
    return Array.from(map.values()).map(d => ({ ...d, name: PLATFORM_LABELS[d.platform] || d.platform }));
  }, [allStats]);

  const realBookings = bookingRevenue?.total ?? 0;
  const realRevenue = bookingRevenue?.revenue ?? 0;
  const totalAdSpend = (stats?.totalSpend ?? 0) + (stats?.totalMktExpenses ?? 0);
  const costPerRealBooking = realBookings > 0 ? totalAdSpend / realBookings : 0;

  return (
    <div className="space-y-6 mt-4">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label className="text-xs mb-1 block">De</Label>
          <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="w-40" />
        </div>
        <div>
          <Label className="text-xs mb-1 block">Até</Label>
          <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="w-40" />
        </div>
        <div>
          <Label className="text-xs mb-1 block">Grupo / Projeto</Label>
          <Select value={projectId} onValueChange={v => setProjectId(v === "all" ? "" : v)}>
            <SelectTrigger className="w-56"><SelectValue placeholder="Todos" /></SelectTrigger>
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
      </div>

      {/* KPIs - Campanhas */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard icon={<DollarSign />} label="Gasto Total Ads" value={`${(stats?.totalSpend ?? 0).toFixed(2)} €`} />
        <KPICard icon={<Target />} label="Conversões (Campanhas)" value={String(stats?.totalReservations ?? 0)} />
        <KPICard icon={<Receipt />} label="Despesas Marketing" value={`${(stats?.totalMktExpenses ?? 0).toFixed(2)} €`} />
        <KPICard icon={<Megaphone />} label="Campanhas" value={String(stats?.campaignCount ?? 0)} />
      </div>

      {/* KPIs - Reservas Reais */}
      <Card className="border-green-200 bg-green-50/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-green-800">Reservas Reais (MultiPark)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Total Reservas</p>
              <p className="text-2xl font-bold text-green-700">{realBookings}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Receita Total</p>
              <p className="text-2xl font-bold text-green-700">{realRevenue.toFixed(2)} €</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Custo Aquisição / Reserva</p>
              <p className="text-2xl font-bold text-amber-600">{costPerRealBooking.toFixed(2)} €</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Receita Média / Reserva</p>
              <p className="text-2xl font-bold text-green-700">{realBookings > 0 ? (realRevenue / realBookings).toFixed(2) : "0.00"} €</p>
            </div>
          </div>
          {bookingRevenue && bookingRevenue.byProject.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3">
              {bookingRevenue.byProject.map((p: any, i: number) => (
                <Badge key={i} variant="outline" className="text-xs">
                  {p.parkName}: {p.count} res. ({p.revenue.toFixed(2)} €)
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard icon={<Eye />} label="Impressões" value={(stats?.totalImpressions ?? 0).toLocaleString()} />
        <KPICard icon={<MousePointerClick />} label="Cliques" value={(stats?.totalClicks ?? 0).toLocaleString()} />
        <KPICard icon={<TrendingUp />} label="Custo / Conversão (Ads)" value={`${(stats?.costPerReservation ?? 0).toFixed(2)} €`} />
        <KPICard icon={<ArrowUpRight />} label="Valor Médio Conversão" value={`${(stats?.avgConversionValue ?? 0).toFixed(2)} €`} />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>Gastos vs Reservas (Mensal)</CardTitle></CardHeader>
          <CardContent>
            {monthlyData.length === 0 ? (
              <p className="text-muted-foreground text-center py-8">Sem dados. Importa estatísticas de campanhas.</p>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={monthlyData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="month" />
                  <YAxis yAxisId="left" />
                  <YAxis yAxisId="right" orientation="right" />
                  <Tooltip formatter={(v: number, name: string) => name === "spend" ? `${v.toFixed(2)} €` : v} />
                  <Legend />
                  <Bar yAxisId="left" dataKey="spend" name="Gasto (€)" fill="#4285F4" radius={[4, 4, 0, 0]} />
                  <Bar yAxisId="right" dataKey="reservations" name="Reservas" fill="#F59E0B" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Gasto por Plataforma</CardTitle></CardHeader>
          <CardContent>
            {platformData.length === 0 ? (
              <p className="text-muted-foreground text-center py-8">Sem dados.</p>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie data={platformData} dataKey="spend" nameKey="name" cx="50%" cy="50%" outerRadius={100} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                    {platformData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => `${v.toFixed(2)} €`} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Cost per reservation trend */}
      {monthlyData.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Custo por Reserva (Evolução)</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={monthlyData.map(d => ({ ...d, cpr: d.reservations > 0 ? d.spend / d.reservations : 0 }))}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" />
                <YAxis />
                <Tooltip formatter={(v: number) => `${v.toFixed(2)} €`} />
                <Line type="monotone" dataKey="cpr" name="Custo/Reserva (€)" stroke="#E4405F" strokeWidth={2} dot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function KPICard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-4">
        <div className="p-2 rounded-lg bg-primary/10 text-primary">{icon}</div>
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="text-xl font-bold">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── CAMPAIGNS ───────────────────────────────────────────────────────────────

function CampaignsTab() {
  const globalFilters = useGlobalFilters();
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState<number | null>(null);
  const [showStats, setShowStats] = useState<number | null>(null);
  const [showGoogleAdsImport, setShowGoogleAdsImport] = useState(false);
  const [filterPlatform, setFilterPlatform] = useState("");
  const [filterProjectId, setFilterProjectId] = useState("");
  const utils = trpc.useUtils();

  // Sync global filter to local project filter
  useEffect(() => {
    if (globalFilters.projectId !== undefined) {
      setFilterProjectId(String(globalFilters.projectId));
    } else {
      setFilterProjectId("");
    }
  }, [globalFilters.projectId]);

  const queryFilters: any = {};
  if (filterPlatform) queryFilters.platform = filterPlatform;
  if (filterProjectId) queryFilters.projectId = Number(filterProjectId);

  const { data: campaignsList } = trpc.marketing.campaigns.list.useQuery(
    Object.keys(queryFilters).length > 0 ? queryFilters : undefined
  );
  const { data: projects } = trpc.projects.list.useQuery();
  const projectOptions = (projects as any[] || []);
  const deleteMut = trpc.marketing.campaigns.delete.useMutation({
    onSuccess: () => { utils.marketing.campaigns.list.invalidate(); toast.success("Campanha eliminada"); },
  });
  const updateMut = trpc.marketing.campaigns.update.useMutation({
    onSuccess: () => { utils.marketing.campaigns.list.invalidate(); toast.success("Projeto atribuído"); },
  });

  // Build sorted tree for dropdown
  const sortedProjects = useMemo(() => {
    const all = projectOptions as any[];
    const result: { id: number; name: string; level: string; depth: number }[] = [];
    const addChildren = (parentId: number | null, depth: number) => {
      all.filter(p => p.parentId === parentId).forEach(p => {
        result.push({ id: p.id, name: p.name, level: p.level, depth });
        addChildren(p.id, depth + 1);
      });
    };
    addChildren(null, 0);
    return result;
  }, [projectOptions]);

  const levelIcon = (level: string) => level === "group" ? "🏢" : level === "city" ? "📍" : level === "brand" ? "🏷" : "📁";

  return (
    <div className="space-y-4 mt-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Select value={filterPlatform} onValueChange={v => setFilterPlatform(v === "all" ? "" : v)}>
          <SelectTrigger className="w-[180px]"><SelectValue placeholder="Plataforma" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas</SelectItem>
            <SelectItem value="google_ads">Google Ads</SelectItem>
            <SelectItem value="meta_ads">Meta Ads</SelectItem>
            <SelectItem value="instagram">Instagram</SelectItem>
            <SelectItem value="other">Outro</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filterProjectId} onValueChange={v => setFilterProjectId(v === "all" ? "" : v)}>
          <SelectTrigger className="w-[220px]"><SelectValue placeholder="Projeto" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            {sortedProjects.map(p => (
              <SelectItem key={p.id} value={String(p.id)}>
                {"  ".repeat(p.depth)}{levelIcon(p.level)} {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={() => setShowCreate(true)}><Plus className="w-4 h-4 mr-1" />Nova Campanha</Button>
        <Button variant="outline" onClick={() => setShowGoogleAdsImport(true)}><Upload className="w-4 h-4 mr-1" />Importar Google Ads CSV</Button>
      </div>

      <div className="grid gap-3">
        {(!campaignsList || campaignsList.length === 0) ? (
          <Card><CardContent className="py-8 text-center text-muted-foreground">Sem campanhas. Cria a primeira!</CardContent></Card>
        ) : campaignsList.map((c: any) => (
          <Card key={c.campaign.id}>
            <CardContent className="flex items-center justify-between p-4 gap-3">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: PLATFORM_COLORS[c.campaign.platform] || "#6B7280" }} />
                <div className="min-w-0">
                  <p className="font-semibold truncate">{c.campaign.name}</p>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
                    <Badge variant="outline">{PLATFORM_LABELS[c.campaign.platform]}</Badge>
                    <Badge variant={c.campaign.status === "active" ? "default" : "secondary"}>{STATUS_LABELS[c.campaign.status]}</Badge>
                    {c.campaign.budget && <span>Orç: {c.campaign.budget} €</span>}
                  </div>
                </div>
              </div>
              <Select
                value={c.campaign.projectId ? String(c.campaign.projectId) : "none"}
                onValueChange={v => updateMut.mutate({ id: c.campaign.id, projectId: v === "none" ? null : Number(v) })}
              >
                <SelectTrigger className="w-[200px] shrink-0">
                  <SelectValue placeholder="Atribuir projeto..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sem projeto</SelectItem>
                  {sortedProjects.map(p => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {"  ".repeat(p.depth)}{levelIcon(p.level)} {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1 shrink-0">
                <Button size="sm" variant="outline" onClick={() => setShowStats(c.campaign.id)}>
                  <BarChart3 className="w-4 h-4 mr-1" />Stats
                </Button>
                <Button size="sm" variant="outline" onClick={() => setShowImport(c.campaign.id)}>
                  <Upload className="w-4 h-4 mr-1" />Importar
                </Button>
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => {
                  if (confirm("Eliminar campanha e todos os dados?")) deleteMut.mutate({ id: c.campaign.id });
                }}><Trash2 className="w-4 h-4" /></Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {showCreate && <CreateCampaignDialog projects={projects || []} onClose={() => setShowCreate(false)} />}
      {showImport !== null && <ImportStatsDialog campaignId={showImport} onClose={() => setShowImport(null)} />}
      {showStats !== null && <CampaignStatsDialog campaignId={showStats} onClose={() => setShowStats(null)} />}
      {showGoogleAdsImport && <GoogleAdsImportDialog onClose={() => { setShowGoogleAdsImport(false); utils.marketing.campaigns.list.invalidate(); }} />}
    </div>
  );
}

function CreateCampaignDialog({ projects, onClose }: { projects: any[]; onClose: () => void }) {
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState("google_ads");
  const [projectId, setProjectId] = useState("");
  const [budget, setBudget] = useState("");
  const [status, setStatus] = useState("active");
  const utils = trpc.useUtils();
  const createMut = trpc.marketing.campaigns.create.useMutation({
    onSuccess: () => { utils.marketing.campaigns.list.invalidate(); toast.success("Campanha criada!"); onClose(); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader><DialogTitle>Nova Campanha</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Nome</Label><Input value={name} onChange={e => setName(e.target.value)} placeholder="Nome da campanha" /></div>
          <div><Label>Plataforma</Label>
            <Select value={platform} onValueChange={setPlatform}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="google_ads">Google Ads</SelectItem>
                <SelectItem value="meta_ads">Meta Ads</SelectItem>
                <SelectItem value="instagram">Instagram</SelectItem>
                <SelectItem value="other">Outro</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div><Label>Grupo / Projeto</Label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger><SelectValue placeholder="Opcional" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Nenhum</SelectItem>
                {(() => {
                  const all = projects as any[];
                  const result: any[] = [];
                  const add = (parentId: number | null, depth: number) => {
                    all.filter(p => p.parentId === parentId).forEach(p => {
                      result.push({ ...p, depth });
                      add(p.id, depth + 1);
                    });
                  };
                  add(null, 0);
                  return result.map(p => {
                    const icon = p.level === "group" ? "🏢" : p.level === "city" ? "📍" : p.level === "brand" ? "🏷" : "📁";
                    return <SelectItem key={p.id} value={String(p.id)}>{"  ".repeat(p.depth)}{icon} {p.name}</SelectItem>;
                  });
                })()}
              </SelectContent>
            </Select>
          </div>
          <div><Label>Orçamento (€)</Label><Input type="number" step="0.01" value={budget} onChange={e => setBudget(e.target.value)} /></div>
          <div><Label>Estado</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Ativa</SelectItem>
                <SelectItem value="paused">Pausada</SelectItem>
                <SelectItem value="completed">Concluída</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={!name || createMut.isPending} onClick={() => createMut.mutate({
            name, platform: platform as any, status: status as any,
            projectId: projectId && projectId !== "none" ? Number(projectId) : undefined,
            budget: budget || undefined,
          })}>Criar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportStatsDialog({ campaignId, onClose }: { campaignId: number; onClose: () => void }) {
  const [rows, setRows] = useState<{ date: string; spend: string; impressions: number; clicks: number; conversions: number; conversionValue: string }[]>([
    { date: new Date().toISOString().split("T")[0], spend: "0", impressions: 0, clicks: 0, conversions: 0, conversionValue: "0" },
  ]);
  const [importing, setImporting] = useState(false);
  const utils = trpc.useUtils();
  const importMut = trpc.marketing.stats.import.useMutation({
    onSuccess: (d) => { utils.marketing.invalidate(); toast.success(`${d.count} registos importados!`); onClose(); },
    onError: (e) => toast.error(e.message),
  });

  const addRow = () => setRows([...rows, { date: new Date().toISOString().split("T")[0], spend: "0", impressions: 0, clicks: 0, conversions: 0, conversionValue: "0" }]);
  const updateRow = (i: number, field: string, value: any) => {
    const copy = [...rows];
    (copy[i] as any)[field] = value;
    setRows(copy);
  };
  const removeRow = (i: number) => setRows(rows.filter((_, idx) => idx !== i));

  const handleExcelUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const XLSX = await import("xlsx");
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: "array", cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const json: any[] = XLSX.utils.sheet_to_json(ws, { defval: 0 });
      
      if (json.length === 0) { toast.error("Ficheiro vazio"); setImporting(false); return; }
      
      // Try to map columns automatically
      const parsed = json.map((row: any) => {
        // Find date column
        const dateKey = Object.keys(row).find(k => /data|date|day|dia/i.test(k));
        const spendKey = Object.keys(row).find(k => /gasto|spend|cost|custo|amount/i.test(k));
        const impKey = Object.keys(row).find(k => /impress/i.test(k));
        const clickKey = Object.keys(row).find(k => /click|clique/i.test(k));
        const convKey = Object.keys(row).find(k => /convers|reserva|booking/i.test(k));
        const valKey = Object.keys(row).find(k => /valor|value|receita|revenue/i.test(k));
        
        let dateStr = "";
        if (dateKey) {
          const v = row[dateKey];
          if (v instanceof Date) {
            dateStr = v.toISOString().split("T")[0];
          } else if (typeof v === "string") {
            // Try dd/mm/yyyy or yyyy-mm-dd
            const parts = v.split(/[\/\-.]/);
            if (parts.length === 3) {
              if (parts[0].length === 4) dateStr = `${parts[0]}-${parts[1].padStart(2,"0")}-${parts[2].padStart(2,"0")}`;
              else dateStr = `${parts[2]}-${parts[1].padStart(2,"0")}-${parts[0].padStart(2,"0")}`;
            }
          } else if (typeof v === "number") {
            // Excel serial date
            const d = new Date((v - 25569) * 86400 * 1000);
            dateStr = d.toISOString().split("T")[0];
          }
        }
        
        return {
          date: dateStr || new Date().toISOString().split("T")[0],
          spend: String(spendKey ? parseFloat(row[spendKey]) || 0 : 0),
          impressions: impKey ? parseInt(row[impKey]) || 0 : 0,
          clicks: clickKey ? parseInt(row[clickKey]) || 0 : 0,
          conversions: convKey ? parseInt(row[convKey]) || 0 : 0,
          conversionValue: String(valKey ? parseFloat(row[valKey]) || 0 : 0),
        };
      });
      
      setRows(parsed);
      toast.success(`${parsed.length} linhas carregadas do Excel! Verifica os dados antes de importar.`);
    } catch (err: any) {
      toast.error("Erro ao ler ficheiro: " + (err.message || "formato inválido"));
    }
    setImporting(false);
    e.target.value = "";
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Importar Dados Diários</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {/* Excel Upload */}
          <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg border border-dashed">
            <FileSpreadsheet className="w-5 h-5 text-green-600" />
            <div className="flex-1">
              <p className="text-sm font-medium">Importar de Excel</p>
              <p className="text-xs text-muted-foreground">Colunas: Data, Gasto, Impressões, Cliques, Reservas, Valor</p>
            </div>
            <label>
              <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleExcelUpload} disabled={importing} />
              <Button variant="outline" size="sm" asChild disabled={importing}>
                <span>{importing ? "A ler..." : "Escolher Ficheiro"}</span>
              </Button>
            </label>
          </div>
          
          <div className="text-xs text-muted-foreground text-center">— ou insere manualmente —</div>
          
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-7 gap-2 items-end">
              <div><Label className="text-xs">Data</Label><Input type="date" value={r.date} onChange={e => updateRow(i, "date", e.target.value)} /></div>
              <div><Label className="text-xs">Gasto (€)</Label><Input type="number" step="0.01" value={r.spend} onChange={e => updateRow(i, "spend", e.target.value)} /></div>
              <div><Label className="text-xs">Impressões</Label><Input type="number" value={r.impressions} onChange={e => updateRow(i, "impressions", Number(e.target.value))} /></div>
              <div><Label className="text-xs">Cliques</Label><Input type="number" value={r.clicks} onChange={e => updateRow(i, "clicks", Number(e.target.value))} /></div>
              <div><Label className="text-xs">Reservas</Label><Input type="number" value={r.conversions} onChange={e => updateRow(i, "conversions", Number(e.target.value))} /></div>
              <div><Label className="text-xs">Valor (€)</Label><Input type="number" step="0.01" value={r.conversionValue} onChange={e => updateRow(i, "conversionValue", e.target.value)} /></div>
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => removeRow(i)} disabled={rows.length <= 1}><Trash2 className="w-4 h-4" /></Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={addRow}><Plus className="w-4 h-4 mr-1" />Adicionar Linha</Button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={importMut.isPending} onClick={() => importMut.mutate({ campaignId, rows })}>
            <Upload className="w-4 h-4 mr-1" />Importar {rows.length} registo(s)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CampaignStatsDialog({ campaignId, onClose }: { campaignId: number; onClose: () => void }) {
  const { data: stats } = trpc.marketing.stats.byCampaign.useQuery({ campaignId });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Estatísticas da Campanha</DialogTitle></DialogHeader>
        {!stats || stats.length === 0 ? (
          <p className="text-muted-foreground text-center py-8">Sem dados importados para esta campanha.</p>
        ) : (
          <div className="space-y-4">
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={stats.map((s: any) => ({
                date: new Date(s.date).toLocaleDateString("pt-PT"),
                spend: parseFloat(s.spend || "0"),
                reservas: s.conversions || 0,
              })).reverse()}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="spend" name="Gasto (€)" fill="#4285F4" radius={[4, 4, 0, 0]} />
                <Bar dataKey="reservas" name="Reservas" fill="#F59E0B" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="p-2">Data</th><th className="p-2">Gasto</th><th className="p-2">Impr.</th>
                    <th className="p-2">Cliques</th><th className="p-2">CTR</th><th className="p-2">CPC</th>
                    <th className="p-2">Reservas</th><th className="p-2">Custo/Reserva</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map((s: any) => (
                    <tr key={s.id} className="border-b">
                      <td className="p-2">{new Date(s.date).toLocaleDateString("pt-PT")}</td>
                      <td className="p-2">{parseFloat(s.spend || "0").toFixed(2)} €</td>
                      <td className="p-2">{s.impressions}</td>
                      <td className="p-2">{s.clicks}</td>
                      <td className="p-2">{s.ctr ? `${parseFloat(s.ctr).toFixed(2)}%` : "-"}</td>
                      <td className="p-2">{s.cpc ? `${parseFloat(s.cpc).toFixed(2)} €` : "-"}</td>
                      <td className="p-2">{s.conversions}</td>
                      <td className="p-2">{s.costPerConversion ? `${parseFloat(s.costPerConversion).toFixed(2)} €` : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <DialogFooter><Button variant="outline" onClick={onClose}>Fechar</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── MARKETING EXPENSES ──────────────────────────────────────────────────────

function MktExpensesTab() {
  const globalFilters = useGlobalFilters();
  const [showCreate, setShowCreate] = useState(false);
  const [filterCat, setFilterCat] = useState("");
  const utils = trpc.useUtils();

  const mktExpQueryInput = useMemo(() => {
    const input: any = {};
    if (filterCat) input.category = filterCat;
    if (globalFilters.projectId !== undefined) input.projectId = globalFilters.projectId;
    return Object.keys(input).length > 0 ? input : undefined;
  }, [filterCat, globalFilters.projectId]);

  const { data: expensesList } = trpc.marketing.expenses.list.useQuery(mktExpQueryInput);
  const deleteMut = trpc.marketing.expenses.delete.useMutation({
    onSuccess: () => { utils.marketing.expenses.list.invalidate(); utils.marketing.dashboard.invalidate(); toast.success("Despesa eliminada"); },
  });

  const totalExpenses = useMemo(() => {
    if (!expensesList) return 0;
    return expensesList.reduce((sum: number, e: any) => sum + parseFloat(e.expense.amount || "0"), 0);
  }, [expensesList]);

  return (
    <div className="space-y-4 mt-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Select value={filterCat} onValueChange={v => setFilterCat(v === "all" ? "" : v)}>
            <SelectTrigger className="w-[180px]"><SelectValue placeholder="Categoria" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas</SelectItem>
              {Object.entries(MKT_CAT_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
            </SelectContent>
          </Select>
          <Badge variant="secondary" className="text-base px-3 py-1">Total: {totalExpenses.toFixed(2)} €</Badge>
        </div>
        <Button onClick={() => setShowCreate(true)}><Plus className="w-4 h-4 mr-1" />Nova Despesa Mkt</Button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="p-2">Data</th><th className="p-2">Descrição</th><th className="p-2">Categoria</th>
              <th className="p-2">Projeto</th><th className="p-2">Fornecedor</th><th className="p-2 text-right">Valor</th><th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {(!expensesList || expensesList.length === 0) ? (
              <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">Sem despesas de marketing.</td></tr>
            ) : expensesList.map((e: any) => (
              <tr key={e.expense.id} className="border-b hover:bg-muted/50">
                <td className="p-2">{new Date(e.expense.date).toLocaleDateString("pt-PT")}</td>
                <td className="p-2 font-medium">{e.expense.description}</td>
                <td className="p-2"><Badge variant="outline">{MKT_CAT_LABELS[e.expense.category] || e.expense.category}</Badge></td>
                <td className="p-2">{e.project?.name || "-"}</td>
                <td className="p-2">{e.expense.supplier || "-"}</td>
                <td className="p-2 text-right font-semibold">{parseFloat(e.expense.amount).toFixed(2)} €</td>
                <td className="p-2">
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => {
                    if (confirm("Eliminar?")) deleteMut.mutate({ id: e.expense.id });
                  }}><Trash2 className="w-4 h-4" /></Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showCreate && <CreateMktExpenseDialog onClose={() => setShowCreate(false)} />}
    </div>
  );
}

function CreateMktExpenseDialog({ onClose }: { onClose: () => void }) {
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("other");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [supplier, setSupplier] = useState("");
  const [notes, setNotes] = useState("");
  const utils = trpc.useUtils();
  const { data: projects } = trpc.projects.list.useQuery();
  const [projectId, setProjectId] = useState("");

  const createMut = trpc.marketing.expenses.create.useMutation({
    onSuccess: () => { utils.marketing.expenses.list.invalidate(); utils.marketing.dashboard.invalidate(); toast.success("Despesa criada!"); onClose(); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader><DialogTitle>Nova Despesa de Marketing</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Descrição</Label><Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Ex: Flyers campanha verão" /></div>
          <div><Label>Categoria</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(MKT_CAT_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Valor (€)</Label><Input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} /></div>
            <div><Label>Data</Label><Input type="date" value={date} onChange={e => setDate(e.target.value)} /></div>
          </div>
          <div><Label>Projeto</Label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger><SelectValue placeholder="Opcional" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Nenhum</SelectItem>
                {(projects || []).map((p: any) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div><Label>Fornecedor</Label><Input value={supplier} onChange={e => setSupplier(e.target.value)} /></div>
          <div><Label>Notas</Label><Textarea value={notes} onChange={e => setNotes(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={!description || !amount || createMut.isPending} onClick={() => createMut.mutate({
            description, category: category as any, amount, date,
            projectId: projectId && projectId !== "none" ? Number(projectId) : undefined,
            supplier: supplier || undefined, notes: notes || undefined,
          })}>Criar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


// ─── GOOGLE ADS CSV IMPORT (with dedup) ─────────────────────────────────────

const PT_MONTHS: Record<string, string> = {
  janeiro: "01", fevereiro: "02", "março": "03", abril: "04",
  maio: "05", junho: "06", julho: "07", agosto: "08",
  setembro: "09", outubro: "10", novembro: "11", dezembro: "12",
};

function parsePtDate(s: string): string {
  const m = s.trim().match(/(\d+)\s+de\s+([\wçãé]+)\s+de\s+(\d{4})/);
  if (m) {
    const day = m[1].padStart(2, "0");
    const month = PT_MONTHS[m[2].toLowerCase()] || "01";
    return `${m[3]}-${month}-${day}`;
  }
  return s;
}

function parsePtNumber(val: string): number {
  if (!val || val.trim() === "--" || val.trim() === "" || val.includes("< ")) return 0;
  let v = val.trim().replace(/"/g, "");
  v = v.replace(/\s/g, "").replace(/\u00a0/g, "");
  v = v.replace(/%$/, "");
  v = v.replace(",", ".");
  return parseFloat(v) || 0;
}

function parsePtInt(val: string): number {
  if (!val || val.trim() === "--" || val.trim() === "") return 0;
  let v = val.trim().replace(/"/g, "");
  v = v.replace(/\s/g, "").replace(/\u00a0/g, "");
  return Math.round(parseFloat(v) || 0);
}

interface ParsedGoogleAdsCampaign {
  name: string;
  status: "active" | "paused" | "completed";
  budget: number;
  campaignType: string;
  impressions: number;
  interactions: number;
  cost: number;
  clicks: number;
  conversions: number;
  cpc: number;
  ctr: number;
  costPerConversion: number;
}

interface ParsedGoogleAdsReport {
  dateRange: { start: string; end: string };
  campaigns: ParsedGoogleAdsCampaign[];
}

function parseGoogleAdsCsv(text: string): ParsedGoogleAdsReport {
  const lines = text.split("\n").filter(l => l.trim());
  if (lines.length < 3) throw new Error("Ficheiro demasiado curto");

  // Line 1: title, Line 2: date range, Line 3: headers, Line 4+: data
  const dateRangeLine = lines[1].trim();
  const parts = dateRangeLine.split(" - ");
  const start = parts.length === 2 ? parsePtDate(parts[0]) : "";
  const end = parts.length === 2 ? parsePtDate(parts[1]) : "";

  const headers = lines[2].split("\t").map(h => h.trim());
  const colIdx: Record<string, number> = {};
  headers.forEach((h, i) => { colIdx[h] = i; });

  const campaigns: ParsedGoogleAdsCampaign[] = [];

  for (let i = 3; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    if (cols.length < 10) continue;

    const campaignName = (cols[colIdx["Campanha"] ?? 1] || "").trim();
    if (!campaignName || campaignName.startsWith("--") || campaignName.startsWith("Total:")) continue;

    const statusRaw = (cols[colIdx["Estado da campanha"] ?? 0] || "").trim();
    const status: "active" | "paused" | "completed" = statusRaw === "Ativada" ? "active" : statusRaw === "Em pausa" ? "paused" : "completed";

    campaigns.push({
      name: campaignName,
      status,
      budget: parsePtNumber(cols[colIdx["Orçamento"] ?? 2] || "0"),
      campaignType: (cols[colIdx["Tipo de campanha"] ?? 8] || "").trim(),
      impressions: parsePtInt(cols[colIdx["Impressões"] ?? 9] || "0"),
      interactions: parsePtInt(cols[colIdx["Interações"] ?? 10] || "0"),
      cost: parsePtNumber(cols[colIdx["Custo"] ?? 13] || "0"),
      clicks: parsePtInt(cols[colIdx["Cliques"] ?? 31] || "0"),
      conversions: parsePtNumber(cols[colIdx["Conversões"] ?? 32] || "0"),
      cpc: parsePtNumber(cols[colIdx["CPC médio"] ?? 34] || "0"),
      ctr: parsePtNumber(cols[colIdx["CTR"] ?? 36] || "0"),
      costPerConversion: parsePtNumber(cols[colIdx["Custo/conv."] ?? 35] || "0"),
    });
  }

  return { dateRange: { start, end }, campaigns };
}

function GoogleAdsImportDialog({ onClose }: { onClose: () => void }) {
  const [parsed, setParsed] = useState<ParsedGoogleAdsReport | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ created: number; skipped: number; details: string[] } | null>(null);

  const importMut = trpc.marketing.stats.importGoogleAdsReport.useMutation({
    onSuccess: (data) => {
      setResult({ created: data.created, skipped: data.skipped, details: data.details });
      toast.success(`${data.created} campanhas importadas, ${data.skipped} ignoradas`);
    },
    onError: (e) => toast.error(e.message),
  });

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError("");
    setParsed(null);
    setResult(null);

    try {
      // Try reading as UTF-16 first, then UTF-8
      let text = "";
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      // Check BOM for UTF-16 LE
      if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
        const decoder = new TextDecoder("utf-16le");
        text = decoder.decode(buffer);
      } else if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
        const decoder = new TextDecoder("utf-16be");
        text = decoder.decode(buffer);
      } else {
        text = new TextDecoder("utf-8").decode(buffer);
      }

      const report = parseGoogleAdsCsv(text);
      if (report.campaigns.length === 0) {
        setError("Nenhuma campanha encontrada no ficheiro");
        return;
      }
      setParsed(report);
    } catch (err: any) {
      setError("Erro ao ler ficheiro: " + (err.message || "formato inválido"));
    }
    e.target.value = "";
  };

  const activeCampaigns = parsed?.campaigns.filter(c => c.cost > 0 || c.clicks > 0 || c.impressions > 0) || [];
  const inactiveCampaigns = parsed?.campaigns.filter(c => c.cost === 0 && c.clicks === 0 && c.impressions === 0) || [];
  const totalCost = activeCampaigns.reduce((s, c) => s + c.cost, 0);
  const totalClicks = activeCampaigns.reduce((s, c) => s + c.clicks, 0);
  const totalImpressions = activeCampaigns.reduce((s, c) => s + c.impressions, 0);

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-blue-500" />
            Importar Relatório Google Ads
          </DialogTitle>
        </DialogHeader>

        {!parsed && !result && (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-4 p-8 border-2 border-dashed rounded-lg bg-muted/30">
              <Upload className="w-10 h-10 text-muted-foreground" />
              <div className="text-center">
                <p className="font-medium">Arrasta ou escolhe o ficheiro CSV do Google Ads</p>
                <p className="text-sm text-muted-foreground mt-1">Formato: Relatório de campanha exportado do Google Ads (CSV, UTF-16 ou UTF-8)</p>
              </div>
              <label>
                <input type="file" accept=".csv,.tsv" className="hidden" onChange={handleFile} />
                <Button variant="outline" asChild><span>Escolher Ficheiro</span></Button>
              </label>
            </div>
            {error && (
              <div className="flex items-center gap-2 p-3 bg-destructive/10 text-destructive rounded-lg">
                <AlertTriangle className="w-4 h-4" />
                <span className="text-sm">{error}</span>
              </div>
            )}
            <div className="p-3 bg-blue-50 dark:bg-blue-950/30 rounded-lg">
              <div className="flex items-start gap-2">
                <Info className="w-4 h-4 text-blue-500 mt-0.5" />
                <div className="text-sm text-blue-700 dark:text-blue-300">
                  <p className="font-medium">Como exportar do Google Ads:</p>
                  <ol className="list-decimal ml-4 mt-1 space-y-0.5">
                    <li>Vai a Campanhas no Google Ads</li>
                    <li>Define o período desejado</li>
                    <li>Clica no ícone de download (⬇)</li>
                    <li>Escolhe formato CSV</li>
                    <li>Importa aqui o ficheiro</li>
                  </ol>
                </div>
              </div>
            </div>
          </div>
        )}

        {parsed && !result && (
          <div className="space-y-4">
            {/* Date range */}
            <div className="flex items-center gap-2 p-3 bg-muted/50 rounded-lg">
              <Badge variant="outline">Período</Badge>
              <span className="font-medium">{parsed.dateRange.start} a {parsed.dateRange.end}</span>
              <span className="text-muted-foreground">• {parsed.campaigns.length} campanhas</span>
            </div>

            {/* Summary KPIs */}
            <div className="grid grid-cols-4 gap-3">
              <Card><CardContent className="p-3 text-center">
                <p className="text-xs text-muted-foreground">Campanhas Ativas</p>
                <p className="text-lg font-bold">{activeCampaigns.length}</p>
              </CardContent></Card>
              <Card><CardContent className="p-3 text-center">
                <p className="text-xs text-muted-foreground">Custo Total</p>
                <p className="text-lg font-bold">{totalCost.toLocaleString("pt-PT", { minimumFractionDigits: 2 })} €</p>
              </CardContent></Card>
              <Card><CardContent className="p-3 text-center">
                <p className="text-xs text-muted-foreground">Cliques</p>
                <p className="text-lg font-bold">{totalClicks.toLocaleString("pt-PT")}</p>
              </CardContent></Card>
              <Card><CardContent className="p-3 text-center">
                <p className="text-xs text-muted-foreground">Impressões</p>
                <p className="text-lg font-bold">{totalImpressions.toLocaleString("pt-PT")}</p>
              </CardContent></Card>
            </div>

            {/* Active campaigns table */}
            {activeCampaigns.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-2 flex items-center gap-1">
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                  Campanhas com dados ({activeCampaigns.length})
                </h3>
                <div className="border rounded-lg overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="text-left p-2">Campanha</th>
                        <th className="text-right p-2">Custo</th>
                        <th className="text-right p-2">Cliques</th>
                        <th className="text-right p-2">Impressões</th>
                        <th className="text-right p-2">CPC</th>
                        <th className="text-right p-2">CTR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeCampaigns.map((c, i) => (
                        <tr key={i} className="border-t">
                          <td className="p-2">
                            <div className="font-medium">{c.name}</div>
                            <div className="text-xs text-muted-foreground">{c.campaignType}</div>
                          </td>
                          <td className="text-right p-2 font-mono">{c.cost.toLocaleString("pt-PT", { minimumFractionDigits: 2 })} €</td>
                          <td className="text-right p-2 font-mono">{c.clicks.toLocaleString("pt-PT")}</td>
                          <td className="text-right p-2 font-mono">{c.impressions.toLocaleString("pt-PT")}</td>
                          <td className="text-right p-2 font-mono">{c.cpc.toFixed(2)} €</td>
                          <td className="text-right p-2 font-mono">{c.ctr.toFixed(2)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Inactive campaigns */}
            {inactiveCampaigns.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-2 flex items-center gap-1 text-muted-foreground">
                  <AlertTriangle className="w-4 h-4" />
                  Campanhas sem dados ({inactiveCampaigns.length}) — serão criadas mas sem estatísticas
                </h3>
                <div className="flex flex-wrap gap-2">
                  {inactiveCampaigns.map((c, i) => (
                    <Badge key={i} variant="secondary">{c.name} ({c.status === "paused" ? "Pausada" : c.status === "active" ? "Ativa" : "Concluída"})</Badge>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center gap-2 p-3 bg-amber-50 dark:bg-amber-950/30 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              <span className="text-sm text-amber-700 dark:text-amber-300">
                Se já importaste dados para este período, serão automaticamente ignorados (sem duplicados).
              </span>
            </div>
          </div>
        )}

        {result && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 p-4 bg-green-50 dark:bg-green-950/30 rounded-lg">
              <CheckCircle2 className="w-6 h-6 text-green-500" />
              <div>
                <p className="font-semibold text-green-700 dark:text-green-300">Importação concluída!</p>
                <p className="text-sm text-green-600 dark:text-green-400">{result.created} importados, {result.skipped} ignorados</p>
              </div>
            </div>
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {result.details.map((d, i) => (
                <p key={i} className="text-sm py-1 border-b last:border-0">{d}</p>
              ))}
            </div>
          </div>
        )}

        <DialogFooter>
          {!result ? (
            <>
              <Button variant="outline" onClick={() => { setParsed(null); setResult(null); setError(""); }}>
                {parsed ? "Voltar" : "Cancelar"}
              </Button>
              {parsed && (
                <Button
                  disabled={importMut.isPending}
                  onClick={() => importMut.mutate({
                    dateRange: parsed.dateRange,
                    campaigns: parsed.campaigns,
                  })}
                >
                  {importMut.isPending ? <><Loader2 className="w-4 h-4 mr-1 animate-spin" />A importar...</> : <><Upload className="w-4 h-4 mr-1" />Importar {parsed.campaigns.length} campanhas</>}
                </Button>
              )}
            </>
          ) : (
            <Button onClick={onClose}>Fechar</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
