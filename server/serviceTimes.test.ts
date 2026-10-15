import { describe, expect, it } from "vitest";
import {
  CALL_WINDOW_AFTER_MIN, CALL_WINDOW_BEFORE_MIN, DEFAULT_GARAGE_ROLES, DEFAULT_GPS_GATE, DEFAULT_PICKUP_T2_TARGET_MINUTES, DEFAULT_SERVICE_TARGET_MINUTES, DISPATCH_MIN_MINUTES,
  DRIVER_METRICS, DRIVER_STATS_MIN_N, LATE_PICKUP_MARK_MIN, PICKUP_TRACK_MAX_HOURS, SERVICE_TIMES_CALC_VERSION,
  driverPeriodRange, driverTimeSeries, driverTimeStats, type DriverRowLike,
  agentRoleIn, appTerminalExit, buildDeliveryCycles, buildPickupCycles, buttonCoherent, crmIdOfContactRef, deliveryTimes,
  dispatchStartIds, driverBlockOf, garageRoleOf, gpsTimesVisible, matchCallToBooking, movementGarages, pickupTimes,
  resolveArrival, serviceEventOf, serviceParamsHash, sharedPhonesByDay, statusChangeOf, withinTarget, zelloHolderAt, zelloOfAt,
  type ArrivalResolution, type CallRecord, type DeliveryCycle, type ServiceEvent,
} from "../shared/serviceTimes";

// Plano 62, P3 — motor puro dos tempos de entrega e de recolha.

const T = (hhmm: string, day = "2026-10-12") => Date.parse(`${day}T${hhmm}:00Z`);
const MIN = 60_000;
let seq = 0;
function ev(type: string, at: number, extra: Partial<ServiceEvent> = {}): ServiceEvent {
  seq++;
  return { id: extra.id ?? `h${String(seq).padStart(4, "0")}`, bookingId: extra.bookingId ?? "b1", type, at, agentUserId: "u-cond", agentName: "Condutor", platform: "MOBILE", lat: null, lng: null, ...extra };
}
const move = (at: number, kind: ServiceEvent["moveKind"], garageTo: string | null, garageFrom: string | null = null, extra: Partial<ServiceEvent> = {}) =>
  ev("MOVEMENT", at, { moveKind: kind, garageTo, garageFrom, ...extra });
const arrived = (at: number, source: any = "gps_zona"): ArrivalResolution =>
  ({ kind: "medido", at, source, precisionS: 30, flags: [], buttonGapS: null });
const noArrival = (status: any): ArrivalResolution => ({ kind: "sem_medicao", status, flags: [] });
const call = (at: number, extra: Partial<CallRecord> = {}): CallRecord => ({ at, source: "central", held: true, phone9: "912345678", crmClientId: null, ...extra });
const one = (events: ServiceEvent[]): DeliveryCycle => {
  const r = buildDeliveryCycles(events);
  expect(r.cycles).toHaveLength(1);
  return r.cycles[0];
};

describe("linhas da History → eventos", () => {
  it("estado de/para de um UPDATE (ordem das chaves indiferente) e garagens de um MOVEMENT", () => {
    expect(statusChangeOf('{"status":{"from":"CHECKED_OUT","to":"CHECKED_IN"}}')).toEqual({ from: "CHECKED_OUT", to: "CHECKED_IN" });
    expect(statusChangeOf('{"status":{"to":"booked","from":"checking_in"}}')).toEqual({ from: "CHECKING_IN", to: "BOOKED" });
    expect(statusChangeOf('{"price":{"from":1,"to":2}}')).toEqual({ from: null, to: null });
    expect(movementGarages('{"garageName":{"from":"P2","to":"CENTRAL COBERTO"},"spot":{"from":"1","to":"9"}}')).toEqual({ from: "P2", to: "CENTRAL COBERTO" });
    expect(movementGarages('{"garageName":{"from":null,"to":"PD"}}')).toEqual({ from: null, to: "PD" });
  });

  it("serviceEventOf: tipo em maiúsculas, MOVEMENT classificado, UPDATE com o estado (ou o snapshot, se a linha mexeu no estado)", () => {
    const m = serviceEventOf({ id: "1", bookingId: "b", changeType: "movement", at: 1, modifiedFields: '{"garageName":{"from":"PD","to":"COBERTO"}}' });
    expect(m).toMatchObject({ type: "MOVEMENT", moveKind: "parques", garageFrom: "PD", garageTo: "COBERTO" });
    const u = serviceEventOf({ id: "2", bookingId: "b", changeType: "UPDATE", at: 1, modifiedFields: '{"status":"x"}', snapStatus: "checked_in" });
    expect(u.statusTo).toBe("CHECKED_IN");
    const u2 = serviceEventOf({ id: "3", bookingId: "b", changeType: "UPDATE", at: 1, modifiedFields: '{"price":2}', snapStatus: "CHECKED_IN" });
    expect(u2.statusTo).toBeNull();
  });
});

describe("ciclos de entrega (§2.2)", () => {
  it("pendente → em entrega → check-out: um ciclo entregue, chave = a linha do CHECK_OUT", () => {
    const r = ev("PENDING_CHECKOUT", T("16:00")), s = ev("CHECKING_OUT", T("16:05")), e = ev("CHECK_OUT", T("16:30"));
    const c = one([e, s, r]);
    expect(c).toMatchObject({ outcome: "entregue", anchor: { id: e.id }, start: { id: s.id }, checkout: { id: e.id }, startCount: 1 });
    expect(c.requests.map((x) => x.id)).toEqual([r.id]);
  });

  it("reinício só com UPDATE → CHECKED_IN; um MOVEMENT nunca reinicia (flag)", () => {
    const old = ev("PENDING_CHECKOUT", T("10:00"));
    const back = ev("UPDATE", T("10:10"), { statusTo: "CHECKED_IN" });
    const r = ev("PENDING_CHECKOUT", T("16:00"));
    const mv = move(T("16:02"), "parques", "PD", "COBERTO");
    const s = ev("CHECKING_OUT", T("16:05")), e = ev("CHECK_OUT", T("16:30"));
    const c = one([old, back, r, mv, s, e]);
    expect(c.requests[0].id).toBe(r.id);
    expect(c.flags).toContain("movimento_durante_pedido");
  });

  it("CANCEL depois do pendente fecha o ciclo como cancelado; CANCEL sem nada não cria ciclo", () => {
    const r = ev("PENDING_CHECKOUT", T("16:00")), x = ev("CANCEL", T("16:20"));
    const c = one([r, x]);
    expect(c).toMatchObject({ outcome: "cancelado", anchor: { id: x.id }, checkout: null });
    expect(buildDeliveryCycles([ev("CANCEL", T("09:00"), { bookingId: "b9" })]).cycles).toEqual([]);
  });

  it("reaberta com pedido novo: a 1.ª fica `reaberta`, a 2.ª `entregue`", () => {
    const list = [
      ev("PENDING_CHECKOUT", T("16:00")), ev("CHECKING_OUT", T("16:05")), ev("CHECK_OUT", T("16:30")),
      ev("UPDATE", T("16:40"), { statusTo: "CHECKED_IN" }),
      ev("PENDING_CHECKOUT", T("17:00")), ev("CHECKING_OUT", T("17:05")), ev("CHECK_OUT", T("17:25")),
    ];
    const { cycles } = buildDeliveryCycles(list);
    expect(cycles.map((c) => c.outcome)).toEqual(["reaberta", "entregue"]);
  });

  it("reaberta e fechada sem pedido novo = `fecho_repetido` (a 1.ª entrega fica); dois CHECK_OUT sem reabertura = `checkout_repetido`", () => {
    const a = buildDeliveryCycles([ev("PENDING_CHECKOUT", T("16:00")), ev("CHECKING_OUT", T("16:05")), ev("CHECK_OUT", T("16:30")),
      ev("UPDATE", T("18:00"), { statusTo: "CHECKED_IN" }), ev("CHECK_OUT", T("18:01"))]).cycles;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ outcome: "entregue" });
    expect(a[0].flags).toContain("fecho_repetido");
    const b = buildDeliveryCycles([ev("PENDING_CHECKOUT", T("16:00")), ev("CHECK_OUT", T("16:30")), ev("CHECK_OUT", T("16:31"))]).cycles;
    expect(b).toHaveLength(1);
    expect(b[0].flags).toContain("checkout_repetido");
  });

  it("ciclo ainda aberto (pendente sem CHECK_OUT) não sai, conta à parte", () => {
    const r = buildDeliveryCycles([ev("PENDING_CHECKOUT", T("22:00"), { bookingId: "aberta" })]);
    expect(r).toEqual({ cycles: [], openCycles: 1 });
  });

  it("vários pendentes: o 1.º conta; > 30 min entre eles = `pedido_repetido`", () => {
    const c = one([ev("PENDING_CHECKOUT", T("15:00")), ev("PENDING_CHECKOUT", T("15:45")), ev("CHECKING_OUT", T("16:00")), ev("CHECK_OUT", T("16:20"))]);
    expect(c.requests).toHaveLength(2);
    expect(c.flags).toContain("pedido_repetido");
  });

  it("desempate no mesmo instante pela ordem lógica (pendente antes do início antes do check-out)", () => {
    const at = T("16:00");
    const c = one([ev("CHECK_OUT", at + 20 * MIN), ev("CHECKING_OUT", at), ev("PENDING_CHECKOUT", at)]);
    expect(c.requests).toHaveLength(1);
    expect(c.start).not.toBeNull();
  });

  it("\"Cheguei\" pelo snapshot: só o deste ciclo (um valor anterior ao início é de outro ciclo); malas guardadas", () => {
    const old = T("09:00");
    const c = one([
      ev("PENDING_CHECKOUT", T("16:00"), { snapArrivedAt: old, snapBaggageAt: T("16:01") }),
      ev("CHECKING_OUT", T("16:05"), { snapArrivedAt: old }),
      ev("UPDATE", T("16:20"), { snapArrivedAt: T("16:20"), agentUserId: "u-cond" }),
      ev("CHECK_OUT", T("16:30"), { snapArrivedAt: T("16:20") }),
    ]);
    expect(c.button).toMatchObject({ at: T("16:20"), event: { type: "UPDATE" } });
    expect(c.baggageAt).toBe(T("16:01"));
    const d = one([ev("PENDING_CHECKOUT", T("16:00"), { bookingId: "b2", snapArrivedAt: old }), ev("CHECK_OUT", T("16:30"), { bookingId: "b2", snapArrivedAt: old })]);
    expect(d.button).toBeNull();
  });
});

