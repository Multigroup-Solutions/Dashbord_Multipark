import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_ATTEMPTS, RETRY_AFTER_MS, TICK_JOBS, ZELLO_SAMEDAY_WINDOW, isoWeekKey, applyOutcome, cursorForRun, describeCadence, emptyState, isDue, jobDeadline, leaseFree,
  lisbonParts, lisbonToUtc, nextDueAt, periodKeyFor, planTick, tickBudgetEnd, wrapCursor, type JobState, type TickJobSpec,
} from "./cronSchedule";
import { runStepsWithDeadline } from "./extrasAutomation";
import { parseDailyOpsCursor } from "./cronJobs";
import { passForDay, pickIncompleteDays, usersToCollect, type ExistingDriverRow } from "./jobs/dailyDriverCollection";
import { zelloLatestDay } from "../shared/lisbonDay";
import { CRON_JOBS } from "../shared/appSettings";

const root = resolve(import.meta.dirname, "..");
const spec = (key: string): TickJobSpec => TICK_JOBS.find((j) => j.key === key)!;
const at = (iso: string) => Date.parse(iso);
const st = (key: string, patch: Partial<JobState> = {}): JobState => ({ ...emptyState(key), ...patch });
const MIN = 60_000;

describe("relógio de Lisboa (hora de verão)", () => {
  it("verão = UTC+1, inverno = UTC+0", () => {
    expect(lisbonParts(at("2026-09-26T03:30:00Z"))).toMatchObject({ date: "2026-09-26", hour: 4, minutes: 4 * 60 + 30 });
    expect(lisbonParts(at("2026-12-01T04:30:00Z"))).toMatchObject({ date: "2026-12-01", hour: 4, minutes: 4 * 60 + 30 });
  });
  it("lisbonToUtc acerta nos dias da mudança da hora", () => {
    expect(new Date(lisbonToUtc("2026-03-29", 4 * 60 + 30)).toISOString()).toBe("2026-03-29T03:30:00.000Z"); // já verão
    expect(new Date(lisbonToUtc("2026-03-28", 4 * 60 + 30)).toISOString()).toBe("2026-03-28T04:30:00.000Z");
    expect(new Date(lisbonToUtc("2026-10-25", 4 * 60 + 30)).toISOString()).toBe("2026-10-25T04:30:00.000Z"); // já inverno
    expect(new Date(lisbonToUtc("2026-10-24", 4 * 60 + 30)).toISOString()).toBe("2026-10-24T03:30:00.000Z");
  });
});

