/**
 * Agrupamento das reservas em Lisboa / Porto / Faro / Marketplace (decisão do
 * Jorge, set. 2026) — PARTILHADO entre servidor (filtros e agregados) e
 * cliente (legendas). PURO.
 *
 * Regra:
 *   - Marcas PRÓPRIAS (Airpark, Redpark, Skypark) → a cidade da reserva,
 *     `matchCityKey(city || parkName)`.
 *   - TODAS as outras marcas → "marketplace", num só bloco — incluindo a Top
 *     Parking (Porto) e as do marketplace (Boardingpark, Parkdirect, Premium
 *     Park, Readypark, Stop & Fly Park, Travelparking, Viagensparking).
 *   - Marca desconhecida (nome novo que ainda não está em PARK_CONFIGS):
 *     deriva-se do NOME — se contém "airpark"/"redpark"/"skypark" (ignorando
 *     espaços, acentos e maiúsculas, ex. "Air Park Faro") é própria; senão é
 *     marketplace. Sem nome nenhum → marketplace (não há marca própria a provar).
 *   - Marca própria cuja cidade não se reconhece → "sem_cidade" (aparece à
 *     parte, nunca é adivinhada).
 *
 * O CANAL de venda (site / telefone / parceiro / campanha / marketplace /
 * outros, de `classifyBookingOrigin`) fica como detalhe SECUNDÁRIO dentro de
 * cada grupo.
 */
import { matchCityKey, type CityKey } from "./city";

export const ORIGIN_GROUPS = ["lisboa", "porto", "faro", "marketplace", "sem_cidade"] as const;
export type OriginGroup = (typeof ORIGIN_GROUPS)[number];

export const ORIGIN_GROUP_LABELS: Record<OriginGroup, string> = {
  lisboa: "Lisboa",
  porto: "Porto",
  faro: "Faro",
  marketplace: "Marketplace",
  sem_cidade: "Sem cidade",
};

export const OWN_BRANDS = ["airpark", "redpark", "skypark"] as const;

const squash = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Marca própria (Airpark/Redpark/Skypark)? Deriva do nome do parque. */
export function isOwnBrand(parkName: string | null | undefined): boolean {
  if (!parkName) return false;
  const n = squash(parkName);
  return OWN_BRANDS.some((b) => n.includes(b));
}

/** Cidade física da reserva (todas as marcas) — para rácios operacionais. */
export function bookingCityKey(b: { parkName?: string | null; city?: string | null }): CityKey | null {
  return matchCityKey(b.city || b.parkName) ?? matchCityKey(b.parkName);
}

export function originGroupOf(b: { parkName?: string | null; city?: string | null }): OriginGroup {
  if (!isOwnBrand(b.parkName)) return "marketplace";
  return bookingCityKey(b) ?? "sem_cidade";
}

/** Canais (secundários) — os grupos de `classifyBookingOrigin`. */
export const CHANNEL_LABELS: Record<string, string> = {
  site: "Sites próprios",
  telefone: "Telefone",
  parceiro: "Parceiros",
  campanha: "Campanhas internas",
  marketplace: "Canal marketplace",
  outros: "Sem origem / por identificar",
};
