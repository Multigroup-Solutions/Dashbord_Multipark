/**
 * Erros das queries tRPC nas páginas: "erro ≠ zero". Uma falha passageira (BD)
 * tenta mais 2 vezes; sem permissão ou pedido inválido mostra logo o erro.
 * PURO (sem React), para os testes do servidor o poderem importar.
 */

/** Código tRPC do erro ("FORBIDDEN", "INTERNAL_SERVER_ERROR", …) ou "". */
export function trpcErrorCode(err: unknown): string {
  return String((err as { data?: { code?: string } } | null)?.data?.code ?? "");
}

const NO_RETRY = ["FORBIDDEN", "UNAUTHORIZED", "BAD_REQUEST"];

export const retryTransient = (count: number, err: unknown): boolean =>
  count < 2 && !NO_RETRY.includes(trpcErrorCode(err));

export const isForbidden = (err: unknown): boolean => trpcErrorCode(err) === "FORBIDDEN";

/** Porque é que um cartão não tem número: sem permissão ou a leitura falhou (null = leu). */
export type QueryFailure = "forbidden" | "error" | null;

/**
 * Plano 64 (C5): um FORBIDDEN do servidor (ou uma consulta que nem sai, por
 * falta do módulo: `allowed = false`) é "Sem acesso"; outro erro é "não
 * carregou". Nunca 0.
 */
export const queryFailure = (err: unknown, allowed = true): QueryFailure =>
  !allowed ? "forbidden" : err ? (isForbidden(err) ? "forbidden" : "error") : null;

/** O texto por baixo do "—" de um cartão que falhou. */
export const failureNote = (f: Exclude<QueryFailure, null>): string =>
  f === "forbidden" ? "Sem acesso" : "Não carregou · tentar de novo";
