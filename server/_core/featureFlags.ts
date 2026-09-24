/**
 * Interruptores (kill-switches) por variável de ambiente — UM só parser.
 *
 * Antes cada automação comparava à sua maneira (`=== "off"`, `!== "off"`,
 * `.toLowerCase()`, listas próprias…): `EXTRAS_AUTOMATION=OFF` ou `=false` não
 * desligava nada. Agora:
 *   - off / false / 0 / no / nao / não / disabled (qualquer caixa) → desligado;
 *   - on / true / 1 / yes / sim / enabled → ligado;
 *   - vazio ou valor desconhecido → o valor por omissão (`defaultEnabled`).
 *
 * As automações existentes são "ligadas por omissão" (só se desligam
 * explicitamente). Interruptores "desligados por omissão" (ex.:
 * INPROCESS_SCHEDULERS) passam `{ defaultEnabled: false }`.
 */

const OFF_VALUES = new Set(["off", "false", "0", "no", "nao", "não", "disabled"]);
const ON_VALUES = new Set(["on", "true", "1", "yes", "sim", "enabled"]);

export type EnvLike = Record<string, string | undefined>;

/** Interpreta um valor cru; `null` = vazio/desconhecido (usa o valor por omissão). */
export function parseSwitch(raw: string | undefined | null): boolean | null {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return null;
  if (OFF_VALUES.has(v)) return false;
  if (ON_VALUES.has(v)) return true;
  return null;
}

export function isFeatureEnabled(
  name: string,
  opts: { defaultEnabled?: boolean; env?: EnvLike } = {},
): boolean {
  const env = opts.env ?? (typeof process !== "undefined" ? process.env : {});
  const parsed = parseSwitch(env[name]);
  return parsed ?? (opts.defaultEnabled ?? true);
}

/**
 * Agendadores in-process (setInterval/setTimeout no servidor Node de longa
 * duração). DESLIGADOS por omissão em TODO o lado: o agendador oficial é o
 * GitHub Actions (.github/workflows/*.yml → /api/cron/*). Só ligar com
 * `INPROCESS_SCHEDULERS=on` num servidor persistente (ex.: Railway) que NÃO
 * esteja a ser servido também pelos crons — senão os jobs correm a dobrar.
 * No Vercel nunca liga (não há processo persistente).
 */
export function inprocessSchedulersEnabled(env: EnvLike = process.env): boolean {
  if (env.VERCEL) return false;
  return isFeatureEnabled("INPROCESS_SCHEDULERS", { defaultEnabled: false, env });
}
