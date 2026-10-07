/**
 * P3 lote 16a — Ocorrências: uma só fonte (a app Multipark, ao vivo) em todo o
 * lado (página, assistente, painel de Suporte, passagem de turno), as antigas
 * `incidents` do dashboard ficam guardadas mas só para leitura (sem lembretes,
 * sem DELETE), e uma leitura falhada nunca aparece como 0 ou "sem ocorrências".
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const state = vi.hoisted(() => ({ queries: [] as string[], previousOpenItems: [] as any[] }));
const dialect = new MySqlDialect();
const fakeDb = {
  select: () => ({ from: async () => [{ id: 49, parentId: null, name: "Lisboa", level: "city" }] }),
  update: () => ({ set: () => ({ where: async () => undefined }) }),
  execute: async (q: any) => {
    const text = dialect.sqlToQuery(q).sql;
    state.queries.push(text);
    if (/FROM `shift_handovers`/.test(text)) {
      return [[{ id: 7, notes: null, aiSummary: null, createdByName: "Ana", createdById: 1, ackByName: null, ackAt: null, openItems: JSON.stringify(state.previousOpenItems) }]];
    }
    return [[]];
  },
};

vi.mock("./db", async (original) => ({ ...(await original<object>()), getDb: async () => fakeDb }));
vi.mock("./multiparkDb/shiftState", () => ({
  getMultiparkShiftState: async () => ({ available: false, code: "QUERY_FAILED", reason: "sem BD da Multipark" }),
}));
vi.mock("./appSettings", async (original) => ({ ...(await original<object>()), getSetting: async () => [] }));
vi.mock("./whatsappInbox", () => ({ listConversations: async () => [] }));
vi.mock("./_core/featureFlags", async (original) => ({ ...(await original<object>()), isFeatureEnabled: () => true }));

import { appRouter } from "./routers";
import { buildHandoverDraft } from "./shiftHandoverDraft";
import { runCaseSlaReminders } from "./caseOps";
import { STAFF_TOOLS } from "./assistant/tools";
import { makeToolExecutor } from "./_core/ai/chat/tools";
import { openItemKey } from "../shared/shiftHandoverAuto";
import { seesBeyondOwn } from "../shared/access";
import { csvCell } from "../shared/csv";
import type { CityAccess } from "./cityAccess";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const LISBOA: CityAccess = { all: false, defaultCityId: 10, cityName: "Lisboa", cityNames: ["Lisboa"], cityIds: [10], projectIds: [10, 11, 12], missingCostCenter: false };
const toolCtx = (role: string, call: (path: string, input?: unknown) => Promise<any>) =>
  ({ user: { id: 7, role }, access: LISBOA, call: vi.fn(call), today: "2026-10-02", financeAllowed: false, helpDocs: [] }) as any;

beforeEach(() => { state.queries = []; state.previousOpenItems = []; });

describe("Assistente: as ocorrências abertas são as da app Multipark", () => {
  it("lê incidents.multipark (abertas, com a cidade) e não a tabela antiga", async () => {
    const ctx = toolCtx("supervisor", async (path) => {
      if (path === "incidents.multipark") {
        return {
          available: true, hasMore: false,
          rows: [{ id: "occ1", title: "Vidro aberto", priority: "HIGH", parkName: "Parque A", createdAt: "2026-10-01T10:00:00Z", plate: "AA-00-BB", remarks: "x" }],
          stats: { total: 12, open: 12, resolved: 0, highOpen: 3, byType: [{ key: "Vidro aberto", label: "Vidro aberto", count: 12 }], byPark: [] },
        };
      }
      return [];
    });
    const r = await makeToolExecutor(STAFF_TOOLS, ctx)({ name: "casos_abertos", args: { tipo: "ocorrencias", cidade: "Lisboa" } });
    expect(ctx.call).toHaveBeenCalledWith("incidents.multipark", { projectId: 10, resolved: false, limit: 10 });
    expect(ctx.call).not.toHaveBeenCalledWith("incidents.list", expect.anything());
    expect(r.ocorrencias).toMatchObject({ fonte: "app Multipark (ao vivo)", abertas: 12, altaPrioridadeAbertas: 3, porTipo: { "Vidro aberto": 12 } });
    expect(JSON.stringify(r)).not.toContain("AA-00-BB"); // sem matrículas
  });

  it("Multipark indisponível → 'indisponível', nunca 0 abertas", async () => {
    const ctx = toolCtx("supervisor", async () => ({ available: false, reason: "BD sem resposta" }));
    const r = await makeToolExecutor(STAFF_TOOLS, ctx)({ name: "casos_abertos", args: { tipo: "ocorrencias" } });
    expect(r.ocorrencias).toEqual({ indisponivel: "Não foi possível ler as ocorrências da app Multipark (BD sem resposta)." });
    expect(JSON.stringify(r)).not.toMatch(/"abertas":0/);
  });

  it("contagens em falta → 'contagem indisponível' (a lista continua)", async () => {
    const ctx = toolCtx("supervisor", async () => ({ available: true, rows: [], hasMore: false, stats: null }));
    const r = await makeToolExecutor(STAFF_TOOLS, ctx)({ name: "casos_abertos", args: { tipo: "ocorrencias" } });
    expect(r.ocorrencias).toMatchObject({ abertas: "contagem indisponível" });
  });

  it("condutor (só os próprios) não pede as ocorrências da cidade", async () => {
    const ctx = toolCtx("condutor", async () => []);
    const r = await makeToolExecutor(STAFF_TOOLS, ctx)({ name: "casos_abertos", args: { tipo: "todos" } });
    expect(ctx.call).not.toHaveBeenCalledWith("incidents.multipark", expect.anything());
    expect(r.ocorrencias).toBeUndefined();
  });
});

describe("Lembretes de prazo: as ocorrências antigas já não entram", () => {
  it("o cron não lê nem marca a tabela incidents (só perdidos e reclamações)", async () => {
    const r = await runCaseSlaReminders(new Date(Date.UTC(2026, 9, 2, 10, 0)), 11);
    expect(state.queries.some((q) => /FROM lost_found_items/.test(q))).toBe(true);
    expect(state.queries.some((q) => /FROM complaints/.test(q))).toBe(true);
    expect(state.queries.some((q) => /\bincidents\b/.test(q))).toBe(false);
    expect(r).toMatchObject({ incidents: 0, notified: 0 });
    const body = src("server/caseOps.ts").slice(src("server/caseOps.ts").indexOf("export async function runCaseSlaReminders"), src("server/caseOps.ts").indexOf("// ─── Conversões não destrutivas"));
    expect(body).not.toContain('kind: "incident_sla"');
  });
});

describe("Passagem de turno sem a Multipark: ocorrências = sem dados, não os #ids antigos", () => {
  const key = { date: "2026-10-02", shift: "morning" as const, city: "lisbon" as const };

  it("não lê a tabela antiga, marca a parte como falhada e a contagem como indisponível", async () => {
    const d = await buildHandoverDraft(key, Date.UTC(2026, 9, 2, 9, 0));
    expect(state.queries.some((q) => /FROM incidents/.test(q))).toBe(false);
    expect(d!.failed).toContain("incidents");
    expect(d!.unavailable).toContain("incidentsOpen");
    expect(d!.incidents).toEqual([]);
  });

  it("44b: uma ocorrência pendente da passagem anterior já não passa de turno (nem se dá como resolvida)", async () => {
    // Jorge, 7 out 2026: ocorrências e reclamações saíram da passagem de turno; a passagem antiga fica como estava.
    state.previousOpenItems = [{ key: openItemKey("incident", 41), kind: "incident", text: "Ocorrência #41", resolved: false, since: "2026-10-01 night" }];
    const d = await buildHandoverDraft(key, Date.UTC(2026, 9, 2, 9, 0));
    expect(d!.carryOver.find((i) => i.key === openItemKey("incident", 41))).toBeUndefined();
  });

  it("o aviso do painel já não diz que as ocorrências vêm das cópias", () => {
    const panel = src("client/src/components/ShiftHandoverDraftPanel.tsx");
    expect(panel).toContain("as ocorrências ficam sem dados (só existem na Multipark)");
    expect(panel).not.toContain("coberto e ocorrências vêm das cópias");
  });
});

describe("Antigas: guardadas, sem DELETE, abertas só para leitura", () => {
  it("incidents.delete deixou de existir (e o deleteIncident também)", async () => {
    const procs = (appRouter as any)._def.procedures as Record<string, unknown>;
    expect(procs["incidents.getById"]).toBeDefined();
    expect(procs["incidents.delete"]).toBeUndefined();
    expect(src("server/db.ts")).not.toContain("export async function deleteIncident");
  });

  it("a página abre `?id=` (ligações de emails e perdidos convertidos) numa vista só de leitura", () => {
    const page = src("client/src/pages/IncidentsPage.tsx");
    expect(page).toContain('get("id")');
    expect(page).toContain("function LegacyIncidentDialog");
    expect(page).toContain("trpc.incidents.getById.useQuery({ id }");
    const legacy = page.slice(page.indexOf("function LegacyIncidentDialog"));
    expect(legacy).not.toMatch(/useMutation/);
  });
});

describe("Página: leitura falhada ≠ vazio", () => {
  const page = src("client/src/pages/IncidentsPage.tsx");
  it("lista, detalhe e antiga com QueryErrorNote; indisponível e contagens em falta com Tentar de novo", () => {
    expect(page).toContain('<QueryErrorNote error={q.error} what="as ocorrências"');
    expect(page).toContain('what="esta ocorrência"');
    expect(page).toContain('what="esta ocorrência antiga"');
    expect(page).toContain("As contagens (total, abertas, por tipo e por parque) não responderam");
    expect((page.match(/Tentar de novo/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("um parque escolhido continua visível (e removível) quando as contagens falham", () => {
    expect(page).toContain("Parque filtrado ✕");
  });

  it("CSV: datas de Lisboa, células seguras e diz quantas leva", () => {
    expect(page).not.toContain("toISOString");
    expect(page).toContain("toCsv(headers, lines)");
    expect(page).toContain("csvDateTime(o.createdAt)");
    expect(page).toMatch(/csvPartial \? ` de \$\{total\}`/);
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvCell("+351 912")).toBe("'+351 912");
  });
});

describe("Painel de Suporte: ocorrências da Multipark, com a cidade, e falha ≠ 0", () => {
  const sup = src("client/src/pages/SuporteDashboard.tsx");
  it("usa incidents.multipark com o filtro de cidade (não incidents.stats da tabela antiga)", () => {
    expect(sup).not.toContain("trpc.incidents.stats");
    expect(sup).toContain("trpc.incidents.multipark.useQuery(");
    expect(sup).toContain("projectId: globalFilters.projectId");
  });
  it("leitura falhada mostra — e o aviso, nunca 0", () => {
    expect(sup).toContain('incidentStats ? incidentStats.open : "—"');
    expect(sup).not.toContain("incidentStats?.open ?? 0");
    expect(sup).toContain('what="as ocorrências da app Multipark"');
  });
});

describe("Menu: condutor e extra já não caem no cadeado", () => {
  it("o item Ocorrências só aparece a quem vê para lá dos próprios", () => {
    expect(seesBeyondOwn("condutor", "ocorrencias")).toBe(false);
    expect(seesBeyondOwn("extra", "ocorrencias")).toBe(false);
    expect(seesBeyondOwn("team_leader", "ocorrencias")).toBe(true);
    expect(seesBeyondOwn("backoffice", "ocorrencias")).toBe(true);
    const layout = src("client/src/components/DashboardLayout.tsx");
    expect(layout).toContain('path: "/ocorrencias", module: "ocorrencias", beyondOwn: true');
    expect(layout).toContain("if (item.beyondOwn) return mods.some(m => seesBeyondOwn(userRole, m));");
  });
});
