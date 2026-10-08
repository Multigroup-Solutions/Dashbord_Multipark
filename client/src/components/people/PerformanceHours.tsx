/**
 * 49e — Desempenho: a atividade por hora do dia (Jorge, 8 out 2026: "para ver
 * a que horas cada um trabalha mesmo"). Ações = Multipark (pela avaliação
 * diária, guardadas por hora) + dashboard (chamadas, emails, WhatsApp,
 * reclamações, caixa, tarefas…), na hora de relógio de Lisboa.
 *
 *  - HourBars: o detalhe de uma pessoa — barras 0–23 h, uma só cor (uma série,
 *    sem legenda: o título diz o que é), dica com o número e a tabela ao lado.
 *  - HourHeatmap: a aba — grelha pessoa × hora numa só cor sequencial
 *    (5 níveis, validados em claro e escuro: --perf-heat-1…5 em index.css),
 *    leitura do que está debaixo do rato e a tabela como alternativa.
 */
import { useMemo, useState } from "react";
import { HOURS_OF_DAY, heatLevel, hourSpan } from "@shared/peoplePerformance";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const nf = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 1 });
const HOURS = Array.from({ length: HOURS_OF_DAY }, (_, h) => h);
const HEAT = ["var(--perf-heat-0)", "var(--perf-heat-1)", "var(--perf-heat-2)", "var(--perf-heat-3)", "var(--perf-heat-4)", "var(--perf-heat-5)"];
const LEVELS = 5;
const sum = (a: ReadonlyArray<number>) => a.reduce((s, x) => s + (Number(x) || 0), 0);
const hourRange = (h: number) => `${h}h–${(h + 1) % 24}h`;
const ddmm = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
const acoes = (n: number) => `${nf.format(n)} ${n === 1 ? "ação" : "ações"}`;

/** "das 7h às 19h · pico às 10h" (pela ordem do dia operacional). */
export function spanText(hours: ReadonlyArray<number>): string | null {
  const s = hourSpan(hours);
  if (s.first == null || s.last == null || s.peak == null) return null;
  return `${s.first === s.last ? `às ${s.first}h` : `das ${s.first}h às ${s.last}h`} · pico às ${s.peak}h`;
}

export interface HourlyInfo { since: string | null; missingDays: number }

/** Nota "por hora desde…" (a Multipark por hora só existe desde a 0590). */
export function HourlyNote({ hourly, from }: { hourly: HourlyInfo; from: string }) {
  const parts: string[] = ["Hora de Lisboa. Ações = Multipark (recolhas, entregas, movimentos, pôr em recolha/entrega, reservas criadas e alterações, pela avaliação diária) + dashboard (chamadas atendidas e feitas, emails, WhatsApp, reclamações, críticas, caixa, despesas, tarefas, leads…). Perdidas e minutos ao telefone não entram."];
  if (hourly.since && hourly.since > from) parts.push(`A Multipark por hora só existe desde ${ddmm(hourly.since)}; antes disso só entra a dashboard.`);
  else if (!hourly.since && hourly.missingDays > 0) parts.push("A Multipark por hora ainda não está guardada neste período (a avaliação diária passou a guardá-la agora; o recálculo da noite enche os últimos 31 dias). Por agora só entra a dashboard.");
  return <p className="text-xs text-muted-foreground">{parts.join(" ")}</p>;
}

