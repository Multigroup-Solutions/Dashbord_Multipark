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
 *  6. (31b) o resto dos agentes com o email de UMA só ficha ativa, pelo cruzamento
 *     Agentes × pessoas (server/agentCrossCheck.ts) — interruptor AGENT_EMAIL_AUTOLINK
 * Tudo conservador: nada é sobrescrito; os casos ambíguos ficam para o ecrã
 * de Ligações (Fase 4).
 *
 * Os agentes (ids, nomes, emails) são lidos AO VIVO da BD da Multipark
 * (server/multiparkDb/activityLive.ts): a cópia `multipark_booking_history`
 * deixou de ser alimentada no PR #141 e só serve quando a BD deles falha.
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { searchText } from "../shared/textKey";
import { cleanAgentName, isLinkableAgent, isSystemAgentId } from "../shared/agentIdentity";

// ─── Puros ──────────────────────────────────────────────────────────────────

export function normName(s: string | null | undefined): string {
  // Regra única (shared/textKey.ts): sem acentos, maiúsculas, apóstrofos nem traços.
  return searchText(s);
}

/**
 * Chaves de nome de uma ficha: completo, "primeiro + último" e "primeiro +
 * qualquer apelido" (na Multipark a pessoa escreve "Bruno Meireles" e a ficha
 * é "Bruno Filipe Meireles Silva"). Só liga quando a chave é única dos dois lados.
 */
