/**
 * Plano 62, P7 — o trabalho `service-times` de ponta a ponta, com um dia
 * sintético de Lisboa (13 out 2026) e dependências falsas: 10 entregas e 8
 * recolhas, chamadas da consola e do WhatsApp, um PDA trocado às 15h, um
 * condutor que espera o cliente, um "em entrega" marcado no terminal, um
 * despachante, uma recolha pelo P2, uma recolha no T2 atrasada, canceladas,
 * uma reaberta e o GPS só na final para uma entrega noturna.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";

const flag = vi.hoisted(() => ({ on: false, deps: 0 }));
vi.mock("./serviceTimesDeps", async (original) => ({
  ...(await original<object>()),
  serviceTimesEnabled: async () => flag.on,
  realServiceTimesDeps: async () => { flag.deps++; throw new Error("não devia ler nada com o interruptor desligado"); },
}));

import {
  gpsFileKey, mergeDayRanges, nextBackfillBlock, nextServiceState, p2LeaveOf, parseServiceReprocess, readWindowFor, runServiceTimes, spotTypeOf, summarizeServiceDay,
  terminalClassOf, type GpsFile, type ServiceTimesDeps, type ServiceTimesRow, type ServiceTimesState,
} from "./serviceTimesJob";
import { buildServiceHistorySql, mapServiceHistoryRow } from "./multiparkDb/serviceRows";
import { MultiparkDbError, assertReadOnlySql } from "./multiparkDb/client";
import { classifyDeliveryType } from "./extrasDia";
import { DEFAULT_GARAGE_ROLES, SERVICE_TIMES_CALC_VERSION, buildPickupCycles, type CallRecord, type ServiceEvent } from "../shared/serviceTimes";
import type { GpsFix } from "../shared/serviceGps";
import { AUTOMATION_FLAGS, CRON_JOBS, automationFlagDefault } from "../shared/appSettings";
import { TICK_JOBS } from "./cronSchedule";

const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const MIN = 60_000;
const T = (hhmm: string, day = "2026-10-13") => Date.parse(`${day}T${hhmm}:00Z`);
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 23).replace("T", " ");

// ─── Geografia (Lisboa) ─────────────────────────────────────────────────────
const at = (c: { lat: number; lng: number }, dx: number, dy = 0) => ({ lat: c.lat + dy / 111_320, lng: c.lng + dx / (111_320 * Math.cos((c.lat * Math.PI) / 180)) });
const T1 = { label: "T1", lat: 38.7742, lng: -9.1342, radiusM: 200 };
const T2 = { label: "T2", lat: 38.769, lng: -9.129, radiusM: 200 };
const PARK = at(T1, 3500, 0);
const P2POS = at(T1, 1500, -1000);
const CENTRALPOS = at(PARK, 0, 250);
const mapLink = (p: { lat: number; lng: number }) => `https://www.google.com/maps/@${p.lat.toFixed(6)},${p.lng.toFixed(6)},18z`;
const airports = { lisbon: { lat: T1.lat, lng: T1.lng, radiusM: 1500, zones: [T1, T2] }, porto: { lat: 41.2481, lng: -8.6814, radiusM: 1500 }, faro: { lat: 37.0144, lng: -7.9659, radiusM: 1500 } };

// ─── GPS: trajetos (um ponto por minuto) ────────────────────────────────────
type Leg = { from: number; to: number; a: { lat: number; lng: number }; b: { lat: number; lng: number }; speed: number };
function track(legs: Leg[]): GpsFix[] {
  const out: GpsFix[] = [];
  for (const l of legs) {
    for (let t = l.from; t <= l.to; t += MIN) {
      const f = l.to === l.from ? 1 : (t - l.from) / (l.to - l.from);
      out.push({ ts: Math.round(t / 1000), speed: l.speed, lat: l.a.lat + (l.b.lat - l.a.lat) * f, lon: l.a.lng + (l.b.lng - l.a.lng) * f, accurate: true });
    }
  }
  return out.sort((x, y) => x.ts - y.ts);
}
const stay = (from: string, to: string, p: { lat: number; lng: number }): Leg => ({ from: T(from), to: T(to), a: p, b: p, speed: 0 });
const drive = (from: string, to: string, a: { lat: number; lng: number }, b: { lat: number; lng: number }): Leg => ({ from: T(from), to: T(to), a, b, speed: 45 });
const inT1 = at(T1, 20), inT2 = at(T2, 20);

/** z1 (ficha 1, Zello fixo): manhã (p1), tarde (e1, e3), uma volta sem paragem (e10) e a noturna (e8). */
const z1Full = track([
  stay("06:00", "06:26", at(T1, 30)), { from: T("06:27"), to: T("06:27"), a: at(T1, 150), b: at(T1, 150), speed: 5 },
  { from: T("06:28"), to: T("06:28"), a: at(T1, 700), b: at(T1, 700), speed: 40 }, drive("06:29", "06:40", at(T1, 1500), PARK), stay("06:41", "06:50", PARK),
  stay("15:30", "16:10", PARK), drive("16:11", "16:21", at(T1, 3500 - (3480 * 1) / 12), at(T1, 3500 - (3480 * 11) / 12)), stay("16:22", "16:45", inT1), drive("16:46", "16:58", inT1, PARK),
  stay("16:59", "17:00", PARK), drive("17:01", "17:14", at(PARK, -200), at(T2, 600)), stay("17:15", "17:42", inT2), drive("17:43", "17:55", inT2, PARK),
  drive("21:00", "21:30", PARK, at(PARK, 6000, 4000)),
  stay("22:05", "22:15", PARK), stay("22:30", "22:40", PARK), drive("22:41", "22:54", at(PARK, -250), at(T1, 600)), stay("22:55", "23:10", inT1),
]);
const z1Sameday = z1Full.filter((p) => p.ts * 1000 <= T("22:15"));
/** pda7: até às 15h com a ficha 3 (no T2!), depois com a ficha 2 (e2). */
const pda7 = track([stay("14:30", "14:59", inT2), stay("15:03", "15:03", PARK), drive("15:04", "15:19", at(PARK, -250), at(T2, 450)), stay("15:20", "15:40", inT2)]);
/** z4 (ficha 4): sai do parque às 18:10 e marca o "em entrega" já no T1 (e4). */
const z4 = track([stay("18:00", "18:10", PARK), drive("18:11", "18:21", at(PARK, -290), at(T1, 300)), stay("18:22", "18:45", inT1)]);
/** z2 (ficha 2, Zello fixo de manhã): chega ao T2 às 07:20, check-in às 07:30, sai às 07:39 (p3). */
const z2 = track([stay("06:40", "07:05", PARK), drive("07:06", "07:19", PARK, at(T2, 700)), stay("07:20", "07:38", inT2), { from: T("07:39"), to: T("07:39"), a: at(T2, 700), b: at(T2, 700), speed: 40 }, drive("07:40", "07:55", at(T2, 1500), PARK)]);

