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

/**
 * Terras → cidade operacional (regra do Jorge para a morada dos extras:
 * Algarve → Faro, Grande Porto → Porto, Grande Lisboa/Setúbal → Lisboa).
 * 8 out 2026: também as terras à volta dos aeroportos onde há parques (Prior
 * Velho, Moscavide, Portela, Maia/Moreira, Pedras Rubras, Gambelas…) — um
 * parque com "Prior Velho" na cidade era tido como de fora das três cidades.
 * Estava no db.ts (só para moradas); passou para aqui no 18b para a cidade
 * escrita nas candidaturas também a usar — "Corroios", "Gaia" ou "Albufeira"
 * ficavam sem cidade e eram vistas por todas as cidades.
 */
export const CITY_PLACE_KEYWORDS: Record<CityKey, readonly string[]> = {
  faro: ["faro", "algarve", "albufeira", "portimao", "olhao", "loule", "quarteira", "vilamoura", "tavira", "lagos", "silves", "almancil", "sao bras", "vila real de santo antonio", "monchique", "aljezur", "castro marim", "alcoutim", "vila do bispo", "montenegro", "quelfes", "armacao de pera", "ferreiras", "guia", "paderne", "boliqueime", "estoi", "moncarapacho", "gambelas", "sao joao da venda", "conceicao de faro", "patacao", "pechao", "fuseta", "vale do lobo", "quinta do lago"],
  porto: ["porto", "vila nova de gaia", "gaia", "matosinhos", "maia", "gondomar", "valongo", "povoa de varzim", "vila do conde", "santo tirso", "trofa", "penafiel", "paredes", "ermesinde", "rio tinto", "espinho", "senhora da hora", "aguas santas", "sao mamede de infesta", "leca", "leca do balio", "moreira", "moreira da maia", "pedras rubras", "perafita", "vila nova da telha", "lavra", "custoias", "gueifaes", "guifoes", "santa cruz do bispo", "milheiros", "castelo da maia"],
  lisboa: ["lisboa", "amadora", "sintra", "cascais", "oeiras", "loures", "odivelas", "almada", "seixal", "barreiro", "montijo", "setubal", "alcochete", "moita", "sesimbra", "palmela", "mafra", "torres vedras", "vila franca de xira", "alverca", "sacavem", "queluz", "agualva", "cacem", "rio de mouro", "massama", "corroios", "feijo", "laranjeiro", "camarate", "povoa de santa iria", "carnaxide", "alges", "damaia", "benfica", "chelas", "marvila", "monte abraao", "prior velho", "moscavide", "portela", "olivais", "bobadela", "sao joao da talha", "santa iria de azoia", "santa iria da azoia", "unhos", "apelacao", "frielas", "santo antonio dos cavaleiros", "parque das nacoes", "lumiar", "charneca", "encarnacao", "sao domingos de benfica", "telheiras", "santa maria dos olivais"],
};

/**
 * Cidade de uma morada ou terra escrita à mão (palavras inteiras; Faro e Porto
 * primeiro, Lisboa no fim). "Portimão" é Faro, nunca Porto. PURA.
 */
export function cityKeyFromPlace(raw: string | null | undefined): CityKey | null {
  if (!raw) return null;
  const text = ` ${normalizeText(raw).replace(/[^a-z0-9]+/g, " ").trim()} `;
  for (const city of ["faro", "porto", "lisboa"] as const) {
    for (const kw of CITY_PLACE_KEYWORDS[city]) if (text.includes(` ${kw} `)) return city;
  }
  return null;
}

/**
 * Cidade de uma MORADA: a terra que aparece MAIS PERTO DO FIM (as moradas
 * acabam no código postal + terra), para "Rua de Lisboa 10, 4470 Maia" ser
 * Porto e "Rua do Porto 3, 2685 Prior Velho" ser Lisboa. Conta também o nome
 * da cidade (Lisboa/Lisbon, Porto/Oporto, Faro). PURA.
 */
export function cityKeyFromAddress(raw: string | null | undefined): CityKey | null {
  if (!raw) return null;
  const text = ` ${normalizeText(raw).replace(/[^a-z0-9]+/g, " ").trim()} `;
  let best: { city: CityKey; end: number } | null = null;
  const consider = (city: CityKey, kw: string) => {
    const needle = ` ${kw} `;
    const at = text.lastIndexOf(needle);
    if (at < 0) return;
    const end = at + needle.length;
    if (!best || end > best.end) best = { city, end };
  };
  for (const city of CITY_KEYS) {
    for (const kw of CITY_PLACE_KEYWORDS[city]) consider(city, kw);
  }
  consider("lisboa", "lisbon");
  consider("porto", "oporto");
  return (best as { city: CityKey; end: number } | null)?.city ?? null;
}

/** Cidade de um texto livre de pessoa (candidatura): o nome da cidade, senão a terra. PURA. */
export function cityKeyFromText(raw: string | null | undefined): CityKey | null {
  return matchCityKey(raw) ?? cityKeyFromPlace(raw);
}
