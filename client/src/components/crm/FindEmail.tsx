/**
 * CRM — email estranho (balcão/agregador): procura o email verdadeiro do
 * cliente na nossa caixa (Comunicação) e propõe-no; sem resultado, retira o
 * email e a ficha fica só com telefone e carro.
 */
import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { shortDate } from "./crmUi";

export function FindEmailButton({ clientId, genericIds, canEdit, onUsed, autoOpen = false }: {
  clientId: number; genericIds: number[]; canEdit: boolean; onUsed: () => void; autoOpen?: boolean;
}) {
  const [on, setOn] = useState(autoOpen);
  const q = trpc.crm.findEmail.useQuery({ clientId }, { enabled: on, retry: false });
  const contact = trpc.crm.contact.useMutation({ onError: (e) => toast.error(e.message) });
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try { await fn(); toast.success(ok); onUsed(); } catch { /* erro já mostrado */ } finally { setBusy(false); }
  };
  const dropGeneric = async () => {
    for (const id of genericIds) await contact.mutateAsync({ op: "removeEmail", clientId, itemId: id, reason: "email de balcão/agregador" });
  };
  const use = (email: string) => run(async () => {
    await contact.mutateAsync({ op: "addEmail", clientId, value: email, primary: true });
    await dropGeneric();
  }, "Email atualizado");
  const drop = () => run(dropGeneric, "Email retirado: a ficha fica só com telefone e carro");

  if (!on) return <Button size="sm" variant="outline" className="h-[30px]" onClick={() => setOn(true)}>Procurar na nossa caixa</Button>;
  return (
    <div className="w-full space-y-2 rounded-lg bg-muted p-2.5">
      <div className="text-[11px] font-bold uppercase tracking-[0.05em] text-muted-foreground">Encontrado na nossa caixa de email</div>
      {q.isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      {q.data && q.data.length === 0 && <p className="text-xs text-muted-foreground">Não encontrámos mensagens deste cliente (nome, matrícula ou n.º de reserva).</p>}
      {(q.data ?? []).map((r) => (
        <div key={r.email} className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="min-w-0 flex-1">
            <strong>{r.email}</strong>{r.fromName ? ` (${r.fromName})` : ""}{" "}
            <span className="text-xs text-muted-foreground">· {r.messages} {r.messages === 1 ? "mensagem" : "mensagens"}, a última a {shortDate(r.lastAt)}{r.subject ? ` «${r.subject}»` : ""}</span>
          </span>
          {canEdit && <Button size="sm" className="h-[30px]" disabled={busy} onClick={() => use(r.email)}>Usar este email</Button>}
        </div>
      ))}
      {canEdit && q.data && genericIds.length > 0 && (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" className="h-[30px]" disabled={busy} onClick={drop}>Retirar o email (fica sem email)</Button>
        </div>
      )}
    </div>
  );
}
