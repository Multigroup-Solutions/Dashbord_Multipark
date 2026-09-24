/**
 * ROAS por campanha → reservas (Jorge, 24 set 2026).
 *
 * Por campanha (Google Ads e Meta, gasto da fonte única getAdMetrics no
 * âmbito): gasto, cliques, conversões da plataforma, reservas LIGADAS, valor
 * s/ IVA, ROAS s/ IVA e CPA (gasto ÷ reservas ligadas).
 *
 * Reserva ligada a uma campanha, por esta ordem (cada reserva conta UMA vez):
 *   1. ID da campanha no link (adCampaignExternalId — gclid/fbclid + ValueTrack
 *      {campaignid} / {{campaign.id}}), do fornecedor da atribuição;
 *   2. `utm_campaign` com ligação criada pelo admin (ad_campaign_links);
 *   3. código de desconto (campo `campaign`/`campaignName` da reserva) com
 *      ligação criada pelo admin.
 * Reservas pela data de criação (dias de Lisboa), sem canceladas.
 * Também devolve as conversões por AÇÃO (ad_conversion_action_metrics).
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { projectScope } from "./cityScope";
import { FINANCE_PARAMS } from "./finance/rules";
import { netOfVatAmount, roasNetOfVat } from "../shared/marketingRules";
import { inLisbonDaysSql, marketingProjectIds, notCancelledSql } from "./marketingSql";

const rowsOf = <T = any>(r: any): T[] => (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r) as T[];
const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

export interface CampaignLinkKey { id: number; adCampaignId: number; keyType: "utm_campaign" | "discount_code"; keyValue: string }
export interface BookingForMatch { id: number; adAttribution: string | null; ext: string | null; utmCampaign: string | null; code: string | null; codeName: string | null; totalPrice: number }
export interface CampaignRef { key: string; provider: string; externalId: string | null; campaignId: number | null }

/**
 * Regra PURA: a que campanha (chave "api:<conta>:<externo>") pertence cada
 * reserva. ID no link > utm_campaign ligado > código de desconto ligado.
 */
export function matchBookingsToCampaigns(bookings: BookingForMatch[], campaigns: CampaignRef[], links: CampaignLinkKey[]): Map<string, BookingForMatch[]> {
  const byExt = new Map<string, CampaignRef>();
  for (const c of campaigns) if (c.externalId) byExt.set(`${c.provider}:${c.externalId}`, c);
  const byDbId = new Map<number, CampaignRef>();
  for (const c of campaigns) if (c.campaignId != null) byDbId.set(c.campaignId, c);
  const utm = new Map<string, CampaignRef>(), code = new Map<string, CampaignRef>();
  for (const l of links) {
    const c = byDbId.get(l.adCampaignId);
    if (!c) continue;
    (l.keyType === "utm_campaign" ? utm : code).set(norm(l.keyValue), c);
  }
  const out = new Map<string, BookingForMatch[]>();
  for (const b of bookings) {
    let hit: CampaignRef | undefined;
    if (b.ext) {
      const providers = b.adAttribution === "meta_paid" ? ["meta"] : b.adAttribution === "google_paid" ? ["google_ads"] : ["google_ads", "meta"];
      for (const p of providers) { hit = byExt.get(`${p}:${b.ext}`); if (hit) break; }
    }
    if (!hit && b.utmCampaign) hit = utm.get(norm(b.utmCampaign));
    if (!hit && (b.code || b.codeName)) hit = code.get(norm(b.code)) ?? code.get(norm(b.codeName));
    if (!hit) continue;
    const list = out.get(hit.key) ?? [];
    list.push(b); out.set(hit.key, list);
  }
  return out;
}

export async function listCampaignLinks(): Promise<Array<CampaignLinkKey & { campaignName: string | null; provider: string | null }>> {
  const db = await getDb();
  if (!db) return [];
  return rowsOf<any>(await db.execute(sql`
    SELECT l.id, l.adCampaignId, l.keyType, l.keyValue, c.name AS campaignName, c.provider AS provider
    FROM ad_campaign_links l LEFT JOIN ad_campaigns c ON c.id = l.adCampaignId
    ORDER BY c.name, l.keyType, l.keyValue`)).map((r) => ({ id: Number(r.id), adCampaignId: Number(r.adCampaignId), keyType: r.keyType, keyValue: String(r.keyValue), campaignName: r.campaignName ?? null, provider: r.provider ?? null }));
}

