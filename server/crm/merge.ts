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
 * email (regras e pontos em shared/crmIdentity.ts). Recusadas não voltam — e
 * a recusa acompanha as fichas quando uma delas é junta a outra (21c).
 *
 * Juntar sozinho (21c): as regras do dono (identityVerdict) e, nas dúvidas,
 * a IA (AI_CRM_IDENTITY, desligada por omissão) — o resto fica em Rever fichas.
 */
import { sql } from "drizzle-orm";
import { identityVerdict, scoreSuggestion, type IdentitySide, type IdentityVerdict } from "../../shared/crmIdentity";
import { recomputeMetrics } from "./sync";

/**
 * Resumo das fichas depois de juntar/separar — lê a Multipark ao vivo. A
 * junção/separação já ficou gravada: se a Multipark não responder, o resumo
 * fica para o próximo crm-sync e não se devolve erro a quem juntou.
 */
async function refreshSummary(db: any, ids: number[]): Promise<void> {
  try { await recomputeMetrics(db, ids); }
  catch (err: any) {
    console.warn("[crm] resumo das fichas fica para o próximo crm-sync:", String(err?.message ?? err).slice(0, 160));
    // metricsAt = NULL: o crm-sync recalcula-as na próxima corrida
    await db.execute(sql`UPDATE crm_clients SET metricsAt = NULL WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`).catch(() => {});
  }
}

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
  moved: {
    emails: number[]; phones: number[]; vehicles: number[]; externalIds: number[]; links: number[]; relations: number[];
    /** 21b: retirados da absorvida (histórico dela) e contas Pro que apontavam para ela */
    removed?: number[]; proAccounts?: number[];
  };
  /** linhas da absorvida retiradas por já existirem na que fica (repostas ao separar) */
  dropped: { emails: any[]; phones: any[]; vehicles: any[]; relations: any[] };
  /** campos da que fica preenchidos com os da absorvida */
  filled: Record<string, unknown>;
  mergedStatus: string;
  /** 21b: bloqueios copiados da absorvida para a que fica (saem ao separar) */
  copiedBlocks?: { kind: string; value: string }[];
  /** 21b: como estava a que fica (Pro, notas, etiquetas) e como ficou — separar repõe se ninguém mexeu */
  survivorBefore?: { isPro: number; notes: string | null; tagsJson: string | null };
  survivorAfter?: { isPro: number; notes: string | null; tagsJson: string | null };
  /** 21c: recusas ("não é a mesma pessoa") da absorvida copiadas para a que fica — ao separar voltam ao que eram */
  copiedRefusals?: { id: number; prev: string | null }[];
}

/** Quem juntou: uma pessoa, as regras do dono ou a IA (crm_merge_events.source). */
export type MergeSource = "ui" | "auto" | "ai";

/** Notas das duas fichas juntas, sem perder as da absorvida (21b). PURO. */
export function mergeNotes(survivor: string | null | undefined, merged: string | null | undefined, mergedId: number): string | null {
  const a = String(survivor ?? "").trim(), b = String(merged ?? "").trim();
  if (!b) return a || null;
  if (!a) return b;
  if (a.includes(b)) return a;
  return `${a}\n\n— Da ficha N.º ${mergedId} —\n${b}`.slice(0, 10_000);
}

