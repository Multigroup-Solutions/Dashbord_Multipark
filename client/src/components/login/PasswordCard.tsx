/**
 * Plano 56: Perfil → Palavra-passe (utilizadores, extras e condutores, com
 * "Entrar com email e código" ligado). Criar a primeira; mudar pede a atual —
 * ou, se te esqueceste, sai e entra com um código (durante 15 min podes criar
 * outra sem a antiga). Mudar termina as sessões nos outros aparelhos.
 */
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { KeyRound, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { PASSWORD_MIN, passwordProblem } from "@shared/loginCode";

export function PasswordCard({ name, email }: { name: string | null; email: string | null }) {
  const utils = trpc.useUtils();
  const status = trpc.auth.password.status.useQuery(undefined, { retry: false, staleTime: 30_000 });
  const set = trpc.auth.password.set.useMutation();
  const change = trpc.auth.password.change.useMutation();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const s = status.data;
  if (!s?.enabled || !s.allowed) return null;
  const needsCurrent = s.hasPassword && !s.canSetWithoutCurrent;
  const problem = pw ? passwordProblem(pw, { name, email }) : null;
  const busy = set.isPending || change.isPending;

  const reset = () => { setCurrent(""); setPw(""); setPw2(""); setErr(null); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (problem) { setErr(problem); return; }
    if (pw !== pw2) { setErr("As duas palavras-passe não são iguais."); return; }
    try {
      if (needsCurrent) await change.mutateAsync({ current, password: pw });
      else await set.mutateAsync({ password: pw });
      toast.success(s.hasPassword ? "Palavra-passe mudada. As sessões nos outros aparelhos terminaram." : "Palavra-passe criada.");
      reset();
      setOpen(false);
      await utils.auth.password.status.invalidate();
    } catch (x: any) {
      setErr(x?.message ?? "Não foi possível guardar.");
    }
  };

  return (
    <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-3.5 py-3">
        <span className="w-8 h-8 rounded-[9px] bg-primary/10 text-primary flex items-center justify-center shrink-0"><KeyRound className="w-4 h-4" /></span>
        <div className="flex-1 min-w-0">
          <div className="text-[13.5px] font-semibold text-foreground">Palavra-passe</div>
          <div className="text-[11.5px] text-muted-foreground">
            {s.lockedUntil
              ? "Hoje a entrada com palavra-passe está bloqueada (tentativas erradas). Entra com um código."
              : s.hasPassword
                ? `Definida${s.setAt ? ` em ${fmtPTDateTime(s.setAt)}` : ""}. Entras com o email e a palavra-passe.`
                : "Ainda não tens. Sem ela, cada vez que entras pedes um código."}
          </div>
        </div>
        {!open && <Button size="sm" variant={s.hasPassword ? "outline" : "default"} onClick={() => { reset(); setOpen(true); }}>{s.hasPassword ? "Mudar" : "Criar"}</Button>}
      </div>
      {open && (
        <form onSubmit={submit} className="border-t border-border px-3.5 py-3 space-y-3" autoComplete="off">
          {needsCurrent && (
            <div className="space-y-1">
              <Label htmlFor="pw-current">Palavra-passe atual</Label>
              <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
              <p className="text-[11.5px] text-muted-foreground">Esqueceste-te? Sai e entra com um código: logo a seguir podes criar outra.</p>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="pw-new">Palavra-passe nova</Label>
            <Input id="pw-new" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
            <p className={`text-[11.5px] ${problem ? "text-amber-700" : "text-muted-foreground"}`}>{problem ?? `Pelo menos ${PASSWORD_MIN} caracteres. Não uses o teu nome nem datas.`}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="pw-new-2">Repete a palavra-passe</Label>
            <Input id="pw-new-2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </div>
          {s.hasPassword && <p className="text-[11.5px] text-muted-foreground">Ao mudar, as sessões nos outros aparelhos terminam (este fica).</p>}
          {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !pw || !pw2 || (needsCurrent && !current)}>
              {busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Guardar
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { reset(); setOpen(false); }}>Cancelar</Button>
          </div>
        </form>
      )}
    </div>
  );
}