const filesFor = (pass: "sameday" | "final"): Map<string, GpsFile> => {
  const m = new Map<string, GpsFile>();
  const lisbonDay = (p: GpsFix) => (p.ts * 1000 >= Date.parse("2026-10-13T23:00:00Z") ? "2026-10-14" : "2026-10-13");
  const put = (zello: string, pts: GpsFix[], filePass = pass) => {
    for (const day of ["2026-10-13", "2026-10-14"]) {
      const mine = pts.filter((p) => lisbonDay(p) === day);
      if (mine.length) m.set(gpsFileKey(zello, day), { status: "ok", pass: filePass, points: mine });
    }
  };
  put("z1", pass === "sameday" ? z1Sameday : z1Full);
  put("pda7", pda7);
  put("z4", z4);
  put("z2", z2);
  return m;
};

// ─── A History do dia ───────────────────────────────────────────────────────
let seq = 0;
type Raw = Record<string, unknown>;
const h = (bookingId: string, type: string, time: string, agent: string, extra: Partial<Raw> & { pos?: { lat: number; lng: number }; day?: string } = {}): Raw => {
  seq++;
  const { pos, day, ...rest } = extra;
  return {
    id: `h-${bookingId}-${type}-${time}-${seq % 1}`, booking_id: bookingId, change_type: type, action_time: utc(T(time, day)), agent_user_id: agent, agent_name: `Agente ${agent}`, platform: "MOBILE",
    lat: pos?.lat ?? null, lng: pos?.lng ?? null, status_from: null, status_to: null, move_kind: null, garage_from: null, garage_to: null, snap_arrived: null, snap_baggage: null, ...rest,
  };
};
const mv = (b: string, time: string, agent: string, kind: string, to: string | null = null, from: string | null = null, pos?: { lat: number; lng: number }) => h(b, "MOVEMENT", time, agent, { move_kind: kind, garage_to: to, garage_from: from, pos });

function dayHistory(o: { withE9?: boolean } = {}): Raw[] {
  seq = 0;
  return [
    // e1: chamada da central 20 min antes do pendente; condutor A; assinatura com o TL no T1
    h("e1", "PENDING_CHECKOUT", "16:00", "uOff"), h("e1", "CHECKING_OUT", "16:10", "uA", { pos: PARK }), h("e1", "CHECK_OUT", "16:40", "uTL", { pos: inT1 }),
    // e2: chamada perdida pelo WhatsApp; PDA trocado às 15h; o condutor espera o cliente
    h("e2", "PENDING_CHECKOUT", "14:50", "uOff"), h("e2", "CHECKING_OUT", "15:02", "uB", { pos: PARK }), h("e2", "CHECK_OUT", "15:35", "uB", { pos: inT2 }),
    // e3: o condutor faz o próprio check-out (esperou o cliente)
    h("e3", "PENDING_CHECKOUT", "16:55", "uOff"), h("e3", "CHECKING_OUT", "17:00", "uA", { pos: PARK }), h("e3", "CHECK_OUT", "17:40", "uA", { pos: inT2 }),
    // e4: "em entrega" marcado já no T1
    h("e4", "PENDING_CHECKOUT", "18:05", "uOff"), h("e4", "CHECKING_OUT", "18:30", "uC", { pos: inT1 }), h("e4", "CHECK_OUT", "18:50", "uTL", { pos: inT1 }),
    // e5: despachante (LEADER no parque)
    h("e5", "PENDING_CHECKOUT", "19:00", "uOff"), h("e5", "CHECKING_OUT", "19:02", "uTL", { pos: PARK }), h("e5", "CHECK_OUT", "19:30", "uA", { pos: inT1 }),
    // e6: cancelada depois do início
    h("e6", "PENDING_CHECKOUT", "19:30", "uOff"), h("e6", "CHECKING_OUT", "19:35", "uA"), h("e6", "CANCEL", "19:40", "uOff"),
    // e7: reaberta (reabertura com pedido novo)
    h("e7", "PENDING_CHECKOUT", "12:00", "uOff"), h("e7", "CHECKING_OUT", "12:05", "uA"), h("e7", "CHECK_OUT", "12:30", "uA"),
    h("e7", "UPDATE", "12:40", "uOff", { status_from: "CHECKED_OUT", status_to: "CHECKED_IN" }),
    h("e7", "PENDING_CHECKOUT", "13:00", "uOff"), h("e7", "CHECKING_OUT", "13:05", "uA"), h("e7", "CHECK_OUT", "13:30", "uA"),
    // e8: noturna (00:05 de Lisboa): só a recolha final tem os pontos
    h("e8", "PENDING_CHECKOUT", "22:30", "uOff"), h("e8", "CHECKING_OUT", "22:40", "uA", { pos: PARK }), h("e8", "CHECK_OUT", "23:05", "uTL", { pos: inT1 }),
    // e9: sem pendente nem chamada
    ...(o.withE9 === false ? [] : [h("e9", "CHECKING_OUT", "20:00", "uA", { pos: PARK }), h("e9", "CHECK_OUT", "20:30", "uA")]),
    // e10: Oriente, sem posição da assinatura → sem destino (nunca o aeroporto)
    h("e10", "PENDING_CHECKOUT", "21:00", "uOff"), h("e10", "CHECKING_OUT", "21:05", "uA", { pos: PARK }), h("e10", "CHECK_OUT", "21:30", "uA"),
    // eMK: parque que a operação não faz → fica fora
    h("eMK", "PENDING_CHECKOUT", "16:00", "uOff"), h("eMK", "CHECKING_OUT", "16:05", "uA"), h("eMK", "CHECK_OUT", "16:30", "uA"),
    // r1: em recolha (escritório) → check-in no T1 → sai pelo GPS → CENTRAL (pára)
    h("r1", "CHECKING_IN", "06:00", "uOff", { pos: PARK }), h("r1", "CHECK_IN", "06:20", "uA", { pos: inT1 }), mv("r1", "06:27", "uA", "inicio"), mv("r1", "06:45", "uA", "arrumar", "CENTRAL"),
    // r2: sem GPS (saída pela app) → P2 → CENTRAL às 09:10 por outra pessoa
    h("r2", "CHECK_IN", "06:30", "uX", { pos: inT1 }), mv("r2", "06:35", "uX", "inicio", null, null, inT1), mv("r2", "06:50", "uX", "arrumar", "P2"),
    mv("r2", "09:00", "uC", "inicio"), mv("r2", "09:10", "uC", "parques", "CENTRAL", "P2"),
    // r3: T2, chamada às 07:00; o condutor chega ao T2 às 07:19:30 (15 min = 07:15 → atrasada 4,5 min)
    h("r3", "CHECKING_IN", "07:02", "uOff"), h("r3", "CHECK_IN", "07:30", "uB", { pos: inT2 }), mv("r3", "07:40", "uB", "inicio"), mv("r3", "07:55", "uB", "arrumar", "PD"),
    // r4: cancelada depois do "em recolha"
    h("r4", "CHECKING_IN", "08:00", "uOff"), h("r4", "CANCEL", "08:30", "uOff"),
    // r5: sem "em recolha"; movimento antigo (sem garagem)
    h("r5", "CHECK_IN", "08:10", "uX", { pos: inT1 }), mv("r5", "08:20", "uX", "antigo"),
    // r6: "em recolha" 1 min antes, pelo mesmo agente (marcado no terminal)
    h("r6", "CHECKING_IN", "08:40", "uX"), h("r6", "CHECK_IN", "08:41", "uX", { pos: inT1 }),
    // r7: check-in por um agente de sistema
    h("r7", "CHECK_IN", "08:50", "uSys", { pos: inT1 }),
    // r8: P2 ainda (por arrumar)
    h("r8", "CHECK_IN", "09:20", "uX", { pos: inT1 }), mv("r8", "09:25", "uX", "inicio", null, null, inT1), mv("r8", "09:40", "uX", "arrumar", "P2"),
    // marcas "estacionado aqui" na PD (fim de movimentos de manhã, antes dos pedidos): a PD não tem
    // coordenadas na Multipark, o centro sai da mediana destas posições (= PARK)
    mv("e1", "10:00", "uA", "lugar", "PD", "PD", PARK), mv("e2", "10:01", "uA", "lugar", "PD", "PD", at(PARK, 20)), mv("e3", "10:02", "uA", "lugar", "PD", "PD", at(PARK, -20)),
    mv("e5", "10:03", "uA", "lugar", "PD", "PD", at(PARK, 0, 20)), mv("e9", "10:04", "uA", "lugar", "PD", "PD", at(PARK, 0, -20)),
  ];
}