describe("chamadas → reserva (§5.1)", () => {
  const phones = new Set(["912345678"]);
  const R = T("16:00");

  it("chamada 20 min antes do pendente → conta; 90 min antes → não conta (`chamada_fora_da_janela`)", () => {
    expect(matchCallToBooking({ calls: [call(R - 20 * MIN)], phones, anchorAt: R, fallbackAt: null }).call?.at).toBe(R - 20 * MIN);
    const far = matchCallToBooking({ calls: [call(R - 90 * MIN)], phones, anchorAt: R, fallbackAt: null });
    expect(far.call).toBeNull();
    expect(far.flags).toContain("chamada_fora_da_janela");
  });

  it("chamada perdida e pelo WhatsApp contam, com flag; outro número não conta", () => {
    expect(matchCallToBooking({ calls: [call(R - 5 * MIN, { held: false })], phones, anchorAt: R, fallbackAt: null }).flags).toContain("chamada_perdida");
    const w = matchCallToBooking({ calls: [call(R - 5 * MIN, { source: "whatsapp" })], phones, anchorAt: R, fallbackAt: null });
    expect(w.call?.source).toBe("whatsapp");
    expect(w.flags).toContain("chamada_whatsapp");
    expect(matchCallToBooking({ calls: [call(R - 5 * MIN, { phone9: "999999999" })], phones, anchorAt: R, fallbackAt: null }).call).toBeNull();
  });

  it("a 1.ª chamada da janela; a ficha do CRM (contactRef crm-<id>) também bate", () => {
    const r = matchCallToBooking({ calls: [call(R - 3 * MIN), call(R - 30 * MIN)], phones, anchorAt: R, fallbackAt: null });
    expect(r.call?.at).toBe(R - 30 * MIN);
    expect(matchCallToBooking({ calls: [call(R - 3 * MIN, { phone9: null, crmClientId: 7 })], phones: new Set(), crmIds: new Set([7]), anchorAt: R, fallbackAt: null }).call).not.toBeNull();
    expect(crmIdOfContactRef("crm-7")).toBe(7);
    expect(crmIdOfContactRef("emp-7")).toBeNull();
  });

  it("número partilhado (≥ 3 reservas com pedido no mesmo dia) não conta; duas reservas da mesma pessoa partilham a chamada", () => {
    const shared = sharedPhonesByDay([
      { day: "2026-10-12", bookingId: "a", phones: ["911111111"] },
      { day: "2026-10-12", bookingId: "b", phones: ["911111111"] },
      { day: "2026-10-12", bookingId: "c", phones: ["911111111", "922222222"] },
      { day: "2026-10-12", bookingId: "d", phones: ["922222222"] },
      { day: "2026-10-13", bookingId: "e", phones: ["911111111"] },
    ]);
    expect([...(shared.get("2026-10-12") ?? [])]).toEqual(["911111111"]);
    expect(shared.get("2026-10-13")).toBeUndefined();
    const r = matchCallToBooking({ calls: [call(R - 5 * MIN, { phone9: "911111111" })], phones: new Set(["911111111"]), anchorAt: R, fallbackAt: null, shared: shared.get("2026-10-12") });
    expect(r.call).toBeNull();
    expect(r.flags).toContain("telefone_partilhado");
    const c = call(R - 5 * MIN, { phone9: "922222222" });
    for (const anchor of [R, R + 2 * MIN]) expect(matchCallToBooking({ calls: [c], phones: new Set(["922222222"]), anchorAt: anchor, fallbackAt: null, shared: shared.get("2026-10-12") }).call).toBe(c);
  });

  it("sem pendente: janela [S − 60 min, S]; sem pendente nem início: nada", () => {
    const S = T("16:10");
    expect(matchCallToBooking({ calls: [call(S - 50 * MIN)], phones, anchorAt: null, fallbackAt: S }).call).not.toBeNull();
    expect(matchCallToBooking({ calls: [call(S + 2 * MIN)], phones, anchorAt: null, fallbackAt: S }).call).toBeNull();
    expect(matchCallToBooking({ calls: [call(S)], phones, anchorAt: null, fallbackAt: null }).call).toBeNull();
    expect(CALL_WINDOW_BEFORE_MIN).toBe(60);
  });

  it("voo seguido: pendente 40 min antes da chamada → a chamada não conta e fica `pedido_antes_da_chamada`", () => {
    const r = matchCallToBooking({ calls: [call(R + 40 * MIN)], phones, anchorAt: R, fallbackAt: null, untilAt: R + 90 * MIN });
    expect(r.call).toBeNull();
    expect(r.flags).toContain("pedido_antes_da_chamada");
    // o cliente ligou ANTES do pendente e voltou a ligar ("então?"): não é um pendente posto antes da chamada
    const twice = matchCallToBooking({ calls: [call(R - 10 * MIN), call(R + 40 * MIN)], phones, anchorAt: R, fallbackAt: null, untilAt: R + 90 * MIN });
    expect(twice.call?.at).toBe(R - 10 * MIN);
    expect(twice.flags).not.toContain("pedido_antes_da_chamada");
  });
});

