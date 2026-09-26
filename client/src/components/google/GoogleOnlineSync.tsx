// Google Tarefas e Contactos enquanto o dashboard está aberto: a Google não
// avisa alterações nestes dois (ao contrário do Calendário e do Drive), por
// isso o browser manda um "heartbeat" ao abrir o dashboard e de 5 em 5 min
// com a aba visível; pára quando a aba fica escondida ou a pessoa sai. O
// servidor limita a 1 sincronização por pessoa a cada ~5 min (várias abas não
// multiplicam chamadas à Google) e corre-a em segundo plano.
import { useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { clientHeartbeatDue } from "@shared/googlePush";

export function GoogleOnlineSync({ enabled }: { enabled: boolean }) {
  const beat = trpc.googleAccount.sync.heartbeat.useMutation();
  const lastSent = useRef<number | null>(null);
  const mutate = useRef(beat.mutate);
  mutate.current = beat.mutate;

  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      const now = Date.now();
      if (!clientHeartbeatDue(document.visibilityState === "visible", lastSent.current, now)) return;
      lastSent.current = now;
      mutate.current(undefined, { onError: () => { /* silencioso: o google-sync de 4 h é a rede de segurança */ } });
    };
    tick();
    const id = window.setInterval(tick, 30_000);
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [enabled]);

  return null;
}
