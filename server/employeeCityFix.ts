/**
 * Fichas ativas SEM cidade (decisão do dono, 29 set 2026). Por ordem:
 *   1. onde o(s) agente(s) da Multipark da pessoa costuma(m) trabalhar
 *      (cidade do parque com mais ações nos últimos 180 dias);
 *   2. a cidade da candidatura ou da morada (server/employeeCity.ts);
 *   3. se nada der: a ficha fica em aberto e cria-se UMA tarefa (e um email)
 *      para quem trata do RH (Definições "rh.missingCityAssignee", por omissão
 *      a Márcia Nunes).
 * A cidade é o nó `level='city'` da árvore de projetos (employees.projectId).
 * Corre com a ligação automática de hora a hora (identity-sweep).
 */
import { sql } from "drizzle-orm";
import { matchCityKey, CITY_LABELS, type CityKey } from "../shared/city";

type Db = { execute: (q: any) => Promise<any> };
const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r?.rows ?? r) as any[]) ?? [];

export const MISSING_CITY_ASSIGNEE_DEFAULT = "Márcia Nunes";

/** Cidade dominante de uma pessoa a partir das contagens por agente. PURA. */
export function dominantCity(counts: ReadonlyArray<ReadonlyMap<string, number>>): CityKey | null {
  const total = new Map<CityKey, number>();
  for (const m of counts) for (const [city, n] of m) {
    const k = matchCityKey(city);
    if (k) total.set(k, (total.get(k) ?? 0) + n);
  }
  let best: CityKey | null = null, bestN = 0;
  for (const [k, n] of total) if (n > bestN) { best = k; bestN = n; }
  return best;
}

export interface CityFixReport { checked: number; fromAgent: number; fromAddress: number; openTasks: number; errors: string[] }

export async function fixMissingEmployeeCities(o: { nowMs?: number } = {}): Promise<CityFixReport> {
  const rep: CityFixReport = { checked: 0, fromAgent: 0, fromAddress: 0, openTasks: 0, errors: [] };
  const { getDb } = await import("./db");
  const d = (await getDb()) as unknown as Db | null;
  if (!d) return rep;
  const emps = rowsOf(await d.execute(sql`SELECT id, fullName, address, multiparkAgentUserId FROM employees WHERE isActive = 1 AND projectId IS NULL LIMIT 2000`));
  rep.checked = emps.length;
  if (!emps.length) return rep;
  // Nós de cidade da árvore de projetos.
  const cityNode = new Map<CityKey, number>();
  for (const p of rowsOf(await d.execute(sql`SELECT id, name FROM projects WHERE level = 'city'`))) {
    const k = matchCityKey(p.name);
    if (k && !cityNode.has(k)) cityNode.set(k, Number(p.id));
  }
  // 1. Agentes da Multipark de cada ficha → cidade onde trabalham.
  const extra = rowsOf(await d.execute(sql`SELECT agentUserId, employeeId FROM employee_agents WHERE employeeId IN (${sql.join(emps.map((e) => sql`${Number(e.id)}`), sql`, `)})`).catch(() => [[]]));
  const agentsOf = new Map<number, string[]>();
  for (const e of emps) if (e.multiparkAgentUserId) agentsOf.set(Number(e.id), [String(e.multiparkAgentUserId)]);
  for (const a of extra) agentsOf.set(Number(a.employeeId), [...(agentsOf.get(Number(a.employeeId)) ?? []), String(a.agentUserId)]);
  let agentCities = new Map<string, Map<string, number>>();
  const allAgents = [...agentsOf.values()].flat();
  if (allAgents.length) {
    try {
      const { readAgentCities } = await import("./multiparkDb/agentCities");
      agentCities = await readAgentCities(allAgents, o.nowMs);
    } catch (err) { rep.errors.push(`BD Multipark: ${(err as Error).message}`); }
  }
  // 2. Candidatura / morada.
  const { resolveEmployeeCities } = await import("./employeeCity");
  const fromAddress = await resolveEmployeeCities(emps.map((e) => ({ id: Number(e.id), projectId: null, address: e.address ?? null })));

  const { getSystemUserId } = await import("./db");
  const systemUser = await getSystemUserId();
  const stillOpen: Array<{ id: number; fullName: string }> = [];
  for (const e of emps) {
    const id = Number(e.id);
    const viaAgent = dominantCity((agentsOf.get(id) ?? []).map((a) => agentCities.get(a) ?? new Map()));
    const city = viaAgent ?? fromAddress.get(id)?.city ?? null;
    const node = city ? cityNode.get(city) : undefined;
    if (city && node) {
      await d.execute(sql`UPDATE employees SET projectId = ${node} WHERE id = ${id} AND projectId IS NULL`);
      if (viaAgent) rep.fromAgent++; else rep.fromAddress++;
      await d.execute(sql`INSERT INTO activity_logs (userId, action, entity, entityId, details)
        VALUES (${systemUser}, 'employee_city_auto', 'employee', ${id}, ${`Cidade ${CITY_LABELS[city]} definida automaticamente (${viaAgent ? "onde o agente da Multipark trabalha" : "candidatura/morada"})`})`).catch(() => undefined);
    } else {
      stillOpen.push({ id, fullName: String(e.fullName) });
    }
  }
  // 3. Sem cidade: uma tarefa (com email) por ficha, para quem trata do RH.
  for (const e of stillOpen) {
    try { if (await openMissingCityTask(d, e)) rep.openTasks++; } catch (err) { rep.errors.push(`tarefa #${e.id}: ${(err as Error).message}`); }
  }
  return rep;
}

