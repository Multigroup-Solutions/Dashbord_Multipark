import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// BD da Multipark: só a função de consulta é trocada (o resto do cliente é o real).
const queryMock = vi.fn();
vi.mock("./multiparkDb/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("./multiparkDb/client")>();
  return { ...real, multiparkDbQuery: (...args: any[]) => queryMock(...args) };
});

import { assertReadOnlySql } from "./multiparkDb/client";
import {
  buildExtraServiceCatalogSql, buildServiceLinesByIdsSql, buildServiceLinesWindowSql, runServiceTasks, runServiceTasksForBookings, tomorrowAlertBody, type ServiceTasksDeps,
} from "./serviceTasks";
import {
  checkoutShifts, groupServiceTypes, parseServiceTaskKey, planServiceTasks, serviceTaskAssignees, serviceTaskKey, serviceTypeOf,
  teamLeadersFor, type ExistingServiceTask, type ServiceTaskRules, type TeamLeaderRow,
} from "../shared/serviceTasks";
import { taskSourceLink } from "../shared/taskRules";
import { CRON_JOBS, SETTINGS, validateSetting } from "../shared/appSettings";
import { TICK_JOBS, describeCadence } from "./cronSchedule";

const ENV = "DATABASE_URL_MULTIPARK";
const root = resolve(import.meta.dirname, "..");

// 28 set 2026, 11:00 de Lisboa (verão, UTC+1) — turno da manhã.
const NOW = Date.parse("2026-09-28T10:00:00Z");
/** Saída às 17:00 de Lisboa de dia 28 → noite de 28; anterior = manhã de 28. */
const CO_NIGHT = "2026-09-28 16:00:00";
/** Saída às 07:00 de Lisboa de dia 29 → manhã de 29; anterior = noite de 28. */
const CO_MORNING = "2026-09-29 06:00:00";

const PARKS = [
  { id: "p-lis", name: "Airpark Lisboa", city: "Lisboa", firebase_brand: "airpark", listing_type: "ON_PLATFORM", status: "ACTIVE" },
  { id: "p-por", name: "Skypark Porto", city: "Porto", firebase_brand: "skypark", listing_type: "ON_PLATFORM", status: "ACTIVE" },
  { id: "p-mkt", name: "Parque Qualquer", city: "Lisboa", firebase_brand: "outro", listing_type: "DIRECTORY", status: "ACTIVE" },
];

type Row = { line_id: string | null; service_name: string | null; done: boolean | null; booking_id: string; code: string | null; status: string; check_out: string; park_id: string; plate: string | null };
const row = (p: Partial<Row> & { booking_id: string }): Row => ({
  line_id: "l1", service_name: "Lavagem Exterior", done: false, code: "AP-100", status: "BOOKED", check_out: CO_NIGHT, park_id: "p-lis", plate: "AA-00-BB", ...p,
});

/** BD Multipark falsa: parques, janela e leitura por ids. */
function fakeMultipark(rows: () => Row[]) {
  queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
    assertReadOnlySql(sql);
    if (sql.includes('FROM "Park"')) return PARKS;
    if (sql.includes('b."id" IN')) {
      const ids = new Set(params.filter((p) => typeof p === "string") as string[]);
      return rows().filter((r) => ids.has(r.booking_id));
    }
    // janela: só reservas nossas com linha
    const parkIds = new Set(params.filter((p) => typeof p === "string" && String(p).startsWith("p-")) as string[]);
    return rows().filter((r) => r.line_id != null && parkIds.has(r.park_id));
  });
}

