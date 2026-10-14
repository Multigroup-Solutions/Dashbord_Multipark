/**
 * Tempos de um condutor (Q7, Jorge 14 out 2026) — Condutores e agentes →
 * condutor e Desempenho → detalhe: Fila, Trânsito, Cliente, no terminal e P2,
 * por semana, mês e 6 meses, ao lado dos colegas da mesma cidade e do mesmo
 * tipo de serviço, e a evolução num gráfico (ele a azul, os colegas a
 * cinzento: forma de ênfase, paleta .times-viz validada nos dois modos). Só
 * informação: não dá pontos. Abaixo do mínimo: "sem dados suficientes".
 * Os números chegam já com o portão dos tempos com GPS aplicado (servidor).
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { Badge } from "@/components/ui/badge";
import { Info, Lock, Timer } from "lucide-react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CalibrationBadge, fmtDur } from "@/components/serviceTimes/TimesBits";
import type { DriverMetric } from "@shared/serviceTimes";

const PERIOD_LABEL: Record<string, string> = { semana: "Última semana", mes: "Último mês", "6meses": "Últimos 6 meses" };
const SERVICE_LABEL: Record<string, string> = { t1: "T1", t2: "T2", vip: "VIP", other: "Outro", unknown: "sem tipo", todos: "todos" };
const CITY_LABEL: Record<string, string> = { lisboa: "Lisboa", porto: "Porto", faro: "Faro" };
const METRIC_SHORT: Record<string, string> = {
  fila: "Da chamada (ou do pendente) até pegar no carro.",
  transito: "De pegar no carro até chegar ao terminal (GPS).",
  cliente: "Nas entregas em que fez o check-out: a espera pelo cliente no terminal.",
  terminal: "Nas recolhas que tirou do terminal: do check-in até o carro sair de lá.",
  p2: "Nas recolhas que tirou do P2: quanto tempo o carro lá esteve.",
};
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const periodTick = (p: string) => (p.length === 7 ? `${MONTHS[Number(p.slice(5, 7)) - 1]} ${p.slice(2, 4)}` : `${p.slice(8, 10)}/${p.slice(5, 7)}`);
const toMin = (ms: number | null | undefined) => (ms == null ? null : Math.round((ms / 60_000) * 10) / 10);

function Delta({ ms }: { ms: number | null }) {
  if (ms == null) return <span className="text-muted-foreground">—</span>;
  const m = Math.round(ms / 60_000);
  if (m === 0) return <span className="text-muted-foreground tabular-nums">igual</span>;
  return <span className={`tabular-nums ${m > 0 ? "text-amber-700 dark:text-amber-400 font-semibold" : "text-emerald-700 dark:text-emerald-400"}`}>{m > 0 ? `+${m}` : m} min</span>;
}

type Point = { period: string; n: number; p50Ms: number | null; meanMs: number | null; peersN: number; peersP50Ms: number | null; gpsHidden: string | null };

/** Tooltip: o valor primeiro, a série a seguir, com a linha da cor da série. */
function ChartTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload as { period: string; me: number | null; peers: number | null; n: number; peersN: number } | undefined;
  if (!p) return null;
  return (
    <div className="rounded-[10px] border bg-popover px-3 py-2 text-xs shadow-sm">
      <p className="font-medium mb-1">{periodTick(String(label))}</p>
      <p className="flex items-center gap-2"><span className="inline-block h-0.5 w-4 rounded" style={{ background: "var(--times-me)" }} /><b className="tabular-nums">{p.me == null ? "sem dados suficientes" : `${p.me} min`}</b><span className="text-muted-foreground">ele (n={p.n})</span></p>
      <p className="flex items-center gap-2"><span className="inline-block h-0.5 w-4 rounded" style={{ background: "var(--times-peers)" }} /><b className="tabular-nums">{p.peers == null ? "sem dados suficientes" : `${p.peers} min`}</b><span className="text-muted-foreground">colegas (n={p.peersN})</span></p>
    </div>
  );
}

