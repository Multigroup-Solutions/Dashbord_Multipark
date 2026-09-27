/**
 * CRM — juntar e SEPARAR fichas, e as sugestões de fusão.
 *
 * Juntar: tudo o que a ficha absorvida tinha (emails, telefones, carros, ids
 * externos, reservas, ligações) passa para a que fica; os campos vazios da
 * que fica são preenchidos com os da absorvida. Fica um RETRATO (ids movidos,
 * linhas repetidas retiradas, campos preenchidos) em crm_merge_events.
 * Separar repõe esse retrato; o que entrou depois da junção fica na ficha
 * principal. No Odoo, juntar é irreversível; aqui não.
 *
 * Sugestões: pares de fichas ativas que partilham telefone, matrícula, NIF ou
 * email (regras e pontos em shared/crmIdentity.ts). Recusadas não voltam.
 */
import { sql } from "drizzle-orm";
import { scoreSuggestion, type SuggestionSide } from "../../shared/crmIdentity";
import { recomputeMetrics } from "./sync";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const inList = (vals: (string | number)[]) => sql.join(vals.map((v) => sql`${v}`), sql`, `);
const chunks = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/** Valor para voltar a gravar: datas (Date ou ISO do JSON) no formato do MySQL. PURO. */
export function toSqlValue(v: unknown): unknown {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 19).replace("T", " ");
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v)) return v.slice(0, 19).replace("T", " ");
  return v;
}

/** Campos da ficha que a absorvida pode preencher na que fica. */
export const FILLABLE_FIELDS = [
  "displayName", "firstName", "lastName", "photoUrl", "primaryEmail", "primaryPhone", "nif", "taxName", "taxAddress",
  "address", "zone", "gender", "ageBand", "birthDate", "language", "ibanEnc", "originPartnerId", "originPartnerName", "originChannel", "notes",
] as const;

export interface MergeSnapshot {
  moved: { emails: number[]; phones: number[]; vehicles: number[]; externalIds: number[]; links: number[]; relations: number[] };
  /** linhas da absorvida retiradas por já existirem na que fica (repostas ao separar) */
  dropped: { emails: any[]; phones: any[]; vehicles: any[]; relations: any[] };
  /** campos da que fica preenchidos com os da absorvida */
  filled: Record<string, unknown>;
  mergedStatus: string;
}

/** Campos a preencher: os vazios na que fica e cheios na absorvida. PURO. */
export function fieldsToFill(survivor: Record<string, unknown>, merged: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of FILLABLE_FIELDS) {
    const s = survivor[f], m = merged[f];
    const empty = (x: unknown) => x == null || (typeof x === "string" && x.trim() === "");
    if (empty(s) && !empty(m)) out[f] = m;
  }
  return out;
}