describe("tempos das entregas (§2.3)", () => {
  const cycle = (extra: ServiceEvent[] = []) => one([ev("PENDING_CHECKOUT", T("16:00")), ev("CHECKING_OUT", T("16:10")), ev("CHECK_OUT", T("16:40"), { agentUserId: "u-tl" }), ...extra]);

  it("chamada 20 min antes do pendente → Fila desde a chamada; Trânsito, Cliente, Nosso e Total; invariante ao milissegundo", () => {
    const t = deliveryTimes({ cycle: cycle(), call: call(T("15:40")), arrival: arrived(T("16:22") + 1234) });
    expect(t).toMatchObject({ startSource: "chamada", queueStartAt: T("15:40"), queueMs: 30 * MIN, transitMs: 12 * MIN + 1234, queueStatus: "medido", transitStatus: "medido", ourStatus: "medido", customerStatus: "medido" });
    expect(t.ourMs).toBe(t.queueMs! + t.transitMs!);
    expect(t.queueMs! + t.transitMs! + t.customerMs!).toBe(t.totalMs);
    expect(t.totalMs).toBe(60 * MIN);
    expect(withinTarget(t)).toBe(false);
  });

  it("sem chamada (ou serviceTimes.useCalls desligado: o trabalho passa call = null) → Fila desde o pendente", () => {
    const t = deliveryTimes({ cycle: cycle(), call: null, arrival: arrived(T("16:20")) });
    expect(t).toMatchObject({ startSource: "pendente", queueMs: 10 * MIN, transitMs: 10 * MIN, customerMs: 20 * MIN, ourMs: 20 * MIN, totalMs: 40 * MIN });
    expect(withinTarget(t, 20)).toBe(true);
  });

  it("chamada sem pendente → Q0 = chamada; sem pendente nem chamada → Fila `sem_pedido`, Trânsito e Cliente medidos", () => {
    const noReq = one([ev("CHECKING_OUT", T("16:10"), { bookingId: "b3" }), ev("CHECK_OUT", T("16:40"), { bookingId: "b3" })]);
    expect(deliveryTimes({ cycle: noReq, call: call(T("15:50")), arrival: arrived(T("16:25")) })).toMatchObject({ startSource: "chamada", queueMs: 20 * MIN });
    const t = deliveryTimes({ cycle: noReq, call: null, arrival: arrived(T("16:25")) });
    expect(t).toMatchObject({ queueStatus: "sem_pedido", transitStatus: "medido", customerStatus: "medido", ourStatus: "sem_pedido", startSource: "inicio", totalMs: 30 * MIN });
  });

  it("sem \"em entrega\": Fila e Trânsito `sem_inicio`, Total medido", () => {
    const c = one([ev("PENDING_CHECKOUT", T("16:00"), { bookingId: "b4" }), ev("CHECK_OUT", T("16:40"), { bookingId: "b4" })]);
    const t = deliveryTimes({ cycle: c, call: null, arrival: noArrival("sem_pontos") });
    expect(t).toMatchObject({ queueStatus: "sem_inicio", transitStatus: "sem_inicio", totalMs: 40 * MIN });
  });

  it("o carro saiu antes do pendente e da chamada: Fila 0, T0 = S (`inicio_antes_do_pedido`); invariante", () => {
    const c = one([ev("CHECKING_OUT", T("15:50"), { bookingId: "b5" }), ev("PENDING_CHECKOUT", T("16:00"), { bookingId: "b5" }), ev("CHECK_OUT", T("16:30"), { bookingId: "b5" })]);
    const t = deliveryTimes({ cycle: c, call: null, arrival: arrived(T("16:05")) });
    expect(t).toMatchObject({ queueMs: 0, transitMs: 15 * MIN, customerMs: 25 * MIN, totalMs: 40 * MIN });
    expect(t.flags).toContain("inicio_antes_do_pedido");
    expect(t.queueMs! + t.transitMs! + t.customerMs!).toBe(t.totalMs);
  });

  it("chegada até 60 s depois da assinatura = a assinatura (`chegada_ajustada`, Cliente 0); mais do que isso → `chegada_depois_da_assinatura`", () => {
    const a = deliveryTimes({ cycle: cycle(), call: null, arrival: arrived(T("16:40") + 40_000) });
    expect(a).toMatchObject({ customerMs: 0, transitMs: 30 * MIN, arrivedAt: T("16:40") });
    expect(a.flags).toContain("chegada_ajustada");
    expect(a.queueMs! + a.transitMs! + a.customerMs!).toBe(a.totalMs);
    const b = deliveryTimes({ cycle: cycle(), call: null, arrival: arrived(T("16:42")) });
    expect(b).toMatchObject({ transitStatus: "chegada_depois_da_assinatura", customerStatus: "chegada_depois_da_assinatura", transitMs: null, customerMs: null });
  });

  it("nunca um negativo: chegada antes de S conta como S (A ≥ S)", () => {
    const t = deliveryTimes({ cycle: cycle(), call: null, arrival: arrived(T("16:05")) });
    expect(t.transitMs).toBe(0);
    expect(t.arrivedAt).toBe(T("16:10"));
  });

  it("cancelada depois do início → `cancelado`, tempos sem medição", () => {
    const c = one([ev("PENDING_CHECKOUT", T("16:00"), { bookingId: "b6" }), ev("CHECKING_OUT", T("16:10"), { bookingId: "b6" }), ev("CANCEL", T("16:15"), { bookingId: "b6" })]);
    const t = deliveryTimes({ cycle: c, call: null, arrival: arrived(T("16:12")) });
    expect(t).toMatchObject({ outcome: "cancelado", queueStatus: "cancelado", transitStatus: "cancelado", queueMs: null, transitMs: null, totalMs: null });
  });

  it("\"em entrega\" marcado no terminal: com GPS, S = saída do parque; sem GPS, Fila/Trânsito sem medição e Nosso aproximado", () => {
    const withGps = deliveryTimes({ cycle: cycle(), call: null, arrival: arrived(T("16:08")), inicioNoTerminal: { parkExitAt: T("16:03") } });
    expect(withGps).toMatchObject({ startedAt: T("16:03"), queueMs: 3 * MIN, transitMs: 5 * MIN, queueStatus: "medido" });
    expect(withGps.flags).toContain("inicio_no_terminal");
    expect(withGps.queueMs! + withGps.transitMs! + withGps.customerMs!).toBe(withGps.totalMs);
    const noGps = deliveryTimes({ cycle: cycle(), call: null, arrival: noArrival("sem_pontos"), inicioNoTerminal: { parkExitAt: null } });
    expect(noGps).toMatchObject({ queueStatus: "inicio_no_terminal", transitStatus: "inicio_no_terminal", ourStatus: "aproximado", ourMs: 10 * MIN });
    expect(noGps.flags).toContain("nosso_aproximado");
  });

  it("despachante: a Fila mede-se, o Trânsito fica `condutor_por_confirmar`; condutor que esperou o cliente fica marcado", () => {
    const t = deliveryTimes({ cycle: cycle(), call: null, arrival: arrived(T("16:20")), driverBlock: "condutor_por_confirmar" });
    expect(t).toMatchObject({ queueStatus: "medido", transitStatus: "condutor_por_confirmar", customerStatus: "condutor_por_confirmar", ourStatus: "condutor_por_confirmar" });
    const self = one([ev("PENDING_CHECKOUT", T("16:00"), { bookingId: "b7" }), ev("CHECKING_OUT", T("16:10"), { bookingId: "b7" }), ev("CHECK_OUT", T("16:40"), { bookingId: "b7" })]);
    expect(deliveryTimes({ cycle: self, call: null, arrival: arrived(T("16:20")) }).flags).toContain("condutor_esperou");
  });

  it("limites: Fila > 240 min e Trânsito > 120 min → `fora_dos_limites` (Nosso sem medição)", () => {
    const c = one([ev("PENDING_CHECKOUT", T("08:00"), { bookingId: "b8" }), ev("CHECKING_OUT", T("12:30"), { bookingId: "b8" }), ev("CHECK_OUT", T("15:00"), { bookingId: "b8" })]);
    const t = deliveryTimes({ cycle: c, call: null, arrival: arrived(T("14:50")) });
    expect(t).toMatchObject({ queueStatus: "fora_dos_limites", transitStatus: "fora_dos_limites", customerStatus: "medido", ourMs: null });
  });

  it("hora de referência = T0 (dia operacional 03h→03h de Lisboa); a mudança de hora: o dia 24 out tem 25 h", () => {
    // 25 out 2026, 00:30 UTC = 01:30 WEST; 01:30 UTC = 01:30 WET (a mesma hora de relógio duas vezes)
    for (const at of [Date.parse("2026-10-25T00:30:00Z"), Date.parse("2026-10-25T01:30:00Z")]) {
      const c = one([ev("PENDING_CHECKOUT", at, { bookingId: `dst${at}` }), ev("CHECK_OUT", at + 20 * MIN, { bookingId: `dst${at}` })]);
      const t = deliveryTimes({ cycle: c, call: null, arrival: noArrival("sem_inicio") });
      expect(t.opDay).toBe("2026-10-24");
      expect(t.refHour).toBe(1);
    }
    // 25 out, 02:30 UTC = 02:30 WET (ainda antes das 03h) → dia 24; 03:00 UTC = 03:00 → dia 25
    const at = Date.parse("2026-10-25T02:30:00Z");
    expect(deliveryTimes({ cycle: one([ev("PENDING_CHECKOUT", at, { bookingId: "d1" }), ev("CHECK_OUT", at + MIN, { bookingId: "d1" })]), call: null, arrival: noArrival("sem_inicio") }).opDay).toBe("2026-10-24");
    const at2 = Date.parse("2026-10-25T03:00:00Z");
    expect(deliveryTimes({ cycle: one([ev("PENDING_CHECKOUT", at2, { bookingId: "d2" }), ev("CHECK_OUT", at2 + MIN, { bookingId: "d2" })]), call: null, arrival: noArrival("sem_inicio") }).opDay).toBe("2026-10-25");
  });

  it("a hora marcada (checkOut.from) não entra em nada", () => {
    const c = one([ev("PENDING_CHECKOUT", T("16:00"), { bookingId: "hm" }), ev("CHECKING_OUT", T("16:10"), { bookingId: "hm" }), ev("CHECK_OUT", T("16:40"), { bookingId: "hm" })]);
    const t = deliveryTimes({ cycle: c, call: null, arrival: arrived(T("16:20")) });
    expect(JSON.stringify(t)).not.toMatch(/marcad|schedul|antecipad/i);
  });
});

