/**
 * Atividade diária → "Semana" (Jorge, 12 out 2026): o quadro da Pressão para
 * UMA semana escolhida (domingo → sábado). Linhas = os 7 dias operacionais
 * (03:00 → 03:00), colunas = as horas (03h … 02h), por cidade. Entregas ou
 * recolhas; quantidade ou tempo por carro (p75, a métrica da Pressão). Totais
 * por dia e por hora; carregar numa célula mostra o detalhe (n.º, média e p75
 * do tempo, e a espera: pendente → entregue / recolha começada → feita).
 * Leitura: multipark.weekActivity (server/weekActivity.ts); regras em
 * shared/weekActivity.ts.
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
import { CalendarRange, ChevronLeft, ChevronRight } from "lucide-react";
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
const MEASURE_LABEL: Record<WeekMeasure, string> = { quantidade: "Quantidade", tempo: "Tempo por carro" };

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
  const [measure, setMeasure] = usePersistedState<WeekMeasure>("operacional.semana.measure", "quantidade");
  const [sel, setSel] = useState<Sel>(null);
  const city = cityState.city;
  const q = trpc.multipark.weekActivity.useQuery(
    { city: city ?? "lisbon", weekStart },
    { enabled: !!city, refetchOnWindowFocus: false, retry: retryTransient, staleTime: 60_000 },
  );
  const data = q.data;
  const grid: WeekGrid | null = data && data.available ? data.grids[kind] : null;

  const max = useMemo(() => {
    if (!grid) return 0;
    let m = 0;
    for (const r of grid.rows) for (const c of r.cells) m = Math.max(m, weekCellValue(c, measure) ?? 0);
    return m;
  }, [grid, measure]);
  const legend = rampLegend(max);
  const unit = measure === "quantidade" ? (kind === "entregas" ? " entregas" : " recolhas") : " min";

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
  const pick = (row: number | "total", col: number | "total") => setSel(isSel(row, col) ? null : { row, col });
  /** Texto de uma célula/total: quantidade (vazio se 0) ou p75 do tempo. */
  const shown = (c: WeekCell) => {
    const v = weekCellValue(c, measure);
    return v == null ? "" : fmt0(v);
  };
  const few = (c: WeekCell) => measure === "tempo" && c.cycle.n > 0 && c.cycle.n < MIN_SAMPLE;

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
            <div className="inline-flex rounded-md border p-0.5" role="radiogroup" aria-label="Quantidade ou tempo por carro">
              {(["quantidade", "tempo"] as const).map((m) => (
                <Button key={m} size="sm" variant={measure === m ? "selected" : "ghost"} className="h-8" role="radio" aria-checked={measure === m} onClick={() => setMeasure(m)}>{MEASURE_LABEL[m]}</Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            {KIND_LABEL[kind]} — {measure === "quantidade" ? "quantas por hora" : "tempo por carro (p75)"} — {HANDOVER_CITY_LABELS[city]}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {measure === "quantidade"
              ? kind === "entregas" ? "Carros entregues (entrega feita) em cada hora." : "Carros recolhidos (recolha feita) em cada hora."
              : `Minutos entre o início de ${kind === "entregas" ? "uma entrega" : "uma recolha"} e o início do serviço seguinte do mesmo condutor (a métrica da Pressão), dos serviços começados nessa hora. Mostra-se o p75: em 3 de cada 4 vezes foi isto ou menos.`}
            {" "}Cada linha é um dia operacional (03:00 → 03:00): as colunas 00–02 são a madrugada a seguir, ainda desse dia.
          </p>
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
                            const v = weekCellValue(c, measure);
                            return (
                              <td key={ci} onClick={() => pick(ri, ci)} title={`${WEEK_DAY_SHORT[r.weekday]} ${ddmm(r.day)} ${hh(grid.hours[ci])}h\n${detailLines(kind, c).join("\n")}`}
                                className={`h-10 md:h-12 text-center rounded tabular-nums cursor-pointer ${c.future ? "bg-transparent border border-dashed border-muted" : v == null ? "bg-muted/40 text-muted-foreground/60" : ""} ${few(c) ? "italic border border-dashed border-slate-500" : ""} ${isSel(ri, ci) ? "outline outline-2 outline-offset-1 outline-foreground" : ""}`}
                                style={c.future ? {} : cellStyle(v, max)}>
                                {c.future ? "" : shown(c)}
                              </td>
                            );
                          })}
                          <td onClick={() => pick(ri, "total")} className={`text-center rounded tabular-nums font-semibold bg-muted cursor-pointer ${isSel(ri, "total") ? "outline outline-2 outline-offset-1 outline-foreground" : ""}`}>
                            {r.future ? "" : shown(r.total) || (measure === "quantidade" ? "0" : "—")}
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td className="pr-1 text-sm font-semibold">Total</td>
                        {grid.hourTotals.map((c, ci) => (
                          <td key={ci} onClick={() => pick("total", ci)} className={`h-9 text-center rounded tabular-nums font-semibold bg-muted cursor-pointer ${isSel("total", ci) ? "outline outline-2 outline-offset-1 outline-foreground" : ""}`}>{shown(c)}</td>
                        ))}
                        <td onClick={() => pick("total", "total")} className={`text-center rounded tabular-nums font-bold bg-muted cursor-pointer ${isSel("total", "total") ? "outline outline-2 outline-offset-1 outline-foreground" : ""}`}>
                          {shown(grid.total) || (measure === "quantidade" ? "0" : "—")}
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
                    <ul className="mt-1 space-y-0.5 text-xs">{detailLines(kind, selCell.cell).map((l, i) => <li key={i}>{l}</li>)}</ul>
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
