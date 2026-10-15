/**
 * Fecho mensal da Avaliação — leituras com BD (tarefa 62, P2d; regras em
 * shared/evaluationClose.ts). Sem cache: um fecho acabado de gravar vale logo.
 * Nunca lançam.
 */
import { EVALUATION_CLOSED_UNTIL_KEY, EVALUATION_CLOSERS_KEY } from "../shared/evaluationClose";

export type ClosedUntilRead = { ok: true; closedUntil: string | null } | { ok: false };

/**
 * Até quando está fechada. `ok: false` = não deu para ler (ou o valor gravado
 * já não é válido): quem escreve NÃO escreve (mais vale não recalcular do que
 * mexer num mês pago).
 */
export async function readEvaluationClosedUntil(): Promise<ClosedUntilRead> {
  try {
    const { getSettingFresh } = await import("./appSettings");
    const r = await getSettingFresh(EVALUATION_CLOSED_UNTIL_KEY);
    if (r == null || r.invalid) return { ok: false };
    return { ok: true, closedUntil: (r.value as string | null) ?? null };
  } catch {
    return { ok: false };
  }
}

/** Contas que podem fechar (além do super admin). Erro → nenhuma. */
export async function readEvaluationClosers(): Promise<number[]> {
  try {
    const { getSettingFresh } = await import("./appSettings");
    const r = await getSettingFresh(EVALUATION_CLOSERS_KEY);
    return Array.isArray(r?.value) ? (r!.value as number[]).map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  } catch {
    return [];
  }
}

export const CLOSED_READ_FAILED_MESSAGE = "Não deu para ler o fecho do mês da Avaliação: nada foi gravado. Tenta de novo daqui a pouco.";