/** Etiquetas das duas fichas (sem repetir). PURO. */
export function mergeTags(survivor: string | null | undefined, merged: string | null | undefined): string | null {
  const parse = (x: string | null | undefined): string[] => { try { const v = JSON.parse(String(x ?? "[]")); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
  const all = [...new Set([...parse(survivor), ...parse(merged)].map((t) => t.trim()).filter(Boolean))].slice(0, 40);
  return all.length ? JSON.stringify(all) : (survivor ?? null);
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

export async function mergeClients(db: any, o: {
  survivorId: number; mergedId: number; userId: number; reason?: string | null;
  /** 21c: a sugestão que se aceita (tem de continuar pendente — outra pessoa pode tê-la recusado entretanto) */
  suggestionId?: number | null;
  source?: MergeSource;
}): Promise<{ eventId: number }> {
  if (o.survivorId === o.mergedId) throw new Error("Não se junta uma ficha consigo própria.");
  let eventId = 0;
  await db.transaction(async (tx: any) => {
    // trinco nas duas por ordem de id (a separação tranca da mesma forma: sem ciclos)
    const both = rowsOf(await tx.execute(sql`SELECT * FROM crm_clients WHERE id IN (${o.survivorId}, ${o.mergedId}) ORDER BY id FOR UPDATE`));
    const s = both.find((r) => Number(r.id) === o.survivorId);
    const m = both.find((r) => Number(r.id) === o.mergedId);
    if (!s || !m) throw new Error("Ficha não encontrada.");
    if (s.status !== "active" || m.status !== "active") throw new Error("Só se juntam fichas ativas.");
    const [pa, pb] = o.survivorId < o.mergedId ? [o.survivorId, o.mergedId] : [o.mergedId, o.survivorId];
    if (o.suggestionId) {
      const [sg] = rowsOf(await tx.execute(sql`SELECT clientA, clientB, status FROM crm_merge_suggestions WHERE id = ${o.suggestionId} FOR UPDATE`));
      if (!sg || Number(sg.clientA) !== pa || Number(sg.clientB) !== pb) throw new Error("Sugestão não encontrada.");
      if (sg.status !== "pending") throw new Error(sg.status === "dismissed" ? "Esta sugestão foi recusada entretanto (\"não é a mesma pessoa\")." : "Esta sugestão já foi decidida.");
    }
    const snap: MergeSnapshot = {
      moved: { emails: [], phones: [], vehicles: [], externalIds: [], links: [], relations: [], removed: [], proAccounts: [] },
      dropped: { emails: [], phones: [], vehicles: [], relations: [] }, filled: {}, mergedStatus: String(m.status), copiedBlocks: [],
      survivorBefore: { isPro: Number(s.isPro ?? 0), notes: s.notes ?? null, tagsJson: s.tagsJson ?? null },
    };
    // o que foi retirado à mão da ficha que fica não volta por causa da junção (21b)
    const survivorBlocks = rowsOf(await tx.execute(sql`SELECT kind, value FROM crm_blocked_identifiers WHERE clientId = ${o.survivorId}`));
    const blockedIn = (kind: string) => new Set(survivorBlocks.filter((b) => b.kind === kind).map((b) => String(b.value)));

    // emails / telefones / carros: os que a que fica já tem (ou tirou à mão) são retirados (e guardados), os outros mudam
    const moveUnique = async (table: string, key: string, bucket: "emails" | "phones" | "vehicles") => {
      const t = sql.raw(table), k = sql.raw(key);
      const have = new Set(rowsOf(await tx.execute(sql`SELECT ${k} AS v FROM ${t} WHERE clientId = ${o.survivorId}`)).map((r) => String(r.v)));
      for (const v of blockedIn(bucket === "emails" ? "email" : bucket === "phones" ? "phone" : "plate")) have.add(v);
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
    // 21b: o histórico dos retirados e as contas Pro da absorvida passam para a que fica (e voltam ao separar)
    const removed = rowsOf(await tx.execute(sql`SELECT id FROM crm_removed_items WHERE clientId = ${o.mergedId}`)).map((r) => Number(r.id));
    if (removed.length) { snap.moved.removed = removed; await tx.execute(sql`UPDATE crm_removed_items SET clientId = ${o.survivorId} WHERE id IN (${inList(removed)})`); }
    const pro = rowsOf(await tx.execute(sql`SELECT id FROM crm_pro_accounts WHERE crmClientId = ${o.mergedId}`)).map((r) => Number(r.id));
    if (pro.length) { snap.moved.proAccounts = pro; await tx.execute(sql`UPDATE crm_pro_accounts SET crmClientId = ${o.survivorId} WHERE id IN (${inList(pro)})`); }

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

    // campos vazios da que fica ← absorvida (as notas e as etiquetas juntam-se: nada se perde)
    const fill = Object.fromEntries(Object.entries(fieldsToFill(s, m)).filter(([k]) => k !== "notes").map(([k, v]) => [k, toSqlValue(v)]));
    snap.filled = fill;
    const sets = Object.entries(fill).map(([k, v]) => sql`${sql.raw("`" + k + "`")} = ${v as any}`);
    const notes = mergeNotes(s.notes, m.notes, o.mergedId);
    const tags = mergeTags(s.tagsJson, m.tagsJson);
    sets.push(sql`notes = ${notes}`, sql`tagsJson = ${tags}`);
    await tx.execute(sql`UPDATE crm_clients SET ${sql.join(sets, sql`, `)} WHERE id = ${o.survivorId}`);
    await tx.execute(sql`UPDATE crm_clients SET isPro = IF(proManual = 1, isPro, GREATEST(isPro, ${Number(m.isPro) ? 1 : 0})) WHERE id = ${o.survivorId}`);
    const [after] = rowsOf(await tx.execute(sql`SELECT isPro, notes, tagsJson FROM crm_clients WHERE id = ${o.survivorId}`));
    snap.survivorAfter = { isPro: Number(after?.isPro ?? 0), notes: after?.notes ?? null, tagsJson: after?.tagsJson ?? null };
    // o que foi retirado à mão da absorvida também não volta à que fica (e ao separar, sai daqui)
    const have = new Set(survivorBlocks.map((b) => `${b.kind}|${b.value}`));
    snap.copiedBlocks = rowsOf(await tx.execute(sql`SELECT kind, value FROM crm_blocked_identifiers WHERE clientId = ${o.mergedId}`))
      .map((b) => ({ kind: String(b.kind), value: String(b.value) }))
      .filter((b) => !have.has(`${b.kind}|${b.value}`));
    await tx.execute(sql`INSERT IGNORE INTO crm_blocked_identifiers (clientId, kind, value, blockedBy, createdAt)
      SELECT ${o.survivorId}, kind, value, blockedBy, createdAt FROM crm_blocked_identifiers WHERE clientId = ${o.mergedId}`);
    // 21c: "não é a mesma pessoa" acompanha a ficha — X recusada com a absorvida fica recusada com a que fica
    // (senão a junção seguinte, sozinha, juntava X a quem alguém disse que não é ela)
    snap.copiedRefusals = await copyRefusals(tx, o.mergedId, o.survivorId);
    await tx.execute(sql`UPDATE crm_clients SET status = 'merged', mergedInto = ${o.survivorId} WHERE id = ${o.mergedId}`);

    await tx.execute(sql`UPDATE crm_merge_suggestions SET status = 'accepted', decidedBy = ${o.userId}, decidedAt = UTC_TIMESTAMP() WHERE clientA = ${pa} AND clientB = ${pb}`);
    await tx.execute(sql`UPDATE crm_merge_suggestions SET status = 'obsolete' WHERE status = 'pending' AND (clientA = ${o.mergedId} OR clientB = ${o.mergedId})`);
    const ins: any = await tx.execute(sql`INSERT INTO crm_merge_events (survivorId, mergedId, snapshotJson, reason, mergedBy, mergedAt, source)
      VALUES (${o.survivorId}, ${o.mergedId}, ${JSON.stringify(snap)}, ${o.reason ?? null}, ${o.userId}, UTC_TIMESTAMP(), ${o.source ?? "ui"})`);
    eventId = Number((Array.isArray(ins) ? ins[0] : ins)?.insertId ?? 0);
  });
  await refreshSummary(db, [o.survivorId]);
  return { eventId };
}

/**
 * Copia as recusas da absorvida para a que fica (21c). Devolve o que mudou
 * (id da sugestão + estado anterior; null = linha nova) para separar repor.
 */
async function copyRefusals(tx: any, mergedId: number, survivorId: number): Promise<{ id: number; prev: string | null }[]> {
  const out: { id: number; prev: string | null }[] = [];
  const refused = rowsOf(await tx.execute(sql`SELECT clientA, clientB, score, reasons, decidedBy, DATE_FORMAT(decidedAt, '%Y-%m-%d %H:%i:%s') AS decidedAt
    FROM crm_merge_suggestions WHERE status = 'dismissed' AND (clientA = ${mergedId} OR clientB = ${mergedId})`));
  for (const r of refused) {
    const other = Number(r.clientA) === mergedId ? Number(r.clientB) : Number(r.clientA);
    if (other === survivorId) continue;
    const [x, y] = survivorId < other ? [survivorId, other] : [other, survivorId];
    const [cur] = rowsOf(await tx.execute(sql`SELECT id, status FROM crm_merge_suggestions WHERE clientA = ${x} AND clientB = ${y} FOR UPDATE`));
    if (cur?.status === "dismissed") continue;
    if (cur) {
      await tx.execute(sql`UPDATE crm_merge_suggestions SET status = 'dismissed', decidedBy = ${r.decidedBy ?? null}, decidedAt = ${r.decidedAt ?? null} WHERE id = ${Number(cur.id)}`);
      out.push({ id: Number(cur.id), prev: String(cur.status) });
    } else {
      const ins: any = await tx.execute(sql`INSERT INTO crm_merge_suggestions (clientA, clientB, score, reasons, status, decidedBy, decidedAt)
        VALUES (${x}, ${y}, ${Number(r.score ?? 0)}, ${String(r.reasons ?? "")}, 'dismissed', ${r.decidedBy ?? null}, ${r.decidedAt ?? null})`);
      out.push({ id: Number((Array.isArray(ins) ? ins[0] : ins)?.insertId ?? 0), prev: null });
    }
  }
  return out.filter((x) => x.id > 0);
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
    await back("crm_removed_items", snap.moved.removed ?? []);
    // 21b: as contas Pro voltam à ficha de onde vieram — as que a junção mudou e as que o
    // crm-pro-sync entretanto ligou à que ficou mas cujo cliente da Multipark é da absorvida
    for (const part of chunks(snap.moved.proAccounts ?? [], 800)) {
      await tx.execute(sql`UPDATE crm_pro_accounts SET crmClientId = ${m} WHERE crmClientId = ${s} AND id IN (${inList(part)})`);
    }
    await tx.execute(sql`UPDATE crm_pro_accounts pa JOIN crm_client_external_ids x ON x.\`system\` = 'multipark_client' AND x.externalId = pa.mpClientId
      SET pa.crmClientId = ${m} WHERE x.clientId = ${m} AND pa.crmClientId = ${s}`);
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
    // 21b: Pro, notas e etiquetas da que fica voltam ao que eram — se ninguém mexeu depois da junção
    if (snap.survivorBefore && snap.survivorAfter) {
      const b = snap.survivorBefore, a = snap.survivorAfter;
      await tx.execute(sql`UPDATE crm_clients SET isPro = ${b.isPro} WHERE id = ${s} AND proManual = 0 AND isPro = ${a.isPro}`);
      await tx.execute(sql`UPDATE crm_clients SET notes = ${b.notes} WHERE id = ${s} AND notes <=> ${a.notes}`);
      await tx.execute(sql`UPDATE crm_clients SET tagsJson = ${b.tagsJson} WHERE id = ${s} AND tagsJson <=> ${a.tagsJson}`);
    }
    // bloqueios que vieram da absorvida saem da que fica (continuam na absorvida)
    for (const blk of snap.copiedBlocks ?? []) {
      await tx.execute(sql`DELETE FROM crm_blocked_identifiers WHERE clientId = ${s} AND kind = ${blk.kind} AND value = ${blk.value}`);
    }
    await tx.execute(sql`UPDATE crm_clients SET status = 'active', mergedInto = NULL WHERE id = ${m}`);
    await tx.execute(sql`UPDATE crm_merge_events SET undoneAt = UTC_TIMESTAMP(), undoneBy = ${o.userId} WHERE id = ${o.eventId}`);
    // 21c: as recusas copiadas da absorvida saem da que fica (voltam ao que eram; a absorvida mantém as suas)
    for (const c of snap.copiedRefusals ?? []) {
      await tx.execute(sql`UPDATE crm_merge_suggestions SET status = ${c.prev ?? "obsolete"} WHERE id = ${c.id} AND status = 'dismissed'`);
    }
    // separar = "não é a mesma pessoa": a recusa fica gravada mesmo sem sugestão (junção feita na ficha)
    const [a, b] = s < m ? [s, m] : [m, s];
    await tx.execute(sql`INSERT INTO crm_merge_suggestions (clientA, clientB, score, reasons, status, decidedBy, decidedAt)
      VALUES (${a}, ${b}, 0, '', 'dismissed', ${o.userId}, UTC_TIMESTAMP())
      ON DUPLICATE KEY UPDATE status = 'dismissed', decidedBy = VALUES(decidedBy), decidedAt = VALUES(decidedAt)`);
    // As outras sugestões da ficha que volta (postas de lado pela junção) voltam a
    // pendentes — se a outra ficha ainda estiver ativa. As decididas à mão ficam.
    await tx.execute(sql`${restoreSuggestionsSql(m)}`);
    out = { survivorId: s, mergedId: m };
  });
  await refreshSummary(db, [out.survivorId, out.mergedId]);
  return out;
}

// ─── Sugestões ──────────────────────────────────────────────────────────────

/**
 * Sugestões "obsoletas" de uma ficha que voltou a estar ativa (separação) →
 * pendentes, quando a outra ficha também está ativa. Só mexe nas obsoletas:
 * aceites e rejeitadas à mão ficam como estão.
 */
export function restoreSuggestionsSql(clientId: number) {
  return sql`UPDATE crm_merge_suggestions s
    JOIN crm_clients a ON a.id = s.clientA JOIN crm_clients b ON b.id = s.clientB
    SET s.status = 'pending'
    WHERE s.status = 'obsolete' AND (s.clientA = ${clientId} OR s.clientB = ${clientId})
      AND a.status = 'active' AND b.status = 'active'`;
}

/** Um identificador partilhado por mais fichas do que isto é de empresa/balcão: não sugere. */
export const MAX_SHARED = 6;

/** Contagens "tipo|valor" → fichas ativas com esse email/telefone/matrícula. */
type SharedCounts = Map<string, number>;
/** `fallback`: em quantas fichas está um valor comum que não veio nas contagens (nas sugestões: só se contam 2–6 → mais de 6). */
const fichasWithFrom = (counts: SharedCounts, fallback = 2) => (kind: "email" | "phone" | "plate", value: string) => counts.get(`${kind}|${value}`) ?? fallback;

/**
 * Sugestões da madrugada. Cada par fica com a pontuação, o veredicto das
 * regras do dono e os avisos (21c). Numa corrida COMPLETA, as pendentes que
 * deixaram de aparecer (já não partilham nada, ou alguém retirou o dado
 * comum) ficam obsoletas; se voltarem a aparecer, voltam a pendentes.
 */
export async function refreshSuggestions(db: any, o: { deadlineAt: number }): Promise<{ pairs: number; saved: number; obsolete: number; stale: number; complete: boolean; ms: number }> {
  const t0 = Date.now();
  const [{ t: runStart } = { t: null }] = rowsOf(await db.execute(sql`SELECT DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i:%s') AS t`));
  const pairs = new Set<string>();
  const counts: SharedCounts = new Map();
  const addGroup = (kind: string | null, r: any) => {
    if (kind && r.v != null) counts.set(`${kind}|${r.v}`, Number(r.n ?? 2));
    const list = [...new Set(String(r.ids).split(",").map(Number).filter(Boolean))].sort((x, y) => x - y);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) pairs.add(`${list[i]}|${list[j]}`);
  };
  const groups = async (kind: string | null, q: any) => rowsOf(await db.execute(q)).forEach((r) => addGroup(kind, r));
  await groups("phone", sql`SELECT p.phone AS v, COUNT(DISTINCT p.clientId) AS n, GROUP_CONCAT(DISTINCT p.clientId) AS ids FROM crm_client_phones p JOIN crm_clients c ON c.id = p.clientId AND c.status = 'active'
    GROUP BY p.phone HAVING COUNT(DISTINCT p.clientId) BETWEEN 2 AND ${MAX_SHARED}`);
  await groups("plate", sql`SELECT v.plate AS v, COUNT(DISTINCT v.clientId) AS n, GROUP_CONCAT(DISTINCT v.clientId) AS ids FROM crm_client_vehicles v JOIN crm_clients c ON c.id = v.clientId AND c.status = 'active'
    GROUP BY v.plate HAVING COUNT(DISTINCT v.clientId) BETWEEN 2 AND ${MAX_SHARED}`);
  await groups("email", sql`SELECT e.email AS v, COUNT(DISTINCT e.clientId) AS n, GROUP_CONCAT(DISTINCT e.clientId) AS ids FROM crm_client_emails e JOIN crm_clients c ON c.id = e.clientId AND c.status = 'active'
    WHERE e.generic = 0 GROUP BY e.email HAVING COUNT(DISTINCT e.clientId) BETWEEN 2 AND ${MAX_SHARED}`);
  await groups(null, sql`SELECT GROUP_CONCAT(DISTINCT id) AS ids FROM crm_clients WHERE status = 'active' AND nif IS NOT NULL AND nif <> ''
    GROUP BY nif HAVING COUNT(*) BETWEEN 2 AND ${MAX_SHARED}`);
  // um valor que as duas têm em comum e não está nos grupos de 2–6 fichas está em mais de 6
  const fichasWith = fichasWithFrom(counts, MAX_SHARED + 1);

  const allPairs = [...pairs].map((p) => p.split("|").map(Number) as [number, number]);
  let saved = 0;
  let complete = true;
  for (const part of chunks(allPairs, 400)) {
    if (Date.now() > o.deadlineAt - 8_000) { complete = false; break; }
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
      const v = identityVerdict(sa, sb, fichasWith);
      values.push(sql`(${a}, ${b}, ${r.score}, ${r.reasons.join(",")}, ${v.verdict}, ${v.signals.join(",").slice(0, 255)}, UTC_TIMESTAMP())`);
    }
    if (values.length) {
      // o parecer da IA só vale para os mesmos motivos e avisos: se mudaram, volta a perguntar-se
      await db.execute(sql`INSERT INTO crm_merge_suggestions (clientA, clientB, score, reasons, verdict, signals, seenAt) VALUES ${sql.join(values, sql`, `)}
        ON DUPLICATE KEY UPDATE
          aiAt = IF(reasons <=> VALUES(reasons) AND signals <=> VALUES(signals), aiAt, NULL),
          aiVerdict = IF(aiAt IS NULL, NULL, aiVerdict), aiConfidence = IF(aiAt IS NULL, NULL, aiConfidence), aiReason = IF(aiAt IS NULL, NULL, aiReason),
          score = VALUES(score), reasons = VALUES(reasons), verdict = VALUES(verdict), signals = VALUES(signals), seenAt = VALUES(seenAt),
          status = IF(status = 'obsolete', 'pending', status)`);
      saved += values.length;
    }
  }
  const obs: any = await db.execute(sql`UPDATE crm_merge_suggestions s
    LEFT JOIN crm_clients a ON a.id = s.clientA LEFT JOIN crm_clients b ON b.id = s.clientB
    SET s.status = 'obsolete'
    WHERE s.status = 'pending' AND (a.status IS NULL OR a.status <> 'active' OR b.status IS NULL OR b.status <> 'active')`);
  const obsolete = Number((Array.isArray(obs) ? obs[0] : obs)?.affectedRows ?? 0);
  // só com a corrida completa se sabe que uma pendente "desapareceu" (parar no prazo não a torna obsoleta)
  let stale = 0;
  if (complete && runStart) {
    const st: any = await db.execute(sql`UPDATE crm_merge_suggestions SET status = 'obsolete' WHERE status = 'pending' AND (seenAt IS NULL OR seenAt < ${runStart})`);
    stale = Number((Array.isArray(st) ? st[0] : st)?.affectedRows ?? 0);
  }
  return { pairs: allPairs.length, saved, obsolete, stale, complete, ms: Date.now() - t0 };
}

