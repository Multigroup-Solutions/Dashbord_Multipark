/**
 * Parcerias por cidade (29 set 2026): que parcerias têm reservas em que
 * centros de custos, calculado AO VIVO da BD da Multipark e guardado no resumo
 * `partner_city_presence` (migração 0260). O âmbito de cidade das Parcerias
 * (cityScope.partnerScope) lê este resumo — já não a cópia `multipark_bookings`.
 *
 * Regra igual à de antes: a campanha da reserva (server/finance/liveBookings.ts
 * campaignOf — aliases do parceiro da Multipark e do método de pagamento, senão
 * o nome do parceiro, o código de desconto ou a campanha) bate com o nome, a
 * chave de campanha ou um alias da parceria (índice do Financeiro).
 * Janela: entradas dos últimos 24 meses. Refresco pelo cron (de 6 em 6 h).
 */
import { sql } from "drizzle-orm";
import type { PartnerPresenceRow } from "./multiparkDb/partnerPresence";

export const PRESENCE_WINDOW_DAYS = 730;
export const PRESENCE_MAX_AGE_MS = 6 * 60 * 60_000;

export interface PresenceEntry { partnershipId: number; projectId: number; bookings: number; lastCheckIn: string | null }

/** Linhas ao vivo → parceria × centro. PURA. */
export function computePartnerPresence(
  rows: readonly PartnerPresenceRow[],
  ctx: { ourParks: Map<string, number | null>; aliases: Map<string, string> },
  partnerFor: (campaign: string) => number | undefined,
  campaignOf: (r: PartnerPresenceRow, aliases: Map<string, string>) => string | null,
): PresenceEntry[] {
  const acc = new Map<string, PresenceEntry>();
  for (const r of rows) {
    const projectId = ctx.ourParks.get(r.parkId);
    if (projectId == null) continue;
    const campaign = campaignOf(r, ctx.aliases);
    if (!campaign) continue;
    const partnershipId = partnerFor(campaign);
    if (!partnershipId) continue;
    const k = `${partnershipId}:${projectId}`;
    const e = acc.get(k) ?? { partnershipId, projectId, bookings: 0, lastCheckIn: null };
    e.bookings += r.count;
    if (r.lastCheckIn && (!e.lastCheckIn || r.lastCheckIn > e.lastCheckIn)) e.lastCheckIn = r.lastCheckIn;
    acc.set(k, e);
  }
  return [...acc.values()].sort((a, b) => a.partnershipId - b.partnershipId || a.projectId - b.projectId);
}

/** Recalcula o resumo (substitui-o todo). Lança se a BD da Multipark falhar — o resumo anterior fica. */
export async function refreshPartnerCityPresence(nowMs = Date.now()): Promise<{ rows: number; entries: number }> {
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) throw new Error("BD indisponível");
  const [{ loadLiveContext, campaignOf }, { readPartnerPresence }, { loadPartnerIndex, partnerForCampaign }] = await Promise.all([
    import("./finance/liveBookings"), import("./multiparkDb/partnerPresence"), import("./finance/partners"),
  ]);
  const ctx = await loadLiveContext();
  const since = new Date(nowMs - PRESENCE_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  const rows = await readPartnerPresence({ parkIds: [...ctx.ourParks.keys()], since });
  const { index } = await loadPartnerIndex(db);
  const entries = computePartnerPresence(rows, ctx, (c) => partnerForCampaign(index, c)?.id, (r, a) => campaignOf(r, a));
  await db.transaction(async (tx: any) => {
    await tx.execute(sql`DELETE FROM partner_city_presence`);
    for (let i = 0; i < entries.length; i += 500) {
      const chunk = entries.slice(i, i + 500);
      await tx.execute(sql`INSERT INTO partner_city_presence (partnershipId, projectId, bookings, lastCheckIn) VALUES ${sql.join(
        chunk.map((e) => sql`(${e.partnershipId}, ${e.projectId}, ${e.bookings}, ${e.lastCheckIn})`), sql`, `)}`);
    }
  });
  return { rows: rows.length, entries: entries.length };
}

/** Refresca se o resumo estiver vazio ou com mais de `maxAgeMs`. */
export async function maybeRefreshPartnerCityPresence(maxAgeMs = PRESENCE_MAX_AGE_MS): Promise<{ refreshed: boolean; rows?: number; entries?: number }> {
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) return { refreshed: false };
  const res: any = await db.execute(sql`SELECT UNIX_TIMESTAMP(MAX(refreshedAt)) AS at FROM partner_city_presence`);
  const at = Number((Array.isArray(res) ? res[0] : res?.rows ?? res)?.[0]?.at ?? 0) * 1000;
  if (at && Date.now() - at < maxAgeMs) return { refreshed: false };
  return { refreshed: true, ...(await refreshPartnerCityPresence()) };
}