describe("invariantes (ciclos aleatórios)", () => {
  it("com tudo medido, Fila + Trânsito + Cliente = Total ao milissegundo; nunca um negativo; A ≥ S; Nosso = Fila + Trânsito", () => {
    let x = 12345;
    const rnd = (n: number) => { x = (x * 1103515245 + 12345) % 2147483648; return x % n; };
    let full = 0;
    for (let i = 0; i < 400; i++) {
      const id = `inv${i}`;
      const R0 = T("12:00") + rnd(600) * MIN;
      const S0 = R0 + (rnd(80) - 20) * MIN; // às vezes antes do pendente
      const E0 = Math.max(S0, R0) + (1 + rnd(90)) * MIN + rnd(60_000);
      const events = [ev("PENDING_CHECKOUT", R0, { bookingId: id }), ev("CHECKING_OUT", S0, { bookingId: id }), ev("CHECK_OUT", E0, { bookingId: id })];
      const c = buildDeliveryCycles(events).cycles[0];
      const cl = rnd(3) === 0 ? null : call(R0 - rnd(60) * MIN - rnd(60_000));
      const A0 = S0 - 5 * MIN + rnd(Math.max(1, E0 + 2 * MIN - S0 + 5 * MIN)); // às vezes antes de S, às vezes depois de E
      const term = rnd(6) === 0 ? { parkExitAt: rnd(2) ? S0 - rnd(5) * MIN : null } : null;
      const t = deliveryTimes({ cycle: c, call: cl, arrival: arrived(A0), inicioNoTerminal: term });
      for (const k of ["queueMs", "transitMs", "customerMs", "ourMs", "totalMs"] as const) if (t[k] != null) expect(t[k]!, `${k} ${i}`).toBeGreaterThanOrEqual(0);
      if (t.arrivedAt != null && t.startedAt != null) expect(t.arrivedAt).toBeGreaterThanOrEqual(t.startedAt);
      if (t.queueStatus === "medido" && t.transitStatus === "medido" && t.customerStatus === "medido") {
        full++;
        expect(t.queueMs! + t.transitMs! + t.customerMs!, `invariante ${i}`).toBe(t.totalMs);
        expect(t.ourMs).toBe(t.queueMs! + t.transitMs!);
      }
    }
    expect(full).toBeGreaterThan(100);
  });
});

describe("chegada: GPS e \"Cheguei\" (§4.4)", () => {
  const S = T("16:10"), E = T("16:40");
  it("o \"Cheguei\" só serve sem GPS e se for coerente; com os dois guarda-se a diferença", () => {
    expect(buttonCoherent({ buttonAt: T("16:20"), startAt: S, endAt: E, pressedBy: "u1", driverAgentId: "u1", distanceFromParkM: 4000 })).toBe(true);
    expect(buttonCoherent({ buttonAt: S + 60_000, startAt: S, endAt: E })).toBe(false); // < 2 min depois do início
    expect(buttonCoherent({ buttonAt: T("16:20"), startAt: S, endAt: E, pressedBy: "u2", driverAgentId: "u1" })).toBe(false);
    expect(buttonCoherent({ buttonAt: T("16:20"), startAt: S, endAt: E, distanceFromParkM: 100 })).toBe(false); // carregado no parque
    expect(buttonCoherent({ buttonAt: T("16:45"), startAt: S, endAt: E })).toBe(false);
    const gps = { kind: "chegada" as const, at: T("16:22"), source: "gps_zona" as const, precisionS: 60, flags: [] };
    expect(resolveArrival(gps, { at: T("16:20"), coherent: true })).toMatchObject({ kind: "medido", source: "gps_zona", buttonGapS: -120 });
    expect(resolveArrival({ kind: "sem_chegada", status: "sem_paragem", flags: [] }, { at: T("16:20"), coherent: true })).toMatchObject({ kind: "medido", source: "botao", at: T("16:20") });
    expect(resolveArrival({ kind: "sem_chegada", status: "sem_paragem", flags: [] }, { at: T("16:20"), coherent: false })).toMatchObject({ kind: "sem_medicao", status: "sem_paragem" });
    expect(resolveArrival(null, null, "sem_zello")).toMatchObject({ kind: "sem_medicao", status: "sem_zello" });
  });
});

