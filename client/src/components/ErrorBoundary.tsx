import { cn } from "@/lib/utils";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** 20d: muda de página → limpa o erro (o resto da app continua a funcionar). */
  resetKey?: string;
  /** Dentro do layout (só a página), em vez do ecrã inteiro. */
  compact?: boolean;
}

interface State {
  hasError: boolean;
  error: Error | null;
  resetKey?: string;
}

/** Erro de carregar um pedaço da app depois de uma atualização (versão nova publicada). */
export function isStaleChunkError(err: unknown): boolean {
  const m = String((err as Error)?.message ?? err ?? "");
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading chunk \d+ failed/i.test(m);
}

/**
 * 20d: em português, sem o stack técnico à vista (fica na consola), e com
 * "versão nova" quando o erro é de uma atualização publicada entretanto.
 */
class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) return { hasError: false, error: null, resetKey: props.resetKey };
    return null;
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error("[ErrorBoundary]", error, info);
  }

  render() {
    if (this.state.hasError) {
      const stale = isStaleChunkError(this.state.error);
      return (
        <div role="alert" className={cn("flex items-center justify-center p-8", this.props.compact ? "min-h-[40vh]" : "min-h-screen bg-background")}>
          <div className="flex flex-col items-center w-full max-w-md text-center">
            <AlertTriangle size={40} className="text-destructive mb-4 flex-shrink-0" aria-hidden />
            <h2 className="text-lg font-semibold mb-2">
              {stale ? "Há uma versão nova da aplicação" : "Esta página encontrou um erro"}
            </h2>
            <p className="text-sm text-muted-foreground mb-6">
              {stale
                ? "Recarrega para usar a versão mais recente."
                : "Recarrega a página. Se voltar a acontecer, avisa a administração e diz o que estavas a fazer."}
            </p>
            <button
              onClick={() => window.location.reload()}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-lg",
                "bg-primary text-primary-foreground",
                "hover:opacity-90 cursor-pointer"
              )}
            >
              <RotateCcw size={16} aria-hidden />
              Recarregar
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
