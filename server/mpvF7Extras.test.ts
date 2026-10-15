/**
 * Plano MPV F7 (§6.1) — Extras Dia: cadência de 15 min, proposta às 11:00 e
 * confirmação às 15:00, lembretes às 10:30 e 14:30, novas tentativas com
 * espera crescente (15:00 → 15:30 → 16:30 → 18:00 → aviso), dia mexido à mão
 * (D4b, as 3 opções) e a quem vão os lembretes (D4c).
 *
 * Nada de BD real, IA, WhatsApp nem email: o relógio é simulado e o trabalho
 * corre com dependências falsas (o mesmo código de produção, só as pontas
 * trocadas). A reserva dos avisos (claimNotification) corre contra uma BD
 * falsa que só responde ao SQL.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_NOTIFY_ATTEMPTS, autoConfirmDecision, lisbonNow, notifyExhausted, notifyRetryDue, notificationDone, scheduleCoverage, scheduleDue, settlesAfterLastRun,
  unnotifiedAfterRetries, type Gap,
} from "../shared/extrasSchedule";
import {
  DEFAULT_REMINDER_RECIPIENTS, REMINDER_ROLES, describeReminderRule, isoWeekday, reminderAppliesOn, reminderMessage, reminderRecipientFilter, reminderRecipientsSchema, remindersDue,
} from "../shared/extrasReminders";
import { AUTOMATION_FLAGS, CRON_JOBS, SETTINGS, automationFlagDefault, hhmmToMinutes, validateSetting } from "../shared/appSettings";
import { TICK_JOBS, describeCadence, isDue } from "./cronSchedule";
import { kindDef, resolveRecipients, type RoutingCandidate } from "../shared/notificationRouting";
import { NOT_EXTRA_NOTICE_REASON } from "../shared/shiftNotice";

// ─── BD falsa (só para a reserva dos avisos) ────────────────────────────────
const fake = vi.hoisted(() => ({ inserted: 0, row: null as null | { status: string; attempts: number; ageS: number; maxAttempts?: number }, updated: 1, queries: [] as string[] }));
vi.mock("./db", () => ({
  getDb: async () => ({
    execute: async (q: any) => {
      const { MySqlDialect: D } = await import("drizzle-orm/mysql-core");
      const text = new D().sqlToQuery(q).sql;
      fake.queries.push(text);
      if (/^\s*INSERT IGNORE INTO extras_dia_notifications/i.test(text)) return [{ affectedRows: fake.inserted }];
      if (/^\s*SELECT status, attempts/i.test(text)) return [fake.row ? [fake.row] : []];
      if (/^\s*UPDATE extras_dia_notifications/i.test(text)) return [{ affectedRows: fake.updated }];
      return [[]];
    },
    transaction: async (fn: any) => fn({ execute: async () => [{ affectedRows: 0 }] }),
  }),
  logActivity: vi.fn(async () => {}),
}));
vi.mock("./appSettings", () => ({ getSetting: async () => null }));

beforeEach(() => { fake.inserted = 0; fake.row = null; fake.updated = 1; fake.queries = []; });

// ─── Definições e registo ───────────────────────────────────────────────────

describe("definições (D4, D4b, D4c)", () => {
  it("proposta às 11:00 e confirmação às 15:00 por omissão (nomes: extras.autoProposeAt / extras.autoConfirmAt)", () => {
    expect(SETTINGS["extras.autoProposeAt"].defaultValue).toBe("11:00");
    expect(SETTINGS["extras.autoConfirmAt"].defaultValue).toBe("15:00");
    expect(SETTINGS["extras.autoConfirm"].defaultValue).toBe(true);
  });
  it("D4b: três opções; omissão 'confirm' (o comportamento de hoje) até o Jorge decidir", () => {
    expect(SETTINGS["extras.manualEditAtConfirm"].defaultValue).toBe("confirm");
    for (const v of ["confirm", "skip_notify", "if_older_30m"]) expect(validateSetting("extras.manualEditAtConfirm", v)).toEqual({ ok: true, value: v });
    expect(validateSetting("extras.manualEditAtConfirm", "talvez").ok).toBe(false);
  });
  it("D4c: por cidade, papéis + dias + contas; omissão TL e supervisor todos os dias; admin só como conta juntada", () => {
    expect(SETTINGS["extras.reminderRecipients"].defaultValue).toEqual(DEFAULT_REMINDER_RECIPIENTS);
    for (const c of ["lisbon", "porto", "faro"] as const) {
      expect(DEFAULT_REMINDER_RECIPIENTS[c]).toEqual({ roles: ["team_leader", "supervisor"], days: [1, 2, 3, 4, 5, 6, 7], userIds: [] });
    }
    expect(REMINDER_ROLES as readonly string[]).not.toContain("admin");
    // Os papéis que se escolhem são os do tipo de notificação (senão nunca recebiam).
    for (const r of REMINDER_ROLES) expect(kindDef("extras_reminder")!.roles).toContain(r);
    const v = validateSetting("extras.reminderRecipients", { ...DEFAULT_REMINDER_RECIPIENTS, lisbon: { roles: ["backoffice"], days: [5, 1, 1], userIds: [9, 9] } });
    expect(v.ok && (v.value as any).lisbon).toEqual({ roles: ["backoffice"], days: [1, 5], userIds: [9] });
    expect(reminderRecipientsSchema.safeParse({ ...DEFAULT_REMINDER_RECIPIENTS, porto: { roles: ["admin"], days: [], userIds: [] } }).success).toBe(false);
    expect(validateSetting("extras.reminderRecipients", { ...DEFAULT_REMINDER_RECIPIENTS, faro: { roles: [], days: [8], userIds: [] } }).ok).toBe(false);
    expect(describeReminderRule(DEFAULT_REMINDER_RECIPIENTS.lisbon)).toBe("Team leader, Supervisor (todos os dias)");
  });
  it("interruptores novos (regra da casa): lembretes, avisos da escala e 'completar' desligados por omissão", () => {
    expect(automationFlagDefault("EXTRAS_REMINDERS")).toBe(false);
    expect(automationFlagDefault("EXTRAS_SCHEDULE_ALERTS")).toBe(false);
    expect(automationFlagDefault("EXTRAS_COMPLETE_BEFORE_CONFIRM")).toBe(false);
    expect(AUTOMATION_FLAGS.map((f) => f.name)).toEqual(expect.arrayContaining(["EXTRAS_REMINDERS", "EXTRAS_SCHEDULE_ALERTS", "EXTRAS_COMPLETE_BEFORE_CONFIRM"]));
  });
  it("tipos de notificação: falhas a TL + supervisor + back office (e admins, por omissão), com email", () => {
    expect(kindDef("extras_reminder")).toMatchObject({ module: "extras_dia", cityScoped: true, personal: false });
    expect(kindDef("extras_schedule_alert")).toMatchObject({ module: "extras_dia", roles: ["team_leader", "supervisor", "backoffice"], emailDefault: true });
    let id = 1;
    const p = (role: string, cities: RoutingCandidate["cities"]): RoutingCandidate => ({ id: id++, role, isActive: true, email: `p${id}@x.pt`, cities, accessOverrides: {}, prefs: { muted: [], email: {} } });
    const people = [p("admin", "all"), p("supervisor", ["lisbon"]), p("team_leader", ["porto"]), p("backoffice", ["lisbon"])];
    expect(resolveRecipients({ kind: "extras_schedule_alert", city: "lisbon" }, people).map((r) => r.userId).sort()).toEqual([1, 2, 4]);
  });
});

describe("agendador: extras-schedule de 15 em 15 min e o trabalho novo extras-reminders", () => {
  const spec = (k: string) => TICK_JOBS.find((j) => j.key === k)!;
  it("cadências", () => {
    expect(describeCadence(spec("extras-schedule").cadence)).toBe("a cada 15 min (08h–23h)");
    expect(describeCadence(spec("extras-reminders").cadence)).toBe("a cada 15 min (08h–23h)");
    expect(spec("extras-reminders").priority).toBeGreaterThan(spec("extras-schedule").priority); // depois da escala no mesmo tick
  });
  it("15 min: 11:00 e 15:00 caem no 1.º tick dessa fatia; fora das 08h–23h não corre", () => {
    const s = spec("extras-schedule");
    const st = (lastStartedAt: number) => ({ jobKey: s.key, lastStartedAt, lastFinishedAt: lastStartedAt, lastOkAt: lastStartedAt, lastStatus: "ok" as const, lastError: null, lastDurationMs: 1, resumeCursor: null, periodKey: null, attempts: 0, leaseUntil: null });
    const at = (iso: string) => Date.parse(iso);
    expect(isDue(s, st(at("2026-10-21T09:45:10Z")), at("2026-10-21T10:00:10Z")).due).toBe(true); // 11:00 Lisboa
    expect(isDue(s, st(at("2026-10-21T10:00:10Z")), at("2026-10-21T10:10:00Z")).due).toBe(false);
    expect(isDue(s, st(at("2026-10-21T13:45:10Z")), at("2026-10-21T14:00:10Z")).due).toBe(true); // 15:00 Lisboa
    expect(isDue(s, null, at("2026-10-21T06:30:00Z")).due).toBe(false); // 07:30 Lisboa
  });
  it("registado como os outros: função, CRON_JOBS, endpoint e agendador.md", async () => {
    const { JOB_RUNNERS } = await import("./cronScheduler");
    expect(typeof JOB_RUNNERS["extras-reminders"]).toBe("function");
    expect(CRON_JOBS.find((j) => j.name === "extras-reminders")).toMatchObject({ intervalMinutes: 300, workflow: "tick" });
    const api = readFileSync(resolve(__dirname, "_core/api-entry.ts"), "utf8");
    expect(api).toContain('app.get("/api/cron/extras-reminders"');
    const doc = readFileSync(resolve(__dirname, "../docs/ajuda/agendador.md"), "utf8");
    expect(doc).toContain("extras-reminders");
    expect(doc).toMatch(/de 15 em 15 min, das 08h às 23h/);
  });
});

// ─── Regras puras ───────────────────────────────────────────────────────────

describe("novas tentativas com espera crescente (30 × tentativas min)", () => {
  const min = 60_000;
  it("falhada à 1.ª: espera 30 min; à 2.ª 60; à 3.ª 90; à 4.ª esgotou", () => {
    expect(MAX_NOTIFY_ATTEMPTS).toBe(4);
    expect(notifyRetryDue({ status: "failed", attempts: 1, ageMs: 15 * min })).toBe(false);
    expect(notifyRetryDue({ status: "failed", attempts: 1, ageMs: 30 * min - 20_000 })).toBe(true); // a corrida 30 min depois (folga)
    expect(notifyRetryDue({ status: "failed", attempts: 2, ageMs: 45 * min })).toBe(false);
    expect(notifyRetryDue({ status: "failed", attempts: 2, ageMs: 60 * min })).toBe(true);
    expect(notifyRetryDue({ status: "failed", attempts: 3, ageMs: 75 * min })).toBe(false);
    expect(notifyRetryDue({ status: "failed", attempts: 3, ageMs: 90 * min })).toBe(true);
    expect(notifyRetryDue({ status: "failed", attempts: 4, ageMs: 999 * min })).toBe(false);
    expect(notifyExhausted({ status: "failed", attempts: 4 })).toBe(true);
    expect(notifyRetryDue({ status: "sent", attempts: 1, ageMs: 999 * min })).toBe(false);
  });
  it("deploy: as falhas de antes do F7 (teto 3 na 0705) que já estavam esgotadas NÃO ganham uma 4.ª", () => {
    expect(notifyRetryDue({ status: "failed", attempts: 3, ageMs: 999 * min, maxAttempts: 3 })).toBe(false);
    expect(notifyExhausted({ status: "failed", attempts: 3, maxAttempts: 3 })).toBe(true);
    expect(notificationDone({ id: 1, version: 1 }, [{ assignmentId: 1, version: 1, kind: "scheduled", channel: "whatsapp", status: "failed", attempts: 3, maxAttempts: 3 }], "scheduled", "whatsapp")).toBe(true);
    expect(notificationDone({ id: 1, version: 1 }, [{ assignmentId: 1, version: 1, kind: "scheduled", channel: "whatsapp", status: "failed", attempts: 3, maxAttempts: 4 }], "scheduled", "whatsapp")).toBe(false);
    const sql = readFileSync(resolve(__dirname, "migrations/migration_0705.ts"), "utf8");
    expect(sql).toContain("ALTER TABLE `extras_dia_notifications` ADD COLUMN `maxAttempts` INT NOT NULL DEFAULT 3");
  });
  it("quem ficou por avisar: NENHUM canal chegou — esgotado, inválido, sem contacto ou STOP; funcionários de fora", () => {
    const r = (o: any) => ({ assignmentId: 1, version: 1, channel: "whatsapp", status: "failed", attempts: 4, personName: "Ana Silva", detail: null, ...o });
    expect(unnotifiedAfterRetries([r({})])).toEqual([{ assignmentId: 1, version: 1, personName: "Ana Silva", channels: ["whatsapp"], reasons: ["WhatsApp: falhou em todas as tentativas"] }]);
    expect(unnotifiedAfterRetries([r({}), r({ channel: "email", status: "sent", attempts: 1 })])).toEqual([]); // o email chegou
    expect(unnotifiedAfterRetries([r({}), r({ channel: "email", status: "failed", attempts: 2 })])).toEqual([]); // o email ainda vai tentar
    expect(unnotifiedAfterRetries([r({ attempts: 3 })])).toEqual([]);
    for (const status of ["invalid", "no_contact", "opted_out"]) {
      expect(unnotifiedAfterRetries([r({ status, attempts: 1 }), r({ channel: "email", status: "no_contact", attempts: 1 })]).length, status).toBe(1);
    }
    expect(unnotifiedAfterRetries([r({ status: "no_contact", attempts: 1, detail: NOT_EXTRA_NOTICE_REASON })], NOT_EXTRA_NOTICE_REASON)).toEqual([]);
  });
});

describe("reserva do aviso (claimNotification) contra a BD falsa", () => {
  const a = { id: 7, version: 2, employeeId: 11, assignmentDate: "2026-10-22", city: "lisbon" };
  it("nova → envia (com o teto novo); falhada há 10 min (1 tentativa) → não; há 30 min → sim, com reserva compare-and-set", async () => {
    const { claimNotification } = await import("./extrasSchedule");
    fake.inserted = 1;
    expect(await claimNotification(a, "scheduled", "whatsapp")).toBe(true);
    expect(fake.queries[0]).toMatch(/maxAttempts/);
    fake.inserted = 0; fake.row = { status: "failed", attempts: 1, ageS: 600, maxAttempts: 4 };
    expect(await claimNotification(a, "scheduled", "whatsapp")).toBe(false);
    expect(fake.queries.some((q) => /^\s*UPDATE/i.test(q))).toBe(false);
    fake.row = { status: "failed", attempts: 1, ageS: 30 * 60, maxAttempts: 4 };
    fake.queries = [];
    expect(await claimNotification(a, "scheduled", "whatsapp")).toBe(true);
    const upd = fake.queries.find((q) => /^\s*UPDATE/i.test(q))!;
    expect(upd).toMatch(/status = \?/);
    expect(upd).toMatch(/attempts = \?/);
    fake.updated = 0; // outra corrida ganhou
    expect(await claimNotification(a, "scheduled", "whatsapp")).toBe(false);
  });
  it("esgotada (4, ou 3 numa linha de antes do F7) nunca mais; 'sending' esquecida há mais de 15 min volta", async () => {
    const { claimNotification } = await import("./extrasSchedule");
    fake.row = { status: "failed", attempts: 4, ageS: 10 * 3600, maxAttempts: 4 };
    expect(await claimNotification(a, "scheduled", "email")).toBe(false);
    fake.row = { status: "failed", attempts: 3, ageS: 10 * 3600, maxAttempts: 3 };
    expect(await claimNotification(a, "scheduled", "email")).toBe(false);
    fake.row = { status: "sending", attempts: 1, ageS: 16 * 60, maxAttempts: 4 };
    expect(await claimNotification(a, "scheduled", "email")).toBe(true);
    fake.row = { status: "sending", attempts: 1, ageS: 5 * 60, maxAttempts: 4 };
    expect(await claimNotification(a, "scheduled", "email")).toBe(false);
  });
});

describe("dia mexido à mão na confirmação (D4b)", () => {
  const nowMs = Date.parse("2026-10-21T14:00:00Z"); // 15:00 Lisboa
  const state = (manualMinAgo: number | null, extra: Partial<{ status: string; holdAuto: boolean }> = {}) => ({
    status: "proposed", holdAuto: false, ...extra,
    manual: manualMinAgo == null ? null : { atUnix: Math.floor((nowMs - manualMinAgo * 60_000) / 1000) },
  });
  it("intocado → confirma em todas as opções", () => {
    for (const m of ["confirm", "skip_notify", "if_older_30m"] as const) expect(autoConfirmDecision(state(null), m, nowMs)).toEqual({ action: "confirm" });
  });
  it("confirm → confirma; skip_notify → não confirma e avisa; if_older_30m → espera até passarem 30 min", () => {
    expect(autoConfirmDecision(state(10), "confirm", nowMs).action).toBe("confirm");
    expect(autoConfirmDecision(state(10), "skip_notify", nowMs).action).toBe("hold_notify");
    expect(autoConfirmDecision(state(10), "if_older_30m", nowMs).action).toBe("wait");
    expect(autoConfirmDecision(state(30), "if_older_30m", nowMs).action).toBe("wait");
    expect(autoConfirmDecision(state(31), "if_older_30m", nowMs).action).toBe("confirm");
  });
  it("suspenso, já confirmado ou sem proposta → nada", () => {
    expect(autoConfirmDecision(state(null, { holdAuto: true }), "confirm", nowMs).action).toBe("skip");
    expect(autoConfirmDecision(state(null, { status: "confirmed" }), "confirm", nowMs).action).toBe("skip");
    expect(autoConfirmDecision(null, "confirm", nowMs).action).toBe("skip");
  });
  it("if_older_30m: a espera que acaba depois da última volta (23:45) não fica pendurada", () => {
    expect(settlesAfterLastRun(Date.parse("2026-10-21T22:36:00Z"), "2026-10-21")).toBe(false); // 23:36 Lisboa
    expect(settlesAfterLastRun(Date.parse("2026-10-21T22:51:00Z"), "2026-10-21")).toBe(true); // 23:51 Lisboa
    expect(settlesAfterLastRun(Date.parse("2026-10-21T23:10:00Z"), "2026-10-21")).toBe(true); // 00:10 do dia seguinte
  });
});

describe("cobertura (aviso abaixo de 80 % na confirmação)", () => {
  it("horas×condutor cobertas / pedidas, a partir das 03h", () => {
    const needed = Array.from({ length: 27 }, (_, h) => (h >= 8 && h < 18 ? 2 : 0)); // 20 h×condutor
    expect(scheduleCoverage(needed, [{ startHour: 8, endHour: 18 }, { startHour: 8, endHour: 18 }])).toBe(1);
    expect(scheduleCoverage(needed, [{ startHour: 8, endHour: 18 }, { startHour: 8, endHour: 14 }])).toBe(0.8);
    expect(scheduleCoverage(needed, [{ startHour: 8, endHour: 18 }])).toBe(0.5);
    expect(scheduleCoverage(Array(27).fill(0), [])).toBe(1);
  });
});

describe("lembretes: quando e a quem (D4c)", () => {
  const s = { autoProposeAtMin: hhmmToMinutes("11:00"), autoConfirm: true, autoConfirmAtMin: hhmmToMinutes("15:00") };
  it("10:30–10:59 → o da proposta (amanhã); 14:30–14:59 → o da confirmação; fora → nada", () => {
    const at = (h: number, m: number) => ({ date: "2026-10-21", minutes: h * 60 + m });
    expect(remindersDue(at(10, 29), s)).toEqual([]);
    expect(remindersDue(at(10, 30), s)).toEqual([{ slot: "propose", date: "2026-10-22", at: "11:00" }]);
    expect(remindersDue(at(10, 45), s)).toEqual([{ slot: "propose", date: "2026-10-22", at: "11:00" }]);
    expect(remindersDue(at(11, 0), s)).toEqual([]);
    expect(remindersDue(at(14, 30), s)).toEqual([{ slot: "confirm", date: "2026-10-22", at: "15:00" }]);
    expect(remindersDue(at(14, 30), { ...s, autoConfirm: false })).toEqual([]);
  });
  it("dias da semana do dia em que sai; papéis ou contas juntadas", () => {
    expect(isoWeekday("2026-10-25")).toBe(7); // domingo
    const rule = { roles: ["supervisor" as const], days: [1, 2, 3, 4, 5], userIds: [42] };
    expect(reminderAppliesOn(rule, "2026-10-23")).toBe(true); // sexta
    expect(reminderAppliesOn(rule, "2026-10-25")).toBe(false); // domingo
    expect(reminderAppliesOn({ roles: [], days: [1, 2, 3, 4, 5, 6, 7], userIds: [] }, "2026-10-23")).toBe(false);
    const f = reminderRecipientFilter(rule);
    expect(f({ id: 1, role: "supervisor" })).toBe(true);
    expect(f({ id: 2, role: "team_leader" })).toBe(false);
    expect(f({ id: 42, role: "admin" })).toBe(true);
  });
  it("textos: proposta e confirmação (mexido à mão, suspenso, acrescentados, faltas) e o aviso do D4b às 14:30", () => {
    const base = { cityLabel: "Lisboa", dayLabel: "quinta 22/10", status: "proposed" as const, holdAuto: false, manual: false, manualMode: "skip_notify" as const, proposed: 5, confirmed: 0, gaps: [], noAnswer: null, added: [] };
    const p = reminderMessage({ ...base, slot: "propose", at: "11:00", status: "none", proposed: 0, noAnswer: 3 });
    expect(p.title).toBe("Extras-dia Lisboa: proposta de quinta 22/10 às 11:00");
    expect(p.body).toContain("Às 11:00 sai a proposta automática");
    expect(p.body).toContain("Faltam 3 extras responder");
    const c = reminderMessage({ ...base, slot: "confirm", at: "15:00", manual: true, added: ["Rui"], gaps: ["falta 1 condutor entre 14h–17h"] });
    expect(c.body).toContain("Às 15:00 a escala de quinta 22/10 é confirmada");
    expect(c.body).toContain("não é confirmado sozinho");
    expect(c.body).toContain("Acrescentados com quem respondeu entretanto: Rui.");
    expect(c.body).toContain("se mexeres agora nos condutores deste dia, às 15:00 já não é confirmado sozinho");
    expect(reminderMessage({ ...base, slot: "confirm", at: "15:00", manualMode: "if_older_30m" }).body).toContain("só é confirmado sozinho 30 min depois da última mudança");
    expect(reminderMessage({ ...base, slot: "confirm", at: "15:00", manualMode: "confirm" }).body).toContain("é confirmado e avisado como estiver às 15:00");
    expect(reminderMessage({ ...base, slot: "confirm", at: "15:00", holdAuto: true }).body).toContain("está suspenso");
  });
});

// ─── Relógio simulado: 10:00 → 18:30 de Lisboa ──────────────────────────────

type Notif = { assignmentId: number; version: number; channel: string; status: string; attempts: number; updatedAt: number; personName: string; tries: number[] };

/**
 * Mundo falso: o estado da escala de amanhã por cidade, as linhas da escala e
 * os avisos. As funções do trabalho são as de produção; só as pontas são falsas.
 */
