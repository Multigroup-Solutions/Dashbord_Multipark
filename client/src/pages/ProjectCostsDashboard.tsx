import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  Euro,
  Loader2,
  TrendingUp,
  TrendingDown,
  Wallet,
  Users,
  Receipt,
  FolderTree,
  AlertTriangle,
  CheckCircle2,
  ArrowLeft,
  Download,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useState, useMemo, useRef } from "react";
import { useLocation } from "wouter";

import {
  CHART_PALETTE,
  CHART_PRIMARY,
  CHART_SEMANTIC,
  chartAxisTick,
  chartGridStroke,
  chartTooltipStyle,
} from "@/lib/chart-theme";

const COLORS = CHART_PALETTE;

function fmt(v: number) {
  return v.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
}

function pct(v: number) {
  return `${v.toFixed(1)}%`;
}

function budgetColor(percentUsed: number): string {
  if (percentUsed >= 100) return "text-red-600";
  if (percentUsed >= 80) return "text-amber-600";
  if (percentUsed >= 50) return "text-yellow-600";
  return "text-emerald-600";
}

function budgetBg(percentUsed: number): string {
  if (percentUsed >= 100) return "bg-red-500";
  if (percentUsed >= 80) return "bg-amber-500";
  if (percentUsed >= 50) return "bg-yellow-500";
  return "bg-emerald-500";
}

function budgetBadge(percentUsed: number, budget: number) {
  if (budget === 0) return <Badge variant="outline" className="text-xs">Sem orçamento</Badge>;
  if (percentUsed >= 100) return <Badge className="bg-red-100 text-red-700 border-red-200 text-xs">Excedido</Badge>;
  if (percentUsed >= 80) return <Badge className="bg-amber-100 text-amber-700 border-amber-200 text-xs">Atenção</Badge>;
  return <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 text-xs">Saudável</Badge>;
}

type ProjectCost = {
  id: number;
  name: string;
  level: string;
  parentId: number | null;
  color: string | null;
  managerId: number | null;
  managerName: string;
  budget: number;
  expenses: number;
  expenseCount: number;
  pendingExpenses: number;
  paidExpenses: number;
  salaryCost: number;
  employeeCount: number;
  totalCost: number;
  remaining: number;
  percentUsed: number;
};

