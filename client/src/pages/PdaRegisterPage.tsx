/**
 * /pda/registar?pda=ID&c=CÓDIGO — aberto ao ler o QR colado no PDA (Fase 2).
 * Regista ESTE aparelho como esse PDA. A partir daí, quem fizer login aqui
 * fica com o PDA e o Zello até sair ou entrar outra pessoa.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { getLoginUrl } from "@/const";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Loader2, Smartphone, XCircle } from "lucide-react";
import { setPdaToken, setPendingQr, markClaimed } from "@/lib/pdaDevice";

export default function PdaRegisterPage() {
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const pdaId = Number(params.get("pda"));
  const code = params.get("c") ?? "";
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null);
  const register = trpc.operational.pdas.registerByQr.useMutation({
    onSuccess: (r) => {
      setPdaToken(r.token);
      markClaimed(null);
      setState({ ok: true, message: `Este aparelho é agora o ${r.name}. Quem fizer login aqui fica com ele (e com o Zello) até sair.` });
    },
    onError: (e) => setState({ ok: false, message: e.message }),
  });

  useEffect(() => {
    if (loading) return;
    if (!user) {
      // guarda o QR para continuar depois de entrar
      setPendingQr(window.location.search);
      window.location.href = getLoginUrl();
      return;
    }
    if (!pdaId || !code) { setState({ ok: false, message: "QR incompleto." }); return; }
    if (!register.isPending && !state) register.mutate({ pdaId, code });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, user?.id]);

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="max-w-sm w-full">
        <CardContent className="p-6 text-center space-y-4">
          <Smartphone className="h-10 w-10 mx-auto text-primary" />
          <h1 className="text-lg font-semibold">Registar PDA</h1>
          {!state ? (
            <p className="text-sm text-muted-foreground flex items-center justify-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> A registar este aparelho…
            </p>
          ) : state.ok ? (
            <p className="text-sm text-emerald-700 flex items-start gap-2 text-left">
              <CheckCircle2 className="h-5 w-5 shrink-0" /> {state.message}
            </p>
          ) : (
            <p className="text-sm text-red-700 flex items-start gap-2 text-left">
              <XCircle className="h-5 w-5 shrink-0" /> {state.message}
            </p>
          )}
          <Button variant="outline" className="w-full" onClick={() => setLocation("/")}>Ir para a app</Button>
        </CardContent>
      </Card>
    </div>
  );
}
