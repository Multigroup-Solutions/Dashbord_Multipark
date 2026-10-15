/**
 * Argumentos das ferramentas do Multis (cidades e datas), partilhados pelas
 * ferramentas de sempre (./tools.ts) e pelas do piloto (./mpvDataTools.ts).
 * Num ficheiro à parte para as do piloto não importarem ./tools.ts (que as
 * importa a elas). Tudo PURO.
 */
import type { CityAccess } from "../cityAccess";
import { ToolUserError } from "../_core/ai/chat/tools";

// ─── Cidades ────────────────────────────────────────────────────────────────

export const CITY_NAMES = ["Lisboa", "Porto", "Faro"] as const;
const CITY_ALIASES: Record<string, string> = { lisbon: "lisboa", lisboa: "lisboa", oporto: "porto", porto: "porto", faro: "faro" };
export const normCity = (s: string) => {
  const k = s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return CITY_ALIASES[k] ?? k;
};
export const EXTRAS_CITY: Record<string, "lisbon" | "porto" | "faro"> = { lisboa: "lisbon", porto: "porto", faro: "faro" };

/**
 * Cidade pedida → id do projeto (cidade) SE a pessoa tiver acesso a ela.
 * Sem cidade → undefined (as consultas já ficam nas cidades da pessoa).
 * Cidade desconhecida ou fora das cidades da pessoa → ToolUserError. PURA.
 */
export function resolveCityArg(access: CityAccess | undefined, cidade: unknown): { projectId: number; name: string } | undefined {
  if (!access || access.missingCostCenter) throw new ToolUserError("Sem cidade atribuída (centro de custos): não consigo consultar dados.");
  if (cidade == null || String(cidade).trim() === "") return undefined;
  const wanted = normCity(String(cidade));
  const names = access.cityNames ?? (access.cityName ? [access.cityName] : []);
  const ids = access.cityNames ? access.cityIds : access.defaultCityId != null ? [access.defaultCityId] : [];
  const i = names.findIndex((n) => normCity(n) === wanted);
  if (i < 0 || ids[i] == null) {
    const known = (CITY_NAMES as readonly string[]).map(normCity).includes(wanted);
    throw new ToolUserError(known ? `Não tens acesso aos dados de ${String(cidade).trim()}.` : `Cidade desconhecida: ${String(cidade).trim()}.`);
  }
  return { projectId: ids[i], name: names[i] };
}

/** Cidade das páginas de extras ("lisbon" | "porto" | "faro"). Sem cidade: a única da pessoa. */
export function extrasCityArg(access: CityAccess | undefined, cidade: unknown): { id: "lisbon" | "porto" | "faro"; name: string } {
  const r = resolveCityArg(access, cidade);
  const names = access?.cityNames ?? (access?.cityName ? [access.cityName] : []);
  const name = r?.name ?? (names.length === 1 ? names[0] : null);
  if (!name) throw new ToolUserError("Indica a cidade (Lisboa, Porto ou Faro).");
  const id = EXTRAS_CITY[normCity(name)];
  if (!id) throw new ToolUserError(`Sem Extras-Dia para ${name}.`);
  return { id, name };
}

// ─── Datas ──────────────────────────────────────────────────────────────────

export const ISO = /^\d{4}-\d{2}-\d{2}$/;
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function dayArg(v: unknown, fallback: string, label: string): string {
  if (v == null || v === "") return fallback;
  const s = String(v).trim();
  if (!ISO.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new ToolUserError(`${label} inválida (usa AAAA-MM-DD).`);
  return s;
}
/** Intervalo [de, até] com teto de dias. PURA. */
export function rangeArgs(args: Record<string, unknown>, today: string, opts: { defaultFrom?: string; maxDays?: number } = {}): { from: string; to: string } {
  const from = dayArg(args.de, opts.defaultFrom ?? today, "Data inicial");
  const to = dayArg(args.ate, from, "Data final");
  if (to < from) throw new ToolUserError("A data final é anterior à inicial.");
  const max = opts.maxDays ?? 93;
  if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 >= max) {
    throw new ToolUserError(`Intervalo demasiado grande (máximo ${max} dias).`);
  }
  return { from, to };
}

export const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