function world(opts: {
  mode: "confirm" | "skip_notify" | "if_older_30m"; manualAt?: number | null; whatsappUpAt?: number | null; remindersOn?: boolean;
  alertsOn?: boolean; confirmAt?: string; recipients?: (input: any) => number[]; admins?: number[];
}) {
  const W = {
    now: 0,
    states: new Map<string, any>(),
    notifs: [] as Notif[],
    proposals: [] as Array<{ at: number; city: string }>,
    confirms: [] as Array<{ at: number; city: string }>,
    alerts: [] as Array<{ at: number; kind: string; title: string; body: string; city: string | null; recipients: number }>,
    reminders: [] as Array<{ at: number; title: string; body: string; city: string; alsoUserIds?: readonly unknown[] }>,
    claims: new Map<string, { released: boolean; attempts: number }>(),
  };
  const key = (date: string, city: string) => `${date}:${city}`;
  const confirmAt = opts.confirmAt ?? "15:00";
  const settings = {
    autoProposeAt: "11:00", autoConfirmAt: confirmAt, autoProposeAtMin: 660, autoConfirmAtMin: hhmmToMinutes(confirmAt), daysAhead: 1, autoConfirm: true,
    crewRules: {} as any, meetingPoints: { lisbon: "", porto: "", faro: "" }, manualEditAtConfirm: opts.mode,
  };
  const sendFor = (date: string, city: string) => {
    for (const n of W.notifs.filter((x) => W.states.get(key(date, city))?.rows?.includes(x.assignmentId))) {
      // A mesma regra da reserva real (claimNotification → notifyRetryDue).
      if (n.status !== "failed" || !notifyRetryDue({ status: n.status, attempts: n.attempts, ageMs: W.now - n.updatedAt })) continue;
      n.attempts++;
      n.tries.push(W.now);
      n.updatedAt = W.now;
      n.status = opts.whatsappUpAt != null && W.now >= opts.whatsappUpAt ? "sent" : "failed";
    }
    return { whatsapp: null, email: null, warnings: [], errors: [] };
  };
  const getState = async (date: string, city: string) => {
    const st = W.states.get(key(date, city)) ?? null;
    // A mudança à mão aparece à hora em que é feita (só Lisboa).
    if (st && city === "lisbon" && opts.manualAt != null && W.now >= opts.manualAt && !st.manual) {
      st.manual = { atUnix: Math.floor(opts.manualAt / 1000), byId: 5, byName: "Márcia", what: "tirou" };
    }
    return st;
  };
  const claimAlert = async (a: { date: string; city: string; kind: string; key?: string }) => {
    const k = `${a.date}|${a.city}|${a.kind}|${a.key ?? ""}`;
    const c = W.claims.get(k);
    if (!c) { W.claims.set(k, { released: false, attempts: 1 }); return true; }
    if (c.released && c.attempts < 3) { c.released = false; c.attempts++; return true; }
    return false;
  };
  const scheduleDeps = {
    flagOn: async (name: string) => (name === "EXTRAS_AUTOMATION" ? true : name === "EXTRAS_REMINDERS" ? !!opts.remindersOn : name === "EXTRAS_SCHEDULE_ALERTS" ? opts.alertsOn ?? true : false),
    loadSettings: async () => settings,
    getState,
    propose: async ({ date, city }: { date: string; city: string }) => {
      if (W.states.has(key(date, city))) return { status: "skipped", reason: "já tem proposta ou escala", proposed: 0, kept: 0, gaps: [], summary: null, removedOut: 0 } as any;
      const base = city === "lisbon" ? 100 : city === "porto" ? 200 : 300;
      W.states.set(key(date, city), {
        status: "proposed", holdAuto: false, proposedAt: null, proposedBy: "auto", confirmedAt: null, confirmedBy: null, gaps: [] as Gap[], summary: null,
        manual: null, rows: [base + 1, base + 2],
      });
      W.proposals.push({ at: W.now, city });
      return { status: "proposed", proposed: 2, kept: 0, gaps: [], summary: "x", removedOut: 0 } as any;
    },
    complete: async () => ({ status: "skipped", reason: "não usado", added: [], gaps: [] }) as any,
    confirm: async ({ date, city }: { date: string; city: string }) => {
      const st = W.states.get(key(date, city));
      if (!st || st.status !== "proposed" || st.holdAuto) return { status: "skipped", reason: "sem proposta", confirmed: 0, notifications: null } as any;
      st.status = "confirmed";
      W.confirms.push({ at: W.now, city });
      for (const id of st.rows) {
        const ok = opts.whatsappUpAt != null && W.now >= opts.whatsappUpAt;
        W.notifs.push({ assignmentId: id, version: 1, channel: "whatsapp", status: ok ? "sent" : "failed", attempts: 1, updatedAt: W.now, personName: `Extra ${id}`, tries: [W.now] });
      }
      return { status: "confirmed", confirmed: st.rows.length, notifications: { whatsapp: null, email: null, warnings: [], errors: [] } } as any;
    },
    sendNotifications: async (date: string, city: any) => sendFor(date, city),
    unnotified: async (date: string, city: string) => unnotifiedAfterRetries(W.notifs.filter((n) => W.states.get(key(date, city))?.rows?.includes(n.assignmentId))),
    coverage: async () => ({ coverage: 1, gaps: [] }),
    claimAlert,
    releaseAlert: async (a: { date: string; city: string; kind: string; key?: string }) => {
      const c = W.claims.get(`${a.date}|${a.city}|${a.kind}|${a.key ?? ""}`);
      if (c) c.released = true;
    },
    alert: async (input: any) => {
      const recipients = opts.recipients ? opts.recipients(input) : [1, 2];
      W.alerts.push({ at: W.now, kind: input.entity.id.split(":")[2], title: input.title, body: input.body, city: input.city, recipients: recipients.length });
      return { recipients, duplicates: 0 };
    },
    adminIds: async () => opts.admins ?? [],
    noteRecipients: async () => {},
  };
  const reminderDeps = {
    flagOn: scheduleDeps.flagOn,
    loadSettings: async () => settings,
    loadRules: async () => DEFAULT_REMINDER_RECIPIENTS,
    getState,
    counts: async (date: string, city: string) => ({ proposed: W.states.get(key(date, city))?.status === "proposed" ? 2 : 0, confirmed: W.states.get(key(date, city))?.status === "confirmed" ? 2 : 0 }),
    noAnswer: async () => 3,
    completedNames: async () => [],
    claim: async (a: any) => claimAlert(a),
    notify: async (input: any) => { W.reminders.push({ at: W.now, title: input.title, body: input.body, city: input.city, alsoUserIds: input.alsoUserIds }); return { recipients: [1] }; },
    noteRecipients: async () => {},
  };
  return { W, scheduleDeps, reminderDeps, settings };
}

