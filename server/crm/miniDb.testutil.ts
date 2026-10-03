/**
 * BD falsa (em memória) para os testes do CRM que mexem em várias tabelas
 * (juntar/separar, retirar/repor). Percebe só as instruções que esses
 * caminhos usam — uma instrução desconhecida rebenta o teste (melhor do que
 * passar sem a ter executado).
 */
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";

type Row = Record<string, any>;
const dialect = new MySqlDialect();

export class MiniDb {
  tables = new Map<string, Row[]>();
  seq = new Map<string, number>();
  log: string[] = [];

  t(name: string): Row[] {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name)!;
  }
  insert(name: string, row: Row): Row {
    const id = row.id ?? (this.seq.get(name) ?? 100) + 1;
    this.seq.set(name, Math.max(id, this.seq.get(name) ?? 100));
    const r = { ...row, id };
    this.t(name).push(r);
    return r;
  }
  rows(name: string, where: (r: Row) => boolean = () => true): Row[] {
    return this.t(name).filter(where);
  }

  async transaction<T>(fn: (tx: MiniDb) => Promise<T>): Promise<T> {
    const snapshot = new Map([...this.tables].map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
    try { return await fn(this); } catch (e) { this.tables = snapshot; throw e; }
  }

  async execute(q: SQL): Promise<[any]> {
    const { sql: raw, params } = dialect.sqlToQuery(q);
    const text = raw.replace(/\s+/g, " ").trim();
    this.log.push(text);
    const p = [...params];
    for (const [re, fn] of HANDLERS) {
      const m = text.match(re);
      if (m) return [fn(this, m, p)];
    }
    throw new Error(`MiniDb: instrução não suportada: ${text}`);
  }
}

const ids = (s: string, p: any[], from = 0) => { const n = (s.match(/\?/g) ?? []).length; return p.slice(from, from + n).map(Number); };
const cut = (p: any[], n: number) => p.splice(0, n);
const isNull = (v: any) => v === null || v === undefined;

