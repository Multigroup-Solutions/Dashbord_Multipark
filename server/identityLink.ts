/**
 * Ligações automáticas FUNCIONÁRIO ↔ UTILIZADOR ↔ AGENTE MULTIPARK (Fase 1,
 * Jorge 24 set 2026). A ficha é o centro: o utilizador (login) liga-se pela
 * conta (`employees.userId`) e o agente pela identidade Multipark
 * (`multiparkAgentUserId` = id, fiável; `multiparkAgentName` = nome, legado).
 *
 * `runIdentitySweep` corre de hora a hora (a seguir ao sync) e faz, por ordem:
 *  1. fichas ativas sem utilizador → liga/cria pelo email (ensureUserForEmployee)
 *  2. utilizadores ativos sem ficha → liga fichas pelo email de trabalho OU pessoal
 *  3. fichas ligadas só pelo NOME do agente → completa o id (se o nome for de um só agente)
 *  4. agentes por ligar → pelo email (trabalho ou pessoal) — autoAttachAgentsByEmail
 *  5. agentes por ligar → pelo nome ("primeiro + último" ou completo), só se único
 *     dos dois lados
 * Tudo conservador: nada é sobrescrito; os casos ambíguos ficam para o ecrã
 * de Ligações (Fase 4).
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";

// ─── Puros ──────────────────────────────────────────────────────────────────

export function normName(s: string | null | undefined): string {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Chaves de nome de uma ficha: completo e "primeiro + último" (formato da Multipark). */
export function nameKeys(fullName: string): string[] {
  const n = normName(fullName);
  if (!n) return [];
  const parts = n.split(" ");
  const short = parts.length > 2 ? `${parts[0]} ${parts[parts.length - 1]}` : n;
  return short === n ? [n] : [n, short];
}

export interface AgentSeen { id: string; name: string | null; count: number }
export interface EmpLite { id: number; fullName: string; active: boolean; agentName: string | null; agentUserId: string | null }

/**
 * Fichas ligadas só pelo nome → id do agente, quando esse nome pertence a UM
 * só agente e esse agente não está ligado a outra ficha. PURA.
 */
export function planAgentIdFill(emps: EmpLite[], agents: AgentSeen[]): { employeeId: number; agentUserId: string }[] {
  const idsByName = new Map<string, Set<string>>();
  for (const a of agents) {
    const k = normName(a.name);
    if (!k) continue;
    const s = idsByName.get(k) ?? new Set<string>();
    s.add(a.id);
    idsByName.set(k, s);
  }
  const linked = new Set(emps.map((e) => e.agentUserId).filter(Boolean) as string[]);
  const out: { employeeId: number; agentUserId: string }[] = [];
  for (const e of emps) {
    if (e.agentUserId || !e.agentName) continue;
    const ids = idsByName.get(normName(e.agentName));
    if (!ids || ids.size !== 1) continue;
    const id = [...ids][0];
    if (linked.has(id)) continue;
    linked.add(id);
    out.push({ employeeId: e.id, agentUserId: id });
  }
  return out;
}

/**
 * Agentes por ligar → ficha pelo nome. Só liga quando o nome do agente bate
 * com UMA ficha ativa sem agente (nome completo ou "primeiro + último") e
 * nenhum outro agente por ligar tem o mesmo nome. PURA.
 */
export function planNameAttach(agents: AgentSeen[], emps: EmpLite[]): { employeeId: number; agentUserId: string; agentName: string }[] {
  const linkedIds = new Set(emps.map((e) => e.agentUserId).filter(Boolean) as string[]);
  const linkedNames = new Set(emps.map((e) => normName(e.agentName)).filter(Boolean));
  const free = agents.filter((a) => a.name && !linkedIds.has(a.id) && !linkedNames.has(normName(a.name)));
  const agentsByKey = new Map<string, AgentSeen[]>();
  for (const a of free) {
    const k = normName(a.name);
    agentsByKey.set(k, [...(agentsByKey.get(k) ?? []), a]);
  }
  const empsByKey = new Map<string, EmpLite[]>();
  for (const e of emps) {
    if (!e.active || e.agentUserId || e.agentName) continue;
    for (const k of nameKeys(e.fullName)) empsByKey.set(k, [...(empsByKey.get(k) ?? []), e]);
  }
  const out: { employeeId: number; agentUserId: string; agentName: string }[] = [];
  const usedEmp = new Set<number>();
  for (const [k, list] of agentsByKey) {
    if (list.length !== 1) continue;
    const cands = (empsByKey.get(k) ?? []).filter((e, i, arr) => arr.findIndex((x) => x.id === e.id) === i);
    if (cands.length !== 1 || usedEmp.has(cands[0].id)) continue;
    usedEmp.add(cands[0].id);
    out.push({ employeeId: cands[0].id, agentUserId: list[0].id, agentName: list[0].name! });
  }
  return out;
}

