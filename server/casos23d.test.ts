/**
 * P3 lote 23d — respostas do Jorge depois do lote 23 (3 out 2026):
 *  1. D19 também nas Críticas, Ocorrências e Perdidos: condutores e extras não
 *     veem nada (nem os casos em que estão envolvidos); só a partir de team leader;
 *  2. o responsável de um caso só pode ser team leader ou acima;
 *  3. o aviso "o cliente respondeu" fica só no sino (sem email);
 *  4. "Outro" como método de devolução obriga a escrever como foi.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  item: null as any,
  updates: [] as Array<[number, any]>,
  // ficha → contas (papel, ativa) e dados da ficha
  people: new Map<number, { fullName: string; isActive: boolean; projectId: number | null; roles: string[] }>(),
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
  getGoogleReviews: async () => [{ id: 1 }, { id: 2 }],
  getLostFoundItemById: async () => state.item,
  updateLostFoundItem: async (id: number, data: any) => { state.updates.push([id, data]); },
  getDb: async () => ({
    execute: async () => {
      const rows: any[] = [];
      for (const [id, p] of state.people) for (const role of p.roles) rows.push({ id, fullName: p.fullName, isActive: p.isActive ? 1 : 0, projectId: p.projectId, role });
      return [rows];
    },
  }),
}));
vi.mock("./multiparkDb/bookingFile", async (original) => ({
  ...(await original<object>()),
  getBookingFileFeedback: async () => ({ available: true, data: { data: { occurrences: [{ id: "o1", title: "Risco", resolved: false }], reviews: [] }, missing: [] } }),
}));

import { appRouter } from "./routers";
import { can, type ModuleId } from "../shared/access";
import { lostReturnedError } from "../shared/caseRules";
import { assertCaseAssignee, caseAssigneeOptions, isCaseAssigneeRole } from "./caseAssignees";
import { kindDef } from "../shared/notificationRouting";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { MIGRATION_0435_STATEMENTS } from "./migrations/migration_0435";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const caller = (role: string) => appRouter.createCaller({ user: { id: 77, role, name: "Rita" }, req: { headers: {} }, res: {} } as any);
const sees = (role: string, m: ModuleId) => can(role as any, m, "view");

beforeEach(() => {
  state.item = { id: 9, projectId: 10, status: "found", archivedAt: null, returnMethod: null, returnedAt: null, returnNote: null, assignedTo: 5 };
  state.updates = [];
  state.people = new Map([
    [5, { fullName: "Bruno Condutor", isActive: true, projectId: 10, roles: ["condutor"] }],
    [6, { fullName: "Teresa TL", isActive: true, projectId: 10, roles: ["team_leader"] }],
    [7, { fullName: "Sem Conta", isActive: true, projectId: 10, roles: [] }],
    [8, { fullName: "Ana Duas Contas", isActive: true, projectId: 11, roles: ["extra", "supervisor"] }],
    [9, { fullName: "Rui Inativo", isActive: false, projectId: 10, roles: ["supervisor"] }],
    [10, { fullName: "Back Office", isActive: true, projectId: null, roles: ["backoffice"] }],
  ]);
});

describe("1 · D19 nas Críticas, Ocorrências e Perdidos", () => {
  it("matriz: extra e condutor não veem os 4 módulos de casos; team leader vê", () => {
    for (const r of ["extra", "condutor"]) for (const m of ["reclamacoes", "criticas", "ocorrencias", "perdidos"] as ModuleId[]) expect(sees(r, m)).toBe(false);
    for (const m of ["reclamacoes", "criticas", "ocorrencias", "perdidos"] as ModuleId[]) expect(sees("team_leader", m)).toBe(true);
  });

  it("as rotas recusam extra e condutor (nem os casos em que estão envolvidos)", async () => {
    for (const role of ["extra", "condutor"]) {
      const c = caller(role);
      await expect(c.reviews.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(c.reviews.getById({ id: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(c.lostFound.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(c.lostFound.getById({ id: 9 })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(c.lostFound.getMessages({ itemId: 9 })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(c.lostFound.slaDays()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(c.incidents.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(c.incidents.getById({ id: 3 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(await caller("team_leader").reviews.list()).toHaveLength(2);
  });

  it("o código dos 'casos próprios' saiu (sem alcance own nos módulos de casos)", () => {
    const r = src("server/routers.ts");
    expect(r).not.toMatch(/OwnCaseKind|filterOwnCases|assertOwnCase|ownCaseIds/);
    expect(r).not.toMatch(/"(reclamacoes|criticas|ocorrencias|perdidos)", "view", \{ allowOwn: true \}/);
  });

  it("ficha da reserva: o condutor fica sem a lista de ocorrências (e sabe porquê); o team leader vê", async () => {
    const cond = await caller("condutor").bookingFile.feedback({ id: "bk1" });
    expect(cond).toMatchObject({ available: true, occurrencesHidden: true, occurrences: [] });
    const tl = await caller("team_leader").bookingFile.feedback({ id: "bk1" });
    expect(tl).toMatchObject({ available: true, occurrencesHidden: false });
    expect((tl as any).occurrences).toHaveLength(1);
    expect(src("client/src/pages/BookingFilePage.tsx")).toMatch(/d\.occurrencesHidden \? <p[^>]*>As ocorrências só aparecem a team leaders e acima\./);
  });
});

describe("2 · responsável só team leader ou acima", () => {
  it("regra pelo papel", () => {
    expect(isCaseAssigneeRole("condutor")).toBe(false);
    expect(isCaseAssigneeRole("extra")).toBe(false);
    expect(isCaseAssigneeRole("team_leader")).toBe(true);
    expect(isCaseAssigneeRole("backoffice")).toBe(true);
    expect(isCaseAssigneeRole(null)).toBe(false);
  });

  it("recusa um responsável NOVO abaixo de team leader ou sem conta; o atual (mesmo valor) não é recusado", async () => {
    await expect(assertCaseAssignee(5, null)).rejects.toThrow(/team leader ou acima/);
    await expect(assertCaseAssignee(7, null)).rejects.toThrow(/team leader ou acima/);
    await expect(assertCaseAssignee(6, null)).resolves.toBeUndefined();
    await expect(assertCaseAssignee(8, null)).resolves.toBeUndefined(); // conta extra de supervisor conta
    await expect(assertCaseAssignee(5, 5)).resolves.toBeUndefined();
    await expect(assertCaseAssignee(null, 5)).resolves.toBeUndefined();
  });

  it("lista de quem pode ser responsável: ativos, team leader+, na cidade (nacionais sempre)", async () => {
    expect((await caseAssigneeOptions()).map((p) => p.id)).toEqual([8, 10, 6]);
    expect((await caseAssigneeOptions([10])).map((p) => [p.id, p.roleLabel])).toEqual([[10, "Backoffice"], [6, "Team Leader"]]);
  });

  it("as rotas aplicam a regra (reclamações e perdidos) e dão a lista a quem edita", async () => {
    await expect(caller("supervisor").lostFound.update({ id: 9, assignedTo: 5 } as any)).resolves.toBeTruthy(); // já era o responsável
    await expect(caller("supervisor").lostFound.update({ id: 9, assignedTo: 7 } as any)).rejects.toThrow(/team leader ou acima/);
    await caller("supervisor").lostFound.update({ id: 9, assignedTo: 6 } as any);
    expect(state.updates.at(-1)?.[1]).toMatchObject({ assignedTo: 6 });
    expect((await caller("supervisor").lostFound.assigneeOptions()).map((p) => p.id)).toEqual([8, 10, 6]);
    await expect(caller("condutor").complaints.assigneeOptions()).rejects.toMatchObject({ code: "FORBIDDEN" });
    const r = src("server/routers.ts");
    expect(r).toMatch(/await assertCaseAssignee\(input\.assignedToId, null\);/);
    expect(r).toMatch(/await assertCaseAssignee\(rest\.assignedToId, cur\.assignedToId \?\? null\);/);
  });

  it("os seletores só mostram team leader+; um responsável antigo abaixo disso aparece para se trocar", () => {
    const card = src("client/src/components/CaseAssignmentCard.tsx");
    expect(card).toMatch(/\(abaixo de team leader — troca\)/);
    expect(src("client/src/pages/ComplaintsPage.tsx")).toMatch(/trpc\.complaints\.assigneeOptions\.useQuery/);
    expect(src("client/src/pages/ComplaintsPage.tsx")).not.toMatch(/trpc\.rh\.list\.useQuery/);
    expect(src("client/src/pages/lostFound/DetailView.tsx")).toMatch(/people=\{assigneeOptions\.map/);
  });
});

describe("3 · aviso 'o cliente respondeu' só no sino", () => {
  it("o tipo só tem o canal do sino", () => {
    expect(kindDef("complaint_client_reply")?.channels).toEqual(["in_app"]);
  });
});

describe("4 · 'Outro' obriga a escrever como foi", () => {
  const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);

  it("regra pura", () => {
    const base = { status: "returned", returnMethod: "outro", returnedAt: "2026-10-03 00:00:00" };
    expect(lostReturnedError(base, NOW)).toMatch(/Outro.*escreve como foi devolvido/);
    expect(lostReturnedError({ ...base, returnNote: "  " }, NOW)).toMatch(/Outro/);
    expect(lostReturnedError({ ...base, returnNote: "Levantou o filho em Faro" }, NOW)).toBeNull();
    expect(lostReturnedError({ ...base, returnMethod: "correio" }, NOW)).toBeNull();
  });

  it("rota: Devolvido com 'Outro' sem nota é recusado; com nota passa; não se apaga a nota de um Devolvido 'Outro'", async () => {
    state.item = { ...state.item, assignedTo: null };
    await expect(caller("supervisor").lostFound.update({ id: 9, status: "returned", returnMethod: "outro", returnedAt: "2026-10-02 00:00:00" })).rejects.toThrow(/Outro/);
    await caller("supervisor").lostFound.update({ id: 9, status: "returned", returnMethod: "outro", returnedAt: "2026-10-02 00:00:00", returnNote: "Levantou o filho em Faro" });
    expect(state.updates.at(-1)?.[1]).toMatchObject({ status: "returned", returnMethod: "outro", returnNote: "Levantou o filho em Faro" });
    state.item = { ...state.item, status: "returned", returnMethod: "outro", returnedAt: "2026-10-02 00:00:00", returnNote: "Levantou o filho em Faro" };
    await expect(caller("supervisor").lostFound.update({ id: 9, returnNote: null })).rejects.toThrow(/Outro/);
  });

  it("migração 0435: só acrescenta a coluna returnNote", () => {
    expect(SCHEMA_MIGRATION_IDS).toContain("0435");
    expect(SCHEMA_MIGRATION_IDS.indexOf("0435")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0430"));
    expect(MIGRATION_0435_STATEMENTS).toEqual(["ALTER TABLE `lost_found_items` ADD COLUMN `returnNote` VARCHAR(500) NULL"]);
    expect(src("drizzle/schema.ts")).toMatch(/returnNote: varchar\(\{ length: 500 \}\)/);
  });

  it("janela e painel pedem a nota com 'Outro'", () => {
    const p = src("client/src/pages/lostFound/ReturnPanel.tsx");
    expect(p).toMatch(/const needsNote = method === "outro";/);
    expect(p).toMatch(/\(!needsNote \|\| !!note\.trim\(\)\)/);
    expect(p).toMatch(/returnNote: form\.returnNote\.trim\(\) \|\| null/);
  });
});
