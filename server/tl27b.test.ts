/**
 * P3 lote 27b — o TL conta sempre nas pessoas medidas (Jorge, 5 out 2026):
 * "é o primeiro condutor, deve contar com ele, mas se calhar não o mostra na
 * contagem". Pessoas = agentes com ações nessa hora + 1 se nenhum TL agiu;
 * "hora cheia" continua pelos que agiram. O SQL corre num Postgres a sério em
 * extrasPressure.pg.test.ts (com e sem TL).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildPressureCrewSql, buildPressureDriverSlotsSql, pressureWindowSince } from "./multiparkDb/pressure";
import { crewMeasureBands } from "../shared/extrasPressure";
import { DEFAULT_CREW_RULES } from "../shared/appSettings";

const db = vi.hoisted(() => ({ calls: [] as string[], rows: [[{ id: "tl-1" }, { id: " tl-2 " }], [{ id: "tl-1" }, { id: "" }]] as any[], fail: false }));
vi.mock("./db", () => ({
  getDb: async () => ({
    execute: async (q: any) => {
      if (db.fail) throw new Error("ligação recusada");
      db.calls.push(JSON.stringify(q?.queryChunks ?? q));
      return [db.rows.shift() ?? []];
    },
  }),
}));

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const w = pressureWindowSince("2026-09-01", "2026-09-10");
const bands = crewMeasureBands(DEFAULT_CREW_RULES.lisbon);

describe("27b — o TL conta sempre nas pessoas", () => {
  it("SQL: pessoas = agentes + 1 se nenhum TL agiu; TLs como parâmetros", () => {
    const k = buildPressureCrewSql(w, ["P1"], bands, ["tl-1", "tl-1", " tl-2 ", ""]);
    expect(k.sql).toContain("count(DISTINCT ha.uid) AS agents,");
    expect(k.sql).toMatch(/count\(DISTINCT ha\.uid\) \+ CASE WHEN bool_or\(ha\.uid IN \(\$\d+, \$\d+\)\) THEN 0 ELSE 1 END AS n/);
    expect(k.params).toEqual(expect.arrayContaining(["tl-1", "tl-2"]));
    expect(k.sql).not.toContain("'tl-1'"); // nunca no texto do SQL
    // hora cheia pelos que agiram; escalão pelas pessoas (com o TL)
    expect(k.sql).toContain("(COALESCE(hj.jobs, 0) >= GREATEST(COALESCE(crew.agents, 1), 1)) AS busy");
    expect(k.sql).toContain("COALESCE(crew.n, 0)");
  });

  it("sem TL conhecido → +1 em todas as horas (FALSE, nunca IN ())", () => {
    const k = buildPressureCrewSql(w, ["P1"], bands);
    expect(k.sql).toContain("CASE WHEN bool_or(FALSE) THEN 0 ELSE 1 END AS n");
    expect(k.sql).not.toContain("IN ()");
    expect(buildPressureDriverSlotsSql(w, ["P1"], ["tl-9"]).params).toContain("tl-9");
  });

  it("TLs = posto Team Leader: agente da ficha + agentes ligados; sem repetidos; falha → [] (nunca lança)", async () => {
    const { loadTeamLeaderAgentIds } = await import("./extrasPressure");
    expect(await loadTeamLeaderAgentIds()).toEqual(["tl-1", "tl-2"]);
    expect(db.calls.join(" ")).toContain("team_leader");
    expect(db.calls.join(" ")).not.toMatch(/UNION|INSERT|UPDATE|DELETE/);
    db.fail = true;
    expect(await loadTeamLeaderAgentIds()).toEqual([]);
    db.fail = false;
  });

  it("o trabalho diário passa os TL às duas leituras; textos dizem que o TL conta sempre", () => {
    const job = src("server/extrasPressure.ts");
    expect(job).toContain("const tlIds = o.teamLeaderAgentIds !== undefined ? [...(o.teamLeaderAgentIds ?? [])] : await loadTeamLeaderAgentIds();");
    // 47c: os dias guardados levam quem agiu em cada hora; o TL aplica-se ao juntar (lista de hoje)
    expect(job).toContain("combineDriverDays(stored.map((d) => ({ day: d.day, payload: parseDayPayload<DriverDayPayload>(d.payload) })), tlIds, bands)");
    expect(src("client/src/pages/extrasDia/PressureTab.tsx")).toContain("sempre com o TL (se não carregou em nada nessa hora, junta-se 1)");
    expect(src("docs/ajuda/extras-dia.md")).toContain("**sempre com o TL**");
  });
});