/** BD nossa falsa (tarefas + responsáveis + comentários) e o resto das dependências. */
function fakeStore(o: { rules: ServiceTaskRules; teamLeaders?: TeamLeaderRow[] }) {
  const tasks = new Map<number, { id: number; sourceKey: string; taskStatus: string; dueDate: string | null; title: string; description: string; projectId: number | null; assigneeIds: number[] }>();
  const comments: Array<{ taskId: number; body: string }> = [];
  let next = 1;
  const mysql = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  const view = (t: any): ExistingServiceTask => ({ id: t.id, sourceKey: t.sourceKey, taskStatus: t.taskStatus, dueDate: t.dueDate, assigneeIds: [...t.assigneeIds] });
  const deps: Partial<ServiceTasksDeps> = {
    loadRules: async () => o.rules,
    loadOpenTasks: async () => [...tasks.values()].filter((t) => t.taskStatus !== "done").map(view),
    loadTasksByKeys: async (keys) => [...tasks.values()].filter((t) => keys.includes(t.sourceKey)).map(view),
    loadTasksForBookings: async (ids) => [...tasks.values()].filter((t) => ids.includes(parseServiceTaskKey(t.sourceKey)?.bookingId ?? "")).map(view),
    loadTeamLeaders: async (dates) => (o.teamLeaders ?? []).filter((r) => dates.includes(r.date)),
    cityProjectIds: async () => ({ lisbon: 11, porto: 12, faro: 13 }),
    systemUserId: async () => 1,
    createTask: async (t) => {
      const id = next++;
      tasks.set(id, { id, sourceKey: t.sourceKey, taskStatus: "todo", dueDate: mysql(t.dueMs), title: t.title, description: t.description, projectId: t.projectId, assigneeIds: [...t.assigneeIds] });
      return id;
    },
    updateTask: async (id, p) => { const t = tasks.get(id)!; t.dueDate = mysql(p.dueMs); t.title = p.title; t.description = p.description; },
    addAssignees: async (id, ids) => { tasks.get(id)!.assigneeIds.push(...ids); },
    closeTask: async (id, body) => { const t = tasks.get(id)!; if (t.taskStatus !== "done") { t.taskStatus = "done"; comments.push({ taskId: id, body }); } },
    syncGoogle: (ids) => { google.push(...ids); },
  };
  const google: number[] = [];
  return { tasks, comments, deps, google };
}

const RULES_RESP: ServiceTaskRules = { lisbon: { lavagem: { enabled: true, responsibleEmployeeId: 500 } }, porto: {}, faro: {} };
const RULES_TL_ONLY: ServiceTaskRules = { lisbon: { lavagem: { enabled: true, responsibleEmployeeId: null } }, porto: {}, faro: {} };
const TLS: TeamLeaderRow[] = [
  { date: "2026-09-28", shift: "morning", city: "lisbon", employeeId: 21, status: "confirmed" },
  { date: "2026-09-28", shift: "night", city: "lisbon", employeeId: 22, status: "confirmed" },
  { date: "2026-09-29", shift: "morning", city: "lisbon", employeeId: 23, status: "confirmed" },
  { date: "2026-09-28", shift: "night", city: "porto", employeeId: 99, status: "confirmed" },
];

const run = (deps: Partial<ServiceTasksDeps>) => runServiceTasks({ deadlineAt: Date.now() + 60_000, now: NOW }, deps);

beforeEach(() => { process.env[ENV] = "postgres://ro:x@localhost:5432/mp"; queryMock.mockReset(); });
afterEach(() => { delete process.env[ENV]; });

// ─── Regras puras ───────────────────────────────────────────────────────────

describe("tipos de serviço", () => {
  it("agrupa os nomes do catálogo por tipo e tira as marcas operacionais", () => {
    expect(serviceTypeOf("Lavagem Exterior")?.key).toBe("lavagem");
    expect(serviceTypeOf("LAVAGEM COMPLETA")?.key).toBe("lavagem");
    expect(serviceTypeOf("Carregamento Elétrico")).toEqual({ key: "carregamento_eletrico", label: "Carregamento elétrico" });
    expect(serviceTypeOf("EV Charging")?.key).toBe("carregamento_eletrico");
    expect(serviceTypeOf("Flexível")?.key).toBe("valet_flex");
    expect(serviceTypeOf("No pay")).toBeNull();
    expect(serviceTypeOf("Aeroporto Lisboa Partidas")).toBeNull();
    expect(serviceTypeOf("Inspeção Periódica")).toEqual({ key: "inspecao_periodica", label: "Inspeção Periódica" });
    const g = groupServiceTypes(["Lavagem Exterior", "Lavagem Completa", "lavagem exterior", "Carregamento Elétrico", "No pay"]);
    expect(g.map((t) => t.key)).toEqual(["carregamento_eletrico", "lavagem"]);
    expect(g.find((t) => t.key === "lavagem")!.names).toEqual(["Lavagem Completa", "Lavagem Exterior"]);
  });

  it("chave da tarefa e link para a ficha da reserva", () => {
    expect(serviceTaskKey("bk1", "l1")).toBe("svc:bk1:l1");
    expect(serviceTaskKey("x".repeat(100), "y".repeat(40))).toBeNull();
    expect(parseServiceTaskKey("svc:bk1:l1")).toEqual({ bookingId: "bk1", lineId: "l1" });
    expect(parseServiceTaskKey("availability:1:2026-09-28")).toBeNull();
    expect(taskSourceLink("service", null, "svc:bk1:l1")).toBe("/reserva/bk1");
  });

  it("a definição valida por cidade e tipo", () => {
    expect(SETTINGS["services.taskRules"].group).toBe("servicos");
    const ok = validateSetting("services.taskRules", { lisbon: { lavagem: { enabled: true, responsibleEmployeeId: 5 } } });
    expect(ok).toEqual({ ok: true, value: { lisbon: { lavagem: { enabled: true, responsibleEmployeeId: 5 } }, porto: {}, faro: {} } });
    expect(validateSetting("services.taskRules", { lisbon: { "Lavagem!": { enabled: true } } }).ok).toBe(false);
    expect(validateSetting("services.taskRules", { lisbon: { lavagem: { enabled: "sim" } } }).ok).toBe(false);
  });
});

