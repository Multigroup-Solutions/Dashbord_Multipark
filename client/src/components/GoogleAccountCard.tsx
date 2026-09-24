// "Ligar a minha conta Google" — Perfil e Integrações. Autorização
// incremental (só o Gmail por agora), só contas do Workspace da empresa.
// O token nunca chega ao browser; "Desligar" revoga-o na Google.
import { useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Link2, Loader2, LogOut, Mail } from "lucide-react";
import { fmtPTDateTime } from "@/lib/lisbonTime";

/** Mostra o resultado do regresso do OAuth (?google=connected|error&msg=) e limpa a query. */
export function useGoogleOAuthReturnToast(onDone?: () => void) {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const g = params.get("google");
    if (!g) return;
    if (g === "connected") toast.success("Conta Google ligada. O teu email começa a aparecer em poucos minutos.");
    else toast.error(params.get("msg") || "Não foi possível ligar a conta Google.");
    params.delete("google");
    params.delete("msg");
    const q = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${q ? `?${q}` : ""}${window.location.hash}`);
    onDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function googleConnectHref(returnTo?: string): string {
  const back = returnTo ?? `${window.location.pathname}`;
  return `/api/google-account/oauth/start?features=gmail&returnTo=${encodeURIComponent(back)}`;
}

export function GoogleAccountCard({ compact = false, returnTo }: { compact?: boolean; returnTo?: string }) {
  const utils = trpc.useUtils();
  const q = trpc.googleAccount.status.useQuery(undefined, { staleTime: 30_000 });
  const disconnect = trpc.googleAccount.disconnect.useMutation({
    onSuccess: () => { toast.success("Conta Google desligada (acesso revogado)."); utils.googleAccount.status.invalidate(); utils.mail.overview.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  useGoogleOAuthReturnToast(() => { utils.googleAccount.status.invalidate(); utils.mail.overview.invalidate(); });
  const s = q.data;
  const needsReauth = s?.status === "reauth_required" || s?.status === "error";

  return (
    <div className={`bg-card border rounded-2xl shadow-sm ${needsReauth ? "border-amber-500/50" : "border-border"} ${compact ? "p-3" : "p-4"} space-y-2`}>
      <div className="flex items-center gap-3">
        <span className="w-8 h-8 rounded-[9px] bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Mail className="w-4 h-4" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13.5px] font-semibold text-foreground">A minha conta Google</div>
          <div className="text-[11.5px] text-muted-foreground truncate">
            {q.isLoading ? "A verificar…" : s?.connected ? s.email : `Liga a tua conta @${s?.domains?.[0] ?? "multipark.pt"} para usares o teu email no dashboard.`}
          </div>
        </div>
        {s?.connected && !needsReauth && <Badge variant="outline" className="gap-1 border-emerald-500/40 text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="h-3 w-3" />Ligada</Badge>}
        {needsReauth && <Badge variant="outline" className="gap-1 border-amber-500/50 text-amber-700 dark:text-amber-300"><AlertTriangle className="h-3 w-3" />Religar</Badge>}
      </div>
      {needsReauth && (
        <p className="text-xs text-amber-800 dark:text-amber-200">
          A autorização expirou ou foi revogada — o teu email no dashboard está parado. {s?.lastError ?? ""}
        </p>
      )}
      {s && !s.configured && (
        <p className="text-xs text-muted-foreground">A ligação a contas Google ainda não está configurada no servidor (cliente OAuth do Workspace).</p>
      )}
      {s?.connected && s.connectedAt && !compact && (
        <p className="text-[11.5px] text-muted-foreground">
          Ligada desde {fmtPTDateTime(s.connectedAt)} · Acessos: {s.features.filter((f) => f.granted).map((f) => f.id === "gmail" ? "Email (Gmail)" : f.id).join(", ") || "—"}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {s?.configured && (!s.connected || needsReauth) && (
          <Button asChild size="sm">
            <a href={googleConnectHref(returnTo)}><Link2 className="h-4 w-4 mr-1" />{needsReauth ? "Voltar a ligar" : "Ligar a minha conta Google"}</a>
          </Button>
        )}
        {s?.connected && (
          <Button size="sm" variant="outline" disabled={disconnect.isPending}
            onClick={() => { if (window.confirm("Desligar a tua conta Google? O acesso é revogado e o teu email deixa de sincronizar.")) disconnect.mutate(); }}>
            {disconnect.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <LogOut className="h-4 w-4 mr-1" />}Desligar
          </Button>
        )}
      </div>
    </div>
  );
}