const bookings: Record<string, Raw> = Object.fromEntries([
  ["e3", { id: "e3", park_id: "pLX", status: "CHECKED_OUT", delivery_type: "Terminal 2", code: "LX-e3", parking_type: "UNCOVERED", client_phone: "+351912000003" }],
  ...["e1", "e4", "e5", "e6", "e7", "e8", "e9"].map((id) => [id, { id, park_id: "pLX", status: "CHECKED_OUT", delivery_type: "Terminal 1", code: `LX-${id}`, parking_type: "UNCOVERED", client_phone: `+35191200${id.replace(/\D/g, "").padStart(4, "0")}` }]),
  ["e2", { id: "e2", park_id: "pLX", status: "CHECKED_OUT", delivery_type: "Terminal 2", code: "LX-e2", parking_type: "UNCOVERED", client_phone: "+351912000002" }],
  ["e10", { id: "e10", park_id: "pLX", status: "CHECKED_OUT", delivery_type: "Estação do Oriente", code: "LX-e10", parking_type: "UNCOVERED", client_phone: "+351912000010" }],
  ["eMK", { id: "eMK", park_id: "pMK", status: "CHECKED_OUT", delivery_type: "Terminal 1", code: "MK-1", parking_type: "UNCOVERED", client_phone: "+351912999999" }],
  ...["r1", "r2", "r4", "r5", "r6", "r7", "r8"].map((id) => [id, { id, park_id: "pLX", status: "CHECKED_IN", delivery_type: "Terminal 1", code: `LX-${id}`, parking_type: id === "r2" ? "INDOOR" : "UNCOVERED", client_phone: `+35193100${id.replace(/\D/g, "").padStart(4, "0")}` }]),
  ["r3", { id: "r3", park_id: "pLX", status: "CHECKED_IN", delivery_type: "Terminal 2", code: "LX-r3", parking_type: "UNCOVERED", client_phone: "+351931000003" }],
]);
const parks = [
  { id: "pLX", name: "Airpark Lisboa", city: "Lisboa", address: null, firebase_brand: "airpark", listing_type: "ON_PLATFORM", lat: PARK.lat, lng: PARK.lng },
  { id: "pMK", name: "Top Parking", city: "Lisboa", address: null, firebase_brand: null, listing_type: "ON_PLATFORM", lat: 38.75, lng: -9.1 },
];
const garages = [
  { id: "g1", name: "P2", park_id: "pLX", map_link: mapLink(P2POS) },
  { id: "g2", name: "CENTRAL", park_id: "pLX", map_link: mapLink(CENTRALPOS) },
  { id: "g3", name: "PD", park_id: "pLX", map_link: null },
];
const agents = [{ user_id: "uA", park_id: "pLX", role: "DRIVER" }, { user_id: "uB", park_id: "pLX", role: "JUNIOR" }, { user_id: "uC", park_id: "pLX", role: "DRIVER" }, { user_id: "uTL", park_id: "pLX", role: "LEADER" }];
const EMP: Record<string, number> = { uA: 1, uB: 2, uE: 3, uC: 4, uX: 5, uOff: 8, uTL: 9 };
const calls: CallRecord[] = [
  { at: T("15:40"), source: "central", held: true, phone9: "912000001", crmClientId: null },
  { at: T("14:45"), source: "whatsapp", held: false, phone9: "912000002", crmClientId: null },
  { at: T("07:00"), source: "central", held: true, phone9: "931000003", crmClientId: null },
];

interface Harness { deps: ServiceTimesDeps; rows: Map<string, ServiceTimesRow & { id: number; voidedAt: string | null }>; sqls: string[]; historyReads: string[]; timeouts: Array<{ history: boolean; ms: number | undefined }>; gpsAsked: string[]; state: { value: ServiceTimesState | null }; upserts: number }

