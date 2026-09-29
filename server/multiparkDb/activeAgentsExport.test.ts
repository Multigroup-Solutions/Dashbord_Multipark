import { describe, expect, it } from "vitest";
import { assertReadOnlySql } from "./client";
import { makePeriod } from "./initialBookingPrice";
import { ActiveAgentsCollector, AGENT_EXPORT_STAGES, agentExportPage, bookingDriversPage, agentExportCsv, collectActiveAgents, type AgentExportRecord, type AgentExportStage } from "./activeAgentsExport";

const at = "2026-06-01T10:00:00.000Z";
const period = makePeriod("2026-05-01", undefined, new Date(at));
describe("active agents across cities", () => {
  it("includes explicit historical agent roles even after the profile was removed", () => {
    const c = new ActiveAgentsCollector();
    c.add("activity", { id: "e1", user_id: "former-agent", role: "AGENT", name: "Former agent", email: "former@example.invalid", cities: ["porto"], at });
    c.add("activity", { id: "e2", user_id: "customer", role: "CLIENT", at });
    expect(c.finish().agents[0]).toMatchObject({ identificacao: "AGENTE_NO_HISTORICO", nome_agente: "Former agent", email: "former@example.invalid", cidade: "Porto" });
    expect(c.finish().otherActors).toHaveLength(1);
  });
  it("combines park records by account, includes inactive staff, and excludes accounts without activity", () => {
    const c = new ActiveAgentsCollector();
    c.add("agents", { id: "a1", user_id: "u1", name: "Ana", city: "lisbon", active: false });
    c.add("agents", { id: "a2", user_id: "u1", name: "Ana Silva", city: "porto", active: false, updated_at: at });
    c.add("agents", { id: "a3", user_id: "u2", name: "Ana Silva", city: "faro", active: true });
    c.add("agents", { id: "a4", user_id: "u3", name: "Sem atividade", active: true });
    c.add("invites", { id: "i1", accepted_by: "u1", created_agent_id: "a2", email: " ANA@example.invalid " });
    c.add("history", { id: "h1", user_id: "u1", name: "Ana antiga", city: "porto", at, event_type: "UPDATE" });
    c.add("activity", { id: "e1", user_id: "a1", name: "Ana", cities: ["lisbon"], at, email: "ana@example.invalid" });
    c.add("history", { id: "h2", user_id: "u2", name: "Ana Silva", at });
    const r = c.finish();
    expect(r.agents).toHaveLength(2);
    expect(r.agents.find(a => a.agente_user_id === "u1")).toMatchObject({ nome_agente: "Ana Silva", email: "ana@example.invalid", cidade: "Lisboa | Porto", ficha_ativa_atualmente: "nao", registos_history: 1, registos_activity_event: 1 });
    expect(r.agents.find(a => a.agente_user_id === "u2")).toMatchObject({ email: "", estado_email: "SEM_EMAIL", cidade: "Faro", fonte_cidade: "PARQUES_DA_FICHA_ATUAL" });
  });
  it("keeps unmatched authors, missing identities and conflicting invitations explicit", () => {
    const c = new ActiveAgentsCollector();
    c.add("agents", { id: "a1", user_id: "u1" });
    c.add("invites", { id: "i1", created_agent_id: "a1", accepted_by: "u2", email: "wrong@example.invalid" });
    c.add("history", { id: "h1", user_id: "u1", at });
    c.add("activity", { id: "e1", user_id: "deleted-user", name: "Old agent", email: "old@example.invalid", at });
    c.add("activity", { id: "e2", user_id: null, at });
    const r = c.finish();
    expect(r.agents[0]).toMatchObject({ email: "", cidade: "", fonte_cidade: "SEM_CIDADE" });
    expect(r.otherActors[0]).toMatchObject({ agente_user_id: "deleted-user", email: "old@example.invalid" });
    expect(r.identityConflicts).toBe(1);
    expect(r.withoutActorId.activity).toBe(1);
  });
  it("does not choose silently among multiple registered addresses", () => {
    const c = new ActiveAgentsCollector();
    c.add("agents", { id: "a1", user_id: "u1" });
    c.add("invites", { id: "i1", accepted_by: "u1", email: "old@example.invalid" });
    c.add("activity", { id: "e1", user_id: "u1", email: "new@example.invalid", at });
    c.add("activity", { id: "e2", user_id: "u1", email: "invalid", at: "2026-05-02T00:00:00.000Z" });
    expect(c.finish().agents[0]).toMatchObject({ email: "new@example.invalid | old@example.invalid", estado_email: "VARIOS_EMAILS_REGISTADOS", primeira_interacao_utc: "2026-05-02T00:00:00.000Z", ultima_interacao_utc: at });
  });
  it("does not resolve a colliding Agent.id and userId to either account", () => {
    const c = new ActiveAgentsCollector();
    c.add("agents", { id: "a1", user_id: "u1" });
    c.add("agents", { id: "u1", user_id: "u2" });
    c.add("history", { id: "h1", user_id: "u1", at });
    expect(c.finish()).toMatchObject({ agents: [], identityConflicts: 1 });
  });
  it("reads every page in every stage, including an exact-full last page", async () => {
    const records: Record<AgentExportStage, AgentExportRecord[]> = { agents: [{ id: "a1", user_id: "u1" }], invites: [], history: [{ id: "h1", user_id: "u1", at }, { id: "h2", user_id: "u1", at }], activity: [{ id: "e1", user_id: "u1", at }] };
    const calls: string[] = [];
    const r = await collectActiveAgents(async (stage, cursor, limit) => { calls.push(`${stage}:${cursor}`); return records[stage].filter(row => row.id > cursor).slice(0, limit); }, 1);
    expect(r.agents[0]).toMatchObject({ registos_history: 2, registos_activity_event: 1 });
    expect(calls).toContain("history:h2");
    expect(r.counts).toEqual({ agents: 1, invites: 0, history: 2, activity: 1 });
  });
  it("stops when the server repeats a page", async () => {
    await expect(collectActiveAgents(async () => [{ id: "a1" }], 1)).rejects.toThrow("cursor");
  });
  it("protects spreadsheet formula text", () => {
    const c = new ActiveAgentsCollector();
    c.add("agents", { id: "a1", user_id: "u1", name: "=formula" });
    c.add("history", { id: "h1", user_id: "u1", at });
    expect(agentExportCsv(c.finish().agents)).toContain("'=formula");
  });
});

