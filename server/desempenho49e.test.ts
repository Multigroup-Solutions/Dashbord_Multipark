/**
 * Lote 49e — Desempenho (Jorge, 8 out 2026: "avança com o desempenho"):
 *  1. telefonemas da central: atendidas, feitas, perdidas, devolvidas e
 *     minutos, sem as internas (colegas/extensões) — exceto o supervisor a
 *     ligar aos extras;
 *  2. emails também da caixa Gmail pessoal ligada, sem contar duas vezes os
 *     enviados pela dashboard; as partilhadas fora da dashboard não têm autor;
 *  3. a atividade por hora do dia (Lisboa): a Multipark guardada pela
 *     avaliação diária (0590) + a dashboard agrupada por hora no SQL.
 */
import { readFileSync } from "node:fs";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { describe, expect, it, vi } from "vitest";
import {
  centralCallMetrics, emailAuthorOf, heatLevel, hourSpan, lisbonHourOfUtcHour, parseHours, CALLBACK_WINDOW_HOURS, GROUP_VIEW, PERF_METRICS,
} from "../shared/peoplePerformance";
import { operationalDayOf } from "../shared/lisbonDay";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const render = (q: any) => new MySqlDialect().sqlToQuery(q);

// ─── 1. Telefonemas da central ───────────────────────────────────────────────

describe("49e — chamadas da central no desempenho (regra das internas)", () => {
  it("recebidas: atendida conta (com os minutos), não atendida = perdida; internas nunca", () => {
    expect(centralCallMetrics({ direction: "in", held: true, contactRef: "crm-12", durationS: 180 })).toEqual({ callsAnswered: 1, callMinutes: 3 });
    expect(centralCallMetrics({ direction: "in", held: false, contactRef: "tel-351912345678", durationS: null })).toEqual({ callsMissed: 1 });
    expect(centralCallMetrics({ direction: "in", held: true, contactRef: null, durationS: 60 })).toEqual({ callsAnswered: 1, callMinutes: 1 });
    // colega do RH ou extensão: não conta (nem atendida, nem perdida)
    expect(centralCallMetrics({ direction: "in", held: true, contactRef: "emp-7", durationS: 120 })).toEqual({});
    expect(centralCallMetrics({ direction: "in", held: false, contactRef: "ext-410", durationS: null })).toEqual({});
    // um extra a ligar ao supervisor também não (só conta o supervisor a ligar)
    expect(centralCallMetrics({ direction: "in", held: true, contactRef: "emp-7", durationS: 60, callerIsSupervisor: true, otherIsExtra: true })).toEqual({});
  });

  it("feitas: contam as de fora; das internas só o supervisor a ligar a um extra; devolução só de fora", () => {
    expect(centralCallMetrics({ direction: "out", held: true, contactRef: "crm-5", durationS: 240 })).toEqual({ callsMade: 1, callMinutes: 4 });
    expect(centralCallMetrics({ direction: "out", held: true, contactRef: "tel-351911111111", durationS: 60, returnsMissed: true })).toEqual({ callsMade: 1, callMinutes: 1, callbacks: 1 });
    expect(centralCallMetrics({ direction: "out", held: true, contactRef: "emp-9", durationS: 60 })).toEqual({});
    expect(centralCallMetrics({ direction: "out", held: true, contactRef: "emp-9", durationS: 60, callerIsSupervisor: true, otherIsExtra: false })).toEqual({});
    expect(centralCallMetrics({ direction: "out", held: true, contactRef: "emp-9", durationS: 60, callerIsSupervisor: false, otherIsExtra: true })).toEqual({});
    expect(centralCallMetrics({ direction: "out", held: true, contactRef: "emp-9", durationS: 60, callerIsSupervisor: true, otherIsExtra: true, returnsMissed: true }))
      .toEqual({ callsMade: 1, callMinutes: 1 });
    expect(centralCallMetrics({ direction: "out", held: true, contactRef: "ext-410", durationS: 60, callerIsSupervisor: true, otherIsExtra: true })).toEqual({});
  });

  it("o SQL do desempenho faz o mesmo: perdidas, devolvidas e minutos, todas sem as internas", async () => {
    const { userSources } = await import("./peoplePerformance");
    const all = userSources("2026-10-05 02:00:00", "2026-10-12 02:00:00");
    const central = all.filter((s) => /FROM central_calls/.test(render(s.q).sql));
    expect(central.map((s) => s.key)).toEqual(["callsAnswered", "callsMade", "callsMissed", "callbacks", "callMinutes"]);
    for (const s of central) expect(render(s.q).sql).toContain("contactRef NOT LIKE 'emp-%' AND contactRef NOT LIKE 'ext-%'");
    const by = (label: string) => { const s = all.find((x) => x.label === label)!; return { ...s, sql: render(s.q).sql, params: render(s.q).params }; };
    const missed = by("chamadas da central (perdidas)");
    expect(missed.sql).toContain("direction = 'in' AND held = 0 AND (contactRef IS NULL OR");
    expect(missed.hourly).toBe(false); // uma perdida não é uma ação da pessoa
    const back = by("chamadas da central (devolvidas)");
    expect(back.sql).toContain("FROM central_calls m WHERE m.direction = 'in' AND m.held = 0");
    expect(back.sql).toContain(`m.startedAt >= central_calls.startedAt - INTERVAL ${CALLBACK_WINDOW_HOURS} HOUR`);
    expect(back.sql).toContain("RIGHT(m.phone, 9) = RIGHT(central_calls.phone, 9)");
    expect(back.sql).toContain("m.contactRef IS NOT NULL AND m.contactRef = central_calls.contactRef");
    // só a 1.ª chamada feita depois da perdida é devolução
    expect(back.sql).toContain("NOT EXISTS (SELECT 1 FROM central_calls o WHERE o.direction = 'out' AND o.startedAt > m.startedAt AND o.startedAt < central_calls.startedAt");
    expect(back.hourly).toBe(false); // já conta como chamada feita
    const mins = by("minutos da central");
    expect(mins.sql).toContain("SUM(COALESCE(durationS, 0)) / 60 AS n");
    expect(mins.sql).toContain("su.role = 'supervisor'"); // o supervisor a ligar aos extras também conta o tempo
    expect(mins.hourly).toBe(false);
    expect(GROUP_VIEW.office.columns).toEqual(expect.arrayContaining(["callsMissed", "callbacks", "callMinutes"]));
    expect(PERF_METRICS.callsMissed.bad).toBe(true);
    // sem peso nos pontos (o Jorge decide)
    for (const g of Object.values(GROUP_VIEW)) { expect(g.weights.callsMissed).toBeUndefined(); expect(g.weights.callMinutes).toBeUndefined(); }
  });
});

