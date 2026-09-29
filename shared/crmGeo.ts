/**
 * CRM — divisão geográfica (Jorge, 27 set 2026): cidade, região e país dos
 * PARQUES onde o cliente reservou, e o país do CLIENTE (pelo telefone). PURO.
 *
 * As reservas trazem a cidade do parque em texto ("lisbon", "Lisboa",
 * "porto", "faro"…). Parques noutros sítios (marketplace) entram acrescentando
 * a cidade a `CITY_INFO`; uma cidade desconhecida fica com região/país vazios
 * mas continua filtrável por cidade.
 */

export interface CityInfo { city: string; region: string; country: string; aliases: string[] }

export const CITY_INFO: CityInfo[] = [
  { city: "Lisboa", region: "Área Metropolitana de Lisboa", country: "PT", aliases: ["lisboa", "lisbon", "lisbonne", "lissabon"] },
  { city: "Porto", region: "Norte", country: "PT", aliases: ["porto", "oporto"] },
  { city: "Faro", region: "Algarve", country: "PT", aliases: ["faro"] },
];

export const COUNTRY_NAMES: Record<string, string> = {
  PT: "Portugal", ES: "Espanha", FR: "França", GB: "Reino Unido", DE: "Alemanha", CH: "Suíça", BE: "Bélgica",
  NL: "Países Baixos", IT: "Itália", IE: "Irlanda", LU: "Luxemburgo", US: "Estados Unidos", BR: "Brasil",
  AO: "Angola", CV: "Cabo Verde", MZ: "Moçambique", AT: "Áustria", DK: "Dinamarca", SE: "Suécia", NO: "Noruega",
  PL: "Polónia", CA: "Canadá",
};

/** "lisbon" / " Lisboa " → info da cidade (ou null). */
export function cityInfo(raw: string | null | undefined): CityInfo | null {
  const c = String(raw ?? "").trim().toLowerCase();
  if (!c) return null;
  return CITY_INFO.find((i) => i.aliases.includes(c) || i.city.toLowerCase() === c) ?? null;
}

/** Nome da cidade para mostrar ("lisbon" → "Lisboa"; desconhecida → capitalizada). */
export function cityLabel(raw: string | null | undefined): string | null {
  const i = cityInfo(raw);
  if (i) return i.city;
  const c = String(raw ?? "").trim();
  return c ? c.charAt(0).toUpperCase() + c.slice(1).toLowerCase() : null;
}

/** Todos os textos que podem aparecer nas reservas para estas cidades (para SQL IN). */
export function cityAliases(cities: string[]): string[] {
  const out = new Set<string>();
  for (const c of cities) {
    const i = cityInfo(c);
    if (i) i.aliases.forEach((a) => out.add(a));
    out.add(String(c).trim().toLowerCase());
  }
  return [...out].filter(Boolean);
}

/** Cidades (aliases) de uma região. */
export function citiesOfRegion(region: string): string[] {
  return CITY_INFO.filter((i) => i.region === region).flatMap((i) => i.aliases);
}

/** Cidades (aliases) de um país. */
export function citiesOfCountry(country: string): string[] {
  return CITY_INFO.filter((i) => i.country === country).flatMap((i) => i.aliases);
}

export function regionsList(): string[] {
  return [...new Set(CITY_INFO.map((i) => i.region))];
}

/** Indicativos → país (os mais comuns primeiro nas colisões de prefixo). */
const DIAL: [string, string][] = [
  ["351", "PT"], ["353", "IE"], ["352", "LU"], ["244", "AO"], ["238", "CV"], ["258", "MZ"],
  ["34", "ES"], ["33", "FR"], ["44", "GB"], ["49", "DE"], ["41", "CH"], ["32", "BE"], ["31", "NL"], ["39", "IT"],
  ["43", "AT"], ["45", "DK"], ["46", "SE"], ["47", "NO"], ["48", "PL"], ["55", "BR"], ["1", "US"],
];

/** País do cliente pelo telefone E.164 ("+351…" → "PT"), ou null. */
export function countryFromPhone(e164: string | null | undefined): string | null {
  const d = String(e164 ?? "").replace(/^\+/, "");
  if (!d || !/^\d+$/.test(d)) return null;
  const sorted = [...DIAL].sort((a, b) => b[0].length - a[0].length);
  return sorted.find(([p]) => d.startsWith(p))?.[1] ?? null;
}

export interface ParkUse { park: string; city: string | null; bookings: number }

/** Parques usados, do mais usado para o menos. */
export function parseParks(json: string | null | undefined): ParkUse[] {
  try {
    const v = JSON.parse(String(json ?? "[]"));
    return Array.isArray(v) ? v.filter((x) => x && typeof x.park === "string").map((x) => ({ park: x.park, city: x.city ?? null, bookings: Number(x.bookings) || 0 })) : [];
  } catch { return []; }
}
