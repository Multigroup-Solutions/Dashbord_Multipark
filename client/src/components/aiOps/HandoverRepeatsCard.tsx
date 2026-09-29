/**
 * Passagem de turno: pendentes que se repetem entre passagens seguidas
 * (deteção no sistema) e o último resumo semanal da cidade.
 */
import { trpc } from "@/lib/trpc";
import { Card } from "@/components/ui/card";
import { Repeat } from "lucide-react";

export default function HandoverRepeatsCard({ city }: { city: "lisbon" | "porto" | "faro" }) {
  const q = trpc.aiOps.handoverRepeats.useQuery({ city }, { staleTime: 5 * 60_000, retry: false });
  const d = q.data;
  if (!d || (!d.repeated.length && !d.week?.narrative)) return null;
  return (
    <Card className="p-4 space-y-3">
      {d.repeated.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-sm font-semibold"><Repeat className="h-4 w-4 text-amber-600" />Pendentes que se arrastam</div>
          <ul className="list-disc pl-5 text-sm space-y-0.5">
            {d.repeated.map((r: any, n: number) => <li key={n} className="break-words">{r.text} <span className="text-muted-foreground">— {r.count} passagens seguidas</span></li>)}
          </ul>
        </div>
      )}
      {d.week?.narrative && (
        <div className="space-y-1">
          <div className="text-sm font-semibold">Resumo da semana de {d.week.weekStart.slice(8, 10)}/{d.week.weekStart.slice(5, 7)}{d.week.expectedShifts ? ` · ${d.week.filled}/${d.week.expectedShifts} passagens` : ""}</div>
          <p className="text-sm text-muted-foreground leading-relaxed">{d.week.narrative}</p>
        </div>
      )}
    </Card>
  );
}
