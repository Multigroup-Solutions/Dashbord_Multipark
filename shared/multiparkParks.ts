/**
 * Classificação da BD da Multipark — ÚNICO sítio com as regras de:
 *   1. que parques ("Park") são NOSSOS e em que grupo marca + cidade caem;
 *   2. o CANAL de cada reserva para a contabilidade (Direto / Parceiro /
 *      Marketplace).
 * PARTILHADO entre servidor e cliente (Reservas do dia, Ficha da reserva,
 * "Classificação dos parques"). PURO.
 *
 * Regras do Jorge (27 set 2026):
 *
 * PARQUE
 *   - Marca: `Park.firebaseBrand` quando preenchido (normalizado: sem acentos,
 *     espaços nem maiúsculas); se vazio, o NOME do parque. Conta como marca
 *     nossa se contiver "airpark", "redpark" ou "skypark".
 *   - Cidade: `Park.city`; só se estiver vazia, o nome do parque.
 *   - "Parque nosso" = marca ∈ {Airpark, Redpark, Skypark} E cidade ∈
 *     {Lisboa, Porto, Faro}. Cada par marca + cidade é um grupo
 *     ("Airpark Lisboa"); todos os outros ficam num só bloco "Marketplace".
 *   - `Park.listingType` (ON_PLATFORM / DIRECTORY) só se mostra; não conta.
 *
 * CANAL DA RESERVA (contabilidade)
 *   - "Marketplace": o parque NÃO é nosso, OU `Booking.origin = 'MARKETPLACE'`.
 *   - "Parceiro": parque nosso E (`partnerId` preenchido → nome + tipo do
 *     Partner; OU origem PARTNER_API / PARTNER_DASHBOARD; OU, só quando não há
 *     `partnerId`, cobrada por um agregador: paymentSource PARKVIA / PARKOS /
 *     PARKFLOW / AGGREGATOR_OTHER).
 *   - "Direto": tudo o resto nos parques nossos.
 *   Operacionalmente, todas as reservas dos parques nossos continuam no grupo
 *   do parque (recolha/entrega), seja qual for o canal.
 */
import { matchCityKey, CITY_LABELS, type CityKey } from "./city";
import { matchKey, matchWords } from "./textKey";

// ─── Parques ────────────────────────────────────────────────────────────────

export const OUR_PARK_BRANDS = ["airpark", "redpark", "skypark"] as const;
export type OurParkBrand = (typeof OUR_PARK_BRANDS)[number];

export const OUR_PARK_BRAND_LABELS: Record<OurParkBrand, string> = {
  airpark: "Airpark",
  redpark: "Redpark",
  skypark: "Skypark",
};

/** Cidades dos parques nossos, pela ordem em que aparecem. */
export const OUR_PARK_CITIES: readonly CityKey[] = ["lisboa", "porto", "faro"];

// ─── Parques que NÃO são operados por nós (Jorge, 6 out 2026) ───────────────
// "Estes não são operados por nós. Todos os outros que estão na plataforma são
// operados por nós." Casam pelo NOME EXATO (só letras e números, sem acentos —
// `matchKey`), nunca por "contém": "Top Park" ≠ "Top Parking", "Easy Parking" ≠
// "Easy Park Estacionamento". Um nome com a cidade ("Top Parking Porto") também
// casa (2.ª tentativa sem as palavras de cidade). Ficam fora da operação
// (Reservas do dia, Extras-Dia, Pressão, Passagem de turno, Ocorrências), além
// dos escolhidos em Definições → "Parques que a operação não faz".
export const NOT_OPERATED_PARK_NAMES = [
  "Top Parking", "Elite Park and Detail", "Easy Park Estacionamento", "Prime Park", "Check-in Park",
  "Estacionamento Quinta do Lamberg", "Top Park", "Aeroporto Park", "Airport Villa Parking", "Boeing Park",
  "Bruno Miguel Gomes Taboada", "Deluxe Park", "Easy Parking", "Fast Park", "Go Park", "Green Parking",
  "Guard Park", "Jet Park", "Jorge Taboada", "K Meetings", "Low Cost Parking", "Orange Parking",
  "Park and Fly", "Parking Terminal 1", "Ricardo Maria", "Smart Park",
] as const;
const NOT_OPERATED_KEYS = new Set<string>(NOT_OPERATED_PARK_NAMES.map((n) => matchKey(n)));
const PARK_CITY_WORDS = new Set(["lisboa", "lisbon", "porto", "oporto", "faro", "algarve"]);

/** O parque está na lista dos que NÃO operamos (nome exato, com ou sem a cidade). PURA. */
export function isNotOperatedByName(name: string | null | undefined): boolean {
  const k = matchKey(name);
  if (!k) return false;
  if (NOT_OPERATED_KEYS.has(k)) return true;
  const noCity = matchWords(name).filter((w) => !PARK_CITY_WORDS.has(w)).join("");
  return noCity.length > 0 && noCity !== k && NOT_OPERATED_KEYS.has(noCity);
}

