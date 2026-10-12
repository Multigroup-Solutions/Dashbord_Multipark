/**
 * TERMINAL PELO PERFIL — entrega B2 (plano 56; decisões do Jorge a 12 out 2026):
 * "Ainda estás no terminal?", reabrir, horas que contam, ordenado e custo dos
 * extras a partir das sessões, RH (sem sobreposição, meses fechados), linha do
 * tempo do Resumo do dia e o interruptor desligado = nada.
 * Contra uma BD em memória que faz o mesmo que o MySQL (chaves únicas,
 * atualizações condicionais, transações). Sem BD real; sem Zello real.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./appSettings", () => ({ getSetting: async () => null, loadFeatureFlagOverrides: async () => new Map() }));

import {
  TERMINAL_ASK_AFTER_MIN, TERMINAL_GPS_STALE_S, TERMINAL_NO_ANSWER_MIN, TERMINAL_REOPEN_MIN, TERMINAL_STILL_HERE_QUIET_MIN,
  cityDayTimeline, classifyReading, correctionRange, countedAtClose, nextWatch, overlapConflict, parksInsideZones, sessionHoursInShift,
  watchDecision, type ZelloReading,
} from "../shared/terminalWatch";
import { DEFAULT_TERMINAL_AIRPORTS, splitTerminalHours, terminalSplitOfShift } from "../shared/pontoTerminal";
import { canUseTerminal, toDbUtc, type TerminalCityKey } from "../shared/terminalSession";
import {
  releaseOnCheckout, startTerminal, stopTerminal, terminalStatus, liveByCity, tlPut,
  type HandoverRow, type TerminalDeps, type TerminalNotice, type TerminalSessionRow, type TerminalStore, type TerminalStoreOps,
} from "./terminalSessions";
import { answerStillHere, reopenTerminal, runTerminalWatch } from "./terminalWatch";
import { retryPendingTerminalSessions, rhConfirm, rhCorrect, rhReject, rhSessionsOf, rhSetShift, terminalDayTimeline } from "./terminalReview";
import { touchesClosedMonth } from "./terminalPay";
import { computeEmployeeMonth } from "./payroll/compute";
import { pairShifts, countableShifts } from "./payroll/shifts";
import { aggregateExtrasCost } from "./finance/extrasCost";
import { AUTOMATION_FLAGS, CRON_JOBS, automationFlagDefault, validateSetting } from "../shared/appSettings";
import { isPersonalAccessPath } from "./cityAccess";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { MIGRATION_0640_STATEMENTS, IDEMPOTENT_ERROR_CODES_0640 } from "./migrations/migration_0640";
import { TICK_JOBS } from "./cronSchedule";

const src = (p: string) => readFileSync(resolve(import.meta.dirname, "..", p), "utf8");
afterEach(() => { delete process.env.PONTO_TERMINAL; });

// ─── GPS ─────────────────────────────────────────────────────────────────────
const LIS = DEFAULT_TERMINAL_AIRPORTS.lisbon;
const north = (base: { lat: number; lng: number }, m: number, accuracy = 20) => ({ lat: base.lat + m / 111_320, lng: base.lng, accuracy });
const IN_LIS = north(LIS, 400);
const FAR_LIS = north(LIS, 3200);

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 12, 13, 5, 0); // 14:05 em Lisboa (verão)

// ─── BD em memória (as mesmas regras do MySQL) ───────────────────────────────

function memoryStore() {
  let sessions: TerminalSessionRow[] = [];
  let handovers: HandoverRow[] = [];
  let nextId = 1, nextH = 1, writes = 0;
  const dup = () => Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY", errno: 1062 });
  const copy = <T,>(x: T): T => (x == null ? x : JSON.parse(JSON.stringify(x)));
  const ms = (v: string | null | undefined) => (v ? Date.parse(v.replace(" ", "T") + "Z") : NaN);
  const ops = (): TerminalStoreOps => ({
    openByEmployee: async (e) => copy(sessions.find((s) => s.activeEmployeeId === e) ?? null),
    openByCity: async (c) => copy(sessions.find((s) => s.activeCityKey === c) ?? null),
    openAll: async () => sessions.filter((s) => s.activeCityKey != null).map(copy),
    byId: async (id) => copy(sessions.find((s) => s.id === id) ?? null),
    insert: async (row) => {
      if (sessions.some((s) => s.activeCityKey === row.cityKey || s.activeEmployeeId === row.employeeId)) throw dup();
      const id = nextId++;
      writes++;
      sessions.push({
        endedAt: null, endReason: null, endedByUserId: null, endLat: null, endLng: null, endNote: null,
        countedUntil: null, countedBasis: null, outsideSince: null, outsideCount: 0, askedAt: null, stillHereAt: null,
        lastFixAt: null, lastFixState: null, lastFixDistanceM: null, lastCheckAt: null, countedFrom: null, prevSessionId: null,
        reviewedByUserId: null, reviewedAt: null, reviewNote: null, autoCountedUntil: null, autoCountedBasis: null,
        ...row, id, activeCityKey: row.cityKey, activeEmployeeId: row.employeeId,
      } as TerminalSessionRow);
      return id;
    },
    close: async (id, c) => {
      const s = sessions.find((x) => x.id === id && x.endedAt == null);
      if (!s) return false;
      writes++;
      Object.assign(s, c, { activeCityKey: null, activeEmployeeId: null });
      return true;
    },
    improveCounted: async (id, until, basis) => {
      const s = sessions.find((x) => x.id === id && x.endedAt != null && ["pending", "last_gps", "last_service"].includes(String(x.countedBasis)) && (x.countedUntil == null || x.countedUntil < until));
      if (!s) return false;
      writes++;
      s.countedUntil = until; s.countedBasis = basis;
      return true;
    },
    updateWatch: async (id, f, expected) => {
      const s = sessions.find((x) => x.id === id && x.endedAt == null && (x.lastFixAt ?? null) === expected.lastFixAt && (x.stillHereAt ?? null) === expected.stillHereAt);
      if (!s) return false;
      writes++;
      for (const [k, v] of Object.entries(f)) if (v !== undefined) (s as any)[k] = v;
      return true;
    },
    markAsked: async (id, at, prev) => {
      const s = sessions.find((x) => x.id === id && x.endedAt == null && (x.askedAt ?? null) === prev);
      if (!s) return false;
      writes++;
      s.askedAt = at;
      return true;
    },
    markStillHere: async (id, at, insideAt) => {
      const s = sessions.find((x) => x.id === id && x.endedAt == null);
      if (!s) return false;
      writes++;
      s.stillHereAt = at;
      if (insideAt) { s.lastInsideAt = s.lastInsideAt && s.lastInsideAt > insideAt ? s.lastInsideAt : insideAt; s.outsideSince = null; s.outsideCount = 0; }
      return true;
    },
    closeIfUnanswered: async (id, askedAt, c) => {
      const s = sessions.find((x) => x.id === id && x.endedAt == null && x.askedAt === askedAt && (!x.stillHereAt || x.stillHereAt < x.askedAt!));
      if (!s) return false;
      writes++;
      Object.assign(s, c, { activeCityKey: null, activeEmployeeId: null });
      return true;
    },
    latestByEmployee: async (e) => copy([...sessions].filter((s) => s.employeeId === e).sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : b.id - a.id))[0] ?? null),
    sessionsBetween: async (o) => {
      const a = ms(o.fromUtc), b = ms(o.toUtc);
      return sessions.filter((s) => (o.employeeId == null || s.employeeId === o.employeeId) && (!o.cityKey || s.cityKey === o.cityKey))
        .filter((s) => {
          const start = Math.min(ms(s.startedAt), s.countedFrom ? ms(s.countedFrom) : Infinity);
          const end = Math.max(s.endedAt ? ms(s.endedAt) : Infinity, s.countedUntil ? ms(s.countedUntil) : -Infinity);
          return start < b && end >= a;
        }).map(copy);
    },
    review: async (id, f, expected) => {
      const s = sessions.find((x) => x.id === id && x.endedAt != null && (x.countedBasis ?? null) === expected.countedBasis && (x.countedUntil ?? null) === expected.countedUntil);
      if (!s) return false;
      writes++;
      const keepAuto = s.autoCountedBasis != null;
      Object.assign(s, {
        countedFrom: f.countedFrom, countedUntil: f.countedUntil, countedBasis: f.countedBasis,
        reviewedByUserId: f.reviewedByUserId, reviewedAt: f.reviewedAt, reviewNote: f.reviewNote,
        autoCountedUntil: keepAuto ? s.autoCountedUntil : f.autoCountedUntil, autoCountedBasis: keepAuto ? s.autoCountedBasis : f.autoCountedBasis,
      });
      return true;
    },
    toSettle: async (since, limit) => sessions.filter((s) => s.endedAt && s.endedAt >= since && ["pending", "last_gps"].includes(String(s.countedBasis))).slice(0, limit).map(copy),
    insertHandover: async (row) => {
      const id = nextH++;
      writes++;
      handovers.push({ ...row, id, status: "pending", answeredAt: null, answeredByUserId: null, newSessionId: null, note: null });
      return id;
    },
    handoverById: async (id) => copy(handovers.find((h) => h.id === id) ?? null),
    pendingHandovers: async () => handovers.filter((h) => h.status === "pending").map(copy),
    answerHandover: async (id, status, f) => {
      const h = handovers.find((x) => x.id === id && x.status === "pending");
      if (!h) return false;
      writes++;
      Object.assign(h, { status, answeredAt: f.answeredAt, answeredByUserId: f.answeredByUserId });
      return true;
    },
  });
  const store: TerminalStore & { _: any } = {
    ...ops(),
    transaction: async (fn) => {
      const snap = JSON.stringify({ sessions, handovers, nextId, nextH });
      try { return await fn(ops()); } catch (e) {
        const s = JSON.parse(snap);
        sessions = s.sessions; handovers = s.handovers; nextId = s.nextId; nextH = s.nextH;
        throw e;
      }
    },
    _: {
      get sessions() { return sessions; },
      get writes() { return writes; },
      /** grava uma sessão já feita (fechada ou aberta) */
      seed(row: Partial<TerminalSessionRow>) {
        const id = nextId++;
        sessions.push({
          employeeId: 0, userId: null, cityKey: "lisbon", startedAt: "", startLat: null, startLng: null, startAccuracy: null, startSource: "button",
          startedByUserId: null, endedAt: null, endReason: null, endedByUserId: null, endLat: null, endLng: null, endNote: null, lastInsideAt: null,
          countedUntil: null, countedBasis: null, payUplift: 1, note: null, timeRecordId: null, activeCityKey: null, activeEmployeeId: null,
          outsideSince: null, outsideCount: 0, askedAt: null, stillHereAt: null, countedFrom: null, autoCountedBasis: null, autoCountedUntil: null,
          reviewedAt: null, reviewedByUserId: null, reviewNote: null, lastFixAt: null, lastFixState: null, prevSessionId: null,
          ...row, id,
        } as TerminalSessionRow);
        return id;
      },
    },
  };
  return store;
}

// ─── Pessoas e dependências falsas ───────────────────────────────────────────

const JOAO = 10, PEDRO = 11, RUI = 12, TL_LX = 20;
type Person = { id: number; fullName: string; position: string; contractType: string | null; userId: number; isActive: boolean; cities: TerminalCityKey[]; clock: boolean; users: number[] };
const basePeople = (): Record<number, Person> => ({
  [JOAO]: { id: JOAO, fullName: "João Silva", position: "extra", contractType: "extra", userId: 110, isActive: true, cities: ["lisbon"], clock: true, users: [110] },
  [PEDRO]: { id: PEDRO, fullName: "Pedro Costa", position: "extra", contractType: "extra", userId: 120, isActive: true, cities: ["lisbon"], clock: true, users: [120] },
  [RUI]: { id: RUI, fullName: "Rui Condutor", position: "driver", contractType: "permanent", userId: 130, isActive: true, cities: ["lisbon", "porto"], clock: true, users: [130] },
  [TL_LX]: { id: TL_LX, fullName: "Tiago Líder", position: "team_leader", contractType: "permanent", userId: 900, isActive: true, cities: ["lisbon"], clock: true, users: [900] },
});