describe("intervalos", () => {
  it("uma vez por fatia de N min (alinhada ao relógio)", () => {
    const s = spec("mail-sync");
    expect(isDue(s, null, at("2026-09-26T10:00:05Z")).due).toBe(true);
    const ran = st("mail-sync", { lastStartedAt: at("2026-09-26T10:00:05Z"), lastStatus: "ok" });
    expect(isDue(s, ran, at("2026-09-26T10:04:59Z")).due).toBe(false);
    expect(isDue(s, ran, at("2026-09-26T10:05:01Z")).due).toBe(true);
    const hourly = st("multipark-sync", { lastStartedAt: at("2026-09-26T10:59:00Z"), lastStatus: "ok" });
    expect(isDue(spec("multipark-sync"), hourly, at("2026-09-26T11:00:30Z")).due).toBe(true);
    expect(isDue(spec("multipark-sync"), hourly, at("2026-09-26T10:59:50Z")).due).toBe(false);
  });
  it("extras-schedule: de hora a hora só entre as 08h e as 23h de Lisboa (verão e inverno)", () => {
    const s = spec("extras-schedule");
    expect(isDue(s, null, at("2026-09-26T06:59:00Z")).due).toBe(false); // 07:59 Lisboa
    expect(isDue(s, null, at("2026-09-26T07:01:00Z")).due).toBe(true);  // 08:01 Lisboa
    expect(isDue(s, null, at("2026-09-26T22:30:00Z")).due).toBe(true);  // 23:30 Lisboa
    expect(isDue(s, null, at("2026-09-26T23:05:00Z")).due).toBe(false); // 00:05 Lisboa
    expect(isDue(s, null, at("2026-12-01T07:59:00Z")).due).toBe(false); // 07:59 Lisboa (inverno)
    expect(isDue(s, null, at("2026-12-01T08:01:00Z")).due).toBe(true);
    // 14h (propor) e 18h (confirmar) caem no 1.º tick de cada hora
    const at13 = st("extras-schedule", { lastStartedAt: at("2026-09-26T12:00:10Z"), lastStatus: "ok" });
    expect(isDue(s, at13, at("2026-09-26T13:00:10Z")).due).toBe(true); // 14:00 Lisboa
    expect(isDue(s, at13, at("2026-09-26T12:55:00Z")).due).toBe(false);
  });
  it("retoma logo quando ficou a meio", () => {
    const partial = st("mail-sync", { lastStartedAt: at("2026-09-26T10:00:05Z"), lastStatus: "partial", resumeCursor: wrapCursor(null, "") });
    expect(isDue(spec("mail-sync"), partial, at("2026-09-26T10:01:00Z"))).toMatchObject({ due: true, resume: true });
  });
  it("próxima vez de um trabalho com janela salta a noite", () => {
    const s = spec("extras-schedule");
    const last = st("extras-schedule", { lastStartedAt: at("2026-09-26T22:00:00Z"), lastStatus: "ok" }); // 23:00 Lisboa
    expect(new Date(nextDueAt(s, last, at("2026-09-26T23:10:00Z"))!).toISOString()).toBe("2026-09-27T07:00:00.000Z"); // 08:00 Lisboa
  });
});

