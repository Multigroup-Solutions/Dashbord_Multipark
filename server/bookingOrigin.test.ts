import { describe, expect, it } from 'vitest';
import { classifyBookingOrigin } from '../shared/bookingOrigin';

describe('origem Marketplace', () => {
  it('conta reservas com campanha/parceiro no canal original sem apagar a atribuição', () => {
    const bookings = [
      { origin: 'MARKETPLACE', campaign: null, salesPartnerName: null },
      { origin: 'MARKETPLACE', campaign: 'Campanha teste', salesPartnerName: null },
      { origin: 'MARKETPLACE', campaign: null, salesPartnerName: 'Agência teste' },
    ];
    expect(bookings.filter(b => classifyBookingOrigin(b).group === 'marketplace')).toHaveLength(3);
    expect(bookings[1].campaign).toBe('Campanha teste');
    expect(bookings[2].salesPartnerName).toBe('Agência teste');
  });
  it('preserva a classificação dos restantes canais', () => {
    expect(classifyBookingOrigin({ origin: 'MANUAL' }).group).toBe('telefone');
    expect(classifyBookingOrigin({ origin: 'GENERAL_FORM' }).group).toBe('site');
    expect(classifyBookingOrigin({ origin: 'API', originUrl: 'https://www.redpark.pt/?a=1' }).label).toBe('🌐 Site redpark.pt');
    expect(classifyBookingOrigin({ campaign: 'Campanha teste' }).group).toBe('campanha');
    expect(classifyBookingOrigin({ salesPartnerName: 'Agência teste' }).group).toBe('parceiro');
  });
});
