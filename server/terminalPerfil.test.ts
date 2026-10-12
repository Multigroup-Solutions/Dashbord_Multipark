/**
 * TERMINAL PELO PERFIL (plano 56, parte B, entrega B1; decisões do Jorge a
 * 12 out 2026). As regras correm contra uma BD em memória que faz o mesmo que
 * o MySQL: chaves únicas `activeCityKey` / `activeEmployeeId` (ER_DUP_ENTRY)
 * e transações (um erro desfaz tudo). Sem BD real.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routerState = vi.hoisted(() => ({
  deps: null as any,
  people: {} as Record<number, any>,
  inserted: [] as any[],
  logs: [] as any[],
}));

vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => ({ all: true, defaultCityId: null, cityIds: [], projectIds: [], missingCostCenter: false }),
  loadCityAccessParts: async () => {
    const a = { all: true, defaultCityId: null, cityIds: [], projectIds: [], missingCostCenter: false };
    return { access: a, base: a, all: a };
  },
}));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => null,
  getUserPermissionOverrides: async () => ({}),
  getUserModuleOverrides: async () => ({}),
  getUserById: async () => undefined,
  getEmployeeByUserId: async () => undefined,
  getEmployeeById: async (id: number) => routerState.people[id],
  getTimeRecords: async () => [],
  checkGeofenceNote: async () => null,
  logActivity: async (x: any) => { routerState.logs.push(x); },
}));
vi.mock("./rhService", async (original) => ({
  ...(await original<object>()),
  insertTimeRecordAtomic: async (employeeId: number, type: string, data: any) => {
    routerState.inserted.push({ employeeId, type, data });
    // a entrada fica aberta (o ponto da pessoa passa a "em serviço")
    const p = routerState.deps?.__people?.[employeeId];
    if (p) p.clock = type === "check_in";
    return { id: 500 + routerState.inserted.length };
  },
}));
vi.mock("./terminalSessions", async (original) => ({
  ...(await original<object>()),
  realTerminalDeps: async () => routerState.deps,
}));

import { appRouter } from "./routers";
import {
  answerHandover, liveByCity, releaseOnCheckout, requestHandover, startTerminal, stopTerminal, terminalStatus, tlClose, tlPass, tlPut,
  TerminalError, cityKeysOfAccess,
  type HandoverRow, type TerminalActor, type TerminalDeps, type TerminalNotice, type TerminalSessionRow, type TerminalStore, type TerminalStoreOps,
} from "./terminalSessions";
import {
  TERMINAL_MAX_ACCURACY_M, canUseTerminal, closeCounting, distanceLabel, durationLabel, gpsInAirport, matchAirport, terminalPayUplift, zonesOf,
  type TerminalCityKey,
} from "../shared/terminalSession";
import { DEFAULT_TERMINAL_AIRPORTS } from "../shared/pontoTerminal";
import { isExtraEmployee } from "./pontoTerminal";
import { AUTOMATION_FLAGS, automationFlagDefault, validateSetting } from "../shared/appSettings";
import { kindDef } from "../shared/notificationRouting";
import { isPersonalAccessPath } from "./cityAccess";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { MIGRATION_0625_STATEMENTS, IDEMPOTENT_ERROR_CODES_0625 } from "./migrations/migration_0625";

const src = (p: string) => readFileSync(resolve(import.meta.dirname, "..", p), "utf8");

// ─── GPS ─────────────────────────────────────────────────────────────────────
const LIS = DEFAULT_TERMINAL_AIRPORTS.lisbon;
const OPO = DEFAULT_TERMINAL_AIRPORTS.porto;
const north = (base: { lat: number; lng: number }, m: number, accuracy = 20) => ({ lat: base.lat + m / 111_320, lng: base.lng, accuracy });
const IN_LIS = north(LIS, 400);
const IN_OPO = north(OPO, 300);
const FAR_LIS = north(LIS, 3200);

// ─── BD em memória (as mesmas regras do MySQL) ───────────────────────────────

function memoryStore() {
  let sessions: TerminalSessionRow[] = [];
  let handovers: HandoverRow[] = [];
  let nextId = 1, nextH = 1;
  const failInsertFor = new Set<number>();
  const dup = () => Object.assign(new Error("Duplicate entry for key 'uq_terminal_sessions_active_city'"), { code: "ER_DUP_ENTRY", errno: 1062 });
  const copy = <T,>(x: T): T => (x == null ? x : JSON.parse(JSON.stringify(x)));
  let writes = 0;
  const ops = (): TerminalStoreOps => ({
    openByEmployee: async (e) => copy(sessions.find((s) => s.activeEmployeeId === e) ?? null),
    openByCity: async (c) => copy(sessions.find((s) => s.activeCityKey === c) ?? null),
    openAll: async () => sessions.filter((s) => s.activeCityKey != null).map(copy),
    byId: async (id) => copy(sessions.find((s) => s.id === id) ?? null),
    insert: async (row) => {
      if (failInsertFor.has(row.employeeId)) throw new Error("falha simulada a meio da transação");
      if (sessions.some((s) => s.activeCityKey === row.cityKey || s.activeEmployeeId === row.employeeId)) throw dup();
      const id = nextId++;
      writes++;
      sessions.push({
        endedAt: null, endReason: null, endedByUserId: null, endLat: null, endLng: null, endNote: null,
        countedUntil: null, countedBasis: null, ...row, id, activeCityKey: row.cityKey, activeEmployeeId: row.employeeId,
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
    setCounted: async (id, until, basis) => {
      const s = sessions.find((x) => x.id === id && x.countedBasis === "pending");
      if (!s) return false;
      writes++;
      s.countedUntil = until; s.countedBasis = basis;
      return true;
    },
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
      Object.assign(h, { status, answeredAt: f.answeredAt, answeredByUserId: f.answeredByUserId, ...(f.newSessionId != null ? { newSessionId: f.newSessionId } : {}), ...(f.note != null ? { note: f.note } : {}) });
      return true;
    },
  });
  const store: TerminalStore & { _: any } = {
    ...ops(),
    transaction: async (fn) => {
      const snap = JSON.stringify({ sessions, handovers, nextId, nextH });
      try {
        return await fn(ops());
      } catch (e) {
        const s = JSON.parse(snap);
        sessions = s.sessions; handovers = s.handovers; nextId = s.nextId; nextH = s.nextH;
        throw e;
      }
    },
    _: {
      get sessions() { return sessions; },
      get handovers() { return handovers; },
      get writes() { return writes; },
      failInsertFor,
    },
  };
  return store;
}

// ─── Pessoas e dependências falsas ───────────────────────────────────────────

const JOAO = 10, PEDRO = 11, RUI = 12, ANA = 13, SEM_CIDADE = 14, MARTA = 15, TL_LX = 20;
type Person = { id: number; fullName: string; position: string; contractType: string | null; userId: number; isActive: boolean; cities: TerminalCityKey[]; clock: boolean; users: number[] };
const basePeople = (): Record<number, Person> => ({
  [JOAO]: { id: JOAO, fullName: "João Silva", position: "extra", contractType: "extra", userId: 110, isActive: true, cities: ["lisbon"], clock: true, users: [110, 111] },
  [PEDRO]: { id: PEDRO, fullName: "Pedro Costa", position: "extra", contractType: "extra", userId: 120, isActive: true, cities: ["lisbon"], clock: true, users: [120] },
  [RUI]: { id: RUI, fullName: "Rui Condutor", position: "driver", contractType: "permanent", userId: 130, isActive: true, cities: ["lisbon", "porto"], clock: true, users: [130] },
  [ANA]: { id: ANA, fullName: "Ana Backoffice", position: "backoffice", contractType: "permanent", userId: 140, isActive: true, cities: ["lisbon"], clock: true, users: [140] },
  [SEM_CIDADE]: { id: SEM_CIDADE, fullName: "Sem Cidade", position: "extra", contractType: "extra", userId: 150, isActive: true, cities: [], clock: true, users: [150] },
  [MARTA]: { id: MARTA, fullName: "Marta Contrato", position: "driver", contractType: "extra", userId: 160, isActive: true, cities: ["lisbon"], clock: true, users: [160] },
  [TL_LX]: { id: TL_LX, fullName: "Tiago Líder", position: "team_leader", contractType: "permanent", userId: 900, isActive: true, cities: ["lisbon"], clock: true, users: [900] },
});

const T0 = Date.UTC(2026, 9, 12, 13, 5, 0); // 14:05 em Lisboa (verão)

function makeDeps(o: { on?: boolean } = {}) {
  const store = memoryStore();
  const people = basePeople();
  const notices: TerminalNotice[] = [];
  const logs: any[] = [];
  const clock = { now: T0 };
  const state = { on: o.on ?? true, lastService: null as any };
  const deps: TerminalDeps & { __people: Record<number, Person> } = {
    __people: people,
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
    lastService: async () => state.lastService ?? { status: "pending", reason: "no_actions" },
  };
  return { deps, store, people, notices, logs, clock, state };
}

const TL: TerminalActor = { userId: 900, role: "team_leader", cities: ["lisbon"] };

// ─── Regras puras ────────────────────────────────────────────────────────────

describe("regras puras", () => {
  it("quem pode ficar no terminal: extra / condutor / condutor sénior / TL, ou contrato de extra", () => {
    for (const position of ["extra", "driver", "senior_driver", "team_leader"]) expect(canUseTerminal({ position }), position).toBe(true);
    for (const position of ["backoffice", "frontoffice", "supervisor", "director"]) expect(canUseTerminal({ position }), position).toBe(false);
    expect(canUseTerminal({ position: "backoffice", contractType: "extra" })).toBe(true);
    expect(canUseTerminal(null)).toBe(false);
  });
  it("GPS: distância − imprecisão ≤ raio (a imprecisão a tocar a zona)", () => {
    const at1900 = north(LIS, 1900, 0);
    expect(gpsInAirport({ ...at1900, accuracy: 0 }, LIS).inside).toBe(false);
    expect(gpsInAirport({ ...at1900, accuracy: 500 }, LIS).inside).toBe(true);
    expect(matchAirport({ ...at1900, accuracy: TERMINAL_MAX_ACCURACY_M + 1 }, DEFAULT_TERMINAL_AIRPORTS, ["lisbon"])).toMatchObject({ ok: false, reason: "imprecise" });
    expect(matchAirport(null, DEFAULT_TERMINAL_AIRPORTS, ["lisbon"])).toMatchObject({ ok: false, reason: "no_gps" });
    expect(matchAirport({ lat: 0, lng: 0 }, DEFAULT_TERMINAL_AIRPORTS, ["lisbon"])).toMatchObject({ ok: false, reason: "no_gps" });
  });
  it("zonas por terminal (T1/T2): com zonas só elas contam; sem zonas vale o círculo do aeroporto", () => {
    const withZones = { ...LIS, zones: [{ label: "T1", lat: LIS.lat, lng: LIS.lng, radiusM: 300 }, { label: "T2", lat: LIS.lat + 0.01, lng: LIS.lng, radiusM: 200 }] };
    expect(zonesOf(LIS)).toHaveLength(1);
    expect(zonesOf(withZones).map((z) => z.label)).toEqual(["T1", "T2"]);
    expect(gpsInAirport({ ...north(LIS, 600), accuracy: 10 }, withZones).inside).toBe(false); // dentro do círculo, fora das zonas
    expect(gpsInAirport({ ...north(LIS, 600), accuracy: 10 }, LIS).inside).toBe(true);
    expect(gpsInAirport({ lat: LIS.lat + 0.01, lng: LIS.lng, accuracy: 10 }, withZones)).toMatchObject({ inside: true, zone: "T2" });
    // As Definições aceitam as zonas (opcionais) e continuam a aceitar o que já lá está.
    expect(validateSetting("ponto.terminalAirports", DEFAULT_TERMINAL_AIRPORTS).ok).toBe(true);
    expect(validateSetting("ponto.terminalAirports", { ...DEFAULT_TERMINAL_AIRPORTS, lisbon: withZones }).ok).toBe(true);
    expect(validateSetting("ponto.terminalAirports", { ...DEFAULT_TERMINAL_AIRPORTS, lisbon: { ...LIS, zones: [{ lat: 1, lng: 1, radiusM: 10 }] } }).ok).toBe(false);
  });
  it("textos: distância, duração e fecho", () => {
    expect(distanceLabel(3200)).toBe("a 3,2 km");
    expect(distanceLabel(800)).toBe("a 800 m");
    expect(durationLabel(0, (3 * 60 + 15) * 60_000)).toBe("3 h 15");
    expect(durationLabel(0, 45 * 60_000)).toBe("45 min");
    expect(closeCounting({ endedAtMs: T0, insideAtClose: true })).toEqual({ countedUntil: "2026-10-12 13:05:00", countedBasis: "gps_close" });
    expect(closeCounting({ endedAtMs: T0, insideAtClose: false })).toEqual({ countedUntil: null, countedBasis: "pending" });
    expect(closeCounting({ endedAtMs: T0, insideAtClose: true, forgotten: true }).countedBasis).toBe("pending");
  });
  it("cidades do acesso → chaves", () => {
    expect(cityKeysOfAccess({ all: true })).toEqual(["lisbon", "porto", "faro"]);
    expect(cityKeysOfAccess({ all: false, cityNames: ["Porto", "Lisboa"] })).toEqual(["lisbon", "porto"]);
    expect(cityKeysOfAccess(null)).toEqual([]);
  });
});

// ─── 1 por cidade, 1 por pessoa ──────────────────────────────────────────────

describe("duas pessoas na mesma cidade → a segunda fica \"ocupado\"", () => {
  it("o João entra; o Pedro recebe quem está e desde quando + \"Pedir a João para passar\"", async () => {
    const { deps, store } = makeDeps();
    const a = await startTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" });
    expect(a).toMatchObject({ status: "started", message: "Estás no terminal de Lisboa desde 14:05." });
    const b = await startTerminal(deps, { employeeId: PEDRO, actorUserId: 120, fix: IN_LIS, source: "button" });
    expect(b).toMatchObject({
      status: "busy", cityKey: "lisbon", holderName: "João Silva", holderEmployeeId: JOAO,
      message: "O terminal de Lisboa está com João Silva desde 14:05.", requestLabel: "Pedir a João para passar",
    });
    expect(store._.sessions.filter((s: TerminalSessionRow) => s.activeCityKey === "lisbon")).toHaveLength(1);
  });
  it("é a BD que decide: dois toques ao mesmo tempo → a chave única recusa (ER_DUP_ENTRY) e responde \"ocupado\"", async () => {
    const { deps, store } = makeDeps();
    await startTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" });
    // a leitura do Pedro ainda não viu o João (corrida): só a chave única o trava
    const real = store.openByCity;
    let first = true;
    store.openByCity = async (c) => { if (first) { first = false; return null; } return real(c); };
    const b = await startTerminal(deps, { employeeId: PEDRO, actorUserId: 120, fix: IN_LIS, source: "button" });
    expect(b.status).toBe("busy");
    expect(store._.sessions).toHaveLength(1);
  });
  it("a mesma pessoa a carregar duas vezes → \"já estás\" (sem segunda sessão)", async () => {
    const { deps, store } = makeDeps();
    await startTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" });
    const again = await startTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" });
    expect(again.status).toBe("already");
    expect(store._.sessions).toHaveLength(1);
  });
});

describe("a mesma pessoa não abre em duas cidades", () => {
  it("o Rui (Lisboa + Porto) está em Lisboa: no Porto é recusado, pelo botão e pelo TL", async () => {
    const { deps, store } = makeDeps();
    expect((await startTerminal(deps, { employeeId: RUI, actorUserId: 130, fix: IN_LIS, source: "button" })).status).toBe("started");
    const porto = await startTerminal(deps, { employeeId: RUI, actorUserId: 130, fix: IN_OPO, source: "button" });
    expect(porto).toMatchObject({ status: "refused", message: "Já estás no terminal de Lisboa desde 14:05. Sai primeiro." });
    await expect(tlPut(deps, { userId: 901, role: "supervisor", cities: ["porto"] }, { city: "porto", employeeId: RUI, reason: "falta gente" }))
      .rejects.toThrow("Rui Condutor já está no terminal de Lisboa desde 14:05.");
    // e a própria BD recusa (chave única da pessoa)
    await expect(store.insert({ employeeId: RUI, userId: 130, cityKey: "porto", startedAt: "2026-10-12 13:10:00", startLat: null, startLng: null, startAccuracy: null, startSource: "tl", startedByUserId: 901, lastInsideAt: null, payUplift: 0, note: null, timeRecordId: null }))
      .rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    expect(store._.sessions.filter((s: TerminalSessionRow) => s.activeEmployeeId === RUI)).toHaveLength(1);
  });
});

describe("GPS e cidades", () => {
  it("fora da zona → recusa com a distância", async () => {
    const { deps, store } = makeDeps();
    const r = await startTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: FAR_LIS, source: "button" });
    expect(r).toMatchObject({ status: "refused", reason: "outside", message: "Não estás no aeroporto de Lisboa (a 3,2 km)." });
    expect(store._.sessions).toHaveLength(0);
  });
  it("cidade fora do acesso → recusa (o João só trabalha em Lisboa)", async () => {
    const { deps, store } = makeDeps();
    const r = await startTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: IN_OPO, source: "button" });
    expect(r).toMatchObject({ status: "refused", reason: "other_city", message: "O aeroporto do Porto não é de uma cidade onde trabalhas. Fala com o teu TL." });
    const none = await startTerminal(deps, { employeeId: SEM_CIDADE, actorUserId: 150, fix: IN_LIS, source: "button" });
    expect(none).toMatchObject({ status: "refused", reason: "no_city" });
    expect(store._.sessions).toHaveLength(0);
  });
  it("sem ponto aberto → abre a entrada do ponto (need_checkin); posto sem terminal → recusa", async () => {
    const { deps, people } = makeDeps();
    people[JOAO].clock = false;
    expect((await startTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" })).status).toBe("need_checkin");
    expect(await startTerminal(deps, { employeeId: ANA, actorUserId: 140, fix: IN_LIS, source: "button" })).toMatchObject({ status: "refused", reason: "position" });
  });
});

// ─── Troca ───────────────────────────────────────────────────────────────────

describe("troca numa transação", () => {
  it("Pedro pede → sino ao João (todas as contas) e ao TL de serviço; João \"Passa\" → troca no mesmo instante", async () => {
    const { deps, store, notices, clock } = makeDeps();
    const j = await startTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" });
    clock.now += 60 * 60_000;
    const req = await requestHandover(deps, { employeeId: PEDRO, actorUserId: 120, fix: IN_LIS });
    expect(req).toMatchObject({ status: "requested", message: "Pedido enviado a João. Espera pela resposta." });
    const n = notices.at(-1)!;
    expect(n.targetUserIds.sort()).toEqual([110, 111, 900]);
    expect(n.title).toBe("Pedro Costa pede o terminal de Lisboa");
    // pedir outra vez não cria outro pedido
    const again = await requestHandover(deps, { employeeId: PEDRO, actorUserId: 120, fix: IN_LIS });
    expect((again as any).requestId).toBe((req as any).requestId);
    expect(store._.handovers).toHaveLength(1);
    // a barra do João mostra o pedido
    const st = await terminalStatus(deps, JOAO);
    expect(st.incoming).toMatchObject({ requesterName: "Pedro Costa" });
    expect((await terminalStatus(deps, PEDRO)).outgoing).toMatchObject({ holderFirstName: "João" });

    clock.now += 2 * 60_000;
    const r = await answerHandover(deps, { employeeId: JOAO, actorUserId: 110, requestId: (req as any).requestId, answer: "pass", fix: IN_LIS });
    expect(r.status).toBe("passed");
    expect(r.message).toMatch(/^Passaste o terminal a Pedro\. Saíste do terminal às 15:07 \(1 h 02\)\.$/);
    const old = store._.sessions.find((s: TerminalSessionRow) => s.id === (j as any).session.id)!;
    expect(old).toMatchObject({ endReason: "handover", activeCityKey: null, activeEmployeeId: null, countedBasis: "gps_close", endedAt: "2026-10-12 14:07:00" });
    const now = store._.sessions.find((s: TerminalSessionRow) => s.activeCityKey === "lisbon")!;
    expect(now).toMatchObject({ employeeId: PEDRO, startSource: "handover", startedAt: "2026-10-12 14:07:00", lastInsideAt: "2026-10-12 14:05:00", payUplift: 1 });
    expect(store._.handovers[0]).toMatchObject({ status: "passed", newSessionId: now.id });
    expect(notices.at(-1)).toMatchObject({ targetUserIds: [120], title: "João Silva passou-te o terminal de Lisboa" });
  });
  it("um erro a meio desfaz tudo: o João continua no terminal e o pedido continua pendente", async () => {
    const { deps, store } = makeDeps();
    await startTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" });
    const req = await requestHandover(deps, { employeeId: PEDRO, actorUserId: 120, fix: IN_LIS });
    store._.failInsertFor.add(PEDRO);
    await expect(answerHandover(deps, { employeeId: JOAO, actorUserId: 110, requestId: (req as any).requestId, answer: "pass", fix: null })).rejects.toThrow("falha simulada");
    expect(store._.sessions.filter((s: TerminalSessionRow) => s.activeCityKey === "lisbon").map((s: TerminalSessionRow) => s.employeeId)).toEqual([JOAO]);
    expect(store._.sessions).toHaveLength(1);
    expect(store._.handovers[0].status).toBe("pending");
  });
  it("o colega já está noutro terminal → a BD recusa, nada muda e o pedido fica cancelado", async () => {
    const { deps, store } = makeDeps();
    await startTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" });
    const req = await requestHandover(deps, { employeeId: RUI, actorUserId: 130, fix: IN_LIS });
    await tlPut(deps, { userId: 901, role: "supervisor", cities: ["porto"] }, { city: "porto", employeeId: RUI, reason: "falta gente no Porto" });
    await expect(answerHandover(deps, { employeeId: JOAO, actorUserId: 110, requestId: (req as any).requestId, answer: "pass", fix: null }))
      .rejects.toThrow("Não deu para passar: Rui Condutor já está noutro terminal. Ficas no terminal.");
    expect(store._.sessions.find((s: TerminalSessionRow) => s.activeCityKey === "lisbon")?.employeeId).toBe(JOAO);
    expect(store._.handovers[0].status).toBe("cancelled");
  });
  it("\"Ainda estou\": o João fica, o Pedro é avisado; só o João responde ao pedido dele", async () => {
    const { deps, store, notices } = makeDeps();
    await startTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" });
    const req = await requestHandover(deps, { employeeId: PEDRO, actorUserId: 120, fix: IN_LIS });
    await expect(answerHandover(deps, { employeeId: PEDRO, actorUserId: 120, requestId: (req as any).requestId, answer: "pass", fix: null })).rejects.toThrow("Este pedido não é para ti.");
    const r = await answerHandover(deps, { employeeId: JOAO, actorUserId: 110, requestId: (req as any).requestId, answer: "stay", fix: null });
    expect(r).toMatchObject({ status: "declined", message: "Ficaste no terminal. Já dissemos a Pedro." });
    expect(store._.handovers[0].status).toBe("declined");
    expect(store._.sessions.find((s: TerminalSessionRow) => s.activeCityKey === "lisbon")?.employeeId).toBe(JOAO);
    expect(notices.at(-1)).toMatchObject({ targetUserIds: [120], title: "João Silva ainda está no terminal de Lisboa" });
  });
  it("pedido caducado (mais de 30 min) já não passa", async () => {
    const { deps, store, clock } = makeDeps();
    await startTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" });
    const req = await requestHandover(deps, { employeeId: PEDRO, actorUserId: 120, fix: IN_LIS });
    clock.now += 31 * 60_000;
    await expect(answerHandover(deps, { employeeId: JOAO, actorUserId: 110, requestId: (req as any).requestId, answer: "pass", fix: null })).rejects.toThrow("O pedido caducou");
    expect(store._.handovers[0].status).toBe("expired");
  });
});

describe("takeover quando o outro não tem ponto aberto", () => {
  it("o João já não tem ponto: o Pedro entra logo (fecha a do João e abre a dele na mesma transação) e fica registado", async () => {
    const { deps, store, people, notices, logs } = makeDeps();
    await startTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" });
    people[JOAO].clock = false; // (a libertação na saída do ponto falhou)
    const r = await startTerminal(deps, { employeeId: PEDRO, actorUserId: 120, fix: IN_LIS, source: "button" });
    expect(r).toMatchObject({ status: "started", takeoverFrom: "João Silva" });
    expect((r as any).message).toContain("João já não tinha o ponto aberto.");
    const joao = store._.sessions.find((s: TerminalSessionRow) => s.employeeId === JOAO)!;
    expect(joao).toMatchObject({ endReason: "checkout", activeCityKey: null, countedBasis: "pending" });
    expect(joao.endNote).toContain("já não tinha o ponto aberto");
    expect(store._.sessions.find((s: TerminalSessionRow) => s.activeCityKey === "lisbon")).toMatchObject({ employeeId: PEDRO, startSource: "takeover" });
    expect(logs.some((l) => l.action === "terminal_takeover")).toBe(true);
    expect(notices.at(-1)!.targetUserIds.sort()).toEqual([110, 111, 900]);
  });
  it("também pelo pedido: sem ponto do João não há espera", async () => {
    const { deps, store, people } = makeDeps();
    await startTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" });
    people[JOAO].clock = false;
    const r = await requestHandover(deps, { employeeId: PEDRO, actorUserId: 120, fix: IN_LIS });
    expect(r.status).toBe("started");
    expect(store._.handovers).toHaveLength(0);
  });
  it("a falhar a meio, o João fica como estava (transação)", async () => {
    const { deps, store, people } = makeDeps();
    await startTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" });
    people[JOAO].clock = false;
    store._.failInsertFor.add(PEDRO);
    await expect(startTerminal(deps, { employeeId: PEDRO, actorUserId: 120, fix: IN_LIS, source: "button" })).rejects.toThrow("falha simulada");
    expect(store._.sessions.find((s: TerminalSessionRow) => s.activeCityKey === "lisbon")?.employeeId).toBe(JOAO);
  });
});

// ─── Libertar ────────────────────────────────────────────────────────────────

describe("check-out liberta o lugar", () => {
  it("saída do ponto no aeroporto → fecha (checkout) e conta até à saída; o lugar fica livre", async () => {
    const { deps, store, clock } = makeDeps();
    await startTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" });
    clock.now += (3 * 60 + 15) * 60_000;
    const rel = await releaseOnCheckout(deps, { employeeId: JOAO, actorUserId: 110, endedAtMs: clock.now, fix: IN_LIS, reason: "checkout", settle: true });
    expect(rel?.message).toBe("Saíste do terminal às 17:20 (3 h 15).");
    expect(store._.sessions[0]).toMatchObject({ endReason: "checkout", countedBasis: "gps_close", countedUntil: "2026-10-12 16:20:00", activeCityKey: null, activeEmployeeId: null });
    expect((await startTerminal(deps, { employeeId: PEDRO, actorUserId: 120, fix: IN_LIS, source: "button" })).status).toBe("started");
  });
  it("saída fora (ou sem GPS) → \"pending\"; com uma recolha/entrega dele lá dentro passa a \"last_service\"", async () => {
    const { deps, store, clock, state } = makeDeps();
    await startTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" });
    clock.now += 2 * 3_600_000;
    state.lastService = { status: "partial", terminalUntil: "2026-10-12 14:40:00", lastKind: "entrega", bookingCode: "X1", actions: 3 };
    await releaseOnCheckout(deps, { employeeId: JOAO, actorUserId: 110, endedAtMs: clock.now, fix: FAR_LIS, reason: "checkout", settle: true });
    expect(store._.sessions[0]).toMatchObject({ countedBasis: "last_service", countedUntil: "2026-10-12 14:40:00" });
  });
  it("ponto esquecido fechado sozinho (stale_checkout) → liberta, nunca prova nada, nunca antes do início", async () => {
    const { deps, store } = makeDeps();
    await startTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" });
    await releaseOnCheckout(deps, { employeeId: JOAO, actorUserId: null, endedAtMs: T0 - 3_600_000, fix: IN_LIS, reason: "stale_checkout" });
    expect(store._.sessions[0]).toMatchObject({ endReason: "stale_checkout", countedBasis: "pending", endedAt: "2026-10-12 13:05:00", activeCityKey: null });
  });
  it("sem sessão → nada (e nunca lança)", async () => {
    const { deps, store } = makeDeps();
    expect(await releaseOnCheckout(deps, { employeeId: PEDRO, actorUserId: 120, endedAtMs: T0, fix: null, reason: "checkout" })).toBeNull();
    store.openByEmployee = async () => { throw new Error("BD em baixo"); };
    expect(await releaseOnCheckout(deps, { employeeId: PEDRO, actorUserId: 120, endedAtMs: T0, fix: null, reason: "checkout" })).toBeNull();
  });
  it("\"Sair\" com confirmação: fecha pelo botão e cancela pedidos pendentes", async () => {
    const { deps, store, clock } = makeDeps();
    await startTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" });
    await requestHandover(deps, { employeeId: PEDRO, actorUserId: 120, fix: IN_LIS });
    clock.now += 45 * 60_000;
    const r = await stopTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: null });
    expect(r.message).toBe("Saíste do terminal às 14:50 (45 min).");
    expect(store._.sessions[0]).toMatchObject({ endReason: "button", countedBasis: "pending" });
    expect(store._.handovers[0].status).toBe("cancelled");
    await expect(stopTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: null })).rejects.toThrow("Não estás no terminal.");
  });
});

// ─── Pagamento ───────────────────────────────────────────────────────────────

describe("payUplift só para extras", () => {
  it("regra pura", () => {
    expect(terminalPayUplift({ position: "extra" })).toBe(1);
    expect(terminalPayUplift({ position: "driver", contractType: "extra" })).toBe(1);
    expect(terminalPayUplift({ position: "driver", contractType: "permanent" })).toBe(0);
    expect(terminalPayUplift({ position: "senior_driver" })).toBe(0);
    expect(terminalPayUplift({ position: "team_leader" })).toBe(0);
    // a mesma regra do ordenado (isExtraEmployee)
    for (const e of [{ position: "extra" }, { position: "driver", contractType: "extra" }, { position: "driver" }, { position: "team_leader" }]) {
      expect(terminalPayUplift(e) === 1, JSON.stringify(e)).toBe(isExtraEmployee(e));
    }
  });
  it("gravado na sessão: extra 1; condutor e TL ficam no terminal com 0; contrato de extra 1", async () => {
    const { deps, store } = makeDeps();
    await startTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" });
    expect(store._.sessions.at(-1)!.payUplift).toBe(1);
    await stopTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: null });
    await startTerminal(deps, { employeeId: RUI, actorUserId: 130, fix: IN_LIS, source: "button" });
    expect(store._.sessions.at(-1)!.payUplift).toBe(0);
    await stopTerminal(deps, { employeeId: RUI, actorUserId: 130, fix: null });
    await startTerminal(deps, { employeeId: TL_LX, actorUserId: 900, fix: IN_LIS, source: "button" });
    expect(store._.sessions.at(-1)!).toMatchObject({ employeeId: TL_LX, payUplift: 0 });
    await stopTerminal(deps, { employeeId: TL_LX, actorUserId: 900, fix: null });
    await startTerminal(deps, { employeeId: MARTA, actorUserId: 160, fix: IN_LIS, source: "button" });
    expect(store._.sessions.at(-1)!.payUplift).toBe(1);
  });
});

// ─── TL e supervisor ─────────────────────────────────────────────────────────

describe("TL pode pôr / passar / fechar só na cidade dele", () => {
  it("Pôr (sem GPS, com motivo, fica registado quem pôs) → Passar (uma transação) → Fechar", async () => {
    const { deps, store, logs, notices } = makeDeps();
    const put = await tlPut(deps, TL, { city: "lisbon", employeeId: PEDRO, reason: "GPS do PDA não apanha" });
    const s1 = store._.sessions.find((s: TerminalSessionRow) => s.id === put.sessionId)!;
    expect(s1).toMatchObject({ employeeId: PEDRO, startSource: "tl", startedByUserId: 900, note: "GPS do PDA não apanha", lastInsideAt: null, startLat: null });
    expect(notices.at(-1)).toMatchObject({ targetUserIds: [120], title: "Estás no terminal de Lisboa" });

    const pass = await tlPass(deps, TL, { city: "lisbon", toEmployeeId: JOAO, reason: "troca de turno" });
    expect(pass.message).toBe("O terminal de Lisboa passou de Pedro Costa para João Silva.");
    expect(store._.sessions.find((s: TerminalSessionRow) => s.id === put.sessionId)).toMatchObject({ endReason: "tl", endedByUserId: 900, activeCityKey: null });
    expect(store._.sessions.find((s: TerminalSessionRow) => s.activeCityKey === "lisbon")).toMatchObject({ employeeId: JOAO, startSource: "tl" });

    const close = await tlClose(deps, TL, { city: "lisbon", reason: "voo cancelado" });
    expect(close.message).toBe("Terminal de Lisboa fechado (João Silva).");
    expect(store._.sessions.some((s: TerminalSessionRow) => s.activeCityKey === "lisbon")).toBe(false);
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(["terminal_tl_put", "terminal_tl_pass", "terminal_tl_close"]));
  });
  it("noutra cidade, abaixo de TL, sem motivo ou a pessoa sem ponto → recusa", async () => {
    const { deps, store, people } = makeDeps();
    await expect(tlPut(deps, TL, { city: "porto", employeeId: RUI, reason: "falta gente" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(tlPut(deps, { userId: 120, role: "extra", cities: ["lisbon"] }, { city: "lisbon", employeeId: JOAO, reason: "porque sim" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(tlPut(deps, TL, { city: "lisbon", employeeId: JOAO, reason: "x" })).rejects.toThrow("Escreve o motivo");
    people[JOAO].clock = false;
    await expect(tlPut(deps, TL, { city: "lisbon", employeeId: JOAO, reason: "falta gente" })).rejects.toThrow("João Silva não tem o ponto aberto.");
    await expect(tlPut(deps, TL, { city: "lisbon", employeeId: SEM_CIDADE, reason: "falta gente" })).rejects.toThrow("Sem Cidade não trabalha em Lisboa.");
    await expect(tlClose(deps, TL, { city: "lisbon", reason: "voo cancelado" })).rejects.toThrow("O terminal de Lisboa já está livre.");
    await tlPut(deps, TL, { city: "lisbon", employeeId: PEDRO, reason: "falta gente" });
    await expect(tlPut(deps, TL, { city: "lisbon", employeeId: RUI, reason: "falta gente" })).rejects.toThrow('O terminal de Lisboa está com Pedro Costa desde 14:05. Usa "Passar".');
    await expect(tlPass(deps, { ...TL, cities: ["porto"] }, { city: "lisbon", toEmployeeId: RUI, reason: "troca" })).rejects.toBeInstanceOf(TerminalError);
    expect(store._.sessions.filter((s: TerminalSessionRow) => s.activeCityKey)).toHaveLength(1);
  });
  it("Terminal agora: por cidade, quem está, desde quando, pedidos e quem o TL pode pôr", async () => {
    const { deps } = makeDeps();
    await startTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" });
    await requestHandover(deps, { employeeId: PEDRO, actorUserId: 120, fix: IN_LIS });
    const live = await liveByCity(deps, { cities: ["lisbon", "porto"], manage: ["lisbon"] });
    expect(live.enabled).toBe(true);
    expect(live.cities.map((c) => c.cityKey)).toEqual(["lisbon", "porto"]);
    const lx = live.cities[0];
    expect(lx.session).toMatchObject({ name: "João Silva", startedAt: "2026-10-12 13:05:00", sourceLabel: "pelo GPS", clockOpen: true });
    expect(lx.requests.map((r) => r.requesterName)).toEqual(["Pedro Costa"]);
    expect(lx.canManage).toBe(true);
    expect(lx.candidates.map((c) => c.employeeId)).not.toContain(JOAO);
    expect(lx.candidates.map((c) => c.employeeId)).not.toContain(ANA);
    expect(live.cities[1]).toMatchObject({ session: null, canManage: false, candidates: [] });
  });
});

// ─── Interruptor ─────────────────────────────────────────────────────────────

describe("interruptor desligado = nada muda", () => {
  it("nada abre, nada aparece, o TL não mexe, a BD fica igual", async () => {
    const { deps, store } = makeDeps({ on: false });
    expect(await startTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" })).toMatchObject({ status: "off" });
    expect(await requestHandover(deps, { employeeId: PEDRO, actorUserId: 120, fix: IN_LIS })).toMatchObject({ status: "off" });
    expect(await terminalStatus(deps, JOAO)).toEqual({ enabled: false, eligible: false, clockOpen: false, session: null, incoming: null, outgoing: null });
    expect(await liveByCity(deps, { cities: ["lisbon"], manage: ["lisbon"] })).toEqual({ enabled: false, cities: [] });
    await expect(tlPut(deps, TL, { city: "lisbon", employeeId: PEDRO, reason: "falta gente" })).rejects.toThrow("desligado");
    await expect(stopTerminal(deps, { employeeId: JOAO, actorUserId: 110, fix: null })).rejects.toThrow("desligado");
    expect(store._.writes).toBe(0);
  });
  it("PONTO_TERMINAL existe, desligado por omissão, e descreve o terminal pelo perfil + pagamento", () => {
    const f = AUTOMATION_FLAGS.find((x) => x.name === "PONTO_TERMINAL")!;
    expect(f.defaultEnabled).toBe(false);
    expect(automationFlagDefault("PONTO_TERMINAL")).toBe(false);
    expect(f.description).toContain("Terminal pelo perfil");
    expect(f.description).toContain("Estou no terminal");
    expect(f.description).toContain("só aos extras");
  });
});

// ─── Ponto (rh.timeRecords.checkIn) ──────────────────────────────────────────

const admin = () => appRouter.createCaller({ user: { id: 1, role: "admin", name: "Admin", email: "admin@exemplo.pt" }, req: { headers: {} }, res: {} } as any);

describe("check-in com \"Estou no terminal\"", () => {
  beforeEach(() => {
    routerState.inserted = [];
    routerState.logs = [];
    routerState.people = Object.fromEntries(Object.values(basePeople()).map((p) => [p.id, { employee: { ...p, photoUrl: "https://x/foto.jpg", multiparkAgentName: "agente", projectId: 49 } }]));
  });
  const checkIn = (employeeId: number, fix: { lat: number; lng: number; accuracy: number }) => admin().rh.timeRecords.checkIn({
    employeeId, latitude: String(fix.lat), longitude: String(fix.lng), locationName: "aeroporto", terminal: true, accuracy: fix.accuracy,
  });

  it("terminal ocupado: a entrada fica feita e responde \"ocupado\" (com quem está)", async () => {
    const t = makeDeps();
    routerState.deps = t.deps;
    await startTerminal(t.deps, { employeeId: JOAO, actorUserId: 110, fix: IN_LIS, source: "button" });
    t.people[PEDRO].clock = false; // ainda sem entrada
    const r = await checkIn(PEDRO, IN_LIS);
    expect(routerState.inserted).toHaveLength(1);
    expect(routerState.inserted[0]).toMatchObject({ employeeId: PEDRO, type: "check_in", data: { atAirport: 1 } });
    expect(r.success).toBe(true);
    expect(r.terminalSession).toMatchObject({ status: "busy", holderName: "João Silva", requestLabel: "Pedir a João para passar" });
    expect(t.store._.sessions.filter((s: TerminalSessionRow) => s.activeCityKey === "lisbon").map((s: TerminalSessionRow) => s.employeeId)).toEqual([JOAO]);
  });
  it("terminal livre: a sessão abre a seguir à entrada (origem \"checkin\", ligada ao ponto)", async () => {
    const t = makeDeps();
    routerState.deps = t.deps;
    t.people[PEDRO].clock = false;
    const r = await checkIn(PEDRO, IN_LIS);
    expect(r.terminalSession).toMatchObject({ status: "started" });
    expect(t.store._.sessions[0]).toMatchObject({ employeeId: PEDRO, startSource: "checkin", timeRecordId: 1000 + PEDRO });
  });
  it("interruptor desligado: a entrada é a de sempre (sem terminal, sem marca de aeroporto)", async () => {
    const t = makeDeps({ on: false });
    routerState.deps = t.deps;
    t.people[PEDRO].clock = false;
    const r = await checkIn(PEDRO, IN_LIS);
    expect(r.terminalSession).toBeNull();
    expect(routerState.inserted[0].data).not.toHaveProperty("atAirport");
    expect(routerState.inserted[0].data).not.toHaveProperty("terminalStatus");
    expect(t.store._.writes).toBe(0);
  });
});

// ─── Estrutura ───────────────────────────────────────────────────────────────

describe("migração 0625, esquema e ligações", () => {
  it("0625: duas tabelas novas, chaves únicas 1 por cidade / 1 por pessoa, colunas do B2 já lá, registada a seguir à 0615", () => {
    const all = MIGRATION_0625_STATEMENTS.join("\n");
    expect(MIGRATION_0625_STATEMENTS.every((s) => s.startsWith("CREATE TABLE IF NOT EXISTS"))).toBe(true);
    expect(all).toContain("UNIQUE KEY `uq_terminal_sessions_active_city` (`activeCityKey`)");
    expect(all).toContain("UNIQUE KEY `uq_terminal_sessions_active_employee` (`activeEmployeeId`)");
    for (const col of ["payUplift", "lastInsideAt", "outsideSince", "outsideCount", "askedAt", "stillHereAt", "countedUntil", "countedBasis", "timeRecordId", "startAccuracy"]) {
      expect(all, col).toContain(`\`${col}\``);
    }
    expect(all).toContain("`terminal_handover_requests`");
    expect(IDEMPOTENT_ERROR_CODES_0625.has("ER_TABLE_EXISTS_ERROR")).toBe(true);
    expect(SCHEMA_MIGRATION_IDS.indexOf("0625")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0615"));
    const schema = src("drizzle/schema.ts");
    expect(schema).toContain('export const terminalSessions = mysqlTable("terminal_sessions"');
    expect(schema).toContain('uniqueIndex("uq_terminal_sessions_active_city").on(table.activeCityKey)');
    expect(schema).toContain('export const terminalHandoverRequests = mysqlTable("terminal_handover_requests"');
  });
  it("nada se apaga (nem sessões nem pedidos); a BD da Multipark só se lê", () => {
    const s = src("server/terminalSessions.ts");
    expect(s).not.toMatch(/\.delete\(|DELETE\s+FROM/i);
    expect(s).toContain("activeCityKey: null, activeEmployeeId: null");
  });
  it("o ponto já não usa o método antigo (saída + entrada no aeroporto) e liberta o lugar na saída", () => {
    const r = src("server/rhRouter.ts");
    const checkIn = r.slice(r.indexOf("checkIn: protectedProcedure"), r.indexOf("checkOut: protectedProcedure"));
    const checkOut = r.slice(r.indexOf("checkOut: protectedProcedure"), r.indexOf("// ── Geofence por centro de custos"));
    expect(checkIn).not.toContain("evaluateCheckInTerminal(");
    expect(checkOut).not.toContain("evaluateCheckOutTerminal(");
    expect(checkIn).toContain("terminal: z.boolean().optional()");
    expect(checkIn.indexOf('insertTimeRecordAtomic(input.employeeId, "check_in"')).toBeLessThan(checkIn.indexOf("startTerminal("));
    expect(checkOut.indexOf('insertTimeRecordAtomic(input.employeeId, "check_out"')).toBeLessThan(checkOut.indexOf("releaseOnCheckout("));
    expect(checkOut).toContain('reason: "checkout", forgotten: !!autoNote');
    const d = src("server/db.ts");
    const stale = d.slice(d.indexOf("export async function autoCloseStaleCheckIns"), d.indexOf("// ─── PASSAGEM DE TURNO"));
    expect(stale).toContain('reason: "stale_checkout"');
  });
  it("aviso no sino: tipo \"terminal\", pessoal (o João e o TL de serviço)", () => {
    const k = kindDef("terminal")!;
    expect(k).toMatchObject({ personal: true, cityScoped: true, module: "ficha" });
    expect(k.channels).toEqual(["in_app"]);
  });
  it("o terminal da própria pessoa abre sem centro de custos (a resposta diz o que fazer); o do TL não", () => {
    for (const p of ["terminal.status", "terminal.start", "terminal.stop", "terminal.requestHandover", "terminal.answerHandover"]) expect(isPersonalAccessPath(p), p).toBe(true);
    for (const p of ["terminal.liveByCity", "terminal.tl.put", "terminal.tl.pass", "terminal.tl.close"]) expect(isPersonalAccessPath(p), p).toBe(false);
  });
  it("ecrãs: item no menu da foto, opção na entrada do ponto, barra fina e cartão no Ao vivo", () => {
    const layout = src("client/src/components/DashboardLayout.tsx");
    expect(layout).toContain("<span>Estou no terminal</span>");
    expect(layout).toContain("<TerminalBar t={terminal} />");
    expect(layout).toContain("setPontoTerminal(true); setPontoMode(\"check_in\")");
    expect(src("client/src/components/terminal/TerminalBar.tsx")).toContain("Sair do terminal?");
    expect(src("client/src/pages/OperationalPage.tsx")).toContain("<TerminalLiveCard />");
  });
});
