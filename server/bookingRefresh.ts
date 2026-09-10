/** Datas da API Multipark representam UTC, incluindo o formato sem offset. */
export function parseBookingDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4}),?\s*(\d{2}):(\d{2})(?::(\d{2}))?$/);
  const normalized = match
    ? `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:${match[6] ?? '00'}Z`
    : /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.test(value)
      ? `${value.replace(' ', 'T')}${value.length === 10 ? 'T00:00:00' : ''}Z`
      : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  // Date normaliza silenciosamente 31/02; a origem inválida não deve deslocar a reserva.
  if (match && date.toISOString().slice(0, 10) !== `${match[3]}-${match[2]}-${match[1]}`) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** Só altera campos efetivamente devolvidos; ausência não significa zero/nulo. */
export function bookingDetailCore(b: Record<string, any>): Record<string, any> {
  const update: Record<string, any> = {};
  for (const key of ['status', 'parkingType', 'paymentMethod', 'licensePlate']) {
    if (typeof b[key] === 'string' && b[key]) update[key] = b[key];
  }
  for (const [target, source] of [
    ['checkIn', b.checkInDate ?? b.checkIn], ['checkOut', b.checkOutDate ?? b.checkOut],
    ['bookingCreatedAt', b.createdAt], ['cancelledAt', b.cancelledAt], ['sourceUpdatedAt', b.updatedAt],
  ]) {
    const parsed = typeof source === 'string' ? parseBookingDate(source) : null;
    if (parsed) update[target] = parsed;
  }
  const pricing = b.pricing ?? {};
  for (const [target, value] of Object.entries({
    totalPrice: pricing.totalPrice ?? pricing.total ?? b.bookingPrice,
    parkingPrice: pricing.parkingPrice, deliveryCharges: pricing.deliveryCharges,
    extrasTotal: pricing.extraServicesTotal, discount: pricing.discount,
    remainingToPay: pricing.remainingToPay, totalPaid: pricing.totalPaid,
  })) {
    if ((typeof value === 'number' || typeof value === 'string') && value !== '' && Number.isFinite(Number(value))) {
      update[target] = String(value);
    }
  }
  if (typeof pricing.paymentMethod === 'string') update.paymentMethod = pricing.paymentMethod.slice(0, 128);
  return update;
}
