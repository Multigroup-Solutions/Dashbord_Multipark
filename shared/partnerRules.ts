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

/** Tipos sem comissão de venda: o Pro tem desconto, a avença paga uma mensalidade. */
export const NO_COMMISSION_TYPES: ReadonlySet<string> = new Set(["cliente_pro", "avenca_mensal", "avenca_anual"]);
/** Tipos que vêm da Multipark (mesma lista que shared/partnerMultiparkSync.ts SYNCED_TYPES). */
const MULTIPARK_TYPES: ReadonlySet<string> = new Set(["agregador", "agencia_viagem", "cliente_pro", "avenca_mensal", "avenca_anual"]);

type PartnerRecordState = {
  configuredAt?: string | Date | null; partnerType?: string | null; partnerStatus?: string | null;
  multiparkPartnerId?: string | null; multiparkKind?: string | null;
};

/** Registo preso a um parceiro/Pro/avença da Multipark (o tipo e a taxa vêm de lá). PURA. */
export function isLinkedToMultipark(p: PartnerRecordState): boolean {
  return !!(p.multiparkPartnerId && String(p.multiparkPartnerId).trim()) || ["partner", "pro", "plan"].includes(String(p.multiparkKind ?? ""));
}

/**
 * Um parceiro está "por configurar" enquanto nenhum admin o gravou no ecrã
 * (configuredAt NULL). Os parceiros criados pela sincronização automática
 * nascem com 0% e sem avença — sem esta marca não se distinguia um 0%
 * confirmado de uma taxa nunca preenchida.
 *
 * 29a (Jorge, 6 out: "porque é que isto continua a aparecer se tudo está na
 * Multipark?"): NÃO pedem configuração os ligados à Multipark (lá manda ela),
 * os inativos, nem os tipos que vêm da Multipark (Pros, avenças, agências,
 * agregadores — esses ligam-se em "Ligar à Multipark", ver
 * isAwaitingMultiparkLink). Fica só o que é nosso (hotel, empresa, outro…).
 */
export function isPartnerUnconfigured(p: PartnerRecordState): boolean {
  if (p.configuredAt != null) return false;
  if (isLinkedToMultipark(p)) return false;
  if (p.partnerStatus === "inactive") return false;
  if (p.partnerType && MULTIPARK_TYPES.has(p.partnerType)) return false;
  return true;
}

/** 29a: registo de um tipo da Multipark ainda por ligar (resolve-se com "Ligar à Multipark" → Aplicar). PURA. */
export function isAwaitingMultiparkLink(p: PartnerRecordState): boolean {
  return !isLinkedToMultipark(p) && p.multiparkKind !== "own" && p.partnerStatus !== "inactive" && !!p.partnerType && MULTIPARK_TYPES.has(p.partnerType);
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
