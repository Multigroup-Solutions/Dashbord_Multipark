import { describe, expect, it } from "vitest";
import { assertReadOnlySql } from "./multiparkDb/client";
import {
  PROBE_HISTORY_TYPES, buildProbeAgentsSql, buildProbeBookingsSql, buildProbeClientPhonesSql, buildProbeClockSql, buildProbeCoordColumnsSql, buildProbeDriverPhonesSql,
  buildProbeGaragesSql, buildProbeHistorySql, buildProbeParksSql, garageCoordColumns, mapCoordColumns, mapProbeHistoryRow, movementGarages,
} from "./multiparkDb/sondaTempos";
import {
  buildBookingCycles, computeProbeCity, coordsFromText, garageCoords, lastArrivalInZone, matchCalls, sharedPhones, terminalExit, terminalStop, windowGaps, zoneKind,
  type PosPoint, type ProbeCall, type ProbeCityInput, type ProbeEvent,
} from "./sondaTemposCompute";
import { loadProbeGps, probeDayError, runTimesProbe, type ProbeDeps, type ProbeGpsSource } from "./sondaTempos";
import {
  LOG_LINE_MAX_BYTES, T2_LATE_AFTER_MIN, buildSondaReport, emptySondaResult, histAdd, histPercentile, histShareAtLeast, mergeSondaResults, newHist,
  sondaLogLines, sondaReportText, type SondaResult,
} from "../shared/sondaTempos";
import { operationalDayRangeUtc } from "../shared/lisbonDay";

// ─── Dados sintéticos (com tudo o que NUNCA pode sair) ──────────────────────

const DAY = "2026-10-10";
const OP = operationalDayRangeUtc(DAY); // 03h Lisboa = 02:00Z
const at = (hhmm: string, s = 0) => Date.parse(`${DAY}T${hhmm}:00Z`) + s * 1000;
const PARK = { lat: 38.7900, lng: -9.1200 };
/** Coordenadas de uma garagem (locais, não pessoas: podem aparecer na saída — Q6). */
const P2_GARAGE = { lat: 38.76120, lng: -9.11850 };
const T1 = { lat: 38.7700, lng: -9.1300 };
const T2 = { lat: 38.7760, lng: -9.1260 };
const AIRPORT = { lat: 38.7742, lng: -9.1342, radiusM: 1500, zones: [{ label: "T1", ...T1, radiusM: 200 }, { label: "Terminal 2", ...T2, radiusM: 200 }] };
const SECRETS = [
  "bk-SECRET-001", "bk-SECRET-002", "cli-SECRET-9", "912345678", "934567890", "351912345678",
  "agent-uid-TL1", "agent-uid-DRV1", "Maria Secreta", "João Condutor", "zello_joao", "AA-00-BB", "park-AIR-LIS-77",
  "38.79", "38.77", "9.13", "9.12", "bucket-privado",
];
const noSecrets = (text: string) => {
  for (const s of SECRETS) expect(text.includes(s), `saída com "${s}"`).toBe(false);
};

let seq = 0;
const ev = (o: Partial<ProbeEvent> & Pick<ProbeEvent, "bookingId" | "type" | "atMs">): ProbeEvent => ({
  id: `h${++seq}`, uid: null, agentName: null, platform: "MOBILE", lat: null, lng: null, hasSnapshot: true, snapStatus: null,
  snapArrivedMs: null, snapBaggageMs: null, moveKind: null, garageFrom: null, garageTo: null, updateStatusTo: null, ...o,
});

/** Pontos de minuto a minuto de `from` a `to`, a ir de `a` para `b` à velocidade dada. */
function track(from: number, to: number, a: { lat: number; lng: number }, b: { lat: number; lng: number }, speed: number, stepS = 60): PosPoint[] {
  const out: PosPoint[] = [];
  const n = Math.max(1, Math.round((to - from) / 1000 / stepS));
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    out.push({ ts: Math.round(from / 1000) + i * stepS, speed, lat: a.lat + (b.lat - a.lat) * f, lon: a.lng + (b.lng - a.lng) * f, accurate: true });
  }
  return out;
}

const DEL = "bk-SECRET-001";
const PIC = "bk-SECRET-002";
function dayEvents(): ProbeEvent[] {
  return [
    // entrega: pendente 14:00, em entrega 14:10, assinatura 14:30 (no T1)
    ev({ bookingId: DEL, type: "PENDING_CHECKOUT", atMs: at("14:00"), uid: "agent-uid-TL1", agentName: "Maria Secreta", lat: PARK.lat, lng: PARK.lng, snapStatus: "PENDING_CHECKOUT" }),
    ev({ bookingId: DEL, type: "CHECKING_OUT", atMs: at("14:10"), uid: "agent-uid-DRV1", agentName: "João Condutor", lat: PARK.lat, lng: PARK.lng, snapStatus: "CHECKING_OUT" }),
    ev({ bookingId: DEL, type: "CHECK_OUT", atMs: at("14:30"), uid: "agent-uid-DRV1", agentName: "João Condutor", lat: T1.lat + 0.0001, lng: T1.lng - 0.0001, snapStatus: "CHECKED_OUT", snapArrivedMs: at("14:25") }),
    // recolha no T2: em recolha 08:00, check-in 08:20, movimento 08:25→08:45 (P2), 12:00 P2 → PD
    ev({ bookingId: PIC, type: "CHECKING_IN", atMs: at("08:00"), uid: "agent-uid-TL1", agentName: "Maria Secreta", lat: PARK.lat, lng: PARK.lng }),
    ev({ bookingId: PIC, type: "CHECK_IN", atMs: at("08:20"), uid: "agent-uid-DRV1", agentName: "João Condutor", lat: T2.lat, lng: T2.lng }),
    ev({ bookingId: PIC, type: "MOVEMENT", atMs: at("08:25"), uid: "agent-uid-DRV1", agentName: "João Condutor", lat: T2.lat, lng: T2.lng, moveKind: "inicio" }),
    ev({ bookingId: PIC, type: "MOVEMENT", atMs: at("08:45"), uid: "agent-uid-DRV1", agentName: "João Condutor", lat: T1.lat - 0.002, lng: T1.lng, moveKind: "arrumar", garageTo: "p2" }),
    ev({ bookingId: PIC, type: "MOVEMENT", atMs: at("12:00"), uid: "agent-uid-DRV1", agentName: "João Condutor", moveKind: "parques", garageFrom: "p2", garageTo: "pd" }),
  ];
}
const drvPoints = (): PosPoint[] => [
  // recolha: parado no T2 das 08:05 às 08:24, sai a 30 km/h às 08:26
  ...track(at("08:05"), at("08:24"), T2, T2, 0),
  ...track(at("08:26"), at("08:40"), { lat: T2.lat + 0.004, lng: T2.lng }, { lat: T2.lat + 0.03, lng: T2.lng }, 30),
  // entrega: a andar do parque ao T1 (14:11–14:21), parado no T1 das 14:22 às 14:35
  ...track(at("14:11"), at("14:21"), PARK, T1, 40),
  ...track(at("14:22"), at("14:35"), T1, T1, 0),
];