function harness(o: { now: number; history: () => Raw[]; files: () => Map<string, GpsFile>; settings?: Partial<Awaited<ReturnType<ServiceTimesDeps["settings"]>>>; failQuery?: boolean; prev?: Harness; parkRows?: Raw[]; garageRows?: Raw[] }): Harness {
  const rows = o.prev?.rows ?? new Map();
  const state = o.prev?.state ?? { value: null };
  const H: Harness = { rows, sqls: [], historyReads: [], timeouts: [], gpsAsked: [], state, upserts: 0, deps: null as any };
  let nextId = Math.max(0, ...[...rows.values()].map((r) => r.id)) + 1;
  H.deps = {
    query: async (sql, params = [], opts) => {
      assertReadOnlySql(sql);
      H.sqls.push(sql);
      H.timeouts.push({ history: sql.includes('FROM "History"'), ms: opts?.timeoutMs });
      if (o.failQuery) throw new MultiparkDbError("canceling statement due to statement timeout", "QUERY_FAILED");
      if (sql.includes('FROM "History"')) {
        H.historyReads.push(sql);
        const from = Date.parse(String(params[0]).replace(" ", "T") + "Z"), to = Date.parse(String(params[1]).replace(" ", "T") + "Z");
        return o.history().filter((r) => { const t = Date.parse(String(r.action_time).replace(" ", "T") + "Z"); return t >= from && t < to; }) as any;
      }
      if (sql.includes('FROM "Booking"')) return params.map((id) => bookings[String(id)]).filter(Boolean) as any;
      if (sql.includes('FROM "Driver"')) return [];
      if (sql.includes('FROM "Agent"')) return agents.filter((a) => params.includes(a.user_id)) as any;
      if (sql.includes('FROM "Park"')) return (o.parkRows ?? parks) as any;
      if (sql.includes('FROM "Garage"')) return (o.garageRows ?? garages) as any;
      throw new Error(`SQL inesperado: ${sql.slice(0, 60)}`);
    },
    now: () => o.now,
    settings: async () => ({
      excludedParks: [], airports, parkZones: { lisbon: [], porto: [], faro: [] }, garageRoles: DEFAULT_GARAGE_ROLES.map((g) => ({ ...g })),
      targetMinutes: 15, t2TargetMinutes: 15, since: "2026-10-09", gpsSince: "2026-09-15", useCalls: true, ...o.settings,
    }),
    ourDb: {
      calls: async () => calls,
      crmLinks: async () => new Map(),
      pdaCheckins: async () => [{ employeeId: 3, zello: "pda7", start: T("14:00"), end: T("15:00") }, { employeeId: 2, zello: "PDA7", start: T("15:00"), end: T("22:00") }],
      fixedZellos: async () => [{ employeeId: 1, zello: "z1", active: true }, { employeeId: 2, zello: "z2", active: true }, { employeeId: 4, zello: "z4", active: true }, { employeeId: 3, zello: "z3", active: true }],
    },
    loadGps: async (reqs) => {
      const files = o.files();
      const out = new Map<string, GpsFile>();
      for (const r of reqs) { const k = gpsFileKey(r.zello, r.day); H.gpsAsked.push(k); out.set(k, files.get(k) ?? { status: "missing" }); }
      return out;
    },
    identity: async () => ({ agent: (userId) => (userId === "uSys" ? { kind: "ignorado", employeeId: null } : userId && EMP[userId] ? { kind: "colaborador", employeeId: EMP[userId] } : { kind: "por_ligar", employeeId: null }) }),
    store: {
      loadState: async () => state.value,
      saveState: async (s) => { state.value = s; },
      existing: async (fromUtc, toUtc) => [...rows.values()].filter((r) => r.anchorAt >= fromUtc && r.anchorAt < `${toUtc}.999`)
        .map((r) => ({ id: r.id, kind: r.kind, bookingId: r.bookingId, anchorHistoryId: r.anchorHistoryId, gpsPass: r.gpsPass, calcVersion: r.calcVersion, paramsHash: r.paramsHash, voided: r.voidedAt != null })),
      upsert: async (list) => {
        H.upserts += list.length;
        for (const r of list) { const k = `${r.kind}|${r.bookingId}|${r.anchorHistoryId}`; const prev = rows.get(k); rows.set(k, { ...r, id: prev?.id ?? nextId++, voidedAt: null }); }
      },
      voidRows: async (ids, atUtc) => { for (const r of rows.values()) if (ids.includes(r.id) && r.voidedAt == null) r.voidedAt = atUtc; },
    },
    log: () => undefined,
  };
  return H;
}
const del = (H: Harness, id: string) => [...H.rows.values()].filter((r) => r.kind === "entrega" && r.bookingId === id).sort((a, b) => a.anchorAt.localeCompare(b.anchorAt));
const pick = (H: Harness, id: string) => [...H.rows.values()].find((r) => r.kind === "recolha" && r.bookingId === id)!;
const NOW1 = Date.parse("2026-10-14T05:40:00Z");
const NOW2 = Date.parse("2026-10-15T05:40:00Z");

