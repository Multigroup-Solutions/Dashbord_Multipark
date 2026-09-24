/**
 * Avaliação individual — sobre o motor ÚNICO (employee_day_metrics +
 * ajustes manuais + contestações), com as regras de shared/evaluationRules.ts.
 *
 *  - Ranking do período (Dia/Semana/Mês/Ano), com vista "Por hora" secundária;
 *    clicar na pontuação abre a gaveta com as regras, métricas e dias.
 *  - "A minha avaliação": só os dados da própria ficha (o servidor decide quem é).
 *  - Contestações (gestão): aceitar com correção ou recusar.
 * O âmbito de cidade é aplicado no servidor.
 */
import EvaluationExplanation from "@/components/aiOps/EvaluationExplanation";
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Award, Clock, Download, RefreshCw, Trophy, Zap } from "lucide-react";
import DateRangeNav, { rangeFor, type DateGran } from "@/components/DateRangeNav";
import { useOpenEmployee } from "@/hooks/useOpenEmployee";
import {
  DisputeList,
  EmployeeEvaluationDetail,
  EvaluationDrawer,
  ResolveDisputeDialog,
  RulesLegend,
  fmtDay,
  fmtNum,
  fmtPts,
  ptsClass,
} from "@/components/evaluation/EvaluationBreakdown";

const ROLE_LEVEL: Record<string, number> = { super_admin: 7, admin: 6, supervisor: 5, team_leader: 4, backoffice: 3, frontoffice: 2, extra: 1, user: 0 };
const roleAtLeast = (role: string | undefined, min: string) => (ROLE_LEVEL[role ?? ""] ?? -1) >= ROLE_LEVEL[min];

type View = "totals" | "perHour";

export default function PerformancePage() {
  const { user } = useAuth();
  // só para mostrar/esconder — quem decide é o servidor
  const canRank = roleAtLeast(user?.role, "frontoffice");
  const isSupervisor = roleAtLeast(user?.role, "supervisor");
  const [tab, setTab] = useState<string>(canRank ? "ranking" : "mine");

  const [range, setRange] = useState(() => {
    const r = rangeFor("week", new Date());
    return { start: r.start, end: r.end, gran: "week" as DateGran };
  });
  const hasRange = !!range.start && !!range.end;

  return (
    <div className="space-y-4 max-w-7xl mx-auto w-full">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-muted-foreground text-sm">Pontuação por dia operacional (03h→03h), com o detalhe de cada regra.</p>
        <DateRangeNav start={range.start} end={range.end} gran={range.gran} showAll={false}
          onChange={(s, e, g) => setRange({ start: s, end: e, gran: g })} />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto">
          {canRank && <TabsTrigger value="ranking">Ranking</TabsTrigger>}
          <TabsTrigger value="mine">A minha avaliação</TabsTrigger>
          {isSupervisor && <TabsTrigger value="disputes">Contestações</TabsTrigger>}
        </TabsList>
        {canRank && (
          <TabsContent value="ranking" className="mt-4">
            {hasRange && <RankingView from={range.start} to={range.end} isSupervisor={isSupervisor} />}
          </TabsContent>
        )}
        <TabsContent value="mine" className="mt-4">
          {hasRange && <MineView from={range.start} to={range.end} />}
        </TabsContent>
        {isSupervisor && (
          <TabsContent value="disputes" className="mt-4">
            <DisputesView />
          </TabsContent>
        )}
      </Tabs>

      <Card>
        <CardHeader><CardTitle className="text-base">Sistema de pontos</CardTitle></CardHeader>
        <CardContent><RulesLegend /></CardContent>
      </Card>
    </div>
  );
}

// ─── Ranking ─────────────────────────────────────────────────────────────────

type SortKey = "points" | "pointsPerHour" | "actions" | "actionsPerHour" | "hours" | "name";

