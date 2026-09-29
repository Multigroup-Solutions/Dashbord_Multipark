import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FALLBACK_CARS_PER_HOUR,
  MAX_SHIFT_HOURS,
  MIN_SHIFT_HOURS,
  availabilityWindow,
  bestBlock,
  canAutoConfirm,
  carsPerHourFor,
  describeGap,
  driversNeededFor,
  explainProposal,
  lisbonNow,
  notificationDone,
  pendingScheduleNotifications,
  planSchedule,
  rankCandidates,
  scheduleCronOk,
  scheduleDue,
  scheduleMessageText,
  shouldNotifyRemoval,
  summarizeGaps,
  whatsappOutcomeStatus,
  type NotifyLogRow,
  type ScheduleCandidate,
} from "../shared/extrasSchedule";
import { DEFAULT_CARS_PER_HOUR, SETTINGS, cronOutcome, hhmmToMinutes, validateSetting } from "../shared/appSettings";
import { MIGRATION_0115_STATEMENTS } from "./migrations/migration_0115";

// ─── Mocks (só para os testes de idempotência com BD simulada) ──────────────
const dbState = vi.hoisted(() => ({ affected: [] as number[], executed: [] as string[] }));
vi.mock("./db", () => ({
  getDb: async () => ({
    execute: async (q: any) => {
      dbState.executed.push(JSON.stringify(q?.queryChunks ?? q).slice(0, 200));
      return [{ affectedRows: dbState.affected.length ? dbState.affected.shift() : 0 }];
    },
    transaction: async (fn: any) => fn({ execute: async () => [{ affectedRows: 0 }] }),
  }),
  logActivity: vi.fn(async () => {}),
}));
const settingsMock = vi.hoisted(() => ({ values: new Map<string, unknown>() }));
vi.mock("./appSettings", () => ({
  getSetting: async (k: string) => (settingsMock.values.has(k) ? settingsMock.values.get(k) : null),
}));

const cand = (over: Partial<ScheduleCandidate> & { id: number }): ScheduleCandidate => ({
  fullName: `Extra ${over.id}`,
  level: "junior",
  levelLabel: "Júnior",
  hourlyRate: 4.5,
  window: { from: 3, to: 15 },
  evalScore: null,
  recentDays: 0,
  noShows: 0,
  declines: 0,
  ...over,
});
const needArr = (spec: Record<number, number>) => Array.from({ length: 27 }, (_, h) => spec[h] ?? 0);

// ─── 1. Capacidade por cidade ───────────────────────────────────────────────

describe("capacidade por cidade (carros/hora por condutor)", () => {
  it("omissões: Lisboa 2, Porto 3, Faro 3", () => {
    expect(DEFAULT_CARS_PER_HOUR).toEqual({ lisbon: 2, porto: 3, faro: 3 });
    expect(SETTINGS["extras.carsPerHourPerDriver"].defaultValue).toEqual({ lisbon: 2, porto: 3, faro: 3 });
  });
  it("Lisboa (2) pede mais condutores do que o Porto (3) para os mesmos carros", () => {
    const cars = 6;
    const lx = driversNeededFor(cars, carsPerHourFor(DEFAULT_CARS_PER_HOUR, "lisbon"));
    const po = driversNeededFor(cars, carsPerHourFor(DEFAULT_CARS_PER_HOUR, "porto"));
    expect(lx).toBe(3);
    expect(po).toBe(2);
    expect(lx).toBeGreaterThan(po);
    expect(driversNeededFor(7, 2)).toBe(4);
    expect(driversNeededFor(0, 2)).toBe(0);
    expect(driversNeededFor(4.5, 1.5)).toBe(3); // sem erro de vírgula flutuante
  });
  it("fallback 3 carros/hora quando a definição falta ou é inválida", () => {
    expect(carsPerHourFor(null, "lisbon")).toBe(FALLBACK_CARS_PER_HOUR);
    expect(carsPerHourFor({ lisbon: 0 }, "lisbon")).toBe(FALLBACK_CARS_PER_HOUR);
    expect(carsPerHourFor({ porto: 2.5 }, "porto")).toBe(2.5);
  });
  it("a previsão/sugestão de turnos usa a capacidade da cidade", async () => {
    const { suggestShifts, loadCarsPerHour } = await import("./extrasDia");
    const hourly = needArr({ 8: 6, 9: 6 });
    const lx = suggestShifts(hourly, "junior", undefined, await loadCarsPerHour("lisbon"));
    const po = suggestShifts(hourly, "junior", undefined, await loadCarsPerHour("porto"));
    expect(lx.peakDrivers).toBe(3);
    expect(po.peakDrivers).toBe(2);
    expect(lx.totalDriverHours).toBeGreaterThan(po.totalDriverHours);
    // valor editado em Definições → Parâmetros
    settingsMock.values.set("extras.carsPerHourPerDriver", { lisbon: 1, porto: 3, faro: 3 });
    expect(await loadCarsPerHour("lisbon")).toBe(1);
    expect(suggestShifts(hourly, "junior", undefined, await loadCarsPerHour("lisbon")).peakDrivers).toBe(6);
    settingsMock.values.clear();
  });
  it("a definição valida com zod (mapa por cidade)", () => {
    expect(validateSetting("extras.carsPerHourPerDriver", { lisbon: 2, porto: 3, faro: 3 }).ok).toBe(true);
    expect(validateSetting("extras.carsPerHourPerDriver", { lisbon: 2, porto: 3 }).ok).toBe(false);
    expect(validateSetting("extras.carsPerHourPerDriver", { lisbon: 0, porto: 3, faro: 3 }).ok).toBe(false);
    expect(validateSetting("extras.autoProposeAt", "14:00").ok).toBe(true);
    expect(validateSetting("extras.autoProposeAt", "25:00").ok).toBe(false);
    expect(validateSetting("extras.autoConfirm", false)).toEqual({ ok: true, value: false });
    expect(validateSetting("extras.autoProposeDaysAhead", 0).ok).toBe(false);
    expect(hhmmToMinutes("18:00")).toBe(1080);
  });
});