describe("trabalho service-times — dia sintético de Lisboa", () => {
  it("1.ª noite: as linhas certas, uma leitura da History por intervalo e todo o SQL só de leitura", async () => {
    const H = harness({ now: NOW1, history: () => dayHistory(), files: () => filesFor("sameday") });
    const r = await runServiceTimes(H.deps, { deadlineAt: Date.now() + 40_000 });
    expect(r.ok).toBe(true);
    expect(r.done).toBe(true);
    // noite (11–13 out) + o bloco para trás (9–10 out): 2 leituras, nenhuma por bookingId
    expect(r.ranges.map((x) => `${x.reason} ${x.from}..${x.to}`)).toEqual(["noite 2026-10-11..2026-10-13", "para_tras 2026-10-09..2026-10-10"]);
    expect(H.historyReads).toHaveLength(2);
    for (const s of H.historyReads) expect(s).not.toMatch(/"bookingId"\s+IN/);
    expect(H.sqls.length).toBeGreaterThan(4);
    const night = r.ranges[0];
    expect(night).toMatchObject({ deliveries: 11, pickups: 8, written: 19 });
    expect([...H.rows.values()].every((x) => x.calcVersion === SERVICE_TIMES_CALC_VERSION && /^[0-9a-f]{16}$/.test(x.paramsHash))).toBe(true);
    // fora: o parque que a operação não faz
    expect(del(H, "eMK")).toEqual([]);

    // e1: chamada da central (20 min antes), Trânsito pelo GPS (meio do intervalo), Cliente, Nosso, Total; condutores
    const e1 = del(H, "e1")[0];
    expect(e1).toMatchObject({ outcome: "entregue", startSource: "chamada", callSource: "central", callHeld: 1, queueMs: 30 * MIN, queueStatus: "medido",
      transitStatus: "medido", transitMs: 11.5 * MIN, arrivedSource: "gps_zona", customerMs: 18.5 * MIN, ourMs: 41.5 * MIN, totalMs: 60 * MIN,
      startEmployeeId: 1, deliverEmployeeId: 9, startRole: "DRIVER", gpsPass: "sameday", zelloUsername: "z1", opDay: "2026-10-13", cityKey: "lisboa", terminalClass: "t1" });
    // e2: WhatsApp perdida; PDA trocado às 15h (os pontos da ficha 3 no T2 não contam); condutor esperou
    const e2 = del(H, "e2")[0];
    expect(e2).toMatchObject({ callSource: "whatsapp", callHeld: 0, startSource: "chamada", transitStatus: "medido", transitMs: 17.5 * MIN, zelloUsername: "pda7", terminalClass: "t2", startEmployeeId: 2, deliverEmployeeId: 2 });
    expect(e2.flags).toEqual(expect.stringContaining("chamada_perdida"));
    expect(e2.flags).toEqual(expect.stringContaining("chamada_whatsapp"));
    expect(e2.flags).toEqual(expect.stringContaining("condutor_esperou"));
    expect(e2.flags).not.toEqual(expect.stringContaining("inicio_no_terminal"));
    expect(del(H, "e3")[0]).toMatchObject({ transitStatus: "medido", transitMs: 14.5 * MIN, deliverEmployeeId: 1 });
    expect(del(H, "e3")[0].flags).toEqual(expect.stringContaining("condutor_esperou"));
    // e4: "em entrega" no T1 → S = saída do parque pelo GPS
    const e4 = del(H, "e4")[0];
    expect(e4.flags).toEqual(expect.stringContaining("inicio_no_terminal"));
    expect(e4).toMatchObject({ startedAt: utc(T("18:11") + 30_000), queueMs: 6.5 * MIN, queueStatus: "medido", transitStatus: "medido", startEmployeeId: 4 });
    // e5: despachante → Trânsito por confirmar, Fila medida
    expect(del(H, "e5")[0]).toMatchObject({ transitStatus: "condutor_por_confirmar", queueStatus: "medido", queueMs: 2 * MIN, startRole: "LEADER" });
    expect(del(H, "e6")[0]).toMatchObject({ outcome: "cancelado", queueStatus: "cancelado", transitMs: null });
    expect(del(H, "e7").map((x) => x.outcome)).toEqual(["reaberta", "entregue"]);
    // e8: noturna — só a provisória (pontos até às 23:15 de Lisboa) → por recolher
    expect(del(H, "e8")[0]).toMatchObject({ transitStatus: "gps_por_recolher", opDay: "2026-10-13" });
    expect(del(H, "e9")[0]).toMatchObject({ queueStatus: "sem_pedido", startSource: "inicio" });
    expect(del(H, "e10")[0]).toMatchObject({ terminalClass: "other", transitStatus: "sem_destino" });

    // recolhas
    expect(pick(H, "r1")).toMatchObject({ customerMs: 20 * MIN, customerStatus: "medido", terminalStatus: "medido", terminalExitSource: "gps", terminalMs: 7.5 * MIN,
      firstGarage: "CENTRAL", firstGarageRole: "parque", parkedStatus: "arrumado", toParkedMs: 25 * MIN, driverEmployeeId: 1, checkInEmployeeId: 1, parkedEmployeeId: 1 });
    expect(pick(H, "r2")).toMatchObject({ terminalExitSource: "app_inicio_movimento", terminalMs: 5 * MIN, firstGarageRole: "provisoria", p2Status: "medido", p2Ms: 140 * MIN,
      p2ExitAt: utc(T("09:00")), p2EmployeeId: 4, parkedGarage: "CENTRAL", parkedEmployeeId: 4, spotType: "indoor" });
    expect(pick(H, "r3")).toMatchObject({ startSource: "chamada", customerMs: 30 * MIN, t2Status: "medido", t2LateMs: 4.5 * MIN, t2DriverArrivedAt: utc(T("07:19") + 30_000),
      terminalStatus: "medido", terminalMs: 8.5 * MIN, parkedGarage: "PD", parkedStatus: "arrumado", checkInEmployeeId: 2, driverEmployeeId: 2 });
    expect(pick(H, "r4")).toMatchObject({ outcome: "cancelado", customerStatus: "cancelado" });
    expect(pick(H, "r5")).toMatchObject({ customerStatus: "sem_em_recolha", parkedStatus: "sem_garagem", terminalStatus: "sem_zello" });
    expect(pick(H, "r6")).toMatchObject({ customerStatus: "em_recolha_tardio" });
    expect(pick(H, "r7")).toMatchObject({ terminalStatus: "condutor_desconhecido", checkInEmployeeId: null });
    expect(pick(H, "r8")).toMatchObject({ p2Status: "no_p2", parkedStatus: "por_arrumar" });

    // privacidade: nem telefones nem coordenadas nas linhas
    const dump = JSON.stringify([...H.rows.values()]);
    expect(dump).not.toMatch(/9120000|9310000|38\.77|-9\.13/);
    // log do dia
    expect(r.lines.some((l) => /^\[tempos\] 2026-10-13 lisboa: entregas \d+ \(fila p75 \d+, com chamada \d+ %; trânsito p75 \d+, GPS \d+ %; na meta \d+ %\) · recolhas \d+ \(cliente p50 \d+; terminal p75 \d+; P2 p75 2h20; T2 atrasadas 1\/1\)/.test(l))).toBe(true);
    // o estado: noite feita, nada para trás
    expect(H.state.value).toMatchObject({ v: SERVICE_TIMES_CALC_VERSION, nightly: "2026-10-14", todo: [] });
  });

  it("2.ª noite: a recolha final sobe a noturna para `final`; o que desapareceu fica anulado; volta e reaparece; as finais não se refazem", async () => {
    const H1 = harness({ now: NOW1, history: () => dayHistory(), files: () => filesFor("sameday") });
    await runServiceTimes(H1.deps, { deadlineAt: Date.now() + 40_000 });
    // noite seguinte: GPS final; a e9 deixou de estar na History
    const H2 = harness({ now: NOW2, history: () => dayHistory({ withE9: false }), files: () => filesFor("final"), prev: H1 });
    const r2 = await runServiceTimes(H2.deps, { deadlineAt: Date.now() + 40_000 });
    expect(r2.ranges.map((x) => x.reason)).toEqual(["noite"]);
    const e8 = del(H2, "e8")[0];
    expect(e8).toMatchObject({ transitStatus: "medido", gpsPass: "final", arrivedSource: "gps_zona" });
    expect(del(H2, "e1")[0]).toMatchObject({ gpsPass: "final", transitMs: 11.5 * MIN });
    expect(del(H2, "e9")[0].voidedAt).not.toBeNull();
    expect(r2.ranges[0].voided).toBe(1);
    // a e9 volta → reaparece (voidedAt a NULL); as linhas finais e atuais não se reescrevem
    H2.state.value = { ...H2.state.value!, nightly: null };
    const before = new Map([...H2.rows.entries()].map(([k, v]) => [k, JSON.stringify(v)]));
    const H3 = harness({ now: NOW2, history: () => dayHistory(), files: () => filesFor("final"), prev: H2 });
    const r3 = await runServiceTimes(H3.deps, { deadlineAt: Date.now() + 40_000 });
    expect(del(H3, "e9")[0].voidedAt).toBeNull();
    expect(r3.ranges[0].keptFinal).toBeGreaterThan(5);
    expect(H3.upserts).toBeLessThan(r3.ranges[0].deliveries + r3.ranges[0].pickups);
    // idempotente: as finais ficaram iguais
    expect(JSON.stringify(H3.rows.get(`entrega|e1|${del(H3, "e1")[0].anchorHistoryId}`))).toBe(before.get(`entrega|e1|${del(H3, "e1")[0].anchorHistoryId}`));
  });

  it("reprocessar à mão: força refazer, em blocos (7 dias; 2 nos dias com GPS), com o que falta em `cursor`", async () => {
    const H = harness({ now: NOW2, history: () => dayHistory(), files: () => filesFor("final") });
    const r = await runServiceTimes(H.deps, { deadlineAt: Date.now() + 40_000, reprocess: { from: "2026-10-01", to: "2026-10-13" } });
    expect(r.ranges.map((x) => `${x.reason} ${x.from}..${x.to}`)).toEqual(["reprocessar 2026-10-12..2026-10-13"]);
    expect(r).toMatchObject({ done: false, cursor: "2026-10-01..2026-10-11" });
    expect(H.historyReads).toHaveLength(1);
    // antes do GPS: blocos de 7 dias
    const H2 = harness({ now: NOW2, history: () => [], files: () => new Map(), settings: { gpsSince: "2026-10-20" } });
    const r2 = await runServiceTimes(H2.deps, { deadlineAt: Date.now() + 40_000, reprocess: { from: "2026-10-01", to: "2026-10-13" } });
    expect(r2.ranges.map((x) => `${x.from}..${x.to}`)).toEqual(["2026-10-07..2026-10-13"]);
    expect(r2.cursor).toBe("2026-10-01..2026-10-06");
  });

  it("Multipark em baixo: nada se grava, ok:false com o motivo (o agendador repete); nunca lança", async () => {
    const H = harness({ now: NOW1, history: () => dayHistory(), files: () => filesFor("sameday"), failQuery: true });
    const r = await runServiceTimes(H.deps, { deadlineAt: Date.now() + 40_000 });
    expect(r).toMatchObject({ ok: false, done: false });
    expect(r.error).toMatch(/demorou demasiado/);
    expect(H.upserts).toBe(0);
    expect(H.state.value).toBeNull();
  });

  it("serviceTimes.useCalls desligado → a Fila conta desde o pendente (nenhuma chamada lida)", async () => {
    const H = harness({ now: NOW1, history: () => dayHistory(), files: () => filesFor("sameday"), settings: { useCalls: false } });
    await runServiceTimes(H.deps, { deadlineAt: Date.now() + 40_000 });
    expect(del(H, "e1")[0]).toMatchObject({ startSource: "pendente", callAt: null, queueMs: 10 * MIN });
    expect(pick(H, "r3")).toMatchObject({ startSource: "em_recolha", callAt: null });
  });

  it("carga: a leitura da History com teto próprio (≤ 25 s) e as leituras por chave também; sem prazo para uma leitura, não lê nada e fica a meio", async () => {
    const H = harness({ now: NOW1, history: () => dayHistory(), files: () => filesFor("sameday") });
    await runServiceTimes(H.deps, { deadlineAt: Date.now() + 43_000 });
    const hist = H.timeouts.filter((t) => t.history);
    expect(hist.length).toBeGreaterThan(0);
    for (const t of hist) expect(t.ms).toBeLessThanOrEqual(25_000);
    for (const t of H.timeouts.filter((x) => !x.history && x.ms != null)) expect(t.ms!).toBeLessThanOrEqual(10_000);
    // sem teto próprio (o normal, 15 s) só "Park" e "Garage" (tabelas pequenas, uma vez por corrida)
    expect(H.sqls.filter((_, i) => H.timeouts[i].ms == null).every((q) => /FROM "(Park|Garage)"/.test(q))).toBe(true);
    // 10 s de prazo: nem começa a noite (o agendador volta no tick seguinte)
    const H2 = harness({ now: NOW1, history: () => dayHistory(), files: () => filesFor("sameday") });
    const r2 = await runServiceTimes(H2.deps, { deadlineAt: Date.now() + 10_000 });
    expect(r2).toMatchObject({ ok: true, done: false, cursor: "noite" });
    expect(H2.historyReads).toHaveLength(0);
    expect(H2.state.value).toBeNull();
    expect(TICK_JOBS.find((j) => j.key === "service-times")!.minMs).toBeGreaterThanOrEqual(27_000); // o agendador só o arranca com prazo para uma leitura
  });

  it("para trás só até às 09h de Lisboa (a meio do dia não lê a Multipark em sequência); o que falta fica para a manhã seguinte", async () => {
    const at11 = Date.parse("2026-10-14T10:00:00Z"); // 11h de Lisboa
    const H = harness({ now: at11, history: () => dayHistory(), files: () => filesFor("sameday") });
    const r = await runServiceTimes(H.deps, { deadlineAt: Date.now() + 40_000 });
    expect(r).toMatchObject({ ok: true, done: true });
    expect(r.ranges.map((x) => x.reason)).toEqual(["noite"]);
    expect(H.historyReads).toHaveLength(1);
    expect(H.state.value!.todo).toEqual([{ from: "2026-10-09", to: "2026-10-10" }]);
    expect(r.lines.some((l) => /continua amanhã de manhã/.test(l))).toBe(true);
  });

  it("uma leitura vazia da History não anula nada (fica no log: anulação suspensa)", async () => {
    const H1 = harness({ now: NOW1, history: () => dayHistory(), files: () => filesFor("sameday") });
    await runServiceTimes(H1.deps, { deadlineAt: Date.now() + 40_000 });
    const H2 = harness({ now: NOW2, history: () => [], files: () => new Map(), prev: H1 });
    const r2 = await runServiceTimes(H2.deps, { deadlineAt: Date.now() + 40_000 });
    expect(r2.ranges[0]).toMatchObject({ historyRows: 0, voided: 0 });
    expect(r2.ranges[0].voidSuspended).toBeGreaterThan(0);
    expect([...H2.rows.values()].every((x) => x.voidedAt == null)).toBe(true);
    expect(r2.lines.some((l) => /ANULAÇÃO SUSPENSA/.test(l))).toBe(true);
  });

  it("mudar uma zona (outra impressão digital) refaz os últimos 14 dias; mudar o calcVersion recomeça desde `since`", async () => {
    const s0 = nextServiceState(null, { version: 1, hash: "a", today: "2026-10-14", since: "2026-04-03" });
    expect(s0).toEqual({ v: 1, h: "a", nightly: null, todo: [{ from: "2026-04-03", to: "2026-10-10" }] });
    const done = { ...s0, nightly: "2026-10-14", todo: [] };
    expect(nextServiceState(done, { version: 1, hash: "b", today: "2026-10-14", since: "2026-04-03" }).todo).toEqual([{ from: "2026-09-30", to: "2026-10-10" }]);
    expect(nextServiceState(done, { version: 1, hash: "a", today: "2026-10-14", since: "2026-04-03" }).todo).toEqual([]);
    expect(nextServiceState(done, { version: 2, hash: "a", today: "2026-10-14", since: "2026-04-03" }).todo).toEqual([{ from: "2026-04-03", to: "2026-10-10" }]);
    // no trabalho: outra garagem com papel muda a impressão digital
    const H = harness({ now: NOW1, history: () => [], files: () => new Map() });
    await runServiceTimes(H.deps, { deadlineAt: Date.now() + 40_000 });
    const h1 = H.state.value!.h;
    const H2 = harness({ now: NOW1, history: () => [], files: () => new Map(), prev: H, settings: { garageRoles: [{ garage: "P3", role: "provisoria" }] } });
    await runServiceTimes(H2.deps, { deadlineAt: Date.now() + 40_000 });
    expect(H2.state.value!.h).not.toBe(h1);
  });

  // P0: o Park.lat/lng da Multipark não é a garagem — em Lisboa fica junto ao aeroporto
  const transitOf = (H: Harness) => Object.fromEntries([...H.rows.values()].filter((r) => r.kind === "entrega")
    .map((r) => [`${r.bookingId}|${r.anchorHistoryId}`, { transitStatus: r.transitStatus, transitMs: r.transitMs, startedAt: r.startedAt, flags: r.flags }]));
  const noPdMarks = () => dayHistory().filter((r) => !(r.change_type === "MOVEMENT" && r.move_kind === "lugar" && r.garage_to === "PD"));

  it("o Park.lat/lng junto ao aeroporto não muda nenhum tempo: o \"parque\" são as garagens (zonas e marcas \"estacionado aqui\")", async () => {
    const base = harness({ now: NOW1, history: () => dayHistory(), files: () => filesFor("sameday") });
    await runServiceTimes(base.deps, { deadlineAt: Date.now() + 40_000 });
    const nearAirport = parks.map((p) => (p.id === "pLX" ? { ...p, ...at(T1, 50) } : p));
    const H = harness({ now: NOW1, history: () => dayHistory(), files: () => filesFor("sameday"), parkRows: nearAirport });
    await runServiceTimes(H.deps, { deadlineAt: Date.now() + 40_000 });
    expect(transitOf(H)).toEqual(transitOf(base));
    expect(del(H, "e1")[0]).toMatchObject({ transitStatus: "medido", transitMs: 11.5 * MIN });
    expect(del(H, "e4")[0]).toMatchObject({ startedAt: utc(T("18:11") + 30_000), transitStatus: "medido" });
    // e a impressão digital não depende das marcas (não refaz 14 dias de cada vez que a mediana mexe)
    expect(H.state.value!.h).toBe(base.state.value!.h);
    const H2 = harness({ now: NOW1, history: noPdMarks, files: () => filesFor("sameday") });
    await runServiceTimes(H2.deps, { deadlineAt: Date.now() + 40_000 });
    expect(H2.state.value!.h).toBe(base.state.value!.h);
  });

  it("garagem de origem dentro da zona do terminal → `destino_ambiguo`; as marcas de um parque que não operamos não contam", async () => {
    const markAtT1 = (b: string, i: number) => mv(b, `10:1${i}`, "uZ", "lugar", "JUNTO AO T1", "JUNTO AO T1", at(inT1, (i % 2 ? 1 : -1) * 15, 10 * (i - 2)));
    // 5 marcas num parque que a operação não faz (Top Parking): ignoradas — o e4 continua "em entrega" no terminal
    const Hx = harness({ now: NOW1, history: () => [...dayHistory(), ...[0, 1, 2, 3, 4].map((i) => markAtT1("eMK", i))], files: () => filesFor("sameday") });
    await runServiceTimes(Hx.deps, { deadlineAt: Date.now() + 40_000 });
    expect(del(Hx, "e4")[0]).toMatchObject({ transitStatus: "medido", startedAt: utc(T("18:11") + 30_000) });
    // as mesmas marcas numa reserva nossa: há uma garagem nossa no T1 — o e4 (posição em S lá dentro) fica ambíguo; o e1 (saiu da PD) não
    const Hy = harness({ now: NOW1, history: () => [...dayHistory(), ...[0, 1, 2, 3, 4].map((i) => markAtT1("e7", i))], files: () => filesFor("sameday") });
    await runServiceTimes(Hy.deps, { deadlineAt: Date.now() + 40_000 });
    expect(del(Hy, "e4")[0]).toMatchObject({ transitStatus: "destino_ambiguo" });
    expect(del(Hy, "e1")[0]).toMatchObject({ transitStatus: "medido", transitMs: 11.5 * MIN });
  });

  it("sem garagens conhecidas (nem zona nem marcas): a coerência fica pela linha \"em entrega\"; a saída do parque não se adivinha", async () => {
    const H = harness({ now: NOW1, history: noPdMarks, files: () => filesFor("sameday"), garageRows: [] });
    await runServiceTimes(H.deps, { deadlineAt: Date.now() + 40_000 });
    expect(del(H, "e1")[0]).toMatchObject({ transitStatus: "medido", transitMs: 11.5 * MIN });
    const e4 = del(H, "e4")[0];
    expect(e4.flags).toEqual(expect.stringContaining("inicio_no_terminal"));
    expect(e4.transitStatus).not.toBe("medido");
  });
});

