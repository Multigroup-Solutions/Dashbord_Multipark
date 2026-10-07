// Tarefas — filtros e estado da reserva (pedido 5), Jorge 7 out 2026: "Nas tarefas
// 'as minhas tarefas' deve estar filtrado por estado da reserva …".
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BOOKING_STATUS_UNKNOWN,
  EMPTY_TASK_FILTERS,
  TASK_BOOKING_FILTERS,
  activeTaskFilterCount,
  bookingStatusChip,
  bookingStatusKey,
  clearTaskFilters,
  dueDayRanges,
  dueWindows,
  normalizeTaskFilters,
  patchTaskFilters,
  taskBookingRef,
  taskDueBuckets,
  taskDueDay,
  taskFacetCounts,
  taskFiltersForServer,
  taskFiltersStorageKey,
  taskMatchesFacets,
  toggleTaskFilter,
  type TaskFilterRow,
  type TaskFilters,
} from "../shared/taskFilters";
import { BOOKING_STATUSES, BOOKING_STATUS_COLORS } from "../shared/reservasDoDia";
import { TASK_SOURCE_LABELS, taskSourceLink } from "../shared/taskRules";
import { SCHEMA_MIGRATION_IDS } from "./migrations";
import { IDEMPOTENT_ERROR_CODES_0545, MIGRATION_0545_STATEMENTS, runMigration0545Collation } from "./migrations/migration_0545";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// Quarta 7 out 2026, 10:00 UTC = 11:00 em Lisboa (verão, +1). Semana: seg 5 → dom 11.
const NOW = Date.UTC(2026, 9, 7, 10, 0, 0);
const f = (patch: Partial<TaskFilters>): TaskFilters => patchTaskFilters(clearTaskFilters(), patch);
const row = (p: Partial<TaskFilterRow> = {}): TaskFilterRow => ({
  sourceModule: "manual", taskStatus: "todo", taskPriority: "medium", dueDate: null, dueHasTime: 0, bookingRef: null, bookingStatus: null, ...p,
});

describe("estado dos filtros", () => {
  it("normaliza o que vem guardado: valores desconhecidos caem, ordem canónica, sem repetidos", () => {
    expect(normalizeTaskFilters(null)).toEqual(EMPTY_TASK_FILTERS);
    expect(normalizeTaskFilters("lixo")).toEqual(EMPTY_TASK_FILTERS);
    const n = normalizeTaskFilters({
      sources: ["service", "xpto", "lead", "service"], statuses: ["done", "todo"], priorities: ["urgent", 3],
      due: ["week", "overdue", "ontem"], bookingStatuses: ["CANCELLED", "UNKNOWN", "cancelled"],
      assignee: "12", projectId: -4, q: "x".repeat(500),
    });
    expect(n.sources).toEqual(["service", "lead"]);
    expect(n.statuses).toEqual(["todo", "done"]);
    expect(n.priorities).toEqual(["urgent"]);
    expect(n.due).toEqual(["overdue", "week"]);
    expect(n.bookingStatuses).toEqual(["CANCELLED", BOOKING_STATUS_UNKNOWN]);
    expect(n.assignee).toBe(12);
    expect(n.projectId).toBeNull();
    expect(n.q).toHaveLength(120);
    expect(normalizeTaskFilters({ assignee: "none" }).assignee).toBe("none");
    expect(normalizeTaskFilters({ assignee: 0 }).assignee).toBeNull();
  });
  it("alternar liga e desliga; limpar volta ao vazio; contar filtros ativos", () => {
    let s = toggleTaskFilter(clearTaskFilters(), "sources", "lead");
    s = toggleTaskFilter(s, "sources", "service");
    expect(s.sources).toEqual(["service", "lead"]);
    s = toggleTaskFilter(s, "sources", "lead");
    expect(s.sources).toEqual(["service"]);
    s = patchTaskFilters(s, { due: ["today"], assignee: "none", projectId: 3, q: "  chaves " });
    expect(activeTaskFilterCount(s)).toBe(5);
    expect(activeTaskFilterCount(s, { ignoreAssignee: true })).toBe(4);
    expect(clearTaskFilters()).toEqual(EMPTY_TASK_FILTERS);
    expect(activeTaskFilterCount(clearTaskFilters())).toBe(0);
  });
  it("para o servidor: só o ativo; centro e responsável nos campos de topo; 'As minhas' sem responsável", () => {
    expect(taskFiltersForServer(clearTaskFilters())).toEqual({});
    const s = f({ sources: ["service"], bookingStatuses: ["CHECKED_IN"], assignee: 7, projectId: 2, q: " #12 " });
    expect(taskFiltersForServer(s)).toEqual({ projectId: 2, assigneeId: 7, filters: { sources: ["service"], bookingStatuses: ["CHECKED_IN"], q: "#12" } });
    expect(taskFiltersForServer(s, { mine: true })).toEqual({ projectId: 2, filters: { sources: ["service"], bookingStatuses: ["CHECKED_IN"], q: "#12" } });
    expect(taskFiltersForServer(f({ assignee: "none" }))).toEqual({ unassigned: true });
  });
  it("guardados por utilizador", () => {
    expect(taskFiltersStorageKey(42)).toBe("mp.tasks.filters.v1.u42");
    expect(taskFiltersStorageKey(42)).not.toBe(taskFiltersStorageKey(43));
  });
});

