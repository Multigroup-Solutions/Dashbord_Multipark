/**
 * Extras-Dia → separador "Pressão": quando é que a operação aperta.
 * Dados: trabalho diário `extras-pressure` (60 dias da BD da Multipark,
 * guardados em ops_pressure_stats). Regras: shared/extrasPressure.ts.
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Flame, Gauge, TrafficCone } from "lucide-react";
import {
  MIN_SAMPLE, WEEKDAY_SHORT, describeLoadEffect, extraCityGroupKey, isRushHour, loadComparison, pressureSummary,
  slotLoadPerDay, tightReason, tightThresholds, type PressureLoadRow, type PressureSlot,
} from "@shared/extrasPressure";

type Metric = "load" | "delivery";
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];
const fmt1 = (n: number | null | undefined) => (n == null ? "—" : String(Math.round(n * 10) / 10).replace(".", ","));
const fmt0 = (n: number | null | undefined) => (n == null ? "—" : String(Math.round(n)));
const ddmm = (d: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : "—");

/** Célula do mapa: um só tom (azul), mais escuro = mais valor. */
function cellStyle(v: number | null, max: number): React.CSSProperties {
  if (v == null || v <= 0 || max <= 0) return {};
  const a = 0.08 + 0.82 * Math.min(1, v / max);
  return { backgroundColor: `rgba(37, 99, 235, ${a.toFixed(3)})`, color: a > 0.5 ? "white" : undefined };
}

export function PressureTab({ city }: { city: "lisbon" | "porto" | "faro" }) {
  const q = trpc.extrasDia.pressure.useQuery(undefined, { staleTime: 10 * 60_000 });
  const [metric, setMetric] = useState<Metric>("load");
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

  const value = (s: PressureSlot | undefined): number | null => {
    if (!s) return null;
    if (metric === "load") return slotLoadPerDay(s);
    return s.deliveryN >= MIN_SAMPLE ? s.deliveryP75 : null;
  };
  const max = Math.max(0, ...slots.map((s) => value(s) ?? 0));

  if (q.isLoading) return <div className="text-sm text-muted-foreground">A carregar a pressão…</div>;
  if (q.error) return <div className="text-sm text-red-600">Erro: {q.error.message}</div>;
  if (!q.data?.available || !groups.length) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          Ainda não há dados de pressão. O cálculo corre todos os dias a partir das 04:45 (trabalho <code>extras-pressure</code>, 60 dias da BD da Multipark);
          um super admin pode corrê-lo já em <code>/api/cron/extras-pressure</code>.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Últimos {q.data.windowDays} dias ({ddmm(q.data.windowStart)} a {ddmm(q.data.windowEnd)}) da BD da Multipark, por hora de Lisboa.
          {q.data.computedAt && <> Calculado em {q.data.computedAt.slice(0, 16)} UTC.</>}
        </p>
        <Select value={group} onValueChange={setPicked}>
          <SelectTrigger className="w-64 h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            {groups.map((g) => <SelectItem key={g.key} value={g.key}>{g.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

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

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base flex items-center gap-2"><Gauge className="h-4 w-4" />Dia da semana × hora</CardTitle>
          <div className="flex gap-1">
            <Button size="sm" variant={metric === "load" ? "default" : "outline"} onClick={() => setMetric("load")}>Carros/hora</Button>
            <Button size="sm" variant={metric === "delivery" ? "default" : "outline"} onClick={() => setMetric("delivery")}>Entrega p75 (min)</Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="text-[11px] border-separate" style={{ borderSpacing: 2 }}>
              <thead>
                <tr>
                  <th className="w-10"></th>
                  {HOURS.map((h) => (
                    <th key={h} className={`font-mono font-normal w-8 ${isRushHour(h) ? "text-amber-700" : "text-muted-foreground"}`}>{String(h).padStart(2, "0")}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {WEEKDAYS.map((wd) => (
                  <tr key={wd}>
                    <td className="pr-1 text-muted-foreground">{WEEKDAY_SHORT[wd]}</td>
                    {HOURS.map((h) => {
                      const s = byKey.get(`${wd}:${h}`);
                      const v = value(s);
                      const tight = tightReason(s, thresholds);
                      const tip = s
                        ? [
                            `${WEEKDAY_SHORT[wd]} ${String(h).padStart(2, "0")}h`,
                            `Carros/hora (média por dia): ${fmt1(slotLoadPerDay(s))} — ${fmt1(s.checkinsDone / Math.max(1, s.days))} chegadas, ${fmt1(s.checkoutsDone / Math.max(1, s.days))} saídas`,
                            `Pedidos de entrega: ${fmt1(s.checkoutsStarted / Math.max(1, s.days))}/dia · recolhas começadas ${fmt1(s.checkinsStarted / Math.max(1, s.days))}/dia`,
                            `Em simultâneo: média ${fmt1(s.concurrencyAvg)}, máx. ${fmt0(s.concurrencyMax)}`,
                            `Entrega (n=${s.deliveryN}): mediana ${fmt0(s.deliveryP50)} · p75 ${fmt0(s.deliveryP75)} · p90 ${fmt0(s.deliveryP90)} min`,
                            `Recolha (n=${s.pickupN}): mediana ${fmt0(s.pickupP50)} · p75 ${fmt0(s.pickupP75)} min`,
                            tight ? "Hora apertada (top 20 %)" : "",
                          ].filter(Boolean).join("\n")
                        : `${WEEKDAY_SHORT[wd]} ${String(h).padStart(2, "0")}h — sem movimento`;
                      return (
                        <td
                          key={h}
                          title={tip}
                          className={`h-7 w-8 text-center rounded-sm tabular-nums ${v == null ? "bg-muted/40 text-muted-foreground/60" : ""} ${tight ? "ring-2 ring-orange-500 ring-inset" : ""}`}
                          style={cellStyle(v, max)}
                        >
                          {v == null ? "" : metric === "load" ? fmt1(v) : fmt0(v)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Mais escuro = {metric === "load" ? "mais carros por hora (chegadas + saídas concluídas, média por dia)" : "entrega mais lenta (p75 do pedido do cliente até ao carro entregue; só com ≥ 5 entregas)"}.
            Contorno laranja = hora apertada. Horas a âmbar = horas de ponta (07–10h, 17–20h). Passa o rato por uma célula para o detalhe.
          </p>
        </CardContent>
      </Card>

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
    <Badge variant="outline" className="ml-2 h-5 py-0 text-[10px] border-orange-300 text-orange-700" title={`Nos últimos 60 dias esta hora está no top 20 % (${why}).`}>
      hora apertada
    </Badge>
  );
}
