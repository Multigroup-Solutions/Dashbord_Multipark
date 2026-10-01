import { beforeEach, describe, expect, it, vi } from "vitest";

// Arrumar o #185 ("agendador mais leve"), 30 set 2026: o que a revisão
// confirmou — tarefas gémeas, tarefas perdidas quando o webhook falha, o aviso
// de amanhã preso à Multipark, a caixa a dar "feito" a meio e alertas deitados
// fora, a triagem a desistir em falhas passageiras. Testes de comportamento.

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  queue: vi.fn(),
  sendTomorrow: vi.fn(),
  runSweep: vi.fn(),
  flagOn: false,
}));
vi.mock("./crm/sync", () => ({ syncCrmForBookings: async () => ({ rows: 0 }) }));
vi.mock("./_core/featureFlags", () => ({ ensureFeatureFlagOverrides: async () => undefined, isFeatureEnabled: () => mocks.flagOn }));

import { planServiceTasks, type ServiceLine, type ServiceTaskRules } from "../shared/serviceTasks";
import {
  ServiceTaskExistsError, retryServiceTasks, serviceKeyPrefixLike, serviceReportNeedsRetry, runServiceTasksForBookings,
  SERVICE_RETRY_MAX_ATTEMPTS, type ServiceRetryStore, type ServiceTasksDeps, type ServiceTasksReport,
} from "./serviceTasks";
import { sendCaseAlerts, sweepJobDone, ALERTS_PER_RUN, type CaseAlert } from "./cashSweep";
import { whatsappTriageFailureCounts } from "../shared/commsAi";
import { TICK_JOBS } from "./cronSchedule";
import { CRON_JOBS, automationFlagDefault } from "../shared/appSettings";
import { MIGRATION_0325_STATEMENTS } from "./migrations/migration_0325";

const NOW = Date.parse("2026-09-28T10:00:00Z");
const RULES: ServiceTaskRules = { lisbon: { lavagem: { enabled: true, responsibleEmployeeId: 500 } }, porto: {}, faro: {} };
const line = (p: Partial<ServiceLine> = {}): ServiceLine => ({
  lineId: "l1", bookingId: "B", code: "AP-1", status: "BOOKED", checkOutMs: NOW + 24 * 3_600_000,
  parkName: "Airpark Lisboa", city: "lisbon", plate: null, serviceName: "Lavagem Exterior", done: false, ...p,
});
const report = (p: Partial<ServiceTasksReport> = {}): ServiceTasksReport => ({
  ok: true, done: true, lines: 0, bookings: 0, created: 0, updated: 0, assigned: 0,
  closed: { cancelled: 0, removed: 0, done_multipark: 0, done_local: 0 }, pending: 0, alreadyExisted: 0, truncated: false, errors: [], ...p,
});

describe("tarefas dos serviços", () => {
  it("compra online por acabar (PENDING) não gera tarefa", () => {
    const a = planServiceTasks({ lines: [line({ status: "PENDING" })], checkedBookingIds: new Set(["B"]), rules: RULES, existing: [], teamLeaders: [], nowMs: NOW });
    expect(a).toEqual([]);
    const b = planServiceTasks({ lines: [line()], checkedBookingIds: new Set(["B"]), rules: RULES, existing: [], teamLeaders: [], nowMs: NOW });
    expect(b.map((x) => x.kind)).toEqual(["create"]);
  });

  it("com uma aberta e uma fechada da mesma chave, a aberta é a que acompanha a reserva", () => {
    // o webhook lê as tarefas da reserva; a fechada vem antes, a aberta por último
    const existing = [
      { id: 1, sourceKey: "svc:B:l1", taskStatus: "done", dueDate: null, assigneeIds: [500] },
      { id: 2, sourceKey: "svc:B:l1", taskStatus: "todo", dueDate: null, assigneeIds: [500] },
    ];
    const a = planServiceTasks({ lines: [line({ status: "CANCELLED" })], checkedBookingIds: new Set(["B"]), rules: RULES, existing, teamLeaders: [], nowMs: NOW });
    expect(a).toEqual([{ kind: "close", taskId: 2, reason: "cancelled" }]);
  });

  it("LIKE da reserva escapa % e _ (não apanha tarefas de outras reservas)", () => {
    expect(serviceKeyPrefixLike("ab_c%")).toBe("svc:ab\\_c\\%:%");
  });

  it("webhook: não lê a lista de abertas (usa a chave da reserva); criação gémea → conta como já existente", async () => {
    const deps: Partial<ServiceTasksDeps> = {
      multiparkConfigured: () => true,
      query: (async (sql: string) => (sql.includes('FROM "Park"')
        ? [{ id: "p-lis", name: "Airpark Lisboa", city: "Lisboa", firebase_brand: "airpark", listing_type: "ON_PLATFORM", status: "ACTIVE" }]
        : [{ line_id: "l1", service_name: "Lavagem Exterior", done: false, booking_id: "B", code: "AP-1", status: "BOOKED", check_out: "2026-09-29 10:00:00", park_id: "p-lis", plate: null }])) as any,
      loadRules: async () => RULES,
      loadOpenTasks: async () => { throw new Error("não devia ler as 1000 abertas"); },
      loadTasksByKeys: async () => { throw new Error("não devia"); },
      loadTasksForBookings: async () => [],
      loadTeamLeaders: async () => [],
      cityProjectIds: async () => ({ lisbon: 11 }),
      systemUserId: async () => 1,
      createTask: async (t) => { throw new ServiceTaskExistsError(t.sourceKey); },
      syncGoogle: () => undefined,
    };
    const r = await runServiceTasksForBookings(["B"], { deadlineAt: Date.now() + 30_000, now: NOW }, deps);
    expect(r).toMatchObject({ created: 0, alreadyExisted: 1, errors: [], ok: true });
  });

  it("migração 0325: marca as gémeas (nada apagado) e a chave única é só das tarefas de serviço", () => {
    const [dedupe, col, uq, retries] = MIGRATION_0325_STATEMENTS;
    expect(dedupe).toMatch(/^UPDATE `tasks`/);
    expect(dedupe).not.toMatch(/DELETE/i);
    expect(col).toContain("IF(`sourceModule` = 'service', `sourceKey`, NULL)");
    expect(uq).toContain("UNIQUE INDEX");
    expect(retries).toContain("service_task_retries");
  });
});

