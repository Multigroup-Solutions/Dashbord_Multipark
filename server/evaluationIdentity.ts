/**
 * Resolução de IDENTIDADE da avaliação — a mesma para a Avaliação individual,
 * a Avaliação operacional e o recálculo diário (antes cada uma tinha a sua:
 * o ranking semanal juntava por id/nome do agente em SQL e o operacional pelo
 * "nome curto" da escala, e os números não batiam).
 *
 * Por cima do resolvedor da Atividade (activityHelpers.buildIdentityResolver:
 * id do agente > agentes extra > nome do agente na ficha > ignorado >
 * parceiro), junta:
 *  - nome curto derivado ("Gelson Manuel Leão Sousa" → "gelson sousa") como
 *    ÚLTIMO recurso, só quando é único (era a regra do operacional);
 *  - utilizador → ficha (conta principal + contas extra), para quem reporta
 *    ocorrências;
 *  - linha da escala (extras-dia) → ficha, ou chave do agente por ligar.
 *
 * A parte pura (`buildEvaluationIdentity`) é testada em evaluationIdentity.test.ts.
 */
import {
  buildIdentityResolver,
  type IdentityAlias,
  type IdentityEmployee,
  type IdentityPartner,
  type ResolvedAgent,
} from "./activityHelpers";

export interface EvaluationEmployee extends IdentityEmployee {
  userId: number | null;
}

export interface EvaluationIdentityInput {
  employees: EvaluationEmployee[];
  agentAliases: IdentityAlias[];
  accountAliases: { userId: number; employeeId: number }[];
  partners?: IdentityPartner[];
  ignoredAgentNames?: string[];
}

export interface EvaluationIdentity {
  /** Agente Multipark (id, nome) → pessoa. */
  agent(agentUserId: string | null | undefined, agentName: string | null | undefined): ResolvedAgent;
  /** Utilizador da app → ficha (null se não houver). */
  user(userId: number | null | undefined): number | null;
  /** Linha da escala → ficha (ou null) + chave do agente para as ações por ligar. */
  assignment(a: { employeeId: number | null; personName: string }): { employeeId: number | null; agentKey: string };
}

export const normName = (s: string | null | undefined): string =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase().replace(/\s+/g, " ");

/** "Gelson Manuel Leão Sousa" → "Gelson Sousa" (igual a extrasDia.deriveShortName). */
export function shortNameOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return fullName.trim();
  return `${parts[0]} ${parts[parts.length - 1]}`;
}

/** Chave estável de um agente sem ficha (igual à da Atividade: `agent:<nome>`). */
export const agentKeyOf = (name: string | null | undefined): string => `agent:${String(name ?? "").trim().toLowerCase()}`;

export function buildEvaluationIdentity(input: EvaluationIdentityInput): EvaluationIdentity {
  const base = buildIdentityResolver(
    input.employees,
    input.agentAliases,
    input.partners ?? [],
    input.ignoredAgentNames ?? [],
  );
  const byId = new Map(input.employees.map((e) => [e.id, e]));

  // Nome curto e nome completo → ficha, só quando únicos (homónimos → sem match).
  const byShort = new Map<string, number | null>();
  const byFull = new Map<string, number | null>();
  const put = (m: Map<string, number | null>, k: string, id: number) => {
    if (!k) return;
    const cur = m.get(k);
    m.set(k, cur === undefined || cur === id ? id : null);
  };
  for (const e of input.employees) {
    put(byShort, normName(shortNameOf(e.fullName)), e.id);
    put(byFull, normName(e.fullName), e.id);
  }

  const byUser = new Map<number, number>();
  for (const e of input.employees) if (e.userId != null) byUser.set(Number(e.userId), e.id);
  // contas extra (email pessoal…) → a mesma ficha; a principal ganha
  for (const a of input.accountAliases) if (!byUser.has(Number(a.userId))) byUser.set(Number(a.userId), Number(a.employeeId));

  return {
    agent(agentUserId, agentName) {
      const r = base(agentUserId, agentName);
      if (r.kind !== "por_ligar") return r;
      const k = normName(agentName);
      const id = (k ? byShort.get(k) : undefined) ?? (k ? byFull.get(k) : undefined);
      const emp = id != null ? byId.get(id) : undefined;
      if (emp) return { kind: "colaborador", key: `emp:${emp.id}`, employeeId: emp.id, name: emp.fullName };
      return r;
    },
    user(userId) {
      if (userId == null) return null;
      return byUser.get(Number(userId)) ?? null;
    },
    assignment(a) {
      const shortKey = agentKeyOf(shortNameOf(a.personName));
      if (a.employeeId != null) return { employeeId: a.employeeId, agentKey: shortKey };
      const id = byFull.get(normName(a.personName));
      return { employeeId: id ?? null, agentKey: shortKey };
    },
  };
}

/** Carrega o resolvedor com os dados da BD (todas as fichas, sem âmbito de cidade). */
export async function loadEvaluationIdentity(): Promise<{ identity: EvaluationIdentity; employees: EvaluationEmployee[] }> {
  const { getDb, listAgentPartners, listIgnoredAgents } = await import("./db");
  const { listAgentAliases, listAllAliases } = await import("./employeeAliases");
  const { employees } = await import("../drizzle/schema");
  const db = await getDb();
  const emps: EvaluationEmployee[] = db
    ? (await db.select({
        id: employees.id, fullName: employees.fullName, userId: employees.userId,
        multiparkAgentName: employees.multiparkAgentName, multiparkAgentUserId: employees.multiparkAgentUserId,
      }).from(employees)).map((e) => ({
        id: e.id, fullName: e.fullName, userId: e.userId ?? null,
        multiparkAgentName: e.multiparkAgentName ?? null, multiparkAgentUserId: e.multiparkAgentUserId ?? null,
      }))
    : [];
  const [agentAliases, all, partners, ignored] = await Promise.all([
    listAgentAliases(), listAllAliases(), listAgentPartners().catch(() => []), listIgnoredAgents().catch(() => []),
  ]);
  const identity = buildEvaluationIdentity({
    employees: emps,
    agentAliases,
    accountAliases: all.accounts.map((a) => ({ userId: a.userId, employeeId: a.employeeId })),
    partners: partners.map((p) => ({ agentName: p.agentName, partnerName: p.partnerName })),
    ignoredAgentNames: ignored,
  });
  return { identity, employees: emps };
}