// ─── 2. Disponibilidade, ordenação e proposta ───────────────────────────────

describe("janela de disponibilidade", () => {
  const base = { status: "available", morning: false, night: false, fromHour: null, toHour: null };
  it("turnos e horas (madrugada = dia seguinte)", () => {
    expect(availabilityWindow({ ...base, morning: true })).toEqual({ from: 3, to: 15 });
    expect(availabilityWindow({ ...base, night: true })).toEqual({ from: 15, to: 27 });
    expect(availabilityWindow({ ...base, morning: true, night: true })).toEqual({ from: 3, to: 27 });
    expect(availabilityWindow({ ...base, fromHour: 7, toHour: 12 })).toEqual({ from: 7, to: 12 });
    expect(availabilityWindow({ ...base, fromHour: 22, toHour: 2 })).toEqual({ from: 22, to: 26 });
  });
  it("sem disponibilidade → null", () => {
    expect(availabilityWindow({ ...base, status: "no_response", morning: true })).toBeNull();
    expect(availabilityWindow({ ...base, status: "unavailable" })).toBeNull();
    expect(availabilityWindow(null)).toBeNull();
  });
});

describe("turno mínimo e máximo", () => {
  it("nunca menos de 3h (alarga dentro da janela)", () => {
    const b = bestBlock({ from: 3, to: 15 }, needArr({ 10: 1 }));
    expect(b).not.toBeNull();
    expect(b!.endHour - b!.startHour).toBe(MIN_SHIFT_HOURS);
    expect(b!.startHour).toBe(10);
  });
  it("janela mais curta que o mínimo → não entra", () => {
    expect(bestBlock({ from: 9, to: 11 }, needArr({ 9: 1, 10: 1 }))).toBeNull();
  });
  it("nunca mais de 12h", () => {
    const need = needArr(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [5 + i, 1])));
    const b = bestBlock({ from: 3, to: 27 }, need)!;
    expect(b.endHour - b.startHour).toBe(MAX_SHIFT_HOURS);
    expect(b.coveredHours).toBe(12);
  });
  it("dois picos afastados → turno curto (não paga horas paradas)", () => {
    const b = bestBlock({ from: 3, to: 15 }, needArr({ 8: 1, 9: 1, 14: 1 }))!;
    expect([b.startHour, b.endHour]).toEqual([8, 11]);
  });
  it("a proposta respeita os limites em todas as linhas", () => {
    const plan = planSchedule({
      needed: needArr({ 6: 2, 7: 2, 8: 3, 9: 3, 10: 3, 11: 2, 12: 2, 13: 1, 14: 2, 15: 2, 16: 2, 17: 1, 18: 1, 19: 1, 20: 1, 21: 1 }),
      existing: [],
      candidates: [1, 2, 3, 4, 5].map((id) => cand({ id, window: { from: 3, to: 27 } })),
    });
    for (const p of plan.picks) {
      expect(p.endHour - p.startHour).toBeGreaterThanOrEqual(MIN_SHIFT_HOURS);
      expect(p.endHour - p.startHour).toBeLessThanOrEqual(MAX_SHIFT_HOURS);
    }
  });
});

