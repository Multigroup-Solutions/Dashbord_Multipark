/**
 * Reconciliação de identidade por EMAIL — utilizadores, fichas de colaborador
 * e agentes Multipark.
 *
 * REGRA (Jorge, 2026-09-10): um email = UMA pessoa. Quem tem ficha com email
 * válido tem de ter utilizador com ESSE email; todos os agentes Multipark que
 * usam esse email são a mesma pessoa e ficam ANEXADOS à ficha; nunca podem
 * existir dois utilizadores (nem duas fichas ativas) com o mesmo email.
 * "Juntar" nunca é apagar: as referências são re-apontadas antes de qualquer
 * remoção, e tudo fica em `activity_logs`.
 *
 * Este módulo é dividido em três partes:
 *   1. `loadIdentitySnapshot` — lê tudo (só SELECTs).
 *   2. `buildIdentityAudit` / `planReconcile` — PURAS (testáveis sem BD).
 *   3. `applyReconcile` — escreve, uma ação de cada vez, com log.
 *
 * Os scripts `scripts/identity-audit.ts` (relatório) e
 * `scripts/identity-reconcile.ts` (dry-run por defeito, `--apply`) são a
 * interface de linha de comandos.
 */
import { sql } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { isPlausibleEmail, normalizeEmail } from "../shared/email";

export type Db = MySql2Database<Record<string, never>> | MySql2Database<any>;

// ─── Snapshot ────────────────────────────────────────────────────────────────

export interface UserRow {
  id: number;
  openId: string;
  name: string | null;
  email: string | null;
  role: string;
  isActive: number;
  loginMethod: string | null;
  lastSignedIn: string | null;
}

export interface EmployeeRow {
  id: number;
  fullName: string;
  email: string | null;
  /** Email pessoal dos INTERNOS (0067) — só para contacto; conta para casar agentes. */
  personalEmail: string | null;
  phone: string | null;
  position: string;
  isActive: number;
  userId: number | null;
  multiparkAgentName: string | null;
  multiparkAgentUserId: string | null;
}

/** Um agente Multipark = um `agentUserId` visto no histórico das reservas. */
export interface AgentRow {
  agentUserId: string;
  /** Nomes com que este agente apareceu (normalmente 1). */
  agentNames: string[];
  /** Emails com que apareceu (normalmente 1; vazio se a API nunca mandou). */
  agentEmails: string[];
  actions: number;
  firstAction: string | null;
  lastAction: string | null;
}

export interface IdentitySnapshot {
  users: UserRow[];
  employees: EmployeeRow[];
  agents: AgentRow[];
}

