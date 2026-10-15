import { describe, expect, it } from "vitest";
import {
  DEFAULT_GARAGE_ZONE_RADIUS_M, D_EXIT_MARGIN_M, G_GOOD_S, G_WEAK_S, R_SIGNATURE_M, T_CONFIRM_S, T_STOP_MIN_S, V_CAR_KMH, V_STOP_KMH, V_WALK_KMH, effectiveParkZones, kindOfGarageName,
  arrivalZoneFor, detectExit, detectStop, insideZone, lastZoneArrival, mapLinkCoords, mapLinkKind, median, p2TerminalConflicts, p2ZoneOf,
  parkZoneOverlaps, positionAt, startCoherence, terminalLabelOf, terminalZoneFor, unlabeledTerminalZones,
  type GpsFix, type ParkZonesMap, type Zone,
} from "../shared/serviceGps";
import type { AirportFence } from "../shared/pontoTerminal";

// Plano 62, P4 — GPS dos tempos (paragem, saída de uma zona, zonas).

const T = (hhmm: string) => Date.parse(`2026-10-12T${hhmm}:00Z`);
const MIN = 60_000;
/** Ponto a dx/dy metros de um centro. */
const at = (c: { lat: number; lng: number }, dxM: number, dyM = 0) => ({ lat: c.lat + dyM / 111_320, lng: c.lng + dxM / (111_320 * Math.cos((c.lat * Math.PI) / 180)) });
const T2: Zone = { label: "T2", lat: 38.769, lng: -9.129, radiusM: 200 };
const T1: Zone = { label: "T1", lat: 38.7742, lng: -9.1342, radiusM: 200 };
const PARK = at(T2, 3600, 0);
/** Ponto GPS em ms, a dx metros a este do centro da zona T2, a v km/h. */
const fix = (ms: number, dxM: number, speed: number, accurate = true, c: { lat: number; lng: number } = T2): GpsFix => {
  const p = at(c, dxM);
  return { ts: Math.round(ms / 1000), speed, lat: p.lat, lon: p.lng, accurate };
};
/** Trajeto do parque ao terminal: pontos a cada `stepS` segundos, a andar até `arriveMs`, depois parados no terminal. */
function trip(startMs: number, arriveMs: number, endMs: number, stepS: number): GpsFix[] {
  const out: GpsFix[] = [];
  for (let t = startMs - 60_000; t <= endMs; t += stepS * 1000) {
    if (t < arriveMs) {
      const frac = Math.max(0, (t - startMs) / (arriveMs - startMs));
      out.push(fix(t, 3600 * (1 - frac), 45));
    } else out.push(fix(t, 20, 0));
  }
  return out;
}
const S = T("16:10"), E = T("16:40");

describe("parâmetros fechados pela P0 (29 set–12 out 2026, PR dos parâmetros)", () => {
  it("paragem, intervalo e saída: os valores medidos", () => {
    // item 3: a melhor combinação é ≤ 7 km/h durante 60 s; o raio à volta da assinatura é indiferente (fica 150 m)
    expect([V_STOP_KMH, V_WALK_KMH, T_STOP_MIN_S, T_CONFIRM_S, R_SIGNATURE_M]).toEqual([3, 7, 60, 360, 150]);
    // item 1: p90 do intervalo dentro das entregas 26 s (≤ 6 min) → G_GOOD/G_WEAK como propostos
    expect([G_GOOD_S, G_WEAK_S]).toEqual([360, 900]);
    // item 11: 5/10/15 km/h e 150/300 m dão o mesmo
    expect([V_CAR_KMH, D_EXIT_MARGIN_M]).toEqual([10, 300]);
  });

  it("com pontos a cada 7 s (o p50 medido) a chegada fica ao segundo e sem precisão fraca", () => {
    const pts = trip(S, T("16:25"), E, 7);
    const r = detectStop({ points: pts, startAt: S, endAt: E, zone: T2, park: PARK });
    expect(r.kind).toBe("chegada");
    if (r.kind !== "chegada") return;
    expect(Math.abs(r.at - T("16:25"))).toBeLessThanOrEqual(7_000);
    expect(r.precisionS).toBeLessThanOrEqual(4);
    expect(r.flags).not.toContain("precisao_fraca");
  });
});