/** O detalhe de uma pessoa: ações por hora do dia (0–23 h). */
export function HourBars({ byHour, byHourMultipark }: { byHour: number[]; byHourMultipark: number[] }) {
  const [table, setTable] = useState(false);
  const data = useMemo(() => HOURS.map((h) => {
    const total = byHour[h] ?? 0, mp = byHourMultipark[h] ?? 0;
    return { h: `${h}h`, hour: h, total, mp, dash: Math.max(0, Math.round((total - mp) * 10) / 10) };
  }), [byHour, byHourMultipark]);
  const total = sum(byHour);
  const span = spanText(byHour);
  if (total <= 0) return <p className="text-sm text-muted-foreground">Sem ações com hora neste período.</p>;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Ações por hora do dia</h3>
        {span && <span className="text-xs text-muted-foreground">{span}</span>}
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 6, right: 4, left: -12, bottom: 0 }} barCategoryGap={2}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="h" interval={2} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={{ stroke: "var(--border)" }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} width={36} tickLine={false} axisLine={false} />
          <Tooltip cursor={{ fill: "var(--muted)", opacity: 0.6 }} content={<HourTip />} />
          <Bar dataKey="total" name="Ações" fill="var(--perf-1)" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" aria-expanded={table} onClick={() => setTable((t) => !t)}>
        {table ? "Esconder a tabela" : "Ver em tabela"}
      </Button>
      {table && (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead><tr className="bg-muted text-left text-[11px] font-bold uppercase text-muted-foreground">
              <th className="px-2 py-1">Hora</th><th className="px-2 py-1 text-right">Multipark</th><th className="px-2 py-1 text-right">Dashboard</th><th className="px-2 py-1 text-right">Total</th>
            </tr></thead>
            <tbody>
              {data.filter((d) => d.total > 0).map((d) => (
                <tr key={d.hour} className="border-t">
                  <td className="px-2 py-1">{hourRange(d.hour)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{nf.format(d.mp)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{nf.format(d.dash)}</td>
                  <td className="px-2 py-1 text-right font-semibold tabular-nums">{nf.format(d.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-2 pt-1 text-xs text-muted-foreground">As outras horas: sem ações.</p>
        </div>
      )}
    </div>
  );
}

function HourTip({ active, payload }: { active?: boolean; payload?: Array<{ payload: { hour: number; total: number; mp: number; dash: number } }> }) {
  const p = active ? payload?.[0]?.payload : null;
  if (!p) return null;
  return (
    <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-sm">
      <div className="text-sm font-semibold tabular-nums">{acoes(p.total)}</div>
      <div className="text-muted-foreground">{hourRange(p.hour)} · Multipark {nf.format(p.mp)} · dashboard {nf.format(p.dash)}</div>
    </div>
  );
}

type HeatPerson = { employeeId: number; name: string; byHour?: number[]; byHourMultipark?: number[] };
type HeatRow = { key: string; name: string; byHour: number[]; byHourMultipark: number[]; total: number; person: HeatPerson | null };

/** A aba: grelha pessoa × hora (uma só cor, do claro ao escuro). */
export function HourHeatmap<P extends HeatPerson>({ people, groupByHour, groupByHourMultipark, hourly, from, onOpen }: {
  people: P[]; groupByHour: number[]; groupByHourMultipark: number[]; hourly: HourlyInfo; from: string; onOpen: (p: P) => void;
}) {
  const [scale, setScale] = useState<"row" | "all">("row");
  const [all, setAll] = useState(false);
  const [table, setTable] = useState(false);
  /** o que está debaixo do rato (uma célula) ou com o foco (uma linha: hour = null) */
  const [hover, setHover] = useState<{ row: HeatRow; hour: number | null } | null>(null);
  const rows = useMemo<HeatRow[]>(() => people
    .map((p) => ({ key: String(p.employeeId), name: p.name, byHour: p.byHour ?? [], byHourMultipark: p.byHourMultipark ?? [], total: sum(p.byHour ?? []), person: p as HeatPerson }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "pt")), [people]);
  const groupRow: HeatRow = { key: "todos", name: "Toda a aba", byHour: groupByHour, byHourMultipark: groupByHourMultipark, total: sum(groupByHour), person: null };
  const LIMIT = 25;
  const shown = all ? rows : rows.slice(0, LIMIT);
  const globalMax = Math.max(0, ...rows.flatMap((r) => r.byHour));
  const rowMax = (r: HeatRow) => (r.person == null || scale === "row" ? Math.max(0, ...r.byHour) : globalMax);
  const readout = !hover ? null
    : hover.hour == null ? `${hover.row.name} · ${acoes(hover.row.total)} · ${spanText(hover.row.byHour) ?? "sem ações"}`
    : `${hover.row.name} · ${hourRange(hover.hour)} · ${acoes(hover.row.byHour[hover.hour] ?? 0)} (Multipark ${nf.format(hover.row.byHourMultipark[hover.hour] ?? 0)}, dashboard ${nf.format(Math.max(0, Math.round(((hover.row.byHour[hover.hour] ?? 0) - (hover.row.byHourMultipark[hover.hour] ?? 0)) * 10) / 10))})`;
  // no telemóvel cabe sem deslizar: nome ≥ 64 px e células ≥ 6 px (o número está na leitura e na tabela)
  const grid = { gridTemplateColumns: "minmax(64px, 160px) repeat(24, minmax(6px, 1fr))" } as const;

  const line = (r: HeatRow, strong = false) => {
    const max = rowMax(r);
    return (
      <div key={r.key} className="contents">
        {r.person ? (
          <button type="button" className="truncate pr-2 text-left text-xs hover:underline focus-visible:underline" title={`${r.name} — ver o detalhe`}
            onClick={() => onOpen(r.person as P)}
            onFocus={() => setHover({ row: r, hour: null })} onPointerEnter={() => setHover({ row: r, hour: null })}>{r.name}</button>
        ) : (
          <span tabIndex={0} className={`truncate pr-2 text-xs ${strong ? "font-semibold" : ""}`}
            onFocus={() => setHover({ row: r, hour: null })} onPointerEnter={() => setHover({ row: r, hour: null })}>{r.name}</span>
        )}
        {HOURS.map((h) => {
          const v = r.byHour[h] ?? 0;
          const lvl = heatLevel(v, max, LEVELS);
          return (
            <div key={h} className="h-[18px] rounded-[2px]" style={{ background: HEAT[lvl] }}
              title={`${r.name} · ${hourRange(h)} · ${acoes(v)}`}
              onPointerEnter={() => setHover({ row: r, hour: h })} onPointerDown={() => setHover({ row: r, hour: h })} />
          );
        })}
      </div>
    );
  };

  return (
    <Card>
      <CardHeader className="pb-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Atividade por hora do dia</CardTitle>
          <div role="group" aria-label="Escala da cor" className="inline-flex items-center gap-1 text-xs">
            <span className="text-muted-foreground">Cor</span>
            <Button size="sm" variant={scale === "row" ? "selected" : "outline"} onClick={() => setScale("row")}>por pessoa</Button>
            <Button size="sm" variant={scale === "all" ? "selected" : "outline"} onClick={() => setScale("all")}>igual para todos</Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {scale === "row" ? "Cada linha na sua escala: a hora com mais ações dessa pessoa leva o tom de «mais»." : `A mesma escala para todos: o tom de «mais» = ${acoes(globalMax)} numa hora («Toda a aba» tem a sua).`} Toca no nome para ver o detalhe.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.length === 0 && groupRow.total <= 0 ? <p className="py-6 text-center text-sm text-muted-foreground">Sem ações com hora neste período.</p> : (
          <>
            <p className="min-h-[1.25rem] text-xs tabular-nums">{readout ?? <span className="text-muted-foreground">Passa o rato (ou toca) numa célula para ver o número.</span>}</p>
            <div className="overflow-x-auto" onPointerLeave={() => setHover(null)}>
              <div className="grid min-w-[260px] items-center gap-[2px]" style={grid}>
                <span />
                {HOURS.map((h) => <span key={h} className="text-center text-[10px] tabular-nums text-muted-foreground">{h % 3 === 0 ? h : ""}</span>)}
                {line(groupRow, true)}
                {shown.map((r) => line(r))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1" aria-label="Escala da cor: de menos para mais">
                menos {HEAT.slice(1).map((c, i) => <span key={i} className="inline-block h-3 w-4 rounded-[2px]" style={{ background: c }} />)} mais
              </span>
              <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-4 rounded-[2px]" style={{ background: HEAT[0] }} /> sem ações</span>
              {rows.length > LIMIT && (
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setAll((a) => !a)}>{all ? `Só as ${LIMIT} com mais ações` : `Mostrar todos (${rows.length})`}</Button>
              )}
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" aria-expanded={table} onClick={() => setTable((t) => !t)}>{table ? "Esconder a tabela" : "Ver em tabela"}</Button>
            </div>
            {table && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-[12px]">
                  <thead><tr className="bg-muted text-left text-[10px] font-bold uppercase text-muted-foreground">
                    <th className="sticky left-0 bg-muted px-2 py-1">Pessoa</th>
                    {HOURS.map((h) => <th key={h} className="px-1 py-1 text-right normal-case">{h}h</th>)}
                    <th className="px-2 py-1 text-right">Total</th>
                  </tr></thead>
                  <tbody>
                    {[groupRow, ...rows].map((r) => (
                      <tr key={r.key} className="border-t">
                        <td className={`sticky left-0 bg-card px-2 py-1 ${r.person ? "" : "font-semibold"}`}>{r.name}</td>
                        {HOURS.map((h) => <td key={h} className={`px-1 py-1 text-right tabular-nums ${(r.byHour[h] ?? 0) === 0 ? "text-muted-foreground" : ""}`}>{(r.byHour[h] ?? 0) === 0 ? "·" : nf.format(r.byHour[h])}</td>)}
                        <td className="px-2 py-1 text-right font-semibold tabular-nums">{nf.format(r.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        <HourlyNote hourly={hourly} from={from} />
      </CardContent>
    </Card>
  );
}