describe("read-only queries", () => {
  it("uses explicit invitation identity links independently of the current invitation status", () => {
    const q = agentExportPage("invites", period, "", 1000);
    expect(q.sql).toContain('i."createdAgentId" IS NOT NULL');
    expect(q.sql).toContain('i."acceptedBy" IS NOT NULL');
    expect(q.sql).not.toContain('i."status"');
  });
  it("exports delivery and reception drivers in the prior reservation creation window", () => {
    const q = bookingDriversPage(period, "last-id", 1000);
    expect(() => assertReadOnlySql(q.sql)).not.toThrow();
    expect(q.sql).toContain('b."createdAt" >= $1');
    expect(q.sql).toContain('b."checkOutDriverName"');
    expect(q.sql).toContain('b."checkInDriverId"');
    expect(q.params).toEqual([period.startUtc, period.endUtc, "last-id", 1000]);
  });
  it.each(AGENT_EXPORT_STAGES)("uses parameters, bounded pages, and no private payloads for %s", stage => {
    const q = agentExportPage(stage, period, "cursor';DROP TABLE x;--", 1000);
    expect(() => assertReadOnlySql(q.sql)).not.toThrow();
    expect(q.sql).not.toContain("DROP");
    expect(q.sql).not.toMatch(/snapshot|payload|token|ipAddress|userAgent/i);
    expect(q.params).toContain("cursor';DROP TABLE x;--");
    expect(q.params.at(-1)).toBe(1000);
    expect(q.sql).not.toMatch(/isActive.*=\s*true|createdAt/);
  });
  it("filters the interaction timestamp from midnight Lisbon, regardless of booking creation", () => {
    expect(period.startUtc).toBe("2026-04-30 23:00:00.000");
    expect(agentExportPage("history", period, "", 100).sql).toContain('h."actionTime" >= $1');
    expect(agentExportPage("activity", period, "", 100).sql).toContain('e."timestamp" >= $1');
  });
});
