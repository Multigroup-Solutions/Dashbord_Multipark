import { describe, expect, it } from "vitest";
import {
  CLOCK_GRACE_MINUTES, MOVEMENT_ALERT_EXPIRE_HOURS, ZELLO_STALE_SECONDS,
  diffPresenceAlerts, dueForEscalation, evaluatePresence, isOperationalPosition, presenceOneLine, presenceRecipients, zelloOnline,
  type PresencePerson, type ZelloStatus,
} from "../shared/opsPresence";
import { dbMs, utcStamp } from "./opsPresence";
import { NOTIFICATION_KIND_DEFS } from "../shared/notificationRouting";
import { AUTOMATION_FLAGS, SETTINGS } from "../shared/appSettings";
import { TICK_JOBS } from "./cronSchedule";

const NOW = Date.UTC(2026, 8, 29, 10, 0, 0);
const MIN = 60_000;

const person = (o: Partial<PresencePerson> = {}): PresencePerson => ({
  employeeId: 1, name: "Rui Santos", position: "driver", city: "lisbon",
  clockOpenSince: NOW - 60 * MIN, pdaName: "PDA 12", zelloUsername: "pda12", ...o,
});
const zello = (entries: Record<string, number>): Map<string, ZelloStatus> =>
  new Map(Object.entries(entries).map(([u, d]) => [u, { username: u, status: "available", lastReportDelay: d }]));

describe("quem conta como operacional", () => {
  it("team leader, condutores e extras sim; back office, front office, supervisor não", () => {
    for (const p of ["team_leader", "senior_driver", "driver", "extra"]) expect(isOperationalPosition(p)).toBe(true);
    for (const p of ["backoffice", "frontoffice", "supervisor", "director", null]) expect(isOperationalPosition(p)).toBe(false);
  });
});

describe("Zello ligado", () => {
  it("reporte recente = ligado; antigo, offline ou ausente = desligado; sem Zello = não se sabe", () => {
    expect(zelloOnline("PDA12", zello({ pda12: 30 }))).toBe(true);
    expect(zelloOnline("pda12", zello({ pda12: ZELLO_STALE_SECONDS + 1 }))).toBe(false);
    expect(zelloOnline("pda12", new Map([["pda12", { username: "pda12", status: "offline", lastReportDelay: 5 }]]))).toBe(false);
    expect(zelloOnline("pda99", zello({ pda12: 30 }))).toBe(false);
    expect(zelloOnline("pda12", null)).toBeNull();
  });
});

describe("evaluatePresence", () => {
  it("ponto aberto sem PDA → alerta, mas só depois da tolerância", () => {
    const early = evaluatePresence({ now: NOW, people: [person({ pdaName: null, clockOpenSince: NOW - (CLOCK_GRACE_MINUTES - 1) * MIN })], movements: [], locations: zello({}) });
    expect(early).toEqual([]);
    const late = evaluatePresence({ now: NOW, people: [person({ pdaName: null, clockOpenSince: NOW - (CLOCK_GRACE_MINUTES + 1) * MIN })], movements: [], locations: zello({}) });
    expect(late.map((p) => p.kind)).toEqual(["clock_no_pda"]);
  });

  it("PDA na mão mas Zello desligado → alerta; Zello em baixo → nada", () => {
    expect(evaluatePresence({ now: NOW, people: [person()], movements: [], locations: zello({ pda12: 3600 }) }).map((p) => p.kind)).toEqual(["clock_zello_off"]);
    expect(evaluatePresence({ now: NOW, people: [person()], movements: [], locations: zello({ pda12: 20 }) })).toEqual([]);
    expect(evaluatePresence({ now: NOW, people: [person()], movements: [], locations: null })).toEqual([]);
  });

  it("conta Zello excluída do GPS não é vigiada", () => {
    expect(evaluatePresence({ now: NOW, people: [person({ zelloExcluded: true })], movements: [], locations: zello({}) })).toEqual([]);
  });

  it("back office fica de fora mesmo com ponto aberto e movimentos", () => {
    const p = person({ position: "backoffice", pdaName: null, clockOpenSince: null });
    expect(evaluatePresence({ now: NOW, people: [p], movements: [{ employeeId: 1, changeType: "CHECK_IN", at: NOW - MIN }], locations: zello({}) })).toEqual([]);
  });

  it("movimento sem ponto aberto → alerta (um por pessoa); ponto esquecido conta como fechado", () => {
    const p = person({ clockOpenSince: NOW - 20 * 3_600_000 });
    const r = evaluatePresence({
      now: NOW, people: [p], locations: zello({ pda12: 5 }),
      movements: [
        { employeeId: 1, changeType: "CHECK_IN", at: NOW - 2 * MIN, bookingCode: "MP123", plate: "AA-00-BB" },
        { employeeId: 1, changeType: "CHECK_OUT", at: NOW - 5 * MIN },
      ],
    });
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe("move_no_clock");
    expect(r[0].detail).toContain("Recolha da reserva MP123 (AA-00-BB)");
  });

  it("movimento com ponto aberto e Zello desligado → move_zello_off (além do do ponto)", () => {
    const r = evaluatePresence({ now: NOW, people: [person()], locations: zello({}), movements: [{ employeeId: 1, changeType: "UPDATE", at: NOW - MIN }] });
    expect(r.map((x) => x.kind).sort()).toEqual(["clock_zello_off", "move_zello_off"]);
  });
});