/** Nomes da lista sem nenhum parque com esse nome (para avisar nas Definições). PURA. */
export function unmatchedNotOperatedNames(parkNames: readonly (string | null | undefined)[]): string[] {
  const hit = new Set<string>();
  for (const n of parkNames) {
    const k = matchKey(n);
    const noCity = matchWords(n).filter((w) => !PARK_CITY_WORDS.has(w)).join("");
    if (NOT_OPERATED_KEYS.has(k)) hit.add(k);
    else if (NOT_OPERATED_KEYS.has(noCity)) hit.add(noCity);
  }
  return NOT_OPERATED_PARK_NAMES.filter((n) => !hit.has(matchKey(n)));
}

export const MARKETPLACE_GROUP_KEY = "marketplace";
export const MARKETPLACE_GROUP_LABEL = "Marketplace";

export const PARK_LISTING_TYPE_LABELS: Record<string, string> = {
  ON_PLATFORM: "Na plataforma",
  DIRECTORY: "Diretório",
};

export const PARK_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pendente",
  ACTIVE: "Ativo",
  INACTIVE: "Inativo",
};

/** Colunas da tabela "Park" usadas na classificação. */
export interface ParkInput {
  name?: string | null;
  city?: string | null;
  firebaseBrand?: string | null;
  listingType?: string | null;
}

export interface ParkClassification {
  /** "airpark_lisboa", … ou "marketplace". */
  key: string;
  /** "Airpark Lisboa", … ou "Marketplace". */
  label: string;
  ours: boolean;
  /** Marca NOSSA reconhecida (null se não for nossa). */
  brand: OurParkBrand | null;
  /** De onde veio a marca: do `firebaseBrand` ou (na falta) do nome. */
  brandSource: "firebaseBrand" | "name";
  city: CityKey | null;
  /** De onde veio a cidade (null = não reconhecida). */
  citySource: "city" | "name" | null;
  /** ON_PLATFORM / DIRECTORY (só para mostrar). */
  listingType: string | null;
  /** Porquê, em texto curto ("Airpark (firebaseBrand) + Lisboa"). */
  reason: string;
  /** Ordem de apresentação (nossos por cidade e marca; o Marketplace no fim). */
  order: number;
}

const squash = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

const clean = (s: string | null | undefined) => {
  const t = String(s ?? "").trim();
  return t ? t : null;
};

/** Marca nossa num texto ("Air Park Faro" → airpark), ou null. PURA. */
export function ourBrandOf(text: string | null | undefined): OurParkBrand | null {
  if (!text) return null;
  const n = squash(text);
  return OUR_PARK_BRANDS.find((b) => n.includes(b)) ?? null;
}

