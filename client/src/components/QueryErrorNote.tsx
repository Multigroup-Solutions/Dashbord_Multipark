import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isForbidden } from "@/lib/queryRetry";

/**
 * Erro ≠ vazio: a secção diz que a leitura falhou e deixa tentar de novo.
 * Sem permissão (FORBIDDEN) não oferece "Tentar de novo" — não adianta.
 */
export function QueryErrorNote({ error, onRetry, retrying, what }: {
  error: { message: string };
  onRetry: () => void;
  retrying?: boolean;
  /** O que não carregou ("as transcrições", "o GPS de ontem"…). */
  what?: string;
}) {
  const forbidden = isForbidden(error);
  return (
    <div role="alert" className="flex flex-wrap items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {forbidden
          ? "Sem acesso: a tua conta não tem esta permissão."
          : `Não foi possível carregar${what ? ` ${what}` : ""}: ${error.message}`}
      </span>
      {!forbidden && (
        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={onRetry} disabled={retrying}>
          <RefreshCw className={`w-3 h-3 mr-1 ${retrying ? "animate-spin" : ""}`} aria-hidden /> Tentar de novo
        </Button>
      )}
    </div>
  );
}
