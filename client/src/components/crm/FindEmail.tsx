/**
 * CRM — email estranho (balcão/agregador): procura o email verdadeiro do
 * cliente na nossa caixa (Comunicação — só mensagens RECEBIDAS e de emails de
 * pessoas) e propõe-no; sem resultado, retira o email e a ficha fica só com
 * telefone e carro. Trocar é UM pedido (21c): ou fica tudo, ou nada.
 */
import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { shortDate } from "./crmUi";

export function FindEmailButton({ clientId, hasGeneric, canEdit, onUsed, autoOpen = false }: {
  clientId: number; hasGeneric: boolean; canEdit: boolean; onUsed: () => void; autoOpen?: boolean;
}) {
  const [on, setOn] = useState(autoOpen);
  const q = trpc.crm.findEmail.useQuery({ clientId }, { enabled: on, retry: false });
  const replace = trpc.crm.replaceGenericEmail.useMutation({
    onSuccess: (r) => { toast.success(r.email ? "Email atualizado (o de balcão ficou em Retirados)" : "Email retirado: a ficha fica só com telefone e carro"); onUsed(); },
    onError: (e) => toast.error(e.message),
  });

  if (!on) return <Button size="sm" variant="outline" className="h-[30px]" onClick={() => setOn(true)}>Procurar na nossa caixa</Button>;
  return (
    <div className="w-full space-y-2 rounded-lg bg-muted p-2.5">
      <div className="text-[11px] font-bold uppercase tracking-[0.05em] text-muted-foreground">Encontrado na nossa caixa de email</div>
      {q.isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      {q.error && <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="a procura na caixa" />}
      {q.data && q.data.length === 0 && <p className="text-xs text-muted-foreground">Não encontrámos mensagens deste cliente (nome, matrícula ou n.º de reserva).</p>}
      {(q.data ?? []).map((r) => (
        <div key={r.email} className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="min-w-0 flex-1 break-words">
            <strong className="break-all">{r.email}</strong>{r.fromName ? ` (${r.fromName})` : ""}{" "}
            <span className="text-xs text-muted-foreground">· {r.messages} {r.messages === 1 ? "mensagem" : "mensagens"}, a última a {shortDate(r.lastAt)}{r.subject ? ` «${r.subject}»` : ""}</span>
          </span>
          {canEdit && <Button size="sm" className="h-[30px]" disabled={replace.isPending} onClick={() => replace.mutate({ clientId, email: r.email })}>Usar este email</Button>}
        </div>
      ))}
      {canEdit && q.data && hasGeneric && (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" className="h-[30px]" disabled={replace.isPending} onClick={() => replace.mutate({ clientId, email: null })}>Retirar o email (fica sem email)</Button>
        </div>
      )}
    </div>
  );
}