describe("diários", () => {
  const daily = spec("daily-ops");
  it("a partir das 04:30 de Lisboa, no verão e no inverno", () => {
    expect(isDue(daily, null, at("2026-09-26T03:29:00Z")).due).toBe(false);
    expect(isDue(daily, null, at("2026-09-26T03:31:00Z")).due).toBe(true);
    expect(isDue(daily, null, at("2026-12-01T04:29:00Z")).due).toBe(false);
    expect(isDue(daily, null, at("2026-12-01T04:31:00Z")).due).toBe(true);
  });
  it("dias da mudança de hora", () => {
    expect(isDue(daily, null, at("2026-03-29T03:29:00Z")).due).toBe(false); // 04:29 WEST
    expect(isDue(daily, null, at("2026-03-29T03:31:00Z")).due).toBe(true);
    expect(isDue(daily, null, at("2026-10-25T04:29:00Z")).due).toBe(false); // 04:29 WET
    expect(isDue(daily, null, at("2026-10-25T04:31:00Z")).due).toBe(true);
  });
  it("período = dia de Lisboa; feito → só amanhã", () => {
    const t = at("2026-09-26T23:30:00Z"); // 00:30 de 27 em Lisboa
    expect(periodKeyFor(daily.cadence, t)).toBe("2026-09-27");
    const done = st("daily-ops", { periodKey: "2026-09-26", lastStatus: "ok" });
    expect(isDue(daily, done, at("2026-09-26T20:00:00Z")).due).toBe(false);
    expect(isDue(daily, done, at("2026-09-27T03:31:00Z")).due).toBe(true);
    expect(new Date(nextDueAt(daily, done, at("2026-09-26T20:00:00Z"))!).toISOString()).toBe("2026-09-27T03:30:00.000Z");
  });
  it("só dá o dia como feito quando acaba; a meio guarda o cursor e retoma", () => {
    const t0 = at("2026-09-26T03:31:00Z");
    const partial = applyOutcome(daily, null, { ok: true, done: false, cursor: '{"s":["overdue"],"d":[]}', error: null, startedAt: t0, finishedAt: t0 + 40_000 });
    expect(partial).toMatchObject({ lastStatus: "partial", periodKey: null, leaseUntil: null });
    expect(cursorForRun(partial, "2026-09-26")).toBe('{"s":["overdue"],"d":[]}');
    expect(isDue(daily, partial, t0 + 5 * MIN)).toMatchObject({ due: true, resume: true });
    const done = applyOutcome(daily, partial, { ok: true, done: true, cursor: null, error: null, startedAt: t0 + 5 * MIN, finishedAt: t0 + 6 * MIN });
    expect(done).toMatchObject({ lastStatus: "ok", periodKey: "2026-09-26", resumeCursor: null, lastOkAt: t0 + 6 * MIN });
    expect(isDue(daily, done, t0 + 10 * MIN).due).toBe(false);
  });
  it("um cursor de ontem é descartado (recomeça no período novo)", () => {
    const stale = st("daily-ops", { lastStatus: "partial", resumeCursor: wrapCursor("2026-09-25", "x") });
    expect(cursorForRun(stale, "2026-09-26")).toBeNull();
    expect(isDue(daily, stale, at("2026-09-26T03:31:00Z"))).toMatchObject({ due: true, resume: false });
  });
  it("falhas: nova tentativa 30 min depois e desiste do dia à 3.ª", () => {
    let s: JobState | null = null;
    let t = at("2026-09-26T03:31:00Z");
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      s = applyOutcome(daily, s, { ok: false, done: true, cursor: null, error: "Zello em baixo", startedAt: t, finishedAt: t + 1000 });
      expect(s.attempts).toBe(i);
      if (i < MAX_ATTEMPTS) {
        expect(isDue(daily, s, t + 10 * MIN)).toMatchObject({ due: false, reason: "a aguardar nova tentativa" });
        t += RETRY_AFTER_MS + 1000;
        expect(isDue(daily, s, t).due).toBe(true);
      }
    }
    expect(s).toMatchObject({ lastStatus: "error", periodKey: "2026-09-26", lastError: "Zello em baixo" });
    expect(isDue(daily, s, t + 2 * RETRY_AFTER_MS).due).toBe(false);
    // no dia seguinte volta a tentar, com as tentativas a zero
    const next = applyOutcome(daily, s, { ok: true, done: true, cursor: null, error: null, startedAt: at("2026-09-27T03:31:00Z"), finishedAt: at("2026-09-27T03:32:00Z") });
    expect(next).toMatchObject({ attempts: 0, periodKey: "2026-09-27", lastError: null });
  });
  it("avaliação: só depois do daily-ops de hoje (ou a partir das 06:00)", () => {
    const ev = spec("evaluation-recompute");
    const t = at("2026-09-26T04:00:00Z"); // 05:00 Lisboa
    const states = new Map<string, JobState>();
    expect(isDue(ev, null, t, states)).toMatchObject({ due: false, reason: "à espera de daily-ops" });
    states.set("daily-ops", st("daily-ops", { periodKey: "2026-09-26", lastStatus: "ok" }));
    expect(isDue(ev, null, t, states).due).toBe(true);
    expect(isDue(ev, null, at("2026-09-26T05:01:00Z"), new Map()).due).toBe(true); // 06:01 Lisboa, recurso
  });
  it("hora dinâmica (Web & SEO) só atrasa, nunca adianta", () => {
    const wa = spec("web-analytics");
    expect(isDue(wa, null, at("2026-09-26T08:01:00Z"), new Map(), 7 * 60).due).toBe(true); // 09:01 Lisboa
    expect(isDue(wa, null, at("2026-09-26T08:01:00Z"), new Map(), 11 * 60).due).toBe(false);
    expect(isDue(wa, null, at("2026-09-26T10:01:00Z"), new Map(), 11 * 60).due).toBe(true);
  });
});

