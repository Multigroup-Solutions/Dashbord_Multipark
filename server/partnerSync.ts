/**
 * Sincronização de PARCEIROS a partir dos dados explícitos da API Multipark
 * (Fase 1 do plano de reorganização das Parcerias, 2026-08-04):
 *
 *  - resolve os partnerIds mascarados ("Unknown User" no /report): por cada
 *    partnerId sem alias, vai ao detalhe de UMA reserva desse parceiro,
 *    aprende o nome real, cria/liga a partnership e o alias — o alias aplica
 *    o nome ao histórico (addPartnerAlias já faz o UPDATE em massa)
 *  - cria as empresas Pro a partir das campanhas "Pro <empresa>"
 *  - normaliza tipos legados do ENUM antigo (aggregator/agency/pro_client/…)
 */

import { and, eq, isNotNull, like, ne, or, sql } from "drizzle-orm";
import { addPartnerAlias, createPartnership, getDb } from "./db";
import { multiparkBookings, partnerAliases, partnerships } from "../drizzle/schema";
import { LEGACY_TYPE_MAP } from "../shared/partnerTypes";

const AGGREGATOR_RE = /parkos|parclick|park\s?via|looking\s?4|parkimeter|one\s?park|free2move|parkivado|parkopedia|parkfly|holiday\s?extras/i;
const AGENCY_RE = /viagen|travel|tour(?!ing)|ag[êe]ncia|besttravel|bestravel/i;

/** Classificação automática pelo nome; o resto fica "outro" (fila Por classificar). */
export function classifyPartnerName(name: string): string {
  if (/^pro\s+/i.test(name)) return "cliente_pro";
  if (AGGREGATOR_RE.test(name)) return "agregador";
  if (AGENCY_RE.test(name)) return "agencia_viagem";
  if (/hotel/i.test(name)) return "hotel";
  return "outro";
}

/** Normaliza tipos legados nas partnerships existentes (idempotente). */
export async function fixLegacyPartnerTypes(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const legacy = Object.keys(LEGACY_TYPE_MAP);
  const rows = await db
    .select({ id: partnerships.id, name: partnerships.name, partnerType: partnerships.partnerType })
    .from(partnerships);
  let fixed = 0;
  for (const p of rows) {
    const t = p.partnerType ?? "";
    if (!legacy.includes(t)) continue;
    // "Pro X" marcado como agency (bug antigo da página de inferência) é Pro.
    const newType = /^pro\s+/i.test(p.name) ? "cliente_pro" : (LEGACY_TYPE_MAP[t] ?? "outro");
    await db.update(partnerships).set({ partnerType: newType }).where(eq(partnerships.id, p.id));
    fixed++;
  }
  return fixed;
}

export interface PartnerSyncResult {
  legacyTypesFixed: number;
  partnerIdsTotal: number;
  alreadyLinked: number;
  linkedToExisting: number;
  created: number;
  unresolved: Array<{ partnerId: string; reason: string }>;
  proCreated: number;
  proExisting: number;
}

/**
 * Resolve os partnerIds mascarados e garante as empresas Pro. Idempotente —
 * pode correr as vezes que forem precisas (botão "Sincronizar parceiros da
 * API" na página de Parcerias).
 */
export async function syncPartnersFromApi(): Promise<PartnerSyncResult> {
  const db = await getDb();
  const result: PartnerSyncResult = {
    legacyTypesFixed: 0, partnerIdsTotal: 0, alreadyLinked: 0,
    linkedToExisting: 0, created: 0, unresolved: [], proCreated: 0, proExisting: 0,
  };
  if (!db) return result;

  result.legacyTypesFixed = await fixLegacyPartnerTypes();

  // 1) partnerIds distintos nas reservas, com uma reserva-amostra recente cada
  const rows = (r: any) => (Array.isArray(r[0]) ? r[0] : r) as any[];
  const ids = rows(await db.execute(sql`
    SELECT partnerId,
           SUBSTRING_INDEX(GROUP_CONCAT(externalId ORDER BY checkIn DESC), ',', 1) AS sampleExternalId,
           MAX(NULLIF(NULLIF(partnerName, ''), 'Unknown User')) AS knownName,
           COUNT(*) AS n
    FROM multipark_bookings
    WHERE partnerId IS NOT NULL AND partnerId <> ''
    GROUP BY partnerId`));
  result.partnerIdsTotal = ids.length;

  const aliasRows = await db
    .select({ aliasValue: partnerAliases.aliasValue })
    .from(partnerAliases)
    .where(eq(partnerAliases.aliasType, "multipark_partner_id"));
  const linked = new Set(aliasRows.map((a) => a.aliasValue.toLowerCase()));

  const partnershipRows = await db
    .select({ id: partnerships.id, name: partnerships.name })
    .from(partnerships);
  const byName = new Map(partnershipRows.map((p) => [p.name.trim().toLowerCase(), p.id]));

  const { getBookingTryAllParks } = await import("./multipark");

  for (const row of ids) {
    const partnerId = String(row.partnerId);
    if (linked.has(partnerId.toLowerCase())) { result.alreadyLinked++; continue; }

    // Nome: usa o que já esteja na BD (enrichment) ou vai ao detalhe da amostra
    let name: string | null = row.knownName ?? null;
    if (!name && row.sampleExternalId) {
      try {
        const found = await getBookingTryAllParks(String(row.sampleExternalId));
        const pn = (found?.booking as any)?.partnerName;
        if (typeof pn === "string" && pn && !/unknown/i.test(pn)) name = pn;
      } catch { /* tenta o próximo */ }
    }
    if (!name) {
      result.unresolved.push({ partnerId, reason: "nome não disponível na API (amostra falhou ou mascarado)" });
      continue;
    }

    name = name.trim().slice(0, 255);
    let partnershipId = byName.get(name.toLowerCase()) ?? null;
    if (!partnershipId) {
      partnershipId = await createPartnership({
        name,
        partnerType: classifyPartnerName(name),
        partnerStatus: "active",
        commissionRate: 0,
        monthlyFee: 0,
      });
      if (!partnershipId) {
        result.unresolved.push({ partnerId, reason: `falha a criar partnership "${name}"` });
        continue;
      }
      byName.set(name.toLowerCase(), partnershipId);
      result.created++;
    } else {
      result.linkedToExisting++;
    }
    // O alias liga o UUID ao parceiro E aplica o nome ao histórico de reservas.
    await addPartnerAlias(partnershipId, "multipark_partner_id", partnerId, true);
    linked.add(partnerId.toLowerCase());
  }

  // 2) Empresas Pro a partir das campanhas "Pro <empresa>"
  const proCamps = rows(await db.execute(sql`
    SELECT campaignName, COUNT(*) AS n FROM multipark_bookings
    WHERE campaignName LIKE 'Pro %' GROUP BY campaignName`));
  for (const c of proCamps) {
    const campaignName = String(c.campaignName).trim();
    const empresa = campaignName.replace(/^pro\s+/i, "").trim();
    const existing = byName.get(campaignName.toLowerCase()) ?? byName.get(empresa.toLowerCase());
    if (existing) { result.proExisting++; continue; }
    const id = await createPartnership({
      name: campaignName,
      partnerType: "cliente_pro",
      partnerStatus: "active",
      commissionRate: 0,
      monthlyFee: 0,
    });
    if (id) {
      byName.set(campaignName.toLowerCase(), id);
      result.proCreated++;
    }
  }

  return result;
}
