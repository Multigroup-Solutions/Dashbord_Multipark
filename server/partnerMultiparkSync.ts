/**
 * Parcerias a partir da Multipark — leitura ao vivo (parceiros das NOSSAS
 * cidades todas, Pros e avenças) → plano (shared/partnerMultiparkSync.ts) →
 * aplicar na nossa tabela `partnerships`.
 *
 *  - Pré-visualizar não grava nada. Aplicar grava: liga (id da Multipark, tipo,
 *    o que lá está em JSON, estado), cria os que faltam e arquiva os que já não
 *    têm par (menos os que o dono desmarcar). Nunca apaga.
 *  - O dinheiro que a Faturação usa hoje (commissionRate/monthlyFee) NÃO é
 *    reescrito aqui (passa a vir da Multipark no passo da Faturação); só se
 *    preenche a avença quando a nossa está a 0.
 *  - Os agentes de cada parceiro (o utilizador da empresa na Multipark)
 *    ficam ligados à parceria (agent_partner_map), sem cliques.
 *  - Os nomes dos nossos registos ficam (a Faturação ainda os usa para casar
 *    as campanhas); o nome da Multipark fica no JSON e aparece ao lado.
 */
import { sql } from "drizzle-orm";
import { getDb, logActivity } from "./db";
import { feeSummary, ourTypeForPartner, ourTypeForPlan, planPartnerSync, type MpEntity, type OurPartnerRecord, type SyncPlan } from "../shared/partnerMultiparkSync";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const utcNow = () => new Date().toISOString().slice(0, 19).replace("T", " ");

export interface PartnerSyncPreview {
  available: boolean;
  reason?: string;
  plan: SyncPlan;
  /** registo → a nossa comissão/avença de hoje e a da Multipark (para ver antes de aplicar) */
  money: Record<number, { ours: string; mp: string }>;
  counts: { partners: number; pros: number; plans: number; records: number };
}

/** Entidades da Multipark (todas as cidades). */
export async function loadMpEntities(): Promise<{ available: boolean; reason?: string; entities: MpEntity[]; complete: boolean }> {
  const { readPartnershipsLive } = await import("./multiparkDb/partnerships");
  const { readProLive } = await import("./multiparkDb/partnershipsPro");
  const [pr, pro] = await Promise.all([readPartnershipsLive(undefined), readProLive(undefined)]);
  if (!pr.available) return { available: false, reason: pr.reason, entities: [], complete: false };
  const entities: MpEntity[] = [];
  for (const p of pr.data.partners) {
    const parks = p.parks.map((x) => ({ parkName: x.parkName, feeType: x.feeType, feePct: x.feePct, feeFixed: x.feeFixed, active: x.active }));
    entities.push({
      key: p.userId, altKeys: p.parks.map((x) => x.partnerId), kind: "partner", name: p.name,
      partnerType: ourTypeForPartner(p.type), active: p.active,
      snapshot: { mpName: p.name, mpType: p.type, parks, fee: feeSummary(parks) },
    });
  }
  if (pro.available) {
    for (const r of pro.data.rows) {
      // reservas Pro sem conta ProClient/ClientPlan (Pro antigo): não são uma entidade
      if (r.name === "Pro sem registo ProClient" || r.name === "Avença sem registo") continue;
      if (r.kind === "pro") {
        entities.push({ key: `pro:${r.key}`, altKeys: [], kind: "pro", name: r.name, partnerType: "cliente_pro", active: r.active,
          snapshot: { mpName: r.name, mpClientId: r.mpClientId, detail: r.detail, parks: r.parks } });
      } else {
        entities.push({ key: `plan:${r.key}`, altKeys: [], kind: "plan", name: r.name, partnerType: ourTypeForPlan(r.cadence), active: r.active,
          snapshot: { mpName: r.name, mpClientId: r.mpClientId, detail: r.detail, parks: r.parks, price: r.price, cadence: r.cadence } });
      }
    }
  }
  // sem a leitura dos Pro não se arquivam Pros/avenças (ficaria tudo "sem par")
  return { available: true, entities, complete: pro.available };
}