describe("estado da reserva (9 estados Multipark, sem agrupar)", () => {
  it("chips com os rótulos e as cores de reservasDoDia; desconhecido cai para o texto em bruto", () => {
    expect(TASK_BOOKING_FILTERS).toEqual([...BOOKING_STATUSES, "UNKNOWN"]);
    expect(bookingStatusChip("CHECKED_IN")).toEqual({ label: "Estacionada", className: BOOKING_STATUS_COLORS.CHECKED_IN, known: true });
    expect(bookingStatusKey(" checked_out ")).toBe("CHECKED_OUT");
    expect(bookingStatusChip("ON_HOLD")).toMatchObject({ label: "ON_HOLD", known: false });
    expect(bookingStatusChip(null)).toMatchObject({ label: "Sem estado", known: false });
    expect(bookingStatusKey("ON_HOLD")).toBe(BOOKING_STATUS_UNKNOWN);
  });
  it("reserva da tarefa a partir da origem (igual ao backfill da 0545)", () => {
    expect(taskBookingRef("service", "svc:abc-123:line9")).toBe("abc-123");
    expect(taskBookingRef("service", "svc:abc:line9#dup77")).toBe("abc");
    expect(taskBookingRef("service", "svc:abc")).toBeNull();
    expect(taskBookingRef("manual", "svc:abc:line")).toBeNull();
    expect(taskBookingRef("lead", "lead:4")).toBeNull();
  });
  it("só conta para tarefas ligadas a uma reserva (também 'Sem estado')", () => {
    const s = f({ bookingStatuses: ["CHECKED_IN", BOOKING_STATUS_UNKNOWN] });
    expect(taskMatchesFacets(row({ sourceModule: "service", bookingRef: "b1", bookingStatus: "CHECKED_IN" }), s, NOW)).toBe(true);
    expect(taskMatchesFacets(row({ sourceModule: "service", bookingRef: "b2", bookingStatus: null }), s, NOW)).toBe(true);
    expect(taskMatchesFacets(row({ sourceModule: "service", bookingRef: "b3", bookingStatus: "BOOKED" }), s, NOW)).toBe(false);
    // Uma tarefa manual (sem reserva) nunca passa num filtro de estado da reserva.
    expect(taskMatchesFacets(row({ sourceModule: "manual" }), s, NOW)).toBe(false);
    expect(taskMatchesFacets(row({ sourceModule: "manual" }), f({ bookingStatuses: [BOOKING_STATUS_UNKNOWN] }), NOW)).toBe(false);
  });
});