/** Corre o tick (escala e depois lembretes) de 15 em 15 min, de `fromIso` a `toIso` (UTC). */
async function runClock(w: ReturnType<typeof world>, fromIso: string, toIso: string) {
  const { runScheduleAutomation } = await import("./extrasSchedule");
  const { runExtrasReminders } = await import("./extrasReminders");
  const reports: Array<{ at: number; sched: any; rem: any }> = [];
  for (let t = Date.parse(fromIso); t <= Date.parse(toIso); t += 15 * 60_000) {
    w.W.now = t;
    const sched = await runScheduleAutomation(new Date(t), w.scheduleDeps as any);
    const rem = await runExtrasReminders(new Date(t), w.reminderDeps as any);
    reports.push({ at: t, sched, rem });
  }
  return reports;
}

const lx = (ms: number) => { const n = lisbonNow(new Date(ms)); return `${String(Math.floor(n.minutes / 60)).padStart(2, "0")}:${String(n.minutes % 60).padStart(2, "0")}`; };

describe("relógio simulado das 10:00 às 18:30 (Lisboa)", () => {
  // Quarta 21 out (hora de verão, UTC+1) e domingo 25 out (muda a hora: UTC+0).
  for (const [label, from, to] of [["qua 21 out (verão)", "2026-10-21T09:00:00Z", "2026-10-21T17:30:00Z"], ["dom 25 out (muda a hora)", "2026-10-25T10:00:00Z", "2026-10-25T18:30:00Z"]] as const) {
    it(`${label}: lembrete 10:30 → proposta 11:00 → lembrete 14:30 → confirmação e envio 15:00`, async () => {
      const w = world({ mode: "confirm", whatsappUpAt: 0, remindersOn: true });
      await runClock(w, from, to);
      const cities = (xs: Array<{ city: string }>) => xs.map((x) => x.city).sort();
      // Lembretes: um por cidade e hora, nunca repetidos às :45.
      expect(w.W.reminders.filter((r) => r.title.includes("proposta")).map((r) => lx(r.at))).toEqual(["10:30", "10:30", "10:30"]);
      expect(w.W.reminders.filter((r) => r.title.includes("confirmação")).map((r) => lx(r.at))).toEqual(["14:30", "14:30", "14:30"]);
      expect(cities(w.W.reminders.filter((r) => r.title.includes("proposta")))).toEqual(["faro", "lisbon", "porto"]);
      // Proposta só a partir das 11:00 (uma por cidade, depois idempotente).
      expect(w.W.proposals.map((p) => lx(p.at))).toEqual(["11:00", "11:00", "11:00"]);
      // Confirmação e envio às 15:00 (não antes).
      expect(w.W.confirms.map((c) => lx(c.at))).toEqual(["15:00", "15:00", "15:00"]);
      expect(w.W.notifs.every((n) => n.status === "sent" && lx(n.tries[0]) === "15:00")).toBe(true);
      expect(w.W.alerts).toEqual([]);
    });
  }

  it("lembretes desligados (omissão) → nenhum lembrete; a escala corre na mesma", async () => {
    const w = world({ mode: "confirm", whatsappUpAt: 0, remindersOn: false });
    const reports = await runClock(w, "2026-10-21T09:00:00Z", "2026-10-21T14:30:00Z");
    expect(w.W.reminders).toEqual([]);
    expect(reports[0].rem).toMatchObject({ skipped: "off" });
    expect(w.W.confirms.length).toBe(3);
  });

  it("falha do envio às 15:00 → nova tentativa 15:30 → 16:30 → 18:00 → aviso de falha (uma vez)", async () => {
    const w = world({ mode: "confirm", whatsappUpAt: null });
    await runClock(w, "2026-10-21T09:00:00Z", "2026-10-21T17:30:00Z");
    const lisbon = w.W.notifs.filter((n) => n.assignmentId === 101)[0];
    expect(lisbon.tries.map(lx)).toEqual(["15:00", "15:30", "16:30", "18:00"]);
    expect(lisbon.status).toBe("failed");
    const unnotified = w.W.alerts.filter((a) => a.kind === "unnotified");
    expect(unnotified.map((a) => `${lx(a.at)} ${a.city}`).sort()).toEqual(["18:00 faro", "18:00 lisbon", "18:00 porto"]);
    const lxAlert = unnotified.find((a) => a.city === "lisbon")!;
    expect(lxAlert.title).toBe("Escala de quinta 22/10 (Lisboa): 2 extras ficaram por avisar");
    expect(lxAlert.body).toContain("Extra 101 (WhatsApp: falhou em todas as tentativas)");
    expect(lxAlert.body).toContain("não chegou por nenhum canal");
  });

  it("avisos da escala desligados (EXTRAS_SCHEDULE_ALERTS, omissão): a mesma falha não avisa ninguém (nem email)", async () => {
    const w = world({ mode: "skip_notify", manualAt: Date.parse("2026-10-21T13:50:00Z"), whatsappUpAt: null, alertsOn: false });
    const reports = await runClock(w, "2026-10-21T09:00:00Z", "2026-10-21T17:30:00Z");
    expect(w.W.alerts).toEqual([]);
    expect(reports.some((r) => r.sched.skipped.some((s: string) => s.includes("EXTRAS_SCHEDULE_ALERTS desligado")))).toBe(true);
  });

  it("a Meta volta às 16:00: a tentativa das 16:30 já passa e não há aviso", async () => {
    const w = world({ mode: "confirm", whatsappUpAt: Date.parse("2026-10-21T15:00:00Z") });
    await runClock(w, "2026-10-21T09:00:00Z", "2026-10-21T17:30:00Z");
    const n = w.W.notifs.find((x) => x.assignmentId === 101)!;
    expect(n.tries.map(lx)).toEqual(["15:00", "15:30", "16:30"]);
    expect(n.status).toBe("sent");
    expect(w.W.alerts.filter((a) => a.kind === "unnotified")).toEqual([]);
  });

  it("aviso sem destinatários na cidade → vai aos admins; sem ninguém → liberta e tenta outra vez (no máximo 3)", async () => {
    // Ninguém na cidade, admins existem: a 2.ª chamada (sem cidade) chega aos admins.
    const w = world({ mode: "confirm", whatsappUpAt: null, admins: [99], recipients: (input) => (input.city ? [] : [99]) });
    const reports = await runClock(w, "2026-10-21T09:00:00Z", "2026-10-21T17:30:00Z");
    const lxAlerts = w.W.alerts.filter((a) => a.kind === "unnotified" && a.title.includes("Lisboa"));
    expect(lxAlerts.map((a) => a.city)).toEqual(["lisbon", null]); // 1.º a cidade, depois os admins
    expect(lxAlerts[1].recipients).toBe(1);
    expect(reports.some((r) => r.sched.warnings.some((s: string) => s.includes("foi aos admins")))).toBe(true);
    // Ninguém de todo: liberta e volta a tentar nas corridas seguintes, até 3 vezes.
    const w0 = world({ mode: "confirm", whatsappUpAt: null, admins: [], recipients: () => [] });
    const r0 = await runClock(w0, "2026-10-21T09:00:00Z", "2026-10-21T17:30:00Z");
    const tries = w0.W.alerts.filter((a) => a.kind === "unnotified" && a.title.includes("Lisboa")).map((a) => lx(a.at));
    expect(tries).toEqual(["18:00", "18:15", "18:30"]);
    expect(r0.some((r) => r.sched.warnings.some((s: string) => s.includes("sem destinatários")))).toBe(true);
  });

  describe("dia mexido à mão às 14:50 (Lisboa), nas 3 opções", () => {
    const manualAt = Date.parse("2026-10-21T13:50:00Z"); // 14:50 Lisboa
    it("confirm (omissão): confirma às 15:00 como está", async () => {
      const w = world({ mode: "confirm", manualAt, whatsappUpAt: 0 });
      await runClock(w, "2026-10-21T09:00:00Z", "2026-10-21T17:30:00Z");
      expect(w.W.confirms.find((c) => c.city === "lisbon")).toMatchObject({ at: Date.parse("2026-10-21T14:00:00Z") });
      expect(w.W.alerts.filter((a) => a.kind === "manual_hold")).toEqual([]);
    });
    it("skip_notify: não confirma e avisa às 15:00; continua por confirmar → repete às 18:00 (uma vez)", async () => {
      const w = world({ mode: "skip_notify", manualAt, whatsappUpAt: 0 });
      await runClock(w, "2026-10-21T09:00:00Z", "2026-10-21T17:30:00Z");
      expect(w.W.confirms.map((c) => c.city).sort()).toEqual(["faro", "porto"]);
      const hold = w.W.alerts.filter((a) => a.kind === "manual_hold");
      expect(hold.map((a) => `${lx(a.at)} ${a.city}`)).toEqual(["15:00 lisbon", "18:00 lisbon"]);
      expect(hold[0].body).toContain("mexido à mão por Márcia (tirou)");
      expect(hold[0].body).toContain("Confirmar escala");
      expect(hold[1].title).toContain("AINDA por confirmar");
      expect(w.W.notifs.some((n) => n.assignmentId === 101)).toBe(false); // ninguém de Lisboa avisado
    });
    it("if_older_30m: espera; confirma às 15:30 (40 min depois da última mudança)", async () => {
      const w = world({ mode: "if_older_30m", manualAt, whatsappUpAt: 0 });
      const reports = await runClock(w, "2026-10-21T09:00:00Z", "2026-10-21T17:30:00Z");
      expect(lx(w.W.confirms.find((c) => c.city === "lisbon")!.at)).toBe("15:30");
      const at1515 = reports.find((r) => lx(r.at) === "15:15")!;
      expect(at1515.sched.skipped.join(" ")).toMatch(/mexido à mão há 25 min/);
      expect(w.W.alerts).toEqual([]);
    });
  });

  describe("if_older_30m perto do fim do dia (confirmação às 23:30)", () => {
    it("mexido às 23:05 → confirma às 23:45 sem aviso", async () => {
      const w = world({ mode: "if_older_30m", confirmAt: "23:30", manualAt: Date.parse("2026-10-21T22:05:00Z"), whatsappUpAt: 0 });
      await runClock(w, "2026-10-21T09:00:00Z", "2026-10-21T22:45:00Z");
      expect(lx(w.W.confirms.find((c) => c.city === "lisbon")!.at)).toBe("23:45");
      expect(w.W.alerts).toEqual([]);
    });
    it("mexido às 23:20 → a espera passava das 23:45: avisa (uma vez) e não fica pendurado", async () => {
      const w = world({ mode: "if_older_30m", confirmAt: "23:30", manualAt: Date.parse("2026-10-21T22:20:00Z"), whatsappUpAt: 0 });
      await runClock(w, "2026-10-21T09:00:00Z", "2026-10-21T22:45:00Z");
      expect(w.W.confirms.find((c) => c.city === "lisbon")).toBeUndefined();
      const late = w.W.alerts.filter((a) => a.kind === "manual_hold");
      expect(late.map((a) => lx(a.at))).toEqual(["23:30"]);
      expect(late[0].body).toContain("não vai ser confirmado sozinho");
    });
  });
});

describe("as decisões do cron continuam as de antes onde não mudaram", () => {
  it("scheduleDue: propõe a partir das 11:00 e confirma a partir das 15:00 (amanhã)", () => {
    const s = { autoProposeAtMin: 660, daysAhead: 1, autoConfirm: true, autoConfirmAtMin: 900 };
    expect(scheduleDue({ date: "2026-10-21", minutes: 659 }, s)).toEqual({ proposeDates: [], confirmDates: [] });
    expect(scheduleDue({ date: "2026-10-21", minutes: 660 }, s)).toEqual({ proposeDates: ["2026-10-22"], confirmDates: [] });
    expect(scheduleDue({ date: "2026-10-21", minutes: 900 }, s)).toEqual({ proposeDates: ["2026-10-22"], confirmDates: ["2026-10-22"] });
  });
});
