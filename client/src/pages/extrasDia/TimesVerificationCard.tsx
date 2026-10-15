/**
 * Extras-Dia → Pressão → "Verificação dos tempos" (plano MPV §7, F8; só o
 * super admin): "os tempos estão péssimos — é verdade?". Cobertura do GPS
 * por cidade e semana com o portão, uma amostra de 30 entregas comparada com
 * a ficha da reserva e com o Zello, e as medianas por condutor com n.
 * Exporta em Markdown (com o resumo do Diagnóstico dos tempos, se correu
 * nesta página) e em CSV, para anexar ao go/no-go. Só leitura.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Download, FileCheck2, Loader2, Play } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  BOOKING_STATUS_LABELS, VERIFY_CITY_LABELS, ZELLO_STATUS_LABELS, lisbonHm, timesVerificationCsv, timesVerificationMarkdown,
  type TimesVerificationReport, type TvMetricStat,
} from "@shared/timesVerification";

const city = (c: string | null) => VERIFY_CITY_LABELS[c ?? ""] ?? c ?? "—";
const mins = (ms: number | null | undefined) => (ms == null ? "—" : (ms / 60_000).toLocaleString("pt-PT", { maximumFractionDigits: 1 }));
const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v)} %`);
const tone = (ok: boolean) => (ok ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400");

function download(name: string, text: string, type: string) {
  const blob = new Blob([type.startsWith("text/csv") ? "﻿" + text : text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function Stat({ m, minN }: { m: TvMetricStat; minN: number }) {
  if (!m.n) return <span className="text-muted-foreground">—</span>;
  return <span className={`tabular-nums ${m.n < minN ? "text-muted-foreground" : ""}`} title={m.n < minN ? `Só ${m.n}: a mediana diz pouco` : undefined}>{mins(m.p50Ms)} <span className="text-muted-foreground">(n={m.n})</span></span>;
}

export function TimesVerificationCard({ probeSummary }: { probeSummary?: string | null }) {
  const [report, setReport] = useState<TimesVerificationReport | null>(null);
  const run = trpc.extrasDia.timesVerification.useMutation({
    onSuccess: (r) => setReport(r as TimesVerificationReport),
    onError: (e) => toast.error(e.message || "Não deu para fazer a verificação."),
  });
  const stamp = report?.today ?? "";
  const r = report;
  return (
    <Card className="rounded-[14px]">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <FileCheck2 className="h-4 w-4 text-[#0055D2]" />Verificação dos tempos <Badge variant="outline" className="text-[10px]">só super admin</Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          "Os tempos estão péssimos — é verdade?" Antes de o Multis explicar tempos: a cobertura do GPS por cidade e semana (e se o portão abria), 30 entregas comparadas com a ficha da reserva e com o Zello, e as medianas por condutor com o n. Só lê; a ficha lê a History da Multipark (pode demorar até 40 s).
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => run.mutate({})} disabled={run.isPending}>
            {run.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Play className="h-4 w-4 mr-1" />}
            {r ? "Gerar outra vez" : "Gerar o relatório"}
          </Button>
          {r && (
            <>
              <Button size="sm" variant="outline" onClick={() => download(`verificacao-tempos-${stamp}.md`, timesVerificationMarkdown(r, { probeSummary }), "text/markdown;charset=utf-8")}>
                <Download className="h-4 w-4 mr-1" />Markdown
              </Button>
              <Button size="sm" variant="outline" onClick={() => download(`verificacao-tempos-amostra-${stamp}.csv`, timesVerificationCsv(r, "amostra"), "text/csv;charset=utf-8")}>CSV amostra</Button>
              <Button size="sm" variant="outline" onClick={() => download(`verificacao-tempos-condutores-${stamp}.csv`, timesVerificationCsv(r, "condutores"), "text/csv;charset=utf-8")}>CSV condutores</Button>
              <Button size="sm" variant="outline" onClick={() => download(`verificacao-tempos-cobertura-${stamp}.csv`, timesVerificationCsv(r, "cobertura"), "text/csv;charset=utf-8")}>CSV cobertura</Button>
              <span className="text-[11px] text-muted-foreground">{probeSummary ? "O Markdown leva o resumo do Diagnóstico dos tempos que correste aqui." : "Corre o Diagnóstico dos tempos (acima) para o Markdown o levar também."}</span>
            </>
          )}
        </div>

        {r && (
          <>
            <section aria-label="Conclusão" className="rounded-[14px] border bg-card p-3 text-sm space-y-1">
              <p>
                Amostra de <b>{r.sample.items.length}</b> entregas ({r.sample.fromDay} a {r.sample.toDay}, de {r.sample.available} possíveis):{" "}
                <b className={tone(r.sample.bookingCounts.bate === r.sample.items.length)}>{r.sample.bookingCounts.bate}</b> batem com a ficha,{" "}
                {r.sample.bookingCounts.difere} diferem, {r.sample.bookingCounts.sem_ciclo} sem entrega na ficha, {r.sample.bookingCounts.falhou} por ler.
              </p>
              <p>
                Zello: <b>{r.sample.zelloCounts.bate}</b> batem, {r.sample.zelloCounts.gps_fraco} com GPS fraco, {r.sample.zelloCounts.sem_ficheiro} sem ficheiro, {r.sample.zelloCounts.sem_zello} sem Zello
                {r.sample.zelloCounts.falhou + r.sample.zelloCounts.nao_lido > 0 ? `, ${r.sample.zelloCounts.falhou + r.sample.zelloCounts.nao_lido} por ler` : ""}.
                {" "}Portão: <b>{r.gate.visible ? "aberto" : "fechado (em calibração)"}</b> (≥ {r.gate.minCoveragePct} % e n ≥ {r.gate.minN}).
              </p>
              {r.sample.bookingReadFailed && <p className="text-xs text-amber-700 dark:text-amber-400">A ficha das reservas não respondeu: {r.sample.bookingReadFailed}</p>}
            </section>

            <section aria-label="Cobertura do GPS" className="space-y-1">
              <h4 className="text-sm font-semibold">1. Cobertura do GPS por cidade e semana</h4>
              <div className="overflow-x-auto -mx-1">
                <table className="w-full text-xs min-w-[44rem]">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="p-1.5">Semana</th><th className="p-1.5">Cidade</th><th className="p-1.5 text-right">Entregas</th>
                      <th className="p-1.5 text-right">GPS</th><th className="p-1.5 text-right" title="Trânsito medido (GPS ou botão): a cobertura que o portão usa">Cobertura</th>
                      <th className="p-1.5" title="Com esta cobertura e este n, o portão deixava ver os tempos com GPS">Abria?</th>
                      <th className="p-1.5 text-right">Saída GPS (recolhas)</th><th className="p-1.5 text-right">Zello não bate</th><th className="p-1.5">Motivos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.coverage.rows.map((c) => (
                      <tr key={`${c.city}|${c.week}`} className="border-b last:border-0">
                        <td className="p-1.5 tabular-nums">{c.week}</td><td className="p-1.5">{city(c.city)}</td>
                        <td className="p-1.5 text-right tabular-nums">{c.deliveries}</td>
                        <td className="p-1.5 text-right tabular-nums">{pct(c.gpsPct)}</td>
                        <td className="p-1.5 text-right tabular-nums">{pct(c.measuredPct)}</td>
                        <td className={`p-1.5 ${tone(c.gateWouldOpen)}`}>{c.gateWouldOpen ? "sim" : "não"}</td>
                        <td className="p-1.5 text-right tabular-nums">{pct(c.terminalGpsPct)}</td>
                        <td className="p-1.5 text-right tabular-nums">{c.noZello || "—"}</td>
                        <td className="p-1.5 text-muted-foreground">{c.topReasons.map((x) => `${x.reason} ${x.n}`).join(", ") || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section aria-label="Amostra" className="space-y-1">
              <h4 className="text-sm font-semibold">2. Amostra: tabela × ficha da reserva × Zello</h4>
              <p className="text-[11px] text-muted-foreground">Horas de Lisboa, tempos em minutos. A ficha é a History da reserva lida outra vez com as mesmas regras; o Zello são os pontos do GPS do condutor entre pegar no carro e entregar.</p>
              <div className="overflow-x-auto -mx-1">
                <table className="w-full text-xs min-w-[60rem]">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="p-1.5">Reserva</th><th className="p-1.5">Cidade · dia</th><th className="p-1.5">Condutor</th>
                      <th className="p-1.5">Pendente → pegou → chegou → entregou</th>
                      <th className="p-1.5 text-right">Fila</th><th className="p-1.5 text-right">Trânsito</th><th className="p-1.5 text-right">Cliente</th><th className="p-1.5 text-right">Total</th>
                      <th className="p-1.5">Ficha</th><th className="p-1.5">Zello</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.sample.items.map((x) => (
                      <tr key={`${x.bookingId}|${x.anchorKey}`} className="border-b last:border-0 align-top">
                        <td className="p-1.5 font-mono">{x.bookingCode ?? x.bookingId}</td>
                        <td className="p-1.5 whitespace-nowrap">{city(x.cityKey)} · {x.opDay.slice(5)}</td>
                        <td className="p-1.5">{x.driverName ?? (x.startEmployeeId ? `#${x.startEmployeeId}` : "—")}</td>
                        <td className="p-1.5 tabular-nums whitespace-nowrap">{lisbonHm(x.requestAt)} → {lisbonHm(x.startedAt)} → {lisbonHm(x.arrivedAt)}{x.arrivedSource ? ` (${x.arrivedSource})` : ""} → {lisbonHm(x.deliveredAt)}</td>
                        <td className="p-1.5 text-right tabular-nums">{mins(x.queueMs)}</td>
                        <td className="p-1.5 text-right tabular-nums">{mins(x.transitMs)}</td>
                        <td className="p-1.5 text-right tabular-nums">{mins(x.customerMs)}</td>
                        <td className="p-1.5 text-right tabular-nums">{mins(x.totalMs)}</td>
                        <td className={`p-1.5 ${tone(x.booking.status === "bate")}`}>{BOOKING_STATUS_LABELS[x.booking.status]}{x.booking.note && <span className="block text-[11px] text-muted-foreground">{x.booking.note}</span>}</td>
                        <td className={`p-1.5 ${tone(x.zello.status === "bate")}`}>
                          {ZELLO_STATUS_LABELS[x.zello.status]}{x.zello.points != null ? ` · ${x.zello.points} pts` : ""}
                          {x.zello.note && <span className="block text-[11px] text-muted-foreground">{x.zello.note}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!r.sample.items.length && <p className="text-sm text-muted-foreground">Sem entregas guardadas neste período (o trabalho "Tempos de entrega e de recolha" está desligado ou ainda não correu).</p>}
            </section>

            <section aria-label="Medianas por condutor" className="space-y-1">
              <h4 className="text-sm font-semibold">3. Medianas por condutor ({r.drivers.fromDay} a {r.drivers.toDay}, minutos)</h4>
              <p className="text-[11px] text-muted-foreground">Abaixo de n = {r.drivers.minN} (a cinzento) a mediana diz pouco. A Fila, o Trânsito e o Nosso são de quem pegou no carro; o Cliente, de quem entregou.</p>
              <div className="overflow-x-auto -mx-1">
                <table className="w-full text-xs min-w-[40rem]">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="p-1.5">Cidade</th><th className="p-1.5">Condutor</th><th className="p-1.5 text-right">Fila</th><th className="p-1.5 text-right">Trânsito</th><th className="p-1.5 text-right">Nosso</th><th className="p-1.5 text-right">Cliente</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.drivers.cities.map((c) => (
                      <tr key={`c|${c.city}`} className="border-b bg-muted/40 font-medium">
                        <td className="p-1.5">{city(c.city)}</td><td className="p-1.5">toda a cidade</td>
                        <td className="p-1.5 text-right"><Stat m={c.metrics.fila} minN={r.drivers.minN} /></td>
                        <td className="p-1.5 text-right"><Stat m={c.metrics.transito} minN={r.drivers.minN} /></td>
                        <td className="p-1.5 text-right"><Stat m={c.metrics.nosso} minN={r.drivers.minN} /></td>
                        <td className="p-1.5 text-right"><Stat m={c.metrics.cliente} minN={r.drivers.minN} /></td>
                      </tr>
                    ))}
                    {r.drivers.rows.map((d) => (
                      <tr key={`${d.city}|${d.employeeId}`} className="border-b last:border-0">
                        <td className="p-1.5">{city(d.city)}</td><td className="p-1.5">{d.name ?? `#${d.employeeId}`}</td>
                        <td className="p-1.5 text-right"><Stat m={d.metrics.fila} minN={r.drivers.minN} /></td>
                        <td className="p-1.5 text-right"><Stat m={d.metrics.transito} minN={r.drivers.minN} /></td>
                        <td className="p-1.5 text-right"><Stat m={d.metrics.nosso} minN={r.drivers.minN} /></td>
                        <td className="p-1.5 text-right"><Stat m={d.metrics.cliente} minN={r.drivers.minN} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}
