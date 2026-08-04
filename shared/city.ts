/**
 * Cidades operacionais (Lisboa / Porto / Faro) — vocabulário PARTILHADO entre
 * cliente e servidor.
 *
 * Vive em `shared/` porque o filtro da UI e a derivação no servidor têm de
 * concordar no mesmo conjunto de chaves e no mesmo reconhecimento de texto.
 * A derivação com acesso à BD está em `server/employeeCity.ts`.
 */

export const CITY_KEYS = ["lisboa", "porto", "faro"] as const;
export type CityKey = (typeof CITY_KEYS)[number];

export const CITY_LABELS: Record<CityKey, string> = {
  lisboa: "Lisboa",
  porto: "Porto",
  faro: "Faro",
};

/** De onde veio a cidade — mostrado no tooltip da tabela de extras. */
export type CitySource = "project" | "application" | "address";

export const CITY_SOURCE_LABELS: Record<CitySource, string> = {
  project: "projeto/parque atribuído",
  application: "candidatura do site",
  address: "morada da ficha",
};

function normalizeText(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // tira acentos (marcas combinatórias)
    .toLowerCase();
}

/**
 * Reconhece a cidade num texto livre (nome de projeto, cidade da candidatura,
 * morada). Deliberadamente CONSERVADOR e ancorado em fronteiras de palavra:
 * "Portimão" NÃO pode virar "Porto", e "Vila Nova de Gaia" fica sem cidade em
 * vez de ser adivinhada.
 */
export function matchCityKey(raw: string | null | undefined): CityKey | null {
  if (!raw) return null;
  const text = normalizeText(raw);
  if (/\blisb\w*/.test(text)) return "lisboa"; // Lisboa, Lisbon, Lisbonne
  if (/\b(porto|oporto)\b/.test(text)) return "porto";
  if (/\bfaro\b/.test(text)) return "faro";
  return null;
}
