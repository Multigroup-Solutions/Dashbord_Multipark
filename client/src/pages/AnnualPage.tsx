import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/_core/hooks/useAuth";
import { toast } from "sonner";
import { useState, useMemo, useEffect } from "react";
import {
  Euro, TrendingUp, TrendingDown,
  BarChart3, ArrowUpRight, ArrowDownRight, Receipt, Users, Landmark,
  Megaphone, HandCoins, Calendar, Upload, Loader2,
} from "lucide-react";

const MONTHS = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const MONTHS_SHORT = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];

const fmt = (v: number) => new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(v);
const fmtCompact = (v: number) => {
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k€`;
  return `${Math.round(v)}€`;
};

const LEVEL_LABEL: Record<string, string> = {
  group: "Grupo", city: "Cidade", brand: "Marca", project: "Projeto",
};
const LEVEL_COLOR: Record<string, string> = {
  group: "bg-violet-100 text-violet-700 border-violet-200",
  city: "bg-blue-100 text-blue-700 border-blue-200",
  brand: "bg-emerald-100 text-emerald-700 border-emerald-200",
  project: "bg-amber-100 text-amber-700 border-amber-200",
};

function sortProjectsHierarchical<T extends { id: number; name: string; parentId?: number | null; level?: string | null }>(
  list: T[],
): Array<T & { __depth: number }> {
  const byParent = new Map<number | null, T[]>();
  for (const p of list) {
    const key = p.parentId ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(p);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.name.localeCompare(b.name, "pt"));
  const out: Array<T & { __depth: number }> = [];
  function walk(parentId: number | null, depth: number) {
    const children = byParent.get(parentId) ?? [];
    for (const c of children) {
      out.push({ ...c, __depth: depth });
      walk(c.id, depth + 1);
    }
  }
  walk(null, 0);
  const seen = new Set(out.map((p) => p.id));
  for (const p of list) if (!seen.has(p.id)) out.push({ ...p, __depth: 0 });
  return out;
}

type MonthRow = {
  month: number;
  revenueGrossWithVat?: number;
  salesCommissions?: number;
  operationalCommissions?: number;
  revenueWithVat: number;
  revenueNoVat: number;
  vatRevenue: number;
  expensesWithVat: number;
  expensesNoVat: number;
  vatExpenses: number;
  vatToPay: number;
  marketingCost?: number;
  extrasDiaCost?: number;
  salaries: number;
  employerTax: number;
  totalCosts: number;
  profit: number;
};

type Totals = {
  revenueGrossWithVat: number;
  salesCommissions: number;
  operationalCommissions: number;
  revenueWithVat: number;
  revenueNoVat: number;
  vatRevenue: number;
  expensesWithVat: number;
  expensesNoVat: number;
  vatExpenses: number;
  vatToPay: number;
  marketingCost: number;
  extrasDiaCost: number;
  salaries: number;
  employerTax: number;
  totalCosts: number;
  profit: number;
};

function aggregate(rows: MonthRow[]): Totals {
  const t: Totals = {
    revenueGrossWithVat: 0, salesCommissions: 0, operationalCommissions: 0,
    revenueWithVat: 0, revenueNoVat: 0, vatRevenue: 0,
    expensesWithVat: 0, expensesNoVat: 0, vatExpenses: 0, vatToPay: 0,
    marketingCost: 0, extrasDiaCost: 0,
    salaries: 0, employerTax: 0, totalCosts: 0, profit: 0,
  };
  for (const m of rows) {
    t.revenueGrossWithVat += m.revenueGrossWithVat ?? m.revenueWithVat;
    t.salesCommissions += m.salesCommissions ?? 0;
    t.operationalCommissions += m.operationalCommissions ?? 0;
    t.revenueWithVat += m.revenueWithVat;
    t.revenueNoVat += m.revenueNoVat;
    t.vatRevenue += m.vatRevenue;
    t.expensesWithVat += m.expensesWithVat;
    t.expensesNoVat += m.expensesNoVat;
    t.vatExpenses += m.vatExpenses;
    t.vatToPay += m.vatToPay;
    t.marketingCost += m.marketingCost ?? 0;
    t.extrasDiaCost += m.extrasDiaCost ?? 0;
    t.salaries += m.salaries;
    t.employerTax += m.employerTax;
    t.totalCosts += m.totalCosts;
    t.profit += m.profit;
  }
  return t;
}

function deltaPct(curr: number, prev: number): number | null {
  if (prev === 0) return null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

function DeltaBadge({ curr, prev, invert = false }: { curr: number; prev: number; invert?: boolean }) {
  const pct = deltaPct(curr, prev);
  if (pct === null) return <span className="text-[10px] text-muted-foreground">—</span>;
  const positive = invert ? pct < 0 : pct > 0;
  const color = positive ? "text-emerald-700 bg-emerald-50" : pct === 0 ? "text-muted-foreground bg-muted" : "text-red-700 bg-red-50";
  const arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "•";
  return <span className={`text-[10px] px-1 rounded ${color}`}>{arrow} {Math.abs(pct).toFixed(1)}%</span>;
}

// Parse de CSV/Excel colado: colunas ano;mês;receita[;despesas][;ordenados][;notas]
// Aceita ; , ou TAB como separador e números PT ("1.234,56") ou EN ("1234.56").
function parseHistoryCsv(text: string): Array<{ year: number; month: number; revenueWithVat: number; expensesWithVat?: number; salaries?: number; notes?: string }> {
  const parseNum = (s: string): number => {
    const t = (s ?? "").trim().replace(/[€\s]/g, "");
    if (!t) return 0;
    // "1.234,56" → PT; "1234.56" → EN
    const norm = /,\d{1,2}$/.test(t) ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
    const n = parseFloat(norm);
    return Number.isFinite(n) ? n : 0;
  };
  const rows: ReturnType<typeof parseHistoryCsv> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(/[;\t]|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((c) => c.replace(/^"|"$/g, "").trim());
    const year = parseInt(cols[0]);
    const month = parseInt(cols[1]);
    if (!Number.isFinite(year) || year < 2000 || year > 2100) continue; // salta cabeçalhos
    if (!Number.isFinite(month) || month < 1 || month > 12) continue;
    rows.push({
      year, month,
      revenueWithVat: parseNum(cols[2]),
      expensesWithVat: cols[3] != null ? parseNum(cols[3]) : undefined,
      salaries: cols[4] != null ? parseNum(cols[4]) : undefined,
      notes: cols[5] || undefined,
    });
  }
  return rows;
}

function ImportHistoryDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const [text, setText] = useState("");
  const importMutation = trpc.annual.importHistory.useMutation({
    onSuccess: (r) => { toast.success(`${r.imported} meses importados`); setText(""); onImported(); onClose(); },
    onError: (e) => toast.error(e.message || "Erro ao importar"),
  });
  const parsed = useMemo(() => parseHistoryCsv(text), [text]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Upload className="h-5 w-5 text-primary" /> Importar histórico financeiro</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 flex-1 min-h-0 overflow-y-auto">
          <p className="text-sm text-muted-foreground">
            Cola aqui as linhas do Excel/CSV com os totais mensais de anos antigos (2016→). Formato por linha:
          </p>
          <pre className="text-xs bg-muted/50 rounded p-2">ano;mês;receita c/IVA;despesas c/IVA;ordenados;notas{"\n"}2019;1;85000;42000;15000;importado do excel</pre>
          <p className="text-xs text-muted-foreground">
            Despesas, ordenados e notas são opcionais. Estes valores só são usados nos meses em que a app
            não tem dados reais (reservas/despesas/payroll) — os anos com dados reais nunca são substituídos.
            Reimportar o mesmo ano/mês substitui o valor anterior.
          </p>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
            placeholder={"2019;1;85000;42000;15000\n2019;2;79000;40000;15000\n…"}
            className="font-mono text-xs"
          />
          <p className="text-sm">
            {parsed.length > 0
              ? <span className="text-emerald-700 font-medium">{parsed.length} linhas válidas ({Array.from(new Set(parsed.map(r => r.year))).sort().join(", ")})</span>
              : <span className="text-muted-foreground">Sem linhas válidas ainda</span>}
          </p>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => importMutation.mutate({ rows: parsed })} disabled={parsed.length === 0 || importMutation.isPending} className="gap-2">
            {importMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Importar {parsed.length > 0 ? `${parsed.length} meses` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AnnualPage() {
  const filters = useGlobalFilters();
  const { user } = useAuth();
  const isAdmin = ["admin", "super_admin"].includes(user?.role ?? "");
  const [showImport, setShowImport] = useState(false);
  const utils = trpc.useUtils();
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [selectedProject, setSelectedProject] = useState<string>("all");
  const [fromMonth, setFromMonth] = useState(1);
  const [toMonth, setToMonth] = useState(12);
  const [compareMode, setCompareMode] = useState<"none" | "year">("none");
  const [compareYear, setCompareYear] = useState(currentYear - 1);

  useEffect(() => {
    if (filters.projectId !== undefined) setSelectedProject(String(filters.projectId));
    else setSelectedProject("all");
  }, [filters.projectId]);

  const projectId = selectedProject !== "all" ? parseInt(selectedProject) : undefined;

  const { data: monthsRaw = [], isLoading } = trpc.annual.breakdown.useQuery({ year, projectId });
  const { data: monthsCompareRaw = [] } = trpc.annual.breakdown.useQuery(
    { year: compareYear, projectId },
    { enabled: compareMode === "year" },
  );
  const { data: projects = [] } = trpc.projects.list.useQuery();

  // Filtra ao range de meses (filtragem client-side; o backend devolve 12 meses)
  const months = useMemo<MonthRow[]>(
    () => monthsRaw.filter((m: any) => m.month >= fromMonth && m.month <= toMonth) as MonthRow[],
    [monthsRaw, fromMonth, toMonth],
  );
  const monthsCompare = useMemo<MonthRow[]>(
    () => monthsCompareRaw.filter((m: any) => m.month >= fromMonth && m.month <= toMonth) as MonthRow[],
    [monthsCompareRaw, fromMonth, toMonth],
  );

  const totals = useMemo(() => aggregate(months), [months]);
  const totalsCompare = useMemo(() => aggregate(monthsCompare), [monthsCompare]);

  const maxVal = Math.max(...months.map(m => Math.max(m.revenueNoVat, m.totalCosts)), 1);
  const sortedProjects = useMemo(() => sortProjectsHierarchical(projects as any[]), [projects]);

  const showCompare = compareMode === "year" && monthsCompare.length > 0;

  return (
    <div className="space-y-6">
      <ImportHistoryDialog
        open={showImport}
        onClose={() => setShowImport(false)}
        onImported={() => utils.annual.breakdown.invalidate()}
      />
      {/* Header com filtros */}
      <Card className="p-3">
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <Link href="/faturacao">
              <a className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-1">← Faturação</a>
            </Link>
            <p className="text-sm text-muted-foreground">Visão anual de gestão: lucros, gastos, IVA, ordenados e comissões</p>
          </div>
          {isAdmin && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setShowImport(true)}>
              <Upload className="h-3.5 w-3.5" /> Importar histórico
            </Button>
          )}
          <div>
            <Label className="text-xs mb-1 block">Ano</Label>
            <Input type="number" value={year} onChange={e => setYear(parseInt(e.target.value) || currentYear)} className="w-24 h-9" />
          </div>
          <div>
            <Label className="text-xs mb-1 flex items-center gap-1"><Calendar className="w-3 h-3" /> De</Label>
            <Select value={String(fromMonth)} onValueChange={(v) => setFromMonth(parseInt(v))}>
              <SelectTrigger className="w-28 h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTHS.map((m, i) => <SelectItem key={i} value={String(i + 1)}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs mb-1 block">Até</Label>
            <Select value={String(toMonth)} onValueChange={(v) => setToMonth(parseInt(v))}>
              <SelectTrigger className="w-28 h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTHS.map((m, i) => <SelectItem key={i} value={String(i + 1)}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1 min-w-[240px]">
            <Label className="text-xs mb-1 block">Projeto / Centro de custos</Label>
            <Select value={selectedProject} onValueChange={setSelectedProject}>
              <SelectTrigger className="h-9"><SelectValue placeholder="Todos" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos (grupo / cidade / marca / projeto)</SelectItem>
                {sortedProjects.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    <span style={{ paddingLeft: `${p.__depth * 12}px` }} className="inline-flex items-center gap-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${LEVEL_COLOR[p.level ?? "project"] ?? ""}`}>
                        {LEVEL_LABEL[p.level ?? "project"] ?? p.level}
                      </span>
                      {p.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs mb-1 block">Comparar com</Label>
            <Tabs value={compareMode} onValueChange={(v) => setCompareMode(v as any)}>
              <TabsList className="h-9">
                <TabsTrigger value="none" className="text-xs">Nenhum</TabsTrigger>
                <TabsTrigger value="year" className="text-xs">Ano anterior</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          {compareMode === "year" && (
            <div>
              <Label className="text-xs mb-1 block">Ano comparado</Label>
              <Input
                type="number"
                value={compareYear}
                onChange={(e) => setCompareYear(parseInt(e.target.value) || currentYear - 1)}
                className="w-24 h-9"
              />
            </div>
          )}
        </div>
      </Card>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
        </div>
      ) : (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
            <Card className="p-3">
              <div className="flex items-center gap-1 mb-1">
                <Euro className="w-4 h-4 text-green-600" />
                <span className="text-[10px] text-muted-foreground">Receita s/IVA</span>
              </div>
              <p className="text-lg font-bold text-green-700">{fmt(totals.revenueNoVat)}</p>
              {showCompare && <DeltaBadge curr={totals.revenueNoVat} prev={totalsCompare.revenueNoVat} />}
            </Card>
            <Card className="p-3">
              <div className="flex items-center gap-1 mb-1">
                <HandCoins className="w-4 h-4 text-amber-600" />
                <span className="text-[10px] text-muted-foreground">Comissões</span>
              </div>
              <p className="text-lg font-bold text-amber-700">{fmt(totals.salesCommissions + totals.operationalCommissions)}</p>
              {showCompare && <DeltaBadge curr={totals.salesCommissions + totals.operationalCommissions} prev={totalsCompare.salesCommissions + totalsCompare.operationalCommissions} invert />}
            </Card>
            <Card className="p-3">
              <div className="flex items-center gap-1 mb-1">
                <Receipt className="w-4 h-4 text-red-600" />
                <span className="text-[10px] text-muted-foreground">Despesas s/IVA</span>
              </div>
              <p className="text-lg font-bold text-red-700">{fmt(totals.expensesNoVat)}</p>
              {showCompare && <DeltaBadge curr={totals.expensesNoVat} prev={totalsCompare.expensesNoVat} invert />}
            </Card>
            <Card className="p-3">
              <div className="flex items-center gap-1 mb-1">
                <Megaphone className="w-4 h-4 text-pink-600" />
                <span className="text-[10px] text-muted-foreground">Marketing</span>
              </div>
              <p className="text-lg font-bold text-pink-700">{fmt(totals.marketingCost)}</p>
              {showCompare && <DeltaBadge curr={totals.marketingCost} prev={totalsCompare.marketingCost} invert />}
            </Card>
            <Card className="p-3">
              <div className="flex items-center gap-1 mb-1">
                <Users className="w-4 h-4 text-orange-600" />
                <span className="text-[10px] text-muted-foreground">Ordenados</span>
              </div>
              <p className="text-lg font-bold text-orange-700">{fmt(totals.salaries)}</p>
              {showCompare && <DeltaBadge curr={totals.salaries} prev={totalsCompare.salaries} invert />}
            </Card>
            <Card className="p-3">
              <div className="flex items-center gap-1 mb-1">
                <Landmark className="w-4 h-4 text-purple-600" />
                <span className="text-[10px] text-muted-foreground">TSU + Extras-dia</span>
              </div>
              <p className="text-lg font-bold text-purple-700">{fmt(totals.employerTax + totals.extrasDiaCost)}</p>
              {showCompare && <DeltaBadge curr={totals.employerTax + totals.extrasDiaCost} prev={totalsCompare.employerTax + totalsCompare.extrasDiaCost} invert />}
            </Card>
            <Card className="p-3">
              <div className="flex items-center gap-1 mb-1">
                <ArrowUpRight className="w-4 h-4 text-blue-600" />
                <span className="text-[10px] text-muted-foreground">IVA a Pagar</span>
              </div>
              <p className={`text-lg font-bold ${totals.vatToPay >= 0 ? "text-red-700" : "text-green-700"}`}>{fmt(totals.vatToPay)}</p>
              {showCompare && <DeltaBadge curr={totals.vatToPay} prev={totalsCompare.vatToPay} />}
            </Card>
            <Card className="p-3 border-2 border-primary/20">
              <div className="flex items-center gap-1 mb-1">
                {totals.profit >= 0 ? <TrendingUp className="w-4 h-4 text-green-600" /> : <TrendingDown className="w-4 h-4 text-red-600" />}
                <span className="text-[10px] text-muted-foreground font-medium">Lucro</span>
              </div>
              <p className={`text-lg font-bold ${totals.profit >= 0 ? "text-green-700" : "text-red-700"}`}>{fmt(totals.profit)}</p>
              {showCompare && <DeltaBadge curr={totals.profit} prev={totalsCompare.profit} />}
            </Card>
          </div>

          {/* IVA summary */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Card className="p-4 bg-blue-50/50">
              <p className="text-xs text-muted-foreground mb-1">IVA Cobrado (23% das receitas líquidas)</p>
              <p className="text-2xl font-bold text-blue-700">{fmt(totals.vatRevenue)}</p>
            </Card>
            <Card className="p-4 bg-cyan-50/50">
              <p className="text-xs text-muted-foreground mb-1">IVA Dedutível (23% das despesas)</p>
              <p className="text-2xl font-bold text-cyan-700">{fmt(totals.vatExpenses)}</p>
            </Card>
            <Card className={`p-4 ${totals.vatToPay >= 0 ? "bg-red-50/50" : "bg-green-50/50"}`}>
              <p className="text-xs text-muted-foreground mb-1">IVA a {totals.vatToPay >= 0 ? "Pagar" : "Recuperar"}</p>
              <p className={`text-2xl font-bold ${totals.vatToPay >= 0 ? "text-red-700" : "text-green-700"}`}>{fmt(Math.abs(totals.vatToPay))}</p>
            </Card>
          </div>

          {/* Chart mensal — com comparação opcional */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart3 className="w-4 h-4" /> Evolução Mensal
                {showCompare && <span className="text-xs text-muted-foreground font-normal">— a comparar com {compareYear}</span>}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-end gap-2 h-64">
                {months.map((m, idx) => {
                  const mc = showCompare ? monthsCompare.find(x => x.month === m.month) : undefined;
                  const localMax = Math.max(maxVal, mc?.revenueNoVat ?? 0, mc?.totalCosts ?? 0);
                  const revH = (m.revenueNoVat / localMax) * 100;
                  const costH = (m.totalCosts / localMax) * 100;
                  const revCH = mc ? (mc.revenueNoVat / localMax) * 100 : 0;
                  const costCH = mc ? (mc.totalCosts / localMax) * 100 : 0;
                  return (
                    <div key={idx} className="flex-1 flex flex-col items-center gap-1">
                      <span className={`text-[10px] tabular-nums ${m.profit >= 0 ? "text-emerald-700" : "text-red-700"}`}>
                        {fmtCompact(m.profit)}
                      </span>
                      <div className="w-full flex gap-0.5 items-end" style={{ height: "180px" }}>
                        {showCompare && (
                          <>
                            <div className="flex-1 bg-green-200 rounded-t transition-all" style={{ height: `${revCH}%` }} title={`${compareYear} Receita: ${fmt(mc?.revenueNoVat ?? 0)}`} />
                            <div className="flex-1 bg-red-100 rounded-t transition-all" style={{ height: `${costCH}%` }} title={`${compareYear} Custos: ${fmt(mc?.totalCosts ?? 0)}`} />
                          </>
                        )}
                        <div className="flex-1 bg-green-500 rounded-t transition-all" style={{ height: `${revH}%` }} title={`Receita: ${fmt(m.revenueNoVat)}`} />
                        <div className="flex-1 bg-red-400 rounded-t transition-all" style={{ height: `${costH}%` }} title={`Custos: ${fmt(m.totalCosts)}`} />
                      </div>
                      <span className="text-[10px] text-muted-foreground">{MONTHS_SHORT[m.month - 1]}</span>
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground flex-wrap">
                <span className="flex items-center gap-1"><div className="w-3 h-3 bg-green-500 rounded" /> Receita {year}</span>
                <span className="flex items-center gap-1"><div className="w-3 h-3 bg-red-400 rounded" /> Custos {year}</span>
                {showCompare && (
                  <>
                    <span className="flex items-center gap-1"><div className="w-3 h-3 bg-green-200 rounded" /> Receita {compareYear}</span>
                    <span className="flex items-center gap-1"><div className="w-3 h-3 bg-red-100 rounded" /> Custos {compareYear}</span>
                  </>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Detalhe mensal */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Detalhe Mensal — {year}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="p-2">Mês</th>
                      <th className="p-2 text-right">Bruto c/IVA</th>
                      <th className="p-2 text-right">Comissões</th>
                      <th className="p-2 text-right">Líq. c/IVA</th>
                      <th className="p-2 text-right">IVA Rec.</th>
                      <th className="p-2 text-right">Receita s/IVA</th>
                      <th className="p-2 text-right">Desp. s/IVA</th>
                      <th className="p-2 text-right">Marketing</th>
                      <th className="p-2 text-right">Ordenados</th>
                      <th className="p-2 text-right">TSU+Extras</th>
                      <th className="p-2 text-right">IVA a Pagar</th>
                      <th className="p-2 text-right font-bold">Lucro</th>
                    </tr>
                  </thead>
                  <tbody>
                    {months.sort((a, b) => a.month - b.month).map(m => {
                      const mc = showCompare ? monthsCompare.find(x => x.month === m.month) : undefined;
                      const commissions = (m.salesCommissions ?? 0) + (m.operationalCommissions ?? 0);
                      return (
                        <tr key={m.month} className="border-b hover:bg-muted/50">
                          <td className="p-2 font-medium">
                            {MONTHS[m.month - 1]}
                            {(m as any).fromHistory && (
                              <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200" title="Valores importados do Excel (sem detalhe na app)">hist.</span>
                            )}
                          </td>
                          <td className="p-2 text-right tabular-nums text-muted-foreground">{fmt(m.revenueGrossWithVat ?? m.revenueWithVat)}</td>
                          <td className="p-2 text-right tabular-nums text-amber-700">−{fmt(commissions)}</td>
                          <td className="p-2 text-right tabular-nums text-green-600">{fmt(m.revenueWithVat)}</td>
                          <td className="p-2 text-right tabular-nums text-blue-600">{fmt(m.vatRevenue)}</td>
                          <td className="p-2 text-right tabular-nums text-green-700 font-medium">{fmt(m.revenueNoVat)}</td>
                          <td className="p-2 text-right tabular-nums text-red-700">{fmt(m.expensesNoVat)}</td>
                          <td className="p-2 text-right tabular-nums text-pink-700">{fmt(m.marketingCost ?? 0)}</td>
                          <td className="p-2 text-right tabular-nums text-orange-600">{fmt(m.salaries)}</td>
                          <td className="p-2 text-right tabular-nums text-purple-600">{fmt(m.employerTax + (m.extrasDiaCost ?? 0))}</td>
                          <td className={`p-2 text-right tabular-nums ${m.vatToPay >= 0 ? "text-red-600" : "text-green-600"}`}>{fmt(m.vatToPay)}</td>
                          <td className="p-2 text-right tabular-nums font-bold">
                            <span className={m.profit >= 0 ? "text-green-700" : "text-red-700"}>
                              {m.profit >= 0 ? "+" : ""}{fmt(m.profit)}
                            </span>
                            {showCompare && mc && (
                              <div className="text-[9px] font-normal text-muted-foreground">
                                vs {compareYear}: {mc.profit >= 0 ? "+" : ""}{fmtCompact(mc.profit)} <DeltaBadge curr={m.profit} prev={mc.profit} />
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {/* Totais */}
                    <tr className="border-t-2 font-bold bg-muted/30">
                      <td className="p-2">TOTAL</td>
                      <td className="p-2 text-right text-muted-foreground">{fmt(totals.revenueGrossWithVat)}</td>
                      <td className="p-2 text-right text-amber-700">−{fmt(totals.salesCommissions + totals.operationalCommissions)}</td>
                      <td className="p-2 text-right text-green-600">{fmt(totals.revenueWithVat)}</td>
                      <td className="p-2 text-right text-blue-600">{fmt(totals.vatRevenue)}</td>
                      <td className="p-2 text-right text-green-700">{fmt(totals.revenueNoVat)}</td>
                      <td className="p-2 text-right text-red-700">{fmt(totals.expensesNoVat)}</td>
                      <td className="p-2 text-right text-pink-700">{fmt(totals.marketingCost)}</td>
                      <td className="p-2 text-right text-orange-600">{fmt(totals.salaries)}</td>
                      <td className="p-2 text-right text-purple-600">{fmt(totals.employerTax + totals.extrasDiaCost)}</td>
                      <td className={`p-2 text-right ${totals.vatToPay >= 0 ? "text-red-600" : "text-green-600"}`}>{fmt(totals.vatToPay)}</td>
                      <td className="p-2 text-right">
                        <span className={totals.profit >= 0 ? "text-green-700" : "text-red-700"}>
                          {totals.profit >= 0 ? "+" : ""}{fmt(totals.profit)}
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Sumário de comparação ano vs ano */}
              {showCompare && (
                <div className="mt-6 border-t pt-4">
                  <h3 className="text-sm font-semibold mb-3">Comparação {year} vs {compareYear} (totais do período)</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                    <div className="p-3 rounded border bg-muted/20">
                      <p className="text-xs text-muted-foreground">Receita s/IVA</p>
                      <p className="font-semibold text-green-700">{fmt(totals.revenueNoVat)}</p>
                      <p className="text-[11px] text-muted-foreground">{compareYear}: {fmt(totalsCompare.revenueNoVat)}</p>
                      <DeltaBadge curr={totals.revenueNoVat} prev={totalsCompare.revenueNoVat} />
                    </div>
                    <div className="p-3 rounded border bg-muted/20">
                      <p className="text-xs text-muted-foreground">Despesas s/IVA</p>
                      <p className="font-semibold text-red-700">{fmt(totals.expensesNoVat)}</p>
                      <p className="text-[11px] text-muted-foreground">{compareYear}: {fmt(totalsCompare.expensesNoVat)}</p>
                      <DeltaBadge curr={totals.expensesNoVat} prev={totalsCompare.expensesNoVat} invert />
                    </div>
                    <div className="p-3 rounded border bg-muted/20">
                      <p className="text-xs text-muted-foreground">Custos totais</p>
                      <p className="font-semibold">{fmt(totals.totalCosts)}</p>
                      <p className="text-[11px] text-muted-foreground">{compareYear}: {fmt(totalsCompare.totalCosts)}</p>
                      <DeltaBadge curr={totals.totalCosts} prev={totalsCompare.totalCosts} invert />
                    </div>
                    <div className="p-3 rounded border bg-muted/20 border-primary/30">
                      <p className="text-xs text-muted-foreground">Lucro</p>
                      <p className={`font-semibold ${totals.profit >= 0 ? "text-green-700" : "text-red-700"}`}>{fmt(totals.profit)}</p>
                      <p className="text-[11px] text-muted-foreground">{compareYear}: {fmt(totalsCompare.profit)}</p>
                      <DeltaBadge curr={totals.profit} prev={totalsCompare.profit} />
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
