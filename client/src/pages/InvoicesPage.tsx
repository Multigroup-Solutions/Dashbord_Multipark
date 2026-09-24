import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useState, useMemo } from "react";
import {
  Euro, TrendingUp, TrendingDown, Receipt, Truck, CalendarClock,
  Building2, FolderTree, Users as UsersIcon, Handshake, LogIn, AlertTriangle, Wallet, Target,
} from "lucide-react";
import FinanceExportButtons from "@/components/FinanceExportButtons";
import DateRangeNav, { type DateGran, rangeFor } from "@/components/DateRangeNav";
import { useTableSort, Th } from "@/components/SortableTable";
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend,
} from "recharts";

const fmt = (v: number | string) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(Number.isFinite(n) ? n : 0);
};

const compact = (v: number) => {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(0)}k`;
  return v.toFixed(0);
};

type Granularity = "day" | "week" | "month" | "year";

export default function InvoicesPage() {
  const filters = useGlobalFilters();
  const initialMonth = rangeFor("month", new Date());

  const [from, setFrom] = useState(initialMonth.start);
  const [to, setTo] = useState(initialMonth.end);
  const [navGran, setNavGran] = useState<DateGran>("month");
  const [granularity, setGranularity] = useState<Granularity>("day");

  const projectId = useMemo(() => {
    if (filters.brandId !== null) return filters.brandId;
    if (filters.cityId !== null) return filters.cityId;
    return undefined;
  }, [filters.cityId, filters.brandId]);

  const { data, isLoading } = trpc.invoices.billing.useQuery({ from, to, projectId, granularity });
  const [tab, setTab] = useState("real");
  const { data: cash, isLoading: cashLoading } = trpc.invoices.cash.useQuery({ from, to, projectId }, { enabled: tab === "cash" });

  const summary = data?.summary as any;
  const timeseries = data?.timeseries ?? [];
  const deliveries = data?.deliveries ?? [];
  const collectedRows: Array<{ projectName: string | null; count: number; totalRevenue: number }> = (data as any)?.collected ?? [];
  const expensesPaid = data?.expensesPaid ?? [];
  const expensesPending = data?.expensesPending ?? [];
  const forecast = data?.forecast ?? [];
  const extrasDia = (data as any)?.extrasDia ?? [];
  const expensesExcluded = data?.expensesExcluded ?? [];
  const salesCommissions = data?.salesCommissions ?? [];
  const operationalPartners = data?.operationalPartners ?? [];
  const quality = summary?.quality;
  const projection = summary?.projection;
  const current = !!summary?.isCurrentPeriod;
  const salaries: { byProject: Array<{ projectName: string | null; cost: number }>; total: number } = (data as any)?.salaries ?? { byProject: [], total: 0 };

  // Ordenação por coluna nas tabelas principais
  const delSort = useTableSort(deliveries as any[]);
  const colSort = useTableSort(collectedRows as any[]);
  const comSort = useTableSort(salesCommissions as any[]);

  // Gráfico na MESMA base dos cartões (s/ IVA, com TSU): a pilha de custos
  // + a margem somam exatamente os Entregues s/ IVA de cada ponto.
  const chartData = useMemo(() => timeseries.map((p: any) => ({
    bucket: p.bucket,
    produced: Number(p.producedNet ?? 0),
    collected: Number(p.collected ?? 0),
    expenses: Number(p.expensesNet ?? 0),
    salaries: Number(p.salaries ?? 0),
    partners: Number(p.partners ?? 0),
    extrasCost: Number(p.extrasCost ?? 0),
    revenueForecast: Number(p.revenueForecastNet ?? 0),
    margin: Number(p.margin ?? 0),
    marginForecast: Number(p.marginForecast ?? 0),
  })), [timeseries]);

  // Despesas pagas por projeto (agrupado)
  const expPaidByProject = useMemo(() => {
    const map = new Map<string, { projectName: string; total: number; categories: { name: string; total: number }[] }>();
    for (const e of expensesPaid) {
      const key = e.projectName ?? "Sem projeto";
      if (!map.has(key)) map.set(key, { projectName: key, total: 0, categories: [] });
      const entry = map.get(key)!;
      entry.total += Number(e.totalAmount);
      entry.categories.push({ name: e.categoryName ?? "Sem categoria", total: Number(e.totalAmount) });
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [expensesPaid]);

  const expPendByProject = useMemo(() => {
    const map = new Map<string, { projectName: string; total: number; items: { supplier: string; category: string; total: number }[] }>();
    for (const e of expensesPending) {
      const key = e.projectName ?? "Sem projeto";
      if (!map.has(key)) map.set(key, { projectName: key, total: 0, items: [] });
      const entry = map.get(key)!;
      entry.total += Number(e.totalAmount);
      entry.items.push({ supplier: e.supplier ?? "—", category: e.categoryName ?? "Sem categoria", total: Number(e.totalAmount) });
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [expensesPending]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <p className="text-muted-foreground text-sm">
            Recolhidos (carro entrou) vs entregues (carro saiu — valor realizado) e todos os custos do período, em dias de Lisboa.
            Uma reserva que atravessa meses conta inteira no mês da saída.
          </p>
        </div>
        <div className="flex items-end gap-2 flex-wrap">
          <FinanceExportButtons input={{ kind: "billing", from, to, projectId, granularity }} />
          <Link href="/anual">
            <a className="text-xs px-2.5 py-1.5 rounded border bg-primary text-primary-foreground hover:opacity-90 transition-opacity inline-flex items-center gap-1">
              <CalendarClock className="w-3.5 h-3.5" /> Anual
            </a>
          </Link>
          <DateRangeNav
            start={from}
            end={to}
            gran={navGran}
            showAll={false}
            onChange={(s, e, g) => {
              setFrom(s); setTo(e); setNavGran(g);
              // Granularidade do gráfico acompanha o período escolhido
              if (g === "year") setGranularity("month");
              else if (g === "month" || g === "week") setGranularity("day");
              else if (g === "day") setGranularity("day");
            }}
          />
          <div>
            <Label className="text-xs mb-1 block">Gráfico por</Label>
            <Select value={granularity} onValueChange={(v) => setGranularity(v as Granularity)}>
              <SelectTrigger className="w-[110px] h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="day">Dia</SelectItem>
                <SelectItem value="week">Semana</SelectItem>
                <SelectItem value="month">Mês</SelectItem>
                <SelectItem value="year">Ano</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {isLoading || !summary ? (
        <div className="flex justify-center py-20">
          <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
        </div>
      ) : (
        <>
          {/* KPI Cards principais — no período em curso: "Realizado até hoje" */}
          {current && (
            <p className="text-xs text-muted-foreground -mb-1">
              <strong>Realizado até hoje ({summary.asOf})</strong>: receita entregue e custos até hoje — salários, provisões,
              TSU, equipa do dia e despesas cortados em hoje.
            </p>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard
              icon={<LogIn className="w-4 h-4 text-sky-600" />}
              label="Recolhidos"
              value={fmt(summary.collected ?? 0)}
              hint={`${summary.collectedCount ?? 0} carros entrados no período`}
              color="text-sky-700"
            />
            <KpiCard
              icon={<Truck className="w-4 h-4 text-emerald-600" />}
              label="Entregues"
              value={fmt(summary.produced)}
              hint={`${summary.producedCount ?? 0} carros saídos · s/ IVA: ${fmt(summary.producedNoVat)}`}
              color="text-emerald-700"
            />
            <KpiCard
              icon={<Receipt className="w-4 h-4 text-red-600" />}
              label={current ? "Custos até hoje (s/ IVA)" : "Custos (s/ IVA)"}
              value={fmt(summary.totalCostsNoVat)}
              hint={`Despesas s/IVA + pessoal + TSU + equipa-dia + comissões · c/ IVA: ${fmt(summary.totalCostsGross)} · por pagar (não soma): ${fmt(summary.expensesPending ?? 0)}`}
              color="text-red-700"
            />
            <KpiCard
              icon={summary.marginNet >= 0 ? <TrendingUp className="w-4 h-4 text-emerald-600" /> : <TrendingDown className="w-4 h-4 text-red-600" />}
              label={current ? "Margem realizada até hoje" : "Margem (s/ IVA)"}
              value={fmt(summary.marginNet)}
              hint={`Entregues s/ IVA − custos · ${summary.marginPct != null ? summary.marginPct.toFixed(1) : "0"}%`}
              color={summary.marginNet >= 0 ? "text-emerald-700" : "text-red-700"}
            />
          </div>

          {/* Fecho previsto (período em curso / futuro) */}
          {projection?.applies && (
            <Card className="p-4 border-sky-200 bg-sky-50/40">
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <Target className="w-4 h-4 text-sky-700" />
                <span className="text-sm font-medium">Fecho previsto ({to})</span>
                <span className="text-[11px] text-muted-foreground">realizado + receita esperada (carros estacionados e check-ins com saída até {to}) − custos do período inteiro</span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div><p className="text-xs text-muted-foreground">Receita s/ IVA</p><p className="font-semibold tabular-nums">{fmt(projection.revenueNet)}</p><p className="text-[11px] text-muted-foreground">+ {fmt(projection.forecastRevenueNet)} esperados</p></div>
                <div><p className="text-xs text-muted-foreground">Custos s/ IVA (período inteiro)</p><p className="font-semibold tabular-nums">{fmt(projection.costsNet)}</p><p className="text-[11px] text-muted-foreground">+ {fmt(projection.futureCostsNet)} até ao fim</p></div>
                <div><p className="text-xs text-muted-foreground">Margem prevista</p><p className={`font-bold tabular-nums ${projection.margin >= 0 ? "text-emerald-700" : "text-red-700"}`}>{fmt(projection.margin)}</p></div>
                <div><p className="text-xs text-muted-foreground">Margem prevista %</p><p className="font-semibold tabular-nums">{projection.marginPct != null ? `${projection.marginPct.toFixed(1)}%` : "—"}</p></div>
              </div>
            </Card>
          )}

          <QualityWarnings quality={quality} />

          {/* KPI secundários: detalhe dos custos */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiSmall icon={<Truck className="w-3.5 h-3.5 text-teal-600" />} label="Serviços extra (nas entregas)" value={fmt(deliveries.reduce((s2: number, d: any) => s2 + Number(d.extrasRevenue ?? 0), 0))} />
            <KpiSmall icon={<Receipt className="w-3.5 h-3.5 text-red-500" />} label="Despesas inseridas" value={fmt(summary.expensesPaid)} />
            <KpiSmall icon={<UsersIcon className="w-3.5 h-3.5 text-amber-500" />} label="Equipa do dia" value={fmt(summary.extrasDiaCost)} />
            <KpiSmall icon={<UsersIcon className="w-3.5 h-3.5 text-blue-500" />} label="Salários + TSU" value={fmt((summary.salariesCost ?? 0) + (summary.employerTax ?? 0))} />
            <KpiSmall icon={<Handshake className="w-3.5 h-3.5 text-rose-500" />} label="Comissão venda" value={fmt(summary.salesCommissions ?? 0)} />
            <KpiSmall icon={<Handshake className="w-3.5 h-3.5 text-cyan-500" />} label="Parceiros op." value={fmt(summary.operationalCommissions ?? 0)} />
          </div>

          {/* Gráfico timeseries */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <CalendarClock className="w-4 h-4" />
                Evolução por {granularity === "day" ? "dia" : granularity === "week" ? "semana" : granularity === "month" ? "mês" : "ano"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {chartData.length === 0 ? (
                <p className="text-muted-foreground text-sm text-center py-10">Sem dados no período</p>
              ) : (
                <ResponsiveContainer width="100%" height={320}>
                  <ComposedChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={compact} />
                    <Tooltip
                      formatter={(v: any, name: string) => [fmt(Number(v)), name]}
                      contentStyle={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 12 }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="produced" name="Entregues (s/ IVA)" fill="#10b981" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="expenses" name="Despesas (s/ IVA)" stackId="cost" fill="#f59e0b" />
                    <Bar dataKey="salaries" name="Salários + TSU" stackId="cost" fill="#3b82f6" />
                    <Bar dataKey="partners" name="Parceiros" stackId="cost" fill="#f43f5e" />
                    <Bar dataKey="extrasCost" name="Equipa-dia" stackId="cost" fill="#eab308" radius={[3, 3, 0, 0]} />
                    <Line dataKey="collected" name="Recolhidos" stroke="#0284c7" strokeWidth={2} dot={false} />
                    <Line dataKey="revenueForecast" name="Receita esperada (s/ IVA)" stroke="#0ea5e9" strokeDasharray="4 4" strokeWidth={2} dot={false} />
                    <Line dataKey="margin" name="Margem realizada" stroke="#111827" strokeWidth={2} dot={false} />
                    {projection?.applies && <Line dataKey="marginForecast" name="Fecho previsto" stroke="#6b7280" strokeDasharray="4 4" strokeWidth={2} dot={false} />}
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Tabs com detalhes */}
          <Tabs value={tab} onValueChange={setTab} className="space-y-4">
            <TabsList>
              <TabsTrigger value="real">Realizado</TabsTrigger>
              <TabsTrigger value="costs">Custos detalhados</TabsTrigger>
              <TabsTrigger value="forecast">Previsão</TabsTrigger>
              <TabsTrigger value="cash">Caixa</TabsTrigger>
            </TabsList>

            <TabsContent value="real" className="space-y-4">
              {/* Entregues por projeto */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Truck className="w-4 h-4" /> Entregues por projeto (receita realizada)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {deliveries.length === 0 ? (
                    <p className="text-muted-foreground text-sm text-center py-6">Sem produção no período</p>
                  ) : (
                    <div className="overflow-x-auto"><table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left">
                          <Th k="projectName" label="Projeto" sortKey={delSort.sortKey} sortDir={delSort.sortDir} onToggle={delSort.toggle} />
                          <Th k="count" label="Entregas" align="right" sortKey={delSort.sortKey} sortDir={delSort.sortDir} onToggle={delSort.toggle} />
                          <Th k="extrasRevenue" label="Serviços extras" align="right" sortKey={delSort.sortKey} sortDir={delSort.sortDir} onToggle={delSort.toggle} />
                          <Th k="totalRevenue" label="Total" align="right" className="font-bold" sortKey={delSort.sortKey} sortDir={delSort.sortDir} onToggle={delSort.toggle} />
                        </tr>
                      </thead>
                      <tbody>
                        {(delSort.sorted as any[]).map((d, i) => (
                          <tr key={i} className="border-b hover:bg-muted/50">
                            <td className="p-2 flex items-center gap-2"><FolderTree className="w-3 h-3 text-muted-foreground" />{d.projectName ?? "Sem projeto"}</td>
                            <td className="p-2 text-right tabular-nums">{d.count}</td>
                            <td className="p-2 text-right tabular-nums">{fmt(Number(d.extrasRevenue))}</td>
                            <td className="p-2 text-right tabular-nums font-bold">{fmt(Number(d.totalRevenue))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table></div>
                  )}
                </CardContent>
              </Card>

              {/* Recolhidos por projeto */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <LogIn className="w-4 h-4" /> Recolhidos por projeto (carros entrados)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {collectedRows.length === 0 ? (
                    <p className="text-muted-foreground text-sm text-center py-6">Sem recolhas no período</p>
                  ) : (
                    <div className="overflow-x-auto"><table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left">
                          <Th k="projectName" label="Projeto" sortKey={colSort.sortKey} sortDir={colSort.sortDir} onToggle={colSort.toggle} />
                          <Th k="count" label="Recolhas" align="right" sortKey={colSort.sortKey} sortDir={colSort.sortDir} onToggle={colSort.toggle} />
                          <Th k="totalRevenue" label="Valor das reservas" align="right" className="font-bold" sortKey={colSort.sortKey} sortDir={colSort.sortDir} onToggle={colSort.toggle} />
                        </tr>
                      </thead>
                      <tbody>
                        {(colSort.sorted as any[]).map((c, i) => (
                          <tr key={i} className="border-b hover:bg-muted/50">
                            <td className="p-2">{c.projectName ?? "Sem projeto"}</td>
                            <td className="p-2 text-right tabular-nums">{c.count}</td>
                            <td className="p-2 text-right tabular-nums font-bold text-sky-700">{fmt(Number(c.totalRevenue))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table></div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="costs" className="space-y-4">
              {/* Despesas pagas */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Receipt className="w-4 h-4" /> Despesas inseridas por projeto
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {expPaidByProject.length === 0 ? (
                    <p className="text-muted-foreground text-sm text-center py-6">Sem despesas inseridas no período</p>
                  ) : (
                    <div className="space-y-3">
                      {expPaidByProject.map((p) => (
                        <div key={p.projectName} className="border rounded-lg p-3">
                          <div className="flex items-center justify-between mb-2">
                            <span className="font-medium flex items-center gap-2"><Building2 className="w-4 h-4 text-muted-foreground" />{p.projectName}</span>
                            <span className="font-bold text-red-700">{fmt(p.total)}</span>
                          </div>
                          <div className="space-y-1">
                            {p.categories.map((c, i) => (
                              <div key={i} className="flex justify-between text-sm text-muted-foreground">
                                <span>{c.name}</span>
                                <span className="tabular-nums">{fmt(c.total)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Despesas excluídas da margem (custo já contado pelo RH / ponto) */}
              {expensesExcluded.length > 0 && (
                <Card className="border-amber-200">
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-600" /> Despesas excluídas da margem
                    </CardTitle>
                    <p className="text-xs text-muted-foreground">
                      Categorias marcadas "excluir da margem" (Despesas → Categorias, IVA e margem): o custo já entra pelos salários + TSU
                      ou pelo ponto dos extras. NÃO somam aos custos acima.
                    </p>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-1">
                      {expensesExcluded.map((e, i) => (
                        <div key={i} className="flex justify-between text-sm text-muted-foreground">
                          <span>{e.projectName ?? "Por atribuir"} · {e.categoryName ?? "Sem categoria"}</span>
                          <span className="tabular-nums">{fmt(e.totalAmount)}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Extras-dia */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <UsersIcon className="w-4 h-4" /> Equipa do dia (extras-dia)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {extrasDia.length === 0 ? (
                    <p className="text-muted-foreground text-sm text-center py-6">Sem escalas extras-dia no período</p>
                  ) : (
                    <div className="overflow-x-auto"><table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left">
                          <th className="p-2">Nível</th>
                          <th className="p-2 text-right">Pessoas</th>
                          <th className="p-2 text-right">Horas</th>
                          <th className="p-2 text-right font-bold">Custo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {extrasDia.map((e: any, i: number) => (
                          <tr key={i} className="border-b hover:bg-muted/50">
                            <td className="p-2 capitalize">{e.level}</td>
                            <td className="p-2 text-right tabular-nums">{e.headcount}</td>
                            <td className="p-2 text-right tabular-nums">{Number(e.hours).toFixed(1)}h</td>
                            <td className="p-2 text-right tabular-nums font-bold text-amber-700">{fmt(e.cost)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table></div>
                  )}
                </CardContent>
              </Card>

              {/* (Marketing saiu da Faturação: as faturas do Google entram pelas
                  Despesas normais — o detalhe vê-se no módulo Marketing.) */}

              {/* Salários por projeto (rateados ao dia) */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <UsersIcon className="w-4 h-4" /> Salários por centro de custos
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">
                    Salário vigente em cada mês (histórico de RH): mês completo = salário mensal; parcial = proporcional aos dias
                    do próprio mês, respeitando início e fim de contrato. Inclui provisões de subsídios ({fmt(summary.salariesProvisions ?? 0)})
                    e variável do ponto — horas extra, noturnas, fim de semana e alimentação ({fmt(summary.salariesVariable ?? 0)}).
                    Quem está num nível superior (Grupo / Cidade / Marca) é rateado pelas marcas folhas; sem centro fica "Por atribuir".
                    TSU patronal ({(summary.tsuEmployerRate * 100).toFixed(2)}%) sobre base + provisões de 13.º/14.º + variável tributável: {fmt(summary.employerTax ?? 0)}.
                    {current && " No período em curso só conta até hoje."}
                  </p>
                </CardHeader>
                <CardContent>
                  {salaries.byProject.length === 0 ? (
                    <p className="text-muted-foreground text-sm text-center py-6">Sem salários no período</p>
                  ) : (
                    <div className="overflow-x-auto"><table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left">
                          <th className="p-2">Centro de custos</th>
                          <th className="p-2 text-right font-bold">Custo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {salaries.byProject.map((s: any, i: number) => (
                          <tr key={i} className="border-b hover:bg-muted/50">
                            <td className="p-2 flex items-center gap-2"><FolderTree className="w-3 h-3 text-muted-foreground" />{s.projectName ?? "Sem projeto"}</td>
                            <td className="p-2 text-right tabular-nums font-bold text-blue-700">{fmt(s.cost)}</td>
                          </tr>
                        ))}
                        <tr className="bg-muted/30 font-bold">
                          <td className="p-2">Total</td>
                          <td className="p-2 text-right">{fmt(salaries.total)}</td>
                        </tr>
                      </tbody>
                    </table></div>
                  )}
                </CardContent>
              </Card>

              {/* Comissões parceiros de venda (calculadas via campaign matching) */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Handshake className="w-4 h-4" /> Comissões a parceiros de venda
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">
                    Agências/parceiros com campanha — comissão = receita da reserva <strong>sem IVA</strong> × <em>%</em> (com IVA só nos parceiros marcados como exceção), atribuída à marca da reserva.
                    Um parceiro operacional não cobra comissão de venda nas reservas dos centros que já opera.
                  </p>
                </CardHeader>
                <CardContent>
                  {salesCommissions.length === 0 ? (
                    <p className="text-muted-foreground text-sm text-center py-6">Sem comissões de venda no período</p>
                  ) : (
                    <div className="overflow-x-auto"><table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left">
                          <Th k="partnerName" label="Parceiro" sortKey={comSort.sortKey} sortDir={comSort.sortDir} onToggle={comSort.toggle} />
                          <Th k="projectName" label="Marca / Projeto" sortKey={comSort.sortKey} sortDir={comSort.sortDir} onToggle={comSort.toggle} />
                          <Th k="bookingsCount" label="Reservas" align="right" sortKey={comSort.sortKey} sortDir={comSort.sortDir} onToggle={comSort.toggle} />
                          <Th k="revenueGross" label="Receita c/ IVA" align="right" sortKey={comSort.sortKey} sortDir={comSort.sortDir} onToggle={comSort.toggle} />
                          <Th k="revenueNet" label="Base" align="right" sortKey={comSort.sortKey} sortDir={comSort.sortDir} onToggle={comSort.toggle} />
                          <Th k="commissionRate" label="%" align="right" sortKey={comSort.sortKey} sortDir={comSort.sortDir} onToggle={comSort.toggle} />
                          <Th k="commission" label="Comissão" align="right" className="font-bold" sortKey={comSort.sortKey} sortDir={comSort.sortDir} onToggle={comSort.toggle} />
                        </tr>
                      </thead>
                      <tbody>
                        {(comSort.sorted as any[]).map((c, i) => (
                          <tr key={i} className="border-b hover:bg-muted/50">
                            <td className="p-2">{c.partnerName ?? "—"}</td>
                            <td className="p-2 flex items-center gap-2"><FolderTree className="w-3 h-3 text-muted-foreground" />{c.projectName ?? "Sem projeto"}</td>
                            <td className="p-2 text-right tabular-nums">{c.bookingsCount}</td>
                            <td className="p-2 text-right tabular-nums">{fmt(c.revenueGross)}</td>
                            <td className="p-2 text-right tabular-nums">{fmt(c.commissionBase === "gross" ? c.revenueGross : c.revenueNet)} <span className="text-[10px] text-muted-foreground">{c.commissionBase === "gross" ? "c/ IVA" : "s/ IVA"}</span></td>
                            <td className="p-2 text-right tabular-nums">{c.commissionRate ?? "—"}%</td>
                            <td className="p-2 text-right tabular-nums font-bold text-rose-700">{fmt(c.commission)}</td>
                          </tr>
                        ))}
                        <tr className="bg-muted/30 font-bold">
                          <td className="p-2" colSpan={6}>Total</td>
                          <td className="p-2 text-right">{fmt(salesCommissions.reduce((s, c) => s + c.commission, 0))}</td>
                        </tr>
                      </tbody>
                    </table></div>
                  )}
                </CardContent>
              </Card>

              {/* Parceiros operacionais (faturas) */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Handshake className="w-4 h-4" /> Parceiros operacionais
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">
                    Ex.: Top Parking a operar marcas do Porto. Comissão = receita <strong>sem IVA</strong> das
                    reservas dos projetos que o parceiro opera (configurados na ficha) × <em>%</em>.
                  </p>
                </CardHeader>
                <CardContent>
                  {operationalPartners.length === 0 ? (
                    <p className="text-muted-foreground text-sm text-center py-6">Sem parceiros operacionais com projetos configurados no período</p>
                  ) : (
                    <div className="overflow-x-auto"><table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left">
                          <th className="p-2">Parceiro</th>
                          <th className="p-2">Projetos operados</th>
                          <th className="p-2 text-right">Reservas</th>
                          <th className="p-2 text-right">Receita c/ IVA</th>
                          <th className="p-2 text-right">Base</th>
                          <th className="p-2 text-right">%</th>
                          <th className="p-2 text-right font-bold">Comissão</th>
                        </tr>
                      </thead>
                      <tbody>
                        {operationalPartners.map((p, i) => (
                          <tr key={i} className="border-b hover:bg-muted/50">
                            <td className="p-2">{p.partnerName ?? "—"}</td>
                            <td className="p-2 text-xs text-muted-foreground">{p.projectNames?.length ? p.projectNames.join(", ") : <span className="text-muted-foreground">(sem projetos)</span>}</td>
                            <td className="p-2 text-right tabular-nums">{p.bookingsCount}</td>
                            <td className="p-2 text-right tabular-nums">{fmt(p.revenueGross)}</td>
                            <td className="p-2 text-right tabular-nums">{fmt(p.commissionBase === "gross" ? p.revenueGross : p.revenueNet)} <span className="text-[10px] text-muted-foreground">{p.commissionBase === "gross" ? "c/ IVA" : "s/ IVA"}</span></td>
                            <td className="p-2 text-right tabular-nums">{p.commissionRate}%</td>
                            <td className="p-2 text-right tabular-nums font-bold text-cyan-700">{fmt(p.commission)}</td>
                          </tr>
                        ))}
                        <tr className="bg-muted/30 font-bold">
                          <td className="p-2" colSpan={6}>Total</td>
                          <td className="p-2 text-right">{fmt(operationalPartners.reduce((s, p) => s + p.commission, 0))}</td>
                        </tr>
                      </tbody>
                    </table></div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="forecast" className="space-y-4">
              {/* KPIs Previsão — receita esperada = saída prevista até ao fim do período */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <KpiCard
                  icon={<CalendarClock className="w-4 h-4 text-sky-600" />}
                  label="Receita esperada"
                  value={fmt(summary.forecastRange?.revenue ?? 0)}
                  hint={projection?.applies
                    ? `${summary.forecastRange?.count ?? 0} reservas por entregar (${summary.forecastRange?.from} a ${to}) · s/ IVA: ${fmt(summary.forecastRange?.revenueNet ?? 0)}`
                    : "Período encerrado: sem previsão"}
                  color="text-sky-700"
                />
                <KpiCard
                  icon={<Receipt className="w-4 h-4 text-orange-600" />}
                  label="Despesas a pagar"
                  value={fmt(summary.expensesPending)}
                  hint={`${expensesPending.length} grupos · não soma aos custos (já contadas pela data da despesa)`}
                  color="text-orange-700"
                />
                <KpiCard
                  icon={<Euro className="w-4 h-4 text-emerald-600" />}
                  label={projection?.applies ? "Fecho previsto (margem)" : "Realizado (período encerrado)"}
                  value={fmt(projection?.applies ? projection.margin : summary.marginNet)}
                  hint={projection?.applies ? "Realizado + receita esperada − custos do período inteiro" : "Sem previsão somada: o período já terminou"}
                  color="text-emerald-700"
                />
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <CalendarClock className="w-4 h-4" /> Receita prevista por projeto
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">Reservas não entregues nem canceladas com saída prevista até {to}: carros estacionados (saídas em atraso contam hoje) + check-ins de hoje em diante</p>
                </CardHeader>
                <CardContent>
                  {forecast.length === 0 ? (
                    <p className="text-muted-foreground text-sm text-center py-6">Sem reservas pendentes no período</p>
                  ) : (
                    <div className="overflow-x-auto"><table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left">
                          <th className="p-2">Projeto</th>
                          <th className="p-2 text-right">Reservas</th>
                          <th className="p-2 text-right font-bold">Receita prevista</th>
                        </tr>
                      </thead>
                      <tbody>
                        {forecast.map((f, i) => (
                          <tr key={i} className="border-b hover:bg-muted/50">
                            <td className="p-2">{f.projectName ?? "Sem projeto"}</td>
                            <td className="p-2 text-right tabular-nums">{f.count}</td>
                            <td className="p-2 text-right tabular-nums font-bold">{fmt(Number(f.totalRevenue))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table></div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Receipt className="w-4 h-4" /> Despesas a pagar por projeto
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">Despesas pendentes com vencimento no período</p>
                </CardHeader>
                <CardContent>
                  {expPendByProject.length === 0 ? (
                    <p className="text-muted-foreground text-sm text-center py-6">Sem despesas pendentes no período</p>
                  ) : (
                    <div className="space-y-3">
                      {expPendByProject.map((p) => (
                        <div key={p.projectName} className="border rounded-lg p-3">
                          <div className="flex items-center justify-between mb-2">
                            <span className="font-medium flex items-center gap-2"><Building2 className="w-4 h-4 text-muted-foreground" />{p.projectName}</span>
                            <span className="font-bold text-orange-700">{fmt(p.total)}</span>
                          </div>
                          <div className="space-y-1">
                            {p.items.map((it, i) => (
                              <div key={i} className="flex justify-between text-sm text-muted-foreground">
                                <span>{it.supplier} · {it.category}</span>
                                <span className="tabular-nums">{fmt(it.total)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="cash" className="space-y-4">
              <CashPanel cash={cash} loading={cashLoading} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

function KpiCard({ icon, label, value, hint, color }: { icon: React.ReactNode; label: string; value: string; hint?: string; color?: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className={`text-2xl font-bold ${color ?? ""}`}>{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground mt-1">{hint}</p>}
    </Card>
  );
}

function KpiSmall({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="border rounded-lg px-3 py-2 bg-muted/30 flex items-center justify-between">
      <span className="flex items-center gap-2 text-xs text-muted-foreground">{icon}{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}

/** Avisos de qualidade dos dados (o que pode estar a distorcer os números). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function QualityWarnings({ quality }: { quality: any }) {
  if (!quality) return null;
  const items: Array<{ key: string; text: React.ReactNode }> = [];
  const ex = quality.excludedExpenses;
  if (ex?.total > 0) items.push({ key: "excl", text: <>Despesas excluídas da margem (já contadas pelo RH/ponto): <strong>{fmt(ex.total)}</strong> em {ex.count} despesa(s) — {ex.categories.map((c: any) => `${c.name} ${fmt(c.total)}`).join(", ")}</> });
  const bw = quality.bookingsWithoutProject;
  if (bw?.count > 0) items.push({ key: "bwp", text: <>Reservas entregues sem centro de custos: <strong>{bw.count}</strong> ({fmt(bw.total)}) — só contam no consolidado</> });
  const ew = quality.expensesWithoutProject;
  if (ew?.count > 0) items.push({ key: "ewp", text: <>Despesas sem centro de custos: <strong>{ew.count}</strong> ({fmt(ew.total)}) — "Por atribuir"</> });
  const inact = quality.inactiveWithoutContractEnd ?? [];
  if (inact.length > 0) items.push({ key: "inact", text: <>Inativos sem data de fim de contrato ({inact.length}) — contam até à desativação/última atualização: {inact.map((e: any) => `${e.fullName} (até ${e.assumedEnd ?? "?"})`).join(", ")}</> });
  const cov = quality.salesCommissionsCoveredByOperational;
  if (cov?.count > 0) items.push({ key: "cov", text: <>Comissão de venda não cobrada em {cov.count} reserva(s) ({fmt(cov.revenueGross)}): o parceiro é operacional e já opera esse centro</> });
  if ((quality.partnersRateMissing ?? []).length > 0) items.push({ key: "rate", text: <>Parceiros sem taxa de comissão: {quality.partnersRateMissing.join(", ")}</> });
  if ((quality.partnerConflicts ?? []).length > 0) items.push({ key: "conf", text: <>Campanhas ligadas a mais do que um parceiro: {quality.partnerConflicts.map((c: any) => c.key).join(", ")}</> });
  if (items.length === 0) return null;
  return (
    <Card className="p-3 border-amber-200 bg-amber-50/50">
      <div className="flex items-center gap-2 mb-1 text-sm font-medium text-amber-800"><AlertTriangle className="w-4 h-4" /> Qualidade dos dados</div>
      <ul className="text-xs text-amber-900 space-y-0.5 list-disc pl-5">
        {items.map((i) => <li key={i.key}>{i.text}</li>)}
      </ul>
    </Card>
  );
}

/** Caixa: o dinheiro (recebido / por cobrar / no-shows pré-pagos). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CashPanel({ cash, loading }: { cash: any; loading: boolean }) {
  if (loading || !cash) return <p className="text-sm text-muted-foreground text-center py-6">A carregar…</p>;
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard icon={<Wallet className="w-4 h-4 text-emerald-600" />} label="Recebido" value={fmt(cash.received.total)} hint={`${cash.received.count} reservas entregues · data: ${cash.dateBasis}`} color="text-emerald-700" />
        <KpiCard icon={<Receipt className="w-4 h-4 text-orange-600" />} label="Por cobrar" value={fmt(cash.toCollect.total)} hint={`${cash.toCollect.count} reservas entregues com valor em falta`} color="text-orange-700" />
        <KpiCard icon={<CalendarClock className="w-4 h-4 text-sky-600" />} label="No-shows pré-pagos" value={fmt(cash.prepaidNoShows.total)} hint={`${cash.prepaidNoShows.count} reservas pagas com check-in passado que nunca entraram`} color="text-sky-700" />
        <KpiCard icon={<AlertTriangle className="w-4 h-4 text-muted-foreground" />} label="Canceladas com pagamento" value={fmt(cash.cancelledPaid.total)} hint={`${cash.cancelledPaid.count} canceladas no período — informativo, NÃO é receita (sem dados de taxa/reembolso)`} />
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Recebido por método de pagamento</CardTitle></CardHeader>
        <CardContent>
          {cash.received.byMethod.length === 0 ? <p className="text-sm text-muted-foreground text-center py-4">Sem recebimentos no período</p> : (
            <div className="space-y-1">
              {cash.received.byMethod.map((m: any) => (
                <div key={m.method} className="flex justify-between text-sm"><span>{m.method} <span className="text-xs text-muted-foreground">({m.count})</span></span><span className="tabular-nums font-medium">{fmt(m.total)}</span></div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <p className="text-[11px] text-muted-foreground">
        Dados que faltam na sincronização Multipark: {cash.missing.join(" · ")}. As taxas de cancelamento só entram como receita quando existirem na base de dados.
      </p>
    </>
  );
}
