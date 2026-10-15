/**
 * "Movido pela IA → caixa (motivo)" numa conversa de email ou de WhatsApp
 * (Jorge, 8 out 2026: a IA separa sozinha; tem de se ver e de se poder
 * corrigir — o "Mover para…" / a caixa do WhatsApp já existentes corrigem e
 * fica registado). Não mostra nada quando a IA não mexeu na conversa.
 */
import { Sparkles } from "lucide-react";
import { trpc } from "@/lib/trpc";

export function AiRoutingNote({ channel, id, className }: { channel: "email" | "whatsapp"; id: number; className?: string }) {
  const q = trpc.commsRouting.note.useQuery({ channel, id }, { staleTime: 30_000, retry: false });
  const n = q.data;
  if (!n) return null;
  return (
    <div
      className={className ?? "px-3 py-1.5 border-b text-[11.5px] leading-snug bg-violet-50/70 dark:bg-violet-950/20 text-violet-900 dark:text-violet-200 flex items-start gap-1.5 shrink-0"}
      title="A IA separa sozinha as conversas novas pelas caixas. Se estiver errado, muda a caixa — fica registado que foi corrigido."
    >
      <Sparkles className="h-3.5 w-3.5 shrink-0 mt-px" aria-hidden />
      <span className="min-w-0 break-words">{n.text}</span>
    </div>
  );
}
