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
