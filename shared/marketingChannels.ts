/**
 * Canal de aquisição de uma reserva (Marketing → Canais e clientes).
 *
 * Modelo (Jorge, 24 set 2026): nos canais PRÓPRIOS — Marketplace (multipark),
 * site das marcas e telefone — a reserva de um CLIENTE NOVO (primeira reserva
 * daquele email, ou sem email) conta como ANÚNCIOS (custo = gasto do Google
 * Ads); a de quem JÁ ERA CLIENTE conta como ORGÂNICO (voltou por si). O gclid
 * é só prova de clique (informação), não decide nada. Parceiros (campanha →
 * parceria, com comissão) e campanhas sem parceiro ficam à parte.
 */
export type ChannelKey = "marketplace" | "site" | "telefone" | "parceiro" | "campanha" | "outros";
export type ChannelGroup = "anuncios" | "organico" | "parceiros" | "campanhas" | "outros";

export const CHANNEL_LABEL: Record<ChannelKey, string> = {
  marketplace: "Marketplace (multipark)",
  site: "Site das marcas",
  telefone: "Telefone",
  parceiro: "Parceiros",
  campanha: "Campanhas sem parceiro",
  outros: "Outros / sem origem",
};

/** Canais próprios: o grupo depende de ser cliente novo (anúncios) ou não (orgânico). */
export const OWN_CHANNELS: ChannelKey[] = ["marketplace", "site", "telefone"];

export function groupOf(channel: ChannelKey, newClient: boolean): ChannelGroup {
  if (OWN_CHANNELS.includes(channel)) return newClient ? "anuncios" : "organico";
  return channel === "parceiro" ? "parceiros" : channel === "campanha" ? "campanhas" : "outros";
}

export const GROUP_LABEL: Record<ChannelGroup, string> = {
  anuncios: "Anúncios Google — clientes novos",
  organico: "Orgânico — clientes que voltam",
  parceiros: "Parceiros",
  campanhas: "Campanhas sem parceiro",
  outros: "Outros / sem origem",
};

/** Ordem fixa de apresentação. */
export const CHANNEL_ORDER: ChannelKey[] = ["marketplace", "site", "telefone", "parceiro", "campanha", "outros"];
export const GROUP_ORDER: ChannelGroup[] = ["anuncios", "organico", "parceiros", "campanhas", "outros"];

export function channelOf(b: { origin?: string | null; campaign?: string | null }, hasPartner: (campaign: string) => boolean): ChannelKey {
  const origin = String(b.origin ?? "");
  if (origin === "MARKETPLACE") return "marketplace";
  const campaign = (b.campaign ?? "").trim();
  if (campaign) return hasPartner(campaign) ? "parceiro" : "campanha";
  if (origin === "PARTNER_DASHBOARD") return "parceiro";
  if (origin === "MANUAL") return "telefone";
  if (origin === "API" || origin === "GENERAL_FORM") return "site";
  return "outros";
}

/**
 * Primeira reserva de um cliente, codificada numa só coluna para se obter com
 * MIN() numa agregação por email (sem window functions):
 * "AAAA-MM-DD HH:MM:SS|ORIGEM|0/1|campanha". A campanha vai no fim porque
 * pode conter "|".
 */
export function parseFirstBooking(raw: string | null | undefined): { at: string; origin: string; googlePaid: boolean; campaign: string } | null {
  if (!raw) return null;
  const [at, origin, paid, ...rest] = String(raw).split("|");
  if (!at) return null;
  return { at, origin: origin ?? "", googlePaid: paid === "1", campaign: rest.join("|") };
}
