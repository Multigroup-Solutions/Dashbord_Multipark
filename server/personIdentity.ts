/**
 * Uma pessoa (ficha) e as suas identidades: contas de login (principal + extra)
 * e agentes da Multipark (principal + extra). Para o ecrã RH → Ligações:
 * ver tudo de uma ficha, anexar/retirar agentes à mão e juntar contas.
 */
import { sql } from "drizzle-orm";
import { matchWords, textMatches } from "../shared/textKey";

type Db = { execute: (q: any) => Promise<any> };
const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r?.rows ?? r) as any[]) ?? [];

async function database(): Promise<Db> {
  const { getDb } = await import("./db");
  const d = await getDb();
  if (!d) throw new Error("BD indisponível");
  return d as unknown as Db;
}

export interface PersonIdentity {
  employee: { id: number; fullName: string; email: string | null; personalEmail: string | null; isActive: boolean };
  accounts: Array<{ userId: number; name: string | null; email: string | null; role: string; isActive: boolean; principal: boolean; lastSignedIn: string | null }>;
  agents: Array<{ agentUserId: string | null; agentName: string | null; email: string | null; principal: boolean }>;
}

export async function getPersonIdentity(employeeId: number): Promise<PersonIdentity | null> {
  const d = await database();
  const e = rowsOf(await d.execute(sql`SELECT id, fullName, email, personalEmail, isActive, userId, multiparkAgentUserId, multiparkAgentName FROM employees WHERE id = ${employeeId} LIMIT 1`))[0];
  if (!e) return null;
  const accRows = rowsOf(await d.execute(sql`SELECT u.id, u.name, u.email, u.role, u.isActive, DATE_FORMAT(u.lastSignedIn, '%Y-%m-%d %H:%i') AS lastSignedIn, 1 AS principal
      FROM users u WHERE u.id = ${e.userId ?? 0}
    UNION ALL
    SELECT u.id, u.name, u.email, u.role, u.isActive, DATE_FORMAT(u.lastSignedIn, '%Y-%m-%d %H:%i'), 0 FROM employee_accounts a JOIN users u ON u.id = a.userId WHERE a.employeeId = ${employeeId}`).catch(() => [[]]));
  const agentRows = rowsOf(await d.execute(sql`SELECT agentUserId, agentName FROM employee_agents WHERE employeeId = ${employeeId}`).catch(() => [[]]));
  const ids = [e.multiparkAgentUserId, ...agentRows.map((a) => a.agentUserId)].filter(Boolean).map(String);
  // Emails dos agentes: ao vivo da Multipark; a cópia antiga só para os que lá não aparecem.
  const emails = new Map<string, string | null>();
  if (ids.length) {
    const { listLiveAgents } = await import("./multiparkDb/activityLive");
    const live = await listLiveAgents().catch(() => ({ available: false as const }));
    if (live.available) for (const a of (live as any).data as Array<{ agentUserId: string; email: string | null }>) if (ids.includes(a.agentUserId) && a.email) emails.set(a.agentUserId, a.email);
    const missing = ids.filter((i) => !emails.has(i));
    if (missing.length) {
      for (const r of rowsOf(await d.execute(sql`SELECT agentUserId, email FROM multipark_agents WHERE agentUserId IN (${sql.join(missing.map((i) => sql`${i}`), sql`, `)})`).catch(() => [[]]))) {
        if (r.email) emails.set(String(r.agentUserId), r.email);
      }
    }
  }
  const agents: PersonIdentity["agents"] = [];
  if (e.multiparkAgentUserId || e.multiparkAgentName) {
    agents.push({ agentUserId: e.multiparkAgentUserId ? String(e.multiparkAgentUserId) : null, agentName: e.multiparkAgentName ?? null, email: e.multiparkAgentUserId ? emails.get(String(e.multiparkAgentUserId)) ?? null : null, principal: true });
  }
  for (const a of agentRows) agents.push({ agentUserId: String(a.agentUserId), agentName: a.agentName ?? null, email: emails.get(String(a.agentUserId)) ?? null, principal: false });
  return {
    employee: { id: Number(e.id), fullName: String(e.fullName), email: e.email ?? null, personalEmail: e.personalEmail ?? null, isActive: Number(e.isActive) === 1 },
    accounts: accRows.map((u) => ({ userId: Number(u.id), name: u.name ?? null, email: u.email ?? null, role: String(u.role), isActive: Number(u.isActive) === 1, principal: Number(u.principal) === 1, lastSignedIn: u.lastSignedIn ?? null })),
    agents,
  };
}

