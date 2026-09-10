import { afterEach, describe, expect, it, vi } from 'vitest';
import { bookingDetailCore, parseBookingDate } from './bookingRefresh';
import { matchParkConfig, resolveParkForBooking } from './multipark';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('datas e atualização do detalhe', () => {
  it('interpreta o formato da API em UTC, independentemente do fuso do servidor', () => {
    for (const tz of ['Europe/Lisbon', 'America/New_York', 'UTC']) {
      vi.stubEnv('TZ', tz);
      expect(parseBookingDate('10/09/2026, 12:35')).toBe('2026-09-10 12:35:00');
      expect(parseBookingDate('2026-09-10 12:35:00')).toBe('2026-09-10 12:35:00');
      expect(parseBookingDate('2026-09-10T13:35:00+01:00')).toBe('2026-09-10 12:35:00');
    }
  });
  it('rejeita datas impossíveis e aceita anos bissextos', () => {
    expect(parseBookingDate('31/02/2026, 12:00')).toBeNull();
    expect(parseBookingDate('29/02/2024, 12:00')).toBe('2024-02-29 12:00:00');
    expect(parseBookingDate('10/09/2026, 28:00')).toBeNull();
  });
  it('refresca estado, matrícula, datas e valores sem apagar campos ausentes', () => {
    expect(bookingDetailCore({ status: 'BOOKED', licensePlate: 'CC00DD',
      checkOut: '12/09/2026, 19:00', pricing: { totalPrice: 0, remainingToPay: 0 },
    })).toEqual({ status: 'BOOKED', licensePlate: 'CC00DD', checkOut: '2026-09-12 19:00:00', totalPrice: '0', remainingToPay: '0' });
    expect(bookingDetailCore({ pricing: { totalPrice: 'inválido' } })).toEqual({});
  });
});

describe('parque correto por nome, cidade e identificador', () => {
  it('distingue Top Parking Porto do parque excluído de Lisboa', () => {
    expect(matchParkConfig({ parkId: 'cmr2qq7tp05viql2zi4ah8dcl' })?.id).toBe('PORTO_TOP_PARKING');
    expect(matchParkConfig({ parkName: 'Top-Parking - Porto', city: 'porto' })?.id).toBe('PORTO_TOP_PARKING');
    expect(matchParkConfig({ parkName: 'Top Parking', city: 'Lisbon' })?.closed).toBe(true);
  });
  it('não escolhe outra cidade quando o nome é ambíguo', () => {
    expect(matchParkConfig({ parkName: 'Airpark' })).toBeUndefined();
    expect(matchParkConfig({ parkName: 'Airpark - Lisboa', city: 'faro' })).toBeUndefined();
    expect(matchParkConfig({ parkName: 'Airpark - Lisbon', city: 'lisbon' })?.id).toBe('LISBON_AIRPARK');
  });
  it('mantém falha recuperável quando falta a chave do parque conhecido', async () => {
    vi.stubEnv('MULTIPARK_API_KEY_PORTO_TOP_PARKING', '');
    await expect(resolveParkForBooking({ parkId: 'cmr2qq7tp05viql2zi4ah8dcl' })).rejects.toMatchObject({ code: 'PARK_ACCESS_MISSING' });
  });
});
