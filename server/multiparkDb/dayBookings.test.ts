import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("./client", async (importOriginal) => {
  const real = await importOriginal<typeof import("./client")>();
  return { ...real, multiparkDbQuery: (...args: any[]) => queryMock(...args) };
});

import { assertReadOnlySql } from "./client";
import {
  DAY_BOOKINGS_LIMIT, buildDayBookingsSql, buildParksSql, getMultiparkDayBookings, getMultiparkParkClassification, lisbonDayBounds, mapDayBookingRow, mapParks,
} from "./dayBookings";
import { allParkGroups, classifyBookingChannel, classifyPark, ourBrandOf } from "../../shared/multiparkParks";
import {
  excludeParks, filterMovements, groupMovements, movementDone, operationalParkGroup, phaseLabel, summarizeDay, toDayMovements, type DayBooking,
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

describe("classificação dos parques: firebaseBrand", () => {
  it("firebaseBrand preenchido manda (normalizado), mesmo que o nome não tenha a marca", () => {
    expect(classifyPark({ name: "Parque do Aeroporto", city: "Lisboa", firebaseBrand: "  AIR park " }))
      .toMatchObject({ key: "airpark_lisboa", ours: true, brand: "airpark", brandSource: "firebaseBrand" });
    expect(classifyPark({ name: "P2", city: "Faro", firebaseBrand: "Skypark" }).key).toBe("skypark_faro");
  });
  it("firebaseBrand de outra marca → Marketplace, mesmo com 'Airpark' no nome", () => {
    const c = classifyPark({ name: "Airpark Lisboa (antigo)", city: "Lisboa", firebaseBrand: "TopParking" });
    expect(c).toMatchObject({ key: "marketplace", ours: false, brandSource: "firebaseBrand" });
    expect(c.reason).toContain("TopParking");
  });
  it("firebaseBrand vazio/nulo → marca pelo nome", () => {
    expect(classifyPark({ name: "Redpark Porto", city: "Porto", firebaseBrand: "" })).toMatchObject({ key: "redpark_porto", brandSource: "name" });
    expect(classifyPark({ name: "Redpark Porto", city: "Porto", firebaseBrand: null }).brandSource).toBe("name");
  });
  it("cidade: o campo cidade manda; o nome só quando a cidade está vazia", () => {
    expect(classifyPark({ name: "Skypark Faro", city: "" })).toMatchObject({ key: "skypark_faro", citySource: "name" });
    expect(classifyPark({ name: "Airpark Lisboa", city: "Madrid" }).key).toBe("marketplace");
  });
  it("listingType só se expõe (não muda a classificação)", () => {
    expect(classifyPark({ name: "Airpark", city: "Lisboa", listingType: "directory" })).toMatchObject({ ours: true, listingType: "DIRECTORY" });
    expect(classifyPark({ name: "Parkvia", city: "Lisboa", listingType: "ON_PLATFORM" })).toMatchObject({ ours: false, listingType: "ON_PLATFORM" });
  });
  it("mapParks lê firebaseBrand, listingType e status", () => {
    const [p] = mapParks([{ id: "p1", name: "Parque X", city: "Porto", firebase_brand: "redpark", listing_type: "ON_PLATFORM", status: "ACTIVE" }]);
    expect(p).toMatchObject({ key: "redpark_porto", firebaseBrand: "redpark", listingType: "ON_PLATFORM", status: "ACTIVE", brandSource: "firebaseBrand" });
  });
});

describe("canal: Direto / Parceiro / Marketplace", () => {
  const ours = { parkOurs: true };
  it("parque que não é nosso → Marketplace, seja qual for a origem", () => {
    expect(classifyBookingChannel({ parkOurs: false, origin: "API", paymentSource: "STRIPE" })).toMatchObject({ channel: "marketplace", badge: "Marketplace", detail: "Parque de terceiros" });
    expect(classifyBookingChannel({ parkOurs: false, partnerId: "pa1", partnerName: "Parkos", partnerType: "AGGREGATOR" }).detail).toBe("Parque de terceiros · Parkos (agregador)");
  });
  it("origem MARKETPLACE num parque nosso → Marketplace (ganha ao parceiro)", () => {
    expect(classifyBookingChannel({ ...ours, origin: "MARKETPLACE" })).toMatchObject({ channel: "marketplace", detail: "Origem Marketplace" });
    expect(classifyBookingChannel({ ...ours, origin: "marketplace", partnerId: "pa1", partnerName: "X" }).channel).toBe("marketplace");
  });
  it("parceiro ligado → Parceiro com nome e tipo (agência / agregador / parceiro)", () => {
    expect(classifyBookingChannel({ ...ours, partnerId: "pa1", partnerName: "Parkos", partnerType: "AGGREGATOR", origin: "API" }))
      .toEqual({ channel: "parceiro", detail: "Parkos (agregador)", partnerName: "Parkos", partnerTypeLabel: "agregador", badge: "Parceiro · Parkos" });
    expect(classifyBookingChannel({ ...ours, partnerId: "pa2", partnerName: "Viagens Lda", partnerType: "AGENCY" }).detail).toBe("Viagens Lda (agência)");
    expect(classifyBookingChannel({ ...ours, partnerId: "pa3", partnerName: "Hotel Y", partnerType: "PARTNER" }).partnerTypeLabel).toBe("parceiro");
    expect(classifyBookingChannel({ ...ours, partnerId: "pa4", partnerName: null, partnerType: null })).toMatchObject({ detail: "Parceiro", badge: "Parceiro · Parceiro" });
  });
  it("origem de parceiro (API / painel) sem partnerId → Parceiro", () => {
    expect(classifyBookingChannel({ ...ours, origin: "PARTNER_API" })).toMatchObject({ channel: "parceiro", detail: "API de parceiro", badge: "Parceiro" });
    expect(classifyBookingChannel({ ...ours, origin: "PARTNER_DASHBOARD" }).detail).toBe("Painel de parceiro");
  });
  it("paymentSource de agregador só como pista quando não há partnerId", () => {
    expect(classifyBookingChannel({ ...ours, origin: "API", paymentSource: "PARKVIA" })).toMatchObject({ channel: "parceiro", partnerName: "Parkvia", badge: "Parceiro · Parkvia" });
    expect(classifyBookingChannel({ ...ours, paymentSource: "AGGREGATOR_OTHER" }).channel).toBe("parceiro");
    // Com partnerId, o parceiro manda (não o agregador que cobrou).
    expect(classifyBookingChannel({ ...ours, partnerId: "pa1", partnerName: "Agência Z", partnerType: "AGENCY", paymentSource: "PARKOS" }).partnerName).toBe("Agência Z");
  });
  it("site, formulário, manual, Stripe num parque nosso → Direto", () => {
    expect(classifyBookingChannel({ ...ours, origin: "API", paymentSource: "STRIPE" })).toMatchObject({ channel: "direto", detail: "API / site", badge: "Direto" });
    expect(classifyBookingChannel({ ...ours, origin: "MANUAL" }).channel).toBe("direto");
    expect(classifyBookingChannel(ours).channel).toBe("direto");
  });
});

describe("SQL", () => {
  it("parques: leitura simples com LIMIT", () => {
    const { sql, params } = buildParksSql();
    expect(sql).toContain(`FROM "Park" p`);
    expect(sql).toContain(`p."firebaseBrand"`);
    expect(sql).toContain(`p."listingType"::text`);
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
const PARK = { id: "p1", name: "Airpark", cityName: "Lisboa", key: "airpark_lisboa", label: "Airpark Lisboa", ours: true, order: 0 };

describe("mapeamento da linha", () => {
  it("linha → reserva (datas ISO UTC, números, grupo operacional; sem canal)", () => {
    const b = mapDayBookingRow(ROW, PARK);
    expect(b).toMatchObject({
      id: "cm1", code: "29484", status: "CHECKED_IN",
      checkIn: "2026-09-27T07:30:00.000Z", checkOut: "2026-10-02T18:00:00.000Z", checkInTime: "08:30", checkOutTime: null,
      parkName: "Airpark", parkCity: "Lisboa", groupKey: "airpark_lisboa", groupLabel: "Airpark Lisboa", groupOrder: 0, ours: true,
      clientName: "Ana Silva", plate: "AA-00-BB", vehicleBrand: "Renault",
      departingFlightEta: "2026-09-27T10:05:00.000Z", returnFlightEta: null,
      origin: "API", paymentSource: "PARKVIA",
      garage: "Garagem A", spot: "B 12", price: 49.9, paid: 20, toPay: 29.9, pro: false,
      extrasCount: 2, extrasPending: 1, customerCheckinEta: 15,
    });
    expect(b.phases.checkingInAt).toBe("2026-09-27T07:20:00.000Z");
    expect(b).not.toHaveProperty("channel");
    expect(b).not.toHaveProperty("channelBadge");
  });
  it("parque de terceiros → o seu próprio grupo (nome do parque), sem Marketplace", () => {
    const other = { id: "p7", name: "Top-Parking Lisboa", cityName: "Lisboa", ...classifyPark({ name: "Top-Parking Lisboa", city: "Lisboa" }) };
    const b = mapDayBookingRow({ ...ROW, park_id: "p7" }, other);
    expect(b).toMatchObject({ groupKey: "park:p7", groupLabel: "Top-Parking Lisboa", ours: false, groupOrder: 1000 });
  });
  it("parque desconhecido → grupo próprio; preço em falta → sem 'falta pagar'", () => {
    const b = mapDayBookingRow({ ...ROW, price: null, paid: null, client_first_name: null, client_last_name: null }, undefined);
    expect(b).toMatchObject({ groupKey: "park:p1", groupLabel: "Parque desconhecido", ours: false });
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
      mk({ id: "b", status: "CHECKED_OUT", groupKey: "park:p7", groupLabel: "Top-Parking", groupOrder: 1000, ours: false, checkIn: "2026-09-20T08:00:00.000Z", checkOut: "2026-09-27T09:00:00.000Z" }),
      mk({ id: "c", status: "CANCELLED", checkIn: "2026-09-27T10:00:00.000Z", checkOut: "2026-09-27T12:00:00.000Z" }),
    ], day.startMs, day.endMs);
    const s = summarizeDay(rows);
    expect(s).toMatchObject({ entradas: 1, saidas: 1, canceladas: 1, entradasPorFazer: 1, saidasPorFazer: 0 });
    expect(s.groups.find((g) => g.key === "airpark_lisboa")).toMatchObject({ entradas: 1, saidas: 0 });
    expect(s.groups.find((g) => g.key === "park:p7")).toMatchObject({ entradas: 0, saidas: 1 });
    expect(s.groups.map((g) => g.key)).toEqual(["airpark_lisboa", "park:p7"]);
    expect(s).not.toHaveProperty("channels");
  });
});

describe("grupos operacionais (um por parque)", () => {
  const cls = (id: string, name: string, city: string) => ({ id, name, ...classifyPark({ name, city }) });
  it("marca nossa + cidade → grupo da marca; outro parque → o próprio parque", () => {
    expect(operationalParkGroup(cls("a", "Airpark", "Porto"))).toEqual({ key: "airpark_porto", label: "Airpark Porto", ours: true, order: 3 });
    expect(operationalParkGroup(cls("x", "Parkvia Faro", "Faro"))).toEqual({ key: "park:x", label: "Parkvia Faro", ours: false, order: 1000 });
    expect(operationalParkGroup({ id: "y", name: null, key: "marketplace", label: "Marketplace", ours: false }).label).toBe("y");
  });
  it("ordem: marcas nossas (Lisboa, Porto, Faro × Airpark, Redpark, Skypark) e depois os outros por nome", () => {
    const parks = [
      cls("z", "Zeta Parking", "Lisboa"), cls("s", "Skypark", "Lisboa"), cls("f", "Airpark", "Faro"),
      cls("b", "boardingpark", "Porto"), cls("a", "Airpark", "Lisboa"), cls("r", "Redpark", "Porto"), cls("c", "Ávila Park", "Faro"),
    ];
    const rows = toDayMovements(
      parks.map((p, i) => mapDayBookingRow({ ...ROW, id: `b${i}`, park_id: p.id, check_in: `2026-09-27 ${String(8 + i).padStart(2, "0")}:00:00` }, p)),
      day.startMs, day.endMs,
    );
    const sections = groupMovements(rows);
    expect(sections.map((g) => g.label)).toEqual([
      "Airpark Lisboa", "Skypark Lisboa", "Redpark Porto", "Airpark Faro", "Ávila Park", "boardingpark", "Zeta Parking",
    ]);
    expect(sections.every((g) => g.rows.length === 1)).toBe(true);
    expect(sections.some((g) => g.label === "Marketplace")).toBe(false);
    expect(summarizeDay(rows).groups.map((g) => g.label)).toEqual(sections.map((g) => g.label));
  });
  it("dois parques da mesma marca + cidade ficam no mesmo bloco", () => {
    const p1 = cls("a1", "Airpark", "Lisboa");
    const p2 = cls("a2", "Airpark Premium", "Lisboa");
    const rows = toDayMovements([mapDayBookingRow({ ...ROW, id: "x1", park_id: "a1" }, p1), mapDayBookingRow({ ...ROW, id: "x2", park_id: "a2" }, p2)], day.startMs, day.endMs);
    expect(groupMovements(rows).map((g) => [g.key, g.rows.length])).toEqual([["airpark_lisboa", 2]]);
  });
  it("excludeParks: tira os ids da lista; lista vazia não muda nada", () => {
    const ps = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(excludeParks(ps, ["b", "zz"]).map((p) => p.id)).toEqual(["a", "c"]);
    expect(excludeParks(ps, [])).toBe(ps);
    expect(excludeParks(ps, null)).toBe(ps);
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
    expect(r.data.excludedParks).toBe(0);
  });
  it("todos os parques (também os de terceiros) menos os que a operação não faz", async () => {
    process.env[ENV] = "postgres://ro:x@db.example.com:5432/mp";
    queryMock
      .mockResolvedValueOnce([
        { id: "p1", name: "Airpark", city: "Lisboa" },
        { id: "p5", name: "Boardingpark", city: "Lisboa" },
        { id: "p6", name: "Parque Não Operado", city: "Lisboa" },
        // 28a: na lista dos que não operamos (pelo nome) — fica sempre fora
        { id: "p7", name: "Top-Parking", city: "Lisboa" },
      ])
      .mockResolvedValueOnce([ROW, { ...ROW, id: "cm5", park_id: "p5" }]);
    const r = await getMultiparkDayBookings("2026-09-27", undefined, ["p6"]);
    expect(r.available).toBe(true);
    if (!r.available) return;
    // A leitura das reservas só pede os parques operados (p6 fica de fora no SQL).
    expect(queryMock.mock.calls[1][1].slice(0, 2)).toEqual(["p1", "p5"]);
    expect(queryMock.mock.calls[1][0]).toContain(`b."parkId" IN ($1, $2)`);
    expect(r.data.parks.map((p) => p.id)).toEqual(["p1", "p5"]);
    expect(r.data.parks.map((p) => p.groupLabel)).toEqual(["Airpark Lisboa", "Boardingpark"]);
    expect(r.data.excludedParks).toBe(2);
    expect(r.data.movements.map((m) => m.booking.groupLabel)).toEqual(["Airpark Lisboa", "Boardingpark"]);
  });
  it("todos os parques excluídos → lista vazia sem ler as reservas", async () => {
    process.env[ENV] = "postgres://ro:x@db.example.com:5432/mp";
    queryMock.mockResolvedValueOnce([{ id: "p1", name: "Airpark", city: "Lisboa" }]);
    const r = await getMultiparkDayBookings("2026-09-27", undefined, ["p1"]);
    expect(r).toMatchObject({ available: true, data: { movements: [], parks: [], excludedParks: 1 } });
    expect(queryMock).toHaveBeenCalledTimes(1);
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
  it("classificação dos parques: leitura leve, com âmbito", async () => {
    process.env[ENV] = "postgres://ro:x@db.example.com:5432/mp";
    queryMock.mockResolvedValueOnce([
      { id: "p1", name: "Parque A", city: "Lisboa", firebase_brand: "Airpark", listing_type: "ON_PLATFORM", status: "ACTIVE" },
      { id: "p2", name: "Outro", city: "Porto", firebase_brand: null, listing_type: "DIRECTORY", status: "INACTIVE" },
    ]);
    const r = await getMultiparkParkClassification(["Lisboa"]);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(r.available && r.data.parks).toEqual([expect.objectContaining({ id: "p1", ours: true, label: "Airpark Lisboa", firebaseBrand: "Airpark", listingType: "ON_PLATFORM", status: "ACTIVE" })]);
  });
  it("erro da BD → indisponível (não lança)", async () => {
    process.env[ENV] = "postgres://ro:x@db.example.com:5432/mp";
    queryMock.mockRejectedValueOnce(new Error("canceling statement due to statement timeout"));
    const r = await getMultiparkDayBookings("2026-09-27");
    expect(r).toMatchObject({ available: false, code: "TIMEOUT" });
  });
});
