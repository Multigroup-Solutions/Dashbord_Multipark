/**
 * Reserva → campanha pelo CLIQUE (Jorge, 8 out 2026: "as campanhas dão 0
 * reservas ligadas").
 *
 * Com o auto-tagging da Google o link da reserva só traz o `gclid` — sem o ID
 * da campanha (`adCampaignExternalId` fica null) a reserva não se ligava a
 * nada. O Google Ads diz de que campanha é cada clique (click_view, lido de
 * hora a hora para google_ads_clicks — ./clicks.ts). Aqui, EM LOTE (um SELECT
 * … WHERE gclid IN (…) por pedaço, nunca um por reserva):
 *
 *  1. ID da campanha no link → ganha sempre (evidência "link");
 *  2. sem ID no link mas com gclid de um clique conhecido → a campanha desse
 *     clique (evidência "gclid": "gclid → campanha (Google Ads)");
 *  3. gclid sem clique conhecido (mais de 90 dias, conta não recolhida, ainda
 *     por ler) → sem ligação, como antes.
 * gbraid/wbraid não: o click_view só dá o gclid. Os utm_campaign e códigos
 * ligados à mão continuam em matchBookingsToCampaigns (marketingCampaignRoas).
 *
 * Nunca lança: sem a tabela (migração por aplicar) ou com a BD em baixo, as
 * reservas ficam como estavam (só a ligação pelo link).
 */
import { sql } from "drizzle-orm";
import { getDb } from "../../db";
import type { CampaignEvidence } from "../../../shared/campaignEvidence";

export interface ClickCampaign { customerId: string; campaignId: string }

/** O que é preciso de uma reserva para a ligar (MarketingBooking serve). */
export interface LinkableBooking { gclid?: string | null; adCampaignExternalId: string | null }

export type WithCampaignEvidence<T> = T & { campaignEvidence: CampaignEvidence | null };

/** gclids por procurar: só das reservas SEM ID no link; sem repetir. PURA. */
export function gclidsToResolve(bookings: ReadonlyArray<LinkableBooking>): string[] {
  const out = new Set<string>();
  for (const b of bookings) {
    const g = b.gclid?.trim();
    if (!b.adCampaignExternalId && g) out.add(g);
  }
  return [...out];
}

/**
 * Aplica os cliques encontrados. PURA. Não muda os objetos recebidos (a lista
 * das reservas vem de uma cache partilhada): devolve cópias, com a evidência.
 */
export function applyClickCampaigns<T extends LinkableBooking>(bookings: ReadonlyArray<T>, byGclid: ReadonlyMap<string, ClickCampaign>): Array<WithCampaignEvidence<T>> {
  return bookings.map((b) => {
    if (b.adCampaignExternalId) return { ...b, campaignEvidence: "link" as const };
    const hit = b.gclid ? byGclid.get(b.gclid.trim()) : undefined;
    if (hit) return { ...b, adCampaignExternalId: hit.campaignId, campaignEvidence: "gclid" as const };
    return { ...b, campaignEvidence: null };
  });
}

/** Pedaços do IN (…). */
export const GCLID_LOOKUP_CHUNK = 500;

const rowsOf = <T = any>(r: any): T[] => (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r) as T[];

/** gclid → campanha, em lote (um SELECT por pedaço de 500). */
export async function lookupClickCampaigns(gclids: ReadonlyArray<string>, db?: { execute: (q: any) => Promise<unknown> } | null): Promise<Map<string, ClickCampaign>> {
  const out = new Map<string, ClickCampaign>();
  if (!gclids.length) return out;
  const conn = db ?? (await getDb());
  if (!conn) return out;
  for (let i = 0; i < gclids.length; i += GCLID_LOOKUP_CHUNK) {
    const part = gclids.slice(i, i + GCLID_LOOKUP_CHUNK);
    const rows = rowsOf<any>(await conn.execute(sql`
      SELECT gclid, customerId, campaignId FROM google_ads_clicks
      WHERE gclid IN (${sql.join(part.map((g) => sql`${g}`), sql`, `)})`));
    for (const r of rows) out.set(String(r.gclid), { customerId: String(r.customerId), campaignId: String(r.campaignId) });
  }
  return out;
}

/**
 * Reservas com a campanha também pelo clique. Nunca lança: se a procura
 * falhar, as reservas ficam só com a ligação pelo link (e fica um aviso no log).
 */
export async function withClickCampaigns<T extends LinkableBooking>(
  bookings: ReadonlyArray<T>,
  lookup: (gclids: string[]) => Promise<ReadonlyMap<string, ClickCampaign>> = (g) => lookupClickCampaigns(g),
): Promise<Array<WithCampaignEvidence<T>>> {
  const gclids = gclidsToResolve(bookings);
  let byGclid: ReadonlyMap<string, ClickCampaign> = new Map();
  if (gclids.length) {
    try { byGclid = await lookup(gclids); }
    catch (err: any) { console.warn("[marketing] gclid → campanha indisponível:", String(err?.message ?? err).slice(0, 160)); }
  }
  return applyClickCampaigns(bookings, byGclid);
}