describe("detectStop — paragem no destino (§4.4)", () => {
  it("pontos de 30 s: chegada perto do instante real, precisão de segundos", () => {
    const r = detectStop({ points: trip(S, T("16:22"), E, 30), startAt: S, endAt: E, zone: T2, park: PARK });
    expect(r.kind).toBe("chegada");
    if (r.kind !== "chegada") return;
    expect(Math.abs(r.at - T("16:22"))).toBeLessThanOrEqual(30_000);
    expect(r.precisionS).toBeLessThanOrEqual(30);
  });

  it("pontos de 3 e 6 min: meio do intervalo, precisão ±g/2; 10 min → `precisao_fraca`; 16 min → `buraco_no_gps`", () => {
    for (const step of [180, 360]) {
      const r = detectStop({ points: trip(S, T("16:22"), E, step), startAt: S, endAt: E, zone: T2, park: PARK });
      expect(r.kind, String(step)).toBe("chegada");
      if (r.kind === "chegada") {
        expect(Math.abs(r.at - T("16:22"))).toBeLessThanOrEqual((step / 2) * 1000 + 1000);
        expect(r.flags).not.toContain("precisao_fraca");
      }
    }
    const ten = detectStop({ points: [fix(S - MIN, 3600, 0), fix(S + 10 * MIN, 3000, 50), fix(S + 20 * MIN, 10, 0), fix(S + 25 * MIN, 10, 0)], startAt: S, endAt: E, zone: T2, park: PARK });
    expect(ten).toMatchObject({ kind: "chegada", at: S + 15 * MIN });
    if (ten.kind === "chegada") expect(ten.flags).toContain("precisao_fraca");
    const hole = detectStop({ points: [fix(S - MIN, 3600, 0), fix(S + MIN, 3500, 50), fix(S + MIN + 16 * MIN, 10, 0), fix(S + 25 * MIN, 10, 0)], startAt: S, endAt: E, zone: T2, park: PARK });
    expect(hole).toMatchObject({ kind: "sem_chegada", status: "buraco_no_gps" });
    // dois pontos parados na zona com 10 min entre eles e a assinatura 25 min depois do último → chegou (precisão fraca), não "sem paragem"
    const tenStay = detectStop({ points: [fix(S - MIN, 3600, 0), fix(S + 5 * MIN, 1800, 50), fix(S + 10 * MIN, 10, 0), fix(S + 20 * MIN, 10, 0)], startAt: S, endAt: S + 45 * MIN, zone: T2, park: PARK });
    expect(tenStay).toMatchObject({ kind: "chegada", at: S + 7.5 * MIN });
    // um só ponto devagar na zona e o seguinte, 10 min depois, fora a andar → passou (não chegou)
    const pass = detectStop({ points: [fix(S - MIN, 3600, 0), fix(S + 5 * MIN, 1800, 50), fix(S + 10 * MIN, 10, 5), fix(S + 20 * MIN, 2500, 50), fix(S + 30 * MIN, 5000, 50)], startAt: S, endAt: S + 45 * MIN, zone: T2, park: PARK });
    expect(pass).toMatchObject({ kind: "sem_chegada", status: "sem_paragem" });
    // espaçados (8 min) e já parados na zona: a chegada conta desde o 1.º ponto parado (não do último)
    const sparse = detectStop({ points: [fix(S - MIN, 3600, 0), fix(S + 4 * MIN, 2000, 50), fix(S + 12 * MIN, 10, 0), fix(S + 20 * MIN, 10, 0)], startAt: S, endAt: E, zone: T2, park: PARK });
    expect(sparse).toMatchObject({ kind: "chegada", at: S + 8 * MIN, precisionS: 240 });
    expect(G_GOOD_S).toBe(360);
    expect(G_WEAK_S).toBe(900);
  });

  it("a pé a sair da zona: dentro devagar e o ponto seguinte fora, a pé → chegou", () => {
    const pts = [fix(S - MIN, 3600, 0), fix(S + 5 * MIN, 1500, 50), fix(S + 10 * MIN, 400, 40), fix(S + 11 * MIN, 150, 5), fix(S + 12 * MIN, 260, 4)];
    const r = detectStop({ points: pts, startAt: S, endAt: E, zone: T2, park: PARK });
    expect(r).toMatchObject({ kind: "chegada", at: S + 10.5 * MIN });
    if (r.kind === "chegada") expect(r.flags).toContain("chegada_a_pe");
  });

  it("passa pela zona a andar (ou pelo T1 a caminho do T2) não conta; fila de trânsito dentro da zona conta", () => {
    // pelo T1 a caminho do T2: os pontos no T1 não estão na zona T2
    const viaT1 = [fix(S - MIN, 3600, 0), fix(S + 5 * MIN, 0, 3, true, T1), fix(S + 6 * MIN, 0, 2, true, T1), fix(S + 10 * MIN, 400, 30), fix(S + 11 * MIN, 30, 0), fix(S + 12 * MIN, 30, 0)];
    expect(detectStop({ points: viaT1, startAt: S, endAt: E, zone: T2, park: PARK })).toMatchObject({ kind: "chegada", at: S + 10.5 * MIN });
    // atravessa a zona T2 a andar e sai a andar → sem paragem
    const through = [fix(S - MIN, 3600, 0), fix(S + 5 * MIN, 1500, 50), fix(S + 8 * MIN, 0, 30), fix(S + 9 * MIN, -900, 50), fix(S + 15 * MIN, -3000, 60)];
    expect(detectStop({ points: through, startAt: S, endAt: E, zone: T2, park: PARK })).toMatchObject({ kind: "sem_chegada", status: "sem_paragem" });
    // fila de trânsito dentro da zona (devagar, ainda a mexer) → chegou (de propósito)
    const queue = [fix(S - MIN, 3600, 0), fix(S + 5 * MIN, 1500, 50), fix(S + 9 * MIN, 190, 6), fix(S + 10 * MIN, 120, 5), fix(S + 11 * MIN, 60, 4)];
    expect(detectStop({ points: queue, startAt: S, endAt: E, zone: T2, park: PARK }).kind).toBe("chegada");
  });

  it("o último ponto antes da assinatura (sem mais pontos, a ≤ 20 min dela) conta", () => {
    const pts = [fix(S - MIN, 3600, 0), fix(S + 6 * MIN, 1500, 50), fix(S + 12 * MIN, 30, 0)];
    expect(detectStop({ points: pts, startAt: S, endAt: E, zone: T2, park: PARK })).toMatchObject({ kind: "chegada", at: S + 9 * MIN });
    const far = [fix(S - MIN, 3600, 0), fix(T("15:00") + 20 * MIN, 1500, 50), fix(T("15:00") + 22 * MIN, 30, 0)];
    expect(detectStop({ points: far, startAt: T("15:00"), endAt: E, zone: T2, park: PARK }).kind).toBe("sem_chegada");
  });

  it("ponto impreciso à beira da zona não conta", () => {
    const pts = [fix(S - MIN, 3600, 0), fix(S + 5 * MIN, 1500, 50), fix(S + 8 * MIN, 150, 0, false), fix(S + 9 * MIN, 150, 0, false), fix(S + 14 * MIN, 1200, 45), fix(S + 20 * MIN, 2500, 50)];
    expect(detectStop({ points: pts, startAt: S, endAt: E, zone: T2, park: PARK })).toMatchObject({ kind: "sem_chegada", status: "sem_paragem" });
  });

  it("parque perto do aeroporto: último ponto ≤ S no parque e o 1.º depois de S já na zona → chegada (A ≥ S), não início no terminal", () => {
    const nearPark = at(T2, 900);
    const pts = [{ ...fix(S - 2 * MIN, 0, 0), lat: nearPark.lat, lon: nearPark.lng }, fix(S + 4 * MIN, 50, 0), fix(S + 5 * MIN, 50, 0)];
    const r = detectStop({ points: pts, startAt: S, endAt: E, zone: T2, park: nearPark });
    expect(r.kind).toBe("chegada");
    if (r.kind === "chegada") expect(r.at).toBeGreaterThanOrEqual(S);
  });

  it("último ponto ≤ S já na zona → `inicio_no_terminal`; sem GPS antes de S, a linha \"em entrega\" no terminal (longe do parque)", () => {
    const pts = [fix(S - 2 * MIN, 30, 0), fix(S + 5 * MIN, 30, 0)];
    expect(detectStop({ points: pts, startAt: S, endAt: E, zone: T2, park: PARK }).kind).toBe("inicio_no_terminal");
    const after = [fix(S + 5 * MIN, 30, 0), fix(S + 6 * MIN, 30, 0)];
    expect(detectStop({ points: after, startAt: S, endAt: E, zone: T2, park: PARK, startRow: at(T2, 10) }).kind).toBe("inicio_no_terminal");
    expect(detectStop({ points: after, startAt: S, endAt: E, zone: T2, park: at(T2, 400), startRow: at(T2, 10) }).kind).not.toBe("inicio_no_terminal");
  });

  it("coerência: posição no início a > 1 km do parque e da linha → `gps_nao_bate`; nunca se afasta 500 m → `gps_parado`; sem pontos → `sem_pontos`", () => {
    const wrong = [fix(S - MIN, 9000, 0), fix(S + 5 * MIN, 9000, 0), fix(S + 10 * MIN, 9100, 30)];
    expect(detectStop({ points: wrong, startAt: S, endAt: E, zone: T2, park: PARK, startRow: PARK })).toMatchObject({ kind: "sem_chegada", status: "gps_nao_bate" });
    const stuck = [fix(S - MIN, 3600, 0), fix(S + 10 * MIN, 3650, 0), fix(S + 20 * MIN, 3600, 0)];
    expect(detectStop({ points: stuck, startAt: S, endAt: E, zone: T2, park: at(T2, 3600) })).toMatchObject({ kind: "sem_chegada", status: "gps_parado" });
    expect(detectStop({ points: [fix(S - 30 * MIN, 0, 0)], startAt: S, endAt: E, zone: T2 })).toMatchObject({ kind: "sem_chegada", status: "sem_pontos" });
    expect(startCoherence(at(T2, 3600, 100), PARK, null)).toBe("ok");
    expect(startCoherence(at(T2, 3600, 800), PARK, null)).toBe("duvidosa");
  });

  it("coerência com pontos espaçados: o ponto mais perto de S é de 4 min depois, já a 3 km (o carro a andar) → não é `gps_nao_bate`; a 15 km logo a seguir a S → é", () => {
    // sem ponto até 6 min antes de S; o 1.º depois de S, 4 min depois, já a meio caminho
    const moving = [fix(S + 4 * MIN, 600, 50), fix(S + 7 * MIN, 150, 30), fix(S + 9 * MIN, 20, 0), fix(S + 12 * MIN, 20, 0)];
    expect(detectStop({ points: moving, startAt: S, endAt: E, zone: T2, park: PARK, startRow: PARK })).toMatchObject({ kind: "chegada" });
    const far = [fix(S + 30_000, 18_000, 0), fix(S + 5 * MIN, 18_000, 0), fix(S + 10 * MIN, 18_100, 30)];
    expect(detectStop({ points: far, startAt: S, endAt: E, zone: T2, park: PARK, startRow: PARK })).toMatchObject({ kind: "sem_chegada", status: "gps_nao_bate" });
    expect(startCoherence(at(T2, 3600, 1500), PARK, null, 240 * 15)).toBe("ok");
  });

  it("chegada já depois da assinatura (> 60 s) → `chegada_depois_da_assinatura`; até 60 s → a própria assinatura", () => {
    const late = [fix(S - MIN, 3600, 0), fix(S + 20 * MIN, 1500, 50), fix(E + 70_000, 400, 40), fix(E + 90_000, 30, 0), fix(E + 100_000, 30, 0)];
    expect(detectStop({ points: late, startAt: S, endAt: E, zone: T2, park: PARK })).toMatchObject({ kind: "sem_chegada", status: "chegada_depois_da_assinatura" });
    const just = [fix(S - MIN, 3600, 0), fix(E - 10_000, 1500, 50), fix(E + 40_000, 30, 0), fix(E + 50_000, 30, 0)];
    const r = detectStop({ points: just, startAt: S, endAt: E, zone: T2, park: PARK });
    expect(r).toMatchObject({ kind: "chegada", at: E });
    if (r.kind === "chegada") expect(r.flags).toContain("chegada_ajustada");
  });

  it("o parque dentro da zona de chegada → `destino_ambiguo`", () => {
    const pts = [fix(S - MIN, 3600, 0), fix(S + 5 * MIN, 1500, 50), fix(S + 10 * MIN, 30, 0), fix(S + 11 * MIN, 30, 0)];
    expect(detectStop({ points: pts, startAt: S, endAt: E, zone: { ...T2, radiusM: 5000 }, park: PARK })).toMatchObject({ kind: "sem_chegada" });
    expect(V_WALK_KMH).toBe(7);
  });
});

