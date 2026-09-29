import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  HANDOVER_CONFLICT_MESSAGE,
  HANDOVER_EXISTS_MESSAGE,
  HANDOVER_LOCKED_MESSAGE,
  allowedHandoverCities,
  decideHandoverWrite,
  defaultHandoverCity,
  diffHandoverFields,
  findPersonShift,
  maxHandoverDate,
  operationalDayWindowUtc,
  operationalShift,
} from "../shared/shiftHandover";
import { isIsoDay } from "../shared/expensePeriods";
import { buildHandoverInsert, buildHandoverList, buildHandoverUpdate, handoverBoundValues } from "./shiftHandoverSql";
import { MIGRATION_0087_STATEMENTS, IDEMPOTENT_ERROR_CODES_0087 } from "./migrations/migration_0087";

const at = (iso: string) => Date.parse(iso);
const compile = (q: ReturnType<typeof sql>) => new MySqlDialect().sqlToQuery(q);

describe("operationalShift (Europe/Lisbon, noite = dia em que começa)", () => {
  it("01:30 de Lisboa é ainda a noite do dia anterior", () => {
    // 2026-09-24 00:30 UTC = 01:30 WEST
    expect(operationalShift(at("2026-09-24T00:30:00Z"))).toEqual({ date: "2026-09-23", shift: "night" });
    expect(operationalShift(at("2026-09-24T01:59:00Z"))).toEqual({ date: "2026-09-23", shift: "night" });
  });
  it("03:00 começa a manhã, 15:00 a noite (verão)", () => {
    expect(operationalShift(at("2026-09-24T02:00:00Z"))).toEqual({ date: "2026-09-24", shift: "morning" });
    expect(operationalShift(at("2026-09-24T13:59:00Z"))).toEqual({ date: "2026-09-24", shift: "morning" });
    expect(operationalShift(at("2026-09-24T14:00:00Z"))).toEqual({ date: "2026-09-24", shift: "night" });
    expect(operationalShift(at("2026-09-24T22:59:00Z"))).toEqual({ date: "2026-09-24", shift: "night" });
    // 23:30 UTC = 00:30 de dia 25 em Lisboa → ainda a noite de 24
    expect(operationalShift(at("2026-09-24T23:30:00Z"))).toEqual({ date: "2026-09-24", shift: "night" });
  });
  it("inverno (WET = UTC)", () => {
    expect(operationalShift(at("2026-01-15T01:30:00Z"))).toEqual({ date: "2026-01-14", shift: "night" });
    expect(operationalShift(at("2026-01-15T03:00:00Z"))).toEqual({ date: "2026-01-15", shift: "morning" });
    expect(operationalShift(at("2026-01-15T15:00:00Z"))).toEqual({ date: "2026-01-15", shift: "night" });
  });
  it("mudança para a hora de verão (29 mar 2026, 01:00 → 02:00)", () => {
    expect(operationalShift(at("2026-03-29T00:30:00Z"))).toEqual({ date: "2026-03-28", shift: "night" }); // 00:30 WET
    expect(operationalShift(at("2026-03-29T01:30:00Z"))).toEqual({ date: "2026-03-28", shift: "night" }); // 02:30 WEST
    expect(operationalShift(at("2026-03-29T02:00:00Z"))).toEqual({ date: "2026-03-29", shift: "morning" }); // 03:00 WEST
  });
  it("mudança para a hora de inverno (25 out 2026, 02:00 → 01:00)", () => {
    expect(operationalShift(at("2026-10-25T00:30:00Z"))).toEqual({ date: "2026-10-24", shift: "night" }); // 01:30 WEST
    expect(operationalShift(at("2026-10-25T01:30:00Z"))).toEqual({ date: "2026-10-24", shift: "night" }); // 01:30 WET
    expect(operationalShift(at("2026-10-25T02:30:00Z"))).toEqual({ date: "2026-10-24", shift: "night" }); // 02:30 WET
    expect(operationalShift(at("2026-10-25T03:00:00Z"))).toEqual({ date: "2026-10-25", shift: "morning" }); // 03:00 WET
  });
});