describe("ordenação dos candidatos", () => {
  const remaining = needArr({ 8: 1, 9: 1, 10: 1 });
  it("avaliação mais alta primeiro (mesma cobertura e custo)", () => {
    const r = rankCandidates([cand({ id: 1, evalScore: 5 }), cand({ id: 2, evalScore: 30 })], remaining);
    expect(r.map((x) => x.candidate.id)).toEqual([2, 1]);
  });
  it("mais barato primeiro (mesma avaliação)", () => {
    const r = rankCandidates([cand({ id: 1, hourlyRate: 6, level: "master" }), cand({ id: 2, hourlyRate: 4.5 })], remaining);
    expect(r[0].candidate.id).toBe(2);
  });
  it("equidade: quem foi menos escalado recentemente primeiro", () => {
    const r = rankCandidates([cand({ id: 1, recentDays: 6 }), cand({ id: 2, recentDays: 0 })], remaining);
    expect(r[0].candidate.id).toBe(2);
  });
  it("faltas e recusas recentes penalizam", () => {
    const r = rankCandidates([cand({ id: 1, noShows: 1 }), cand({ id: 2 }), cand({ id: 3, declines: 2 })], remaining);
    expect(r.map((x) => x.candidate.id)).toEqual([2, 3, 1]);
  });
  it("cobertura pesa mais: quem cobre as horas em falta passa à frente", () => {
    const r = rankCandidates([
      cand({ id: 1, evalScore: 40, window: { from: 10, to: 13 } }), // só cobre 1h
      cand({ id: 2, evalScore: 10, window: { from: 7, to: 15 } }), // cobre 3h
    ], remaining);
    expect(r[0].candidate.id).toBe(2);
  });
  it("determinístico: empate → nome e id", () => {
    const a = rankCandidates([cand({ id: 2, fullName: "Bea" }), cand({ id: 1, fullName: "Ana" })], remaining);
    const b = rankCandidates([cand({ id: 1, fullName: "Ana" }), cand({ id: 2, fullName: "Bea" })], remaining);
    expect(a.map((x) => x.candidate.id)).toEqual([1, 2]);
    expect(b.map((x) => x.candidate.id)).toEqual([1, 2]);
  });
  it("sem janela (não disponível) não entra", () => {
    expect(rankCandidates([cand({ id: 1, window: null })], remaining)).toEqual([]);
  });
});