describe("condutor (§2.4, §4.2)", () => {
  it("papel do agente lido no PARQUE DA RESERVA (uma linha Agent por parque); sem linha nesse parque, o mais alto com flag", () => {
    const rows = [{ userId: "u1", parkId: "pA", role: "DRIVER" }, { userId: "u1", parkId: "pB", role: "LEADER" }];
    expect(agentRoleIn(rows, "u1", "pA")).toEqual({ role: "DRIVER", otherPark: false });
    expect(agentRoleIn(rows, "u1", "pB")).toEqual({ role: "LEADER", otherPark: false });
    expect(agentRoleIn(rows, "u1", "pC")).toEqual({ role: "LEADER", otherPark: true });
    expect(agentRoleIn(rows, "u9", "pA")).toEqual({ role: null, otherPark: false });
  });

  it("despachante: chefia, ou dois inícios do mesmo agente a < 2 min (P0: era 8)", () => {
    const ids = dispatchStartIds([{ id: "a", agentUserId: "tl", at: T("16:00") }, { id: "b", agentUserId: "tl", at: T("16:01") }, { id: "c", agentUserId: "x", at: T("16:00") }, { id: "d", agentUserId: "x", at: T("16:20") }]);
    expect([...ids].sort()).toEqual(["a", "b"]);
    // Faro (P0): o carro já está perto do terminal e o condutor começa a 2.ª entrega 5 min depois da 1.ª — é condutor, não despachante
    expect(dispatchStartIds([{ id: "f1", agentUserId: "faro", at: T("16:00") }, { id: "f2", agentUserId: "faro", at: T("16:05") }]).size).toBe(0);
    // exatamente 2 min já não é despacho (o corte é "menos de")
    expect(dispatchStartIds([{ id: "g1", agentUserId: "g", at: T("16:00") }, { id: "g2", agentUserId: "g", at: T("16:02") }]).size).toBe(0);
    // condutor que entregou a 1.ª em 40 s (assinou ele) e começou a 2.ª logo a seguir: conduziu as duas
    expect(dispatchStartIds([{ id: "q1", agentUserId: "q", at: T("16:00"), doneAt: T("16:00") + 40_000, doneBy: "q" }, { id: "q2", agentUserId: "q", at: T("16:01") + 30_000 }]).size).toBe(0);
    // quem despacha não assina a anterior (assina o condutor, mais tarde): continua despacho
    expect([...dispatchStartIds([{ id: "d1", agentUserId: "tl", at: T("16:00"), doneAt: T("16:20"), doneBy: "drv" }, { id: "d2", agentUserId: "tl", at: T("16:01") }])].sort()).toEqual(["d1", "d2"]);
    // assinou a anterior, mas DEPOIS de começar a seguinte: não chega
    expect(dispatchStartIds([{ id: "w1", agentUserId: "w", at: T("16:00"), doneAt: T("16:05"), doneBy: "w" }, { id: "w2", agentUserId: "w", at: T("16:01") }]).size).toBe(2);
    expect(driverBlockOf({ kind: "colaborador", role: "LEADER", dispatch: false })).toBe("condutor_por_confirmar");
    expect(driverBlockOf({ kind: "colaborador", role: "DRIVER", dispatch: true })).toBe("condutor_por_confirmar");
    expect(driverBlockOf({ kind: "colaborador", role: "DRIVER", dispatch: false })).toBeNull();
    expect(driverBlockOf({ kind: "parceiro", role: null, dispatch: false })).toBe("condutor_fora_da_equipa");
    expect(driverBlockOf({ kind: "ignorado", role: null, dispatch: false })).toBe("condutor_fora_da_equipa");
    expect(driverBlockOf({ kind: "por_ligar", role: null, dispatch: false })).toBe("condutor_desconhecido");
    expect(driverBlockOf({ kind: null, role: null, dispatch: false })).toBe("condutor_desconhecido");
  });

  it("Zello no instante: check-in de PDA (aberto: no máximo 16 h); Zello fixo só de fichas ativas e sem dono repetido", () => {
    const checkins = [
      { employeeId: 1, zello: "PDA 12", start: T("14:00"), end: T("15:00") },
      { employeeId: 2, zello: "pda 12", start: T("15:00"), end: null }, // PDA trocado às 15h
    ];
    const fixed = [{ employeeId: 3, zello: "pda 12", active: true }, { employeeId: 4, zello: "joao", active: true }, { employeeId: 5, zello: "Maria", active: true }, { employeeId: 6, zello: "maria", active: true }, { employeeId: 7, zello: "ana", active: false }];
    const ctx = { checkins, fixed };
    expect(zelloOfAt(1, T("14:30"), ctx)).toEqual({ zello: "pda 12", source: "pda" });
    expect(zelloOfAt(2, T("16:00"), ctx)).toEqual({ zello: "pda 12", source: "pda" });
    expect(zelloHolderAt("PDA 12", T("14:59"), ctx)).toBe(1);
    expect(zelloHolderAt("PDA 12", T("15:01"), ctx)).toBe(2);
    // check-in aberto: só 16 h
    expect(zelloOfAt(2, T("15:00") + 17 * 3_600_000, ctx)).toEqual({ zello: null, reason: "sem_zello" });
    expect(zelloOfAt(4, T("16:00"), ctx)).toEqual({ zello: "joao", source: "fixo" });
    // o mesmo Zello em duas fichas ativas → ambíguo
    expect(zelloOfAt(5, T("16:00"), ctx)).toEqual({ zello: null, reason: "sem_zello" });
    // ficha inativa → sem Zello
    expect(zelloOfAt(7, T("16:00"), ctx)).toEqual({ zello: null, reason: "sem_zello" });
    // o Zello fixo dele está num PDA com o check-in de outra pessoa → sem Zello
    expect(zelloOfAt(3, T("16:00"), ctx)).toEqual({ zello: null, reason: "sem_zello" });
    expect(zelloOfAt(3, T("13:00"), ctx)).toEqual({ zello: "pda 12", source: "fixo" });
    // condutor sem Zello nenhum
    expect(zelloOfAt(99, T("16:00"), ctx)).toEqual({ zello: null, reason: "sem_zello" });
  });

  it("PDA com dois check-ins abertos (ninguém fez check-out): ganha o mais recente, seja qual for a ordem da lista", () => {
    const a = { employeeId: 1, zello: "PDA 7", start: T("06:00"), end: null }; // manhã, ficou aberto
    const b = { employeeId: 2, zello: "pda 7", start: T("15:00"), end: null }; // tarde
    for (const checkins of [[a, b], [b, a]]) {
      const ctx = { checkins, fixed: [{ employeeId: 1, zello: "joao", active: true }] };
      expect(zelloHolderAt("PDA 7", T("16:00"), ctx)).toBe(2);
      expect(zelloHolderAt("PDA 7", T("10:00"), ctx)).toBe(1);
      expect(zelloOfAt(2, T("16:00"), ctx)).toEqual({ zello: "pda 7", source: "pda" });
      // o da manhã já não tem o PDA às 16h: vale o Zello fixo dele
      expect(zelloOfAt(1, T("16:00"), ctx)).toEqual({ zello: "joao", source: "fixo" });
      expect(zelloOfAt(1, T("10:00"), ctx)).toEqual({ zello: "pda 7", source: "pda" });
    }
  });
});

describe("ciclos de recolha (§3.1)", () => {
  it("em recolha → check-in → movimentos (até 48 h e até ao pedido de entrega)", () => {
    const list = [
      ev("CHECKING_IN", T("07:00"), { bookingId: "r1" }), ev("CHECK_IN", T("07:20"), { bookingId: "r1" }),
      move(T("07:25"), "inicio", null, null, { bookingId: "r1" }), move(T("07:35"), "arrumar", "P2", null, { bookingId: "r1" }),
      move(T("09:00", "2026-10-15"), "parques", "PD", "P2", { bookingId: "r1" }), // > 48 h
    ];
    const [c] = buildPickupCycles(list);
    expect(c).toMatchObject({ outcome: "recebido", checkingIn: { at: T("07:00") }, checkIn: { at: T("07:20") } });
    expect(c.moves).toHaveLength(2);
    const [d] = buildPickupCycles([ev("CHECK_IN", T("07:20"), { bookingId: "r2" }), ev("PENDING_CHECKOUT", T("09:00"), { bookingId: "r2" }), move(T("09:05"), "parques", "PD", "COBERTO", { bookingId: "r2" })]);
    expect(d.moves).toHaveLength(0);
  });

  it("reinício (UPDATE → BOOKED: o cliente não veio), cancelada depois do \"em recolha\" e check-in repetido", () => {
    const [c] = buildPickupCycles([ev("CHECKING_IN", T("06:00"), { bookingId: "r3" }), ev("UPDATE", T("06:30"), { bookingId: "r3", statusTo: "BOOKED" }), ev("CHECKING_IN", T("07:00"), { bookingId: "r3" }), ev("CHECK_IN", T("07:10"), { bookingId: "r3" })]);
    expect(c.checkingIn?.at).toBe(T("07:00"));
    const [x] = buildPickupCycles([ev("CHECKING_IN", T("06:00"), { bookingId: "r4" }), ev("CANCEL", T("06:40"), { bookingId: "r4" })]);
    expect(x.outcome).toBe("cancelado");
    expect(buildPickupCycles([ev("CANCEL", T("06:40"), { bookingId: "r5" })])).toEqual([]);
    const rep = buildPickupCycles([ev("CHECK_IN", T("07:10"), { bookingId: "r6" }), ev("CHECK_IN", T("07:12"), { bookingId: "r6" })]);
    expect(rep).toHaveLength(1);
    expect(rep[0].flags).toContain("checkin_repetido");
  });
});

