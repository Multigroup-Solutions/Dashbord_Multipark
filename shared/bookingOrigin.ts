export function classifyBookingOrigin(b: {
  origin?: string | null; originUrl?: string | null;
  salesPartnerName?: string | null; campaign?: string | null;
}): { group: string; label: string } {
  const origin = String(b.origin ?? '');
  // Uma campanha/comissão não muda o canal que a Multipark registou.
  if (origin === 'MARKETPLACE') return { group: 'marketplace', label: '🏬 Marketplace' };
  if (b.salesPartnerName) return { group: 'parceiro', label: `🤝 ${b.salesPartnerName}` };
  if (b.campaign) return { group: 'campanha', label: `📣 ${b.campaign}` };
  if (origin === 'MANUAL') return { group: 'telefone', label: '📞 Telefone' };
  if (origin === 'PARTNER_DASHBOARD') return { group: 'parceiro', label: '🤝 Parceiro (por identificar)' };
  if (origin === 'GENERAL_FORM') return { group: 'site', label: '🌐 Site multipark.app' };
  if (origin === 'API') {
    try { return { group: 'site', label: `🌐 Site ${new URL(b.originUrl ?? '').hostname.replace(/^www\./, '')}` }; }
    catch { return { group: 'outros', label: 'API (sem link)' }; }
  }
  return { group: 'outros', label: 'Sem origem' };
}

/**
 * Origens em que a reserva é feita num SITE (o formulário multipark.app ou o
 * site de uma marca por API) — onde o gclid/utm pode chegar. A REGRA ÚNICA
 * (plano 64, F2) do Painel do Marketing ("Reservas feitas no site", qualidade
 * da atribuição) e do Web & SEO (conversão web → reserva, receita por sessão).
 */
export const SITE_BOOKING_ORIGINS: readonly string[] = ['API', 'GENERAL_FORM'];

/** A reserva foi feita num site (SITE_BOOKING_ORIGINS)? PURA. */
export function isSiteBooking(origin: string | null | undefined): boolean {
  return !!origin && SITE_BOOKING_ORIGINS.includes(origin);
}
