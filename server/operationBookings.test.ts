import { describe, expect, it } from 'vitest';
import { matchesOperationState, summarizeOperationBookings } from '../shared/operationBookings';

describe('reservas criadas e canceladas', () => {
  const bookings = [
    { status: 'BOOKED', parkName: 'Parque', totalPrice: '100', totalPaid: '70', remainingToPay: '30', paymentMethod: 'Online', salesPartnerCommission: 10 },
    { status: 'CHECKED_OUT', parkName: 'Parque', totalPrice: '50', totalPaid: '50', remainingToPay: '0', paymentMethod: 'Multibanco' },
    { status: 'CANCELLED', parkName: 'Parque', totalPrice: '29.80', totalPaid: '29.80', remainingToPay: '29.80', paymentMethod: 'Online', salesPartnerCommission: 2.98 },
  ];
  it('conta todas as criações mas separa o valor cancelado dos valores não cancelados', () => {
    const all = bookings.filter(b => matchesOperationState(b.status, 'creation', 'all'));
    expect(all).toHaveLength(3);
    expect(summarizeOperationBookings(all, 'creation')).toMatchObject({
      revenue: 150, paidOnline: 70, paidMB: 50, toCollect: 30, partnerTotal: 10,
      cancelledCount: 1, cancelledValue: 29.8, byPark: { Parque: { count: 3, revenue: 150 } },
    });
  });
  it('permite conferir apenas canceladas ou não canceladas sem mudar o período de criação', () => {
    const active = bookings.filter(b => matchesOperationState(b.status, 'creation', 'active'));
    const cancelled = bookings.filter(b => matchesOperationState(b.status, 'creation', 'cancelled'));
    expect(active).toHaveLength(2);
    expect(cancelled).toHaveLength(1);
    expect(summarizeOperationBookings(cancelled, 'creation')).toMatchObject({ revenue: 0, toCollect: 0, cancelledValue: 29.8 });
    expect(summarizeOperationBookings(cancelled, 'cancelation').revenue).toBe(29.8);
  });
  it('preserva os filtros operacionais de recolhas e entregas', () => {
    expect(matchesOperationState('BOOKED', 'checkin', 'pending')).toBe(true);
    expect(matchesOperationState('CHECKED_IN', 'checkin', 'done')).toBe(true);
    expect(matchesOperationState('CHECKED_IN', 'checkout', 'pending')).toBe(true);
    expect(matchesOperationState('CHECKED_OUT', 'checkout', 'done')).toBe(true);
    expect(matchesOperationState('CHECKED_OUT', 'checkout', 'pending')).toBe(false);
  });
});
