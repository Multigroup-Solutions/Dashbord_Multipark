/**
 * P3 lote 23a — Ocorrências (decisões do Jorge, 3 out):
 *  - D16 sem os "Parques que a operação não faz"; lista dos parques tratados;
 *        as Reclamações e as Críticas continuam a vir de todos os parques
 *  - D17 dia de calendário (00h–24h de Lisboa) — já era assim
 *  - D18 a importação antiga do Gmail fica desligada (410)
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ParamList, buildOccurrenceListSql, buildOccurrenceStatsSql, buildOccurrenceWhere } from "./multiparkDb/read";
import { SETTINGS } from "../shared/appSettings";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const midnight = (day: string) => `${day} 00:00:00`;

describe("D16 parques que a operação não faz", () => {
  it("ficam fora da lista e das contagens; as ocorrências sem parque ficam", () => {
    const p = new ParamList();
    const where = buildOccurrenceWhere({ excludedParkIds: ["pX", "pY", "pX", " "] }, p, midnight);
    expect(where).toBe(`(o."parkId" IS NULL OR o."parkId" NOT IN ($1, $2))`);
    expect(p.values).toEqual(["pX", "pY"]);
    const list = buildOccurrenceListSql({ excludedParkIds: ["pX"], cities: ["Lisboa"] }, midnight);
    expect(list.sql).toContain(`o."parkId" NOT IN`);
    const stats = buildOccurrenceStatsSql({ excludedParkIds: ["pX"] }, midnight);
    expect(stats.sql).toContain(`o."parkId" NOT IN`);
    expect(buildOccurrenceWhere({ excludedParkIds: [] }, new ParamList(), midnight)).toBe("TRUE");
  });

  it("a rota lê a definição; a lista dos parques tratados separa os de fora", () => {
    const routes = src("server/routers.ts");
    const list = routes.split("multipark: protectedProcedure.input(z.object({\n      projectId")[1].split("multiparkById:")[0];
    expect(list).toContain('getSetting("operations.excludedParks")');
    expect(list).toContain("excludedParkIds };");
    // 28a: mais os que não operamos pelo nome (o SQL só aceita ids)
    expect(list).toContain("...(await getNotOperatedParkIds())");
    const parks = routes.split("parksHandled: protectedProcedure")[1].split("multiparkById:")[0];
    expect(parks).toContain('requireAccess(ctx.user, "ocorrencias", "view")');
    expect(parks).toContain("handled: r.data.filter((p) => !isParkExcluded(p, excluded))");
    expect(parks).toContain("scopedCityNames()");
    expect(src("client/src/pages/IncidentsPage.tsx")).toContain("<ParksHandledNote");
  });

  it("as Reclamações e as Críticas não aplicam a exclusão", () => {
    const routes = src("server/routers.ts");
    const complaints = routes.split("complaints: router({")[1].split("\n  }),\n")[0];
    const reviews = routes.split("reviews: router({")[1].split("\n  }),\n")[0];
    expect(complaints).not.toContain("excludedParks");
    expect(reviews).not.toContain("excludedParks");
    expect(SETTINGS["operations.excludedParks"].description).toContain("As Reclamações e as Críticas vêm de todos os parques");
  });
});

describe("D17 dia de calendário", () => {
  it("as datas filtram pela meia-noite de Lisboa (00h–24h), não pelas 03h", () => {
    const p = new ParamList();
    const where = buildOccurrenceWhere({ dateFrom: "2026-10-01", dateTo: "2026-10-02" }, p, midnight);
    expect(where).toContain(`o."createdAt" >= $1::timestamp`);
    expect(p.values).toEqual(["2026-10-01 00:00:00", "2026-10-03 00:00:00"]);
    expect(src("server/multiparkDb/read.ts")).not.toContain("operationalDay");
  });
});

describe("D18 importação antiga do Gmail", () => {
  it("responde 410 e não grava nada; a documentação já não a oferece", () => {
    const ext = src("server/externalApi.ts");
    const handler = ext.split('r.post("/gmail-import"')[1].split("\n  });")[0];
    expect(handler).toContain("res.status(410)");
    expect(ext).not.toMatch(/getIncidentBySourceEmailId|getReviewBySourceEmailId/);
    expect(src("shared/apiKeyCapabilities.ts")).not.toContain("importação do Gmail");
    expect(src("client/src/pages/ApiKeysPage.tsx")).toContain("(descontinuado)");
  });
});
