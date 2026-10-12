/**
 * Plano 56: "Ativar avisos" no telemóvel/PC para todos (antes só para quem
 * atende o WhatsApp). O TL e o supervisor recebem aqui o código de entrada de
 * quem o pede. Usa o mesmo service worker (/sw.js) e a mesma subscrição do
 * browser que as chamadas do WhatsApp.
 *  - `PushAlertsCard`: cartão no Perfil;
 *  - `PushAlertsBanner`: pedido curto depois de entrar (TL e supervisor), uma
 *    vez por aparelho ("Agora não" esconde-o).
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { BellRing, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { currentPushSubscription, disablePush, enablePush, notificationPermission, pushSupported } from "@/lib/webPush";

const DISMISS_KEY = "mp.pushPrompt.dismissed";

function usePushAlerts() {
  const utils = trpc.useUtils();
  const [endpoint, setEndpoint] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const supported = pushSupported();
  useEffect(() => {
    let alive = true;
    void currentPushSubscription().then((s) => { if (alive) setEndpoint(s?.endpoint ?? null); });
    return () => { alive = false; };
  }, []);
  const state = trpc.notifications.pushState.useQuery({ endpoint: endpoint ?? null }, { enabled: endpoint !== undefined && supported, retry: false, staleTime: 30_000 });
  const subscribe = trpc.notifications.pushSubscribe.useMutation();
  const unsubscribe = trpc.notifications.pushUnsubscribe.useMutation();
  const active = !!endpoint && !!state.data?.registered && notificationPermission() === "granted";
  const blocked = notificationPermission() === "denied";

  async function enable(): Promise<boolean> {
    if (!state.data?.publicKey) return false;
    setBusy(true);
    try {
      const r = await enablePush(state.data.publicKey);
      if (!r.ok) { toast.error(r.message); return false; }
      await subscribe.mutateAsync(r.subscription);
      setEndpoint(r.subscription.endpoint);
      await utils.notifications.pushState.invalidate();
      toast.success("Avisos ligados neste aparelho.");
      return true;
    } catch (e: any) {
      toast.error(e?.message ?? "Não foi possível ligar os avisos.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const ep = await disablePush();
      if (ep) await unsubscribe.mutateAsync({ endpoint: ep });
      setEndpoint(null);
      await utils.notifications.pushState.invalidate();
      toast.success("Avisos desligados neste aparelho.");
    } catch (e: any) {
      toast.error(e?.message ?? "Não foi possível desligar os avisos.");
    } finally {
      setBusy(false);
    }
  }

  return { supported, available: !!state.data?.available, active, blocked, busy, enable, disable, loaded: endpoint !== undefined && !state.isLoading };
}

export function PushAlertsCard() {
  const p = usePushAlerts();
  if (!p.available && p.supported) return null;
  return (
    <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-3.5 py-3">
        <span className="w-8 h-8 rounded-[9px] bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <BellRing className="w-4 h-4" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13.5px] font-semibold text-foreground">Avisos no telemóvel</div>
          <div className="text-[11.5px] text-muted-foreground">
            {!p.supported
              ? "Este browser não suporta avisos. No iPhone, instala primeiro a app no ecrã principal (Partilhar → Adicionar ao ecrã principal)."
              : p.blocked
                ? "Bloqueados neste browser. Permite as notificações nas definições do site (cadeado ao lado do endereço)."
                : p.active
                  ? "Ligados neste aparelho: recebes os códigos de entrada de quem os pede (e as chamadas, se as atendes)."
                  : "Liga para receberes no telemóvel os códigos de entrada de quem os pede, mesmo com a app fechada."}
          </div>
        </div>
        {p.supported && !p.blocked && p.available && (
          p.active
            ? <Button size="sm" variant="outline" disabled={p.busy} onClick={p.disable}>Desligar</Button>
            : <Button size="sm" disabled={p.busy} onClick={() => void p.enable()}>Ativar avisos</Button>
        )}
      </div>
    </div>
  );
}

export function PushAlertsBanner({ pda = false }: { pda?: boolean } = {}) {
  const p = usePushAlerts();
  // (auditoria A2) Num PDA (partilhado) o "Agora não" vale só para esta sessão —
  // senão a primeira pessoa que o carregasse escondia-o para todas as seguintes.
  const store = (): Storage | null => { try { return pda ? sessionStorage : localStorage; } catch { return null; } };
  const [hidden, setHidden] = useState(() => { try { return store()?.getItem(DISMISS_KEY) === "1"; } catch { return false; } });
  if (hidden || !p.loaded || !p.supported || !p.available || p.active || p.blocked || notificationPermission() !== "default") return null;
  const dismiss = () => { setHidden(true); try { store()?.setItem(DISMISS_KEY, "1"); } catch { /* sem storage */ } };
  return (
    <div role="status" className="mb-4 rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm flex flex-wrap items-center gap-2">
      <BellRing className="h-4 w-4 text-primary shrink-0" />
      {/* basis-56: a 360 px os botões descem para a linha de baixo (antes o texto ficava uma palavra por linha, por baixo dos botões) */}
      <span className="min-w-0 flex-1 basis-56">{pda
        ? "Ativa os avisos neste PDA: enquanto estiveres com ele recebes \"Tens um aviso\" (sem nomes) mesmo com a app fechada."
        : "Ativa os avisos para receberes no telemóvel os códigos de entrada de quem os pede."}</span>
      <Button size="sm" disabled={p.busy} onClick={async () => { if (await p.enable()) dismiss(); }}>Ativar avisos</Button>
      <Button size="sm" variant="ghost" onClick={dismiss} aria-label="Agora não"><X className="h-4 w-4 mr-1" />Agora não</Button>
    </div>
  );
}
