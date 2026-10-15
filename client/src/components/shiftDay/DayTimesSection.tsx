/**
 * Resumo do dia → os tempos de entrega (tarde) e de recolha (manhã), 15 out
 * 2026. Entregas: Fila, Trânsito, Nosso (Fila + Trânsito) com a % na meta,
 * Cliente e Total; as mais lentas com as três partes numa barra e o condutor
 * do Trânsito. Recolhas: no terminal e no P2 (os principais), o cliente, até arrumado e as
 * atrasadas no T2; as que ficaram mais tempo no terminal ou no P2.
 * A cobertura vê-se sempre. Os números com GPS chegam já filtrados pelo
 * portão (servidor): aqui só se mostra o que veio.
 */
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Car, Lock, PlaneLanding } from "lucide-react";
import { fmtPTTime } from "@/lib/lisbonTime";
import { CalibrationBadge, DeliveryBar, DeliveryBarLegend, DeliveryCoverageNote, MetricTile, PickupCoverageNote, fmtDur } from "@/components/serviceTimes/TimesBits";
import type { DayTimesView, SlowDeliveryItem } from "../../../../server/serviceTimesAgg";

export type DayTimes = DayTimesView & { source: "tabela" | "ao_vivo" | "indisponivel"; computedAt: string | null; truncated: boolean; reason: string | null };

const TERMINAL_LABEL: Record<string, string> = { t1: "T1", t2: "T2", vip: "VIP", other: "Outro", unknown: "sem tipo" };

function SourceLine({ t }: { t: DayTimes }) {
  if (t.source === "indisponivel") return <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-[10px] px-2 py-1">Sem tempos deste dia: {t.reason ?? "a BD da Multipark não respondeu"}. Tenta outra vez daqui a pouco.</p>;
  return (
    <p className="text-[11px] text-muted-foreground">
      {t.source === "tabela"
        ? <>Da tabela dos tempos (cálculo da noite{t.computedAt ? `, ${t.computedAt.slice(0, 16)} UTC` : ""}).</>
        : <>Calculado agora com as mesmas regras, <b>provisório</b>: a tabela dos tempos ainda não tem este dia e o GPS do dia só chega à noite (os tempos com GPS ficam "GPS por recolher").</>}
      {t.truncated && <span className="text-amber-700"> Leitura cortada no limite: só parte do dia.</span>}
      {" "}Meta da entrega: {t.targetMinutes} min de nosso tempo (Fila + Trânsito). A hora marcada não entra em nenhum tempo.
    </p>
  );
}