describe("repetição do que falha no webhook", () => {
  it("relatório com erro ou por acabar → repete; saltado ou limpo → não", () => {
    expect(serviceReportNeedsRetry(report({ errors: ["create: lock"] }))).toBe(true);
    expect(serviceReportNeedsRetry(report({ done: false }))).toBe(true);
    expect(serviceReportNeedsRetry(report())).toBe(false);
    expect(serviceReportNeedsRetry(report({ skipped: "nenhum serviço", done: true }))).toBe(false);
  });

  const store = () => {
    const s = { due: ["B1", "B2"], done: [] as string[], failed: [] as string[], limit: 0, max: 0 };
    const api: ServiceRetryStore = {
      queue: async () => undefined,
      due: async (limit, max) => { s.limit = limit; s.max = max; return s.due; },
      markDone: async (ids) => { s.done.push(...ids); },
      markFailed: async (ids) => { s.failed.push(...ids); },
    };
    return { s, api };
  };

  it("repete em lote; se correr bem, ficam feitas", async () => {
    const { s, api } = store();
    const run = vi.fn(async () => report({ created: 2 }));
    const r = await retryServiceTasks({ deadlineAt: Date.now() + 20_000 }, api, run as any);
    expect(run).toHaveBeenCalledWith(["B1", "B2"], expect.anything());
    expect(r).toMatchObject({ due: 2, done: 2, failed: 0 });
    expect(s.done).toEqual(["B1", "B2"]);
    expect(s.max).toBe(SERVICE_RETRY_MAX_ATTEMPTS);
  });

  it("se voltar a falhar (ou rebentar), sobe a tentativa e fica para a próxima", async () => {
    const { s, api } = store();
    await retryServiceTasks({ deadlineAt: Date.now() + 20_000 }, api, (async () => report({ errors: ["x"] })) as any);
    expect(s.failed).toEqual(["B1", "B2"]);
    const t = store();
    await retryServiceTasks({ deadlineAt: Date.now() + 20_000 }, t.api, (async () => { throw new Error("BD em baixo"); }) as any);
    expect(t.s.failed).toEqual(["B1", "B2"]);
  });

  it("o webhook guarda a reserva para repetir quando a corrida falha ou rebenta", async () => {
    const st = await import("./serviceTasks");
    const runSpy = vi.spyOn(st, "runServiceTasksForBookings");
    const queueSpy = vi.spyOn(st, "queueServiceTaskRetry").mockResolvedValue(undefined);
    const { onBookingArrived } = await import("./multiparkWebhook");
    runSpy.mockResolvedValueOnce(report({ errors: ["create: ER_LOCK_DEADLOCK"] }));
    await onBookingArrived("BK1");
    expect(queueSpy).toHaveBeenLastCalledWith("BK1", "create: ER_LOCK_DEADLOCK");
    runSpy.mockRejectedValueOnce(new Error("timeout"));
    await onBookingArrived("BK2");
    expect(queueSpy).toHaveBeenLastCalledWith("BK2", expect.any(String));
    runSpy.mockResolvedValueOnce(report());
    queueSpy.mockClear();
    await onBookingArrived("BK3");
    expect(queueSpy).not.toHaveBeenCalled();
    runSpy.mockRestore(); queueSpy.mockRestore();
  });
});