function cityInput(over: Partial<ProbeCityInput> = {}): ProbeCityInput {
  return {
    city: "lisbon", day: DAY, opStartMs: OP.startMs, opEndMs: OP.endMs,
    events: dayEvents(),
    bookings: new Map([[DEL, { id: DEL, parkId: "park-AIR-LIS-77", terminalClass: "t1" as const }], [PIC, { id: PIC, parkId: "park-AIR-LIS-77", terminalClass: "t2" as const }]]),
    parks: new Map([["park-AIR-LIS-77", { id: "park-AIR-LIS-77", city: "lisbon" as const, ...PARK }]]),
    garages: [
      { name: "P2", parkingType: "UNCOVERED", parkId: "park-AIR-LIS-77", mapHasCoords: false, ...P2_GARAGE, coordSource: "colunas lat/lng da Garage" },
      { name: "PD", parkingType: "UNCOVERED", parkId: "park-AIR-LIS-77", mapHasCoords: false, lat: null, lng: null, coordSource: "link do mapa sem coordenadas (link curto?)" },
    ],
    agents: new Map([["agent-uid-TL1", [{ parkId: "park-AIR-LIS-77", role: "LEADER" }]], ["agent-uid-DRV1", [{ parkId: "outro-parque", role: "DRIVER" }]]]),
    resolveAgent: (uid) => (uid === "agent-uid-DRV1" ? { kind: "ficha", employeeId: 501 } : uid === "agent-uid-TL1" ? { kind: "ficha", employeeId: 502 } : { kind: "sem_ficha" }),
    gps: new Map([[501, { status: "ok" as const, files: [{ id: 9001, day: DAY, split: false, points: drvPoints(), mine: () => true }] }], [502, { status: "sem_ficheiro" as const, files: [] }]]),
    phones: new Map([[DEL, new Set(["912345678"])], [PIC, new Set(["934567890"])]]),
    crmIds: new Map(),
    calls: [
      { source: "central", atMs: at("13:50"), last9: "912345678", held: true, crmClientId: null, createdAtMs: at("13:50", 4) },
      { source: "whatsapp", atMs: at("07:58"), last9: "934567890", held: false, crmClientId: null, createdAtMs: null },
    ],
    airport: AIRPORT,
    global: {
      gpsRows: [{ pass: "final", hasFile: true }, { pass: "sameday", hasFile: false }], filesPending: 0,
      calls: [
        { source: "central", atMs: at("13:50"), last9: "912345678", held: true, crmClientId: null, createdAtMs: at("13:50", 4) },
        { source: "central", atMs: at("15:00"), last9: null, held: false, crmClientId: null, createdAtMs: at("15:01") },
        { source: "central", atMs: at("15:00") + 24 * 3_600_000, last9: "912345678", held: true, crmClientId: null, createdAtMs: null },
        { source: "whatsapp", atMs: at("07:58"), last9: "934567890", held: false, crmClientId: null, createdAtMs: null },
      ],
    },
    staticBase: { centralSugarOn: true, excludedParks: 1, parks: 1, pgClockOffsetMs: 120 },
    ...over,
  };
}

// ─── Histogramas e percentis ────────────────────────────────────────────────

describe("histogramas com caixas fixas", () => {
  it("percentis com interpolação, abaixo e acima das arestas", () => {
    const h = newHist("min");
    for (let i = 0; i < 10; i++) histAdd(h, 12); // caixa [10, 15)
    expect(histPercentile(h, 0.5)?.value).toBeCloseTo(12.5, 5);
    histAdd(h, 999);
    expect(histPercentile(h, 1)).toMatchObject({ above: true, value: 240 });
    histAdd(h, -3);
    expect(histPercentile(h, 0)).toMatchObject({ below: true, value: 0 });
    expect(histPercentile(newHist("min"), 0.5)).toBeNull();
  });
  it("% acima de 6 min (aresta exata)", () => {
    const h = newHist("gapS");
    [30, 60, 120, 359, 360, 400, 2000].forEach((v) => histAdd(h, v));
    expect(histShareAtLeast(h, 360)).toBeCloseTo(3 / 7, 6);
  });
  it("dois dias somados = um período com os dois dias", () => {
    const a = emptySondaResult("lisbon", ["2026-10-09"]), b = emptySondaResult("lisbon", ["2026-10-10"]), both = emptySondaResult("lisbon", ["2026-10-09", "2026-10-10"]);
    for (const [r, vals] of [[a, [1, 4, 9, 33]], [b, [2, 2, 70, 181]]] as Array<[SondaResult, number[]]>) {
      r.h.x = newHist("min");
      r.n.c = vals.length;
      for (const v of vals) { histAdd(r.h.x, v); }
    }
    both.h.x = newHist("min");
    for (const v of [1, 4, 9, 33, 2, 2, 70, 181]) histAdd(both.h.x, v);
    const m = mergeSondaResults([a, b]);
    expect(m.h.x.c).toEqual(both.h.x.c);
    expect(m.n.c).toBe(8);
    expect(m.days).toEqual(["2026-10-09", "2026-10-10"]);
    for (const q of [0.5, 0.9, 0.99]) expect(histPercentile(m.h.x, q)).toEqual(histPercentile(both.h.x, q));
    // os de entrada não mudam
    expect(a.n.c).toBe(4);
  });
  it("várias cidades: as definições (zonas, garagens) não se misturam", () => {
    const a = emptySondaResult("lisbon", [DAY]), b = emptySondaResult("porto", [DAY]);
    a.s = { airportRadiusM: 1500, zones: [], centralSugarOn: true, excludedParks: 0, parks: 1, garages: [], pgClockOffsetMs: 0 };
    b.s = a.s;
    expect(mergeSondaResults([a]).s).not.toBeNull();
    expect(mergeSondaResults([a, b]).s).toBeNull();
  });
});