describe("peças do trabalho (puras)", () => {
  it("noites que faltaram (Multipark em baixo, interruptor desligado): os dias entre a última noite e D-4 vão para trás", () => {
    const prev = { v: 1, h: "a", nightly: "2026-10-08", todo: [] };
    // a noite de 8 leu 5–7; hoje (14) lê 11–13: faltam 8–10
    expect(nextServiceState(prev, { version: 1, hash: "a", today: "2026-10-14", since: "2026-04-03" }).todo).toEqual([{ from: "2026-10-08", to: "2026-10-10" }]);
    expect(nextServiceState({ ...prev, nightly: "2026-10-13" }, { version: 1, hash: "a", today: "2026-10-14", since: "2026-04-03" }).todo).toEqual([]);
    expect(nextServiceState({ ...prev, nightly: "2026-10-10" }, { version: 1, hash: "a", today: "2026-10-14", since: "2026-04-03" }).todo).toEqual([{ from: "2026-10-10", to: "2026-10-10" }]);
  });

  it("blocos para trás: 7 dias sem GPS, 2 com GPS, sem misturar", () => {
    const o = { days: 7, gpsDays: 2, gpsSince: "2026-09-15" };
    expect(nextBackfillBlock([{ from: "2026-04-03", to: "2026-10-10" }], o)).toEqual({ block: { from: "2026-10-09", to: "2026-10-10" }, rest: [{ from: "2026-04-03", to: "2026-10-08" }] });
    expect(nextBackfillBlock([{ from: "2026-04-03", to: "2026-09-15" }], o).block).toEqual({ from: "2026-09-15", to: "2026-09-15" });
    expect(nextBackfillBlock([{ from: "2026-04-03", to: "2026-09-14" }], o).block).toEqual({ from: "2026-09-08", to: "2026-09-14" });
    // quantas leituras desde 3 abr (uma vez): 24 sem GPS + 13 com GPS
    let todo = [{ from: "2026-04-03", to: "2026-10-10" }], n = 0;
    for (; todo.length && n < 100; n++) todo = nextBackfillBlock(todo, o).rest;
    expect(n).toBe(37);
  });

  it("intervalos de dias, blocos de 7 para trás e o parâmetro reprocessar", () => {
    expect(mergeDayRanges([{ from: "2026-10-05", to: "2026-10-07" }, { from: "2026-10-08", to: "2026-10-09" }, { from: "2026-09-01", to: "2026-09-02" }])).toEqual([{ from: "2026-09-01", to: "2026-09-02" }, { from: "2026-10-05", to: "2026-10-09" }]);
    expect(nextBackfillBlock([{ from: "2026-09-20", to: "2026-10-10" }])).toEqual({ block: { from: "2026-10-04", to: "2026-10-10" }, rest: [{ from: "2026-09-20", to: "2026-10-03" }] });
    expect(nextBackfillBlock([{ from: "2026-10-08", to: "2026-10-10" }])).toEqual({ block: { from: "2026-10-08", to: "2026-10-10" }, rest: [] });
    expect(parseServiceReprocess("2026-10-01..2026-10-13")).toEqual({ from: "2026-10-01", to: "2026-10-13" });
    expect(parseServiceReprocess("2026-10-13")).toEqual({ from: "2026-10-13", to: "2026-10-13" });
    expect(parseServiceReprocess("2026-10-13..2026-10-01")).toBeNull();
    expect(parseServiceReprocess("2026-01-01..2026-10-01")).toBeNull();
  });

  it("janela da leitura: 6 h antes do 1.º dia operacional e 48 h depois do último (nunca depois de agora)", () => {
    const w = readWindowFor("2026-10-11", "2026-10-13", NOW1);
    expect(new Date(w.anchorFromMs).toISOString()).toBe("2026-10-11T02:00:00.000Z");
    expect(new Date(w.anchorToMs).toISOString()).toBe("2026-10-14T02:00:00.000Z");
    expect(new Date(w.readFromMs).toISOString()).toBe("2026-10-10T20:00:00.000Z");
    expect(w.readToMs).toBe(NOW1);
    // mudança de hora: o dia operacional de 24 out tem 25 h (02:00 UTC → 03:00 UTC do dia 25)
    const d = readWindowFor("2026-10-24", "2026-10-24", Date.parse("2026-11-01T00:00:00Z"));
    expect(new Date(d.anchorFromMs).toISOString()).toBe("2026-10-24T02:00:00.000Z");
    expect(new Date(d.anchorToMs).toISOString()).toBe("2026-10-25T03:00:00.000Z");
    expect((d.anchorToMs - d.anchorFromMs) / 3_600_000).toBe(25);
  });

  it("classe do destino = a do Extras-Dia (classifyDeliveryType); tipo de lugar", () => {
    for (const [dt, city] of [["Terminal 2", "lisbon"], ["T2", "porto"], ["Estação do Oriente", "lisbon"], ["VIP", "faro"], ["Estação de comboios", "faro"], ["", "lisbon"], ["Hotel", "lisbon"]] as const) {
      expect(terminalClassOf(dt, city), `${dt}/${city}`).toBe(classifyDeliveryType(dt, city));
    }
    expect(spotTypeOf("INDOOR", null)).toBe("indoor");
    expect(spotTypeOf(null, null)).toBe("unknown");
  });

  it("a leitura da History: só os tipos precisos, 3 chaves do snapshot, estado e garagens extraídos no Postgres; o mapeador", () => {
    const q = buildServiceHistorySql({ fromUtc: "2026-10-10 20:00:00", toUtc: "2026-10-14 05:40:00" });
    expect(() => assertReadOnlySql(q.sql)).not.toThrow();
    expect(q.sql).not.toMatch(/\\/);
    expect(q.sql.match(/"snapshot"->>'([a-zA-Z]+)'/g)).toEqual([`"snapshot"->>'status'`, `"snapshot"->>'arrivedAtDeliveryAt'`, `"snapshot"->>'baggageWaitingAt'`]);
    expect(q.sql).not.toMatch(/SELECT[^;]*h\."modifiedFields" AS/);
    expect(q.params).toContain("CHECKING_IN");
    expect(q.params).toContain('%"status"%');
    const ev = mapServiceHistoryRow({ id: "1", booking_id: "b", change_type: "MOVEMENT", action_time: "2026-10-13 09:10:00.250", agent_user_id: "u", lat: 0, lng: 0, move_kind: "parques", garage_from: "P2", garage_to: "CENTRAL" }) as ServiceEvent;
    expect(ev).toMatchObject({ type: "MOVEMENT", at: Date.parse("2026-10-13T09:10:00.250Z"), moveKind: "parques", garageFrom: "P2", garageTo: "CENTRAL", lat: null });
  });

  it("saída do P2 sem início de movimento → pelo GPS de quem o levou", () => {
    const evs = dayHistory().filter((r) => r.booking_id === "r2" && !(r.change_type === "MOVEMENT" && r.move_kind === "inicio" && String(r.action_time).includes("09:00"))).map(mapServiceHistoryRow).filter(Boolean) as ServiceEvent[];
    const [p] = buildPickupCycles(evs);
    expect(p2LeaveOf(p, DEFAULT_GARAGE_ROLES)).toMatchObject({ firstEnd: { garageTo: "P2" }, leave: { garageTo: "CENTRAL", agentUserId: "uC" } });
    const [q] = buildPickupCycles(dayHistory().filter((r) => r.booking_id === "r2").map(mapServiceHistoryRow).filter(Boolean) as ServiceEvent[]);
    expect(p2LeaveOf(q, DEFAULT_GARAGE_ROLES)).toBeNull();
  });

  it("resumo do dia sem dados → nada", () => {
    expect(summarizeServiceDay([], "2026-10-13", "lisboa", 15)).toBeNull();
  });
});

