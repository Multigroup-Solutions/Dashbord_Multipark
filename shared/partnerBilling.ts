/**
 * A faturar de um registo das Parcerias LIGADO à Multipark (0295), com os
 * números de lá (server/multiparkDb/partnerBilling.ts). PURO.
 *   - parceiro: a faturar = o NOSSO gravado (partnerAmountDue) das saídas do período;
 *   - Pro: a faturar = o preço das reservas Pro que saíram;
 *   - avença: a faturar = o preço do plano (Multipark) pelos meses cobertos.
 * Registos não ligados (ou só nossos) → null: seguem a regra antiga.
 */
import { partnerFeeForPeriod } from "./partnerRules";

export interface MpBillingStats { n: number; value: number; ours: number | null; missing: number }
export interface MpBillingMaps {
  partners: ReadonlyMap<string, MpBillingStats>;
  pros: ReadonlyMap<string, MpBillingStats>;
  plans: ReadonlyMap<string, MpBillingStats>;
}
export interface RecordForBilling {
  partnerType: string | null;
  multiparkKind: string | null;
  multiparkPartnerId: string | null;
  multiparkSnapshot: string | null;
}
export interface RecordBilling { bookingsCount: number; revenueGross: number; aFaturar: number; missing: number; source: "multipark" }

/** €/mês a partir do preço e da cadência do plano. PURA. */
export function planMonthly(price: unknown, cadence: unknown): number {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return 0;
  return /year|annual|anual/i.test(String(cadence ?? "")) ? p / 12 : p;
}

const EMPTY: MpBillingStats = { n: 0, value: 0, ours: 0, missing: 0 };
const r2 = (n: number) => Math.round(n * 100) / 100;

export function recordBillingFromMp(rec: RecordForBilling, mp: MpBillingMaps, from: string, to: string): RecordBilling | null {
  const kind = String(rec.multiparkKind ?? "");
  const key = String(rec.multiparkPartnerId ?? "").trim();
  if (!key || !["partner", "pro", "plan"].includes(kind)) return null;
  if (kind === "partner") {
    const s = mp.partners.get(key) ?? EMPTY;
    return { bookingsCount: s.n, revenueGross: r2(s.value), aFaturar: r2(s.ours ?? 0), missing: s.missing, source: "multipark" };
  }
  if (kind === "pro") {
    const s = mp.pros.get(key.replace(/^pro:/, "")) ?? EMPTY;
    return { bookingsCount: s.n, revenueGross: r2(s.value), aFaturar: r2(s.value), missing: 0, source: "multipark" };
  }
  const s = mp.plans.get(key.replace(/^plan:/, "")) ?? EMPTY;
  let snap: Record<string, unknown> = {};
  try { snap = rec.multiparkSnapshot ? JSON.parse(rec.multiparkSnapshot) : {}; } catch { /* JSON estragado: sem preço */ }
  const type = rec.partnerType === "avenca_anual" ? "avenca_anual" : "avenca_mensal";
  return { bookingsCount: s.n, revenueGross: r2(s.value), aFaturar: r2(partnerFeeForPeriod(type, planMonthly(snap.price, snap.cadence), from, to)), missing: 0, source: "multipark" };
}
