import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { useState, useMemo } from "react";
import {
  Trophy, RefreshCw, TrendingUp, TrendingDown, Minus, Clock,
  Zap, AlertTriangle, Award, Download, Pencil, ChevronLeft, ChevronRight,
} from "lucide-react";
import { useTableSort, Th } from "@/components/SortableTable";
import { useOpenEmployee } from "@/hooks/useOpenEmployee";
import { fmtPTDate } from "@/lib/lisbonTime";

function getWeekNumber(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

export default function PerformancePage() {
  const { user } = useAuth();
  const now = new Date();
  const [week, setWeek] = useState(getWeekNumber(now));
  const [year, setYear] = useState(now.getFullYear());
  const [editing, setEditing] = useState<any>(null);

  const prevWeek = week > 1 ? week - 1 : 53;
  const prevYear = week > 1 ? year : year - 1;

  const { data: evaluations = [], isLoading } = trpc.performance.list.useQuery({ weekNumber: week, yearNumber: year });
  const lastWorkedMap = trpc.rh.lastWorkedMap.useQuery();
  const openEmployee = useOpenEmployee();
  const { data: prevEvaluations = [] } = trpc.performance.list.useQuery({ weekNumber: prevWeek, yearNumber: prevYear });
  const generateMut = trpc.performance.generate.useMutation();
  const updateMut = trpc.performance.update.useMutation();
  const utils = trpc.useUtils();
  // roster (id+nome) em vez de rh.list: acessível a extra+ (rh.list é admin)
  const { data: employees = [] } = trpc.rh.roster.useQuery({ activeOnly: true });

  const employeeMap = useMemo(() => {
    const map = new Map<number, string>();
    employees.forEach((e: any) => map.set(e.id, e.fullName));
    return map;
  }, [employees]);

  // Mapeia posição anterior por employeeId para tendência
  const prevPositionMap = useMemo(() => {
    const sorted = [...prevEvaluations].sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0));
    const map = new Map<number, number>();
    sorted.forEach((ev, i) => map.set(ev.employeeId, i + 1));
    return map;
  }, [prevEvaluations]);

  const isSupervisor = user?.role && ["supervisor", "admin", "super_admin"].includes(user.role);

  // Ordenação por coluna; a POSIÇÃO do ranking (medalhas) é sempre pela
  // pontuação, independentemente da coluna ordenada.
  const { sorted: sortedEvals, sortKey, sortDir, toggle } = useTableSort(evaluations as any[]);
  const rankByEmployee = useMemo(() => {
    const byPoints = [...evaluations].sort((a: any, b: any) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0));
    const m = new Map<number, number>();
    byPoints.forEach((ev: any, i: number) => m.set(ev.employeeId, i + 1));
    return m;
  }, [evaluations]);

  const handleGenerate = async () => {
    if (evaluations.length > 0 && !confirm(`Já existem ${evaluations.length} avaliações para esta semana. Recalcular vai actualizar os valores automáticos (mantém notas guardadas). Continuar?`)) {
      return;
    }
    try {
      await generateMut.mutateAsync({ weekNumber: week, yearNumber: year });
      utils.performance.list.invalidate();
      toast.success(`Avaliação da semana ${week} gerada!`);
    } catch (e: any) {
      toast.error(e.message || "Erro ao gerar avaliação");
    }
  };

  const exportCSV = () => {
    const headers = ["Pos","Condutor","Horas","Movs","Mov/h","Inc+","Inc-","Pts+","Pts-","Total","Custo","Notas"];
    const rows = evaluations.map((ev: any, idx: number) => [
      idx + 1,
      employeeMap.get(ev.employeeId) ?? `#${ev.employeeId}`,
      ev.hoursWorked, ev.movementsCount, ev.movementsPerHour,
      ev.incidentsPositive, ev.incidentsNegative,
      ev.positivePoints, ev.negativePoints, ev.totalPoints, ev.weeklyCost ?? "",
      (ev.notes ?? "").replace(/;/g, ","),
    ]);
    const csv = [headers.join(";"), ...rows.map(r => r.join(";"))].join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `avaliacao_S${week}_${year}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const topPerformer = evaluations.length > 0 ? evaluations[0] : null;
  const totalHours = evaluations.reduce((s: number, e: any) => s + (e.hoursWorked || 0), 0);
  const totalMovements = evaluations.reduce((s: number, e: any) => s + (e.movementsCount || 0), 0);
  const totalCost = evaluations.reduce((s: number, e: any) => s + Number(e.weeklyCost || 0), 0);

  return (
    <div className="space-y-6 max-w-7xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-muted-foreground">Ranking semanal dos condutores</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Setinhas de semana (padrão transversal): ◀ S32/2026 ▶ + Esta semana */}
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="icon" className="h-9 w-8" title="Semana anterior"
              onClick={() => { if (week > 1) setWeek(week - 1); else { setWeek(53); setYear(year - 1); } }}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium tabular-nums min-w-[86px] text-center">S{week}/{year}</span>
            <Button variant="outline" size="icon" className="h-9 w-8" title="Semana seguinte"
              onClick={() => { if (week < 53) setWeek(week + 1); else { setWeek(1); setYear(year + 1); } }}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant={week === getWeekNumber(now) && year === now.getFullYear() ? "secondary" : "outline"}
              size="sm" className="h-9"
              onClick={() => { setWeek(getWeekNumber(now)); setYear(now.getFullYear()); }}
            >
              Esta semana
            </Button>
          </div>
          <Button variant="outline" size="sm" onClick={exportCSV} disabled={evaluations.length === 0}>
            <Download className="w-4 h-4 mr-2" /> CSV
          </Button>
          {isSupervisor && (
            <Button onClick={handleGenerate} disabled={generateMut.isPending} size="sm">
              <RefreshCw className={`w-4 h-4 mr-2 ${generateMut.isPending ? "animate-spin" : ""}`} />
              {generateMut.isPending ? "A gerar..." : evaluations.length > 0 ? "Recalcular" : "Gerar Avaliação"}
            </Button>
          )}
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-3">
          <div className="flex items-center gap-2"><Clock className="w-4 h-4" /><span className="text-xs text-muted-foreground">Total Horas</span></div>
          <p className="text-xl font-bold mt-1">{Number(totalHours).toFixed(1)}h</p>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2"><Zap className="w-4 h-4 text-blue-500" /><span className="text-xs text-muted-foreground">Total Movimentações</span></div>
          <p className="text-xl font-bold mt-1">{totalMovements}</p>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2"><Zap className="w-4 h-4 text-amber-500" /><span className="text-xs text-muted-foreground">Custo Escalas</span></div>
          <p className="text-xl font-bold mt-1">{totalCost.toFixed(0)}€</p>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2"><Award className="w-4 h-4 text-yellow-500" /><span className="text-xs text-muted-foreground">Melhor Condutor</span></div>
          <p className="text-sm font-bold mt-1 truncate">{topPerformer ? (employeeMap.get(topPerformer.employeeId) ?? `#${topPerformer.employeeId}`) : "—"}</p>
        </Card>
      </div>

      {/* Ranking Table */}
      {isLoading ? (
        <div className="flex justify-center py-20"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>
      ) : evaluations.length === 0 ? (
        <Card className="p-10 text-center">
          <Trophy className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
          <p className="text-muted-foreground">Sem avaliações para esta semana</p>
          <p className="text-xs text-muted-foreground mt-1">
            {isSupervisor ? "Clica em \"Gerar Avaliação\" para calcular o ranking" : "Aguarda que um supervisor gere o ranking."}
          </p>
        </Card>
      ) : (
        <Card>
          <CardHeader><CardTitle className="text-base">Ranking — Semana {week}/{year}</CardTitle></CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="p-2 w-12">#</th>
                    <th className="p-2 w-12 text-center">Δ</th>
                    <Th k="employeeName" label="Condutor" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                    <Th k="hoursWorked" label="Horas" align="center" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                    <Th k="movementsCount" label="Movs" align="center" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                    <Th k="movementsPerHour" label="Mov/h" align="center" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                    <Th k="incidentsPositive" label="Inc+" align="center" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                    <Th k="incidentsNegative" label="Inc−" align="center" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                    <Th k="positivePoints" label="Pts+" align="center" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                    <Th k="negativePoints" label="Pts−" align="center" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                    <Th k="totalPoints" label="Total" align="center" className="font-bold" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                    <Th k="weeklyCost" label="Custo" align="center" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                    <th className="p-2">Notas</th>
                    {isSupervisor && <th className="p-2 w-10"></th>}
                  </tr>
                </thead>
                <tbody>
                  {sortedEvals.map((ev: any) => {
                    const name = employeeMap.get(ev.employeeId) ?? ev.employeeName ?? `#${ev.employeeId}`;
                    const currentPos = rankByEmployee.get(ev.employeeId) ?? 0;
                    const isTop3 = currentPos <= 3;
                    const prevPos = prevPositionMap.get(ev.employeeId);
                    const delta = prevPos != null ? prevPos - currentPos : null; // +ve = subiu
                    return (
                      <tr key={ev.id} className={`border-b hover:bg-muted/50 ${isTop3 ? "bg-yellow-50/30" : ""}`}>
                        <td className="p-2 font-bold text-center">
                          {currentPos === 1 ? "🥇" : currentPos === 2 ? "🥈" : currentPos === 3 ? "🥉" : currentPos}
                        </td>
                        <td className="p-2 text-center">
                          {delta == null ? (
                            <Badge variant="outline" className="text-[10px]">novo</Badge>
                          ) : delta > 0 ? (
                            <span className="text-green-700 text-xs inline-flex items-center gap-0.5">
                              <TrendingUp className="w-3 h-3" /> {delta}
                            </span>
                          ) : delta < 0 ? (
                            <span className="text-red-700 text-xs inline-flex items-center gap-0.5">
                              <TrendingDown className="w-3 h-3" /> {Math.abs(delta)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground text-xs inline-flex items-center"><Minus className="w-3 h-3" /></span>
                          )}
                        </td>
                        <td className="p-2 font-medium whitespace-nowrap">
                          <button type="button" className="hover:underline text-left" title="Abrir ficha do funcionário" onClick={() => openEmployee(ev.employeeId)}>
                            {name}
                          </button>
                          {lastWorkedMap.data?.[ev.employeeId] && (
                            <span className="block text-[10px] text-muted-foreground font-normal">últ. trabalho: {fmtPTDate(lastWorkedMap.data[ev.employeeId])}</span>
                          )}
                        </td>
                        <td className="p-2 text-center tabular-nums">{Number(ev.hoursWorked || 0).toFixed(1)}h</td>
                        <td className="p-2 text-center tabular-nums">{ev.movementsCount || 0}</td>
                        <td className="p-2 text-center tabular-nums">{Number(ev.movementsPerHour || 0).toFixed(1)}</td>
                        <td className="p-2 text-center text-green-600">{ev.incidentsPositive || 0}</td>
                        <td className="p-2 text-center text-red-600">{ev.incidentsNegative || 0}</td>
                        <td className="p-2 text-center"><span className="text-green-600 font-medium">+{ev.positivePoints || 0}</span></td>
                        <td className="p-2 text-center"><span className="text-red-600 font-medium">−{ev.negativePoints || 0}</span></td>
                        <td className="p-2 text-center">
                          <span className={`font-bold text-base ${(ev.totalPoints || 0) >= 0 ? "text-green-600" : "text-red-600"}`}>
                            {ev.totalPoints || 0}
                          </span>
                        </td>
                        <td className="p-2 text-center text-xs tabular-nums">
                          {Number(ev.weeklyCost || 0) > 0 ? (
                            <>
                              {Number(ev.weeklyCost).toFixed(0)}€
                              {ev.movementsCount > 0 && <span className="block text-[10px] text-muted-foreground">{(Number(ev.weeklyCost) / ev.movementsCount).toFixed(2)}€/mov</span>}
                            </>
                          ) : "—"}
                        </td>
                        <td className="p-2 text-xs text-muted-foreground max-w-[150px] truncate" title={ev.notes ?? ""}>
                          {ev.notes ?? <span className="text-muted-foreground/50">—</span>}
                        </td>
                        {isSupervisor && (
                          <td className="p-2">
                            <Button variant="ghost" size="icon" className="w-7 h-7" onClick={() => setEditing(ev)}>
                              <Pencil className="w-3 h-3" />
                            </Button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Points Legend */}
      <Card>
        <CardHeader><CardTitle className="text-base">Sistema de Pontos</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <h4 className="font-medium text-green-600 mb-2">Pontos Positivos</h4>
              <ul className="space-y-1 text-muted-foreground">
                <li>+2 pts por movimentação realizada</li>
                <li>+5 pts por ocorrência reportada</li>
              </ul>
            </div>
            <div>
              <h4 className="font-medium text-red-600 mb-2">Pontos Negativos</h4>
              <ul className="space-y-1 text-muted-foreground">
                <li>Ocorrências atribuídas ao colaborador (por severidade): low −2, medium −5, high −10, critical −20</li>
                <li>Penalizações abertas (no-show extras-dia, etc): −5 pts por ponto aberto</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      {editing && (
        <Dialog open onOpenChange={(v) => !v && setEditing(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Ajustar pontuação — {employeeMap.get(editing.employeeId) ?? "—"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Pts positivos</Label>
                  <Input
                    type="number"
                    value={editing.positivePoints}
                    onChange={e => setEditing({ ...editing, positivePoints: parseInt(e.target.value) || 0 })}
                  />
                </div>
                <div>
                  <Label className="text-xs">Pts negativos</Label>
                  <Input
                    type="number"
                    value={editing.negativePoints}
                    onChange={e => setEditing({ ...editing, negativePoints: parseInt(e.target.value) || 0 })}
                  />
                </div>
              </div>
              <div>
                <Label className="text-xs">Notas do supervisor</Label>
                <textarea
                  className="w-full border rounded-md p-2 text-sm min-h-[80px] bg-card"
                  value={editing.notes ?? ""}
                  onChange={e => setEditing({ ...editing, notes: e.target.value })}
                  placeholder="Justifica o ajuste, se aplicável..."
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Total resultante: <strong>{(editing.positivePoints || 0) - (editing.negativePoints || 0)}</strong>
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditing(null)}>Cancelar</Button>
              <Button
                disabled={updateMut.isPending}
                onClick={async () => {
                  try {
                    await updateMut.mutateAsync({
                      id: editing.id,
                      positivePoints: editing.positivePoints,
                      negativePoints: editing.negativePoints,
                      notes: editing.notes ?? null,
                    });
                    utils.performance.list.invalidate();
                    toast.success("Avaliação actualizada");
                    setEditing(null);
                  } catch (e: any) {
                    toast.error(e.message || "Erro ao guardar");
                  }
                }}
              >
                {updateMut.isPending ? "A guardar..." : "Guardar"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
