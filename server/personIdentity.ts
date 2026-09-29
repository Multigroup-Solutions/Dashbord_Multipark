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
  const hits = agents.filter((a) => textMatches(`${a.agentName ?? ""} ${a.email ?? ""}`, q)).sort((a, b) => b.total - a.total).slice(0, limit);
  const owners = new Map<string, { id: number; fullName: string }>();
  if (hits.length) {
    const ids = hits.map((h) => h.agentUserId);
    for (const r of rowsOf(await d.execute(sql`SELECT e.id, e.fullName, e.multiparkAgentUserId AS agentUserId FROM employees e WHERE e.multiparkAgentUserId IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
      UNION ALL SELECT e.id, e.fullName, a.agentUserId FROM employee_agents a JOIN employees e ON e.id = a.employeeId WHERE a.agentUserId IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`).catch(() => [[]]))) {
      owners.set(String(r.agentUserId), { id: Number(r.id), fullName: String(r.fullName) });
    }
  }
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

/** Agentes de teste (saem da lista dos "por ligar"; não saem da Multipark). PURA. */
export function looksLikeTestAgent(name: string | null | undefined, email?: string | null): boolean {
  const text = `${name ?? ""} ${email ?? ""}`;
  const words = matchWords(text);
  return words.some((w) => /^(teste?s?|tests?|testing|demo|dummy|fake|qa|sandbox)\d*$/.test(w)) || /\b(teste?|test|demo)\b/i.test(String(email ?? "").split("@")[0].replace(/[._-]/g, " "));
}
