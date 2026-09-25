import { describe, expect, it } from "vitest";
import { createFakeDb, type FakeQuery } from "./_core/ai/testUtils";
import { cityScope } from "./cityScope";
import { globalSearch, type SearchSource } from "./globalSearch";
import {
  NAV_ENTRIES, addRecentSearch, matchNavigation, matchScore, parseRecentSearches, parseSearch, rankGroups, seeAllHref, type SearchGroupResult,
} from "../shared/globalSearch";

// Âmbitos de cidade como o middleware os põe (ids de projeto por cidade).
const PORTO = { all: false, defaultCityId: 50, cityName: "Porto", cityNames: ["Porto"], cityIds: [50], projectIds: [50, 65], missingCostCenter: false };
const LISBOA = { all: false, defaultCityId: 10, cityName: "Lisboa", cityNames: ["Lisboa"], cityIds: [10], projectIds: [10, 11], missingCostCenter: false };
const FARO = { all: false, defaultCityId: 90, cityName: "Faro", cityNames: ["Faro"], cityIds: [90], projectIds: [90], missingCostCenter: false };
const ALL = { all: true, defaultCityId: null, cityName: undefined, cityNames: ["Lisboa", "Porto", "Faro"], cityIds: [10, 50, 90], projectIds: [10, 11, 50, 65, 90], missingCostCenter: false };

function respond(q: FakeQuery): unknown {
  if (q.sql.startsWith("SELECT id FROM employees WHERE userId")) return [[{ id: 77 }]];
  if (q.sql.includes("FROM multipark_bookings b WHERE (")) {
    return [[{ id: 1, externalId: "EXT1", bookingNumber: "MP12345", status: "CONFIRMED", parkName: "Airpark", checkIn: "2026-09-20 10:00:00", clientFirstName: "Ana", clientLastName: "Silva", clientEmail: "ana@x.pt", licensePlate: "AA-00-BB", bookingCreatedAt: "2026-09-01 12:00:00" }]];
  }
  return [[]];
}

async function search(role: string, access: typeof PORTO | typeof ALL, q = "MP12345", overrides: any = null) {
  const d = createFakeDb(respond);
  const r = await cityScope.run(access as any, () => globalSearch(d as any, { id: 5, role, accessOverrides: overrides }, { q }));
  return { r, queries: d.queries };
}
const find = (qs: FakeQuery[], needle: string) => qs.filter((q) => q.sql.includes(needle));