describe("GPS do Zello — passagem provisória (23:15–23:55 de Lisboa)", () => {
  const z = spec("zello-sameday");
  it("só dentro da janela; fora dela salta o dia (verão e inverno)", () => {
    expect(ZELLO_SAMEDAY_WINDOW).toEqual({ from: "23:15", until: "23:55" });
    expect(isDue(z, null, at("2026-09-26T22:14:00Z")).due).toBe(false); // 23:14 Lisboa
    expect(isDue(z, null, at("2026-09-26T22:16:00Z")).due).toBe(true);  // 23:16
    expect(isDue(z, null, at("2026-09-26T22:56:00Z")).due).toBe(false); // 23:56
    expect(isDue(z, null, at("2026-09-26T23:10:00Z")).due).toBe(false); // 00:10 do dia seguinte
    expect(isDue(z, null, at("2026-12-01T23:16:00Z")).due).toBe(true);  // 23:16 (inverno)
    expect(isDue(z, null, at("2026-12-01T23:56:00Z")).due).toBe(false);
  });
  it("retoma dentro da janela, nunca depois", () => {
    const t = at("2026-09-26T22:20:00Z");
    const partial = applyOutcome(z, null, { ok: true, done: false, cursor: null, error: null, startedAt: t, finishedAt: t + 40_000 });
    expect(isDue(z, partial, t + 5 * MIN)).toMatchObject({ due: true, resume: true });
    expect(isDue(z, partial, at("2026-09-26T22:56:00Z")).due).toBe(false);
    expect(new Date(nextDueAt(z, partial, at("2026-09-26T22:56:00Z"))!).toISOString()).toBe("2026-09-27T22:15:00.000Z");
  });
  it("que passagem serve cada dia: hoje → provisória; ontem → nenhuma; até D-2 → final", () => {
    const now = at("2026-09-27T21:30:00Z"); // 22:30 de 27 em Lisboa
    expect(passForDay("2026-09-27", now)).toBe("sameday");
    expect(passForDay("2026-09-26", now)).toBeNull();
    expect(passForDay("2026-09-25", now)).toBe("final");
    expect(passForDay("2026-09-20", now)).toBe("final");
  });
  it("a final substitui a provisória; a provisória retoma sem repetir e nunca toca numa final", () => {
    const existing = new Map<string, ExistingDriverRow>([
      ["ana", { id: 1, pass: "sameday", collectedAtMs: 1_000 }],
      ["rui", { id: 2, pass: "sameday", collectedAtMs: 5_000 }],
      ["eva", { id: 3, pass: "final", collectedAtMs: 1_000 }],
    ]);
    const users = ["ana", "rui", "eva", "novo"];
    expect(usersToCollect(users, existing, "final", 0)).toEqual(["ana", "rui", "novo"]);
    expect(usersToCollect(users, existing, "sameday", 2_000)).toEqual(["ana", "novo"]);
  });
});

describe("semanais (RH: regra documental à segunda)", () => {
  const w = spec("rh-docs-weekly");
  it("semana ISO", () => {
    expect(isoWeekKey("2026-09-28")).toBe("2026-W40");
    expect(isoWeekKey("2026-10-04")).toBe("2026-W40"); // domingo = mesma semana
    expect(isoWeekKey("2027-01-01")).toBe("2026-W53");
    expect(isoWeekKey("2026-01-01")).toBe("2026-W01");
  });
  it("segunda a partir das 04:45 de Lisboa; apanha nos dias seguintes da semana; feito → segunda seguinte", () => {
    expect(isDue(w, null, at("2026-09-28T03:44:00Z")).due).toBe(false); // seg 04:44
    expect(isDue(w, null, at("2026-09-28T03:46:00Z")).due).toBe(true);
    expect(isDue(w, null, at("2026-09-30T12:00:00Z")).due).toBe(true);  // quarta, ainda não feito
    const done = applyOutcome(w, null, { ok: true, done: true, cursor: null, error: null, startedAt: at("2026-09-28T03:46:00Z"), finishedAt: at("2026-09-28T03:47:00Z") });
    expect(done.periodKey).toBe("2026-W40");
    expect(isDue(w, done, at("2026-10-03T12:00:00Z")).due).toBe(false);
    expect(isDue(w, done, at("2026-10-05T03:46:00Z")).due).toBe(true);
    expect(new Date(nextDueAt(w, done, at("2026-10-01T12:00:00Z"))!).toISOString()).toBe("2026-10-05T03:45:00.000Z");
  });
  it("saiu do daily-ops (as possíveis faltas ficam lá, diárias)", () => {
    const src = readFileSync(resolve(root, "server/cronJobs.ts"), "utf8");
    const daily = src.slice(src.indexOf("export async function dailyOpsCron"), src.indexOf("export async function zelloSameDayCron"));
    expect(daily).not.toContain("applyDocsComplianceAll");
    expect(daily).toContain("detectExtraDiaNoShows");
    expect(src.slice(src.indexOf("export async function rhDocsWeeklyCron"))).toContain("applyDocsComplianceAll");
  });
});

