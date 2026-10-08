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
 *
 * Pesos (Jorge, 8 out 2026: "avança com os pesos do ranking"): a tabela
 * "Como se contam os pontos" mostra os pesos EM VIGOR e tem o Editar pesos
 * (grava a definição `perf.rankWeights`).
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { lisbonDayOf } from "@shared/lisbonDay";
import {
  GROUP_VIEW, PERF_GROUPS, PERF_METRICS, PERF_PERIODS, periodTitle, rankPeople, shiftAnchor, MIN_HOURS_FOR_RATE,
  TEAM_COLUMNS, TEAM_GROUPS, TEAM_POINT_WEIGHTS, TEAM_WEIGHT_KEYS, TEAM_WEIGHT_LABELS, UNWEIGHTED_METRICS, PERF_RANK_WEIGHTS_KEY,
  rankWeightSchema, rankWeightsSchema, teamWeightOverridesOf, weightOverridesOf, withTabOverrides,
  type PerfGroup, type PerfMetric, type PerfPeriod, type RankMode, type RankWeightOverrides, type TeamPointWeights,
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { toast } from "sonner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChevronLeft, ChevronRight, Link2, Loader2, Medal, Pencil, Plus, RotateCcw, Save, X } from "lucide-react";

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

          {/* 8 out 2026: os pesos em vigor e o editor (a aba dos dados que chegaram, não a do separador a carregar) */}
          <PointsTable key={d.group} group={d.group} rw={d.rankWeights} />

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

/** Pesos em vigor que o servidor manda com o desempenho (8 out 2026). */
type RankWeightsView = {
  weights: Partial<Record<PerfMetric, number>>; team: TeamPointWeights; overrides: RankWeightOverrides;
  updatedAt: string | null; updatedByName: string | null; readable: boolean;
};

const weightText = (v: number | undefined) => (v == null ? "" : String(v).replace(".", ","));
/** Texto do input → número (vírgula ou ponto); vazio ou lixo → null. */
const weightOf = (txt: string | undefined): number | null => {
  const t = String(txt ?? "").trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/**
 * 42c: "uma tabela… que pontos é que tem cada coisa" — os pesos desta aba.
 * 8 out 2026 (Jorge: "avança com os pesos do ranking"): os pesos em vigor
 * (omissões + `perf.rankWeights`) e o editor — Editar pesos → cada linha
 * passa a número (0 = não conta; dá para acrescentar uma coluna da aba que
 * não conta), mais os 3 da equipa nas abas com equipa; Guardar grava pela
 * mesma rota das Definições (histórico com quem e quando), Repor omissões da
 * aba, Cancelar. Ao guardar, o ranking recarrega.
 */
function PointsTable({ group, rw }: { group: PerfGroup; rw: RankWeightsView }) {
  const utils = trpc.useUtils();
  const defaults = GROUP_VIEW[group].weights;
  const showTeam = TEAM_GROUPS.includes(group);
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [teamDraft, setTeamDraft] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState("");
  const [error, setError] = useState<string | null>(null);
  const editing = draft != null;
  const stop = () => { setDraft(null); setTeamDraft({}); setAdding(""); setError(null); };
  const save = trpc.settings.values.set.useMutation({
    onSuccess: (r) => {
      toast.success(r.changed ? "Pesos guardados: o ranking já conta com eles." : "Sem alterações.");
      stop();
      utils.evaluation.peoplePerformance.invalidate();
    },
    onError: (e) => {
      toast.error(e.message);
      // outra pessoa gravou entretanto → recarrega (o que estavas a editar fica descartado)
      if (e.data?.code === "CONFLICT") { stop(); utils.evaluation.peoplePerformance.invalidate(); }
    },
  });

  const fill = (w: Partial<Record<PerfMetric, number>>, t: TeamPointWeights) => {
    setDraft(Object.fromEntries(Object.entries(w).map(([k, v]) => [k, weightText(v)])));
    setTeamDraft(Object.fromEntries(TEAM_WEIGHT_KEYS.map((k) => [k, weightText(t[k])])));
    setAdding("");
    setError(null);
  };
  const startEdit = () => fill(rw.weights, rw.team);
  /** Repor omissões da aba: só no ecrã — fica gravado com Guardar. */
  const resetDefaults = () => fill(defaults, TEAM_POINT_WEIGHTS);

  const parse = (label: string, txt: string | undefined): number | string => {
    if (String(txt ?? "").trim() === "") return `${label}: escreve um número (0 = não conta).`;
    const r = rankWeightSchema.safeParse(weightOf(txt) ?? Number.NaN);
    return r.success ? r.data : `${label}: ${r.error.issues[0]?.message ?? "peso inválido."}`;
  };
  const submit = () => {
    if (!draft) return;
    if (!rw.readable) { setError("Não deu para ler os pesos gravados agora: recarrega antes de gravar."); return; }
    const edited: Partial<Record<PerfMetric, number>> = {};
    for (const [k, txt] of Object.entries(draft) as Array<[PerfMetric, string]>) {
      const v = parse(PERF_METRICS[k]?.label ?? k, txt);
      if (typeof v === "string") { setError(v); return; }
      edited[k] = v;
    }
    let team: Partial<TeamPointWeights> | undefined;
    if (showTeam) {
      const t: Partial<TeamPointWeights> = {};
      for (const k of TEAM_WEIGHT_KEYS) {
        const v = parse(`Equipa — ${TEAM_WEIGHT_LABELS[k]}`, teamDraft[k]);
        if (typeof v === "string") { setError(v); return; }
        t[k] = v;
      }
      team = teamWeightOverridesOf(t);
    }
    const next = withTabOverrides(rw.overrides, group, weightOverridesOf(group, edited), team);
    const valid = rankWeightsSchema.safeParse(next);
    if (!valid.success) { setError(valid.error.issues.map((i) => i.message).join(" ")); return; }
    setError(null);
    save.mutate({ key: PERF_RANK_WEIGHTS_KEY, value: next, expectedUpdatedAt: rw.updatedAt });
  };

  const pointsText = (k: PerfMetric, v: number) => (v === 0 ? "0 (não conta)" : k === "evalPoints" || k === "teamPoints" ? `${nf.format(v)} por ponto` : signed(v));
  const defaultText = (k: PerfMetric) => (defaults[k] == null ? "não conta" : pointsText(k, defaults[k] as number));
  const changedBadge = (changed: boolean, def: string) => changed
    ? <Badge variant="outline" className="ml-1 border-amber-500 px-1 py-0 text-[10px] text-amber-700 dark:text-amber-300" title={`Omissão: ${def}`}>alterado</Badge>
    : null;
  const keys = (editing ? Object.keys(draft) : Object.keys(rw.weights)) as PerfMetric[];
  const shownEval = editing ? (weightOf(draft.evalPoints) ?? 0) !== 0 : (rw.weights.evalPoints ?? 0) !== 0;
  const addable = editing ? GROUP_VIEW[group].columns.filter((k) => !(k in draft) && !UNWEIGHTED_METRICS.has(k)) : [];
  const missedOff = GROUP_VIEW[group].columns.includes("callsMissed") && !(rw.weights.callsMissed ?? 0);

  const cell = (k: string, txt: string | undefined, onChange: (v: string) => void, label: string) => (
    <Input value={txt ?? ""} onChange={(e) => onChange(e.target.value)} inputMode="decimal" aria-label={`Peso: ${label}`}
      className="ml-auto h-7 w-20 text-right tabular-nums" data-weight={k} />
  );
  const headRow = (title: string) => (
    <thead><tr className="bg-muted text-left text-[11px] font-bold uppercase text-muted-foreground"><th className="px-3 py-1.5">{title}</th><th className="px-3 py-1.5 text-right">Pontos</th></tr></thead>
  );
  const row = (label: string, pts: React.ReactNode, note?: string, extra?: React.ReactNode) => (
    <tr key={label} className="border-t"><td className="px-3 py-1">{label}{note && <span className="ml-1 text-muted-foreground">({note})</span>}{extra}</td><td className="px-3 py-1 text-right font-semibold tabular-nums">{pts}</td></tr>
  );

  return (
    <Card>
      <details open>
        <summary className="cursor-pointer px-6 py-3 text-base font-semibold">Como se contam os pontos desta aba</summary>
        <CardContent className="space-y-3 pt-0">
          <div className="flex flex-wrap items-center gap-2">
            {!editing ? (
              <Button size="sm" variant="outline" onClick={startEdit} disabled={!rw.readable}
                title={rw.readable ? "Mudar quanto vale cada coisa nesta aba (sem deploy)" : "Não deu para ler os pesos gravados agora"}>
                <Pencil className="mr-1 h-4 w-4" />Editar pesos
              </Button>
            ) : (
              <>
                <Button size="sm" onClick={submit} disabled={save.isPending}>
                  {save.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}Guardar
                </Button>
                <Button size="sm" variant="outline" onClick={resetDefaults} disabled={save.isPending} title="Põe no ecrã os pesos do código desta aba (e os da equipa); fica gravado com Guardar">
                  <RotateCcw className="mr-1 h-4 w-4" />Repor omissões da aba
                </Button>
                <Button size="sm" variant="ghost" onClick={stop} disabled={save.isPending}><X className="mr-1 h-4 w-4" />Cancelar</Button>
              </>
            )}
            <span className="text-xs text-muted-foreground">
              {rw.updatedAt ? `Pesos mudados por ${rw.updatedByName ?? "—"} · ${fmtPTDateTime(rw.updatedAt)} (histórico em Definições → Parâmetros).` : "Pesos por omissão do código."}
            </span>
          </div>
          {editing && <p className="text-xs text-muted-foreground">Escreve quanto vale cada coisa (ex.: 0,5). 0 = não conta; negativo = desconta. Os pontos da equipa valem para os team leaders e para a supervisão.</p>}
          {error && <p className="text-sm font-semibold text-destructive" role="alert">{error}</p>}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <table className="w-full text-[13px]">
                {headRow("Cada…")}
                <tbody>{keys.map((k) => {
                  const label = PERF_METRICS[k]?.label ?? k;
                  if (!editing) {
                    const v = rw.weights[k] ?? 0;
                    return row(label, pointsText(k, v), PERF_METRICS[k]?.source, changedBadge((defaults[k] ?? 0) !== v, defaultText(k)));
                  }
                  const live = weightOf(draft[k]);
                  return row(label, cell(k, draft[k], (t) => setDraft((d) => ({ ...(d ?? {}), [k]: t })), label), PERF_METRICS[k]?.source,
                    <>{changedBadge(live != null && (defaults[k] ?? 0) !== live, defaultText(k))}<span className="ml-1 text-[11px] text-muted-foreground">omissão: {defaultText(k)}</span></>);
                })}</tbody>
              </table>
              {editing && addable.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={adding} onValueChange={setAdding}>
                    <SelectTrigger className="h-8 w-64 text-xs" aria-label="Acrescentar uma coluna da aba que não conta"><SelectValue placeholder="Acrescentar uma coluna que não conta…" /></SelectTrigger>
                    <SelectContent>{addable.map((k) => <SelectItem key={k} value={k}>{PERF_METRICS[k].label}</SelectItem>)}</SelectContent>
                  </Select>
                  <Button size="sm" variant="outline" disabled={!adding}
                    onClick={() => { setDraft((d) => ({ ...(d ?? {}), [adding]: "1" })); setAdding(""); }}><Plus className="mr-1 h-4 w-4" />Acrescentar</Button>
                </div>
              )}
              {missedOff && <p className="text-xs text-muted-foreground">Chamadas perdidas: aparecem mas não contam (a chamada toca em várias consolas).</p>}
            </div>
            <div className="space-y-4">
              {shownEval && (
                <table className="w-full text-[13px]">
                  {headRow("Pontos da avaliação — cada…")}
                  <tbody>{EVALUATION_RULES.map((r) => row(r.label, signed(EVALUATION_POINTS[r.key])))}</tbody>
                </table>
              )}
              {showTeam && (
                <table className="w-full text-[13px]">
                  {headRow("Pontos da equipa — por dia, por pessoa da equipa")}
                  <tbody>{TEAM_WEIGHT_KEYS.map((k) => {
                    const def = signed(TEAM_POINT_WEIGHTS[k]);
                    if (!editing) return row(TEAM_WEIGHT_LABELS[k], signed(rw.team[k]), "a dividir pela equipa", changedBadge(rw.team[k] !== TEAM_POINT_WEIGHTS[k], def));
                    const live = weightOf(teamDraft[k]);
                    return row(TEAM_WEIGHT_LABELS[k], cell(k, teamDraft[k], (t) => setTeamDraft((d) => ({ ...d, [k]: t })), TEAM_WEIGHT_LABELS[k]), "a dividir pela equipa",
                      <>{changedBadge(live != null && live !== TEAM_POINT_WEIGHTS[k], def)}<span className="ml-1 text-[11px] text-muted-foreground">omissão: {def}</span></>);
                  })}</tbody>
                </table>
              )}
              <p className="text-xs text-muted-foreground">1 ponto ≈ 5 minutos de trabalho, a mesma escala da avaliação (recolha ou entrega +3, movimento +2, levar ao parque +5). Horas e km não dão pontos. "Por hora" = pontos ÷ horas trabalhadas (com {MIN_HOURS_FOR_RATE} h ou mais). Nota = 100 para o melhor.</p>
            </div>
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