describe("turnos e team leaders", () => {
  it("turno da saída e o anterior (manhã 03–15h, noite 15–03h de Lisboa)", () => {
    expect(checkoutShifts(Date.parse("2026-09-28T16:00:00Z"))).toEqual({ leaving: { date: "2026-09-28", shift: "night" }, previous: { date: "2026-09-28", shift: "morning" } });
    expect(checkoutShifts(Date.parse("2026-09-29T06:00:00Z"))).toEqual({ leaving: { date: "2026-09-29", shift: "morning" }, previous: { date: "2026-09-28", shift: "night" } });
    // 01:30 de dia 29 ainda é a noite de 28
    expect(checkoutShifts(Date.parse("2026-09-29T00:30:00Z"))).toEqual({ leaving: { date: "2026-09-28", shift: "night" }, previous: { date: "2026-09-28", shift: "morning" } });
  });

  it("confirmados ganham aos propostos; sem confirmados usa os propostos", () => {
    const rows: TeamLeaderRow[] = [
      { date: "2026-09-29", shift: "morning", city: "lisbon", employeeId: 1, status: "proposed" },
      { date: "2026-09-29", shift: "morning", city: "lisbon", employeeId: 2, status: "confirmed" },
      { date: "2026-09-29", shift: "night", city: "lisbon", employeeId: 3, status: "proposed" },
    ];
    expect(teamLeadersFor(rows, "lisbon", { date: "2026-09-29", shift: "morning" })).toEqual([2]);
    expect(teamLeadersFor(rows, "lisbon", { date: "2026-09-29", shift: "night" })).toEqual([3]);
    expect(teamLeadersFor(rows, "porto", { date: "2026-09-29", shift: "morning" })).toEqual([]);
  });

  it("responsável configurado + TL do turno da saída + TL do turno anterior (sem repetidos)", () => {
    const co = Date.parse("2026-09-29T06:00:00Z");
    expect(serviceTaskAssignees({ rule: { responsibleEmployeeId: 500 }, city: "lisbon", checkOutMs: co, teamLeaders: TLS })).toEqual([500, 23, 22]);
    expect(serviceTaskAssignees({ rule: { responsibleEmployeeId: null }, city: "lisbon", checkOutMs: co, teamLeaders: TLS })).toEqual([23, 22]);
    expect(serviceTaskAssignees({ rule: { responsibleEmployeeId: 22 }, city: "lisbon", checkOutMs: co, teamLeaders: TLS })).toEqual([22, 23]);
  });
});

describe("SQL (só leitura)", () => {
  it("janela, ids e catálogo passam na guarda de só leitura e são parametrizados", () => {
    const w = buildServiceLinesWindowSql(NOW - 3_600_000, NOW + 48 * 3_600_000, ["p-lis", "p-por"]);
    assertReadOnlySql(w.sql);
    expect(w.sql).toContain('JOIN "BookingExtraService" e ON e."bookingId" = b."id"');
    expect(w.sql).toContain('b."checkOutDate" >= $5::timestamp');
    expect(w.params.slice(0, 2)).toEqual(["p-lis", "p-por"]);
    expect(w.sql).not.toContain("p-lis");
    const b = buildServiceLinesByIdsSql(["bk1"]);
    assertReadOnlySql(b.sql);
    expect(b.sql).toContain('LEFT JOIN "BookingExtraService"');
    const c = buildExtraServiceCatalogSql(["p-lis"]);
    assertReadOnlySql(c.sql);
    expect(c.sql).toContain('FROM "ExtraService" x');
  });
});

// ─── Corrida (BD Multipark e BD nossa falsas) ───────────────────────────────