export function nameKeys(fullName: string): string[] {
  const n = normName(fullName);
  if (!n) return [];
  const parts = n.split(" ").filter((p) => p.length > 1 || /\d/.test(p));
  const keys = new Set<string>([n]);
  if (parts.length > 2) {
    keys.add(`${parts[0]} ${parts[parts.length - 1]}`);
    for (const p of parts.slice(1)) if (!["da", "de", "do", "das", "dos", "e"].includes(p)) keys.add(`${parts[0]} ${p}`);
  }
  return [...keys];
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
    const k = normName(cleanAgentName(a.name));
    if (!k) continue;
    const s = idsByName.get(k) ?? new Set<string>();
    s.add(a.id);
    idsByName.set(k, s);
  }
  const linked = new Set(emps.map((e) => e.agentUserId).filter(Boolean) as string[]);
  const out: { employeeId: number; agentUserId: string }[] = [];
  for (const e of emps) {
    if (e.agentUserId || !e.agentName) continue;
    const ids = idsByName.get(normName(cleanAgentName(e.agentName)));
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
  const linkedNames = new Set(emps.map((e) => normName(cleanAgentName(e.agentName))).filter(Boolean));
  const free = agents.filter((a) => a.name && !linkedIds.has(a.id) && !linkedNames.has(normName(cleanAgentName(a.name))));
  const agentsByKey = new Map<string, AgentSeen[]>();
  for (const a of free) {
    const k = normName(cleanAgentName(a.name));
    agentsByKey.set(k, [...(agentsByKey.get(k) ?? []), a]);
  }
  const empsByKey = new Map<string, EmpLite[]>();
  for (const e of emps) {
    if (!e.active || e.agentUserId || e.agentName) continue;
    for (const k of nameKeys(e.fullName)) empsByKey.set(k, [...(empsByKey.get(k) ?? []), e]);
  }
  const out: { employeeId: number; agentUserId: string; agentName: string }[] = [];
  const usedEmp = new Set<number>();
  for (const [k, all] of agentsByKey) {
    // o mesmo agente pode vir com vários nomes que dão a mesma chave
    const list = all.filter((a, i, arr) => arr.findIndex((x) => x.id === a.id) === i);
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

/**
 * Id do agente Multipark para um nome (o mais usado nos últimos 180 dias),
 * lido AO VIVO da BD da Multipark ("History" + "Agent"). A cópia local
 * `multipark_booking_history` (já não alimentada desde o PR #141) só serve
 * quando a BD da Multipark não responde.
 */
export async function agentIdForName(name: string): Promise<string | null> {
  const { findAgentIdForNameLive } = await import("./multiparkDb/activityLive");
  const live = await findAgentIdForNameLive(name);
  if (live.available) return live.data;
  console.warn(`[identityLink] id do agente pelo nome: BD da Multipark indisponível (${live.code}) — a usar a cópia local.`);
  return agentIdForNameLegacy(name);
}

async function agentIdForNameLegacy(name: string): Promise<string | null> {
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

export interface SweepReport { nonPersonAgentsRemoved?: number; agentsByEmailCross?: number; usersLinked: number; usersCreated: number; employeesLinkedToUsers: number; agentIdsFilled: number; agentsByEmail: number; agentsByName: number; agentAliases: number; errors: string[]; agentsSource?: "multipark" | "copia"; agentsNotice?: string | null }

export interface AgentEmailSeen { agentUserId: string; agentName: string | null; agentEmail: string }

/**
 * Agentes vistos nos últimos 180 dias (e emails), AO VIVO da BD da Multipark;
 * a cópia local `multipark_booking_history` só quando a BD deles não responde.
 */
export async function loadAgentsSeen(): Promise<{ agents: AgentSeen[]; emails: AgentEmailSeen[]; source: "multipark" | "copia"; notice: string | null }> {
  const { listLiveAgents } = await import("./multiparkDb/activityLive");
  const live = await listLiveAgents();
  if (live.available) {
    const agents: AgentSeen[] = [];
    const emails: AgentEmailSeen[] = [];
    for (const a of live.data) {
      if (!isLinkableAgent(a.agentUserId, a.agentName ?? a.agentNames[0], a.email)) continue; // sistema, teste, agência
      // um AgentSeen por nome (o mesmo agente pode ter mais de um), como na cópia local
      for (const n of a.agentNames.length ? a.agentNames : [null]) agents.push({ id: a.agentUserId, name: n, count: a.total });
      if (a.email) emails.push({ agentUserId: a.agentUserId, agentName: a.agentName, agentEmail: a.email });
    }
    return { agents, emails, source: "multipark", notice: null };
  }
  const db = await getDb();
  if (!db) return { agents: [], emails: [], source: "copia", notice: live.reason };
  const agents = rowsOf(await db.execute(sql`
    SELECT agentUserId AS id, agentName AS name, COUNT(*) AS n FROM multipark_booking_history
     WHERE agentUserId IS NOT NULL AND agentUserId <> '' AND actionTime >= NOW() - INTERVAL 180 DAY
     GROUP BY agentUserId, agentName`)).map((r) => ({ id: String(r.id), name: r.name ? String(r.name) : null, count: Number(r.n) }));
  const emails = rowsOf(await db.execute(sql`
    SELECT agentUserId, MAX(agentName) AS agentName, MAX(agentEmail) AS agentEmail FROM multipark_booking_history
     WHERE agentUserId IS NOT NULL AND agentUserId <> '' AND agentEmail IS NOT NULL AND agentEmail <> ''
       AND actionTime >= NOW() - INTERVAL 180 DAY
     GROUP BY agentUserId`)).map((r) => ({ agentUserId: String(r.agentUserId), agentName: r.agentName ? String(r.agentName) : null, agentEmail: String(r.agentEmail) }));
  const keep = (id: string, name: string | null) => isLinkableAgent(id, name);
  agents.splice(0, agents.length, ...agents.filter((a) => keep(a.id, a.name)));
  emails.splice(0, emails.length, ...emails.filter((a) => keep(a.agentUserId, a.agentName)));
  return { agents, emails, source: "copia", notice: `${live.reason} Agentes da cópia local (deixou de ser atualizada — agentes novos não aparecem).` };
}

/**
 * Agentes ligados a fichas que não são pessoas: ids de sistema ("system",
 * "api", "API User"…) como principal ou extra, e extras de teste/agência/texto
 * de formulário. Tira a ligação (a ficha e a Multipark ficam iguais) e regista.
 */
export async function removeNonPersonAgentLinks(db: any): Promise<number> {
  const { isNonPersonAgentName } = await import("../shared/agentIdentity");
  let n = 0;
  const prim = rowsOf(await db.execute(sql`SELECT id, multiparkAgentUserId AS a, multiparkAgentName AS name FROM employees
    WHERE multiparkAgentUserId IS NOT NULL AND multiparkAgentUserId <> ''`));
  for (const e of prim) {
    if (!isSystemAgentId(String(e.a))) continue;
    await db.execute(sql`UPDATE employees SET multiparkAgentUserId = NULL, multiparkAgentName = NULL WHERE id = ${Number(e.id)} AND multiparkAgentUserId = ${String(e.a)}`);
    await logLink("agent_detach", Number(e.id), `[Ligações] agente de sistema "${String(e.a)}" retirado da ficha (não é uma pessoa)`);
    n++;
  }
  const extras = rowsOf(await db.execute(sql`SELECT employeeId, agentUserId, agentName FROM employee_agents`).catch(() => [[]]));
  for (const x of extras) {
    if (!isSystemAgentId(String(x.agentUserId)) && !isNonPersonAgentName(x.agentName)) continue;
    await db.execute(sql`DELETE FROM employee_agents WHERE agentUserId = ${String(x.agentUserId)} AND employeeId = ${Number(x.employeeId)}`);
    await logLink("agent_detach", Number(x.employeeId), `[Ligações] agente extra "${x.agentName ?? x.agentUserId}" retirado (sistema, teste ou agência — não é uma pessoa)`);
    n++;
  }
  return n;
}

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
      const r = await ensureUserForEmployee(db as any, { id: Number(e.id), fullName: String(e.fullName), email: e.email, position: String(e.position ?? ""), userId: null }, { source: "cron" });
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
    for (const u of orphans) rep.employeesLinkedToUsers += (await linkEmployeesToUserByEmail(db as any, Number(u.id), String(u.email), { source: "cron" })).length;
  } catch (err: any) { rep.errors.push(`utilizadores sem ficha: ${err?.message ?? err}`); }

  // 0. Tirar das fichas os agentes que não são pessoas (sistema, teste, agências, textos de formulário)
  try {
    rep.nonPersonAgentsRemoved = await removeNonPersonAgentLinks(db);
  } catch (err: any) { rep.errors.push(`agentes que não são pessoas: ${err?.message ?? err}`); }

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
  let agentEmails: AgentEmailSeen[] = [];
  try {
    const seen = await loadAgentsSeen();
    rep.agentsSource = seen.source;
    rep.agentsNotice = seen.notice;
    if (seen.notice) console.warn(`[identityLink] ${seen.notice}`);
    agents = seen.agents.filter((a) => !aliasAgentIds.has(a.id)); // agentes EXTRA já estão ligados
    agentEmails = seen.emails;
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
    const seen = agentEmails;
    const { autoAttachAgentsByEmail } = await import("./identityReconcile");
    rep.agentsByEmail = await autoAttachAgentsByEmail(db as any, seen.filter((s) => !aliasAgentIds.has(s.agentUserId)) as any);

    // 4b. Segundo agente da mesma pessoa: email de uma ficha ativa que JÁ tem
    // outro agente → entra como agente EXTRA (várias contas Multipark)
    const fichas = rowsOf(await db.execute(sql`
      SELECT e.id, e.multiparkAgentUserId AS agentId,
             LOWER(TRIM(COALESCE(NULLIF(e.email, ''), u.email))) AS email, LOWER(TRIM(e.personalEmail)) AS personalEmail
        FROM employees e LEFT JOIN users u ON u.id = e.userId WHERE e.isActive = 1`));
    // 41a: o agente principal de uma ficha INATIVA continua dela — não passa a extra de outra
    const allPrincipal = rowsOf(await db.execute(sql`SELECT multiparkAgentUserId AS agentId FROM employees
      WHERE multiparkAgentUserId IS NOT NULL AND multiparkAgentUserId <> ''`));
    const linkedIds = new Set([...fichas, ...allPrincipal].map((f) => String(f.agentId ?? "").trim()).filter(Boolean));
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

  // 6. (31b) Cruzamento Agentes × pessoas: o resto dos agentes com o email de UMA só ficha ativa
  //    (agentes inativos, email pessoal ou do utilizador, ficha que já tem agente → extra)
  try {
    const { autoLinkAgentsByEmail } = await import("./agentCrossCheck");
    rep.agentsByEmailCross = await autoLinkAgentsByEmail();
  } catch (err: any) { rep.errors.push(`agentes por email (cruzamento): ${err?.message ?? err}`); }

  return rep;
}