// ─── 2. Emails ───────────────────────────────────────────────────────────────

describe("49e — emails: dashboard + caixa Gmail pessoal, cada um uma vez", () => {
  const row = (o: Partial<Parameters<typeof emailAuthorOf>[0]>) => ({ direction: "out", automated: 0, sentById: null, accountKey: null, mailboxKey: null, ...o });
  it("de quem é cada email enviado", () => {
    expect(emailAuthorOf(row({ sentById: 12, accountKey: "dwd:reservas@multipark.pt", mailboxKey: "reservas" }))).toBe(12); // dashboard, caixa partilhada
    expect(emailAuthorOf(row({ sentById: 12, accountKey: "user:12" }))).toBe(12); // dashboard, a própria caixa
    expect(emailAuthorOf(row({ accountKey: "user:12" }))).toBe(12); // Gmail pessoal, fora da dashboard
    expect(emailAuthorOf(row({ accountKey: "user:12", mailboxKey: "reservas" }))).toBeNull(); // pela conta dele mas de uma caixa partilhada
    expect(emailAuthorOf(row({ accountKey: "dwd:info@multipark.pt", mailboxKey: "info" }))).toBeNull(); // partilhada fora da dashboard: sem autor
    expect(emailAuthorOf(row({ accountKey: "user:12", direction: "in" }))).toBeNull();
    expect(emailAuthorOf(row({ accountKey: "user:12", automated: 3 }))).toBeNull();
  });

  it("um email enviado pela dashboard da caixa pessoal não conta duas vezes (é uma só linha, com autor)", () => {
    const rows = [
      row({ sentById: 12, accountKey: "user:12" }), // enviado pela dashboard (gravado logo, com autor)
      row({ accountKey: "user:12" }), // enviado no Gmail (chega pela sincronização)
      row({ sentById: 12, accountKey: "dwd:reservas@multipark.pt", mailboxKey: "reservas" }),
      row({ accountKey: "dwd:info@multipark.pt", mailboxKey: "info" }),
      row({ accountKey: "user:30" }), // de outra pessoa
    ];
    const by = new Map<number, number>();
    for (const r of rows) { const u = emailAuthorOf(r); if (u != null) by.set(u, (by.get(u) ?? 0) + 1); }
    expect(Object.fromEntries(by)).toEqual({ 12: 3, 30: 1 });
  });

  it("o SQL usa a mesma regra (COALESCE: o autor da dashboard primeiro) e o índice de sentAt", async () => {
    const { userSources } = await import("./peoplePerformance");
    const s = userSources("2026-10-05 02:00:00", "2026-10-12 02:00:00").find((x) => x.key === "emails")!;
    const { sql, params } = render(s.q);
    expect(sql).toContain("SELECT COALESCE(sentById, CASE WHEN mailboxKey IS NULL AND accountKey LIKE 'user:%' THEN CAST(SUBSTRING(accountKey, 6) AS UNSIGNED) END) AS u");
    expect(sql).toContain("FROM mail_messages");
    expect(sql).toContain("sentAt >= ? AND sentAt < ? AND direction = 'out' AND automated = 0");
    expect(params).toEqual(["2026-10-05 02:00:00", "2026-10-12 02:00:00"]);
    const c = src("client/src/components/people/PeoplePerformancePanel.tsx");
    expect(c).toContain("Os enviados diretamente das caixas partilhadas (info@, reservas@…) fora da dashboard não têm autor e não contam.");
  });
});

