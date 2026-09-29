import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { Sparkles, Check, X, Undo2, Mail, RefreshCw } from "lucide-react";
import {
  COMPLAINT_PRIORITY_LABEL_PT,
  COMPLAINT_TYPE_LABEL_PT,
  type ComplaintPriority,
  type ComplaintType,
} from "@shared/commsAi";

const FIELD_LABEL: Record<string, string> = {
  type: "Tipo",
  priority: "Prioridade",
  sla: "SLA",
  booking: "Reserva",
  duplicate: "Possível duplicado",
  draft: "Rascunho de resposta",
};

function valueLabel(field: string, value: string | null): string {
  if (value == null) return "—";
  if (field === "type") return COMPLAINT_TYPE_LABEL_PT[value as ComplaintType] ?? value;
  if (field === "priority") return COMPLAINT_PRIORITY_LABEL_PT[value as ComplaintPriority] ?? value;
  if (field === "sla") return `${value} h`;
  if (field === "duplicate") return `Reclamação #${value}`;
  return value;
}

const pct = (c: number | null) => (c == null ? "" : `${Math.round(c * 100)}%`);

/**
 * Sugestões da triagem por IA de uma reclamação (tipo, prioridade, SLA,
 * reserva, duplicado, rascunho). Aceitar/Rejeitar por campo; as aplicadas
 * sozinhas (confiança alta + campo vazio) podem ser desfeitas. O rascunho vai
 * para a janela "Enviar email" — é sempre uma pessoa que envia.
 */
export default function ComplaintAiPanel({
  complaintId,
  canEdit,
  onUseDraft,
  onChanged,
}: {
  complaintId: number;
  canEdit: boolean;
  onUseDraft: (text: string) => void;
  onChanged?: () => void;
}) {
  const utils = trpc.useUtils();
  const q = trpc.complaints.aiSuggestions.useQuery({ complaintId }, { retry: false });
  const refresh = () => {
    utils.complaints.aiSuggestions.invalidate({ complaintId });
    utils.complaints.getById.invalidate({ id: complaintId });
    utils.complaints.list.invalidate();
    onChanged?.();
  };
  const decide = trpc.complaints.aiDecide.useMutation({
    onSuccess: () => refresh(),
    onError: (e) => toast.error(e.message || "Não foi possível guardar"),
  });
  const retriage = trpc.complaints.aiRetriage.useMutation({
    onSuccess: (r) => { (r.ok ? toast.success : toast.info)(r.message); refresh(); },
    onError: () => toast.error("Não foi possível analisar agora"),
  });

  const data = q.data;
  // Sem sugestões e IA indisponível → não mostra nada (sem erros na UI).
  if (!data || (!data.suggestions.length && !data.available)) return null;
  const visible = data.suggestions.filter((s) => s.status !== "rejected" && s.status !== "accepted");
  const decided = data.suggestions.length - visible.length;

  return (
    <Card className="border-violet-200 dark:border-violet-900">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex flex-wrap items-center gap-2">
          <Sparkles className="w-4 h-4 text-violet-600" /> Sugestões da IA
          <span className="text-[11px] font-normal text-muted-foreground">nada é enviado ao cliente sem aprovação</span>
          {canEdit && data.available && (
            <Button
              size="sm" variant="ghost" className="ml-auto h-7 px-2 text-xs"
              disabled={retriage.isPending}
              onClick={() => retriage.mutate({ complaintId })}
            >
              <RefreshCw className={`w-3.5 h-3.5 mr-1 ${retriage.isPending ? "animate-spin" : ""}`} />
              {data.triagedAt ? "Voltar a analisar" : "Analisar"}
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {!visible.length && (
          <p className="text-xs text-muted-foreground">
            {data.triagedAt ? `Sem sugestões por decidir${decided ? ` (${decided} já decidida${decided > 1 ? "s" : ""})` : ""}.` : "Ainda não analisada."}
          </p>
        )}
        {visible.map((s) => {
          const applied = s.status === "applied";
          const busy = decide.isPending;
          if (s.field === "draft") {
            return (
              <div key={s.field} className="rounded-md border p-2 space-y-2">
                <div className="flex items-center gap-2 text-xs font-medium">
                  {FIELD_LABEL.draft}
                  <Badge variant="outline" className="text-[10px]">por aprovar</Badge>
                </div>
                <p className="text-sm whitespace-pre-wrap bg-muted/40 rounded p-2">{s.value}</p>
                {canEdit && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" className="h-8" onClick={() => { onUseDraft(s.value ?? ""); decide.mutate({ complaintId, field: "draft", decision: "accept" }); }} disabled={busy}>
                      <Mail className="w-4 h-4 mr-1" /> Usar no email
                    </Button>
                    <Button size="sm" variant="outline" className="h-8" onClick={() => decide.mutate({ complaintId, field: "draft", decision: "reject" })} disabled={busy}>
                      <X className="w-4 h-4 mr-1" /> Rejeitar
                    </Button>
                  </div>
                )}
              </div>
            );
          }
          return (
            <div key={s.field} className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-md border p-2">
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                  <span className="text-muted-foreground">{FIELD_LABEL[s.field] ?? s.field}:</span>
                  <span className="font-medium break-all">{valueLabel(s.field, s.value)}</span>
                  {s.confidence != null && (
                    <Badge variant="outline" className="text-[10px]" title="Confiança da IA">{pct(s.confidence)}</Badge>
                  )}
                  {applied && <Badge className="text-[10px] bg-violet-100 text-violet-800">aplicado automaticamente</Badge>}
                </div>
                {s.reason && <p className="text-[11px] text-muted-foreground mt-0.5 break-words">{s.reason}</p>}
              </div>
              {canEdit && (
                <div className="flex gap-1.5 shrink-0">
                  {applied ? (
                    <>
                      <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => decide.mutate({ complaintId, field: s.field, decision: "accept" })}>
                        <Check className="w-4 h-4 mr-1" /> Manter
                      </Button>
                      <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => decide.mutate({ complaintId, field: s.field, decision: "reject" })}>
                        <Undo2 className="w-4 h-4 mr-1" /> Desfazer
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" className="h-8" disabled={busy} onClick={() => decide.mutate({ complaintId, field: s.field, decision: "accept" })}>
                        <Check className="w-4 h-4 mr-1" /> Aceitar
                      </Button>
                      <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => decide.mutate({ complaintId, field: s.field, decision: "reject" })}>
                        <X className="w-4 h-4 mr-1" /> Rejeitar
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
