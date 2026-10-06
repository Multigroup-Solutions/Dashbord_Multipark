/**
 * P3 lote 31a — Todos os agentes da Multipark (um por "userId"), para o
 * cruzamento Agentes × pessoas: papéis, parques e cidades, e a empresa
 * parceira (é o dono do "Partner", membro de um parceiro, ou agente gerido
 * por ele). E os dias em que cada agente mexeu (para comparar com o Zello e a
 * escala). Só leitura, com parâmetros e LIMIT.
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList } from "./read";
import { opDaySql } from "./movements";

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;
export const AGENT_REGISTRY_LIMIT = 5_000;

/** Um agente por utilizador da Multipark, com o parceiro a que pertence. PURA. */
export function buildAgentRegistrySql(limit = AGENT_REGISTRY_LIMIT): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const sql = [
    `WITH ag AS (`,
    `  SELECT a."userId" AS uid,`,
    `         (array_agg(NULLIF(trim(a."name"), '') ORDER BY a."isActive" DESC, a."updatedAt" DESC))[1] AS name,`,
    `         bool_or(a."isActive") AS active,`,
    `         array_agg(DISTINCT a."role"::text) AS roles,`,
    `         array_remove(array_agg(DISTINCT pk."name"), NULL) AS parks,`,
    `         array_remove(array_agg(DISTINCT pk."city"), NULL) AS cities,`,
    `         (array_agg(a."managedByPartnerUserId") FILTER (WHERE COALESCE(a."managedByPartnerUserId", '') <> ''))[1] AS managed_by`,
    `    FROM "Agent" a LEFT JOIN "Park" pk ON pk."id" = a."parkId"`,
    `   WHERE COALESCE(a."userId", '') <> ''`,
    `   GROUP BY a."userId"`,
    `), own AS (`,
    `  SELECT DISTINCT ON (pp."userId") pp."userId" AS uid, pp."name" AS name, pp."partnerType"::text AS type`,
    `    FROM "Partner" pp ORDER BY pp."userId", pp."isActive" DESC, pp."updatedAt" DESC`,
    `), mem AS (`,
    `  SELECT DISTINCT ON (m."memberUserId") m."memberUserId" AS uid, m."ownerUserId" AS owner, lower(trim(m."email")) AS email`,
    `    FROM "PartnerMember" m WHERE COALESCE(m."memberUserId", '') <> ''`,
    `   ORDER BY m."memberUserId", m."isActive" DESC, m."updatedAt" DESC`,
    `)`,
    `SELECT ag.uid AS user_id, ag.name, ag.active, ag.roles, ag.parks, ag.cities, ag.managed_by,`,
    `       own.name AS own_name, own.type AS own_type, mem.owner AS member_owner, mem.email AS member_email,`,
    `       o2.name AS owner_name, o2.type AS owner_type`,
    `  FROM ag LEFT JOIN own ON own.uid = ag.uid LEFT JOIN mem ON mem.uid = ag.uid`,
    `  LEFT JOIN own o2 ON o2.uid = COALESCE(mem.owner, ag.managed_by)`,
    ` LIMIT ${p.add(Math.max(1, Math.min(limit, AGENT_REGISTRY_LIMIT)))}`,
  ].join("\n");
  return { sql, params: p.values };
}

export interface RegistryAgent {
  userId: string;
  name: string | null;
  active: boolean;
  roles: string[];
  parks: string[];
  cities: string[];
  memberEmail: string | null;
  partner: { ownerUserId: string; name: string | null; type: string | null; how: "dono" | "membro" | "gerido" } | null;
}

const str = (v: unknown) => (v == null || String(v).trim() === "" ? null : String(v).trim());
const bool = (v: unknown) => v === true || v === "t" || v === "true" || v === 1;
function arr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x ?? "").trim()).filter((x) => x && x !== "NULL");
  const s = String(v ?? "").trim();
  if (!s || s === "{}") return [];
  return s.replace(/^\{|\}$/g, "").match(/"((?:[^"\\]|\\.)*)"|[^,]+/g)?.map((x) => x.replace(/^"|"$/g, "").replace(/\\(.)/g, "$1").trim()).filter((x) => x && x !== "NULL") ?? [];
}

/** PURA. */
export function mapRegistryRow(r: Record<string, unknown>): RegistryAgent | null {
  const userId = str(r.user_id);
  if (!userId) return null;
  const ownName = str(r.own_name);
  const memberOwner = str(r.member_owner), managedBy = str(r.managed_by);
  const partner = ownName != null || str(r.own_type)
    ? { ownerUserId: userId, name: ownName, type: str(r.own_type), how: "dono" as const }
    : memberOwner ? { ownerUserId: memberOwner, name: str(r.owner_name), type: str(r.owner_type), how: "membro" as const }
    : managedBy ? { ownerUserId: managedBy, name: str(r.owner_name), type: str(r.owner_type), how: "gerido" as const }
    : null;
  return { userId, name: str(r.name), active: bool(r.active), roles: arr(r.roles), parks: arr(r.parks), cities: arr(r.cities), memberEmail: str(r.member_email), partner };
}

export async function readAgentRegistry(query: Query = multiparkDbQuery): Promise<RegistryAgent[]> {
  const { sql, params } = buildAgentRegistrySql();
  return (await query<Record<string, unknown>>(sql, params)).map(mapRegistryRow).filter((x): x is RegistryAgent => !!x);
}

export const AGENT_DAYS_WINDOW = 60;

/** Dias operacionais (03h→03h) com ações no History, por agente. PURA. */
export function buildAgentDaysSql(o: { agentIds: readonly string[]; since: string }): { sql: string; params: SqlParam[] } {
  const ids = [...new Set(o.agentIds.filter(Boolean))].slice(0, 1500);
  if (!ids.length) throw new Error("Sem agentes.");
  const p = new ParamList();
  const sql = [
    `SELECT h."userId" AS user_id, ${opDaySql(`h."actionTime"`)} AS day, count(*) AS n`,
    `  FROM "History" h`,
    ` WHERE h."userId" IN (${ids.map((x) => p.add(x)).join(", ")}) AND h."actionTime" >= ${p.add(o.since)}::timestamp`,
    ` GROUP BY 1, 2`,
    ` LIMIT ${p.add(ids.length * (AGENT_DAYS_WINDOW + 2))}`,
  ].join("\n");
  return { sql, params: p.values };
}

export async function readAgentDays(agentIds: readonly string[], nowMs = Date.now(), query: Query = multiparkDbQuery): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (!agentIds.some(Boolean)) return out;
  const since = new Date(nowMs - AGENT_DAYS_WINDOW * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  const { sql, params } = buildAgentDaysSql({ agentIds, since });
  for (const r of await query<Record<string, unknown>>(sql, params)) {
    const id = String(r.user_id ?? ""), day = String(r.day ?? "");
    if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const s = out.get(id) ?? new Set<string>();
    s.add(day);
    out.set(id, s);
  }
  return out;
}