describe("prazo (calendário de Lisboa)", () => {
  it("janelas: hoje, amanhã e a semana de segunda a domingo", () => {
    expect(dueWindows(NOW)).toEqual({ today: "2026-10-07", tomorrow: "2026-10-08", weekStart: "2026-10-05", weekEnd: "2026-10-11" });
  });
  it("classifica cada tarefa (pode estar em mais de uma opção)", () => {
    expect(taskDueBuckets(row(), NOW)).toEqual(["none"]);
    expect(taskDueBuckets(row({ dueDate: "2026-10-07 00:00:00" }), NOW)).toEqual(["today", "week"]);
    expect(taskDueBuckets(row({ dueDate: "2026-10-06 00:00:00" }), NOW)).toEqual(["overdue", "week"]);
    expect(taskDueBuckets(row({ dueDate: "2026-10-06 00:00:00", taskStatus: "done" }), NOW)).toEqual(["week"]);
    expect(taskDueBuckets(row({ dueDate: "2026-10-08 00:00:00" }), NOW)).toEqual(["tomorrow", "week"]);
    expect(taskDueBuckets(row({ dueDate: "2026-10-12 00:00:00" }), NOW)).toEqual([]);
    // Com hora: 09:00 UTC (10h em Lisboa) já passou → em atraso e de hoje.
    expect(taskDueBuckets(row({ dueDate: "2026-10-07 09:00:00", dueHasTime: 1 }), NOW)).toEqual(["overdue", "today", "week"]);
    // 23:30 UTC = 00:30 de dia 8 em Lisboa → amanhã (o dia de Lisboa, não o UTC).
    expect(taskDueDay(row({ dueDate: "2026-10-07 23:30:00", dueHasTime: 1 }))).toBe("2026-10-08");
    expect(taskDueBuckets(row({ dueDate: "2026-10-07 23:30:00", dueHasTime: 1 }), NOW)).toEqual(["tomorrow", "week"]);
  });
  it("as janelas do SQL têm as mesmas fronteiras (também na mudança de hora)", () => {
    const r = dueDayRanges(NOW);
    expect(r.today).toEqual({ fromDay: "2026-10-07", toDay: "2026-10-07", fromUtc: "2026-10-06 23:00:00", toUtcExcl: "2026-10-07 23:00:00" });
    expect(r.week).toMatchObject({ fromDay: "2026-10-05", toDay: "2026-10-11", fromUtc: "2026-10-04 23:00:00", toUtcExcl: "2026-10-11 23:00:00" });
    // Semana da mudança de hora (dom 25 out): a meia-noite de 26 já é 00:00 UTC.
    const dst = dueDayRanges(Date.UTC(2026, 9, 21, 12));
    expect(dst.week).toMatchObject({ fromUtc: "2026-10-18 23:00:00", toUtcExcl: "2026-10-26 00:00:00" });
    // Propriedade: uma tarefa com hora entra em "hoje" sse o instante está na janela do SQL.
    for (let h = -30; h <= 54; h++) {
      const at = NOW + h * 3_600_000;
      const due = new Date(at).toISOString().slice(0, 19).replace("T", " ");
      const inJs = taskDueBuckets(row({ dueDate: due, dueHasTime: 1 }), NOW).includes("today");
      const inSql = due >= r.today.fromUtc && due < r.today.toUtcExcl;
      expect(inJs).toBe(inSql);
    }
  });
});

