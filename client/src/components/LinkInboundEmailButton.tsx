import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Mail, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { QueryErrorNote } from "@/components/QueryErrorNote";

/**
 * Anexa um email da caixa (inbound) a um caso, transcrevendo-o como MENSAGEM.
 * Para o cenário multi-identidade (ex.: email do marido, participação da mulher)
 * que o match automático não apanha. Reutilizável por Reclamações e Perdidos.
 */
export default function LinkInboundEmailButton({
  module, alias, caseId, defaultSearch, onLinked,
}: {
  module: "complaint" | "lostfound";
  alias: "reclamacoes" | "perdidos";
  caseId: number;
  defaultSearch?: string | null;
  onLinked?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState(defaultSearch || "");
  const emailsQ = trpc.clients.inboundEmails.useQuery(
    { alias, search: search || null },
    { enabled: open },
  );
  const { data: emails = [], isFetching } = emailsQ;
  const link = trpc.clients.linkInbound.useMutation({
    onSuccess: (r: any) => { toast.success(r?.already ? "Este email já estava anexado a este caso" : "Email anexado ao caso (visível nas mensagens)"); onLinked?.(); setOpen(false); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <>
      <Button variant="outline" size="sm" className="w-full mt-2" onClick={() => setOpen(true)}>
        <Mail className="w-4 h-4 mr-2" /> Anexar email da caixa
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>Anexar email a este caso</DialogTitle></DialogHeader>
          <Input
            placeholder="Procurar por email, nome ou assunto…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="space-y-1 max-h-[50vh] overflow-y-auto">
            {isFetching && <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>}
            {emailsQ.isError && <QueryErrorNote error={emailsQ.error} what="os emails da caixa" onRetry={() => emailsQ.refetch()} retrying={isFetching} />}
            {!isFetching && !emailsQ.isError && emails.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-6">
                Sem emails. Reencaminha para <b>{alias}@multipark.pt</b> e sincroniza.
              </p>
            )}
            {(emails as any[]).map((em) => (
              <div key={em.id} className="border rounded p-2 text-sm flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium truncate">{em.subject || "(sem assunto)"}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {em.clientName || em.fromName || em.fromEmail || "—"}
                    {em.receivedAt ? ` · ${fmtPTDateTime(em.receivedAt)}` : ""}
                  </div>
                  {em.bodyText && <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{em.bodyText}</div>}
                  {em.targetId && <Badge variant="outline" className="text-[10px] mt-1">já ligado a #{em.targetId}</Badge>}
                </div>
                <Button size="sm" disabled={link.isPending} onClick={() => link.mutate({ inboundId: em.id, module, caseId })}>
                  Anexar
                </Button>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