describe("proposta e buracos", () => {
  it("preenche com os disponíveis e lista o que falta (com o porquê)", () => {
    const plan = planSchedule({
      needed: needArr({ 8: 3, 9: 3, 14: 2, 15: 2 }),
      existing: [],
      candidates: [
        cand({ id: 1, fullName: "Ana", evalScore: 28 }),
        cand({ id: 2, fullName: "Bruno", evalScore: 5, window: { from: 7, to: 12 } }),
        cand({ id: 3, fullName: "Carla", window: { from: 15, to: 27 }, level: "senior", levelLabel: "Sénior", hourlyRate: 5 }),
        cand({ id: 4, fullName: "Duarte", evalScore: 15, noShows: 1 }),
      ],
    });
    expect(plan.picks.map((p) => p.personName)).toEqual(["Ana", "Duarte", "Bruno", "Carla"]);
    expect(plan.gaps).toEqual([{ fromHour: 15, toHour: 16, missing: 1 }]);
    expect(describeGap(plan.gaps[0])).toBe("falta 1 condutor entre 15h–16h");
    const ana = plan.picks[0];
    expect(ana.reason).toMatch(/avaliação 28,0 pts\/dia \(1\.º de 3\)/);
    expect(ana.reason).toMatch(/Júnior 4,50 €\/h/);
    expect(plan.picks[1].reason).toMatch(/1 falta\(s\)/);
    // alargado para cobrir as 14h (já não havia mais ninguém livre)
    expect([ana.startHour, ana.endHour]).toEqual([8, 15]);
    expect(ana.reason).toMatch(/turno alargado/);
  });
  it("conta quem já está escalado e não repete pessoas excluídas", () => {
    const plan = planSchedule({
      needed: needArr({ 8: 2, 9: 2, 10: 2 }),
      existing: [{ startHour: 8, endHour: 11 }],
      candidates: [cand({ id: 1 }), cand({ id: 2 })],
      exclude: new Set([1]),
    });
    expect(plan.picks.map((p) => p.employeeId)).toEqual([2]);
    expect(plan.gaps).toEqual([]);
  });
  it("sem ninguém disponível → tudo em buraco", () => {
    const plan = planSchedule({ needed: needArr({ 14: 2, 15: 2, 16: 1 }), existing: [], candidates: [] });
    expect(plan.picks).toEqual([]);
    expect(plan.gaps.map(describeGap)).toEqual(["faltam 2 condutores entre 14h–17h"]);
  });
  it("buracos agrupados por horas seguidas", () => {
    expect(summarizeGaps(needArr({ 5: 1, 6: 2, 9: 1 }))).toEqual([
      { fromHour: 5, toHour: 7, missing: 2 },
      { fromHour: 9, toHour: 10, missing: 1 },
    ]);
  });
  it("explainProposal: texto determinístico (gancho para a IA)", () => {
    const t = explainProposal({
      date: "2026-09-25", city: "lisbon", carsPerHour: 2, peakDrivers: 3, peakHour: 8,
      picks: [{ personName: "Ana", startHour: 8, endHour: 11, hourlyRate: 4.5 }], keptCount: 1,
      gaps: [{ fromHour: 14, toHour: 17, missing: 2 }],
    });
    expect(t).toBe("Proposta para sexta 25/09 em Lisboa: 1 condutor(es) propostos (3h, 13,50 €) além de 1 já escalado(s). Capacidade 2 carros/hora por condutor; pico de 3 condutor(es) às 08h. Atenção: faltam 2 condutores entre 14h–17h.");
  });
  it("texto do aviso: dia, horas, cidade e ponto de encontro", () => {
    expect(scheduleMessageText({ date: "2026-09-25", city: "porto", spans: [{ startHour: 15, endHour: 27 }], meetingPoint: " Portão A " }))
      .toBe("sexta 25/09, das 15h às 03h · Porto · ponto de encontro: Portão A");
    expect(scheduleMessageText({ date: "2026-09-25", city: "lisbon", spans: [{ startHour: 14, endHour: 17 }, { startHour: 6, endHour: 9 }] }))
      .toBe("sexta 25/09, das 06h às 09h e das 14h às 17h · Lisboa");
  });
});

// ─── 3. Horários (Lisboa), confirmação automática e cron ────────────────────