describe("arrivalZoneFor — zona de chegada (§4.3)", () => {
  const lisbon: AirportFence = { lat: 38.7742, lng: -9.1342, radiusM: 1500, zones: [T1, T2] };
  const sig = at(T2, 2000);

  it("T1/T2 pelo rótulo; VIP e sem tipo usam a T1", () => {
    expect(arrivalZoneFor({ terminalClass: "t2", airport: lisbon, signature: sig })).toMatchObject({ kind: "zona", source: "gps_zona", zone: { label: "T2" } });
    for (const cls of ["t1", "vip", "unknown"] as const) expect(arrivalZoneFor({ terminalClass: cls, airport: lisbon, signature: sig })).toMatchObject({ zone: { label: "T1" } });
    expect(terminalLabelOf("Terminal 2")).toBe("t2");
    expect(terminalLabelOf("chegadas")).toBeNull();
  });

  it("Porto com uma zona sem rótulo → serve à classe T1; Lisboa com zonas sem rótulo não adivinha (ponto da assinatura)", () => {
    const porto: AirportFence = { lat: 41.2481, lng: -8.6814, radiusM: 1500, zones: [{ lat: 41.2485, lng: -8.68, radiusM: 200 }] };
    expect(arrivalZoneFor({ terminalClass: "t1", airport: porto, signature: null })).toMatchObject({ kind: "zona", source: "gps_zona" });
    expect(terminalZoneFor(porto, "t1")).not.toBeNull();
    expect(terminalZoneFor(porto, "t2")).toBeNull();
    const noLabels: AirportFence = { ...lisbon, zones: [{ lat: T1.lat, lng: T1.lng, radiusM: 200 }, { lat: T2.lat, lng: T2.lng, radiusM: 200 }] };
    expect(arrivalZoneFor({ terminalClass: "t2", airport: noLabels, signature: sig })).toMatchObject({ source: "gps_ponto_assinatura", zone: { radiusM: R_SIGNATURE_M } });
    expect(terminalZoneFor(noLabels, "t2")).toBeNull();
  });

  it("classe \"Outro\" (Oriente) sem ponto da assinatura → `sem_destino`, nunca o círculo do aeroporto", () => {
    expect(arrivalZoneFor({ terminalClass: "other", airport: lisbon, signature: null })).toEqual({ kind: "sem_zona", status: "sem_destino" });
    expect(arrivalZoneFor({ terminalClass: "other", airport: lisbon, signature: sig })).toMatchObject({ source: "gps_ponto_assinatura" });
  });

  it("sem zonas: círculo do aeroporto (`precisao_fraca`), ou `destino_ambiguo` com um parque lá dentro", () => {
    const circle: AirportFence = { lat: 38.7742, lng: -9.1342, radiusM: 1500 };
    expect(arrivalZoneFor({ terminalClass: "t1", airport: circle, signature: null, parks: [PARK] })).toMatchObject({ source: "gps_aeroporto", flags: ["precisao_fraca"] });
    expect(arrivalZoneFor({ terminalClass: "t1", airport: circle, signature: null, parks: [at(circle, 500)] })).toEqual({ kind: "sem_zona", status: "destino_ambiguo" });
    expect(arrivalZoneFor({ terminalClass: "t1", airport: null, signature: null })).toEqual({ kind: "sem_zona", status: "sem_destino" });
  });
});