describe("aviso das tarefas de amanhã", () => {
  beforeEach(() => { mocks.flagOn = false; });
  it("é um trabalho próprio às 18:00, a seguir à volta, e entra DESLIGADO", () => {
    const tomorrow = TICK_JOBS.find((j) => j.key === "services-tomorrow")!;
    const sweep = TICK_JOBS.find((j) => j.key === "services-tasks")!;
    expect(tomorrow.cadence).toEqual({ kind: "daily", from: "18:00" });
    expect(tomorrow.priority).toBeGreaterThan(sweep.priority);
    expect(automationFlagDefault("SERVICE_TASKS_TOMORROW_ALERT")).toBe(false);
  });
  it("interruptor desligado → não avisa; a volta (e a corrida à mão) já não manda o aviso", async () => {
    const st = await import("./serviceTasks");
    const sendSpy = vi.spyOn(st, "sendServiceTasksTomorrowAlert").mockResolvedValue({ date: "2026-09-29", tasks: 1, cities: 1 });
    const runSpy = vi.spyOn(st, "runServiceTasks").mockResolvedValue(report());
    const { serviceTasksCron, serviceTasksTomorrowCron } = await import("./cronJobs");
    await serviceTasksCron({ deadlineAt: Date.now() + 20_000 });
    expect(sendSpy).not.toHaveBeenCalled();
    expect((await serviceTasksTomorrowCron()).body).toMatchObject({ skipped: expect.stringMatching(/desligado/) });
    mocks.flagOn = true;
    // a Multipark em baixo não o trava: só lê a nossa BD
    runSpy.mockRejectedValue(new Error("CONNECT_FAILED"));
    const r = await serviceTasksTomorrowCron();
    expect(r.body).toMatchObject({ tasks: 1 });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    sendSpy.mockRestore(); runSpy.mockRestore();
  });
});

describe("caixa", () => {
  it("varredura a meio → não acabou (retoma no tick seguinte), até 3 seguidas", () => {
    expect(sweepJobDone({ partial: false })).toBe(true);
    expect(sweepJobDone({ partial: true, partialRuns: 1 })).toBe(false);
    expect(sweepJobDone({ partial: true, partialRuns: 3 })).toBe(true);
  });
  it("30 casos graves → 25 avisos + 1 resumo; todos marcados como avisados", async () => {
    const list: CaseAlert[] = Array.from({ length: 30 }, (_, i) => ({ caseId: i + 1, meta: { subjectType: "booking", subjectId: `b${i}`, projectId: 11 } as any, finding: { label: "Preço zerado", detail: "…" } as any }));
    const sent: any[] = [];
    let updates = 0;
    const d = { execute: async () => { updates++; return [[]]; } };
    const n = await sendCaseAlerts(d, "2026-09-30 10:00:00", list, async (x) => { sent.push(x); });
    expect(sent).toHaveLength(ALERTS_PER_RUN + 1);
    expect(sent[ALERTS_PER_RUN].title).toMatch(/mais 5 casos/);
    expect(n).toBe(ALERTS_PER_RUN + 1);
    expect(updates).toBe(30); // alertedAt nos 30

  });
});

describe("triagem do WhatsApp", () => {
  it("só a resposta inválida conta para desistir; timeout, 429 e 5xx voltam a tentar", () => {
    expect(whatsappTriageFailureCounts("invalid_output")).toBe(true);
    expect(whatsappTriageFailureCounts("unsupported")).toBe(true);
    for (const c of ["timeout", "rate_limited", "provider", null]) expect(whatsappTriageFailureCounts(c)).toBe(false);
  });
});

describe("cadências: as duas tabelas não se desencontram", () => {
  // de propósito diferentes: o Gmail com push (5 min vs rede de segurança), a
  // escala só de dia, e os mensais que partilham o nome com o diário
  const EXCEPTIONS = new Set(["mail-sync", "extras-schedule", "google-ads-monthly", "meta-ads-monthly"]);
  const minutes = (c: (typeof TICK_JOBS)[number]["cadence"]) => (c.kind === "interval" ? c.minutes : c.kind === "daily" ? 1440 : c.kind === "weekly" ? 10080 : 44640);
  it("CRON_JOBS.intervalMinutes = cadência do agendador", () => {
    for (const j of TICK_JOBS) {
      if (EXCEPTIONS.has(j.key)) continue;
      expect(CRON_JOBS.find((c) => c.name === j.runName)?.intervalMinutes, j.key).toBe(minutes(j.cadence));
    }
  });
});
