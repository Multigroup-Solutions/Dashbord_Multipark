/**
 * Movimento × mudança de lugar (Jorge, 14 out 2026: "os movimentos, para os
 * pontos, são os que tocam no parque; as mudanças de lugar não contam como
 * movimentos, contam como interações") — EM TODO O LADO.
 *
 * A regra é a do #381 (shared/multiparkMovements.ts → classifyMovement, e a
 * mesma em SQL em server/multiparkDb/movements.ts → movementKindSql): a app
 * grava cada deslocação em DUAS linhas MOVEMENT (início: status → MOVING; fim:
 * garageName/spot from → to). O início não conta; sem garagem de origem =
 * levar ao parque; mesma garagem = mudança de lugar; garagens diferentes =
 * entre parques. Classifica-se LINHA A LINHA (não depende do que veio antes),
 * por isso a janela, os cancelamentos e as reservas sem recolha no histórico
 * não mudam nada.
 *
 * Estes testes cobrem os sítios que o #381 não tinha mudado e que contavam
 * todas as linhas MOVEMENT: a Atividade do dia (contagens e gaveta) e o Resumo
 * do dia (as ações de um condutor). O motor da Avaliação, os agregados de
 * Condutores e agentes e o detalhe estão em multiparkDb/movements.test.ts e
 * movimentosRotulos.test.ts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyMovement, displayChangeType, movementLabel, MOVEMENT_KIND_CHANGE_TYPES } from "../shared/multiparkMovements";
import { buildActivityActionsSql, buildActivityDetailSql, mapActivityActionRow, mapActivityDetailRow } from "./multiparkDb/activityLive";
import { movementKindSql } from "./multiparkDb/movements";
import { assertReadOnlySql } from "./multiparkDb/client";

const src = (p: string) => readFileSync(resolve(import.meta.dirname, "..", p), "utf8");
const START = '{"_version":2,"status":{"from":"CHECKED_IN","to":"MOVING"}}';
const END = (gFrom: string | null, gTo: string, sFrom: string | null = null, sTo = "1 / 1") =>
  JSON.stringify({ _version: 2, garageName: { from: gFrom, to: gTo }, spot: { from: sFrom, to: sTo } });

describe("casos-limite da regra (por linha, não pela sequência)", () => {
  it("depois de uma recolha: início (não conta) + fim sem garagem = levar ao parque; os seguintes na mesma garagem = mudança de lugar", () => {
    const seq = [START, END(null, "PD"), START, END("PD", "PD", "1 / 1", "9 / 2"), START, END("PD", "PD", "9 / 2", "3 / 1")];
    expect(seq.map(classifyMovement)).toEqual(["inicio", "arrumar", "inicio", "lugar", "inicio", "lugar"]);
  });
  it("não depende da janela nem do que veio antes: o fim de uma arrumação com a recolha há 3 dias continua a ser levar ao parque", () => {
    expect(classifyMovement(END(null, "PD FORA"))).toBe("arrumar");
  });
  it("reserva sem recolha no histórico (o carro já estava no parque): mudança de lugar / entre parques pelo próprio registo", () => {
    expect(classifyMovement(END("PD", "PD"))).toBe("lugar");
    expect(classifyMovement(END("PD FORA", "PD"))).toBe("parques");
  });
  it("cancelamento ou ações com o mesmo instante não mudam a classificação (cada linha decide-se sozinha)", () => {
    const a = classifyMovement(END("PD", "PD"));
    expect([a, classifyMovement(END("PD", "PD"))]).toEqual(["lugar", "lugar"]);
  });
  it("rótulos: o início e a mudança de lugar com o seu nome; o resto continua MOVEMENT", () => {
    expect(displayChangeType("MOVEMENT", "inicio")).toBe(MOVEMENT_KIND_CHANGE_TYPES.inicio);
    expect(displayChangeType("MOVEMENT", "lugar")).toBe("SPOT_CHANGE");
    expect(displayChangeType("MOVEMENT", "arrumar")).toBe("MOVEMENT");
    expect(displayChangeType("MOVEMENT", "parques")).toBe("MOVEMENT");
    expect(movementLabel("SPOT_CHANGE")).toBe("Mudança de lugar");
  });
});

describe("Atividade do dia: as contagens já não contam o início nem as mudanças de lugar como movimentos", () => {
  const W = { from: "2026-10-12 23:00:00", to: "2026-10-13 23:00:00" };
  it("SQL: o tipo de cada MOVEMENT pelo modifiedFields (uma vez por linha), sem os inícios, mudança de lugar = SPOT_CHANGE", () => {
    const { sql, params } = buildActivityActionsSql({ ...W, cities: ["Lisboa"] });
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain(`CASE WHEN upper(h."changeType"::text) = 'MOVEMENT' THEN ${movementKindSql(`COALESCE(h."modifiedFields", '')`)} END AS mk`);
    expect(sql).toContain("OFFSET 0");
    expect(sql).toContain(`WHERE h.mk IS DISTINCT FROM 'inicio'`);
    expect(sql).toContain(`CASE WHEN h.mk = 'lugar' THEN 'SPOT_CHANGE' ELSE upper(h."changeType"::text) END AS change_type`);
    expect(params).toEqual([W.from, W.to, "lisboa", "lisbon", expect.any(Number)]);
    expect(mapActivityActionRow({ user_id: "u1", agent_name: "Ana", change_type: "SPOT_CHANGE", at: "2026-10-13 08:00:00", n: 2 })?.changeType).toBe("SPOT_CHANGE");
  });
  it("as \"Movimentações\" da página contam só MOVEMENT; a mudança de lugar fica nas ações (outras)", () => {
    const day = src("server/dayActivity.ts");
    const ct = day.slice(day.indexOf("const CT: Record<string"), day.indexOf("};", day.indexOf("const CT: Record<string")));
    expect(ct).toContain('MOVEMENT: "movements"');
    expect(ct).not.toContain("SPOT_CHANGE");
    expect(day).toContain('const col = CT[String(r.changeType ?? "").toUpperCase()] ?? "other";');
  });
  it("gaveta de uma pessoa: o tipo vem do SQL; os inícios ficam de fora", async () => {
    const { sql } = buildActivityDetailSql({ ...W, userIds: ["u1"] });
    expect(sql).toContain("END AS move_kind");
    expect(mapActivityDetailRow({ id: "1", change_type: "movement", move_kind: "lugar" }).changeType).toBe("SPOT_CHANGE");
    expect(src("server/multiparkDb/activityLive.ts")).toContain(".filter((r) => r.changeType !== MOVEMENT_KIND_CHANGE_TYPES.inicio)");
  });
  it("o ecrã chama-lhe \"Mudança de lugar\"", () => {
    expect(src("client/src/pages/OperationalPage.tsx")).toContain('SPOT_CHANGE: "Mudança de lugar"');
  });
});

describe("Resumo do dia: as ações de um condutor com a mesma regra", () => {
  it("usa o tipo do SQL (texto completo) e, sem ele, o do texto; o início não é ação", () => {
    const s = src("server/shiftDayDetail.ts");
    expect(s).toContain("return ct === \"MOVEMENT\" ? displayChangeType(ct, r.moveKind ?? classifyMovement(r.modifiedFields)) : ct;");
    expect(s).toContain("if (typeOf(r) === MOVEMENT_KIND_CHANGE_TYPES.inicio) return false;");
    expect(s).toContain("changeType: typeOf(r),");
    // já não há a regra pela sequência das ações (a do ramo antes do #381)
    expect(s).not.toMatch(/moveKindsOf|readMoveKinds|actionKeyOf/);
    expect(src("client/src/components/shiftDay/ShiftDayReview.tsx")).toContain('SPOT_CHANGE: "Mudança de lugar"');
  });
  it("a leitura do Resumo traz o tipo calculado sobre o texto completo", () => {
    expect(src("server/multiparkDb/historyLive.ts")).toContain(`CASE WHEN upper(h."changeType"::text) = 'MOVEMENT' THEN \${movementKindSql(\`COALESCE(h."modifiedFields"::text, '')\`)} END AS move_kind`);
  });
});

describe("já não há uma segunda regra (pela sequência) em lado nenhum", () => {
  it("nenhum ficheiro usa a regra antiga do ramo (moveKindsOf / moveSeqCteSql / readMoveKinds)", () => {
    for (const f of ["server/multiparkDb/movements.ts", "server/multiparkDb/activityLive.ts", "server/shiftDayDetail.ts", "server/evaluationCore.ts", "server/db.ts", "shared/multiparkMovements.ts"]) {
      expect(src(f)).not.toMatch(/moveKindsOf|moveSeqCteSql|moveIsSpotSql|readMoveKinds|markSpotChanges/);
    }
  });
});