describe("detectExit — saída de uma zona (§4.5)", () => {
  const I = T("07:20");
  it("sai a 40 km/h: meio entre o último ponto dentro e o 1.º fora de carro (confirmado pelo seguinte)", () => {
    const pts = [fix(I - MIN, 20, 0), fix(I + 2 * MIN, 30, 0), fix(I + 6 * MIN, 50, 3), fix(I + 8 * MIN, 600, 40), fix(I + 9 * MIN, 1500, 50)];
    expect(detectExit({ points: pts, fromAt: I, zone: T2 })).toMatchObject({ kind: "saida", at: I + 7 * MIN, precisionS: 60 });
  });

  it("sai a pé e volta não é saída; a saída de carro a seguir conta", () => {
    const pts = [fix(I, 20, 0), fix(I + 2 * MIN, 260, 5), fix(I + 4 * MIN, 30, 2), fix(I + 10 * MIN, 40, 0), fix(I + 12 * MIN, 700, 35), fix(I + 13 * MIN, 1600, 45)];
    expect(detectExit({ points: pts, fromAt: I, zone: T2 })).toMatchObject({ kind: "saida", at: I + 11 * MIN });
  });

  it("sem pontos dentro, mas o check-in foi na zona → conta desde o check-in", () => {
    const pts = [fix(I + 8 * MIN, 800, 40), fix(I + 9 * MIN, 1600, 50)];
    expect(detectExit({ points: pts, fromAt: I, zone: T2, startPos: at(T2, 10) })).toMatchObject({ kind: "saida", at: I + 4 * MIN, precisionS: 240 });
    expect(detectExit({ points: pts, fromAt: I, zone: T2 })).toMatchObject({ kind: "sem_saida", status: "nunca_na_zona" });
  });

  it("buraco no GPS (> 15 min entre o último dentro e o 1.º fora) → `buraco_no_gps`; sem pontos → `sem_pontos`; sem sair → `sem_saida`", () => {
    const pts = [fix(I, 20, 0), fix(I + 20 * MIN, 1500, 50), fix(I + 21 * MIN, 2500, 50)];
    expect(detectExit({ points: pts, fromAt: I, zone: T2 })).toMatchObject({ kind: "sem_saida", status: "buraco_no_gps" });
    expect(detectExit({ points: [], fromAt: I, zone: T2 })).toMatchObject({ status: "sem_pontos" });
    expect(detectExit({ points: [fix(I, 20, 0), fix(I + 5 * MIN, 30, 0)], fromAt: I, zone: T2 })).toMatchObject({ status: "sem_saida" });
  });

  it("saída do parque (\"em entrega\" no terminal): só entre o pedido e S", () => {
    const parkZone: Zone = { label: "parque", lat: PARK.lat, lng: PARK.lng, radiusM: 300 };
    const pts = [fix(S - 20 * MIN, 0, 0, true, PARK), fix(S - 15 * MIN, 0, 0, true, PARK), fix(S - 13 * MIN, 900, 40, true, PARK), fix(S - 12 * MIN, 2000, 50, true, PARK)];
    expect(detectExit({ points: pts, fromAt: S - 20 * MIN, untilAt: S, zone: parkZone })).toMatchObject({ kind: "saida", at: S - 14 * MIN });
  });
});