export async function getCampaignRoas(f: { from: string; to: string; projectId?: number }) {
  const db = await getDb();
  const vat = FINANCE_PARAMS.vatRate;
  const projectIds = await marketingProjectIds(f.projectId);
  const { getAdMetrics } = await import("./integrations/googleAds/adMetrics");
  const ads = await getAdMetrics({ from: f.from, to: f.to, projectIds });
  const apiCampaigns = ads.byCampaign.filter((c) => c.source === "api");
  const empty = { range: { from: f.from, to: f.to }, vatRate: vat, rows: [] as any[], conversionActions: [] as any[], linkedTotal: 0, links: [] as any[] };
  if (!db) return empty;
  const links = await listCampaignLinks();
  const utmKeys = links.filter((l) => l.keyType === "utm_campaign").map((l) => norm(l.keyValue));
  const codeKeys = links.filter((l) => l.keyType === "discount_code").map((l) => norm(l.keyValue));
  const inList = (col: any, vals: string[]) => vals.length ? sql` OR LOWER(TRIM(${col})) IN (${sql.join(vals.map((v) => sql`${v}`), sql`, `)})` : sql``;
  const proj = projectIds ? (projectIds.length ? sql` AND b.projectId IN (${sql.join(projectIds.map((id) => sql`${id}`), sql`, `)})` : sql` AND 1 = 0`) : sql``;
  const bookings: BookingForMatch[] = rowsOf<any>(await db.execute(sql`
    SELECT b.id, b.adAttribution, b.adCampaignExternalId AS ext, b.utmCampaign, b.campaign AS code, b.campaignName AS codeName, b.totalPrice
    FROM multipark_bookings b
    WHERE ${notCancelledSql(sql`b.status`)} AND ${inLisbonDaysSql(sql`b.bookingCreatedAt`, f.from, f.to)}
      AND ${projectScope(sql`b.projectId`)}${proj}
      AND (b.adCampaignExternalId IS NOT NULL${inList(sql`b.utmCampaign`, utmKeys)}${inList(sql`b.campaign`, codeKeys)}${inList(sql`b.campaignName`, codeKeys)})`))
    .map((r) => ({ id: Number(r.id), adAttribution: r.adAttribution ?? null, ext: r.ext ?? null, utmCampaign: r.utmCampaign ?? null, code: r.code ?? null, codeName: r.codeName ?? null, totalPrice: Number(r.totalPrice ?? 0) }));
  const matched = matchBookingsToCampaigns(bookings, apiCampaigns.map((c) => ({ key: c.key, provider: c.provider, externalId: c.externalId, campaignId: c.campaignId })), links);

  // Conversões por ação (Google: ação de conversão; Meta: tipo de ação)
  const keySet = new Set(apiCampaigns.map((c) => c.key));
  const actRows = rowsOf<any>(await db.execute(sql`
    SELECT m.provider, m.accountId, m.campaignExternalId, m.actionName, m.category,
           SUM(m.conversions) AS conversions, SUM(m.valueMicros) AS valueMicros
    FROM ad_conversion_action_metrics m
    WHERE m.date >= ${f.from} AND m.date <= ${f.to}
    GROUP BY m.provider, m.accountId, m.campaignExternalId, m.actionName, m.category`));
  const actionsByCampaign = new Map<string, Array<{ actionName: string; category: string | null; conversions: number; value: number }>>();
  const actionTotals = new Map<string, { provider: string; actionName: string; category: string | null; conversions: number; value: number }>();
  for (const r of actRows) {
    const key = `api:${r.accountId}:${r.campaignExternalId}`;
    if (!keySet.has(key)) continue;
    const conv = Number(r.conversions ?? 0), value = Number(r.valueMicros ?? 0) / 1_000_000;
    const list = actionsByCampaign.get(key) ?? [];
    list.push({ actionName: String(r.actionName ?? ""), category: r.category ?? null, conversions: conv, value });
    actionsByCampaign.set(key, list);
    const tk = `${r.provider}|${r.actionName}`;
    const t = actionTotals.get(tk) ?? { provider: String(r.provider), actionName: String(r.actionName ?? ""), category: r.category ?? null, conversions: 0, value: 0 };
    t.conversions += conv; t.value += value; actionTotals.set(tk, t);
  }

  const linksByCampaign = new Map<number, typeof links>();
  for (const l of links) { const a = linksByCampaign.get(l.adCampaignId) ?? []; a.push(l); linksByCampaign.set(l.adCampaignId, a); }
  let linkedTotal = 0;
  const rows = apiCampaigns.map((c) => {
    const bs = matched.get(c.key) ?? [];
    linkedTotal += bs.length;
    const revenue = bs.reduce((t, b) => t + b.totalPrice, 0);
    return {
      key: c.key, campaignId: c.campaignId, name: c.name, provider: c.provider, status: c.status, accountName: c.accountName,
      projectId: c.projectId, national: !!c.national, cost: c.cost, clicks: c.clicks, conversions: c.conversions, conversionValue: c.conversionValue,
      bookings: bs.length, revenue, revenueNet: netOfVatAmount(revenue, vat), roasNet: roasNetOfVat(revenue, c.cost, vat),
      cpa: bs.length > 0 ? c.cost / bs.length : null,
      actions: (actionsByCampaign.get(c.key) ?? []).sort((a, b) => b.conversions - a.conversions),
      links: c.campaignId != null ? (linksByCampaign.get(c.campaignId) ?? []).map((l) => ({ id: l.id, keyType: l.keyType, keyValue: l.keyValue })) : [],
    };
  }).sort((a, b) => b.cost - a.cost);
  return {
    range: { from: f.from, to: f.to }, vatRate: vat, rows, linkedTotal,
    conversionActions: Array.from(actionTotals.values()).sort((a, b) => b.conversions - a.conversions),
  };
}

export async function addCampaignLink(input: { adCampaignId: number; keyType: "utm_campaign" | "discount_code"; keyValue: string; userId: number }) {
  const db = await getDb();
  if (!db) throw new Error("DB indisponível");
  const v = input.keyValue.trim();
  if (!v) throw new Error("Valor vazio");
  await db.execute(sql`
    INSERT INTO ad_campaign_links (adCampaignId, keyType, keyValue, createdById)
    VALUES (${input.adCampaignId}, ${input.keyType}, ${v}, ${input.userId})
    ON DUPLICATE KEY UPDATE adCampaignId = VALUES(adCampaignId)`);
}

export async function removeCampaignLink(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB indisponível");
  await db.execute(sql`DELETE FROM ad_campaign_links WHERE id = ${id}`);
}
