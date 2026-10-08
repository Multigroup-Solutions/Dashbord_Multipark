/**
 * Dias livres HABITUAIS (Jorge, 8 out 2026): "tenho livres as terças-feiras à
 * tarde e as quartas de manhã, e todos os fins de semana". Regra pura
 * (resumo, atalhos, turnos), validação, acessos (a própria pessoa com a ficha
 * inativa, RH no âmbito de cidade, recusa fora dele), migração 0580 e ecrãs.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  access: null as any,
  me: null as any,
  people: {} as Record<number, any>,
  logs: [] as any[],
  saved: [] as any[],
}));

vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => state.access,
  loadCityAccessParts: async () => ({ access: state.access, base: state.access, all: state.access }),
}));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => null,
  getUserPermissionOverrides: async () => ({}),
  getUserModuleOverrides: async () => ({}),
  getEmployeeByUserId: async (userId: number) => (userId === 1 ? state.me : undefined),
  getEmployeeById: async (id: number) => state.people[id],
  getUserById: async () => undefined,
  resolveProjectIds: async (id: number) => [id],
  logActivity: async (x: any) => { state.logs.push(x); },
}));
vi.mock("./availabilityPattern", async (original) => ({
  ...(await original<object>()),
  getAvailabilityPattern: async (employeeId: number) => ({ employeeId, slots: { tue: ["afternoon"] }, note: null, summary: "Ter tarde", updatedAt: null, updatedByName: null }),
  saveAvailabilityPattern: async (...a: any[]) => {
    state.saved.push(a);
    return { view: { employeeId: a[0], slots: a[1], note: a[2], summary: "Ter tarde", updatedAt: "2026-10-08 10:00:00", updatedByName: "Rita" }, previous: "nada", current: "Ter tarde" };
  },
}));

import { appRouter } from "./routers";
import { isPersonalAccessPath, ownRecordEmployeeId } from "./cityAccess";
import { patternLogLine } from "./availabilityPattern";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { MIGRATION_0580_STATEMENTS, IDEMPOTENT_ERROR_CODES_0580 } from "./migrations/migration_0580";
import {
  applyShortcut,
  describePeriods,
  isEmptyPattern,
  normalizeSlots,
  parseSlots,
  patternCoversShift,
  patternCoversShiftOn,
  patternDayOf,
  patternHintFor,
  patternInputSchema,
  patternSlotsSchema,
  serializeSlots,
  shortcutActive,
  summarizePattern,
  toggleSlot,
  type PatternSlots,
} from "../shared/availabilityPattern";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const caller = (role: string, id = 1) => appRouter.createCaller({ user: { id, role, name: "Rita", email: "rita@exemplo.pt" }, req: { headers: {} }, res: {} } as any);

const NATIONAL = { all: true, defaultCityId: null, cityName: null, cityIds: [] as number[], projectIds: [] as number[], missingCostCenter: false };
const PORTO = { all: false, defaultCityId: 50, cityName: "Porto", cityIds: [50], projectIds: [50, 65], missingCostCenter: false };
const NO_CITY = { all: false, defaultCityId: null, cityName: null, cityIds: [] as number[], projectIds: [] as number[], missingCostCenter: true };

beforeEach(() => {
  state.access = NATIONAL;
  // Candidato / inativo que volta: a ficha da conta está INATIVA e sem cidade.
  state.me = { employee: { id: 7, isActive: 0, projectId: null, fullName: "Eu Candidato", userId: 1 } };
  state.people = {
    7: { employee: { id: 7, projectId: 50, userId: 1, fullName: "Eu Candidato", position: "extra" } },
    8: { employee: { id: 8, projectId: 49, userId: null, fullName: "Ana de Lisboa", position: "extra" } },
    9: { employee: { id: 9, projectId: 65, userId: null, fullName: "Bruno do Porto", position: "extra" } },
  };
  state.logs = [];
  state.saved = [];
});

// ─── Regra pura ──────────────────────────────────────────────────────────────

describe("Resumo legível", () => {
  const jorge: PatternSlots = { tue: ["afternoon"], wed: ["morning"], sat: ["morning", "afternoon", "night"], sun: ["night", "afternoon", "morning"] };
  it("o exemplo do Jorge: terças à tarde, quartas de manhã e todos os fins de semana", () => {
    expect(summarizePattern(jorge)).toBe("Ter tarde · Qua manhã · Sáb e Dom todo o dia");
    expect(summarizePattern(jorge, { short: true })).toBe("Ter tarde · Qua manhã · Fins de semana");
  });
  it("junta os dias com os mesmos períodos; 3 ou mais seguidos ficam 'X a Y'", () => {
    expect(summarizePattern({ mon: ["morning"], tue: ["morning"], wed: ["morning"], fri: ["morning"] })).toBe("Seg a Qua e Sex manhã");
    expect(summarizePattern({ tue: ["afternoon"], thu: ["afternoon"] })).toBe("Ter e Qui tarde");
    expect(summarizePattern({ mon: ["afternoon", "night"] })).toBe("Seg tarde e noite");
  });
  it("curto: Dias úteis / Todos os dias, com o período quando não é o dia todo", () => {
    const weekdaysMorning = { mon: ["morning"], tue: ["morning"], wed: ["morning"], thu: ["morning"], fri: ["morning"] } as PatternSlots;
    expect(summarizePattern(weekdaysMorning, { short: true })).toBe("Dias úteis de manhã");
    expect(summarizePattern(weekdaysMorning)).toBe("Seg a Sex manhã");
    expect(summarizePattern(applyShortcut({}, "everyday"), { short: true })).toBe("Todos os dias");
    expect(summarizePattern({ sat: ["afternoon", "night"], sun: ["afternoon", "night"] }, { short: true })).toBe("Fins de semana à tarde e à noite");
  });
  it("vazio = texto vazio; períodos por extenso", () => {
    expect(summarizePattern({})).toBe("");
    expect(describePeriods(["night", "morning"])).toBe("manhã e noite");
    expect(describePeriods(["morning", "afternoon", "night"])).toBe("todo o dia");
  });
});

describe("Forma canónica", () => {
  it("só dias e períodos válidos, sem repetidos, pela ordem; dias vazios saem", () => {
    expect(normalizeSlots({ sun: ["night", "morning", "night"], foo: ["morning"], mon: [], tue: ["lanche"] })).toEqual({ sun: ["morning", "night"] });
    expect(normalizeSlots(null)).toEqual({});
    expect(normalizeSlots(["mon"])).toEqual({});
  });
  it("texto da BD estragado = grelha vazia (nunca erro); ida e volta", () => {
    expect(parseSlots("{não é json")).toEqual({});
    expect(parseSlots(null)).toEqual({});
    const s: PatternSlots = { wed: ["morning"], tue: ["afternoon"] };
    expect(serializeSlots(s)).toBe('{"tue":["afternoon"],"wed":["morning"]}');
    expect(parseSlots(serializeSlots(s))).toEqual({ tue: ["afternoon"], wed: ["morning"] });
  });
  it("tocar numa casa liga e desliga", () => {
    const a = toggleSlot({}, "tue", "afternoon");
    expect(a).toEqual({ tue: ["afternoon"] });
    expect(toggleSlot(a, "tue", "afternoon")).toEqual({});
    expect(isEmptyPattern(toggleSlot(a, "tue", "afternoon"))).toBe(true);
  });
});

describe("Atalhos", () => {
  it("'Fins de semana' soma ao que já está (não apaga a terça à tarde)", () => {
    const s = applyShortcut({ tue: ["afternoon"] }, "weekends");
    expect(s).toEqual({ tue: ["afternoon"], sat: ["morning", "afternoon", "night"], sun: ["morning", "afternoon", "night"] });
    expect(shortcutActive(s, "weekends")).toBe(true);
    expect(shortcutActive(s, "weekdays")).toBe(false);
  });
  it("tocar outra vez desfaz só esses dias", () => {
    const s = applyShortcut(applyShortcut({ tue: ["afternoon"] }, "weekends"), "weekends");
    expect(s).toEqual({ tue: ["afternoon"] });
  });
  it("'Dias úteis' completa os dias a meio; 'Todos os dias' marca tudo; 'Limpar' tira tudo", () => {
    const s = applyShortcut({ tue: ["afternoon"] }, "weekdays");
    expect(Object.keys(s)).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(s.tue).toEqual(["morning", "afternoon", "night"]);
    const all = applyShortcut(s, "everyday");
    expect(Object.keys(all)).toHaveLength(7);
    expect(shortcutActive(all, "everyday")).toBe(true);
    expect(applyShortcut(all, "clear")).toEqual({});
    expect(shortcutActive({}, "clear")).toBe(true);
  });
});

describe("Turnos do sistema (só dicas)", () => {
  const s: PatternSlots = { tue: ["afternoon"], wed: ["morning"], fri: ["night"] };
  it("manhã ⇐ Manhã; noite ⇐ Tarde ou Noite", () => {
    expect(patternCoversShift(s, "wed", "morning")).toBe(true);
    expect(patternCoversShift(s, "wed", "night")).toBe(false);
    expect(patternCoversShift(s, "tue", "night")).toBe(true);
    expect(patternCoversShift(s, "tue", "morning")).toBe(false);
    expect(patternCoversShift(s, "fri", "night")).toBe(true);
    expect(patternCoversShift(s, "mon", "night")).toBe(false);
  });
  it("por data: 8 out 2026 é quinta; 13 out 2026 é terça", () => {
    expect(patternDayOf("2026-10-08")).toBe("thu");
    expect(patternDayOf("2026-10-13")).toBe("tue");
    expect(patternDayOf("2026-02-30")).toBeNull();
    expect(patternDayOf("lixo")).toBeNull();
    expect(patternCoversShiftOn(s, "2026-10-13", "night")).toBe(true);
    expect(patternCoversShiftOn(s, "2026-10-13", "morning")).toBe(false);
  });
  it("dica do dia: o que costuma ter livre nesse dia da semana", () => {
    expect(patternHintFor(s, "2026-10-13")).toEqual({ text: "Ter tarde", morning: false, night: true });
    expect(patternHintFor(s, "2026-10-12")).toEqual({ text: "", morning: false, night: false });
    expect(patternHintFor({}, "2026-10-13")).toBeNull();
  });
});

describe("Validação (zod)", () => {
  it("aceita a grelha e a nota", () => {
    expect(patternInputSchema.safeParse({ slots: { tue: ["afternoon"], sat: ["morning", "afternoon", "night"] }, note: "não posso em agosto" }).success).toBe(true);
    expect(patternInputSchema.safeParse({ slots: {} }).success).toBe(true);
  });
  it("recusa dias e períodos que não existem, períodos a mais e notas longas", () => {
    expect(patternSlotsSchema.safeParse({ segunda: ["morning"] }).success).toBe(false);
    expect(patternSlotsSchema.safeParse({ mon: ["madrugada"] }).success).toBe(false);
    expect(patternSlotsSchema.safeParse({ mon: ["morning", "afternoon", "night", "morning"] }).success).toBe(false);
    expect(patternInputSchema.safeParse({ slots: {}, note: "x".repeat(301) }).success).toBe(false);
  });
  it("o servidor recusa antes de gravar", async () => {
    await expect(caller("extra").extrasAvailability.setMyPattern({ slots: { segunda: ["morning"] } as any })).rejects.toThrow();
    expect(state.saved).toHaveLength(0);
  });
});

// ─── Acessos ─────────────────────────────────────────────────────────────────

describe("A própria pessoa (também com a ficha INATIVA)", () => {
  it("vê e grava os seus dias habituais — candidato/inativo que volta", async () => {
    await expect(caller("extra").extrasAvailability.myPattern()).resolves.toMatchObject({ employeeId: 7, own: true, canEdit: true });
    const r = await caller("extra").extrasAvailability.setMyPattern({ slots: { tue: ["afternoon"] }, note: "  todos os fins de semana  " });
    expect(r).toMatchObject({ employeeId: 7, own: true });
    expect(state.saved[0].slice(0, 2)).toEqual([7, { tue: ["afternoon"] }]);
    expect(state.saved[0][3]).toBe(1); // quem gravou = a conta
    expect(state.logs.at(-1)).toMatchObject({ action: "availability_pattern_set", entity: "extras_availability_pattern", entityId: 7 });
    expect(state.logs.at(-1).details).toContain("antes: nada");
  });
  it("conta sem ficha: diz qual é a conta e o que fazer", async () => {
    state.me = undefined;
    await expect(caller("extra").extrasAvailability.myPattern()).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("rita@exemplo.pt") });
    await expect(caller("extra").extrasAvailability.setMyPattern({ slots: {} })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.saved).toHaveLength(0);
  });
  it("sem centro de custos: os seus dias passam; a ficha de outra pessoa não", async () => {
    state.access = NO_CITY;
    expect(isPersonalAccessPath("extrasAvailability.myPattern")).toBe(true);
    expect(isPersonalAccessPath("extrasAvailability.setMyPattern")).toBe(true);
    expect(ownRecordEmployeeId("extrasAvailability.patternFor", { employeeId: 7 })).toBe(7);
    await expect(caller("extra").extrasAvailability.myPattern()).resolves.toMatchObject({ employeeId: 7 });
    await expect(caller("extra").extrasAvailability.patternFor({ employeeId: 7 })).resolves.toMatchObject({ own: true, canEdit: true });
    await expect(caller("extra").extrasAvailability.patternFor({ employeeId: 8 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("um extra não marca os dias de outra pessoa", async () => {
    await expect(caller("extra").extrasAvailability.setPatternFor({ employeeId: 8, slots: {} })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.saved).toHaveLength(0);
  });
});

describe("RH / supervisor: o mesmo controlo que a disponibilidade da semana", () => {
  it("dentro do âmbito: vê e marca por alguém, com registo", async () => {
    state.access = PORTO;
    state.me = { employee: { id: 1, isActive: 1, projectId: 50, fullName: "Supervisora", userId: 1 } };
    await expect(caller("supervisor").extrasAvailability.patternFor({ employeeId: 9 })).resolves.toMatchObject({ employeeId: 9, own: false, canEdit: true });
    await caller("supervisor").extrasAvailability.setPatternFor({ employeeId: 9, slots: { sat: ["morning"] }, note: null });
    expect(state.saved[0].slice(0, 2)).toEqual([9, { sat: ["morning"] }]);
    expect(state.logs.at(-1)).toMatchObject({ action: "availability_pattern_manual", entity: "extras_availability_pattern", entityId: 9 });
    expect(state.logs.at(-1).details).toContain("Bruno do Porto");
  });
  it("fora do âmbito de cidade: recusa ver e marcar (também a um admin só do Porto)", async () => {
    state.access = PORTO;
    state.me = { employee: { id: 1, isActive: 1, projectId: 50, fullName: "Supervisora", userId: 1 } };
    for (const role of ["supervisor", "admin"]) {
      await expect(caller(role).extrasAvailability.patternFor({ employeeId: 8 })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller(role).extrasAvailability.setPatternFor({ employeeId: 8, slots: { sat: ["morning"] } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(state.saved).toHaveLength(0);
  });
  it("ficha que não existe: não encontrado", async () => {
    await expect(caller("admin").extrasAvailability.setPatternFor({ employeeId: 99, slots: {} })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("histórico em texto curto", () => {
    expect(patternLogLine({}, null)).toBe("nada");
    expect(patternLogLine({ tue: ["afternoon"] }, "não posso em agosto")).toBe("Ter tarde (nota: não posso em agosto)");
  });
});

// ─── Migração, gravação e ecrãs ──────────────────────────────────────────────

describe("Migração 0580 e gravação", () => {
  it("cria extras_availability_pattern (uma linha por ficha) e está registada a seguir à 0575", () => {
    expect(MIGRATION_0580_STATEMENTS).toHaveLength(1);
    expect(MIGRATION_0580_STATEMENTS[0]).toMatch(/^CREATE TABLE IF NOT EXISTS `extras_availability_pattern`/);
    expect(MIGRATION_0580_STATEMENTS[0]).toContain("UNIQUE KEY `extras_availability_pattern_emp_unique` (`employeeId`)");
    expect(IDEMPOTENT_ERROR_CODES_0580.has("ER_TABLE_EXISTS_ERROR")).toBe(true);
    expect(SCHEMA_MIGRATION_IDS.indexOf("0580")).toBe(SCHEMA_MIGRATION_IDS.indexOf("0575") + 1);
    expect(src("drizzle/schema.ts")).toContain('export const extrasAvailabilityPattern = mysqlTable("extras_availability_pattern"');
  });
  it("gravar substitui a linha (nunca se apaga) e não mexe na disponibilidade da semana", () => {
    const s = src("server/availabilityPattern.ts");
    expect(s).toContain(".onDuplicateKeyUpdate(");
    expect(s).not.toMatch(/\.delete\(|DELETE\s+FROM/i);
    expect(s).not.toContain("extrasAvailability,");
    expect(src("server/availabilityPatternRouter.ts")).not.toMatch(/\.delete\(|DELETE\s+FROM/i);
  });
  it("a escala automática não lê os dias habituais (é só uma dica)", () => {
    for (const f of ["server/extrasAutomation.ts", "server/extrasSchedule.ts", "server/extrasDia.ts"]) {
      expect(src(f)).not.toContain("availabilityPattern");
    }
  });
});

describe("Ecrãs", () => {
  it("/disponibilidade: o cartão dos dias habituais fica por cima da semana", () => {
    const page = src("client/src/pages/DisponibilidadePage.tsx");
    expect(page.indexOf("<MyAvailabilityPatternCard />")).toBeGreaterThan(-1);
    expect(page.indexOf("<MyAvailabilityPatternCard />")).toBeLessThan(page.indexOf("A minha disponibilidade"));
  });
  it("ficha no RH, lista da gestão e seletor do Extras-Dia mostram o habitual", () => {
    expect(src("client/src/components/EmployeeAccessAvailability.tsx")).toContain("<EmployeeAvailabilityPattern employeeId={employeeId} />");
    expect(src("client/src/pages/ExtrasDiaPage.tsx")).toContain("{!ex.responded && <HabitualLine habitual={ex.habitual} note={ex.habitualNote} />}");
    expect(src("server/extrasAvailability.ts")).toContain("habitual: patterns.has(e.id) ? summarizePattern(patterns.get(e.id)!.slots, { short: true }) || null : null,");
    const picker = src("client/src/pages/extrasDia/PersonPicker.tsx");
    expect(picker).toContain('c.availability?.status === "no_response" ? c.habitual ?? null : null');
  });
});
