// Atividade diária → Resumo do dia: linha do tempo do terminal da cidade
// (plano 56 B2). Quem, de–a, como fechou, até que hora contou, e os buracos
// "terminal vazio 12:10–12:40". Interruptor PONTO_TERMINAL desligado → não aparece.
import { Plane } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { fmtPTTime } from "@/lib/lisbonTime";

export function TerminalDayCard({ date, city }: { date: string; city: "lisbon" | "porto" | "faro" }) {
  const q = trpc.terminal.dayTimeline.useQuery({ date, city }, { retry: false, staleTime: 60_000 });
  if (q.error) return <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="o terminal do dia" />;
  if (!q.data?.enabled) return null;
  const items = q.data.items;
  const gaps = items.filter((i) => i.kind === "gap").length;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2"><Plane className="h-4 w-4" />Terminal {q.data.cityLabel} — linha do tempo</CardTitle>
        <p className="text-[11px] text-muted-foreground">
          Quem esteve no terminal, de que horas a que horas, como saiu e até que hora contou para o pagamento.
          {gaps > 0 ? ` ${gaps} ${gaps === 1 ? "buraco" : "buracos"} com o terminal vazio.` : ""}
        </p>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Ninguém esteve no terminal neste dia.</p>
        ) : (
          <ol className="space-y-1.5 text-sm">
            {items.map((it, i) => it.kind === "gap" ? (
              <li key={`gap-${i}`} className="rounded-md border border-dashed border-amber-300 bg-amber-50/60 px-3 py-1 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
                {it.label}
              </li>
            ) : (
              <li key={it.id} className="rounded-md border px-3 py-1.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="font-medium tabular-nums">{fmtPTTime(it.from)}–{it.to ? fmtPTTime(it.to) : "agora"}</span>
                  <span className="font-medium">{it.name}</span>
                  <span className="text-xs text-muted-foreground">{it.sourceLabel}{it.endReasonLabel ? ` · ${it.endReasonLabel}` : ""}</span>
                  <Badge variant="outline" className={`text-[11px] ${it.basis === "pending" ? "border-amber-400 text-amber-800 dark:text-amber-200" : it.basis === "rejected" ? "line-through text-muted-foreground" : ""}`}>{it.countedLabel}</Badge>
                  {!it.payUplift && <span className="text-[11px] text-muted-foreground">(sem nível +1)</span>}
                </div>
                {it.endNote && <p className="text-[11px] text-muted-foreground">{it.endNote}</p>}
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
