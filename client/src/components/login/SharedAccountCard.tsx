/**
 * Plano 05 (L1): Perfil → "Conta Multipark". Só aparece com SHARED_AUTH_LINK
 * ou SHARED_AUTH_LOGIN ligado e o be-shared configurado. Ligada: como e
 * quando. Por ligar: a própria pessoa prova a conta Multipark com o email e a
 * palavra-passe dela (a palavra-passe só vive no formulário e vai-se logo a
 * seguir, dê certo ou não).
 */
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fmtPTDate } from "@/lib/lisbonTime";
import { MultiparkMark } from "@/components/login/SharedLoginForm";
import { SHARED_FORGOT_PASSWORD_URL, linkMethodLabel } from "@shared/sharedIdentityView";

export function SharedAccountCard({ email: myEmail }: { email: string | null }) {
  const utils = trpc.useUtils();
  const me = trpc.sharedIdentity.me.useQuery(undefined, { retry: false, staleTime: 60_000, refetchOnWindowFocus: false });
  const link = trpc.sharedIdentity.linkWithPassword.useMutation();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const d = me.data;
  if (!d?.enabled) return null;

  const close = () => { setPassword(""); setOpen(false); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await link.mutateAsync({ email: email.trim(), password });
      toast.success(`Conta ligada à conta Multipark ${r.sharedEmail}.`, {
        description: d.loginEnabled ? "Já podes entrar no dashboard com o email e a palavra-passe da conta Multipark." : undefined,
      });
      close();
      await utils.sharedIdentity.me.invalidate();
    } catch (x: any) {
      toast.error(x?.message ?? "Não foi possível ligar a conta.");
      setPassword("");
    }
  };

  return (
    <section aria-labelledby="shared-account-title" className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-3.5 py-3">
        <MultiparkMark className="w-8 h-8" />
        <div className="flex-1 min-w-0">
          <div id="shared-account-title" className="text-[13.5px] font-semibold text-foreground flex items-center gap-1.5">
            Conta Multipark
            {d.linked && (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded-full bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200">
                <CheckCircle2 className="w-3 h-3" aria-hidden />Ligada
              </span>
            )}
          </div>
          <div className="text-[11.5px] text-muted-foreground">
            {d.linked
              ? <>{linkMethodLabel(d.linkMethod)}{d.linkedAt ? ` · desde ${fmtPTDate(d.linkedAt)}` : ""}.{" "}
                  {d.loginEnabled ? "Entras com o email e a palavra-passe da conta Multipark." : "Por agora entras como sempre."}</>
              : "Liga a tua conta Multipark para entrares com ela (a mesma da app e do site)."}
          </div>
        </div>
        {!d.linked && !open && (
          <Button size="sm" onClick={() => { setEmail(myEmail ?? ""); setPassword(""); setOpen(true); }}>Ligar</Button>
        )}
      </div>
      {!d.linked && open && (
        <form onSubmit={submit} className="border-t border-border px-3.5 py-3 space-y-3" autoComplete="off">
          <p className="text-[11.5px] text-muted-foreground">
            Escreve o email e a palavra-passe da tua conta Multipark. Só servem para confirmar que a conta é tua — não ficam guardados no dashboard.
          </p>
          <div className="space-y-1">
            <Label htmlFor="shared-link-email">Email da conta Multipark</Label>
            <Input id="shared-link-email" type="email" inputMode="email" autoCapitalize="none" spellCheck={false} autoComplete="username"
              value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="space-y-1">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor="shared-link-password">Palavra-passe da conta Multipark</Label>
              <a href={SHARED_FORGOT_PASSWORD_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[11.5px] text-primary underline underline-offset-2">
                Esqueci-me<ExternalLink className="h-3 w-3" aria-hidden /><span className="sr-only"> da palavra-passe (abre noutro separador)</span>
              </a>
            </div>
            <Input id="shared-link-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={link.isPending || !email.trim() || !password}>
              {link.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Ligar
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={close} disabled={link.isPending}>Cancelar</Button>
          </div>
        </form>
      )}
    </section>
  );
}
