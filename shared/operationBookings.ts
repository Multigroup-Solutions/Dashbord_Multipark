export type OperationAction = 'creation' | 'checkin' | 'checkout' | 'cancelation';

export function matchesOperationState(status: string, action: OperationAction, filter: string) {
  if (action === 'creation') {
    if (filter === 'active') return status !== 'CANCELLED';
    if (filter === 'cancelled') return status === 'CANCELLED';
    return true;
  }
  const done = action === 'checkin'
    ? ['CHECKED_IN', 'MOVING', 'CHECKING_OUT', 'PENDING_CHECKOUT', 'CHECKED_OUT'].includes(status)
    : action === 'checkout' ? status === 'CHECKED_OUT' : true;
  return filter === 'done' ? done : filter === 'pending' ? !done : true;
}

export function summarizeOperationBookings(bookings: Record<string, any>[], action: OperationAction) {
  let revenue = 0, partnerTotal = 0, toCollect = 0;
  let paidOnline = 0, paidMB = 0, paidCash = 0, paidOther = 0;
  let cancelledCount = 0, cancelledValue = 0;
  const byPark: Record<string, { count: number; revenue: number; partnerShare: number; partnerName: string | null }> = {};
  for (const b of bookings) {
    const price = Number(b.totalPrice) || 0;
    const park = b.parkName || 'Desconhecido';
    const city = b.city || '';
    const name = city && !park.includes(city) ? `${park} ${city}` : park;
    const group = byPark[name] ??= { count: 0, revenue: 0, partnerShare: 0, partnerName: null };
    group.count++;
    if (b.status === 'CANCELLED') {
      cancelledCount++;
      cancelledValue += price;
      // A criação continua a contar; o valor cancelado não é receita prevista.
      if (action === 'creation') continue;
    }
    revenue += price;
    group.revenue += price;
    toCollect += Number(b.remainingToPay) || 0;
    const paid = Number(b.totalPaid) || 0;
    const method = String(b.paymentMethod ?? '').toLowerCase();
    if (paid > 0) {
      if (method === 'online' || method.includes('viva wallet') || method.includes('transferencia') || method.includes('transferência')) paidOnline += paid;
      else if (method === 'multibanco') paidMB += paid;
      else if (method === 'dinheiro') paidCash += paid;
      else paidOther += paid;
    }
    const commission = Number(b.salesPartnerCommission ?? 0);
    if (commission > 0) {
      group.partnerShare += commission;
      group.partnerName = b.salesPartnerName ?? group.partnerName;
      partnerTotal += commission;
    }
  }
  return { revenue, byPark, partnerTotal, toCollect, paidOnline, paidMB, paidCash, paidOther, cancelledCount, cancelledValue };
}
