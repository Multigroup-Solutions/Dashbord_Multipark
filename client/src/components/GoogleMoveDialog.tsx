/**
 * 15 out 2026 (Jorge, caso Thiago Camargo): "Passar a conta Google" — a Google
 * Workspace renomeou a conta de quem saiu para a pessoa nova. A conta antiga
 * (desativada) larga a Google e volta ao nome/email da ficha, com o histórico;
 * a conta ativa escolhida passa a entrar com essa Google. Servidor:
 * identityLinks.moveGoogleAccount (server/googleAccountMove.ts).
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

export function GoogleMoveDialog({ from, onClose, onDone }: { from: { userId: number; email: string | null } | null; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState("");
  const [toId, setToId] = useState<number | null>(null);
  const [setEmail, setSetEmail] = useState(true);
  const search = trpc.users.search.useQuery({ search: q.trim(), limit: 8, sort: "name" }, { enabled: !!from && q.trim().length >= 2 });
  const preview = trpc.identityLinks.previewGoogleMove.useQuery({ fromUserId: from?.userId ?? 0, toUserId: toId ?? 0 }, { enabled: !!from && !!toId, retry: false });
  const move = trpc.identityLinks.moveGoogleAccount.useMutation({
    onSuccess: (r) => { toast.success(`Conta Google ${r.googleEmail ?? ""} passada. A conta antiga ficou com o histórico.`); reset(); onDone(); },
    onError: (e) => toast.error(e.message),
  });
  const reset = () => { setQ(""); setToId(null); setSetEmail(true); };
  const close = () => { reset(); onClose(); };
  const p = preview.data;

  return (
    <AlertDialog open={!!from} onOpenChange={(o) => !o && close()}>
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Passar a conta Google</AlertDialogTitle>
          <AlertDialogDescription>
            Para quando a Google Workspace renomeou a conta de quem saiu ({from?.email ?? "esta conta"}) para outra pessoa. Esta conta (desativada) larga a Google e
            volta ao nome e email da ficha dela — o histórico (ponto, tarefas, registos) fica com ela. A conta que escolheres passa a entrar com esta Google.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2 text-sm">
          <Input className="h-9" placeholder="Para a conta de… (nome ou email)" value={q} onChange={(e) => { setQ(e.target.value); setToId(null); }} aria-label="Procurar a conta que recebe a Google" />
          {search.data && search.data.rows.length > 0 && !toId && (
            <ul className="max-h-48 overflow-auto rounded-md border">
              {search.data.rows.filter((u: any) => u.id !== from?.userId).map((u: any) => (
                <li key={u.id} className="flex items-center justify-between gap-2 border-b px-2 py-1 last:border-0">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{u.name ?? "(sem nome)"} <span className="text-xs text-muted-foreground">{u.email ?? ""} · {u.role}{u.isActive ? "" : " · desativada"}</span></span>
                  <Button size="sm" variant="outline" className="h-7" disabled={!u.isActive} onClick={() => setToId(u.id)}>Escolher</Button>
                </li>
              ))}
            </ul>
          )}
          {toId && preview.isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          {preview.error && <p className="text-destructive">{preview.error.message}</p>}
          {p && (
            <div className="space-y-1 rounded-md border p-2">
              <p><strong>{p.googleEmail}</strong> passa a entrar na conta de <strong>{p.to.name ?? `#${p.to.id}`}</strong> ({p.to.email ?? "sem email"}).</p>
              <p className="text-muted-foreground">A conta antiga #{p.from.id} volta a {p.restore.name ?? p.from.name ?? "?"} &lt;{p.restore.email ?? p.from.email ?? "sem email"}&gt;, desativada, com o histórico.</p>
              <label className="flex items-center gap-2 pt-1"><Checkbox checked={setEmail} onCheckedChange={(v) => setSetEmail(v === true)} /> A conta de {p.to.name ?? "destino"} fica com {p.googleEmail} como email principal</label>
            </div>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={close}>Cancelar</AlertDialogCancel>
          <AlertDialogAction disabled={!p || move.isPending} onClick={(e) => { e.preventDefault(); if (from && toId) move.mutate({ fromUserId: from.userId, toUserId: toId, setEmail }); }}>
            {move.isPending ? "A passar…" : "Passar a conta Google"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
