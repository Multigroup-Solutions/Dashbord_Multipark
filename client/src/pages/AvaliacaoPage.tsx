/**
 * Avaliação — UMA página com dois separadores principais:
 *  - "Dia" (antiga Avaliação operacional): a escala do Extras Dia × os
 *    movimentos lidos AO VIVO da BD da Multipark, por pessoa, com a lista de
 *    movimentos e o GPS do Zello (components/evaluation/DayEvaluationTab);
 *  - "4 semanas" (antiga Avaliação individual): ranking do período sobre o
 *    motor único (employee_day_metrics + ajustes + contestações), o resumo
 *    vivo dos movimentos por pessoa e "Recalcular".
 * Mais "A minha avaliação" e "Contestações" (gestão).
 *
 * O motor lê os movimentos da BD da Multipark sozinho (cron diário das
 * últimas 4 semanas e ao abrir um dia) — não há botões para ir buscar
 * histórico. O âmbito de cidade é aplicado no servidor.
 * Rotas: /avaliacao?tab=dia|semanas|minha|contestacoes (/avaliacao-operacional
 * redireciona para ?tab=dia).
 */
import EvaluationExplanation from "@/components/aiOps/EvaluationExplanation";
import { ExportToSheetsButton } from "@/components/google/DriveActions";
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Award, Clock, Download, RefreshCw, Trophy, Zap } from "lucide-react";
import DateRangeNav, { type DateGran } from "@/components/DateRangeNav";
import { useOpenEmployee } from "@/hooks/useOpenEmployee";
import { can, scopeFor } from "@shared/access";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { addDays, operationalDayOf } from "@shared/lisbonDay";
import { RECOMPUTE_WINDOW_DAYS } from "@shared/evaluationRules";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import DayEvaluationTab, { MovementSourceNotice } from "@/components/evaluation/DayEvaluationTab";
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

type View = "totals" | "perHour";
type TabKey = "dia" | "semanas" | "minha" | "contestacoes";

/** As últimas 4 semanas (a janela do recálculo automático), até hoje. */
function lastFourWeeks(): { start: string; end: string; gran: DateGran } {
  const today = operationalDayOf(Date.now());
  return { start: addDays(today, -(RECOMPUTE_WINDOW_DAYS - 1)), end: today, gran: "custom" };
}

