/**
 * P3 lote 29a — Parcerias por MARCA (Jorge, 6 out 2026): "aqui deves pôr
 * apenas as marcas, não divididas por cidade — quem é parceiro de uma marca é
 * parceiro nas três cidades". A taxa continua gravada por parque na Multipark;
 * aqui junta-se por marca (Airpark, Redpark, Skypark). Se as cidades tiverem
 * taxas diferentes mostra-se o intervalo e o detalhe fica na dica.
 *
 * E os inativos (parceiros, parques, Pros, avenças) saem das listas.
 */
import { OUR_PARK_BRAND_LABELS, ourBrandOf, type OurParkBrand } from "./multiparkParks";

export interface BrandFeePark {
  /** marca do parque (airpark|redpark|skypark) — null = não é nosso */
  brand: string | null;
  parkName: string;
  city: string | null;
  /** linha "Partner" ativa na Multipark */
  active: boolean;
  /** o parque não está INATIVO na Multipark (omisso = ativo) */
  parkActive?: boolean;
  feeType: string | null;
  feePct: number | null;
  feeFixed: number | null;
}

export interface PartnerBrandFee {
  brand: string;
  /** alguma cidade ativa (parceiro ativo num parque ativo) */
  active: boolean;
  /** "20 %", "20–25 %", "2,50 €" ou null (sem taxa / taxas escondidas) */
  fee: string | null;
  /** quando as cidades diferem: "Faro 25 % · Lisboa 20 %" */
  detail: string | null;
}

const brandLabel = (b: string | null): string =>
  b && (OUR_PARK_BRAND_LABELS as Record<string, string>)[b] ? (OUR_PARK_BRAND_LABELS as Record<string, string>)[b] : "Outro";

const pct = (n: number) => `${n.toLocaleString("pt-PT", { maximumFractionDigits: 2 })} %`;
const money = (n: number) => `${n.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

function feeOf(p: BrandFeePark): { kind: "pct" | "fixed"; value: number } | null {
  if (p.feeType === "FIXED" && p.feeFixed != null) return { kind: "fixed", value: p.feeFixed };
  if (p.feePct != null) return { kind: "pct", value: p.feePct };
  if (p.feeFixed != null) return { kind: "fixed", value: p.feeFixed };
  return null;
}
const fmtFee = (f: { kind: "pct" | "fixed"; value: number }) => (f.kind === "pct" ? pct(f.value) : money(f.value));

/** Parque conta como ativo: linha do parceiro ativa E parque não inativo. PURA. */
export const isParkRowActive = (p: Pick<BrandFeePark, "active" | "parkActive">): boolean => p.active && p.parkActive !== false;

/**
 * Linhas por parque → uma por marca. A taxa mostrada é a das cidades ativas
 * (se nenhuma estiver ativa, a de todas). Ordem: Airpark, Redpark, Skypark,
 * Outro. PURA.
 */
export function partnerBrandFees(parks: readonly BrandFeePark[]): PartnerBrandFee[] {
  const order = ["airpark", "redpark", "skypark"];
  const groups = new Map<string, BrandFeePark[]>();
  for (const p of parks) {
    const k = p.brand && order.includes(p.brand) ? p.brand : "outro";
    const g = groups.get(k) ?? [];
    g.push(p);
    groups.set(k, g);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (order.indexOf(a) === -1 ? 9 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 9 : order.indexOf(b)))
    .map(([k, rows]) => {
      const active = rows.some(isParkRowActive);
      const use = active ? rows.filter(isParkRowActive) : rows;
      const fees = use.map((r) => ({ r, f: feeOf(r) }));
      const known = fees.filter((x) => x.f) as Array<{ r: BrandFeePark; f: { kind: "pct" | "fixed"; value: number } }>;
      const distinct = [...new Set(known.map((x) => fmtFee(x.f)))];
      let fee: string | null = null;
      if (distinct.length === 1) fee = distinct[0];
      else if (distinct.length > 1) {
        const pcts = known.filter((x) => x.f.kind === "pct").map((x) => x.f.value);
        fee = pcts.length === known.length ? `${Math.min(...pcts).toLocaleString("pt-PT")}–${pct(Math.max(...pcts))}` : "várias taxas";
      }
      const detail = distinct.length > 1
        ? [...known].sort((a, b) => String(a.r.city ?? a.r.parkName).localeCompare(String(b.r.city ?? b.r.parkName), "pt"))
          .map((x) => `${x.r.city ?? x.r.parkName} ${fmtFee(x.f)}`).join(" · ")
        : null;
      return { brand: k === "outro" ? "Outro" : brandLabel(k), active, fee, detail };
    });
}

/** Nomes de parques → marcas (sem repetir); nomes sem marca ficam como estão. PURA. */
export function brandsOfParkNames(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    const b = ourBrandOf(n) as OurParkBrand | null;
    const label = b ? OUR_PARK_BRAND_LABELS[b] : n;
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

/** Parceiro (todas as linhas) ativo: alguma linha ativa num parque ativo. PURA. */
export function isLivePartnerActive(p: { active: boolean; parks: ReadonlyArray<Pick<BrandFeePark, "active" | "parkActive">> }): boolean {
  if (!p.active) return false;
  return p.parks.length === 0 || p.parks.some(isParkRowActive);
}
