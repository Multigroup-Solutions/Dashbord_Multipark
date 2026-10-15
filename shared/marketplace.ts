/**
 * MARKETPLACE — parques de terceiros em que NÓS somos o marketplace (vendemos
 * as reservas deles). Regra do dono (27 set 2026): o valor das reservas
 * divide-se 80 % para o parque e 20 % para nós. Uma constante única para, mais
 * tarde, passar a ser configurável por parque.
 */

/** A nossa parte do valor das reservas de um parque de terceiros (0–1). */
export const MARKETPLACE_COMMISSION = 0.2;

/**
 * 28b (Jorge, 6 out 2026): uma reserva num parque NOSSO que vem pela
 * campanha do Marketplace (a Multipark marca-a com `Booking.origin =
 * 'MARKETPLACE'`, ou a campanha chama-se "Marketplace") paga ao Marketplace
 * 20 % — "igual que dos outros parceiros". Nome da campanha nas contas.
 */
export const MARKETPLACE_CAMPAIGN = "Marketplace";

/** `Booking.origin` das reservas feitas no Marketplace (multipark.pt). */
export const MARKETPLACE_ORIGIN = "MARKETPLACE";

/**
 * É uma reserva do MARKETPLACE? — a REGRA ÚNICA (Jorge, 8 out 2026: "têm que
 * aparecer TODAS as reservas feitas no marketplace, seja de que parque for;
 * depois nós é que pomos para onde tiver de ser"):
 *   - parque de TERCEIROS (não é Airpark/Redpark/Skypark em Lisboa/Porto/Faro):
 *     TODAS as reservas, seja qual for a origem;
 *   - parque NOSSO: só as que vieram pelo Marketplace (`origin = 'MARKETPLACE'`,
 *     regra 28b do dono).
 * É a mesma do canal da contabilidade (classifyBookingChannel), das Reservas
 * do dia, das Operações, do Marketing e das Parcerias. A "comissão gravada"
 * ("commissionAmount") NÃO entra aqui: nos terceiros já entram todas e nos
 * nossos nenhuma regra do dono a usa (ver MARKETPLACE_COMMISSIONED_SQL para o
 * dinheiro). PURA.
 */
export function isMarketplaceBooking(b: { parkOurs: boolean; origin?: string | null }): boolean {
  return !b.parkOurs || String(b.origin ?? "").trim().toUpperCase() === MARKETPLACE_ORIGIN;
}

/** Etiqueta do parque de uma reserva do Marketplace (comissão diferente — Jorge, 8 out 2026). */
export const MARKETPLACE_OPERATED_LABEL = "Operado por nós";
export const MARKETPLACE_NOT_OPERATED_LABEL = "Não operado";
export const operatedLabel = (operated: boolean) => (operated ? MARKETPLACE_OPERATED_LABEL : MARKETPLACE_NOT_OPERATED_LABEL);

/** Nome do bloco das reservas do Marketplace de parques sem cidade reconhecida. */
export const MARKETPLACE_NO_CITY_LABEL = "Marketplace (sem cidade)";

const cents = (n: number) => Math.round(n * 100) / 100;

/** Valor → { nossa parte, parte do parque }. `rate` por omissão = MARKETPLACE_COMMISSION. PURA. */
export function marketplaceSplit(value: number, rate: number = MARKETPLACE_COMMISSION): { ours: number; park: number } {
  const v = Number.isFinite(value) ? value : 0;
  const r = Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : MARKETPLACE_COMMISSION;
  const ours = cents(v * r);
  return { ours, park: cents(v - ours) };
}
