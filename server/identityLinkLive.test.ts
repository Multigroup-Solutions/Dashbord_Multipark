import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ findLive: vi.fn(), listLive: vi.fn(), execute: vi.fn() }));
vi.mock("./multiparkDb/activityLive", async (orig) => ({
  ...(await orig<object>()),
  findAgentIdForNameLive: h.findLive,
  listLiveAgents: h.listLive,
}));
vi.mock("./db", () => ({ getDb: async () => ({ execute: h.execute }) }));

import { agentIdForName, loadAgentsSeen } from "./identityLink";

beforeEach(() => { h.findLive.mockReset(); h.listLive.mockReset(); h.execute.mockReset(); });

describe("ligação de agentes lê a BD da Multipark ao vivo (regressão #141)", () => {
  it("id do agente pelo nome: ao vivo, sem tocar na cópia local", async () => {
    h.findLive.mockResolvedValue({ available: true, data: "u42" });
    expect(await agentIdForName("Ana Silva")).toBe("u42");
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("id do agente pelo nome: BD da Multipark em baixo → cópia local", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.findLive.mockResolvedValue({ available: false, code: "CONNECT_FAILED", reason: "sem ligação" });
    h.execute.mockResolvedValue([[{ agentUserId: "old7", n: 3 }]]);
    expect(await agentIdForName("Ana Silva")).toBe("old7");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("agentes vistos: um por nome + emails, ao vivo", async () => {
    h.listLive.mockResolvedValue({ available: true, data: [
      { agentUserId: "u1", agentName: "Ana", agentNames: ["Ana", "Ana S"], email: "ana@x.pt", active: true, total: 5, checkins: 0, checkouts: 0, movements: 0, firstSeen: null, lastSeen: null },
      { agentUserId: "u2", agentName: null, agentNames: [], email: null, active: true, total: 0, checkins: 0, checkouts: 0, movements: 0, firstSeen: null, lastSeen: null },
    ] });
    const r = await loadAgentsSeen();
    expect(r.source).toBe("multipark");
    expect(r.agents).toEqual([{ id: "u1", name: "Ana", count: 5 }, { id: "u1", name: "Ana S", count: 5 }, { id: "u2", name: null, count: 0 }]);
    expect(r.emails).toEqual([{ agentUserId: "u1", agentName: "Ana", agentEmail: "ana@x.pt" }]);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("agentes vistos: sem BD da Multipark → cópia local com aviso", async () => {
    h.listLive.mockResolvedValue({ available: false, code: "TIMEOUT", reason: "Demorou." });
    h.execute.mockResolvedValueOnce([[{ id: "o1", name: "Rui", n: 2 }]]).mockResolvedValueOnce([[{ agentUserId: "o1", agentName: "Rui", agentEmail: "rui@x.pt" }]]);
    const r = await loadAgentsSeen();
    expect(r.source).toBe("copia");
    expect(r.notice).toMatch(/Demorou.*cópia local/);
    expect(r.agents).toEqual([{ id: "o1", name: "Rui", count: 2 }]);
  });
});