// ─── 3. Atividade por hora ───────────────────────────────────────────────────

describe("49e — hora de Lisboa (regras puras)", () => {
  it("a hora UTC agrupada no SQL → hora de relógio de Lisboa (verão, inverno e as duas mudanças de hora)", () => {
    expect(lisbonHourOfUtcHour("2026-10-06 00")).toBe(1); // verão (+1)
    expect(lisbonHourOfUtcHour("2026-11-02 01")).toBe(1); // inverno (+0)
    expect(lisbonHourOfUtcHour("2026-10-25 00")).toBe(1); // 25 out: 01h de verão…
    expect(lisbonHourOfUtcHour("2026-10-25 01")).toBe(1); // …e outra vez 01h, já de inverno
    expect(lisbonHourOfUtcHour("2026-03-29 00")).toBe(0);
    expect(lisbonHourOfUtcHour("2026-03-29 01")).toBe(2); // 29 mar: salta das 01h para as 02h
    expect(lisbonHourOfUtcHour("lixo")).toBeNull();
  });

  it("o dia que passa a meia-noite: 00h–02h de Lisboa ainda são do dia operacional anterior", () => {
    expect(operationalDayOf(Date.parse("2026-10-05T23:30:00Z"))).toBe("2026-10-05"); // 00h30 de 6 out
    expect(lisbonHourOfUtcHour("2026-10-05 23")).toBe(0);
    expect(operationalDayOf(Date.parse("2026-10-06T02:00:00Z"))).toBe("2026-10-06"); // 03h de 6 out
  });

  it("nível da cor, horas da avaliação e o intervalo de trabalho (pela ordem do dia operacional)", () => {
    expect([heatLevel(0, 10), heatLevel(1, 10), heatLevel(5, 10), heatLevel(10, 10), heatLevel(3, 0)]).toEqual([0, 1, 3, 5, 0]);
    const h = new Array(24).fill(0);
    expect(parseHours(JSON.stringify(h))).toEqual(h);
    expect(parseHours("[1,2]")).toBeNull();
    expect(parseHours(null)).toBeNull();
    expect(parseHours("nada")).toBeNull();
    const night = new Array(24).fill(0);
    for (const x of [15, 16, 20, 23, 0, 2]) night[x] = 1;
    night[20] = 5;
    expect(hourSpan(night)).toEqual({ first: 15, last: 2, peak: 20 }); // a noite: 15h → 2h, não 0h → 23h
    expect(hourSpan(new Array(24).fill(0))).toEqual({ first: null, last: null, peak: null });
  });
});