export default function AvaliacaoPage() {
  const { user } = useAuth();
  // Só para mostrar/esconder — quem decide é o servidor, com a MESMA matriz
  // (shared/access.ts + permissões por utilizador).
  const canDay = !!user && can(user as any, "avaliacao_operacional", "view");
  const canRank = !!user && can(user as any, "avaliacao", "view") && scopeFor(user as any, "avaliacao") !== "own";
  const isSupervisor = !!user && can(user as any, "avaliacao", "edit");
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const allowed: TabKey[] = [
    ...(canDay ? ["dia" as const] : []),
    ...(canRank ? ["semanas" as const] : []),
    "minha",
    ...(isSupervisor ? ["contestacoes" as const] : []),
  ];
  const asked = params.get("tab") as TabKey | null;
  const [tab, setTabState] = useState<TabKey>(asked && allowed.includes(asked) ? asked : allowed[0]);
  const setTab = (t: string) => {
    setTabState(t as TabKey);
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("tab", t);
      u.searchParams.delete("date");
      window.history.replaceState({}, "", u.pathname + u.search);
    } catch { /* sem URL (testes) */ }
  };

  const [range, setRange] = useState(lastFourWeeks);
  const hasRange = !!range.start && !!range.end;
  const periodNav = (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" onClick={() => setRange(lastFourWeeks())}>Últimas 4 semanas</Button>
      <DateRangeNav start={range.start} end={range.end} gran={range.gran} showAll={false}
        onChange={(s, e, g) => setRange({ start: s, end: e, gran: g })} />
    </div>
  );

  return (
    <div className="space-y-4 max-w-7xl mx-auto w-full">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Trophy className="h-6 w-6 text-purple-600" /> Avaliação</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Pontuação por dia operacional (03h→03h). Os movimentos vêm em tempo real da BD da Multipark; o GPS, o ponto e a escala vêm do dashboard.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto">
          {canDay && <TabsTrigger value="dia">Dia</TabsTrigger>}
          {canRank && <TabsTrigger value="semanas">4 semanas</TabsTrigger>}
          <TabsTrigger value="minha">A minha avaliação</TabsTrigger>
          {isSupervisor && <TabsTrigger value="contestacoes">Contestações</TabsTrigger>}
        </TabsList>
        {canDay && (
          <TabsContent value="dia" className="mt-4">
            {tab === "dia" && <DayEvaluationTab initialDate={params.get("date") ?? undefined} />}
          </TabsContent>
        )}
        {canRank && (
          <TabsContent value="semanas" className="mt-4 space-y-4">
            {periodNav}
            {hasRange && tab === "semanas" && <RankingView from={range.start} to={range.end} isSupervisor={isSupervisor} />}
            <Card>
              <CardHeader><CardTitle className="text-base">Sistema de pontos</CardTitle></CardHeader>
              <CardContent><RulesLegend /></CardContent>
            </Card>
          </TabsContent>
        )}
        <TabsContent value="minha" className="mt-4 space-y-4">
          {periodNav}
          {hasRange && tab === "minha" && <MineView from={range.start} to={range.end} />}
        </TabsContent>
        {isSupervisor && (
          <TabsContent value="contestacoes" className="mt-4">
            {tab === "contestacoes" && <DisputesView />}
          </TabsContent>
        )}
      </Tabs>
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
    onSuccess: (r) => {
      if (r.skipped && r.days === 0) {
        toast.warning(r.notice ?? "BD da Multipark indisponível: nada foi recalculado; ficam os valores anteriores.");
      } else {
        const msg = `Recalculado: ${r.written} dia(s) de colaboradores${r.partial ? ` (até ${fmtDay(r.until)} — o resto fica para o recálculo automático)` : ""}`;
        if (r.skipped) toast.warning(`${msg}. ${r.notice ?? "Parou: BD da Multipark indisponível."}`);
        else toast.success(msg);
      }
      utils.evaluation.invalidate();
    },
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
  // Sem dados (a carregar ou erro) os cartões dizem "—", nunca 0.
  const ready = !!q.data;

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
        <Card className="p-3 gap-1 min-w-0"><div className="flex items-center gap-2"><Clock className="w-4 h-4 shrink-0" /><span className="text-xs text-muted-foreground">Horas (ponto)</span></div><p className="text-xl font-bold tabular-nums truncate">{ready ? `${fmtNum(totals.hours)} h` : "—"}</p></Card>
        <Card className="p-3 gap-1 min-w-0"><div className="flex items-center gap-2"><Zap className="w-4 h-4 shrink-0 text-blue-500" /><span className="text-xs text-muted-foreground">Ações</span></div><p className="text-xl font-bold tabular-nums truncate">{ready ? totals.actions : "—"}</p></Card>
        <Card className="p-3 gap-1 min-w-0"><div className="flex items-center gap-2"><Zap className="w-4 h-4 shrink-0 text-amber-500" /><span className="text-xs text-muted-foreground">Custo</span></div><p className="text-xl font-bold tabular-nums truncate">{ready ? `${fmtNum(totals.cost, 0)} €` : "—"}</p></Card>
        <Card className="p-3 gap-1 min-w-0"><div className="flex items-center gap-2"><Award className="w-4 h-4 shrink-0 text-yellow-600" /><span className="text-xs text-muted-foreground">Melhor</span></div>{top ? (<><p className="text-sm font-bold truncate" title={top.employeeName}>{top.employeeName}</p><p className="text-xs font-semibold tabular-nums text-muted-foreground">{fmtPts(top.score.totalPoints)} pts</p></>) : <p className="text-xl font-bold">—</p>}</Card>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border p-0.5">
          <Button size="sm" variant={view === "totals" ? "selected" : "ghost"} className="h-8" onClick={() => setView("totals")}>Totais</Button>
          <Button size="sm" variant={view === "perHour" ? "selected" : "ghost"} className="h-8" onClick={() => setView("perHour")}>Por hora</Button>
        </div>
        <div className="ml-auto flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" onClick={exportCSV} disabled={rows.length === 0}><Download className="w-4 h-4 mr-1" /> CSV</Button>
          <ExportToSheetsButton input={{ report: "avaliacoes", from, to }} disabled={rows.length === 0} />
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
        <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="o ranking" />
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

      <LiveMovementsCard from={from} to={to} />

      <EvaluationDrawer employeeId={drawer?.id ?? null} employeeName={drawer?.name ?? ""} from={from} to={to}
        canAdjust={isSupervisor} onOpenChange={(o) => !o && setDrawer(null)} />
    </div>
  );
}

// ─── Movimentos do período (BD da Multipark, ao vivo) ────────────────────────

const LIVE_MAX_DAYS = 62;

