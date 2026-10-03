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
import type { CityAskOutcome } from "../shared/extrasCityRequest";

const lisbonDay = (dbDate: string): string => { const [y, m, d] = dbDate.slice(0, 10).split("-"); return `${d}/${m}/${y}`; };

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

export interface CityFixReport { checked: number; fromAgent: number; fromAddress: number; openTasks: number; asked?: number; errors: string[] }

export async function fixMissingEmployeeCities(o: { nowMs?: number } = {}): Promise<CityFixReport> {
  const rep: CityFixReport = { checked: 0, fromAgent: 0, fromAddress: 0, openTasks: 0, errors: [] };
  const { getDb } = await import("./db");
  const d = (await getDb()) as unknown as Db | null;
  if (!d) return rep;
  const emps = rowsOf(await d.execute(sql`SELECT id, fullName, address, multiparkAgentUserId, position, email, personalEmail FROM employees WHERE isActive = 1 AND projectId IS NULL LIMIT 2000`));
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

  const stillOpen: OpenEmployee[] = [];
  for (const e of emps) {
    const id = Number(e.id);
    const viaAgent = dominantCity((agentsOf.get(id) ?? []).map((a) => agentCities.get(a) ?? new Map()));
    const city = viaAgent ?? fromAddress.get(id)?.city ?? null;
    const node = city ? cityNode.get(city) : undefined;
    if (city && node) {
      await d.execute(sql`UPDATE employees SET projectId = ${node} WHERE id = ${id} AND projectId IS NULL`);
      if (viaAgent) rep.fromAgent++; else rep.fromAddress++;
      // 20c: autor 0 + origem "cron" (antes aparecia como o primeiro super admin).
      await d.execute(sql`INSERT INTO activity_logs (userId, action, entity, entityId, details, source)
        VALUES (0, 'employee_city_auto', 'employee', ${id}, ${`Cidade ${CITY_LABELS[city]} definida automaticamente (${viaAgent ? "onde o agente da Multipark trabalha" : "candidatura/morada"})`}, 'cron')`).catch(() => undefined);
    } else {
      stillOpen.push({ id, fullName: String(e.fullName), position: e.position ?? null, email: e.email ?? null, personalEmail: e.personalEmail ?? null });
    }
  }
  // 3. Sem cidade: a um EXTRA pede-se a cidade (uma vez, com o interruptor
  //    EXTRAS_ASK_CITY); depois uma tarefa (com email e prazo de 1 semana)
  //    para quem trata do RH (17g-3).
  const askOn = stillOpen.some((e) => e.position === "extra") && (await askCityEnabled());
  for (const e of stillOpen) {
    try {
      const asked = askOn && e.position === "extra" ? await askExtraCity(d, e) : null;
      if (asked && !asked.previously) rep.asked = (rep.asked ?? 0) + 1;
      if (await openMissingCityTask(d, e, asked)) rep.openTasks++;
    } catch (err) { rep.errors.push(`tarefa #${e.id}: ${(err as Error).message}`); }
  }
  return rep;
}

type OpenEmployee = { id: number; fullName: string; position: string | null; email: string | null; personalEmail: string | null };

async function askCityEnabled(): Promise<boolean> {
  try {
    const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
    await ensureFeatureFlagOverrides();
    return isFeatureEnabled("EXTRAS_ASK_CITY", { defaultEnabled: automationFlagDefault("EXTRAS_ASK_CITY") });
  } catch { return false; }
}

/**
 * Pede a cidade a um extra (17g-3): email pela recursos-humanos@ (a resposta
 * cai na caixa RH) e WhatsApp em texto livre só com a conversa aberta (24 h).
 * UMA vez por pessoa (activity_logs "extra_city_requested"); respeita o "Não
 * enviar" da ficha. Uma falha de envio não fica registada → tenta na próxima hora.
 */
