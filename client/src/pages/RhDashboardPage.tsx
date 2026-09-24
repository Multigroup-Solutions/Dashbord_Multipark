import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  Users, Clock, AlertTriangle, BarChart3, ShieldAlert, ChevronLeft,
} from "lucide-react";
import { useTableSort, Th } from "@/components/SortableTable";
import { toast } from "sonner";

const MONTH_NAMES = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

const fmt = (v: number) =>
  new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(Number.isFinite(v) ? v : 0);

export default function RhDashboardPage({ onBack }: { onBack?: () => void } = {}) {
  const { user } = useAuth();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [lookback, setLookback] = useState(3);
  const [search, setSearch] = useState("");

  const { data = [], isLoading } = trpc.rh.dashboard.useQuery({ year, month, monthsLookback: lookback });

  const utils = trpc.useUtils();
  const processNoShows = trpc.rh.penalties.processNoShows.useMutation({
    onSuccess: (r) => { utils.rh.penalties.pending.invalidate(); toast.success(`${r.created} possível(is) falta(s) registada(s) para validação (${r.alreadyPending} já existiam)`); },
    onError: (e) => toast.error(e.message),
  });
  const { data: pendingPenalties = [] } = trpc.rh.penalties.pending.useQuery();
  const reviewPenalty = trpc.rh.penalties.review.useMutation({
    onSuccess: (r) => { utils.rh.penalties.pending.invalidate(); utils.rh.dashboard.invalidate(); toast.success(`Registado · ${r.points} ponto(s) confirmados${r.blocked ? " · acesso bloqueado" : ""}`); },
    onError: (e) => toast.error(e.message),
  });

  const filtered = useMemo(() => {
    const s = search.toLowerCase().trim();
    if (!s) return data;
    return data.filter((r: any) => r.fullName.toLowerCase().includes(s) || (r.department ?? "").toLowerCase().includes(s));
  }, [data, search]);

  const employees = filtered.filter((r: any) => !r.isExtra);
  const extras = filtered.filter((r: any) => r.isExtra);

  const totals = (rows: any[]) => ({
    count: rows.length,
    hours: rows.reduce((s, r) => s + r.currentMonth.totalHours, 0),
    bruto: rows.reduce((s, r) => s + r.currentMonth.totalPayment, 0),
    liquido: rows.reduce((s, r) => s + r.currentMonth.netEstimate, 0),
    redFlags: rows.filter(r => r.severity === "red").length,
    blocked: rows.filter(r => r.loginBlocked).length,            // estado REAL de acesso, não pontos
    yellowFlags: rows.filter(r => r.severity === "yellow").length,
  });

  const tEmps = totals(employees);
  const tExtras = totals(extras);

  if (user?.role !== "super_admin") {
    return (
      <Card className="max-w-md mx-auto mt-12">
        <CardContent className="p-8 text-center">
          <ShieldAlert className="w-12 h-12 mx-auto text-muted-foreground" />
          <p className="text-sm mt-3">Apenas super_admin tem acesso a este dashboard.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto w-full">
      <Card className="p-3">
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex-1 min-w-[200px] flex items-center gap-3">
            {onBack && (
              <Button variant="ghost" size="sm" onClick={onBack}>
                <ChevronLeft className="w-4 h-4 mr-1" /> Voltar
              </Button>
            )}
            <div>
              <h1 className="text-xl font-semibold flex items-center gap-2">
                <BarChart3 className="w-5 h-5" /> Dashboard RH
              </h1>
              <p className="text-sm text-muted-foreground">Custo de pessoal, horas e penalizações por colaborador</p>
            </div>
          </div>
          <div>
            <Label className="text-xs mb-1 block">Mês</Label>
            <Select value={String(month)} onValueChange={v => setMonth(parseInt(v))}>
              <SelectTrigger className="w-32 h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTH_NAMES.map((m, i) => <SelectItem key={i} value={String(i + 1)}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs mb-1 block">Ano</Label>
            <Input type="number" value={year} onChange={e => setYear(parseInt(e.target.value) || now.getFullYear())} className="w-24 h-9" />
          </div>
          <div>
            <Label className="text-xs mb-1 block">Histórico</Label>
            <Select value={String(lookback)} onValueChange={v => setLookback(parseInt(v))}>
              <SelectTrigger className="w-32 h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[1, 3, 6, 12].map(n => <SelectItem key={n} value={String(n)}>{n} meses</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1 min-w-[180px]">
            <Label className="text-xs mb-1 block">Pesquisar</Label>
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Nome ou departamento" className="h-9" />
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={processNoShows.isPending}
            onClick={() => {
              const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
              processNoShows.mutate({ date: yesterday });
            }}
          >
            {processNoShows.isPending ? "A processar..." : "Processar faltas (ontem)"}
          </Button>
        </div>
      </Card>

      {/* Possíveis faltas por validar — só contam pontos depois de confirmadas */}
      {pendingPenalties.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/40">
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Possíveis faltas por validar ({pendingPenalties.length})</CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-1">
            {pendingPenalties.map((row: any) => (
              <div key={row.penalty.id} className="flex flex-col gap-2 sm:flex-row sm:items-center text-sm border-b last:border-0 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span className="font-medium truncate">{row.employee?.fullName ?? `#${row.penalty.employeeId}`}</span>
                    <span className="shrink-0 text-xs font-semibold tabular-nums text-amber-800">{Number(row.penalty.points).toLocaleString("pt-PT")} pt</span>
                  </div>
                  <p className="text-muted-foreground line-clamp-2 break-words" title={row.penalty.notes ?? undefined}>{row.penalty.reason === "no_show_extra_dia" ? "Falta a extra" : row.penalty.reason}{row.penalty.notes ? ` · ${row.penalty.notes}` : ""}</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" disabled={reviewPenalty.isPending} onClick={() => reviewPenalty.mutate({ id: row.penalty.id, decision: "confirmed" })}>Confirmar falta</Button>
                  <Button size="sm" variant="ghost" disabled={reviewPenalty.isPending} onClick={() => reviewPenalty.mutate({ id: row.penalty.id, decision: "dismissed" })}>Justificada / não conta</Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">A carregar...</div>
      ) : (
        <Tabs defaultValue="employees">
          <TabsList>
            <TabsTrigger value="employees">
              <Users className="w-4 h-4 mr-2" />
              Colaboradores
              <Badge variant="secondary" className="ml-2">{employees.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="extras">
              <Clock className="w-4 h-4 mr-2" />
              Extras
              <Badge variant="secondary" className="ml-2">{extras.length}</Badge>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="employees" className="space-y-4 mt-4">
            <KpiRow t={tEmps} />
            <DashboardTable rows={employees} />
          </TabsContent>

          <TabsContent value="extras" className="space-y-4 mt-4">
            <KpiRow t={tExtras} />
            <DashboardTable rows={extras} extra />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function KpiRow({ t }: { t: ReturnType<any> }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
      <Card className="p-3 gap-1 min-w-0">
        <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Pessoas</p>
        <p className="text-lg sm:text-xl font-bold tabular-nums truncate" title={String(t.count)}>{t.count}</p>
      </Card>
      <Card className="p-3 gap-1 min-w-0">
        <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Horas este mês</p>
        <p className="text-lg sm:text-xl font-bold tabular-nums truncate">{Number(t.hours).toFixed(1)}h</p>
      </Card>
      <Card className="p-3 gap-1 min-w-0">
        <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Bruto</p>
        <p className="text-lg sm:text-xl font-bold tabular-nums truncate text-primary" title={String(fmt(t.bruto))}>{fmt(t.bruto)}</p>
      </Card>
      <Card className="p-3 gap-1 min-w-0 bg-amber-50/30 border-amber-200">
        <p className="text-[11px] font-medium tracking-wide text-amber-700 uppercase">Líq. est.</p>
        <p className="text-lg sm:text-xl font-bold tabular-nums truncate text-amber-700" title={String(fmt(t.liquido))}>{fmt(t.liquido)}</p>
      </Card>
      <Card className="p-3 gap-1 min-w-0 bg-yellow-50/30 border-yellow-200">
        <p className="text-[11px] font-medium tracking-wide text-yellow-700 uppercase">Atenção</p>
        <p className="text-lg sm:text-xl font-bold tabular-nums truncate text-yellow-700" title={String(t.yellowFlags)}>{t.yellowFlags}</p>
      </Card>
      <Card className="p-3 gap-1 min-w-0 bg-red-50/30 border-red-200">
        <p className="text-[11px] font-medium tracking-wide text-red-700 uppercase">Bloqueados (acesso)</p>
        <p className="text-lg sm:text-xl font-bold tabular-nums truncate text-red-700" title={String(t.blocked)}>{t.blocked}</p>
        {t.redFlags > t.blocked && <p className="text-[11px] font-medium tracking-wide text-red-700">{t.redFlags - t.blocked} com 3+ pontos por rever</p>}
      </Card>
    </div>
  );
}

function DashboardTable({ rows, extra = false }: { rows: any[]; extra?: boolean }) {
  const { sorted, sortKey, sortDir, toggle } = useTableSort(rows);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Detalhe por colaborador</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs">
                <Th k="fullName" label="Nome" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                <Th k="projectName" label="Centro" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                <Th k="currentMonth.totalHours" label="Horas mês" align="right" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                <Th k="currentMonth.daysWorked" label="Dias" align="right" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                <Th k="currentMonth.totalPayment" label="Bruto mês" align="right" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                <Th k="currentMonth.netEstimate" label="Líq. est." align="right" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                <Th k="totalReceivedLookback" label="Apurado lookback" align="right" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                <Th k="totalPaidLookback" label="Pago (fechos)" align="right" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                <Th k="avgPerHourLookback" label="€/h méd." align="right" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                <Th k="severity" label="Estado" align="center" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
              </tr>
            </thead>
            <tbody>
              {(sorted as any[]).map(r => {
                const bg = r.severity === "red" ? "bg-red-50/50" : r.severity === "yellow" ? "bg-yellow-50/40" : "";
                return (
                  <tr key={r.employeeId} className={`border-b hover:bg-muted/30 ${bg}`}>
                    <td className="p-2 font-medium min-w-[160px] max-w-[260px] truncate" title={r.fullName}>{r.fullName}</td>
                    <td className="p-2 text-xs text-muted-foreground max-w-[200px] truncate" title={r.projectName ?? r.department ?? undefined}>{r.projectName ?? r.department ?? "—"}</td>
                    <td className="p-2 text-right tabular-nums whitespace-nowrap">{Number(r.currentMonth.totalHours).toFixed(1)}</td>
                    <td className="p-2 text-right tabular-nums whitespace-nowrap">{r.currentMonth.daysWorked}</td>
                    <td className="p-2 text-right tabular-nums whitespace-nowrap">{fmt(r.currentMonth.totalPayment)}</td>
                    <td className="p-2 text-right tabular-nums whitespace-nowrap text-amber-700">{fmt(r.currentMonth.netEstimate)}</td>
                    <td className="p-2 text-right tabular-nums whitespace-nowrap">{fmt(r.totalReceivedLookback)}</td>
                    <td className="p-2 text-right tabular-nums whitespace-nowrap text-emerald-700">{r.totalPaidLookback ? fmt(r.totalPaidLookback) : "—"}</td>
                    <td className="p-2 text-right tabular-nums whitespace-nowrap">{extra ? `${Number(r.avgPerHourLookback).toFixed(2)}€` : "—"}</td>
                    <td className="p-2 text-center">
                      {r.severity === "red" && (
                        <Badge variant="destructive" className="text-[11px] gap-1 whitespace-nowrap">
                          <AlertTriangle className="w-3 h-3" /> {r.openPenaltyPoints} pt
                        </Badge>
                      )}
                      {r.severity === "yellow" && (
                        <Badge className="text-[11px] gap-1 whitespace-nowrap bg-yellow-100 text-yellow-800 border-yellow-300">
                          <AlertTriangle className="w-3 h-3" /> {r.openPenaltyPoints} pt
                        </Badge>
                      )}
                      {r.severity === "ok" && <span className="text-xs text-muted-foreground">—</span>}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={9} className="p-8 text-center text-muted-foreground">Sem dados</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
