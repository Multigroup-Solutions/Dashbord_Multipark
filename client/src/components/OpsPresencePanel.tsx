import { useState } from "react";
import { usePersistedState } from "@/hooks/usePersistedState";
import { trpc } from "@/lib/trpc";
import { fmtPTDateTime, fmtPTTime } from "@/lib/lisbonTime";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { AlertTriangle, Check, ChevronDown, ChevronRight } from "lucide-react";
import { NOTIFY_CITY_LABELS, type NotifyCity } from "@shared/notificationRouting";
import { retryTransient } from "@/lib/queryRetry";
import { QueryErrorNote } from "@/components/QueryErrorNote";

/**
 * Alertas "a trabalhar sem PDA ou Zello ligado" (server/opsPresence.ts): os
 * abertos em cima, com "Visto" (o team leader tratou → não passa ao WhatsApp),
 * e os fechados nas últimas 24 h.
 * 43b (Jorge, 7 out 2026: "isto é para pôr de lado e vai mais pequeno"):
 * compacto, encolhe com um clique (fica lembrado) e a nota só abre se for preciso.
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

  const [collapsed, setCollapsed] = usePersistedState("pdas.presence.collapsed", false);
  const [noteFor, setNoteFor] = useState<number | null>(null);

  return (
    <Card className="gap-0 py-0 text-xs">
      <CardHeader className="p-3 pb-2">
        <button type="button" className="flex w-full items-center gap-1.5 text-left" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}>
          {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
          <CardTitle className="text-sm">Sem PDA ou Zello</CardTitle>
          {open.length > 0 && <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">{open.length}</Badge>}
        </button>
        {!collapsed && <p className="mt-1 leading-snug text-muted-foreground">Ponto aberto sem PDA, Zello desligado ou movimentos sem ponto. Revê de 5 em 5 min e fecha sozinho.</p>}
      </CardHeader>
      {!collapsed && (
      <CardContent className="space-y-1.5 p-3 pt-0">
        {isLoading && <p className="text-muted-foreground">A carregar…</p>}
        {failed && <QueryErrorNote error={q.error!} onRetry={() => q.refetch()} retrying={q.isFetching} what="os alertas" />}
        {!isLoading && !failed && open.length === 0 && <p className="text-muted-foreground">Nada em aberto. 👍</p>}
        {open.map((a) => (
          <div key={a.id} className="space-y-1 rounded-md border p-2">
            <div className="flex flex-wrap items-center gap-1">
              <span className="font-medium">{a.name}</span>
              <Badge variant="outline" className="px-1 py-0 text-[10px]">{city(a.city)}</Badge>
              <Badge variant="secondary" className="px-1 py-0 text-[10px]">{a.kindLabel}</Badge>
              <span className="text-muted-foreground">desde {a.openedAt ? fmtPTTime(a.openedAt) : "—"}</span>
              {a.escalatedAt && <Badge variant="destructive" className="px-1 py-0 text-[10px]" title={a.escalationResult ?? ""}>WhatsApp {fmtPTTime(a.escalatedAt)}</Badge>}
            </div>
            {a.detail && <div className="leading-snug text-muted-foreground">{a.detail}</div>}
            {a.acknowledgedAt ? (
              <div className="text-emerald-700">Visto por {a.acknowledgedBy ?? "—"} às {fmtPTTime(a.acknowledgedAt)}{a.ackNote ? ` · ${a.ackNote}` : ""}</div>
            ) : (
              <div className="space-y-1">
                {noteFor === a.id && (
                  <Input className="h-7 text-xs" placeholder="Nota: ex. PDA avariado, já falei com ele" value={notes[a.id] ?? ""} maxLength={255}
                    onChange={(e) => setNotes((n) => ({ ...n, [a.id]: e.target.value }))} />
                )}
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={ack.isPending} onClick={() => ack.mutate({ id: a.id, note: notes[a.id] || undefined })}>
                    <Check className="mr-1 h-3.5 w-3.5" />Visto
                  </Button>
                  {noteFor !== a.id && <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setNoteFor(a.id)}>+ nota</Button>}
                </div>
              </div>
            )}
          </div>
        ))}
        {closed.length > 0 && (
          <details>
            <summary className="cursor-pointer text-muted-foreground">Fechados nas últimas 24 h ({closed.length})</summary>
            <div className="mt-1 space-y-1">
              {closed.map((a) => (
                <div key={a.id} className="text-muted-foreground">
                  {a.resolvedAt ? fmtPTDateTime(a.resolvedAt) : ""} · {a.name} · {a.kindLabel} · {a.resolution === "expirado" ? "expirou" : "resolvido"}
                  {a.acknowledgedBy ? ` · visto por ${a.acknowledgedBy}` : ""}{a.escalatedAt ? " · foi ao WhatsApp" : ""}
                </div>
              ))}
            </div>
          </details>
        )}
      </CardContent>
      )}
    </Card>
  );
}