describe("runServiceTasks — responsáveis", () => {
  it("responsável configurado + TL do turno da saída + TL do anterior", async () => {
    fakeMultipark(() => [row({ booking_id: "bk1", check_out: CO_MORNING })]);
    const s = fakeStore({ rules: RULES_RESP, teamLeaders: TLS });
    const r = await run(s.deps);
    expect(r).toMatchObject({ ok: true, created: 1 });
    const t = [...s.tasks.values()][0];
    expect(t.assigneeIds).toEqual([500, 23, 22]);
    expect(t.sourceKey).toBe("svc:bk1:l1");
    expect(t.projectId).toBe(11);
    expect(t.dueDate).toBe(CO_MORNING);
    expect(t.title).toBe("Lavagem Exterior · reserva AP-100 · AA-00-BB");
    expect(t.description).toContain("Saída do carro: 29/09/2026 07:00");
    expect(t.description).toContain("Ficha da reserva: /reserva/bk1");
    expect(t.description).toContain("Parque: Airpark Lisboa (Lisboa)");
  });

  it("sem responsável configurado → só os team leaders", async () => {
    fakeMultipark(() => [row({ booking_id: "bk1", check_out: CO_NIGHT })]);
    const s = fakeStore({ rules: RULES_TL_ONLY, teamLeaders: TLS });
    await run(s.deps);
    expect([...s.tasks.values()][0].assigneeIds).toEqual([22, 21]);
  });

  it("tipo desligado, outra cidade, parque que não é nosso, saída já passada ou serviço feito → nada", async () => {
    fakeMultipark(() => [
      row({ booking_id: "bk1", service_name: "Carregamento Elétrico" }),
      row({ booking_id: "bk2", park_id: "p-por" }),
      row({ booking_id: "bk3", park_id: "p-mkt" }),
      row({ booking_id: "bk4", check_out: "2026-09-28 08:00:00" }),
      row({ booking_id: "bk5", done: true }),
      row({ booking_id: "bk6", status: "CANCELLED" }),
    ]);
    const s = fakeStore({ rules: RULES_TL_ONLY, teamLeaders: TLS });
    const r = await run(s.deps);
    expect(r.created).toBe(0);
    expect(s.tasks.size).toBe(0);
  });

  it("escala publicada depois → acrescenta os TL em falta (nunca tira ninguém)", async () => {
    fakeMultipark(() => [row({ booking_id: "bk1", check_out: CO_MORNING })]);
    const tls: TeamLeaderRow[] = [];
    const s = fakeStore({ rules: RULES_RESP, teamLeaders: tls });
    await run(s.deps);
    expect([...s.tasks.values()][0].assigneeIds).toEqual([500]);
    tls.push(...TLS);
    const r = await run(s.deps);
    expect(r).toMatchObject({ created: 0, assigned: 2 });
    expect([...s.tasks.values()][0].assigneeIds).toEqual([500, 23, 22]);
  });

  it("sem nenhum tipo ligado e sem tarefas abertas → nem lê a Multipark", async () => {
    const s = fakeStore({ rules: { lisbon: {}, porto: {}, faro: {} } });
    const r = await run(s.deps);
    expect(r.skipped).toMatch(/gera tarefa/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("sem DATABASE_URL_MULTIPARK → nota, sem erro", async () => {
    delete process.env[ENV];
    const s = fakeStore({ rules: RULES_RESP });
    const r = await run(s.deps);
    expect(r).toMatchObject({ ok: true, skipped: expect.stringContaining("DATABASE_URL_MULTIPARK") });
  });
});

describe("runServiceTasks — idempotência", () => {
  it("duas corridas → uma só tarefa; saída mudada → novo prazo na mesma tarefa", async () => {
    let rows = [row({ booking_id: "bk1", check_out: CO_NIGHT }), row({ booking_id: "bk1", line_id: "l2", service_name: "Lavagem Interior" })];
    fakeMultipark(() => rows);
    const s = fakeStore({ rules: RULES_TL_ONLY, teamLeaders: TLS });
    expect((await run(s.deps)).created).toBe(2);
    const again = await run(s.deps);
    expect(again).toMatchObject({ created: 0, updated: 0, assigned: 0 });
    expect(s.tasks.size).toBe(2);

    rows = rows.map((r) => ({ ...r, check_out: CO_MORNING }));
    const moved = await run(s.deps);
    expect(moved).toMatchObject({ created: 0, updated: 2 });
    expect([...s.tasks.values()].map((t) => t.dueDate)).toEqual([CO_MORNING, CO_MORNING]);
    expect([...s.tasks.values()][0].description).toContain("29/09/2026 07:00");
  });

  it("saída mudada para fora da janela: a reserva é lida pelo id e o prazo acompanha", async () => {
    let co = CO_NIGHT;
    fakeMultipark(() => [row({ booking_id: "bk1", check_out: co })]);
    const s = fakeStore({ rules: RULES_TL_ONLY, teamLeaders: TLS });
    await run(s.deps);
    co = "2026-10-05 09:00:00";
    // a janela já não a traz; a leitura por ids sim
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "Park"')) return PARKS;
      if (sql.includes('b."id" IN')) return [row({ booking_id: "bk1", check_out: co })];
      return [];
    });
    const r = await run(s.deps);
    expect(r).toMatchObject({ created: 0, updated: 1 });
    expect([...s.tasks.values()][0].dueDate).toBe(co);
  });

  it("tarefa concluída à mão não é recriada nem reaberta", async () => {
    fakeMultipark(() => [row({ booking_id: "bk1" })]);
    const s = fakeStore({ rules: RULES_TL_ONLY, teamLeaders: TLS });
    await run(s.deps);
    [...s.tasks.values()][0].taskStatus = "done";
    const r = await run(s.deps);
    expect(r).toMatchObject({ created: 0, updated: 0, closed: { cancelled: 0, removed: 0, done_multipark: 0 } });
    expect(s.tasks.size).toBe(1);
  });
});

describe("runServiceTasks — cancelamento e fecho", () => {
  it("reserva cancelada → a tarefa fecha com comentário", async () => {
    let status = "BOOKED";
    fakeMultipark(() => [row({ booking_id: "bk1", status })]);
    const s = fakeStore({ rules: RULES_TL_ONLY, teamLeaders: TLS });
    await run(s.deps);
    status = "CANCELLED";
    const r = await run(s.deps);
    expect(r.closed.cancelled).toBe(1);
    expect([...s.tasks.values()][0].taskStatus).toBe("done");
    expect(s.comments[0].body).toMatch(/cancelada/);
    // e não volta a criar
    expect((await run(s.deps)).created).toBe(0);
  });

  it("serviço retirado da reserva → fecha", async () => {
    let rows = [row({ booking_id: "bk1" }), row({ booking_id: "bk1", line_id: "l2", service_name: "Lavagem Interior" })];
    fakeMultipark(() => rows);
    const s = fakeStore({ rules: RULES_TL_ONLY, teamLeaders: TLS });
    await run(s.deps);
    rows = rows.filter((r) => r.line_id !== "l2");
    const r = await run(s.deps);
    expect(r.closed.removed).toBe(1);
    expect([...s.tasks.values()].find((t) => t.sourceKey === "svc:bk1:l2")!.taskStatus).toBe("done");
    expect([...s.tasks.values()].find((t) => t.sourceKey === "svc:bk1:l1")!.taskStatus).toBe("todo");
  });

  it("serviço marcado feito na Multipark → a tarefa fica concluída", async () => {
    let done = false;
    fakeMultipark(() => [row({ booking_id: "bk1", done })]);
    const s = fakeStore({ rules: RULES_TL_ONLY, teamLeaders: TLS });
    await run(s.deps);
    done = true;
    const r = await run(s.deps);
    expect(r.closed.done_multipark).toBe(1);
    expect(s.comments[0].body).toMatch(/feito na Multipark/);
  });

  it("plano puro: reserva não lida (fora do orçamento) não fecha a tarefa", () => {
    const existing: ExistingServiceTask[] = [{ id: 1, sourceKey: "svc:bk9:l1", taskStatus: "todo", dueDate: CO_NIGHT, assigneeIds: [] }];
    expect(planServiceTasks({ lines: [], checkedBookingIds: new Set(), rules: RULES_TL_ONLY, existing, teamLeaders: [], nowMs: NOW })).toEqual([]);
    expect(planServiceTasks({ lines: [], checkedBookingIds: new Set(["bk9"]), rules: RULES_TL_ONLY, existing, teamLeaders: [], nowMs: NOW }))
      .toEqual([{ kind: "close", taskId: 1, reason: "removed" }]);
  });
});

// ─── Agendador, endpoint e ajuda ────────────────────────────────────────────

describe("agendador", () => {
  it("services-tasks 1×/dia às 18:00 (as tarefas nascem no webhook), com função, entrada nos crons e endpoint manual", async () => {
    const spec = TICK_JOBS.find((j) => j.key === "services-tasks")!;
    expect(describeCadence(spec.cadence)).toBe("diário a partir das 18:00");
    expect(spec.maxMs).toBeLessThan(50_000);
    expect(CRON_JOBS.find((j) => j.name === "services-tasks")).toMatchObject({ intervalMinutes: 1440, workflow: "tick" });
    const { JOB_RUNNERS } = await import("./cronScheduler");
    expect(typeof JOB_RUNNERS["services-tasks"]).toBe("function");
    const api = readFileSync(resolve(root, "server/_core/api-entry.ts"), "utf8");
    expect(api).toMatch(/app\.get\("\/api\/cron\/services-tasks"[\s\S]{0,120}cronAuthOk\(req\)/);
    const help = readFileSync(resolve(root, "docs/ajuda/agendador.md"), "utf8");
    expect(help).toContain("services-tasks");
  });
});

// ─── Webhook: a tarefa nasce quando a reserva chega ─────────────────────────

describe("runServiceTasksForBookings (webhook)", () => {
  it("cria a tarefa da reserva que chegou (saída até 72 h) e manda-a para o Google; mais longe fica para a volta", async () => {
    // bkW sai daqui a 46 h (dentro das 72 h do webhook); bkFar só a 20 out
    fakeMultipark(() => [row({ booking_id: "bkW", check_out: "2026-09-30 08:00:00" }), row({ booking_id: "bkFar", check_out: "2026-10-20 08:00:00" }), row({ booking_id: "bkOther" })]);
    const s = fakeStore({ rules: RULES_RESP });
    // 30 set 2026: janela de 72 h (com 400 dias as tarefas iam para o Google semanas antes)
    const far = await runServiceTasksForBookings(["bkFar"], { deadlineAt: Date.now() + 30_000, now: NOW }, s.deps);
    expect(far.created).toBe(0);
    const r = await runServiceTasksForBookings(["bkW"], { deadlineAt: Date.now() + 30_000, now: NOW }, s.deps);
    expect(r.created).toBe(1);
    expect([...s.tasks.values()].map((t) => t.sourceKey)).toEqual(["svc:bkW:l1"]);
    expect([...s.tasks.values()][0].assigneeIds).toEqual([500]);
    expect(s.google).toEqual([1]);
    // o mesmo webhook outra vez: nada de novo
    const again = await runServiceTasksForBookings(["bkW"], { deadlineAt: Date.now() + 30_000, now: NOW }, s.deps);
    expect(again.created).toBe(0);
    expect(s.tasks.size).toBe(1);
  });

  it("reserva cancelada no webhook fecha a tarefa; só toca nas reservas dadas", async () => {
    let status = "BOOKED";
    fakeMultipark(() => [row({ booking_id: "bkC", status }), row({ booking_id: "bkKeep", line_id: "l9" })]);
    const s = fakeStore({ rules: RULES_RESP });
    await runServiceTasksForBookings(["bkC", "bkKeep"], { deadlineAt: Date.now() + 30_000, now: NOW }, s.deps);
    expect(s.tasks.size).toBe(2);
    status = "CANCELLED";
    const r = await runServiceTasksForBookings(["bkC"], { deadlineAt: Date.now() + 30_000, now: NOW }, s.deps);
    expect(r.closed.cancelled).toBe(1);
    expect([...s.tasks.values()].filter((t) => t.taskStatus === "done").map((t) => t.sourceKey)).toEqual(["svc:bkC:l1"]);
  });

  it("sem tipos ligados e sem tarefas → não lê a Multipark", async () => {
    const s = fakeStore({ rules: { lisbon: {}, porto: {}, faro: {} } });
    const r = await runServiceTasksForBookings(["bkX"], { deadlineAt: Date.now() + 30_000, now: NOW }, s.deps);
    expect(r.skipped).toMatch(/gera tarefa/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("aviso de amanhã: hora de Lisboa, por ordem de saída", () => {
    const body = tomorrowAlertBody([
      { id: 2, title: "Lavagem · AP-2", dueDate: "2026-09-30 16:00:00", projectId: 11 },
      { id: 1, title: "Lavagem · AP-1", dueDate: "2026-09-30 06:30:00", projectId: 11 },
    ]);
    expect(body).toBe("07:30 · Lavagem · AP-1\n17:00 · Lavagem · AP-2");
  });
});
