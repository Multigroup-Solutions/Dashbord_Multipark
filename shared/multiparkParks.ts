/**
 * Classificação dos parques da BD da Multipark ("Park") — ÚNICO sítio com a
 * lista dos parques nossos. PARTILHADO entre servidor e cliente. PURO.
 *
 * Decisão do Jorge (27 set 2026):
 *   - "Parques nossos" = as marcas Airpark, Redpark e Skypark em Lisboa, Porto
 *     e Faro. Cada par marca + cidade é um grupo ("Airpark Lisboa").
 *   - Todos os outros parques ficam num só bloco "Marketplace" (inclui a
 *     Top Parking e os parques de terceiros).
 *
 * A tabela "Park" não tem um campo de marca fiável (só `name`, `city`,
 * `companyName` e o legado `firebaseBrand`), por isso a marca sai do NOME do
 * parque, como no resto do dashboard (`isOwnBrand` em originGroup.ts): contém
 * "airpark", "redpark" ou "skypark", ignorando espaços, acentos e maiúsculas.
 * A cidade sai de `Park.city` (ou, na falta, do nome). Uma marca nossa numa
 * cidade fora das três fica no Marketplace (não está na lista do Jorge).
 */
import { matchCityKey, CITY_LABELS, type CityKey } from "./city";

export const OUR_PARK_BRANDS = ["airpark", "redpark", "skypark"] as const;
export type OurParkBrand = (typeof OUR_PARK_BRANDS)[number];

export const OUR_PARK_BRAND_LABELS: Record<OurParkBrand, string> = {
  airpark: "Airpark",
  redpark: "Redpark",
  skypark: "Skypark",
};

/** Cidades dos parques nossos, pela ordem em que aparecem. */
export const OUR_PARK_CITIES: readonly CityKey[] = ["lisboa", "porto", "faro"];

export const MARKETPLACE_GROUP_KEY = "marketplace";
export const MARKETPLACE_GROUP_LABEL = "Marketplace";

export interface ParkClassification {
  /** "airpark_lisboa", … ou "marketplace". */
  key: string;
  /** "Airpark Lisboa", … ou "Marketplace". */
  label: string;
  ours: boolean;
  brand: OurParkBrand | null;
  city: CityKey | null;
  /** Ordem de apresentação (nossos por cidade e marca; o Marketplace no fim). */
  order: number;
}

const squash = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Marca nossa no nome do parque ("Air Park Faro" → airpark), ou null. PURA. */
export function ourBrandOf(name: string | null | undefined): OurParkBrand | null {
  if (!name) return null;
  const n = squash(name);
  return OUR_PARK_BRANDS.find((b) => n.includes(b)) ?? null;
}

/** Grupo de um parque (nome + cidade da tabela "Park"). PURA. */
export function classifyPark(p: { name?: string | null; city?: string | null }): ParkClassification {
  const brand = ourBrandOf(p.name);
  const city = matchCityKey(p.city) ?? matchCityKey(p.name);
  if (brand && city && OUR_PARK_CITIES.includes(city)) {
    const ci = OUR_PARK_CITIES.indexOf(city);
    const bi = OUR_PARK_BRANDS.indexOf(brand);
    return {
      key: `${brand}_${city}`,
      label: `${OUR_PARK_BRAND_LABELS[brand]} ${CITY_LABELS[city]}`,
      ours: true,
      brand,
      city,
      order: ci * OUR_PARK_BRANDS.length + bi,
    };
  }
  return { key: MARKETPLACE_GROUP_KEY, label: MARKETPLACE_GROUP_LABEL, ours: false, brand: null, city, order: 1000 };
}

/** Todos os grupos possíveis, pela ordem de apresentação. PURA. */
export function allParkGroups(): Array<Pick<ParkClassification, "key" | "label" | "ours" | "order">> {
  const out: Array<Pick<ParkClassification, "key" | "label" | "ours" | "order">> = [];
  OUR_PARK_CITIES.forEach((city, ci) =>
    OUR_PARK_BRANDS.forEach((brand, bi) =>
      out.push({ key: `${brand}_${city}`, label: `${OUR_PARK_BRAND_LABELS[brand]} ${CITY_LABELS[city]}`, ours: true, order: ci * OUR_PARK_BRANDS.length + bi }),
    ),
  );
  out.push({ key: MARKETPLACE_GROUP_KEY, label: MARKETPLACE_GROUP_LABEL, ours: false, order: 1000 });
  return out;
}
