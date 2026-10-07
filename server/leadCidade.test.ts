// Cidade no "Novo lead" (pedido 9), Jorge 7 out 2026: "deve dar para por aqui a
// cidade em que vai estar o extra".
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LEAD_CITY_OUT_OF_SCOPE_MSG,
  LEAD_CITY_REQUIRED_MSG,
  LEAD_NO_CITY,
  LEAD_NO_CITY_FORBIDDEN_MSG,
  defaultConvertCity,
  defaultNewLeadCity,
  leadCityToProjectId,
  newLeadCityError,
  resolveNewLeadCity,
} from "../shared/leadCity";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("Cidade no Novo lead", () => {
  const scoped = { scope: [10, 11] as number[], defaultCityId: 10 };
  const national = { scope: undefined, defaultCityId: null };
  it("servidor: fora das cidades → erro; 'Sem cidade' só nacional; sem campo → a cidade de quem cria", () => {
    expect(resolveNewLeadCity(10, scoped)).toEqual({ ok: true, projectId: 10 });
    expect(resolveNewLeadCity(20, scoped)).toEqual({ ok: false, error: LEAD_CITY_OUT_OF_SCOPE_MSG });
    expect(resolveNewLeadCity(null, scoped)).toEqual({ ok: false, error: LEAD_NO_CITY_FORBIDDEN_MSG });
    expect(resolveNewLeadCity(null, national)).toEqual({ ok: true, projectId: null });
    expect(resolveNewLeadCity(20, national)).toEqual({ ok: true, projectId: 20 });
    expect(resolveNewLeadCity(undefined, scoped)).toEqual({ ok: true, projectId: 10 });
    expect(resolveNewLeadCity(undefined, national)).toEqual({ ok: true, projectId: null });
    expect(resolveNewLeadCity(0, national)).toEqual({ ok: false, error: LEAD_CITY_REQUIRED_MSG });
  });
  it("ecrã: obrigatória; pré-escolhida com uma só cidade; 'Sem cidade' só para quem vê todas", () => {
    expect(defaultNewLeadCity([10])).toBe("10");
    expect(defaultNewLeadCity([10, 11])).toBe("");
    expect(newLeadCityError("", true)).toBe(LEAD_CITY_REQUIRED_MSG);
    expect(newLeadCityError(LEAD_NO_CITY, false)).toBe(LEAD_NO_CITY_FORBIDDEN_MSG);
    expect(newLeadCityError(LEAD_NO_CITY, true)).toBeNull();
    expect(newLeadCityError("10", false)).toBeNull();
    expect(leadCityToProjectId(LEAD_NO_CITY)).toBeNull();
    expect(leadCityToProjectId("10")).toBe(10);
  });
  it("converter em extra pré-escolhe a cidade do lead (se for das de quem converte)", () => {
    expect(defaultConvertCity({ projectId: 11 }, [10, 11])).toBe("11");
    expect(defaultConvertCity({ projectId: 99 }, [10, 11])).toBe("");
    expect(defaultConvertCity({ projectId: 99 }, [10])).toBe("10");
    expect(defaultConvertCity({ projectId: null }, [10])).toBe("10");
    expect(defaultConvertCity({ projectId: null }, [10, 11])).toBe("");
  });
  it("o servidor aceita e valida a cidade no create; a página manda-a e pré-preenche o converter", () => {
    const r = src("server/routers.ts");
    const create = r.slice(r.indexOf("    create: protectedProcedure", r.indexOf("extraLeads: router(")));
    expect(create.slice(0, 800)).toContain("projectId: z.number().int().positive().nullable().optional(),");
    const s = src("server/extraLeads.ts");
    expect(s).toContain("const city = resolveNewLeadCity(input.projectId, { scope: scopedProjectIds(), defaultCityId: currentDefaultCityId() });");
    expect(s).toContain("if (input.projectId !== undefined) await assertLeadCity(city.projectId);");
    const p = src("client/src/pages/ExtraLeadsPage.tsx");
    expect(p).toContain("create.mutate({ ...payload, projectId: leadCityToProjectId(draft.city) });");
    expect(p).toContain("setConvertProjectId(defaultConvertCity(l, cityIds));");
    expect(p).toContain("<Label>Cidade *</Label>");
  });
});