describe("49e — a avaliação diária guarda a Multipark por hora (a mesma leitura)", () => {
  it("a leitura agregada da History traz a hora de Lisboa e agrupa por ela", async () => {
    const { buildEngineActionCountsSql, mapEngineActionCountRow } = await import("./multiparkDb/movements");
    const { sql } = buildEngineActionCountsSql({ lookbackFrom: "2026-10-02 02:00:00", from: "2026-10-05 02:00:00", to: "2026-10-12 02:00:00" });
    expect(sql).toContain(`(extract(hour from ((x.at) AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Lisbon'))::int AS hour`);
    expect(sql).toContain("GROUP BY x.user_id, 3, 4, x.ct, 6");
    expect(sql).toMatch(/^WITH h AS/);
    expect(mapEngineActionCountRow({ user_id: "u1", day: "2026-10-05", shift: "night", change_type: "check_in", hour: "23", n: 2 }).hour).toBe(23);
    expect(mapEngineActionCountRow({ user_id: "u1", day: "2026-10-05", shift: "night", change_type: "check_in", hour: null, n: 2 })).not.toHaveProperty("hour");
    expect(mapEngineActionCountRow({ user_id: "u1", day: "2026-10-05", shift: "night", change_type: "check_in", hour: 24, n: 2 })).not.toHaveProperty("hour");
  });

  it("o motor soma as ações por hora de cada pessoa (contagens vivas e linhas soltas da cópia)", async () => {
    const { actionRowsToCounts, computeEmployeeDays } = await import("./evaluationCore");
    const { buildEvaluationIdentity } = await import("./evaluationIdentity");
    const identity = buildEvaluationIdentity({
      employees: [{ id: 1, fullName: "Gelson Manuel Leão Sousa", userId: 10, multiparkAgentName: null, multiparkAgentUserId: "mp-1" }],
      agentAliases: [], accountAliases: [],
    });
    const base = {
      startDay: "2026-09-24", endDay: "2026-09-24", identity,
      employees: new Map([[1, { id: 1, position: "extra", contractType: "extra", extraLevel: 1, monthlySalary: null, projectId: 48 }]]),
      actions: [] as any[], ponto: [], assignments: [], incidents: [], complaints: [], speedAlerts: [], penalties: [],
      rate: () => 10, tlWorkingDaysPerMonth: 15,
    };
    const live = computeEmployeeDays({ ...base, actionCounts: [
      { agentUserId: "mp-1", agentName: "Gelson Sousa", day: "2026-09-24", shift: "night", changeType: "CHECK_IN", hour: 22, n: 3, parkingMoves: 0, lateDeliveries: 0 },
      { agentUserId: "mp-1", agentName: "Gelson Sousa", day: "2026-09-24", shift: "night", changeType: "MOVEMENT", hour: 1, n: 2, parkingMoves: 0, lateDeliveries: 0 }, // 01h do dia 25 = noite do 24
      { agentUserId: "mp-1", agentName: "Gelson Sousa", day: "2026-09-24", shift: "morning", changeType: "UPDATE", n: 1, parkingMoves: 0, lateDeliveries: 0 }, // sem hora
    ] });
    const h = live.rows[0].actionsByHour!;
    expect(h).toHaveLength(24);
    expect([h[22], h[1]]).toEqual([3, 2]);
    expect(h.reduce((a, b) => a + b, 0)).toBe(5);
    expect(live.rows[0].metrics.actions).toBe(6); // as ações contam todas; só a "sem hora" fica fora das horas
    // a cópia local (linhas soltas) dá as mesmas horas de Lisboa
    const counts = actionRowsToCounts([
      { bookingExternalId: "B1", changeType: "CHECK_IN", actionTime: "2026-09-24 21:10:00", agentUserId: "mp-1", agentName: "Gelson Sousa" }, // 22h10 Lisboa
      { bookingExternalId: "B2", changeType: "MOVEMENT", actionTime: "2026-09-25 00:30:00", agentUserId: "mp-1", agentName: "Gelson Sousa" }, // 01h30 de 25 → dia 24
    ]);
    expect(counts.map((c) => [c.day, c.hour])).toEqual([["2026-09-24", 22], ["2026-09-24", 1]]);
    const copy = computeEmployeeDays({ ...base, actionCounts: counts });
    expect(copy.rows[0].actionsByHour![22]).toBe(1);
    expect(copy.rows[0].actionsByHour![1]).toBe(1);
  });

  it("grava a coluna nova (migração 0590, registada depois da 0575) — só quando há ações", async () => {
    const e = src("server/evaluationEngine.ts");
    expect(e).toContain(`actionsByHour: r.actionsByHour && r.actionsByHour.some((n) => n > 0) ? JSON.stringify(r.actionsByHour) : null,`);
    expect(e).toMatch(/UPSERT_COLUMNS = \[[\s\S]*"actionsByHour"/);
    expect(src("drizzle/schema.ts")).toContain("actionsByHour: varchar({ length: 255 }),");
    const { SCHEMA_MIGRATION_IDS } = await import("./migrations/index");
    expect(SCHEMA_MIGRATION_IDS.indexOf("0590")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0575"));
    const m = await import("./migrations/migration_0590");
    expect(m.MIGRATION_0590_STATEMENTS).toEqual(["ALTER TABLE `employee_day_metrics` ADD COLUMN `actionsByHour` VARCHAR(255) NULL AFTER `actionsByType`"]);
    expect(m.IDEMPOTENT_ERROR_CODES_0590.has("ER_DUP_FIELDNAME")).toBe(true);
  });
});

// ─── Juntar no desempenho (BD simulada) ──────────────────────────────────────
const h = vi.hoisted(() => ({ texts: [] as string[] }));
vi.mock("./dayActivity", () => ({ speedThreshold: async () => 100 }));
vi.mock("./db", () => ({
  getDb: async () => ({
    execute: async (q: any) => {
      const flat = (c: any): string => (c?.queryChunks ? c.queryChunks.map(flat).join("") : Array.isArray(c?.value) ? c.value.join("") : typeof c === "string" ? c : "");
      const text = flat(q);
      h.texts.push(text);
      if (/FROM employees e LEFT JOIN users/.test(text)) return [[
        { id: 2, fullName: "Bea Front", position: "frontoffice", contractType: "permanent", isActive: 1, userId: 12, photoUrl: null, role: "frontoffice" },
      ]];
      if (/SELECT MIN\(day\) AS d FROM employee_day_metrics/.test(text)) return [[{ d: "2026-10-05" }]];
      if (/FROM employee_day_metrics/.test(text)) {
        const hrs = new Array(24).fill(0); hrs[10] = 2; hrs[23] = 1;
        const m = (day: string, actions: number, actionsByHour: string | null) => ({ employeeId: 2, day, hoursWorked: 7, scheduledHours: 0, actions, recolhas: 0, entregas: 0, movements: 0, parkingMoves: 0, cancels: 0,
          otherActions: actions, weightedActions: 0, speedingEvents: 0, delays: 0, lateServices: 0, complaints: 0, accidents: 0, incidentsReported: 0, incidentsAgainst: 0, penaltyPoints: 0,
          actionsByType: JSON.stringify({ CREATED: actions }), actionsByHour });
        return [[m("2026-10-05", 3, JSON.stringify(hrs)), m("2026-10-06", 3, null)]];
      }
      if (/FROM central_calls/.test(text)) {
        if (/SUM\(COALESCE\(durationS/.test(text)) return [[{ u: 12, h: "2026-10-05 14", n: "7.5000" }]];
        if (/FROM central_calls m/.test(text)) return [[{ u: 12, h: "2026-10-05 16", n: 1 }]];
        if (/held = 0/.test(text)) return [[{ u: 12, h: "2026-10-05 15", n: 2 }]];
        if (/direction = 'in' AND held = 1/.test(text)) return [[{ u: 12, h: "2026-10-05 14", n: 3 }]];
        if (/direction = 'out'/.test(text)) return [[{ u: 12, h: "2026-10-05 16", n: 1 }]];
      }
      if (/FROM whatsapp_messages/.test(text)) return [[
        { u: 12, h: "2026-10-05 23", n: 4 }, // 00h de 6 out em Lisboa → dia operacional 5, hora 0
        { u: 12, h: "2026-10-05 01", n: 9 }, // 02h de 5 out → dia operacional 4: fora da semana
      ]];
      if (/FROM mail_messages/.test(text)) return [[{ u: 12, h: "2026-10-05 09", n: 2 }]];
      return [[]];
    },
  }),
}));

describe("49e — o desempenho junta tudo (BD simulada)", () => {
  it("chamadas (atendidas, feitas, perdidas, devolvidas, minutos), emails e as ações por hora de Lisboa", async () => {
    const { loadPeoplePerformance } = await import("./peoplePerformance");
    const r = await loadPeoplePerformance({ period: "week", anchor: "2026-10-06", group: "office" });
    expect(r.people.map((p) => p.name)).toEqual(["Bea Front"]);
    const bea = r.people[0];
    expect(bea.totals).toMatchObject({ callsAnswered: 3, callsMade: 1, callsMissed: 2, callbacks: 1, callMinutes: 8, emails: 2, waMessages: 4 });
    // por hora: WhatsApp às 0h, email às 10h, atendidas às 15h, feita às 17h (perdidas, devolvidas e minutos não);
    // Multipark (avaliação): 2 às 10h e 1 às 23h; a mensagem do dia 4 fica fora
    const expected = new Array(24).fill(0);
    expected[0] = 4; expected[10] = 4; expected[15] = 3; expected[17] = 1; expected[23] = 1;
    expect(bea.byHour).toEqual(expected);
    const mp = new Array(24).fill(0); mp[10] = 2; mp[23] = 1;
    expect(bea.byHourMultipark).toEqual(mp);
    expect(r.groupByHour).toEqual(expected);
    expect(r.groupByHourMultipark).toEqual(mp);
    // por hora desde 5 out; o dia 6 tem ações na Multipark mas ainda sem horas
    expect(r.hourly).toEqual({ since: "2026-10-05", missingDays: 1 });
    expect(h.texts.some((t) => /SELECT MIN\(day\) AS d FROM employee_day_metrics WHERE day >= .* AND day <= .* AND actionsByHour IS NOT NULL/.test(t))).toBe(true);
  });
});

// ─── Ecrã e ajuda ────────────────────────────────────────────────────────────

describe("49e — ecrã", () => {
  const c = src("client/src/components/people/PeoplePerformancePanel.tsx");
  const hrs = src("client/src/components/people/PerformanceHours.tsx");
  const css = src("client/src/index.css");
  it("grelha pessoa × hora na aba e barras 0–23 h no detalhe, com a tabela como alternativa", () => {
    expect(c).toContain("<HourHeatmap people={ranked}");
    expect(c).toContain("<HourBars byHour={p.byHour ?? []}");
    expect(hrs).toContain(`<Bar dataKey="total" name="Ações" fill="var(--perf-1)" radius={[4, 4, 0, 0]} maxBarSize={24}`);
    expect(hrs.match(/Ver em tabela/g)?.length).toBeGreaterThanOrEqual(2);
    expect(hrs).toContain("A Multipark por hora só existe desde");
  });
  it("uma só cor sequencial, com passos próprios no claro e no escuro", () => {
    const light = css.slice(css.indexOf(".perf-viz {"), css.indexOf(".dark .perf-viz {"));
    const dark = css.slice(css.indexOf(".dark .perf-viz {"));
    for (const k of [0, 1, 2, 3, 4, 5]) { expect(light).toContain(`--perf-heat-${k}:`); expect(dark).toContain(`--perf-heat-${k}:`); }
    expect(light).toContain("--perf-heat-1: #86b6ef;");
    expect(dark).toContain("--perf-heat-5: #9ec5f4;");
  });
  it("a ajuda explica as chamadas, os emails e a atividade por hora", () => {
    const d = src("docs/ajuda/condutores-agentes.md");
    expect(d).toContain("Atividade por hora do dia");
    expect(d).toContain("caixa Gmail pessoal");
    expect(d).not.toContain("Os emails mandados diretamente no Gmail ainda não têm autor.");
  });
});