describe("GPS antigo (v1): apagado em vez de recalculado", () => {
  it("sem a 'Fase 0' e só linhas v1 (nunca as já corrigidas)", () => {
    const src = readFileSync(resolve(root, "server/jobs/dailyDriverCollection.ts"), "utf8");
    expect(src).not.toContain("recomputeDriverHistory");
    const purge = src.slice(src.indexOf("export async function purgeLegacyDriverHistory"));
    expect(purge).toContain("SELECT id FROM daily_driver_history WHERE metricsVersion < 2");
    expect(purge).toContain("DELETE FROM daily_driver_history WHERE id IN (${list}) AND metricsVersion < 2");
    expect(purge).toContain("DELETE FROM driver_day_shares WHERE historyId IN (${list})");
    expect(readFileSync(resolve(root, "server/cronJobs.ts"), "utf8")).toContain("purgeLegacyDriverHistory({ deadlineAt: cap(");
  });
});

describe("mensais (dia 2)", () => {
  const m = spec("google-ads-monthly");
  it("dia 2 a partir das 05:45 de Lisboa; dia 1 nunca; apanha nos dias seguintes", () => {
    expect(isDue(m, null, at("2026-10-01T10:00:00Z")).due).toBe(false);
    expect(isDue(m, null, at("2026-10-02T04:44:00Z")).due).toBe(false); // 05:44 Lisboa
    expect(isDue(m, null, at("2026-10-02T04:46:00Z")).due).toBe(true);
    expect(isDue(m, null, at("2026-10-03T01:00:00Z")).due).toBe(true); // falhou o dia 2 → dia 3
    expect(isDue(m, null, at("2026-10-08T12:00:00Z")).due).toBe(true);
    // um deploy a meio do mês não volta a pedir o mês anterior
    expect(isDue(m, null, at("2026-09-26T12:00:00Z")).due).toBe(false);
    expect(new Date(nextDueAt(m, null, at("2026-09-26T12:00:00Z"))!).toISOString()).toBe("2026-10-02T04:45:00.000Z");
    expect(periodKeyFor(m.cadence, at("2026-10-02T04:46:00Z"))).toBe("2026-10");
  });
  it("feito → só no mês seguinte (dezembro → janeiro)", () => {
    const done = applyOutcome(m, null, { ok: true, done: true, cursor: null, error: null, startedAt: at("2026-12-02T05:46:00Z"), finishedAt: at("2026-12-02T05:47:00Z") });
    expect(done.periodKey).toBe("2026-12");
    expect(isDue(m, done, at("2026-12-20T10:00:00Z")).due).toBe(false);
    expect(new Date(nextDueAt(m, done, at("2026-12-20T10:00:00Z"))!).toISOString()).toBe("2027-01-02T05:45:00.000Z");
  });
  it("mesmos parâmetros dos workflows: kind daily e monthly do Google Ads e da Meta", () => {
    expect(TICK_JOBS.filter((j) => j.runName === "google-ads").map((j) => j.cadence.kind).sort()).toEqual(["daily", "monthly"]);
    expect(TICK_JOBS.filter((j) => j.runName === "meta-ads").map((j) => j.cadence.kind).sort()).toEqual(["daily", "monthly"]);
  });
});

