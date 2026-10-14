// 14 out 2026 (auditoria): os detalhes de movimentos (Condutores e agentes,
// Avaliação do dia) mostram o início e a mudança de lugar com o seu nome, com o
// tipo calculado sobre o texto COMPLETO do modifiedFields — para o detalhe
// bater com os totais.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildLiveHistorySql, mapLiveHistoryRow } from "./multiparkDb/historyLive";
import { movementKindSql } from "./multiparkDb/movements";
import { assertReadOnlySql } from "./multiparkDb/client";
import { classifyMovement, displayChangeType } from "../shared/multiparkMovements";

const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

describe("histórico ao vivo (getAgentHistoryFromDb): o tipo vem do SQL sobre o texto completo", () => {
  it("o SQL traz move_kind (o modified_fields continua cortado a 1000 só para mostrar)", () => {
    const { sql } = buildLiveHistorySql({ from: "2026-10-03 02:00:00", to: "2026-10-04 02:00:00", userIds: ["u1"], limit: 50 });
    expect(sql).toContain(`THEN ${movementKindSql(`COALESCE(h."modifiedFields"::text, '')`)} END AS move_kind`);
    expect(sql).toContain(`left(h."modifiedFields"::text, 1000) AS modified_fields`);
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(mapLiveHistoryRow({ history_id: "1", booking_id: "b", change_type: "MOVEMENT", move_kind: "inicio" }).moveKind).toBe("inicio");
    expect("moveKind" in mapLiveHistoryRow({ history_id: "1", booking_id: "b", change_type: "MOVEMENT" })).toBe(false);
  });

  it("re-rótulo: MOVEMENT_START (não conta) e SPOT_CHANGE; sem tipo do SQL, o do texto que veio", () => {
    expect(displayChangeType("MOVEMENT", "inicio")).toBe("MOVEMENT_START");
    expect(displayChangeType("MOVEMENT", "lugar")).toBe("SPOT_CHANGE");
    expect(displayChangeType("MOVEMENT", "arrumar")).toBe("MOVEMENT");
    expect(displayChangeType("CHECK_IN", "lugar")).toBe("CHECK_IN");
    expect(displayChangeType("MOVEMENT", classifyMovement('{"garageName":{"from":"PD","to":"PD"}}'))).toBe("SPOT_CHANGE");
    const db = read("server/db.ts");
    expect(db).toMatch(/getAgentHistoryFromDb[\s\S]{0,4000}displayChangeType\(ct, kind \?\? classifyMovement\(mf\)\)/);
    expect(db).toContain("changeType: moveType(r.changeType, r.modifiedFields, r.moveKind),");
  });

  it("agentHistorySummary: as contagens por tipo saem dos itens já com o nome certo; só as cidades em âmbito", () => {
    const r = read("server/routers.ts");
    const i = r.indexOf("agentHistorySummary: protectedProcedure");
    const block = r.slice(i, i + 2200);
    expect(block).toContain("total: r.data.rows.length - movementStarts, movementStarts,");
    expect(read("server/db.ts")).toContain("const actions = history.filter((h) => h.changeType !== MOVEMENT_START_TYPE);");
    expect(block).toContain("getAgentDayMovements({ day: input.date, userIds: ids, cities: scopedCityNames() })");
    expect(block).toContain("for (const m of r.data.rows) byType[m.changeType] = (byType[m.changeType] ?? 0) + 1;");
  });

  it("Condutores e agentes: quem só fez mudanças de lugar também é condutor", () => {
    expect(read("server/movementPeople.ts")).toContain("x.recolhas + x.entregas + x.movements + x.spotChanges > 0");
  });

  it("payroll: os movimentos do mês já incluem o levar ao parque (não somar duas vezes)", () => {
    expect(read("server/db.ts")).toContain("SUM(movements) AS movements,");
    expect(read("server/db.ts")).not.toContain("SUM(movements + parkingMoves)");
  });
});
