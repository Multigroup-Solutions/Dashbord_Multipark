/**
 * Plano 05 (F3, SHARED_AUTH_LOGIN): "Entrar com a conta Multipark" na página
 * de entrada — email + palavra-passe da conta Multipark (be-shared). O servidor
 * confere-os no be-shared e entra pelas mesmas portas do Google; sem ligação
 * fica um pedido de acesso para o super admin. Num PDA leva o token do
 * aparelho (como a palavra-passe do dashboard) e o Chrome não guarda nada.
 */
import { useState, type FormEvent } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getPdaToken } from "@/lib/pdaDevice";
import { SHARED_LOGIN_MSG } from "@shared/sharedIdentity";
import { SHARED_FORGOT_PASSWORD_URL } from "@shared/sharedIdentityView";

/** O "P" da Multipark (ícone da app), para o botão e o cartão do perfil. */
export function MultiparkMark({ className = "w-5 h-5" }: { className?: string }) {
  return <img src="/icon-192.png" alt="" aria-hidden className={`${className} rounded-[5px] shrink-0`} />;
}

/** O interruptor: a página de entrada mostra a conta Multipark? `undefined` enquanto pergunta. */
export function useSharedLoginOption(): boolean | undefined {
  const q = trpc.auth.shared.options.useQuery(undefined, { staleTime: 5 * 60_000, retry: 1, refetchOnWindowFocus: false });
  return q.data ? q.data.enabled : q.isError ? false : undefined;
}

export function SharedLoginForm({ next, onPda, onDone, onBack }: {
  next: string | null;
  onPda: boolean;
  /** Entrou: para onde ir (o `next` validado no servidor). */
  onDone: (to: string) => void;
  onBack: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const login = trpc.auth.shared.login.useMutation();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      const r = await login.mutateAsync({ email: email.trim(), password, next, pdaToken: getPdaToken() });
      setPassword("");
      onDone(r.next ?? "/");
    } catch (x: any) {
      setErr(x?.message ?? "Não foi possível entrar.");
      setPassword("");
    }
  };

  // Conta Multipark certa mas sem acesso ao dashboard: não é um erro da pessoa — o pedido foi para o administrador.
  const requested = err === SHARED_LOGIN_MSG.accessRequested;

  return (
    <form onSubmit={submit} className="space-y-4" autoComplete={onPda ? "off" : "on"} aria-label="Entrar com a conta Multipark">
      <p className="text-[15px] text-slate-500 leading-snug">
        Usa o email e a palavra-passe da tua conta Multipark (a mesma da app e do site).
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="shared-login-email">Email</Label>
        <Input id="shared-login-email" type="email" inputMode="email" autoComplete={onPda ? "off" : "username"} autoCapitalize="none" spellCheck={false}
          className="h-11 text-[15px]" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="nome@exemplo.pt" required autoFocus />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <Label htmlFor="shared-login-password">Palavra-passe</Label>
          <a href={SHARED_FORGOT_PASSWORD_URL} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2">
            Esqueci-me da palavra-passe<ExternalLink className="h-3 w-3" aria-hidden /><span className="sr-only"> (abre noutro separador)</span>
          </a>
        </div>
        <Input id="shared-login-password" type="password" autoComplete={onPda ? "new-password" : "current-password"} className="h-11 text-[15px]"
          value={password} onChange={(e) => setPassword(e.target.value)} required />
      </div>
      {err && (requested ? (
        <p role="status" className="text-sm text-blue-950 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">{err}</p>
      ) : (
        <p role="alert" className="text-sm text-red-700 rounded-lg border border-red-200 bg-red-50 px-3 py-2">{err}</p>
      ))}
      <Button type="submit" size="lg" className="w-full h-11 text-[15px] font-semibold" disabled={login.isPending || !email.trim() || !password}>
        {login.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <MultiparkMark className="w-5 h-5 mr-2" />}Entrar
      </Button>
      <Button type="button" variant="ghost" className="w-full" onClick={onBack} disabled={login.isPending}>Outras formas de entrar</Button>
    </form>
  );
}