export interface EmployeeLogin { userId: number; name: string | null; email: string | null; role: string; isActive: boolean; principal: boolean; lastSignedIn: string | null; loginMethod: string | null }

/** Lote 46: as contas de login de uma ficha (principal + extra), sem ler a Multipark. */
export async function listEmployeeLogins(employeeId: number): Promise<EmployeeLogin[]> {
  const d = await database();
  const rows = rowsOf(await d.execute(sql`SELECT u.id, u.name, u.email, u.role, u.isActive, u.loginMethod, DATE_FORMAT(u.lastSignedIn, '%Y-%m-%d %H:%i') AS lastSignedIn, 1 AS principal
      FROM employees e JOIN users u ON u.id = e.userId WHERE e.id = ${employeeId}
    UNION ALL
    SELECT u.id, u.name, u.email, u.role, u.isActive, u.loginMethod, DATE_FORMAT(u.lastSignedIn, '%Y-%m-%d %H:%i'), 0 FROM employee_accounts a JOIN users u ON u.id = a.userId WHERE a.employeeId = ${employeeId}`).catch(() => [[]]));
  return rows.map((u) => ({ userId: Number(u.id), name: u.name ?? null, email: u.email ?? null, role: String(u.role ?? "user"), isActive: Number(u.isActive) === 1,
    principal: Number(u.principal) === 1, lastSignedIn: u.lastSignedIn ?? null, loginMethod: u.loginMethod ?? null }));
}

/**
 * Lote 46: contas que ENTRARAM com a Google e não têm ficha (nem como conta
 * extra) e que parecem ser a pessoa desta ficha (mesmo email ou dois nomes em
 * comum — shared/ownAccess.ts). Só sugestões, as mais recentes primeiro.
 */
