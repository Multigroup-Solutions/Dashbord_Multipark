/**
 * Plano 05: leituras e escritas da identidade partilhada (be-shared) — tudo por
 * SQL, porque `users.shared*` NÃO estão no drizzle (migração 0950, como as da
 * palavra-passe em 0620): uma migração por aplicar nunca parte as leituras de
 * `users`. Sem BD (ou sem as colunas): leituras vazias, escritas recusadas.
 * Os testes trocam esta loja por uma em memória (server/sharedIdentity.ts).
 */
import crypto from "node:crypto";
import { sql } from "drizzle-orm";

const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r?.rows ?? r) as any[]) ?? [];
const affected = (r: any): number => Number((Array.isArray(r) ? r[0] : r)?.affectedRows ?? 0);
const toIso = (v: unknown): string | null => {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  const s = String(v).trim();
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(" ", "T") : `${s.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const mysqlUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

export type SharedLinkMethod = "google_shadow" | "password" | "agent_confirmed" | "proposal" | "created" | "email_verified" | "access_request";

export interface DashUserRow {
  id: number;
  openId: string;
  email: string | null;
  name: string | null;
  role: string;
  isActive: number;
  deactivationReason: string | null;
  sessionVersion: number;
  sharedUserId: string | null;
  sharedLinkedAt: string | null;
  sharedLinkMethod: string | null;
  lastSignedIn: string | null;
  loginMethod: string | null;
}

export interface ProposalRow {
  id: number;
  userId: number;
  sharedUserId: string;
  sharedEmail: string;
  proposedById: number;
  expiresAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
}

export interface AccessRequestRow {
  id: number;
  sharedUserId: string;
  email: string | null;
  name: string | null;
  status: "pending" | "approved" | "rejected";
  requestCount: number;
  lastRequestedAt: string | null;
  decidedById: number | null;
  decidedAt: string | null;
  userId: number | null;
}

export type SetLinkResult = "linked" | "already_linked" | "taken" | "unavailable";

export interface SharedIdentityStore {
  userById(id: number): Promise<DashUserRow | null>;
  userBySharedId(sharedUserId: string): Promise<DashUserRow | null>;
  /** Contas por ligar com este email EXATO (sem variantes Gmail — decisão D2), fundidas excluídas. */
  unlinkedUsersByEmail(email: string): Promise<DashUserRow[]>;
  /** Liga só se a conta ainda não tiver ligação; o UNIQUE recusa uma conta Multipark já usada. */
  setLink(userId: number, sharedUserId: string, method: SharedLinkMethod, now: number): Promise<SetLinkResult>;
  clearLink(userId: number): Promise<boolean>;
  touchChecked(userIds: number[], now: number): Promise<void>;
  /** Para o ecrã de identidade: todas as contas (exceto fundidas). */
  listUsers(): Promise<(DashUserRow & { hasFicha: boolean })[]>;
  /** Ids de agente Multipark (= ids do be-shared) das fichas desta conta. */
  agentIdsOfUser(userId: number): Promise<string[]>;
  /** A conta tem ficha (principal ou conta extra)? */
  hasFicha(userId: number): Promise<boolean>;
  createProposal(p: { userId: number; sharedUserId: string; sharedEmail: string; tokenHash: string; proposedById: number; expiresAt: number }): Promise<number>;
  proposalByTokenHash(tokenHash: string): Promise<ProposalRow | null>;
  /** Marca confirmada se ainda estiver aberta. */
  confirmProposal(id: number, now: number): Promise<boolean>;
  cancelOpenProposals(userId: number, now: number): Promise<void>;
  openProposals(): Promise<ProposalRow[]>;
  upsertAccessRequest(r: { sharedUserId: string; email: string | null; name: string | null; now: number }): Promise<void>;
  accessRequests(status: "pending" | "approved" | "rejected" | "all"): Promise<AccessRequestRow[]>;
  accessRequestById(id: number): Promise<AccessRequestRow | null>;
  decideAccessRequest(id: number, d: { status: "approved" | "rejected"; decidedById: number; userId: number | null; now: number }): Promise<boolean>;
  log(entry: { userId: number; action: string; entityId: number | null; details: string }): Promise<void>;
}

async function database(): Promise<any | null> {
  const { getDb } = await import("./db");
  return getDb();
}

const USER_COLS = sql`id, openId, email, name, role, isActive, deactivationReason, sessionVersion, sharedUserId, sharedLinkedAt, sharedLinkMethod, lastSignedIn, loginMethod`;
const notMerged = sql`(loginMethod IS NULL OR LEFT(loginMethod, 12) <> 'merged_into_')`;

function userRow(r: any): DashUserRow {
  return {
    id: Number(r.id), openId: String(r.openId), email: r.email ?? null, name: r.name ?? null, role: String(r.role ?? "user"),
    isActive: Number(r.isActive ?? 0), deactivationReason: r.deactivationReason ?? null, sessionVersion: Number(r.sessionVersion ?? 0),
    sharedUserId: r.sharedUserId ?? null, sharedLinkedAt: toIso(r.sharedLinkedAt), sharedLinkMethod: r.sharedLinkMethod ?? null,
    lastSignedIn: toIso(r.lastSignedIn), loginMethod: r.loginMethod ?? null,
  };
}

function proposalRow(r: any): ProposalRow {
  return {
    id: Number(r.id), userId: Number(r.userId), sharedUserId: String(r.sharedUserId), sharedEmail: String(r.sharedEmail),
    proposedById: Number(r.proposedById), expiresAt: toIso(r.expiresAt) ?? new Date(0).toISOString(),
    confirmedAt: toIso(r.confirmedAt), cancelledAt: toIso(r.cancelledAt),
  };
}

function requestRow(r: any): AccessRequestRow {
  const status = String(r.status);
  return {
    id: Number(r.id), sharedUserId: String(r.sharedUserId), email: r.email ?? null, name: r.name ?? null,
    status: status === "approved" || status === "rejected" ? status : "pending", requestCount: Number(r.requestCount ?? 1),
    lastRequestedAt: toIso(r.lastRequestedAt), decidedById: r.decidedById == null ? null : Number(r.decidedById),
    decidedAt: toIso(r.decidedAt), userId: r.userId == null ? null : Number(r.userId),
  };
}

const isDup = (err: unknown): boolean => {
  const e = err as any;
  return e?.code === "ER_DUP_ENTRY" || e?.cause?.code === "ER_DUP_ENTRY" || /Duplicate entry/i.test(String(e?.message ?? e?.cause?.message ?? ""));
};

export const sqlSharedIdentityStore: SharedIdentityStore = {
  async userById(id) {
    const d = await database();
    if (!d) return null;
    const [r] = rowsOf(await d.execute(sql`SELECT ${USER_COLS} FROM users WHERE id = ${id} LIMIT 1`));
    return r ? userRow(r) : null;
  },
  async userBySharedId(sharedUserId) {
    const d = await database();
    if (!d || !sharedUserId) return null;
    const [r] = rowsOf(await d.execute(sql`SELECT ${USER_COLS} FROM users WHERE sharedUserId = ${sharedUserId} LIMIT 1`));
    return r ? userRow(r) : null;
  },
  async unlinkedUsersByEmail(email) {
    const d = await database();
    const e = email.trim().toLowerCase();
    if (!d || !e) return [];
    return rowsOf(await d.execute(sql`SELECT ${USER_COLS} FROM users WHERE ${notMerged} AND sharedUserId IS NULL
      AND LOWER(TRIM(email)) = ${e} ORDER BY isActive DESC, id ASC LIMIT 20`)).map(userRow);
  },
  async setLink(userId, sharedUserId, method, now) {
    const d = await database();
    if (!d) return "unavailable";
    try {
      const r = await d.execute(sql`UPDATE users SET sharedUserId = ${sharedUserId}, sharedLinkedAt = ${mysqlUtc(now)}, sharedLinkMethod = ${method}
        WHERE id = ${userId} AND sharedUserId IS NULL`);
      if (affected(r) === 1) return "linked";
      const [cur] = rowsOf(await d.execute(sql`SELECT sharedUserId FROM users WHERE id = ${userId} LIMIT 1`));
      return cur?.sharedUserId === sharedUserId ? "already_linked" : "taken";
    } catch (err) {
      if (isDup(err)) return "taken";
      throw err;
    }
  },
  async clearLink(userId) {
    const d = await database();
    if (!d) return false;
    const r = await d.execute(sql`UPDATE users SET sharedUserId = NULL, sharedLinkedAt = NULL, sharedLinkMethod = NULL, sharedCheckedAt = NULL WHERE id = ${userId}`);
    return affected(r) === 1;
  },
  async touchChecked(userIds, now) {
    const d = await database();
    if (!d || userIds.length === 0) return;
    await d.execute(sql`UPDATE users SET sharedCheckedAt = ${mysqlUtc(now)} WHERE id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})`).catch(() => undefined);
  },
  async listUsers() {
    const d = await database();
    if (!d) return [];
    const rows = rowsOf(await d.execute(sql`SELECT ${USER_COLS},
        (EXISTS (SELECT 1 FROM employees e WHERE e.userId = users.id) OR EXISTS (SELECT 1 FROM employee_accounts a WHERE a.userId = users.id)) AS hasFicha
      FROM users WHERE ${notMerged} ORDER BY isActive DESC, name ASC LIMIT 5000`));
    return rows.map((r) => ({ ...userRow(r), hasFicha: Number(r.hasFicha ?? 0) === 1 }));
  },
  async agentIdsOfUser(userId) {
    const d = await database();
    if (!d) return [];
    const fichas = rowsOf(await d.execute(sql`SELECT id, multiparkAgentUserId FROM employees WHERE userId = ${userId}
      UNION SELECT e.id, e.multiparkAgentUserId FROM employee_accounts a JOIN employees e ON e.id = a.employeeId WHERE a.userId = ${userId}`).catch(() => [[]]));
    const ids = new Set<string>();
    for (const f of fichas) if (f.multiparkAgentUserId) ids.add(String(f.multiparkAgentUserId).trim());
    const fichaIds = fichas.map((f) => Number(f.id)).filter((n) => Number.isFinite(n));
    if (fichaIds.length) {
      const agents = rowsOf(await d.execute(sql`SELECT agentUserId FROM employee_agents WHERE employeeId IN (${sql.join(fichaIds.map((id) => sql`${id}`), sql`, `)})`).catch(() => [[]]));
      for (const a of agents) if (a.agentUserId) ids.add(String(a.agentUserId).trim());
    }
    return [...ids].filter(Boolean);
  },
  async hasFicha(userId) {
    const d = await database();
    if (!d) return false;
    const [r] = rowsOf(await d.execute(sql`SELECT (EXISTS (SELECT 1 FROM employees WHERE userId = ${userId})
      OR EXISTS (SELECT 1 FROM employee_accounts WHERE userId = ${userId})) AS has`));
    return Number(r?.has ?? 0) === 1;
  },
  async createProposal(p) {
    const d = await database();
    if (!d) throw new Error("Sem base de dados");
    const r = await d.execute(sql`INSERT INTO shared_link_proposals (userId, sharedUserId, sharedEmail, tokenHash, proposedById, expiresAt)
      VALUES (${p.userId}, ${p.sharedUserId}, ${p.sharedEmail}, ${p.tokenHash}, ${p.proposedById}, ${mysqlUtc(p.expiresAt)})`);
    return Number((Array.isArray(r) ? r[0] : r)?.insertId ?? 0);
  },
  async proposalByTokenHash(tokenHash) {
    const d = await database();
    if (!d) return null;
    const [r] = rowsOf(await d.execute(sql`SELECT * FROM shared_link_proposals WHERE tokenHash = ${tokenHash} LIMIT 1`));
    return r ? proposalRow(r) : null;
  },
  async confirmProposal(id, now) {
    const d = await database();
    if (!d) return false;
    const r = await d.execute(sql`UPDATE shared_link_proposals SET confirmedAt = ${mysqlUtc(now)} WHERE id = ${id} AND confirmedAt IS NULL AND cancelledAt IS NULL`);
    return affected(r) === 1;
  },
  async cancelOpenProposals(userId, now) {
    const d = await database();
    if (!d) return;
    await d.execute(sql`UPDATE shared_link_proposals SET cancelledAt = ${mysqlUtc(now)} WHERE userId = ${userId} AND confirmedAt IS NULL AND cancelledAt IS NULL`);
  },
  async openProposals() {
    const d = await database();
    if (!d) return [];
    return rowsOf(await d.execute(sql`SELECT * FROM shared_link_proposals WHERE confirmedAt IS NULL AND cancelledAt IS NULL AND expiresAt > UTC_TIMESTAMP() ORDER BY id DESC LIMIT 500`).catch(() => [[]])).map(proposalRow);
  },
  async upsertAccessRequest(r) {
    const d = await database();
    if (!d) return;
    // Um pedido por conta Multipark: repetir só conta e volta a "pendente" se tinha sido recusado há tempo.
    await d.execute(sql`INSERT INTO shared_access_requests (sharedUserId, email, name, status, requestCount, lastRequestedAt)
      VALUES (${r.sharedUserId}, ${r.email}, ${r.name}, 'pending', 1, ${mysqlUtc(r.now)})
      ON DUPLICATE KEY UPDATE requestCount = requestCount + 1, lastRequestedAt = VALUES(lastRequestedAt),
        email = VALUES(email), name = VALUES(name),
        status = IF(status = 'approved', status, 'pending')`);
  },
  async accessRequests(status) {
    const d = await database();
    if (!d) return [];
    const where = status === "all" ? sql`1 = 1` : sql`status = ${status}`;
    return rowsOf(await d.execute(sql`SELECT * FROM shared_access_requests WHERE ${where} ORDER BY lastRequestedAt DESC LIMIT 500`).catch(() => [[]])).map(requestRow);
  },
  async accessRequestById(id) {
    const d = await database();
    if (!d) return null;
    const [r] = rowsOf(await d.execute(sql`SELECT * FROM shared_access_requests WHERE id = ${id} LIMIT 1`));
    return r ? requestRow(r) : null;
  },
  async decideAccessRequest(id, dec) {
    const d = await database();
    if (!d) return false;
    const r = await d.execute(sql`UPDATE shared_access_requests SET status = ${dec.status}, decidedById = ${dec.decidedById}, decidedAt = ${mysqlUtc(dec.now)}, userId = ${dec.userId}
      WHERE id = ${id} AND status = 'pending'`);
    return affected(r) === 1;
  },
  async log(entry) {
    try {
      const { logActivity } = await import("./db");
      await logActivity({ userId: entry.userId, action: entry.action, entity: "user", entityId: entry.entityId, details: entry.details.slice(0, 1000), source: "ui" } as any);
    } catch { /* o registo nunca parte a ligação */ }
  },
};

/** Token aleatório (base64url) e o seu hash — só o hash vai para a BD. */
export function newProposalToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, hash: hashProposalToken(token) };
}
export const hashProposalToken = (token: string): string => crypto.createHash("sha256").update(token).digest("hex");

let current: SharedIdentityStore = sqlSharedIdentityStore;
/** A loja em uso (os testes trocam-na). */
export function sharedIdentityStore(): SharedIdentityStore {
  return current;
}
export function setSharedIdentityStoreForTests(store: SharedIdentityStore | null): void {
  current = store ?? sqlSharedIdentityStore;
}