export default function ProjectCostsDashboard() {
  const [, setLocation] = useLocation();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState<number | undefined>(undefined);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [levelFilter, setLevelFilter] = useState<string>("all");

  const prevDataRef = useRef<ProjectCost[]>([]);
  const { data: costData, isLoading } = trpc.projects.costs.useQuery(
    { year, month },
    { placeholderData: (prev) => prev }
  );
  // Keep a stable ref for previous data
  if (costData && costData.length > 0) {
    prevDataRef.current = costData as ProjectCost[];
  }

  const data = (costData ?? []) as ProjectCost[];

  // Build hierarchy helpers
  const childrenMap = useMemo(() => {
    const map = new Map<number | null, ProjectCost[]>();
    for (const p of data) {
      const pid = p.parentId;
      if (!map.has(pid)) map.set(pid, []);
      map.get(pid)!.push(p);
    }
    return map;
  }, [data]);

  // Hierarchical rollup: compute aggregated costs (own + children)
  const rollupData = useMemo(() => {
    // Build children map
    const cMap = new Map<number | null, ProjectCost[]>();
    for (const p of data) {
      const pid = p.parentId;
      if (!cMap.has(pid)) cMap.set(pid, []);
      cMap.get(pid)!.push(p);
    }
    // Recursive rollup
    const rollup = new Map<number, { expenses: number; salaryCost: number; totalCost: number; budget: number; employeeCount: number; expenseCount: number }>(); 
    function computeRollup(id: number): { expenses: number; salaryCost: number; totalCost: number; budget: number; employeeCount: number; expenseCount: number } {
      if (rollup.has(id)) return rollup.get(id)!;
      const item = data.find(d => d.id === id);
      if (!item) return { expenses: 0, salaryCost: 0, totalCost: 0, budget: 0, employeeCount: 0, expenseCount: 0 };
      let agg = { expenses: item.expenses, salaryCost: item.salaryCost, totalCost: item.totalCost, budget: item.budget, employeeCount: item.employeeCount, expenseCount: item.expenseCount };
      const children = cMap.get(id) || [];
      for (const child of children) {
        const cr = computeRollup(child.id);
        agg.expenses += cr.expenses;
        agg.salaryCost += cr.salaryCost;
        agg.totalCost += cr.totalCost;
        agg.budget += cr.budget;
        agg.employeeCount += cr.employeeCount;
        agg.expenseCount += cr.expenseCount;
      }
      rollup.set(id, agg);
      return agg;
    }
    for (const d of data) computeRollup(d.id);
    return rollup;
  }, [data]);

  // Aggregate totals from ALL items (not just project level)
  const totals = useMemo(() => {
    // Sum only direct costs across all items (no double counting)
    const totalBudget = data.reduce((s, d) => s + d.budget, 0);
    const totalExpenses = data.reduce((s, d) => s + d.expenses, 0);
    const totalSalary = data.reduce((s, d) => s + d.salaryCost, 0);
    const totalCost = totalExpenses + totalSalary;
    const totalRemaining = totalBudget - totalCost;
    const percentUsed = totalBudget > 0 ? (totalCost / totalBudget) * 100 : 0;
    const allWithBudget = data.filter(d => d.budget > 0);
    const projectsOverBudget = allWithBudget.filter(d => {
      const r = rollupData.get(d.id);
      return r && r.budget > 0 && (r.totalCost / r.budget) * 100 >= 100;
    }).length;
    const projectsAtRisk = allWithBudget.filter(d => {
      const r = rollupData.get(d.id);
      if (!r || r.budget <= 0) return false;
      const pct = (r.totalCost / r.budget) * 100;
      return pct >= 80 && pct < 100;
    }).length;
    return { totalBudget, totalExpenses, totalSalary, totalCost, totalRemaining, percentUsed, projectsOverBudget, projectsAtRisk, projectCount: data.length };
  }, [data, rollupData]);

  // Chart data: top items by cost (any level with costs)
  const topProjectsChart = useMemo(() => {
    return data
      .filter(d => d.totalCost > 0)
      .sort((a, b) => b.totalCost - a.totalCost)
      .slice(0, 10)
      .map(d => ({
        name: d.name.length > 18 ? d.name.slice(0, 18) + "…" : d.name,
        despesas: d.expenses,
        salarios: d.salaryCost,
        orcamento: d.budget,
      }));
  }, [data]);

  // Pie data: cost distribution by top-level groups/cities
  const costByLevel = useMemo(() => {
    const levelMap = new Map<string, number>();
    // Group costs by root-level items (groups) using rollup
    const roots = data.filter(d => d.parentId === null);
    for (const root of roots) {
      const r = rollupData.get(root.id);
      if (r && r.totalCost > 0) {
        levelMap.set(root.name, r.totalCost);
      }
    }
    // Add unallocated costs (items with no project)
    const unallocated = data.filter(d => d.totalCost > 0 && !data.some(p => p.id === d.parentId) && d.parentId !== null);
    for (const u of unallocated) {
      levelMap.set(u.name, (levelMap.get(u.name) || 0) + u.totalCost);
    }
    return Array.from(levelMap.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [data, rollupData]);

  // Filtered data for table
  const filteredData = useMemo(() => {
    if (levelFilter === "all") return data;
    return data.filter(d => d.level === levelFilter);
  }, [data, levelFilter]);

  // Roots (no parent or parent not in filtered set)
  const rootItems = useMemo(() => {
    if (levelFilter !== "all") return filteredData.sort((a, b) => b.totalCost - a.totalCost);
    return filteredData.filter(d => d.parentId === null).sort((a, b) => b.totalCost - a.totalCost);
  }, [filteredData, levelFilter]);

  const toggleExpand = (id: number) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const expandAll = () => {
    setExpandedIds(new Set(data.map(d => d.id)));
  };

  const collapseAll = () => {
    setExpandedIds(new Set());
  };

  // CSV export
  const exportCSV = () => {
    const projectRows = data;
    const header = "Projeto;Gestor;Orçamento;Despesas;Salários;Custo Total;Restante;% Utilizado";
    const rows = projectRows.map(d =>
      [
        d.name,
        d.managerName,
        d.budget.toFixed(2).replace(".", ","),
        d.expenses.toFixed(2).replace(".", ","),
        d.salaryCost.toFixed(2).replace(".", ","),
        d.totalCost.toFixed(2).replace(".", ","),
        d.remaining.toFixed(2).replace(".", ","),
        d.percentUsed.toFixed(1).replace(".", ",") + "%",
      ].join(";")
    );
    const csv = "\uFEFF" + [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `custos-projetos-${year}${month ? `-${String(month).padStart(2, "0")}` : ""}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const months = [
    { value: "all", label: "Ano inteiro" },
    { value: "1", label: "Janeiro" },
    { value: "2", label: "Fevereiro" },
    { value: "3", label: "Março" },
    { value: "4", label: "Abril" },
    { value: "5", label: "Maio" },
    { value: "6", label: "Junho" },
    { value: "7", label: "Julho" },
    { value: "8", label: "Agosto" },
    { value: "9", label: "Setembro" },
    { value: "10", label: "Outubro" },
    { value: "11", label: "Novembro" },
    { value: "12", label: "Dezembro" },
  ];

  const years = Array.from({ length: 5 }, (_, i) => now.getFullYear() - i);

  const levelLabels: Record<string, string> = {
    group: "Grupo",
    city: "Cidade",
    brand: "Marca",
    project: "Projeto",
  };

  function renderRow(item: ProjectCost, depth: number) {
    const children = childrenMap.get(item.id) || [];
    const hasChildren = children.length > 0 && levelFilter === "all";
    const isExpanded = expandedIds.has(item.id);

    // Use rollup data for items with children, direct data for leaf items
    const r = rollupData.get(item.id);
    const displayExpenses = hasChildren && r ? r.expenses : item.expenses;
    const displaySalary = hasChildren && r ? r.salaryCost : item.salaryCost;
    const displayTotal = hasChildren && r ? r.totalCost : item.totalCost;
    const displayBudget = hasChildren && r ? r.budget : item.budget;
    const displayPercent = displayBudget > 0 ? (displayTotal / displayBudget) * 100 : 0;

    return (
      <div key={item.id}>
        <div
          className={`flex items-center gap-2 px-3 py-2.5 border-b hover:bg-muted/50 transition-colors ${
            depth === 0 ? "bg-muted/20" : ""
          }`}
          style={{ paddingLeft: `${12 + depth * 24}px` }}
        >
          {/* Expand toggle */}
          <div className="w-5 shrink-0">
            {hasChildren ? (
              <button onClick={() => toggleExpand(item.id)} className="p-0.5 hover:bg-accent rounded">
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
            ) : null}
          </div>

          {/* Color dot + name */}
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <div
              className="h-3 w-3 rounded-full shrink-0"
              style={{ backgroundColor: item.color || CHART_PRIMARY }}
            />
            <span className={`truncate ${depth === 0 ? "font-semibold" : "font-medium"} text-sm`}>
              {item.name}
            </span>
            <Badge variant="outline" className="text-[10px] shrink-0">
              {levelLabels[item.level] || item.level}
            </Badge>
            {hasChildren && (
              <span className="text-[10px] text-muted-foreground">
                ({(r?.employeeCount ?? item.employeeCount)} func.)
              </span>
            )}
          </div>

          {/* Manager */}
          <div className="hidden md:block w-28 text-xs text-muted-foreground truncate shrink-0">
            {item.managerName !== "—" ? item.managerName : ""}
          </div>

          {/* Budget */}
          <div className="w-24 text-right text-sm shrink-0">
            {displayBudget > 0 ? fmt(displayBudget) : <span className="text-muted-foreground text-xs">—</span>}
          </div>

          {/* Expenses */}
          <div className="hidden sm:block w-24 text-right text-sm shrink-0">
            {displayExpenses > 0 ? fmt(displayExpenses) : <span className="text-muted-foreground text-xs">—</span>}
          </div>

          {/* Salaries */}
          <div className="hidden sm:block w-24 text-right text-sm shrink-0">
            {displaySalary > 0 ? fmt(displaySalary) : <span className="text-muted-foreground text-xs">—</span>}
          </div>

          {/* Total cost */}
          <div className="w-24 text-right text-sm font-semibold shrink-0">
            {displayTotal > 0 ? fmt(displayTotal) : <span className="text-muted-foreground text-xs">—</span>}
          </div>

          {/* Progress bar + badge */}
          <div className="w-36 shrink-0 flex items-center gap-2">
            {displayBudget > 0 ? (
              <>
                <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${budgetBg(displayPercent)}`}
                    style={{ width: `${Math.min(displayPercent, 100)}%` }}
                  />
                </div>
                <span className={`text-xs font-medium w-12 text-right ${budgetColor(displayPercent)}`}>
                  {pct(displayPercent)}
                </span>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
          </div>

          {/* Status badge */}
          <div className="w-20 shrink-0 flex justify-end">
            {budgetBadge(displayPercent, displayBudget)}
          </div>
        </div>

        {/* Children */}
        {hasChildren && isExpanded && (
          <div>
            {children
              .sort((a, b) => {
                const ra = rollupData.get(a.id);
                const rb = rollupData.get(b.id);
                return (rb?.totalCost ?? b.totalCost) - (ra?.totalCost ?? a.totalCost);
              })
              .map(child => renderRow(child, depth + 1))}
          </div>
        )}
      </div>
    );
  }

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
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/projetos")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <p className="text-sm text-muted-foreground">
              Comparação de despesas e salários vs. orçamento definido
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {years.map(y => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={month ? String(month) : "all"} onValueChange={(v) => setMonth(v === "all" ? undefined : Number(v))}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {months.map(m => (
                <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={exportCSV} className="gap-1.5">
            <Download className="h-3.5 w-3.5" />
            CSV
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Card className="relative overflow-hidden">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground font-medium">Orçamento Total</p>
                <p className="text-lg font-bold">{fmt(totals.totalBudget)}</p>
              </div>
              <div className="h-8 w-8 rounded-lg flex items-center justify-center bg-blue-100">
                <Wallet className="h-4 w-4 text-blue-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground font-medium">Despesas</p>
                <p className="text-lg font-bold">{fmt(totals.totalExpenses)}</p>
              </div>
              <div className="h-8 w-8 rounded-lg flex items-center justify-center bg-amber-100">
                <Receipt className="h-4 w-4 text-amber-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground font-medium">Salários</p>
                <p className="text-lg font-bold">{fmt(totals.totalSalary)}</p>
              </div>
              <div className="h-8 w-8 rounded-lg flex items-center justify-center bg-purple-100">
                <Users className="h-4 w-4 text-purple-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground font-medium">Custo Total</p>
                <p className="text-lg font-bold">{fmt(totals.totalCost)}</p>
              </div>
              <div className="h-8 w-8 rounded-lg flex items-center justify-center bg-indigo-100">
                <Euro className="h-4 w-4 text-indigo-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground font-medium">Restante</p>
                <p className={`text-lg font-bold ${totals.totalRemaining < 0 ? "text-red-600" : "text-emerald-600"}`}>
                  {fmt(totals.totalRemaining)}
                </p>
              </div>
              <div className={`h-8 w-8 rounded-lg flex items-center justify-center ${totals.totalRemaining < 0 ? "bg-red-100" : "bg-emerald-100"}`}>
                {totals.totalRemaining < 0 ? (
                  <TrendingDown className="h-4 w-4 text-red-600" />
                ) : (
                  <TrendingUp className="h-4 w-4 text-emerald-600" />
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground font-medium">Alertas</p>
                <p className="text-lg font-bold">
                  <span className="text-red-600">{totals.projectsOverBudget}</span>
                  <span className="text-muted-foreground text-sm mx-1">/</span>
                  <span className="text-amber-600">{totals.projectsAtRisk}</span>
                </p>
                <p className="text-[10px] text-muted-foreground">excedidos / em risco</p>
              </div>
              <div className="h-8 w-8 rounded-lg flex items-center justify-center bg-red-100">
                <AlertTriangle className="h-4 w-4 text-red-600" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Top projects bar chart */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold">Top 10 Projetos por Custo</CardTitle>
          </CardHeader>
          <CardContent>
            {topProjectsChart.length === 0 ? (
              <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
                Sem dados disponíveis
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={topProjectsChart} margin={{ top: 4, right: 4, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartGridStroke} />
                  <XAxis dataKey="name" tick={chartAxisTick} angle={-20} textAnchor="end" height={60} />
                  <YAxis tick={chartAxisTick} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k€`} />
                  <Tooltip
                    formatter={(v: any, name: string) => [
                      fmt(parseFloat(v)),
                      name === "despesas" ? "Despesas" : name === "salarios" ? "Salários" : "Orçamento",
                    ]}
                    contentStyle={chartTooltipStyle}
                  />
                  <Legend
                    formatter={(value: string) =>
                      value === "despesas" ? "Despesas" : value === "salarios" ? "Salários" : "Orçamento"
                    }
                    wrapperStyle={{ fontSize: "12px" }}
                  />
                  <Bar dataKey="despesas" stackId="cost" fill={CHART_SEMANTIC.warning} radius={[0, 0, 0, 0]} />
                  <Bar dataKey="salarios" stackId="cost" fill={CHART_PALETTE[4]} radius={[4, 4, 0, 0]} />
                  <Bar dataKey="orcamento" fill={chartGridStroke} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Cost by city pie */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold">Custos por Marca</CardTitle>
          </CardHeader>
          <CardContent>
            {costByLevel.length === 0 ? (
              <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
                Sem dados disponíveis
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={costByLevel}
                    cx="50%"
                    cy="50%"
                    innerRadius={55}
                    outerRadius={90}
                    paddingAngle={3}
                    dataKey="value"
                  >
                    {costByLevel.map((_: any, i: number) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(v: any) => [fmt(parseFloat(String(v)))]}
                    contentStyle={chartTooltipStyle}
                  />
                  <Legend iconSize={10} wrapperStyle={{ fontSize: "11px" }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Projects Table */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <FolderTree className="h-4 w-4 text-primary" />
              Detalhe por Projeto
            </CardTitle>
            <div className="flex items-center gap-2">
              <Select value={levelFilter} onValueChange={setLevelFilter}>
                <SelectTrigger className="w-32 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Hierarquia</SelectItem>
                  <SelectItem value="project">Só projetos</SelectItem>
                  <SelectItem value="city">Só cidades</SelectItem>
                  <SelectItem value="brand">Só marcas</SelectItem>
                </SelectContent>
              </Select>
              {levelFilter === "all" && (
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" onClick={expandAll} className="text-xs h-8 px-2">
                    Expandir
                  </Button>
                  <Button variant="ghost" size="sm" onClick={collapseAll} className="text-xs h-8 px-2">
                    Colapsar
                  </Button>
                </div>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {/* Table header */}
          <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40 text-xs font-medium text-muted-foreground">
            <div className="w-5 shrink-0" />
            <div className="flex-1 min-w-0">Projeto</div>
            <div className="hidden md:block w-28 shrink-0">Gestor</div>
            <div className="w-24 text-right shrink-0">Orçamento</div>
            <div className="hidden sm:block w-24 text-right shrink-0">Despesas</div>
            <div className="hidden sm:block w-24 text-right shrink-0">Salários</div>
            <div className="w-24 text-right shrink-0">Custo Total</div>
            <div className="w-36 shrink-0 text-center">Utilização</div>
            <div className="w-20 shrink-0 text-right">Estado</div>
          </div>

          {/* Table body */}
          <div className="max-h-[500px] overflow-y-auto">
            {rootItems.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground text-sm">
                Sem projetos com dados de custos
              </div>
            ) : (
              rootItems.map(item => renderRow(item, 0))
            )}
          </div>
        </CardContent>
      </Card>

      {/* Budget health summary */}
      {data.filter(d => d.budget > 0 && d.percentUsed >= 80).length > 0 && (
        <Card className="border-amber-200 bg-amber-50/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold flex items-center gap-2 text-amber-800">
              <AlertTriangle className="h-4 w-4" />
              Projetos que Requerem Atenção
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {data
                .filter(d => d.budget > 0 && d.percentUsed >= 80)
                .sort((a, b) => b.percentUsed - a.percentUsed)
                .map(d => (
                  <div key={d.id} className="flex items-center gap-3 p-3 rounded-lg bg-white border">
                    <div
                      className="h-3 w-3 rounded-full shrink-0"
                      style={{ backgroundColor: d.color || CHART_PRIMARY }}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{d.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {fmt(d.totalCost)} / {fmt(d.budget)}
                      </p>
                    </div>
                    <div className="shrink-0">
                      {budgetBadge(d.percentUsed, d.budget)}
                    </div>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