describe("tempos das recolhas (§3.3)", () => {
  const roles = DEFAULT_GARAGE_ROLES;
  const now = T("12:00", "2026-10-20");
  const gpsExit = (at: number) => ({ kind: "medido" as const, at, source: "gps" as const, precisionS: 60, flags: [] });
  const base = (moves: ServiceEvent[] = [], k: number | null = T("07:00"), id = "p") => buildPickupCycles([
    ...(k != null ? [ev("CHECKING_IN", k, { bookingId: id, agentUserId: "u-esc" })] : []),
    ev("CHECK_IN", T("07:20"), { bookingId: id, agentUserId: "u-cond" }),
    ...moves.map((m) => ({ ...m, bookingId: id })),
  ])[0];

  it("em recolha → check-in → saída do terminal pelo GPS; G1 = central (pára de medir)", () => {
    const c = base([move(T("07:30"), "inicio", null), move(T("07:45"), "arrumar", "CENTRAL")]);
    const t = pickupTimes({ cycle: c, call: null, terminalExit: gpsExit(T("07:28")), roles, spotType: "uncovered", now });
    expect(t).toMatchObject({ customerMs: 20 * MIN, customerStatus: "medido", terminalMs: 8 * MIN, terminalStatus: "medido", firstGarage: "CENTRAL", firstGarageRole: "parque",
      toFirstGarageMs: 17 * MIN, parkedStatus: "arrumado", parkedGarage: "CENTRAL", toParkedMs: 25 * MIN, p2Status: "nao_passou_no_p2", t2Status: "nao_aplicavel" });
  });

  it("chamada antes do \"em recolha\" → o Cliente conta desde a chamada", () => {
    const t = pickupTimes({ cycle: base(), call: call(T("06:50")), terminalExit: gpsExit(T("07:28")), roles, spotType: "uncovered", now });
    expect(t).toMatchObject({ startSource: "chamada", customerMs: 30 * MIN });
  });

  it("saída pela app (início do movimento marcado na zona do terminal)", () => {
    const c = base([move(T("07:31"), "inicio", null, null, { lat: 38.77, lng: -9.13 }), move(T("07:45"), "arrumar", "PD")]);
    const exit = appTerminalExit(c, (lat) => lat > 38.7);
    expect(exit).toMatchObject({ kind: "medido", at: T("07:31"), source: "app_inicio_movimento" });
    expect(appTerminalExit(c, () => false)).toBeNull();
    expect(pickupTimes({ cycle: c, call: null, terminalExit: exit!, roles, spotType: "uncovered", now })).toMatchObject({ terminalMs: 11 * MIN, terminalExitSource: "app_inicio_movimento" });
  });

  it("G1 = P2 → central: tempo no P2 (e a saída do P2 pelo início do movimento); quem o tirou do P2 e quem o arrumou (Q7)", () => {
    const c = base([move(T("07:30"), "inicio", null), move(T("07:40"), "arrumar", "P2"), move(T("09:00"), "inicio", null, null, { agentUserId: "u-p2" }), move(T("09:10"), "parques", "CENTRAL", "P2", { agentUserId: "u-p2" })]);
    const t = pickupTimes({ cycle: c, call: null, terminalExit: gpsExit(T("07:28")), roles, spotType: "indoor", now });
    expect(t).toMatchObject({ firstGarageRole: "provisoria", p2Status: "medido", p2Ms: 90 * MIN, p2ExitAt: T("09:00"), parkedGarage: "CENTRAL", toParkedMs: 110 * MIN });
    expect(t.p2Mover?.agentUserId).toBe("u-p2");
    expect(t.parker?.at).toBe(T("09:10"));
  });

  it("G1 = PD com carro de interior → só arruma no coberto (`foi_para_o_sitio_errado`)", () => {
    const c = base([move(T("07:40"), "arrumar", "PD"), move(T("10:00"), "parques", "COBERTO", "PD")]);
    const t = pickupTimes({ cycle: c, call: null, terminalExit: gpsExit(T("07:28")), roles, spotType: "indoor", now });
    expect(t).toMatchObject({ parkedGarage: "COBERTO", parkedStatus: "arrumado", toParkedMs: 160 * MIN });
    expect(t.flags).toContain("foi_para_o_sitio_errado");
  });

  it("carro de toldo no PD → arrumado (warn); garagem desconhecida → arrumado com `arrumo_por_confirmar` e aviso de garagem sem papel", () => {
    expect(pickupTimes({ cycle: base([move(T("07:40"), "arrumar", "PD")]), call: null, terminalExit: gpsExit(T("07:28")), roles, spotType: "covered", now })).toMatchObject({ parkedStatus: "arrumado", parkedGarage: "PD" });
    const t = pickupTimes({ cycle: base([move(T("07:40"), "arrumar", "GARAGEM NOVA")]), call: null, terminalExit: gpsExit(T("07:28")), roles, spotType: "uncovered", now });
    expect(t).toMatchObject({ parkedStatus: "arrumado", firstGarageRole: "final" });
    expect(t.flags).toEqual(expect.arrayContaining(["arrumo_por_confirmar", "garagem_sem_papel"]));
    expect(garageRoleOf("central coberto", roles)).toEqual({ role: "parque", configured: true });
  });

  it("sem garagem provisória configurada → \"No P2\" diz isso (nunca 0)", () => {
    const t = pickupTimes({ cycle: base([move(T("07:40"), "arrumar", "PD")]), call: null, terminalExit: gpsExit(T("07:28")), roles: roles.filter((r) => r.role !== "provisoria"), spotType: "uncovered", now });
    expect(t).toMatchObject({ p2Status: "sem_garagem_provisoria", p2Ms: null });
  });

  it("sem garagem nos movimentos (formato antigo) → só Cliente e terminal", () => {
    const t = pickupTimes({ cycle: base([move(T("07:40"), "antigo", null)]), call: null, terminalExit: gpsExit(T("07:28")), roles, spotType: "uncovered", now });
    expect(t).toMatchObject({ parkedStatus: "sem_garagem", p2Status: "sem_garagem", firstGarage: null, terminalStatus: "medido", customerStatus: "medido" });
  });

  it("48 h sem arrumar → `por_arrumar`", () => {
    const t = pickupTimes({ cycle: base([move(T("07:40"), "arrumar", "P2")]), call: null, terminalExit: gpsExit(T("07:28")), roles, spotType: "uncovered", now });
    expect(t).toMatchObject({ parkedStatus: "por_arrumar", p2Status: "no_p2" });
  });

  it("\"em recolha\" < 2 min antes do check-in: pelo mesmo agente → Cliente sem medição (sem chamada); por outra pessoa fora do terminal → medido (~0)", () => {
    const same = buildPickupCycles([ev("CHECKING_IN", T("07:19"), { bookingId: "s1", agentUserId: "u-cond" }), ev("CHECK_IN", T("07:20"), { bookingId: "s1", agentUserId: "u-cond" })])[0];
    const a = pickupTimes({ cycle: same, call: null, terminalExit: gpsExit(T("07:28")), roles, spotType: "uncovered", now });
    expect(a).toMatchObject({ customerStatus: "em_recolha_tardio", customerMs: null });
    expect(a.flags).toContain("em_recolha_tardio");
    expect(pickupTimes({ cycle: same, call: call(T("07:05")), terminalExit: gpsExit(T("07:28")), roles, spotType: "uncovered", now })).toMatchObject({ customerStatus: "medido", customerMs: 15 * MIN });
    const other = buildPickupCycles([ev("CHECKING_IN", T("07:19"), { bookingId: "s2", agentUserId: "u-esc" }), ev("CHECK_IN", T("07:20"), { bookingId: "s2", agentUserId: "u-cond" })])[0];
    expect(pickupTimes({ cycle: other, call: null, terminalExit: gpsExit(T("07:28")), roles, spotType: "uncovered", now })).toMatchObject({ customerStatus: "medido", customerMs: MIN });
    expect(pickupTimes({ cycle: other, call: null, checkingInAtTerminal: true, terminalExit: gpsExit(T("07:28")), roles, spotType: "uncovered", now })).toMatchObject({ customerStatus: "em_recolha_tardio" });
  });

  it("\"em recolha\" tardio com chamada DEPOIS dele: o K tardio não conta (Cliente desde a chamada); chamada já depois do check-in não conta; T2 sem início → sem medição", () => {
    const same = buildPickupCycles([ev("CHECKING_IN", T("07:19"), { bookingId: "s3", agentUserId: "u-cond" }), ev("CHECK_IN", T("07:20"), { bookingId: "s3", agentUserId: "u-cond" })])[0];
    // chamada às 07:19:30 (dentro da janela K+5): o Cliente conta desde a chamada, não desde o K (marcado no terminal)
    expect(pickupTimes({ cycle: same, call: call(T("07:19") + 30_000), terminalExit: gpsExit(T("07:28")), roles, spotType: "uncovered", now })).toMatchObject({ startSource: "chamada", customerMs: 30_000 });
    // chamada às 07:22 (depois do check-in) → não é o pedido: sem medição
    const late = pickupTimes({ cycle: same, call: call(T("07:22")), terminalExit: gpsExit(T("07:28")), roles, spotType: "uncovered", now });
    expect(late).toMatchObject({ customerStatus: "em_recolha_tardio", customerMs: null, startSource: null });
    // T2: sem início do cliente (o K é tardio e não há chamada) → sem medição, nunca "a tempo"
    const t2 = pickupTimes({ cycle: same, call: null, terminalExit: gpsExit(T("07:28")), roles, spotType: "uncovered", now, t2: { arrival: { at: T("07:00"), alreadyThere: true }, targetMinutes: 15 } });
    expect(t2).toMatchObject({ t2Status: "em_recolha_tardio", t2LateMs: null });
    // o dia operacional continua a ser o do K (a hora de referência não se perde)
    expect(t2.opDay).toBe("2026-10-12");
  });

  it("Q4: a recolha no T2 é atrasada a partir de 15 min depois da chamada (omissão 15, editável)", () => {
    expect(DEFAULT_PICKUP_T2_TARGET_MINUTES).toBe(15);
    const c = base([], T("07:00"), "q4");
    const t2 = (atMin: number) => pickupTimes({ cycle: c, call: null, terminalExit: gpsExit(T("07:28")), roles, spotType: "uncovered", now, t2: { arrival: { at: T("07:00") + atMin * MIN, alreadyThere: false }, targetMinutes: DEFAULT_PICKUP_T2_TARGET_MINUTES } });
    expect(t2(15).t2LateMs).toBe(0);
    expect(t2(20).t2LateMs).toBe(5 * MIN);
  });

  it("T2: chegada 15 min depois da chamada → atrasada 5 min; 5 min depois → a tempo; já lá → 0; sem zona T2 → `sem_zona_t2`; T1 sem atraso", () => {
    const c = base([], T("07:00"));
    const k0 = T("07:00");
    const t2 = (arrival: any) => pickupTimes({ cycle: c, call: null, terminalExit: gpsExit(T("07:28")), roles, spotType: "uncovered", now, t2: { arrival, targetMinutes: 10 } });
    expect(t2({ at: k0 + 15 * MIN, alreadyThere: false })).toMatchObject({ t2Status: "medido", t2LateMs: 5 * MIN });
    expect(t2({ at: k0 + 5 * MIN, alreadyThere: false })).toMatchObject({ t2LateMs: 0 });
    expect(t2({ at: k0 - 10 * MIN, alreadyThere: true })).toMatchObject({ t2LateMs: 0 });
    expect(t2({ status: "sem_zona_t2" })).toMatchObject({ t2Status: "sem_zona_t2", t2LateMs: null });
    expect(pickupTimes({ cycle: c, call: null, terminalExit: gpsExit(T("07:28")), roles, spotType: "uncovered", now })).toMatchObject({ t2Status: "nao_aplicavel" });
  });

  it("sem \"em recolha\" nem chamada → Cliente sem medição; cancelada → tudo `cancelado`", () => {
    expect(pickupTimes({ cycle: base([], null, "q1"), call: null, terminalExit: gpsExit(T("07:28")), roles, spotType: "uncovered", now })).toMatchObject({ customerStatus: "sem_em_recolha" });
    const x = buildPickupCycles([ev("CHECKING_IN", T("06:00"), { bookingId: "q2" }), ev("CANCEL", T("06:40"), { bookingId: "q2" })])[0];
    expect(pickupTimes({ cycle: x, call: null, terminalExit: { kind: "sem_medicao", status: "sem_pontos", flags: [] }, roles, spotType: "uncovered", now })).toMatchObject({ customerStatus: "cancelado", terminalStatus: "cancelado", parkedStatus: "cancelado" });
  });

  it("sem GPS da saída: o motivo fica no \"No terminal\"; a 1.ª garagem conta desde o check-in (aproximado)", () => {
    const c = base([move(T("07:45"), "arrumar", "PD")]);
    const t = pickupTimes({ cycle: c, call: null, terminalExit: { kind: "sem_medicao", status: "sem_zello", flags: [] }, roles, spotType: "uncovered", now });
    expect(t).toMatchObject({ terminalStatus: "sem_zello", terminalMs: null, toFirstGarageMs: 25 * MIN });
    expect(t.flags).toContain("garagem_desde_o_check_in");
  });
});