export async function mergeClients(db: any, o: { survivorId: number; mergedId: number; userId: number; reason?: string | null }): Promise<{ eventId: number }> {
  if (o.survivorId === o.mergedId) throw new Error("Não se junta uma ficha consigo própria.");
  let eventId = 0;
  await db.transaction(async (tx: any) => {
    // trinco nas duas por ordem de id (a separação tranca da mesma forma: sem ciclos)
    const both = rowsOf(await tx.execute(sql`SELECT * FROM crm_clients WHERE id IN (${o.survivorId}, ${o.mergedId}) ORDER BY id FOR UPDATE`));
    const s = both.find((r) => Number(r.id) === o.survivorId);
    const m = both.find((r) => Number(r.id) === o.mergedId);
    if (!s || !m) throw new Error("Ficha não encontrada.");
    if (s.status !== "active" || m.status !== "active") throw new Error("Só se juntam fichas ativas.");
    const snap: MergeSnapshot = { moved: { emails: [], phones: [], vehicles: [], externalIds: [], links: [], relations: [] }, dropped: { emails: [], phones: [], vehicles: [], relations: [] }, filled: {}, mergedStatus: String(m.status) };

    // emails / telefones / carros: os que a que fica já tem são retirados (e guardados), os outros mudam
    const moveUnique = async (table: string, key: string, bucket: "emails" | "phones" | "vehicles") => {
      const t = sql.raw(table), k = sql.raw(key);
      const have = new Set(rowsOf(await tx.execute(sql`SELECT ${k} AS v FROM ${t} WHERE clientId = ${o.survivorId}`)).map((r) => String(r.v)));
      const mine = rowsOf(await tx.execute(sql`SELECT * FROM ${t} WHERE clientId = ${o.mergedId}`));
      const dup = mine.filter((r) => have.has(String(r[key])));
      const move = mine.filter((r) => !have.has(String(r[key])));
      if (dup.length) {
        snap.dropped[bucket] = dup.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toSqlValue(v)])));
        await tx.execute(sql`DELETE FROM ${t} WHERE id IN (${inList(dup.map((r) => Number(r.id)))})`);
      }
      if (move.length) {
        snap.moved[bucket] = move.map((r) => Number(r.id));
        // o principal continua a ser o da ficha que fica
        const primary = bucket === "vehicles" ? sql`` : sql`, isPrimary = 0`;
        await tx.execute(sql`UPDATE ${t} SET clientId = ${o.survivorId}${primary} WHERE id IN (${inList(snap.moved[bucket])})`);
      }
    };
    await moveUnique("crm_client_emails", "email", "emails");
    await moveUnique("crm_client_phones", "phone", "phones");
    await moveUnique("crm_client_vehicles", "plate", "vehicles");

    const ext = rowsOf(await tx.execute(sql`SELECT id FROM crm_client_external_ids WHERE clientId = ${o.mergedId}`)).map((r) => Number(r.id));
    if (ext.length) { snap.moved.externalIds = ext; await tx.execute(sql`UPDATE crm_client_external_ids SET clientId = ${o.survivorId} WHERE id IN (${inList(ext)})`); }
    const links = rowsOf(await tx.execute(sql`SELECT id FROM crm_booking_links WHERE clientId = ${o.mergedId}`)).map((r) => Number(r.id));
    if (links.length) { snap.moved.links = links; for (const part of chunks(links, 800)) await tx.execute(sql`UPDATE crm_booking_links SET clientId = ${o.survivorId} WHERE id IN (${inList(part)})`); }

    // ligações (pessoa ↔ empresa, família): a relação entre as duas desaparece; as outras mudam
    const rels = rowsOf(await tx.execute(sql`SELECT * FROM crm_client_relations WHERE clientId = ${o.mergedId} OR relatedClientId = ${o.mergedId}`));
    for (const r of rels) {
      const newClient = Number(r.clientId) === o.mergedId ? o.survivorId : Number(r.clientId);
      const newRelated = Number(r.relatedClientId) === o.mergedId ? o.survivorId : Number(r.relatedClientId);
      const clash = newClient === newRelated || rowsOf(await tx.execute(sql`SELECT id FROM crm_client_relations
        WHERE kind = ${r.kind} AND clientId = ${newClient} AND relatedClientId = ${newRelated} AND id <> ${Number(r.id)}`)).length > 0;
      if (clash) {
        snap.dropped.relations.push(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toSqlValue(v)])));
        await tx.execute(sql`DELETE FROM crm_client_relations WHERE id = ${Number(r.id)}`);
      } else {
        snap.moved.relations.push(Number(r.id));
        await tx.execute(sql`UPDATE crm_client_relations SET
          clientId = IF(clientId = ${o.mergedId}, ${o.survivorId}, clientId),
          relatedClientId = IF(relatedClientId = ${o.mergedId}, ${o.survivorId}, relatedClientId)
          WHERE id = ${Number(r.id)}`);
      }
    }

    // campos vazios da que fica ← absorvida
    const fill = Object.fromEntries(Object.entries(fieldsToFill(s, m)).map(([k, v]) => [k, toSqlValue(v)]));
    snap.filled = fill;
    const sets = Object.entries(fill).map(([k, v]) => sql`${sql.raw("`" + k + "`")} = ${v as any}`);
    if (sets.length) await tx.execute(sql`UPDATE crm_clients SET ${sql.join(sets, sql`, `)} WHERE id = ${o.survivorId}`);
    await tx.execute(sql`UPDATE crm_clients SET isPro = IF(proManual = 1, isPro, GREATEST(isPro, ${Number(m.isPro) ? 1 : 0})) WHERE id = ${o.survivorId}`);
    // o que foi retirado à mão da absorvida também não volta à que fica
    await tx.execute(sql`INSERT IGNORE INTO crm_blocked_identifiers (clientId, kind, value, blockedBy, createdAt)
      SELECT ${o.survivorId}, kind, value, blockedBy, createdAt FROM crm_blocked_identifiers WHERE clientId = ${o.mergedId}`);
    await tx.execute(sql`UPDATE crm_clients SET status = 'merged', mergedInto = ${o.survivorId} WHERE id = ${o.mergedId}`);

    const [a, b] = o.survivorId < o.mergedId ? [o.survivorId, o.mergedId] : [o.mergedId, o.survivorId];
    await tx.execute(sql`UPDATE crm_merge_suggestions SET status = 'accepted', decidedBy = ${o.userId}, decidedAt = UTC_TIMESTAMP() WHERE clientA = ${a} AND clientB = ${b}`);
    await tx.execute(sql`UPDATE crm_merge_suggestions SET status = 'obsolete' WHERE status = 'pending' AND (clientA = ${o.mergedId} OR clientB = ${o.mergedId})`);
    const ins: any = await tx.execute(sql`INSERT INTO crm_merge_events (survivorId, mergedId, snapshotJson, reason, mergedBy, mergedAt)
      VALUES (${o.survivorId}, ${o.mergedId}, ${JSON.stringify(snap)}, ${o.reason ?? null}, ${o.userId}, UTC_TIMESTAMP())`);
    eventId = Number((Array.isArray(ins) ? ins[0] : ins)?.insertId ?? 0);
  });
  await recomputeMetrics(db, [o.survivorId]);
  return { eventId };
}

