/**
 * Extras-Dia → separador "Pressão": quando é que a operação aperta.
 * Dados: trabalho diário `extras-pressure` (BD da Multipark desde
 * extras.timesSince — 22d: acumula —, guardados em ops_pressure_stats).
 * 22d: nas cidades também o tempo por carro de cada condutor, comparado com a
 * tabela máxima (D12). Regras: shared/extrasPressure.ts.
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, Flame, Gauge, Timer, TrafficCone } from "lucide-react";
import {
  CREW_MEASURE_MIN_SAMPLES, MIN_SAMPLE, WEEKDAY_SHORT, cycleAt, describeLoadEffect, extraCityGroupKey, isRushHour, loadComparison, pressureSummary,
  slotCycleAt, slotLoadPerDay, tightReason, tightThresholds, type CrewMeasureBand, type CyclePercentile, type PressureCrewRow,
  type PressureLoadRow, type PressureSlot,
} from "@shared/extrasPressure";

type Metric = "load" | "delivery" | "cycle" | "drive" | "crew";
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];
const fmt1 = (n: number | null | undefined) => (n == null ? "—" : String(Math.round(n * 10) / 10).replace(".", ","));
const fmt0 = (n: number | null | undefined) => (n == null ? "—" : String(Math.round(n)));
const ddmm = (d: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : "—");
const ddmmyyyy = (d: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "—");

/**
 * 44a: rampa ordinal de um só tom (validada: clara → escura). Quatro degraus
 * em vez de transparência contínua — os números estão escritos na célula.
 */
const RAMP = ["#86b6ef", "#5598e7", "#256abf", "#104281"] as const;
const rampIndex = (v: number, max: number) => Math.min(RAMP.length - 1, Math.floor((v / max) * RAMP.length - 1e-9));
function cellStyle(v: number | null, max: number): React.CSSProperties {
  if (v == null || v <= 0 || max <= 0) return {};
  const i = rampIndex(v, max);
  return { backgroundColor: RAMP[i], color: i >= 2 ? "#ffffff" : "#0f172a" };
}

/** 44a: as métricas, com nome claro e o que querem dizer. */
const METRICS: Array<{ key: Metric; label: string; short: string; city?: boolean }> = [
  { key: "load", label: "Carros por hora", short: "chegadas + saídas feitas" },
  { key: "delivery", label: "Tempo de entrega", short: "do pedido ao carro entregue" },
  { key: "cycle", label: "Tempo por carro", short: "de cada condutor", city: true },
  { key: "drive", label: "Na estrada", short: "do início da entrega a entregue", city: true },
  { key: "crew", label: "Pessoas a trabalhar", short: "média, com o TL", city: true },
];

const METRIC_HELP: Record<Metric, string> = {
  load: "Quantos carros se tratam nessa hora, em média por dia (chegadas + saídas concluídas). Mais escuro = mais carros.",
  delivery: "Minutos desde o cliente pedir o carro até o ter na mão. Mostra-se o p75: em 3 de cada 4 entregas demorou isto ou menos. Mais escuro = entregas mais lentas.",
  cycle: "Minutos entre o início de um serviço e o início do seguinte do mesmo condutor (inclui voltar, trânsito e esperas). Mostra-se o p{p}: em {p} % das vezes foi isto ou menos. Mais escuro = cada carro come mais tempo.",
  drive: "Minutos desde que o condutor arranca com a entrega até entregar. Mostra-se o p75: em 3 de cada 4 entregas foi isto ou menos. Mais escuro = mais tempo na estrada.",
  crew: "Pessoas diferentes a fazer serviços nessa hora, sempre a contar o team leader (média por dia). Mais escuro = mais gente.",
};