export type LoadedSide = IdentitySide & { bookings: number };

export async function loadSides(db: any, ids: number[]): Promise<Map<number, LoadedSide>> {
  const out = new Map<number, LoadedSide>();
  if (!ids.length) return out;
  for (const part of chunks(ids, 800)) {
    for (const c of rowsOf(await db.execute(sql`SELECT id, displayName, nif, kind, isPro, bookings FROM crm_clients WHERE id IN (${inList(part)})`))) {
      out.set(Number(c.id), {
        id: Number(c.id), name: c.displayName ?? null, emails: [], phones: [], plates: [], nif: c.nif || null,
        kind: c.kind ?? null, isPro: Number(c.isPro ?? 0) === 1, bookings: Number(c.bookings ?? 0),
      });
    }
    for (const e of rowsOf(await db.execute(sql`SELECT clientId, email FROM crm_client_emails WHERE generic = 0 AND clientId IN (${inList(part)})`))) out.get(Number(e.clientId))?.emails.push(String(e.email));
    for (const p of rowsOf(await db.execute(sql`SELECT clientId, phone FROM crm_client_phones WHERE clientId IN (${inList(part)})`))) out.get(Number(p.clientId))?.phones.push(String(p.phone));
    for (const v of rowsOf(await db.execute(sql`SELECT clientId, plate FROM crm_client_vehicles WHERE clientId IN (${inList(part)})`))) out.get(Number(v.clientId))?.plates.push(String(v.plate));
  }
  return out;
}