// ─── Paragem, saída e chegada ───────────────────────────────────────────────

describe("paragem no terminal antes do CHECK_OUT", () => {
  const S = at("14:10"), E = at("14:30");
  const base = { lat: T1.lat, lng: T1.lng, radiusM: 200, startMs: S, endMs: E };
  it("pontos densos parados na zona → paragem, com o início e até à assinatura", () => {
    const st = terminalStop(drvPoints(), { ...base, vMaxKmh: 3, minStopS: 120 });
    expect(st).toMatchObject({ found: true, lastsUntilEnd: true });
    expect(st.found && st.startMs).toBe(at("14:22"));
  });
  it("passar pela zona a andar não é paragem", () => {
    const pts = track(S, E, { lat: T1.lat - 0.01, lng: T1.lng }, { lat: T1.lat + 0.01, lng: T1.lng }, 40);
    expect(terminalStop(pts, { ...base, vMaxKmh: 7, minStopS: 60 }).found).toBe(false);
  });
  it("pontos espaçados: o último ponto antes da assinatura, dentro e parado, chega (o carro ficou lá)", () => {
    const pts: PosPoint[] = [
      { ts: at("14:12") / 1000, speed: 40, lat: PARK.lat, lon: PARK.lng, accurate: true },
      { ts: at("14:24") / 1000, speed: 0, lat: T1.lat, lon: T1.lng, accurate: true },
    ];
    const st = terminalStop(pts, { ...base, vMaxKmh: 3, minStopS: 180 });
    expect(st).toMatchObject({ found: true, lastsUntilEnd: true });
  });
  it("parado pouco tempo e a sair → não chega à duração mínima", () => {
    const pts = [...track(at("14:20"), at("14:21"), T1, T1, 0), ...track(at("14:22"), at("14:29"), { lat: T1.lat + 0.01, lng: T1.lng }, { lat: T1.lat + 0.02, lng: T1.lng }, 30)];
    expect(terminalStop(pts, { ...base, vMaxKmh: 3, minStopS: 120 }).found).toBe(false);
  });
});

describe("saída do terminal e chegada ao T2", () => {
  const I = at("08:20");
  it("sai a 30 km/h → X no meio entre o último ponto dentro e o 1.º de carro", () => {
    const x = terminalExit(drvPoints(), { lat: T2.lat, lng: T2.lng, radiusM: 200, marginM: 300, vCarKmh: 10, fromMs: I, toMs: I + 3_600_000 });
    expect(x).toBe((at("08:24") + at("08:26")) / 2);
  });
  it("sai a pé e volta → não é saída de carro", () => {
    const pts: PosPoint[] = [
      { ts: at("08:21") / 1000, speed: 0, lat: T2.lat, lon: T2.lng, accurate: true },
      { ts: at("08:23") / 1000, speed: 4, lat: T2.lat + 0.0025, lon: T2.lng, accurate: true },
      { ts: at("08:25") / 1000, speed: 0, lat: T2.lat, lon: T2.lng, accurate: true },
    ];
    expect(terminalExit(pts, { lat: T2.lat, lng: T2.lng, radiusM: 200, marginM: 300, vCarKmh: 10, fromMs: I, toMs: I + 3_600_000 })).toBeNull();
  });
  it("chegada à zona: a última série de pontos dentro antes do check-in", () => {
    const zone = { ...T2, radiusM: 200 };
    expect(lastArrivalInZone(drvPoints(), zone, at("07:30"), I)).toBe(at("08:05"));
    const away = [...track(at("07:40"), at("07:45"), T2, T2, 0), ...track(at("07:50"), at("07:55"), PARK, PARK, 0), ...track(at("08:10"), at("08:19"), T2, T2, 0)];
    expect(lastArrivalInZone(away, zone, at("07:30"), I)).toBe(at("08:10"));
    expect(lastArrivalInZone(track(at("08:10"), at("08:19"), PARK, PARK, 0), zone, at("07:30"), I)).toBeNull();
  });
  it("intervalos que tocam a janela (com os de fora)", () => {
    const pts = track(at("14:00"), at("14:40"), PARK, PARK, 0, 300);
    // pontos às 14:00, 14:05, …, 14:40; janela 14:12–14:28 → os 4 intervalos que a tocam (14:10–14:30)
    const g = windowGaps(pts, at("14:12"), at("14:28"));
    expect(g.map((x) => x.gapS)).toEqual([300, 300, 300, 300]);
    expect(g.every((x) => !x.moving)).toBe(true);
  });
  it("rótulos das zonas", () => {
    expect([zoneKind("T1"), zoneKind("Terminal 2"), zoneKind("t2 chegadas"), zoneKind(""), zoneKind("Partidas")]).toEqual(["T1", "T2", "T2", "sem_rotulo", "outro"]);
  });
});

// ─── Q6: coordenadas das garagens ───────────────────────────────────────────

