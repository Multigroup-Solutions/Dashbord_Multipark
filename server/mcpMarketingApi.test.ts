import { describe, it, expect } from "vitest";
import { parseMarketingQuery, parseWebQuery } from "./mcpMarketingApi";

describe("parseMarketingQuery", () => {
  it("exige from e to", () => {
    expect(parseMarketingQuery({})).toHaveProperty("error");
    expect(parseMarketingQuery({ from: "2026-09-01" })).toHaveProperty("error");
  });
  it("aceita intervalo válido sem projectId", () => {
    expect(parseMarketingQuery({ from: "2026-09-01", to: "2026-09-30" })).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });
  it("converte projectId e rejeita lixo", () => {
    expect(parseMarketingQuery({ from: "2026-09-01", to: "2026-09-30", projectId: "3" })).toMatchObject({ projectId: 3 });
    expect(parseMarketingQuery({ from: "2026-09-01", to: "2026-09-30", projectId: "abc" })).toHaveProperty("error");
    expect(parseMarketingQuery({ from: "2026-09-01", to: "2026-09-30", projectId: "0" })).toHaveProperty("error");
  });
  it("rejeita mais de 366 dias e datas trocadas", () => {
    expect(parseMarketingQuery({ from: "2025-01-01", to: "2026-09-30" })).toHaveProperty("error");
    expect(parseMarketingQuery({ from: "2026-09-30", to: "2026-09-01" })).toHaveProperty("error");
  });
});

describe("parseWebQuery", () => {
  const rg = { from: "2026-09-24", to: "2026-09-30" };
  it("overview: defaults e validação de marca/comparação", () => {
    expect(parseWebQuery(rg, false)).toMatchObject({ brand: null, compare: "previous" });
    expect(parseWebQuery({ ...rg, brand: "skypark", compare: "yoy" }, false)).toMatchObject({ brand: "skypark", compare: "yoy" });
    expect(parseWebQuery({ ...rg, brand: "outra" }, false)).toHaveProperty("error");
    expect(parseWebQuery({ ...rg, compare: "x" }, false)).toHaveProperty("error");
  });
  it("lista: fonte, dimensão e ordenação têm de bater certo", () => {
    expect(parseWebQuery({ ...rg, source: "ga", dim: "channel" }, true)).toMatchObject({ source: "ga", dim: "channel", sort: "sessions", pageSize: 25 });
    expect(parseWebQuery({ ...rg, source: "sc", dim: "query" }, true)).toMatchObject({ sort: "clicks" });
    expect(parseWebQuery({ ...rg, source: "sc", dim: "channel" }, true)).toHaveProperty("error");
    expect(parseWebQuery({ ...rg, source: "ga", dim: "channel", sort: "clicks" }, true)).toHaveProperty("error");
    expect(parseWebQuery({ ...rg, source: "x", dim: "channel" }, true)).toHaveProperty("error");
  });
  it("lista: pageSize entre 5 e 100", () => {
    expect(parseWebQuery({ ...rg, source: "ga", dim: "city", pageSize: "100" }, true)).toMatchObject({ pageSize: 100 });
    expect(parseWebQuery({ ...rg, source: "ga", dim: "city", pageSize: "3" }, true)).toHaveProperty("error");
    expect(parseWebQuery({ ...rg, source: "ga", dim: "city", pageSize: "101" }, true)).toHaveProperty("error");
  });
});
