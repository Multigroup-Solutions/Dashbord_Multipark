import { Link } from "wouter";
import { toast } from "sonner";
import { ClipboardPlus, ExternalLink, Sparkles } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { can } from "@shared/access";
import { Button } from "@/components/ui/button";
import { CASE_PROPOSAL_LABEL, isCaseProposalKind, type CaseProposalKind } from "@shared/whatsappConversation";

/**
 * D34 (Jorge, 3 out 2026): a triagem PROPÕE o caso — uma pessoa decide.
 * "Criar …" cria a reclamação/perdido com os dados da conversa; "Não é" faz a
 * proposta desaparecer desta conversa. Depois de criado, fica o link.
 */
export function CaseProposalBar({ t }: {
  t: { conversationId: number; caseProposal: CaseProposalKind | null; caseKind: string | null; caseId: number | null };
}) {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const refresh = () => utils.whatsapp.messages.byConversation.invalidate({ conversationId: t.conversationId });
  const create = trpc.whatsapp.conversations.createCase.useMutation({
    onSuccess: (r) => {
      toast.success(r.kind === "complaint" ? `Reclamação #${r.id} criada.` : `Perdido #${r.id} criado.`);
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const dismiss = trpc.whatsapp.conversations.dismissCaseProposal.useMutation({
    onSuccess: () => refresh(),
    onError: (e) => toast.error(e.message),
  });

  if (t.caseId && isCaseProposalKind(t.caseKind)) {
    const l = CASE_PROPOSAL_LABEL[t.caseKind];
    return (
      <div className="flex items-center gap-1.5 px-3 py-1 text-[11px] border-b bg-muted/40 text-muted-foreground shrink-0">
        <ClipboardPlus className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate">{t.caseKind === "complaint" ? "Reclamação" : "Perdido"} #{t.caseId} criado a partir desta conversa.</span>
        <Link href={l.link(t.caseId)} className="ml-auto inline-flex items-center gap-1 text-primary hover:underline shrink-0">
          Abrir <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
    );
  }
  const kind = t.caseProposal;
  if (!kind) return null;
  const l = CASE_PROPOSAL_LABEL[kind];
  const canCreate = can(user as any, kind === "complaint" ? "reclamacoes" : "perdidos", "edit");
  const canDismiss = can(user as any, "whatsapp", "edit");
  const busy = create.isPending || dismiss.isPending;
  return (
    <div role="status" className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 text-[12px] border-b bg-violet-50 text-violet-900 dark:bg-violet-950/40 dark:text-violet-100 shrink-0">
      <Sparkles className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">A triagem acha que isto é <strong>{l.noun}</strong>.</span>
      {canCreate && (
        <Button size="sm" className="h-6 px-2 text-[11px]" disabled={busy} onClick={() => create.mutate({ conversationId: t.conversationId, kind })}>
          {l.create}
        </Button>
      )}
      {canDismiss && (
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={busy} onClick={() => dismiss.mutate({ conversationId: t.conversationId })}>
          Não é
        </Button>
      )}
    </div>
  );
}