describe("portão dos tempos com GPS (§8.1)", () => {
  it("fechado: só o super admin vê (\"em calibração\"); aberto: cobertura ≥ 60 % e n ≥ 20", () => {
    expect(DEFAULT_GPS_GATE).toEqual({ visible: false, minCoveragePct: 60, minN: 20 });
    expect(gpsTimesVisible({ coveragePct: 90, n: 100, gate: null, isSuperAdmin: false })).toEqual({ visible: false, label: "Em calibração" });
    expect(gpsTimesVisible({ coveragePct: 10, n: 1, gate: null, isSuperAdmin: true })).toEqual({ visible: true, label: "em calibração" });
    const open = { ...DEFAULT_GPS_GATE, visible: true };
    expect(gpsTimesVisible({ coveragePct: 59, n: 50, gate: open, isSuperAdmin: false })).toEqual({ visible: false, label: "Sem dados suficientes (cobertura 59 %, n = 50)" });
    expect(gpsTimesVisible({ coveragePct: 60, n: 19, gate: open, isSuperAdmin: false }).visible).toBe(false);
    expect(gpsTimesVisible({ coveragePct: 60, n: 20, gate: open, isSuperAdmin: false })).toEqual({ visible: true, label: null });
  });
});

describe("parâmetros fechados pela P0 (29 set–12 out 2026, PR dos parâmetros)", () => {
  it("valores medidos e versão do cálculo", () => {
    // mudou: o despachante marca os "em entrega" a < 2 min (em Faro um condutor começa duas em 5 min)
    expect(DISPATCH_MIN_MINUTES).toBe(2);
    // ficam (medidos): só 2 de 1 395 recolhas sem movimento em 48 h; "em recolha" < 2 min em 0,2 %
    expect(PICKUP_TRACK_MAX_HOURS).toBe(48);
    expect(LATE_PICKUP_MARK_MIN).toBe(2);
    // ainda provisória (quase não há chamadas registadas): não mexe
    expect([CALL_WINDOW_BEFORE_MIN, CALL_WINDOW_AFTER_MIN]).toEqual([60, 5]);
    // omissões das definições: decisões do Jorge e portão fechado (nenhuma cidade com ≥ 60 % de GPS)
    expect(DEFAULT_SERVICE_TARGET_MINUTES).toBe(15);
    expect(DEFAULT_PICKUP_T2_TARGET_MINUTES).toBe(15);
    expect(DEFAULT_GPS_GATE).toEqual({ visible: false, minCoveragePct: 60, minN: 20 });
    // mudar parâmetros sobe a versão (o trabalho recalcula as linhas antigas)
    expect(SERVICE_TIMES_CALC_VERSION).toBe(2);
  });
});