describe("horários em hora de Lisboa", () => {
  const s = { autoProposeAtMin: 14 * 60, daysAhead: 2, autoConfirm: true, autoConfirmAtMin: 18 * 60 };
  it("lisbonNow: verão UTC+1, inverno UTC+0", () => {
    expect(lisbonNow(new Date("2026-09-24T12:59:00Z"))).toEqual({ date: "2026-09-24", minutes: 13 * 60 + 59 });
    expect(lisbonNow(new Date("2026-12-10T14:00:00Z"))).toEqual({ date: "2026-12-10", minutes: 14 * 60 });
    expect(lisbonNow(new Date("2026-09-24T23:30:00Z"))).toEqual({ date: "2026-09-25", minutes: 30 });
  });
  it("proposta a partir das 14:00 de Lisboa, para amanhã … +N", () => {
    expect(scheduleDue(lisbonNow(new Date("2026-09-24T12:59:00Z")), s).proposeDates).toEqual([]); // 13:59 Lisboa
    expect(scheduleDue(lisbonNow(new Date("2026-09-24T13:00:00Z")), s).proposeDates).toEqual(["2026-09-25", "2026-09-26"]); // 14:00
  });
  it("confirmação automática a partir das 18:00 de Lisboa, só para amanhã", () => {
    expect(scheduleDue(lisbonNow(new Date("2026-09-24T16:59:00Z")), s).confirmDates).toEqual([]); // 17:59
    expect(scheduleDue(lisbonNow(new Date("2026-09-24T17:00:00Z")), s).confirmDates).toEqual(["2026-09-25"]); // 18:00
    // inverno: 18:00 Lisboa = 18:00 UTC
    expect(scheduleDue(lisbonNow(new Date("2026-12-10T17:30:00Z")), s).confirmDates).toEqual([]);
    expect(scheduleDue(lisbonNow(new Date("2026-12-10T18:00:00Z")), s).confirmDates).toEqual(["2026-12-11"]);
    expect(scheduleDue(lisbonNow(new Date("2026-09-24T20:00:00Z")), { ...s, autoConfirm: false }).confirmDates).toEqual([]);
  });
  it("só confirma propostas por confirmar e não suspensas", () => {
    expect(canAutoConfirm({ status: "proposed", holdAuto: false })).toBe(true);
    expect(canAutoConfirm({ status: "proposed", holdAuto: true })).toBe(false);
    expect(canAutoConfirm({ status: "confirmed", holdAuto: false })).toBe(false);
    expect(canAutoConfirm(null)).toBe(false);
  });
  it("cron: ok honesto — erros ficam vermelhos, avisos não", () => {
    expect(scheduleCronOk({ errors: [] })).toBe(true);
    expect(scheduleCronOk({ errors: ["propose:x: boom"] })).toBe(false);
    const green = { ok: scheduleCronOk({ errors: [] }), warnings: ["WhatsApp não configurado — só email"], errors: [] };
    expect(cronOutcome(200, green).ok).toBe(true);
    expect(cronOutcome(200, green).note).toMatch(/WhatsApp não configurado/);
    const red = { ok: scheduleCronOk({ errors: ["confirm:x: falhou"] }), errors: ["confirm:x: falhou"] };
    expect(cronOutcome(200, red)).toEqual({ ok: false, error: "confirm:x: falhou" });
  });
});

// ─── 4. Avisos: deduplicação, versões e STOP ────────────────────────────────

describe("deduplicação dos avisos", () => {
  const rows = [
    { id: 1, version: 1, status: "confirmed", employeeId: 11 },
    { id: 2, version: 2, status: "confirmed", employeeId: 12 },
    { id: 3, version: 1, status: "proposed", employeeId: 13 },
    { id: 4, version: 1, status: "confirmed", employeeId: null },
  ];
  const log = (over: Partial<NotifyLogRow>): NotifyLogRow => ({ assignmentId: 1, version: 1, kind: "scheduled", channel: "whatsapp", status: "sent", attempts: 1, ...over });
  it("só linhas confirmadas com pessoa; propostas nunca são avisadas", () => {
    expect(pendingScheduleNotifications(rows, [], "whatsapp").map((r) => r.id)).toEqual([1, 2]);
  });
  it("1 aviso por versão e canal: enviado não repete, nova versão volta a avisar", () => {
    const l = [log({ assignmentId: 1 }), log({ assignmentId: 2, version: 1 })];
    expect(pendingScheduleNotifications(rows, l, "whatsapp").map((r) => r.id)).toEqual([2]); // v2 ainda não
    expect(pendingScheduleNotifications(rows, l, "email").map((r) => r.id)).toEqual([1, 2]); // canal diferente
  });
  it("falhado repete até 3 tentativas", () => {
    expect(notificationDone({ id: 1, version: 1 }, [log({ status: "failed", attempts: 2 })], "scheduled", "whatsapp")).toBe(false);
    expect(notificationDone({ id: 1, version: 1 }, [log({ status: "failed", attempts: 3 })], "scheduled", "whatsapp")).toBe(true);
  });
  it("avisos antigos (antes da 0115) contam como enviados na versão 1", () => {
    expect(pendingScheduleNotifications(rows, [], "whatsapp", new Set([1])).map((r) => r.id)).toEqual([2]);
  });
  it("STOP (opt-out) do WhatsApp é final — não se volta a tentar", () => {
    expect(whatsappOutcomeStatus("opted_out")).toBe("opted_out");
    expect(notificationDone({ id: 1, version: 1 }, [log({ status: "opted_out" })], "scheduled", "whatsapp")).toBe(true);
    expect(whatsappOutcomeStatus("invalid_phone")).toBe("invalid");
    expect(whatsappOutcomeStatus("sent")).toBe("sent");
    expect(whatsappOutcomeStatus(undefined)).toBe("no_contact");
    expect(whatsappOutcomeStatus("failed")).toBe("failed");
  });
  it("remoção: só avisa quem saiu de uma escala confirmada e já tinha sido avisado", () => {
    expect(shouldNotifyRemoval({ status: "confirmed", employeeId: 1 }, true)).toBe(true);
    expect(shouldNotifyRemoval({ status: "confirmed", employeeId: 1 }, false)).toBe(false);
    expect(shouldNotifyRemoval({ status: "proposed", employeeId: 1 }, true)).toBe(false);
    expect(shouldNotifyRemoval({ status: "confirmed", employeeId: null }, true)).toBe(false);
  });
  it("versão sobe quando mudam pessoa/dia/horas (não com 'mandado para casa')", async () => {
    const { assignmentVersionChanged } = await import("./extrasDia");
    const a = { employeeId: 1, assignmentDate: "2026-09-25", startHour: 8, endHour: 14, shift: "morning", personName: "Ana" };
    expect(assignmentVersionChanged(a, { ...a })).toBe(false);
    expect(assignmentVersionChanged(a, { ...a, endHour: 15 })).toBe(true);
    expect(assignmentVersionChanged(a, { ...a, employeeId: 2 })).toBe(true);
    expect(assignmentVersionChanged(a, { ...a, assignmentDate: "2026-09-26" })).toBe(true);
  });
});