describe("coordenadas das garagens (Q6)", () => {
  it("lê o link do mapa (pino, centro, q=, %2C, JSON) e recusa link curto e 0,0", () => {
    expect(coordsFromText("https://www.google.com/maps/place/P2/@38.7600,-9.1100,17z/data=!3d38.76125!4d-9.11852")).toEqual({ lat: 38.76125, lng: -9.11852 });
    expect(coordsFromText("https://www.google.com/maps/@38.7612,-9.1185,17z")).toEqual({ lat: 38.7612, lng: -9.1185 });
    expect(coordsFromText("https://maps.google.com/?q=38.7612%2C-9.1185")).toEqual({ lat: 38.7612, lng: -9.1185 });
    expect(coordsFromText(`{"lat": 38.7612, "lng": -9.1185}`)).toEqual({ lat: 38.7612, lng: -9.1185 });
    expect(coordsFromText("38.7612, -9.1185")).toEqual({ lat: 38.7612, lng: -9.1185 });
    expect(coordsFromText("https://maps.app.goo.gl/AbCdEf")).toBeNull();
    expect(coordsFromText("0.000, 0.000")).toBeNull();
    expect(coordsFromText(null)).toBeNull();
  });
  it("ordem: colunas lat/lng → outra coluna → link do mapa; diz de onde vieram", () => {
    expect(garageCoords({ lat: "38.7612", lng: "-9.1185", mapLink: "https://maps.google.com/?q=1.5,2.5" })).toEqual({ lat: 38.7612, lng: -9.1185, source: "colunas lat/lng da Garage" });
    expect(garageCoords({ other: [{ column: "location", value: "38.7612,-9.1185" }] }).source).toBe("coluna location da Garage");
    expect(garageCoords({ mapLink: "https://maps.google.com/?q=38.7612,-9.1185" }).source).toBe("link do mapa (mapLink)");
    expect(garageCoords({ mapLink: "https://maps.app.goo.gl/x" })).toEqual({ lat: null, lng: null, source: "link do mapa sem coordenadas (link curto?)" });
    expect(garageCoords({})).toEqual({ lat: null, lng: null, source: "sem coordenadas" });
  });
  it("descobre as colunas no information_schema (só identificadores seguros) e lê-as da Garage", () => {
    const q = buildProbeCoordColumnsSql();
    expect(() => assertReadOnlySql(q.sql)).not.toThrow();
    expect(q.sql).toContain("information_schema.columns");
    const cols = mapCoordColumns([
      { table_name: "Garage", column_name: "mapLink", data_type: "text" },
      { table_name: "Garage", column_name: "latitude", data_type: "double precision" },
      { table_name: "Garage", column_name: "longitude", data_type: "double precision" },
      { table_name: "Garage", column_name: "geoPoint", data_type: "jsonb" },
      { table_name: "Garage", column_name: `x"; DROP TABLE "Garage`, data_type: "text" },
      { table_name: "Park", column_name: "lat", data_type: "double precision" },
    ]);
    expect(cols.map((c) => `${c.table}.${c.column}`)).toEqual(["Garage.mapLink", "Garage.latitude", "Garage.longitude", "Garage.geoPoint", "Park.lat"]);
    const gc = garageCoordColumns(cols);
    expect(gc).toEqual({ lat: "latitude", lng: "longitude", other: ["geoPoint"] });
    const g = buildProbeGaragesSql(gc);
    expect(() => assertReadOnlySql(g.sql)).not.toThrow();
    expect(g.sql).toContain(`g."latitude"::text AS g_lat`);
    expect(g.sql).toContain(`left(g."geoPoint"::text, 600) AS g_other_0`);
    // só a lat sem a lng não conta como par; identificadores perigosos nunca entram
    expect(garageCoordColumns(cols.filter((c) => c.column !== "longitude")).lat).toBeNull();
    expect(buildProbeGaragesSql({ lat: `a"b`, lng: "c", other: [`x" OR 1=1`] }).sql).not.toContain(`a"b`);
  });
  it("conta as garagens com coordenadas válidas e mede a posição dos fins de movimento até elas", () => {
    const r = computeProbeCity(cityInput());
    expect(r.s?.garages).toEqual([
      expect.objectContaining({ name: "P2", lat: P2_GARAGE.lat, lng: P2_GARAGE.lng, valid: true, coordSource: "colunas lat/lng da Garage" }),
      expect.objectContaining({ name: "PD", lat: null, valid: false }),
    ]);
    // o fim no P2 tem posição → distância às coordenadas do P2; o do PD não tem posição
    expect(histPercentile(r.h["garagens.posicao_vs_coord.P2"], 0.5)?.value).toBeGreaterThan(1000);
    expect(r.n["garagens.coord.mov_sem_posicao"]).toBe(1);
    // coordenadas longe do parque (> 30 km, ex.: lat/lng trocadas) não são válidas
    const far = computeProbeCity(cityInput({ garages: [{ name: "P2", parkingType: null, parkId: "park-AIR-LIS-77", mapHasCoords: false, lat: -9.1185, lng: 38.7612, coordSource: "colunas lat/lng da Garage" }] }));
    expect(far.s?.garages[0].valid).toBe(false);
    expect(far.n["garagens.coord.garagem_sem_coordenadas"]).toBe(1);
    const report = buildSondaReport(r);
    const sec = report.find((x) => x.id === "garagens_coord")!;
    expect(sec.item).toBe(16);
    expect(sec.table?.rows[0].slice(0, 5)).toEqual(["P2", "—", "colunas lat/lng da Garage", "38.76120, -9.11850", "sim"]);
    expect(report[0].rows.find((x) => x.label.startsWith("Garagens com coordenadas válidas"))?.value).toBe("1 de 2");
  });
});

// ─── Q4: recolha atrasada no T2 a partir de 15 min ──────────────────────────

