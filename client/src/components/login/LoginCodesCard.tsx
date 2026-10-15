/**
 * Plano 56: cartão "Códigos de entrada" (Atividade diária → Ao vivo) para o
 * TL e o supervisor de serviço — os pedidos dos últimos 15 minutos cujo código
 * veio para ti, com o nome, a foto da ficha, o aparelho e o código. Serve a
 * quem não tem os avisos no telemóvel ligados. Só com "Entrar com email e
 * código" ligado.
 */
import { KeyRound } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fmtPTTime } from "@/lib/lisbonTime";
import { formatCode } from "@shared/loginCode";
import { useCodeLoginOption } from "@/lib/loginOptions";

export function LoginCodesCard() {
  const { codeLogin } = useCodeLoginOption();
  const q = trpc.auth.codes.pendingForMe.useQuery(undefined, { enabled: codeLogin === true, refetchInterval: 15_000, retry: false });
  if (codeLogin !== true) return null;
  const rows = q.data ?? [];
  const pending = rows.filter((r) => r.status === "pending");
  const done = rows.filter((r) => r.status !== "pending").slice(0, 5);
  return (
    <Card className="mb-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><KeyRound className="h-4 w-4" />Códigos de entrada</CardTitle>
        <p className="text-xs text-muted-foreground">Dá o código só à própria pessoa, quando ta pedir (confirma quem é). Cada código vale 10 minutos e só funciona no aparelho onde foi pedido.</p>
      </CardHeader>
      <CardContent className="space-y-2">
        {q.error && <p role="alert" className="text-sm text-destructive">{q.error.message}</p>}
        {!q.error && pending.length === 0 && <p className="text-sm text-muted-foreground">Sem pedidos de código agora.</p>}
        {pending.map((r) => (
          <div key={r.id} className="flex items-center gap-3 rounded-lg border p-2.5">
            {r.photoUrl
              ? <img src={r.photoUrl} alt="" className="h-11 w-11 rounded-full object-cover border shrink-0" />
              : <div className="h-11 w-11 rounded-full bg-muted flex items-center justify-center text-sm font-semibold shrink-0">{r.name.slice(0, 1).toUpperCase()}</div>}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold [overflow-wrap:anywhere]">{r.name}</div>
              <div className="text-xs text-muted-foreground">
                {r.email ? "email sem ficha · " : ""}{r.device ?? "aparelho desconhecido"} · pedido às {fmtPTTime(r.createdAt)} · até às {fmtPTTime(r.expiresAt)}
              </div>
            </div>
            <div className="font-mono text-xl font-bold tracking-widest shrink-0" aria-label="Código">{r.code ? formatCode(r.code) : "—"}</div>
          </div>
        ))}
        {done.length > 0 && (
          <ul className="space-y-1 pt-1">
            {done.map((r) => (
              <li key={r.id} className="text-xs text-muted-foreground flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary" className="text-[10px]">{r.status === "used" ? "usado" : "já não vale"}</Badge>
                <span className="[overflow-wrap:anywhere]">{r.name}</span> · {fmtPTTime(r.createdAt)}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