// ─── I/O ────────────────────────────────────────────────────────────────────

const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r) as any[]) ?? [];

/** Id do agente Multipark para um nome (o mais usado nos últimos 180 dias). */
export async function agentIdForName(name: string): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const [r] = rowsOf(await db.execute(sql`
    SELECT agentUserId, COUNT(*) AS n FROM multipark_booking_history
     WHERE agentName = ${name} AND agentUserId IS NOT NULL AND agentUserId <> ''
     GROUP BY agentUserId ORDER BY n DESC LIMIT 1`));
  return r?.agentUserId ? String(r.agentUserId) : null;
}

async function logLink(action: string, entityId: number, details: string) {
  try {
    const { logActivity } = await import("./db");
    await logActivity({ userId: 0, action, entity: "employee", entityId, details });
  } catch { /* segue */ }
}

export interface SweepReport { usersLinked: number; usersCreated: number; employeesLinkedToUsers: number; agentIdsFilled: number; agentsByEmail: number; agentsByName: number; agentAliases: number; errors: string[] }

export async function runIdentitySweep(): Promise<SweepReport> {
  const rep: SweepReport = { usersLinked: 0, usersCreated: 0, employeesLinkedToUsers: 0, agentIdsFilled: 0, agentsByEmail: 0, agentsByName: 0, agentAliases: 0, errors: [] };
  const { listAgentAliases, addAgentAlias } = await import("./employeeAliases");
  const aliasAgentIds = new Set((await listAgentAliases()).map((a) => a.agentUserId));
  const db = await getDb();
  if (!db) return rep;
  const { ensureUserForEmployee, linkEmployeesToUserByEmail } = await import("./identity");

  // 1. Fichas ativas sem utilizador
  try {
    const noUser = rowsOf(await db.execute(sql`
      SELECT id, fullName, email, position, userId FROM employees
       WHERE isActive = 1 AND userId IS NULL AND email IS NOT NULL AND email <> ''`));
    for (const e of noUser) {
      const r = await ensureUserForEmployee(db as any, { id: Number(e.id), fullName: String(e.fullName), email: e.email, position: String(e.position ?? ""), userId: null });
      if (r.userId) r.created ? rep.usersCreated++ : rep.usersLinked++;
    }
  } catch (err: any) { rep.errors.push(`fichas sem utilizador: ${err?.message ?? err}`); }

  // 2. Utilizadores ativos sem ficha → fichas com o mesmo email (trabalho ou pessoal)
  try {
    let orphans: any[];
    try {
      orphans = rowsOf(await db.execute(sql`
        SELECT u.id, u.email FROM users u
         WHERE u.isActive = 1 AND u.email IS NOT NULL AND u.email <> ''
           AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.userId = u.id)
           AND NOT EXISTS (SELECT 1 FROM employee_accounts a WHERE a.userId = u.id)`));
    } catch {
      orphans = rowsOf(await db.execute(sql`
        SELECT u.id, u.email FROM users u
         WHERE u.isActive = 1 AND u.email IS NOT NULL AND u.email <> ''
           AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.userId = u.id)`));
    }
    for (const u of orphans) rep.employeesLinkedToUsers += (await linkEmployeesToUserByEmail(db as any, Number(u.id), String(u.email))).length;
  } catch (err: any) { rep.errors.push(`utilizadores sem ficha: ${err?.message ?? err}`); }

  // Agentes vistos (últimos 180 dias) e fichas
  let agents: AgentSeen[] = [];
  let emps: EmpLite[] = [];
  const loadEmps = async () => {
    emps = rowsOf(await db.execute(sql`SELECT id, fullName, isActive, multiparkAgentName, multiparkAgentUserId FROM employees`)).map((r) => ({
      id: Number(r.id),
      fullName: String(r.fullName ?? ""),
      active: Number(r.isActive) === 1,
      agentName: r.multiparkAgentName ? String(r.multiparkAgentName) : null,
      agentUserId: r.multiparkAgentUserId ? String(r.multiparkAgentUserId).trim() || null : null,
    }));
  };
  try {
    agents = rowsOf(await db.execute(sql`
      SELECT agentUserId AS id, agentName AS name, COUNT(*) AS n FROM multipark_booking_history
       WHERE agentUserId IS NOT NULL AND agentUserId <> '' AND actionTime >= NOW() - INTERVAL 180 DAY
       GROUP BY agentUserId, agentName`)).map((r) => ({ id: String(r.id), name: r.name ? String(r.name) : null, count: Number(r.n) }))
      .filter((a) => !aliasAgentIds.has(a.id)); // agentes EXTRA já estão ligados
    await loadEmps();
  } catch (err: any) { rep.errors.push(`carregar agentes: ${err?.message ?? err}`); return rep; }

  // 3. Fichas ligadas só pelo nome → completar o id
  try {
    for (const f of planAgentIdFill(emps, agents)) {
      await db.execute(sql`UPDATE employees SET multiparkAgentUserId = ${f.agentUserId}
                            WHERE id = ${f.employeeId} AND (multiparkAgentUserId IS NULL OR multiparkAgentUserId = '')`);
      await logLink("agent_attach", f.employeeId, `[Ligações] id do agente Multipark ${f.agentUserId} completado pelo nome já ligado`);
      rep.agentIdsFilled++;
    }
  } catch (err: any) { rep.errors.push(`completar id do agente: ${err?.message ?? err}`); }

  // 4. Por email (trabalho ou pessoal)
  try {
    const seen = rowsOf(await db.execute(sql`
      SELECT agentUserId, MAX(agentName) AS agentName, MAX(agentEmail) AS agentEmail FROM multipark_booking_history
       WHERE agentUserId IS NOT NULL AND agentUserId <> '' AND agentEmail IS NOT NULL AND agentEmail <> ''
         AND actionTime >= NOW() - INTERVAL 180 DAY
       GROUP BY agentUserId`)).map((r) => ({ agentUserId: String(r.agentUserId), agentName: r.agentName ? String(r.agentName) : null, agentEmail: String(r.agentEmail) }));
    const { autoAttachAgentsByEmail } = await import("./identityReconcile");
    rep.agentsByEmail = await autoAttachAgentsByEmail(db as any, seen.filter((s) => !aliasAgentIds.has(s.agentUserId)) as any);

    // 4b. Segundo agente da mesma pessoa: email de uma ficha ativa que JÁ tem
    // outro agente → entra como agente EXTRA (várias contas Multipark)
    const fichas = rowsOf(await db.execute(sql`
      SELECT e.id, e.multiparkAgentUserId AS agentId,
             LOWER(TRIM(COALESCE(NULLIF(e.email, ''), u.email))) AS email, LOWER(TRIM(e.personalEmail)) AS personalEmail
        FROM employees e LEFT JOIN users u ON u.id = e.userId WHERE e.isActive = 1`));
    const linkedIds = new Set(fichas.map((f) => String(f.agentId ?? "").trim()).filter(Boolean));
    for (const a of seen) {
      if (linkedIds.has(a.agentUserId) || aliasAgentIds.has(a.agentUserId)) continue;
      const email = a.agentEmail.trim().toLowerCase();
      const m = fichas.filter((f) => f.email === email || (f.personalEmail && f.personalEmail === email));
      if (m.length !== 1 || !m[0].agentId) continue;
      await addAgentAlias(Number(m[0].id), a.agentUserId, a.agentName);
      aliasAgentIds.add(a.agentUserId);
      await logLink("agent_attach", Number(m[0].id), `[Ligações] agente Multipark ${a.agentUserId} "${a.agentName ?? ""}" junto como agente EXTRA (mesmo email)`);
      rep.agentAliases++;
    }
  } catch (err: any) { rep.errors.push(`agentes por email: ${err?.message ?? err}`); }

  // 5. Por nome, só quando é inequívoco
  try {
    await loadEmps();
    for (const a of planNameAttach(agents, emps)) {
      await db.execute(sql`UPDATE employees SET multiparkAgentUserId = ${a.agentUserId}, multiparkAgentName = ${a.agentName.slice(0, 256)}
                            WHERE id = ${a.employeeId} AND (multiparkAgentUserId IS NULL OR multiparkAgentUserId = '')
                              AND (multiparkAgentName IS NULL OR multiparkAgentName = '')`);
      await logLink("agent_attach", a.employeeId, `[Ligações] agente Multipark ${a.agentUserId} "${a.agentName}" ligado pelo nome (único)`);
      rep.agentsByName++;
    }
  } catch (err: any) { rep.errors.push(`agentes por nome: ${err?.message ?? err}`); }

  return rep;
}
