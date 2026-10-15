/**
 * Extras-Dia → Pressão → "De onde vêm os tempos" (só o super admin, 15 out
 * 2026): por cidade e semana, de onde vem o início da Fila (chamada /
 * pendente), a chegada ao terminal (GPS / botão / sem medição) e a saída do
 * terminal nas recolhas, os motivos sem medição, os Zellos que não batem, as
 * zonas em falta e as garagens sem papel. É o que diz quando se pode abrir o
 * portão dos tempos com GPS (≥ 60 % numa cidade). Só contagens.
 */
import { trpc } from "@/lib/trpc";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Radar } from "lucide-react";
import { statusLabel } from "@/components/serviceTimes/TimesBits";

const CITY: Record<string, string> = { lisboa: "Lisboa", porto: "Porto", faro: "Faro" };
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);
const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

function Pct({ a, b, good }: { a: number; b: number; good?: boolean }) {
  const v = pct(a, b);
  const tone = v == null || !good ? "" : v >= 60 ? "text-emerald-700 dark:text-emerald-400 font-semibold" : v < 30 ? "text-red-700 dark:text-red-400" : "text-amber-700 dark:text-amber-400";
  return <span className={`tabular-nums ${tone}`}>{v == null ? "—" : `${v} %`}</span>;
}

export function ServiceTimesCoverageCard() {
  const q = trpc.extrasDia.serviceTimesCoverage.useQuery(undefined, { staleTime: 10 * 60_000, refetchOnWindowFocus: false });
  const d = q.data;
  return (
    <Card className="rounded-[14px]">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><Radar className="h-4 w-4 text-[#0055D2]" />De onde vêm os tempos <Badge variant="outline" className="text-[10px]">só super admin</Badge></CardTitle>
        <p className="text-xs text-muted-foreground">
          Por cidade e semana, da tabela dos tempos. A verde, as coberturas de GPS a partir de 60 %: é a partir daí (e com 20 medições) que o portão deixa mostrar os tempos com GPS a toda a gente, quando o abrires nas Definições.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {q.isLoading ? <p className="text-sm text-muted-foreground">A ler…</p>
          : q.error ? <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="a cobertura dos tempos" />
          : !d || !d.weeks.length ? (
            <p className="text-sm text-muted-foreground">Ainda não há tempos guardados. O trabalho da noite "Tempos de entrega e de recolha" está desligado (Definições → Automações) ou ainda não correu; um dia reprocessado à mão também aparece aqui.</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[46rem]">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="p-1.5">Semana</th><th className="p-1.5">Cidade</th>
                      <th className="p-1.5 text-right">Entregas</th>
                      <th className="p-1.5 text-right" title="Fila a começar na chamada do cliente">Com chamada</th>
                      <th className="p-1.5 text-right" title="Chegada ao terminal pelo GPS">GPS</th>
                      <th className="p-1.5 text-right" title="Chegada pelo botão Cheguei (recurso)">Botão</th>
                      <th className="p-1.5 text-right">Recolhas</th>
                      <th className="p-1.5 text-right" title="Saída do terminal pelo GPS">Saída GPS</th>
                      <th className="p-1.5 text-right" title="Saída do terminal pelo início do movimento na app">Saída app</th>
                      <th className="p-1.5 text-right" title="Sem Zello ou condutor por ligar à ficha">Zello não bate</th>
                      <th className="p-1.5 text-right" title="Sem zona de destino, do terminal ou T2">Zonas em falta</th>
                      <th className="p-1.5">Motivos sem medição</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.weeks.map((w) => (
                      <tr key={`${w.week}-${w.city}`} className="border-b align-top">
                        <td className="p-1.5 tabular-nums whitespace-nowrap">{ddmm(w.week)}</td>
                        <td className="p-1.5">{CITY[w.city] ?? w.city}</td>
                        <td className="p-1.5 text-right tabular-nums">{w.deliveries}</td>
                        <td className="p-1.5 text-right whitespace-nowrap"><Pct a={w.withCall} b={w.deliveries} /></td>
                        <td className="p-1.5 text-right whitespace-nowrap"><Pct a={w.gps} b={w.deliveries} good /></td>
                        <td className="p-1.5 text-right whitespace-nowrap"><Pct a={w.button} b={w.deliveries} /></td>
                        <td className="p-1.5 text-right tabular-nums">{w.pickups}</td>
                        <td className="p-1.5 text-right whitespace-nowrap"><Pct a={w.terminalGps} b={w.pickups} good /></td>
                        <td className="p-1.5 text-right whitespace-nowrap"><Pct a={w.terminalApp} b={w.pickups} /></td>
                        <td className="p-1.5 text-right tabular-nums">{w.noZello || "·"}</td>
                        <td className="p-1.5 text-right tabular-nums">{w.missingZones || "·"}</td>
                        <td className="p-1.5 text-muted-foreground min-w-[14rem]">{Object.entries(w.reasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${statusLabel(k)} ${v}`).join(" · ") || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>Garagens sem papel: {d.garagesWithoutRole.length ? <b className="text-foreground">{d.garagesWithoutRole.join(", ")}</b> : "nenhuma"} (Definições → Papéis das garagens)</span>
                {d.truncated && <span className="text-amber-700">Leitura cortada no limite: só as semanas mais recentes.</span>}
                <span>Linhas dos últimos 14 dias com outra versão do cálculo ou outras zonas: <b className="text-foreground tabular-nums">{d.staleRows}</b> (refazem-se sozinhas nas noites seguintes)</span>
              </div>
            </>
          )}
      </CardContent>
    </Card>
  );
}