describe("T2: última chegada à zona antes do check-in (§3.4)", () => {
  const K0 = T("07:00"), I = T("07:20");
  it("já lá antes da chamada → a tempo; saiu e voltou → a última chegada; último ponto fora → `sem_paragem`", () => {
    const there = [fix(K0 - 20 * MIN, 30, 0), fix(K0, 30, 0), fix(I - MIN, 20, 0)];
    expect(lastZoneArrival({ points: there, fromAt: K0 - 30 * MIN, untilAt: I, zone: T2 })).toEqual({ kind: "chegada", at: K0 - 20 * MIN, alreadyThere: true });
    const back = [fix(K0 - 20 * MIN, 30, 0), fix(K0 + 2 * MIN, 1500, 50), fix(K0 + 10 * MIN, 600, 40), fix(K0 + 12 * MIN, 30, 0), fix(I - MIN, 30, 0)];
    expect(lastZoneArrival({ points: back, fromAt: K0 - 30 * MIN, untilAt: I, zone: T2 })).toEqual({ kind: "chegada", at: K0 + 11 * MIN, alreadyThere: false });
    expect(lastZoneArrival({ points: [fix(K0, 30, 0), fix(I - MIN, 2000, 40)], fromAt: K0 - 30 * MIN, untilAt: I, zone: T2 })).toEqual({ kind: "sem_chegada", status: "sem_paragem" });
    expect(lastZoneArrival({ points: [], fromAt: K0, untilAt: I, zone: T2 })).toEqual({ kind: "sem_chegada", status: "sem_pontos" });
  });
});