function makeDeps(o: { on?: boolean } = {}) {
  const store = memoryStore();
  const people = basePeople();
  const notices: TerminalNotice[] = [];
  const logs: any[] = [];
  const clock = { now: T0 };
  const state = {
    on: o.on ?? true,
    /** posição do Zello de cada pessoa: a leitura é feita na hora do vigia (atraso em segundos) */
    zello: new Map<number, { fix: { lat: number; lng: number; accuracy: number } | null; delayS: number; atMs?: number }>() as Map<number, { fix: { lat: number; lng: number; accuracy: number } | null; delayS: number; atMs?: number }> | null,
    zelloCalls: 0,
    lastService: vi.fn(async (_o: { employeeId: number; inAt: string; outAt: string }): Promise<any> => ({ status: "pending", reason: "no_actions" })),
    closed: new Set<string>(),
    /** entrada do ponto de cada registo (o mês do ordenado é o do turno) */
    clockIns: new Map<number, string>(),
  };
  const deps: TerminalDeps = {
    store,
    now: () => clock.now,
    enabled: async () => state.on,
    airports: async () => DEFAULT_TERMINAL_AIRPORTS,
    person: async (id) => {
      const p = people[id];
      return p ? { id: p.id, fullName: p.fullName, position: p.position, contractType: p.contractType, userId: p.userId, isActive: p.isActive } : null;
    },
    personCities: async (id) => people[id]?.cities ?? [],
    openClock: async (id) => (people[id]?.clock ? { timeRecordId: 1000 + id, since: "2026-10-12 12:00:00" } : null),
    userIdsOf: async (id) => people[id]?.users ?? [],
    tlOnDuty: async (city) => (city === "lisbon" ? [900] : []),
    candidates: async (city) => Object.values(people).filter((p) => p.clock && p.cities.includes(city) && canUseTerminal(p)).map((p) => ({ employeeId: p.id, name: p.fullName, position: p.position })),
    notify: async (n) => { notices.push(n); },
    log: async (e) => { logs.push(e); },
    lastService: (x) => state.lastService(x),
    zelloReadings: async (ids) => {
      state.zelloCalls++;
      if (!state.zello) return null;
      return new Map(ids.map((id): [number, ZelloReading | null] => {
        const z = state.zello!.get(id);
        if (!z?.fix) return [id, null];
        const at = z.atMs ?? clock.now - z.delayS * 1000;
        return [id, { ...z.fix, lastReportDelay: Math.round((clock.now - at) / 1000), lastReportSec: Math.floor(at / 1000) }];
      }));
    },
    closedMonths: async () => state.closed,
    clockInAt: async (id) => state.clockIns.get(id) ?? null,
  };
  /** posição do Zello na próxima volta do vigia (relatório de há `delayS` segundos) */
  const zello = (employeeId: number, fix: { lat: number; lng: number; accuracy: number } | null, delayS = 30, atMs?: number) => {
    state.zello!.set(employeeId, { fix, delayS, atMs });
  };
  const tick = async (minutes: number) => { clock.now += minutes * MIN; return runTerminalWatch(deps); };
  return { deps, store, people, notices, logs, clock, state, zello, tick };
}

const sessionOf = (store: ReturnType<typeof memoryStore>, employeeId: number) => store._.sessions.filter((s: TerminalSessionRow) => s.employeeId === employeeId).at(-1) as TerminalSessionRow;