/** Em quantas fichas ATIVAS está cada email/telefone/matrícula que os pares têm em comum. */
async function loadSharedCounts(db: any, pairs: [IdentitySide, IdentitySide][]): Promise<SharedCounts> {
  const vals = { email: new Set<string>(), phone: new Set<string>(), plate: new Set<string>() };
  for (const [a, b] of pairs) {
    a.emails.filter((v) => b.emails.includes(v)).forEach((v) => vals.email.add(v));
    a.phones.filter((v) => b.phones.includes(v)).forEach((v) => vals.phone.add(v));
    a.plates.filter((v) => b.plates.includes(v)).forEach((v) => vals.plate.add(v));
  }
  const out: SharedCounts = new Map();
  const q = {
    email: (l: any) => sql`SELECT x.email AS v, COUNT(DISTINCT x.clientId) AS n FROM crm_client_emails x JOIN crm_clients c ON c.id = x.clientId AND c.status = 'active' WHERE x.email IN (${l}) GROUP BY x.email`,
    phone: (l: any) => sql`SELECT x.phone AS v, COUNT(DISTINCT x.clientId) AS n FROM crm_client_phones x JOIN crm_clients c ON c.id = x.clientId AND c.status = 'active' WHERE x.phone IN (${l}) GROUP BY x.phone`,
    plate: (l: any) => sql`SELECT x.plate AS v, COUNT(DISTINCT x.clientId) AS n FROM crm_client_vehicles x JOIN crm_clients c ON c.id = x.clientId AND c.status = 'active' WHERE x.plate IN (${l}) GROUP BY x.plate`,
  };
  for (const kind of ["email", "phone", "plate"] as const) {
    for (const part of chunks([...vals[kind]], 500)) {
      for (const r of rowsOf(await db.execute(q[kind](inList(part))))) out.set(`${kind}|${r.v}`, Number(r.n));
    }
  }
  return out;
}

