/**
 * 49c (Jorge, 8 out 2026): "Liga a tua conta" — quem entra com uma conta
 * Google que não está em nenhuma ficha escolhe:
 *   a) "Sou novo — quero candidatar-me": cria a ficha de candidato (ou liga à
 *      que já existe com este email) e abre "A minha ficha";
 *   b) "Já me candidatei / já trabalhei convosco com outro email": escreve o
 *      email OU o telefone que usou. A resposta é sempre a mesma (não revela
 *      quem existe); com o código por email ligado, escreve-se o código aqui.
 * Regras no servidor (server/accountLink.ts).
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { Loader2, LogOut, Mail, UserPlus, UserSearch } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CITY_KEYS, CITY_LABELS } from "@shared/city";

export function LinkAccountScreen({ email, fallbackMessage }: { email?: string | null; fallbackMessage: string }) {
  const { logout } = useAuth();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const mine = trpc.accountLink.mine.useQuery(undefined, { retry: false });
  const [mode, setMode] = useState<"choose" | "new" | "claim">("choose");
  const [claim, setClaim] = useState("");
  const [code, setCode] = useState("");
  const [reply, setReply] = useState<{ requestId: number; codeExpected: boolean; message: string } | null>(null);

  // Ligou → a conta passa a ter ficha: recarrega a sessão e abre "A minha ficha".
  const done = async (text: string) => {
    toast.success(text);
    await Promise.all([utils.auth.me.invalidate(), utils.rh.me.invalidate(), utils.accountLink.mine.invalidate()]);
    try { sessionStorage.removeItem("mp.filters.hr.selectedId"); } catch { /* sem storage */ }
    navigate("/rh");
  };

  const start = trpc.accountLink.startCandidate.useMutation({
    onSuccess: async (r) => {
      if (r.outcome === "pending_rh") {
        toast.info("O teu email já está numa ficha que o RH tem de confirmar. Já lhe enviámos o pedido.");
        utils.accountLink.mine.invalidate();
        return;
      }
      await done(r.outcome === "created" ? "Ficha de candidato criada. Preenche os teus dados e carrega os documentos." : "Conta ligada à tua ficha.");
    },
    onError: (e) => toast.error(e.message),
  });
  const request = trpc.accountLink.request.useMutation({
    onSuccess: (r) => { setReply(r); setCode(""); utils.accountLink.mine.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const confirm = trpc.accountLink.confirmCode.useMutation({
    onSuccess: () => done("Conta ligada à tua ficha."),
    onError: (e) => toast.error(e.message),
  });

  const pending = mine.data?.pending ?? null;
  // Código: o pedido acabado de fazer, ou um pendente ainda dentro dos 10 minutos.
  const codeRequestId = reply?.codeExpected ? reply.requestId : pending?.codeWindow ? pending.id : null;

  return (
    <div className="max-w-lg mx-auto py-8 px-4">
      <Card role="region" aria-labelledby="link-account-title">
        <CardContent className="py-6 space-y-5">
          <div className="space-y-1 text-center">
            <UserSearch className="w-10 h-10 mx-auto text-primary" aria-hidden />
            <h2 id="link-account-title" className="text-lg font-semibold">Liga a tua conta</h2>
            <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
              Entraste com <strong>{email || "uma conta Google"}</strong>, que ainda não está em nenhuma ficha. Escolhe o teu caso:
            </p>
          </div>

          {pending && !reply && (
            <p role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-100">
              Tens um pedido à espera do RH{pending.claimed ? <> (disseste <strong className="[overflow-wrap:anywhere]">{pending.claimed}</strong>)</> : null}. Quando o RH ligar a tua conta, sai e volta a entrar.
            </p>
          )}

          {mode === "choose" && (
            <div className="grid gap-3">
              <Button size="lg" className="h-auto py-3 justify-start text-left whitespace-normal" onClick={() => setMode("new")}>
                <UserPlus className="h-5 w-5 mr-3 shrink-0" />
                <span><strong className="block">Sou novo — quero candidatar-me</strong>
                  <span className="text-xs opacity-90">Crio a minha ficha com este email, preencho os dados e carrego os documentos. O RH aprova.</span></span>
              </Button>
              <Button size="lg" variant="outline" className="h-auto py-3 justify-start text-left whitespace-normal" onClick={() => setMode("claim")}>
                <Mail className="h-5 w-5 mr-3 shrink-0" />
                <span><strong className="block">Já me candidatei / já trabalhei convosco com outro email</strong>
                  <span className="text-xs text-muted-foreground">Digo o email ou o telefone que usei e ligamos esta conta à minha ficha.</span></span>
              </Button>
            </div>
          )}

          {mode === "new" && (
            <div className="space-y-3">
              <p className="text-sm font-medium">Em que cidade queres trabalhar?</p>
              <div className="grid grid-cols-2 gap-2">
                {CITY_KEYS.map((k) => (
                  <Button key={k} variant="outline" disabled={start.isPending} onClick={() => start.mutate({ city: k })}>{CITY_LABELS[k]}</Button>
                ))}
                <Button variant="ghost" disabled={start.isPending} onClick={() => start.mutate({ city: null })}>Ainda não sei</Button>
              </div>
              {start.isPending && <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />A criar a tua ficha…</p>}
              <Button variant="ghost" size="sm" disabled={start.isPending} onClick={() => setMode("choose")}>Voltar</Button>
            </div>
          )}

          {mode === "claim" && (
            <div className="space-y-3">
              {!reply ? (
                <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (claim.trim().length >= 3) request.mutate({ claim: claim.trim() }); }}>
                  <Label htmlFor="link-claim">Email ou telefone com que te candidataste (ou trabalhaste connosco)</Label>
                  <Input id="link-claim" autoFocus autoComplete="off" maxLength={320} placeholder="ex.: nome@gmail.com ou 912 345 678"
                    value={claim} onChange={(e) => setClaim(e.target.value)} />
                  <p className="text-xs text-muted-foreground">Não ligamos só pelo nome: tem de ser o email ou o telefone que nos deste.</p>
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" disabled={request.isPending || claim.trim().length < 3}>
                      {request.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}Enviar
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setMode("choose")}>Voltar</Button>
                  </div>
                </form>
              ) : (
                <p role="status" className="rounded-md border bg-muted/40 p-3 text-sm">{reply.message}</p>
              )}
              {codeRequestId != null && (
                <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (code.trim()) confirm.mutate({ requestId: codeRequestId, code: code.trim() }); }}>
                  <Label htmlFor="link-code">Código recebido por email</Label>
                  <Input id="link-code" inputMode="numeric" autoComplete="one-time-code" maxLength={8} placeholder="000000"
                    value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, ""))} />
                  <Button type="submit" disabled={confirm.isPending || code.length < 6}>
                    {confirm.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}Ligar a minha conta
                  </Button>
                </form>
              )}
              {reply && <Button variant="ghost" size="sm" onClick={() => { setReply(null); setClaim(""); setMode("choose"); }}>Voltar ao início</Button>}
            </div>
          )}

          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Tens outra conta Google (a que deste ao RH)?</summary>
            <p className="mt-2 [overflow-wrap:anywhere]">{fallbackMessage} Sai e entra com essa conta.</p>
          </details>
          <div className="text-center">
            <Button variant="outline" size="sm" onClick={() => { Promise.resolve(logout()).finally(() => { window.location.href = "/"; }); }}>
              <LogOut className="h-4 w-4 mr-1.5" />Sair (para entrar com outra conta)
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
