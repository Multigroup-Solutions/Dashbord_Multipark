/**
 * 👍/👎 por baixo de cada resposta do Multis (Multis 2). O 👎 abre um
 * mini-formulário (o que estava errado + comentário opcional). Mudar de ideias
 * atualiza a mesma avaliação. As respostas com 👎 vão para "Perguntas que
 * falharam" (só admins).
 */
import { useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { FEEDBACK_COMMENT_MAX, FEEDBACK_REASONS, FEEDBACK_REASON_LABELS, type FeedbackReason } from "@shared/assistantFeedback";

export function MultisFeedback({ messageId, rating, onRated }: {
  messageId: number;
  rating: 1 | -1 | null | undefined;
  onRated: (rating: 1 | -1) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<FeedbackReason | null>(null);
  const [comment, setComment] = useState("");
  const [thanks, setThanks] = useState(false);
  const give = trpc.assistant.feedback.give.useMutation({
    onSuccess: (_r, v) => {
      onRated(v.rating);
      setOpen(false);
      setThanks(true);
    },
    onError: (e) => toast.error(e.message || "Não foi possível guardar a avaliação."),
  });

  const btn = "inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:opacity-50";
  return (
    <div className="mt-1.5 space-y-1.5">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={cn(btn, rating === 1 && "text-emerald-700 dark:text-emerald-400")}
          aria-label="Boa resposta"
          aria-pressed={rating === 1}
          title="Boa resposta"
          disabled={give.isPending}
          onClick={() => { if (rating !== 1) give.mutate({ messageId, rating: 1 }); }}
        >
          <ThumbsUp className={cn("h-3.5 w-3.5", rating === 1 && "fill-current")} />
        </button>
        <button
          type="button"
          className={cn(btn, rating === -1 && "text-red-700 dark:text-red-400")}
          aria-label="Má resposta"
          aria-pressed={rating === -1}
          aria-expanded={open}
          title="Má resposta — diz o que estava errado"
          disabled={give.isPending}
          onClick={() => setOpen((o) => !o)}
        >
          <ThumbsDown className={cn("h-3.5 w-3.5", rating === -1 && "fill-current")} />
        </button>
        {thanks && !open && <span className="text-[11px] text-muted-foreground">Obrigado — ajuda a melhorar o Multis.</span>}
      </div>
      {open && (
        <div className="space-y-2 rounded-md border bg-background p-2">
          <p className="text-xs font-medium">O que estava errado?</p>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Motivo">
            {FEEDBACK_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={reason === r}
                onClick={() => setReason(r)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                  reason === r ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent",
                )}
              >
                {FEEDBACK_REASON_LABELS[r]}
              </button>
            ))}
          </div>
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value.slice(0, FEEDBACK_COMMENT_MAX))}
            rows={2}
            placeholder="O que esperavas? (opcional)"
            className="min-h-0 text-xs"
            aria-label="Comentário"
          />
          <div className="flex justify-end gap-1">
            <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              disabled={!reason || give.isPending}
              onClick={() => give.mutate({ messageId, rating: -1, reason, comment: comment.trim() || null })}
            >
              Enviar
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