function RankingView({ from, to, isSupervisor }: { from: string; to: string; isSupervisor: boolean }) {
  const utils = trpc.useUtils();
  const openEmployee = useOpenEmployee();
  const q = trpc.evaluation.ranking.useQuery({ from, to });
  const recompute = trpc.evaluation.recompute.useMutation({
    onSuccess: (r) => { toast.success(`Recalculado: ${r.written} dia(s) de colaboradores`); utils.evaluation.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const [view, setView] = useState<View>("totals");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "points", dir: -1 });
  const [drawer, setDrawer] = useState<{ id: number; name: string } | null>(null);
  const rows = q.data ?? [];

  // posição do ranking é sempre pela pontuação total
  const rank = useMemo(() => {
    const m = new Map<number, number>();
    [...rows].sort((a, b) => b.score.totalPoints - a.score.totalPoints).forEach((r, i) => m.set(r.employeeId, i + 1));
    return m;
  }, [rows]);
  const sorted = useMemo(() => {
    const val = (r: (typeof rows)[number]): number | string => {
      switch (sort.key) {
        case "name": return r.employeeName;
        case "points": return r.score.totalPoints;
        case "pointsPerHour": return r.perHour.pointsPerHour ?? -Infinity;
        case "actions": return r.metrics.actions;
        case "actionsPerHour": return r.perHour.actionsPerHour ?? -Infinity;
        case "hours": return r.perHour.hours;
      }
    };
    return [...rows].sort((a, b) => {
      const va = val(a), vb = val(b);
      const c = typeof va === "string" ? va.localeCompare(String(vb)) : (va as number) - (vb as number);
      return c * sort.dir;
    });
  }, [rows, sort]);
  const toggle = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === "name" ? 1 : -1 }));
  const th = (key: SortKey, label: string, cls = "text-right") => (
    <th className={`p-2 ${cls} cursor-pointer select-none whitespace-nowrap`} onClick={() => toggle(key)}>
      {label}{sort.key === key ? (sort.dir === -1 ? " ▼" : " ▲") : ""}
    </th>
  );

  const totals = useMemo(() => ({
    hours: rows.reduce((s, r) => s + r.metrics.hoursWorked, 0),
    actions: rows.reduce((s, r) => s + r.metrics.actions, 0),
    cost: rows.reduce((s, r) => s + r.metrics.cost, 0),
  }), [rows]);
  const top = rows[0];

  const exportCSV = () => {
    const headers = ["Pos", "Colaborador", "Dias", "Horas", "Ações", "Recolhas", "Entregas", "Movimentos", "Levar ao parque", "Atrasos", "Velocidade", "Reclamações", "Acidentes", "Pts+", "Pts−", "Total", "Ações/h", "Pontos/h", "Custo"];
    const lines = sorted.map((r) => [
      rank.get(r.employeeId), r.employeeName, r.days, r.metrics.hoursWorked, r.metrics.actions, r.metrics.recolhas, r.metrics.entregas,
      r.metrics.movements, r.metrics.parkingMoves, r.metrics.delays, r.metrics.speedingEvents, r.metrics.complaints, r.metrics.accidents,
      r.score.positivePoints, r.score.negativePoints, r.score.totalPoints, r.perHour.actionsPerHour ?? "", r.perHour.pointsPerHour ?? "", r.metrics.cost,
    ].map((v) => String(v ?? "").replace(/;/g, ",")).join(";"));
    const blob = new Blob(["﻿" + [headers.join(";"), ...lines].join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `avaliacao_${from}_${to}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-3 gap-1 min-w-0"><div className="flex items-center gap-2"><Clock className="w-4 h-4 shrink-0" /><span className="text-xs text-muted-foreground">Horas (ponto)</span></div><p className="text-xl font-bold tabular-nums truncate">{fmtNum(totals.hours)} h</p></Card>
        <Card className="p-3 gap-1 min-w-0"><div className="flex items-center gap-2"><Zap className="w-4 h-4 shrink-0 text-blue-500" /><span className="text-xs text-muted-foreground">Ações</span></div><p className="text-xl font-bold tabular-nums truncate">{totals.actions}</p></Card>
        <Card className="p-3 gap-1 min-w-0"><div className="flex items-center gap-2"><Zap className="w-4 h-4 shrink-0 text-amber-500" /><span className="text-xs text-muted-foreground">Custo</span></div><p className="text-xl font-bold tabular-nums truncate">{fmtNum(totals.cost, 0)} €</p></Card>
        <Card className="p-3 gap-1 min-w-0"><div className="flex items-center gap-2"><Award className="w-4 h-4 shrink-0 text-yellow-600" /><span className="text-xs text-muted-foreground">Melhor</span></div>{top ? (<><p className="text-sm font-bold truncate" title={top.employeeName}>{top.employeeName}</p><p className="text-xs font-semibold tabular-nums text-muted-foreground">{fmtPts(top.score.totalPoints)} pts</p></>) : <p className="text-xl font-bold">—</p>}</Card>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border p-0.5">
          <Button size="sm" variant={view === "totals" ? "default" : "ghost"} className="h-8" onClick={() => setView("totals")}>Totais</Button>
          <Button size="sm" variant={view === "perHour" ? "default" : "ghost"} className="h-8" onClick={() => setView("perHour")}>Por hora</Button>
        </div>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={exportCSV} disabled={rows.length === 0}><Download className="w-4 h-4 mr-1" /> CSV</Button>
          {isSupervisor && (
            <Button size="sm" disabled={recompute.isPending} onClick={() => recompute.mutate({ from, to })}>
              <RefreshCw className={`w-4 h-4 mr-1 ${recompute.isPending ? "animate-spin" : ""}`} /> {recompute.isPending ? "A recalcular..." : "Recalcular"}
            </Button>
          )}
        </div>
      </div>

      {q.isLoading ? (
        <div className="flex justify-center py-16"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>
      ) : q.error ? (
        <Card className="p-6 text-sm text-red-700">{q.error.message}</Card>
      ) : rows.length === 0 ? (
        <Card className="p-10 text-center">
          <Trophy className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
          <p className="text-muted-foreground">Sem dias calculados neste período.</p>
          <p className="text-xs text-muted-foreground mt-1">O recálculo automático corre todos os dias (últimas 4 semanas){isSupervisor ? "; para outro período usa Recalcular." : "."}</p>
        </Card>
      ) : (
        <Card>
          <CardHeader><CardTitle className="text-base">Ranking — {from === to ? fmtDay(from) : `${fmtDay(from)} a ${fmtDay(to)}`}{view === "perHour" && " · por hora"}</CardTitle></CardHeader>
          <CardContent className="px-2 sm:px-6">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="border-b text-left">
                    <th className="p-2 w-10">#</th>
                    {th("name", "Colaborador", "text-left")}
                    {view === "totals" ? (
                      <>
                        {th("hours", "Horas")}
                        {th("actions", "Ações")}
                        <th className="p-2 text-right" title="Recolhas + entregas">Rec/Ent</th>
                        <th className="p-2 text-right" title="Movimentos (dos quais levar ao parque)">Movs</th>
                        <th className="p-2 text-right">Atrasos</th>
                        <th className="p-2 text-right" title="Velocidade · Reclamações · Acidentes">Vel/Recl/Acid</th>
                        {th("points", "Pontos")}
                      </>
                    ) : (
                      <>
                        {th("hours", "Horas")}
                        {th("actionsPerHour", "Ações/h")}
                        <th className="p-2 text-right">Pts ações/h</th>
                        {th("pointsPerHour", "Pontos/h")}
                        {th("points", "Pontos")}
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => {
                    const pos = rank.get(r.employeeId) ?? 0;
                    const m = r.metrics;
                    return (
                      <tr key={r.employeeId} className={`border-b hover:bg-muted/50 ${pos <= 3 ? "bg-yellow-50/30" : ""}`}>
                        <td className="p-2 font-bold text-center">{pos === 1 ? "🥇" : pos === 2 ? "🥈" : pos === 3 ? "🥉" : pos}</td>
                        <td className="p-2 font-medium min-w-[160px]">
                          <button type="button" className="hover:underline text-left" title="Abrir ficha" onClick={() => openEmployee(r.employeeId)}>{r.employeeName}</button>
                          <span className="block text-[11px] text-muted-foreground font-normal">
                            {r.days} dia(s){r.adjustments > 0 && " · ajustado"}{r.openDisputes > 0 && ` · ${r.openDisputes} contestação(ões)`}
                          </span>
                        </td>
                        {view === "totals" ? (
                          <>
                            <td className="p-2 text-right tabular-nums whitespace-nowrap">{fmtNum(m.hoursWorked)}</td>
                            <td className="p-2 text-right tabular-nums whitespace-nowrap">{m.actions}</td>
                            <td className="p-2 text-right tabular-nums whitespace-nowrap">{m.recolhas + m.entregas}</td>
                            <td className="p-2 text-right tabular-nums whitespace-nowrap">{m.movements}{m.parkingMoves > 0 && <span className="text-muted-foreground"> ({m.parkingMoves})</span>}</td>
                            <td className="p-2 text-right tabular-nums whitespace-nowrap">{m.delays || "—"}</td>
                            <td className="p-2 text-right tabular-nums whitespace-nowrap">{m.speedingEvents}/{m.complaints}/{m.accidents}</td>
                          </>
                        ) : (
                          <>
                            <td className="p-2 text-right tabular-nums whitespace-nowrap">{fmtNum(r.perHour.hours)}</td>
                            <td className="p-2 text-right tabular-nums whitespace-nowrap">{fmtNum(r.perHour.actionsPerHour, 2)}</td>
                            <td className="p-2 text-right tabular-nums whitespace-nowrap">{fmtNum(r.perHour.weightedPerHour, 2)}</td>
                            <td className="p-2 text-right tabular-nums whitespace-nowrap">{fmtNum(r.perHour.pointsPerHour, 2)}</td>
                          </>
                        )}
                        <td className="p-2 text-right">
                          <button type="button" title="Ver de onde vem a pontuação"
                            className={`font-bold text-base tabular-nums whitespace-nowrap underline decoration-dotted underline-offset-4 ${ptsClass(r.score.totalPoints)}`}
                            onClick={() => setDrawer({ id: r.employeeId, name: r.employeeName })}>
                            {fmtPts(r.score.totalPoints)}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <EvaluationDrawer employeeId={drawer?.id ?? null} employeeName={drawer?.name ?? ""} from={from} to={to}
        canAdjust={isSupervisor} onOpenChange={(o) => !o && setDrawer(null)} />
    </div>
  );
}

// ─── A minha avaliação ───────────────────────────────────────────────────────

function MineView({ from, to }: { from: string; to: string }) {
  const utils = trpc.useUtils();
  const q = trpc.evaluation.mine.useQuery({ from, to });
  if (q.isLoading) return <p className="text-sm text-muted-foreground">A carregar...</p>;
  if (q.error) return <Card className="p-6 text-sm text-red-700">{q.error.message}</Card>;
  const d = q.data;
  if (!d?.employee) {
    return <Card className="p-8 text-center text-muted-foreground">A tua conta não está ligada a uma ficha de colaborador — fala com o RH.</Card>;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex flex-wrap items-center gap-2">
          {d.employee.fullName}
          {d.totals && <Badge variant="secondary" className={`tabular-nums ${ptsClass(d.totals.score.totalPoints)}`}>{fmtPts(d.totals.score.totalPoints)} pts</Badge>}
        </CardTitle>
        <p className="text-xs text-muted-foreground">Só vês os teus dados. Se algo estiver errado num dia, abre o dia e carrega em "Contestar".</p>
      </CardHeader>
      <CardContent>
        <div className="mb-4"><EvaluationExplanation from={from} to={to} /></div>
        <EmployeeEvaluationDetail employeeId={d.employee.id} detail={d as any} mode="self"
          onChanged={() => utils.evaluation.mine.invalidate()} />
      </CardContent>
    </Card>
  );
}

// ─── Contestações (gestão) ───────────────────────────────────────────────────

function DisputesView() {
  const utils = trpc.useUtils();
  const [status, setStatus] = useState<"open" | "accepted" | "rejected">("open");
  const q = trpc.evaluation.disputes.list.useQuery({ status });
  const [resolving, setResolving] = useState<any>(null);
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-2 space-y-0">
        <CardTitle className="text-base">Contestações</CardTitle>
        <div className="ml-auto inline-flex rounded-md border p-0.5">
          {(["open", "accepted", "rejected"] as const).map((s) => (
            <Button key={s} size="sm" variant={status === s ? "default" : "ghost"} className="h-8" onClick={() => setStatus(s)}>
              {s === "open" ? "Em análise" : s === "accepted" ? "Aceites" : "Recusadas"}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {q.isLoading ? <p className="text-sm text-muted-foreground">A carregar...</p>
          : (q.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">Sem contestações.</p>
          : <DisputeList disputes={q.data ?? []} onResolve={setResolving} />}
      </CardContent>
      {resolving && (
        <ResolveDisputeDialog dispute={resolving} onClose={() => setResolving(null)}
          onDone={() => { setResolving(null); utils.evaluation.invalidate(); }} />
      )}
    </Card>
  );
}
