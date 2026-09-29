/**
 * Tarifas €/hora dos extras — FONTE ÚNICA (Jorge, 24 set 2026).
 *
 * Antes havia 5 cópias (extrasDia, finance/rules, db.EXTRAS_DIA_RATES, a UI e
 * a tabela `extra_rates`): mudar a taxa em "Taxas Extra" só mexia no ordenado;
 * a escala e as Finanças continuavam com os valores fixos. Agora todos leem
 * `extra_rates` por aqui (cache curta), com estes valores só como recurso
 * quando um nível ainda não tem linha na tabela.
 *
 * Os extras RECEBEM PELO PONTO (horas de ponto × tarifa); a escala do Extras
 * Dia serve para ESTIMAR o custo do dia — ambas com as mesmas tarifas.
 */
import { getDb } from "./db";
import { extraRates } from "../drizzle/schema";

export type ExtraLevelName = "junior" | "senior" | "terminal" | "master";
export const DEFAULT_EXTRA_RATES: Record<ExtraLevelName, number> = { junior: 4.5, senior: 5, terminal: 5.5, master: 6 };
/** Nível numérico da ficha (employees.extraLevel) → nome. */
export const LEVEL_NAME_BY_NUMBER: Record<number, ExtraLevelName> = { 1: "junior", 2: "senior", 3: "terminal", 4: "master" };

export type ExtraRates = Record<string, number>;

/** Monta o mapa nome → taxa a partir das linhas da tabela; níveis em falta ficam com o valor por defeito. */
export function ratesFromRows(rows: Array<{ level: number | null; levelName: string | null; hourlyRate: unknown }>): ExtraRates {
  const out: ExtraRates = { ...DEFAULT_EXTRA_RATES };
  for (const r of rows) {
    const rate = parseFloat(String(r.hourlyRate));
    if (!Number.isFinite(rate) || rate <= 0) continue;
    const name = (r.levelName && String(r.levelName).trim().toLowerCase()) || (r.level != null ? LEVEL_NAME_BY_NUMBER[Number(r.level)] : undefined);
    if (name) out[name] = rate;
  }
  return out;
}

/** Taxa de um nível (nome da escala ou número da ficha); desconhecido → júnior. */
export function rateFor(rates: ExtraRates, level: string | number | null | undefined): number {
  const name = typeof level === "number" ? LEVEL_NAME_BY_NUMBER[level] : (level ? String(level).toLowerCase() : "junior");
  return rates[name ?? "junior"] ?? rates.junior ?? DEFAULT_EXTRA_RATES.junior;
}

const TTL_MS = 60_000;
let cache: { at: number; rates: ExtraRates } | null = null;

export async function loadExtraRates(): Promise<ExtraRates> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rates;
  const db = await getDb();
  if (!db) return { ...DEFAULT_EXTRA_RATES };
  try {
    const rows = await db.select({ level: extraRates.level, levelName: extraRates.levelName, hourlyRate: extraRates.hourlyRate }).from(extraRates);
    const rates = ratesFromRows(rows);
    cache = { at: Date.now(), rates };
    return rates;
  } catch {
    return { ...DEFAULT_EXTRA_RATES };
  }
}

/** Depois de alterar uma taxa. */
export function invalidateExtraRates(): void { cache = null; }

/**
 * Valida o valor introduzido em "Taxas Extra" (€/hora): número finito, > 0 e
 * ≤ 100; aceita vírgula decimal. Devolve o valor normalizado com 2 casas
 * ("5.50") ou `null` quando inválido — o router responde BAD_REQUEST.
 */
export const MAX_EXTRA_HOURLY_RATE = 100;
export function normalizeHourlyRate(value: unknown): string | null {
  const s = String(value ?? "").trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_EXTRA_HOURLY_RATE) return null;
  return n.toFixed(2);
}
