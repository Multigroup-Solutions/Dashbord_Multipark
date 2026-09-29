// Regras puras das Parcerias — partilhadas entre client e server (sem BD,
// sem Date local), para a UI e o servidor concordarem.

/**
 * Meses (fracionários) cobertos por um intervalo de dias: cada mês de
 * calendário conta dias_no_intervalo / dias_do_mês. Um mês completo = 1,
 * independentemente de ter 28, 30 ou 31 dias.
 */
export function monthsCovered(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  let total = 0;
  let cur = new Date(start);
  while (cur.getTime() <= end) {
    const y = cur.getUTCFullYear(), m = cur.getUTCMonth();
    const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const monthEnd = Date.UTC(y, m, dim);
    const last = Math.min(end, monthEnd);
    total += (Math.round((last - cur.getTime()) / 86_400_000) + 1) / dim;
    cur = new Date(Date.UTC(y, m + 1, 1));
  }
  return total;
}

/**
 * Avença rateada pelo período. O campo `monthlyFee` é SEMPRE €/mês (é o que o
 * formulário pede: "Valor da avença (€/mês)"), tanto na avença mensal como na
 * anual — a anual só difere na periodicidade da fatura. Ambas faturam
 * monthlyFee × meses cobertos. Antes a anual fazia monthlyFee × dias/365, ou
 * seja faturava 1/12 do devido; e a mensal usava dias/30 (31 dias = 1,03 meses).
 * Outros tipos não têm avença → 0.
 */
export function partnerFeeForPeriod(partnerType: string, monthlyFee: number | null | undefined, from: string, to: string): number {
  if (partnerType !== "avenca_mensal" && partnerType !== "avenca_anual") return 0;
  const fee = Number(monthlyFee ?? 0);
  if (!Number.isFinite(fee) || fee <= 0) return 0;
  return Math.round(fee * monthsCovered(from, to) * 100) / 100;
}

/**
 * Um parceiro está "por configurar" enquanto nenhum admin o gravou no ecrã
 * (configuredAt NULL). Os parceiros criados pela sincronização automática
 * nascem com 0% e sem avença — sem esta marca não se distinguia um 0%
 * confirmado de uma taxa nunca preenchida.
 */
export function isPartnerUnconfigured(p: { configuredAt?: string | Date | null }): boolean {
  return p.configuredAt == null;
}

/**
 * Valor de fallback para `campaign` de uma reserva vinda do /report. O
 * partnerName vem mascarado como "Unknown User" nas reservas de parceiros —
 * nesse caso passa-se ao código de desconto / campanha em vez de descartar
 * tudo (antes um "Unknown User" apagava também o discountCode).
 */
export function bookingCampaignFallback(b: { partnerName?: unknown; discountCode?: unknown; campaign?: unknown }): string | null {
  for (const v of [b.partnerName, b.discountCode, b.campaign]) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (s && !/unknown/i.test(s)) return s;
  }
  return null;
}

/** Primeiro e último dia do mês de um dia "YYYY-MM-DD" (calendário, sem fuso). */
export function monthBoundsOf(day: string): { monthStart: string; monthEnd: string } {
  const [y, m] = day.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { monthStart: `${y}-${mm}-01`, monthEnd: `${y}-${mm}-${String(last).padStart(2, "0")}` };
}