function LiveMovementsCard({ from, to }: { from: string; to: string }) {
  const openEmployee = useOpenEmployee();
  const tooLong = useMemo(() => {
    const d = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
    return d > LIVE_MAX_DAYS;
  }, [from, to]);
  const q = trpc.evaluation.liveMovements.useQuery({ from, to }, { enabled: !tooLong, refetchOnWindowFocus: false });
  const d = q.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Movimentos na BD da Multipark</CardTitle>
        <p className="text-xs text-muted-foreground">
          Lido agora da app Multipark: quem mexeu em que reservas, em que fase, check-ins e check-outs assinados, ocorrências e as avaliações dos clientes nas reservas de cada um.
        </p>
      </CardHeader>
      <CardContent className="px-2 sm:px-6">
        {tooLong ? <p className="text-sm text-muted-foreground">Escolhe no máximo {LIVE_MAX_DAYS} dias para ver os movimentos.</p>
          : q.isLoading ? <p className="text-sm text-muted-foreground">A ler a BD da Multipark...</p>
          : q.error ? <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="os movimentos" />
          : !d ? null
          : !d.available ? <MovementSourceNotice notice={`Movimentos indisponíveis: ${d.reason}`} />
          : d.rows.length === 0 ? <p className="text-sm text-muted-foreground">Sem movimentos neste período.</p>
          : (
            <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
              <table className="w-full text-sm min-w-[760px]">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="p-2">Pessoa / agente</th>
                    <th className="p-2 text-right" title="Todas as ações registadas">Ações</th>
                    <th className="p-2 text-right" title="Recolhas (check-in) · início da recolha">Check-in</th>
                    <th className="p-2 text-right">Movimentos</th>
                    <th className="p-2 text-right" title="Entregas (check-out) · pedidos de entrega">Check-out</th>
                    <th className="p-2 text-right" title="Reservas diferentes">Reservas</th>
                    <th className="p-2 text-right" title="Reservas com o seu id no check-in / check-out">Assinados</th>
                    <th className="p-2 text-right" title="Ocorrências criadas / resolvidas">Ocorr.</th>
                    <th className="p-2 text-right" title="Avaliações dos clientes nas reservas que fez">Avaliações</th>
                    <th className="p-2">Última ação</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.key} className="border-b hover:bg-muted/40">
                      <td className="p-2 min-w-[160px]">
                        {r.employeeId != null
                          ? <button type="button" className="hover:underline text-left font-medium" onClick={() => openEmployee(r.employeeId!)}>{r.name}</button>
                          : <span className="font-medium">{r.name}</span>}
                        {r.kind !== "colaborador" && <Badge variant="outline" className="ml-1 text-[11px]">{r.kind === "parceiro" ? "parceiro" : "sem ficha"}</Badge>}
                      </td>
                      <td className="p-2 text-right tabular-nums">{r.total}</td>
                      <td className="p-2 text-right tabular-nums">{r.recolhas}{(r.byType.CHECKING_IN ?? 0) > 0 && <span className="text-muted-foreground"> · {r.byType.CHECKING_IN}</span>}</td>
                      <td className="p-2 text-right tabular-nums">{r.movements}</td>
                      <td className="p-2 text-right tabular-nums">{r.entregas}{(r.byType.PENDING_CHECKOUT ?? 0) > 0 && <span className="text-muted-foreground"> · {r.byType.PENDING_CHECKOUT}</span>}</td>
                      <td className="p-2 text-right tabular-nums">{r.bookings}</td>
                      <td className="p-2 text-right tabular-nums">{r.checkInsSigned}/{r.checkOutsSigned}</td>
                      <td className="p-2 text-right tabular-nums">{r.occurrencesCreated}/{r.occurrencesResolved}</td>
                      <td className="p-2 text-right tabular-nums">{r.reviews > 0 ? `${r.reviews} · ${fmtNum(r.reviewAvg, 1)}★` : "—"}</td>
                      <td className="p-2 whitespace-nowrap text-muted-foreground">{r.lastAt ? fmtPTDateTime(r.lastAt) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </CardContent>
    </Card>
  );
}

// ─── A minha avaliação ───────────────────────────────────────────────────────

function MineView({ from, to }: { from: string; to: string }) {
  const utils = trpc.useUtils();
  const q = trpc.evaluation.mine.useQuery({ from, to });
  if (q.isLoading) return <p className="text-sm text-muted-foreground">A carregar...</p>;
  if (q.error) return <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="a tua avaliação" />;
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
        <div className="ml-auto inline-flex flex-wrap rounded-md border p-0.5">
          {(["open", "accepted", "rejected"] as const).map((s) => (
            <Button key={s} size="sm" variant={status === s ? "selected" : "ghost"} className="h-8" onClick={() => setStatus(s)}>
              {s === "open" ? "Em análise" : s === "accepted" ? "Aceites" : "Recusadas"}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {q.isLoading ? <p className="text-sm text-muted-foreground">A carregar...</p>
          : q.error ? <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="as contestações" />
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
