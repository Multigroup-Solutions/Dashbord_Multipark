import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("./client", async (importOriginal) => {
  const real = await importOriginal<typeof import("./client")>();
  return { ...real, multiparkDbQuery: (...args: any[]) => queryMock(...args) };
});

import { assertReadOnlySql } from "./client";
import { ParamList } from "./read";
import {
  CHILD_SQL, bookingScopeSql, buildChild, buildCoreSql, buildLocationSql, buildResolveSql, buildSignaturesSql,
  diffSnapshots, formatChange, formatDiffValue, getBookingFileAccounts, getBookingFileMain, getBookingFileTimeline,
  mapActivityRow, mapAttachmentRow, mapBillingRow, mapCancellationRow, mapCoreRow, mapExtraRow, mapHistoryRow,
  mapLink, mapLocationRow, mapPaymentRow, mapPricingRow, mapReviewRow, mergeTimeline, normalizeRef, normalizeSignature,
  openableUrl, parseModifiedFields, pickResolution, resolveBookingRef, summarizeSnapshot, type ChildKey,
} from "./bookingFile";

const ENV = "DATABASE_URL_MULTIPARK";
let savedEnv: string | undefined;
beforeEach(() => { savedEnv = process.env[ENV]; queryMock.mockReset(); });
afterEach(() => { if (savedEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv; });

describe("ficha — SQL", () => {
  it("todas as consultas passam a guarda de só-leitura e não levam dados do utilizador no texto", () => {
    const evil = `x'; DROP TABLE "Booking"; --`;
    const all = [
      buildResolveSql(evil, ["Lisboa"]), buildCoreSql(evil, ["Porto"]), buildLocationSql(evil), buildSignaturesSql(evil, []),
      ...(Object.keys(CHILD_SQL) as ChildKey[]).map((k) => buildChild(k, evil, ["Faro"])),
    ];
    for (const { sql, params } of all) {
      expect(() => assertReadOnlySql(sql)).not.toThrow();
      expect(sql).not.toContain("DROP");
      expect(params[0]).toContain("DROP");
      expect(sql).toMatch(/LIMIT (\$\d+|1)$/);
    }
  });

  it("âmbito de cidade: todas, nenhuma, ou EXISTS por Park.city com sinónimos", () => {
    const p = new ParamList();
    expect(bookingScopeSql(p, "$1", undefined)).toBe("TRUE");
    expect(bookingScopeSql(p, "$1", [])).toBe("FALSE");
    const p2 = new ParamList();
    p2.add("id");
    const s = bookingScopeSql(p2, "$1", ["Lisboa"]);
    expect(s).toContain(`sb."id" = $1`);
    expect(s).toContain(`lower(trim(sp."city")) IN ($2, $3)`);
    expect(p2.values).toEqual(["id", "lisboa", "lisbon"]);
  });

  it("as assinaturas não vêm na leitura principal (só o tamanho)", () => {
    const { sql } = buildCoreSql("b1");
    expect(sql).toContain(`- 'checkinSignature' - 'checkoutSignature'`);
    expect(sql).toContain(`length(to_jsonb(b) ->> 'checkinSignature')`);
  });

  it("resolver: id exato, n.º (allocation) ou referência externa, id primeiro", () => {
    const { sql, params } = buildResolveSql(" #29484 ");
    expect(params[0]).toBe("29484");
    expect(sql).toContain(`b."id" = $1 OR b."allocation" = $1 OR b."externalReference" = $1`);
    expect(sql).toContain(`ORDER BY (b."id" = $1) DESC`);
  });
});

describe("ficha — id vs n.º", () => {
  const row = (id: string, allocation = "29484") => ({ id, allocation, status: "BOOKED", park_name: "Airpark", park_city: "Lisboa", plate: "AA-00-BB" });

  it("normalizeRef limpa # e espaços", () => {
    expect(normalizeRef("  #29484 ")).toBe("29484");
    expect(normalizeRef("cmabc123")).toBe("cmabc123");
  });

  it("id exato ganha mesmo com outros candidatos", () => {
    expect(pickResolution("cm1", [row("cm2"), row("cm1")])).toEqual({ kind: "found", id: "cm1" });
  });

  it("um só candidato pelo n.º → encontrada", () => {
    expect(pickResolution("29484", [row("cm9")])).toEqual({ kind: "found", id: "cm9" });
  });

  it("n.º repetido entre parques → escolher, a não ser que a nossa BD desempate", () => {
    const r = pickResolution("29484", [row("cmA"), row("cmB")]);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.candidates.map((c) => c.id)).toEqual(["cmA", "cmB"]);
      expect(r.candidates[0]).toMatchObject({ code: "29484", statusLabel: "Reservada", parkName: "Airpark" });
    }
    expect(pickResolution("29484", [row("cmA"), row("cmB")], ["cmB"])).toEqual({ kind: "found", id: "cmB" });
  });

  it("nada → não encontrada", () => {
    expect(pickResolution("x", [])).toEqual({ kind: "not_found" });
  });

  it("resolveBookingRef usa a BD (mock) e passa a referência como parâmetro", async () => {
    process.env[ENV] = "postgres://u:p@h/db";
    queryMock.mockResolvedValueOnce([row("cm1")]);
    const r = await resolveBookingRef("#29484", ["Porto"]);
    expect(r).toEqual({ available: true, data: { kind: "found", id: "cm1" } });
    expect(queryMock.mock.calls[0][1]).toEqual(["29484", "porto", "oporto", 20]);
  });

  it("sem BD configurada → indisponível, sem consultas", async () => {
    delete process.env[ENV];
    const r = await resolveBookingRef("29484", undefined);
    expect(r.available).toBe(false);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("ficha — antes → depois", () => {
  it("objeto {campo:{from,to}}", () => {
    const c = parseModifiedFields(JSON.stringify({ status: { from: "BOOKED", to: "CHECKING_IN" }, bookingPrice: { from: 45, to: 50.5 } }));
    expect(c).toEqual([
      { field: "status", label: "Estado", from: "BOOKED", to: "CHECKING_IN" },
      { field: "bookingPrice", label: "Preço", from: "45", to: "50.5" },
    ]);
    expect(c.map(formatChange)).toEqual(["Estado: BOOKED → CHECKING_IN", "Preço: 45 → 50.5"]);
  });

  it("lista [{field,old,new}] e lista de nomes", () => {
    expect(parseModifiedFields([{ field: "spotId", old: null, new: "s1" }])).toEqual([{ field: "spotId", label: "Lugar", from: null, to: "s1" }]);
    expect(parseModifiedFields('["remarks","vehicleKms"]').map(formatChange)).toEqual(["Notas", "Km"]);
  });

  it("texto simples e valores vazios", () => {
    expect(parseModifiedFields("status: BOOKED -> CANCELLED").map(formatChange)).toEqual(["Estado: BOOKED → CANCELLED"]);
    expect(parseModifiedFields("remarks, spotId").map((c) => c.field)).toEqual(["remarks", "spotId"]);
    expect(parseModifiedFields("")).toEqual([]);
    expect(parseModifiedFields("{}")).toEqual([]);
    expect(parseModifiedFields(null)).toEqual([]);
  });

  it("formatação de valores: booleanos, datas UTC, vazios, objetos, textos longos", () => {
    expect(formatDiffValue(true)).toBe("sim");
    expect(formatDiffValue(false)).toBe("não");
    expect(formatDiffValue("")).toBeNull();
    expect(formatDiffValue(null)).toBeNull();
    expect(formatDiffValue("2026-03-02T10:00:00.000")).toBe("2026-03-02T10:00:00.000Z");
    expect(formatDiffValue({ a: 1 })).toBe('{"a":1}');
    expect(formatDiffValue("x".repeat(300))!.length).toBe(198);
    expect(formatChange({ field: "remarks", label: "Notas", from: "a", to: null })).toBe("Notas: a → —");
  });

  it("diferença de retratos ignora updatedAt e assinaturas", () => {
    const d = diffSnapshots({ status: "BOOKED", updatedAt: "1", checkinSignature: "a", vehicleKms: "100" }, { status: "CHECKED_IN", updatedAt: "2", checkinSignature: "b", vehicleKms: "100" });
    expect(d).toEqual([{ field: "status", label: "Estado", from: "BOOKED", to: "CHECKED_IN" }]);
    expect(diffSnapshots(null, { a: 1 })).toEqual([]);
  });

  it("resumo do retrato", () => {
    expect(summarizeSnapshot({ status: "CHECKED_IN", externalGarage: "G2", externalSpot: "14", vehicleKms: "52000", bookingPrice: 60, paymentMethod: "Dinheiro", checkInDriverName: "Rui" }))
      .toBe("No parque · lugar G2 14 · 52000 km · 60.00 € · Dinheiro · entrada: Rui");
    expect(summarizeSnapshot(null)).toBeNull();
    expect(summarizeSnapshot({})).toBeNull();
  });
});

describe("ficha — mapeadores", () => {
  const core = {
    booking: {
      id: "cm1", allocation: "29484", status: "CHECKED_IN", createdAt: "2026-09-01T10:00:00", checkingInAt: "2026-09-10T08:00:00", movingAt: "2026-09-10T08:10:00",
      checkInDate: "2026-09-10T00:00:00", checkInTime: "08:00", checkIn: "2026-09-10T08:05:00", checkOutDate: "2026-09-15T00:00:00", checkOutTime: "22:00",
      returnFlight: "TP1234", returnFlightEta: "2026-09-15T21:40:00", deliveryType: "Terminal 1", origin: "MARKETPLACE", partnerId: "pa1",
      partnerFeeType: "PERCENTAGE", partnerFeeValue: 20, bookingPrice: 60, originalBookingPrice: 55, currency: "EUR", paymentMethod: "Dinheiro",
      vehicleKms: "52000", language: "pt", taxNumber: "123456789", checkinVideo: "bookings/cm1/video.mp4",
      cashValidated: true, cashValidatedAt: "2026-09-15T23:00:00", cashValidatedByName: "Ana", driverValidated: false, cashierClosed: false,
      checkInDriverName: "Rui",
    },
    park: { id: "p1", name: "Airpark Lisboa", city: "Lisboa", listingType: "ON_PLATFORM", iban: "PT50…" },
    vehicle: { licensePlate: "AA-00-BB", brand: "VW", model: "Golf", color: "Azul", vehicleType: "CAR", seats: 5 },
    client: { firstName: "Maria", lastName: "Silva", email: "maria@example.com", phoneNumber: "+351900000000", nif: null, anonymizedAt: null },
    partner: { name: "Parkos", partnerType: "AGGREGATOR" },
    checkin_sig_len: 5000,
    checkout_sig_len: null,
  };

  it("cabeçalho, cliente, viatura, caixa e provas", () => {
    const m = mapCoreRow(core);
    expect(m).toMatchObject({
      id: "cm1", code: "29484", status: "CHECKED_IN", statusLabel: "No parque",
      checkIn: { day: "2026-09-10", time: "08:00", at: "2026-09-10T08:05:00.000Z" },
      flights: { return: { flight: "TP1234", eta: "2026-09-15T21:40:00.000Z" } },
      park: { name: "Airpark Lisboa", city: "Lisboa", ours: true, groupLabel: "Airpark Lisboa", listingType: "ON_PLATFORM" },
      origin: { channel: "marketplace", badge: "Marketplace", channelDetail: "Origem Marketplace · Parkos (agregador)", partnerName: "Parkos", partnerTypeLabel: "agregador", partnerFee: "20 %", label: "Marketplace" },
      price: { bookingPrice: 60, originalBookingPrice: 55, paymentMethod: "Dinheiro" },
      client: { name: "Maria Silva", email: "maria@example.com", nif: "123456789", language: "pt", anonymized: false },
      vehicle: { plate: "AA-00-BB", brand: "VW", kms: "52000" },
      agents: { checkIn: "Rui", checkOut: null },
      cashier: { cashValidated: { done: true, by: "Ana", at: "2026-09-15T23:00:00.000Z" }, driverValidated: { done: false } },
      evidence: { video: { raw: "bookings/cm1/video.mp4", url: null }, hasCheckinSignature: true, hasCheckoutSignature: false },
    });
    expect(m.phases.map((p) => p.key)).toEqual(["createdAt", "checkingInAt", "movingAt"]);
    expect(JSON.stringify(m)).not.toContain("PT50");
  });

  it("linha vazia não rebenta (colunas em falta)", () => {
    const m = mapCoreRow({ booking: { id: "x" } });
    expect(m.statusLabel).toBe("—");
    expect(m.park.ours).toBe(false);
    expect(m.origin.channel).toBe("marketplace");
    expect(m.evidence.video).toBeNull();
  });

  it("canal pelo classificador único (Direto / Parceiro / Marketplace)", () => {
    const withB = (booking: Record<string, unknown>, park: Record<string, unknown> = core.park, partner: Record<string, unknown> | undefined = undefined) =>
      mapCoreRow({ ...core, booking: { ...core.booking, partnerId: null, ...booking }, park, partner });
    expect(withB({ origin: "API" }).origin).toMatchObject({ channel: "direto", badge: "Direto" });
    expect(withB({ origin: "PARTNER_API" }).origin).toMatchObject({ channel: "parceiro", channelDetail: "API de parceiro" });
    expect(withB({ origin: "API", partnerId: "pa1" }, core.park, { name: "Viagens Lda", partnerType: "AGENCY" }).origin)
      .toMatchObject({ channel: "parceiro", badge: "Parceiro · Viagens Lda", partnerTypeLabel: "agência" });
    expect(withB({ origin: "API", paymentSource: "PARKOS" }).origin.badge).toBe("Parceiro · Parkos");
    // firebaseBrand manda na marca: parque de outra marca → Marketplace.
    const other = withB({ origin: "API" }, { ...core.park, firebaseBrand: "TopParking" });
    expect(other.park).toMatchObject({ ours: false, groupLabel: "Marketplace", firebaseBrand: "TopParking" });
    expect(other.origin).toMatchObject({ channel: "marketplace", channelDetail: "Parque de terceiros" });
  });

  it("links: só http(s) abre; GPS inválido não dá mapa", () => {
    expect(openableUrl("https://firebasestorage.googleapis.com/x")).toBe("https://firebasestorage.googleapis.com/x");
    expect(openableUrl("bookings/cm1/v.mp4")).toBeNull();
    expect(mapLink(38.77, -9.13)).toBe("https://www.google.com/maps?q=38.77,-9.13");
    expect(mapLink(0, 0)).toBeNull();
    expect(mapLink(null, 1)).toBeNull();
  });

  it("lugar, anexos, contas, extras, avaliação", () => {
    expect(mapLocationRow({ b: { allocation: "29484", externalGarage: "G2" }, spot: { row: "A", spot: "14", hasCharger: true }, garage: { name: "Garagem 2", mapLink: "https://maps.app/x" }, alloc: null }))
      .toMatchObject({ code: "29484", spot: { row: "A", spot: "14", hasCharger: true }, garage: { name: "Garagem 2", mapLink: "https://maps.app/x" }, allocation: null, external: { garage: "G2" } });
    expect(mapLocationRow(undefined)).toBeNull();
    expect(mapAttachmentRow({ a: { id: "a1", type: "VEHICLE_PHOTO", url: "https://x/y.jpg" } })).toMatchObject({ typeLabel: "Foto da viatura", url: "https://x/y.jpg" });
    expect(mapAttachmentRow({ a: { id: "a2", type: "VEHICLE_VIDEO", url: "internal/path" } }).url).toBeNull();
    expect(mapPricingRow({ l: { id: "l1", description: "Estacionamento", category: "PARKING", total: 50, amountPaid: 50, paymentMethod: "MB" } })).toMatchObject({ total: 50, amountPaid: 50, category: "PARKING" });
    expect(mapPaymentRow({ pay: { id: "p1", amount: 10, paymentMethod: "Dinheiro", recordedAt: "2026-09-15T22:00:00" }, line: "Valet" })).toMatchObject({ line: "Valet", recordedAt: "2026-09-15T22:00:00.000Z" });
    expect(mapBillingRow({ bi: { id: "f1", invoice: "FT 2026/123", invoiceExpressId: 99, emited: true, amount: 60 } })).toMatchObject({ invoice: "FT 2026/123", emitted: true });
    expect(mapCancellationRow({ ca: { cancellationType: "Duplicada", cancellationObs: "", refund: true, refunded: false, refundedAmount: 0 } })).toMatchObject({ type: "Duplicada", notes: null, refund: true, refunded: false });
    expect(mapCancellationRow(undefined)).toBeNull();
    expect(mapExtraRow({ e: { id: "e1", name: "Lavagem", price: 15, done: true }, catalog_name: "Lavagem", catalog_price: 12 })).toMatchObject({ inCatalog: true, catalogPrice: 12, done: true });
    expect(mapReviewRow({ r: { rating: 5, comment: "Ótimo", clientName: "Maria" } })).toMatchObject({ rating: 5, text: "Ótimo" });
  });

  it("histórico e auditoria → linha do tempo ordenada", () => {
    const h = mapHistoryRow({ h: { id: "h1", changeType: "MOVEMENT", actionTime: "2026-09-10T09:00:00", lat: 38.7, lng: -9.1, platform: "android", modifiedFields: '{"spotId":{"from":null,"to":"s1"}}' }, snap: { status: "CHECKED_IN" }, agent: "Rui" });
    expect(h).toMatchObject({ id: "h:h1", kindLabel: "Movimento", who: "Rui", gps: { url: "https://www.google.com/maps?q=38.7,-9.1" }, snapshotSummary: "No parque" });
    expect(h.changes.map(formatChange)).toEqual(["Lugar: — → s1"]);
    const a = mapActivityRow({ ae: { id: "a1", eventType: "BOOKING_UPDATED", timestamp: "2026-09-11T09:00:00", actorDisplayName: "Ana", actorRole: "ADMIN", previousSnapshot: { bookingPrice: 55 }, snapshot: { bookingPrice: 60 } } });
    expect(a.changes.map(formatChange)).toEqual(["Preço: 55 → 60"]);
    expect(mergeTimeline([h], [a]).map((t) => t.id)).toEqual(["a:a1", "h:h1"]);
  });

  it("assinaturas: base64 cru, data URI, link, caminho interno", () => {
    const b64 = "iVBORw0KGgo" + "A".repeat(60);
    expect(normalizeSignature(b64)).toEqual({ kind: "image", src: `data:image/png;base64,${b64}` });
    expect(normalizeSignature(`data:image/png;base64,${b64}`)).toEqual({ kind: "image", src: `data:image/png;base64,${b64}` });
    expect(normalizeSignature("https://s3/x.png")).toEqual({ kind: "link", url: "https://s3/x.png" });
    expect(normalizeSignature("signatures/cm1.png")).toEqual({ kind: "internal", raw: "signatures/cm1.png" });
    expect(normalizeSignature("")).toBeNull();
  });
});

describe("ficha — degradação por parte", () => {
  it("uma tabela em falta só esvazia essa parte", async () => {
    process.env[ENV] = "postgres://u:p@h/db";
    queryMock
      .mockResolvedValueOnce([{ l: { id: "l1", total: 10, amountPaid: 10 } }]) // pricing
      .mockRejectedValueOnce(new Error('relation "BookingPricingPayment" does not exist')) // payments
      .mockResolvedValueOnce([]) // billing
      .mockResolvedValueOnce([]); // cancellation
    const r = await getBookingFileAccounts("cm1", undefined);
    expect(r.available).toBe(true);
    if (r.available) {
      expect(r.data.data.pricing).toHaveLength(1);
      expect(r.data.data.payments).toEqual([]);
      expect(r.data.missing.map((m) => m.part)).toEqual(["payments"]);
    }
  });

  it("tudo falha → secção indisponível com motivo", async () => {
    process.env[ENV] = "postgres://u:p@h/db";
    queryMock.mockRejectedValue(new Error("canceling statement due to statement timeout"));
    const r = await getBookingFileTimeline("cm1", undefined);
    expect(r).toMatchObject({ available: false, code: "TIMEOUT" });
  });

  it("sem configuração → indisponível sem consultas", async () => {
    delete process.env[ENV];
    const r = await getBookingFileMain("cm1", undefined);
    expect(r.available).toBe(false);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
