/**
 * Auditoria nossa (R29, docs/auditoria/caixa-furos.md): mudar a taxa, a base,
 * a mensalidade ou os códigos de um parceiro muda as comissões de meses já
 * fechados. Passa a ficar registado o ANTES e o DEPOIS de cada campo (e um
 * aviso quando a mudança toca em dinheiro).
 */

/** Campos da parceria cujo antes → depois fica no registo. */
export const PARTNER_AUDIT_FIELDS = [
  "name", "campaignKey", "partnerType", "commissionRate", "commissionBase", "monthlyFee", "partnerStatus", "billingAgreement", "multiparkPartnerId", "partnerNif",
] as const;
/** Os que mexem nas contas (comissões, mensalidade, a que reservas se aplica). */
export const PARTNER_MONEY_FIELDS = new Set(["campaignKey", "commissionRate", "commissionBase", "monthlyFee", "multiparkPartnerId", "name"]);

const norm = (v: unknown) => (v == null || v === "" ? null : typeof v === "number" ? v : String(v).trim());
const same = (a: unknown, b: unknown) => {
  const x = norm(a), y = norm(b);
  if (x == null || y == null) return x === y;
  const nx = Number(x), ny = Number(y);
  if (Number.isFinite(nx) && Number.isFinite(ny) && String(x).trim() !== "" && String(y).trim() !== "") return Math.abs(nx - ny) < 1e-9;
  return String(x) === String(y);
};

/** "campo: antes → depois; …" só dos campos pedidos que mudam. PURA. */
export function partnerAuditDiff(before: Record<string, unknown> | null | undefined, patch: Record<string, unknown>): { text: string | null; money: boolean } {
  if (!before) return { text: null, money: false };
  const parts: string[] = [];
  let money = false;
  for (const k of PARTNER_AUDIT_FIELDS) {
    if (!(k in patch)) continue;
    if (same(before[k], patch[k])) continue;
    parts.push(`${k}: ${norm(before[k]) ?? "—"} → ${norm(patch[k]) ?? "—"}`);
    if (PARTNER_MONEY_FIELDS.has(k)) money = true;
  }
  if (!parts.length) return { text: null, money: false };
  return { text: `${money ? "[mexe nas comissões] " : ""}${parts.join("; ")}`.slice(0, 2000), money };
}
