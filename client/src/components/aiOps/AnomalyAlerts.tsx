/**
 * "Alertas" de uma página (Reservas/Operações, Despesas, Marketing):
 * anomalias detetadas por estatística; a linha em itálico é a explicação da
 * IA (quando está ligada). Sem alertas → não mostra nada.
 *
 * 42d (Jorge, 7 out 2026: "estes alertas… mais pequenos… de lado… dar para
 * retirar"): compactos, encolhem com um clique (fica lembrado), cada um sai da
 * lista com o X (para toda a gente; nada se apaga) e volta em "Tirados → Repor".
 */
import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { usePersistedState } from "@/hooks/usePersistedState";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BellRing, ChevronDown, ChevronRight, RotateCcw, X } from "lucide-react";

type Domain = "bookings" | "expenses" | "marketing";
const shortDay = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const PAGE = 4;

export default function AnomalyAlerts({ domain, enabled = true, className = "" }: { domain: Domain; enabled?: boolean; className?: string }) {
  const [all, setAll] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [collapsed, setCollapsed] = usePersistedState(`alerts.${domain}.collapsed`, false);
  const utils = trpc.useUtils();
  const q = trpc.aiOps.anomalies.useQuery({ domain }, { enabled, staleTime: 5 * 60_000, retry: false });
  const dq = trpc.aiOps.anomalies.useQuery({ domain, dismissed: true }, { enabled: enabled && showDismissed, staleTime: 60_000, retry: false });
  const dismiss = trpc.aiOps.dismissAnomaly.useMutation({
    onSuccess: (_r, v) => {
      toast.success(v.restore ? "Alerta reposto." : "Alerta tirado da lista.");
      utils.aiOps.anomalies.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const list = q.data ?? [];
  if (!enabled || (!list.length && !showDismissed)) return null;
  const shown = all ? list : list.slice(0, PAGE);
  const critical = list.filter((a: any) => a.severity === "critical").length;
  return (
    <Card className={`space-y-2 border-amber-300 bg-amber-50/40 p-3 text-xs dark:bg-amber-950/10 ${className}`}>
      <button type="button" className="flex w-full items-center gap-1.5 text-left" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}>
        {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        <BellRing className="h-3.5 w-3.5 text-amber-700" />
        <span className="text-sm font-semibold">Alertas</span>
        <span className="text-muted-foreground">{list.length}{critical ? ` · ${critical} crítico${critical > 1 ? "s" : ""}` : ""} · 14 dias</span>
      </button>
      {!collapsed && (
        <>
          <ul className="space-y-1.5">
            {shown.map((a: any) => (
              <li key={a.id} className="group flex gap-1.5 break-words">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1">
                    <Badge variant={a.severity === "critical" ? "destructive" : "secondary"} className="px-1 py-0 text-[10px]">{a.severity === "critical" ? "crítico" : "atenção"}</Badge>
                    <span className="tabular-nums text-muted-foreground">{shortDay(a.day)}</span>
                  </div>
                  <div className="mt-0.5 leading-snug">{a.detail}</div>
                  {a.explanation && <div className="mt-0.5 italic leading-snug text-muted-foreground">{a.explanation}</div>}
                </div>
                <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" title="Tirar da lista (para toda a gente; volta em Tirados → Repor)"
                  aria-label="Tirar da lista" disabled={dismiss.isPending} onClick={() => dismiss.mutate({ id: a.id, domain })}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
            {!list.length && <li className="text-muted-foreground">Sem alertas na lista.</li>}
          </ul>
          <div className="flex flex-wrap items-center gap-1">
            {list.length > PAGE && (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setAll((v) => !v)}>{all ? "Mostrar menos" : `Ver todos (${list.length})`}</Button>
            )}
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setShowDismissed((v) => !v)}>{showDismissed ? "Esconder tirados" : "Tirados"}</Button>
          </div>
          {showDismissed && (
            <ul className="space-y-1 border-t pt-1.5">
              {dq.isLoading && <li className="text-muted-foreground">A carregar…</li>}
              {dq.error && <li className="text-destructive">Não deu para ler os tirados.</li>}
              {dq.data && !dq.data.length && <li className="text-muted-foreground">Nenhum alerta tirado nos últimos 14 dias.</li>}
              {(dq.data ?? []).map((a: any) => (
                <li key={a.id} className="flex items-start gap-1.5 text-muted-foreground">
                  <span className="tabular-nums">{shortDay(a.day)}</span>
                  <span className="min-w-0 flex-1 break-words">{a.detail}</span>
                  <Button variant="ghost" size="sm" className="h-6 shrink-0 px-1.5 text-xs" disabled={dismiss.isPending} onClick={() => dismiss.mutate({ id: a.id, domain, restore: true })}>
                    <RotateCcw className="mr-1 h-3 w-3" />Repor
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