export function DriverTimesCard({ employeeId, name, compact }: { employeeId: number; name?: string | null; compact?: boolean }) {
  const q = trpc.reviews.driverTimes.useQuery({ employeeId }, { staleTime: 5 * 60_000, refetchOnWindowFocus: false, retry: false });
  const d = q.data;
  const [metric, setMetric] = useState<DriverMetric>("fila");
  const [bucket, setBucket] = useState<"monthly" | "weekly">("monthly");
  const [table, setTable] = useState(false);
  const m = d?.metrics.find((x) => x.metric === metric) ?? d?.metrics[0];
  const series: Point[] = (m?.[bucket] ?? []) as Point[];
  const data = useMemo(() => series.map((p) => ({ period: p.period, me: toMin(p.p50Ms), peers: toMin(p.peersP50Ms), n: p.n, peersN: p.peersN })), [series]);
  const hiddenSeries = series.length > 0 && series.every((p) => p.gpsHidden) ? series[0].gpsHidden : null;
  const gpsNote = m ? Object.values(m.periods).flat().find((s) => s.gpsLabel)?.gpsLabel ?? null : null;
  const last = [...data].reverse().find((x) => x.me != null);

  return (
    <section className={`times-viz rounded-[14px] border bg-card ${compact ? "p-3" : "p-4"} space-y-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold flex items-center gap-2"><Timer className="w-4 h-4 text-[#0055D2]" />Tempos{name ? ` de ${name}` : ""}</h3>
        <span className="text-[11px] text-muted-foreground flex items-center gap-1"><Info className="w-3.5 h-3.5" />Só informação: não dá pontos.</span>
      </div>
      {q.isLoading ? <p className="text-sm text-muted-foreground">A ler os tempos…</p>
        : q.error ? <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="os tempos deste condutor" />
        : !d || !m ? null
        : !d.hasRows ? (
          <p className="text-sm text-muted-foreground">Sem tempos deste condutor nos últimos 6 meses{d.available ? "" : " (a tabela dos tempos ainda está vazia: o cálculo da noite está desligado ou ainda não correu)"}.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Que tempo">
              {d.metrics.map((x) => (
                <button key={x.metric} type="button" role="radio" aria-checked={x.metric === m.metric} onClick={() => setMetric(x.metric)}
                  className={`h-8 rounded-[10px] border px-3 text-xs transition-colors ${x.metric === m.metric ? "border-[#0055D2] bg-[#0055D2] text-white" : "hover:bg-muted/60"}`}>
                  {x.metric === "cliente" ? "Cliente" : x.metric === "terminal" ? "No terminal" : x.metric === "p2" ? "No P2" : x.metric === "fila" ? "Fila" : "Trânsito"}{x.gps ? " · GPS" : ""}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">{METRIC_SHORT[m.metric]} Colegas = os outros condutores da mesma cidade e do mesmo serviço (T1, T2, VIP, Outro), sem ele. Mínimo {d.minN} medições por linha; abaixo disso, "sem dados suficientes".</p>
            <CalibrationBadge note={gpsNote} />

            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-xs min-w-[34rem]">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="p-1.5">Período</th><th className="p-1.5">Onde</th>
                    <th className="p-1.5 text-right">n</th><th className="p-1.5 text-right">Média</th><th className="p-1.5 text-right">Mediana</th><th className="p-1.5 text-right">p75</th>
                    <th className="p-1.5 text-right">Colegas (mediana)</th><th className="p-1.5 text-right">Diferença</th>
                  </tr>
                </thead>
                <tbody>
                  {(["semana", "mes", "6meses"] as const).map((p) => {
                    const list = m.periods[p];
                    if (!list.length) return <tr key={p} className="border-b"><td className="p-1.5 font-medium whitespace-nowrap">{PERIOD_LABEL[p]}</td><td className="p-1.5 text-muted-foreground" colSpan={7}>sem casos neste período</td></tr>;
                    return list.map((s, i) => (
                      <tr key={`${p}-${s.cityKey}-${s.serviceType}`} className="border-b align-top">
                        <td className="p-1.5 font-medium whitespace-nowrap">{i === 0 ? PERIOD_LABEL[p] : ""}</td>
                        <td className="p-1.5 whitespace-nowrap">{CITY_LABEL[s.cityKey ?? ""] ?? s.cityKey ?? "—"} · {SERVICE_LABEL[s.serviceType] ?? s.serviceType}</td>
                        <td className="p-1.5 text-right tabular-nums">{s.n}</td>
                        {s.gpsHidden ? (
                          <td className="p-1.5 text-muted-foreground" colSpan={5}><span className="inline-flex items-center gap-1"><Lock className="w-3 h-3" />{s.gpsHidden}</span></td>
                        ) : !s.enough ? (
                          <td className="p-1.5 text-muted-foreground" colSpan={5}>sem dados suficientes (n = {s.n}, mínimo {d.minN})</td>
                        ) : (
                          <>
                            <td className="p-1.5 text-right tabular-nums">{fmtDur(s.meanMs)}</td>
                            <td className="p-1.5 text-right tabular-nums font-semibold">{fmtDur(s.p50Ms)}</td>
                            <td className="p-1.5 text-right tabular-nums">{fmtDur(s.p75Ms)}</td>
                            <td className="p-1.5 text-right tabular-nums">{s.peers.p50Ms != null ? <>{fmtDur(s.peers.p50Ms)} <span className="text-muted-foreground">({s.peers.drivers} cond.)</span></> : <span className="text-muted-foreground">sem dados suficientes</span>}</td>
                            <td className="p-1.5 text-right"><Delta ms={s.deltaP50Ms} /></td>
                          </>
                        )}
                      </tr>
                    ));
                  })}
                </tbody>
              </table>
            </div>

            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold">Evolução — mediana dele e dos colegas</p>
                <div className="inline-flex rounded-[10px] border p-0.5" role="radiogroup" aria-label="Por semana ou por mês">
                  {([["monthly", "Por mês"], ["weekly", "Por semana"]] as const).map(([k, l]) => (
                    <button key={k} type="button" role="radio" aria-checked={bucket === k} onClick={() => setBucket(k)}
                      className={`h-7 rounded-[8px] px-2.5 text-xs ${bucket === k ? "bg-[#0E2957] text-white" : "hover:bg-muted/60"}`}>{l}</button>
                  ))}
                </div>
              </div>
              {hiddenSeries ? (
                <p className="text-sm text-muted-foreground flex items-center gap-1"><Lock className="w-4 h-4" />{hiddenSeries}</p>
              ) : data.length === 0 ? (
                <p className="text-xs text-muted-foreground">Sem casos para o gráfico.</p>
              ) : (
                <>
                  <div className="h-[220px] w-full" role="img" aria-label={`Mediana de ${m.label} por ${bucket === "monthly" ? "mês" : "semana"}: ele e os colegas`}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={data} margin={{ top: 12, right: 40, left: -8, bottom: 0 }}>
                        <CartesianGrid vertical={false} stroke="var(--border)" strokeWidth={1} />
                        <XAxis dataKey="period" tickFormatter={periodTick} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} stroke="var(--border)" interval="preserveStartEnd" />
                        <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} stroke="var(--border)" width={40} allowDecimals={false} unit=" min" />
                        <Tooltip content={<ChartTip />} cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1 }} />
                        <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-foreground">{v}</span>} />
                        <Line type="monotone" dataKey="peers" name="Colegas" stroke="var(--times-peers)" strokeWidth={2} dot={{ r: 4, strokeWidth: 2, stroke: "var(--card)", fill: "var(--times-peers)" }} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />
                        <Line type="monotone" dataKey="me" name={name ?? "Ele"} stroke="var(--times-me)" strokeWidth={2} dot={{ r: 4, strokeWidth: 2, stroke: "var(--card)", fill: "var(--times-me)" }} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  {last && <p className="text-[11px] text-muted-foreground">Último {bucket === "monthly" ? "mês" : "semana"} com dados ({periodTick(last.period)}): ele <b className="text-foreground">{last.me} min</b>{last.peers != null ? <> · colegas <b className="text-foreground">{last.peers} min</b></> : null}. Pontos em falta = menos medições do que o mínimo.</p>}
                  <button type="button" className="text-xs text-primary underline underline-offset-2" onClick={() => setTable((t) => !t)}>{table ? "Esconder a tabela" : "Ver em tabela"}</button>
                  {table && (
                    <div className="overflow-x-auto -mx-1">
                      <table className="w-full text-xs min-w-[22rem]">
                        <thead><tr className="border-b text-left text-muted-foreground"><th className="p-1">{bucket === "monthly" ? "Mês" : "Semana"}</th><th className="p-1 text-right">Ele (mediana)</th><th className="p-1 text-right">n</th><th className="p-1 text-right">Colegas (mediana)</th><th className="p-1 text-right">n</th></tr></thead>
                        <tbody>{data.map((p) => (
                          <tr key={p.period} className="border-b"><td className="p-1">{periodTick(p.period)}</td><td className="p-1 text-right tabular-nums">{p.me == null ? "—" : `${p.me} min`}</td><td className="p-1 text-right tabular-nums">{p.n}</td><td className="p-1 text-right tabular-nums">{p.peers == null ? "—" : `${p.peers} min`}</td><td className="p-1 text-right tabular-nums">{p.peersN}</td></tr>
                        ))}</tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">Até {d.refDay.split("-").reverse().join("/")} (o último dia já calculado). <Badge variant="outline" className="text-[10px] align-middle">não entra nos pontos (Avaliação nem ranking)</Badge></p>
          </>
        )}
    </section>
  );
}
