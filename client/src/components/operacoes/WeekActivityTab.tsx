/**
 * Atividade diária → "Semana" (Jorge, 12 out 2026): o quadro da Pressão para
 * UMA semana escolhida (domingo → sábado). Linhas = os 7 dias operacionais
 * (03:00 → 03:00), colunas = as horas (03h … 02h), por cidade. Entregas ou
 * recolhas; quantidade ou tempo por carro (p75, a métrica da Pressão). Totais
 * por dia e por hora; carregar numa célula mostra o detalhe (n.º, média e p75
 * do tempo, e a espera: pendente → entregue / recolha começada → feita).
 * Leitura: multipark.weekActivity (server/weekActivity.ts); regras em
 * shared/weekActivity.ts.
 * 15 out 2026: "Tempos" — Fila, Trânsito, nosso tempo, % na meta, Cliente e
 * Total das entregas; Cliente, No terminal e No P2 das recolhas, da tabela
 * dos tempos (o bloco `times`, com o portão dos tempos com GPS já aplicado).
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { retryTransient } from "@/lib/queryRetry";
import { usePersistedState } from "@/hooks/usePersistedState";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CalendarRange, ChevronLeft, ChevronRight, Lock } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CalibrationBadge, fmtDur } from "@/components/serviceTimes/TimesBits";
import type { GridCell, TimeMetric } from "../../../../server/serviceTimesAgg";
import type { WeekTimes } from "../../../../server/serviceTimesViews";
import { cellStyle, rampLegend } from "@/components/heatRamp";
import { CitySelect, useHandoverCity } from "@/components/shiftDay/handoverCity";
import { HANDOVER_CITY_LABELS } from "@shared/shiftHandover";
import { addDays, operationalDayOf } from "@shared/lisbonDay";
import { MIN_SAMPLE, isRushHour } from "@shared/extrasPressure";
import {
  WEEK_DAY_SHORT, ddmm, weekCellValue, weekStartOf, type DurStats, type WeekCell, type WeekGrid, type WeekKind, type WeekMeasure,
} from "@shared/weekActivity";

const hh = (h: number) => String(h).padStart(2, "0");
const fmt0 = (n: number | null | undefined) => (n == null ? "—" : String(Math.round(n)));
const KIND_LABEL: Record<WeekKind, string> = { entregas: "Entregas", recolhas: "Recolhas" };
type Measure = WeekMeasure | "tempos";
const MEASURE_LABEL: Record<Measure, string> = { quantidade: "Quantidade", tempo: "Tempo por carro", tempos: "Tempos" };
type TimesPick = TimeMetric | "meta";
const TIMES_BY_KIND: Record<WeekKind, Array<{ key: TimesPick; label: string; help: string }>> = {
  entregas: [
    { key: "fila", label: "Fila", help: "da chamada do cliente (ou do pendente) até pegar no carro" },
    { key: "transito", label: "Trânsito", help: "de pegar no carro até chegar ao terminal (GPS)" },
    { key: "nosso", label: "Nosso tempo", help: "Fila + Trânsito" },
    { key: "meta", label: "% na meta", help: "entregas com o nosso tempo dentro da meta (aqui mais escuro = mais na meta, melhor)" },
    { key: "cliente", label: "Cliente", help: "do terminal à assinatura (espera pelo cliente)" },
    { key: "total", label: "Total", help: "da chamada (ou do pendente) à assinatura" },
  ],
  recolhas: [
    { key: "cliente_recolha", label: "Cliente", help: "da chamada (ou do \"em recolha\") ao check-in" },
    { key: "terminal", label: "No terminal", help: "do check-in até o carro sair do terminal (GPS)" },
    { key: "p2", label: "No P2", help: "do P2 até ir para um parque" },
  ],
};
/** Cobertura (% medidos) com vírgula decimal: "62,5 %"; sem valor "—". */
const fmtCoverage = (v: number | null | undefined) => (v == null ? "—" : `${String(Math.round(v * 10) / 10).replace(".", ",")} %`);
/** Valor de uma célula dos tempos: p75 em minutos (ou a % na meta); null = sem casos suficientes. */
function timesCellValue(c: GridCell | undefined, pick: TimesPick): number | null {
  if (!c) return null;
  if (pick === "meta") return c.inTarget?.pct ?? null;
  const st = c.m[pick];
  return st ? st.p75Ms / 60_000 : null;
}

/** "média 42 · mediana 40 · p75 48 min" (ou "sem casos"). */
function durText(d: DurStats, withMax = false): string {
  if (!d.n) return "sem casos";
  return `média ${fmt0(d.avg)} · mediana ${fmt0(d.p50)} · p75 ${fmt0(d.p75)}${withMax ? ` · máx. ${fmt0(d.max)}` : ""} min`;
}