export function PressureTab({ city }: { city: "lisbon" | "porto" | "faro" }) {
  const q = trpc.extrasDia.pressure.useQuery(undefined, { staleTime: 10 * 60_000 });
  const [metric, setMetric] = useState<Metric>("load");
  const [cellKey, setCellKey] = useState<string | null>(null);
  const cityKey = extraCityGroupKey(city);
  const groups = q.data?.groups ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const group = picked && groups.some((g) => g.key === picked) ? picked : groups.find((g) => g.key === cityKey)?.key ?? groups[0]?.key ?? "";
  const groupLabel = groups.find((g) => g.key === group)?.label ?? "";
  const where = groupLabel.replace(/ \(todas as marcas\)$/, "");

  const slots = useMemo(() => (q.data?.slots ?? []).filter((s) => s.group === group) as PressureSlot[], [q.data, group]);
  const loads = useMemo(() => (q.data?.loads ?? []).filter((l) => l.group === group) as PressureLoadRow[], [q.data, group]);
  const byKey = useMemo(() => new Map(slots.map((s) => [`${s.weekday}:${s.hour}`, s])), [slots]);
  const thresholds = useMemo(() => tightThresholds(slots), [slots]);
  const summary = useMemo(() => pressureSummary(slots, where), [slots, where]);
  const loadRows = useMemo(() => loadComparison(loads), [loads]);
  const loadText = useMemo(() => describeLoadEffect(loads), [loads]);
  // 22d: só nas cidades (todas as marcas) há tempos por condutor.
  const cityInfo = (q.data?.cities ?? {})[group] as { percentile: CyclePercentile; bands: CrewMeasureBand[]; useMeasured?: boolean } | undefined;
  const pct: CyclePercentile = cityInfo?.percentile ?? 75;
  const crewRows = useMemo(() => (q.data?.crew ?? []).filter((c) => c.group === group) as PressureCrewRow[], [q.data, group]);
  const metricShown: Metric = !cityInfo && (metric === "cycle" || metric === "drive" || metric === "crew") ? "load" : metric;
  const stale = q.data?.stale?.[group];

  const value = (s: PressureSlot | undefined): number | null => {
    if (!s) return null;
    if (metricShown === "load") return slotLoadPerDay(s);
    if (metricShown === "cycle") return (s.cycleN ?? 0) >= MIN_SAMPLE ? slotCycleAt(s, pct) : null;
    if (metricShown === "drive") return (s.driveN ?? 0) >= MIN_SAMPLE ? s.driveP75 ?? null : null;
    if (metricShown === "crew") return s.crewAvg ?? null;
    return s.deliveryN >= MIN_SAMPLE ? s.deliveryP75 : null;
  };
  const max = Math.max(0, ...slots.map((s) => value(s) ?? 0));
  const unit = metricShown === "load" ? " carros" : metricShown === "crew" ? " pessoas" : " min";
  const fmtV = (v: number) => (metricShown === "load" || metricShown === "crew" ? fmt1(v) : fmt0(v));

  const detail = (wd: number, h: number): string[] => {
    const s = byKey.get(`${wd}:${h}`);
    const head = `${WEEKDAY_SHORT[wd]} ${String(h).padStart(2, "0")}h`;
    if (!s) return [`${head} — sem movimento`];
    const tight = tightReason(s, thresholds);
    return [
      head,
      `Carros/hora (média por dia): ${fmt1(slotLoadPerDay(s))} — ${fmt1(s.checkinsDone / Math.max(1, s.days))} chegadas, ${fmt1(s.checkoutsDone / Math.max(1, s.days))} saídas`,
      `Pedidos de entrega: ${fmt1(s.checkoutsStarted / Math.max(1, s.days))}/dia · recolhas começadas ${fmt1(s.checkinsStarted / Math.max(1, s.days))}/dia`,
      `Em simultâneo: média ${fmt1(s.concurrencyAvg)}, máx. ${fmt0(s.concurrencyMax)}`,
      `Entrega (n=${s.deliveryN}): mediana ${fmt0(s.deliveryP50)} · p75 ${fmt0(s.deliveryP75)} · p90 ${fmt0(s.deliveryP90)} min`,
      `Recolha (n=${s.pickupN}): mediana ${fmt0(s.pickupP50)} · p75 ${fmt0(s.pickupP75)} min`,
      cityInfo && (s.cycleN ?? 0) > 0 ? `Por carro, por condutor (n=${s.cycleN}): mediana ${fmt0(s.cycleP50)} · p${pct} ${fmt0(slotCycleAt(s, pct))} min` : "",
      cityInfo && (s.driveN ?? 0) > 0 ? `Na estrada (n=${s.driveN}): mediana ${fmt0(s.driveP50)} · p75 ${fmt0(s.driveP75)} min` : "",
      cityInfo && (s.toParkN ?? 0) > 0 ? `Recolhido → no parque (n=${s.toParkN}): mediana ${fmt0(s.toParkP50)} · p75 ${fmt0(s.toParkP75)} min` : "",
      cityInfo && s.crewAvg != null ? `Pessoas a trabalhar (média): ${fmt1(s.crewAvg)}` : "",
      tight ? `Hora apertada (top 20 %: ${[tight.load ? "muitos carros" : "", tight.delivery ? "entregas lentas" : ""].filter(Boolean).join(" e ")})` : "",
    ].filter(Boolean);
  };
  const [selWd, selH] = (cellKey ?? "").split(":").map(Number);
  const selected = cellKey ? detail(selWd, selH) : null;

  if (q.isLoading) return <div className="text-sm text-muted-foreground">A carregar a pressão…</div>;
  if (q.error) return <div className="text-sm text-red-600">Erro: {q.error.message}</div>;
  if (!q.data?.available || !groups.length) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          Ainda não há dados de pressão. O cálculo corre todos os dias a partir das 04:45 (trabalho <code>extras-pressure</code>, BD da Multipark desde abril de 2026);
          um super admin pode corrê-lo já em <code>/api/cron/extras-pressure</code>.
        </CardContent>
      </Card>
    );
  }

  const legend = max > 0
    ? RAMP.map((c, i) => ({ c, from: (max * i) / RAMP.length, to: (max * (i + 1)) / RAMP.length }))
    : [];

  return (
    <div className="space-y-4">
      {/* 44a: em cima, o que se está a ver — grupo e métrica, com botões grandes. */}
      <Card>
        <CardContent className="pt-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Select value={group} onValueChange={(v) => { setPicked(v); setCellKey(null); }}>
              <SelectTrigger className="w-64 h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {groups.map((g) => <SelectItem key={g.key} value={g.key}>{g.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Desde {ddmmyyyy(q.data.windowStart)} até {ddmm(q.data.windowEnd)} ({q.data.windowDays} dias), por hora de Lisboa.
              {q.data.computedAt && <> Calculado em {q.data.computedAt.slice(0, 16)} UTC.</>}
            </p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2" role="radiogroup" aria-label="O que mostrar no mapa">
            {METRICS.filter((m) => !m.city || cityInfo).map((m) => {
              const on = metricShown === m.key;
              return (
                <button
                  key={m.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setMetric(m.key)}
                  className={`rounded-md border px-3 py-2 text-left transition-colors ${on ? "border-blue-600 bg-blue-50 dark:bg-blue-950/40 ring-1 ring-blue-600" : "hover:bg-muted/60"}`}
                >
                  <span className="block text-sm font-medium">{m.label}</span>
                  <span className="block text-[11px] text-muted-foreground">{m.key === "cycle" ? `${m.short} (p${pct})` : m.short}</span>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {stale && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm">
          <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-700 shrink-0" />
          <span>
            {stale.part === "all"
              ? <>O último cálculo falhou em <strong>{where}</strong>: mostro os dados até {ddmm(stale.w)}.</>
              : <>O último cálculo dos tempos por condutor falhou em <strong>{where}</strong>: esses tempos são até {ddmm(stale.w)}.</>}
            {" "}Volta a tentar na próxima corrida (todos os dias a partir das 04:45).
          </span>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Gauge className="h-4 w-4" />{METRICS.find((m) => m.key === metricShown)?.label} — dia da semana × hora{where ? ` — ${where}` : ""}
          </CardTitle>
          <p className="text-sm text-muted-foreground">{METRIC_HELP[metricShown].replaceAll("{p}", String(pct))}</p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] table-fixed text-xs sm:text-sm border-separate" style={{ borderSpacing: 3 }}>
              <thead>
                <tr>
                  <th className="w-12"></th>
                  {HOURS.map((h) => (
                    <th key={h} className={`font-mono font-normal text-[11px] ${isRushHour(h) ? "text-amber-700 font-semibold" : "text-muted-foreground"}`}>{String(h).padStart(2, "0")}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {WEEKDAYS.map((wd) => (
                  <tr key={wd}>
                    <td className="pr-1 text-sm font-medium text-muted-foreground">{WEEKDAY_SHORT[wd]}</td>
                    {HOURS.map((h) => {
                      const key = `${wd}:${h}`;
                      const s = byKey.get(key);
                      const v = value(s);
                      const tight = tightReason(s, thresholds);
                      return (
                        <td
                          key={h}
                          title={detail(wd, h).join("\n")}
                          onClick={() => setCellKey(cellKey === key ? null : key)}
                          className={`h-12 md:h-14 text-center rounded tabular-nums cursor-pointer ${v == null ? "bg-muted/40 text-muted-foreground/60" : ""} ${tight ? "ring-2 ring-orange-500 ring-inset" : ""} ${cellKey === key ? "outline outline-2 outline-offset-1 outline-foreground" : ""}`}
                          style={cellStyle(v, max)}
                        >
                          {v == null ? "" : fmtV(v)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
            {legend.length > 0 && (
              <span className="flex items-center gap-1">
                {legend.map((l, i) => (
                  <span key={i} className="flex items-center gap-1">
                    <span className="inline-block h-3 w-5 rounded-sm" style={{ backgroundColor: l.c }} />
                    <span className="tabular-nums">{i === 0 ? "até" : ""} {fmtV(l.to)}{i === legend.length - 1 ? unit : ""}</span>
                  </span>
                ))}
              </span>
            )}
            <span className="flex items-center gap-1"><span className="inline-block h-3 w-5 rounded-sm bg-muted/40 border" /> sem dados (sem movimento ou menos de {MIN_SAMPLE} casos)</span>
            <span className="flex items-center gap-1"><span className="inline-block h-3 w-5 rounded-sm ring-2 ring-orange-500 ring-inset" /> hora apertada (top 20 %)</span>
            <span><span className="font-mono text-amber-700 font-semibold">07</span> = hora de ponta (07–10h, 17–20h)</span>
          </div>

          {selected ? (
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <strong>{selected[0]}</strong>
                <button type="button" className="text-xs text-muted-foreground hover:underline" onClick={() => setCellKey(null)}>fechar</button>
              </div>
              <ul className="mt-1 space-y-0.5 text-xs">{selected.slice(1).map((l, i) => <li key={i}>{l}</li>)}</ul>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Carrega numa célula (ou passa o rato) para ver o detalhe dessa hora.</p>
          )}

          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">O que é o p75 (e o p{pct})?</summary>
            <p className="mt-1">
              Ordena-se todos os casos dessa hora do mais rápido ao mais lento. O p75 é o valor a 75 % do caminho: em 3 de cada 4 vezes demorou isso ou menos, e só 1 em 4 demorou mais.
              Usa-se em vez da média para os dias maus contarem sem que um caso raro (um carro que ficou preso duas horas) estrague tudo. A mediana (p50) é o caso do meio.
            </p>
          </details>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Flame className="h-4 w-4 text-orange-600" />Onde aperta</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          {summary.length === 0 ? (
            <p className="text-muted-foreground">Sem movimento suficiente neste grupo.</p>
          ) : (
            <ul className="list-disc pl-5 space-y-0.5">{summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
          )}
          <p className="text-xs text-muted-foreground pt-1">
            "Apertada" = hora no top 20 % do grupo em carros/hora (≥ {fmt1(thresholds.load)}) ou em tempo de entrega p75 (≥ {fmt0(thresholds.deliveryP75)} min).
          </p>
        </CardContent>
      </Card>

      {cityInfo && <CrewCard bands={cityInfo.bands} rows={crewRows} pct={pct} where={where} useMeasured={!!cityInfo.useMeasured} />}

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><TrafficCone className="h-4 w-4" />Carga × tempo de entrega</CardTitle>
          <p className="text-xs text-muted-foreground">
            Cada entrega fica no escalão dos carros tratados nessa hora (no grupo). Ponta = 07–10h e 17–20h (aproximação do trânsito).
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {loadText.length > 0 && <ul className="text-sm list-disc pl-5">{loadText.map((t, i) => <li key={i}>{t}</li>)}</ul>}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs uppercase text-muted-foreground">
                  <th className="text-left py-2 px-2">Carros nessa hora</th>
                  <th className="text-right py-2 px-2">Ponta: n</th>
                  <th className="text-right py-2 px-2">mediana</th>
                  <th className="text-right py-2 px-2">p75</th>
                  <th className="text-right py-2 px-2">p90</th>
                  <th className="text-right py-2 px-2">Resto: n</th>
                  <th className="text-right py-2 px-2">mediana</th>
                  <th className="text-right py-2 px-2">p75</th>
                  <th className="text-right py-2 px-2">p90</th>
                </tr>
              </thead>
              <tbody>
                {loadRows.map((r) => (
                  <tr key={r.loadBucket} className="border-b">
                    <td className="py-1.5 px-2">{r.label}</td>
                    {[r.rush, r.rest].map((x, i) => (
                      <FragmentCells key={i} row={x} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">Minutos. Com menos de {MIN_SAMPLE} entregas o valor é pouco fiável.</p>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * 22d: tempo por carro de cada condutor, medido, por número de pessoas a
 * trabalhar (TL incluído) — horas cheias (cada pessoa teve pelo menos um
 * serviço) e horas calmas — ao lado do máximo da tabela (Definições, D12).
 */
function CrewCard({ bands, rows, pct, where, useMeasured }: { bands: CrewMeasureBand[]; rows: PressureCrewRow[]; pct: CyclePercentile; where: string; useMeasured: boolean }) {
  const cell = (r: PressureCrewRow | undefined) => {
    if (!r || r.n === 0) return <span className="text-muted-foreground">—</span>;
    const v = cycleAt(r, pct);
    return (
      <span className={`block ${r.n < MIN_SAMPLE ? "text-muted-foreground" : ""}`}>
        <span className="font-medium tabular-nums">{fmt0(v)}</span><span className="text-[11px]"> min</span>
        <span className="block text-[11px] text-muted-foreground tabular-nums">n={r.n}</span>
      </span>
    );
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Timer className="h-4 w-4" />Tempo por carro, por condutor{where ? ` — ${where}` : ""}</CardTitle>
        <p className="text-xs text-muted-foreground">
          Do início de um serviço (início da entrega ou da recolha) ao início do serviço seguinte do mesmo condutor: inclui o regresso, o trânsito e as esperas.
          Valor p{pct}: em {pct === 50 ? "metade" : `${pct} %`} das vezes foi isto ou menos. Pessoas = agentes diferentes a trabalhar nessa hora, sempre com o TL (se não carregou em nada nessa hora, junta-se 1).
        </p>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs uppercase text-muted-foreground">
                <th className="text-left py-2 px-1 sm:px-2">Pessoas</th>
                <th className="text-right py-2 px-1 sm:px-2">Horas cheias</th>
                <th className="text-right py-2 px-1 sm:px-2">Horas calmas</th>
                <th className="text-right py-2 px-1 sm:px-2" title="Máximo da tabela (Definições → Tempo por carro conforme as pessoas no turno)">Máximo</th>
              </tr>
            </thead>
            <tbody>
              {bands.map((b) => (
                <tr key={b.index} className="border-b">
                  <td className="py-1.5 px-1 sm:px-2">{b.label}</td>
                  <td className="py-1.5 px-1 sm:px-2 text-right">{cell(rows.find((r) => r.band === b.index && r.busy))}</td>
                  <td className="py-1.5 px-1 sm:px-2 text-right">{cell(rows.find((r) => r.band === b.index && !r.busy))}</td>
                  <td className="py-1.5 px-1 sm:px-2 text-right tabular-nums">{b.maxMinutes == null ? <span className="text-muted-foreground">—</span> : <>{b.maxMinutes}<span className="text-[11px]"> min</span></>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Máximo = a tabela das Definições (tempo por carro conforme as pessoas no turno). Horas cheias = cada pessoa teve pelo menos um serviço começado nessa hora; é aí que se vê a capacidade. Nas horas calmas o intervalo inclui esperar por trabalho.
          Uma entrega com recolha pelo meio (a recolha começa até 30 min depois de entregar) conta como um só serviço.
          A cinzento: menos de {MIN_SAMPLE} serviços.{" "}
          {useMeasured
            ? <>A escala usa o valor das horas cheias, quando há pelo menos {CREW_MEASURE_MIN_SAMPLES} serviços, e nunca acima do máximo (Definições → Parâmetros → Escala com os tempos medidos).</>
            : <>Por agora só se mede: a escala continua a usar a tabela máxima. Para a escala usar estes tempos (nunca acima do máximo), liga em Definições → Parâmetros → Escala com os tempos medidos.</>}
        </p>
      </CardContent>
    </Card>
  );
}

function FragmentCells({ row }: { row: PressureLoadRow | null }) {
  const weak = !row || row.deliveryN < MIN_SAMPLE;
  const cls = `py-1.5 px-2 text-right tabular-nums ${weak ? "text-muted-foreground" : ""}`;
  return (
    <>
      <td className={cls}>{row?.deliveryN ?? 0}</td>
      <td className={cls}>{fmt0(row?.deliveryP50)}</td>
      <td className={cls}>{fmt0(row?.deliveryP75)}</td>
      <td className={cls}>{fmt0(row?.deliveryP90)}</td>
    </>
  );
}

/** Pequena etiqueta para a escala do dia. */
export function TightHourBadge({ reason }: { reason: { load: boolean; delivery: boolean } }) {
  const why = [reason.load ? "muitos carros" : "", reason.delivery ? "entregas lentas" : ""].filter(Boolean).join(" e ");
  return (
    <Badge variant="outline" className="ml-2 h-5 py-0 text-[10px] border-orange-300 text-orange-700" title={`Desde abril de 2026 esta hora está no top 20 % (${why}).`}>
      hora apertada
    </Badge>
  );
}
