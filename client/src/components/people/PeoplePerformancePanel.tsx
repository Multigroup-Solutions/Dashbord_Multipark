/**
 * Pessoas → Condutores e agentes → Desempenho (37a, Jorge 6 out 2026): tudo
 * o que cada pessoa fez, por dia/semana/mês/ano, por posto (abas), com
 * ranking — dashboard + Multipark + Zello. Só o super admin (o servidor
 * confirma o papel; a aba nem aparece aos outros).
 *
 * Regras em shared/peoplePerformance.ts; dados em server/peoplePerformance.ts.
 *
 * 42c (Jorge, 7 out 2026): cidade e marca do topo; o nome abre a ficha e o
 * resto da linha o detalhe; todos os cabeçalhos ordenam; "Como se contam os
 * pontos" (a tabela dos pesos); a equipa do TL e do supervisor (movimentos,
 * custo, sem Zello, horas paradas, extras a mais/a menos); "km sem
 * movimentos" com as Ligações à mão.
 *
 * 49e (Jorge, 8 out 2026): chamadas perdidas, devolvidas e minutos ao
 * telefone; emails também da caixa Gmail pessoal; a atividade por hora do dia
 * (grelha pessoa × hora na aba, barras 0–23 h no detalhe).
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { lisbonDayOf } from "@shared/lisbonDay";
import {
  GROUP_VIEW, PERF_GROUPS, PERF_METRICS, PERF_PERIODS, periodTitle, rankPeople, shiftAnchor, MIN_HOURS_FOR_RATE,
  TEAM_COLUMNS, TEAM_GROUPS, TEAM_POINT_WEIGHTS,
  type PerfGroup, type PerfMetric, type PerfPeriod, type RankMode,
} from "@shared/peoplePerformance";
import { EVALUATION_POINTS, EVALUATION_RULES } from "@shared/evaluationRules";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { useOpenEmployee } from "@/hooks/useOpenEmployee";
import { useTableSort, Th } from "@/components/SortableTable";
import { PersonLinksDialog } from "@/components/PersonLinksDialog";
import { HourBars, HourHeatmap, HourlyNote, type HourlyInfo } from "@/components/people/PerformanceHours";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChevronLeft, ChevronRight, Link2, Loader2, Medal } from "lucide-react";

const SERIES = ["var(--perf-1)", "var(--perf-2)", "var(--perf-3)", "var(--perf-4)"];
const nf = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 1 });
const eur = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const HOUR_METRICS: ReadonlySet<PerfMetric> = new Set(["hours", "teamHoursStopped", "teamShortHours", "teamOverHours"]);
const fmt = (k: PerfMetric, v: number) => (k === "km" ? `${nf.format(v)} km` : k === "maxSpeed" ? (v ? `${Math.round(v)} km/h` : "—")
  : k === "teamCost" ? eur.format(v) : HOUR_METRICS.has(k) ? `${nf.format(v)} h` : k === "callMinutes" ? `${nf.format(v)} min` : nf.format(v));
const signed = (n: number) => (n > 0 ? `+${nf.format(n)}` : nf.format(n));

type Person = {
  employeeId: number; name: string; position: string | null; role: string | null; active: boolean; photoUrl: string | null;
  totals: Record<PerfMetric, number>; points: number; perHour: number | null; series: Partial<Record<PerfMetric, number[]>>;
  kmNoMoves?: boolean; byRoster?: boolean;
  /** 49e: ações por hora do dia (Lisboa) e a parte da Multipark */
  byHour?: number[]; byHourMultipark?: number[];
};

