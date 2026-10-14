/**
 * Avaliação → "Mês" (ranking do período, equipas do mês e movimentos na BD
 * da Multipark). Saiu de AvaliacaoPage.tsx (12 out 2026) para ser o MESMO
 * componente em dois sítios: o separador "Mês" da Avaliação e o separador
 * "Avaliação do mês" da Atividade diária (pedido do Jorge). Mesma regra de
 * acesso nos dois: Avaliação para além do próprio (canRank,
 * shared/operationalTabs.ts → canSeeEvaluationRanking); o servidor aplica-a.
 */
import { ExportToSheetsButton } from "@/components/google/DriveActions";
import { Fragment, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Award, Clock, Download, Medal, RefreshCw, SearchX, Trophy, Zap } from "lucide-react";
import DateRangeNav, { rangeFor, type DateGran } from "@/components/DateRangeNav";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { useOpenEmployee } from "@/hooks/useOpenEmployee";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { Th, useTableSort } from "@/components/SortableTable";
import { operationalDayOf } from "@shared/lisbonDay";
import { LATE_AFTER_REQUEST_MINUTES } from "@shared/evaluationRules";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { MovementSourceNotice } from "@/components/evaluation/DayEvaluationTab";
import { EvaluationDrawer, RulesLegend, fmtDay, fmtNum, fmtPts, ptsClass } from "@/components/evaluation/EvaluationBreakdown";
import { RankingFilterBar, useRankingFilter } from "@/components/evaluation/RankingFilterBar";
import { describeFilter, filterRanking, groupRanking, isFilterActive, rankingCsv, rankingTotals, type EvalFilterView } from "@shared/evaluationFilters";

export type MonthRange = { start: string; end: string; gran: DateGran };

/** 42a: o mês do dia operacional de hoje (o recálculo automático cobre o último mês). */
export function thisMonth(): MonthRange {
  return { ...rangeFor("month", new Date(`${operationalDayOf(Date.now())}T12:00:00`)), gran: "month" };
}

/** "Este mês" + o navegador de datas (Mês e A minha avaliação). */
export function PeriodNav({ range, onChange }: { range: MonthRange; onChange: (r: MonthRange) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" onClick={() => onChange(thisMonth())}>Este mês</Button>
      <DateRangeNav start={range.start} end={range.end} gran={range.gran} showAll={false}
        onChange={(s, e, g) => onChange({ start: s, end: e, gran: g })} />
    </div>
  );
}

/**
 * O separador "Mês": período, ranking (Totais / Por hora, CSV, Sheets,
 * Recalcular para quem pode), equipas, movimentos e o sistema de pontos.
 * `range`/`onRangeChange` opcionais: a Avaliação partilha o período com "A
 * minha avaliação"; a Atividade diária usa o seu.
 */
export default function MonthEvaluationTab({ isSupervisor, range: rangeIn, onRangeChange, active = true }: {
  isSupervisor: boolean;
  range?: MonthRange;
  onRangeChange?: (r: MonthRange) => void;
  /** Só lê quando o separador está aberto. */
  active?: boolean;
}) {
  const [own, setOwn] = useState<MonthRange>(thisMonth);
  const range = rangeIn ?? own;
  const setRange = onRangeChange ?? setOwn;
  const hasRange = !!range.start && !!range.end;
  return (
    <div className="space-y-4">
      <PeriodNav range={range} onChange={setRange} />
      {hasRange && active && <RankingView from={range.start} to={range.end} isSupervisor={isSupervisor} />}
      <Card>
        <CardHeader><CardTitle className="text-base">Sistema de pontos</CardTitle></CardHeader>
        <CardContent><RulesLegend /></CardContent>
      </Card>
    </div>
  );
}

// ─── Ranking ─────────────────────────────────────────────────────────────────

type View = "totals" | "perHour";
type SortKey = "points" | "pointsPerHour" | "actions" | "actionsPerHour" | "hours" | "name" | "recEnt" | "movs" | "delays" | "incidents" | "weightedPerHour";

