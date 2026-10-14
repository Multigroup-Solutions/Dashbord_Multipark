/**
 * Fecho mensal da Avaliação (tarefa 62, P2d; Jorge, 14 out 2026). PURO.
 *
 * `evaluation.closedUntil` (Definições; omissão nula = nada fechado): com uma
 * data, o recálculo da noite, o Recalcular, os ajustes, a anulação de ajustes
 * e as contestações (criar e aceitar com ajuste) NÃO escrevem dias ≤ essa
 * data. Reabrir = mudar a data (fica no histórico das Definições). Uso: fechar
 * cada mês ANTES de pagar os prémios — o 1.º é novembro, no início de
 * dezembro (setembro e outubro não são meses de prémios).
 *
 * Quem fecha (Q10): o super admin e as pessoas da lista
 * `evaluation.closers` (contas escolhidas pelo super admin em Definições).
 * Nada de nomes no código.
 *
 * ATENÇÃO — o fecho congela as MÉTRICAS, não as REGRAS: a pontuação calcula-se
 * ao ler (scoreOf sobre as métricas guardadas). Depois do 1.º fecho, mudar
 * EVALUATION_POINTS ou EVALUATION_RULES muda meses já pagos — qualquer mudança
 * tem de trazer a data a partir da qual vale (como o withAccidentCutoff). O
 * teste da impressão digital (evaluationRulesFingerprint) falha de propósito.
 */
import { EVALUATION_POINTS, EVALUATION_RULES, EVALUATION_RULES_VERSION, LATE_ARRIVAL_FROM_MINUTES, MAX_LATE_ARRIVALS_PER_DAY } from "./evaluationRules";

export const EVALUATION_CLOSED_UNTIL_KEY = "evaluation.closedUntil" as const;
export const EVALUATION_CLOSERS_KEY = "evaluation.closers" as const;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDay = (s: unknown): s is string =>
  typeof s === "string" && DAY_RE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** O dia está fechado? Sem data (nula) nada está. PURA. */
export function isDayClosed(day: string, closedUntil: string | null | undefined): boolean {
  return !!closedUntil && day <= closedUntil;
}

const nextDay = (d: string): string => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
};

/**
 * O 1.º dia ABERTO de [from, to]: from, ou o dia a seguir ao fecho. null = o
 * período está todo fechado. PURA.
 */
export function openFrom(from: string, to: string, closedUntil: string | null | undefined): string | null {
  const start = closedUntil && from <= closedUntil ? nextDay(closedUntil) : from;
  return start > to ? null : start;
}

/** Pode fechar/reabrir o mês: o super admin ou alguém da lista. PURA. */
export function canCloseEvaluation(user: { id: number; role: string } | null | undefined, closers: readonly number[] | null | undefined): boolean {
  if (!user) return false;
  return user.role === "super_admin" || (closers ?? []).includes(Number(user.id));
}

/** "30/11/2026". PURA. */
export function fmtClosedUntil(closedUntil: string): string {
  const [y, m, d] = closedUntil.split("-");
  return `${d}/${m}/${y}`;
}

/** Mensagem de recusa para um dia fechado. PURA. */
export function closedDayMessage(closedUntil: string): string {
  return `A avaliação está fechada até ${fmtClosedUntil(closedUntil)} (fecho mensal): esse dia já não se recalcula, ajusta nem contesta. Para mudar, quem fecha o mês tem de a reabrir primeiro.`;
}

/**
 * Impressão digital das regras da pontuação (pontos, regras e versão). O teste
 * fixa-a: mudá-la parte o teste com a mensagem "há meses fechados: diz a partir
 * de que dia vale". PURA.
 */
export function evaluationRulesFingerprint(): string {
  return JSON.stringify({
    version: EVALUATION_RULES_VERSION,
    points: EVALUATION_POINTS,
    rules: EVALUATION_RULES.map((r) => [r.key, r.label]),
    lateArrivalFromMinutes: LATE_ARRIVAL_FROM_MINUTES,
    maxLateArrivalsPerDay: MAX_LATE_ARRIVALS_PER_DAY,
  });
}