describe("combinações e contadores", () => {
  const rows: TaskFilterRow[] = [
    row({ sourceModule: "service", taskPriority: "high", bookingRef: "b1", bookingStatus: "CHECKED_IN", dueDate: "2026-10-07 00:00:00" }),
    row({ sourceModule: "service", taskPriority: "high", bookingRef: "b2", bookingStatus: "CANCELLED", taskStatus: "done" }),
    row({ sourceModule: "lead", dueDate: "2026-10-06 12:00:00", dueHasTime: 1 }),
    row({ sourceModule: null, taskStatus: "in_progress" }),
  ];
  it("E entre facetas, OU dentro de cada uma; sem origem conta como Manual", () => {
    expect(rows.filter((t) => taskMatchesFacets(t, f({ sources: ["service", "lead"] }), NOW))).toHaveLength(3);
    expect(rows.filter((t) => taskMatchesFacets(t, f({ sources: ["service"], statuses: ["todo"] }), NOW))).toHaveLength(1);
    expect(rows.filter((t) => taskMatchesFacets(t, f({ sources: ["manual"] }), NOW))).toHaveLength(1);
    expect(rows.filter((t) => taskMatchesFacets(t, f({ due: ["overdue", "none"] }), NOW))).toHaveLength(3);
    expect(rows.filter((t) => taskMatchesFacets(t, f({ priorities: ["high"], bookingStatuses: ["CANCELLED"] }), NOW))).toHaveLength(1);
    expect(rows.filter((t) => taskMatchesFacets(t, clearTaskFilters(), NOW))).toHaveLength(4);
  });
  it("cada faceta conta com as OUTRAS aplicadas; todas as opções aparecem", () => {
    const c = taskFacetCounts(rows, f({ sources: ["service"] }), NOW);
    // A própria faceta "origem" ignora-se a si mesma (diz quantas aparecem se se juntar a opção).
    expect(c.sources).toMatchObject({ service: 2, lead: 1, manual: 1, template: 0 });
    // As outras contam só dentro de "Serviço da reserva".
    expect(c.statuses).toMatchObject({ todo: 1, done: 1, in_progress: 0 });
    expect(c.bookingStatuses).toMatchObject({ CHECKED_IN: 1, CANCELLED: 1, BOOKED: 0, UNKNOWN: 0 });
    expect(c.due).toMatchObject({ today: 1, week: 1, none: 1, overdue: 0 });
    expect(Object.keys(c.bookingStatuses)).toHaveLength(10);
  });
});

describe("origem 'Candidatura de condutor'", () => {
  it("rótulo e link para o lead", () => {
    expect(TASK_SOURCE_LABELS.lead).toBe("Candidatura de condutor");
    expect(taskSourceLink("lead", 15, "lead:15")).toBe("/extras-leads?lead=15");
    expect(taskSourceLink("lead", null, null)).toBe("/extras-leads");
  });
});

describe("0545: bookingRef + chave única das candidaturas", () => {
  it("registada no fim, idempotente, só acrescenta; backfill só das que não a têm", () => {
    expect(SCHEMA_MIGRATION_IDS.indexOf("0545")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0525"));
    expect([...IDEMPOTENT_ERROR_CODES_0545].sort()).toEqual(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
    expect(MIGRATION_0545_STATEMENTS.join("\n")).not.toMatch(/DROP|DELETE/i);
    const backfill = MIGRATION_0545_STATEMENTS.find((s) => s.startsWith("UPDATE"))!;
    expect(backfill).toContain("`bookingRef` IS NULL");
    expect(backfill).toContain("`sourceModule` = 'service'");
    expect(MIGRATION_0545_STATEMENTS.some((s) => s.includes("UNIQUE INDEX `uq_tasks_lead_source_key`"))).toBe(true);
    expect(src("drizzle/schema.ts")).toContain("leadSourceKey: varchar({ length: 128 }).generatedAlwaysAs(");
  });
  it("collation: bookingRef fica igual à de multipark_bookings.externalId (só quando difere)", async () => {
    const run = async (taskColl: string) => {
      let calls = 0;
      const db = {
        execute: async () => {
          calls++;
          return calls === 1 ? [[{ t: "multipark_bookings", cs: "utf8mb4", coll: "utf8mb4_0900_ai_ci" }, { t: "tasks", cs: "utf8mb4", coll: taskColl }]] : [];
        },
      };
      return { changed: await runMigration0545Collation(db), calls };
    };
    expect(await run("utf8mb4_0900_ai_ci")).toEqual({ changed: false, calls: 1 });
    expect(await run("utf8mb4_unicode_ci")).toEqual({ changed: true, calls: 2 });
  });
  it("as tarefas de serviço gravam a reserva ao nascer; a lista junta o estado da reserva", () => {
    expect(src("server/serviceTasks.ts")).toContain("bookingRef: taskBookingRef(SERVICE_TASK_SOURCE, t.sourceKey),");
    const svc = src("server/tasksService.ts");
    expect(svc).toContain(".leftJoin(multiparkBookings, eq(multiparkBookings.externalId, tasks.bookingRef))");
    expect(svc).toContain("conds.push(...facetConds(f.filters, nowMs));");
  });
});
