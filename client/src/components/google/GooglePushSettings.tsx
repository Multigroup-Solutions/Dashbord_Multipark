// Definições → Comunicação: sincronização Google por eventos — canais de
// notificação da Google (Calendário partilhado por cidade, Drive da base de
// conhecimento e o total dos calendários pessoais), fila "sincronizar já" e
// o endereço do webhook. Os admins veem; só o super admin carrega em
// "Renovar agora" (o agendador renova sozinho 1×/dia).
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Loader2, RadioTower, RefreshCw, XCircle } from "lucide-react";
import { fmtPTDateTime } from "@/lib/lisbonTime";

const HEALTH: Record<string, { label: string; cls: string }> = {
  active: { label: "Ativo", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  expiring: { label: "A expirar (renova hoje)", cls: "bg-amber-100 text-amber-800 border-amber-200" },
  expired: { label: "Expirado", cls: "bg-red-100 text-red-800 border-red-200" },
};

const when = (ms: number | null | undefined) => (ms ? fmtPTDateTime(ms) : "—");

export function GooglePushSettings() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const q = trpc.googleCalendar.push.status.useQuery(undefined, { retry: false, staleTime: 30_000 });
  const renew = trpc.googleCalendar.push.renewNow.useMutation({
    onSuccess: (r) => {
      utils.googleCalendar.push.status.invalidate();
      if (r.skipped) toast.message(r.skipped);
      else if (r.errors.length) toast.error(r.errors[0]);
      else toast.success(`Canais: ${r.created} criado(s), ${r.stopped} parado(s).`);
    },
    onError: (e) => toast.error(e.message),
  });
  if (q.error) return null;
  if (q.isLoading || !q.data) return <Card><CardContent className="py-4"><Loader2 className="h-4 w-4 animate-spin" /></CardContent></Card>;
  const d = q.data;
  const isSuper = user?.role === "super_admin";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <RadioTower className="h-4 w-4 text-primary" /> Google em tempo real (notificações)
          <Badge variant="outline" className={d.webhookUrl ? "bg-emerald-100 text-emerald-800 border-emerald-200" : "bg-muted text-secondary-foreground"}>{d.webhookUrl ? "Ligado" : "Desligado"}</Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Calendário e Drive avisam a app quando algo muda (sincroniza logo). Tarefas e Contactos sincronizam enquanto cada pessoa tem o dashboard aberto (de 5 em 5 min).
          O que muda no dashboard vai logo para o Google. Rede de segurança: sincronização completa de 4 em 4 horas.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {d.webhookUrl
          ? <p className="text-[11.5px] text-muted-foreground break-all">Endereço das notificações: <span className="font-mono">{d.webhookUrl}</span></p>
          : <p className="text-xs text-amber-800 dark:text-amber-200">{d.disabledReason}</p>}
        <div className="space-y-1.5">
          {d.shared.length === 0 && <p className="text-xs text-muted-foreground">Sem canais de calendários partilhados nem do Drive (criam-se na próxima sincronização ou em "Renovar agora").</p>}
          {d.shared.map((c) => (
            <div key={c.id} className="rounded-lg border px-3 py-2 text-xs flex flex-wrap items-center gap-2">
              <span className="font-semibold">{c.label}</span>
              <Badge variant="outline" className={HEALTH[c.health]?.cls}>{HEALTH[c.health]?.label ?? c.health}</Badge>
              <span className="text-muted-foreground">expira {when(c.expiration)}</span>
              <span className="text-muted-foreground">· última notificação {when(c.lastNotifiedAt)}{c.notifications ? ` (${c.notifications})` : ""}</span>
              {c.lastError && <span className="w-full text-red-700 dark:text-red-300 break-words"><XCircle className="inline h-3 w-3 mr-1" />{c.lastError}</span>}
            </div>
          ))}
          <div className="rounded-lg border px-3 py-2 text-xs flex flex-wrap items-center gap-2">
            <span className="font-semibold">Calendários pessoais "Multipark"</span>
            <span className="text-muted-foreground">{d.personal.active} ativo(s) · {d.personal.expiring} a expirar · {d.personal.expired} expirado(s)</span>
            <span className="text-muted-foreground">· última notificação {when(d.personal.lastNotifiedAt)}</span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Alterações por enviar/receber: {d.pending}
          {d.pendingErrors.length > 0 && <> · com falhas: {d.pendingErrors.map((p) => `${p.scopeKey} (${p.attempts}×)`).join(", ")}</>}
        </p>
        {isSuper && (
          <Button size="sm" variant="outline" onClick={() => renew.mutate()} disabled={renew.isPending || !d.webhookUrl}>
            {renew.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}Renovar agora
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