describe("diffPresenceAlerts", () => {
  it("abre os novos, mantém os que continuam e fecha os resolvidos", () => {
    const people = [person({ pdaName: null }), person({ employeeId: 2, pdaName: "PDA 3", zelloUsername: "pda3" })];
    const problems = evaluatePresence({ now: NOW, people, movements: [], locations: zello({ pda3: 5 }) });
    const d = diffPresenceAlerts({
      now: NOW, people, problems, locations: zello({ pda3: 5 }),
      open: [
        { id: 10, employeeId: 1, kind: "clock_no_pda", openedAt: NOW - 30 * MIN },
        { id: 11, employeeId: 2, kind: "clock_zello_off", openedAt: NOW - 30 * MIN },
      ],
    });
    expect(d.toOpen).toEqual([]);
    expect(d.toTouch).toEqual([10]);
    expect(d.toResolve).toEqual([{ id: 11, resolution: "resolvido" }]);
  });

  it("sem Zello não fecha o alerta do Zello; movimento sem ponto fecha quando abre o ponto ou expira", () => {
    const people = [person(), person({ employeeId: 2, clockOpenSince: null })];
    const d = diffPresenceAlerts({
      now: NOW, people, problems: [], locations: null,
      open: [
        { id: 1, employeeId: 1, kind: "clock_zello_off", openedAt: NOW - 30 * MIN },
        { id: 2, employeeId: 1, kind: "move_no_clock", openedAt: NOW - 30 * MIN },
        { id: 3, employeeId: 2, kind: "move_no_clock", openedAt: NOW - 30 * MIN },
        { id: 4, employeeId: 2, kind: "move_no_clock", openedAt: NOW - (MOVEMENT_ALERT_EXPIRE_HOURS + 1) * 3_600_000 },
      ],
    });
    expect(d.toTouch).toEqual([1]);
    expect(d.toResolve).toEqual([{ id: 2, resolution: "resolvido" }, { id: 4, resolution: "expirado" }]);
  });
});

describe("passagem ao WhatsApp", () => {
  it("só passa sem Visto, sem ter passado e depois dos minutos", () => {
    const base = { openedAt: NOW - 11 * MIN, acknowledgedAt: null, escalatedAt: null, resolvedAt: null };
    expect(dueForEscalation(base, NOW, 10)).toBe(true);
    expect(dueForEscalation({ ...base, openedAt: NOW - 9 * MIN }, NOW, 10)).toBe(false);
    expect(dueForEscalation({ ...base, acknowledgedAt: NOW }, NOW, 10)).toBe(false);
    expect(dueForEscalation({ ...base, escalatedAt: NOW }, NOW, 10)).toBe(false);
    expect(dueForEscalation({ ...base, resolvedAt: NOW }, NOW, 10)).toBe(false);
  });

  it("o texto do modelo vai numa só linha", () => {
    const t = presenceOneLine("clock_no_pda", "Rui\nSantos", "Lisboa", "linha 1\nlinha 2");
    expect(t).not.toMatch(/\n/);
    expect(t).toContain("Ponto aberto sem PDA: Rui Santos (Lisboa)");
  });
});

describe("quem recebe no sino", () => {
  it("TL escalado + TL com ponto aberto + supervisor, sem repetidos e sem a própria pessoa", () => {
    expect(presenceRecipients({ scheduledTeamLeaders: [5, 6], clockedTeamLeaders: [6, 7], supervisors: [8] }, [7])).toEqual([5, 6, 8]);
  });
});

describe("ligações", () => {
  it("tipo de notificação pessoal, interruptores desligados, definições e cron registados", () => {
    const k = NOTIFICATION_KIND_DEFS.find((d) => d.kind === "ops_presence");
    expect(k?.personal).toBe(true);
    for (const n of ["OPS_PRESENCE_ALERTS", "OPS_PRESENCE_WHATSAPP"]) expect(AUTOMATION_FLAGS.find((f) => f.name === n)?.defaultEnabled).toBe(false);
    expect(SETTINGS["ops.presenceEscalateMinutes"].defaultValue).toBe(10);
    expect(SETTINGS["ops.presencePhones"].schema.safeParse({ lisbon: ["+351912345678"], porto: [], faro: [], copy: [] }).success).toBe(true);
    expect(SETTINGS["ops.presencePhones"].schema.safeParse({ lisbon: ["abc"], porto: [], faro: [], copy: [] }).success).toBe(false);
    expect(SETTINGS["ops.presenceTemplate"].schema.safeParse("alerta_operacional|pt_PT").success).toBe(true);
    expect(TICK_JOBS.some((j) => j.key === "ops-presence")).toBe(true);
  });

  it("datas da BD em UTC", () => {
    expect(dbMs("2026-09-29 10:00:00")).toBe(NOW);
    expect(utcStamp(NOW)).toBe("2026-09-29 10:00:00");
    expect(dbMs(null)).toBeNull();
  });
});
