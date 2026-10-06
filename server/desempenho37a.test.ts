/**
 * P3 lote 37a — Desempenho por pessoa (Jorge, 6 out 2026): tudo o que cada
 * pessoa fez (dashboard + Multipark + Zello), por dia/semana/mês/ano, por
 * posto, com ranking. Só o super admin.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  bucketOf, emptyTotals, groupOf, perfRange, perHourOf, periodTitle, rankPeople, shiftAnchor, utcHourMs, workPoints, GROUP_VIEW, PERF_METRICS,
} from "../shared/peoplePerformance";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("37a — abas por posto", () => {
  it("o papel da conta manda no escritório e chefias; senão o posto da ficha", () => {
    expect(groupOf({ position: "driver", role: "backoffice" })).toBe("office");
    expect(groupOf({ position: "driver", role: "frontoffice" })).toBe("office");
    expect(groupOf({ position: "driver", role: "supervisor" })).toBe("supervision");
    expect(groupOf({ position: "extra", role: "team_leader" })).toBe("teamleaders");
    expect(groupOf({ position: "director", role: "admin" })).toBe("supervision");
    expect(groupOf({ position: "senior_driver", role: "condutor" })).toBe("drivers");
    expect(groupOf({ position: "extra", role: null })).toBe("drivers");
    expect(groupOf({ position: null, role: "user", contractType: "extra" })).toBe("drivers");
    expect(groupOf({ position: null, role: "admin" })).toBeNull();
  });
});

describe("37a — períodos e baldes", () => {
  it("dia, semana (seg–dom), mês (dias) e ano (meses)", () => {
    expect(perfRange("day", "2026-10-06")).toMatchObject({ from: "2026-10-06", to: "2026-10-06", buckets: ["2026-10-06"] });
    const w = perfRange("week", "2026-10-08"); // quinta
    expect(w.from).toBe("2026-10-05");
    expect(w.to).toBe("2026-10-11");
    expect(w.bucketLabels[0]).toBe("seg 05");
    const m = perfRange("month", "2026-02-10");
    expect(m.buckets).toHaveLength(28);
    expect(m.to).toBe("2026-02-28");
    const y = perfRange("year", "2026-10-06");
    expect(y).toMatchObject({ from: "2026-01-01", to: "2026-12-31" });
    expect(y.buckets).toHaveLength(12);
    expect(bucketOf("year", "2026-03-15", y)).toBe("2026-03");
    expect(bucketOf("month", "2026-03-15", m)).toBeNull();
    expect(() => perfRange("month", "06/10/2026")).toThrow(/inválido/);
  });

  it("setas: o período anterior/seguinte (fim de mês e ano bissexto incluídos)", () => {
    expect(shiftAnchor("day", "2026-10-06", -1)).toBe("2026-10-05");
    expect(shiftAnchor("week", "2026-10-06", 1)).toBe("2026-10-13");
    expect(shiftAnchor("month", "2026-03-31", -1)).toBe("2026-02-28");
    expect(shiftAnchor("month", "2026-12-15", 1)).toBe("2027-01-15");
    expect(shiftAnchor("year", "2028-02-29", 1)).toBe("2029-02-28");
    expect(periodTitle("month", "2026-10-06")).toBe("out 2026");
    expect(periodTitle("week", "2026-10-08")).toBe("semana de 5 out a 11 out");
  });

  it("hora UTC agrupada no SQL → instante", () => {
    expect(utcHourMs("2026-10-06 01")).toBe(Date.parse("2026-10-06T01:00:00Z"));
    expect(utcHourMs("2026-10-06 01:00:00")).toBe(Date.parse("2026-10-06T01:00:00Z"));
  });
});

describe("37a — pontos e ranking", () => {
  it("pontos = soma ponderada da aba; condutores pelos pontos da avaliação, excessos descontam", () => {
    const t = emptyTotals();
    t.callsAnswered = 10; t.emails = 5; t.created = 2; t.updated = 4;
    expect(workPoints("office", t)).toBe(10 * 2 + 5 * 2 + 2 * 3 + 4 * 1);
    const d = emptyTotals();
    d.evalPoints = 120; d.overLimitDays = 2; d.occurrences = 3;
    expect(workPoints("drivers", d)).toBe(120 - 20 + 3);
    // as horas e os km nunca dão pontos
    for (const g of Object.keys(GROUP_VIEW) as Array<keyof typeof GROUP_VIEW>) {
      expect(GROUP_VIEW[g].weights.hours).toBeUndefined();
      expect(GROUP_VIEW[g].weights.km).toBeUndefined();
      for (const k of [...GROUP_VIEW[g].cards, ...GROUP_VIEW[g].columns, ...GROUP_VIEW[g].chart]) expect(PERF_METRICS[k]).toBeTruthy();
      expect(GROUP_VIEW[g].chart.length).toBeLessThanOrEqual(4); // 4 cores validadas
    }
  });

  it("por hora: só com 4 h ou mais; quem não tem vai para o fim; nota 100 para o melhor", () => {
    expect(perHourOf(50, 3.9)).toBeNull();
    expect(perHourOf(50, 10)).toBe(5);
    const base = { totals: emptyTotals() };
    const rows = [
      { employeeId: 1, name: "Ana", points: 100, perHour: 10, ...base },
      { employeeId: 2, name: "Bruno", points: 300, perHour: null, ...base },
      { employeeId: 3, name: "Carla", points: 80, perHour: 20, ...base },
    ];
    expect(rankPeople(rows, "perHour").map((r) => [r.name, r.rank, r.grade])).toEqual([["Carla", 1, 100], ["Ana", 2, 50], ["Bruno", 3, 0]]);
    expect(rankPeople(rows, "total").map((r) => [r.name, r.grade])).toEqual([["Bruno", 100], ["Ana", 33], ["Carla", 27]]);
  });
});

// ─── Juntar as fontes (BD simulada) ──────────────────────────────────────────
const h = vi.hoisted(() => ({ texts: [] as string[] }));
vi.mock("./dayActivity", () => ({ speedThreshold: async () => 100 }));
vi.mock("./db", () => ({
  getDb: async () => ({
    execute: async (q: any) => {
      const flat = (c: any): string => (c?.queryChunks ? c.queryChunks.map(flat).join("") : Array.isArray(c?.value) ? c.value.join("") : typeof c === "string" ? c : "");
      const text = flat(q);
      h.texts.push(text);
      if (/FROM employees e LEFT JOIN users/.test(text)) return [[
        { id: 1, fullName: "Ana Condutora", position: "driver", contractType: "permanent", isActive: 1, userId: 11, photoUrl: null, role: "condutor" },
        { id: 2, fullName: "Bea Front", position: "driver", contractType: "permanent", isActive: 1, userId: 12, photoUrl: null, role: "frontoffice" },
        { id: 3, fullName: "Velho Inativo", position: "driver", contractType: "permanent", isActive: 0, userId: null, photoUrl: null, role: null },
      ]];
      if (/FROM employee_accounts/.test(text)) return [[{ employeeId: 2, userId: 22 }]];
      if (/FROM employee_day_metrics/.test(text)) return [[
        { employeeId: 1, day: "2026-10-05", hoursWorked: 8, scheduledHours: 0, actions: 12, recolhas: 5, entregas: 4, movements: 3, parkingMoves: 1, cancels: 0, otherActions: 0, weightedActions: 0, speedingEvents: 0, delays: 1, lateServices: 0, complaints: 0, accidents: 0, incidentsReported: 2, incidentsAgainst: 0, penaltyPoints: 0, actionsByType: JSON.stringify({ CHECKING_IN: 6, CHECKING_OUT: 5, CREATED: 0 }) },
        { employeeId: 2, day: "2026-10-05", hoursWorked: 7, scheduledHours: 0, actions: 3, recolhas: 0, entregas: 0, movements: 0, parkingMoves: 0, cancels: 0, otherActions: 3, weightedActions: 0, speedingEvents: 0, delays: 0, lateServices: 0, complaints: 0, accidents: 0, incidentsReported: 0, incidentsAgainst: 0, penaltyPoints: 0, actionsByType: JSON.stringify({ CREATED: 2, UPDATE: 1 }) },
      ]];
      if (/FROM employee_metric_adjustments/.test(text)) return [[]];
      if (/FROM daily_driver_history/.test(text)) return [[]];
      if (/FROM driver_day_shares/.test(text)) return [[{ employeeId: 1, day: "2026-10-05", km: 84.4, maxSpeed: 131 }]];
      // chamadas atendidas pela conta extra da Bea, às 01h UTC de 6 out = 02h Lisboa → dia operacional 5 out
      if (/FROM whatsapp_calls/.test(text) && /answeredByUserId/.test(text)) return [[{ u: 22, h: "2026-10-06 01", n: 3 }]];
      if (/FROM mail_messages/.test(text)) return [[{ u: 12, h: "2026-10-05 10", n: 4 }]];
      // 37b: CRM por duas fontes (registo + junções) somam; perdidos e achados; fecho de mês de parceiros
      if (/FROM activity_logs/.test(text) && /crm_client/.test(text)) return [[{ u: 12, h: "2026-10-05 11", n: 2 }]];
      if (/FROM crm_merge_events/.test(text)) return [[{ u: 12, h: "2026-10-05 12", n: 1 }]];
      if (/FROM lost_found_messages/.test(text)) return [[{ u: 12, h: "2026-10-05 13", n: 1 }]];
      if (/FROM partner_month_closes/.test(text)) return [[{ u: 12, h: "2026-10-05 14", n: 2 }]];
      if (/FROM cash_day_review_log/.test(text)) throw new Error("tabela em falta");
      if (/FROM extras_dia_assignments/.test(text)) return [[]];
      return [[]];
    },
  }),
}));

describe("37a — juntar as fontes por pessoa", () => {
  it("condutores: Multipark pela avaliação, km e dias acima do limite pelo GPS; inativos sem nada ficam de fora", async () => {
    const { loadPeoplePerformance } = await import("./peoplePerformance");
    const r = await loadPeoplePerformance({ period: "week", anchor: "2026-10-06", group: "drivers" });
    expect(r.people.map((p) => p.name)).toEqual(["Ana Condutora"]);
    const ana = r.people[0];
    expect(ana.totals).toMatchObject({ hours: 8, recolhas: 5, entregas: 4, movements: 3, checkingIn: 6, checkingOut: 5, occurrences: 2, delays: 1, km: 84.4, gpsDays: 1, overLimitDays: 1, maxSpeed: 131 });
    expect(ana.series.recolhas).toEqual([5, 0, 0, 0, 0, 0, 0]);
    expect(r.speedLimit).toBe(100);
  });

  it("escritório: chamadas da conta extra, emails, reservas criadas/alteradas; fonte que falha fica dita", async () => {
    const { loadPeoplePerformance } = await import("./peoplePerformance");
    const r = await loadPeoplePerformance({ period: "week", anchor: "2026-10-06", group: "office" });
    expect(r.people.map((p) => p.name)).toEqual(["Bea Front"]);
    expect(r.people[0].totals).toMatchObject({ callsAnswered: 3, emails: 4, created: 2, updated: 1, hours: 7 });
    expect(r.people[0].series.callsAnswered).toEqual([3, 0, 0, 0, 0, 0, 0]); // dia operacional 5 out (segunda)
    expect(r.people[0].totals).toMatchObject({ crmUpdates: 3, lostFound: 1, partnerClosings: 2 });
    expect(r.people[0].points).toBe(3 * 2 + 4 * 2 + 2 * 3 + 1 + 3 * 1 + 1 * 2 + 2 * 3);
    expect(r.notes.join(" ")).toMatch(/Não deu para ler: .*correções de caixa/);
  });
});

describe("37a — só o super admin", () => {
  it("o servidor recusa outros papéis e o ecrã só mostra a aba ao super admin", () => {
    const r = src("server/evaluationRouter.ts");
    expect(r).toMatch(/peoplePerformance: protectedProcedure[\s\S]{0,400}if \(ctx\.user\.role !== "super_admin"\) throw new TRPCError\(\{ code: "FORBIDDEN"/);
    const p = src("client/src/pages/CondutoresAgentesPage.tsx");
    expect(p).toContain('const isSuper = (user as any).role === "super_admin";');
    expect(p).toContain('{isSuper && <TabsTrigger value="performance">');
    expect(p).toContain('{isSuper && <TabsContent value="performance"');
    // só leitura
    expect(src("server/peoplePerformance.ts")).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b\s+(INTO|\w+\s+SET|FROM)/);
  });
});

describe("37b — mais coisas no apanhado", () => {
  it("voos de regresso: alterações à reserva que mexem no voo, por agente e dia operacional; só leitura com parâmetros", async () => {
    const { buildReturnFlightsSql } = await import("./multiparkDb/perfReturnFlights");
    const q = buildReturnFlightsSql({ userIds: ["a1", "a1", "a2"], from: "2026-10-01 02:00:00", to: "2026-11-01 03:00:00" });
    expect(q.sql).toContain(`h."modifiedFields" ILIKE '%returnFlight%'`);
    expect(q.sql).toContain(`h."changeType"::text = 'UPDATE'`);
    expect(q.sql).not.toMatch(/\b(INSERT|DELETE)\b/);
    expect(q.params).toEqual(["a1", "a2", "2026-10-01 02:00:00", "2026-11-01 03:00:00", 50000]);
    expect(() => buildReturnFlightsSql({ userIds: [], from: "x", to: "y" })).toThrow(/Sem agentes/);
  });

  it("as novas métricas existem e entram nas abas do escritório, supervisão e team leaders", () => {
    for (const k of ["partnerAccounts", "partnerClosings", "extrasDia", "crmUpdates", "lostFound", "returnFlights"] as const) {
      expect(PERF_METRICS[k]).toBeTruthy();
    }
    expect(GROUP_VIEW.office.columns).toEqual(expect.arrayContaining(["returnFlights", "crmUpdates", "lostFound", "partnerAccounts", "partnerClosings"]));
    expect(GROUP_VIEW.supervision.columns).toEqual(expect.arrayContaining(["extrasDia", "partnerClosings", "crmUpdates", "lostFound"]));
    expect(GROUP_VIEW.teamleaders.columns).toEqual(expect.arrayContaining(["extrasDia", "returnFlights", "updated", "lostFound"]));
    const s = src("server/peoplePerformance.ts");
    expect(s).toContain("sql`partner_month_closes`, sql`closedBy`, sql`closedAt`");
    expect(s).toContain("sql`extras_dia_assignments`, sql`createdById`, sql`createdAt`");
  });
});

