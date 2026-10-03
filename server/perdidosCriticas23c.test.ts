/**
 * P3 lote 23c — Perdidos e Críticas (decisões do Jorge, 3 out 2026):
 *  - D22: "Devolvido" obriga a dizer como (método da lista) e quando (data);
 *  - D24: o prazo dos Perdidos vem de Definições → sla.lostFoundDays;
 *  - D27: na Performance de Agentes (Críticas) escolhe-se a ficha, não um nome.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  item: null as any,
  updates: [] as Array<[number, any]>,
  agentCalls: [] as any[],
  who: { fullName: "Rui Costa", agentUserIds: ["ag-1", "ag-2"] } as { fullName: string | null; agentUserIds: string[] },
}));
const national = vi.hoisted(() => ({ all: true, defaultCityId: null, cityName: null, cityIds: [] as number[], projectIds: [] as number[], missingCostCenter: false }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => national,
  loadCityAccessParts: async () => ({ access: national, base: national, all: national }),
}));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getUserPermissionOverrides: async () => ({}),
  getUserModuleOverrides: async () => ({}),
  logActivity: async () => {},
  getLostFoundItemById: async () => state.item,
  updateLostFoundItem: async (id: number, data: any) => { state.updates.push([id, data]); },
  getAgentHistoryFromDb: async (o: any) => { state.agentCalls.push(o); return { total: 1, period: { startDate: o.startDate, endDate: o.endDate }, agentName: "RUI C", agentUserId: "ag-1", history: [{ id: "h1", changeType: "CHECK_IN" }] }; },
}));
vi.mock("./personIdentity", async (original) => ({
  ...(await original<object>()),
  agentIdsOfEmployee: async () => state.who,
  employeesWithAgents: async () => [{ id: 7, fullName: "Rui Costa", isActive: true, agents: 2 }],
}));

import { appRouter } from "./routers";
import {
  DEFAULT_LOST_SLA_DAYS, LOST_RETURN_METHODS, isLostReturnMethod, lostAgeTone, lostReturnedError, lostSlaDays,
} from "../shared/caseRules";
import { SETTINGS } from "../shared/appSettings";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const caller = (role: string) => appRouter.createCaller({ user: { id: 77, role, name: "Rita" }, req: { headers: {} }, res: {} } as any);
const item = (o: any = {}) => ({ id: 9, projectId: 10, status: "found", archivedAt: null, returnMethod: null, returnedAt: null, closedAt: null, ...o });
const DAY = 86_400_000;

beforeEach(() => {
  state.item = item(); state.updates = []; state.agentCalls = [];
  state.who = { fullName: "Rui Costa", agentUserIds: ["ag-1", "ag-2"] };
});

describe("D22 — 'Devolvido' obriga método e data", () => {
  const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);

  it("regra pura", () => {
    expect([...LOST_RETURN_METHODS]).toEqual(["em_maos", "correio", "entrega", "outro"]);
    expect(isLostReturnMethod("correio")).toBe(true);
    expect(isLostReturnMethod("drone")).toBe(false);
    expect(lostReturnedError({ status: "found" }, NOW)).toBeNull();
    expect(lostReturnedError({ status: "returned", returnedAt: "2026-10-03 00:00:00" }, NOW)).toMatch(/como foi devolvido/);
    expect(lostReturnedError({ status: "returned", returnMethod: "em_maos" }, NOW)).toMatch(/data da devolução/);
    expect(lostReturnedError({ status: "returned", returnMethod: "em_maos", returnedAt: "2026-10-09 00:00:00" }, NOW)).toMatch(/futuro/);
    expect(lostReturnedError({ status: "returned", returnMethod: "em_maos", returnedAt: "2026-10-03 00:00:00" }, NOW)).toBeNull();
  });

  it("passar a Devolvido sem método ou sem data é recusado; com os dois fecha o caso", async () => {
    await expect(caller("supervisor").lostFound.update({ id: 9, status: "returned" })).rejects.toThrow(/como foi devolvido/);
    await expect(caller("supervisor").lostFound.update({ id: 9, status: "returned", returnMethod: "correio" })).rejects.toThrow(/data da devolução/);
    expect(state.updates).toEqual([]);
    await caller("supervisor").lostFound.update({ id: 9, status: "returned", returnMethod: "correio", returnedAt: "2026-10-02 00:00:00" });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0][1]).toMatchObject({ status: "returned", returnMethod: "correio", returnedAt: "2026-10-02 00:00:00", closedById: 77 });
  });

  it("método e data que já estavam no caso contam (só se escolhe o estado)", async () => {
    state.item = item({ returnMethod: "em_maos", returnedAt: "2026-10-01 00:00:00" });
    await caller("supervisor").lostFound.update({ id: 9, status: "returned" });
    expect(state.updates[0][1]).toMatchObject({ status: "returned" });
  });

  it("método fora da lista é recusado; o valor antigo que já lá estava fica", async () => {
    await expect(caller("supervisor").lostFound.update({ id: 9, returnMethod: "drone" })).rejects.toThrow(/Método de devolução inválido/);
    state.item = item({ returnMethod: "Levantou o filho" });
    await caller("supervisor").lostFound.update({ id: 9, returnMethod: "Levantou o filho", foundLocation: "porta-luvas" });
    expect(state.updates.at(-1)?.[1]).toMatchObject({ returnMethod: "Levantou o filho" });
  });

  it("data inválida é recusada", async () => {
    await expect(caller("supervisor").lostFound.update({ id: 9, returnedAt: "ontem" })).rejects.toThrow(/Data da devolução inválida/);
  });

  it("um Devolvido não perde o método nem a data; os antigos sem eles continuam editáveis e podem fechar", async () => {
    state.item = item({ status: "returned", returnMethod: "em_maos", returnedAt: "2026-10-01 00:00:00" });
    await expect(caller("supervisor").lostFound.update({ id: 9, returnMethod: null })).rejects.toThrow(/como foi devolvido/);
    state.item = item({ status: "returned" }); // antigo, sem método nem data
    await caller("supervisor").lostFound.update({ id: 9, description: "Óculos de sol" });
    await caller("supervisor").lostFound.update({ id: 9, status: "closed" });
    expect(state.updates.map(([, d]) => d.description ?? d.status)).toEqual(["Óculos de sol", "closed"]);
  });

  it("os 3 caminhos para Devolvido abrem a janela do método e da data", () => {
    const panel = src("client/src/pages/lostFound/ReturnPanel.tsx");
    expect(panel).toMatch(/export function MarkReturnedDialog/);
    expect(panel).toMatch(/save\.mutate\(\{ id: item\.id, status: "returned", returnMethod: method, returnedAt: `\$\{day\} 00:00:00`, returnNote: /);
    expect(panel).not.toMatch(/<SelectItem value="em_maos">/); // a lista vem de LOST_RETURN_METHODS
    const detail = src("client/src/pages/lostFound/DetailView.tsx");
    expect(detail).toMatch(/if \(status === "returned" && item\?\.status !== "returned"\) \{ setReturning\(true\); return; \}/);
    expect(detail).toMatch(/\{returning && <MarkReturnedDialog item=\{item\}/);
    const kanban = src("client/src/pages/lostFound/KanbanView.tsx");
    expect(kanban).toMatch(/if \(newStatus === "returned"\) \{[^]*?setReturning\(card\); return;/);
    expect(kanban).toMatch(/\{returning && <MarkReturnedDialog item=\{returning\}/);
  });
});

describe("D24 — prazo dos Perdidos das Definições", () => {
  const T0 = Date.UTC(2026, 9, 1, 10, 0, 0);
  const at = (days: number) => T0 + days * DAY;
  const open = { status: "new", createdAt: "2026-10-01 10:00:00" };

  it("a definição passou a mandar (live) e só aceita 1–90 dias", () => {
    expect(SETTINGS["sla.lostFoundDays"].wiring).toBe("live");
    expect(SETTINGS["sla.lostFoundDays"].defaultValue).toBe(DEFAULT_LOST_SLA_DAYS);
    expect(lostSlaDays(14)).toBe(14);
    expect(lostSlaDays(0)).toBe(7);
    expect(lostSlaDays("x")).toBe(7);
    expect(lostSlaDays(120)).toBe(7);
  });

  it("cor do 'Parado há N dias': âmbar a ~3/7 do prazo, vermelho no prazo", () => {
    expect(lostAgeTone(open, at(2), 7)?.tone).toBe("ok");
    expect(lostAgeTone(open, at(3), 7)?.tone).toBe("warn");
    expect(lostAgeTone(open, at(7), 7)).toEqual({ days: 7, tone: "late" });
    expect(lostAgeTone(open, at(7), 14)?.tone).toBe("warn");
    expect(lostAgeTone(open, at(5), 14)?.tone).toBe("ok");
    expect(lostAgeTone(open, at(14), 14)?.tone).toBe("late");
  });

  it("o prazo da Atribuição ganha ao da definição; fechados não têm cor", () => {
    expect(lostAgeTone({ ...open, dueDate: "2026-10-01 22:59:59" }, at(1), 7)?.tone).toBe("late");
    expect(lostAgeTone({ ...open, dueDate: "2026-10-20 22:59:59" }, at(10), 7)?.tone).toBe("warn");
    expect(lostAgeTone({ ...open, status: "returned" }, at(30), 7)).toBeNull();
    expect(lostAgeTone({ ...open, status: "converted" }, at(30), 7)).toBeNull();
  });

  it("painel e lembretes usam a definição (já não há 7 dias fixos no prazo)", () => {
    const ops = src("server/caseOps.ts");
    expect(ops).toMatch(/export async function lostFoundSlaDays\(\)/);
    expect(ops).toMatch(/COALESCE\(l\.dueDate, DATE_ADD\(l\.createdAt, INTERVAL \$\{slaDays\} DAY\)\)/);
    expect(ops).toMatch(/COALESCE\(dueDate, DATE_ADD\(createdAt, INTERVAL \$\{await lostFoundSlaDays\(\)\} DAY\)\) < \$\{nowStr\}/);
    expect(ops).not.toMatch(/dueDate, DATE_ADD\([^)]*INTERVAL 7 DAY/);
  });

  it("rota slaDays: sem definição gravada → 7; o quadro e o caso usam-na", async () => {
    expect(await caller("supervisor").lostFound.slaDays()).toEqual({ days: 7 });
    expect(src("client/src/pages/lostFound/KanbanView.tsx")).toMatch(/const age = lostAgeTone\(item, Date\.now\(\), slaDays\);/);
    expect(src("client/src/pages/lostFound/DetailView.tsx")).toMatch(/lostAgeTone\(item, Date\.now\(\), item\.slaDays\)/);
  });
});

describe("D27 — agentes das Críticas escolhidos pela ficha", () => {
  it("lista de fichas com agente: só quem vê as Críticas para lá do 'próprio'", async () => {
    expect(await caller("supervisor").reviews.agentPeople()).toEqual([{ id: 7, fullName: "Rui Costa", isActive: true, agents: 2 }]);
    await expect(caller("condutor").reviews.agentPeople()).rejects.toThrow(/não autorizado/);
  });

  it("histórico pelos agentes ligados à ficha (todos), nunca por nome", async () => {
    const r = await caller("supervisor").reviews.agentHistory({ startDate: "2026-10-01", endDate: "2026-10-03", employeeId: 7 });
    expect(state.agentCalls).toEqual([{ startDate: "2026-10-01", endDate: "2026-10-03", userIds: ["ag-1", "ag-2"] }]);
    expect(r).toMatchObject({ agentName: "Rui Costa", noAgent: false, total: 1 });
    // um nome escrito já não chega (sem ficha → pedido inválido)
    await expect(caller("supervisor").reviews.agentHistory({ startDate: "2026-10-01", endDate: "2026-10-03", agentName: "Rui" } as any)).rejects.toThrow();
    await expect(caller("supervisor").reviews.agentHistory({ startDate: "1 out", endDate: "2026-10-03", employeeId: 7 })).rejects.toThrow();
  });

  it("ficha sem agente ligado → diz isso (não 'sem ações'); ficha inexistente → não encontrada", async () => {
    state.who = { fullName: "Ana Lopes", agentUserIds: [] };
    const r = await caller("supervisor").reviews.agentHistory({ startDate: "2026-10-01", endDate: "2026-10-03", employeeId: 8 });
    expect(r).toMatchObject({ noAgent: true, agentName: "Ana Lopes", total: 0 });
    expect(state.agentCalls).toEqual([]);
    state.who = { fullName: null, agentUserIds: [] };
    await expect(caller("supervisor").reviews.agentHistory({ startDate: "2026-10-01", endDate: "2026-10-03", employeeId: 999 })).rejects.toThrow(/Ficha não encontrada/);
  });

  it("página: seletor de ficha em vez do nome escrito", () => {
    // 23e: o painel dos agentes passou para Pessoas → Condutores e agentes.
    const p = src("client/src/pages/CondutoresAgentesPage.tsx");
    const panel = p.slice(p.indexOf("function AgentPerformancePanel"));
    expect(panel).toMatch(/trpc\.reviews\.agentPeople\.useQuery\(\)/);
    expect(panel).toMatch(/\{ startDate, endDate, employeeId: Number\(employeeId\) \}/);
    expect(panel).toMatch(/<SearchableSelect/);
    expect(panel).not.toMatch(/Nome do Agente|placeholder="Ex: João Silva"/);
    expect(panel).toMatch(/data\?\.noAgent/);
  });
});
