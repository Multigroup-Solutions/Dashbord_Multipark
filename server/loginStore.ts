/**
 * Plano 56 (A1): leituras e escritas da entrada por email + código +
 * palavra-passe. Tudo por SQL (a palavra-passe NÃO está no drizzle `users`,
 * para nunca chegar ao cliente). Os testes trocam este módulo por uma BD em
 * memória (`loginStore()` → a deles).
 *
 * Sem BD: as leituras devolvem vazio e as escritas não fazem nada (o login
 * Google continua como antes). Nada se apaga.
 */
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { gmailCanonical, isGmail, type DutyPools } from "../shared/loginCode";
import { notifyCityOf, type NotifyCity } from "../shared/notificationRouting";

const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r?.rows ?? r) as any[]) ?? [];
const affected = (r: any): number => Number((Array.isArray(r) ? r[0] : r)?.affectedRows ?? 0);
const insertId = (r: any): number => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? 0);
const toMs = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  const s = String(v).trim();
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(" ", "T") : `${s.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : null;
};
export const mysqlUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

export interface LoginUserRow {
  id: number;
  openId: string;
  email: string | null;
  name: string | null;
  role: string;
  isActive: number;
  loginMethod: string | null;
  googleSub: string | null;
  hasPassword: boolean;
  deactivationReason: string | null;
  sessionVersion: number;
}

export interface LoginFichaRow {
  id: number;
  fullName: string;
  isActive: number;
  /** Conta principal da ficha. */
  userId: number | null;
  /** Contas extra (employee_accounts). */
  aliasUserIds: number[];
  photoUrl: string | null;
  projectId: number | null;
  position: string | null;
}

export interface NewLoginCode {
  emailNorm: string;
  userId: number | null;
  employeeId: number | null;
  codeHash: string;
  deviceNonceHash: string;
  deviceLabel: string | null;
  pdaId: number | null;
  cityKey: string | null;
  deliveryMode: "duty" | "email";
  expiresAt: number;
  ipHash: string | null;
  createdAt: number;
}

export interface StoredLoginCode {
  id: number;
  emailNorm: string;
  userId: number | null;
  employeeId: number | null;
  codeHash: string;
  deviceNonceHash: string;
  deviceLabel: string | null;
  deliveredTo: number[];
  expiresAt: number;
  attempts: number;
  usedAt: number | null;
  createdAt: number;
}

export interface PendingCodeForMe {
  id: number;
  emailNorm: string;
  employeeId: number | null;
  fullName: string | null;
  photoUrl: string | null;
  deviceLabel: string | null;
  deviceNonceHash: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  usedAt: number | null;
  /** Título do aviso no sino desta pessoa (leva o código). */
  title: string | null;
}

export interface PasswordState {
  hash: string | null;
  setAt: number | null;
  failedDay: string | null;
  failedCount: number;
  lockedUntil: number | null;
}

export interface LoginStore {
  usersByEmail(email: string): Promise<LoginUserRow[]>;
  usersByIds(ids: number[]): Promise<LoginUserRow[]>;
  userById(id: number): Promise<LoginUserRow | null>;
  userByGoogleSub(sub: string): Promise<LoginUserRow | null>;
  userByOpenId(openId: string): Promise<LoginUserRow | null>;
  fichasByEmail(email: string): Promise<LoginFichaRow[]>;
  fichasOfUser(userId: number): Promise<LoginFichaRow[]>;
  /** Caixa partilhada da Comunicação (reservas@, info@…)? */
  isSharedMailbox(email: string): Promise<boolean>;
  /** Grava o googleSub (só se a conta ainda não tem e ninguém o tem). */
  setGoogleSub(userId: number, sub: string): Promise<boolean>;
  /**
   * Entrou: último login e a forma. A conta do backoffice nunca usada
   * (`manual_…`) deixa de o ser: passa a `email_…` (código/palavra-passe) ou a
   * `google_<sub>` (Google, como a adoção de sempre).
   */
  markSignedIn(userId: number, method: "google" | "email_code" | "password", now: number, opts?: { googleSub?: string }): Promise<void>;
  /** Conta nova "utilizador" (email desconhecido ou ficha sem conta), só depois do código certo. */
  createEmailAccount(input: { email: string; name: string | null; now: number }): Promise<number>;
  insertCode(row: NewLoginCode): Promise<number>;
  setCodeDelivery(id: number, deliveredTo: number[]): Promise<void>;
  /** Os códigos mais recentes deste email neste aparelho (mais recente primeiro). */
  deviceCodes(emailNorm: string, deviceNonceHash: string, limit: number): Promise<StoredLoginCode[]>;
  bumpCodeAttempts(ids: number[]): Promise<void>;
  /** Marca o código como usado (uma vez só). */
  useCode(id: number, userId: number | null, now: number): Promise<boolean>;
  /** A conta que entrou com este código (quando só foi criada depois). */
  setCodeUser(id: number, userId: number): Promise<void>;
  /** Entrou com um código desde `sinceMs`? (para criar a palavra-passe sem a antiga). */
  codeLoginSince(userId: number, sinceMs: number): Promise<StoredLoginCode | null>;
  /** Pedidos recentes cujo código foi para esta pessoa (cartão "Códigos de entrada"). */
  codesDeliveredTo(userId: number, sinceMs: number): Promise<PendingCodeForMe[]>;
  passwordState(userId: number): Promise<PasswordState | null>;
  savePassword(userId: number, hash: string, now: number): Promise<void>;
  recordPasswordFailure(userId: number, day: string, count: number, lockedUntil: number | null): Promise<void>;
  clearPasswordFailures(userId: number): Promise<void>;
  /** Repor acesso: sem palavra-passe, sem bloqueio. */
  clearPassword(userId: number): Promise<void>;
  /** TL escalados, supervisores (com ponto aberto?) e RH/admins. */
  dutyPools(city: NotifyCity | null, shift: { date: string; shift: string }, now: number): Promise<DutyPools>;
  cityOfFicha(employeeId: number): Promise<NotifyCity | null>;
  /** PDA registado (token do aparelho): nome e cidade. */
  pdaByToken(token: string): Promise<{ id: number; name: string; city: NotifyCity | null } | null>;
  /** Nome e papel (para o aviso "enviado a TL X / supervisor Y"). */
  peopleOf(ids: number[]): Promise<Map<number, { name: string | null; role: string }>>;
  log(entry: { userId: number; action: string; entityId: number | null; details: string }): Promise<void>;
}

// ─── Implementação SQL ──────────────────────────────────────────────────────

async function database(): Promise<any | null> {
  const { getDb } = await import("./db");
  return getDb();
}

const USER_COLS = sql`id, openId, email, name, role, isActive, loginMethod, googleSub, (passwordHash IS NOT NULL) AS hasPassword, deactivationReason, sessionVersion`;
const notMerged = sql`(loginMethod IS NULL OR LEFT(loginMethod, 12) <> 'merged_into_')`;

function userRow(r: any): LoginUserRow {
  return {
    id: Number(r.id), openId: String(r.openId), email: r.email ?? null, name: r.name ?? null, role: String(r.role ?? "user"),
    isActive: Number(r.isActive ?? 0), loginMethod: r.loginMethod ?? null, googleSub: r.googleSub ?? null,
    hasPassword: Number(r.hasPassword ?? 0) === 1, deactivationReason: r.deactivationReason ?? null, sessionVersion: Number(r.sessionVersion ?? 0),
  };
}

/** `coluna` = este email (minúsculas; Gmail também sem pontos/"+"). */
function emailMatches(column: ReturnType<typeof sql.raw>, email: string) {
  const e = email.trim().toLowerCase();
  if (!isGmail(e)) return sql`LOWER(TRIM(${column})) = ${e}`;
  const local = gmailCanonical(e).split("@")[0];
  return sql`(LOWER(TRIM(${column})) = ${e} OR (SUBSTRING_INDEX(LOWER(TRIM(${column})), '@', -1) IN ('gmail.com', 'googlemail.com')
    AND REPLACE(SUBSTRING_INDEX(SUBSTRING_INDEX(LOWER(TRIM(${column})), '@', 1), '+', 1), '.', '') = ${local}))`;
}

async function fichasWhere(d: any, where: ReturnType<typeof sql>): Promise<LoginFichaRow[]> {
  const rows = rowsOf(await d.execute(sql`SELECT e.id, e.fullName, e.isActive, e.userId, e.photoUrl, e.projectId, e.position
    FROM employees e WHERE ${where} ORDER BY e.isActive DESC, e.id ASC LIMIT 20`));
  if (!rows.length) return [];
  const ids = rows.map((r) => Number(r.id));
  const aliases = rowsOf(await d.execute(sql`SELECT employeeId, userId FROM employee_accounts WHERE employeeId IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`).catch(() => [[]]));
  return rows.map((r) => ({
    id: Number(r.id), fullName: String(r.fullName ?? ""), isActive: Number(r.isActive ?? 0), userId: r.userId == null ? null : Number(r.userId),
    aliasUserIds: aliases.filter((a) => Number(a.employeeId) === Number(r.id)).map((a) => Number(a.userId)),
    photoUrl: r.photoUrl ?? null, projectId: r.projectId == null ? null : Number(r.projectId), position: r.position ?? null,
  }));
}

function codeRow(r: any): StoredLoginCode {
  let delivered: number[] = [];
  try {
    const v = typeof r.deliveredTo === "string" ? JSON.parse(r.deliveredTo) : r.deliveredTo;
    if (Array.isArray(v)) delivered = v.map(Number).filter((x) => Number.isInteger(x) && x > 0);
  } catch { delivered = []; }
  return {
    id: Number(r.id), emailNorm: String(r.emailNorm), userId: r.userId == null ? null : Number(r.userId), employeeId: r.employeeId == null ? null : Number(r.employeeId),
    codeHash: String(r.codeHash), deviceNonceHash: String(r.deviceNonceHash), deviceLabel: r.deviceLabel ?? null, deliveredTo: delivered,
    expiresAt: toMs(r.expiresAt) ?? 0, attempts: Number(r.attempts ?? 0), usedAt: toMs(r.usedAt), createdAt: toMs(r.createdAt) ?? 0,
  };
}

export const sqlLoginStore: LoginStore = {
  async usersByEmail(email) {
    const d = await database();
    if (!d) return [];
    return rowsOf(await d.execute(sql`SELECT ${USER_COLS} FROM users WHERE ${notMerged} AND ${emailMatches(sql.raw("email"), email)} ORDER BY isActive DESC, id ASC LIMIT 20`)).map(userRow);
  },
  async usersByIds(ids) {
    const list = Array.from(new Set(ids.filter((x) => Number.isInteger(x) && x > 0)));
    const d = await database();
    if (!d || !list.length) return [];
    return rowsOf(await d.execute(sql`SELECT ${USER_COLS} FROM users WHERE ${notMerged} AND id IN (${sql.join(list.map((id) => sql`${id}`), sql`, `)}) ORDER BY id`)).map(userRow);
  },
  async userById(id) {
    const d = await database();
    if (!d) return null;
    const [r] = rowsOf(await d.execute(sql`SELECT ${USER_COLS} FROM users WHERE id = ${id} LIMIT 1`));
    return r ? userRow(r) : null;
  },
  async userByGoogleSub(sub) {
    const d = await database();
    if (!d || !sub) return null;
    const [r] = rowsOf(await d.execute(sql`SELECT ${USER_COLS} FROM users WHERE googleSub = ${sub} LIMIT 1`));
    return r ? userRow(r) : null;
  },
  async userByOpenId(openId) {
    const d = await database();
    if (!d) return null;
    const [r] = rowsOf(await d.execute(sql`SELECT ${USER_COLS} FROM users WHERE openId = ${openId} LIMIT 1`));
    return r ? userRow(r) : null;
  },
  async fichasByEmail(email) {
    const d = await database();
    if (!d) return [];
    return fichasWhere(d, sql`(${emailMatches(sql.raw("e.email"), email)} OR ${emailMatches(sql.raw("e.personalEmail"), email)})`);
  },
  async fichasOfUser(userId) {
    const d = await database();
    if (!d) return [];
    return fichasWhere(d, sql`(e.userId = ${userId} OR EXISTS (SELECT 1 FROM employee_accounts a WHERE a.employeeId = e.id AND a.userId = ${userId}))`);
  },
  async isSharedMailbox(email) {
    const d = await database();
    if (!d) return false;
    const e = email.trim().toLowerCase();
    const rows = rowsOf(await d.execute(sql`SELECT addressesJson, sourceKind, sourceEmail FROM mail_mailboxes`).catch(() => [[]]));
    for (const r of rows) {
      // Só as caixas partilhadas (lidas pela conta do Workspace ou por tema); a
      // de uma pessoa (sourceKind "user") pode ter o email dela.
      const kind = String(r.sourceKind ?? "dwd");
      if (kind === "user") continue;
      if (kind === "dwd" && String(r.sourceEmail ?? "").trim().toLowerCase() === e) return true;
      let list: unknown = [];
      try { list = JSON.parse(String(r.addressesJson ?? "[]")); } catch { list = []; }
      const addressOf = (a: any) => String(typeof a === "string" ? a : a?.address ?? "").trim().toLowerCase();
      if (Array.isArray(list) && list.some((a) => addressOf(a) === e)) return true;
    }
    return false;
  },
  async setGoogleSub(userId, sub) {
    const d = await database();
    if (!d || !sub) return false;
    try {
      const r = await d.execute(sql`UPDATE users SET googleSub = ${sub} WHERE id = ${userId} AND googleSub IS NULL`);
      return affected(r) > 0;
    } catch {
      return false; // outra conta já tem este sub (índice único) — fica como está
    }
  },
  async markSignedIn(userId, method, now, opts) {
    const d = await database();
    if (!d) return;
    const fresh = method === "google" && opts?.googleSub ? `google_${opts.googleSub}`.slice(0, 64) : `email_${crypto.randomBytes(12).toString("hex")}`;
    await d.execute(sql`UPDATE users SET lastSignedIn = ${mysqlUtc(now)}, loginMethod = ${method},
      openId = IF(LEFT(openId, 7) = 'manual_', ${fresh}, openId) WHERE id = ${userId}`);
  },
  async createEmailAccount({ email, name, now }) {
    const d = await database();
    if (!d) throw new Error("Base de dados indisponível.");
    const openId = `email_${crypto.randomBytes(12).toString("hex")}`;
    const r = await d.execute(sql`INSERT INTO users (openId, name, email, role, loginMethod, isActive, lastSignedIn)
      VALUES (${openId}, ${name ? name.slice(0, 255) : null}, ${email.trim().toLowerCase()}, 'user', 'email_code', 1, ${mysqlUtc(now)})`);
    return insertId(r);
  },
  async insertCode(row) {
    const d = await database();
    if (!d) throw new Error("Base de dados indisponível.");
    const r = await d.execute(sql`INSERT INTO login_codes (emailNorm, userId, employeeId, codeHash, deviceNonceHash, deviceLabel, pdaId, cityKey, deliveryMode, expiresAt, ipHash, createdAt)
      VALUES (${row.emailNorm}, ${row.userId}, ${row.employeeId}, ${row.codeHash}, ${row.deviceNonceHash}, ${row.deviceLabel ? row.deviceLabel.slice(0, 120) : null},
        ${row.pdaId}, ${row.cityKey}, ${row.deliveryMode}, ${mysqlUtc(row.expiresAt)}, ${row.ipHash}, ${mysqlUtc(row.createdAt)})`);
    return insertId(r);
  },
  async setCodeDelivery(id, deliveredTo) {
    const d = await database();
    if (!d) return;
    await d.execute(sql`UPDATE login_codes SET deliveredTo = ${JSON.stringify(deliveredTo)} WHERE id = ${id}`);
  },
  async deviceCodes(emailNorm, deviceNonceHash, limit) {
    const d = await database();
    if (!d) return [];
    return rowsOf(await d.execute(sql`SELECT * FROM login_codes WHERE emailNorm = ${emailNorm} AND deviceNonceHash = ${deviceNonceHash}
      ORDER BY id DESC LIMIT ${Math.max(1, Math.min(20, limit))}`)).map(codeRow);
  },
  async bumpCodeAttempts(ids) {
    const d = await database();
    if (!d || !ids.length) return;
    await d.execute(sql`UPDATE login_codes SET attempts = attempts + 1 WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
  },
  async useCode(id, userId, now) {
    const d = await database();
    if (!d) return false;
    const r = await d.execute(sql`UPDATE login_codes SET usedAt = ${mysqlUtc(now)}, usedByUserId = ${userId} WHERE id = ${id} AND usedAt IS NULL`);
    return affected(r) === 1;
  },
  async setCodeUser(id, userId) {
    const d = await database();
    if (!d) return;
    await d.execute(sql`UPDATE login_codes SET usedByUserId = ${userId} WHERE id = ${id}`);
  },
  async codeLoginSince(userId, sinceMs) {
    const d = await database();
    if (!d) return null;
    const [r] = rowsOf(await d.execute(sql`SELECT * FROM login_codes WHERE usedByUserId = ${userId} AND usedAt >= ${mysqlUtc(sinceMs)} ORDER BY usedAt DESC LIMIT 1`));
    return r ? codeRow(r) : null;
  },
  async codesDeliveredTo(userId, sinceMs) {
    const d = await database();
    if (!d) return [];
    // Os avisos "login_code" desta pessoa (o título leva o código) → os pedidos.
    const notes = rowsOf(await d.execute(sql`SELECT entityKey, title FROM app_notifications
      WHERE userId = ${userId} AND kind = 'login_code' AND createdAt >= DATE_SUB(NOW(), INTERVAL 30 MINUTE)
      ORDER BY id DESC LIMIT 60`));
    const titleOf = new Map<number, string>();
    for (const n of notes) {
      const id = Number(/^login_code:(\d+)$/.exec(String(n.entityKey ?? ""))?.[1] ?? 0);
      if (id > 0 && !titleOf.has(id)) titleOf.set(id, String(n.title ?? ""));
    }
    if (!titleOf.size) return [];
    const ids = sql.join(Array.from(titleOf.keys()).map((id) => sql`${id}`), sql`, `);
    const rows = rowsOf(await d.execute(sql`SELECT lc.id, lc.emailNorm, lc.employeeId, lc.deviceLabel, lc.deviceNonceHash, lc.createdAt, lc.expiresAt, lc.attempts, lc.usedAt,
        e.fullName, e.photoUrl
      FROM login_codes lc LEFT JOIN employees e ON e.id = lc.employeeId
      WHERE lc.id IN (${ids})
      ORDER BY lc.id DESC`));
    return rows
      .map((r) => ({
        id: Number(r.id), emailNorm: String(r.emailNorm), employeeId: r.employeeId == null ? null : Number(r.employeeId), fullName: r.fullName ?? null, photoUrl: r.photoUrl ?? null,
        deviceLabel: r.deviceLabel ?? null, deviceNonceHash: String(r.deviceNonceHash), createdAt: toMs(r.createdAt) ?? 0, expiresAt: toMs(r.expiresAt) ?? 0,
        attempts: Number(r.attempts ?? 0), usedAt: toMs(r.usedAt), title: titleOf.get(Number(r.id)) ?? null,
      }))
      .filter((r) => r.createdAt >= sinceMs);
  },
  async passwordState(userId) {
    const d = await database();
    if (!d) return null;
    const [r] = rowsOf(await d.execute(sql`SELECT passwordHash, passwordSetAt, DATE_FORMAT(passwordFailedDay, '%Y-%m-%d') AS failedDay, passwordFailedCount, passwordLockedUntil
      FROM users WHERE id = ${userId} LIMIT 1`));
    if (!r) return null;
    return { hash: r.passwordHash ?? null, setAt: toMs(r.passwordSetAt), failedDay: r.failedDay ?? null, failedCount: Number(r.passwordFailedCount ?? 0), lockedUntil: toMs(r.passwordLockedUntil) };
  },
  async savePassword(userId, hash, now) {
    const d = await database();
    if (!d) throw new Error("Base de dados indisponível.");
    await d.execute(sql`UPDATE users SET passwordHash = ${hash}, passwordSetAt = ${mysqlUtc(now)}, passwordFailedDay = NULL, passwordFailedCount = 0, passwordLockedUntil = NULL WHERE id = ${userId}`);
  },
  async recordPasswordFailure(userId, day, count, lockedUntil) {
    const d = await database();
    if (!d) return;
    await d.execute(sql`UPDATE users SET passwordFailedDay = ${day}, passwordFailedCount = ${count}, passwordLockedUntil = ${lockedUntil == null ? null : mysqlUtc(lockedUntil)} WHERE id = ${userId}`);
  },
  async clearPasswordFailures(userId) {
    const d = await database();
    if (!d) return;
    await d.execute(sql`UPDATE users SET passwordFailedDay = NULL, passwordFailedCount = 0 WHERE id = ${userId} AND passwordFailedCount <> 0`);
  },
  async clearPassword(userId) {
    const d = await database();
    if (!d) throw new Error("Base de dados indisponível.");
    await d.execute(sql`UPDATE users SET passwordHash = NULL, passwordSetAt = NULL, passwordFailedDay = NULL, passwordFailedCount = 0, passwordLockedUntil = NULL WHERE id = ${userId}`);
  },
  async dutyPools(city, shift, now) {
    const d = await database();
    const empty: DutyPools = { scheduledTeamLeaders: [], supervisors: [], rhAdmins: [] };
    if (!d) return empty;
    const { loadCandidatesFromDb } = await import("./notify");
    const candidates = await loadCandidatesFromDb().catch(() => []);
    const roleOf = new Map(candidates.map((c) => [c.id, c.role]));
    const rhAdmins = candidates.filter((c) => c.role === "backoffice" || c.role === "admin").map((c) => c.id);
    const pools: DutyPools = {
      ...empty,
      rhAdmins: rhAdmins.length ? rhAdmins : candidates.filter((c) => c.role === "super_admin").map((c) => c.id),
    };
    if (!city) return pools;
    // TL escalados neste turno, nesta cidade → as contas das fichas (principal + extra).
    const tlFichas = rowsOf(await d.execute(sql`SELECT DISTINCT employeeId FROM extras_dia_assignments
      WHERE assignmentDate = ${shift.date} AND shift = ${shift.shift} AND city = ${city} AND isTeamLeader = 1 AND employeeId IS NOT NULL`).catch(() => [[]]))
      .map((r) => Number(r.employeeId));
    if (tlFichas.length) {
      const list = sql.join(tlFichas.map((id) => sql`${id}`), sql`, `);
      const accounts = rowsOf(await d.execute(sql`SELECT userId FROM employees WHERE id IN (${list}) AND userId IS NOT NULL
        UNION SELECT userId FROM employee_accounts WHERE employeeId IN (${list})`).catch(() => [[]])).map((r) => Number(r.userId));
      pools.scheduledTeamLeaders = accounts.filter((id) => roleOf.has(id));
    }
    // Supervisores da cidade (as mesmas regras do sino) e se têm o ponto aberto
    // (último registo = entrada, há menos de 16 h — a regra do opsPresence).
    const sups = candidates.filter((c) => c.role === "supervisor" && !c.personalOnly && (c.cities === "all" || c.cities.includes(city))).map((c) => c.id);
    if (sups.length) {
      const list = sql.join(sups.map((id) => sql`${id}`), sql`, `);
      const { clockIsOpen } = await import("../shared/opsPresence");
      const rows = rowsOf(await d.execute(sql`SELECT x.userId,
          (SELECT t.type FROM time_records t WHERE t.employeeId = x.employeeId ORDER BY t.recordedAt DESC, t.id DESC LIMIT 1) AS lastType,
          (SELECT t.recordedAt FROM time_records t WHERE t.employeeId = x.employeeId ORDER BY t.recordedAt DESC, t.id DESC LIMIT 1) AS lastAt
        FROM (
          SELECT e.userId AS userId, e.id AS employeeId FROM employees e WHERE e.userId IN (${list})
          UNION SELECT a.userId, a.employeeId FROM employee_accounts a WHERE a.userId IN (${list})
        ) x`).catch(() => [[]]));
      const openSet = new Set(rows.filter((r) => String(r.lastType ?? "") === "check_in" && clockIsOpen(toMs(r.lastAt), now)).map((r) => Number(r.userId)));
      pools.supervisors = sups.map((userId) => ({ userId, clockOpen: openSet.has(userId) }));
    }
    return pools;
  },
  async cityOfFicha(employeeId) {
    const { resolveCitiesForEmployeeIds } = await import("./employeeCity");
    const m = await resolveCitiesForEmployeeIds([employeeId]).catch(() => new Map());
    return notifyCityOf((m.get(employeeId) as any)?.city ?? null);
  },
  async pdaByToken(token) {
    const d = await database();
    if (!d || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
    const [r] = rowsOf(await d.execute(sql`SELECT id, name, projectId FROM pdas WHERE deviceToken = ${token} AND status = 'active' LIMIT 1`).catch(() => [[]]));
    if (!r) return null;
    let city: NotifyCity | null = null;
    if (r.projectId != null) {
      const { resolveCitiesForProjectIds } = await import("./employeeCity");
      const m = await resolveCitiesForProjectIds([Number(r.projectId)]).catch(() => new Map());
      city = notifyCityOf(m.get(Number(r.projectId)) ?? null);
    }
    return { id: Number(r.id), name: String(r.name ?? "PDA"), city };
  },
  async peopleOf(ids) {
    const out = new Map<number, { name: string | null; role: string }>();
    const list = Array.from(new Set(ids.filter((x) => Number.isInteger(x) && x > 0)));
    const d = await database();
    if (!d || !list.length) return out;
    const rows = rowsOf(await d.execute(sql`SELECT u.id, u.role, COALESCE(
        (SELECT e.fullName FROM employees e WHERE e.userId = u.id ORDER BY e.isActive DESC, e.id LIMIT 1), u.name) AS name
      FROM users u WHERE u.id IN (${sql.join(list.map((id) => sql`${id}`), sql`, `)})`));
    for (const r of rows) out.set(Number(r.id), { name: r.name ?? null, role: String(r.role ?? "user") });
    return out;
  },
  async log(entry) {
    try {
      const { logActivity } = await import("./db");
      await logActivity({ userId: entry.userId, action: entry.action, entity: "user", entityId: entry.entityId, details: entry.details.slice(0, 1000), source: "ui" } as any);
    } catch { /* o registo nunca parte a entrada */ }
  },
};

/** A loja em uso (os testes trocam-na). */
export function loginStore(): LoginStore {
  return sqlLoginStore;
}
