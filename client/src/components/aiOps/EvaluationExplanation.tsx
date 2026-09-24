/**
 * Explicação curta da pontuação (a partir das linhas das regras; a IA nunca
 * recalcula). "A minha avaliação" e a gaveta do detalhe. O team leader (ou
 * acima) pode esconder/mostrar a explicação ao colaborador.
 */
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Eye, EyeOff, Sparkles } from "lucide-react";

export default function EvaluationExplanation({ employeeId, from, to }: { employeeId?: number; from: string; to: string }) {
  const utils = trpc.useUtils();
  const q = trpc.evaluation.explanation.useQuery({ from, to, employeeId }, { staleTime: 10 * 60_000, retry: false });
  const hide = trpc.evaluation.setExplanationHidden.useMutation({
    onSuccess: () => { utils.evaluation.explanation.invalidate(); toast.success("Atualizado"); },
    onError: (e) => toast.error(e.message),
  });
  const r = q.data;
  if (!r || (!r.text && !r.canHide)) return null;
  return (
    <div className={`rounded-lg border p-3 text-sm space-y-2 ${r.hidden ? "opacity-70 border-dashed" : "bg-muted/30"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold">Explicação</span>
        {r.ai && <Badge variant="outline" className="text-[10px] gap-1"><Sparkles className="h-3 w-3" />IA</Badge>}
        {r.hidden && <Badge variant="secondary" className="text-[10px]">escondida ao colaborador{r.hiddenByName ? ` por ${r.hiddenByName}` : ""}</Badge>}
        {r.canHide && employeeId && (
          <Button size="sm" variant="ghost" className="ml-auto h-7 px-2" disabled={hide.isPending}
            onClick={() => hide.mutate({ employeeId, from, to, hidden: !r.hidden })}>
            {r.hidden ? <><Eye className="h-3.5 w-3.5 mr-1" />Mostrar</> : <><EyeOff className="h-3.5 w-3.5 mr-1" />Esconder</>}
          </Button>
        )}
      </div>
      {r.text && <p className="leading-relaxed">{r.text}</p>}
      <p className="text-[11px] text-muted-foreground">A pontuação é a da tabela; este texto só a explica.</p>
    </div>
  );
}
