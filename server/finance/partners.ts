/**
 * PARCEIROS — UMA regra de correspondência campanha → parceiro para todo o
 * lado (motor financeiro, Parcerias, Reservas & Operações, Marketing):
 * R.buildPartnerIndex sobre TODOS os parceiros + aliases (nome, campaignKey,
 * alias; o mais recente ganha e o conflito fica assinalado). Antes cada vista
 * tinha a sua cópia (a das Parcerias só via os parceiros do tipo filtrado e o
 * "primeiro" ganhava; a da Faturação o mais recente).
 */
import { partnerAliases, partnerships } from "../../drizzle/schema";
import { parsePartnerConfig } from "../../shared/partnerTypes";
import * as R from "./rules";

export interface PartnerRow extends R.PartnerLite {
  notes: string | null;
  monthlyFee: number;
  partnerStatus: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadPartnerIndex(db: any): Promise<{ partners: PartnerRow[]; index: R.PartnerIndex }> {
  const rows = await db.select({
    id: partnerships.id, name: partnerships.name, campaignKey: partnerships.campaignKey,
    commissionRate: partnerships.commissionRate, partnerType: partnerships.partnerType,
    commissionBase: partnerships.commissionBase, notes: partnerships.notes,
    monthlyFee: partnerships.monthlyFee, partnerStatus: partnerships.partnerStatus,
    updatedAt: partnerships.updatedAt, configuredAt: partnerships.configuredAt,
  }).from(partnerships);
  const aliasRows = await db.select({ partnershipId: partnerAliases.partnershipId, aliasValue: partnerAliases.aliasValue }).from(partnerAliases);
  const partners: PartnerRow[] = (rows as any[]).map((p) => ({
    id: p.id, name: p.name, campaignKey: p.campaignKey ?? null,
    commissionRate: p.commissionRate == null ? null : Number(p.commissionRate),
    partnerType: p.partnerType ?? null, commissionBase: p.commissionBase ?? "net",
    notes: p.notes ?? null, monthlyFee: Number(p.monthlyFee ?? 0), partnerStatus: p.partnerStatus ?? null,
    updatedAt: p.updatedAt ?? "", configuredAt: p.configuredAt === undefined ? undefined : (p.configuredAt ?? null),
  }));
  return { partners, index: R.buildPartnerIndex(partners, aliasRows ?? []) };
}

/** Parceiro de uma campanha (chave sem espaços nem maiúsculas). */
export function partnerForCampaign(index: R.PartnerIndex, campaign: string | null | undefined): R.PartnerLite | undefined {
  const key = (campaign ?? "").trim().toLowerCase();
  return key ? index.byKey.get(key) : undefined;
}

/**
 * Centros (folhas) que cada parceiro OPERACIONAL cobre (operatesProjects na
 * ficha, expandidos pela hierarquia). `filter` limita ao âmbito pedido.
 */
export async function operatedLeavesByPartner(
  partners: Array<{ id: number; partnerType?: string | null; notes: string | null }>,
  resolveProjectIds: (id: number) => Promise<number[]>,
  filter?: Set<number>,
): Promise<Map<number, Set<number>>> {
  const out = new Map<number, Set<number>>();
  for (const p of partners) {
    if ((p.partnerType ?? "outro") !== "operacional") continue;
    const roots = parsePartnerConfig(p.notes ?? null).operatesProjects ?? [];
    if (roots.length === 0) continue;
    const leaves = new Set<number>();
    for (const root of roots) for (const pid of await resolveProjectIds(root)) if (!filter || filter.has(pid)) leaves.add(pid);
    if (leaves.size) out.set(p.id, leaves);
  }
  return out;
}
