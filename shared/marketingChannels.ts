/**
 * Canal de aquisição de uma reserva (Marketing → Canais e clientes).
 *
 * Parte da mesma leitura de shared/bookingOrigin.ts, com uma diferença: uma
 * reserva do site com prova de clique pago (adAttribution = google_paid) é do
 * canal "Google Ads", não "Site". O parceiro de venda vem da campanha (mapa
 * campanha → parceria, igual ao da Faturação/Parcerias).
 */
export type ChannelKey = "google_ads" | "parceiro" | "campanha" | "marketplace" | "site" | "telefone" | "outros";

export const CHANNEL_LABEL: Record<ChannelKey, string> = {
  google_ads: "Google Ads",
  parceiro: "Parceiros",
  campanha: "Campanhas sem parceiro",
  marketplace: "Marketplace",
  site: "Site (orgânico / direto)",
  telefone: "Telefone",
  outros: "Outros / sem origem",
};

/** Ordem fixa de apresentação (e das cores, se houver gráfico). */
export const CHANNEL_ORDER: ChannelKey[] = ["google_ads", "parceiro", "campanha", "marketplace", "site", "telefone", "outros"];

export function channelOf(b: { origin?: string | null; googlePaid?: boolean; campaign?: string | null }, hasPartner: (campaign: string) => boolean): ChannelKey {
  const origin = String(b.origin ?? "");
  if (b.googlePaid) return "google_ads";
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