/** Valor de uma expressão "? " ou literal. */
type H = [RegExp, (db: MiniDb, m: RegExpMatchArray, p: any[]) => any];
const HANDLERS: H[] = [
  // ── crm_clients ──
  [/^SELECT \* FROM crm_clients WHERE id IN \(\?, \?\) ORDER BY id FOR UPDATE$/, (db, _m, p) => db.rows("crm_clients", (r) => p.map(Number).includes(r.id)).sort((a, b) => a.id - b.id)],
  [/^SELECT id, status, mergedInto FROM crm_clients WHERE id IN \(\?, \?\) ORDER BY id FOR UPDATE$/, (db, _m, p) => db.rows("crm_clients", (r) => p.map(Number).includes(r.id)).sort((a, b) => a.id - b.id)],
  [/^SELECT isPro, notes, tagsJson FROM crm_clients WHERE id = \?$/, (db, _m, p) => db.rows("crm_clients", (r) => r.id === Number(p[0]))],
  [/^SELECT status FROM crm_clients WHERE id = \?$/, (db, _m, p) => db.rows("crm_clients", (r) => r.id === Number(p[0]))],
  [/^UPDATE crm_clients SET isPro = IF\(proManual = 1, isPro, GREATEST\(isPro, \?\)\) WHERE id = \?$/, (db, _m, p) => {
    for (const r of db.rows("crm_clients", (x) => x.id === Number(p[1]))) if (!r.proManual) r.isPro = Math.max(Number(r.isPro ?? 0), Number(p[0]));
    return { affectedRows: 1 };
  }],
  [/^UPDATE crm_clients SET status = 'merged', mergedInto = \? WHERE id = \?$/, (db, _m, p) => { for (const r of db.rows("crm_clients", (x) => x.id === Number(p[1]))) { r.status = "merged"; r.mergedInto = Number(p[0]); } return {}; }],
  [/^UPDATE crm_clients SET status = 'active', mergedInto = NULL WHERE id = \?$/, (db, _m, p) => { for (const r of db.rows("crm_clients", (x) => x.id === Number(p[0]))) { r.status = "active"; r.mergedInto = null; } return {}; }],
  [/^UPDATE crm_clients SET isPro = \? WHERE id = \? AND proManual = 0 AND isPro = \?$/, (db, _m, p) => { for (const r of db.rows("crm_clients", (x) => x.id === Number(p[1]) && !x.proManual && Number(x.isPro) === Number(p[2]))) r.isPro = Number(p[0]); return {}; }],
  [/^UPDATE crm_clients SET (notes|tagsJson) = \? WHERE id = \? AND \1 <=> \?$/, (db, m, p) => { for (const r of db.rows("crm_clients", (x) => x.id === Number(p[1]) && (x[m[1]] ?? null) === (p[2] ?? null))) r[m[1]] = p[0]; return {}; }],
  [/^UPDATE crm_clients SET `(\w+)` = NULL WHERE id = \? AND `\1` <=> \?$/, (db, m, p) => { for (const r of db.rows("crm_clients", (x) => x.id === Number(p[0]) && (x[m[1]] ?? null) === (p[1] ?? null))) r[m[1]] = null; return {}; }],
  [/^UPDATE crm_clients SET (.+) WHERE id = \?$/, (db, m, p) => {
    // "`a` = ?, `b` = ?, notes = ?, tagsJson = ?"
    const cols = m[1].split(", ").map((x) => x.replace(/`/g, "").split(" = ")[0]);
    const vals = cut(p, cols.length);
    for (const r of db.rows("crm_clients", (x) => x.id === Number(p[0]))) cols.forEach((c, i) => { r[c] = vals[i]; });
    return {};
  }],
  [/^UPDATE crm_clients SET metricsAt = NULL WHERE id IN \((.+)\)$/, () => ({})],
  // ── tabelas de contactos: SELECT/UPDATE/DELETE por cliente e id ──
  [/^SELECT `?(\w+)`? AS v FROM (\w+) WHERE clientId = \?$/, (db, m, p) => db.rows(m[2], (r) => r.clientId === Number(p[0])).map((r) => ({ v: r[m[1]] }))],
  [/^SELECT \* FROM (\w+) WHERE clientId = \?$/, (db, m, p) => db.rows(m[1], (r) => r.clientId === Number(p[0])).map((r) => ({ ...r }))],
  [/^SELECT \* FROM (\w+) WHERE id = \? AND clientId = \? FOR UPDATE$/, (db, m, p) => db.rows(m[1], (r) => r.id === Number(p[0]) && r.clientId === Number(p[1])).map((r) => ({ ...r }))],
  [/^SELECT id FROM (\w+) WHERE clientId = \?$/, (db, m, p) => db.rows(m[1], (r) => r.clientId === Number(p[0])).map((r) => ({ id: r.id }))],
  [/^SELECT id FROM crm_pro_accounts WHERE crmClientId = \?$/, (db, _m, p) => db.rows("crm_pro_accounts", (r) => r.crmClientId === Number(p[0])).map((r) => ({ id: r.id }))],
  [/^SELECT kind, value FROM crm_blocked_identifiers WHERE clientId = \?$/, (db, _m, p) => db.rows("crm_blocked_identifiers", (r) => r.clientId === Number(p[0])).map((r) => ({ kind: r.kind, value: r.value }))],
  [/^DELETE FROM (\w+) WHERE id IN \((.+)\)$/, (db, m, p) => { const set = new Set(p.map(Number)); db.tables.set(m[1], db.t(m[1]).filter((r) => !set.has(r.id))); return {}; }],
  [/^DELETE FROM (\w+) WHERE id = \? AND clientId = \?$/, (db, m, p) => { db.tables.set(m[1], db.t(m[1]).filter((r) => !(r.id === Number(p[0]) && r.clientId === Number(p[1])))); return {}; }],
  [/^DELETE FROM crm_client_relations WHERE id = \?$/, (db, _m, p) => { db.tables.set("crm_client_relations", db.t("crm_client_relations").filter((r) => r.id !== Number(p[0]))); return {}; }],
  [/^DELETE FROM crm_blocked_identifiers WHERE clientId = \? AND kind = \? AND value = \?$/, (db, _m, p) => {
    db.tables.set("crm_blocked_identifiers", db.t("crm_blocked_identifiers").filter((r) => !(r.clientId === Number(p[0]) && r.kind === p[1] && r.value === p[2]))); return {};
  }],
  [/^UPDATE (\w+) SET clientId = \?(, isPrimary = 0)? WHERE id IN \((.+)\)$/, (db, m, p) => {
    const [to, ...rest] = p; const set = new Set(rest.map(Number));
    for (const r of db.rows(m[1], (x) => set.has(x.id))) { r.clientId = Number(to); if (m[2]) r.isPrimary = 0; }
    return {};
  }],
  [/^UPDATE (\w+) SET clientId = \? WHERE clientId = \? AND id IN \((.+)\)$/, (db, m, p) => {
    const [to, from, ...rest] = p; const set = new Set(rest.map(Number));
    for (const r of db.rows(m[1], (x) => set.has(x.id) && x.clientId === Number(from))) r.clientId = Number(to);
    return {};
  }],
  [/^UPDATE crm_pro_accounts SET crmClientId = \? WHERE id IN \((.+)\)$/, (db, _m, p) => { const [to, ...rest] = p; const set = new Set(rest.map(Number)); for (const r of db.rows("crm_pro_accounts", (x) => set.has(x.id))) r.crmClientId = Number(to); return {}; }],
  [/^UPDATE crm_pro_accounts SET crmClientId = \? WHERE crmClientId = \? AND id IN \((.+)\)$/, (db, _m, p) => {
    const [to, from, ...rest] = p; const set = new Set(rest.map(Number));
    for (const r of db.rows("crm_pro_accounts", (x) => set.has(x.id) && x.crmClientId === Number(from))) r.crmClientId = Number(to);
    return {};
  }],
  [/^UPDATE crm_pro_accounts pa JOIN crm_client_external_ids x ON x.`system` = 'multipark_client' AND x.externalId = pa.mpClientId SET pa.crmClientId = \? WHERE x.clientId = \? AND pa.crmClientId = \?$/, (db, _m, p) => {
    const mine = new Set(db.rows("crm_client_external_ids", (x) => x.system === "multipark_client" && x.clientId === Number(p[1])).map((x) => String(x.externalId)));
    for (const r of db.rows("crm_pro_accounts", (x) => x.crmClientId === Number(p[2]) && mine.has(String(x.mpClientId)))) r.crmClientId = Number(p[0]);
    return {};
  }],
  // ── relações ──
  [/^SELECT \* FROM crm_client_relations WHERE clientId = \? OR relatedClientId = \?$/, (db, _m, p) => db.rows("crm_client_relations", (r) => r.clientId === Number(p[0]) || r.relatedClientId === Number(p[1])).map((r) => ({ ...r }))],
  [/^SELECT \* FROM crm_client_relations WHERE id = \?$/, (db, _m, p) => db.rows("crm_client_relations", (r) => r.id === Number(p[0])).map((r) => ({ ...r }))],
  // ── bloqueios ──
  [/^INSERT IGNORE INTO crm_blocked_identifiers \(clientId, kind, value, blockedBy, createdAt\) SELECT \?, kind, value, blockedBy, createdAt FROM crm_blocked_identifiers WHERE clientId = \?$/, (db, _m, p) => {
    for (const b of db.rows("crm_blocked_identifiers", (r) => r.clientId === Number(p[1]))) {
      if (!db.rows("crm_blocked_identifiers", (r) => r.clientId === Number(p[0]) && r.kind === b.kind && r.value === b.value).length) db.insert("crm_blocked_identifiers", { clientId: Number(p[0]), kind: b.kind, value: b.value });
    }
    return {};
  }],
  [/^INSERT IGNORE INTO crm_blocked_identifiers \(clientId, kind, value, blockedBy\) VALUES (.+)$/, (db, m, p) => {
    const n = (m[1].match(/\(/g) ?? []).length;
    for (let i = 0; i < n; i++) {
      const literalField = /'field'/.test(m[1]);
      const [clientId, a, b] = literalField ? [p[i * 3], "field", p[i * 3 + 1]] : [p[i * 4], p[i * 4 + 1], p[i * 4 + 2]];
      if (!db.rows("crm_blocked_identifiers", (r) => r.clientId === Number(clientId) && r.kind === a && r.value === b).length) db.insert("crm_blocked_identifiers", { clientId: Number(clientId), kind: a, value: b });
    }
    return {};
  }],
  // ── sugestões e eventos ──
  [/^UPDATE crm_merge_suggestions /, () => ({ affectedRows: 0 })],
  [/^INSERT INTO crm_merge_events \(survivorId, mergedId, snapshotJson, reason, mergedBy, mergedAt\) VALUES \(\?, \?, \?, \?, \?, UTC_TIMESTAMP\(\)\)$/, (db, _m, p) => {
    const r = db.insert("crm_merge_events", { survivorId: Number(p[0]), mergedId: Number(p[1]), snapshotJson: p[2], reason: p[3], mergedBy: p[4], undoneAt: null });
    return { insertId: r.id };
  }],
  [/^SELECT \* FROM crm_merge_events WHERE id = \? FOR UPDATE$/, (db, _m, p) => db.rows("crm_merge_events", (r) => r.id === Number(p[0]))],
  [/^UPDATE crm_merge_events SET undoneAt = UTC_TIMESTAMP\(\), undoneBy = \? WHERE id = \?$/, (db, _m, p) => { for (const r of db.rows("crm_merge_events", (x) => x.id === Number(p[1]))) r.undoneAt = "agora"; return {}; }],
  // ── retirados ──
  [/^INSERT INTO crm_removed_items \(clientId, kind, value, rowJson, reason, removedBy, removedAt\) VALUES \(\?, \?, \?, \?, \?, \?, UTC_TIMESTAMP\(\)\)$/, (db, _m, p) => {
    const r = db.insert("crm_removed_items", { clientId: Number(p[0]), kind: p[1], value: p[2], rowJson: p[3], reason: p[4], removedBy: p[5], restoredAt: null });
    return { insertId: r.id };
  }],
  [/^SELECT \* FROM crm_removed_items WHERE id = \? AND clientId = \? AND restoredAt IS NULL FOR UPDATE$/, (db, _m, p) => db.rows("crm_removed_items", (r) => r.id === Number(p[0]) && r.clientId === Number(p[1]) && isNull(r.restoredAt))],
  [/^UPDATE crm_removed_items SET restoredAt = UTC_TIMESTAMP\(\), restoredBy = \? WHERE id = \?$/, (db, _m, p) => { for (const r of db.rows("crm_removed_items", (x) => x.id === Number(p[1]))) r.restoredAt = "agora"; return {}; }],
  [/^INSERT IGNORE INTO (crm_client_\w+) \((.+)\) VALUES \((.+)\)$/, (db, m, p) => {
    const cols = m[2].split(", ").map((c) => c.replace(/`/g, ""));
    const row = Object.fromEntries(cols.map((c, i) => [c, p[i]]));
    const key = m[1] === "crm_client_emails" ? "email" : m[1] === "crm_client_phones" ? "phone" : m[1] === "crm_client_vehicles" ? "plate" : null;
    if (key && db.rows(m[1], (r) => r.clientId === Number(row.clientId) && r[key] === row[key]).length) return {};
    if (row.id != null && db.rows(m[1], (r) => r.id === Number(row.id)).length) return {};
    db.insert(m[1], { ...row, clientId: Number(row.clientId), ...(row.id != null ? { id: Number(row.id) } : {}) });
    return {};
  }],
  // primaryEmail/primaryPhone/noEmail recalculados — não interessa aqui
  [/^UPDATE crm_clients c SET primaryEmail = /, () => ({})],
];

/** Uma ficha mínima. */
export function ficha(db: MiniDb, id: number, o: Row = {}): Row {
  return db.insert("crm_clients", { id, status: "active", mergedInto: null, isPro: 0, proManual: 0, notes: null, tagsJson: null, displayName: `Cliente ${id}`, nif: null, bookings: 0, ...o });
}

export const ids2 = ids;
