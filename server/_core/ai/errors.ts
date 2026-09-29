/**
 * Erros tipados da IA. A UI só recebe `userMessage` (PT-PT, genérica): nunca
 * o corpo da resposta do fornecedor, que pode trazer o pedido, dados de
 * clientes ou pistas da chave. O detalhe técnico (código/estado HTTP) fica
 * só no registo de uso (ai_usage_log.errorCode) e nos logs do servidor.
 */

export type AiErrorCode =
  | "disabled"
  | "not_configured"
  | "budget"
  | "timeout"
  | "rate_limited"
  | "provider"
  | "invalid_output"
  | "unsupported";

export const AI_USER_MESSAGES: Record<AiErrorCode, string> = {
  disabled: "Esta funcionalidade de IA está desligada.",
  not_configured: "A IA não está configurada.",
  budget: "IA temporariamente indisponível.",
  timeout: "A IA demorou demasiado a responder. Tenta outra vez.",
  rate_limited: "A IA está com muitos pedidos. Tenta daqui a pouco.",
  provider: "A IA não respondeu. Tenta outra vez.",
  invalid_output: "A IA devolveu uma resposta inválida. Tenta outra vez.",
  unsupported: "Este tipo de ficheiro não é suportado pela IA configurada.",
};

export class AiError extends Error {
  readonly code: AiErrorCode;
  /** Estado HTTP do fornecedor, quando houver (nunca o corpo). */
  readonly status: number | null;
  readonly retryable: boolean;
  constructor(code: AiErrorCode, opts: { status?: number | null; retryable?: boolean; detail?: string } = {}) {
    super(opts.detail ? `${code}: ${opts.detail}` : code);
    this.name = "AiError";
    this.code = code;
    this.status = opts.status ?? null;
    this.retryable = opts.retryable ?? false;
  }
  get userMessage(): string {
    return AI_USER_MESSAGES[this.code];
  }
}

export class AiDisabledError extends AiError {
  constructor(feature: string) { super("disabled", { detail: feature }); this.name = "AiDisabledError"; }
}
export class AiNotConfiguredError extends AiError {
  constructor() { super("not_configured"); this.name = "AiNotConfiguredError"; }
}
export class AiBudgetExceededError extends AiError {
  constructor() { super("budget"); this.name = "AiBudgetExceededError"; }
}
export class AiTimeoutError extends AiError {
  constructor() { super("timeout"); this.name = "AiTimeoutError"; }
}
export class AiRateLimitError extends AiError {
  constructor(status = 429) { super("rate_limited", { status, retryable: true }); this.name = "AiRateLimitError"; }
}
export class AiProviderError extends AiError {
  constructor(status: number | null, retryable: boolean, detail?: string) {
    super("provider", { status, retryable, detail });
    this.name = "AiProviderError";
  }
}
export class AiInvalidOutputError extends AiError {
  constructor(detail?: string) { super("invalid_output", { retryable: true, detail }); this.name = "AiInvalidOutputError"; }
}
export class AiUnsupportedInputError extends AiError {
  constructor(detail?: string) { super("unsupported", { detail }); this.name = "AiUnsupportedInputError"; }
}

export function isAiError(err: unknown): err is AiError {
  return err instanceof AiError;
}

/** Mensagem segura para a UI a partir de QUALQUER erro. PURA. */
export function aiUserMessage(err: unknown): string {
  return isAiError(err) ? err.userMessage : AI_USER_MESSAGES.provider;
}

/** Código curto para registo (sem mensagens do fornecedor). PURA. */
export function aiErrorCode(err: unknown): string {
  if (isAiError(err)) return err.status ? `${err.code}_${err.status}` : err.code;
  return "unknown";
}

/** Estados HTTP que valem nova tentativa (limite de pedidos e falhas do servidor). PURA. */
export function isRetryableStatus(status: number | null | undefined): boolean {
  return status === 408 || status === 429 || (typeof status === "number" && status >= 500 && status <= 599);
}

/** Erro de um fornecedor (SDK ou HTTP) → AiError. Nunca guarda o corpo. PURA. */
export function toAiError(err: unknown): AiError {
  if (isAiError(err)) return err;
  const e = err as any;
  const name = String(e?.name ?? "");
  if (name === "AbortError" || name === "TimeoutError" || name === "FetchTimeoutError") return new AiTimeoutError();
  const status = typeof e?.status === "number" ? e.status : typeof e?.code === "number" ? e.code : null;
  if (status === 429) return new AiRateLimitError();
  if (status != null) return new AiProviderError(status, isRetryableStatus(status));
  // Falha de rede (fetch failed, ECONNRESET…): vale nova tentativa.
  const netCode = String(e?.cause?.code ?? e?.code ?? "");
  if (name === "TypeError" || /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR/.test(netCode)) return new AiProviderError(null, true, "network");
  return new AiProviderError(null, false);
}