export async function splitMerge(db: any, o: { eventId: number; userId: number }): Promise<{ survivorId: number; mergedId: number }> {
  let out = { survivorId: 0, mergedId: 0 };
  await db.transaction(async (tx: any) => {
    const [ev] = rowsOf(await tx.execute(sql`SELECT * FROM crm_merge_events WHERE id = ${o.eventId} FOR UPDATE`));
    if (!ev) throw new Error("Fusão não encontrada.");
    if (ev.undoneAt) throw new Error("Esta fusão já foi separada.");
    const s = Number(ev.survivorId), m = Number(ev.mergedId);
    // trinco nas duas fichas (a carga, ao arrumar sobras de fusões, tranca a absorvida)
    const locked = rowsOf(await tx.execute(sql`SELECT id, status, mergedInto FROM crm_clients WHERE id IN (${s}, ${m}) ORDER BY id FOR UPDATE`));
    const sRow = locked.find((r) => Number(r.id) === s), mRow = locked.find((r) => Number(r.id) === m);
    // fusões em cadeia (M→S e depois S→T): as linhas já estão noutra ficha — separar primeiro a mais recente
    if (!sRow || sRow.status !== "active") throw new Error("A ficha que ficou foi entretanto junta a outra: separe primeiro essa junção (a mais recente).");
    if (!mRow || mRow.status !== "merged" || Number(mRow.mergedInto) !== s) throw new Error("A ficha absorvida já não está junta a esta.");
    const snap = JSON.parse(String(ev.snapshotJson)) as MergeSnapshot;
    const back = async (table: string, ids: number[]) => {
      for (const part of chunks(ids, 800)) await tx.execute(sql`UPDATE ${sql.raw(table)} SET clientId = ${m} WHERE clientId = ${s} AND id IN (${inList(part)})`);
    };
    await back("crm_client_emails", snap.moved.emails);
    await back("crm_client_phones", snap.moved.phones);
    await back("crm_client_vehicles", snap.moved.vehicles);
    await back("crm_client_external_ids", snap.moved.externalIds);
    await back("crm_booking_links", snap.moved.links);
    for (const id of snap.moved.relations) {
      await tx.execute(sql`UPDATE crm_client_relations SET
        clientId = IF(clientId = ${s}, ${m}, clientId), relatedClientId = IF(relatedClientId = ${s}, ${m}, relatedClientId)
        WHERE id = ${id}`);
    }
    // linhas retiradas voltam tal e qual estavam (id e valores originais; emails,
    // telefones e carros já tinham clientId = absorvida; ligações ficam com os dois lados originais)
    const reinsert = async (table: string, rows: any[]) => {
      for (const r of rows) {
        const cols = Object.keys(r);
        await tx.execute(sql`INSERT IGNORE INTO ${sql.raw(table)} (${sql.raw(cols.map((c) => "`" + c + "`").join(", "))})
          VALUES (${sql.join(cols.map((c) => sql`${toSqlValue(r[c]) as any}`), sql`, `)})`);
      }
    };
    await reinsert("crm_client_emails", snap.dropped.emails);
    await reinsert("crm_client_phones", snap.dropped.phones);
    await reinsert("crm_client_vehicles", snap.dropped.vehicles);
    await reinsert("crm_client_relations", snap.dropped.relations);
    // campos preenchidos na que fica: só se ainda estiverem como a junção os deixou
    for (const [k, v] of Object.entries(snap.filled ?? {})) {
      await tx.execute(sql`UPDATE crm_clients SET ${sql.raw("`" + k + "`")} = NULL WHERE id = ${s} AND ${sql.raw("`" + k + "`")} <=> ${v as any}`);
    }
    await tx.execute(sql`UPDATE crm_clients SET status = 'active', mergedInto = NULL WHERE id = ${m}`);
    await tx.execute(sql`UPDATE crm_merge_events SET undoneAt = UTC_TIMESTAMP(), undoneBy = ${o.userId} WHERE id = ${o.eventId}`);
    const [a, b] = s < m ? [s, m] : [m, s];
    await tx.execute(sql`UPDATE crm_merge_suggestions SET status = 'dismissed', decidedBy = ${o.userId}, decidedAt = UTC_TIMESTAMP() WHERE clientA = ${a} AND clientB = ${b}`);
    out = { survivorId: s, mergedId: m };
  });
  await recomputeMetrics(db, [out.survivorId, out.mergedId]);
  return out;
}

