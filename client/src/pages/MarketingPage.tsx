import { useState, useMemo, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import DateRangeNav from "@/components/DateRangeNav";
import { fmtPTDate, fmtPTDateTime } from "@/lib/lisbonTime";
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
  Megaphone, TrendingUp, Target, DollarSign, Plus, Trash2, Pencil,
  Upload, Eye, BarChart3, Receipt, ArrowUpRight, MousePointerClick, FileSpreadsheet,
  AlertTriangle, CheckCircle2, Info, Loader2, RefreshCw,
} from "lucide-react";

const PLATFORM_LABELS: Record<string, string> = {
  google_ads: "Google Ads",
  meta_ads: "Meta Ads",
  instagram: "Instagram",
  other: "Outro",
};
const PLATFORM_COLORS: Record<string, string> = {
  google_ads: "#4285F4",
  meta_ads: "#1877F2",
  instagram: "#E4405F",
  other: "#6B7280",
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
const CHART_COLORS = ["#4285F4", "#1877F2", "#E4405F", "#F59E0B", "#10B981", "#8B5CF6", "#6B7280"];

export default function MarketingPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState("dashboard");
  const [showCsvImport, setShowCsvImport] = useState(false);
  const isAdmin = ["admin", "super_admin"].includes(user?.role ?? "");

  return (
    <>
      {showCsvImport && <ImportCampaignCsvDialog onClose={() => setShowCsvImport(false)} />}
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <p className="text-muted-foreground">Campanhas, custos e performance</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Gasto diário atualiza-se sozinho via email agendado para <code className="bg-muted px-1 rounded">campanhas@multipark.pt</code> (CSV com Data + Campanha + Custo).
            </p>
          </div>
          {isAdmin && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setShowCsvImport(true)}>
              <FileSpreadsheet className="w-3.5 h-3.5" /> Importar CSV (histórico)
            </Button>
          )}
        </div>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="dashboard"><BarChart3 className="w-4 h-4 mr-1" />Dashboard</TabsTrigger>
            <TabsTrigger value="campaigns"><Megaphone className="w-4 h-4 mr-1" />Campanhas</TabsTrigger>
            <TabsTrigger value="expenses"><Receipt className="w-4 h-4 mr-1" />Despesas Mkt</TabsTrigger>
          </TabsList>

          <TabsContent value="dashboard"><DashboardTab /></TabsContent>
          <TabsContent value="campaigns"><InternalCampaignsTab /></TabsContent>
          <TabsContent value="expenses"><MktExpensesTab /></TabsContent>
        </Tabs>
      </div>
    </>
  );
}

