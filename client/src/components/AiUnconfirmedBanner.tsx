import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Archive, Check, Sparkles } from "lucide-react";

/** O que aparece na lista (cartão) de um caso criado pela IA com certeza média. */
export const AI_UNCONFIRMED_LABEL = "Por confirmar (IA)";

/** Selo do cartão. */
export function AiUnconfirmedBadge() {
  return (
    <Badge variant="outline" className="text-[11px] border-violet-400 bg-violet-50 text-violet-900 dark:border-violet-700 dark:bg-violet-950/50 dark:text-violet-100"
      title="A IA criou este caso a partir de um email, mas não tinha a certeza — abre para confirmar ou arquivar">
      {AI_UNCONFIRMED_LABEL}
    </Badge>
  );
}

/**
 * 14 out 2026: o caso nasceu de um email que a IA leu com certeza média.
 * "É reclamação" / "É perdido" confirma; "Não é" abre o arquivo (com motivo —
 * nada se apaga).
 */
export function AiUnconfirmedBanner({ kind, canConfirm, canArchive, confirming, onConfirm, onReject }: {
  kind: "complaint" | "lost_found";
  canConfirm: boolean;
  canArchive: boolean;
  confirming: boolean;
  onConfirm: () => void;
  onReject: () => void;
}) {
  const complaint = kind === "complaint";
  return (
    <div role="status" className="rounded-md border border-violet-300 bg-violet-50 p-3 text-sm text-violet-900 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-100 flex flex-wrap items-center gap-2">
      <Sparkles className="w-4 h-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 basis-60">
        <strong>{AI_UNCONFIRMED_LABEL}</strong>: a IA criou {complaint ? "esta reclamação" : "este caso"} a partir de um email, mas não tinha a certeza.
        {" "}Confirma ou, se não for, arquiva (nada se apaga). Ninguém respondeu ao cliente.
      </span>
      {canConfirm && (
        <Button size="sm" variant="outline" disabled={confirming} onClick={onConfirm}>
          <Check className="w-4 h-4 mr-1" /> {confirming ? "A confirmar…" : complaint ? "É reclamação" : "É um perdido"}
        </Button>
      )}
      {canArchive && (
        <Button size="sm" variant="outline" onClick={onReject}>
          <Archive className="w-4 h-4 mr-1" /> {complaint ? "Não é reclamação" : "Não é um perdido"}
        </Button>
      )}
    </div>
  );
}