export async function orphanLoginCandidates(ficha: { fullName: string; emails: string[] }, limit = 5): Promise<Array<{ userId: number; name: string | null; email: string | null; lastSignedIn: string | null; reason: string }>> {
  const d = await database();
  const rows = rowsOf(await d.execute(sql`SELECT u.id, u.name, u.email, DATE_FORMAT(u.lastSignedIn, '%Y-%m-%d %H:%i') AS lastSignedIn FROM users u
    WHERE u.isActive = 1 AND u.loginMethod = 'google'
      AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.userId = u.id)
      AND NOT EXISTS (SELECT 1 FROM employee_accounts a WHERE a.userId = u.id)
    ORDER BY u.lastSignedIn DESC LIMIT 1000`).catch(() => [[]]));
  const { loginCandidateReason } = await import("../shared/ownAccess");
  const out: Array<{ userId: number; name: string | null; email: string | null; lastSignedIn: string | null; reason: string }> = [];
  for (const u of rows) {
    const reason = loginCandidateReason(ficha, { name: u.name ?? null, email: u.email ?? null });
    if (reason) out.push({ userId: Number(u.id), name: u.name ?? null, email: u.email ?? null, lastSignedIn: u.lastSignedIn ?? null, reason });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Ficha de cada agente da Multipark pelo ID (agente principal da ficha ou
 * agente extra) — a ligação explícita, nunca pelo nome. Sem ficha → fora do mapa.
 */
export async function employeesForAgentIds(ids: readonly string[]): Promise<Map<string, { id: number; fullName: string }>> {
  const out = new Map<string, { id: number; fullName: string }>();
  const clean = Array.from(new Set(ids.filter(Boolean)));
  if (!clean.length) return out;
  const d = await database();
  const list = sql.join(clean.map((i) => sql`${i}`), sql`, `);
  // Duas leituras em vez de UNION: employees e employee_agents têm colações
  // diferentes em produção e o UNION rebentava (ER_CANT_AGGREGATE_NCOLLATIONS,
  // Reclamações/Perdidos sem agentes desde 4 out 2026). O agente principal ganha.
  const principal = rowsOf(await d.execute(sql`SELECT e.id, e.fullName, e.multiparkAgentUserId AS agentUserId FROM employees e WHERE e.multiparkAgentUserId IN (${list})`));
  const extra = rowsOf(await d.execute(sql`SELECT e.id, e.fullName, a.agentUserId FROM employee_agents a JOIN employees e ON e.id = a.employeeId WHERE a.agentUserId IN (${list})`));
  for (const r of [...principal, ...extra]) {
    if (!out.has(String(r.agentUserId))) out.set(String(r.agentUserId), { id: Number(r.id), fullName: String(r.fullName) });
  }
  return out;
}

/** Procurar agentes da Multipark (ao vivo; a cópia local só se a BD deles falhar). Regra única de texto. */
export async function searchAgents(q: string, limit = 30) {
  const d = await database();
  const { listLiveAgents } = await import("./multiparkDb/activityLive");
  const live = await listLiveAgents();
  let agents: Array<{ agentUserId: string; agentName: string | null; email: string | null; active: boolean; total: number; lastSeen: string | null }> = [];
  if (live.available) agents = live.data.map((a) => ({ agentUserId: a.agentUserId, agentName: a.agentName, email: a.email, active: a.active, total: a.total, lastSeen: a.lastSeen }));
  else {
    agents = rowsOf(await d.execute(sql`SELECT agentUserId, agentName, email, active FROM multipark_agents LIMIT 10000`).catch(() => [[]]))
      .map((r) => ({ agentUserId: String(r.agentUserId), agentName: r.agentName ?? null, email: r.email ?? null, active: Number(r.active) === 1, total: 0, lastSeen: null }));
  }
  const { isSystemAgentId } = await import("../shared/agentIdentity");
  agents = agents.filter((a) => !isSystemAgentId(a.agentUserId));
  const hits = agents.filter((a) => textMatches(`${a.agentName ?? ""} ${a.email ?? ""}`, q)).sort((a, b) => b.total - a.total).slice(0, limit);
  // A mesma leitura das fichas (sem UNION); falhar não esconde os agentes, só as fichas.
  const owners = hits.length
    ? await employeesForAgentIds(hits.map((h) => h.agentUserId)).catch(() => new Map<string, { id: number; fullName: string }>())
    : new Map<string, { id: number; fullName: string }>();
  return hits.map((a) => ({ ...a, employeeId: owners.get(a.agentUserId)?.id ?? null, employeeName: owners.get(a.agentUserId)?.fullName ?? null, fromCopy: !live.available }));
}

/**
 * Retirar um agente de uma ficha (principal ou extra). Se era o principal e
 * havia agentes extra, o primeiro extra passa a principal.
 */
export async function detachAgent(employeeId: number, agentUserId: string): Promise<void> {
  const d = await database();
  const e = rowsOf(await d.execute(sql`SELECT multiparkAgentUserId FROM employees WHERE id = ${employeeId} LIMIT 1`))[0];
  if (!e) throw new Error("Ficha não encontrada.");
  if (String(e.multiparkAgentUserId ?? "") === agentUserId) {
    const next = rowsOf(await d.execute(sql`SELECT agentUserId, agentName FROM employee_agents WHERE employeeId = ${employeeId} ORDER BY agentUserId LIMIT 1`))[0];
    if (next) {
      await d.execute(sql`UPDATE employees SET multiparkAgentUserId = ${next.agentUserId}, multiparkAgentName = ${next.agentName ?? null} WHERE id = ${employeeId}`);
      await d.execute(sql`DELETE FROM employee_agents WHERE agentUserId = ${next.agentUserId}`);
    } else {
      await d.execute(sql`UPDATE employees SET multiparkAgentUserId = NULL, multiparkAgentName = NULL WHERE id = ${employeeId}`);
    }
    return;
  }
  await d.execute(sql`DELETE FROM employee_agents WHERE agentUserId = ${agentUserId} AND employeeId = ${employeeId}`);
}

/**
 * 41a: separar uma conta de login da ficha (principal ou extra). A conta não é
 * apagada nem desativada — só deixa de estar ligada. Se era a principal e havia
 * contas extra, a primeira extra passa a principal (como nos agentes).
 */
export async function detachAccount(employeeId: number, userId: number): Promise<"principal" | "extra"> {
  const d = await database();
  const e = rowsOf(await d.execute(sql`SELECT userId FROM employees WHERE id = ${employeeId} LIMIT 1`))[0];
  if (!e) throw new Error("Ficha não encontrada.");
  if (Number(e.userId ?? 0) === userId) {
    const next = rowsOf(await d.execute(sql`SELECT userId FROM employee_accounts WHERE employeeId = ${employeeId} ORDER BY userId LIMIT 1`))[0];
    if (next) {
      await d.execute(sql`UPDATE employees SET userId = ${Number(next.userId)} WHERE id = ${employeeId}`);
      await d.execute(sql`DELETE FROM employee_accounts WHERE userId = ${Number(next.userId)}`);
    } else {
      await d.execute(sql`UPDATE employees SET userId = NULL WHERE id = ${employeeId}`);
    }
    return "principal";
  }
  const alias = rowsOf(await d.execute(sql`SELECT userId FROM employee_accounts WHERE userId = ${userId} AND employeeId = ${employeeId} LIMIT 1`))[0];
  if (!alias) throw new Error("Essa conta não está ligada a esta ficha.");
  await d.execute(sql`DELETE FROM employee_accounts WHERE userId = ${userId} AND employeeId = ${employeeId}`);
  return "extra";
}

/** 41a: o endereço do agente na Multipark a partir do modelo das Definições ({id}). PURA. */
/**
 * 41a: a conta e a ficha andam juntas ("inativamos a estrutura dos dois
 * lados"). Fichas onde esta conta é a PRINCIPAL e que mudam com ela: ao
 * desativar, as ativas que não têm outra conta ativa (se a pessoa ainda entra
 * por uma conta extra, a ficha fica); ao reativar, as inativas. Os agentes da
 * Multipark e as ligações ficam sempre como estão. Só leitura.
 */
export async function employeesFollowingAccount(userId: number, isActive: boolean): Promise<Array<{ id: number; fullName: string }>> {
  const d = await database();
  const rows = rowsOf(await d.execute(sql`SELECT e.id, e.fullName FROM employees e
      WHERE e.userId = ${userId} AND e.isActive = ${isActive ? 0 : 1}
        ${isActive ? sql`` : sql`AND NOT EXISTS (SELECT 1 FROM employee_accounts a JOIN users u ON u.id = a.userId
          WHERE a.employeeId = e.id AND a.userId <> ${userId} AND u.isActive = 1)`}`).catch(() => [[]]));
  return rows.map((r) => ({ id: Number(r.id), fullName: String(r.fullName ?? "") }));
}

/** 41a: contas extra ATIVAS de uma ficha (para desativarem com ela). Só leitura. */
export async function activeExtraAccounts(employeeId: number): Promise<number[]> {
  const d = await database();
  const rows = rowsOf(await d.execute(sql`SELECT a.userId FROM employee_accounts a JOIN users u ON u.id = a.userId
      WHERE a.employeeId = ${employeeId} AND u.isActive = 1`).catch(() => [[]]));
  return rows.map((r) => Number(r.userId)).filter((n) => n > 0);
}

/**
 * 41a: fichas ativas para a sugestão de suspensão — o último login de todas
 * as contas da ficha e o papel mais alto (admin+ não se bloqueiam). Só as que
 * ainda não estão bloqueadas à mão. Só leitura.
 */
export async function suspendRows(): Promise<import("../shared/suspendSuggest").SuspendRow[]> {
  const d = await database();
  const rows = rowsOf(await d.execute(sql`SELECT e.id, e.fullName, e.position, e.projectId, p.name AS projectName,
        DATE_FORMAT(e.createdAt, '%Y-%m-%d') AS createdAt,
        DATE_FORMAT(GREATEST(COALESCE(u.lastSignedIn, '1970-01-01'), COALESCE((SELECT MAX(xu.lastSignedIn) FROM employee_accounts xa JOIN users xu ON xu.id = xa.userId WHERE xa.employeeId = e.id), '1970-01-01')), '%Y-%m-%d') AS lastLogin,
        u.role AS role
      FROM employees e LEFT JOIN users u ON u.id = e.userId LEFT JOIN projects p ON p.id = e.projectId
      WHERE e.isActive = 1 AND COALESCE(e.blockedManually, 0) = 0`));
  return rows.map((r) => ({
    employeeId: Number(r.id), fullName: String(r.fullName ?? ""), position: r.position ? String(r.position) : null,
    projectName: r.projectName ? String(r.projectName) : null, createdAt: r.createdAt ? String(r.createdAt) : null,
    lastLogin: r.lastLogin && r.lastLogin !== "1970-01-01" ? String(r.lastLogin) : null,
    topRole: r.role ? String(r.role) : null,
    projectId: r.projectId == null ? null : Number(r.projectId),
  }));
}

/** 41a: suspender = bloqueio manual (reversível com "Desbloquear" no RH). Não desativa nada. */
export async function suspendEmployee(employeeId: number, reason: string): Promise<boolean> {
  const d = await database();
  const r = rowsOf(await d.execute(sql`SELECT id, userId, isActive, blockedManually FROM employees WHERE id = ${employeeId} LIMIT 1`))[0];
  if (!r || Number(r.isActive) !== 1 || Number(r.blockedManually) === 1) return false;
  await d.execute(sql`UPDATE employees SET blockedManually = 1, loginBlockedReason = ${reason.slice(0, 200)} WHERE id = ${employeeId}`);
  const { recomputeLoginBlocked } = await import("./rhService");
  await recomputeLoginBlocked(employeeId);
  const { invalidateLoginBlock } = await import("./loginBlock");
  invalidateLoginBlock(r.userId == null ? undefined : Number(r.userId));
  return true;
}

export function multiparkAgentUrl(template: string | null | undefined, agentUserId: string | null | undefined): string | null {
  const t = String(template ?? "").trim();
  if (!t || !agentUserId || !t.includes("{id}") || !/^https:\/\//.test(t)) return null;
  return t.split("{id}").join(encodeURIComponent(String(agentUserId)));
}

/** Agentes de teste (saem da lista dos "por ligar"; não saem da Multipark). PURA. */
export function looksLikeTestAgent(name: string | null | undefined, email?: string | null): boolean {
  const text = `${name ?? ""} ${email ?? ""}`;
  const words = matchWords(text);
  return words.some((w) => /^(teste?s?|tests?|testing|demo|dummy|fake|qa|sandbox)\d*$/.test(w)) || /\b(teste?|test|demo)\b/i.test(String(email ?? "").split("@")[0].replace(/[._-]/g, " "));
}

/** IDs dos agentes da Multipark ligados a uma ficha (principal + extra), sem ir à Multipark. */
export async function agentIdsOfEmployee(employeeId: number): Promise<{ fullName: string | null; agentUserIds: string[] }> {
  const d = await database();
  const e = rowsOf(await d.execute(sql`SELECT fullName, multiparkAgentUserId FROM employees WHERE id = ${employeeId} LIMIT 1`))[0];
  if (!e) return { fullName: null, agentUserIds: [] };
  const extra = rowsOf(await d.execute(sql`SELECT agentUserId FROM employee_agents WHERE employeeId = ${employeeId}`).catch(() => [[]]));
  const ids = [e.multiparkAgentUserId, ...extra.map((a) => a.agentUserId)].filter((x) => x != null && String(x).trim()).map(String);
  return { fullName: e.fullName ?? null, agentUserIds: Array.from(new Set(ids)) };
}

/**
 * Fichas com pelo menos um agente da Multipark ligado (para escolher "a pessoa"
 * em vez de escrever o nome — D27). `projectIds` = âmbito de cidade (undefined = todas).
 */
export async function employeesWithAgents(projectIds?: readonly number[]): Promise<Array<{ id: number; fullName: string; isActive: boolean; agents: number }>> {
  const d = await database();
  const rows = rowsOf(await d.execute(sql`SELECT e.id, e.fullName, e.isActive, e.projectId,
      (CASE WHEN e.multiparkAgentUserId IS NULL OR e.multiparkAgentUserId = '' THEN 0 ELSE 1 END)
        + (SELECT COUNT(*) FROM employee_agents a WHERE a.employeeId = e.id) AS agents
    FROM employees e
    WHERE (e.multiparkAgentUserId IS NOT NULL AND e.multiparkAgentUserId <> '') OR EXISTS (SELECT 1 FROM employee_agents a WHERE a.employeeId = e.id)
    ORDER BY e.isActive DESC, e.fullName ASC LIMIT 3000`));
  const allowed = projectIds ? new Set(projectIds) : null;
  return rows
    .filter((r) => !allowed || (r.projectId != null && allowed.has(Number(r.projectId))))
    .map((r) => ({ id: Number(r.id), fullName: String(r.fullName ?? ""), isActive: Number(r.isActive) === 1, agents: Number(r.agents ?? 0) }));
}