async function openMissingCityTask(d: Db, e: { id: number; fullName: string }): Promise<boolean> {
  const key = `rh:missing-city:${e.id}`;
  const existing = rowsOf(await d.execute(sql`SELECT id FROM tasks WHERE sourceKey = ${key} AND taskStatus <> 'done' LIMIT 1`))[0];
  if (existing) return false;
  const [{ getSystemUserId, findEmployeeByEmailOrName }, { getSetting }] = await Promise.all([import("./db"), import("./appSettings")]);
  const systemUser = await getSystemUserId();
  const res: any = await d.execute(sql`INSERT INTO tasks (title, description, createdById, taskStatus, taskPriority, sourceModule, sourceId, sourceKey)
    VALUES (${`Ficha sem cidade: ${e.fullName}`.slice(0, 250)},
      ${`A ficha #${e.id} (${e.fullName}) não tem cidade e não foi possível descobri-la (nem pelo agente da Multipark, nem pela candidatura ou morada). Define a cidade (centro de custo) na ficha: sem cidade a pessoa não entra na app.`},
      ${systemUser}, 'todo', 'high', 'rh', ${e.id}, ${key})`);
  const taskId = Number((Array.isArray(res) ? res[0] : res)?.insertId ?? 0);
  let who = MISSING_CITY_ASSIGNEE_DEFAULT;
  try { who = (await getSetting("rh.missingCityAssignee")) || who; } catch { /* omissão */ }
  const owner = await findEmployeeByEmailOrName(who);
  if (owner && taskId) {
    await d.execute(sql`INSERT IGNORE INTO task_assignees (taskId, employeeId) VALUES (${taskId}, ${owner.id})`);
    await d.execute(sql`UPDATE tasks SET assigneeId = ${owner.id} WHERE id = ${taskId}`);
    const email = rowsOf(await d.execute(sql`SELECT COALESCE(u.email, e.email) AS email FROM employees e LEFT JOIN users u ON u.id = e.userId WHERE e.id = ${owner.id} LIMIT 1`))[0]?.email;
    if (email) {
      const { sendEmail } = await import("./mail/systemMail");
      await sendEmail({ to: String(email), subject: `Ficha sem cidade: ${e.fullName}`,
        text: `Olá,\n\nA ficha de ${e.fullName} (#${e.id}) não tem cidade e o dashboard não a conseguiu descobrir (nem pelo agente da Multipark, nem pela candidatura ou morada).\n\nDefine a cidade (centro de custo) na ficha: sem cidade a pessoa não consegue entrar na app. Ficou uma tarefa no dashboard.\n\nObrigado.`,
      }).catch(() => false);
    }
  }
  return true;
}