describe("recolha atrasada no T2 (Q4 = 15 min)", () => {
  // K0 = a chamada do WhatsApp às 07:58 (antes do "em recolha" das 08:00)
  const withArrival = (hhmm: string) => {
    const pts = [...track(at(hhmm), at("08:24"), T2, T2, 0), ...track(at("08:26"), at("08:40"), { lat: T2.lat + 0.004, lng: T2.lng }, { lat: T2.lat + 0.03, lng: T2.lng }, 30)];
    return computeProbeCity(cityInput({ gps: new Map([[501, { status: "ok" as const, files: [{ id: 1, day: DAY, split: false, points: pts, mine: () => true }] }]]) }));
  };
  it("o limiar é 15 min", () => expect(T2_LATE_AFTER_MIN).toBe(15));
  it("chega 14 min depois de K0 → a tempo (com a regra antiga dos 10 min era atrasada)", () => {
    const r = withArrival("08:12");
    expect(r.n["t2.com_chegada"]).toBe(1);
    expect(r.n["t2.atrasadas"]).toBeUndefined();
  });
  it("chega 18 min depois de K0 → atrasada; aparece na leitura rápida e no item 12", () => {
    const r = withArrival("08:16");
    expect(r.n["t2.atrasadas"]).toBe(1);
    const report = buildSondaReport(r);
    expect(report[0].rows.find((x) => x.label.includes("T2 atrasadas"))?.label).toContain("> 15 min");
    const t2 = report.find((x) => x.id === "t2")!;
    expect(t2.closes).toContain("15 min");
    expect(t2.rows.find((x) => x.label.startsWith("Atrasadas"))?.value).toContain("1 de 1");
  });
});

// ─── Ciclos e chamadas ──────────────────────────────────────────────────────

describe("ciclos por reserva", () => {
  it("entrega simples e recolha com movimentos", () => {
    const c = buildBookingCycles(dayEvents().filter((e) => e.bookingId === DEL));
    expect(c.deliveries).toHaveLength(1);
    expect(c.deliveries[0]).toMatchObject({ outcome: "entregue" });
    expect(c.deliveries[0].R?.atMs).toBe(at("14:00"));
    const p = buildBookingCycles(dayEvents().filter((e) => e.bookingId === PIC));
    expect(p.pickups[0]).toMatchObject({ outcome: "recebido" });
    expect(p.pickups[0].moves).toHaveLength(3);
  });
  it("CHECK_OUT repetido, reabertura com fecho repetido, cancelada e recolha reiniciada", () => {
    const b = "bk-x";
    const c = buildBookingCycles([
      ev({ bookingId: b, type: "PENDING_CHECKOUT", atMs: at("10:00") }),
      ev({ bookingId: b, type: "CHECK_OUT", atMs: at("10:20") }),
      ev({ bookingId: b, type: "CHECK_OUT", atMs: at("10:21") }),
      ev({ bookingId: b, type: "UPDATE", atMs: at("11:00"), updateStatusTo: "CHECKED_IN" }),
      ev({ bookingId: b, type: "CHECK_OUT", atMs: at("11:05") }),
      ev({ bookingId: b, type: "PENDING_CHECKOUT", atMs: at("15:00") }),
      ev({ bookingId: b, type: "CANCEL", atMs: at("15:10") }),
    ]);
    expect(c.notes.map((n) => n.kind)).toEqual(["checkout_repetido", "reaberturas", "fecho_repetido"]);
    expect(c.deliveries.map((d) => d.outcome)).toEqual(["entregue", "cancelado"]);
    const p = buildBookingCycles([
      ev({ bookingId: b, type: "CHECKING_IN", atMs: at("06:00") }),
      ev({ bookingId: b, type: "UPDATE", atMs: at("07:00"), updateStatusTo: "BOOKED" }),
      ev({ bookingId: b, type: "CHECKING_IN", atMs: at("09:00") }),
      ev({ bookingId: b, type: "CHECK_IN", atMs: at("09:05") }),
    ]);
    expect(p.notes.map((n) => n.kind)).toEqual(["recolha_reiniciada"]);
    expect(p.pickups[0].K?.atMs).toBe(at("09:00"));
  });
});

describe("chamadas → reserva", () => {
  const R = at("14:00");
  const call = (min: number, last9: string | null = "912345678", o: Partial<ProbeCall> = {}): ProbeCall => ({ source: "central", atMs: R + min * 60_000, last9, held: true, crmClientId: null, createdAtMs: null, ...o });
  const phones = new Set(["912345678"]);
  it("20 min antes → na janela; 90 min antes → fora da janela", () => {
    expect(matchCalls([call(-20)], R, phones, undefined, new Set())).toMatchObject({ reason: "na_janela", before60: true });
    expect(matchCalls([call(-90)], R, phones, undefined, new Set())).toMatchObject({ reason: "fora_da_janela", before60: false });
  });
  it("chamada 40 min depois do pendente (voo seguido) → pedido antes da chamada", () => {
    expect(matchCalls([call(40)], R, phones, undefined, new Set())).toMatchObject({ reason: "fora_da_janela", requestBeforeCall: true });
  });
  it("número partilhado por ≥ 3 reservas não conta; sem telefones; pela ficha do CRM", () => {
    const byBooking = new Map([["a", new Set(["912345678"])], ["b", new Set(["912345678"])], ["c", new Set(["912345678"])]]);
    const shared = sharedPhones(byBooking, ["a", "b", "c"]);
    expect([...shared]).toEqual(["912345678"]);
    expect(matchCalls([call(-10)], R, phones, undefined, shared).reason).toBe("partilhado");
    expect(matchCalls([call(-10)], R, undefined, undefined, new Set()).reason).toBe("sem_telefone");
    expect(matchCalls([call(-10, null, { crmClientId: 77 })], R, new Set(), new Set([77]), new Set()).reason).toBe("na_janela");
  });
});

// ─── As contas de um dia (e privacidade) ────────────────────────────────────