describe("zonas da operação (P5: operations.parkZones)", () => {
  const airports = { lisbon: { lat: 38.7742, lng: -9.1342, radiusM: 1500, zones: [T1, T2] } };
  const zones = (lat: number, lng: number): ParkZonesMap => ({
    lisbon: [{ label: "P2", kind: "p2", lat, lng, radiusM: 150, garages: ["P2"] }, { label: "PD", kind: "pd", lat: lat + 0.001, lng, radiusM: 200, garages: ["PD"] }],
    porto: [], faro: [],
  });
  it("P2 que toca numa zona do terminal → conflito (recusado ao gravar); longe → nada", () => {
    const near = at(T1, 300);
    expect(p2TerminalConflicts(zones(near.lat, near.lng), airports)).toEqual([{ city: "lisbon", p2: "P2", terminal: "T1", distanceM: 300 }]);
    const far = at(T1, 2000);
    expect(p2TerminalConflicts(zones(far.lat, far.lng), airports)).toEqual([]);
    expect(p2ZoneOf(zones(far.lat, far.lng), "lisbon")?.label).toBe("P2");
    expect(p2ZoneOf(zones(far.lat, far.lng), "porto")).toBeNull();
  });

  it("zonas de tipos diferentes que se tocam → aviso; zonas do terminal sem rótulo T1/T2 → aviso", () => {
    const far = at(T1, 2000);
    expect(parkZoneOverlaps(zones(far.lat, far.lng))).toEqual([{ city: "lisbon", a: "P2", b: "PD" }]);
    expect(unlabeledTerminalZones({ lisbon: { ...airports.lisbon, zones: [T1, { lat: 1, lng: 2, radiusM: 100, label: "Chegadas" }] } })).toEqual([{ city: "lisbon", index: 1, label: "Chegadas" }]);
  });

  it("links reais do Google Maps: o pino (!3d!4d) antes do centro do ecrã (@); q=, query=, ll=, /place/, /search/, embed, geo:", () => {
    // "/place/…/@centro do ecrã…/data=…!3d<pino>!4d<pino>": vale o pino (o @ pode estar a centenas de metros)
    expect(mapLinkCoords("https://www.google.com/maps/place/Multipark+P2/@38.7801,-9.1250,17z/data=!3m1!4b1!4m6!3m5!1s0xd1932b5:0x9a!8m2!3d38.7812345!4d-9.1234567!16s%2Fg%2F11")).toEqual({ lat: 38.7812345, lng: -9.1234567 });
    // sítio com graus/minutos no nome do lugar: o pino na mesma
    expect(mapLinkCoords("https://www.google.com/maps/place/38%C2%B046'52.4%22N+9%C2%B007'24.4%22W/@38.7812,-9.1235,17z/data=!4m4!3m3!8m2!3d38.781222!4d-9.123444")).toEqual({ lat: 38.781222, lng: -9.123444 });
    expect(mapLinkCoords("https://www.google.com/maps/@38.7712,-9.1301,17z")).toEqual({ lat: 38.7712, lng: -9.1301 });
    expect(mapLinkCoords("https://maps.google.com/?q=38.77,-9.13")).toEqual({ lat: 38.77, lng: -9.13 });
    expect(mapLinkCoords("https://www.google.com/maps?q=loc:38.77%2C-9.13&z=17")).toEqual({ lat: 38.77, lng: -9.13 });
    expect(mapLinkCoords("https://www.google.com/maps/search/?api=1&query=38.7712,+-9.1301")).toEqual({ lat: 38.7712, lng: -9.1301 });
    expect(mapLinkCoords("https://www.google.com/maps/search/38.7712,+-9.1301?entry=ttu")).toEqual({ lat: 38.7712, lng: -9.1301 });
    expect(mapLinkCoords("https://www.google.com/maps/place/38.7712,-9.1301")).toEqual({ lat: 38.7712, lng: -9.1301 });
    expect(mapLinkCoords("https://www.google.com/maps/dir/?api=1&destination=41.2481,-8.6814")).toEqual({ lat: 41.2481, lng: -8.6814 });
    expect(mapLinkCoords("https://maps.apple.com/?ll=37.0144,-7.9659&q=Faro")).toEqual({ lat: 37.0144, lng: -7.9659 });
    // incorporar (iframe): !2d<lng>!3d<lat>
    expect(mapLinkCoords("https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3111.2!2d-9.1301!3d38.7712!2m3!1f0!2f0!3f0")).toEqual({ lat: 38.7712, lng: -9.1301 });
    expect(mapLinkCoords("geo:38.7712,-9.1301?z=17")).toEqual({ lat: 38.7712, lng: -9.1301 });
    // só o nome do sítio, link curto, lixo, 0,0
    expect(mapLinkCoords("https://www.google.com/maps/place/Multipark+Lisboa")).toBeNull();
    expect(mapLinkCoords("https://maps.app.goo.gl/AbCdEf123")).toBeNull();
    expect(mapLinkCoords("https://www.google.com/maps/@0,0,3z")).toBeNull();
    expect(mapLinkCoords(null)).toBeNull();
    // que link é (o editor diz o que fazer): os curtos não se abrem no servidor
    expect(mapLinkKind("https://maps.app.goo.gl/AbCdEf123")).toBe("curto");
    expect(mapLinkKind("https://goo.gl/maps/AbCdEf")).toBe("curto");
    expect(mapLinkKind("https://www.google.com/maps/place/Multipark+Lisboa")).toBe("sem_coordenadas");
    expect(mapLinkKind(" ")).toBe("sem_link");
    expect(mapLinkKind("https://www.google.com/maps/@38.77,-9.13,17z")).toBe("coordenadas");
  });

  it("\"Sugerir\": coordenadas do link do mapa e mediana", () => {
    expect(mapLinkCoords("https://www.google.com/maps/place/x/@38.7712,-9.1301,17z")).toEqual({ lat: 38.7712, lng: -9.1301 });
    expect(mapLinkCoords("https://maps.google.com/?q=38.77,-9.13")).toEqual({ lat: 38.77, lng: -9.13 });
    expect(mapLinkCoords("https://maps.app.goo.gl/abc")).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("dentro = distância ≤ raio, só pontos precisos; posição no início = o último ponto até 6 min antes", () => {
    expect(insideZone(fix(0, 199, 0), T2)).toBe(true);
    expect(insideZone(fix(0, 201, 0), T2)).toBe(false);
    expect(insideZone(fix(0, 10, 0, false), T2)).toBe(false);
    const pts = [fix(S - 10 * MIN, 0, 0), fix(S - 3 * MIN, 50, 0), fix(S + MIN, 60, 0)];
    expect(positionAt(pts, S)?.ts).toBe(Math.round((S - 3 * MIN) / 1000));
    expect(positionAt([fix(S - 10 * MIN, 0, 0)], S)).toBeNull();
  });
});

describe("Q6 — zonas a partir das garagens da Multipark, com exceções", () => {
  const g = (garage: string, lat: number | null, lng: number | null, city: "lisbon" | "porto" | "faro" = "lisbon") => ({ garage, city, lat, lng });
  it("garagem com coordenadas → zona com o raio de omissão do tipo; sem coordenadas → fica de fora (a não ser com exceção)", () => {
    const r = effectiveParkZones([g("P2", 38.77, -9.12), g("CENTRAL", 38.78, -9.11), g("PD", null, null), g("PD", 41.2, -8.6, "porto")], null);
    expect(r.zones.lisbon.map((z) => [z.label, z.kind, z.radiusM, z.source])).toEqual([["P2", "p2", DEFAULT_GARAGE_ZONE_RADIUS_M.p2, "multipark"], ["CENTRAL", "central", 200, "multipark"]]);
    expect(r.zones.porto).toHaveLength(1);
    expect(r.withoutCoords).toEqual([{ city: "lisbon", garage: "PD" }]);
    // link curto: fica sem zona, e o porquê segue para o editor
    expect(effectiveParkZones([{ garage: "P2", city: "lisbon", lat: null, lng: null, link: "curto" }], null).withoutCoords).toEqual([{ city: "lisbon", garage: "P2", link: "curto" }]);
  });

  it("exceções: só o raio, corrigir o centro, dar o centro a uma garagem sem coordenadas, zona só daqui; exceção sem centro e sem garagem → fora", () => {
    const r = effectiveParkZones([g("P2", 38.77, -9.12), g("PD", null, null)], {
      lisbon: [{ label: "p2", radiusM: 300 }, { label: "PD", lat: 38.79, lng: -9.1 }, { label: "Coberto novo", kind: "coberto", lat: 38.8, lng: -9.09, garages: ["COBERTO"] }, { label: "Fantasma" }],
      porto: [], faro: [],
    });
    expect(r.zones.lisbon.find((z) => z.label === "p2")).toMatchObject({ lat: 38.77, radiusM: 300, kind: "p2", source: "multipark_ajustada", garages: ["P2"] });
    expect(r.zones.lisbon.find((z) => z.label === "PD")).toMatchObject({ lat: 38.79, kind: "pd", source: "multipark_ajustada" });
    expect(r.zones.lisbon.find((z) => z.label === "Coberto novo")).toMatchObject({ source: "manual", garages: ["COBERTO"], radiusM: 150 });
    expect(r.withoutCoords).toEqual([{ city: "lisbon", garage: "Fantasma" }]);
    expect(kindOfGarageName("PD FORA")).toBe("pd");
    expect(kindOfGarageName("Central Coberto")).toBe("central");
    expect(kindOfGarageName("Indoor")).toBe("coberto");
  });

  it("o P2 vindo da Multipark que toque no terminal também é apanhado (a recusa vê as zonas em vigor)", () => {
    const near = at(T1, 250);
    const eff = effectiveParkZones([g("P2", near.lat, near.lng)], null).zones;
    expect(p2TerminalConflicts(eff, { lisbon: { lat: T1.lat, lng: T1.lng, radiusM: 1500, zones: [T1] } })).toHaveLength(1);
  });
});
