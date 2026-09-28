import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("./client", async (importOriginal) => {
  const real = await importOriginal<typeof import("./client")>();
  return { ...real, multiparkDbQuery: (...args: any[]) => queryMock(...args) };
});

import { assertReadOnlySql } from "./client";
import {
  ACTIVITY_ROW_LIMIT,
  buildActivityActionsSql,
  buildActivityDetailSql,
  buildAgentCanonicalNamesSql,
  buildAgentIdForNameSql,
  buildLiveAgentsSql,
  findAgentIdForNameLive,
  getActivityActionsLive,
  getActivityDetailLive,
  getAgentNamesLive,
  listLiveAgents,
  mapActivityActionRow,
  mapActivityDetailRow,
  mapLiveAgentRow,
  sinceUtc,
} from "./activityLive";

const ENV = "DATABASE_URL_MULTIPARK";
let savedEnv: string | undefined;
beforeEach(() => { savedEnv = process.env[ENV]; queryMock.mockReset(); process.env[ENV] = "postgres://ro@db/mp"; });
afterEach(() => { if (savedEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv; });

const W = { from: "2026-09-26 23:00:00", to: "2026-09-27 23:00:00" };

describe("Atividade do Dia — ações ao vivo", () => {
  it("History na janela UTC, agregado ao minuto, com cidade opcional", () => {
    const { sql, params } = buildActivityActionsSql({ ...W, cities: ["Lisboa"] });
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain(`h."actionTime" >= $1::timestamp AND h."actionTime" < $2::timestamp`);
    expect(sql).toContain(`date_trunc('minute', h."actionTime")`);
    expect(sql).toContain(`COALESCE(NULLIF(h."agentName", ''), NULLIF(ag."name", ''))`);
    expect(sql).toContain(`lower(trim(p."city")) IN ($3, $4)`);
    expect(params).toEqual([W.from, W.to, "lisboa", "lisbon", ACTIVITY_ROW_LIMIT]);
    expect(buildActivityActionsSql({ ...W, cities: [] }).sql).toContain("FALSE");
    expect(buildActivityActionsSql(W).sql).not.toContain(`p."city"`);
  });

  it("linha → ação (hora em UTC ISO, peso = contagem)", () => {
    expect(mapActivityActionRow({ user_id: "u1", agent_name: " Ana ", change_type: "check_in", at: "2026-09-27 08:15:00", n: "3" }))
      .toEqual({ agentUserId: "u1", agentName: "Ana", changeType: "CHECK_IN", actionTime: "2026-09-27T08:15:00.000Z", n: 3 });
    expect(mapActivityActionRow({ user_id: "u1", at: null })).toBeNull();
  });

  it("leitura: dados; sem BD configurada → indisponível sem lançar", async () => {
    queryMock.mockResolvedValueOnce([{ user_id: "u1", agent_name: "Ana", change_type: "MOVEMENT", at: "2026-09-27 08:15:00", n: 2 }]);
    const r = await getActivityActionsLive(W);
    expect(r).toMatchObject({ available: true, data: { truncated: false } });
    if (r.available) expect(r.data.rows[0]).toMatchObject({ agentUserId: "u1", n: 2 });
    delete process.env[ENV];
    expect(await getActivityActionsLive(W)).toMatchObject({ available: false, code: "NOT_CONFIGURED" });
  });

  it("detalhe da gaveta: por ids OU nomes, no formato da cópia local", async () => {
    const { sql, params } = buildActivityDetailSql({ ...W, userIds: ["u1", "u1", " "], names: ["Ana Silva"] });
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain(`(h."userId" IN ($3) OR lower(trim(COALESCE(NULLIF(h."agentName", ''), NULLIF(ag."name", '')))) IN ($4))`);
    expect(params.slice(0, 4)).toEqual([W.from, W.to, "u1", "ana silva"]);
    expect(buildActivityDetailSql(W).sql).toContain("FALSE");
    expect(mapActivityDetailRow({ booking_id: "b1", change_type: "check_out", action_time: "2026-09-27 10:00:00", agent_name: "Ana", plate: "AA-00-BB", booking_code: "MP123", park_name: "P1" }))
      .toEqual({ bookingExternalId: "b1", changeType: "CHECK_OUT", actionTime: "2026-09-27T10:00:00.000Z", agentName: "Ana", licensePlate: "AA-00-BB", bookingNumber: "MP123", parkName: "P1" });
    // sem quem → nem consulta
    expect(await getActivityDetailLive({ ...W })).toEqual({ available: true, data: [] });
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("catálogo de agentes ao vivo", () => {
  it("History recente + Agent (ativos, sem só-parceiro) + email do convite", () => {
    const { sql, params } = buildLiveAgentsSql({ since: "2026-04-01 00:00:00" });
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain(`FROM act FULL OUTER JOIN ag ON ag.uid = act.uid`);
    expect(sql).toContain(`WHERE act.uid IS NOT NULL OR (ag.active AND NOT ag.partner_only)`);
    expect(sql).toContain(`FROM "AgentInvite" i`);
    expect(params[0]).toBe("2026-04-01 00:00:00");
  });

  it("linha → agente (nome mais usado primeiro, depois o do Agent; email em minúsculas)", () => {
    expect(mapLiveAgentRow({ user_id: "u1", history_names: ["Ana S", "Ana Silva"], agent_name: "Ana Silva", email: "Ana@X.pt", active: true, total: "7", checkins: 2, checkouts: 1, movements: 3, first_at: "2026-09-01 10:00:00", last_at: "2026-09-27 08:00:00" }))
      .toEqual({ agentUserId: "u1", agentName: "Ana S", agentNames: ["Ana S", "Ana Silva"], email: "ana@x.pt", active: true, total: 7, checkins: 2, checkouts: 1, movements: 3, firstSeen: "2026-09-01T10:00:00.000Z", lastSeen: "2026-09-27T08:00:00.000Z" });
    // sem ações: só o nome do Agent; array em texto do Postgres
    expect(mapLiveAgentRow({ user_id: "u2", history_names: '{"Rui Costa",Rui}', agent_name: null, active: "t", total: 0 })).toMatchObject({ agentName: "Rui Costa", agentNames: ["Rui Costa", "Rui"], active: true, lastSeen: null });
    expect(mapLiveAgentRow({ user_id: null })).toBeNull();
  });

  it("listLiveAgents lê desde há 180 dias", async () => {
    queryMock.mockResolvedValueOnce([{ user_id: "u1", history_names: [], agent_name: "Ana", active: true, total: 0 }]);
    const r = await listLiveAgents({ nowMs: Date.UTC(2026, 8, 27, 12) });
    expect(r).toMatchObject({ available: true, data: [{ agentUserId: "u1", agentName: "Ana" }] });
    expect(queryMock.mock.calls[0][1][0]).toBe(sinceUtc(180, Date.UTC(2026, 8, 27, 12)));
  });

  it("id do agente pelo nome: History recente e, sem ações, o Agent", async () => {
    const { sql, params } = buildAgentIdForNameSql(" Ana Silva ", "2026-04-01 00:00:00");
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain(`FROM "Agent" a WHERE lower(trim(a."name")) = $1`);
    expect(params).toEqual(["ana silva", "2026-04-01 00:00:00"]);
    queryMock.mockResolvedValueOnce([{ user_id: "u9" }]);
    expect(await findAgentIdForNameLive("Ana Silva")).toEqual({ available: true, data: "u9" });
    queryMock.mockResolvedValueOnce([]);
    expect(await findAgentIdForNameLive("Ninguém")).toEqual({ available: true, data: null });
    expect(await findAgentIdForNameLive("  ")).toEqual({ available: true, data: null });
  });

  it("nome canónico de um agente", async () => {
    const { sql } = buildAgentCanonicalNamesSql(["u1"], "2026-04-01 00:00:00");
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    queryMock.mockResolvedValueOnce([{ user_id: "u1", name: "Ana Silva" }]);
    const r = await getAgentNamesLive(["u1"]);
    expect(r.available && r.data.get("u1")).toBe("Ana Silva");
  });
});
