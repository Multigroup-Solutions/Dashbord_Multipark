/**
 * Plano 56 (A2): depois da saída do ponto num PDA, o resumo da saída fica no
 * ecrã com "A sessão termina em 10 s" e a seguir volta à página de entrada
 * (a pessoa seguinte entra). Não pede nada ao servidor: a sessão já acabou.
 */
import { useEffect, useState } from "react";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PDA_SESSION_END_SECONDS, sessionEndsInText } from "@shared/pdaSession";
import { PDA_SESSION_END_EVENT, clearSharedDeviceState, type PdaSessionEndDetail } from "@/lib/pdaSessionEnd";

function finish(): void {
  clearSharedDeviceState();
  window.location.replace("/");
}

export function PdaSessionEndNotice() {
  const [lines, setLines] = useState<string[] | null>(null);
  const [left, setLeft] = useState(PDA_SESSION_END_SECONDS);

  useEffect(() => {
    const onEnd = (e: Event) => {
      setLines((e as CustomEvent<PdaSessionEndDetail>).detail?.lines ?? []);
      setLeft(PDA_SESSION_END_SECONDS);
    };
    window.addEventListener(PDA_SESSION_END_EVENT, onEnd);
    return () => window.removeEventListener(PDA_SESSION_END_EVENT, onEnd);
  }, []);

  useEffect(() => {
    if (!lines) return;
    if (left <= 0) { finish(); return; }
    const t = window.setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => window.clearTimeout(t);
  }, [lines, left]);

  if (!lines) return null;
  return (
    <div role="alertdialog" aria-live="assertive" className="fixed inset-0 z-[100] flex items-center justify-center bg-background/95 p-4">
      <div className="w-full max-w-sm rounded-2xl border bg-card p-6 shadow-lg space-y-4 text-center">
        <LogOut className="h-8 w-8 mx-auto text-primary" />
        <div className="space-y-1.5 text-sm text-left">
          {lines.map((l, i) => <p key={i} className={i === 0 ? "font-semibold text-base" : "text-muted-foreground"}>{l}</p>)}
        </div>
        <p className="text-sm font-medium">{sessionEndsInText(left)}</p>
        <Button className="w-full" onClick={finish}>Terminar já</Button>
      </div>
    </div>
  );
}
