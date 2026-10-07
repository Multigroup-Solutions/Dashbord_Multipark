import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("./client", async (importOriginal) => {
  const real = await importOriginal<typeof import("./client")>();
  return { ...real, multiparkDbQuery: (...args: any[]) => queryMock(...args) };
});

import { MultiparkDbError, assertReadOnlySql } from "./client";
import {
  buildOccurrenceByIdSql, buildOccurrenceGroupSql, buildOccurrenceListSql, buildOccurrenceStatsSql, buildOccurrenceWhere,
  cityAliases, clampPage, describeReadFailure, getMultiparkOccurrence, getMultiparkOccurrenceStats, likeContains,
  listMultiparkOccurrences, mapOccurrenceRow, mapOccurrenceStatsRow, normalizePlate, ParamList, toIsoUtc,
  OCCURRENCE_LIST_MAX_LIMIT,
} from "./read";

// Meia-noite de Lisboa → UTC (verão: -1h), determinística para os testes.
const midnight = (day: string) => `${day} 00:00:00(L)`;

const ENV = "DATABASE_URL_MULTIPARK";
let savedEnv: string | undefined;
beforeEach(() => { savedEnv = process.env[ENV]; queryMock.mockReset(); });
afterEach(() => { if (savedEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv; });

describe("ocorrências — SQL", () => {
  it("sem filtros: TRUE, ordenado e com LIMIT/OFFSET parametrizados", () => {
    const { sql, params } = buildOccurrenceListSql({}, midnight);
    expect(sql).toContain(`FROM "Occurrence" o`);
    expect(sql).toContain("WHERE TRUE");
    expect(sql).toContain(`ORDER BY o."createdAt" DESC, o."id" DESC`);
    expect(sql).toMatch(/LIMIT \$1 OFFSET \$2$/);
    expect(params).toEqual([50, 0]);
    expect(() => assertReadOnlySql(sql)).not.toThrow();
  });

  it("todos os filtros viram parâmetros (nada do utilizador vai no texto do SQL)", () => {
    const evil = `x'; DROP TABLE "Occurrence"; --`;
    const { sql, params } = buildOccurrenceListSql({
      dateFrom: "2026-09-01", dateTo: "2026-09-27", parkId: "park1", type: "Vidro Aberto", priority: "HIGH",
      resolved: false, search: evil, cities: ["Lisboa"], limit: 20, offset: 40,
    }, midnight);
    expect(sql).not.toContain("DROP");
    expect(sql).not.toContain("Vidro");
    expect(sql).toContain(`o."createdAt" >= $1::timestamp`);
    expect(sql).toContain(`o."createdAt" < $2::timestamp`);
    expect(params.slice(0, 2)).toEqual(["2026-09-01 00:00:00(L)", "2026-09-28 00:00:00(L)"]); // dia seguinte, exclusivo
    expect(params).toContain("park1");
    expect(params).toContain("Vidro Aberto");
    expect(params).toContain("HIGH");
    expect(params).toContain(false);
    expect(params).toEqual(expect.arrayContaining(["lisboa", "lisbon"]));
    expect(params).toContain(`%${evil}%`);
    expect(params.slice(-2)).toEqual([20, 40]);
    expect(() => assertReadOnlySql(sql)).not.toThrow();
  });

  it("pesquisa: n.º da reserva (allocation), matrícula normalizada, id exato", () => {
    const p = new ParamList();
    const where = buildOccurrenceWhere({ search: "aa-12-bb" }, p, midnight);
    expect(where).toContain(`b."allocation" ILIKE $1`);
    expect(where).toContain(`v."licensePlate" ILIKE $1`);
    expect(where).toContain(`o."bookingId" = $2`);
    expect(where).toContain(`regexp_replace(upper(v."licensePlate"), '[^A-Z0-9]', '', 'g') LIKE $3`);
    expect(p.values).toEqual(["%aa-12-bb%", "aa-12-bb", "%AA12BB%"]);
  });

  it("âmbito de cidade: [] não deixa ver nada; undefined não filtra", () => {
    expect(buildOccurrenceWhere({ cities: [] }, new ParamList(), midnight)).toBe("FALSE");
    expect(buildOccurrenceWhere({}, new ParamList(), midnight)).toBe("TRUE");
  });

  it("ignora datas e prioridades inválidas", () => {
    const p = new ParamList();
    expect(buildOccurrenceWhere({ dateFrom: "ontem", priority: "URGENT" as any }, p, midnight)).toBe("TRUE");
    expect(p.values).toEqual([]);
  });

  it("contagens, agrupamentos e por id passam na guarda de só leitura", () => {
    for (const { sql } of [
      buildOccurrenceStatsSql({ resolved: true, cities: ["Porto"] }, midnight),
      buildOccurrenceGroupSql("type", { search: "x" }, midnight),
      buildOccurrenceGroupSql("park", {}, midnight),
      buildOccurrenceByIdSql("occ1", ["Faro"]),
    ]) expect(() => assertReadOnlySql(sql)).not.toThrow();
    const byId = buildOccurrenceByIdSql("occ1", ["Faro"]);
    expect(byId.sql).toContain(`o."id" = $1`);
    expect(byId.sql).toMatch(/LIMIT 1$/);
    expect(byId.params).toEqual(["occ1", "faro"]);
  });

  it("paginação com teto", () => {
    expect(clampPage()).toEqual({ limit: 50, offset: 0 });
    expect(clampPage(10_000, -5)).toEqual({ limit: OCCURRENCE_LIST_MAX_LIMIT, offset: 0 });
    expect(clampPage(0, 99_999).offset).toBe(5_000);
    expect(clampPage(0).limit).toBe(1);
  });
});

describe("ocorrências — ajudantes puros", () => {
  it("escapa % e _ no ILIKE", () => {
    expect(likeContains("50%_a")).toBe("%50\\%\\_a%");
  });
  it("matrícula só com letras e números", () => {
    expect(normalizePlate(" aa-12·bb ")).toBe("AA12BB");
  });
  it("cidades com sinónimos", () => {
    expect(cityAliases(["Lisboa", "Oporto", "Faro", ""])).toEqual(["lisboa", "lisbon", "porto", "oporto", "faro"]);
  });
  it("datas sem fuso são UTC", () => {
    expect(toIsoUtc("2026-09-27 10:05:00")).toBe("2026-09-27T10:05:00.000Z");
    expect(toIsoUtc(new Date("2026-09-27T10:05:00Z"))).toBe("2026-09-27T10:05:00.000Z");
    expect(toIsoUtc(null)).toBeNull();
    expect(toIsoUtc("lixo")).toBeNull();
  });
});

describe("ocorrências — mapeamento da linha", () => {
  it("mapeia todos os campos", () => {
    const o = mapOccurrenceRow({
      id: "occ1", title: "Vidro Aberto", priority: "high", resolved: "t", created_at: "2026-09-20 08:00:00", resolved_at: null,
      created_by_user_id: "u1", created_by_name: "Rui", resolved_by_id: null, resolved_by_name: " ",
      remarks: "vidro traseiro", lat: "38.77", lng: -9.13, attachment: "https://firebasestorage.example/x.jpg",
      booking_id: "bk1", booking_code: "29484", plate: "AA-12-BB", park_id: "p1", park_name: "Airpark", park_city: "Lisboa",
    });
    expect(o).toEqual({
      id: "occ1", title: "Vidro Aberto", priority: "HIGH", resolved: true, createdAt: "2026-09-20T08:00:00.000Z", resolvedAt: null,
      createdByUserId: "u1", createdByName: "Rui", resolvedById: null, resolvedByName: null,
      remarks: "vidro traseiro", lat: 38.77, lng: -9.13,
      attachment: "https://firebasestorage.example/x.jpg", attachmentUrl: "https://firebasestorage.example/x.jpg",
      bookingId: "bk1", bookingCode: "29484", plate: "AA-12-BB", parkId: "p1", parkName: "Airpark", parkCity: "Lisboa",
    });
  });
  it("valores em falta ou estranhos ficam null; caminho interno não é link", () => {
    const o = mapOccurrenceRow({ id: "x", priority: "URGENT", resolved: false, attachment: "occurrences/abc.jpg", lat: "n/a" });
    expect(o.title).toBe("Ocorrência");
    expect(o.priority).toBeNull();
    expect(o.resolved).toBe(false);
    expect(o.lat).toBeNull();
    expect(o.attachment).toBe("occurrences/abc.jpg");
    expect(o.attachmentUrl).toBeNull();
  });
  it("contagens (bigint do pg vem em texto)", () => {
    expect(mapOccurrenceStatsRow({ total: "10", open: "4", resolved: "6", high: "2", high_open: "1", medium: "5", low: "3" }))
      .toEqual({ total: 10, open: 4, autoClosed: 0, resolved: 6, high: 2, highOpen: 1, medium: 5, low: 3 });
    expect(mapOccurrenceStatsRow(undefined).total).toBe(0);
  });
});

describe("ocorrências — leituras com degradação (multiparkDbQuery simulado)", () => {
  it("sem DATABASE_URL_MULTIPARK: indisponível, sem consultar", async () => {
    delete process.env[ENV];
    const r = await listMultiparkOccurrences();
    expect(r).toMatchObject({ available: false, code: "NOT_CONFIGURED" });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("lista: pede limit+1 para saber se há mais", async () => {
    process.env[ENV] = "postgres://u:p@h/db";
    queryMock.mockResolvedValueOnce([{ id: "a", title: "Atraso" }, { id: "b", title: "Atraso" }, { id: "c", title: "Atraso" }]);
    const r = await listMultiparkOccurrences({ limit: 2 });
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.data.rows.map((x) => x.id)).toEqual(["a", "b"]);
    expect(r.data.hasMore).toBe(true);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain(`FROM "Occurrence" o`);
    expect(params.slice(-2)).toEqual([3, 0]);
  });

  it("tempo esgotado → aviso amigável, não lança", async () => {
    process.env[ENV] = "postgres://u:p@h/db";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    queryMock.mockRejectedValueOnce(new MultiparkDbError("canceling statement due to statement timeout [57014]", "QUERY_FAILED"));
    const r = await getMultiparkOccurrenceStats({});
    expect(r).toMatchObject({ available: false, code: "TIMEOUT" });
    warn.mockRestore();
  });

  it("sem ligação → CONNECT_FAILED; por id inexistente → null", async () => {
    process.env[ENV] = "postgres://u:p@h/db";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    queryMock.mockRejectedValueOnce(new MultiparkDbError("ECONNREFUSED", "CONNECT_FAILED"));
    expect(await getMultiparkOccurrence("x")).toMatchObject({ available: false, code: "CONNECT_FAILED" });
    queryMock.mockResolvedValueOnce([]);
    expect(await getMultiparkOccurrence("x")).toEqual({ available: true, data: null });
    warn.mockRestore();
  });

  it("contagens: totais + por tipo + por parque", async () => {
    process.env[ENV] = "postgres://u:p@h/db";
    queryMock
      .mockResolvedValueOnce([{ total: "3", open: "1", resolved: "2", high: "1", high_open: "0", medium: "1", low: "1" }])
      .mockResolvedValueOnce([{ key: "Atraso", label: "Atraso", city: null, n: "2" }])
      .mockResolvedValueOnce([{ key: "p1", label: "Airpark", city: "Lisboa", n: "3" }]);
    const r = await getMultiparkOccurrenceStats({ parkId: "p1" });
    expect(r.available && r.data).toMatchObject({ total: 3, open: 1, byType: [{ key: "Atraso", count: 2 }], byPark: [{ key: "p1", label: "Airpark", count: 3 }] });
    // A lista de parques não leva o filtro de parque.
    expect(queryMock.mock.calls[2][1]).not.toContain("p1");
  });

  it("motivos por tipo de erro", () => {
    expect(describeReadFailure(new MultiparkDbError("x", "NOT_CONFIGURED")).code).toBe("NOT_CONFIGURED");
    expect(describeReadFailure(new Error("boom")).code).toBe("QUERY_FAILED");
  });
});