export async function askExtraCity(d: Db, e: OpenEmployee): Promise<CityAskOutcome> {
  // 20c: o "já se pediu" vive na ficha (employees.cityRequestedAt), não nos
  // logs — com a retenção dos logs voltava a pedir passados 24 meses.
  const before = rowsOf(await d.execute(sql`SELECT cityRequestedAt FROM employees WHERE id = ${e.id} LIMIT 1`))[0];
  if (before?.cityRequestedAt) return { email: "no_contact", whatsapp: "no_contact", previously: true };
  const { cityRequestMessage } = await import("../shared/extrasCityRequest");
  const msg = cityRequestMessage(e.fullName);
  const out: CityAskOutcome = { email: "no_contact", whatsapp: "no_contact" };
  const to = (e.email || e.personalEmail || "").trim();
  if (to) {
    const { sendEmailDetailed } = await import("./mail/systemMail");
    const r = await sendEmailDetailed({
      to, subject: msg.subject, text: msg.text, html: msg.html,
      from: "recursos-humanos@multipark.pt", fromName: "Multipark Recursos Humanos",
      auto: { kind: "city_request", employeeId: e.id },
    } as any);
    out.email = r.ok ? "sent" : r.blocked ? "blocked" : "failed";
  }
  const { employeesWithNoAuto } = await import("./contactPrefs");
  if ((await employeesWithNoAuto([e.id], "whatsapp")).has(e.id)) out.whatsapp = "blocked";
  else {
    const conv = rowsOf(await d.execute(sql`SELECT id FROM whatsapp_conversations WHERE employeeId = ${e.id} ORDER BY lastMessageAt DESC, id DESC LIMIT 1`))[0];
    if (conv) {
      try {
        const { replyToConversation } = await import("./whatsappInbox");
        const r = await replyToConversation(Number(conv.id), msg.whatsapp, null);
        out.whatsapp = r.ok ? "sent" : (r as any).optedOut ? "blocked" : "closed";
      } catch { out.whatsapp = "failed"; }
    }
  }
  // Regista (= não volta a pedir) quando saiu por algum lado ou quando não há
  // por onde pedir; uma falha de envio deixa tentar outra vez na próxima hora.
  if (out.email !== "failed" && out.whatsapp !== "failed") {
    await d.execute(sql`UPDATE employees SET cityRequestedAt = UTC_TIMESTAMP() WHERE id = ${e.id} AND cityRequestedAt IS NULL`).catch(() => undefined);
    await d.execute(sql`INSERT INTO activity_logs (userId, action, entity, entityId, details, source)
      VALUES (0, 'extra_city_requested', 'employee', ${e.id}, ${`Pedida a cidade: email ${out.email}, WhatsApp ${out.whatsapp}`}, 'cron')`).catch(() => undefined);
  }
  return out;
}

async function openMissingCityTask(d: Db, e: { id: number; fullName: string }, asked: CityAskOutcome | null = null): Promise<boolean> {
  const key = `rh:missing-city:${e.id}`;
  const existing = rowsOf(await d.execute(sql`SELECT id FROM tasks WHERE sourceKey = ${key} AND taskStatus <> 'done' LIMIT 1`))[0];
  if (existing) return false;
  const [{ getSystemUserId, findEmployeeByEmailOrName }, { getSetting }] = await Promise.all([import("./db"), import("./appSettings")]);
  const systemUser = await getSystemUserId();
  const { askedSummary, cityTaskDueDate, CITY_TASK_DUE_DAYS } = await import("../shared/extrasCityRequest");
  const summary = askedSummary(asked);
  // Prazo de uma semana para contactar (17g-3).
  const res: any = await d.execute(sql`INSERT INTO tasks (title, description, createdById, taskStatus, taskPriority, dueDate, sourceModule, sourceId, sourceKey)
    VALUES (${`Ficha sem cidade: ${e.fullName}`.slice(0, 250)},
      ${`A ficha #${e.id} (${e.fullName}) não tem cidade e não foi possível descobri-la (nem pelo agente da Multipark, nem pela candidatura ou morada). ${summary} Define a cidade (centro de custo) na ficha em ${CITY_TASK_DUE_DAYS} dias: sem cidade a pessoa não entra na app nem é chamada para a escala.`},
      ${systemUser}, 'todo', 'high', ${cityTaskDueDate()}, 'rh', ${e.id}, ${key})`);
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
        text: `Olá,\n\nA ficha de ${e.fullName} (#${e.id}) não tem cidade e o dashboard não a conseguiu descobrir (nem pelo agente da Multipark, nem pela candidatura ou morada).\n\n${summary}\n\nDefine a cidade (centro de custo) na ficha até ${lisbonDay(cityTaskDueDate())}: sem cidade a pessoa não consegue entrar na app nem é chamada para a escala. Ficou uma tarefa no dashboard com esse prazo.\n\nObrigado.`,
      }).catch(() => false);
    }
  }
  return true;
}