describe("computeProbeCity", () => {
  it("mede o que o §11.0 pede", () => {
    const r = computeProbeCity(cityInput());
    expect(r.n["entregas.entregues"]).toBe(1);
    expect(r.n["gps.cobertura.entregas.com_gps"]).toBe(1);
    expect(r.n["chamadas.entregas.na_janela"]).toBe(1);
    expect(r.n["chamadas.entregas.antes_60"]).toBe(1);
    expect(r.n["chamadas.recolhas.na_janela"]).toBe(1);
    expect(r.l["chamadas.recolhas.fonte"]).toEqual({ "WhatsApp perdida": 1 });
    expect(r.n["cheguei.deste_ciclo"]).toBe(1);
    expect(r.n["paragem.base"]).toBe(1);
    expect(r.n["paragem.v3_t120_r200.com"]).toBe(1);
    expect(histPercentile(r.h["paragem.v3_t120_r200.antes"], 0.5)?.value).toBeGreaterThanOrEqual(5);
    expect(r.n["recolhas.recebidas"]).toBe(1);
    expect(r.n["recolhas.com_em_recolha"]).toBe(1);
    expect(r.l["recolhas.sequencia"]).toEqual({ "em recolha → check-in → mov. início → mov. fim (arrumar) → mov. entre garagens": 1 });
    expect(r.l["posicao.CHECKING_IN"]).toEqual({ "no parque (≤ 500 m)": 1 });
    expect(r.l["garagens.destino"]).toEqual({ P2: 1, PD: 1 });
    expect(r.l["garagens.primeira"]).toEqual({ P2: 1 });
    expect(r.n["p2.na_tabela"]).toBe(1);
    expect(r.n["p2.nos_movimentos"]).toBe(1);
    expect(r.n["saida.base"]).toBe(1);
    expect(r.n["saida.v10_m300.com"]).toBe(1);
    expect(r.n["t2.recolhas"]).toBe(1);
    expect(r.n["t2.com_chegada"]).toBe(1);
    expect(r.l["quem.CHECK_IN.papel"]).toEqual({ DRIVER: 1 });
    expect(r.n["quem.CHECK_IN.outro_parque"]).toBe(1);
    expect(r.l["quem.CHECKING_IN.papel"]).toEqual({ LEADER: 1 });
    expect(r.l["ficheiros.passagem"]).toEqual({ final: 1, "provisória (sameday) sem ficheiro": 1 });
    // só as chamadas do dia contam nos totais da consola (juntar dias não repete chamadas)
    expect(r.n["chamadas.central.recebidas"]).toBe(2);
    expect(r.n["chamadas.central.sem_numero"]).toBe(1);
    expect(r.n["chamadas.whatsapp.recebidas"]).toBe(1);
    expect(histPercentile(r.h["chamadas.central.atraso_registo"], 0)?.value).toBe(1);
    expect(r.n["ficheiros.lidos"]).toBe(1);
    expect(r.s?.zones).toEqual([{ label: "T1", radiusM: 200 }, { label: "T2", radiusM: 200 }]);
    expect(r.s?.garages.map((g) => g.name)).toEqual(["P2", "PD"]);
  });

  it("cobertura: sem ficha, sem ficheiro, sistema e sem início", () => {
    const evs = dayEvents();
    evs[1] = { ...evs[1], uid: "system" }; // CHECKING_OUT por "system"
    const r = computeProbeCity(cityInput({ events: evs }));
    expect(r.n["gps.cobertura.entregas.agente_sistema"]).toBe(1);
    const r2 = computeProbeCity(cityInput({ resolveAgent: () => ({ kind: "sem_ficha" }) }));
    expect(r2.n["gps.cobertura.entregas.sem_ficha"]).toBe(1);
    const r3 = computeProbeCity(cityInput({ gps: new Map([[501, { status: "sem_ficheiro" as const, files: [] }]]) }));
    expect(r3.n["gps.cobertura.entregas.sem_ficheiro"]).toBe(1);
    const r4 = computeProbeCity(cityInput({ events: dayEvents().filter((e) => e.type !== "CHECKING_OUT") }));
    expect(r4.n["gps.cobertura.entregas.sem_inicio"]).toBe(1);
  });

  it("só o dia operacional: um ciclo de outro dia não entra", () => {
    const evs = dayEvents().map((e) => (e.bookingId === DEL ? { ...e, atMs: e.atMs - 24 * 3_600_000 } : e));
    const r = computeProbeCity(cityInput({ events: evs }));
    expect(r.n["entregas.entregues"]).toBeUndefined();
    expect(r.n["recolhas.recebidas"]).toBe(1);
  });

  it("privacidade: o resultado, o relatório, o texto e o log não têm ids, telefones, nomes nem coordenadas", () => {
    const r = computeProbeCity(cityInput());
    const merged = mergeSondaResults([r, computeProbeCity(cityInput())]);
    const report = buildSondaReport(merged, { lisbon: merged });
    const text = sondaReportText(merged, report, { cities: "Lisboa" });
    noSecrets(JSON.stringify(r));
    noSecrets(JSON.stringify(report));
    noSecrets(text);
    for (const line of sondaLogLines(merged)) noSecrets(line);
    expect(text).toContain("Intervalo entre pontos GPS");
    expect(text).toContain("fecha:");
  });
});

describe("relatório e log", () => {
  it("cada linha [sonda62 n/N] tem ≤ 2 KB e juntas trazem os agregados todos", () => {
    const r = computeProbeCity(cityInput());
    const lines = sondaLogLines(r);
    expect(lines.length).toBeGreaterThan(1);
    lines.forEach((l, i) => {
      expect(l.startsWith(`[sonda62 ${i + 1}/${lines.length}] {`)).toBe(true);
      expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(LOG_LINE_MAX_BYTES);
    });
    const keys = new Set(lines.flatMap((l) => Object.keys(JSON.parse(l.slice(l.indexOf("{"))))));
    for (const k of Object.keys(r.n)) expect(keys.has(`n.${k}`)).toBe(true);
    for (const k of Object.keys(r.h)) expect(keys.has(`h.${k}`)).toBe(true);
  });
  it("leitura rápida com os critérios do §11.0", () => {
    const rows = buildSondaReport(computeProbeCity(cityInput()))[0].rows;
    expect(rows.map((x) => x.label)).toEqual(expect.arrayContaining(["Intervalo entre pontos (entregas)", "Cobertura GPS das entregas", "Há uma garagem \"P2\"?"]));
    expect(rows.find((x) => x.label === "Cobertura GPS das entregas")?.hint).toContain("≥ 60 %");
  });
});

// ─── SQL só de leitura ──────────────────────────────────────────────────────