describe("plano do tick, orçamento e lease", () => {
  it("primeiro os que retomam, depois por prioridade", () => {
    const t = at("2026-09-26T10:00:30Z");
    const states = new Map<string, JobState>([
      ["multipark-future", st("multipark-future", { lastStatus: "partial", lastStartedAt: t - 5 * MIN, resumeCursor: wrapCursor(null, "14") })],
    ]);
    const plan = planTick(TICK_JOBS, states, t);
    expect(plan[0]).toMatchObject({ key: "multipark-future", resume: true });
    const rest = plan.slice(1).map((p) => p.key);
    expect(rest.indexOf("mail-sync")).toBeLessThan(rest.indexOf("multipark-sync"));
    expect(rest).not.toContain("knowledge-sync");
    expect(rest).not.toContain("google-business");
  });
  it("orçamento de 50 s, sempre antes do prazo real da função", () => {
    expect(tickBudgetEnd(1_000_000)).toBe(1_050_000);
    expect(tickBudgetEnd(1_000_000, 1_055_000)).toBe(1_047_000);
  });
  it("um trabalho só arranca com o tempo mínimo; o prazo é o menor entre o teto e o orçamento", () => {
    expect(jobDeadline({ minMs: 20_000, maxMs: 45_000 }, 0, 15_000)).toBeNull();
    expect(jobDeadline({ minMs: 10_000, maxMs: 25_000 }, 0, 50_000)).toBe(25_000);
    expect(jobDeadline({ minMs: 10_000, maxMs: 45_000 }, 20_000, 50_000)).toBe(50_000);
  });
  it("lease livre só sem dono ou expirado", () => {
    expect(leaseFree(null, 100)).toBe(true);
    expect(leaseFree(100, 100)).toBe(true);
    expect(leaseFree(101, 100)).toBe(false);
  });
  it("uma corrida grava o fim e liberta o lease", () => {
    const s = applyOutcome(spec("mail-sync"), st("mail-sync", { leaseUntil: 999 }), { ok: false, done: true, cursor: null, error: "x".repeat(2000), startedAt: 1, finishedAt: 5 });
    expect(s).toMatchObject({ leaseUntil: null, lastStatus: "error", lastDurationMs: 4, attempts: 0, resumeCursor: null });
    expect(s.lastError!.length).toBe(1000);
  });
});

describe("registo dos trabalhos", () => {
  it("cadências pedidas (tabela do Jorge)", () => {
    const c = Object.fromEntries(TICK_JOBS.map((j) => [j.key, describeCadence(j.cadence)]));
    expect(c).toMatchObject({
      "mail-sync": "a cada 5 min", "multipark-deliveries": "a cada 15 min", "ai-comms": "a cada 15 min", "google-sync": "a cada 15 min",
      "multipark-sync": "de hora a hora", "email-inbound": "de hora a hora", "extras-auto": "de hora a hora", "identity-sweep": "de hora a hora",
      "extras-schedule": "de hora a hora (08h–23h)", "multipark-future": "a cada 2 h",
      "daily-ops": "diário a partir das 04:30", "zello-sameday": "diário das 23:15 às 23:55", "rh-docs-weekly": "semanal, segunda a partir das 04:45", "ops-briefing": "diário a partir das 07:30", "web-analytics": "diário a partir das 09:00",
      "google-ads": "diário a partir das 05:45", "meta-ads": "diário a partir das 05:45",
      "google-ads-monthly": "mensal, dia 2 a partir das 05:45", "meta-ads-monthly": "mensal, dia 2 a partir das 05:45",
    });
    expect(c["evaluation-recompute"]).toContain("depois de daily-ops");
    expect(TICK_JOBS.map((j) => j.key)).not.toEqual(expect.arrayContaining(["knowledge-sync"]));
  });
  it("cada trabalho tem função, entrada nos crons conhecidos e teto < 50 s", async () => {
    const { JOB_RUNNERS } = await import("./cronScheduler");
    const known = new Set(CRON_JOBS.map((j) => j.name));
    for (const j of TICK_JOBS) {
      expect(typeof JOB_RUNNERS[j.key], j.key).toBe("function");
      expect(known.has(j.runName), j.runName).toBe(true);
      expect(j.maxMs).toBeLessThan(50_000);
      expect(j.minMs).toBeLessThanOrEqual(j.maxMs);
    }
    expect(new Set(TICK_JOBS.map((j) => j.key)).size).toBe(TICK_JOBS.length);
  });
});