describe("operationalDayWindowUtc (03:00 → 03:00 do dia seguinte, em UTC)", () => {
  it("verão e inverno", () => {
    expect(operationalDayWindowUtc("2026-09-23")).toMatchObject({ start: "2026-09-23 02:00:00", end: "2026-09-24 02:00:00" });
    expect(operationalDayWindowUtc("2026-01-15")).toMatchObject({ start: "2026-01-15 03:00:00", end: "2026-01-16 03:00:00" });
  });
  it("dias de mudança de hora (23h / 25h)", () => {
    const spring = operationalDayWindowUtc("2026-03-28");
    expect(spring).toMatchObject({ start: "2026-03-28 03:00:00", end: "2026-03-29 02:00:00" });
    expect((spring.endMs - spring.startMs) / 3_600_000).toBe(23);
    const autumn = operationalDayWindowUtc("2026-10-24");
    expect(autumn).toMatchObject({ start: "2026-10-24 02:00:00", end: "2026-10-25 03:00:00" });
    expect((autumn.endMs - autumn.startMs) / 3_600_000).toBe(25);
  });
});

describe("maxHandoverDate", () => {
  it("hoje (Lisboa) + 1", () => {
    expect(maxHandoverDate(at("2026-09-24T12:00:00Z"))).toBe("2026-09-25");
    // 23:30 UTC já é dia 25 em Lisboa
    expect(maxHandoverDate(at("2026-09-24T23:30:00Z"))).toBe("2026-09-26");
  });
});

