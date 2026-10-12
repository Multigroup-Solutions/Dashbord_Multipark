// Lote 57 (Jorge, 12 out 2026): emails de OUTRAS caixas (info@, reservas@…)
// que a IA achou que podem ser reclamações, com pouca certeza para criar
// sozinha: "Parece uma reclamação → Criar reclamação" ou "Não é reclamação".
// Nada é enviado ao cliente; o email fica na caixa onde chegou.
import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sparkles, Plus, X, ExternalLink, AlertTriangle } from "lucide-react";

const VISIBLE = 3;

export default function ComplaintMailSuggestions({ canEdit, onOpenComplaint }: { canEdit: boolean; onOpenComplaint: (id: number) => void }) {
  const utils = trpc.useUtils();
  const q = trpc.complaints.mailSuggestions.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const [showAll, setShowAll] = useState(false);
  const refresh = () => { utils.complaints.mailSuggestions.invalidate(); utils.complaints.list.invalidate(); };
  const create = trpc.complaints.createFromMailSuggestion.useMutation({
    onSuccess: (r) => {
      toast.success(r.already ? `Esta conversa já está na reclamação #${r.complaintId}` : r.isNew ? `Reclamação #${r.complaintId} criada (nada foi enviado ao cliente)` : `Email junto à reclamação aberta #${r.complaintId}`);
      refresh();
      onOpenComplaint(r.complaintId);
    },
    onError: (e) => { toast.error(e.message || "Não foi possível criar a reclamação"); refresh(); },
  });
  const dismiss = trpc.complaints.dismissMailSuggestion.useMutation({
    onSuccess: () => { toast.success("Marcado: não é reclamação (fica registado)"); refresh(); },
    onError: (e) => toast.error(e.message || "Não foi possível guardar"),
  });

  if (q.isError) return <QueryErrorNote error={q.error} what="as sugestões da IA (emails de outras caixas)" onRetry={() => q.refetch()} retrying={q.isFetching} />;
  const items = q.data?.items ?? [];
  if (!items.length) return null;
  const shown = showAll ? items : items.slice(0, VISIBLE);
  const busy = create.isPending || dismiss.isPending;

  return (
    <Card className="border-violet-200 dark:border-violet-900" data-testid="complaint-mail-suggestions">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex flex-wrap items-center gap-x-2 gap-y-1">
          <Sparkles className="w-4 h-4 text-violet-600 shrink-0" aria-hidden />
          <span>Parecem reclamações ({items.length})</span>
          <span className="text-[11px] font-normal text-muted-foreground">emails de outras caixas que a IA leu — uma pessoa decide; nada é enviado ao cliente</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {shown.map((s) => (
          <div key={s.id} className="rounded-md border p-2 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <Badge variant="secondary" className="text-[11px] max-w-full"><span className="truncate">Chegou a {s.fromBoxLabel}</span></Badge>
              {s.confidence != null && <Badge variant="outline" className="text-[11px]" title="Certeza da IA">{Math.round(s.confidence * 100)}%</Badge>}
              {s.status === "failed" && <Badge className="text-[11px] bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200">Falhou ao criar</Badge>}
              <span className="ml-auto text-muted-foreground whitespace-nowrap tabular-nums">{s.at ? fmtPTDateTime(s.at) : ""}</span>
            </div>
            <div className="text-sm font-medium break-words [overflow-wrap:anywhere]">{s.subject}</div>
            <div className="text-xs text-muted-foreground break-words [overflow-wrap:anywhere]">
              {[s.contactName, s.contactEmail].filter(Boolean).join(" · ") || "—"}
            </div>
            {s.snippet && <p className="text-xs text-muted-foreground line-clamp-2 break-words [overflow-wrap:anywhere]">{s.snippet}</p>}
            {s.reason && <p className="text-[11px] text-violet-800 dark:text-violet-300 break-words">IA: {s.reason}</p>}
            {s.status === "failed" && s.error && (
              <p className="flex items-start gap-1 text-[11px] text-red-800 dark:text-red-300"><AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" aria-hidden /><span className="min-w-0 break-words">{s.error}</span></p>
            )}
            <div className="flex flex-wrap gap-2 pt-0.5">
              {canEdit && (
                <Button size="sm" className="h-8" disabled={busy} onClick={() => create.mutate({ id: s.id })}>
                  <Plus className="w-4 h-4 mr-1" /> {s.status === "failed" ? "Tentar de novo" : "Criar reclamação"}
                </Button>
              )}
              {canEdit && (
                <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => dismiss.mutate({ id: s.id })}>
                  <X className="w-4 h-4 mr-1" /> Não é reclamação
                </Button>
              )}
              <Button size="sm" variant="ghost" className="h-8" asChild>
                <Link href={s.link}><ExternalLink className="w-4 h-4 mr-1" /> Abrir conversa</Link>
              </Button>
            </div>
          </div>
        ))}
        {items.length > VISIBLE && (
          <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Mostrar só as primeiras" : `Ver todas (${items.length})`}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
