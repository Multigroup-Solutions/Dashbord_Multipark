/**
 * Pontuação de uma lead (0–100, critérios explícitos calculados no sistema:
 * disponibilidade, cidade, experiência, anos de carta, rapidez de resposta)
 * + resumo de uma linha (IA) + rascunho do 1.º contacto, que só sai depois
 * de aprovado. O template «seja_motorista» continua no botão WhatsApp.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Check, Loader2, Sparkles, X } from "lucide-react";

export interface LeadScoreRow { leadId: number; score: number; lines: Array<{ key: string; label: string; points: number; max: number; detail: string }>; summary: string | null; draftMessage: string | null; draftStatus: string | null }

const tone = (s: number) => (s >= 70 ? "bg-green-100 text-green-800" : s >= 45 ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-700");

export default function LeadScoreCell({ leadId, row, canEdit }: { leadId: number; row: LeadScoreRow | undefined; canEdit: boolean }) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState<string | null>(null);
  const refresh = () => utils.aiOps.leads.scores.invalidate();
  const summarize = trpc.aiOps.leads.summarize.useMutation({ onSuccess: refresh, onError: (e) => toast.error(e.message) });
  const makeDraft = trpc.aiOps.leads.draftFirstContact.useMutation({
    onSuccess: (r) => { setDraft(r.message); refresh(); },
    onError: (e) => toast.error(e.message),
  });
  const review = trpc.aiOps.leads.reviewFirstContact.useMutation({
    onSuccess: (r) => {
      refresh();
      setDraft(null);
      if (r.status === "rejected") toast.info("Rascunho rejeitado");
      else if (r.sent) toast.success("Aprovado e enviado por WhatsApp");
      else toast.info(`Aprovado. ${r.reason ?? ""}`.trim());
    },
    onError: (e) => toast.error(e.message),
  });
  if (!row) return <span className="text-muted-foreground text-xs">—</span>;
  const pending = row.draftStatus === "pending";
  const text = draft ?? (pending ? row.draftMessage : null);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex items-center gap-1" aria-label={`Pontuação ${row.score}`}>
          <Badge variant="secondary" className={`tabular-nums ${tone(row.score)}`}>{row.score}</Badge>
          {pending && <Badge variant="outline" className="text-[10px]">rascunho</Badge>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(22rem,calc(100vw-2rem))] space-y-3" align="start">
        <div className="text-sm font-semibold">Pontuação {row.score}/100</div>
        <ul className="text-xs space-y-1">
          {row.lines.map((l) => (
            <li key={l.key} className="flex justify-between gap-2">
              <span>{l.label} <span className="text-muted-foreground">({l.detail})</span></span>
              <span className="tabular-nums font-medium">{l.points}/{l.max}</span>
            </li>
          ))}
        </ul>
        <p className="text-[11px] text-muted-foreground">Só critérios explícitos; nunca idade, género, nacionalidade ou outros dados sensíveis.</p>
        {row.summary ? (
          <p className="text-sm bg-muted/40 rounded p-2">{row.summary}</p>
        ) : (
          <Button size="sm" variant="outline" className="h-8" disabled={summarize.isPending} onClick={() => summarize.mutate({ leadIds: [leadId] })}>
            {summarize.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 mr-1" />}Resumo IA
          </Button>
        )}
        {canEdit && (
          <div className="space-y-2 border-t pt-2">
            <div className="text-xs font-semibold">1.º contacto (precisa de aprovação)</div>
            {text != null ? (
              <>
                <Textarea rows={5} value={text} maxLength={1000} onChange={(e) => setDraft(e.target.value)} />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" className="h-8" disabled={review.isPending || !text.trim()} onClick={() => review.mutate({ leadId, approve: true, message: text.trim() })}><Check className="h-3.5 w-3.5 mr-1" />Aprovar</Button>
                  <Button size="sm" variant="outline" className="h-8" disabled={review.isPending} onClick={() => review.mutate({ leadId, approve: false })}><X className="h-3.5 w-3.5 mr-1" />Rejeitar</Button>
                </div>
                <p className="text-[11px] text-muted-foreground">Aprovado: sai por WhatsApp se a janela de 24 h estiver aberta; senão usa o template.</p>
              </>
            ) : (
              <Button size="sm" variant="outline" className="h-8" disabled={makeDraft.isPending} onClick={() => makeDraft.mutate({ leadId })}>
                {makeDraft.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 mr-1" />}Rascunho com IA
              </Button>
            )}
            {row.draftStatus && row.draftStatus !== "pending" && !draft && (
              <p className="text-[11px] text-muted-foreground">Último rascunho: {row.draftStatus === "approved" ? "aprovado" : "rejeitado"}.</p>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