// ─── Sugestões ──────────────────────────────────────────────────────────────

/** Um identificador partilhado por mais fichas do que isto é de empresa/balcão: não sugere. */
export const MAX_SHARED = 6;

export async function refreshSuggestions(db: any, o: { deadlineAt: number }): Promise<{ pairs: number; saved: number; obsolete: number; ms: number }> {
  const t0 = Date.now();
  const pairs = new Set<string>();
  const addGroup = (ids: string) => {
    const list = [...new Set(String(ids).split(",").map(Number).filter(Boolean))].sort((x, y) => x - y);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) pairs.add(`${list[i]}|${list[j]}`);
  };
  const groups = async (q: any) => rowsOf(await db.execute(q)).forEach((r) => addGroup(r.ids));
  await groups(sql`SELECT GROUP_CONCAT(DISTINCT p.clientId) AS ids FROM crm_client_phones p JOIN crm_clients c ON c.id = p.clientId AND c.status = 'active'
    GROUP BY p.phone HAVING COUNT(DISTINCT p.clientId) BETWEEN 2 AND ${MAX_SHARED}`);
  await groups(sql`SELECT GROUP_CONCAT(DISTINCT v.clientId) AS ids FROM crm_client_vehicles v JOIN crm_clients c ON c.id = v.clientId AND c.status = 'active'
    GROUP BY v.plate HAVING COUNT(DISTINCT v.clientId) BETWEEN 2 AND ${MAX_SHARED}`);
  await groups(sql`SELECT GROUP_CONCAT(DISTINCT e.clientId) AS ids FROM crm_client_emails e JOIN crm_clients c ON c.id = e.clientId AND c.status = 'active'
    WHERE e.generic = 0 GROUP BY e.email HAVING COUNT(DISTINCT e.clientId) BETWEEN 2 AND ${MAX_SHARED}`);
  await groups(sql`SELECT GROUP_CONCAT(DISTINCT id) AS ids FROM crm_clients WHERE status = 'active' AND nif IS NOT NULL AND nif <> ''
    GROUP BY nif HAVING COUNT(*) BETWEEN 2 AND ${MAX_SHARED}`);

  const allPairs = [...pairs].map((p) => p.split("|").map(Number) as [number, number]);
  let saved = 0;
  for (const part of chunks(allPairs, 400)) {
    if (Date.now() > o.deadlineAt - 8_000) break;
    const ids = [...new Set(part.flat())];
    const sides = await loadSides(db, ids);
    const related = new Set(rowsOf(await db.execute(sql`SELECT clientId, relatedClientId FROM crm_client_relations
      WHERE clientId IN (${inList(ids)}) OR relatedClientId IN (${inList(ids)})`)).map((r) => {
      const [x, y] = [Number(r.clientId), Number(r.relatedClientId)].sort((p, q) => p - q);
      return `${x}|${y}`;
    }));
    const values: any[] = [];
    for (const [a, b] of part) {
      if (related.has(`${a}|${b}`)) continue;
      const sa = sides.get(a), sb = sides.get(b);
      if (!sa || !sb) continue;
      const r = scoreSuggestion(sa, sb);
      if (!r) continue;
      values.push(sql`(${a}, ${b}, ${r.score}, ${r.reasons.join(",")})`);
    }
    if (values.length) {
      await db.execute(sql`INSERT INTO crm_merge_suggestions (clientA, clientB, score, reasons) VALUES ${sql.join(values, sql`, `)}
        ON DUPLICATE KEY UPDATE score = VALUES(score), reasons = VALUES(reasons)`);
      saved += values.length;
    }
  }
  const obs: any = await db.execute(sql`UPDATE crm_merge_suggestions s
    LEFT JOIN crm_clients a ON a.id = s.clientA LEFT JOIN crm_clients b ON b.id = s.clientB
    SET s.status = 'obsolete'
    WHERE s.status = 'pending' AND (a.status IS NULL OR a.status <> 'active' OR b.status IS NULL OR b.status <> 'active')`);
  const obsolete = Number((Array.isArray(obs) ? obs[0] : obs)?.affectedRows ?? 0);
  return { pairs: allPairs.length, saved, obsolete, ms: Date.now() - t0 };
}

export async function loadSides(db: any, ids: number[]): Promise<Map<number, SuggestionSide>> {
  const out = new Map<number, SuggestionSide>();
  if (!ids.length) return out;
  for (const part of chunks(ids, 800)) {
    for (const c of rowsOf(await db.execute(sql`SELECT id, displayName, nif FROM crm_clients WHERE id IN (${inList(part)})`))) {
      out.set(Number(c.id), { id: Number(c.id), name: c.displayName ?? null, emails: [], phones: [], plates: [], nif: c.nif || null });
    }
    for (const e of rowsOf(await db.execute(sql`SELECT clientId, email FROM crm_client_emails WHERE generic = 0 AND clientId IN (${inList(part)})`))) out.get(Number(e.clientId))?.emails.push(String(e.email));
    for (const p of rowsOf(await db.execute(sql`SELECT clientId, phone FROM crm_client_phones WHERE clientId IN (${inList(part)})`))) out.get(Number(p.clientId))?.phones.push(String(p.phone));
    for (const v of rowsOf(await db.execute(sql`SELECT clientId, plate FROM crm_client_vehicles WHERE clientId IN (${inList(part)})`))) out.get(Number(v.clientId))?.plates.push(String(v.plate));
  }
  return out;
}

