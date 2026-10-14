/**
 * Plano 05 (L2): /ligar-conta-multipark/:token — o link do email da proposta
 * do super admin. Abre SEM sessão (shared/loginReturn: PUBLIC_PATH_PREFIXES).
 * Mostra a que conta do dashboard vai ligar e só liga quando a pessoa carrega
 * em "Confirmar" (nunca ao abrir a página: os leitores de email abrem links).
 */
import { useState } from "react";
import { useRoute } from "wouter";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { sharedRefusal } from "@shared/sharedIdentity";
import { MultiparkMark } from "@/components/login/SharedLoginForm";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-background px-4 py-8">
      <Card className="w-full max-w-md">
        <CardContent className="py-8 px-6">
          <img src="/multipark-logo.png" alt="Multipark" className="h-7 mb-6" />
          {children}
        </CardContent>
      </Card>
    </main>
  );
}

/** Erro do pedido → texto para a pessoa (um token mal formado é só "Link inválido."). */
function errorText(e: { message: string; data?: { code?: string } | null } | null | undefined): string {
  if (!e) return sharedRefusal("invalid");
  // O `view` só dá BAD_REQUEST quando o token do endereço está mal formado (validação).
  if (e.data?.code === "BAD_REQUEST") return sharedRefusal("invalid");
  return e.message || "Não foi possível abrir o link.";
}

export default function SharedLinkConfirmPage() {
  const [, params] = useRoute("/ligar-conta-multipark/:token");
  const token = params?.token ?? "";
  const view = trpc.sharedIdentity.proposal.view.useQuery({ token }, { enabled: !!token, retry: false, refetchOnWindowFocus: false });
  const loginOpt = trpc.auth.shared.options.useQuery(undefined, { retry: false, staleTime: 5 * 60_000, refetchOnWindowFocus: false });
  const confirm = trpc.sharedIdentity.proposal.confirm.useMutation();
  const [done, setDone] = useState(false);

  if (token && view.isLoading) {
    return (
      <Shell>
        <div role="status" className="flex flex-col items-center py-6 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin text-primary mb-3" aria-hidden />
          A verificar o link…
        </div>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell>
        <div role="status" className="flex flex-col items-center text-center">
          <CheckCircle2 className="h-12 w-12 text-green-600 mb-3" aria-hidden />
          <h1 className="text-lg font-semibold mb-2">Ligada</h1>
          <p className="text-sm text-muted-foreground mb-6">
            {loginOpt.data?.enabled
              ? "Ligada. Já podes entrar no dashboard com a tua conta Multipark."
              : "Ligada. Quando a entrada com a conta Multipark estiver disponível, entras no dashboard com ela; até lá entras como sempre."}
          </p>
          <Button asChild>
            <a href={loginOpt.data?.enabled ? "/?passo=conta-multipark" : "/"}>Ir para a entrada</a>
          </Button>
        </div>
      </Shell>
    );
  }

  const data = view.data;
  if (!token || view.error || !data || !data.ok) {
    const message = !token ? sharedRefusal("invalid") : view.error ? errorText(view.error as any) : data && !data.ok ? data.message : sharedRefusal("invalid");
    return (
      <Shell>
        <div role="alert" className="flex flex-col items-center text-center">
          <XCircle className="h-12 w-12 text-destructive mb-3" aria-hidden />
          <h1 className="text-lg font-semibold mb-2">Não dá para ligar</h1>
          <p className="text-sm text-muted-foreground">{message}</p>
        </div>
      </Shell>
    );
  }

  const submit = async () => {
    try {
      await confirm.mutateAsync({ token });
      setDone(true);
    } catch { /* a mensagem fica no ecrã (confirm.error) */ }
  };

  return (
    <Shell>
      <div className="flex items-center gap-2.5 mb-4">
        <MultiparkMark className="w-8 h-8" />
        <h1 className="text-lg font-semibold">Ligar a conta Multipark</h1>
      </div>
      <p className="text-sm leading-relaxed [overflow-wrap:anywhere]">
        Vais ligar a conta Multipark <strong>{data.sharedEmail}</strong> à conta do dashboard de <strong>{data.dashName}</strong>.
      </p>
      <p className="text-sm text-amber-900 dark:text-amber-200 rounded-lg border border-amber-300/60 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 mt-4">
        Se não és esta pessoa, não confirmes — fecha esta página e nada muda.
      </p>
      <p className="text-xs text-muted-foreground mt-3">Este link vale até {fmtPTDateTime(data.expiresAt)}.</p>
      {confirm.error && (
        <p role="alert" className="text-sm text-red-700 rounded-lg border border-red-200 bg-red-50 px-3 py-2 mt-4">{confirm.error.message}</p>
      )}
      <Button className="w-full mt-6" size="lg" onClick={submit} disabled={confirm.isPending}>
        {confirm.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden />}Confirmar
      </Button>
    </Shell>
  );
}
