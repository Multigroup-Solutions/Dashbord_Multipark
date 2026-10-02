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
  Wallet,
  Users,
  Receipt,
  FolderTree,
  AlertTriangle,
  ArrowLeft,
  Download,
  ChevronDown,
  ChevronRight,
  Handshake,
} from "lucide-react";
import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import FitAmount from "@/components/finance/FitAmount";
import { AXIS_TICK, CHART_PALETTE, CHART_TOOLTIP_ITEM, CHART_TOOLTIP_STYLE, eurAxis } from "@/lib/financeFormat";

const COLORS = CHART_PALETTE;

function fmt(v: number) {
  return v.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
}

function pct(v: number) {
  return `${v.toFixed(1)}%`;
}

function budgetColor(percentUsed: number): string {
  if (percentUsed >= 100) return "text-red-700";
  if (percentUsed >= 80) return "text-amber-700";
  if (percentUsed >= 50) return "text-yellow-700";
  return "text-emerald-700";
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

/** Falha passageira (BD) tenta mais 2 vezes; sem permissão mostra logo o erro. */
const retryTransient = (count: number, err: unknown) =>
  count < 2 && !["FORBIDDEN", "UNAUTHORIZED", "BAD_REQUEST"].includes(String((err as { data?: { code?: string } })?.data?.code ?? ""));

/** Uma linha do servidor (server/finance/projectCosts.ts). */
type Row = {
  id: number; name: string; level: string; parentId: number | null; color: string | null; isActive: boolean;
  managerName: string;
  budgetAnnual: number; budget: number;
  expenses: number; expensesGross: number;
  salaries: number; employerTax: number; extras: number; personnel: number;
  commissions: number; totalCost: number;
};
type Sums = { expenses: number; personnel: number; commissions: number; totalCost: number; budget: number };
/** O que a tabela, os alertas e a lista "requerem atenção" mostram de um nó (uma regra só). */
type View = Sums & { percent: number; hasChildren: boolean };

export default function ProjectCostsDashboard({ onBack }: { onBack?: () => void } = {}) {
  const [, setLocation] = useLocation();
  const goBack = onBack ?? (() => setLocation("/projetos"));
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState<number | undefined>(undefined);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [levelFilter, setLevelFilter] = useState<string>("all");

  const { data: report, isLoading, error, refetch, isFetching, isPlaceholderData } = trpc.projects.costs.useQuery(
    { year, month },
    { placeholderData: (prev) => prev, retry: retryTransient }
  );
  const data = (report?.rows ?? []) as Row[];
  const unallocated = report?.unallocated;

  const childrenMap = useMemo(() => {
    const map = new Map<number | null, Row[]>();
    for (const p of data) {
      if (!map.has(p.parentId)) map.set(p.parentId, []);
      map.get(p.parentId)!.push(p);
    }
    return map;
  }, [data]);

  // Rollup: custos do nó + descendentes (cada custo vive num só nó, por isso
  // somar não duplica — é a mesma soma que a Faturação filtrada nesse nó).
  const rollupData = useMemo(() => {
    const rollup = new Map<number, Sums>();
    const byId = new Map(data.map((d) => [d.id, d]));
    const compute = (id: number): Sums => {
      const hit = rollup.get(id);
      if (hit) return hit;
      const item = byId.get(id);
      const agg: Sums = item
        ? { expenses: item.expenses, personnel: item.personnel, commissions: item.commissions, totalCost: item.totalCost, budget: item.budget }
        : { expenses: 0, personnel: 0, commissions: 0, totalCost: 0, budget: 0 };
      rollup.set(id, agg);
      for (const child of childrenMap.get(id) ?? []) {
        const c = compute(child.id);
        agg.expenses += c.expenses; agg.personnel += c.personnel; agg.commissions += c.commissions;
        agg.totalCost += c.totalCost; agg.budget += c.budget;
      }
      return agg;
    };
    for (const d of data) compute(d.id);
    return rollup;
  }, [data, childrenMap]);

  // Orçamento do nó (o budget é hierárquico: definido em cima, os filhos
  // consomem dele); sem budget próprio mas com filhos, conta a soma dos filhos.
  const viewOf = (item: Row): View => {
    const hasChildren = (childrenMap.get(item.id) ?? []).length > 0;
    const r = rollupData.get(item.id);
    const sums = hasChildren && r ? r : item;
    const budget = item.budget > 0 ? item.budget : (hasChildren && r ? r.budget : item.budget);
    return {
      expenses: sums.expenses, personnel: sums.personnel, commissions: sums.commissions, totalCost: sums.totalCost,
      budget, percent: budget > 0 ? (sums.totalCost / budget) * 100 : 0, hasChildren,
    };
  };

  const totals = useMemo(() => {
    // Orçamento total = budgets dos nós de topo (ou a soma dos filhos quando o topo não tem)
    const roots = data.filter((d) => d.parentId === null);
    const totalBudget = roots.reduce((s, root) => s + (root.budget > 0 ? root.budget : rollupData.get(root.id)?.budget ?? 0), 0);
    // Custos: os do servidor (= Faturação, mesmo alcance) — incluem o "Por atribuir"
    const t = report?.totals ?? { expenses: 0, personnel: 0, commissions: 0, totalCost: 0 };
    const views = data.map((d) => viewOf(d)).filter((v) => v.budget > 0);
    return {
      totalBudget, ...t,
      totalRemaining: totalBudget - t.totalCost,
      overBudget: views.filter((v) => v.percent >= 100).length,
      atRisk: views.filter((v) => v.percent >= 80 && v.percent < 100).length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, rollupData, report?.totals]);

  const topProjectsChart = useMemo(() => {
    return data
      .filter((d) => d.totalCost > 0)
      .sort((a, b) => b.totalCost - a.totalCost)
      .slice(0, 10)
      .map((d) => ({
        name: d.name.length > 18 ? d.name.slice(0, 18) + "…" : d.name,
        despesas: d.expenses,
        pessoal: d.personnel,
        comissoes: d.commissions,
        orcamento: d.budget,
      }));
  }, [data]);

  // Distribuição pelos nós de topo (com descendentes) + o que não tem centro
  const costByRoot = useMemo(() => {
    const out = data
      .filter((d) => d.parentId === null)
      .map((root) => ({ name: root.name, value: rollupData.get(root.id)?.totalCost ?? 0 }))
      .filter((x) => x.value > 0);
    if (unallocated && unallocated.totalCost > 0) out.push({ name: "Por atribuir", value: unallocated.totalCost });
    return out.sort((a, b) => b.value - a.value);
  }, [data, rollupData, unallocated]);

  const filteredData = useMemo(() => (levelFilter === "all" ? data : data.filter((d) => d.level === levelFilter)), [data, levelFilter]);

  const rootItems = useMemo(() => {
    const base = levelFilter === "all" ? filteredData.filter((d) => d.parentId === null) : filteredData;
    return [...base].sort((a, b) => (rollupData.get(b.id)?.totalCost ?? b.totalCost) - (rollupData.get(a.id)?.totalCost ?? a.totalCost));
  }, [filteredData, levelFilter, rollupData]);

  const attention = useMemo(
    () => data.map((d) => ({ d, v: viewOf(d) })).filter(({ v }) => v.budget > 0 && v.percent >= 80).sort((a, b) => b.v.percent - a.v.percent),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, rollupData],
  );

  const toggleExpand = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // CSV: valores do próprio nó e, à parte, com os descendentes
  const exportCSV = () => {
    const n = (v: number) => v.toFixed(2).replace(".", ",");
    const header = "Nó;Nível;Gestor;Orçamento anual;Orçamento do período;Despesas (sem IVA);Despesas (com IVA);Salários;TSU;Extras;Comissões;Custo do nó;Custo com descendentes;Restante;% utilizado";
    const rows = data.map((d) => {
      const v = viewOf(d);
      return [d.name, levelLabels[d.level] ?? d.level, d.managerName, n(d.budgetAnnual), n(v.budget), n(d.expenses), n(d.expensesGross), n(d.salaries), n(d.employerTax), n(d.extras), n(d.commissions), n(d.totalCost), n(v.totalCost), n(v.budget - v.totalCost), v.budget > 0 ? v.percent.toFixed(1).replace(".", ",") + "%" : ""].join(";");
    });
    if (unallocated && unallocated.totalCost > 0) {
      const u = unallocated;
      rows.push(["Por atribuir", "", "", "", "", n(u.expenses), n(u.expensesGross), n(u.salaries), n(u.employerTax), n(u.extras), n(u.commissions), n(u.totalCost), n(u.totalCost), "", ""].join(";"));
    }
    const csv = "﻿" + [header, ...rows].join("\n");
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

  const money = (v: number) => (v > 0 ? fmt(v) : <span className="text-muted-foreground text-xs">—</span>);

  function renderRow(item: Row, depth: number) {
    const children = childrenMap.get(item.id) || [];
    const v = viewOf(item);
    const hasChildren = v.hasChildren && levelFilter === "all";
    const isExpanded = expandedIds.has(item.id);

    return (
      <div key={item.id}>
        <div
          className={`flex items-center gap-2 px-3 py-2.5 border-b hover:bg-muted/50 transition-colors ${depth === 0 ? "bg-muted/20" : ""}`}
          style={{ paddingLeft: `${12 + depth * 24}px` }}
        >
          <div className="w-5 shrink-0">
            {hasChildren ? (
              <button onClick={() => toggleExpand(item.id)} className="p-0.5 hover:bg-accent rounded" aria-label={isExpanded ? "Fechar" : "Abrir"}>
                {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
              </button>
            ) : null}
          </div>

          <div className="flex items-center gap-2 min-w-[13rem] flex-1">
            <div className="h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: item.color || "#6366f1" }} />
            <span className={`truncate ${depth === 0 ? "font-semibold" : "font-medium"} text-sm`} title={item.name}>{item.name}</span>
            <Badge variant="outline" className="text-[11px] shrink-0">{levelLabels[item.level] || item.level}</Badge>
            {!item.isActive && <Badge variant="outline" className="text-[11px] shrink-0 text-muted-foreground">Inativo</Badge>}
          </div>

          <div className="hidden md:block w-28 text-xs text-muted-foreground truncate shrink-0">
            {item.managerName !== "—" ? item.managerName : ""}
          </div>
          <div className="w-28 text-right text-sm tabular-nums whitespace-nowrap shrink-0">{money(v.budget)}</div>
          <div className="w-28 text-right text-sm tabular-nums whitespace-nowrap shrink-0">{money(v.expenses)}</div>
          <div className="w-28 text-right text-sm tabular-nums whitespace-nowrap shrink-0">{money(v.personnel)}</div>
          <div className="w-24 text-right text-sm tabular-nums whitespace-nowrap shrink-0">{money(v.commissions)}</div>
          <div className="w-28 text-right text-sm font-semibold tabular-nums whitespace-nowrap shrink-0">{money(v.totalCost)}</div>

          <div className="w-36 shrink-0 flex items-center gap-2">
            {v.budget > 0 ? (
              <>
                <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                  <div className={`h-full rounded-full transition-all ${budgetBg(v.percent)}`} style={{ width: `${Math.min(v.percent, 100)}%` }} />
                </div>
                <span className={`text-xs font-medium w-12 text-right tabular-nums ${budgetColor(v.percent)}`}>{pct(v.percent)}</span>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
          </div>

          <div className="w-28 shrink-0 flex justify-end">{budgetBadge(v.percent, v.budget)}</div>
        </div>

        {hasChildren && isExpanded && (
          <div>
            {[...children]
              .sort((a, b) => (rollupData.get(b.id)?.totalCost ?? b.totalCost) - (rollupData.get(a.id)?.totalCost ?? a.totalCost))
              .map((child) => renderRow(child, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24" role="status" aria-label="A carregar custos">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const asOf = report?.period?.isCurrent ? report.period.asOf.split("-").reverse().join("/") : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={goBack} aria-label="Voltar aos projetos" className="shrink-0">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <p className="text-sm text-muted-foreground">
              Custos realizados{asOf ? ` até ${asOf}` : ""} vs. orçamento, com as regras da Faturação (sem IVA).
            </p>
            <p className="text-xs text-muted-foreground">
              Orçamento anual{month ? " — com um mês escolhido conta 1/12" : ""}. Cada nó com os de baixo dá o mesmo que a Faturação filtrada nele.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              {years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={month ? String(month) : "all"} onValueChange={(v) => setMonth(v === "all" ? undefined : Number(v))}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              {months.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={exportCSV} className="gap-1.5" disabled={!report}>
            <Download className="h-3.5 w-3.5" />
            CSV
          </Button>
        </div>
      </div>

      {/* Erro ≠ zero: antes uma falha (BD da Multipark em baixo, sem permissão) mostrava 0 € e "Sem projetos" */}
      {/* também quando o que está à vista é o período anterior (placeholder) */}
      {error && (!report || isPlaceholderData) ? (
        <Card className="border-red-200 bg-red-50/50" role="alert">
          <CardContent className="pt-6 flex items-start gap-2 text-sm text-red-800">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="font-medium">Não foi possível calcular os custos.</p>
              <p className="text-xs mt-0.5 break-words">{String(error.message ?? "").slice(0, 200)}</p>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()} disabled={isFetching}>
                {isFetching ? "A tentar…" : "Tentar de novo"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
      <>
      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6 gap-3 [&>*]:min-w-0">
        {([
          { label: month ? "Orçamento do mês" : "Orçamento do ano", value: totals.totalBudget, icon: Wallet, box: "bg-blue-100", ic: "text-blue-600", hint: "" },
          { label: "Despesas (sem IVA)", value: totals.expenses, icon: Receipt, box: "bg-amber-100", ic: "text-amber-600", hint: "" },
          { label: "Pessoal", value: totals.personnel, icon: Users, box: "bg-purple-100", ic: "text-purple-600", hint: "salários, TSU e extras" },
          { label: "Comissões", value: totals.commissions, icon: Handshake, box: "bg-teal-100", ic: "text-teal-600", hint: "parceiros" },
          { label: "Custo total", value: totals.totalCost, icon: Euro, box: "bg-indigo-100", ic: "text-indigo-600", hint: totals.totalBudget > 0 ? `${totals.totalRemaining < 0 ? "excede em" : "restam"} ${fmt(Math.abs(totals.totalRemaining))}` : "" },
        ] as const).map((k) => (
          <Card key={k.label} className="relative overflow-hidden">
            <CardContent className="pt-5 pb-4">
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-1 min-w-0 flex-1">
                  <p className="text-xs text-muted-foreground font-medium">{k.label}</p>
                  <FitAmount value={k.value} className="text-base sm:text-lg font-bold" />
                  {k.hint && <p className={`text-[11px] ${k.label === "Custo total" && totals.totalRemaining < 0 ? "text-red-700 dark:text-red-400" : "text-muted-foreground"}`}>{k.hint}</p>}
                </div>
                <div className={`h-8 w-8 shrink-0 rounded-lg flex items-center justify-center ${k.box}`}>
                  <k.icon className={`h-4 w-4 ${k.ic}`} />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
        <Card className="relative overflow-hidden">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1 min-w-0 flex-1">
                <p className="text-xs text-muted-foreground font-medium">Alertas</p>
                <p className="text-lg font-bold">
                  <span className="text-red-700 dark:text-red-400">{totals.overBudget}</span>
                  <span className="text-muted-foreground text-sm mx-1">/</span>
                  <span className="text-amber-700 dark:text-amber-400">{totals.atRisk}</span>
                </p>
                <p className="text-[11px] text-muted-foreground">excedidos / em risco</p>
              </div>
              <div className="h-8 w-8 shrink-0 rounded-lg flex items-center justify-center bg-red-100">
                <AlertTriangle className="h-4 w-4 text-red-600" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold">Top 10 nós por custo (só o próprio nó)</CardTitle>
          </CardHeader>
          <CardContent>
            {topProjectsChart.length === 0 ? (
              <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">Sem custos neste período</div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={topProjectsChart} margin={{ top: 4, right: 4, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="name" tick={AXIS_TICK} angle={-25} textAnchor="end" height={70} interval="preserveStartEnd" />
                  <YAxis tick={AXIS_TICK} tickFormatter={eurAxis} width={68} />
                  <Tooltip
                    formatter={(v: any, name: string) => [fmt(parseFloat(v)), SERIES[name] ?? name]}
                    contentStyle={CHART_TOOLTIP_STYLE}
                    itemStyle={CHART_TOOLTIP_ITEM}
                    cursor={{ fill: "var(--muted)" }}
                  />
                  <Legend formatter={(value: string) => <span className="text-foreground">{SERIES[value] ?? value}</span>} wrapperStyle={{ fontSize: "12px" }} />
                  <Bar dataKey="despesas" stackId="cost" fill="var(--chart-4)" />
                  <Bar dataKey="pessoal" stackId="cost" fill="var(--chart-3)" />
                  <Bar dataKey="comissoes" stackId="cost" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="orcamento" fill="var(--muted-foreground)" fillOpacity={0.35} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold">Custos por grupo</CardTitle>
          </CardHeader>
          <CardContent>
            {costByRoot.length === 0 ? (
              <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">Sem custos neste período</div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie data={costByRoot} cx="50%" cy="50%" innerRadius={55} outerRadius={90} paddingAngle={3} dataKey="value">
                    {costByRoot.map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: any) => [fmt(parseFloat(String(v)))]} contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_TOOLTIP_ITEM} />
                  <Legend iconSize={10} wrapperStyle={{ fontSize: "12px" }} formatter={(v) => <span className="text-foreground">{v}</span>} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Tabela em árvore */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <FolderTree className="h-4 w-4 text-primary" />
              Detalhe por nó
            </CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              <Select value={levelFilter} onValueChange={setLevelFilter}>
                <SelectTrigger className="w-32 h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Hierarquia</SelectItem>
                  <SelectItem value="project">Só projetos</SelectItem>
                  <SelectItem value="city">Só cidades</SelectItem>
                  <SelectItem value="brand">Só marcas</SelectItem>
                </SelectContent>
              </Select>
              {levelFilter === "all" && (
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setExpandedIds(new Set(data.map((d) => d.id)))} className="text-xs h-8 px-2">Expandir</Button>
                  <Button variant="ghost" size="sm" onClick={() => setExpandedIds(new Set())} className="text-xs h-8 px-2">Colapsar</Button>
                </div>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {/* No telemóvel faz scroll horizontal dentro do cartão */}
          <div className="overflow-x-auto">
          <div className="min-w-[1120px]">
          <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40 text-xs font-medium text-muted-foreground">
            <div className="w-5 shrink-0" />
            <div className="flex-1 min-w-[13rem]">Nó</div>
            <div className="hidden md:block w-28 shrink-0">Gestor</div>
            <div className="w-28 text-right shrink-0">Orçamento</div>
            <div className="w-28 text-right shrink-0">Despesas</div>
            <div className="w-28 text-right shrink-0">Pessoal</div>
            <div className="w-24 text-right shrink-0">Comissões</div>
            <div className="w-28 text-right shrink-0">Custo total</div>
            <div className="w-36 shrink-0 text-center">Utilização</div>
            <div className="w-28 shrink-0 text-right">Estado</div>
          </div>

          <div className="max-h-[500px] overflow-y-auto">
            {rootItems.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground text-sm">Sem nós de projeto</div>
            ) : (
              rootItems.map((item) => renderRow(item, 0))
            )}
            {/* Custos sem centro de custos: entram no total (como na Faturação) */}
            {levelFilter === "all" && unallocated && unallocated.totalCost > 0 && (
              <div className="flex items-center gap-2 px-3 py-2.5 border-b bg-amber-50/40 dark:bg-amber-950/10" title="Despesas, pessoas e extras sem centro de custos">
                <div className="w-5 shrink-0" />
                <div className="flex items-center gap-2 min-w-[13rem] flex-1">
                  <span className="text-sm font-semibold">Por atribuir</span>
                  <span className="text-[11px] text-muted-foreground truncate">sem centro de custos</span>
                </div>
                <div className="hidden md:block w-28 shrink-0" />
                <div className="w-28 text-right text-xs text-muted-foreground shrink-0">—</div>
                <div className="w-28 text-right text-sm tabular-nums whitespace-nowrap shrink-0">{money(unallocated.expenses)}</div>
                <div className="w-28 text-right text-sm tabular-nums whitespace-nowrap shrink-0">{money(unallocated.personnel)}</div>
                <div className="w-24 text-right text-sm tabular-nums whitespace-nowrap shrink-0">{money(unallocated.commissions)}</div>
                <div className="w-28 text-right text-sm font-semibold tabular-nums whitespace-nowrap shrink-0">{money(unallocated.totalCost)}</div>
                <div className="w-36 shrink-0" />
                <div className="w-28 shrink-0" />
              </div>
            )}
          </div>
          </div>
          </div>
        </CardContent>
      </Card>

      {/* Mesma regra da tabela (com descendentes) */}
      {attention.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold flex items-center gap-2 text-amber-800">
              <AlertTriangle className="h-4 w-4" />
              Nós que requerem atenção
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {attention.map(({ d, v }) => (
                <div key={d.id} className="flex items-center gap-3 p-3 rounded-lg bg-card border">
                  <div className="h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: d.color || "#6366f1" }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{d.name}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">{fmt(v.totalCost)} / {fmt(v.budget)}</p>
                  </div>
                  <div className="shrink-0">{budgetBadge(v.percent, v.budget)}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
      </>
      )}
    </div>
  );
}

const SERIES: Record<string, string> = { despesas: "Despesas", pessoal: "Pessoal", comissoes: "Comissões", orcamento: "Orçamento" };