describe("SQL da Multipark", () => {
  it("todas as leituras passam a guarda de só leitura", () => {
    const all = [
      buildProbeParksSql(), buildProbeGaragesSql(), buildProbeClockSql(),
      buildProbeHistorySql({ parkIds: ["p1", "p2"], from: "2026-10-10 00:00:00", to: "2026-10-12 02:00:00", coreTo: "2026-10-11 08:00:00" }),
      buildProbeBookingsSql(["b1"]), buildProbeAgentsSql(["u1"]), buildProbeClientPhonesSql(["c1"]), buildProbeDriverPhonesSql(["b1"]),
    ];
    for (const q of all) {
      expect(q).not.toBeNull();
      expect(() => assertReadOnlySql(q!.sql)).not.toThrow();
    }
    expect(buildProbeBookingsSql([])).toBeNull();
  });
  it("a History: os tipos certos, só 3 chaves do snapshot e nunca o modifiedFields inteiro de um UPDATE", () => {
    const { sql, params } = buildProbeHistorySql({ parkIds: ["p1"], from: "a", to: "b", coreTo: "c" });
    for (const t of PROBE_HISTORY_TYPES) expect(sql).toContain(`'${t}'`);
    expect(sql).not.toMatch(/h\."snapshot"\s+AS/);
    expect(sql).toContain(`substring(h."modifiedFields" from`);
    expect((sql.match(/FROM "History"/g) ?? []).length).toBe(1);
    expect(params).toEqual(["p1", "a", "b", "c", 40000]);
  });
  it("mapeia uma linha (garagens do movimento; 0,0 = sem posição)", () => {
    const e = mapProbeHistoryRow({ id: "h1", booking_id: "b", ct: "MOVEMENT", at: "2026-10-10 08:45:00.250", uid: "u", lat: 0, lng: 0, has_snapshot: true, move_fields: `{"garageName":{"from":null,"to":"P2"},"spot":{"from":null,"to":"12"}}` });
    expect(e).toMatchObject({ type: "MOVEMENT", atMs: Date.parse("2026-10-10T08:45:00.250Z"), lat: null, moveKind: "arrumar", garageTo: "p2" });
    expect(movementGarages(`{"garageName":{"from":"P2","to":"PD"}}`)).toEqual({ from: "p2", to: "pd" });
    expect(mapProbeHistoryRow({ id: "h2", booking_id: "b", ct: "UPDATE", at: "2026-10-10 08:45:00", update_to: `"CHECKED_IN"` })?.updateStatusTo).toBe("CHECKED_IN");
  });
});

// ─── A corrida (dependências falsas) ────────────────────────────────────────

function fakeDeps(o: { historyFails?: boolean; slowGps?: boolean } = {}) {
  const sqls: string[] = [];
  const logs: string[] = [];
  const t0 = Date.now();
  const histRow = (e: ProbeEvent) => ({
    id: e.id, booking_id: e.bookingId, ct: e.type, at: new Date(e.atMs).toISOString().replace("T", " ").replace("Z", ""),
    uid: e.uid, agent_name: e.agentName, platform: e.platform, lat: e.lat, lng: e.lng, has_snapshot: true, snap_status: e.snapStatus,
    snap_arrived: e.snapArrivedMs ? new Date(e.snapArrivedMs).toISOString() : null, snap_baggage: null,
    move_fields: e.type === "MOVEMENT" ? (e.moveKind === "inicio" ? `{"status":{"from":"CHECKED_IN","to":"MOVING"}}` : `{"garageName":{"from":${e.garageFrom ? `"${e.garageFrom}"` : "null"},"to":"${e.garageTo}"}}`) : null,
    update_to: null,
  });
  const deps: ProbeDeps = {
    now: () => Date.parse("2026-10-14T10:00:00Z") + (Date.now() - t0),
    mpConfigured: () => true,
    mpQuery: async (sql) => {
      assertReadOnlySql(sql);
      sqls.push(sql);
      if (/FROM "History"/.test(sql)) {
        if (o.historyFails) throw new Error("canceling statement due to statement timeout");
        return dayEvents().map(histRow) as any;
      }
      if (/information_schema/.test(sql)) return [{ table_name: "Garage", column_name: "mapLink", data_type: "text" }, { table_name: "Park", column_name: "lat", data_type: "double precision" }, { table_name: "Park", column_name: "lng", data_type: "double precision" }] as any;
      if (/FROM "Park"/.test(sql)) return [{ id: "park-AIR-LIS-77", name: "Airpark Lisboa", city: "Lisboa", lat: PARK.lat, lng: PARK.lng }] as any;
      if (/FROM "Booking"/.test(sql)) return [{ id: DEL, park_id: "park-AIR-LIS-77", delivery_type: "Terminal 1", client_id: "cli-SECRET-9" }, { id: PIC, park_id: "park-AIR-LIS-77", delivery_type: "Terminal 2", client_id: "cli-SECRET-9" }] as any;
      if (/FROM "Agent"/.test(sql)) return [{ uid: "agent-uid-DRV1", park_id: "park-AIR-LIS-77", role: "DRIVER" }] as any;
      if (/FROM "Garage"/.test(sql)) return [{ name: "P2", parking_type: "UNCOVERED", park_id: "park-AIR-LIS-77", map_link: `https://www.google.com/maps/@${P2_GARAGE.lat},${P2_GARAGE.lng},17z` }] as any;
      if (/FROM "Client"/.test(sql)) return [{ id: "cli-SECRET-9", phone: "+351 912 345 678" }] as any;
      if (/FROM "Driver"/.test(sql)) return [{ booking_id: PIC, phone: "+351934567890" }] as any;
      if (/now\(\)/.test(sql)) return [{ now_utc: "2026-10-14 10:00:00.100" }] as any;
      return [];
    },
    settings: async () => ({ airports: { lisbon: AIRPORT, porto: AIRPORT, faro: AIRPORT } as any, centralSugarOn: true, excludedParkIds: [] }),
    calls: async () => cityInput().calls as ProbeCall[],
    crmPhones: async () => new Map([[DEL, { phones: ["+351912345678"], clientIds: [42] }]]),
    identity: async () => cityInput().resolveAgent,
    gpsSources: async (emps) => emps.map((e, i) => ({ id: 100 + i, day: DAY, geoJsonUrl: `https://bucket-privado/zello_joao_${e}.geojson`, split: false, rowEmployeeId: e, employeeIds: [e], zello: "zello_joao" })),
    gpsHolder: async () => () => null,
    fetchPoints: async () => (o.slowGps ? new Promise<PosPoint[]>(() => undefined) : drvPoints()),
    gpsRows: async () => [{ pass: "final", hasFile: true }],
    classifier: async () => (dt) => (/2/.test(String(dt)) ? "t2" : "t1"),
    parkClassify: async (rows) => rows.map((r) => ({ id: String(r.id), name: String(r.name), ours: true, city: "lisboa" })),
    operated: () => true,
    log: (l) => logs.push(l),
  };
  return { deps, sqls, logs };
}