describe("registo: interruptor, agenda, crons, rota manual e ajuda", () => {
  it("SERVICE_TIMES desligado por omissão e só do super admin; o cron salta sem ler nada", async () => {
    expect(AUTOMATION_FLAGS.find((f) => f.name === "SERVICE_TIMES")).toMatchObject({ defaultEnabled: false, superAdminOnly: true });
    expect(automationFlagDefault("SERVICE_TIMES")).toBe(false);
    flag.on = false; flag.deps = 0;
    const { serviceTimesCron } = await import("./cronJobs");
    const r = await serviceTimesCron({ deadlineAt: Date.now() + 10_000 });
    expect(r).toMatchObject({ httpStatus: 200, done: true, body: { skipped: "SERVICE_TIMES desligado" } });
    expect(flag.deps).toBe(0);
  });

  it("diário a partir das 05:30, depois da recolha GPS final (o mais tardar 07:00); nos crons; runner; rota manual com reprocessar", async () => {
    expect(TICK_JOBS.find((j) => j.key === "service-times")).toMatchObject({ runName: "service-times", cadence: { kind: "daily", from: "05:30", after: { job: "daily-ops", fallbackFrom: "07:00" } } });
    expect(CRON_JOBS.find((j) => j.name === "service-times")).toMatchObject({ intervalMinutes: 1440, workflow: "tick" });
    const { JOB_RUNNERS } = await import("./cronScheduler");
    expect(typeof JOB_RUNNERS["service-times"]).toBe("function");
    const api = read("server/_core/api-entry.ts");
    expect(api).toContain('app.get("/api/cron/service-times"');
    expect(api).toContain("parseServiceReprocess(req.query.reprocessar)");
    expect(read("docs/ajuda/agendador.md")).toMatch(/Tempos de entrega e de recolha[\s\S]*service-times\?reprocessar=AAAA-MM-DD\.\.AAAA-MM-DD[\s\S]*trabalho `service-times`/);
  });
});
