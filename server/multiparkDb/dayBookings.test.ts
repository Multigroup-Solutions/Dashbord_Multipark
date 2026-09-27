import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("./client", async (importOriginal) => {
  const real = await importOriginal<typeof import("./client")>();
  return { ...real, multiparkDbQuery: (...args: any[]) => queryMock(...args) };
});

import { assertReadOnlySql } from "./client";
import {
  DAY_BOOKINGS_LIMIT, buildDayBookingsSql, buildParksSql, getMultiparkDayBookings, lisbonDayBounds, mapDayBookingRow, mapParks,
} from "./dayBookings";
import { allParkGroups, classifyPark, ourBrandOf } from "../../shared/multiparkParks";
import {
  classifyBookingChannel, filterMovements, movementDone, phaseLabel, summarizeDay, toDayMovements, type DayBooking,
} from "../../shared/reservasDoDia";

const ENV = "DATABASE_URL_MULTIPARK";
let savedEnv: string | undefined;
beforeEach(() => { savedEnv = process.env[ENV]; queryMock.mockReset(); });
afterEach(() => { if (savedEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv; });

describe("limites do dia de Lisboa", () => {
  it("verão: o dia começa às 23:00 UTC da véspera", () => {
    const b = lisbonDayBounds("2026-09-27");
    expect(b.start).toBe("2026-09-26 23:00:00");
    expect(b.end).toBe("2026-09-27 23:00:00");
    expect(b.wideStart).toBe("2026-09-25 23:00:00");
    expect(b.wideEnd).toBe("2026-09-28 23:00:00");
    expect(b.endMs - b.startMs).toBe(86_400_000);
  });
  it("inverno: meia-noite UTC", () => {
    const b = lisbonDayBounds("2026-01-15");
    expect(b.start).toBe("2026-01-15 00:00:00");
    expect(b.end).toBe("2026-01-16 00:00:00");
  });
  it("mudança de hora (25 out 2026): o dia tem 25 horas", () => {
    const b = lisbonDayBounds("2026-10-25");
    expect(b.start).toBe("2026-10-24 23:00:00");
    expect(b.end).toBe("2026-10-26 00:00:00");
  });
  it("dia inválido → erro", () => {
    expect(() => lisbonDayBounds("27/09/2026")).toThrow();
  });
});

describe("classificação dos parques", () => {
  it("marca nossa + cidade das três → grupo marca+cidade", () => {
    expect(classifyPark({ name: "Airpark Lisboa", city: "Lisboa" })).toMatchObject({ key: "airpark_lisboa", label: "Airpark Lisboa", ours: true });
    expect(classifyPark({ name: "Red Park", city: "Oporto" })).toMatchObject({ key: "redpark_porto", label: "Redpark Porto", ours: true });
    expect(classifyPark({ name: "SKYPARK Faro", city: null })).toMatchObject({ key: "skypark_faro", ours: true });
  });
  it("outros parques, ou marca nossa fora das três cidades → Marketplace", () => {
    expect(classifyPark({ name: "Top-Parking Lisboa", city: "Lisboa" })).toMatchObject({ key: "marketplace", label: "Marketplace", ours: false });
    expect(classifyPark({ name: "Boardingpark", city: "Porto" }).ours).toBe(false);
    expect(classifyPark({ name: "Airpark Madrid", city: "Madrid" }).key).toBe("marketplace");
    expect(classifyPark({}).key).toBe("marketplace");
  });
  it("marca pelo nome, sem acentos nem espaços", () => {
    expect(ourBrandOf("Aír Park")).toBe("airpark");
    expect(ourBrandOf("Parkdirect")).toBeNull();
  });
  it("ordem: Lisboa, Porto, Faro (Airpark, Redpark, Skypark) e o Marketplace no fim", () => {
    const labels = allParkGroups().map((g) => g.label);
    expect(labels.slice(0, 4)).toEqual(["Airpark Lisboa", "Redpark Lisboa", "Skypark Lisboa", "Airpark Porto"]);
    expect(labels[labels.length - 1]).toBe("Marketplace");
    expect(labels).toHaveLength(10);
  });
  it("mapParks: âmbito de cidade (com sinónimos) e ordenação", () => {
    const rows = [
      { id: "p3", name: "Parkvia Faro", city: "Faro" },
      { id: "p1", name: "Airpark", city: "Lisbon" },
      { id: "p2", name: "Redpark", city: "Porto" },
      { id: null, name: "sem id", city: "Lisboa" },
    ];
    expect(mapParks(rows).map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    expect(mapParks(rows, ["Lisboa"]).map((p) => p.id)).toEqual(["p1"]);
    expect(mapParks(rows, [])).toEqual([]);
  });
});

describe("origem: Direto vs Marketplace", () => {
  it("parceiro → Marketplace, com o nome e o tipo", () => {
    expect(classifyBookingChannel({ partnerId: "pa1", partnerName: "Parkos", partnerType: "AGGREGATOR", origin: "API" }))
      .toEqual({ channel: "marketplace", detail: "Parkos (agregador)" });
    expect(classifyBookingChannel({ partnerId: "pa2", partnerName: null, partnerType: "AGENCY" }).detail).toBe("Parceiro (agência)");
  });
  it("origem de terceiros ou cobrada por agregador → Marketplace", () => {
    expect(classifyBookingChannel({ origin: "MARKETPLACE" }).channel).toBe("marketplace");
    expect(classifyBookingChannel({ origin: "PARTNER_DASHBOARD" }).detail).toBe("Painel de parceiro");
    expect(classifyBookingChannel({ origin: "API", paymentSource: "PARKVIA" })).toEqual({ channel: "marketplace", detail: "Parkvia" });
  });
  it("site, formulário, manual, Stripe → Direto", () => {
    expect(classifyBookingChannel({ origin: "API", paymentSource: "STRIPE" })).toEqual({ channel: "direto", detail: "API / site" });
    expect(classifyBookingChannel({ origin: "MANUAL" }).channel).toBe("direto");
    expect(classifyBookingChannel({}).channel).toBe("direto");
  });
});

describe("SQL", () => {
  it("parques: leitura simples com LIMIT", () => {
    const { sql, params } = buildParksSql();
    expect(sql).toContain(`FROM "Park" p`);
    expect(sql).toMatch(/LIMIT 500$/);
    expect(params).toEqual([]);
    expect(() => assertReadOnlySql(sql)).not.toThrow();
  });
  it("reservas do dia: tudo parametrizado, índices por parque + data, LIMIT", () => {
    const b = lisbonDayBounds("2026-09-27");
    const evil = `x'); DROP TABLE "Booking"; --`;
    const { sql, params } = buildDayBookingsSql(b, ["park1", evil], 1001);
    expect(sql).not.toContain("DROP");
    expect(sql).toContain(`b."parkId" IN ($1, $2)`);
    expect(sql).toContain(`b."checkInDate" >= $5::timestamp AND b."checkInDate" < $6::timestamp AND b."checkIn" >= $3::timestamp AND b."checkIn" < $4::timestamp`);
    expect(sql).toContain(`b."checkOut" >= $3::timestamp AND b."checkOut" < $4::timestamp`);
    expect(sql).toContain("LIMIT $7");
    expect(params).toEqual(["park1", evil, "2026-09-26 23:00:00", "2026-09-27 23:00:00", "2026-09-25 23:00:00", "2026-09-28 23:00:00", 1001]);
    expect(() => assertReadOnlySql(sql)).not.toThrow();
  });
  it("teto do LIMIT e sem parques → erro", () => {
    const b = lisbonDayBounds("2026-09-27");
    expect(buildDayBookingsSql(b, ["p"], 99_999).params.at(-1)).toBe(DAY_BOOKINGS_LIMIT + 1);
    expect(() => buildDayBookingsSql(b, [])).toThrow();
  });
});

const ROW = {
  id: "cm1", code: "29484", status: "CHECKED_IN",
  check_in: "2026-09-27 07:30:00", check_out: "2026-10-02 18:00:00", check_in_time: "08:30", check_out_time: null,
  created_at: "2026-09-01 10:00:00", park_id: "p1",
  client_first_name: "Ana", client_last_name: "Silva", client_email: "ana@example.com", client_phone: "+351900000000",
  plate: "AA-00-BB", vehicle_brand: "Renault", vehicle_model: "Clio", vehicle_color: "Branco", vehicle_type: "CAR",
  departing_flight: "TP1234", departing_flight_eta: "2026-09-27 10:05:00", return_flight: "TP1235", return_flight_eta: null,
  delivery_type: "Terminal 1", delivery_location: null, origin: "API", payment_source: "PARKVIA",
  partner_id: null, partner_name: null, partner_type: null, garage: "Garagem A", spot: "B 12",
  price: "49.9", paid: 20, payment_method: "MBWAY", currency: "EUR", pro: "f", remarks: null,
  check_in_driver: "Rui", check_out_driver: null, cancelled_at: null, cancel_reason: null, customer_checkin_eta: 15,
  checking_in_at: "2026-09-27 07:20:00", moving_at: null, pending_checkout_at: null, checking_out_at: null,
  arrived_at_delivery_at: null, baggage_waiting_at: null, extras_count: "2", extras_pending: 1,
};
const PARK = { name: "Airpark", cityName: "Lisboa", key: "airpark_lisboa", label: "Airpark Lisboa", ours: true };

describe("mapeamento da linha", () => {
  it("linha → reserva (datas ISO UTC, números, grupo, canal)", () => {
    const b = mapDayBookingRow(ROW, PARK);
    expect(b).toMatchObject({
      id: "cm1", code: "29484", status: "CHECKED_IN",
      checkIn: "2026-09-27T07:30:00.000Z", checkOut: "2026-10-02T18:00:00.000Z", checkInTime: "08:30", checkOutTime: null,
      parkName: "Airpark", parkCity: "Lisboa", groupKey: "airpark_lisboa", groupLabel: "Airpark Lisboa", ours: true,
      clientName: "Ana Silva", plate: "AA-00-BB", vehicleBrand: "Renault",
      departingFlightEta: "2026-09-27T10:05:00.000Z", returnFlightEta: null,
      channel: "marketplace", channelDetail: "Parkvia",
      garage: "Garagem A", spot: "B 12", price: 49.9, paid: 20, toPay: 29.9, pro: false,
      extrasCount: 2, extrasPending: 1, customerCheckinEta: 15,
    });
    expect(b.phases.checkingInAt).toBe("2026-09-27T07:20:00.000Z");
  });
  it("parque desconhecido → Marketplace; preço em falta → sem 'falta pagar'", () => {
    const b = mapDayBookingRow({ ...ROW, price: null, paid: null, client_first_name: null, client_last_name: null }, undefined);
    expect(b.groupKey).toBe("marketplace");
    expect(b.toPay).toBeNull();
    expect(b.clientName).toBeNull();
  });
});

const day = lisbonDayBounds("2026-09-27");
const mk = (over: Partial<DayBooking>): DayBooking => ({ ...mapDayBookingRow(ROW, PARK), ...over });

describe("movimentos, filtros e contagens", () => {
  it("entrada e saída no mesmo dia → duas linhas, por hora; voo certo em cada uma", () => {
    const b = mk({ checkIn: "2026-09-27T06:00:00.000Z", checkOut: "2026-09-27T20:00:00.000Z", status: "BOOKED" });
    const out = toDayMovements([b, mk({ id: "cm2", checkIn: "2026-09-20T06:00:00.000Z", checkOut: "2026-09-27T05:00:00.000Z" })], day.startMs, day.endMs);
    expect(out.map((m) => m.key)).toEqual(["cm2:saida", "cm1:entrada", "cm1:saida"]);
    expect(out[1]).toMatchObject({ kind: "entrada", flight: "TP1234", done: false });
    expect(out[2]).toMatchObject({ kind: "saida", flight: "TP1235" });
  });
  it("fora do dia (23:30 de Lisboa da véspera = 22:30 UTC) não entra", () => {
    const b = mk({ checkIn: "2026-09-26T22:30:00.000Z", checkOut: "2026-09-26T23:00:00.000Z" });
    expect(toDayMovements([b], day.startMs, day.endMs).map((m) => m.kind)).toEqual(["saida"]);
  });
  it("feito: entrada quando o carro já entrou, saída quando foi entregue", () => {
    expect(movementDone("entrada", "MOVING")).toBe(true);
    expect(movementDone("entrada", "BOOKED")).toBe(false);
    expect(movementDone("saida", "PENDING_CHECKOUT")).toBe(false);
    expect(movementDone("saida", "CHECKED_OUT")).toBe(true);
  });
  it("fase: à espera da bagagem", () => {
    expect(phaseLabel(mk({ status: "PENDING_CHECKOUT", phases: { ...mk({}).phases, baggageWaitingAt: "2026-09-27T10:00:00.000Z" } }))).toBe("À espera da bagagem");
    expect(phaseLabel(mk({ status: "BOOKED" }))).toBeNull();
  });
  it("filtros: tipo, parque, estado (sem canceladas por omissão) e pesquisa", () => {
    const rows = toDayMovements([
      mk({ id: "a", code: "100", plate: "AA-11-BB", clientName: "Ana Silva", checkIn: "2026-09-27T08:00:00.000Z" }),
      mk({ id: "b", code: "200", plate: "CC-22-DD", clientName: "João Sá", parkId: "p2", checkOut: "2026-09-27T09:00:00.000Z", checkIn: "2026-09-20T08:00:00.000Z" }),
      mk({ id: "c", code: "300", status: "CANCELLED", checkIn: "2026-09-27T10:00:00.000Z" }),
    ], day.startMs, day.endMs);
    expect(filterMovements(rows, {}).map((m) => m.booking.id)).toEqual(["a", "b"]);
    expect(filterMovements(rows, { state: "todas" })).toHaveLength(3);
    expect(filterMovements(rows, { state: "CANCELLED" }).map((m) => m.booking.id)).toEqual(["c"]);
    expect(filterMovements(rows, { kind: "saida" }).map((m) => m.booking.id)).toEqual(["b"]);
    expect(filterMovements(rows, { parkId: "p2" }).map((m) => m.booking.id)).toEqual(["b"]);
    expect(filterMovements(rows, { search: "cc22" }).map((m) => m.booking.id)).toEqual(["b"]);
    expect(filterMovements(rows, { search: "joao" }).map((m) => m.booking.id)).toEqual(["b"]);
    expect(filterMovements(rows, { search: "100" }).map((m) => m.booking.id)).toEqual(["a"]);
  });
  it("contagens: entradas, saídas, por grupo, canceladas à parte", () => {
    const rows = toDayMovements([
      mk({ id: "a", status: "BOOKED", checkIn: "2026-09-27T08:00:00.000Z" }),
      mk({ id: "b", status: "CHECKED_OUT", groupKey: "marketplace", checkIn: "2026-09-20T08:00:00.000Z", checkOut: "2026-09-27T09:00:00.000Z" }),
      mk({ id: "c", status: "CANCELLED", checkIn: "2026-09-27T10:00:00.000Z", checkOut: "2026-09-27T12:00:00.000Z" }),
    ], day.startMs, day.endMs);
    const s = summarizeDay(rows);
    expect(s).toMatchObject({ entradas: 1, saidas: 1, canceladas: 1, entradasPorFazer: 1, saidasPorFazer: 0 });
    expect(s.groups.find((g) => g.key === "airpark_lisboa")).toMatchObject({ entradas: 1, saidas: 0 });
    expect(s.groups.find((g) => g.key === "marketplace")).toMatchObject({ entradas: 0, saidas: 1 });
  });
});

describe("leitura (com a BD simulada)", () => {
  it("sem DATABASE_URL_MULTIPARK → indisponível, sem consultas", async () => {
    delete process.env[ENV];
    const r = await getMultiparkDayBookings("2026-09-27");
    expect(r).toMatchObject({ available: false, code: "NOT_CONFIGURED" });
    expect(queryMock).not.toHaveBeenCalled();
  });
  it("parques do âmbito → reservas desses parques → movimentos", async () => {
    process.env[ENV] = "postgres://ro:x@db.example.com:5432/mp";
    queryMock
      .mockResolvedValueOnce([{ id: "p1", name: "Airpark", city: "Lisboa" }, { id: "p9", name: "Redpark", city: "Porto" }])
      .mockResolvedValueOnce([ROW]);
    const r = await getMultiparkDayBookings("2026-09-27", ["Lisboa"]);
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[1][1].slice(0, 1)).toEqual(["p1"]);
    expect(r.data.parks.map((p) => p.id)).toEqual(["p1"]);
    expect(r.data.movements.map((m) => m.key)).toEqual(["cm1:entrada"]);
    expect(r.data.movements[0].booking.groupLabel).toBe("Airpark Lisboa");
    expect(r.data.truncated).toBe(false);
  });
  it("sem parques no âmbito → lista vazia sem ler as reservas", async () => {
    process.env[ENV] = "postgres://ro:x@db.example.com:5432/mp";
    queryMock.mockResolvedValueOnce([{ id: "p9", name: "Redpark", city: "Porto" }]);
    const r = await getMultiparkDayBookings("2026-09-27", ["Faro"]);
    expect(r).toMatchObject({ available: true, data: { movements: [], parks: [] } });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
  it("mais do que o limite → cortada e assinalada", async () => {
    process.env[ENV] = "postgres://ro:x@db.example.com:5432/mp";
    queryMock
      .mockResolvedValueOnce([{ id: "p1", name: "Airpark", city: "Lisboa" }])
      .mockResolvedValueOnce(Array.from({ length: DAY_BOOKINGS_LIMIT + 1 }, (_, i) => ({ ...ROW, id: `b${i}` })));
    const r = await getMultiparkDayBookings("2026-09-27");
    expect(r.available && r.data.truncated).toBe(true);
    expect(r.available && r.data.movements.length).toBe(DAY_BOOKINGS_LIMIT);
  });
  it("erro da BD → indisponível (não lança)", async () => {
    process.env[ENV] = "postgres://ro:x@db.example.com:5432/mp";
    queryMock.mockRejectedValueOnce(new Error("canceling statement due to statement timeout"));
    const r = await getMultiparkDayBookings("2026-09-27");
    expect(r).toMatchObject({ available: false, code: "TIMEOUT" });
  });
});