/** O João entra no terminal às 14:05, o Zello dele diz "dentro" às 14:10 e "fora" a partir das 14:15. */
async function joaoGoesOut() {
  const t = makeDeps();
  await startTerminal(t.deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" });
  t.zello(JOAO, IN_LIS);
  await t.tick(5); // 14:10 dentro
  t.zello(JOAO, FAR_LIS);
  await t.tick(5); // 14:15 fora (1.ª)
  t.zello(JOAO, FAR_LIS);
  await t.tick(5); // 14:20 fora (2.ª) → confirmado, fora desde 14:14:30
  return t;
}

// ─── Leituras do GPS ─────────────────────────────────────────────────────────

describe("leituras do Zello", () => {
  it("dentro / fora com a imprecisão a contar (distância − imprecisão vs raio)", () => {
    const now = T0;
    const r = (fix: { lat: number; lng: number; accuracy: number }, delayS = 30): ZelloReading => ({ ...fix, lastReportDelay: delayS, lastReportSec: Math.floor((now - delayS * 1000) / 1000) });
    expect(classifyReading(r(IN_LIS), LIS, now).state).toBe("inside");
    const far = classifyReading(r(FAR_LIS), LIS, now);
    expect(far.state).toBe("outside");
    expect(Math.abs(far.distanceM! - 3200)).toBeLessThan(10);
    // a 1 900 m com ±500 m toca o raio de 1 500 m → dentro (nunca se diz "fora" a quem pode estar dentro)
    expect(classifyReading(r(north(LIS, 1900, 500)), LIS, now).state).toBe("inside");
    expect(classifyReading(r(north(LIS, 1900, 100)), LIS, now).state).toBe("outside");
  });
  it("GPS velho, pouco preciso, 0,0 ou sem idade → sem GPS (nunca \"fora\")", () => {
    const now = T0;
    expect(classifyReading({ ...FAR_LIS, lastReportDelay: TERMINAL_GPS_STALE_S + 1 }, LIS, now)).toEqual({ state: "no_gps", fixAtMs: null, distanceM: null });
    expect(classifyReading({ ...FAR_LIS, lastReportDelay: 30, lastReportSec: Math.floor(now / 1000) - 3600 }, LIS, now).state).toBe("no_gps"); // o relatório é velho
    expect(classifyReading({ ...FAR_LIS, accuracy: 1500, lastReportDelay: 30 }, LIS, now).state).toBe("no_gps");
    expect(classifyReading({ lat: 0, lng: 0, accuracy: 10, lastReportDelay: 30 }, LIS, now).state).toBe("no_gps");
    expect(classifyReading({ ...FAR_LIS, lastReportDelay: null, lastReportSec: null }, LIS, now).state).toBe("no_gps");
    expect(classifyReading(null, LIS, now).state).toBe("no_gps");
  });
  it("\"fora\" só com 2 leituras seguidas DIFERENTES (a mesma posição repetida não conta)", () => {
    const start = { startedAtMs: T0, lastInsideAtMs: T0, outsideSinceMs: null, outsideCount: 0, lastFixAtMs: null };
    const out1 = nextWatch(start, { state: "outside", fixAtMs: T0 + 10 * MIN, distanceM: 3200 }, T0 + 10 * MIN);
    expect(out1.state).toMatchObject({ outsideCount: 1, outsideSinceMs: T0 + 10 * MIN });
    const same = nextWatch(out1.state, { state: "outside", fixAtMs: T0 + 10 * MIN, distanceM: 3200 }, T0 + 15 * MIN);
    expect(same.newReading).toBe(false);
    expect(same.state.outsideCount).toBe(1);
    const out2 = nextWatch(out1.state, { state: "outside", fixAtMs: T0 + 15 * MIN, distanceM: 3300 }, T0 + 15 * MIN);
    expect(out2.state).toMatchObject({ outsideCount: 2, outsideSinceMs: T0 + 10 * MIN });
    // leituras fora com mais de 15 min entre elas já não são "seguidas": recomeça
    const late = nextWatch(out1.state, { state: "outside", fixAtMs: T0 + 40 * MIN, distanceM: 3300 }, T0 + 40 * MIN);
    expect(late.state).toMatchObject({ outsideCount: 1, outsideSinceMs: T0 + 40 * MIN });
    // voltar a entrar apaga o "fora"
    const back = nextWatch(out2.state, { state: "inside", fixAtMs: T0 + 20 * MIN, distanceM: 300 }, T0 + 20 * MIN);
    expect(back.state).toMatchObject({ outsideCount: 0, outsideSinceMs: null, lastInsideAtMs: T0 + 20 * MIN });
    // sem GPS não muda nada
    expect(nextWatch(out1.state, { state: "no_gps", fixAtMs: null, distanceM: null }, T0 + 30 * MIN).state).toEqual(out1.state);
  });
});

// ─── "Ainda estás no terminal?" ──────────────────────────────────────────────

describe("\"Ainda estás no terminal?\"", () => {
  it("2 leituras fora → ao fim de 20 min pergunta: barra + push à pessoa, sino + push ao TL de serviço; uma só vez", async () => {
    const t = await joaoGoesOut();
    let s = sessionOf(t.store, JOAO);
    expect(s).toMatchObject({ outsideCount: 2, outsideSince: "2026-10-12 13:14:30", lastInsideAt: "2026-10-12 13:09:30", lastFixState: "outside", askedAt: null });
    t.zello(JOAO, FAR_LIS);
    expect((await t.tick(5)).asked).toBe(0); // 14:25 — fora há ~11 min
    t.zello(JOAO, FAR_LIS);
    expect((await t.tick(10)).asked).toBe(1); // 14:35 — fora há ~21 min
    s = sessionOf(t.store, JOAO);
    expect(s.askedAt).toBe("2026-10-12 13:35:00");
    const toJoao = t.notices.find((n) => n.targetUserIds.includes(110) && n.entity.type === "terminal_ask")!;
    expect(toJoao.title).toBe("Ainda estás no terminal de Lisboa?");
    expect(toJoao.push).toMatchObject({ title: "Ainda estás no terminal?", url: "/perfil" });
    expect(toJoao.push!.body).not.toContain("João"); // sem nome (pode ser um PDA)
    const toTl = t.notices.find((n) => n.targetUserIds.includes(900) && n.entity.type === "terminal_ask")!;
    expect(toTl.title).toBe("Terminal de Lisboa: João Silva saiu?");
    expect(toTl.push).toBeTruthy();
    // a barra mostra a pergunta
    const st = await terminalStatus(t.deps, JOAO);
    expect(st.ask).toMatchObject({ message: "Ainda estás no terminal de Lisboa? O GPS diz que saíste às 14:14.", releaseAt: "2026-10-12 13:50:00" });
    // não volta a perguntar enquanto espera
    t.zello(JOAO, FAR_LIS);
    expect((await t.tick(5)).asked).toBe(0);
    expect(t.notices.filter((n) => n.entity.type === "terminal_ask")).toHaveLength(2);
  });
  it("uma só leitura fora (e depois dentro) → não pergunta", async () => {
    const t = makeDeps();
    await startTerminal(t.deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" });
    t.zello(JOAO, FAR_LIS);
    await t.tick(5);
    t.zello(JOAO, IN_LIS);
    await t.tick(5);
    for (let i = 0; i < 12; i++) { t.zello(JOAO, IN_LIS); expect((await t.tick(5)).asked).toBe(0); }
    expect(sessionOf(t.store, JOAO)).toMatchObject({ outsideCount: 0, outsideSince: null, askedAt: null });
  });
  it("GPS velho → sem GPS: nunca \"fora\", nunca pergunta, nunca liberta", async () => {
    const t = makeDeps();
    await startTerminal(t.deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" });
    for (let i = 0; i < 30; i++) {
      t.zello(JOAO, FAR_LIS, TERMINAL_GPS_STALE_S + 60); // posição de há 11 min
      const r = await t.tick(5);
      expect(r).toMatchObject({ asked: 0, released: 0, noGps: 1 });
    }
    expect(sessionOf(t.store, JOAO)).toMatchObject({ outsideCount: 0, askedAt: null, lastFixState: "no_gps", endedAt: null });
    // e o GPS que fica velho a meio de um "fora" não deixa perguntar
    const u = makeDeps();
    await startTerminal(u.deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" });
    u.zello(JOAO, FAR_LIS); await u.tick(5);
    u.zello(JOAO, FAR_LIS); await u.tick(5); // fora confirmado
    for (let i = 0; i < 6; i++) { u.zello(JOAO, FAR_LIS, TERMINAL_GPS_STALE_S + 60); expect((await u.tick(5)).asked).toBe(0); }
  });
  it("Zello em baixo → não muda nada (e nunca rebenta)", async () => {
    const t = makeDeps();
    await startTerminal(t.deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" });
    t.state.zello = null;
    const before = JSON.stringify(sessionOf(t.store, JOAO));
    expect(await t.tick(5)).toMatchObject({ open: 1, zello: false, asked: 0, released: 0 });
    expect(JSON.stringify(sessionOf(t.store, JOAO))).toBe(before);
  });
  it(`sem resposta em ${TERMINAL_NO_ANSWER_MIN} min → liberta o lugar ("saiu do aeroporto às 14:14 (GPS)"), conta até ao último GPS dentro`, async () => {
    const t = await joaoGoesOut();
    t.zello(JOAO, FAR_LIS); await t.tick(15); // 14:35 pergunta
    t.zello(JOAO, FAR_LIS);
    expect((await t.tick(10)).released).toBe(0); // 14:45 ainda a tempo
    t.zello(JOAO, FAR_LIS);
    expect((await t.tick(5)).released).toBe(1); // 14:50 → liberta
    const s = sessionOf(t.store, JOAO);
    expect(s).toMatchObject({
      endReason: "no_answer", endedAt: "2026-10-12 13:50:00", activeCityKey: null,
      endNote: "Sem resposta ao \"Ainda estás no terminal?\" — saiu do aeroporto às 14:14 (GPS)",
      countedBasis: "last_gps", countedUntil: "2026-10-12 13:09:30",
    });
    expect(await t.deps.store.openByCity("lisbon")).toBeNull();
    expect(t.notices.find((n) => n.entity.type === "terminal_release" && n.targetUserIds.includes(110))).toMatchObject({ title: "Saíste do terminal de Lisboa às 14:14 (GPS)" });
    expect(t.notices.find((n) => n.entity.type === "terminal_release" && n.targetUserIds.includes(900))).toMatchObject({ title: "Terminal de Lisboa livre" });
    // a barra: "Saíste às 14:14 — Ainda estou"
    const st = await terminalStatus(t.deps, JOAO);
    expect(st.session).toBeNull();
    expect(st.released).toMatchObject({ cityKey: "lisbon", leftAt: "2026-10-12 13:14:30", reopenUntil: "2026-10-12 14:20:00" });
    expect(st.released!.message).toContain("Saíste do terminal de Lisboa às 14:14 (GPS)");
  });
  it(`"Sim, estou" → não volta a perguntar durante ${TERMINAL_STILL_HERE_QUIET_MIN} min (e não liberta); depois pergunta outra vez`, async () => {
    const t = await joaoGoesOut();
    t.zello(JOAO, FAR_LIS); await t.tick(15); // 14:35 pergunta
    t.clock.now += 2 * MIN; // 14:37
    const r = await answerStillHere(t.deps, { employeeId: JOAO, actorUserId: 110, answer: "yes", fix: null });
    expect(r).toMatchObject({ status: "ok", message: "Obrigado. Não voltamos a perguntar durante 60 min." });
    expect((await terminalStatus(t.deps, JOAO)).ask).toBeNull();
    let asked = 0, released = 0;
    for (let i = 0; i < 11; i++) { t.zello(JOAO, FAR_LIS); const w = await t.tick(5); asked += w.asked; released += w.released; } // até 15:32
    expect({ asked, released }).toEqual({ asked: 0, released: 0 });
    t.zello(JOAO, FAR_LIS);
    expect((await t.tick(5)).asked).toBe(1); // 15:37 — passaram 60 min
    // com o GPS do telemóvel no aeroporto, o "Sim" também é prova
    const u = await joaoGoesOut();
    u.zello(JOAO, FAR_LIS); await u.tick(15);
    await answerStillHere(u.deps, { employeeId: JOAO, actorUserId: 110, answer: "yes", fix: IN_LIS });
    expect(sessionOf(u.store, JOAO)).toMatchObject({ outsideCount: 0, outsideSince: null, lastInsideAt: "2026-10-12 13:35:00" });
  });
  it("\"Já saí\" → fecha à hora a que o GPS o viu sair", async () => {
    const t = await joaoGoesOut();
    t.zello(JOAO, FAR_LIS); await t.tick(15);
    const r = await answerStillHere(t.deps, { employeeId: JOAO, actorUserId: 110, answer: "left", fix: FAR_LIS });
    expect(r).toMatchObject({ status: "closed", endedAt: "2026-10-12 13:14:30", message: "Saíste do terminal às 14:14 (10 min)." });
    expect(sessionOf(t.store, JOAO)).toMatchObject({ endReason: "button", countedBasis: "last_gps", countedUntil: "2026-10-12 13:09:30", activeCityKey: null });
  });
  it("corrida: o vigia não apaga um \"Sim, estou\" com GPS dentro dado enquanto lia (fica para a volta seguinte)", async () => {
    const t = await joaoGoesOut();
    t.zello(JOAO, FAR_LIS); await t.tick(15); // pergunta
    const real = t.store.openAll;
    // o vigia lê as sessões; logo a seguir o João responde "Sim" com o GPS do telemóvel no aeroporto
    t.store.openAll = async () => { const rows = await real(); await answerStillHere(t.deps, { employeeId: JOAO, actorUserId: 110, answer: "yes", fix: IN_LIS }); return rows; };
    t.zello(JOAO, FAR_LIS);
    const w = await t.tick(5);
    t.store.openAll = real;
    expect(w).toMatchObject({ readings: 0, released: 0 });
    expect(sessionOf(t.store, JOAO)).toMatchObject({ outsideCount: 0, outsideSince: null, endedAt: null });
  });
  it("corrida: \"Sim, estou\" no mesmo minuto em que o vigia liberta → só um ganha; o \"Sim\" reabre sem buraco", async () => {
    const t = await joaoGoesOut();
    t.zello(JOAO, FAR_LIS); await t.tick(15); // pergunta
    t.clock.now += 15 * MIN;
    // o "Sim" chega primeiro: o vigia já não liberta (fecho condicional)
    await answerStillHere(t.deps, { employeeId: JOAO, actorUserId: 110, answer: "yes", fix: null });
    t.zello(JOAO, FAR_LIS);
    expect((await runTerminalWatch(t.deps)).released).toBe(0);
    expect(sessionOf(t.store, JOAO).endedAt).toBeNull();
    // ao contrário: o vigia liberta primeiro e o "Sim" reabre (sem buraco)
    const u = await joaoGoesOut();
    u.zello(JOAO, FAR_LIS); await u.tick(15);
    u.zello(JOAO, FAR_LIS); await u.tick(15); // liberta às 14:50
    const r = await answerStillHere(u.deps, { employeeId: JOAO, actorUserId: 110, answer: "yes", fix: null });
    expect(r).toMatchObject({ status: "started", message: "Voltaste ao terminal de Lisboa. Conta a partir de agora (14:50); o tempo em que o GPS te viu fora fica para o RH decidir." });
    expect(sessionOf(u.store, JOAO)).toMatchObject({ startSource: "reopen", startedAt: "2026-10-12 13:50:00", countedFrom: "2026-10-12 13:50:00" });
  });
});

// ─── Reabrir ─────────────────────────────────────────────────────────────────

describe("reabrir depois de libertado", () => {
  async function released() {
    const t = await joaoGoesOut();
    t.zello(JOAO, FAR_LIS); await t.tick(15); // 14:35 pergunta
    t.zello(JOAO, FAR_LIS); await t.tick(15); // 14:50 liberta
    return t;
  }
  it(`até ${TERMINAL_REOPEN_MIN} min: reabre sem buraco (começa onde a outra acabou); as horas só contam com prova`, async () => {
    const t = await released();
    const first = sessionOf(t.store, JOAO);
    t.clock.now += 20 * MIN; // 15:10
    const r = await reopenTerminal(t.deps, { employeeId: JOAO, actorUserId: 110, fix: null });
    expect(r).toMatchObject({ status: "started", message: "Voltaste ao terminal de Lisboa. Conta a partir de agora (15:10); o tempo em que o GPS te viu fora fica para o RH decidir." });
    const s = sessionOf(t.store, JOAO);
    expect(s).toMatchObject({ startSource: "reopen", startedAt: first.endedAt, countedFrom: "2026-10-12 14:10:00", prevSessionId: first.id, lastInsideAt: null, payUplift: 1 });
    expect(t.notices.at(-1)).toMatchObject({ targetUserIds: [900], title: "João Silva voltou ao terminal de Lisboa" });
    // sai sem prova nenhuma → por confirmar (o RH decide)
    t.clock.now += 30 * MIN;
    await stopTerminal(t.deps, { employeeId: JOAO, actorUserId: 110, fix: FAR_LIS });
    expect(sessionOf(t.store, JOAO)).toMatchObject({ countedBasis: "pending", countedUntil: null });
  });
  it(`depois de ${TERMINAL_REOPEN_MIN} min já não reabre ("Estou no terminal" com GPS)`, async () => {
    const t = await released();
    t.clock.now += (TERMINAL_REOPEN_MIN + 1) * MIN;
    expect(await reopenTerminal(t.deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS })).toMatchObject({ status: "refused", reason: "late" });
    expect((await terminalStatus(t.deps, JOAO)).released).toBeNull();
    expect(t.store._.sessions.filter((s: TerminalSessionRow) => s.employeeId === JOAO)).toHaveLength(1);
  });
  it("lugar ocupado entretanto → vai ao TL (aviso), não abre", async () => {
    const t = await released();
    await startTerminal(t.deps, { employeeId: PEDRO, actorUserId: 120, fix: IN_LIS, source: "button" });
    t.clock.now += 5 * MIN;
    const r = await reopenTerminal(t.deps, { employeeId: JOAO, actorUserId: 110, fix: null });
    expect(r).toMatchObject({ status: "busy", holderName: "Pedro Costa" });
    expect((r as any).message).toContain("Pedimos ao TL de serviço para decidir.");
    expect(t.notices.at(-1)).toMatchObject({ targetUserIds: [900], title: "João Silva diz que ainda está no terminal de Lisboa" });
    expect(t.store._.sessions.filter((s: TerminalSessionRow) => s.activeCityKey === "lisbon").map((s: TerminalSessionRow) => s.employeeId)).toEqual([PEDRO]);
  });
  it("alguém esteve lá e já saiu → reabre a partir de quando esse saiu (nunca por cima)", async () => {
    const t = await released();
    t.clock.now += 2 * MIN;
    await startTerminal(t.deps, { employeeId: PEDRO, actorUserId: 120, fix: IN_LIS, source: "button" });
    t.clock.now += 5 * MIN;
    await stopTerminal(t.deps, { employeeId: PEDRO, actorUserId: 120, fix: IN_LIS }); // 14:57
    t.clock.now += 3 * MIN;
    const r = await reopenTerminal(t.deps, { employeeId: JOAO, actorUserId: 110, fix: null });
    expect(r).toMatchObject({ status: "started", message: "Voltaste ao terminal de Lisboa. Conta a partir de agora (15:00); o tempo em que o GPS te viu fora fica para o RH decidir." });
    expect(sessionOf(t.store, JOAO).startedAt).toBe("2026-10-12 13:57:00");
  });
});

// ─── Horas que contam ────────────────────────────────────────────────────────

describe("horas que contam (regra de 7 out)", () => {
  const S = "2026-10-12 13:00:00", E = "2026-10-12 17:00:00";
  it("fecho com GPS dentro → até ao fecho; esquecido nunca prova", () => {
    expect(countedAtClose({ startedAt: S, endedAt: E, insideAtClose: true })).toEqual({ countedUntil: E, countedBasis: "gps_close" });
    expect(countedAtClose({ startedAt: S, endedAt: E, insideAtClose: true, forgotten: true, lastInsideAt: "2026-10-12 15:00:00" })).toEqual({ countedUntil: "2026-10-12 15:00:00", countedBasis: "last_gps" });
  });
  it("senão o maior entre o último GPS dentro e a última recolha/entrega", () => {
    expect(countedAtClose({ startedAt: S, endedAt: E, insideAtClose: false, lastInsideAt: "2026-10-12 15:00:00" })).toEqual({ countedUntil: "2026-10-12 15:00:00", countedBasis: "last_gps" });
    expect(countedAtClose({ startedAt: S, endedAt: E, insideAtClose: null, lastInsideAt: "2026-10-12 15:00:00", lastServiceAt: "2026-10-12 15:30:00" })).toEqual({ countedUntil: "2026-10-12 15:30:00", countedBasis: "last_service" });
    expect(countedAtClose({ startedAt: S, endedAt: E, insideAtClose: null, lastInsideAt: "2026-10-12 15:30:00", lastServiceAt: "2026-10-12 15:00:00" })).toEqual({ countedUntil: "2026-10-12 15:30:00", countedBasis: "last_gps" });
  });
  it("recolha DEPOIS do \"fora\" confirmado não conta; com 1 só leitura fora ainda conta", () => {
    const base = { startedAt: S, endedAt: E, insideAtClose: null, lastInsideAt: "2026-10-12 14:00:00", outsideSince: "2026-10-12 14:10:00", lastServiceAt: "2026-10-12 16:00:00" };
    expect(countedAtClose({ ...base, outsideCount: 2 })).toEqual({ countedUntil: "2026-10-12 14:00:00", countedBasis: "last_gps" });
    expect(countedAtClose({ ...base, outsideCount: 1 })).toEqual({ countedUntil: "2026-10-12 16:00:00", countedBasis: "last_service" });
    expect(countedAtClose({ ...base, outsideCount: 2, lastServiceAt: "2026-10-12 14:05:00" })).toEqual({ countedUntil: "2026-10-12 14:05:00", countedBasis: "last_service" });
  });
  it("sem prova → por confirmar; o GPS do início não é prova de mais nada; a reabertura conta só a partir do \"Ainda estou\"", () => {
    expect(countedAtClose({ startedAt: S, endedAt: E, insideAtClose: false })).toEqual({ countedUntil: null, countedBasis: "pending" });
    expect(countedAtClose({ startedAt: S, endedAt: E, insideAtClose: false, lastInsideAt: S })).toEqual({ countedUntil: null, countedBasis: "pending" });
    expect(countedAtClose({ startedAt: S, countedFrom: "2026-10-12 14:00:00", endedAt: E, insideAtClose: null, lastInsideAt: "2026-10-12 13:30:00" }).countedBasis).toBe("pending");
    expect(countedAtClose({ startedAt: S, countedFrom: "2026-10-12 14:00:00", endedAt: E, insideAtClose: null, lastInsideAt: "2026-10-12 15:00:00" })).toEqual({ countedUntil: "2026-10-12 15:00:00", countedBasis: "last_gps" });
  });
  it("no fecho, a Multipark só é lida até ao \"fora\" confirmado e uma recolha depois disso é ignorada", async () => {
    const t = await joaoGoesOut(); // fora desde 14:14:30 (confirmado)
    t.state.lastService.mockImplementation(async () => ({ status: "partial", terminalUntil: "2026-10-12 14:30:00", lastKind: "recolha", bookingCode: "X", actions: 1 }));
    t.clock.now += 30 * MIN;
    await releaseOnCheckout(t.deps, { employeeId: JOAO, actorUserId: 110, endedAtMs: t.clock.now, fix: FAR_LIS, reason: "checkout", settle: true });
    expect(t.state.lastService).toHaveBeenCalledWith({ employeeId: JOAO, inAt: "2026-10-12 13:05:00", outAt: "2026-10-12 13:14:30" });
    expect(sessionOf(t.store, JOAO)).toMatchObject({ countedBasis: "last_gps", countedUntil: "2026-10-12 13:09:30" });
    // dentro do "antes de sair" conta (melhora o último GPS)
    const u = await joaoGoesOut();
    u.state.lastService.mockImplementation(async () => ({ status: "partial", terminalUntil: "2026-10-12 13:12:00", lastKind: "entrega", bookingCode: "Y", actions: 1 }));
    await releaseOnCheckout(u.deps, { employeeId: JOAO, actorUserId: 110, endedAtMs: u.clock.now, fix: null, reason: "checkout", settle: true });
    expect(sessionOf(u.store, JOAO)).toMatchObject({ countedBasis: "last_service", countedUntil: "2026-10-12 13:12:00" });
  });
  it("TL a fechar sem GPS → conta até ao último GPS dentro (antes ficava por confirmar)", async () => {
    const t = makeDeps();
    await tlPut(t.deps, { userId: 900, role: "team_leader", cities: ["lisbon"] }, { city: "lisbon", employeeId: PEDRO, reason: "GPS do PDA não apanha" });
    t.zello(PEDRO, IN_LIS);
    await t.tick(10);
    t.clock.now += 50 * MIN;
    await stopTerminal(t.deps, { employeeId: PEDRO, actorUserId: 120, fix: null });
    expect(sessionOf(t.store, PEDRO)).toMatchObject({ countedBasis: "last_gps", countedUntil: "2026-10-12 13:14:30" });
  });
  it("repetição de madrugada: melhora com a última recolha/entrega (uma leitura), nunca em meses fechados nem por cima do RH", async () => {
    const t = makeDeps();
    const a = t.store._.seed({ employeeId: JOAO, startedAt: "2026-10-01 09:00:00", endedAt: "2026-10-01 13:00:00", countedBasis: "pending", endReason: "checkout" });
    const b = t.store._.seed({ employeeId: PEDRO, startedAt: "2026-10-01 09:00:00", endedAt: "2026-10-01 13:00:00", countedBasis: "last_gps", countedUntil: "2026-10-01 10:00:00", outsideSince: "2026-10-01 10:30:00", outsideCount: 2, endReason: "no_answer" });
    const c = t.store._.seed({ employeeId: RUI, startedAt: "2026-09-30 23:30:00", endedAt: "2026-10-01 01:30:00", countedBasis: "pending", endReason: "checkout", timeRecordId: 77 });
    t.store._.sessions.find((x: TerminalSessionRow) => x.id === a)!.timeRecordId = 70;
    t.store._.sessions.find((x: TerminalSessionRow) => x.id === b)!.timeRecordId = 71;
    t.state.clockIns = new Map([[70, "2026-10-01 07:00:00"], [71, "2026-10-01 07:30:00"], [77, "2026-09-30 19:00:00"]]); // o do Rui é o turno da noite de 30 set
    t.state.closed = new Set(["2026-09"]);
    t.clock.now = Date.UTC(2026, 9, 2, 3, 30);
    const read = vi.fn(async () => ({ available: true as const, data: { truncated: false, rows: [
      { at: "2026-10-01 11:00:00", kind: "CHECK_OUT", agentUserId: "j" },
      { at: "2026-10-01 10:20:00", kind: "CHECK_IN", agentUserId: "p" },
      { at: "2026-10-01 12:00:00", kind: "CHECK_IN", agentUserId: "p" }, // depois do "fora" do Pedro: não conta
      { at: "2026-10-01 01:00:00", kind: "CHECK_IN", agentUserId: "r" }, // turno de setembro (fechado): não mexe
    ] } }));
    const r = await retryPendingTerminalSessions(t.deps, { deadlineAt: Date.now() + 30_000, read: read as any, agentIdsOf: async (id) => (id === JOAO ? ["j"] : id === PEDRO ? ["p"] : ["r"]) });
    expect(r).toMatchObject({ pending: 3, resolved: 2, closedMonth: 1, readFailed: false });
    expect(read).toHaveBeenCalledTimes(1);
    const byId = (id: number) => t.store._.sessions.find((s: TerminalSessionRow) => s.id === id);
    expect(byId(a)).toMatchObject({ countedBasis: "last_service", countedUntil: "2026-10-01 11:00:00" });
    expect(byId(b)).toMatchObject({ countedBasis: "last_service", countedUntil: "2026-10-01 10:20:00" });
    expect(byId(c)).toMatchObject({ countedBasis: "pending" });
  });
});

// ─── Ordenado e custo dos extras ─────────────────────────────────────────────

describe("ordenado e custo dos extras a partir das sessões", () => {
  const rates = { extraRateByLevel: new Map([[1, 4.5], [2, 5], [3, 5.5], [4, 6]]), extraRateByName: new Map([["junior", 4.5], ["senior", 5], ["terminal", 5.5], ["master", 6]]) };
  const emp = (o: Record<string, unknown> = {}) => ({ id: 1, fullName: "Extra", position: "extra", extraLevel: 1, isActive: 1, ...o });
  // turno 09:00–17:00 (Lisboa = UTC+1): 08:00–16:00 UTC
  const recs = [
    { id: 1, type: "check_in" as const, recordedAt: "2026-10-12 08:00:00" },
    { id: 2, type: "check_out" as const, recordedAt: "2026-10-12 16:00:00", hoursWorked: "8.00" },
  ];
  const shifts = () => countableShifts(pairShifts(recs).shifts);
  const sess = (o: Record<string, unknown>) => ({ startedAt: "2026-10-12 10:00:00", endedAt: "2026-10-12 13:00:00", countedUntil: "2026-10-12 12:00:00", countedBasis: "last_gps", payUplift: 1, ...o });
  const month = (sessions: any[], o: { on?: boolean; e?: Record<string, unknown>; s?: any[] } = {}) => computeEmployeeMonth({
    employee: emp(o.e) as any, year: 2026, month: 10, shifts: o.s ?? shifts(), leaves: [], ...rates, terminalEnabled: o.on ?? true, terminalSessions: sessions,
  });

  it("só as horas que contam, na interseção com o turno, ao nível seguinte", () => {
    const r = month([sess({})]);
    expect(r).toMatchObject({ totalHours: 8, terminalHours: 2, terminalHourlyRate: 5, terminalPayment: 10, extraPayment: 6 * 4.5 + 10 });
    // sessão a começar antes da entrada e a contar depois da saída → só o que cai no turno
    expect(month([sess({ startedAt: "2026-10-12 06:00:00", countedUntil: "2026-10-12 18:00:00", endedAt: "2026-10-12 18:00:00", countedBasis: "gps_close" })]).terminalHours).toBe(8);
    expect(month([sess({ startedAt: "2026-10-12 06:00:00", countedUntil: "2026-10-12 09:30:00", countedBasis: "confirmed" })]).terminalHours).toBe(1.5);
    // a correção do RH (countedFrom) manda no início
    expect(month([sess({ countedFrom: "2026-10-12 11:00:00", countedBasis: "confirmed" })]).terminalHours).toBe(1);
  });
  it("por confirmar e desmarcado não pagam terminal (os por confirmar aparecem à parte)", () => {
    const p = month([sess({ countedBasis: "pending", countedUntil: null })]);
    expect(p).toMatchObject({ terminalHours: 0, terminalPayment: 0, terminalPendingHours: 3, extraPayment: 8 * 4.5 });
    expect(p.warnings.join(" ")).toContain("3 h de terminal por confirmar");
    expect(month([sess({ countedBasis: "rejected" })])).toMatchObject({ terminalHours: 0, terminalPendingHours: 0, extraPayment: 36 });
  });
  it("só extras (nível +1): condutor/TL no terminal não muda o valor; payUplift 0 é ignorado", () => {
    expect(month([sess({ payUplift: 0 })])).toMatchObject({ terminalHours: 0, extraPayment: 36 });
    const driver = month([sess({})], { e: { position: "driver", monthlySalary: 1000 } });
    expect(driver).toMatchObject({ terminalHours: 0, terminalPayment: 0, isExtra: false });
  });
  it("turno do método antigo (histórico) fica como estava, mesmo com sessões", () => {
    const legacy = countableShifts(pairShifts([recs[0], { ...recs[1], terminalStatus: "auto" }]).shifts);
    expect(month([], { s: legacy }).terminalHours).toBe(8);
    expect(month([sess({})], { s: legacy }).terminalHours).toBe(8);
    expect(terminalSplitOfShift({ hours: 8, terminalStatus: "rejected", inAt: recs[0].recordedAt, outAt: recs[1].recordedAt, sessions: [sess({})] }, true)).toEqual({ terminalHours: 0, normalHours: 8 });
  });
  it("horas cortadas/corrigidas encurtam o turno (a sessão depois do fim pago não conta)", () => {
    expect(sessionHoursInShift({ inAt: "2026-10-12 08:00:00", outAt: "2026-10-12 16:00:00", hours: 3 }, [sess({})])).toEqual({ terminalHours: 1, pendingHours: 0 });
    expect(splitTerminalHours([{ hours: 8, inAt: "2026-10-12 08:00:00", outAt: "2026-10-12 16:00:00", sessions: [sess({}), sess({ startedAt: "2026-10-12 14:00:00", endedAt: "2026-10-12 15:00:00", countedBasis: "pending", countedUntil: null })] }], true))
      .toEqual({ normalHours: 6, terminalHours: 2, pendingHours: 1 });
  });
  it("custo dos extras: a mesma regra (sessões do extra, interseção com o turno)", () => {
    const r = { junior: 4.5, senior: 5, terminal: 5.5, master: 6 } as any;
    const ponto = [{ recordedAt: "2026-10-12 16:00:00", hours: "8.00", level: 1, employeeId: 7, projectId: 10, terminalStatus: null, terminalUntil: null, shiftInAt: "2026-10-12 08:00:00" }];
    const opts = (terminal: boolean) => ({ dayOfRecord: () => "2026-10-12", cityOfProject: () => null, terminal });
    const withSessions = { assignments: [], ponto, terminalSessions: new Map([[7, [sess({})]]]) };
    expect(aggregateExtrasCost(withSessions, r, opts(true)).realByDay.get("2026-10-12")).toBe(6 * 4.5 + 2 * 5);
    expect(aggregateExtrasCost(withSessions, r, opts(false)).realByDay.get("2026-10-12")).toBe(8 * 4.5);
    expect(aggregateExtrasCost({ assignments: [], ponto }, r, opts(true)).realByDay.get("2026-10-12")).toBe(8 * 4.5);
  });
  it("meses fechados não mudam: o RH não mexe e a repetição salta; um mês sem sessões dá o mesmo que antes", async () => {
    // um mês já fechado só tem o histórico (sem sessões): o número é o de antes
    const before = computeEmployeeMonth({ employee: emp() as any, year: 2026, month: 10, shifts: shifts(), leaves: [], ...rates, terminalEnabled: true });
    expect(month([])).toEqual(before);
    expect(month([], { on: false })).toEqual(computeEmployeeMonth({ employee: emp() as any, year: 2026, month: 10, shifts: shifts(), leaves: [], ...rates }));
    // o mês é o do turno do ponto: a sessão de 1 out de madrugada no turno da noite de 30 set é de setembro
    expect(touchesClosedMonth(new Set(["2026-09"]), { shiftStartAt: "2026-09-30 19:00:00", instants: ["2026-10-01 00:30:00"] })).toBe("2026-09");
    expect(touchesClosedMonth(new Set(["2026-09"]), { shiftStartAt: "2026-10-01 07:00:00", instants: ["2026-10-01 09:00:00"] })).toBeNull();
    // sem a entrada conhecida, por cautela, 16 h para trás
    expect(touchesClosedMonth(new Set(["2026-09"]), { instants: ["2026-10-01 09:00:00"] })).toBe("2026-09");
    expect(touchesClosedMonth(new Set(["2026-09"]), { instants: ["2026-10-02 12:00:00"] })).toBeNull();
    const t = makeDeps();
    const id = t.store._.seed({ employeeId: JOAO, startedAt: "2026-09-20 09:00:00", endedAt: "2026-09-20 13:00:00", countedBasis: "pending", endReason: "checkout" });
    t.state.closed = new Set(["2026-09"]);
    await expect(rhConfirm(t.deps, { userId: 1 }, { sessionId: id, note: "confirmado com o TL" })).rejects.toThrow("O ordenado de setembro de 2026 já está fechado");
    await expect(rhReject(t.deps, { userId: 1 }, { sessionId: id, note: "não esteve" })).rejects.toThrow("já está fechado");
    expect(t.store._.sessions[0]).toMatchObject({ countedBasis: "pending", reviewedAt: null });
  });
});

// ─── RH ──────────────────────────────────────────────────────────────────────

describe("RH → ficha → Ponto", () => {
  function twoInLisbon() {
    const t = makeDeps();
    const j = t.store._.seed({ employeeId: JOAO, startedAt: "2026-10-12 13:05:00", endedAt: "2026-10-12 14:05:00", countedBasis: "pending", endReason: "checkout" });
    const p = t.store._.seed({ employeeId: PEDRO, startedAt: "2026-10-12 14:05:00", endedAt: "2026-10-12 15:00:00", countedBasis: "gps_close", countedUntil: "2026-10-12 15:00:00", endReason: "button" });
    t.clock.now = Date.UTC(2026, 9, 12, 18, 0);
    return { t, j, p };
  }
  it("confirmar conta o troço todo; fica quem, quando, porquê e o resultado automático de antes", async () => {
    const { t, j } = twoInLisbon();
    const r = await rhConfirm(t.deps, { userId: 5 }, { sessionId: j, note: "confirmado com o TL" });
    expect(r.message).toBe("Terminal confirmado: 14:05–15:05.");
    expect(t.store._.sessions[0]).toMatchObject({ countedBasis: "confirmed", countedFrom: "2026-10-12 13:05:00", countedUntil: "2026-10-12 14:05:00", reviewedByUserId: 5, reviewNote: "confirmado com o TL", autoCountedBasis: "pending" });
    expect(t.logs.at(-1)).toMatchObject({ action: "terminal_rh_confirm" });
    expect(t.logs.at(-1).details).toContain("por confirmar → confirmado 14:05–15:05");
  });
  it("corrigir não deixa sobrepor outro troço na mesma cidade (nem da mesma pessoa); dentro do seu tempo passa", async () => {
    const { t, j } = twoInLisbon();
    await expect(rhCorrect(t.deps, { userId: 5 }, { sessionId: j, from: "2026-10-12 13:05:00", until: "2026-10-12 14:30:00", note: "ficou até às 15h30" }))
      .rejects.toThrow("Sobrepõe-se ao troço de Pedro Costa no terminal de Lisboa (15:05–16:00)");
    expect(t.store._.sessions[0].countedBasis).toBe("pending");
    const ok = await rhCorrect(t.deps, { userId: 5 }, { sessionId: j, from: "2026-10-12 13:15:00", until: "2026-10-12 14:00:00", note: "chegou às 14h15" });
    expect(ok.message).toBe("Terminal corrigido: conta 14:15–15:00.");
    expect(t.store._.sessions[0]).toMatchObject({ countedBasis: "confirmed", countedFrom: "2026-10-12 13:15:00", countedUntil: "2026-10-12 14:00:00" });
    // a mesma pessoa noutra cidade à mesma hora também não
    const k = t.store._.seed({ employeeId: JOAO, cityKey: "porto", startedAt: "2026-10-12 16:00:00", endedAt: "2026-10-12 17:00:00", countedBasis: "pending", endReason: "checkout" });
    await expect(rhCorrect(t.deps, { userId: 5 }, { sessionId: k, from: "2026-10-12 13:30:00", until: "2026-10-12 17:00:00", note: "erro de cidade" })).rejects.toThrow("Sobrepõe-se ao troço de João Silva");
    // horas impossíveis
    await expect(rhCorrect(t.deps, { userId: 5 }, { sessionId: j, from: "2026-10-12 14:00:00", until: "2026-10-12 13:00:00", note: "trocado" })).rejects.toThrow("depois da de início");
    await expect(rhCorrect(t.deps, { userId: 5 }, { sessionId: j, from: "2026-10-12 13:00:00", until: "2026-10-13 13:00:00", note: "futuro" })).rejects.toThrow("futuro");
  });
  it("desmarcar não paga; um troço desmarcado já não bloqueia outro; nada se apaga; sessão aberta não se decide", async () => {
    const { t, j, p } = twoInLisbon();
    await rhReject(t.deps, { userId: 5 }, { sessionId: p, note: "não esteve lá" });
    expect(t.store._.sessions[1]).toMatchObject({ countedBasis: "rejected", countedUntil: "2026-10-12 15:00:00", autoCountedBasis: "gps_close" });
    await rhCorrect(t.deps, { userId: 5 }, { sessionId: j, from: "2026-10-12 13:05:00", until: "2026-10-12 14:30:00", note: "ficou até às 15h30" });
    expect(t.store._.sessions).toHaveLength(2);
    await startTerminal(t.deps, { employeeId: RUI, actorUserId: 130, fix: IN_LIS, source: "button" });
    const open = sessionOf(t.store, RUI);
    await expect(rhConfirm(t.deps, { userId: 5 }, { sessionId: open.id, note: "ainda lá" })).rejects.toThrow("Ainda está no terminal");
    await expect(rhConfirm(t.deps, { userId: 5 }, { sessionId: j, note: "x" })).rejects.toThrow("motivo");
  });
  it("a lista mostra os por confirmar (sem prova, ou \"Ainda estou\" sem prova) e o mês fechado", async () => {
    const { t, j } = twoInLisbon();
    t.store._.seed({ employeeId: JOAO, startedAt: "2026-10-12 16:00:00", endedAt: "2026-10-12 17:00:00", countedBasis: "last_gps", countedUntil: "2026-10-12 16:20:00", stillHereAt: "2026-10-12 16:40:00", endReason: "checkout" });
    const r = await rhSessionsOf(t.deps, { employeeId: JOAO, fromUtc: "2026-10-12 00:00:00", toUtc: "2026-10-13 00:00:00" });
    expect(r.enabled).toBe(true);
    expect(r.sessions.map((s) => [s.id, s.needsReview, s.claimUnproven])).toEqual([[3, true, true], [j, true, false]]);
    expect(r.sessions[0].countedLabel).toBe("contou até 17:20 (último GPS no aeroporto)");
  });
  it("os botões antigos (Confirmar terminal / Desmarcar numa saída) atuam nas sessões do turno", async () => {
    const { t, j } = twoInLisbon();
    const r = await rhSetShift(t.deps, { userId: 5 }, { employeeId: JOAO, inAt: "2026-10-12 12:00:00", outAt: "2026-10-12 19:00:00", terminal: true, note: "confirmado" });
    expect(r).toMatchObject({ changed: 1, message: "Terminal confirmado (1 troço)." });
    expect(t.store._.sessions.find((s: TerminalSessionRow) => s.id === j)).toMatchObject({ countedBasis: "confirmed" });
    await expect(rhSetShift(t.deps, { userId: 5 }, { employeeId: RUI, inAt: "2026-10-12 12:00:00", outAt: "2026-10-12 19:00:00", terminal: true, note: "confirmado" })).rejects.toThrow("Este turno não tem terminal.");
    const rr = src("server/rhRouter.ts");
    const block = rr.slice(rr.indexOf("setTerminal: protectedProcedure"), rr.indexOf("checkIn: protectedProcedure"));
    expect(block).toContain("rhSetShift(");
    expect(block.indexOf("shift && !shift.legacyStatus")).toBeLessThan(block.indexOf("setTimeRecordTerminal("));
  });
  it("corrigir em hora de Lisboa (das–às), a passar a meia-noite", () => {
    expect(correctionRange("2026-10-12 13:05:00", "14:15", "17:20")).toEqual({ from: "2026-10-12 13:15:00", until: "2026-10-12 16:20:00" });
    expect(correctionRange("2026-10-12 21:00:00", "22:30", "01:00")).toEqual({ from: "2026-10-12 21:30:00", until: "2026-10-13 00:00:00" });
    expect(correctionRange("2026-10-12 13:05:00", "25:00", "17:20")).toBeNull();
  });
});

// ─── Resumo do dia: linha do tempo ───────────────────────────────────────────

describe("linha do tempo do terminal (Resumo do dia)", () => {
  it("por ordem, com os buracos \"terminal vazio 12:10–12:40\" só ENTRE pessoas", () => {
    const s = (id: number, name: string, a: string, b: string | null) => ({ id, employeeId: id, name, startedAt: a, endedAt: b, startSource: "button", endReason: b ? "button" : null, countedUntil: null, countedBasis: null });
    const w0 = Date.UTC(2026, 9, 12, 2, 0), w1 = Date.UTC(2026, 9, 13, 2, 0);
    const items = cityDayTimeline([
      s(2, "Pedro", "2026-10-12 11:40:00", "2026-10-12 14:00:00"),
      s(1, "João", "2026-10-12 08:00:00", "2026-10-12 11:10:00"),
      s(3, "Rui", "2026-10-12 14:00:00", null),
    ], w0, w1, Date.UTC(2026, 9, 12, 16, 0));
    expect(items.map((i) => (i.kind === "gap" ? i.label : i.session.name))).toEqual(["João", "terminal vazio 12:10–12:40", "Pedro", "Rui"]);
    expect(items.at(-1)).toMatchObject({ kind: "session", open: true });
  });
  it("pelo servidor: nomes, como fechou e até que hora contou", async () => {
    const t = makeDeps();
    t.store._.seed({ employeeId: JOAO, startedAt: "2026-10-12 08:00:00", endedAt: "2026-10-12 11:10:00", endReason: "no_answer", countedBasis: "last_gps", countedUntil: "2026-10-12 10:40:00", endNote: "Sem resposta — saiu do aeroporto às 11:45 (GPS)" });
    t.store._.seed({ employeeId: PEDRO, startedAt: "2026-10-12 11:40:00", endedAt: "2026-10-12 14:00:00", endReason: "checkout", countedBasis: "gps_close", countedUntil: "2026-10-12 14:00:00" });
    t.clock.now = Date.UTC(2026, 9, 12, 18, 0);
    const r = await terminalDayTimeline(t.deps, { date: "2026-10-12", city: "lisbon" });
    expect(r.enabled).toBe(true);
    expect(r.items.map((i) => i.kind === "gap" ? i.label : `${i.name} · ${i.endReasonLabel} · ${i.countedLabel}`)).toEqual([
      "João Silva · sem resposta · contou até 11:40 (último GPS no aeroporto)",
      "terminal vazio 12:10–12:40",
      "Pedro Costa · saída do ponto · contou até 15:00 (saiu com GPS no aeroporto)",
    ]);
  });
});

// ─── Interruptor desligado ───────────────────────────────────────────────────

describe("interruptor desligado = nada muda", () => {
  it("o vigia não lê o Zello nem grava; as respostas recusam; as leituras dizem \"desligado\"", async () => {
    const t = makeDeps({ on: false });
    t.store._.seed({ employeeId: JOAO, startedAt: "2026-10-12 09:00:00", activeCityKey: "lisbon", activeEmployeeId: JOAO, askedAt: "2026-10-12 09:30:00", outsideSince: "2026-10-12 09:00:00", outsideCount: 2 });
    const before = t.store._.writes;
    expect(await runTerminalWatch(t.deps)).toMatchObject({ skipped: "off", open: 0 });
    expect(t.state.zelloCalls).toBe(0);
    await expect(answerStillHere(t.deps, { employeeId: JOAO, actorUserId: 110, answer: "yes", fix: null })).rejects.toThrow("desligado");
    expect(await reopenTerminal(t.deps, { employeeId: JOAO, actorUserId: 110, fix: null })).toMatchObject({ status: "off" });
    expect(await rhSessionsOf(t.deps, { employeeId: JOAO, fromUtc: "2026-10-01 00:00:00", toUtc: "2026-10-30 00:00:00" })).toEqual({ enabled: false, sessions: [] });
    expect(await terminalDayTimeline(t.deps, { date: "2026-10-12", city: "lisbon" })).toMatchObject({ enabled: false, items: [] });
    expect(await liveByCity(t.deps, { cities: ["lisbon"], manage: [] })).toEqual({ enabled: false, cities: [] });
    expect(await retryPendingTerminalSessions(t.deps, { deadlineAt: Date.now() + 10_000 })).toMatchObject({ skipped: "off" });
    await expect(rhConfirm(t.deps, { userId: 1 }, { sessionId: 1, note: "confirmado" })).rejects.toThrow("desligado");
    expect(t.store._.writes).toBe(before);
    expect(t.notices).toHaveLength(0);
  });
  it("o ordenado e o custo ficam iguais com sessões gravadas", () => {
    const sessions = [{ startedAt: "2026-10-12 10:00:00", endedAt: "2026-10-12 13:00:00", countedUntil: "2026-10-12 13:00:00", countedBasis: "gps_close", payUplift: 1 }];
    expect(terminalSplitOfShift({ hours: 8, inAt: "2026-10-12 08:00:00", outAt: "2026-10-12 16:00:00", sessions }, false)).toEqual({ terminalHours: 0, normalHours: 8 });
    expect(splitTerminalHours([{ hours: 8, inAt: "2026-10-12 08:00:00", sessions }], false)).toEqual({ normalHours: 8, terminalHours: 0, pendingHours: 0 });
    // o ordenado nem lê as sessões com o interruptor desligado
    const pd = src("server/payroll/payrollData.ts");
    expect(pd).toMatch(/const sessionsByEmp = terminalEnabled\s*\?/);
    expect(src("server/finance/extrasCost.ts")).toContain("if (!q.terminal || !ponto.length) return { assignments, ponto };");
  });
  it("o trabalho do agendador sai logo (sem BD do terminal nem Zello)", async () => {
    const { terminalWatchCron } = await import("./cronJobs");
    const r = await terminalWatchCron();
    expect(r).toMatchObject({ httpStatus: 200, done: true, body: { skipped: "off" } });
  });
  it("PONTO_TERMINAL continua desligado por omissão, já pode ser ligado e descreve o B2", () => {
    const f = AUTOMATION_FLAGS.find((x) => x.name === "PONTO_TERMINAL")!;
    expect(f.defaultEnabled).toBe(false);
    expect(automationFlagDefault("PONTO_TERMINAL")).toBe(false);
    expect(f.description).not.toMatch(/não ligar|Ainda não ligar/i);
    for (const t of ["Ainda estás no terminal?", "por confirmar", "só aos extras", "Desligado: nada aparece"]) expect(f.description, t).toContain(t);
  });
});

// ─── Estrutura ───────────────────────────────────────────────────────────────

describe("migração 0640, agendador, push, ligações e ecrãs", () => {
  it("0640 só acrescenta colunas a terminal_sessions e está registada a seguir à 0625", () => {
    expect(MIGRATION_0640_STATEMENTS.every((s) => s.startsWith("ALTER TABLE `terminal_sessions` ADD COLUMN"))).toBe(true);
    for (const c of ["lastFixAt", "lastFixState", "countedFrom", "prevSessionId", "reviewedByUserId", "reviewNote", "autoCountedUntil", "autoCountedBasis"]) {
      expect(MIGRATION_0640_STATEMENTS.join("\n"), c).toContain(`\`${c}\``);
      expect(src("drizzle/schema.ts"), c).toContain(`${c}: `);
    }
    expect(IDEMPOTENT_ERROR_CODES_0640.has("ER_DUP_FIELDNAME")).toBe(true);
    expect(SCHEMA_MIGRATION_IDS.indexOf("0640")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0625"));
  });
  it("vigia de 5 em 5 min no agendador, uma só chamada location/get (máx. 100)", async () => {
    const job = TICK_JOBS.find((j) => j.key === "terminal-watch")!;
    expect(job.cadence).toEqual({ kind: "interval", minutes: 5 });
    expect(job.maxMs).toBeLessThan(50_000);
    expect(CRON_JOBS.some((j) => j.name === "terminal-watch")).toBe(true);
    const { JOB_RUNNERS } = await import("./cronScheduler");
    expect(typeof JOB_RUNNERS["terminal-watch"]).toBe("function");
    const w = src("server/terminalWatch.ts");
    expect(w.match(/getZelloLocations\(\)/g)).toHaveLength(1);
    expect(src("server/zello.ts")).toContain('zelloGet("location/get", { filter: "none", max: "100" })');
    expect(w).not.toMatch(/\.delete\(|DELETE\s+FROM/i);
    expect(src("server/terminalReview.ts")).not.toMatch(/\.delete\(|DELETE\s+FROM/i);
  });
  it("push com o tipo \"terminal\" no service worker (fica até abrir) e as respostas da própria pessoa sem centro de custos", () => {
    const sw = src("client/public/sw.js");
    expect(sw).toContain('data.type === "terminal"');
    expect(sw.slice(sw.indexOf('data.type === "terminal"'), sw.indexOf('const title = data.title || "Chamada WhatsApp"'))).toContain("requireInteraction: true");
    for (const p of ["terminal.answerStillHere", "terminal.reopen"]) expect(isPersonalAccessPath(p), p).toBe(true);
    for (const p of ["terminal.rh.confirm", "terminal.rh.correct", "terminal.dayTimeline"]) expect(isPersonalAccessPath(p), p).toBe(false);
  });
  it("as zonas por terminal validam e um parque dentro de uma zona dá aviso", () => {
    const zones = { ...LIS, zones: [{ label: "T1", lat: LIS.lat, lng: LIS.lng, radiusM: 400 }] };
    expect(validateSetting("ponto.terminalAirports", { ...DEFAULT_TERMINAL_AIRPORTS, lisbon: zones }).ok).toBe(true);
    const parks = [{ projectId: 1, name: "Parque Aeroporto", lat: LIS.lat + 200 / 111_320, lng: LIS.lng }, { projectId: 2, name: "Parque Prior Velho", lat: LIS.lat + 900 / 111_320, lng: LIS.lng }];
    expect(parksInsideZones({ lisbon: zones }, parks)).toEqual([{ city: "lisbon", zone: "T1", park: "Parque Aeroporto", distanceM: 200 }]);
    expect(parksInsideZones({ lisbon: LIS }, parks).map((w) => w.park)).toEqual(["Parque Aeroporto", "Parque Prior Velho"]);
    expect(src("client/src/pages/DefinicoesPage.tsx")).toContain("+ Zona de terminal");
  });
  it("ecrãs: pergunta e reabrir na barra, GPS no Terminal agora, linha do tempo no Resumo do dia, troços na ficha → Ponto", () => {
    const bar = src("client/src/components/terminal/TerminalBar.tsx");
    expect(bar).toContain(">Sim, estou<");
    expect(bar).toContain(">Já saí<");
    expect(bar).toContain('onClick={() => t.reopen()}>Ainda estou<');
    expect(src("client/src/components/terminal/TerminalLiveCard.tsx")).toContain("no aeroporto ✓");
    expect(src("client/src/components/shiftDay/DaySummaryTab.tsx")).toContain("<TerminalDayCard date={date} city={city} />");
    expect(src("client/src/pages/HRPage.tsx")).toContain("<TerminalShiftSessions sessions={shiftSessions}");
  });
});

// sanity: os tempos do plano
it("tempos do plano: 20 min fora, 15 min sem resposta, 60 min depois do \"Sim\", 30 min para reabrir, GPS velho > 10 min", () => {
  expect([TERMINAL_ASK_AFTER_MIN, TERMINAL_NO_ANSWER_MIN, TERMINAL_STILL_HERE_QUIET_MIN, TERMINAL_REOPEN_MIN, TERMINAL_GPS_STALE_S]).toEqual([20, 15, 60, 30, 600]);
  expect(watchDecision({ outsideSinceMs: T0, outsideCount: 2, askedAtMs: null, stillHereAtMs: null, lastFixAtMs: T0 + 19 * MIN }, T0 + 19 * MIN)).toBeNull();
  expect(watchDecision({ outsideSinceMs: T0, outsideCount: 2, askedAtMs: null, stillHereAtMs: null, lastFixAtMs: T0 + 20 * MIN }, T0 + 20 * MIN)).toBe("ask");
  expect(watchDecision({ outsideSinceMs: T0, outsideCount: 2, askedAtMs: T0 + 20 * MIN, stillHereAtMs: null, lastFixAtMs: T0 + 20 * MIN }, T0 + 35 * MIN)).toBe("release");
  expect(overlapConflict({ id: 1, employeeId: 1, cityKey: "lisbon", fromMs: 0, untilMs: 10 }, [], 0)).toBeNull();
  expect(toDbUtc(T0)).toBe("2026-10-12 13:05:00");
});

// ─── Auditoria (B2): casos que o primeiro lote não apanhava ─────────────────

describe("auditoria B2 — vigia", () => {
  it("Zello em baixo com a pergunta à espera → NÃO liberta (sem leitura não se sabe se voltou); volta o Zello e continua fora → liberta", async () => {
    const t = await joaoGoesOut();
    t.zello(JOAO, FAR_LIS); await t.tick(15); // 14:35 pergunta (última leitura fora às 14:34:30)
    expect(sessionOf(t.store, JOAO).askedAt).toBe("2026-10-12 13:35:00");
    t.state.zello = null; // o Zello cai às 14:40
    expect((await t.tick(5)).released).toBe(0); // 14:40
    expect((await t.tick(5)).released).toBe(0); // 14:45
    expect((await t.tick(5)).released).toBe(0); // 14:50 — já devia libertar, mas o Zello não respondeu
    expect(sessionOf(t.store, JOAO)).toMatchObject({ endedAt: null, activeCityKey: "lisbon" });
    // o Zello volta e continua fora (leitura "seguida": ≤ 15 min depois da anterior) → liberta
    t.state.zello = new Map();
    t.zello(JOAO, FAR_LIS, 30, Date.UTC(2026, 9, 12, 13, 49, 0));
    expect((await t.tick(1)).released).toBe(1); // 14:51
    expect(sessionOf(t.store, JOAO)).toMatchObject({ endReason: "no_answer", countedBasis: "last_gps", countedUntil: "2026-10-12 13:09:30" });
  });
  it("Zello em baixo muito tempo → o \"fora\" recomeça quando volta (pergunta outra vez antes de libertar; nunca liberta às cegas)", async () => {
    const t = await joaoGoesOut();
    t.zello(JOAO, FAR_LIS); await t.tick(15); // 14:35 pergunta
    t.state.zello = null;
    let released = 0;
    for (let i = 0; i < 8; i++) released += (await t.tick(5)).released; // até 15:15
    expect(released).toBe(0);
    t.state.zello = new Map();
    t.zello(JOAO, FAR_LIS);
    expect((await t.tick(5)).released).toBe(0); // 15:20: 1.ª leitura depois do buraco → "fora" recomeça
    expect(sessionOf(t.store, JOAO)).toMatchObject({ endedAt: null, outsideCount: 1 });
  });
  it("Zello volta com o GPS dentro → a pergunta responde-se sozinha (nunca liberta)", async () => {
    const t = await joaoGoesOut();
    t.zello(JOAO, FAR_LIS); await t.tick(15);
    t.state.zello = null;
    await t.tick(10); await t.tick(10);
    t.state.zello = new Map();
    t.zello(JOAO, IN_LIS);
    expect((await t.tick(5)).released).toBe(0);
    expect(sessionOf(t.store, JOAO)).toMatchObject({ endedAt: null, outsideSince: null, outsideCount: 0 });
    expect((await terminalStatus(t.deps, JOAO)).ask).toBeNull();
  });
});

describe("auditoria B2 — Zello com mais de 100 utilizadores", () => {
  const loc = (username: string, o: Record<string, unknown> = {}) => ({ username, latitude: IN_LIS.lat, longitude: IN_LIS.lng, accuracy: 20, lastReport: Math.floor(T0 / 1000) - 30, lastReportDelay: 30, ...o });
  const filler = Array.from({ length: 100 }, (_, i) => loc(`outro${i}`));
  it("lista cheia (100) sem o aparelho da pessoa → pede-o à parte (location/getuser), só para quem está no terminal", async () => {
    const { zelloReadingsFor } = await import("./terminalWatch");
    const fetchOne = vi.fn(async (u: string) => (u === "PDA 12" ? loc("PDA 12") : null));
    const r = await zelloReadingsFor({ employeeIds: [JOAO, PEDRO], devices: new Map([[JOAO, "PDA 12"], [PEDRO, "outro3"]]), list: filler, excluded: () => false, fetchOne });
    expect(fetchOne).toHaveBeenCalledTimes(1);
    expect(fetchOne).toHaveBeenCalledWith("PDA 12");
    expect(r.get(JOAO)).toMatchObject({ lat: IN_LIS.lat, lng: IN_LIS.lng, accuracy: 20, lastReportDelay: 30 });
    expect(r.get(PEDRO)).toMatchObject({ lat: IN_LIS.lat });
  });
  it("lista com menos de 100 → não pede nada à parte (quem não vem não tem posição); erro no pedido à parte → sem GPS, nunca rebenta", async () => {
    const { zelloReadingsFor } = await import("./terminalWatch");
    const fetchOne = vi.fn(async () => { throw new Error("Zello 500"); });
    const short = await zelloReadingsFor({ employeeIds: [JOAO], devices: new Map([[JOAO, "PDA 12"]]), list: filler.slice(0, 40), excluded: () => false, fetchOne });
    expect(fetchOne).not.toHaveBeenCalled();
    expect(short.get(JOAO)).toBeNull();
    const failed = await zelloReadingsFor({ employeeIds: [JOAO], devices: new Map([[JOAO, "PDA 12"]]), list: filler, excluded: () => false, fetchOne });
    expect(fetchOne).toHaveBeenCalledTimes(1);
    expect(failed.get(JOAO)).toBeNull();
    // conta excluída do GPS (Definições) → nem se pede
    const ex = vi.fn(async () => loc("PDA 12"));
    expect((await zelloReadingsFor({ employeeIds: [JOAO], devices: new Map([[JOAO, "PDA 12"]]), list: filler, excluded: (u) => u === "PDA 12", fetchOne: ex })).get(JOAO)).toBeNull();
    expect(ex).not.toHaveBeenCalled();
  });
  it("a resposta de location/getuser lê-se em qualquer das formas e nunca dá a posição de outra pessoa", async () => {
    const { parseZelloUserLocation } = await import("./zello");
    const p = { latitude: "38.77", longitude: "-9.13", accuracy: "15", lastReport: "1760274000", lastReportDelay: "40" };
    expect(parseZelloUserLocation({ status: "OK", location: { username: "PDA 12", ...p } }, "pda 12")).toMatchObject({ username: "PDA 12", latitude: 38.77, longitude: -9.13, accuracy: 15, lastReportDelay: 40 });
    expect(parseZelloUserLocation({ status: "OK", locations: [{ username: "PDA 12", ...p }] }, "PDA 12")).toMatchObject({ latitude: 38.77 });
    expect(parseZelloUserLocation({ status: "OK", ...p }, "PDA 12")).toMatchObject({ username: "PDA 12", latitude: 38.77 });
    expect(parseZelloUserLocation({ status: "OK", location: { username: "PDA 13", ...p } }, "PDA 12")).toBeNull();
    expect(parseZelloUserLocation({ status: "Not found" }, "PDA 12")).toBeNull();
    expect(parseZelloUserLocation({ status: "OK", locations: [] }, "PDA 12")).toBeNull();
    expect(parseZelloUserLocation(null, "PDA 12")).toBeNull();
  });
});

describe("auditoria B2 — RH corrige à volta da meia-noite e na mudança de hora", () => {
  it("troço que começou antes da meia-noite: \"00:10–02:00\" é na madrugada SEGUINTE (não no início desse dia)", () => {
    // começou às 23:50 de Lisboa (22:50 UTC, verão)
    expect(correctionRange("2026-10-12 22:50:00", "00:10", "02:00")).toEqual({ from: "2026-10-12 23:10:00", until: "2026-10-13 01:00:00" });
    expect(correctionRange("2026-10-12 22:50:00", "23:55", "01:30")).toEqual({ from: "2026-10-12 22:55:00", until: "2026-10-13 00:30:00" });
    // começou às 00:20 de Lisboa: "23:50" é a noite ANTERIOR (o RH puxa o início para trás)
    expect(correctionRange("2026-10-12 23:20:00", "23:50", "02:00")).toEqual({ from: "2026-10-12 22:50:00", until: "2026-10-13 01:00:00" });
    // de dia continua igual
    expect(correctionRange("2026-10-12 13:05:00", "12:30", "17:20")).toEqual({ from: "2026-10-12 11:30:00", until: "2026-10-12 16:20:00" });
  });
  it("na noite em que a hora muda (25 out 2026) as horas de Lisboa batem certo", () => {
    // 02:30 de Lisboa no domingo 25 out (já inverno, UTC+0) até às 05:00
    expect(correctionRange("2026-10-24 23:30:00", "01:00", "05:00")).toEqual({ from: "2026-10-25 00:00:00", until: "2026-10-25 05:00:00" });
  });
});

describe("auditoria B2 — ecrãs: erro ≠ vazio", () => {
  it("ficha → Ponto: se os troços de terminal não carregam aparece o erro (não fica como \"sem terminal\")", () => {
    expect(src("client/src/components/terminal/TerminalRhSessions.tsx")).toContain("error: enabled ? q.error : null");
    expect(src("client/src/pages/HRPage.tsx")).toContain('{terminalRh.error && <QueryErrorNote error={terminalRh.error}');
    // o Resumo do dia e o "Terminal agora" já mostravam o erro
    expect(src("client/src/components/terminal/TerminalDayCard.tsx")).toContain("if (q.error) return <QueryErrorNote");
    expect(src("client/src/components/terminal/TerminalLiveCard.tsx")).toContain("if (q.error) return <QueryErrorNote");
  });
  it("360 px (capturas do harness): Terminal agora não espreme o nome e o GPS; textos dos selos partem a linha; horas e zonas legíveis", () => {
    const live = src("client/src/components/terminal/TerminalLiveCard.tsx");
    expect(live).toContain('<span className="min-w-0 flex-1 basis-44">'); // os botões descem em vez de espremer
    expect(live.match(/ml-2 whitespace-normal/g)?.length).toBe(3); // no aeroporto ✓ / fora / perguntámos
    expect(src("client/src/components/terminal/TerminalDayCard.tsx")).toContain("text-[11px] whitespace-normal text-left");
    expect(src("client/src/components/terminal/TerminalBar.tsx")).toContain('<span className="min-w-0 flex-1 basis-56">{s.released.message}</span>');
    const rh = src("client/src/components/terminal/TerminalRhSessions.tsx");
    expect(rh).toContain('<div className="grid max-w-xs grid-cols-2 gap-2">');
    expect(rh).not.toContain('className="w-28"');
    expect(src("client/src/pages/DefinicoesPage.tsx")).toContain("grid grid-cols-[1fr_1fr_3.5rem] gap-1 text-[10px] text-muted-foreground");
  });
});

describe("auditoria B2 — vigia: corridas, carga e Zello em baixo", () => {
  it("o cron a correr duas vezes ao mesmo tempo: uma só pergunta, uma só libertação, avisos uma vez", async () => {
    const t = await joaoGoesOut();
    t.zello(JOAO, FAR_LIS);
    t.clock.now += 15 * MIN; // 14:35
    const [a, b] = await Promise.all([runTerminalWatch(t.deps), runTerminalWatch(t.deps)]);
    expect(a.asked + b.asked).toBe(1);
    expect(t.notices.filter((n) => n.entity.type === "terminal_ask")).toHaveLength(2); // pessoa + TL, uma vez
    t.zello(JOAO, FAR_LIS);
    t.clock.now += 15 * MIN; // 14:50
    const [c, d] = await Promise.all([runTerminalWatch(t.deps), runTerminalWatch(t.deps)]);
    expect(c.released + d.released).toBe(1);
    expect(t.notices.filter((n) => n.entity.type === "terminal_release")).toHaveLength(2);
    expect(t.store._.sessions.filter((s: TerminalSessionRow) => s.employeeId === JOAO)).toHaveLength(1);
  });
  it("sem ninguém no terminal o vigia nem chama o Zello (ligado)", async () => {
    const t = makeDeps();
    for (let i = 0; i < 5; i++) expect(await t.tick(5)).toMatchObject({ open: 0, zello: false });
    expect(t.state.zelloCalls).toBe(0);
  });
  it("Zello em baixo → também não pergunta (o vigia só decide com o Zello a responder)", async () => {
    const t = await joaoGoesOut(); // fora confirmado desde 14:14:30
    t.zello(JOAO, FAR_LIS); expect((await t.tick(10)).asked).toBe(0); // 14:30 (fora há ~16 min; leitura das 14:29:30)
    t.state.zello = null;
    expect((await t.tick(5)).asked).toBe(0); // 14:35 — fora há 20 min e a última leitura é de há 5 min, mas o Zello não respondeu agora
    expect(sessionOf(t.store, JOAO).askedAt).toBeNull();
    t.state.zello = new Map();
    t.zello(JOAO, FAR_LIS);
    expect((await t.tick(1)).asked).toBe(1); // 14:36 — o Zello voltou e continua fora
  });
});

describe("auditoria B2 — dinheiro: ordenado = custo dos extras, meia-noite e mês, contas duplas", () => {
  const rates = { extraRateByLevel: new Map([[1, 4.5], [2, 5], [3, 5.5], [4, 6]]), extraRateByName: new Map([["junior", 4.5], ["senior", 5], ["terminal", 5.5], ["master", 6]]) };
  const xr = { junior: 4.5, senior: 5, terminal: 5.5, master: 6 } as any;
  const db = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  let seed = 4242;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];

  it("em 60 meses aleatórios (sessões a cavalo do turno, sobrepostas, todas as bases) o ordenado e o custo dos extras pagam o mesmo", () => {
    for (let i = 0; i < 60; i++) {
      const level = 1 + Math.floor(rnd() * 4);
      const recs: any[] = [], sessions: any[] = [];
      let t = Date.UTC(2026, 9, 1, 5, 0) + Math.floor(rnd() * 20) * 3_600_000, id = 1;
      while (t < Date.UTC(2026, 9, 29)) {
        const inMs = t, h = 1 + Math.floor(rnd() * 44) / 4, outMs = inMs + h * 3_600_000;
        recs.push({ id: id++, type: "check_in", recordedAt: db(inMs) }, { id: id++, type: "check_out", recordedAt: db(outMs), hoursWorked: h.toFixed(2) });
        for (let k = 0; k < 3; k++) {
          const a = inMs + (rnd() - 0.3) * h * 3_600_000, b = a + rnd() * 6 * 3_600_000;
          sessions.push({ startedAt: db(a), endedAt: db(b), countedFrom: rnd() < 0.2 ? db(a + 900_000) : null, countedUntil: db(a + rnd() * (b - a)), countedBasis: pick(["gps_close", "last_gps", "last_service", "confirmed", "pending", "rejected"]), payUplift: pick([0, 1, 1]) });
        }
        t = outMs + (6 + rnd() * 30) * 3_600_000;
      }
      const shifts = countableShifts(pairShifts(recs).shifts);
      const pay = computeEmployeeMonth({ employee: { id: 1, fullName: "X", position: "extra", extraLevel: level, isActive: 1 } as any, year: 2026, month: 10, shifts, leaves: [], ...rates, terminalEnabled: true, terminalSessions: sessions });
      const ponto = shifts.map((s) => ({ recordedAt: s.outAt, hours: String(s.hours), level, employeeId: 1, projectId: 1, terminalStatus: null, terminalUntil: null, shiftInAt: s.inAt }));
      const cost = aggregateExtrasCost({ assignments: [], ponto, terminalSessions: new Map([[1, sessions]]) }, xr, { dayOfRecord: () => "d", cityOfProject: () => null, terminal: true });
      expect(Math.abs((cost.realByDay.get("d") ?? 0) - pay.extraPayment), `mês ${i}`).toBeLessThan(0.01 * shifts.length + 0.011);
      // nunca mais horas de terminal do que as do mês; condutores (payUplift 0) não contam
      expect(pay.terminalHours).toBeLessThanOrEqual(pay.totalHours + 1e-9);
    }
  });
  it("turno da noite de 31 out a 1 nov: as horas de terminal depois da meia-noite são do ordenado de OUTUBRO (o mês do turno), nunca de novembro", () => {
    // 31 out 22:00 → 1 nov 06:00 (Lisboa = UTC desde 25 out); terminal 23:00–02:00 com GPS no fecho
    const recs = [
      { id: 1, type: "check_in" as const, recordedAt: "2026-10-31 22:00:00" },
      { id: 2, type: "check_out" as const, recordedAt: "2026-11-01 06:00:00", hoursWorked: "8.00" },
    ];
    const sessions = [{ startedAt: "2026-10-31 23:00:00", endedAt: "2026-11-01 02:00:00", countedUntil: "2026-11-01 02:00:00", countedBasis: "gps_close", payUplift: 1 }];
    const all = pairShifts(recs).shifts;
    const of = (y: number, m: number) => {
      const first = `${y}-${String(m).padStart(2, "0")}-01`, last = `${y}-${String(m).padStart(2, "0")}-${new Date(Date.UTC(y, m, 0)).getUTCDate()}`;
      return computeEmployeeMonth({ employee: { id: 1, fullName: "X", position: "extra", extraLevel: 1, isActive: 1 } as any, year: y, month: m, shifts: all.filter((s) => s.day >= first && s.day <= last), leaves: [], ...rates, terminalEnabled: true, terminalSessions: sessions });
    };
    expect(of(2026, 10)).toMatchObject({ totalHours: 8, terminalHours: 3 });
    expect(of(2026, 11)).toMatchObject({ totalHours: 0, terminalHours: 0 });
    // passa as 03:00 (início do dia operacional): conta na mesma (não há fecho às 03:00)
    const late = [{ ...sessions[0], endedAt: "2026-11-01 05:00:00", countedUntil: "2026-11-01 05:00:00" }];
    expect(splitTerminalHours(all.map((s) => ({ ...s, sessions: late })), true).terminalHours).toBe(6);
  });
  it("contas duplas: sessões sobrepostas da mesma pessoa e uma reaberta contam o tempo UMA vez; duas saídas no mesmo dia não somam a mesma hora", () => {
    const s1 = { startedAt: "2026-10-12 09:00:00", endedAt: "2026-10-12 12:00:00", countedUntil: "2026-10-12 12:00:00", countedBasis: "gps_close", payUplift: 1 };
    const s2 = { startedAt: "2026-10-12 11:00:00", endedAt: "2026-10-12 13:00:00", countedUntil: "2026-10-12 13:00:00", countedBasis: "confirmed", payUplift: 1 };
    const reopen = { startedAt: "2026-10-12 12:30:00", countedFrom: "2026-10-12 12:45:00", endedAt: "2026-10-12 14:00:00", countedUntil: "2026-10-12 14:00:00", countedBasis: "last_gps", payUplift: 1 };
    // turno 08:00–16:00 UTC (8 h): terminal 09:00–14:00 = 5 h (não 3 + 2 + 1,25)
    expect(sessionHoursInShift({ inAt: "2026-10-12 08:00:00", outAt: "2026-10-12 16:00:00", hours: 8 }, [s1, s2, reopen])).toEqual({ terminalHours: 5, pendingHours: 0 });
    // dois turnos no mesmo dia (08–11 e 12–16): cada um só com a sua parte (3 h + 2 h)
    const two = [
      { hours: 3, inAt: "2026-10-12 08:00:00", outAt: "2026-10-12 11:00:00", sessions: [s1, s2, reopen] },
      { hours: 4, inAt: "2026-10-12 12:00:00", outAt: "2026-10-12 16:00:00", sessions: [s1, s2, reopen] },
    ];
    expect(splitTerminalHours(two, true)).toMatchObject({ terminalHours: 4 }); // 09–11 (2 h) + 12–14 (2 h)
  });
});

describe("auditoria B2 — meses fechados: erro ao ler os fechos ≠ \"nenhum mês fechado\"", () => {
  it("se não se consegue ler os fechos do ordenado, o RH não mexe e a repetição não escreve (nunca abre por engano um mês fechado)", async () => {
    const t = makeDeps();
    const id = t.store._.seed({ employeeId: JOAO, startedAt: "2026-09-20 09:00:00", endedAt: "2026-09-20 13:00:00", countedBasis: "pending", endReason: "checkout" });
    t.deps.closedMonths = async () => { throw new Error("ETIMEDOUT"); };
    t.clock.now = Date.UTC(2026, 8, 25, 10, 0);
    await expect(rhConfirm(t.deps, { userId: 1 }, { sessionId: id, note: "confirmado com o TL" })).rejects.toThrow("Não deu para ver se o ordenado");
    await expect(rhReject(t.deps, { userId: 1 }, { sessionId: id, note: "não esteve" })).rejects.toThrow("Não deu para ver se o ordenado");
    await expect(rhCorrect(t.deps, { userId: 1 }, { sessionId: id, from: "2026-09-20 09:00:00", until: "2026-09-20 11:00:00", note: "só até às 12h" })).rejects.toThrow("Não deu para ver se o ordenado");
    const before = t.store._.writes;
    const read = vi.fn(async () => ({ available: true as const, data: { truncated: false, rows: [{ at: "2026-09-20 12:00:00", kind: "CHECK_OUT", agentUserId: "j" }] } }));
    const r = await retryPendingTerminalSessions(t.deps, { deadlineAt: Date.now() + 30_000, read: read as any, agentIdsOf: async () => ["j"] });
    expect(r).toMatchObject({ pending: 1, resolved: 0, deferred: 1 });
    expect(read).not.toHaveBeenCalled();
    expect(t.store._.writes).toBe(before);
    expect(t.store._.sessions[0]).toMatchObject({ countedBasis: "pending", reviewedAt: null });
    // a lista da ficha continua a abrir (só mostra; quem decide é o servidor)
    expect((await rhSessionsOf(t.deps, { employeeId: JOAO, fromUtc: "2026-09-01 00:00:00", toUtc: "2026-09-30 00:00:00" })).sessions).toHaveLength(1);
  });
});

describe("auditoria B2 — permissões das tRPC novas", () => {
  const router = src("server/terminalRouter.ts");
  const block = (name: string) => {
    const i = router.indexOf(`  ${name}: protectedProcedure`);
    expect(i, name).toBeGreaterThan(-1);
    return router.slice(i, router.indexOf("\n  }),", i) + 6);
  };
  it("\"Sim, estou\" / \"Já saí\" / \"Ainda estou\": a ficha vem SEMPRE de quem pede (não há employeeId na entrada)", () => {
    for (const n of ["answerStillHere", "reopen"]) {
      const b = block(n);
      expect(b, n).toContain("employeeId: await myEmployeeId(ctx.user.id)");
      expect(b, n).not.toMatch(/input\.employeeId|employeeId: z\./);
    }
  });
  it("RH: lista com a guarda do ponto da ficha; confirmar/corrigir/desmarcar só quem gere essa ficha (a da sessão)", () => {
    const rh = router.slice(router.indexOf("  rh: router({"), router.indexOf("  liveByCity:"));
    expect(rh).toContain("await assertCanViewTimeRecords(ctx.user, input.employeeId);");
    expect(rh.match(/await assertManagesSession\(ctx\.user, input\.sessionId\);/g)).toHaveLength(3);
    expect(router).toContain("await assertCanManageEmployee(user, s.employeeId,");
  });
  it("Resumo do dia só das cidades de quem pede; zonas só com Definições", () => {
    const d = block("dayTimeline");
    expect(d).toContain('requireAccess(ctx.user, "passagem_resumo_dia", "view");');
    expect(d).toContain('if (!actor.cities.includes(input.city)) throw new TRPCError({ code: "FORBIDDEN"');
    expect(block("parkPoints")).toContain('requireAccess(ctx.user, "definicoes", "view");');
  });
  it("só as respostas da própria pessoa saltam o centro de custos (as do RH e do TL não)", () => {
    expect(isPersonalAccessPath("terminal.answerStillHere")).toBe(true);
    expect(isPersonalAccessPath("terminal.reopen")).toBe(true);
    for (const p of ["terminal.rh.confirm", "terminal.rh.correct", "terminal.rh.reject", "terminal.rh.list", "terminal.dayTimeline", "terminal.liveByCity", "terminal.tl.put", "terminal.parkPoints"]) expect(isPersonalAccessPath(p), p).toBe(false);
  });
});