async function loadRecords(): Promise<Array<OurPartnerRecord & { commissionRate: number | null; monthlyFee: number | null }>> {
  const db = await getDb();
  if (!db) throw new Error("BD indisponível.");
  return rowsOf(await db.execute(sql`SELECT id, name, partnerType, multiparkPartnerId, multiparkKind, archivedAt, commissionRate, monthlyFee FROM partnerships`))
    .map((r) => ({
      id: Number(r.id), name: String(r.name ?? ""), partnerType: r.partnerType ?? null, multiparkPartnerId: r.multiparkPartnerId ?? null,
      archivedAt: r.archivedAt ? String(r.archivedAt) : null, multiparkKind: r.multiparkKind ?? null, commissionRate: r.commissionRate == null ? null : Number(r.commissionRate), monthlyFee: r.monthlyFee == null ? null : Number(r.monthlyFee),
    }));
}

/** €/mês da avença a partir do preço e da cadência da Multipark. PURA. */
export function monthlyFromPlan(price: unknown, cadence: unknown): number | null {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return null;
  return Math.round(/year|annual|anual/i.test(String(cadence ?? "")) ? p / 12 : p);
}

function mpMoney(snapshot: Record<string, unknown>, kind: string): string {
  if (kind === "partner") return String(snapshot.fee ?? "—");
  if (kind === "plan") return snapshot.price != null ? `${snapshot.price} € (${snapshot.cadence ?? "?"})` : "sem preço";
  return String(snapshot.detail ?? "—");
}

export async function previewPartnerSync(): Promise<PartnerSyncPreview> {
  const mp = await loadMpEntities();
  const empty: SyncPlan = { links: [], creates: [], ambiguous: [], archives: [] };
  if (!mp.available) return { available: false, reason: mp.reason, plan: empty, money: {}, counts: { partners: 0, pros: 0, plans: 0, records: 0 } };
  const records = await loadRecords();
  const plan = planPartnerSync(mp.entities, records, mp.complete);
  const byId = new Map(records.map((r) => [r.id, r]));
  const money: PartnerSyncPreview["money"] = {};
  for (const l of plan.links) {
    const r = byId.get(l.recordId);
    const ours = l.kind === "plan" ? `${r?.monthlyFee ?? 0} €/mês` : l.kind === "partner" ? `${r?.commissionRate ?? 0} %` : "—";
    money[l.recordId] = { ours, mp: mpMoney(l.snapshot, l.kind) };
  }
  return {
    available: true, plan, money,
    counts: {
      partners: mp.entities.filter((e) => e.kind === "partner").length,
      pros: mp.entities.filter((e) => e.kind === "pro").length,
      plans: mp.entities.filter((e) => e.kind === "plan").length,
      records: records.filter((r) => !r.archivedAt).length,
    },
  };
}

export interface PartnerSyncResult { linked: number; created: number; archived: number; ambiguous: number; agentsLinked: number; available: boolean; reason?: string }

