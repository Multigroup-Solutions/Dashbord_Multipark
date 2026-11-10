/**
 * Ponto no menu da foto (avatar) — o que mostrar a partir do rh.timeRecords.myStatus.
 *
 * Jorge (28 out 2026): "o check in/out do menu desapareceu" (Márcia e outros).
 * Antes, sem resposta do myStatus (a carregar, rede fraca, erro, ficha bloqueada a
 * meio da sessão) o menu escondia a linha "Em serviço / Fora de serviço" E os dois
 * botões, sem aviso — e só voltava a perguntar 2 min depois. Regra: com ficha, o
 * menu tem SEMPRE uma linha de ponto (estado, "a verificar" ou o motivo do erro).
 * PURA.
 */

export interface PontoStatusData {
  employeeId: number | null;
  status: "in" | "out" | null;
  since: string | null;
  terminal: boolean;
}

export type PontoMenuState =
  /** Sem ficha de colaborador: não há ponto no menu. */
  | { kind: "none" }
  | { kind: "loading" }
  /** `retry` = vale a pena "tentar de novo" (não é um bloqueio da ficha). */
  | { kind: "error"; message: string; retry: boolean }
  | { kind: "in"; since: string | null; terminal: boolean }
  | { kind: "out" };

export const PONTO_UNAVAILABLE_MSG = "Ponto indisponível de momento.";
export const PONTO_NO_RECORD_MSG = "Sem ficha associada a esta conta para o ponto. Fala com o RH.";

export interface PontoMenuInput {
  hasEmployee: boolean;
  data: PontoStatusData | null | undefined;
  /** Erro da última pergunta (o react-query guarda os dados antigos ao lado do erro). */
  error: { message?: string; data?: { code?: string } | null } | null | undefined;
}

export function pontoMenuState({ hasEmployee, data, error }: PontoMenuInput): PontoMenuState {
  if (!hasEmployee) return { kind: "none" };
  // Uma resposta boa ganha a um erro de uma pergunta seguinte (rede caiu entretanto):
  // o último estado conhecido continua certo até a pessoa picar.
  if (data?.employeeId && data.status === "in") return { kind: "in", since: data.since, terminal: !!data.terminal };
  if (data?.employeeId && data.status === "out") return { kind: "out" };
  if (error) {
    // FORBIDDEN = bloqueio da ficha (loginBlock) — o servidor manda o motivo; repetir não adianta.
    if (error.data?.code === "FORBIDDEN") return { kind: "error", message: error.message?.trim() || PONTO_UNAVAILABLE_MSG, retry: false };
    return { kind: "error", message: PONTO_UNAVAILABLE_MSG, retry: true };
  }
  // O servidor respondeu sem ficha, mas a sessão tem uma: não esconder — dizer o que fazer.
  if (data && !data.employeeId) return { kind: "error", message: PONTO_NO_RECORD_MSG, retry: true };
  return { kind: "loading" };
}

/** Com erro, volta a perguntar mais cedo (15 s) em vez de esperar os 2 min normais. PURA. */
export function pontoRefetchIntervalMs(hasError: boolean): number {
  return hasError ? 15_000 : 120_000;
}
