/**
 * `fetch` com prazo — usado por TODOS os clientes externos (Google Ads e o
 * seu OAuth, Meta, WhatsApp, LLM, Zello). Sem prazo, um fornecedor lento
 * prendia a função até aos 60 s do Vercel e a corrida morria sem registo.
 *
 *  - prazo por omissão: 15 s (`timeoutMs` muda-o por chamada);
 *  - respeita um `signal` do chamador (o primeiro a disparar aborta);
 *  - ao expirar lança `FetchTimeoutError` com uma mensagem curta, só com o
 *    HOST (nunca o URL completo: pode levar tokens na query string).
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export class FetchTimeoutError extends Error {
  constructor(readonly host: string, readonly timeoutMs: number) {
    super(`Sem resposta de ${host} em ${Math.round(timeoutMs / 1000)}s`);
    this.name = "FetchTimeoutError";
  }
}

export type FetchWithTimeoutInit = RequestInit & { timeoutMs?: number };
type FetchFn = (input: any, init?: any) => Promise<Response>;

function hostOf(input: unknown): string {
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as any)?.url ?? "");
    return new URL(raw).host || "servidor externo";
  } catch {
    return "servidor externo";
  }
}

export async function fetchWithTimeout(input: string | URL, init: FetchWithTimeoutInit = {}, fetchImpl: FetchFn = fetch): Promise<Response> {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, signal: outer, ...rest } = init;
  const controller = new AbortController();
  let timedOut = false;
  // O prazo também cobre a leitura do corpo (res.json()/text()): o temporizador
  // só é limpo em erro; em sucesso fica a correr (unref — não prende o processo).
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, timeoutMs));
  (timer as any).unref?.();
  const onOuterAbort = () => controller.abort((outer as AbortSignal).reason);
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener("abort", onOuterAbort, { once: true });
  }
  try {
    return await fetchImpl(input, { ...rest, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (timedOut) throw new FetchTimeoutError(hostOf(input), timeoutMs);
    throw err;
  } finally {
    if (outer) outer.removeEventListener("abort", onOuterAbort);
  }
}
