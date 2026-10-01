/**
 * Perfil: "Ativar notificações de chamadas" neste browser (Web Push). Só
 * aparece a quem pode atender chamadas do WhatsApp, com as chamadas ligadas e
 * o push configurado no servidor.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PhoneIncoming } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { currentPushSubscription, disablePush, enablePush, notificationPermission, pushSupported } from "@/lib/webPush";

export function CallPushCard() {
  const utils = trpc.useUtils();
  const [endpoint, setEndpoint] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const supported = pushSupported();

  useEffect(() => {
    let alive = true;
    void currentPushSubscription().then((s) => { if (alive) setEndpoint(s?.endpoint ?? null); });
    return () => { alive = false; };
  }, []);

  const state = trpc.whatsapp.calls.pushState.useQuery({ endpoint: endpoint ?? null }, { enabled: endpoint !== undefined, retry: false, staleTime: 30_000 });
  const subscribe = trpc.whatsapp.calls.pushSubscribe.useMutation();
  const unsubscribe = trpc.whatsapp.calls.pushUnsubscribe.useMutation();

  if (!state.data?.available) return null;
  const active = !!endpoint && state.data.registered && notificationPermission() === "granted";
  const blocked = notificationPermission() === "denied";

  async function onEnable() {
    if (!state.data?.publicKey) return;
    setBusy(true);
    try {
      const r = await enablePush(state.data.publicKey);
      if (!r.ok) { toast.error(r.message); return; }
      await subscribe.mutateAsync(r.subscription);
      setEndpoint(r.subscription.endpoint);
      await utils.whatsapp.calls.pushState.invalidate();
      toast.success("Notificações de chamadas ativadas neste browser.");
    } catch (e: any) {
      toast.error(e?.message ?? "Não foi possível ativar as notificações.");
    } finally {
      setBusy(false);
    }
  }

  async function onDisable() {
    setBusy(true);
    try {
      const ep = await disablePush();
      if (ep) await unsubscribe.mutateAsync({ endpoint: ep });
      setEndpoint(null);
      await utils.whatsapp.calls.pushState.invalidate();
      toast.success("Notificações de chamadas desativadas neste browser.");
    } catch (e: any) {
      toast.error(e?.message ?? "Não foi possível desativar as notificações.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-3.5 py-3">
        <span className="w-8 h-8 rounded-[9px] bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <PhoneIncoming className="w-4 h-4" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13.5px] font-semibold text-foreground">Notificações de chamadas</div>
          <div className="text-[11.5px] text-muted-foreground">
            {!supported
              ? "Este browser não suporta notificações push."
              : blocked
                ? "Bloqueadas neste browser. Permite as notificações nas definições do site (cadeado ao lado do endereço)."
                : active
                  ? "Ativas neste browser: recebes um aviso quando um cliente liga pelo WhatsApp, mesmo com o separador em segundo plano."
                  : "Recebe um aviso do sistema quando um cliente liga pelo WhatsApp, mesmo com o separador em segundo plano."}
          </div>
        </div>
        {supported && !blocked && (
          active ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={onDisable}>Desativar</Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={onEnable}>Ativar notificações de chamadas</Button>
          )
        )}
      </div>
    </div>
  );
}