describe("extras-auto com prazo", () => {
  const steps = (log: string[], cost: Record<string, number>, clock: { t: number }) =>
    ["a", "b", "c", "d"].map((key) => ({ key, fn: async () => { log.push(key); clock.t += cost[key] ?? 1000; } }));

  it("deixa de arrancar passos perto do prazo e diz onde continuar", async () => {
    const clock = { t: 0 };
    const log: string[] = [];
    const r = await runStepsWithDeadline(steps(log, { a: 20_000, b: 20_000 }, clock), { deadlineAt: 45_000, now: () => clock.t });
    expect(log).toEqual(["a", "b"]);
    expect(r).toEqual({ done: false, nextStep: "c", started: ["a", "b"] });
  });
  it("retoma no passo guardado e acaba", async () => {
    const clock = { t: 0 };
    const log: string[] = [];
    const r = await runStepsWithDeadline(steps(log, {}, clock), { deadlineAt: 45_000, from: "c", now: () => clock.t });
    expect(log).toEqual(["c", "d"]);
    expect(r.done).toBe(true);
    expect(r.nextStep).toBeNull();
  });
  it("corre sempre pelo menos um passo (nunca fica preso) e um passo que lança não pára os outros", async () => {
    const errors: string[] = [];
    const clock = { t: 100_000 };
    const r = await runStepsWithDeadline([{ key: "x", fn: async () => { throw new Error("boom"); } }, { key: "y", fn: async () => {} }], {
      deadlineAt: 1_000_000, now: () => clock.t, onError: (k) => errors.push(k),
    });
    expect(r.done).toBe(true);
    expect(errors).toEqual(["x"]);
    const late = await runStepsWithDeadline([{ key: "x", fn: async () => {} }, { key: "y", fn: async () => {} }], { deadlineAt: 0, now: () => 10 });
    expect(late).toMatchObject({ done: false, nextStep: "y", started: ["x"] });
  });
  it("passo desconhecido no cursor → começa do início", async () => {
    const clock = { t: 0 };
    const log: string[] = [];
    await runStepsWithDeadline(steps(log, {}, clock), { deadlineAt: 45_000, from: "antigo", now: () => clock.t });
    expect(log).toEqual(["a", "b", "c", "d"]);
  });
});