describe("SQL da passagem de turno — valores sempre como parâmetros", () => {
  const evil = "a\\' OR 1=1 -- ";
  const key = { handoverDate: "2026-09-24", shift: "night" as const, city: "lisbon" as const };

  it("INSERT: texto malicioso vai intacto nos params, nunca no SQL", () => {
    const q = compile(buildHandoverInsert(key, { notes: evil, chargedUntilDate: "2026-09-24" }, { id: 7, name: evil }));
    expect(q.sql).not.toContain("OR 1=1");
    expect(q.sql).not.toContain("'");
    expect(q.params).toContain(evil);
    expect(q.params.filter((p) => p === evil)).toHaveLength(3); // notes + filledByName + createdByName
    expect(q.sql).toMatch(/^INSERT INTO `shift_handovers` \(/);
    expect(q.sql.match(/\?/g)?.length).toBe(q.params.length);
  });

  it("UPDATE: lock otimista pela versão e texto como parâmetro", () => {
    const q = compile(buildHandoverUpdate(42, 3, { notes: evil }, { id: 7, name: "Ana" }));
    expect(q.sql).not.toContain("OR 1=1");
    expect(q.params).toContain(evil);
    expect(q.sql).toContain("`version` = `version` + 1");
    expect(q.sql).toMatch(/WHERE `id` = \? AND `version` = \?$/);
    expect(q.params.slice(-2)).toEqual([42, 3]);
  });

  it("LIST: filtros ligados como parâmetros + âmbito de cidade", () => {
    const q = compile(buildHandoverList({ from: evil, to: "2026-09-24", city: evil }, sql`1 = 1`));
    expect(q.sql).not.toContain("OR 1=1");
    expect(q.params).toEqual([evil, "2026-09-24", evil]);
    expect(q.sql).toContain("WHERE 1 = 1 AND `handoverDate` >= ?");
  });

  it("corta ANTES de ligar (nunca depois de escapar)", () => {
    const v = handoverBoundValues({ notes: "'".repeat(3000), chargedUntilDate: "2026-09-24XXXX" });
    expect(v.notes).toHaveLength(2000);
    expect(v.chargedUntilDate).toBe("2026-09-24");
    const q = compile(buildHandoverInsert(key, {}, { id: 1, name: "x".repeat(400) }));
    expect(q.params).toContain("x".repeat(255));
  });

  it("NaN / texto em campos numéricos vira NULL; booleanos → 0/1", () => {
    const v = handoverBoundValues({ carsForCovered: Number.NaN, frontPouchValue: "abc", mbBattery: "80", pdasCharged: false, cashClosedInSafe: true });
    expect(v).toMatchObject({ carsForCovered: null, frontPouchValue: null, mbBattery: 80, pdasCharged: 0, cashClosedInSafe: 1 });
  });

  it("datas das consultas têm de ser dias ISO válidos", () => {
    expect(isIsoDay("2026-09-24")).toBe(true);
    expect(isIsoDay("2026-09-24' OR 1=1 -- ")).toBe(false);
    expect(isIsoDay("2026-02-30")).toBe(false);
  });
});

describe("decideHandoverWrite (lock otimista + 24h)", () => {
  it("registo novo", () => {
    expect(decideHandoverWrite(null, null, false)).toEqual({ ok: true, mode: "insert" });
  });
  it("alguém criou entretanto → CONFLICT", () => {
    expect(decideHandoverWrite({ version: 1, ageMinutes: 1 }, null, false)).toEqual({ ok: false, code: "CONFLICT", message: HANDOVER_EXISTS_MESSAGE });
  });
  it("versão mudou desde que foi carregado → CONFLICT com a mensagem PT-PT", () => {
    const d = decideHandoverWrite({ version: 3, ageMinutes: 5 }, 2, true);
    expect(d).toEqual({ ok: false, code: "CONFLICT", message: HANDOVER_CONFLICT_MESSAGE });
    expect(HANDOVER_CONFLICT_MESSAGE).toBe("Outra pessoa alterou esta passagem — recarrega");
  });
  it("registo apagado depois de carregado → CONFLICT", () => {
    expect(decideHandoverWrite(null, 2, false)).toMatchObject({ ok: false, code: "CONFLICT" });
  });
  it("mesma versão → update", () => {
    expect(decideHandoverWrite({ version: 2, ageMinutes: 60 }, 2, false)).toEqual({ ok: true, mode: "update" });
  });
  it("mais de 24h: team leader bloqueado, supervisor pode", () => {
    expect(decideHandoverWrite({ version: 2, ageMinutes: 24 * 60 + 1 }, 2, false)).toEqual({ ok: false, code: "FORBIDDEN", message: HANDOVER_LOCKED_MESSAGE });
    expect(decideHandoverWrite({ version: 2, ageMinutes: 24 * 60 + 1 }, 2, true)).toEqual({ ok: true, mode: "update" });
    expect(decideHandoverWrite({ version: 2, ageMinutes: 24 * 60 }, 2, false)).toEqual({ ok: true, mode: "update" });
  });
});

describe("diffHandoverFields", () => {
  it("compara valores normalizados (DECIMAL '12.50' = 12.5)", () => {
    const before = handoverBoundValues({ frontPouchValue: "12.50", notes: "ok", mbRolls: 3, pdasCharged: 1 });
    const after = handoverBoundValues({ frontPouchValue: 12.5, notes: "ok!", mbRolls: 3, pdasCharged: true });
    expect(diffHandoverFields(before, after)).toEqual(["notes"]);
  });
  it("registo novo: só os campos preenchidos", () => {
    expect(diffHandoverFields(null, handoverBoundValues({ mbRolls: 2 }))).toEqual(["mbRolls"]);
  });
});

describe("cidade por omissão", () => {
  it("só as cidades do utilizador; uma → essa", () => {
    const porto = allowedHandoverCities({ all: false, cityNames: ["Porto"] });
    expect(porto).toEqual(["porto"]);
    expect(defaultHandoverCity(porto, "lisbon")).toBe("porto");
  });
  it("todas → última usada; última inválida → primeira", () => {
    const all = allowedHandoverCities({ all: true });
    expect(defaultHandoverCity(all, "faro")).toBe("faro");
    expect(defaultHandoverCity(all, "xpto")).toBe("lisbon");
    expect(defaultHandoverCity(allowedHandoverCities({ all: false, cityNames: ["Lisboa", "Faro"] }), null)).toBe("lisbon");
    expect(defaultHandoverCity([], "lisbon")).toBeNull();
  });
});

describe("findPersonShift", () => {
  const shifts = [
    { employeeId: 1, personName: "Rui Silva", city: "lisbon", shift: "morning" },
    { employeeId: null, personName: "Ana", city: "porto", shift: "night" },
    { employeeId: null, personName: "Ana", city: "lisbon", shift: "morning" },
  ];
  it("pelo id quando existe (o nome não engana)", () => {
    expect(findPersonShift(shifts, { employeeId: 1, name: "Outro" })?.shift).toBe("morning");
    // id diferente com o mesmo nome de uma linha COM id → não casa
    expect(findPersonShift(shifts, { employeeId: 9, name: "Rui Silva" })).toBeUndefined();
  });
  it("sem id: nome + cidade", () => {
    expect(findPersonShift(shifts, { employeeId: null, name: "ana" }, "porto")?.shift).toBe("night");
    expect(findPersonShift(shifts, { employeeId: null, name: "Ana" }, "lisbon")?.shift).toBe("morning");
  });
});

describe("migração 0087", () => {
  it("cria a tabela e acrescenta as colunas de integridade (idempotente)", () => {
    expect(MIGRATION_0087_STATEMENTS[0]).toMatch(/^CREATE TABLE IF NOT EXISTS `shift_handovers`/);
    for (const c of ["createdById", "createdByName", "version"]) {
      expect(MIGRATION_0087_STATEMENTS.some((s) => s.includes(`ADD COLUMN \`${c}\``))).toBe(true);
    }
    expect(IDEMPOTENT_ERROR_CODES_0087.has("ER_DUP_FIELDNAME")).toBe(true);
  });
});
