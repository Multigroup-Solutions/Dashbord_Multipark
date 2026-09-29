/**
 * JUNTAR registos das Parcerias (o mesmo parceiro separado em vários — ex.:
 * "Pro Cabopol" e "Blocotelha", mesma agência, mesmo email). Fica UM registo;
 * tudo o que liga reservas aos outros passa para ele:
 *   - os aliases (id do parceiro na Multipark, método de pagamento);
 *   - o id da Multipark (se o que fica não tiver; senão entra como alias);
 *   - os agentes ligados à parceria (agent_partner_map);
 *   - o nome e a chave de campanha dos que saem (via mergedIntoId — o índice
 *     das finanças passa a mandá-los para o que fica).
 * Os que saem ficam ARQUIVADOS ("Junto a #N"), nunca apagados; o que se mudou
 * fica em mergeJson e "Separar" desfaz.
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";

type Db = { execute: (q: any) => Promise<any> };
const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const utcNow = () => new Date().toISOString().slice(0, 19).replace("T", " ");

interface Rec {
  id: number; name: string; partnerType: string | null; multiparkPartnerId: string | null; campaignKey: string | null;
  contactName: string | null; contactEmail: string | null; contactPhone: string | null; partnerNif: string | null;
  billingAgreement: string | null; archivedAt: string | null; mergedIntoId: number | null; mergeJson: string | null;
}

async function loadRecs(d: Db, ids: number[]): Promise<Map<number, Rec>> {
  if (!ids.length) return new Map();
  const rows = rowsOf(await d.execute(sql`SELECT id, name, partnerType, multiparkPartnerId, campaignKey, contactName, contactEmail, contactPhone,
      partner_nif AS partnerNif, billingAgreement, archivedAt, mergedIntoId, mergeJson
    FROM partnerships WHERE id IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})`));
  return new Map(rows.map((r) => [Number(r.id), {
    id: Number(r.id), name: String(r.name ?? ""), partnerType: r.partnerType ?? null, multiparkPartnerId: r.multiparkPartnerId ?? null,
    campaignKey: r.campaignKey ?? null, contactName: r.contactName ?? null, contactEmail: r.contactEmail ?? null, contactPhone: r.contactPhone ?? null,
    partnerNif: r.partnerNif ?? null, billingAgreement: r.billingAgreement ?? null, archivedAt: r.archivedAt ? String(r.archivedAt) : null,
    mergedIntoId: r.mergedIntoId == null ? null : Number(r.mergedIntoId), mergeJson: r.mergeJson ?? null,
  }]));
}

export interface MergePreview {
  keep: { id: number; name: string; multiparkPartnerId: string | null };
  drops: Array<{ id: number; name: string; partnerType: string | null; multiparkPartnerId: string | null; aliases: number; agents: number; email: string | null }>;
  warnings: string[];
}

export async function previewPartnershipMerge(keepId: number, dropIds: number[]): Promise<MergePreview> {
  const d = await getDb();
  if (!d) throw new Error("BD indisponível.");
  const drops = [...new Set(dropIds.filter((x) => x !== keepId))];
  if (!drops.length) throw new Error("Escolhe pelo menos um registo para juntar ao que fica.");
  const recs = await loadRecs(d as any, [keepId, ...drops]);
  const keep = recs.get(keepId);
  if (!keep) throw new Error("O registo que fica não existe.");
  if (keep.mergedIntoId) throw new Error("O registo que fica já está junto a outro: escolhe esse.");
  const warnings: string[] = [];
  const out: MergePreview["drops"] = [];
  const mpIds = new Set<string>(keep.multiparkPartnerId ? [keep.multiparkPartnerId] : []);
  for (const id of drops) {
    const r = recs.get(id);
    if (!r) throw new Error(`Registo #${id} não existe.`);
    if (r.mergedIntoId) throw new Error(`"${r.name}" já está junto a outro registo.`);
    const aliases = Number(rowsOf(await (d as any).execute(sql`SELECT COUNT(*) AS n FROM partner_aliases WHERE partnershipId = ${id}`))[0]?.n ?? 0);
    const agents = Number(rowsOf(await (d as any).execute(sql`SELECT COUNT(*) AS n FROM agent_partner_map WHERE partnershipId = ${id}`).catch(() => [[{ n: 0 }]]))[0]?.n ?? 0);
    if (r.multiparkPartnerId) mpIds.add(r.multiparkPartnerId);
    out.push({ id, name: r.name, partnerType: r.partnerType, multiparkPartnerId: r.multiparkPartnerId, aliases, agents, email: r.contactEmail });
  }
  if (mpIds.size > 1) warnings.push("Há mais do que um parceiro da Multipark nestes registos: fica o do registo que fica; os outros passam a alias (as reservas deles vêm para aqui).");
  const types = new Set([keep.partnerType, ...out.map((x) => x.partnerType)].filter(Boolean));
  if (types.size > 1) warnings.push(`Tipos diferentes (${[...types].join(", ")}): fica o tipo do registo que fica.`);
  return { keep: { id: keep.id, name: keep.name, multiparkPartnerId: keep.multiparkPartnerId }, drops: out, warnings };
}

export async function mergePartnerships(o: { keepId: number; dropIds: number[]; userId: number }): Promise<MergePreview> {
  const p = await previewPartnershipMerge(o.keepId, o.dropIds);
  const d = (await getDb()) as unknown as Db;
  const recs = await loadRecs(d, [o.keepId, ...p.drops.map((x) => x.id)]);
  const keep = recs.get(o.keepId)!;
  let keepMp = keep.multiparkPartnerId;
  const now = utcNow();
  for (const dr of p.drops) {
    const r = recs.get(dr.id)!;
    const log: { aliasIds: number[]; agentNames: string[]; mpMovedToKeep: string | null; mpAliasId: number | null } = { aliasIds: [], agentNames: [], mpMovedToKeep: null, mpAliasId: null };
    // aliases → o que fica
    log.aliasIds = rowsOf(await d.execute(sql`SELECT id FROM partner_aliases WHERE partnershipId = ${dr.id}`)).map((x) => Number(x.id));
    await d.execute(sql`UPDATE partner_aliases SET partnershipId = ${o.keepId} WHERE partnershipId = ${dr.id}`);
    // agentes → o que fica
    log.agentNames = rowsOf(await d.execute(sql`SELECT agentName FROM agent_partner_map WHERE partnershipId = ${dr.id}`).catch(() => [[]])).map((x) => String(x.agentName));
    await d.execute(sql`UPDATE agent_partner_map SET partnershipId = ${o.keepId} WHERE partnershipId = ${dr.id}`).catch(() => {});
    // id da Multipark
    if (r.multiparkPartnerId) {
      await d.execute(sql`UPDATE partnerships SET multiparkPartnerId = NULL WHERE id = ${dr.id}`);
      if (!keepMp) {
        await d.execute(sql`UPDATE partnerships SET multiparkPartnerId = ${r.multiparkPartnerId}, multiparkKind = COALESCE(multiparkKind, (SELECT k FROM (SELECT multiparkKind AS k FROM partnerships WHERE id = ${dr.id}) x)) WHERE id = ${o.keepId}`);
        keepMp = r.multiparkPartnerId; log.mpMovedToKeep = r.multiparkPartnerId;
      } else {
        const res: any = await d.execute(sql`INSERT IGNORE INTO partner_aliases (partnershipId, aliasType, aliasValue) VALUES (${o.keepId}, 'multipark_partner_id', ${r.multiparkPartnerId})`);
        const id = Number((Array.isArray(res) ? res[0] : res)?.insertId ?? 0);
        log.mpAliasId = id || null;
      }
    }
    // campos vazios do que fica ← do que sai
    await d.execute(sql`UPDATE partnerships SET
        contactName = COALESCE(NULLIF(contactName, ''), ${r.contactName}),
        contactEmail = COALESCE(NULLIF(contactEmail, ''), ${r.contactEmail}),
        contactPhone = COALESCE(NULLIF(contactPhone, ''), ${r.contactPhone}),
        partner_nif = COALESCE(NULLIF(partner_nif, ''), ${r.partnerNif}),
        billingAgreement = COALESCE(NULLIF(billingAgreement, ''), ${r.billingAgreement})
      WHERE id = ${o.keepId}`);
    // o que sai: arquivado e junto (nunca apagado)
    await d.execute(sql`UPDATE partnerships SET archivedAt = COALESCE(archivedAt, ${now}), archivedReason = ${`Junto a #${o.keepId} (${keep.name})`.slice(0, 250)},
        partnerStatus = 'inactive', mergedIntoId = ${o.keepId}, mergeJson = ${JSON.stringify(log)} WHERE id = ${dr.id}`);
  }
  await d.execute(sql`UPDATE partnerships SET updatedAt = ${now} WHERE id = ${o.keepId}`);
  await resetCaches();
  return p;
}

/** Desfaz uma junção: o registo volta como estava (os aliases e agentes dele voltam). */
export async function unmergePartnership(dropId: number): Promise<{ keepId: number }> {
  const d = (await getDb()) as unknown as Db;
  if (!d) throw new Error("BD indisponível.");
  const r = (await loadRecs(d, [dropId])).get(dropId);
  if (!r || !r.mergedIntoId) throw new Error("Este registo não está junto a nenhum.");
  const keepId = r.mergedIntoId;
  let log: { aliasIds?: number[]; agentNames?: string[]; mpMovedToKeep?: string | null; mpAliasId?: number | null } = {};
  try { log = r.mergeJson ? JSON.parse(r.mergeJson) : {}; } catch { log = {}; }
  if (log.aliasIds?.length) await d.execute(sql`UPDATE partner_aliases SET partnershipId = ${dropId} WHERE id IN (${sql.join(log.aliasIds.map((x) => sql`${x}`), sql`, `)})`);
  if (log.agentNames?.length) await d.execute(sql`UPDATE agent_partner_map SET partnershipId = ${dropId} WHERE partnershipId = ${keepId} AND agentName IN (${sql.join(log.agentNames.map((x) => sql`${x}`), sql`, `)})`).catch(() => {});
  if (log.mpMovedToKeep) {
    await d.execute(sql`UPDATE partnerships SET multiparkPartnerId = NULL WHERE id = ${keepId} AND multiparkPartnerId = ${log.mpMovedToKeep}`);
    await d.execute(sql`UPDATE partnerships SET multiparkPartnerId = ${log.mpMovedToKeep} WHERE id = ${dropId}`);
  }
  if (log.mpAliasId) {
    // o alias foi criado pela junção: volta a ser o id do registo (sai do que ficou)
    const [a] = rowsOf(await d.execute(sql`SELECT aliasValue FROM partner_aliases WHERE id = ${log.mpAliasId}`));
    if (a?.aliasValue) {
      await d.execute(sql`UPDATE partner_aliases SET partnershipId = ${dropId} WHERE id = ${log.mpAliasId}`);
      await d.execute(sql`UPDATE partnerships SET multiparkPartnerId = ${String(a.aliasValue)} WHERE id = ${dropId}`);
    }
  }
  await d.execute(sql`UPDATE partnerships SET archivedAt = NULL, archivedReason = NULL, partnerStatus = 'active', mergedIntoId = NULL, mergeJson = NULL WHERE id = ${dropId}`);
  await resetCaches();
  return { keepId };
}

/** O registo está junto a outro? */
export async function isMergedPartnership(id: number): Promise<boolean> {
  const d = (await getDb()) as unknown as Db;
  if (!d) return false;
  return !!rowsOf(await d.execute(sql`SELECT mergedIntoId FROM partnerships WHERE id = ${id}`))[0]?.mergedIntoId;
}

async function resetCaches(): Promise<void> {
  try { (await import("./finance/liveBookings")).resetLiveContextCache(); } catch { /* sem cache */ }
  try { (await import("./db")).resetPartnerMapCache(); } catch { /* sem cache */ }
}