/** A IA só junta sozinha com esta certeza (0–100); abaixo, o parecer fica à vista em Rever fichas. */
export const AI_MERGE_MIN_CONFIDENCE = 85;
/** Teto de pares que vão à IA por corrida (custo) e por pedido. */
export const AI_PAIRS_PER_RUN = 60;
const AI_PAIRS_PER_CALL = 15;

export interface AutoMergeResult {
  checked: number; merged: number; mergedByAi: number; aiChecked: number; skipped: number; errors: number;
  stoppedAtDeadline: boolean; aiError?: string;
}

/**
 * Junta sozinho (21c): primeiro as regras do dono (shared/crmIdentity.ts
 * identityVerdict — mesmo nome + email/telefone/matrícula; nome diferente só
 * com email E telefone; nunca empresas, Pro, NIF pessoais diferentes, dados em
 * mais de 2 fichas); depois as DÚVIDAS vão à IA (AI_CRM_IDENTITY, desligada
 * por omissão), que só junta com certeza ≥ 85 %. O resto fica em Rever fichas.
 * Fica a ficha com mais reservas. Cada junção fica em "Juntas recentemente"
 * (origem "auto" ou "ai") e no registo de cada ficha, e separa-se lá.
 * Corre até ao prazo; o que sobrar fica para a próxima corrida.
 */
