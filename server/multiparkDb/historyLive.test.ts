import { describe, expect, it, vi } from "vitest";
import { buildLiveHistoryByAgentSql, buildLiveHistorySql, mapLiveHistoryRow, readLiveHistory, HISTORY_MAX_LIMIT } from "./historyLive";
import { assertReadOnlySql } from "./client";
import { supervisorTimings } from "../db";

describe("histórico ao vivo (\"History\" da Multipark)", () => {
  it("por reserva: só leitura, LIMIT, ordem mais recente primeiro", () => {
    const { sql, params } = buildLiveHistorySql({ bookingIds: ["bk1", "bk1", ""], limit: 500 });
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain(`h."bookingId" IN ($1)`);
    expect(sql).toContain(`ORDER BY h."actionTime" DESC`);
    expect(params).toEqual(["bk1", 500]);
  });
  it("matrícula exata ou contém, normalizada (sem hífenes/espaços)", () => {
    const e = buildLiveHistorySql({ plate: { exact: "aa-00-bb" }, limit: 10 });
    expect(e.sql).toContain(`upper(regexp_replace(coalesce(v."licensePlate", ''), '[^A-Za-z0-9]', '', 'g')) = $1`);
    expect(e.params[0]).toBe("AA00BB");
    const c = buildLiveHistorySql({ plate: { contains: "00 bb" }, limit: 10 });
    expect(c.params[0]).toBe("%00BB%");
  });
  it("agente, período, tipos, texto e cidades (vazio = nada)", () => {
    const q = buildLiveHistorySql({
      agentName: { exact: " João " }, from: "2026-09-01 00:00:00", to: "2026-09-02 00:00:00",
      changeTypes: ["check_out"], text: "50%", cities: ["Lisboa"], limit: 99999, order: "asc",
    });
    expect(q.sql).toContain(`lower(trim(h."agentName")) = $1`);
    expect(q.params).toEqual(expect.arrayContaining(["joão", "2026-09-01 00:00:00", "2026-09-02 00:00:00", "CHECK_OUT", "%50\\%%", "lisboa", "lisbon", HISTORY_MAX_LIMIT]));
    expect(q.sql).toContain(`ORDER BY h."actionTime" ASC`);
    expect(buildLiveHistorySql({ cities: [], limit: 1 }).sql).toContain("FALSE");
    expect(buildLiveHistorySql({ bookingIds: [], limit: 1 }).sql).toContain("FALSE");
  });
  it("contagens por agente (total, entradas, saídas, movimentos)", () => {
    const { sql } = buildLiveHistoryByAgentSql({ changeTypes: ["CHECK_OUT"], from: "2026-09-01 00:00:00" });
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain("GROUP BY 1");
    expect(sql).toContain(`count(*) FILTER (WHERE upper(h."changeType"::text) = 'CHECK_OUT') AS checkouts`);
  });
  it("mapeia no formato da cópia antiga (sem email do agente)", async () => {
    const raw = { history_id: "h1", booking_id: "bk1", change_type: "CHECK_IN", action_time: "2026-09-28 10:00:00", remarks: "", agent_name: "Rui", agent_user_id: "u1", plate: "AA-00-BB", park_name: "Airpark Lisboa", city: "Lisboa", booking_status: "CHECKED_IN", check_in: "2026-09-28 09:50:00" };
    expect(mapLiveHistoryRow(raw)).toMatchObject({ historyId: "h1", bookingExternalId: "bk1", changeType: "CHECK_IN", actionTime: "2026-09-28 10:00:00", remarks: null, agentEmail: null, licensePlate: "AA-00-BB", checkIn: "2026-09-28 09:50:00" });
    const q = vi.fn(async () => [raw]) as any;
    expect(await readLiveHistory({ bookingIds: ["bk1"], limit: 5 }, q)).toHaveLength(1);
  });
});

describe("painel do supervisor: tempos a partir do histórico", () => {
  const w = { start: "2026-09-28 02:00:00", end: "2026-09-29 02:00:00", checkoutEnd: "2026-09-29 12:00:00" };
  const r = (b: string, ct: string, t: string, o: any = {}) => ({ bookingExternalId: b, changeType: ct, actionTime: t, agentName: "Rui", checkIn: null, ...o });
  it("pendente→entrega (mesma reserva, < 10 h) e atraso na recolha vs previsto", () => {
    const { deliveryTimes, pickupDelays } = supervisorTimings([
      r("a", "PENDING_CHECKOUT", "2026-09-28 10:00:00"), r("a", "CHECK_OUT", "2026-09-28 10:25:00"),
      r("b", "PENDING_CHECKOUT", "2026-09-28 10:00:00"), r("b", "CHECK_OUT", "2026-09-28 22:00:00"),   // > 10 h: fora
      r("c", "CHECK_OUT", "2026-09-28 11:00:00"),                                                    // sem pendente: fora
      r("d", "CHECK_IN", "2026-09-28 08:20:00", { checkIn: "2026-09-28 08:00:00" }),
      r("d", "CHECK_IN", "2026-09-28 09:00:00", { checkIn: "2026-09-28 08:00:00" }),                 // conta o 1.º
    ], w);
    expect(deliveryTimes).toEqual([{ booking: "a", mins: 25, agent: "Rui" }]);
    expect(pickupDelays).toEqual([20]);
  });
});