/** As linhas do detalhe de uma célula (ou de um total). */
function detailLines(kind: WeekKind, c: WeekCell): string[] {
  const out = kind === "entregas"
    ? [
        `Entregues: ${c.count} · pedidos de entrega: ${c.requested}`,
        `Tempo por carro (entregas começadas, n=${c.cycle.n}): ${durText(c.cycle)}`,
        `Pendente → entregue (pedidos feitos, n=${c.wait.n}): ${durText(c.wait, true)}`,
      ]
    : [
        `Recolhidos: ${c.count} · recolhas começadas: ${c.requested}`,
        `Tempo por carro (recolhas começadas, n=${c.cycle.n}): ${durText(c.cycle)}`,
        `Recolha (começada → feita, n=${c.wait.n}): ${durText(c.wait, true)}`,
      ];
  out.push(`Pessoas com ações: ${c.people}`);
  return out;
}

type Sel = { row: number | "total"; col: number | "total" } | null;

export default function WeekActivityTab() {
  const cityState = useHandoverCity();
  const today = operationalDayOf(Date.now());
  const thisWeek = weekStartOf(today);
  const [weekStart, setWeekStart] = useState(thisWeek);
  const [kind, setKind] = usePersistedState<WeekKind>("operacional.semana.kind", "entregas");
  const [measure, setMeasure] = usePersistedState<Measure>("operacional.semana.measure", "quantidade");
  const [timesPickRaw, setTimesPick] = usePersistedState<TimesPick>("operacional.semana.tempo", "fila");
  const [sel, setSel] = useState<Sel>(null);
  const city = cityState.city;
  const q = trpc.multipark.weekActivity.useQuery(
    { city: city ?? "lisbon", weekStart },
    { enabled: !!city, refetchOnWindowFocus: false, retry: retryTransient, staleTime: 60_000 },
  );
  const data = q.data;
  const grid: WeekGrid | null = data && data.available ? data.grids[kind] : null;
  const times = ((data as { times?: WeekTimes | null } | undefined)?.times ?? null) as WeekTimes | null;
  const timesPick: TimesPick = TIMES_BY_KIND[kind].some((o) => o.key === timesPickRaw) ? timesPickRaw : TIMES_BY_KIND[kind][0].key;
  const timesHidden = measure === "tempos" && times ? times.cells.hidden[timesPick] ?? null : null;
  const timesNote = measure === "tempos" && times ? times.cells.notes[timesPick] ?? null : null;
  /** O valor mostrado: quantidade, tempo por carro (p75) ou o tempo escolhido (p75 / %). */
  const cellVal = (c: WeekCell, key: string, which: "cells" | "byDay" | "byHour" | "total" = "cells"): number | null => {
    if (measure !== "tempos") return weekCellValue(c, measure);
    if (!times || timesHidden) return null;
    return timesCellValue(times[which].cells[key], timesPick);
  };

  const max = useMemo(() => {
    if (!grid) return 0;
    let m = 0;
    for (const r of grid.rows) r.cells.forEach((c, ci) => { m = Math.max(m, cellVal(c, `${r.day}|${grid.hours[ci]}`) ?? 0); });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, measure, times, timesPick, timesHidden]);
  const legend = rampLegend(max);
  const unit = measure === "quantidade" ? (kind === "entregas" ? " entregas" : " recolhas") : measure === "tempos" && timesPick === "meta" ? " %" : " min";

  const go = (ws: string) => { setWeekStart(ws > thisWeek ? thisWeek : ws); setSel(null); };

  if (cityState.loading) return <p className="text-sm text-muted-foreground mt-4">A carregar…</p>;
  if (cityState.error) return <div className="mt-4"><QueryErrorNote error={cityState.error} onRetry={cityState.retry} retrying={cityState.retrying} what="as tuas cidades" /></div>;
  if (!city) return <Card className="mt-4"><CardContent className="p-8 text-center text-muted-foreground">Sem cidade atribuída — pede a um administrador para associar o teu centro de custos.</CardContent></Card>;

  const selCell: { title: string; cell: WeekCell } | null = (() => {
    if (!grid || !sel) return null;
    if (sel.row === "total" && sel.col === "total") return { title: `Semana toda`, cell: grid.total };
    if (sel.row === "total") return { title: `${hh(grid.hours[sel.col as number])}h — a semana toda`, cell: grid.hourTotals[sel.col as number] };
    const r = grid.rows[sel.row];
    if (!r) return null;
    const label = `${WEEK_DAY_SHORT[r.weekday]} ${ddmm(r.day)}`;
    if (sel.col === "total") return { title: `${label} — o dia todo (03:00 → 03:00)`, cell: r.total };
    const h = grid.hours[sel.col];
    return { title: `${label} · ${hh(h)}h${h < 3 ? " (madrugada a seguir)" : ""}`, cell: r.cells[sel.col] };
  })();
  const isSel = (row: number | "total", col: number | "total") => !!sel && sel.row === row && sel.col === col;
  /** A célula dos tempos novos que corresponde à seleção. */
  const selTimes: GridCell | undefined = (() => {
    if (!times || !grid || !sel) return undefined;
    if (sel.row === "total" && sel.col === "total") return times.total.cells["*"];
    if (sel.row === "total") return times.byHour.cells[String(grid.hours[sel.col as number])];
    const r = grid.rows[sel.row];
    if (!r) return undefined;
    if (sel.col === "total") return times.byDay.cells[r.day];
    return times.cells.cells[`${r.day}|${grid.hours[sel.col]}`];
  })();
  const pick = (row: number | "total", col: number | "total") => setSel(isSel(row, col) ? null : { row, col });
  /** Texto de uma célula/total: quantidade (vazio se 0), p75 do tempo por carro ou o tempo escolhido. */
  const shown = (c: WeekCell, key = "", which: "cells" | "byDay" | "byHour" | "total" = "cells") => {
    const v = cellVal(c, key, which);
    return v == null ? "" : fmt0(v);
  };
  const few = (c: WeekCell) => measure === "tempo" && c.cycle.n > 0 && c.cycle.n < MIN_SAMPLE;
  /** As linhas dos tempos novos de uma célula (no detalhe). */
  const timesDetail = (cell: GridCell | undefined): string[] => {
    if (!times || !cell) return [];
    const out: string[] = [];
    for (const o of TIMES_BY_KIND[kind]) {
      if (times.cells.hidden[o.key]) continue;
      if (o.key === "meta") { if (cell.inTarget) out.push(`Na meta (${times.targetMinutes} min): ${Math.round(cell.inTarget.pct)} % de ${cell.inTarget.n}`); continue; }
      const st = cell.m[o.key];
      if (st) out.push(`${o.label} (n=${st.n}): mediana ${fmtDur(st.p50Ms)} · p75 ${fmtDur(st.p75Ms)} · média ${fmtDur(st.meanMs)}`);
    }
    return out;
  };

  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div><Label className="text-xs mb-1 block">Cidade</Label><CitySelect city={city} allowed={cityState.allowed} onChange={(c) => { cityState.setCity(c); setSel(null); }} /></div>
            <div>
              <Label className="text-xs mb-1 block">Semana (domingo → sábado)</Label>
              <div className="flex items-center gap-1">
                <Button size="icon" variant="outline" className="h-9 w-9" aria-label="Semana anterior" onClick={() => go(addDays(weekStart, -7))}><ChevronLeft className="w-4 h-4" /></Button>
                <span className="h-9 px-2 flex items-center rounded-md border text-sm tabular-nums whitespace-nowrap">
                  <CalendarRange className="w-4 h-4 mr-1 text-muted-foreground" />Dom {ddmm(weekStart)} → Sáb {ddmm(addDays(weekStart, 6))}/{addDays(weekStart, 6).slice(0, 4)}
                </span>
                <Button size="icon" variant="outline" className="h-9 w-9" aria-label="Semana seguinte" disabled={weekStart >= thisWeek} onClick={() => go(addDays(weekStart, 7))}><ChevronRight className="w-4 h-4" /></Button>
              </div>
            </div>
            <div>
              <Label className="text-xs mb-1 block">Ir para o dia</Label>
              <Input type="date" className="w-40 h-9" max={today} value={weekStart}
                onChange={(e) => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) go(weekStartOf(e.target.value)); }} />
            </div>
            {weekStart !== thisWeek && <Button size="sm" variant="ghost" onClick={() => go(thisWeek)}>Esta semana</Button>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-md border p-0.5" role="radiogroup" aria-label="Entregas ou recolhas">
              {(["entregas", "recolhas"] as const).map((k) => (
                <Button key={k} size="sm" variant={kind === k ? "selected" : "ghost"} className="h-8" role="radio" aria-checked={kind === k} onClick={() => { setKind(k); setSel(null); }}>{KIND_LABEL[k]}</Button>
              ))}
            </div>
            <div className="inline-flex rounded-md border p-0.5" role="radiogroup" aria-label="Quantidade, tempo por carro ou tempos">
              {(["quantidade", "tempo", "tempos"] as const).map((m) => (
                <Button key={m} size="sm" variant={measure === m ? "selected" : "ghost"} className="h-8" role="radio" aria-checked={measure === m} onClick={() => setMeasure(m)}>{MEASURE_LABEL[m]}</Button>
              ))}
            </div>
            {measure === "tempos" && (
              <Select value={timesPick} onValueChange={(v) => { setTimesPick(v as TimesPick); setSel(null); }}>
                <SelectTrigger className="w-48 h-9 rounded-[10px]" aria-label="Que tempo"><SelectValue /></SelectTrigger>
                <SelectContent>{TIMES_BY_KIND[kind].map((o) => <SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>)}</SelectContent>
              </Select>
            )}
            {measure === "tempos" && <CalibrationBadge note={timesNote} />}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            {KIND_LABEL[kind]} — {measure === "quantidade" ? "quantas por hora" : measure === "tempo" ? "tempo por carro (p75)" : `${TIMES_BY_KIND[kind].find((o) => o.key === timesPick)?.label} (${timesPick === "meta" ? "%" : "p75"})`} — {HANDOVER_CITY_LABELS[city]}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {measure === "quantidade"
              ? kind === "entregas" ? "Carros entregues (entrega feita) em cada hora." : "Carros recolhidos (recolha feita) em cada hora."
              : measure === "tempo"
                ? `Minutos entre o início de ${kind === "entregas" ? "uma entrega" : "uma recolha"} e o início do serviço seguinte do mesmo condutor (a métrica da Pressão), dos serviços começados nessa hora. Mostra-se o p75: em 3 de cada 4 vezes foi isto ou menos.`
                : `${TIMES_BY_KIND[kind].find((o) => o.key === timesPick)?.label}: ${TIMES_BY_KIND[kind].find((o) => o.key === timesPick)?.help}. ${timesPick === "meta" ? "Mostra-se a %" : "Mostra-se o p75"}, pela hora em que ${kind === "entregas" ? "o cliente ligou (ou ficou pendente)" : "o cliente ligou (ou ficou em recolha)"}; células com menos de ${MIN_SAMPLE} casos ficam em branco. Medido em ${fmtCoverage(times?.cells.coverage[(timesPick === "meta" ? "nosso" : timesPick) as TimeMetric])} na semana.`}
            {" "}Cada linha é um dia operacional (03:00 → 03:00): as colunas 00–02 são a madrugada a seguir, ainda desse dia.
          </p>
          {measure === "tempos" && !times?.available && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-[10px] px-3 py-2">Ainda não há tempos guardados para esta semana: o cálculo da noite dos tempos está desligado ou ainda não correu.</p>}
          {timesHidden && <p className="text-sm font-medium text-muted-foreground flex items-center gap-1"><Lock className="w-4 h-4" />{timesHidden}: este tempo depende do GPS e ainda não se mostra.</p>}
          {measure === "tempos" && times?.truncated && <p className="text-xs text-amber-700">Leitura cortada no limite: só os dias mais recentes da semana entram.</p>}
        </CardHeader>
        <CardContent className="space-y-3">
          {q.isLoading ? <p className="text-sm text-muted-foreground">A ler a semana…</p>
            : q.error ? <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="a semana" />
            : data && !data.available ? (
              <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">Sem números desta semana: {data.reason}</p>
            ) : grid && data?.available ? (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[900px] table-fixed text-xs sm:text-sm border-separate" style={{ borderSpacing: 3 }}>
                    <thead>
                      <tr>
                        <th className="w-20"></th>
                        {grid.hours.map((h) => (
                          <th key={h} className={`font-mono font-normal text-[11px] ${isRushHour(h) ? "text-amber-700 font-semibold" : "text-muted-foreground"}`}>{hh(h)}</th>
                        ))}
                        <th className="w-14 text-[11px] font-semibold">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {grid.rows.map((r, ri) => (
                        <tr key={r.day}>
                          <td className={`pr-1 text-sm font-medium whitespace-nowrap ${r.day === today ? "text-blue-700" : "text-muted-foreground"}`}>
                            {WEEK_DAY_SHORT[r.weekday]} <span className="text-[11px] font-normal">{ddmm(r.day)}</span>
                          </td>
                          {r.cells.map((c, ci) => {
                            const v = cellVal(c, `${r.day}|${grid.hours[ci]}`);
                            return (
                              <td key={ci} onClick={() => pick(ri, ci)} title={`${WEEK_DAY_SHORT[r.weekday]} ${ddmm(r.day)} ${hh(grid.hours[ci])}h\n${detailLines(kind, c).join("\n")}`}
                                className={`h-10 md:h-12 text-center rounded tabular-nums cursor-pointer ${c.future ? "bg-transparent border border-dashed border-muted" : v == null ? "bg-muted/40 text-muted-foreground/60" : ""} ${few(c) ? "italic border border-dashed border-slate-500" : ""} ${isSel(ri, ci) ? "outline outline-2 outline-offset-1 outline-foreground" : ""}`}
                                style={c.future ? {} : cellStyle(v, max)}>
                                {c.future ? "" : shown(c, `${r.day}|${grid.hours[ci]}`)}
                              </td>
                            );
                          })}
                          <td onClick={() => pick(ri, "total")} className={`text-center rounded tabular-nums font-semibold bg-muted cursor-pointer ${isSel(ri, "total") ? "outline outline-2 outline-offset-1 outline-foreground" : ""}`}>
                            {r.future ? "" : shown(r.total, r.day, "byDay") || (measure === "quantidade" ? "0" : "—")}
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td className="pr-1 text-sm font-semibold">Total</td>
                        {grid.hourTotals.map((c, ci) => (
                          <td key={ci} onClick={() => pick("total", ci)} className={`h-9 text-center rounded tabular-nums font-semibold bg-muted cursor-pointer ${isSel("total", ci) ? "outline outline-2 outline-offset-1 outline-foreground" : ""}`}>{shown(c, String(grid.hours[ci]), "byHour")}</td>
                        ))}
                        <td onClick={() => pick("total", "total")} className={`text-center rounded tabular-nums font-bold bg-muted cursor-pointer ${isSel("total", "total") ? "outline outline-2 outline-offset-1 outline-foreground" : ""}`}>
                          {shown(grid.total, "*", "total") || (measure === "quantidade" ? "0" : "—")}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                  {legend.length > 0 && (
                    <span className="flex items-center gap-1">
                      {legend.map((l, i) => (
                        <span key={i} className="flex items-center gap-1">
                          <span className="inline-block h-3 w-5 rounded-sm" style={{ backgroundColor: l.c }} />
                          <span className="tabular-nums">{i === 0 ? "até" : ""} {max < 8 ? String(Math.round(l.to * 10) / 10).replace(".", ",") : fmt0(l.to)}{i === legend.length - 1 ? unit : ""}</span>
                        </span>
                      ))}
                    </span>
                  )}
                  <span className="flex items-center gap-1"><span className="inline-block h-3 w-5 rounded-sm bg-muted/40 border" /> sem casos</span>
                  {measure === "tempo" && <span className="flex items-center gap-1"><span className="inline-block h-3 w-5 rounded-sm border border-dashed border-slate-500" /> <i>itálico</i> = menos de {MIN_SAMPLE} serviços (pouco fiável)</span>}
                  <span className="flex items-center gap-1"><span className="inline-block h-3 w-5 rounded-sm border border-dashed" /> hora que ainda não chegou</span>
                  <span><span className="font-mono text-amber-700 font-semibold">07</span> = hora de ponta (07–10h, 17–20h)</span>
                  <span>Totais: {measure === "quantidade" ? "somas" : "p75 de todos os serviços (não a média das células)"}.</span>
                </div>

                {selCell ? (
                  <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <strong>{selCell.title}</strong>
                      <button type="button" className="text-xs text-muted-foreground hover:underline" onClick={() => setSel(null)}>fechar</button>
                    </div>
                    <ul className="mt-1 space-y-0.5 text-xs">{[...detailLines(kind, selCell.cell), ...timesDetail(selTimes)].map((l, i) => <li key={i}>{l}</li>)}</ul>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Carrega numa célula (ou num total) para ver o detalhe: quantos, a média e o p75 do tempo por carro, e {kind === "entregas" ? "o pendente → entregue" : "o tempo da recolha (começada → feita)"}.</p>
                )}
                <p className="text-[11px] text-muted-foreground">
                  {data.source === "guardado"
                    ? "Dias guardados pelo cálculo da Pressão (todas as noites, BD da Multipark)."
                    : "Lido agora da BD da Multipark (só esta cidade e esta semana; guardado uns minutos)."}
                  {" "}{data.parks} parques nossos em {HANDOVER_CITY_LABELS[city]}, sem os que a operação não faz. Entregues/recolhidos pela hora em que ficaram feitos; tempo por carro pela hora em que o serviço começou; pendente → entregue pela hora do pedido.
                </p>
              </>
            ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