export async function autoMergeConfident(db: any, o: { deadlineAt: number; userId: number; limit?: number; useAi?: boolean }): Promise<AutoMergeResult> {
  const rows = rowsOf(await db.execute(sql`SELECT s.id, s.clientA, s.clientB, s.aiAt FROM crm_merge_suggestions s
    JOIN crm_clients a ON a.id = s.clientA AND a.status = 'active'
    JOIN crm_clients b ON b.id = s.clientB AND b.status = 'active'
    WHERE s.status = 'pending'
    ORDER BY s.score DESC, s.id LIMIT ${Math.max(1, Math.min(5000, o.limit ?? 2000))}`));
  const out: AutoMergeResult = { checked: rows.length, merged: 0, mergedByAi: 0, aiChecked: 0, skipped: 0, errors: 0, stoppedAtDeadline: false };
  if (!rows.length) return out;
  const ids = [...new Set(rows.flatMap((r) => [Number(r.clientA), Number(r.clientB)]))];
  const sides = await loadSides(db, ids);
  const pairOf = (r: any) => [sides.get(Number(r.clientA)), sides.get(Number(r.clientB))] as const;
  const counts = await loadSharedCounts(db, rows.map(pairOf).filter((p): p is [LoadedSide, LoadedSide] => !!p[0] && !!p[1]));
  const fichasWith = fichasWithFrom(counts);
  const { IDENTITY_RULE_LABELS } = await import("../../shared/crmIdentity");

  const gone = new Set<number>();
  const doubts: { id: number; a: LoadedSide; b: LoadedSide; v: IdentityVerdict }[] = [];
  const doMerge = async (sid: number, a: LoadedSide, b: LoadedSide, source: MergeSource, reason: string): Promise<boolean> => {
    const [keep, drop] = a.bookings >= b.bookings ? [a, b] : [b, a];
    try {
      const r = await mergeClients(db, { survivorId: keep.id, mergedId: drop.id, userId: o.userId, reason: reason.slice(0, 255), suggestionId: sid, source });
      gone.add(drop.id);
      await logAutoMerge(o.userId, keep.id, drop.id, r.eventId, reason, source);
      return true;
    } catch {
      out.errors++;
      return false;
    }
  };

  for (const r of rows) {
    if (Date.now() > o.deadlineAt - 3_000) { out.stoppedAtDeadline = true; break; }
    const a = Number(r.clientA), b = Number(r.clientB);
    const [sa, sb] = pairOf(r);
    if (gone.has(a) || gone.has(b) || !sa || !sb) { out.skipped++; continue; }
    const v = identityVerdict(sa, sb, fichasWith);
    if (v.verdict === "same" && v.rule) {
      if (await doMerge(Number(r.id), sa, sb, "auto", `automático: ${IDENTITY_RULE_LABELS[v.rule]}`)) out.merged++;
      continue;
    }
    out.skipped++;
    if (v.verdict === "doubt" && !r.aiAt) doubts.push({ id: Number(r.id), a: sa, b: sb, v });
  }

  // ── dúvidas → IA (só factos e o 1.º nome; nunca contactos) ──
  if (o.useAi === false || !doubts.length || out.stoppedAtDeadline) return out;
  const { aiFeatureAvailableFresh } = await import("../_core/ai/status");
  if (!(await aiFeatureAvailableFresh("crm_identity"))) return out;
  const { runAi } = await import("../_core/ai/run");
  const { aiErrorCode } = await import("../_core/ai/errors");
  const { CRM_IDENTITY_SYSTEM, crmIdentityInput, crmIdentitySchema } = await import("../_core/ai/prompts/crmIdentity");
  const { identityFactsForAi } = await import("../../shared/crmIdentity");
  for (const part of chunks(doubts.slice(0, AI_PAIRS_PER_RUN), AI_PAIRS_PER_CALL)) {
    if (Date.now() > o.deadlineAt - 25_000) { out.stoppedAtDeadline = true; break; }
    const live = part.filter((d) => !gone.has(d.a.id) && !gone.has(d.b.id));
    if (!live.length) continue;
    let results: { id: number; verdict: "same" | "different" | "unsure"; confidence: number; reason: string }[];
    try {
      const r = await runAi({
        feature: "crm_identity",
        system: CRM_IDENTITY_SYSTEM,
        input: crmIdentityInput(live.map((d) => {
          const f = identityFactsForAi(d.a, d.b, fichasWith);
          return { id: d.id, a: { ...f.a, bookings: d.a.bookings }, b: { ...f.b, bookings: d.b.bookings }, facts: f.facts };
        })),
        schema: crmIdentitySchema,
        maxTokens: 1200,
        timeoutMs: 20_000,
        userId: o.userId || null,
        entity: "crm_merge_suggestion",
        entityId: live[0].id,
      });
      results = r.output.results ?? [];
    } catch (err) {
      out.aiError = aiErrorCode(err);
      if (["disabled", "not_configured", "budget"].includes(out.aiError)) break;
      continue;
    }
    const byId = new Map(live.map((d) => [d.id, d]));
    for (const res of results) {
      const d = byId.get(Number(res.id));
      if (!d) continue; // a IA não inventa pares
      byId.delete(d.id);
      const raw = Number(res.confidence);
      const conf = Math.round(Math.max(0, Math.min(100, raw > 0 && raw <= 1 ? raw * 100 : raw)));
      const verdict = res.verdict === "same" || res.verdict === "different" ? res.verdict : "unsure";
      const reason = String(res.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      out.aiChecked++;
      await db.execute(sql`UPDATE crm_merge_suggestions SET aiVerdict = ${verdict === "different" ? "diff" : verdict}, aiConfidence = ${conf}, aiReason = ${reason || null}, aiAt = UTC_TIMESTAMP()
        WHERE id = ${d.id} AND status = 'pending'`);
      if (verdict === "same" && conf >= AI_MERGE_MIN_CONFIDENCE && !gone.has(d.a.id) && !gone.has(d.b.id)) {
        if (await doMerge(d.id, d.a, d.b, "ai", `IA (${conf} %): ${reason || "a mesma pessoa"}`)) { out.mergedByAi++; out.skipped--; }
      }
    }
  }
  return out;
}

/** Registo em CADA ficha (21c): quem/o quê juntou, mesmo quando foi a madrugada (userId 0, origem cron). */
async function logAutoMerge(userId: number, survivorId: number, mergedId: number, eventId: number, reason: string, source: MergeSource) {
  try {
    const { logCrm } = await import("./edit");
    const src = userId > 0 ? "ui" : "cron";
    await logCrm(userId, survivorId, "crm_merge", { mergedId, eventId, reason, by: source }, src);
    await logCrm(userId, mergedId, "crm_merged_into", { survivorId, eventId, reason, by: source }, src);
  } catch (e: any) {
    console.warn("[crm] registo da junção automática falhou:", String(e?.message ?? e).slice(0, 120));
  }
}