export function PeoplePerformancePanel() {
  const [period, setPeriod] = useState<PerfPeriod>("month");
  const [anchor, setAnchor] = useState(() => lisbonDayOf(new Date()));
  const [group, setGroup] = useState<PerfGroup>("drivers");
  const [mode, setMode] = useState<RankMode>("perHour");
  const [open, setOpen] = useState<Person | null>(null);
  const [links, setLinks] = useState<Person | null>(null);
  const { projectId } = useGlobalFilters();
  const openEmployee = useOpenEmployee();
  const q = trpc.evaluation.peoplePerformance.useQuery({ period, anchor, group, projectId: projectId ?? undefined }, { retry: false, staleTime: 5 * 60_000, placeholderData: (p) => p });
  const d = q.data;
  const view = GROUP_VIEW[group];
  const ranked = useMemo(() => (d ? rankPeople(d.people as Person[], mode) : []), [d, mode]);
  const { sorted, sortKey, sortDir, toggle } = useTableSort(ranked);
  /** o nome abre a ficha; o resto da linha, o detalhe */
  const nameCell = (r: Person) => (
    <>
      <button type="button" className="font-semibold text-primary hover:underline" title="Abrir a ficha no RH"
        onClick={(e) => { e.stopPropagation(); openEmployee(r.employeeId); }}>{r.name}</button>
      {!r.active && <Badge variant="outline" className="ml-1">inativo</Badge>}
      {r.byRoster && <Badge variant="outline" className="ml-1" title="Posto de condutor ou extra, mas foi team leader em pelo menos metade dos dias escalados">TL pela escala</Badge>}
      {r.kmNoMoves && (
        <button type="button" className="ml-1 inline-flex items-center gap-0.5 rounded border border-amber-500 px-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300"
          title="Tem km do Zello e nenhum movimento na Multipark: o utilizador do Zello/PDA e o agente da Multipark não estão na mesma ficha. Clica para ver as ligações."
          onClick={(e) => { e.stopPropagation(); setLinks(r); }}><Link2 className="h-3 w-3" /> km sem movimentos</button>
      )}
    </>
  );
  const chartData = useMemo(() => d ? d.buckets.map((_, i) => Object.fromEntries([["label", d.bucketLabels[i]], ...view.chart.map((k) => [k, d.groupSeries[k]?.[i] ?? 0])])) : [], [d, view]);
  const top = ranked.filter((r) => (mode === "perHour" ? r.perHour != null : r.points !== 0)).slice(0, 15);

  return (
    <div className="perf-viz space-y-4">
      {/* filtros numa linha */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <div role="group" aria-label="Período" className="inline-flex gap-1">
            {PERF_PERIODS.map((p) => <Button key={p.id} size="sm" variant={period === p.id ? "selected" : "outline"} onClick={() => setPeriod(p.id)}>{p.label}</Button>)}
          </div>
          <Button size="sm" variant="outline" aria-label="Anterior" onClick={() => setAnchor((a) => shiftAnchor(period, a, -1))}><ChevronLeft className="h-4 w-4" /></Button>
          <Input type="date" value={anchor} onChange={(e) => e.target.value && setAnchor(e.target.value)} className="h-8 w-40" aria-label="Dia de referência" />
          <Button size="sm" variant="outline" aria-label="Seguinte" onClick={() => setAnchor((a) => shiftAnchor(period, a, 1))}><ChevronRight className="h-4 w-4" /></Button>
          <span className="text-sm font-semibold">{periodTitle(period, anchor)}</span>
          {q.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          <span className="text-xs text-muted-foreground">Cidade e marca: o filtro do topo.</span>
          <div role="group" aria-label="Ordenar o ranking" className="ml-auto inline-flex items-center gap-1 text-xs">
            <span className="text-muted-foreground">Ranking por</span>
            <Button size="sm" variant={mode === "perHour" ? "selected" : "outline"} onClick={() => setMode("perHour")}>pontos por hora</Button>
            <Button size="sm" variant={mode === "total" ? "selected" : "outline"} onClick={() => setMode("total")}>pontos</Button>
          </div>
        </CardContent>
      </Card>

      <Tabs value={group} onValueChange={(v) => setGroup(v as PerfGroup)}>
        <TabsList className="max-w-full justify-start overflow-x-auto">
          {PERF_GROUPS.map((g) => <TabsTrigger key={g.id} value={g.id}>{g.label}</TabsTrigger>)}
        </TabsList>
      </Tabs>

      {q.error ? <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="o desempenho" />
        : !d ? <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        : (<>
          {/* números grandes do grupo */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {view.cards.map((k) => (
              <Card key={k}><CardContent className="p-3">
                <div className="text-[11px] font-bold uppercase text-muted-foreground">{PERF_METRICS[k].label}</div>
                <div className="text-2xl font-bold tabular-nums">{fmt(k, d.groupTotals[k] ?? 0)}</div>
              </CardContent></Card>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* evolução no período */}
            {period !== "day" && (
              <Card>
                <CardHeader className="pb-1"><CardTitle className="text-base">Evolução ({period === "year" ? "por mês" : "por dia"})</CardTitle></CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={260}>
                    <LineChart data={chartData} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.4} />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                      <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={36} />
                      <Tooltip />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      {view.chart.map((k, i) => <Line key={k} type="monotone" dataKey={k} name={PERF_METRICS[k].label} stroke={SERIES[i]} strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 4 }} />)}
                    </LineChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}
            {/* ranking */}
            <Card className={period === "day" ? "lg:col-span-2" : undefined}>
              <CardHeader className="pb-1"><CardTitle className="text-base">Ranking — {mode === "perHour" ? "pontos por hora" : "pontos"}</CardTitle></CardHeader>
              <CardContent>
                {top.length === 0 ? <p className="py-10 text-center text-sm text-muted-foreground">Ninguém com {mode === "perHour" ? `pelo menos ${MIN_HOURS_FOR_RATE} h` : "pontos"} neste período.</p> : (
                  <ResponsiveContainer width="100%" height={Math.max(160, top.length * 24 + 30)}>
                    <BarChart data={top.map((r) => ({ name: r.name.split(" ").slice(0, 2).join(" "), v: mode === "perHour" ? r.perHour : r.points }))} layout="vertical" margin={{ left: 0, right: 16 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} opacity={0.4} />
                      <XAxis type="number" tick={{ fontSize: 11 }} />
                      <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11 }} />
                      <Tooltip formatter={(v: number) => [nf.format(v), mode === "perHour" ? "pontos por hora" : "pontos"]} />
                      <Bar dataKey="v" fill="var(--perf-1)" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>

          {/* 49e: a que horas cada um trabalha — grelha pessoa × hora */}
          <HourHeatmap people={ranked} groupByHour={d.groupByHour ?? []} groupByHourMultipark={d.groupByHourMultipark ?? []}
            hourly={d.hourly ?? { since: null, missingDays: 0 }} from={d.from} onOpen={setOpen} />

          {/* tabela: toda a gente, todas as colunas da aba (42c: todos os cabeçalhos ordenam) */}
          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-base">Toda a gente ({ranked.length})</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full min-w-[900px] text-[13px]">
                <thead>
                  <tr className="bg-muted text-left text-[11px] font-bold uppercase text-muted-foreground">
                    <Th k="rank" label="#" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} className="sticky left-0 bg-muted px-3" />
                    <Th k="name" label="Pessoa" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} className="sticky left-8 bg-muted px-3" />
                    <Th k="grade" label="Nota" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right" />
                    <Th k="points" label="Pontos" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right" />
                    <Th k="perHour" label="Por hora" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right" />
                    {view.columns.map((k) => <Th key={k} k={`totals.${k}`} label={<span title={`${PERF_METRICS[k].label} (${PERF_METRICS[k].source})`}>{PERF_METRICS[k].label}</span>} sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right" />)}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => (
                    <tr key={r.employeeId} className="cursor-pointer border-t hover:bg-muted/60" onClick={() => setOpen(r)} title="Ver o detalhe">
                      <td className="sticky left-0 bg-card px-3 py-1.5 tabular-nums">{r.rank <= 3 && r.grade > 0 ? <Medal className={`inline h-4 w-4 ${r.rank === 1 ? "text-amber-500" : r.rank === 2 ? "text-slate-400" : "text-amber-700"}`} aria-label={`${r.rank}.º`} /> : r.rank}</td>
                      <td className="sticky left-8 bg-card px-3 py-1.5">{nameCell(r)}</td>
                      <td className="px-2 py-1.5 text-right"><GradeBar grade={r.grade} /></td>
                      <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{nf.format(r.points)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.perHour == null ? "—" : nf.format(r.perHour)}</td>
                      {view.columns.map((k) => {
                        const v = r.totals[k] ?? 0;
                        return <td key={k} className={`px-2 py-1.5 text-right tabular-nums ${(PERF_METRICS[k].bad && v > 0) || v < 0 ? "font-semibold text-destructive" : v === 0 ? "text-muted-foreground" : ""}`}>{v === 0 ? "·" : fmt(k, v)}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          {TEAM_GROUPS.includes(group) && <TeamTable group={group} people={ranked} nameCell={nameCell} onOpen={setOpen} />}

          <PointsTable group={group} />

          <div className="space-y-1 text-xs text-muted-foreground">
            <p>Pontos = soma ponderada do que a aba mede (nos condutores e team leaders o trabalho na rua conta pelos pontos da avaliação). Por hora só com {MIN_HOURS_FOR_RATE} h ou mais (ponto; sem ponto, a escala). Nota = 100 para o melhor.</p>
            {d.speedLimit != null && <p>Limite de velocidade usado: {Math.round(d.speedLimit)} km/h (com a tolerância).</p>}
            <p>Emails: contam os enviados pela dashboard e os enviados da caixa Gmail pessoal de cada um (O meu email), cada email uma vez. Os enviados diretamente das caixas partilhadas (info@, reservas@…) fora da dashboard não têm autor e não contam.</p>
            {d.notes.map((n, i) => <p key={i}>{n}</p>)}
          </div>
        </>)}

      {open && d && <PersonDialog p={open} group={group} labels={d.bucketLabels} hourly={d.hourly ?? { since: null, missingDays: 0 }} from={d.from} onClose={() => setOpen(null)} />}
      <PersonLinksDialog employeeId={links?.employeeId ?? null} name={links?.name} open={!!links} onOpenChange={(o) => !o && setLinks(null)} />
    </div>
  );
}

/** 42c: a equipa de cada TL (o turno dele) ou supervisor (as cidades dele). */
function TeamTable({ group, people, nameCell, onOpen }: { group: PerfGroup; people: Person[]; nameCell: (r: Person) => React.ReactNode; onOpen: (p: Person) => void }) {
  const rows = useMemo(() => people.filter((p) => (p.totals.teamDays ?? 0) > 0).map((p) => ({
    ...p,
    perPersonDay: p.totals.teamPersonDays > 0 ? Math.round((p.totals.teamActions / p.totals.teamPersonDays) * 10) / 10 : null,
    costPerMove: p.totals.teamActions > 0 ? Math.round((p.totals.teamCost / p.totals.teamActions) * 100) / 100 : null,
  })), [people]);
  const { sorted, sortKey, sortDir, toggle } = useTableSort(rows, "totals.teamPoints", -1);
  const cols = TEAM_COLUMNS.filter((k) => group === "supervision" || (k !== "teamShortHours" && k !== "teamOverHours"));
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-base">A equipa {group === "teamleaders" ? "de cada team leader (o turno dele na escala)" : "de cada supervisor (as cidades dele)"}</CardTitle>
        <p className="text-xs text-muted-foreground">Movimentos = recolhas + entregas + movimentos da equipa. Custo como na Atividade do dia (horas × taxa do nível; o TL pelo salário). Sem Zello = pessoas que mexeram carros sem GPS nesse dia.{group === "supervision" ? " Extras a menos / a mais = horas·pessoa abaixo / acima da previsão do Extras Dia (só com Dia ou Semana)." : ""}</p>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        {sorted.length === 0 ? <p className="p-4 text-sm text-muted-foreground">Ninguém com equipa na escala neste período.</p> : (
          <table className="w-full min-w-[900px] text-[13px]">
            <thead>
              <tr className="bg-muted text-left text-[11px] font-bold uppercase text-muted-foreground">
                <Th k="name" label="Pessoa" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} className="sticky left-0 bg-muted px-3" />
                {cols.map((k) => <Th key={k} k={`totals.${k}`} label={PERF_METRICS[k].label} sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right" />)}
                <Th k="perPersonDay" label="Movimentos por pessoa·dia" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right" />
                <Th k="costPerMove" label="€ por movimento" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.employeeId} className="cursor-pointer border-t hover:bg-muted/60" onClick={() => onOpen(r)} title="Ver o detalhe">
                  <td className="sticky left-0 bg-card px-3 py-1.5">{nameCell(r)}</td>
                  {cols.map((k) => {
                    const v = r.totals[k] ?? 0;
                    return <td key={k} className={`px-2 py-1.5 text-right tabular-nums ${(PERF_METRICS[k].bad && v > 0) || v < 0 ? "font-semibold text-destructive" : v === 0 ? "text-muted-foreground" : ""}`}>{v === 0 ? "·" : fmt(k, v)}</td>;
                  })}
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.perPersonDay == null ? "—" : nf.format(r.perPersonDay)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.costPerMove == null ? "—" : eur.format(r.costPerMove)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

/** 42c: "uma tabela… que pontos é que tem cada coisa" — os pesos desta aba. */
function PointsTable({ group }: { group: PerfGroup }) {
  const weights = Object.entries(GROUP_VIEW[group].weights) as Array<[PerfMetric, number]>;
  const hasEval = weights.some(([k]) => k === "evalPoints");
  const hasTeam = weights.some(([k]) => k === "teamPoints");
  const w = TEAM_POINT_WEIGHTS;
  const row = (label: string, pts: string, note?: string) => (
    <tr key={label} className="border-t"><td className="px-3 py-1">{label}{note && <span className="ml-1 text-muted-foreground">({note})</span>}</td><td className="px-3 py-1 text-right font-semibold tabular-nums">{pts}</td></tr>
  );
  return (
    <Card>
      <details open>
        <summary className="cursor-pointer px-6 py-3 text-base font-semibold">Como se contam os pontos desta aba</summary>
        <CardContent className="grid gap-4 pt-0 md:grid-cols-2">
          <table className="w-full text-[13px]">
            <thead><tr className="bg-muted text-left text-[11px] font-bold uppercase text-muted-foreground"><th className="px-3 py-1.5">Cada…</th><th className="px-3 py-1.5 text-right">Pontos</th></tr></thead>
            <tbody>{weights.map(([k, v]) => row(PERF_METRICS[k].label, k === "evalPoints" || k === "teamPoints" ? "1 por ponto" : signed(v), PERF_METRICS[k].source))}</tbody>
          </table>
          <div className="space-y-4">
            {hasEval && (
              <table className="w-full text-[13px]">
                <thead><tr className="bg-muted text-left text-[11px] font-bold uppercase text-muted-foreground"><th className="px-3 py-1.5">Pontos da avaliação — cada…</th><th className="px-3 py-1.5 text-right">Pontos</th></tr></thead>
                <tbody>{EVALUATION_RULES.map((r) => row(r.label, signed(EVALUATION_POINTS[r.key])))}</tbody>
              </table>
            )}
            {hasTeam && (
              <table className="w-full text-[13px]">
                <thead><tr className="bg-muted text-left text-[11px] font-bold uppercase text-muted-foreground"><th className="px-3 py-1.5">Pontos da equipa — por dia, por pessoa da equipa</th><th className="px-3 py-1.5 text-right">Pontos</th></tr></thead>
                <tbody>
                  {row("Movimento da equipa (recolha, entrega ou movimento)", signed(w.actionsPerPerson), "a dividir pela equipa")}
                  {row("Pessoa que mexeu carros sem Zello", signed(w.noZelloPerPerson), "a dividir pela equipa")}
                  {row("Hora parada (GPS)", signed(w.stoppedHoursPerPerson), "a dividir pela equipa")}
                </tbody>
              </table>
            )}
            <p className="text-xs text-muted-foreground">Horas e km não dão pontos. "Por hora" = pontos ÷ horas trabalhadas (com {MIN_HOURS_FOR_RATE} h ou mais). Nota = 100 para o melhor.</p>
          </div>
        </CardContent>
      </details>
    </Card>
  );
}

function GradeBar({ grade }: { grade: number }) {
  return (
    <span className="inline-flex items-center gap-1.5" title={`${grade} em 100`}>
      <span className="inline-block h-1.5 w-14 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full" style={{ width: `${grade}%`, background: "var(--perf-1)" }} /></span>
      <span className="w-7 text-right tabular-nums">{grade}</span>
    </span>
  );
}

function PersonDialog({ p, group, labels, hourly, from, onClose }: { p: Person; group: PerfGroup; labels: string[]; hourly: HourlyInfo; from: string; onClose: () => void }) {
  const view = GROUP_VIEW[group];
  const data = labels.map((label, i) => Object.fromEntries([["label", label], ...view.chart.map((k) => [k, p.series[k]?.[i] ?? 0])]));
  const shown = (Object.keys(PERF_METRICS) as PerfMetric[]).filter((k) => (p.totals[k] ?? 0) !== 0);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="perf-viz max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{p.name}</DialogTitle></DialogHeader>
        <div className="flex flex-wrap gap-2 text-sm">
          <Badge variant="outline">{nf.format(p.points)} pontos</Badge>
          <Badge variant="outline">{p.perHour == null ? "sem horas suficientes" : `${nf.format(p.perHour)} pontos por hora`}</Badge>
        </div>
        {labels.length > 1 && (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={data} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.4} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={36} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {view.chart.map((k, i) => <Line key={k} type="monotone" dataKey={k} name={PERF_METRICS[k].label} stroke={SERIES[i]} strokeWidth={2} dot={{ r: 2 }} />)}
            </LineChart>
          </ResponsiveContainer>
        )}
        {/* 49e: a que horas trabalha */}
        <HourBars byHour={p.byHour ?? []} byHourMultipark={p.byHourMultipark ?? []} />
        <HourlyNote hourly={hourly} from={from} />
        {shown.length === 0 ? <p className="text-sm text-muted-foreground">Nada registado neste período.</p> : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {shown.map((k) => (
              <div key={k} className="rounded-md border p-2">
                <div className="text-[10px] font-bold uppercase text-muted-foreground">{PERF_METRICS[k].label}</div>
                <div className={`text-lg font-bold tabular-nums ${PERF_METRICS[k].bad ? "text-destructive" : ""}`}>{fmt(k, p.totals[k])}</div>
                <div className="text-[10px] text-muted-foreground">{PERF_METRICS[k].source}</div>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