describe("impressão digital dos parâmetros", () => {
  it("igual com as chaves noutra ordem; muda quando muda uma zona", () => {
    const a = serviceParamsHash({ zones: { lisbon: [{ lat: 1, lng: 2, radiusM: 200 }] }, roles: DEFAULT_GARAGE_ROLES, window: [60, 5] });
    const b = serviceParamsHash({ window: [60, 5], roles: DEFAULT_GARAGE_ROLES, zones: { lisbon: [{ radiusM: 200, lng: 2, lat: 1 }] } });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(serviceParamsHash({ zones: { lisbon: [{ lat: 1, lng: 2, radiusM: 250 }] }, roles: DEFAULT_GARAGE_ROLES, window: [60, 5] })).not.toBe(a);
    expect(SERVICE_TIMES_CALC_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe("Q7 — tempos por condutor (médias por período, comparadas com os colegas)", () => {
  // Lisboa, T1: os colegas entregam entre 13 e 17 min; o condutor 7 entre 20 e 30 (o exemplo do Jorge)
  const day = (i: number) => `2026-0${4 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, "0")}`;
  const row = (emp: number, ourMin: number, i: number, extra: Partial<DriverRowLike> = {}): DriverRowLike => ({
    kind: "entrega", opDay: day(i), cityKey: "lisboa", terminalClass: "t1", outcome: "entregue", startEmployeeId: emp, deliverEmployeeId: emp,
    ourMs: ourMin * MIN, ourStatus: "medido", transitMs: (ourMin - 5) * MIN, transitStatus: "medido", queueMs: 5 * MIN, queueStatus: "medido", ...extra,
  });
  const rows: DriverRowLike[] = [];
  for (let i = 0; i < 40; i++) {
    rows.push(row(7, 20 + (i % 11), i));
    rows.push(row(1, 13 + (i % 5), i));
    rows.push(row(2, 14 + (i % 4), i));
  }
  rows.push(row(9, 15, 1)); // só uma entrega: sem dados suficientes
  rows.push(row(7, 99, 2, { outcome: "cancelado" }), row(7, 99, 3, { voidedAt: "2026-05-01 00:00:00" }), row(7, 99, 4, { ourStatus: "aproximado" }));
  rows.push(row(7, 10, 5, { cityKey: "porto" }));
  // portão aberto (o Jorge abriu-o depois da calibração); a cobertura do fixture passa os 60 %
  const open = { gate: { ...DEFAULT_GPS_GATE, visible: true }, isSuperAdmin: false };

  it("médias e percentis por condutor, cidade e tipo de serviço; os colegas sem ele; diferença do p50", () => {
    expect(driverPeriodRange("6meses", "2026-09-30")).toEqual({ fromDay: "2026-04-02", toDay: "2026-09-30" });
    const stats = driverTimeStats(rows, { metric: "nosso", fromDay: "2026-04-01", toDay: "2026-09-30", gpsGate: open });
    const me = stats.find((s) => s.employeeId === 7 && s.cityKey === "lisboa")!;
    expect(me).toMatchObject({ serviceType: "t1", n: 40, enough: true });
    expect(me.p50Ms! / MIN).toBeGreaterThanOrEqual(20);
    expect(me.peers.drivers).toBe(3);
    expect(me.peers.p50Ms! / MIN).toBeGreaterThanOrEqual(13);
    expect(me.peers.p50Ms! / MIN).toBeLessThanOrEqual(17);
    expect(me.deltaP50Ms! / MIN).toBeGreaterThan(5);
    // os colegas comparam-se com ele lá dentro
    expect(stats.find((s) => s.employeeId === 1 && s.cityKey === "lisboa")!.deltaP50Ms!).toBeLessThan(0);
    // n mínimo: com 1 entrega não há número
    expect(stats.find((s) => s.employeeId === 9)).toMatchObject({ n: 1, enough: false, p50Ms: null, meanMs: null, deltaP50Ms: null });
    // no Porto (outra cidade) não se mistura
    expect(stats.find((s) => s.employeeId === 7 && s.cityKey === "porto")).toMatchObject({ n: 1, enough: false });
    expect(DRIVER_STATS_MIN_N).toBe(10);
  });

  it("canceladas, anuladas e não medidas não contam; sem separar por tipo de serviço; outro tempo (Cliente → quem fez o check-out)", () => {
    const all = driverTimeStats(rows, { metric: "nosso", fromDay: "2026-01-01", toDay: "2026-12-31", byServiceType: false, gpsGate: open });
    expect(all.find((s) => s.employeeId === 7 && s.cityKey === "lisboa")).toMatchObject({ serviceType: "todos", n: 40 });
    const fila = driverTimeStats(rows, { metric: "fila", fromDay: "2026-01-01", toDay: "2026-12-31" });
    expect(fila.find((s) => s.employeeId === 7 && s.cityKey === "lisboa")!.n).toBe(41); // + a do Nosso aproximado (a Fila está medida); sem a cancelada nem a anulada
    expect(DRIVER_METRICS.cliente.employee({ ...rows[0], deliverEmployeeId: 3 })).toBe(3);
  });

  it("os tempos com GPS ficam marcados (portão); sem GPS: Fila, P2, até arrumado, Cliente da recolha", () => {
    expect(Object.entries(DRIVER_METRICS).filter(([, d]) => d.gps).map(([k]) => k).sort()).toEqual(["ate_garagem", "cliente", "nosso", "t2_atraso", "terminal", "transito"]);
    expect(Object.entries(DRIVER_METRICS).filter(([, d]) => !d.gps).map(([k]) => k).sort()).toEqual(["ate_arrumado", "cliente_recolha", "fila", "p2"]);
  });

  it("portão (§8.1) dentro das contas por condutor: sem portão = fechado; super admin vê \"em calibração\"; cobertura baixa = sem números; a Fila (sem GPS) vê-se sempre", () => {
    const closed = driverTimeStats(rows, { metric: "nosso", fromDay: "2026-04-01", toDay: "2026-09-30" });
    const me = closed.find((x) => x.employeeId === 7 && x.cityKey === "lisboa")!;
    expect(me).toMatchObject({ n: 40, enough: true, p50Ms: null, meanMs: null, deltaP50Ms: null, gpsHidden: "Em calibração" });
    expect(me.peers.p50Ms).toBeNull();
    const sa = driverTimeStats(rows, { metric: "nosso", fromDay: "2026-04-01", toDay: "2026-09-30", gpsGate: { gate: null, isSuperAdmin: true } }).find((x) => x.employeeId === 7 && x.cityKey === "lisboa")!;
    expect(sa.p50Ms).not.toBeNull();
    expect(sa).toMatchObject({ gpsHidden: null, gpsLabel: "em calibração" });
    // cobertura < 60 %: metade das entregas de Lisboa sem Trânsito medido
    const thin = rows.map((r, i) => (i % 2 ? { ...r, transitStatus: "sem_zello", ourStatus: "sem_zello" } : r));
    const low = driverTimeStats(thin, { metric: "nosso", fromDay: "2026-04-01", toDay: "2026-09-30", gpsGate: open }).find((x) => x.cityKey === "lisboa")!;
    expect(low.p50Ms).toBeNull();
    expect(low.gpsHidden).toMatch(/^Sem dados suficientes \(cobertura \d+ %, n = \d+\)$/);
    // a Fila não depende do GPS: vê-se com o portão fechado
    expect(driverTimeStats(rows, { metric: "fila", fromDay: "2026-04-01", toDay: "2026-09-30" }).find((x) => x.employeeId === 7 && x.cityKey === "lisboa")!.p50Ms).not.toBeNull();
    // série: fechado → sem números
    expect(driverTimeSeries(rows, { metric: "nosso", employeeId: 7, fromDay: "2026-04-01", toDay: "2026-05-31", bucket: "mes" })[0]).toMatchObject({ p50Ms: null, gpsHidden: "Em calibração" });
  });

  it("a Fila e o Nosso de um \"em entrega\" marcado por quem despacha (ou por um parceiro/sistema) não vão para ninguém", () => {
    const r = { ...rows[0], startEmployeeId: 9 };
    for (const st of ["condutor_por_confirmar", "condutor_fora_da_equipa", "condutor_desconhecido"]) {
      expect(DRIVER_METRICS.fila.employee({ ...r, transitStatus: st }), st).toBeNull();
      expect(DRIVER_METRICS.nosso.employee({ ...r, transitStatus: st }), st).toBeNull();
    }
    expect(DRIVER_METRICS.fila.employee({ ...r, transitStatus: "sem_zello" })).toBe(9);
  });

  it("evolução por semana/mês para o gráfico, com os colegas nas mesmas cidades e tipos", () => {
    const series = driverTimeSeries(rows, { metric: "nosso", employeeId: 7, fromDay: "2026-04-01", toDay: "2026-05-31", bucket: "mes", gpsGate: open });
    expect(series.map((x) => x.period)).toEqual(["2026-04", "2026-05"]);
    expect(series[0].p50Ms! / MIN).toBeGreaterThanOrEqual(20);
    expect(series[0].peersP50Ms! / MIN).toBeLessThanOrEqual(17);
    const weeks = driverTimeSeries(rows, { metric: "nosso", employeeId: 7, fromDay: "2026-04-01", toDay: "2026-04-30", bucket: "semana", gpsGate: open });
    expect(weeks[0].period).toBe("2026-03-30"); // a segunda-feira da semana de 1 abr
    expect(driverPeriodRange("semana", "2026-10-14")).toEqual({ fromDay: "2026-10-08", toDay: "2026-10-14" });
    expect(driverPeriodRange("mes", "2026-10-14").fromDay).toBe("2026-09-15");
  });
});