/** Grupo de um parque (colunas da tabela "Park"). PURA. */
export function classifyPark(p: ParkInput): ParkClassification {
  const fb = clean(p.firebaseBrand);
  const brandSource: ParkClassification["brandSource"] = fb ? "firebaseBrand" : "name";
  const brand = fb ? ourBrandOf(fb) : ourBrandOf(p.name);
  // A cidade do parque manda; o nome só serve quando `city` está vazio.
  const cityRaw = clean(p.city);
  const fromCity = cityRaw ? matchCityKey(cityRaw) : null;
  const fromName = cityRaw ? null : matchCityKey(p.name);
  const city = fromCity ?? fromName;
  const citySource: ParkClassification["citySource"] = fromCity ? "city" : fromName ? "name" : null;
  const listingType = clean(p.listingType)?.toUpperCase() ?? null;
  const brandTxt = brand
    ? `${OUR_PARK_BRAND_LABELS[brand]} (${brandSource === "firebaseBrand" ? "firebaseBrand" : "nome"})`
    : fb ? `marca "${fb}" não é nossa` : "nome sem marca nossa";
  const cityTxt = city
    ? `${CITY_LABELS[city]}${citySource === "name" ? " (nome)" : ""}`
    : cityRaw ? `cidade "${cityRaw}" fora das três` : "sem cidade";
  if (brand && city && OUR_PARK_CITIES.includes(city)) {
    const ci = OUR_PARK_CITIES.indexOf(city);
    const bi = OUR_PARK_BRANDS.indexOf(brand);
    return {
      key: `${brand}_${city}`,
      label: `${OUR_PARK_BRAND_LABELS[brand]} ${CITY_LABELS[city]}`,
      ours: true, brand, brandSource, city, citySource, listingType,
      reason: `${brandTxt} + ${cityTxt}`,
      order: ci * OUR_PARK_BRANDS.length + bi,
    };
  }
  return {
    key: MARKETPLACE_GROUP_KEY, label: MARKETPLACE_GROUP_LABEL,
    ours: false, brand: null, brandSource, city, citySource, listingType,
    reason: brand ? `${brandTxt}, mas ${cityTxt}` : brandTxt,
    order: 1000,
  };
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

// ─── Canal da reserva (contabilidade) ───────────────────────────────────────

export const BOOKING_CHANNELS = ["direto", "parceiro", "marketplace"] as const;
export type BookingChannel = (typeof BOOKING_CHANNELS)[number];

export const BOOKING_CHANNEL_LABELS: Record<BookingChannel, string> = {
  direto: "Direto",
  parceiro: "Parceiro",
  marketplace: "Marketplace",
};

/** Origens ("BookingOrigin") de parceiro (API ou painel do parceiro). */
export const PARTNER_ORIGINS: readonly string[] = ["PARTNER_API", "PARTNER_DASHBOARD"];
/** Quem cobrou ("PaymentSource") que é um agregador — só pista quando não há partnerId. */
export const AGGREGATOR_PAYMENT_SOURCES: readonly string[] = ["PARKVIA", "PARKOS", "PARKFLOW", "AGGREGATOR_OTHER"];

export const PARTNER_TYPE_LABELS: Record<string, string> = {
  AGENCY: "agência",
  AGGREGATOR: "agregador",
  PARTNER: "parceiro",
};

export const ORIGIN_LABELS: Record<string, string> = {
  GENERAL_FORM: "Formulário",
  MANUAL: "Manual",
  MARKETPLACE: "Marketplace",
  IMPORTED: "Importada",
  API: "API / site",
  MOBILE_APP: "App",
  PARTNER_API: "API de parceiro",
  PARTNER_DASHBOARD: "Painel de parceiro",
  CLIENT_PLAN: "Avença",
};

const PAYMENT_SOURCE_LABELS: Record<string, string> = {
  PARKVIA: "Parkvia",
  PARKOS: "Parkos",
  PARKFLOW: "Parkflow",
  AGGREGATOR_OTHER: "Outro agregador",
};

export interface BookingChannelInput {
  /** O parque da reserva é nosso (classifyPark(...).ours). */
  parkOurs: boolean;
  origin?: string | null;
  paymentSource?: string | null;
  partnerId?: string | null;
  partnerName?: string | null;
  partnerType?: string | null;
}

export interface BookingChannelInfo {
  channel: BookingChannel;
  /** Porquê / quem, em texto curto ("Parkos (agregador)", "Parque de terceiros"). */
  detail: string;
  /** Nome do parceiro quando o canal é Parceiro (ou o agregador que cobrou). */
  partnerName: string | null;
  /** "agência" / "agregador" / "parceiro" (Partner.partnerType). */
  partnerTypeLabel: string | null;
  /** Texto do distintivo: "Direto", "Parceiro · Parkos", "Marketplace". */
  badge: string;
}

/** Canal da reserva para a contabilidade (ver regras no topo). PURA. */
export function classifyBookingChannel(b: BookingChannelInput): BookingChannelInfo {
  const origin = String(b.origin ?? "").trim().toUpperCase();
  const pay = String(b.paymentSource ?? "").trim().toUpperCase();
  const partnerTypeLabel = PARTNER_TYPE_LABELS[String(b.partnerType ?? "").trim().toUpperCase()] ?? null;
  const pName = clean(b.partnerName);
  const partnerTxt = b.partnerId ? (partnerTypeLabel ? `${pName ?? "Parceiro"} (${partnerTypeLabel})` : pName ?? "Parceiro") : null;

  if (!b.parkOurs || origin === "MARKETPLACE") {
    const why = !b.parkOurs ? "Parque de terceiros" : "Origem Marketplace";
    return {
      channel: "marketplace",
      detail: partnerTxt ? `${why} · ${partnerTxt}` : why,
      partnerName: b.partnerId ? pName : null,
      partnerTypeLabel: b.partnerId ? partnerTypeLabel : null,
      badge: BOOKING_CHANNEL_LABELS.marketplace,
    };
  }
  if (b.partnerId) {
    const name = pName ?? "Parceiro";
    return { channel: "parceiro", detail: partnerTxt!, partnerName: name, partnerTypeLabel, badge: `Parceiro · ${name}` };
  }
  if (PARTNER_ORIGINS.includes(origin)) {
    const d = ORIGIN_LABELS[origin] ?? origin;
    return { channel: "parceiro", detail: d, partnerName: null, partnerTypeLabel: null, badge: BOOKING_CHANNEL_LABELS.parceiro };
  }
  if (AGGREGATOR_PAYMENT_SOURCES.includes(pay)) {
    const name = PAYMENT_SOURCE_LABELS[pay] ?? pay;
    return { channel: "parceiro", detail: `${name} (cobrado pelo agregador)`, partnerName: name, partnerTypeLabel: null, badge: `Parceiro · ${name}` };
  }
  return { channel: "direto", detail: ORIGIN_LABELS[origin] ?? (origin || "Direto"), partnerName: null, partnerTypeLabel: null, badge: BOOKING_CHANNEL_LABELS.direto };
}