/** As três secções (entregas, recolhas e as listas). `onOpenSlow` abre "o que se passava nesse horário". */
export function DayTimesSection({ t, driverNames, onOpenSlow }: { t: DayTimes; driverNames: Record<number, string>; onOpenSlow: (d: SlowDeliveryItem) => void }) {
  const d = t.deliveries, p = t.pickups;
  const maxBar = Math.max(1, ...d.slowest.map((x) => (x.queueMs ?? 0) + (x.transitMs ?? 0) + (x.customerMs ?? 0)));
  const name = (id: number | null) => (id != null ? driverNames[id] ?? `#${id}` : null);
  return (
    <div className="space-y-4 times-viz">
      <SourceLine t={t} />
      {t.provisional && <p className="text-[11px] text-amber-800 dark:text-amber-300">Os tempos com GPS marcados "provisório" só tu (super admin) vês: o portão ainda está fechado até a calibração acabar.</p>}

      <Card className="rounded-[14px]">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2"><Car className="w-4 h-4 text-[#0055D2]" />Entregas (tarde) — {d.n} {d.n === 1 ? "entrega" : "entregas"}{d.cancelled ? <span className="font-normal text-muted-foreground"> · {d.cancelled} canceladas a meio</span> : null}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            <MetricTile m={d.metrics.fila} hint="Serve para ver como está o trabalho e acertar os extras" />
            <MetricTile m={d.metrics.transito} />
            <MetricTile m={d.metrics.nosso} />
            <div className="rounded-[14px] border bg-card p-3 min-w-0 flex flex-col gap-0.5" title={`Entregas com o nosso tempo (Fila + Trânsito) até ${t.targetMinutes} min, das que têm o nosso tempo medido`}>
              <p className="text-xs text-muted-foreground">Na meta ({t.targetMinutes} min) <span className="text-[10px]">GPS</span></p>
              {d.inTarget.hidden ? <p className="text-sm font-medium text-muted-foreground flex items-start gap-1"><Lock className="w-3.5 h-3.5 mt-0.5 shrink-0" />{d.inTarget.hidden}</p>
                : d.inTarget.pct == null ? <p className="text-sm text-muted-foreground">sem casos medidos</p>
                : <><p className="text-xl font-bold leading-tight">{String(d.inTarget.pct).replace(".", ",")} %</p><p className="text-[11px] text-muted-foreground">{d.inTarget.within} de {d.inTarget.measured} dentro da meta</p></>}
              <CalibrationBadge note={d.inTarget.note} />
            </div>
            <MetricTile m={d.metrics.cliente} hint="Espera pelo cliente no terminal: não é tempo nosso" />
            <MetricTile m={d.metrics.total} hint="Quanto tempo os clientes demoram desde que ligam até assinarem" />
          </div>
          <DeliveryCoverageNote c={d.coverage} />
          {d.slowest.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold">Mais lentas {d.slowestBy === "nosso" ? "pelo nosso tempo" : "pela Fila (os tempos com GPS estão em calibração)"}</p>
                <DeliveryBarLegend queueOnly={d.slowestBy !== "nosso"} />
              </div>
              <ul className="space-y-1">
                {d.slowest.map((x) => {
                  const clickable = !!(x.pendingAt && x.deliveredAt);
                  const head = d.slowestBy === "nosso" ? x.ourMs : x.queueMs;
                  return (
                    <li key={`${x.bookingId}-${x.deliveredAt}`}>
                      <button type="button" disabled={!clickable} onClick={() => clickable && onOpenSlow(x)}
                        className="w-full grid grid-cols-[4.5rem_1fr] sm:grid-cols-[4.5rem_minmax(8rem,14rem)_1fr_auto] items-center gap-x-2 gap-y-0.5 rounded-[10px] px-2 py-1.5 text-left text-xs hover:bg-muted/60 disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        title={clickable ? "Ver o que se passava nesse horário" : "Sem pendente: não dá para ver o que havia à espera"}>
                        <span className="font-semibold tabular-nums">{fmtDur(head)}</span>
                        <span className="truncate">
                          <span className="font-mono">{x.bookingCode ?? `${x.bookingId.slice(0, 8)}…`}</span>
                          {x.terminalClass ? <span className="text-muted-foreground"> · {TERMINAL_LABEL[x.terminalClass] ?? x.terminalClass}</span> : null}
                          {name(x.driverEmployeeId) ? <span className="text-muted-foreground"> · {name(x.driverEmployeeId)}</span> : null}
                        </span>
                        <span className="col-span-2 sm:col-span-1 min-w-0"><DeliveryBar queueMs={x.queueMs} transitMs={x.transitMs} customerMs={x.customerMs} max={maxBar} /></span>
                        <span className="hidden sm:block text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">
                          Fila {fmtDur(x.queueMs)}{x.transitMs != null ? ` · Trânsito ${fmtDur(x.transitMs)}` : ""}{x.customerMs != null ? ` · Cliente ${fmtDur(x.customerMs)}` : ""}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className="text-[11px] text-muted-foreground">Condutor = quem pegou no carro (o do Trânsito). Toca numa para ver a reserva e os outros pedidos à espera nesse horário.</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-[14px]">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2"><PlaneLanding className="w-4 h-4 text-[#0055D2]" />Recolhas (manhã) — {p.n} {p.n === 1 ? "recolha" : "recolhas"}{p.cancelled ? <span className="font-normal text-muted-foreground"> · {p.cancelled} canceladas</span> : null}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            <MetricTile m={p.metrics.terminal} star hint="Tempo médio para tirar os carros do terminal" />
            <MetricTile m={p.metrics.p2} star hint="Tempo para os tirar do P2" />
            <MetricTile m={p.metrics.cliente_recolha} hint="Do telefonema (ou do em recolha) ao check-in: não é tempo nosso" />
            <MetricTile m={p.metrics.ate_arrumado} />
            <MetricTile m={p.metrics.ate_garagem} />
            <div className="rounded-[14px] border bg-card p-3 min-w-0 flex flex-col gap-0.5" title="Só no T2: o condutor chegou ao T2 depois do alvo (a contar da chamada do cliente)">
              <p className="text-xs text-muted-foreground">Atrasadas no T2 <span className="text-[10px]">GPS</span></p>
              {p.t2.hidden ? <p className="text-sm font-medium text-muted-foreground flex items-start gap-1"><Lock className="w-3.5 h-3.5 mt-0.5 shrink-0" />{p.t2.hidden}</p>
                : !p.t2.n ? <p className="text-sm text-muted-foreground">sem recolhas no T2</p>
                : <><p className="text-xl font-bold leading-tight">{p.t2.late ?? "—"} <span className="text-sm font-normal text-muted-foreground">de {p.t2.measured}</span></p><p className="text-[11px] text-muted-foreground">{p.t2.n} no T2 · {p.t2.n - p.t2.measured} sem medição</p></>}
              <CalibrationBadge note={p.t2.note} />
            </div>
          </div>
          <PickupCoverageNote c={p.coverage} />
          {p.longest.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-semibold">Ficaram mais tempo no terminal ou no P2</p>
              <ul className="space-y-1 text-xs">
                {p.longest.map((x) => (
                  <li key={`${x.bookingId}-${x.checkInAt}`} className="flex flex-wrap items-baseline gap-x-2 rounded-[10px] px-2 py-1 hover:bg-muted/40">
                    <Link href={`/reserva/${encodeURIComponent(x.bookingCode || x.bookingId)}`} className="font-mono text-primary underline">{x.bookingCode ?? `${x.bookingId.slice(0, 8)}…`}</Link>
                    {x.checkInAt && <span className="text-muted-foreground">check-in {fmtPTTime(x.checkInAt)}</span>}
                    {x.terminalMs != null && <Badge variant="outline" className="text-[11px]">terminal {fmtDur(x.terminalMs)}</Badge>}
                    {x.p2Ms != null && <Badge variant="outline" className="text-[11px]">P2 {fmtDur(x.p2Ms)}</Badge>}
                    {x.firstGarage && <span className="text-muted-foreground">→ {x.firstGarage}{x.parkedGarage && x.parkedGarage !== x.firstGarage ? ` → ${x.parkedGarage}` : ""}</span>}
                    {name(x.driverEmployeeId) && <span className="text-muted-foreground">· {name(x.driverEmployeeId)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
