/**
 * Lote 44a — Extras-Dia: Pressão (tempo-limite das leituras pesadas, janela
 * anterior quando um grupo falha, mapa maior), "Por hora" com as 24 horas,
 * escala só com gente do RH (e "Permitir ser TL" daqui), Disponibilidade com
 * pesquisa por relevância.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MULTIPARK_DB_LONG_TIMEOUT_MAX_MS, statementTimeoutFor } from "./multiparkDb/client";
import {
  PRESSURE_CHUNK_MIN_MS, PRESSURE_HEAVY_CHUNK_MIN_MS, isHeavyPressureChunk, pressureFallbacks, pressureQueryTimeout, runExtrasPressure, type PressureStore,
} from "./extrasPressure";
import { nameMatchScore, sortByNameMatch } from "../shared/contactSearch";
import { NO_HR_RECORD_MESSAGE, hrRecordRefusal } from "../shared/extrasSchedule";
import { pickerSections, type PickerCandidate } from "../client/src/pages/extrasDia/PersonPicker";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

describe("44a — Pressão: leituras mais longas e pedaços pesados com tempo", () => {
  it("tempo-limite da leitura: 15 s por omissão; pedido explícito entre 1 s e 40 s", () => {
    expect(statementTimeoutFor()).toBe(15_000);
    expect(statementTimeoutFor({})).toBe(15_000);
    expect(statementTimeoutFor({ timeoutMs: 30_000 })).toBe(30_000);
    expect(statementTimeoutFor({ timeoutMs: 120_000 })).toBe(MULTIPARK_DB_LONG_TIMEOUT_MAX_MS);
    expect(statementTimeoutFor({ timeoutMs: 10 })).toBe(1_000);
  });
  it("cada leitura da Pressão leva o tempo que falta até ao prazo (menos 2 s), entre 15 e 40 s", () => {
    expect(pressureQueryTimeout(100_000, 50_000)).toBe(40_000);
    expect(pressureQueryTimeout(100_000, 70_000)).toBe(28_000);
    expect(pressureQueryTimeout(100_000, 95_000)).toBe(15_000);
  });
  it("as cidades e os condutores são pedaços pesados (precisam de ≥ 25 s); marcas e Marketplace não", () => {
    expect(PRESSURE_HEAVY_CHUNK_MIN_MS).toBeGreaterThan(PRESSURE_CHUNK_MIN_MS);
    expect(isHeavyPressureChunk({ key: "cidade_lisboa", label: "", parkIds: [] })).toBe(true);
    expect(isHeavyPressureChunk({ key: "cidade_porto", label: "", parkIds: [], kind: "driver", city: "porto" } as any)).toBe(true);
    expect(isHeavyPressureChunk({ key: "airpark_lisboa", label: "", parkIds: [] })).toBe(false);
    expect(isHeavyPressureChunk({ key: "marketplace", label: "", parkIds: [] })).toBe(false);
  });
  it("com pouco tempo, um pedaço pesado não arranca (fica para o tick seguinte), em vez de ser cortado pela BD", async () => {
    const parks = [{ id: "p1", name: "Airpark Lisboa", city: "Lisboa", firebase_brand: null, listing_type: "ON_PLATFORM", status: "ACTIVE" }];
    const q = vi.fn(async (sql: string) => (sql.includes('FROM "Park"') ? parks : []));
    const groups: string[] = [];
    const store: PressureStore = { async replaceGroup(_w, c) { groups.push(c.key); }, async upsertDriver() {}, async finish() {} };
    const r = await runExtrasPressure({ deadlineAt: Date.now() + PRESSURE_HEAVY_CHUNK_MIN_MS - 2_000, windowEnd: "2026-10-06", query: q as any, store, isConfigured: () => true, teamLeaderAgentIds: [] });
    expect(r.done).toBe(false);
    expect(r.processed).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(groups).toEqual([]);
  });
  it("sem leitura injetada, a corrida passa o tempo-limite à BD da Multipark", () => {
    const s = src("server/extrasPressure.ts");
    expect(s).toContain("multiparkDbQuery<T>(sqlText, params ?? [], { timeoutMs: pressureQueryTimeout(o.deadlineAt, Date.now()) })");
    const c = src("server/multiparkDb/client.ts");
    expect(c).toContain("SET LOCAL statement_timeout = ${timeoutMs}");
  });
});

describe("44a — Pressão: um grupo que falhou mostra-se com a janela anterior", () => {
  it("grupo que falta inteiro → \"all\"; cidade sem tempos por condutor → \"drivers\"", () => {
    const f = pressureFallbacks(
      { groups: new Set(["cidade_porto", "airpark_lisboa"]), withDrivers: new Set(["cidade_porto"]) },
      { slot: new Map([["cidade_lisboa", "2026-10-02"], ["cidade_porto", "2026-10-05"], ["_done", "2026-10-05"]]), crew: new Map([["cidade_lisboa", "2026-10-02"]]) },
      ["cidade_lisboa", "cidade_porto", "cidade_faro"],
    );
    expect(f).toEqual([{ group: "cidade_lisboa", w: "2026-10-02", part: "all" }]);
    const g = pressureFallbacks(
      { groups: new Set(["cidade_lisboa"]), withDrivers: new Set() },
      { slot: new Map([["cidade_lisboa", "2026-10-02"]]), crew: new Map([["cidade_lisboa", "2026-10-02"]]) },
      ["cidade_lisboa"],
    );
    expect(g).toEqual([{ group: "cidade_lisboa", w: "2026-10-02", part: "drivers" }]);
  });
  it("a página avisa quando os dados são de uma janela anterior", () => {
    const s = src("client/src/pages/extrasDia/PressureTab.tsx");
    expect(s).toContain("const stale = q.data?.stale?.[group];");
    expect(s).toContain("O último cálculo falhou em");
  });
});

describe("44a — Pressão: mapa maior, botões em cima, métricas explicadas", () => {
  const s = src("client/src/pages/extrasDia/PressureTab.tsx");
  it("botões das métricas em cima, com nomes claros", () => {
    expect(s.indexOf('role="radiogroup"')).toBeLessThan(s.indexOf("dia da semana × hora"));
    for (const label of ["Carros por hora", "Tempo de entrega", "Tempo por carro", "Na estrada", "Pessoas a trabalhar"]) expect(s).toContain(label);
  });
  it("explica o p75 e tem legenda (rampa de um só tom, sem dados, hora apertada)", () => {
    expect(s).toContain("O que é o p75");
    expect(s).toContain('const RAMP = ["#86b6ef", "#5598e7", "#256abf", "#104281"] as const;');
    expect(s).toContain("hora apertada (top 20 %)");
    expect(s).toContain("h-12 md:h-14");
  });
});

describe("44a — Por hora: as 24 horas (03h → 03h), sem o \"2+1\" no topo", () => {
  const s = src("client/src/pages/ExtrasDiaPage.tsx");
  it("mostra todas as horas do dia operacional, mesmo sem movimento", () => {
    expect(s).toContain(".filter(h => h.hour >= 3 && h.hour < 27)");
    expect(s).not.toContain(".filter(h => h.checkins + h.checkouts > 0)");
    expect(s).toContain('"Manhã · 03h–15h" : "Noite · 15h–03h"');
  });
  it("a regra das pessoas passa para a ajuda do cabeçalho (sem badge no topo)", () => {
    expect(s).toContain("Extras precisos nessa hora, além do team leader. ${data.crewRuleText}");
    expect(s).not.toMatch(/<Badge[^>]*>\s*\{data\.crewRuleText\}/);
  });
});

describe("44a — escala só com gente do RH", () => {
  it("nova linha ou troca de pessoa sem ficha → recusa; linha antiga sem ficha só muda de horas", () => {
    expect(hrRecordRefusal({ personName: "Ana" }, null)).toBe(NO_HR_RECORD_MESSAGE);
    expect(hrRecordRefusal({ employeeId: 7, personName: "Ana" }, null)).toBeNull();
    expect(hrRecordRefusal({ id: 3, personName: "Ana" }, { employeeId: null, personName: "Ana" })).toBeNull();
    expect(hrRecordRefusal({ id: 3, personName: "Rui" }, { employeeId: null, personName: "Ana" })).toBe(NO_HR_RECORD_MESSAGE);
    expect(hrRecordRefusal({ id: 3, personName: "Ana" }, { employeeId: 9, personName: "Ana" })).toBe(NO_HR_RECORD_MESSAGE);
  });
  it("o servidor aplica a regra e o formulário já não tem nome livre", () => {
    const r = src("server/routers.ts");
    expect(r).toContain("hrRecordRefusal(input, input.id ? await escalaAssignmentPerson(input.id) : null)");
    const p = src("client/src/pages/ExtrasDiaPage.tsx");
    expect(p).not.toContain("— Nenhum (escrever nome) —");
    expect(p).not.toContain('placeholder="Nome da pessoa"');
    expect(p).toContain("<PersonPicker");
  });
  it("seletor: cidade da escala primeiro, depois outras, quem não pode ser TL, e sem cidade (bloqueado)", () => {
    const c = (id: number, fullName: string, city: PickerCandidate["city"]): PickerCandidate => ({ id, fullName, city });
    const secs = pickerSections(
      [c(1, "Bruno Alves", "lisbon"), c(2, "Ana Sousa", "porto"), c(3, "Anabela Reis", null), c(4, "Mariana Costa", "lisbon")],
      [c(5, "Paulo Ana", "lisbon")],
      "lisbon",
      "ana",
    );
    expect(secs.map((s) => [s.key, s.rows.map((r) => r.c.id)])).toEqual([
      ["here", [4]],
      ["elsewhere", [2]],
      ["notTl", [5]],
      ["noCity", [3]],
    ]);
    expect(secs.find((s) => s.key === "noCity")?.disabled).toBe(true);
  });
  it("\"Permitir ser TL\" daqui: as mesmas regras das Permissões e fica registado", () => {
    const r = src("server/routers.ts");
    const i = r.indexOf("allowTeamLeader: protectedProcedure");
    expect(i).toBeGreaterThan(0);
    const block = r.slice(i, i + 2600);
    expect(block).toContain('canTouchPermission(ctx.user, "extras_dia.team_leader")');
    expect(block).toContain("canGrantPermissionsTo(ctx.user, target.role)");
    expect(block).toContain("await userInCityScope(userId)");
    expect(block).toContain("await assertEmployeeAccess(input.employeeId)");
    expect(block).toContain('setUserPermission(userId, "extras_dia.team_leader", "grant", ctx.user.id)');
    expect(block).toContain("logActivity(");
  });
});

describe("44a — pesquisa por relevância (\"começa sempre com o A e o B\")", () => {
  it("quem começa pelo que se escreveu vem primeiro", () => {
    expect(nameMatchScore("ana s", "Ana Sousa")).toBe(3);
    expect(nameMatchScore("sou ana", "Ana Sousa")).toBe(2);
    expect(nameMatchScore("ana", "Mariana Costa")).toBe(1);
    expect(nameMatchScore("rui", "Mariana Costa")).toBe(0);
    expect(nameMatchScore("", "Qualquer")).toBe(1);
    expect(nameMatchScore("joao", "João Silva")).toBe(3);
    const rows = ["Mariana Costa", "Bruno Ana", "Ana Sousa", "Joana Ramos"];
    expect(sortByNameMatch("ana", rows, (x) => x)).toEqual(["Ana Sousa", "Bruno Ana", "Mariana Costa", "Joana Ramos"]);
    expect(sortByNameMatch("", rows, (x) => x)).toEqual(rows);
  });
  it("Disponibilidade: a pesquisar, ordena por relevância; sem pesquisa, separadores por estado", () => {
    const s = src("client/src/pages/ExtrasDiaPage.tsx");
    expect(s).toContain("nameMatchScore(trimmedSearch, e.fullName)");
    expect(s).toContain("const divider = !availSort.sortKey && !searching");
  });
});
