// Catálogo canónico de tipos de parceiro. Partilhado entre client e server.
//
// O campo `chargeModel` define como o parceiro fatura/é faturado:
//  - commission_on_revenue: comissão = receita das reservas × commissionRate%
//  - small_commission: comissão de afiliado (rate normalmente baixa < 5%)
//  - monthly_fee: avença fixa mensal (campo `monthlyFee` na partnership)
//  - yearly_fee: avença fixa anual (campo `monthlyFee` ÷ 12 ou novo campo)
//  - prepaid_with_discount: cliente paga logo (vem na reserva com desconto já aplicado)
//  - monthly_invoice_discount: factura-se no fim do mês com desconto
//  - own_campaign: campanha própria — descontos / cashback / prémios para o centro de custos
//  - operational: parceiro operacional (ex: Top Parking nas marcas Porto)
//  - manual: sem modelo automático, lançamento manual
//
// `appliesTo` indica se o parceiro afecta receita (venda) ou custo (operacional).
// `isExtensible = true` significa que é o tipo livre "outro" para casos não previstos.

export type PartnerChargeModel =
  | "commission_on_revenue"
  | "small_commission"
  | "monthly_fee"
  | "yearly_fee"
  | "prepaid_with_discount"
  | "monthly_invoice_discount"
  | "own_campaign"
  | "operational"
  | "manual";

export type PartnerTypeAppliesTo = "sale" | "operational" | "both";

export type PartnerTypeDef = {
  id: string;
  label: string;
  description: string;
  chargeModel: PartnerChargeModel;
  appliesTo: PartnerTypeAppliesTo;
  isExtensible?: boolean;
};

export const PARTNER_TYPES: PartnerTypeDef[] = [
  {
    id: "agregador",
    label: "Agregador",
    description: "Sites de venda (ex: Looking4Parking, Parkos). Recebem comissão sobre a reserva.",
    chargeModel: "commission_on_revenue",
    appliesTo: "sale",
  },
  {
    id: "agencia_viagem",
    label: "Agência de viagem",
    description: "Agências que vendem o estacionamento como parte de um pacote.",
    chargeModel: "commission_on_revenue",
    appliesTo: "sale",
  },
  {
    id: "avenca_mensal",
    label: "Avença mensal",
    description: "Valor fixo cobrado todos os meses. Definir em `monthlyFee` da parceria.",
    chargeModel: "monthly_fee",
    appliesTo: "sale",
  },
  {
    id: "avenca_anual",
    label: "Avença anual",
    description: "Valor fixo cobrado uma vez por ano.",
    chargeModel: "yearly_fee",
    appliesTo: "sale",
  },
  {
    id: "cliente_pro",
    label: "Cliente Pro (Airpark)",
    description: "Empresas Pro — actualmente só na marca Airpark. Faturam no fim do mês com desconto.",
    chargeModel: "monthly_invoice_discount",
    appliesTo: "sale",
  },
  {
    id: "hotel",
    label: "Hotel",
    description: "Parceria com hotéis. Comissão sobre a reserva trazida.",
    chargeModel: "commission_on_revenue",
    appliesTo: "sale",
  },
  {
    id: "companhia_aerea",
    label: "Companhia aérea",
    description: "Parceria com companhias aéreas. Comissão sobre a reserva.",
    chargeModel: "commission_on_revenue",
    appliesTo: "sale",
  },
  {
    id: "afiliado",
    label: "Afiliado",
    description: "Comissão pequena. Cliente do afiliado tem desconto já reflectido na fatura.",
    chargeModel: "small_commission",
    appliesTo: "sale",
  },
  {
    id: "enterprise",
    label: "Enterprise / Corporate",
    description: "Cliente corporate. Paga logo no acto. Desconto já vem na reserva.",
    chargeModel: "prepaid_with_discount",
    appliesTo: "sale",
  },
  {
    id: "campanha_propria",
    label: "Campanha própria",
    description: "Promoções nossas com descontos, cashback ou prémios — vão para o centro de custos.",
    chargeModel: "own_campaign",
    appliesTo: "sale",
  },
  {
    id: "operacional",
    label: "Operacional",
    description: "Parceiro que gere operações (ex: Top Parking para marcas do Porto). Pagamos comissão operacional.",
    chargeModel: "operational",
    appliesTo: "operational",
  },
  {
    id: "outro",
    label: "Outro",
    description: "Casos não cobertos pelos tipos acima.",
    chargeModel: "manual",
    appliesTo: "both",
    isExtensible: true,
  },
];

export const PARTNER_TYPE_BY_ID: Record<string, PartnerTypeDef> = Object.fromEntries(
  PARTNER_TYPES.map((t) => [t.id, t]),
);

/**
 * Valores legados do ENUM antigo (antes do catálogo em português) que ainda
 * podem existir em linhas antigas da BD. Normalizados na leitura.
 */
export const LEGACY_TYPE_MAP: Record<string, string> = {
  aggregator: "agregador",
  agency: "agencia_viagem",
  pro_client: "cliente_pro",
  corporate: "enterprise",
  retainer: "avenca_mensal",
  other: "outro",
};

export function normalizePartnerTypeId(id: string | null | undefined): string {
  if (!id) return "outro";
  return PARTNER_TYPE_BY_ID[id] ? id : (LEGACY_TYPE_MAP[id] ?? "outro");
}

export function getPartnerType(id: string | null | undefined): PartnerTypeDef {
  return PARTNER_TYPE_BY_ID[normalizePartnerTypeId(id)];
}