// ─── IMPORT CSV DE CAMPANHAS (histórico + correções) ─────────────────────────
// Mesmo motor da ingestão do email diário (server/campaignReportIngest.ts):
// aceita exports do Google Ads/Supermetrics com Data + Campanha + Custo
// (+ impressões/cliques/conversões/valor). Idempotente por (campanha, dia).
function ImportCampaignCsvDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const utils = trpc.useUtils();
  const importMut = trpc.marketing.importCampaignCsv.useMutation({
    onSuccess: (r) => {
      toast.success(`${r.imported} registos importados (${r.totalSpend.toFixed(2)}€)`, {
        description: r.campaignsCreated.length
          ? `Campanhas novas auto-criadas (atribui-lhes projeto na aba Campanhas): ${r.campaignsCreated.join(", ")}`
          : undefined,
        duration: 10000,
      });
      utils.marketing.invalidate();
      onClose();
    },
    onError: (e) => toast.error(e.message || "Erro ao importar"),
  });

  const handleFile = (f: File | null) => {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ""));
    reader.readAsText(f);
  };

  const lineCount = text.split(/\r?\n/).filter((l) => l.trim()).length;

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FileSpreadsheet className="w-5 h-5 text-primary" /> Importar CSV de campanhas</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 flex-1 min-h-0 overflow-y-auto">
          <p className="text-sm text-muted-foreground">
            Export do Google Ads ou Supermetrics com as colunas <strong>Data</strong>, <strong>Campanha</strong> e <strong>Custo</strong> (aceita também impressões, cliques, conversões e valor; PT ou EN; separador vírgula, ponto-e-vírgula ou TAB). Serve para carregar o histórico desde 2024 — reimportar o mesmo período substitui, não duplica.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="file"
              accept=".csv,.txt,text/csv"
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
              className="text-sm"
            />
            <span className="text-xs text-muted-foreground">ou cola abaixo</span>
          </div>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={12}
            placeholder={"Date,Campaign,Cost,Impressions,Clicks,Conversions\n2024-01-05,Airpark - Lisboa - PT,208.32,15000,420,18\n…"}
            className="font-mono text-xs"
          />
          <p className="text-sm">
            {lineCount > 1
              ? <span className="text-emerald-700 font-medium">{lineCount} linhas coladas</span>
              : <span className="text-muted-foreground">Sem conteúdo ainda</span>}
          </p>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => importMut.mutate({ csv: text })} disabled={lineCount < 2 || importMut.isPending} className="gap-2">
            {importMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Importar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  // ROAS = receita / gasto. > 1 = lucro, < 1 = sangrento.
  const roas = totalAdSpend > 0 ? realRevenue / totalAdSpend : 0;

  return (
    <div className="space-y-6 mt-4">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label className="text-xs mb-1 block">Período</Label>
          <DateRangeNav start={from} end={to} gran="month" showAll={false} onChange={(s2, e2) => { setFrom(s2); setTo(e2); }} />
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
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
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
              <p className="text-[10px] text-muted-foreground">inclui reservas orgânicas</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Receita Média / Reserva</p>
              <p className="text-2xl font-bold text-green-700">{realBookings > 0 ? (realRevenue / realBookings).toFixed(2) : "0.00"} €</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">ROAS</p>
              <p className={`text-2xl font-bold ${roas >= 1 ? "text-green-700" : "text-red-600"}`}>{roas.toFixed(2)}×</p>
              <p className="text-[10px] text-muted-foreground">receita / gasto total</p>
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
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            disabled={!expensesList || expensesList.length === 0}
            onClick={() => {
              if (!expensesList) return;
              const headers = ["Data","Descrição","Categoria","Projeto","Fornecedor","Valor"];
              const rows = expensesList.map((e: any) => [
                new Date(e.expense.date).toISOString().slice(0, 10),
                (e.expense.description || "").replace(/;/g, ","),
                MKT_CAT_LABELS[e.expense.category] ?? e.expense.category,
                e.project?.name ?? "",
                (e.expense.supplier ?? "").replace(/;/g, ","),
                parseFloat(e.expense.amount || "0").toFixed(2),
              ]);
              const csv = [headers.join(";"), ...rows.map(r => r.join(";"))].join("\n");
              const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url; a.download = `despesas_marketing_${new Date().toISOString().slice(0,10)}.csv`; a.click();
              URL.revokeObjectURL(url);
            }}
          >
            <FileSpreadsheet className="w-4 h-4 mr-1" /> Export CSV
          </Button>
          <Button onClick={() => setShowCreate(true)}><Plus className="w-4 h-4 mr-1" />Nova Despesa Mkt</Button>
        </div>
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
                <td className="p-2">{fmtPTDate(e.expense.date)}</td>
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



// ─── CAMPANHAS INTERNAS ───────────────────────────────────────────────────────
function InternalCampaignsTab() {
  const utils = trpc.useUtils();
  const todayStr = new Date().toISOString().slice(0, 10);
  const monthStartStr = todayStr.slice(0, 8) + "01";
  const [from, setFrom] = useState(monthStartStr);
  const [to, setTo] = useState(todayStr);
  const { data: detected } = trpc.marketing.internalCampaigns.detect.useQuery();
  const { data: campaigns = [] } = trpc.marketing.internalCampaigns.list.useQuery({ from, to });
  const { data: projects = [] } = trpc.projects.list.useQuery();
  const [newName, setNewName] = useState("");
  const [newProject, setNewProject] = useState<string>("");
  const [newBudget, setNewBudget] = useState("");
  const [costInputs, setCostInputs] = useState<Record<string, { date: string; amount: string }>>({});
  const [editCamp, setEditCamp] = useState<any>(null);

  // ── Diálogo "Atualizar campanhas": métricas diárias por campanha ──
  type DailyRow = { amount: string; impressions: string; clicks: string; ctr: string; conversions: string; conversionValue: string };
  const emptyRow: DailyRow = { amount: "", impressions: "", clicks: "", ctr: "", conversions: "", conversionValue: "" };
  const [updOpen, setUpdOpen] = useState(false);
  const [updDate, setUpdDate] = useState(todayStr);
  const [updRows, setUpdRows] = useState<Record<string, DailyRow>>({});
  const [updSaving, setUpdSaving] = useState(false);
  const { data: dayCosts } = trpc.marketing.internalCampaigns.costsByDate.useQuery(
    { costDate: updDate },
    { enabled: updOpen },
  );

  // Pré-preenche com o que já está registado para o dia escolhido
  useEffect(() => {
    if (!updOpen) return;
    const next: Record<string, DailyRow> = {};
    for (const r of (dayCosts ?? []) as any[]) {
      next[r.campaignType + ":" + r.campaignId] = {
        amount: r.amount != null ? String(Number(r.amount)) : "",
        impressions: r.impressions != null ? String(r.impressions) : "",
        clicks: r.clicks != null ? String(r.clicks) : "",
        ctr: r.ctr != null ? String(Number(r.ctr)) : "",
        conversions: r.conversions != null ? String(Number(r.conversions)) : "",
        conversionValue: r.conversionValue != null ? String(Number(r.conversionValue)) : "",
      };
    }
    setUpdRows(next);
  }, [updOpen, updDate, dayCosts]);

  const setUpdField = (ckey: string, field: keyof DailyRow, value: string) => {
    setUpdRows(s => {
      const row = { ...(s[ckey] ?? emptyRow), [field]: value };
      // CTR deriva automaticamente de cliques/impressões (continua editável)
      if (field === "clicks" || field === "impressions") {
        const cl = Number(row.clicks), im = Number(row.impressions);
        if (row.clicks !== "" && im > 0) row.ctr = String(Math.round((cl / im) * 100000) / 1000);
      }
      return { ...s, [ckey]: row };
    });
  };

  const saveDailyUpdate = async () => {
    const entries = Object.entries(updRows).filter(([, r]) => Object.values(r).some(v => v !== ""));
    if (entries.length === 0) { toast.info("Nada para guardar"); return; }
    setUpdSaving(true);
    let saved = 0;
    try {
      for (const [ckey, r] of entries) {
        const [campaignType, idStr] = ckey.split(":");
        await addCostBulk.mutateAsync({
          campaignType: campaignType as "internal" | "ad",
          campaignId: Number(idStr),
          costDate: updDate,
          amount: r.amount !== "" ? Number(r.amount) : 0,
          impressions: r.impressions !== "" ? Number(r.impressions) : null,
          clicks: r.clicks !== "" ? Number(r.clicks) : null,
          ctr: r.ctr !== "" ? Number(r.ctr) : null,
          conversions: r.conversions !== "" ? Number(r.conversions) : null,
          conversionValue: r.conversionValue !== "" ? Number(r.conversionValue) : null,
        });
        saved++;
      }
      toast.success(`Campanhas atualizadas (${saved} ${saved === 1 ? "registo" : "registos"} em ${updDate})`);
      setUpdOpen(false);
      refresh();
      utils.marketing.internalCampaigns.costsByDate.invalidate();
    } catch (e: any) {
      toast.error(`Guardadas ${saved}/${entries.length} — ${e.message}`);
    } finally {
      setUpdSaving(false);
    }
  };

  const refresh = () => {
    utils.marketing.internalCampaigns.detect.invalidate();
    utils.marketing.internalCampaigns.list.invalidate();
  };
  const create = trpc.marketing.internalCampaigns.create.useMutation({ onSuccess: () => { setNewName(""); setNewProject(""); setNewBudget(""); refresh(); toast.success("Campanha criada"); }, onError: (e) => toast.error(e.message) });
  const assignKey = trpc.marketing.internalCampaigns.assignKey.useMutation({ onSuccess: () => { refresh(); toast.success("Link atribuído"); }, onError: (e) => toast.error(e.message) });
  const removeKey = trpc.marketing.internalCampaigns.removeKey.useMutation({ onSuccess: refresh, onError: (e) => toast.error(e.message) });
  const remove = trpc.marketing.internalCampaigns.remove.useMutation({ onSuccess: refresh, onError: (e) => toast.error(e.message) });
  const addCost = trpc.marketing.internalCampaigns.addCost.useMutation({ onSuccess: () => { refresh(); toast.success("Gasto registado"); }, onError: (e) => toast.error(e.message) });
  const addCostBulk = trpc.marketing.internalCampaigns.addCost.useMutation(); // sem toasts por linha — usado pelo diálogo
  const updateInternal = trpc.marketing.internalCampaigns.update.useMutation({ onSuccess: () => { setEditCamp(null); refresh(); toast.success("Campanha atualizada"); }, onError: (e) => toast.error(e.message) });
  const updateAd = trpc.marketing.campaigns.update.useMutation({ onSuccess: () => { setEditCamp(null); refresh(); toast.success("Campanha atualizada"); }, onError: (e) => toast.error(e.message) });

  const assignTo = (target: string, keyType: "campaign_name" | "url_pattern", keyValue: string) => {
    if (!target) return;
    const [campaignType, idStr] = target.split(":");
    assignKey.mutate({ campaignType: campaignType as "internal" | "ad", campaignId: Number(idStr), keyType, keyValue });
  };
  const links = (detected?.links ?? []) as any[];
  const names = (detected?.names ?? []) as any[];
  const sortedProjects = (projects as any[]).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const AssignSelect = ({ keyType, keyValue }: { keyType: "campaign_name" | "url_pattern"; keyValue: string }) => (
    <Select value="" onValueChange={(v) => assignTo(v, keyType, keyValue)}>
      <SelectTrigger className="h-7 w-48 text-xs shrink-0"><SelectValue placeholder="Atribuir a campanha..." /></SelectTrigger>
      <SelectContent>{campaigns.map((c: any) => <SelectItem key={c.campaignType + ":" + c.id} value={c.campaignType + ":" + c.id}>{c.name}{c.campaignType === "ad" ? " · ad" : ""}</SelectItem>)}</SelectContent>
    </Select>
  );

  return (
    <div className="space-y-4">
      {/* Período + nova campanha */}
      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div><Label className="text-xs mb-1 block">Período</Label><DateRangeNav start={from} end={to} gran="month" showAll={false} onChange={(s2, e2) => { setFrom(s2); setTo(e2); }} /></div>
          <div className="text-[11px] text-muted-foreground self-center">↑ período do gasto e das reservas</div>
          <div className="ml-auto">
            <Button onClick={() => { setUpdDate(todayStr); setUpdOpen(true); }}>
              <RefreshCw className="w-4 h-4 mr-1.5" />Atualizar campanhas
            </Button>
          </div>
          <div className="w-full border-t my-1" />
          <div><Label className="text-xs">Nova campanha</Label><Input className="w-48" value={newName} onChange={e => setNewName(e.target.value)} placeholder="nome" /></div>
          <div>
            <Label className="text-xs">Projeto</Label>
            <Select value={newProject} onValueChange={setNewProject}>
              <SelectTrigger className="w-44"><SelectValue placeholder="Opcional..." /></SelectTrigger>
              <SelectContent>{sortedProjects.map((p: any) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div><Label className="text-xs">€/dia</Label><Input type="number" className="w-24" value={newBudget} onChange={e => setNewBudget(e.target.value)} placeholder="0" /></div>
          <Button disabled={!newName || create.isPending} onClick={() => create.mutate({ name: newName, projectId: newProject ? Number(newProject) : undefined, dailyBudget: newBudget ? Number(newBudget) : undefined })}>Criar</Button>
        </CardContent>
      </Card>

      {/* Por atribuir */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reservas por link — por atribuir ({links.length + names.length})</CardTitle>
          <p className="text-xs text-muted-foreground">Em cada link/nome escolhe diretamente a campanha (ou cria uma acima primeiro). Fica atribuído para sempre.</p>
        </CardHeader>
        <CardContent className="space-y-2 max-h-[440px] overflow-y-auto">
          {links.length > 0 && <div className="text-xs font-medium text-muted-foreground">Links</div>}
          {links.map((r) => (
            <div key={"lk-" + r.value} className="flex items-center gap-2 text-sm border-b py-1.5">
              <div className="min-w-0 flex-1">
                <a href={r.value} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline break-all text-xs">{r.value}</a>
                <div className="text-[11px] text-muted-foreground">{Number(r.bookings)} reservas · {Number(r.revenue).toFixed(0)} €</div>
              </div>
              <AssignSelect keyType="url_pattern" keyValue={r.value} />
            </div>
          ))}
          {names.length > 0 && <div className="text-xs font-medium text-muted-foreground mt-2">Nomes de campanha</div>}
          {names.map((r) => (
            <div key={"nm-" + r.value} className="flex items-center gap-2 text-sm border-b py-1">
              <span className="flex-1">{r.value} <span className="text-muted-foreground text-xs">· {Number(r.bookings)} reservas</span></span>
              <AssignSelect keyType="campaign_name" keyValue={r.value} />
            </div>
          ))}
          {links.length + names.length === 0 && <p className="text-sm text-muted-foreground">Tudo atribuído ✓</p>}
        </CardContent>
      </Card>

      {/* Campanhas */}
      <div className="grid gap-3">
        {campaigns.map((c: any) => {
          const ckey = c.campaignType + ":" + c.id;
          const ci = costInputs[ckey] ?? { date: todayStr, amount: "" };
          return (
            <Card key={ckey}>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold">{c.name}</h3>
                    <Badge className="text-[10px]" variant={c.campaignType === "ad" ? "default" : "secondary"}>{c.campaignType === "ad" ? "Ad" : "Interna"}</Badge>
                    {c.projectName && <Badge variant="outline" className="text-[10px]">📁 {c.projectName}</Badge>}
                    {c.dailyBudget != null && <Badge variant="outline" className="text-[10px]">{Number(c.dailyBudget).toFixed(0)} €/dia</Badge>}
                  </div>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setEditCamp({ id: c.id, campaignType: c.campaignType, name: c.name, _name: c.name, _project: c.projectId ? String(c.projectId) : "", _budget: c.dailyBudget != null ? String(c.dailyBudget) : "" })}><Pencil className="w-4 h-4" /></Button>
                    <Button size="sm" variant="ghost" className="text-red-600" onClick={() => { if (confirm(c.campaignType === "ad" ? `Desligar links/custos de "${c.name}"? (a campanha mantém-se)` : `Eliminar campanha "${c.name}"?`)) remove.mutate({ campaignType: c.campaignType, id: c.id }); }}><Trash2 className="w-4 h-4" /></Button>
                  </div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3 text-sm">
                  <div><div className="text-xs text-muted-foreground">Reservas</div><div className="font-semibold">{c.bookings}</div></div>
                  <div><div className="text-xs text-muted-foreground">Receita</div><div className="font-semibold">{Number(c.revenue).toFixed(0)} €</div></div>
                  <div><div className="text-xs text-muted-foreground">Gasto{c.spendEstimated ? " (est.)" : ""}</div><div className="font-semibold">{Number(c.spend).toFixed(0)} €</div></div>
                  <div><div className="text-xs text-muted-foreground">Custo/reserva</div><div className="font-semibold">{Number(c.costPerBooking).toFixed(2)} €</div></div>
                  <div><div className="text-xs text-muted-foreground">ROAS</div><div className="font-semibold">{c.roas != null ? Number(c.roas).toFixed(1) + "x" : "—"}</div></div>
                  <div><div className="text-xs text-muted-foreground">Cliques</div><div className="font-semibold">{c.clicks != null ? c.clicks : "—"}</div></div>
                  <div><div className="text-xs text-muted-foreground">CTR</div><div className="font-semibold">{c.ctr != null ? Number(c.ctr).toFixed(2) + "%" : "—"}</div></div>
                  <div><div className="text-xs text-muted-foreground">Conversões</div><div className="font-semibold">{c.conversions != null ? Number(c.conversions) : "—"}</div></div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(c.keys ?? []).map((k: any) => (
                    <Badge key={k.id} variant="secondary" className="text-[10px] gap-1 max-w-[100%]">
                      <span className="opacity-60">{k.keyType === "campaign_id" ? "link" : k.keyType === "campaign_name" ? "nome" : "url"}:</span>
                      <span className="truncate">{k.keyValue}</span>
                      <button className="ml-1 text-red-500" onClick={() => removeKey.mutate({ keyId: k.id })}>×</button>
                    </Badge>
                  ))}
                  {(c.keys ?? []).length === 0 && <span className="text-xs text-muted-foreground">Sem links atribuídos.</span>}
                </div>
                <div className="flex items-end gap-2 border-t pt-2 flex-wrap">
                  <div className="text-[11px] text-muted-foreground self-center">Gasto real de 1 dia (sobrepõe a estimativa):</div>
                  <div><Label className="text-[10px]">Data</Label><Input type="date" className="h-8 w-36" value={ci.date} onChange={e => setCostInputs(s => ({ ...s, [ckey]: { ...ci, date: e.target.value } }))} /></div>
                  <div><Label className="text-[10px]">€</Label><Input type="number" className="h-8 w-24" value={ci.amount} onChange={e => setCostInputs(s => ({ ...s, [ckey]: { ...ci, amount: e.target.value } }))} placeholder="0.00" /></div>
                  <Button size="sm" variant="outline" className="h-8" disabled={!ci.amount || addCost.isPending} onClick={() => addCost.mutate({ campaignType: c.campaignType, campaignId: c.id, costDate: ci.date, amount: Number(ci.amount) })}>Registar</Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
        {campaigns.length === 0 && <Card className="p-8 text-center text-muted-foreground">Ainda não há campanhas. Cria uma acima.</Card>}
      </div>

      {/* Atualizar campanhas — métricas diárias */}
      <Dialog open={updOpen} onOpenChange={setUpdOpen}>
        <DialogContent className="max-w-5xl">
          <DialogHeader><DialogTitle>Atualizar campanhas — dados do dia</DialogTitle></DialogHeader>
          <div className="flex items-end gap-3 flex-wrap">
            <div><Label className="text-xs">Dia</Label><Input type="date" className="w-40" value={updDate} onChange={e => setUpdDate(e.target.value)} /></div>
            <p className="text-[11px] text-muted-foreground self-center">
              Preenche só o que tiveres — campos vazios não apagam dados já registados. O CTR calcula-se sozinho a partir de cliques/impressões.
            </p>
          </div>
          <div className="overflow-x-auto max-h-[55vh] overflow-y-auto border rounded-lg">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted">
                <tr className="text-[11px] text-muted-foreground uppercase">
                  <th className="text-left font-medium px-3 py-2">Campanha</th>
                  <th className="text-left font-medium px-2 py-2">Gasto (€)</th>
                  <th className="text-left font-medium px-2 py-2">Impressões</th>
                  <th className="text-left font-medium px-2 py-2">Cliques</th>
                  <th className="text-left font-medium px-2 py-2">CTR (%)</th>
                  <th className="text-left font-medium px-2 py-2">Conversões</th>
                  <th className="text-left font-medium px-2 py-2">Valor conv. (€)</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c: any) => {
                  const ckey = c.campaignType + ":" + c.id;
                  const r = updRows[ckey] ?? emptyRow;
                  return (
                    <tr key={ckey} className="border-t">
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        <span className="font-medium">{c.name}</span>
                        {c.campaignType === "ad" && <span className="text-[10px] text-muted-foreground ml-1">· ad</span>}
                      </td>
                      <td className="px-2 py-1.5"><Input type="number" min="0" step="0.01" className="h-8 w-24" placeholder="0.00" value={r.amount} onChange={e => setUpdField(ckey, "amount", e.target.value)} /></td>
                      <td className="px-2 py-1.5"><Input type="number" min="0" className="h-8 w-24" placeholder="—" value={r.impressions} onChange={e => setUpdField(ckey, "impressions", e.target.value)} /></td>
                      <td className="px-2 py-1.5"><Input type="number" min="0" className="h-8 w-20" placeholder="—" value={r.clicks} onChange={e => setUpdField(ckey, "clicks", e.target.value)} /></td>
                      <td className="px-2 py-1.5"><Input type="number" min="0" step="0.001" className="h-8 w-20" placeholder="—" value={r.ctr} onChange={e => setUpdField(ckey, "ctr", e.target.value)} /></td>
                      <td className="px-2 py-1.5"><Input type="number" min="0" step="0.01" className="h-8 w-24" placeholder="—" value={r.conversions} onChange={e => setUpdField(ckey, "conversions", e.target.value)} /></td>
                      <td className="px-2 py-1.5"><Input type="number" min="0" step="0.01" className="h-8 w-28" placeholder="—" value={r.conversionValue} onChange={e => setUpdField(ckey, "conversionValue", e.target.value)} /></td>
                    </tr>
                  );
                })}
                {campaigns.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">Sem campanhas — cria uma primeiro.</td></tr>}
              </tbody>
            </table>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUpdOpen(false)}>Cancelar</Button>
            <Button disabled={updSaving} onClick={saveDailyUpdate}>
              {updSaving ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-1.5" />}
              Guardar dia
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Editar campanha */}
      <Dialog open={!!editCamp} onOpenChange={(v) => !v && setEditCamp(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Editar {editCamp?.name}</DialogTitle></DialogHeader>
          {editCamp && (
            <div className="space-y-3">
              <div><Label className="text-xs">Nome</Label><Input value={editCamp._name} onChange={e => setEditCamp({ ...editCamp, _name: e.target.value })} /></div>
              <div>
                <Label className="text-xs">Projeto</Label>
                <Select value={editCamp._project} onValueChange={(v) => setEditCamp({ ...editCamp, _project: v })}>
                  <SelectTrigger><SelectValue placeholder="Nenhum" /></SelectTrigger>
                  <SelectContent>{sortedProjects.map((p: any) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div><Label className="text-xs">Orçamento (€/dia)</Label><Input type="number" value={editCamp._budget} onChange={e => setEditCamp({ ...editCamp, _budget: e.target.value })} /></div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditCamp(null)}>Cancelar</Button>
            <Button disabled={updateInternal.isPending || updateAd.isPending} onClick={() => {
              const proj = editCamp._project ? Number(editCamp._project) : null;
              if (editCamp.campaignType === "ad") {
                updateAd.mutate({ id: editCamp.id, name: editCamp._name, projectId: proj, budget: editCamp._budget ? String(editCamp._budget) : null });
              } else {
                updateInternal.mutate({ id: editCamp.id, name: editCamp._name, projectId: proj, dailyBudget: editCamp._budget ? Number(editCamp._budget) : null });
              }
            }}>Guardar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