describe("recolha GPS do Zello: D-2 em Lisboa", () => {
  it("às 04:30 de dia 27 o último dia disponível é o 25", () => {
    expect(zelloLatestDay(at("2026-09-27T03:30:00Z"))).toBe("2026-09-25");
  });
  it("usa o calendário de Lisboa (não o UTC) — perto da meia-noite e na mudança da hora", () => {
    expect(zelloLatestDay(at("2026-09-26T23:30:00Z"))).toBe("2026-09-25"); // 00:30 de 27 em Lisboa (verão)
    expect(zelloLatestDay(at("2026-03-29T23:30:00Z"))).toBe("2026-03-28"); // 00:30 de 30 (já verão)
    expect(zelloLatestDay(at("2026-03-28T23:30:00Z"))).toBe("2026-03-26"); // 23:30 de 28 (ainda inverno)
    expect(zelloLatestDay(at("2026-10-25T00:30:00Z"))).toBe("2026-10-23"); // 01:30 de 25 (antes de voltar à hora de inverno)
    expect(zelloLatestDay(at("2026-10-25T23:30:00Z"))).toBe("2026-10-23"); // 23:30 de 25 (inverno)
    expect(zelloLatestDay(at("2027-01-01T00:10:00Z"))).toBe("2026-12-30");
  });
  it("dias em falta dos últimos 7 (até D-2), o mais antigo primeiro", () => {
    const counts = new Map([["2026-09-19", 10], ["2026-09-20", 10], ["2026-09-21", 4], ["2026-09-22", 10], ["2026-09-24", 12]]);
    expect(pickIncompleteDays("2026-09-25", counts, 10)).toEqual(["2026-09-21", "2026-09-23", "2026-09-25"]);
    expect(pickIncompleteDays("2026-09-25", new Map(), 0)).toHaveLength(7); // sem registos = em falta
  });
  it("cursor do daily-ops tolera lixo", () => {
    expect(parseDailyOpsCursor('{"s":["overdue"],"d":["2026-09-25"],"e":["RH: x"]}')).toEqual({ s: ["overdue"], d: ["2026-09-25"], e: ["RH: x"] });
    expect(parseDailyOpsCursor("lixo")).toEqual({ s: [], d: [], e: [] });
    expect(parseDailyOpsCursor(null)).toEqual({ s: [], d: [], e: [] });
  });
});

describe("migração 0190, schema e acessos", () => {
  it("registada no ensureRecentSchema (por ordem), idempotente e espelhada no schema drizzle", async () => {
    const db = readFileSync(resolve(root, "server/db.ts"), "utf8");
    const nums = [...db.matchAll(/import\("\.\/migrations\/migration_(\d{4})"\)\.then\(m => \(\{ s: m\.MIGRATION_/g)].map((x) => Number(x[1]));
    expect(nums[nums.length - 1]).toBe(190);
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
    const { MIGRATION_0190_STATEMENTS } = await import("./migrations/migration_0190");
    expect(MIGRATION_0190_STATEMENTS[0]).toMatch(/^CREATE TABLE IF NOT EXISTS `cron_job_state`/);
    for (const s of MIGRATION_0190_STATEMENTS.slice(1)) expect(s).toMatch(/^ALTER TABLE `daily_driver_history` ADD COLUMN `/);
    expect(readFileSync(resolve(root, "drizzle/schema.ts"), "utf8")).toMatch(/mysqlTable\("cron_job_state"/);
  });
  it("o cartão do agendador é só do super admin (e só leitura)", () => {
    const src = readFileSync(resolve(root, "server/settingsRouter.ts"), "utf8");
    expect(src).toMatch(/scheduler: protectedProcedure\.query\(async \(\{ ctx \}\) => \{\s*requireSuperAdmin\(ctx\.user\.role\);/);
  });
  it("o tick exige o segredo e responde 202 com waitUntil (ou espera com ?wait=1)", () => {
    const src = readFileSync(resolve(root, "server/_core/api-entry.ts"), "utf8");
    expect(src).toMatch(/app\.get\("\/api\/cron\/tick", async \(req, res\) => \{\s*if \(!cronAuthOk\(req\)\) return res\.status\(401\)/);
    expect(src).toContain("waitUntil(work)");
    expect(src).toContain('req.query?.wait === "1"');
  });
  it("sem agendadores in-process (setInterval) no servidor", () => {
    for (const f of ["server/_core/index.ts", "server/jobs/multiparkBookingSync.ts", "server/jobs/emailInboundSync.ts", "server/jobs/dailyDriverCollection.ts"]) {
      const src = readFileSync(resolve(root, f), "utf8");
      expect(src, f).not.toMatch(/setInterval|INPROCESS_SCHEDULERS|start\w+Scheduler/);
    }
  });
});
