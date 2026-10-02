import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { fmtPTDateTime, fmtPTTime } from "@/lib/lisbonTime";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { AlertTriangle, Check } from "lucide-react";
import { NOTIFY_CITY_LABELS, type NotifyCity } from "@shared/notificationRouting";
import { retryTransient } from "@/lib/queryRetry";
import { QueryErrorNote } from "@/components/QueryErrorNote";

/**
 * Alertas "a trabalhar sem PDA ou Zello ligado" (server/opsPresence.ts): os
 * abertos em cima, com "Visto" (o team leader tratou → não passa ao WhatsApp),
 * e os fechados nas últimas 24 h.
 */
export function OpsPresencePanel() {
  const utils = trpc.useUtils();
  const q = trpc.operational.opsPresence.list.useQuery({ hours: 24 }, { refetchInterval: 60_000, retry: retryTransient });
  const { data, isLoading } = q;
  // Erro ≠ "nada em aberto": sem resposta não se sabe se há alertas.
  const failed = !!q.error && !data;
  const [notes, setNotes] = useState<Record<number, string>>({});
  const ack = trpc.operational.opsPresence.acknowledge.useMutation({
    onSuccess: () => { toast.success("Visto."); utils.operational.opsPresence.list.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const list = data ?? [];
  const open = list.filter((a) => !a.resolvedAt);
  const closed = list.filter((a) => a.resolvedAt);
  const city = (c: string | null) => (c && c in NOTIFY_CITY_LABELS ? NOTIFY_CITY_LABELS[c as NotifyCity] : "sem cidade");

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-600" />
          A trabalhar sem PDA ou Zello ligado
          {open.length > 0 && <Badge variant="destructive">{open.length}</Badge>}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Ponto aberto sem PDA, Zello desligado ou movimentos na Multipark sem ponto aberto. Atualiza de 5 em 5 minutos e fecha sozinho quando o problema desaparece.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading && <p className="text-sm text-muted-foreground">A carregar…</p>}
        {failed && <QueryErrorNote error={q.error!} onRetry={() => q.refetch()} retrying={q.isFetching} what="os alertas" />}
        {!isLoading && !failed && open.length === 0 && <p className="text-sm text-muted-foreground">Nada em aberto. 👍</p>}
        {open.map((a) => (
          <div key={a.id} className="border rounded-md p-2 text-sm space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{a.name}</span>
              <Badge variant="outline">{city(a.city)}</Badge>
              <Badge variant="secondary">{a.kindLabel}</Badge>
              <span className="text-xs text-muted-foreground">desde {a.openedAt ? fmtPTTime(a.openedAt) : "—"}</span>
              {a.escalatedAt && <Badge variant="destructive" title={a.escalationResult ?? ""}>WhatsApp {fmtPTTime(a.escalatedAt)}</Badge>}
            </div>
            {a.detail && <div className="text-muted-foreground">{a.detail}</div>}
            {a.acknowledgedAt ? (
              <div className="text-xs text-emerald-700">Visto por {a.acknowledgedBy ?? "—"} às {fmtPTTime(a.acknowledgedAt)}{a.ackNote ? ` · ${a.ackNote}` : ""}</div>
            ) : (
              <div className="flex flex-wrap sm:flex-nowrap gap-2 items-center">
                <Input className="h-8 text-xs" placeholder="Nota (opcional): ex. PDA avariado, já falei com ele" value={notes[a.id] ?? ""} maxLength={255}
                  onChange={(e) => setNotes((n) => ({ ...n, [a.id]: e.target.value }))} />
                <Button size="sm" variant="outline" disabled={ack.isPending} onClick={() => ack.mutate({ id: a.id, note: notes[a.id] || undefined })}>
                  <Check className="w-4 h-4 mr-1" />Visto
                </Button>
              </div>
            )}
          </div>
        ))}
        {closed.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Fechados nas últimas 24 h ({closed.length})</summary>
            <div className="mt-2 space-y-1">
              {closed.map((a) => (
                <div key={a.id} className="text-xs text-muted-foreground">
                  {a.resolvedAt ? fmtPTDateTime(a.resolvedAt) : ""} · {a.name} · {a.kindLabel} · {a.resolution === "expirado" ? "expirou" : "resolvido"}
                  {a.acknowledgedBy ? ` · visto por ${a.acknowledgedBy}` : ""}{a.escalatedAt ? " · foi ao WhatsApp" : ""}
                </div>
              ))}
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