describe("pesquisa global — acesso e cidade por fonte", () => {
  it("supervisor do Porto: todas as fontes da página filtram pelas cidades do Porto", async () => {
    const { r, queries } = await search("supervisor", PORTO);
    const bookings = find(queries, "FROM multipark_bookings b WHERE (");
    expect(bookings).toHaveLength(1);
    expect(bookings[0].sql).toContain("b.projectId IN");
    expect(bookings[0].params).toEqual(expect.arrayContaining([50, 65]));
    expect(bookings[0].params).not.toContain(10);
    expect(find(queries, "FROM complaints c")[0].sql).toContain("c.projectId IN");
    expect(find(queries, "FROM tasks t")[0].sql).toContain("(t.projectId IS NULL OR t.projectId IN");
    expect(find(queries, "FROM whatsapp_conversations")[0].sql).toContain("vis_lead");
    expect(find(queries, "FROM users u")[0].sql).toContain("city_employee.userId = u.id");
    expect(find(queries, "FROM mail_threads t")[0].sql).toContain("t.ownerUserId = ?");
    // Resultado: reserva com link filtrado e o dia de criação.
    const g = r.groups.find((x) => x.group === "reservas")!;
    expect(g.items[0]).toMatchObject({ title: "MP12345 · Ana Silva", score: 100 });
    expect(g.items[0].href).toBe("/operacoes?tab=reservas&q=MP12345&de=2026-09-01");
    expect(r.groups[0].group).toBe("reservas"); // correspondência exata primeiro
  });

  it("admin (todas as cidades): sem restrição de projeto", async () => {
    const { queries } = await search("admin", ALL);
    const b = find(queries, "FROM multipark_bookings b WHERE (")[0];
    expect(b.sql).not.toContain("b.projectId IN");
    expect(b.sql).toContain("1 = 1");
  });

  it("extra de Lisboa: sem reservas, reclamações (só as próprias), WhatsApp nem utilizadores; só as suas tarefas", async () => {
    const { queries } = await search("extra", LISBOA, "cofre");
    expect(find(queries, "multipark_bookings")).toHaveLength(0);
    expect(find(queries, "FROM complaints")).toHaveLength(0);
    expect(find(queries, "FROM whatsapp_conversations")).toHaveLength(0);
    expect(find(queries, "FROM users u")).toHaveLength(0);
    const t = find(queries, "FROM tasks t")[0];
    expect(t.sql).toContain("task_assignees");
    expect(t.params).toContain(77);
    expect(t.params).toEqual(expect.arrayContaining([10, 11]));
  });

  it("condutor de Faro: reservas de Faro (cidade), reclamações não (só as próprias)", async () => {
    const { queries } = await search("condutor", FARO);
    const b = find(queries, "FROM multipark_bookings b WHERE (")[0];
    expect(b.params).toContain(90);
    expect(b.params).not.toContain(50);
    expect(find(queries, "FROM complaints")).toHaveLength(0);
  });

  it("overrides por pessoa: retirar Reclamações tira a fonte; dar Reservas a um extra usa a cidade dele", async () => {
    const noComplaints = await search("supervisor", PORTO, "MP12345", { reclamacoes: { access: "none", actions: [] } });
    expect(find(noComplaints.queries, "FROM complaints")).toHaveLength(0);
    const extraWithBookings = await search("extra", LISBOA, "MP12345", { reservas_operacoes: { access: "city", actions: ["view"] } });
    const b = find(extraWithBookings.queries, "FROM multipark_bookings b WHERE (")[0];
    expect(b.params).toEqual(expect.arrayContaining([10, 11]));
  });

  it("base de conhecimento: só documentos visíveis (papel + cidades), sem a ajuda", async () => {
    const { queries } = await search("supervisor", PORTO, "manual");
    const kb = find(queries, "FROM kb_documents d")[0];
    expect(kb.sql).toContain("d.source <> 'help'");
    expect(kb.sql).toContain("JSON_CONTAINS(d.visibilityRoles");
    expect(kb.params).toEqual(expect.arrayContaining(["supervisor", "Porto"]));
  });

  it("pesquisa entra sempre como parâmetro (sem injeção)", async () => {
    const { queries } = await search("admin", ALL, "x%' OR 1=1 --");
    for (const q of queries) expect(q.sql).not.toContain("OR 1=1");
    expect(queries.some((q) => q.params.includes("%x\\%' or 1=1 --%"))).toBe(true);
  });

  it("pesquisa curta ou sem âmbito de cidade", async () => {
    const d = createFakeDb();
    expect((await cityScope.run(PORTO as any, () => globalSearch(d as any, { id: 1, role: "admin" }, { q: "a" }))).groups).toEqual([]);
    await expect(globalSearch(d as any, { id: 1, role: "admin" }, { q: "abc" })).rejects.toThrow();
  });

  it("uma fonte lenta não atrasa as outras (fica marcada 'sem resposta')", async () => {
    const slow: SearchSource = { group: "reservas", modules: [], run: () => new Promise(() => {}) };
    const fast: SearchSource = { group: "tarefas", modules: [], run: async () => [{ key: "tarefas:1", group: "tarefas", title: "Lavar", subtitle: null, href: "/tarefas?focus=1", score: 70 }] };
    const d = createFakeDb();
    const started = Date.now();
    const r = await cityScope.run(ALL as any, () => globalSearch(d as any, { id: 1, role: "admin" }, { q: "lav" }, { sources: [slow, fast], budgetMs: 50, includeHelp: false }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.groups.find((g) => g.group === "tarefas")?.items).toHaveLength(1);
    expect(r.groups.find((g) => g.group === "reservas")).toMatchObject({ timedOut: true, items: [] });
  });
});

describe("paleta — leitura, pontuação, ordem e grupos", () => {
  it("parseSearch reconhece email, matrícula, código e telefone", () => {
    expect(parseSearch("ana@x.pt").isEmail).toBe(true);
    expect(parseSearch("aa-00-bb").plate).toBe("AA00BB");
    expect(parseSearch("12 AB 34").plate).toBe("12AB34");
    expect(parseSearch("MP12345").isCode).toBe(true);
    expect(parseSearch("Ana Silva").isCode).toBe(false);
    expect(parseSearch("+351 912 345 678")).toMatchObject({ isPhone: true, digits: "351912345678" });
    expect(parseSearch("50%_off").like).toBe("%50\\%\\_off%");
  });

  it("matchScore: igual > começa por > palavra começa por > contém", () => {
    expect(matchScore("mp123", "MP123")).toBe(100);
    expect(matchScore("mp1", "MP123")).toBe(70);
    expect(matchScore("silva", "Ana Silva")).toBe(50);
    expect(matchScore("ilv", "Ana Silva")).toBe(30);
    expect(matchScore("João", "joao pereira")).toBe(70);
    expect(matchScore("zzz", "Ana")).toBe(0);
  });

  it("rankGroups: exatos primeiro, depois melhor resultado, empate pela ordem fixa; máx. 5 por grupo; vazios saem", () => {
    const item = (group: any, score: number, i = 0) => ({ key: `${group}:${i}`, group, title: `${group}${i}`, subtitle: null, href: "/", score });
    const groups: SearchGroupResult[] = [
      { group: "contactos", label: "", items: [item("contactos", 50)], seeAllHref: null },
      { group: "tarefas", label: "", items: [item("tarefas", 50)], seeAllHref: null },
      { group: "reservas", label: "", items: Array.from({ length: 8 }, (_, i) => item("reservas", i === 3 ? 100 : 30, i)), seeAllHref: null },
      { group: "email", label: "", items: [], seeAllHref: null },
      { group: "navegacao", label: "", items: [item("navegacao", 50)], seeAllHref: null },
    ];
    const r = rankGroups(groups);
    expect(r.map((g) => g.group)).toEqual(["reservas", "navegacao", "contactos", "tarefas"]);
    expect(r[0].items).toHaveLength(5);
    expect(r[0].items[0].score).toBe(100);
  });

  it("navegação: só páginas/ações que a pessoa pode abrir", () => {
    const extra = matchNavigation("reclama", { role: "extra" });
    expect(extra.map((x) => x.title)).toContain("Reclamações"); // extra vê as suas
    expect(extra.map((x) => x.title)).not.toContain("Nova reclamação"); // sem "edit"
    const sup = matchNavigation("nova recl", { role: "supervisor" });
    expect(sup[0]).toMatchObject({ title: "Nova reclamação", href: "/reclamacoes?new=1" });
    expect(matchNavigation("escala de amanha", { role: "team_leader" })[0].href).toBe("/extras-dia?dia=amanha");
    expect(matchNavigation("definicoes", { role: "supervisor" })).toEqual([]);
    expect(matchNavigation("definicoes", { role: "admin" })[0].href).toBe("/definicoes");
    expect(matchNavigation("base de conhecimento", { role: "supervisor" })).toEqual([]); // gerir = admin
    expect(matchNavigation("base de conhecimento", { role: "admin" })[0].href).toBe("/formacao/conhecimento");
    for (const e of NAV_ENTRIES) expect(e.path.startsWith("/")).toBe(true);
  });

  it("'ver todos' abre a página já filtrada", () => {
    expect(seeAllHref("reservas", "AA 00")).toBe("/operacoes?tab=reservas&q=AA%2000");
    expect(seeAllHref("tarefas", "x")).toBe("/tarefas?q=x");
    expect(seeAllHref("conhecimento", "x")).toBeNull();
  });

  it("pesquisas recentes: sem repetidas, a última primeiro, máximo 8", () => {
    let list: string[] = [];
    for (const q of ["ana", "MP1", "Ana", "b", "x1", "x2", "x3", "x4", "x5", "x6"]) list = addRecentSearch(list, q);
    expect(list[0]).toBe("x6");
    expect(list).toHaveLength(8);
    expect(list.filter((x) => x.toLowerCase() === "ana")).toHaveLength(1);
    expect(list).not.toContain("b");
    expect(parseRecentSearches('["ok", 3, "a"]')).toEqual(["ok"]);
    expect(parseRecentSearches("lixo")).toEqual([]);
  });
});
