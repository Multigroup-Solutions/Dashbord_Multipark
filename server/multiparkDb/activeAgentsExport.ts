import type { SqlParam } from "./client";
import { csvCell, type Period } from "./initialBookingPrice";

export const AGENT_EXPORT_STAGES = ["agents", "invites", "history", "activity"] as const;
export type AgentExportStage = typeof AGENT_EXPORT_STAGES[number];
export interface AgentExportRecord {
  id: string; user_id?: string | null; agent_id?: string | null; name?: string | null;
  city?: string | null; cities?: string[] | null; email?: string | null;
  role?: string | null; active?: boolean; updated_at?: string;
  accepted_by?: string | null; created_agent_id?: string | null;
  event_type?: string; at?: string;
}
export type AgentExportReader = (stage: AgentExportStage, cursor: string, limit: number) => Promise<AgentExportRecord[]>;
const ts = (column: string) => `to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export interface BookingDriversRow {
  id: string; reference: string | null; city: string | null; created_at: string;
  check_in_driver_id: string | null; check_in_driver_name: string | null;
  check_out_driver_id: string | null; check_out_driver_name: string | null;
}
/** Same creation-date scope as the previous price export, for a direct join by booking ID. */
export function bookingDriversPage(period: Period, cursor: string, limit: number): { sql: string; params: SqlParam[] } {
  return { sql: `SELECT b."id", b."allocation" AS reference, p."city", ${ts('b."createdAt"')} AS created_at,
    b."checkInDriverId" AS check_in_driver_id, b."checkInDriverName" AS check_in_driver_name,
    b."checkOutDriverId" AS check_out_driver_id, b."checkOutDriverName" AS check_out_driver_name
    FROM "Booking" b LEFT JOIN "Park" p ON p."id" = b."parkId"
    WHERE b."createdAt" >= $1::timestamp AND b."createdAt" < $2::timestamp AND b."id" > $3
    ORDER BY b."id" LIMIT $4`, params: [period.startUtc, period.endUtc, cursor, limit] };
}

export function agentExportPage(stage: AgentExportStage, period: Period, cursor: string, limit: number): { sql: string; params: SqlParam[] } {
  if (stage === "agents") return {
    sql: `SELECT a."id", a."userId" AS user_id, a."name", a."isActive" AS active,
      a."role"::text AS role, p."city", ${ts('a."updatedAt"')} AS updated_at
      FROM "Agent" a LEFT JOIN "Park" p ON p."id" = a."parkId"
      WHERE a."id" > $1 ORDER BY a."id" LIMIT $2`, params: [cursor, limit],
  };
  if (stage === "invites") return {
    sql: `SELECT i."id", i."email", i."acceptedBy" AS accepted_by, i."createdAgentId" AS created_agent_id
      FROM "AgentInvite" i WHERE i."status"::text = 'ACCEPTED' AND i."id" > $1
      ORDER BY i."id" LIMIT $2`, params: [cursor, limit],
  };
  if (stage === "history") return {
    sql: `SELECT h."id", h."userId" AS user_id, h."agentName" AS name, p."city",
      h."changeType"::text AS event_type, ${ts('h."actionTime"')} AS at
      FROM "History" h LEFT JOIN "Booking" b ON b."id" = h."bookingId"
      LEFT JOIN "Park" p ON p."id" = b."parkId"
      WHERE h."actionTime" >= $1::timestamp AND h."actionTime" < $2::timestamp AND h."id" > $3
      ORDER BY h."id" LIMIT $4`, params: [period.startUtc, period.endUtc, cursor, limit],
  };
  if (stage === "activity") return {
    sql: `SELECT e."id", e."actorId" AS user_id, e."actorDisplayName" AS name,
      e."actorEmail" AS email, e."actorRole" AS role, e."eventType" AS event_type,
      ${ts('e."timestamp"')} AS at,
      ARRAY(SELECT DISTINCT p."city" FROM "Park" p WHERE p."id" = ANY(e."parkScope")) AS cities,
      bp."city" AS city
      FROM "ActivityEvent" e LEFT JOIN "Booking" b ON lower(e."entityType") = 'booking' AND b."id" = e."entityId"
      LEFT JOIN "Park" bp ON bp."id" = b."parkId"
      WHERE e."timestamp" >= $1::timestamp AND e."timestamp" < $2::timestamp AND e."id" > $3
      ORDER BY e."id" LIMIT $4`, params: [period.startUtc, period.endUtc, cursor, limit],
  };
  throw new Error("Etapa de exportação inválida.");
}

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const email = (value: unknown) => {
  const s = text(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : "";
};
const city = (value: unknown) => {
  const s = text(value);
  return ({ lisboa: "Lisboa", lisbon: "Lisboa", porto: "Porto", oporto: "Porto", faro: "Faro", madrid: "Madrid" } as Record<string, string>)[s.toLowerCase()] ?? s;
};
const join = (values: Iterable<string>) => [...new Set(values)].filter(Boolean).sort((a, b) => a.localeCompare(b, "pt")).join(" | ");
interface AgentInfo { name: string; nameAt: string; ids: Set<string>; cities: Set<string>; roles: Set<string>; active: boolean }
interface Actor {
  id: string; names: Map<string, number>; emails: Map<string, Set<string>>; cities: Set<string>;
  types: Set<string>; roles: Set<string>; history: number; activity: number; first: string; last: string;
}
export class ActiveAgentsCollector {
  agents = new Map<string, AgentInfo>();
  agentIds = new Map<string, string>();
  actors = new Map<string, Actor>();
  inviteEmails = new Map<string, Set<string>>();
  conflicts = 0;
  withoutActorId = { history: 0, activity: 0 };
  counts: Record<AgentExportStage, number> = { agents: 0, invites: 0, history: 0, activity: 0 };

  add(stage: AgentExportStage, row: AgentExportRecord) {
    this.counts[stage]++;
    const uid = text(row.user_id);
    if (stage === "agents") {
      if (!uid) return;
      const info = this.agents.get(uid) ?? { name: "", nameAt: "", ids: new Set(), cities: new Set(), roles: new Set(), active: false };
      if (text(row.name) && (!info.name || (row.updated_at ?? "") > info.nameAt)) { info.name = text(row.name); info.nameAt = row.updated_at ?? ""; }
      info.ids.add(row.id); if (city(row.city)) info.cities.add(city(row.city)); if (text(row.role)) info.roles.add(text(row.role));
      info.active ||= row.active === true;
      this.agents.set(uid, info); this.agentIds.set(row.id, uid);
      return;
    }
    if (stage === "invites") {
      const byAgent = this.agentIds.get(text(row.created_agent_id));
      const accepted = text(row.accepted_by);
      // Never attach an invite to one of two disagreeing identities.
      if (byAgent && accepted && byAgent !== accepted) { this.conflicts++; return; }
      const owner = byAgent || accepted;
      const address = email(row.email);
      if (owner && address) { const list = this.inviteEmails.get(owner) ?? new Set(); list.add(address); this.inviteEmails.set(owner, list); }
      return;
    }
    if (!uid) { this.withoutActorId[stage]++; return; }
    const agentOwner = this.agentIds.get(uid);
    if (agentOwner && this.agents.has(uid) && agentOwner !== uid) { this.conflicts++; return; }
    const id = this.agents.has(uid) ? uid : agentOwner ?? uid;
    const actor = this.actors.get(id) ?? { id, names: new Map(), emails: new Map(), cities: new Set(), types: new Set(), roles: new Set(), history: 0, activity: 0, first: "", last: "" };
    actor[stage]++;
    if (text(row.name)) actor.names.set(text(row.name), (actor.names.get(text(row.name)) ?? 0) + 1);
    const address = email(row.email);
    if (address) { const sources = actor.emails.get(address) ?? new Set(); sources.add("ActivityEvent.actorEmail"); actor.emails.set(address, sources); }
    for (const c of [row.city, ...(row.cities ?? [])]) if (city(c)) actor.cities.add(city(c));
    if (row.event_type) actor.types.add(`${stage}:${row.event_type}`);
    if (row.role) actor.roles.add(row.role);
    if (row.at && (!actor.first || row.at < actor.first)) actor.first = row.at;
    if (row.at && row.at > actor.last) actor.last = row.at;
    this.actors.set(id, actor);
  }

  finish() {
    const rows = [...this.actors.values()].map(actor => {
      const profile = this.agents.get(actor.id);
      for (const address of this.inviteEmails.get(actor.id) ?? []) {
        const sources = actor.emails.get(address) ?? new Set(); sources.add("AgentInvite aceite"); actor.emails.set(address, sources);
      }
      const names = [...actor.names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt"));
      const observed = join(actor.cities), assigned = join(profile?.cities ?? []);
      return {
        nome_agente: profile?.name || names[0]?.[0] || "", email: join(actor.emails.keys()),
        cidade: observed || assigned, agente_user_id: actor.id,
        identificacao: profile ? "FICHA_AGENT" : "SEM_FICHA_AGENT",
        estado_email: actor.emails.size === 0 ? "SEM_EMAIL" : actor.emails.size > 1 ? "VARIOS_EMAILS_REGISTADOS" : "EMAIL_ENCONTRADO",
        fonte_email: join([...actor.emails.values()].flatMap(s => [...s])),
        fonte_cidade: observed ? "HISTORICO_DAS_INTERACOES" : assigned ? "PARQUES_DA_FICHA_ATUAL" : "SEM_CIDADE",
        cidades_com_interacao: observed, cidades_da_ficha_atual: assigned,
        primeira_interacao_utc: actor.first, ultima_interacao_utc: actor.last,
        registos_history: actor.history, registos_activity_event: actor.activity,
        tipos_interacao: join(actor.types), nomes_no_historico: join(actor.names.keys()),
        perfis: join(profile?.roles ?? actor.roles), ficha_ativa_atualmente: profile ? (profile.active ? "sim" : "nao") : "",
      };
    }).sort((a, b) => a.nome_agente.localeCompare(b.nome_agente, "pt") || a.agente_user_id.localeCompare(b.agente_user_id));
    return { agents: rows.filter(r => r.identificacao === "FICHA_AGENT"), otherActors: rows.filter(r => r.identificacao !== "FICHA_AGENT"),
      counts: this.counts, withoutActorId: this.withoutActorId, identityConflicts: this.conflicts };
  }
}

export async function collectActiveAgents(reader: AgentExportReader, pageSize = 1000, progress: (stage: string, count: number) => void = () => {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error("Lote inválido (1 a 1000).");
  const collector = new ActiveAgentsCollector();
  for (const stage of AGENT_EXPORT_STAGES) {
    let cursor = "";
    while (true) {
      const rows = await reader(stage, cursor, pageSize);
      if (!rows.length) break;
      for (const row of rows) collector.add(stage, row);
      const next = rows.at(-1)!.id;
      if (!next || next === cursor) throw new Error("O cursor não avançou.");
      cursor = next; progress(stage, collector.counts[stage]);
      if (rows.length < pageSize) break;
    }
  }
  return collector.finish();
}

export type ActiveAgentExportRow = ReturnType<ActiveAgentsCollector["finish"]>["agents"][number];
export const AGENT_CSV_COLUMNS = ["nome_agente", "email", "cidade", "agente_user_id", "identificacao", "estado_email", "fonte_email", "fonte_cidade", "cidades_com_interacao", "cidades_da_ficha_atual", "primeira_interacao_utc", "ultima_interacao_utc", "registos_history", "registos_activity_event", "tipos_interacao", "nomes_no_historico", "perfis", "ficha_ativa_atualmente"] as const;
export const agentExportCsv = (rows: ActiveAgentExportRow[]) => "\uFEFF" + [AGENT_CSV_COLUMNS.map(csvCell).join(";"), ...rows.map(r => AGENT_CSV_COLUMNS.map(c => csvCell(r[c])).join(";"))].join("\r\n") + "\r\n";