/** Aplica o plano. `keepIds` = registos que o dono não quer arquivar. */
export async function applyPartnerSync(opts: { userId?: number | null; keepIds?: number[] } = {}): Promise<PartnerSyncResult> {
  const db = await getDb();
  if (!db) throw new Error("BD indisponível.");
  const mp = await loadMpEntities();
  if (!mp.available) return { linked: 0, created: 0, archived: 0, ambiguous: 0, agentsLinked: 0, available: false, reason: mp.reason };
  const records = await loadRecords();
  const plan = planPartnerSync(mp.entities, records, mp.complete);
  const now = utcNow();
  const recordOfPartner = new Map<string, number>(); // "Partner".userId → registo

  for (const l of plan.links) {
    // a chave só num registo
    await db.execute(sql`UPDATE partnerships SET multiparkPartnerId = NULL WHERE multiparkPartnerId = ${l.key} AND id <> ${l.recordId}`);
    const fee = l.kind === "plan" ? monthlyFromPlan(l.snapshot.price, l.snapshot.cadence) : null;
    await db.execute(sql`UPDATE partnerships SET
        multiparkPartnerId = ${l.key}, multiparkKind = ${l.kind}, multiparkSnapshot = ${JSON.stringify(l.snapshot)}, multiparkSyncedAt = ${now},
        partnerType = COALESCE(${l.partnerType}, partnerType),
        partnerStatus = ${l.active ? "active" : "inactive"},
        configuredAt = COALESCE(configuredAt, ${now}),
        monthlyFee = IF(COALESCE(monthlyFee, 0) = 0 AND ${fee} IS NOT NULL, ${fee}, monthlyFee)
      WHERE id = ${l.recordId}`);
    if (l.kind === "partner") recordOfPartner.set(l.key, l.recordId);
  }

  const names = new Set(records.map((r) => r.name.trim().toLowerCase()));
  for (const c of plan.creates) {
    const label = c.kind === "pro" ? "Pro" : c.kind === "plan" ? "Avença" : "Multipark";
    let name = c.name.trim().slice(0, 240) || label;
    if (names.has(name.toLowerCase())) name = `${name} (${label})`;
    names.add(name.toLowerCase());
    const fee = c.kind === "plan" ? monthlyFromPlan(c.snapshot.price, c.snapshot.cadence) ?? 0 : 0;
    const res: any = await db.execute(sql`INSERT INTO partnerships
        (name, partnerType, partnerStatus, commissionRate, monthlyFee, multiparkPartnerId, multiparkKind, multiparkSnapshot, multiparkSyncedAt, configuredAt)
      VALUES (${name}, ${c.partnerType}, ${c.active ? "active" : "inactive"}, 0, ${fee}, ${c.key}, ${c.kind}, ${JSON.stringify(c.snapshot)}, ${now}, ${now})`);
    const id = Number((Array.isArray(res) ? res[0] : res)?.insertId ?? 0);
    if (c.kind === "partner" && id) recordOfPartner.set(c.key, id);
  }

  const keep = new Set(opts.keepIds ?? []);
  let archived = 0;
  for (const a of plan.archives) {
    if (keep.has(a.recordId)) {
      // o dono disse que fica: é só nosso, a rotina diária não o volta a propor
      await db.execute(sql`UPDATE partnerships SET multiparkKind = 'own' WHERE id = ${a.recordId}`);
      continue;
    }
    await db.execute(sql`UPDATE partnerships SET archivedAt = ${now}, archivedReason = ${a.reason.slice(0, 250)}, partnerStatus = 'inactive' WHERE id = ${a.recordId} AND archivedAt IS NULL`);
    archived++;
  }

  const agentsLinked = await linkPartnerAgents(recordOfPartner).catch((e) => { console.warn("[parcerias] agentes:", String(e?.message ?? e).slice(0, 160)); return 0; });

  const result = { linked: plan.links.length, created: plan.creates.length, archived, ambiguous: plan.ambiguous.length, agentsLinked, available: true };
  await logActivity({ userId: opts.userId ?? 0, source: opts.userId ? "ui" : "cron", action: "sync", entity: "partnership", details: `Parcerias ← Multipark: ${result.linked} ligadas, ${result.created} criadas, ${result.archived} arquivadas, ${result.ambiguous} à mão, ${result.agentsLinked} agentes` } as any).catch(() => {});
  return result;
}

/**
 * Os agentes de um parceiro são o utilizador da empresa na Multipark
 * ("Partner".userId): ligam-se à parceria pelo nome com que aparecem nas
 * reservas (agent_partner_map). Não mexe nos que já estão ligados.
 */
export async function linkPartnerAgents(recordOfPartner: Map<string, number>): Promise<number> {
  if (!recordOfPartner.size) return 0;
  const { getAgentNamesLive } = await import("./multiparkDb/activityLive");
  const live = await getAgentNamesLive([...recordOfPartner.keys()]);
  if (!live.available) return 0;
  const { listAgentPartners, setAgentPartner } = await import("./db");
  const mapped = new Set((await listAgentPartners()).map((m) => m.agentName.trim().toLowerCase()));
  let n = 0;
  for (const [userId, name] of live.data) {
    const rec = recordOfPartner.get(userId);
    if (!rec || !name || mapped.has(name.trim().toLowerCase())) continue;
    await setAgentPartner(name, rec);
    n++;
  }
  return n;
}