function RankingView({ from, to, isSupervisor }: { from: string; to: string; isSupervisor: boolean }) {
  const utils = trpc.useUtils();
  const openEmployee = useOpenEmployee();
  const { projectId } = useGlobalFilters();
  const q = trpc.evaluation.ranking.useQuery({ from, to, projectId });
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
  // 14 out 2026: dias calculados com as regras antigas e entregas medidas pelo pedido (sem hora marcada)
  const oldRulesDays = rows.reduce((s, r) => s + (r.oldRulesDays ?? 0), 0);
  const noSchedule = rows.reduce((s, r) => s + (r.metrics.deliveriesWithoutSchedule ?? 0), 0);
  // 14 out 2026: pesquisa e filtros "como no Odoo" (shared/evaluationFilters.ts) — no ecrã, na hora.
  const [flt, setFlt] = useRankingFilter();
  const filterOnly: EvalFilterView = { text: flt.text, searches: flt.searches, groups: flt.groups, rules: flt.rules };
  const active = isFilterActive(filterOnly);
  const shownRows = useMemo(() => filterRanking(rows, flt), [rows, flt]);

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
        case "recEnt": return r.metrics.recolhas + r.metrics.entregas;
        case "movs": return r.metrics.movements;
        case "delays": return r.metrics.delays;
        case "incidents": return r.metrics.speedingEvents + r.metrics.complaints + r.metrics.accidents;
        case "weightedPerHour": return r.perHour.weightedPerHour ?? -Infinity;
      }
    };
    return [...shownRows].sort((a, b) => {
      const va = val(a), vb = val(b);
      const c = typeof va === "string" ? va.localeCompare(String(vb)) : (va as number) - (vb as number);
      return c * sort.dir;
    });
  }, [shownRows, sort]);
  const groups = flt.groupBy && flt.groupBy !== "none" ? groupRanking(sorted, flt.groupBy) : null;
  const toggle = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === "name" ? 1 : -1 }));
  const th = (key: SortKey, label: string, cls = "text-right") => (
    <th className={`p-2 ${cls} cursor-pointer select-none whitespace-nowrap`} onClick={() => toggle(key)}>
      {label}{sort.key === key ? (sort.dir === -1 ? " ▼" : " ▲") : ""}
    </th>
  );

  // Os cartões do topo são das linhas que se veem (com filtro, só essas).
  const totals = useMemo(() => rankingTotals(shownRows), [shownRows]);
  const top = totals.best;
  // Sem dados (a carregar ou erro) os cartões dizem "—", nunca 0.
  const ready = !!q.data;

  // CSV = o que se vê: filtrado, pela ordem do ecrã; com filtro, di-lo no topo e no nome.
  const exportCSV = () => {
    const csv = rankingCsv(sorted, { rankOf: (id) => rank.get(id), filter: active ? describeFilter(filterOnly, rows) : null, total: rows.length });
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `avaliacao_${from}_${to}${active ? "_filtrado" : ""}.csv`; a.click();
    URL.revokeObjectURL(url);
  };
  const colCount = view === "totals" ? 9 : 7;

  const renderRow = (r: (typeof rows)[number]) => {
    const pos = rank.get(r.employeeId) ?? 0;
    const m = r.metrics;
    return (
      <tr key={r.employeeId} className={`border-b hover:bg-muted/50 ${pos <= 3 ? "bg-yellow-50/30" : ""}`}>
        <td className="p-2 font-bold text-center" title="Posição no ranking do período (sem filtro)">
          {pos >= 1 && pos <= 3
            ? <span className="inline-flex items-center justify-center"><Medal className={`h-5 w-5 ${pos === 1 ? "text-yellow-500" : pos === 2 ? "text-slate-400" : "text-amber-700"}`} aria-hidden /><span className="sr-only">{pos}</span></span>
            : pos}
        </td>
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
            <td className="p-2 text-right tabular-nums whitespace-nowrap" title="Atrasos à entrada + entregas atrasadas (entre parênteses)">{m.delays || "—"}{m.lateServices > 0 && <span className="text-muted-foreground"> ({m.lateServices})</span>}</td>
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
  };

  return (
    <div className="space-y-4">
      {/* 14 out 2026: pesquisa e filtros como no Odoo — mandam nos cartões, no ranking e nas exportações */}
      {rows.length > 0 && (
        <RankingFilterBar rows={rows} value={flt} onChange={setFlt} shown={shownRows.length}
          extras={{ view, sort }}
          onApplyExtras={(x) => { if (x.view) setView(x.view); if (x.sort) setSort(x.sort); }} />
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-3 gap-1 min-w-0"><div className="flex items-center gap-2"><Clock className="w-4 h-4 shrink-0" /><span className="text-xs text-muted-foreground">Horas (ponto)</span></div><p className="text-xl font-bold tabular-nums truncate">{ready ? `${fmtNum(totals.hours)} h` : "—"}</p></Card>
        <Card className="p-3 gap-1 min-w-0"><div className="flex items-center gap-2"><Zap className="w-4 h-4 shrink-0 text-blue-500" /><span className="text-xs text-muted-foreground">Ações</span></div><p className="text-xl font-bold tabular-nums truncate">{ready ? totals.actions : "—"}</p></Card>
        <Card className="p-3 gap-1 min-w-0"><div className="flex items-center gap-2"><Zap className="w-4 h-4 shrink-0 text-amber-500" /><span className="text-xs text-muted-foreground">Custo</span></div><p className="text-xl font-bold tabular-nums truncate">{ready ? `${fmtNum(totals.cost, 0)} €` : "—"}</p></Card>
        <Card className="p-3 gap-1 min-w-0"><div className="flex items-center gap-2"><Award className="w-4 h-4 shrink-0 text-yellow-600" /><span className="text-xs text-muted-foreground">Melhor{active ? " (do filtro)" : ""}</span></div>{top ? (<><p className="text-sm font-bold truncate" title={top.employeeName}>{top.employeeName}</p><p className="text-xs font-semibold tabular-nums text-muted-foreground">{fmtPts(top.score.totalPoints)} pts</p></>) : <p className="text-xl font-bold">—</p>}</Card>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border p-0.5">
          <Button size="sm" variant={view === "totals" ? "selected" : "ghost"} className="h-8" onClick={() => setView("totals")}>Totais</Button>
          <Button size="sm" variant={view === "perHour" ? "selected" : "ghost"} className="h-8" onClick={() => setView("perHour")}>Por hora</Button>
        </div>
        <div className="ml-auto flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" onClick={exportCSV} disabled={sorted.length === 0} title={active ? "Leva só as pessoas do filtro" : undefined}><Download className="w-4 h-4 mr-1" /> CSV{active ? " (filtrado)" : ""}</Button>
          {/* a folha leva a cidade/marca do topo e o filtro do ecrã (aplicado no servidor com as mesmas regras) */}
          <ExportToSheetsButton input={{ report: "avaliacoes", from, to, projectId, ...(active ? { filter: filterOnly } : {}) }} disabled={sorted.length === 0} />
          {isSupervisor && (
            <Button size="sm" disabled={recompute.isPending} onClick={() => recompute.mutate({ from, to })}>
              <RefreshCw className={`w-4 h-4 mr-1 ${recompute.isPending ? "animate-spin" : ""}`} /> {recompute.isPending ? "A recalcular..." : "Recalcular"}
            </Button>
          )}
        </div>
      </div>

      {oldRulesDays > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
          <span>{oldRulesDays} dia(s) calculado(s) com as regras antigas (antes de 14 out 2026: movimentos, atrasos e entregas contavam de outra forma).</span>
          {isSupervisor && (
            <Button size="sm" variant="outline" className="h-7" disabled={recompute.isPending} onClick={() => recompute.mutate({ from, to })}>
              <RefreshCw className={`w-3.5 h-3.5 mr-1 ${recompute.isPending ? "animate-spin" : ""}`} /> Recalcular
            </Button>
          )}
        </div>
      )}
      {noSchedule > 0 && (
        <p className="text-xs text-muted-foreground">{noSchedule} entrega(s) sem hora marcada: medidas pelo pedido + {LATE_AFTER_REQUEST_MINUTES} min.</p>
      )}

      {q.isLoading ? (
        <div className="flex justify-center py-16"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>
      ) : q.error ? (
        <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="o ranking" />
      ) : rows.length === 0 ? (
        <Card className="p-10 text-center">
          <Trophy className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
          <p className="text-muted-foreground">Sem dias calculados neste período.</p>
          <p className="text-xs text-muted-foreground mt-1">O recálculo automático corre todos os dias (último mês){isSupervisor ? "; para outro período usa Recalcular." : "."}</p>
        </Card>
      ) : sorted.length === 0 ? (
        <Card className="p-10 text-center">
          <SearchX className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
          <p className="text-muted-foreground">Ninguém cumpre este filtro neste período.</p>
          <Button variant="outline" size="sm" className="mt-3 self-center" onClick={() => setFlt({ groupBy: flt.groupBy })}>Limpar o filtro</Button>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Ranking — {from === to ? fmtDay(from) : `${fmtDay(from)} a ${fmtDay(to)}`}{view === "perHour" && " · por hora"}
              {active && <span className="font-normal text-muted-foreground"> · filtrado ({sorted.length} de {rows.length})</span>}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-2 sm:px-6">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="border-b text-left">
                    <th className="p-2 w-10" title="Posição no ranking do período (sem filtro)">#</th>
                    {th("name", "Colaborador", "text-left")}
                    {view === "totals" ? (
                      <>
                        {th("hours", "Horas")}
                        {th("actions", "Ações")}
                        {th("recEnt", "Rec/Ent")}
                        {th("movs", "Movs")}
                        {th("delays", "Atrasos")}
                        {th("incidents", "Vel/Recl/Acid")}
                        {th("points", "Pontos")}
                      </>
                    ) : (
                      <>
                        {th("hours", "Horas")}
                        {th("actionsPerHour", "Ações/h")}
                        {th("weightedPerHour", "Pts ações/h")}
                        {th("pointsPerHour", "Pontos/h")}
                        {th("points", "Pontos")}
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {groups
                    ? groups.map((g) => (
                      <Fragment key={`g-${g.key}`}>
                        <tr className="border-b bg-muted/60">
                          {/* telemóvel: a tabela desliza de lado; o subtotal fica preso à esquerda e quebra de linha (nunca cortado) */}
                          <td colSpan={colCount} className="p-0 text-[13px]">
                            <div className="sticky left-0 max-w-[calc(100vw-4rem)] p-2 whitespace-normal">
                              <span className="font-semibold">{g.label}</span>
                              <span className="text-muted-foreground"> · {g.totals.people} {g.totals.people === 1 ? "pessoa" : "pessoas"} · <span className={ptsClass(g.totals.points)}>{fmtPts(g.totals.points)} pts</span> · {fmtNum(g.totals.hours)} h · {g.totals.actions} ações</span>
                            </div>
                          </td>
                        </tr>
                        {g.rows.map(renderRow)}
                      </Fragment>
                    ))
                    : sorted.map(renderRow)}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <TeamsCard from={from} to={to} />

      <LiveMovementsCard from={from} to={to} />

      <EvaluationDrawer employeeId={drawer?.id ?? null} employeeName={drawer?.name ?? ""} from={from} to={to}
        canAdjust={isSupervisor} onOpenChange={(o) => !o && setDrawer(null)} />
    </div>
  );
}

// ─── 42a: as equipas do mês (o TL como TL; a cidade = o supervisor) ──────────

function TeamsCard({ from, to }: { from: string; to: string }) {
  const { projectId } = useGlobalFilters();
  const openEmployee = useOpenEmployee();
  const q = trpc.evaluation.teams.useQuery({ from, to, projectId }, { refetchOnWindowFocus: false });
  const leaders = q.data?.leaders ?? [];
  const cities = q.data?.cities ?? [];
  const tl = useTableSort(leaders, "avgTeamPoints", -1);
  const ct = useTableSort(cities, "label", 1);
  if (q.isLoading) return null;
  if (q.error) return <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="as equipas" />;
  if (!leaders.length && !cities.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Equipas — team leaders e supervisão</CardTitle>
        <p className="text-xs text-muted-foreground">
          O team leader é avaliado de duas maneiras: como condutor (no ranking de cima, com as ações dele) e aqui como TL — os pontos da equipa nos dias em que foi TL (mesmo dia, cidade e turno). A supervisão é a equipa da cidade (sem os TL). Média = pontos por pessoa e por dia.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 px-2 sm:px-6">
        {cities.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead><tr className="border-b text-left">
                <Th k="label" label="Cidade (supervisão)" sortKey={ct.sortKey} sortDir={ct.sortDir} onToggle={ct.toggle} />
                <Th k="days" label="Dias" align="right" sortKey={ct.sortKey} sortDir={ct.sortDir} onToggle={ct.toggle} />
                <Th k="personDays" label="Pessoas·dia" align="right" sortKey={ct.sortKey} sortDir={ct.sortDir} onToggle={ct.toggle} />
                <Th k="actions" label="Ações" align="right" sortKey={ct.sortKey} sortDir={ct.sortDir} onToggle={ct.toggle} />
                <Th k="points" label="Pontos" align="right" sortKey={ct.sortKey} sortDir={ct.sortDir} onToggle={ct.toggle} />
                <Th k="avgPoints" label="Média" align="right" sortKey={ct.sortKey} sortDir={ct.sortDir} onToggle={ct.toggle} />
              </tr></thead>
              <tbody>
                {(ct.sorted as typeof cities).map((c) => (
                  <tr key={c.city} className="border-b">
                    <td className="p-2"><span className="font-medium">{c.label}</span><span className="block text-[11px] text-muted-foreground">{c.supervisors.length ? c.supervisors.join(", ") : "sem supervisor com esta cidade"}</span></td>
                    <td className="p-2 text-right tabular-nums">{c.days}</td>
                    <td className="p-2 text-right tabular-nums">{c.personDays}</td>
                    <td className="p-2 text-right tabular-nums">{c.actions}</td>
                    <td className={`p-2 text-right tabular-nums font-semibold ${ptsClass(c.points)}`}>{fmtPts(c.points)}</td>
                    <td className="p-2 text-right tabular-nums">{fmtNum(c.avgPoints, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {leaders.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead><tr className="border-b text-left">
                <Th k="employeeName" label="Team leader" sortKey={tl.sortKey} sortDir={tl.sortDir} onToggle={tl.toggle} />
                <Th k="tlDays" label="Dias como TL" align="right" sortKey={tl.sortKey} sortDir={tl.sortDir} onToggle={tl.toggle} />
                <Th k="ownPoints" label="Pontos (como condutor)" align="right" sortKey={tl.sortKey} sortDir={tl.sortDir} onToggle={tl.toggle} />
                <Th k="teamPersonDays" label="Equipa (pessoas·dia)" align="right" sortKey={tl.sortKey} sortDir={tl.sortDir} onToggle={tl.toggle} />
                <Th k="teamActions" label="Ações da equipa" align="right" sortKey={tl.sortKey} sortDir={tl.sortDir} onToggle={tl.toggle} />
                <Th k="teamPoints" label="Pontos da equipa" align="right" sortKey={tl.sortKey} sortDir={tl.sortDir} onToggle={tl.toggle} />
                <Th k="avgTeamPoints" label="Média da equipa" align="right" sortKey={tl.sortKey} sortDir={tl.sortDir} onToggle={tl.toggle} />
              </tr></thead>
              <tbody>
                {(tl.sorted as typeof leaders).map((r) => (
                  <tr key={r.employeeId} className="border-b">
                    <td className="p-2 font-medium"><button type="button" className="hover:underline text-left" title="Abrir ficha" onClick={() => openEmployee(r.employeeId)}>{r.employeeName}</button></td>
                    <td className="p-2 text-right tabular-nums">{r.tlDays}</td>
                    <td className={`p-2 text-right tabular-nums ${ptsClass(r.ownPoints)}`}>{fmtPts(r.ownPoints)}</td>
                    <td className="p-2 text-right tabular-nums">{r.teamPersonDays}</td>
                    <td className="p-2 text-right tabular-nums">{r.teamActions}</td>
                    <td className={`p-2 text-right tabular-nums font-semibold ${ptsClass(r.teamPoints)}`}>{fmtPts(r.teamPoints)}</td>
                    <td className="p-2 text-right tabular-nums">{fmtNum(r.avgTeamPoints, 1)}</td>
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

// ─── Movimentos do período (BD da Multipark, ao vivo) ────────────────────────

const LIVE_MAX_DAYS = 62;

function LiveMovementsCard({ from, to }: { from: string; to: string }) {
  const openEmployee = useOpenEmployee();
  const tooLong = useMemo(() => {
    const d = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
    return d > LIVE_MAX_DAYS;
  }, [from, to]);
  const { projectId } = useGlobalFilters();
  const q = trpc.evaluation.liveMovements.useQuery({ from, to, projectId }, { enabled: !tooLong, refetchOnWindowFocus: false });
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
              <table className="w-full text-sm min-w-[840px]">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="p-2">Pessoa / agente</th>
                    <th className="p-2 text-right" title="Todas as ações registadas">Ações</th>
                    <th className="p-2 text-right" title="Recolhas (check-in) · início da recolha">Check-in</th>
                    <th className="p-2 text-right" title="Levar ao parque e entre garagens (o início de cada deslocação não conta)">Movimentos</th>
                    <th className="p-2 text-right" title="O carro ficou na mesma garagem e só mudou de lugar: conta nas ações, não nos movimentos (+1 na avaliação)">Mudanças de lugar</th>
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
                      <td className="p-2 text-right tabular-nums">{r.spotChanges || <span className="text-muted-foreground">·</span>}</td>
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