describe("runTimesProbe", () => {
  it("corre um dia: UMA leitura da History, só SQL de leitura, só agregados na resposta e no log", async () => {
    const { deps, sqls, logs } = fakeDeps();
    const r = await runTimesProbe({ day: DAY, cities: ["lisbon"] }, deps);
    expect(r.failures).toEqual([]);
    expect(sqls.filter((s) => /FROM "History"/.test(s))).toHaveLength(1);
    expect(sqls.some((s) => /"History"[\s\S]*"bookingId" IN \(\$/.test(s))).toBe(false);
    const res = r.results.lisbon!;
    expect(res.n["entregas.entregues"]).toBe(1);
    expect(res.n["gps.cobertura.entregas.com_gps"]).toBe(1);
    expect(res.n["chamadas.entregas.na_janela"]).toBe(1);
    expect(res.n["ficheiros.lidos"]).toBe(1);
    expect(res.s?.pgClockOffsetMs).not.toBeNull();
    expect(res.s?.coordColumns).toEqual(["Garage.mapLink (text)", "Park.lat (double precision)", "Park.lng (double precision)"]);
    expect(res.s?.garages[0]).toMatchObject({ name: "P2", park: "Airpark Lisboa", coordSource: "link do mapa (mapLink)", lat: P2_GARAGE.lat, valid: true });
    noSecrets(JSON.stringify(r));
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) { expect(l.startsWith("[sonda62 ")).toBe(true); noSecrets(l); }
  });

  it("a Multipark falha → não lança: 'falhou: motivo' e o log na mesma", async () => {
    const { deps, logs } = fakeDeps({ historyFails: true });
    const r = await runTimesProbe({ day: DAY, cities: ["lisbon", "porto"] }, deps);
    expect(r.failures.join(" ")).toContain("falhou: History da Multipark");
    expect(r.results.lisbon?.failures.join(" ")).toContain("falhou");
    expect(r.results.porto).toBeTruthy();
    expect(logs.some((l) => l.includes("falhou"))).toBe(true);
  });

  it("dia que ainda não acabou, sem cidades ou sem BD → não lança", async () => {
    const { deps } = fakeDeps();
    expect((await runTimesProbe({ day: "2026-10-14", cities: ["lisbon"] }, deps)).failures[0]).toContain("ainda não acabou");
    expect((await runTimesProbe({ day: DAY, cities: [] }, deps)).failures[0]).toContain("nenhuma cidade");
    expect((await runTimesProbe({ day: DAY, cities: ["faro"] }, { ...deps, mpConfigured: () => false })).failures[0]).toContain("não está configurada");
    expect(probeDayError("2026-13-99x", Date.now())).toContain("inválido");
  });

  it("GPS lento: devolve dentro do prazo com 'truncated' e o ficheiro por ler", async () => {
    const { deps } = fakeDeps({ slowGps: true });
    const t = Date.now();
    const sources: ProbeGpsSource[] = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, day: DAY, geoJsonUrl: `https://x/${i}`, split: false, rowEmployeeId: i + 1, employeeIds: [i + 1], zello: `z${i}` }));
    const services = new Map(sources.map((s) => [s.rowEmployeeId!, 1]));
    const g = await loadProbeGps(services, sources, () => null, deps.fetchPoints, { now: () => Date.now(), deadlineAt: Date.now() + 250 });
    expect(Date.now() - t).toBeLessThan(2_000);
    expect(g.truncated).toBe(true);
    expect(g.read).toBe(0);
    expect(g.pending).toBe(200);
    expect([...g.byEmp.values()].every((e) => e.status === "por_ler")).toBe(true);
  });

  it("limite de 60 ficheiros: os das pessoas com mais serviços primeiro", async () => {
    const sources: ProbeGpsSource[] = Array.from({ length: 70 }, (_, i) => ({ id: i + 1, day: DAY, geoJsonUrl: `https://x/${i}`, split: false, rowEmployeeId: i + 1, employeeIds: [i + 1], zello: `z${i}` }));
    const services = new Map(sources.map((s) => [s.rowEmployeeId!, s.id <= 10 ? 1 : 10]));
    const g = await loadProbeGps(services, sources, () => null, async () => [], { now: () => Date.now(), deadlineAt: Date.now() + 5_000 });
    expect(g.read).toBe(60);
    expect(g.pending).toBe(10);
    expect(g.byEmp.get(70)?.status).toBe("ok");
    expect(g.byEmp.get(1)?.status).toBe("por_ler");
  });

  it("sem pontos com posição ou sem linhas: estados certos", async () => {
    const services = new Map([[1, 1], [2, 1], [3, 1]]);
    const sources: ProbeGpsSource[] = [{ id: 1, day: DAY, geoJsonUrl: null, split: false, rowEmployeeId: 1, employeeIds: [1], zello: "a" }];
    const g = await loadProbeGps(services, sources, () => null, async () => [], { now: () => Date.now(), deadlineAt: Date.now() + 1000 });
    expect(g.byEmp.get(1)?.status).toBe("sem_ficheiro");
    expect(g.byEmp.get(2)?.status).toBe("sem_linha");
  });
});