// ─── Categorias macro (organização pedida pelo Jorge, 2026-08-04) ────────────
// 4 categorias de venda + uma secção à parte para o que é custo/interno.

export type PartnerCategoryId = "pros" | "agencias" | "empresas" | "agregadores" | "interno";

export type PartnerCategoryDef = {
  id: PartnerCategoryId;
  label: string;
  description: string;
};

export const PARTNER_CATEGORIES: PartnerCategoryDef[] = [
  { id: "pros", label: "Prós", description: "Empresas com plano Pro (faturação mensal com desconto)." },
  { id: "agencias", label: "Agências de viagens", description: "Agências que vendem o estacionamento em pacote." },
  { id: "empresas", label: "Empresas parceiras", description: "ACP, corporates, hotéis, companhias aéreas, avenças e afiliados." },
  { id: "agregadores", label: "Agregadores", description: "Sites de venda (Parkos, Parclick, Parkvia, …) à comissão." },
  { id: "interno", label: "Operacional / Campanhas", description: "Parceiros operacionais e campanhas próprias — custo, não venda." },
];

const TYPE_TO_CATEGORY: Record<string, PartnerCategoryId> = {
  cliente_pro: "pros",
  agencia_viagem: "agencias",
  agregador: "agregadores",
  enterprise: "empresas",
  hotel: "empresas",
  companhia_aerea: "empresas",
  afiliado: "empresas",
  avenca_mensal: "empresas",
  avenca_anual: "empresas",
  outro: "empresas",
  operacional: "interno",
  campanha_propria: "interno",
};

export function partnerCategoryOf(typeId: string | null | undefined): PartnerCategoryId {
  return TYPE_TO_CATEGORY[normalizePartnerTypeId(typeId)] ?? "empresas";
}

export function typesInCategory(categoryId: PartnerCategoryId): PartnerTypeDef[] {
  return PARTNER_TYPES.filter((t) => partnerCategoryOf(t.id) === categoryId);
}

/**
 * Configuração extra que vive em partnership.notes como JSON.
 *   - operatesProjects: lista de projectIds que este parceiro opera (só
 *     usado para tipo "operacional"; ex.: Top Parking opera as marcas Porto).
 *     A comissão é aplicada sobre TODAS as reservas dos projetos da lista,
 *     independentemente do campaign — permite dupla comissão (venda +
 *     operacional na mesma reserva).
 *   - cashbackPercent: % de cashback dado em campanhas próprias.
 *   - prizeBudget: orçamento de prémios em campanhas próprias (€).
 *
 * Para back-compat, se o notes não for JSON válido, ignora-se e devolve
 * objecto vazio.
 */
export type PartnerExtraConfig = {
  operatesProjects?: number[];
  cashbackPercent?: number;
  prizeBudget?: number;
  avencaDate?: string;  // data da avença (YYYY-MM-DD) — tipos avenca_*
  invoiceDay?: number;  // dia do mês em que se emite a fatura — agregador/agência/pro
};

// Que campos do formulário fazem sentido para cada tipo (deriva do chargeModel).
export type PartnerFormFields = {
  commission: boolean;      // % de comissão
  invoiceTiming: boolean;   // dia/timing da fatura
  monthlyFee: boolean;      // valor da avença
  avencaDate: boolean;      // data da avença
  discountApplied: boolean; // info: desconto já vem aplicado na reserva
};

export function partnerFormFields(typeId: string | null | undefined): PartnerFormFields {
  const cm = getPartnerType(typeId).chargeModel;
  return {
    commission: cm === "commission_on_revenue" || cm === "small_commission",
    invoiceTiming: cm === "commission_on_revenue" || cm === "monthly_invoice_discount",
    monthlyFee: cm === "monthly_fee" || cm === "yearly_fee",
    avencaDate: cm === "monthly_fee" || cm === "yearly_fee",
    discountApplied: cm === "prepaid_with_discount" || cm === "monthly_invoice_discount",
  };
}

export function parsePartnerConfig(notes: string | null | undefined): PartnerExtraConfig {
  if (!notes) return {};
  const trimmed = notes.trim();
  if (!trimmed.startsWith("{")) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as PartnerExtraConfig;
  } catch {
    return {};
  }
}

export function serializePartnerConfig(cfg: PartnerExtraConfig, plainNotes: string = ""): string {
  const clean: PartnerExtraConfig = {};
  if (Array.isArray(cfg.operatesProjects) && cfg.operatesProjects.length > 0) {
    clean.operatesProjects = cfg.operatesProjects.map((n) => Number(n)).filter((n) => Number.isFinite(n));
  }
  if (typeof cfg.cashbackPercent === "number" && Number.isFinite(cfg.cashbackPercent)) {
    clean.cashbackPercent = cfg.cashbackPercent;
  }
  if (typeof cfg.prizeBudget === "number" && Number.isFinite(cfg.prizeBudget)) {
    clean.prizeBudget = cfg.prizeBudget;
  }
  if (typeof cfg.avencaDate === "string" && cfg.avencaDate.trim()) {
    clean.avencaDate = cfg.avencaDate.trim();
  }
  if (typeof cfg.invoiceDay === "number" && Number.isFinite(cfg.invoiceDay)) {
    clean.invoiceDay = cfg.invoiceDay;
  }
  // Se config vazio e há plain notes → devolve o plain
  if (Object.keys(clean).length === 0) return plainNotes;
  return JSON.stringify(clean);
}