export async function loadIdentitySnapshot(db: Db): Promise<IdentitySnapshot> {
  const [u] = (await db.execute(sql`
    SELECT id, openId, name, email, role, isActive, loginMethod, lastSignedIn
    FROM users ORDER BY id`)) as any;
  // personalEmail só existe a partir da migração 0067 — tolerante a BD antiga.
  let e: any;
  try {
    [e] = (await db.execute(sql`
      SELECT id, fullName, email, personalEmail, phone, position, isActive, userId, multiparkAgentName, multiparkAgentUserId
      FROM employees ORDER BY id`)) as any;
  } catch {
    [e] = (await db.execute(sql`
      SELECT id, fullName, email, NULL AS personalEmail, phone, position, isActive, userId, multiparkAgentName, multiparkAgentUserId
      FROM employees ORDER BY id`)) as any;
  }
  const [a] = (await db.execute(sql`
    SELECT agentUserId,
           GROUP_CONCAT(DISTINCT agentEmail ORDER BY agentEmail SEPARATOR '\n') AS emails,
           COUNT(*) AS actions, MIN(actionTime) AS firstAction, MAX(actionTime) AS lastAction
    FROM multipark_booking_history
    WHERE agentUserId IS NOT NULL AND agentUserId != ''
    GROUP BY agentUserId ORDER BY actions DESC`)) as any;
  // Nomes por agente ORDENADOS por frequência — o mais usado é o canónico
  // (o que os joins por `employees.multiparkAgentName` vão encontrar).
  const [an] = (await db.execute(sql`
    SELECT agentUserId, agentName, COUNT(*) AS n
    FROM multipark_booking_history
    WHERE agentUserId IS NOT NULL AND agentUserId != '' AND agentName IS NOT NULL AND agentName != ''
    GROUP BY agentUserId, agentName ORDER BY agentUserId, n DESC, agentName`)) as any;
  const namesByAgent = new Map<string, string[]>();
  for (const r of an as any[]) {
    const k = String(r.agentUserId);
    namesByAgent.set(k, [...(namesByAgent.get(k) ?? []), String(r.agentName).trim()]);
  }

  const str = (v: unknown): string | null => (v == null ? null : String(v));
  const split = (v: unknown): string[] =>
    String(v ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

  return {
    users: (u as any[]).map((r) => ({
      id: Number(r.id),
      openId: String(r.openId),
      name: str(r.name),
      email: str(r.email),
      role: String(r.role),
      isActive: Number(r.isActive),
      loginMethod: str(r.loginMethod),
      lastSignedIn: str(r.lastSignedIn),
    })),
    employees: (e as any[]).map((r) => ({
      id: Number(r.id),
      fullName: String(r.fullName),
      email: str(r.email),
      personalEmail: str(r.personalEmail),
      phone: str(r.phone),
      position: String(r.position),
      isActive: Number(r.isActive),
      userId: r.userId == null ? null : Number(r.userId),
      multiparkAgentName: str(r.multiparkAgentName),
      multiparkAgentUserId: str(r.multiparkAgentUserId),
    })),
    agents: (a as any[]).map((r) => ({
      agentUserId: String(r.agentUserId),
      agentNames: namesByAgent.get(String(r.agentUserId)) ?? [],
      agentEmails: split(r.emails).map(normalizeEmail).filter(Boolean),
      actions: Number(r.actions),
      firstAction: str(r.firstAction),
      lastAction: str(r.lastAction),
    })),
  };
}

// ─── Auditoria (pura) ────────────────────────────────────────────────────────

export interface AuditFinding<T> {
  kind: string;
  items: T[];
}

export interface EmployeeNoUser {
  employeeId: number;
  fullName: string;
  email: string;
  position: string;
  isActive: number;
  /** Já existe utilizador com este email → só falta ligar. */
  existingUserId: number | null;
}

export interface EmployeeEmailMismatch {
  employeeId: number;
  fullName: string;
  employeeEmail: string | null;
  userId: number;
  userEmail: string | null;
  userActive: number;
}

export interface DuplicateEmailGroup<T> {
  email: string;
  rows: T[];
}

export interface AgentFinding {
  agentUserId: string;
  agentNames: string[];
  agentEmails: string[];
  actions: number;
  lastAction: string | null;
  /** Ficha(s) já ligada(s) a este agente (por userId ou por nome). */
  linkedEmployeeIds: number[];
  /** Ficha(s) cujo email (ou email do utilizador ligado) coincide. */
  emailMatchEmployeeIds: number[];
  /** Utilizador(es) cujo email coincide. */
  emailMatchUserIds: number[];
}

export interface IdentityAudit {
  counts: {
    users: number;
    usersWithEmail: number;
    employees: number;
    employeesActive: number;
    employeesWithValidEmail: number;
    employeesWithInvalidEmail: number;
    employeesWithoutEmail: number;
    agents: number;
    agentsWithEmail: number;
  };
  /** Fichas com email válido e SEM utilizador ligado. */
  employeesWithoutUser: EmployeeNoUser[];
  /** Fichas com email inválido/estranho (não dá para criar utilizador). */
  employeesInvalidEmail: Array<{ employeeId: number; fullName: string; email: string; isActive: number }>;
  /** Fichas ligadas a um utilizador cujo email é DIFERENTE do da ficha. */
  employeeUserEmailMismatch: EmployeeEmailMismatch[];
  /** Fichas ligadas a um userId que não existe em `users`. */
  employeesDanglingUser: Array<{ employeeId: number; fullName: string; userId: number }>;
  /** Vários utilizadores com o mesmo email. */
  duplicateUsers: DuplicateEmailGroup<UserRow>[];
  /** Várias fichas (ativas ou não) com o mesmo email. */
  duplicateEmployees: DuplicateEmailGroup<EmployeeRow>[];
  /** Duas ou mais fichas ATIVAS ligadas ao mesmo utilizador. */
  usersWithSeveralActiveEmployees: Array<{ userId: number; employeeIds: number[] }>;
  /** Utilizadores ativos sem ficha nenhuma ligada e sem ficha com o mesmo email. */
  usersWithoutEmployee: Array<{ userId: number; email: string | null; name: string | null; role: string }>;
  /** Agentes Multipark cujo email coincide com uma ficha/utilizador mas NÃO estão anexados. */
  agentsToAttach: AgentFinding[];
  /** Agentes anexados a uma ficha cujo email é diferente do email do agente. */
  agentsEmailMismatch: Array<AgentFinding & { employeeEmail: string | null }>;
  /** Agentes sem qualquer ficha/utilizador correspondente (nem por ligação nem por email). */
  agentsUnmatched: AgentFinding[];
  /** O mesmo email usado por vários agentes (mesma pessoa, várias contas Multipark). */
  agentsSharingEmail: Array<{ email: string; agentUserIds: string[] }>;
  /** Agentes anexados a MAIS do que uma ficha ativa. */
  agentsLinkedToSeveralEmployees: Array<{ agentUserId: string; employeeIds: number[] }>;
  /** Fichas ativas com agente indicado que nunca apareceu no histórico. */
  employeesWithUnknownAgent: Array<{ employeeId: number; fullName: string; multiparkAgentName: string | null; multiparkAgentUserId: string | null }>;
}

const norm = (s: string | null | undefined) => normalizeEmail(s);
const nameKey = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export function buildIdentityAudit(snap: IdentitySnapshot): IdentityAudit {
  const usersById = new Map(snap.users.map((u) => [u.id, u]));
  const usersByEmail = new Map<string, UserRow[]>();
  for (const u of snap.users) {
    const k = norm(u.email);
    if (!k) continue;
    usersByEmail.set(k, [...(usersByEmail.get(k) ?? []), u]);
  }
  const employeesByEmail = new Map<string, EmployeeRow[]>();
  for (const e of snap.employees) {
    const k = norm(e.email);
    if (!k) continue;
    employeesByEmail.set(k, [...(employeesByEmail.get(k) ?? []), e]);
  }
  /** Email efetivo da ficha: o da ficha, senão o do utilizador ligado. */
  const effectiveEmail = (e: EmployeeRow): string => {
    const own = norm(e.email);
    if (own) return own;
    const u = e.userId != null ? usersById.get(e.userId) : undefined;
    return norm(u?.email);
  };
  // Para casar AGENTES: o email de trabalho (ou do login) E o pessoal dos
  // internos — um agente Multipark criado com o gmail da pessoa é a mesma pessoa.
  const employeesByEffectiveEmail = new Map<string, EmployeeRow[]>();
  for (const e of snap.employees) {
    const keys = new Set([effectiveEmail(e), norm(e.personalEmail)].filter(Boolean));
    for (const k of keys) employeesByEffectiveEmail.set(k, [...(employeesByEffectiveEmail.get(k) ?? []), e]);
  }
  /** Emails que identificam a pessoa para efeitos de agente: trabalho/login + pessoal. */
  const agentEmailsOf = (e: EmployeeRow): string[] => [effectiveEmail(e), norm(e.personalEmail)].filter(Boolean);
  const employeesByUserId = new Map<number, EmployeeRow[]>();
  for (const e of snap.employees) {
    if (e.userId == null) continue;
    employeesByUserId.set(e.userId, [...(employeesByUserId.get(e.userId) ?? []), e]);
  }
  const employeesByAgentUserId = new Map<string, EmployeeRow[]>();
  const employeesByAgentName = new Map<string, EmployeeRow[]>();
  for (const e of snap.employees) {
    if (e.multiparkAgentUserId) {
      const k = e.multiparkAgentUserId.trim();
      employeesByAgentUserId.set(k, [...(employeesByAgentUserId.get(k) ?? []), e]);
    }
    if (e.multiparkAgentName) {
      const k = nameKey(e.multiparkAgentName);
      employeesByAgentName.set(k, [...(employeesByAgentName.get(k) ?? []), e]);
    }
  }

  // ── Fichas ────────────────────────────────────────────────────────────────
  const employeesWithoutUser: EmployeeNoUser[] = [];
  const employeesInvalidEmail: IdentityAudit["employeesInvalidEmail"] = [];
  const employeeUserEmailMismatch: EmployeeEmailMismatch[] = [];
  const employeesDanglingUser: IdentityAudit["employeesDanglingUser"] = [];
  let withValid = 0;
  let withInvalid = 0;
  let withoutEmail = 0;
  for (const e of snap.employees) {
    const raw = (e.email ?? "").trim();
    if (!raw) withoutEmail++;
    else if (isPlausibleEmail(raw)) withValid++;
    else {
      withInvalid++;
      employeesInvalidEmail.push({ employeeId: e.id, fullName: e.fullName, email: raw, isActive: e.isActive });
    }
    if (e.userId != null) {
      const u = usersById.get(e.userId);
      if (!u) {
        employeesDanglingUser.push({ employeeId: e.id, fullName: e.fullName, userId: e.userId });
      } else if (norm(e.email) && norm(u.email) !== norm(e.email)) {
        employeeUserEmailMismatch.push({
          employeeId: e.id,
          fullName: e.fullName,
          employeeEmail: e.email,
          userId: u.id,
          userEmail: u.email,
          userActive: u.isActive,
        });
      }
      continue;
    }
    if (raw && isPlausibleEmail(raw)) {
      const k = norm(raw);
      const existing = pickUser(usersByEmail.get(k) ?? []);
      employeesWithoutUser.push({
        employeeId: e.id,
        fullName: e.fullName,
        email: k,
        position: e.position,
        isActive: e.isActive,
        existingUserId: existing?.id ?? null,
      });
    }
  }

  // ── Duplicados ────────────────────────────────────────────────────────────
  const duplicateUsers: DuplicateEmailGroup<UserRow>[] = [];
  for (const [email, rows] of usersByEmail) if (rows.length > 1) duplicateUsers.push({ email, rows });
  const duplicateEmployees: DuplicateEmailGroup<EmployeeRow>[] = [];
  for (const [email, rows] of employeesByEmail) if (rows.length > 1) duplicateEmployees.push({ email, rows });
  const usersWithSeveralActiveEmployees: IdentityAudit["usersWithSeveralActiveEmployees"] = [];
  for (const [userId, rows] of employeesByUserId) {
    const active = rows.filter((r) => r.isActive === 1);
    if (active.length > 1) usersWithSeveralActiveEmployees.push({ userId, employeeIds: active.map((r) => r.id) });
  }

  // ── Utilizadores sem ficha ────────────────────────────────────────────────
  const usersWithoutEmployee: IdentityAudit["usersWithoutEmployee"] = [];
  for (const u of snap.users) {
    if (u.isActive !== 1) continue;
    if ((employeesByUserId.get(u.id) ?? []).length) continue;
    if ((employeesByEmail.get(norm(u.email)) ?? []).length) continue;
    usersWithoutEmployee.push({ userId: u.id, email: u.email, name: u.name, role: u.role });
  }

  // ── Agentes Multipark ─────────────────────────────────────────────────────
  const agentsToAttach: AgentFinding[] = [];
  const agentsEmailMismatch: IdentityAudit["agentsEmailMismatch"] = [];
  const agentsUnmatched: AgentFinding[] = [];
  const agentsLinkedToSeveralEmployees: IdentityAudit["agentsLinkedToSeveralEmployees"] = [];
  const byEmailAgents = new Map<string, string[]>();
  let agentsWithEmail = 0;
  for (const a of snap.agents) {
    if (a.agentEmails.length) agentsWithEmail++;
    for (const em of a.agentEmails) byEmailAgents.set(em, [...(byEmailAgents.get(em) ?? []), a.agentUserId]);

    const linked = new Map<number, EmployeeRow>();
    for (const e of employeesByAgentUserId.get(a.agentUserId) ?? []) linked.set(e.id, e);
    for (const n of a.agentNames) for (const e of employeesByAgentName.get(nameKey(n)) ?? []) linked.set(e.id, e);
    const linkedActive = [...linked.values()].filter((e) => e.isActive === 1);
    if (linkedActive.length > 1) {
      agentsLinkedToSeveralEmployees.push({ agentUserId: a.agentUserId, employeeIds: linkedActive.map((e) => e.id) });
    }

    const emailMatchEmployees = new Map<number, EmployeeRow>();
    const emailMatchUsers = new Map<number, UserRow>();
    for (const em of a.agentEmails) {
      for (const e of employeesByEffectiveEmail.get(em) ?? []) emailMatchEmployees.set(e.id, e);
      for (const u of usersByEmail.get(em) ?? []) emailMatchUsers.set(u.id, u);
    }
    const finding: AgentFinding = {
      agentUserId: a.agentUserId,
      agentNames: a.agentNames,
      agentEmails: a.agentEmails,
      actions: a.actions,
      lastAction: a.lastAction,
      linkedEmployeeIds: [...linked.keys()],
      emailMatchEmployeeIds: [...emailMatchEmployees.keys()],
      emailMatchUserIds: [...emailMatchUsers.keys()],
    };

    if (linked.size === 0) {
      if (emailMatchEmployees.size || emailMatchUsers.size) agentsToAttach.push(finding);
      else agentsUnmatched.push(finding);
      continue;
    }
    // Anexado: o email do agente tem de bater com o da ficha (trabalho/login
    // OU pessoal, nos internos).
    for (const e of linked.values()) {
      const mine = agentEmailsOf(e);
      if (a.agentEmails.length && mine.length && !a.agentEmails.some((em) => mine.includes(em))) {
        agentsEmailMismatch.push({ ...finding, employeeEmail: e.email ?? mine[0] });
      }
    }
  }
  const agentsSharingEmail: IdentityAudit["agentsSharingEmail"] = [];
  for (const [email, ids] of byEmailAgents) if (ids.length > 1) agentsSharingEmail.push({ email, agentUserIds: ids });

  const knownAgentIds = new Set(snap.agents.map((a) => a.agentUserId));
  const knownAgentNames = new Set(snap.agents.flatMap((a) => a.agentNames.map(nameKey)));
  const employeesWithUnknownAgent: IdentityAudit["employeesWithUnknownAgent"] = [];
  for (const e of snap.employees) {
    if (e.isActive !== 1) continue;
    if (!e.multiparkAgentName && !e.multiparkAgentUserId) continue;
    const byId = e.multiparkAgentUserId ? knownAgentIds.has(e.multiparkAgentUserId.trim()) : false;
    const byName = e.multiparkAgentName ? knownAgentNames.has(nameKey(e.multiparkAgentName)) : false;
    if (!byId && !byName) {
      employeesWithUnknownAgent.push({
        employeeId: e.id,
        fullName: e.fullName,
        multiparkAgentName: e.multiparkAgentName,
        multiparkAgentUserId: e.multiparkAgentUserId,
      });
    }
  }

  return {
    counts: {
      users: snap.users.length,
      usersWithEmail: snap.users.filter((u) => norm(u.email)).length,
      employees: snap.employees.length,
      employeesActive: snap.employees.filter((e) => e.isActive === 1).length,
      employeesWithValidEmail: withValid,
      employeesWithInvalidEmail: withInvalid,
      employeesWithoutEmail: withoutEmail,
      agents: snap.agents.length,
      agentsWithEmail,
    },
    employeesWithoutUser,
    employeesInvalidEmail,
    employeeUserEmailMismatch,
    employeesDanglingUser,
    duplicateUsers,
    duplicateEmployees,
    usersWithSeveralActiveEmployees,
    usersWithoutEmployee,
    agentsToAttach,
    agentsEmailMismatch,
    agentsUnmatched,
    agentsSharingEmail,
    agentsLinkedToSeveralEmployees,
    employeesWithUnknownAgent,
  };
}

/** Entre vários utilizadores com o mesmo email: ativo > login Google > id mais baixo. */
export function pickUser(rows: UserRow[]): UserRow | null {
  if (!rows.length) return null;
  return [...rows].sort((a, b) => {
    if (a.isActive !== b.isActive) return b.isActive - a.isActive;
    const ga = a.openId.startsWith("google_") ? 1 : 0;
    const gb = b.openId.startsWith("google_") ? 1 : 0;
    if (ga !== gb) return gb - ga;
    return a.id - b.id;
  })[0];
}

// ─── Plano de reconciliação (puro) ───────────────────────────────────────────

/**
 * Role de login que uma ficha ganha quando o utilizador é criado
 * automaticamente. Segue o que já está em uso na BD (set 2026): extras e
 * condutores entram como `extra`; chefias com o role equivalente. NUNCA
 * atribui `admin`/`super_admin` sozinho — isso é decisão humana, por isso
 * `director` entra como `supervisor`.
 */
export function roleForPosition(position: string): string {
  switch (position) {
    case "team_leader":
      return "team_leader";
    case "backoffice":
      return "backoffice";
    case "frontoffice":
      return "frontoffice";
    case "supervisor":
    case "director":
      return "supervisor";
    case "extra":
    case "driver":
    case "senior_driver":
    default:
      return "extra";
  }
}

export interface CreateUserAction {
  employeeId: number;
  fullName: string;
  email: string;
  position: string;
  role: string;
}
export interface LinkUserAction {
  employeeId: number;
  fullName: string;
  email: string;
  userId: number;
}
export interface AttachAgentAction {
  employeeId: number;
  fullName: string;
  email: string;
  agentUserId: string;
  /** Nome canónico (mais usado no histórico) que fica em `multiparkAgentName`. */
  agentName: string;
  previousAgentName: string | null;
  previousAgentUserId: string | null;
  actions: number;
}
export interface MergeUsersAction {
  email: string;
  keepUserId: number;
  removeUserIds: number[];
}
export interface SkippedItem {
  what: "create_user" | "link_user" | "attach_agent" | "merge_users";
  ref: string;
  reason: string;
}

export interface ReconcilePlan {
  createUsers: CreateUserAction[];
  linkUsers: LinkUserAction[];
  attachAgents: AttachAgentAction[];
  mergeUsers: MergeUsersAction[];
  skipped: SkippedItem[];
}

export interface ReconcileOptions {
  /** Também trata fichas com isActive = 0 (por defeito só ativas). */
  includeInactive?: boolean;
}

export function planReconcile(snap: IdentitySnapshot, audit: IdentityAudit, opts: ReconcileOptions = {}): ReconcilePlan {
  const plan: ReconcilePlan = { createUsers: [], linkUsers: [], attachAgents: [], mergeUsers: [], skipped: [] };
  const employeesById = new Map(snap.employees.map((e) => [e.id, e]));
  const usersById = new Map(snap.users.map((u) => [u.id, u]));
  const activeEmployeesByUser = new Map<number, EmployeeRow[]>();
  for (const e of snap.employees) {
    if (e.userId == null || e.isActive !== 1) continue;
    activeEmployeesByUser.set(e.userId, [...(activeEmployeesByUser.get(e.userId) ?? []), e]);
  }
  const agentsById = new Map(snap.agents.map((a) => [a.agentUserId, a]));
  const emailsClaimed = new Set<string>();

  // 1. Fichas com email válido e sem utilizador → ligar ao existente ou criar.
  for (const e of audit.employeesWithoutUser) {
    if (!opts.includeInactive && e.isActive !== 1) {
      plan.skipped.push({ what: "create_user", ref: `ficha #${e.employeeId}`, reason: "ficha inativa (usa --include-inactive)" });
      continue;
    }
    if (emailsClaimed.has(e.email)) {
      plan.skipped.push({ what: "create_user", ref: `ficha #${e.employeeId}`, reason: `email ${e.email} já reclamado por outra ficha neste plano — duplicado a resolver à mão` });
      continue;
    }
    const dupGroup = audit.duplicateEmployees.find((g) => g.email === e.email);
    if (dupGroup && dupGroup.rows.filter((r) => r.isActive === 1).length > 1) {
      plan.skipped.push({ what: "create_user", ref: `ficha #${e.employeeId}`, reason: `email ${e.email} partilhado por ${dupGroup.rows.length} fichas — decidir à mão` });
      continue;
    }
    emailsClaimed.add(e.email);
    if (e.existingUserId != null) {
      const u = usersById.get(e.existingUserId);
      const taken = (activeEmployeesByUser.get(e.existingUserId) ?? []).filter((x) => x.id !== e.employeeId);
      if (taken.length) {
        plan.skipped.push({ what: "link_user", ref: `ficha #${e.employeeId}`, reason: `utilizador #${e.existingUserId} já ligado à ficha ativa #${taken[0].id} (${taken[0].fullName})` });
        continue;
      }
      if (u && u.isActive !== 1) {
        plan.skipped.push({ what: "link_user", ref: `ficha #${e.employeeId}`, reason: `utilizador #${e.existingUserId} está desativado — reativar à mão antes de ligar` });
        continue;
      }
      plan.linkUsers.push({ employeeId: e.employeeId, fullName: e.fullName, email: e.email, userId: e.existingUserId });
    } else {
      plan.createUsers.push({ employeeId: e.employeeId, fullName: e.fullName, email: e.email, position: e.position, role: roleForPosition(e.position) });
    }
  }

  // 2. Agentes Multipark com o email de UMA ficha → anexar.
  for (const a of audit.agentsToAttach) {
    const ref = `agente ${a.agentUserId} (${a.agentNames[0] ?? "?"})`;
    if (a.emailMatchEmployeeIds.length === 0) {
      plan.skipped.push({ what: "attach_agent", ref, reason: `email ${a.agentEmails.join("|")} só bate com utilizador(es) #${a.emailMatchUserIds.join(",")}, sem ficha — criar ficha à mão se for uma pessoa` });
      continue;
    }
    const candidates = a.emailMatchEmployeeIds.map((id) => employeesById.get(id)!).filter((e) => opts.includeInactive || e.isActive === 1);
    if (candidates.length !== 1) {
      plan.skipped.push({ what: "attach_agent", ref, reason: candidates.length === 0 ? "a única ficha com este email está inativa" : `email bate com ${candidates.length} fichas ativas (#${candidates.map((c) => c.id).join(",")}) — decidir à mão` });
      continue;
    }
    const e = candidates[0];
    const currentAgent = e.multiparkAgentUserId?.trim() || null;
    if (currentAgent && currentAgent !== a.agentUserId && agentsById.has(currentAgent)) {
      plan.skipped.push({ what: "attach_agent", ref, reason: `ficha #${e.id} já está anexada ao agente ${currentAgent} (real) — uma ficha só tem um agente; decidir à mão` });
      continue;
    }
    // Ligação LEGADA por nome: se o nome que está na ficha é o de OUTRO agente
    // real do histórico, a ficha já tem o seu agente — nunca o substituir
    // (caso Luís Tercitano, 2026-09-10: o email @multipark.pt batia com um
    // agente de teste e o nome "Luis Tercitano", com 410 ações, ia-se embora).
    const currentNameKey = nameKey(e.multiparkAgentName);
    const ownerByName = currentNameKey
      ? snap.agents.find((x) => x.agentUserId !== a.agentUserId && x.agentNames.some((n) => nameKey(n) === currentNameKey))
      : undefined;
    if (ownerByName) {
      plan.skipped.push({ what: "attach_agent", ref, reason: `ficha #${e.id} já está ligada por nome ao agente ${ownerByName.agentUserId} ("${e.multiparkAgentName}", ${ownerByName.actions} ações) — decidir à mão` });
      continue;
    }
    const agent = agentsById.get(a.agentUserId);
    const names = agent?.agentNames ?? a.agentNames;
    const keepName = e.multiparkAgentName && names.some((n) => n.trim().toLowerCase() === e.multiparkAgentName!.trim().toLowerCase());
    const agentName = keepName ? e.multiparkAgentName! : names[0] ?? e.multiparkAgentName ?? a.agentUserId;
    plan.attachAgents.push({
      employeeId: e.id,
      fullName: e.fullName,
      email: a.agentEmails[0] ?? "",
      agentUserId: a.agentUserId,
      agentName,
      previousAgentName: e.multiparkAgentName,
      previousAgentUserId: e.multiparkAgentUserId,
      actions: a.actions,
    });
  }

  // 3. Utilizadores duplicados → fica um (ativo > Google > id mais baixo).
  for (const g of audit.duplicateUsers) {
    const keep = pickUser(g.rows)!;
    const remove = g.rows.filter((u) => u.id !== keep.id);
    const googleLosers = remove.filter((u) => u.openId.startsWith("google_") && u.isActive === 1);
    if (googleLosers.length && keep.openId.startsWith("google_")) {
      plan.skipped.push({ what: "merge_users", ref: g.email, reason: `duas contas Google ATIVAS (#${keep.id}, #${googleLosers.map((u) => u.id).join(",")}) — decidir à mão qual fica` });
      continue;
    }
    plan.mergeUsers.push({ email: g.email, keepUserId: keep.id, removeUserIds: remove.map((u) => u.id) });
  }

  return plan;
}

// ─── Aplicar ─────────────────────────────────────────────────────────────────

export interface ApplyResult {
  createdUsers: Array<{ employeeId: number; userId: number; email: string }>;
  linkedUsers: Array<{ employeeId: number; userId: number }>;
  attachedAgents: Array<{ employeeId: number; agentUserId: string }>;
  mergedUsers: Array<{ email: string; keepUserId: number; removed: number[]; deactivated: number[] }>;
  errors: Array<{ ref: string; error: string }>;
}

const nowMysql = () => new Date().toISOString().slice(0, 19).replace("T", " ");

async function log(db: Db, action: string, entity: string, entityId: number | null, details: string) {
  try {
    await db.execute(sql`INSERT INTO activity_logs (userId, action, entity, entityId, details) VALUES (0, ${action}, ${entity}, ${entityId}, ${details.slice(0, 2000)})`);
  } catch { /* o log nunca pode impedir a reconciliação */ }
}

/**
 * Aplica o plano, uma ação de cada vez, com `activity_logs` (userId = 0 =
 * sistema). Nunca apaga fichas. Utilizadores duplicados: re-aponta TODAS as
 * referências para o sobrevivente e só depois remove a linha (mesma regra do
 * `adoptPlaceholderAccountByEmail`); se a remoção falhar, desativa e marca
 * `merged_into_<id>`.
 */
export async function applyReconcile(db: Db, plan: ReconcilePlan): Promise<ApplyResult> {
  const out: ApplyResult = { createdUsers: [], linkedUsers: [], attachedAgents: [], mergedUsers: [], errors: [] };

  for (const a of plan.createUsers) {
    try {
      const openId = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const [res] = (await db.execute(sql`
        INSERT INTO users (openId, name, email, role, loginMethod, isActive, lastSignedIn)
        VALUES (${openId}, ${a.fullName.slice(0, 255)}, ${a.email}, ${a.role}, 'manual', 1, ${nowMysql()})`)) as any;
      const userId = Number(res?.insertId);
      if (!userId) throw new Error("insertId em falta");
      await db.execute(sql`UPDATE employees SET userId = ${userId} WHERE id = ${a.employeeId} AND userId IS NULL`);
      await log(db, "user_autocreate", "user", userId, `[Reconciliação] Utilizador criado para a ficha #${a.employeeId} ${a.fullName} <${a.email}> com role ${a.role}`);
      out.createdUsers.push({ employeeId: a.employeeId, userId, email: a.email });
    } catch (err) {
      out.errors.push({ ref: `create_user ficha #${a.employeeId}`, error: String((err as Error)?.message ?? err) });
    }
  }

  for (const a of plan.linkUsers) {
    try {
      await db.execute(sql`UPDATE employees SET userId = ${a.userId} WHERE id = ${a.employeeId} AND userId IS NULL`);
      await log(db, "account_link", "employee", a.employeeId, `[Reconciliação] Ficha #${a.employeeId} ${a.fullName} ligada ao utilizador #${a.userId} <${a.email}>`);
      out.linkedUsers.push({ employeeId: a.employeeId, userId: a.userId });
    } catch (err) {
      out.errors.push({ ref: `link_user ficha #${a.employeeId}`, error: String((err as Error)?.message ?? err) });
    }
  }

  for (const a of plan.attachAgents) {
    try {
      await db.execute(sql`UPDATE employees SET multiparkAgentUserId = ${a.agentUserId}, multiparkAgentName = ${a.agentName.slice(0, 256)} WHERE id = ${a.employeeId}`);
      await log(db, "agent_attach", "employee", a.employeeId, `[Reconciliação] Agente Multipark ${a.agentUserId} "${a.agentName}" <${a.email}> anexado à ficha #${a.employeeId} ${a.fullName}${a.previousAgentName ? ` (antes: "${a.previousAgentName}"${a.previousAgentUserId ? ` / ${a.previousAgentUserId}` : ""})` : ""}`);
      out.attachedAgents.push({ employeeId: a.employeeId, agentUserId: a.agentUserId });
    } catch (err) {
      out.errors.push({ ref: `attach_agent ficha #${a.employeeId}`, error: String((err as Error)?.message ?? err) });
    }
  }

  for (const m of plan.mergeUsers) {
    const removed: number[] = [];
    const deactivated: number[] = [];
    for (const loser of m.removeUserIds) {
      try {
        await db.execute(sql`UPDATE employees SET userId = ${m.keepUserId} WHERE userId = ${loser}`);
        for (const [table, column] of USER_REF_COLUMNS) {
          try {
            await db.execute(sql.raw(`UPDATE \`${table}\` SET \`${column}\` = ${Number(m.keepUserId)} WHERE \`${column}\` = ${Number(loser)}`));
          } catch { /* tabela/coluna pode não existir */ }
        }
        try {
          await db.execute(sql`DELETE FROM users WHERE id = ${loser}`);
          removed.push(loser);
        } catch {
          await db.execute(sql`UPDATE users SET isActive = 0, loginMethod = ${`merged_into_${m.keepUserId}`.slice(0, 64)} WHERE id = ${loser}`);
          deactivated.push(loser);
        }
        await log(db, "account_merge", "user", m.keepUserId, `[Reconciliação] Utilizador duplicado <${m.email}>: #${loser} fundido em #${m.keepUserId} (referências re-apontadas)`);
      } catch (err) {
        out.errors.push({ ref: `merge_users ${m.email} #${loser}`, error: String((err as Error)?.message ?? err) });
      }
    }
    out.mergedUsers.push({ email: m.email, keepUserId: m.keepUserId, removed, deactivated });
  }

  return out;
}

/** Colunas que apontam para users.id (espelho de `identity.ts`; fichas NÃO entram). */
export const USER_REF_COLUMNS: Array<[table: string, column: string]> = [
  ["activity_logs", "userId"],
  ["app_notifications", "userId"],
  ["complaint_messages", "authorId"],
  ["complaint_photos", "uploadedById"],
  ["complaints", "createdById"],
  ["complaints", "closedById"],
  ["lost_found_items", "createdBy"],
  ["lost_found_items", "closedById"],
  ["lost_found_messages", "userId"],
  ["lost_found_attached_drivers", "attachedById"],
  ["tasks", "createdById"],
  ["google_reviews", "respondedBy"],
  ["google_reviews", "createdById"],
  ["expenses", "insertedById"],
  ["multipark_sync_logs", "triggeredById"],
];

// ─── Anexação automática no sync ─────────────────────────────────────────────

export interface SeenAgent {
  agentUserId: string;
  agentName: string | null;
  agentEmail: string | null;
}

/**
 * Chamado pelo sync das reservas com os agentes vistos no lote: se um agente
 * ainda não está anexado a nenhuma ficha e o seu email é o de EXATAMENTE uma
 * ficha ativa sem agente real, anexa. Barato (uma leitura de fichas) e
 * idempotente. Devolve o número de fichas anexadas.
 */
export async function autoAttachAgentsByEmail(db: Db, seen: SeenAgent[]): Promise<number> {
  const byId = new Map<string, SeenAgent>();
  for (const s of seen) {
    const id = (s.agentUserId ?? "").trim();
    const email = normalizeEmail(s.agentEmail);
    if (!id || !email || !isPlausibleEmail(email)) continue;
    if (!byId.has(id)) byId.set(id, { agentUserId: id, agentName: s.agentName?.trim() || null, agentEmail: email });
  }
  if (!byId.size) return 0;

  const [rows] = (await db.execute(sql`
    SELECT e.id, e.fullName, e.email, e.isActive, e.multiparkAgentName, e.multiparkAgentUserId,
           LOWER(TRIM(COALESCE(NULLIF(e.email, ''), u.email))) AS effectiveEmail
    FROM employees e LEFT JOIN users u ON u.id = e.userId`)) as any;
  const emps = (rows as any[]).map((r) => ({
    id: Number(r.id),
    fullName: String(r.fullName),
    isActive: Number(r.isActive),
    agentName: (r.multiparkAgentName ?? null) as string | null,
    agentUserId: ((r.multiparkAgentUserId ?? "") as string).trim() || null,
    effectiveEmail: String(r.effectiveEmail ?? ""),
  }));
  const linkedAgentIds = new Set(emps.map((e) => e.agentUserId).filter(Boolean) as string[]);
  const linkedNames = new Set(emps.map((e) => (e.agentName ?? "").trim().toLowerCase()).filter(Boolean));

  let attached = 0;
  for (const a of byId.values()) {
    if (linkedAgentIds.has(a.agentUserId)) continue;
    if (a.agentName && linkedNames.has(a.agentName.toLowerCase())) continue; // já ligado por nome
    const matches = emps.filter((e) => e.isActive === 1 && e.effectiveEmail === a.agentEmail);
    if (matches.length !== 1) continue;
    const e = matches[0];
    if (e.agentUserId) continue; // já tem outro agente real
    // Conservador: se a ficha já tem um nome de agente e não é o deste agente,
    // pode ser uma ligação legada por nome a OUTRO agente — não tocar (o
    // script de reconciliação, com o histórico completo, decide isso).
    if (e.agentName && (!a.agentName || e.agentName.trim().toLowerCase() !== a.agentName.toLowerCase())) continue;
    const name = a.agentName ?? e.agentName ?? a.agentUserId;
    try {
      await db.execute(sql`UPDATE employees SET multiparkAgentUserId = ${a.agentUserId}, multiparkAgentName = ${name.slice(0, 256)} WHERE id = ${e.id} AND (multiparkAgentUserId IS NULL OR multiparkAgentUserId = '')`);
      await log(db, "agent_attach", "employee", e.id, `[Sync] Agente Multipark ${a.agentUserId} "${name}" <${a.agentEmail}> anexado automaticamente à ficha #${e.id} ${e.fullName} (mesmo email)`);
      linkedAgentIds.add(a.agentUserId);
      attached++;
    } catch { /* best-effort */ }
  }
  return attached;
}
