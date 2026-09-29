/**
 * "Alertas" de uma página (Reservas/Operações, Despesas, Marketing):
 * anomalias detetadas por estatística; a linha em itálico é a explicação da
 * IA (quando está ligada). Sem alertas → não mostra nada.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BellRing } from "lucide-react";

const shortDay = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

export default function AnomalyAlerts({ domain, enabled = true }: { domain: "bookings" | "expenses" | "marketing"; enabled?: boolean }) {
  const [all, setAll] = useState(false);
  const q = trpc.aiOps.anomalies.useQuery({ domain }, { enabled, staleTime: 5 * 60_000, retry: false });
  const list = q.data ?? [];
  if (!enabled || !list.length) return null;
  const shown = all ? list : list.slice(0, 4);
  return (
    <Card className="p-4 space-y-3 border-amber-300 bg-amber-50/40 dark:bg-amber-950/10">
      <div className="flex items-center gap-2">
        <BellRing className="h-4 w-4 text-amber-700" />
        <h3 className="font-semibold text-sm">Alertas</h3>
        <span className="text-xs text-muted-foreground">{list.length} nos últimos 14 dias</span>
      </div>
      <ul className="space-y-2">
        {shown.map((a: any) => (
          <li key={a.id} className="text-sm break-words">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={a.severity === "critical" ? "destructive" : "secondary"} className="text-[11px]">{a.severity === "critical" ? "crítico" : "atenção"}</Badge>
              <span className="text-xs text-muted-foreground tabular-nums">{shortDay(a.day)}</span>
            </div>
            <div className="mt-0.5">{a.detail}</div>
            {a.explanation && <div className="text-xs text-muted-foreground italic mt-0.5">{a.explanation}</div>}
          </li>
        ))}
      </ul>
      {list.length > 4 && (
        <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => setAll((v) => !v)}>{all ? "Mostrar menos" : `Ver todos (${list.length})`}</Button>
      )}
    </Card>
  );
}
