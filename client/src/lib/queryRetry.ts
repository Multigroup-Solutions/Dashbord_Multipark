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
