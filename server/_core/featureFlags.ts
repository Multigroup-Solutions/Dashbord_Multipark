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

/**
 * Resolução de um interruptor. PURA. Precedência:
 *   1. sobreposição da BD (página Definições → Automações), se existir;
 *   2. env var (off/on…);
 *   3. valor por omissão.
 */
export function resolveFeatureFlag(
  envRaw: string | undefined | null,
  override: boolean | null | undefined,
  defaultEnabled = true,
): boolean {
  if (typeof override === "boolean") return override;
  return parseSwitch(envRaw) ?? defaultEnabled;
}

export function isFeatureEnabled(
  name: string,
  opts: { defaultEnabled?: boolean; env?: EnvLike; overrides?: ReadonlyMap<string, boolean> | null } = {},
): boolean {
  const env = opts.env ?? (typeof process !== "undefined" ? process.env : {});
  const override = opts.overrides !== undefined ? opts.overrides?.get(name) : cachedFeatureOverride(name);
  return resolveFeatureFlag(env[name], override, opts.defaultEnabled ?? true);
}

// ─── Sobreposições da BD (tabela app_settings, chaves "flag.<NOME>") ─────────
// Cache em memória de 30s por processo. `isFeatureEnabled` é síncrono: usa o
// último valor conhecido e, se a cache estiver velha, pede um refresh em
// segundo plano. Os crons e o contexto tRPC fazem `await
// ensureFeatureFlagOverrides()` antes, para decidir já com o valor fresco.

export const FEATURE_OVERRIDE_TTL_MS = 30_000;
let overrideCache: Map<string, boolean> = new Map();
let overrideLoadedAt = 0;
let overrideInflight: Promise<void> | null = null;

function overridesEnabled(): boolean {
  return typeof process !== "undefined" && !!process.env.DATABASE_URL && process.env.NODE_ENV !== "test" && !process.env.VITEST;
}

function cachedFeatureOverride(name: string): boolean | undefined {
  if (overridesEnabled() && Date.now() - overrideLoadedAt > FEATURE_OVERRIDE_TTL_MS) void ensureFeatureFlagOverrides();
  return overrideCache.get(name);
}

/** Recarrega as sobreposições se a cache tiver mais de 30s (nunca lança). */
export async function ensureFeatureFlagOverrides(force = false): Promise<void> {
  if (!overridesEnabled()) return;
  if (!force && Date.now() - overrideLoadedAt <= FEATURE_OVERRIDE_TTL_MS) return;
  if (overrideInflight) return overrideInflight;
  overrideInflight = (async () => {
    try {
      const { loadFeatureFlagOverrides } = await import("../appSettings");
      overrideCache = await loadFeatureFlagOverrides();
    } catch (err) {
      console.warn("[featureFlags] sobreposições indisponíveis:", String((err as Error)?.message ?? err).slice(0, 160));
    } finally {
      // Mesmo em erro: não martelar a BD — tenta outra vez daqui a 30s.
      overrideLoadedAt = Date.now();
      overrideInflight = null;
    }
  })();
  return overrideInflight;
}

/** Depois de gravar uma sobreposição (este processo vê-a logo). */
export function setCachedFeatureOverride(name: string, value: boolean | null): void {
  const next = new Map(overrideCache);
  if (value == null) next.delete(name); else next.set(name, value);
  overrideCache = next;
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
