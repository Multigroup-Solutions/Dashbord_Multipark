/**
 * Tarefa 62 (P1b, Q9): re-dividir uma vez o GPS dos últimos 31 dias com o
 * limite de hoje, a pedido do super admin, em segundo plano (agendador) e
 * retomável — dia a dia com o resplitDriverDay que já existe; não avisa
 * ninguém nem mexe em dados de negócio.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RESPLIT_BACKFILL_DAYS, resplitBackfillRange, runResplitBackfillStep, startResplitBackfill, stopResplitBackfill,
  type ResplitBackfillDeps, type ResplitBackfillState,
} from "./gpsResplitBackfill";
import { TICK_JOBS } from "./cronSchedule";
import { CRON_JOBS } from "../shared/appSettings";

const src = (p: string) => readFileSync(resolve(import.meta.dirname, "..", p), "utf8");

function fakeDeps(o: { rowsPerDay?: number; perCall?: number; failDay?: string; closed?: { ok: true; closedUntil: string | null } | { ok: false } } = {}) {
  let stored: ResplitBackfillState | null = null;
  const calls: Array<{ day: string; afterId?: number }> = [];
  const perCall = o.perCall ?? Infinity;
  const deps: ResplitBackfillDeps = {
    read: async () => (stored ? JSON.parse(JSON.stringify(stored)) : null),
    write: async (s) => { stored = JSON.parse(JSON.stringify(s)); },
    resplit: async (day, opts) => {
      calls.push({ day, afterId: opts.afterId });
      if (day === o.failDay) throw new Error("BD indisponível");
      const total = o.rowsPerDay ?? 3;
      const done = (opts.afterId ?? 0) + perCall >= total;
      const processed = done ? total - (opts.afterId ?? 0) : perCall;
      return { processed, done, nextAfterId: done ? null : (opts.afterId ?? 0) + perCall, errors: [] };
    },
    closedUntil: async () => o.closed ?? { ok: true, closedUntil: null },
    now: () => new Date("2026-10-14T10:00:00Z"),
  };
  return { deps, calls, get: () => stored };
}

describe("o intervalo e o pedido", () => {
  it("os últimos 31 dias até ontem", () => {
    expect(RESPLIT_BACKFILL_DAYS).toBe(31);
    expect(resplitBackfillRange("2026-10-14")).toEqual({ from: "2026-09-13", to: "2026-10-13" });
  });
  it("sem pedido o trabalho não faz nada; pedir duas vezes não recomeça", async () => {
    const f = fakeDeps();
    expect(await runResplitBackfillStep(f.deps, { deadlineAt: Date.now() + 60_000 })).toEqual({ idle: true });
    expect(f.calls).toEqual([]);
    const a = await startResplitBackfill(f.deps, { userId: 1, todayLisbon: "2026-10-14" });
    expect(a).toMatchObject({ state: "running", from: "2026-09-13", to: "2026-10-13", day: "2026-09-13", requestedById: 1 });
    await runResplitBackfillStep(f.deps, { deadlineAt: Date.now() + 60_000 });
    const b = await startResplitBackfill(f.deps, { userId: 1, todayLisbon: "2026-10-14" });
    expect(b.state === "running" ? b.daysDone : -1).toBe(f.get()!.daysDone);
  });
});

describe("em segundo plano e retomável", () => {
  it("dia a dia até ao fim: 31 dias, depois 'done'", async () => {
    const f = fakeDeps({ rowsPerDay: 2 });
    await startResplitBackfill(f.deps, { userId: 1, todayLisbon: "2026-10-14" });
    const r = await runResplitBackfillStep(f.deps, { deadlineAt: Date.now() + 60_000 });
    expect(r).toMatchObject({ idle: false, rowsNow: 62 });
    expect(f.get()).toMatchObject({ state: "done", daysDone: 31, rowsDone: 62, day: "2026-10-14" });
    expect(f.calls.map((c) => c.day)[0]).toBe("2026-09-13");
    expect(f.calls.at(-1)!.day).toBe("2026-10-13");
    expect(await runResplitBackfillStep(f.deps, { deadlineAt: Date.now() + 60_000 })).toEqual({ idle: true });
  });
  it("a meio de um dia (prazo): guarda o id e continua daí no passo seguinte", async () => {
    const f = fakeDeps({ rowsPerDay: 5, perCall: 2 });
    await startResplitBackfill(f.deps, { userId: 1, todayLisbon: "2026-10-14" });
    await runResplitBackfillStep(f.deps, { deadlineAt: Date.now() + 60_000 });
    expect(f.get()).toMatchObject({ state: "running", day: "2026-09-13", afterId: 2, rowsDone: 2 });
    await runResplitBackfillStep(f.deps, { deadlineAt: Date.now() + 60_000 });
    expect(f.calls[1]).toEqual({ day: "2026-09-13", afterId: 2 });
    expect(f.get()).toMatchObject({ day: "2026-09-13", afterId: 4 });
  });
  it("sem tempo: não começa nenhum dia", async () => {
    const f = fakeDeps();
    await startResplitBackfill(f.deps, { userId: 1, todayLisbon: "2026-10-14" });
    await runResplitBackfillStep(f.deps, { deadlineAt: Date.now() + 1_000 });
    expect(f.calls).toEqual([]);
  });
  it("um dia com erro fica registado e volta a tentar no passo seguinte (não lança)", async () => {
    const f = fakeDeps({ failDay: "2026-09-13" });
    await startResplitBackfill(f.deps, { userId: 1, todayLisbon: "2026-10-14" });
    const r = await runResplitBackfillStep(f.deps, { deadlineAt: Date.now() + 60_000 });
    expect(r).toMatchObject({ idle: false });
    expect(f.get()).toMatchObject({ state: "running", day: "2026-09-13" });
    expect(f.get()!.errors[0]).toMatch(/^2026-09-13: BD indisponível/);
  });
  it("parar: fica onde estava e o trabalho deixa de correr", async () => {
    const f = fakeDeps({ rowsPerDay: 5, perCall: 2 });
    await startResplitBackfill(f.deps, { userId: 1, todayLisbon: "2026-10-14" });
    await runResplitBackfillStep(f.deps, { deadlineAt: Date.now() + 60_000 });
    expect((await stopResplitBackfill(f.deps))?.state).toBe("stopped");
    expect(await runResplitBackfillStep(f.deps, { deadlineAt: Date.now() + 60_000 })).toEqual({ idle: true });
  });
});

describe("o fecho mensal da Avaliação", () => {
  it("os dias fechados saltam-se (nunca se re-dividem); os abertos sim", async () => {
    const f = fakeDeps({ rowsPerDay: 1, closed: { ok: true, closedUntil: "2026-09-30" } });
    await startResplitBackfill(f.deps, { userId: 1, todayLisbon: "2026-10-14" });
    await runResplitBackfillStep(f.deps, { deadlineAt: Date.now() + 60_000 });
    const days = f.calls.map((c) => c.day);
    expect(days[0]).toBe("2026-10-01");
    expect(days.every((d) => d > "2026-09-30")).toBe(true);
    expect(f.get()).toMatchObject({ state: "done", daysDone: 13, daysClosed: 18, rowsDone: 13 });
  });
  it("tudo fechado: não re-divide nenhum dia e fica 'done'", async () => {
    const f = fakeDeps({ closed: { ok: true, closedUntil: "2026-10-13" } });
    await startResplitBackfill(f.deps, { userId: 1, todayLisbon: "2026-10-14" });
    await runResplitBackfillStep(f.deps, { deadlineAt: Date.now() + 60_000 });
    expect(f.calls).toEqual([]);
    expect(f.get()).toMatchObject({ state: "done", daysDone: 0, daysClosed: 31 });
  });
  it("o fecho não se leu: nada se re-divide neste passo (fica a correr, no mesmo dia)", async () => {
    const f = fakeDeps({ closed: { ok: false } });
    await startResplitBackfill(f.deps, { userId: 1, todayLisbon: "2026-10-14" });
    await runResplitBackfillStep(f.deps, { deadlineAt: Date.now() + 60_000 });
    expect(f.calls).toEqual([]);
    expect(f.get()).toMatchObject({ state: "running", day: "2026-09-13", daysDone: 0 });
    expect(f.get()!.errors.at(-1)).toMatch(/fecho do mês/);
  });
  it("as dependências reais leem o fecho da Avaliação", () => {
    expect(src("server/gpsResplitBackfill.ts")).toContain('closedUntil: async () => (await import("./evaluationClose")).readEvaluationClosedUntil(),');
  });
});

describe("ligações", () => {
  it("é um trabalho do agendador (5 em 5 min, ≤ 40 s) e está na lista dos crons", () => {
    expect(TICK_JOBS.find((j) => j.key === "gps-resplit-backfill")).toMatchObject({ cadence: { kind: "interval", minutes: 5 }, maxMs: 40_000 });
    expect(CRON_JOBS.some((c) => c.name === "gps-resplit-backfill")).toBe(true);
    expect(src("server/cronScheduler.ts")).toContain('"gps-resplit-backfill": async (o) => (await import("./cronJobs")).gpsResplitBackfillCron(o),');
  });
  it("só o super admin pede, vê e pára; usa o resplitDriverDay (não avisa ninguém)", () => {
    const r = src("server/operationalRouter.ts");
    const block = r.slice(r.indexOf("resplitBackfill: router({"), r.indexOf("collectDay: protectedProcedure"));
    expect(block.match(/ctx\.user\.role !== "super_admin"/g)?.length).toBe(3);
    const m = src("server/gpsResplitBackfill.ts");
    expect(m).toContain("resplit: (day, opts) => resplitDriverDay(day, opts),");
    expect(m).not.toMatch(/notify|recordSpeedExcesses|DELETE/);
    expect(src("client/src/components/ResplitBackfillCard.tsx")).toContain('user?.role === "super_admin"');
  });
});