describe("idempotência de propor e confirmar (BD simulada)", () => {
  beforeEach(() => { dbState.affected = []; dbState.executed = []; });
  it("o cron não propõe um dia que já tem proposta/escala (reserva falha → nada muda)", async () => {
    const { proposeSchedule } = await import("./extrasSchedule");
    dbState.affected = [0]; // INSERT IGNORE do estado não inseriu
    const r = await proposeSchedule({ date: "2026-09-25", city: "lisbon", by: "auto", userId: null });
    expect(r.status).toBe("skipped");
    expect(dbState.executed.length).toBe(1); // só a tentativa de reserva
  });
  it("confirmar automaticamente outra vez não reconfirma nem reenvia", async () => {
    const { confirmSchedule } = await import("./extrasSchedule");
    dbState.affected = [0]; // UPDATE … WHERE status='proposed' AND holdAuto=0 não mexeu
    const r = await confirmSchedule({ date: "2026-09-25", city: "lisbon", by: "auto", userId: null });
    expect(r).toEqual({ status: "skipped", reason: "sem proposta por confirmar ou envio suspenso", confirmed: 0, notifications: null });
    expect(dbState.executed.length).toBe(1);
  });
  it("reserva do aviso: só quem insere (ou retoma uma falha) envia", async () => {
    const { claimNotification } = await import("./extrasSchedule");
    const a = { id: 1, version: 1, employeeId: 11, assignmentDate: "2026-09-25", city: "lisbon" };
    dbState.affected = [1];
    expect(await claimNotification(a, "scheduled", "whatsapp")).toBe(true);
    dbState.affected = [0, 0]; // já existe e não está falhada
    expect(await claimNotification(a, "scheduled", "whatsapp")).toBe(false);
    dbState.affected = [0, 1]; // existia falhada (< 3 tentativas) → retoma
    expect(await claimNotification(a, "scheduled", "whatsapp")).toBe(true);
  });
});

// ─── Migração 0115 ──────────────────────────────────────────────────────────

describe("migração 0115", () => {
  it("idempotente: sem UPDATE, tabelas com IF NOT EXISTS", () => {
    const all = MIGRATION_0115_STATEMENTS.join("\n");
    expect(MIGRATION_0115_STATEMENTS.some((x) => /^\s*UPDATE\b/i.test(x))).toBe(false);
    for (const st of MIGRATION_0115_STATEMENTS.filter((x) => x.startsWith("CREATE TABLE"))) expect(st).toMatch(/IF NOT EXISTS/);
    expect(all).toContain("`status` VARCHAR(12) NOT NULL DEFAULT 'confirmed'");
    expect(all).toContain("UNIQUE KEY `uq_edn_version` (`assignmentId`, `version`, `kind`, `channel`)");
  });
  it("registada no ensureRecentSchema e no schema drizzle", () => {
    const root = resolve(__dirname, "..");
    expect(readFileSync(resolve(root, "server/db.ts"), "utf8")).toContain('import("./migrations/migration_0115")');
    const schema = readFileSync(resolve(root, "drizzle/schema.ts"), "utf8");
    expect(schema).toContain('mysqlTable("extras_dia_schedules"');
    expect(schema).toContain('mysqlTable("extras_dia_notifications"');
  });
});
