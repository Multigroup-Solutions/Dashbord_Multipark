/**
 * Lote 42d — Reservas (Jorge, 7 out 2026): alertas mais pequenos, de lado e
 * que se tiram (nada se apaga; "Repor" volta a mostrar); Reservas do dia por
 * cidade, por hora (o que entra e o que sai) e por marca com o Marketplace à
 * parte (parques que não são nossos + as nossas marcas vindas pelo
 * Marketplace); a cidade do parque também pelo nome.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { dayBucketOf, filterMovements, lisbonClockHour, summarizeByCity, type DayBooking, type DayMovement } from "../shared/reservasDoDia";
import { mapParks } from "./multiparkDb/dayBookings";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const booking = (o: Partial<DayBooking> & { id: string }): DayBooking => ({
  code: o.id, status: "BOOKED", checkIn: null, checkOut: null, checkInTime: null, checkOutTime: null, createdAt: null,
  parkId: "p1", parkName: "Airpark", parkCity: "Lisboa", cityKey: "lisboa", brand: "airpark",
  groupKey: "airpark_lisboa", groupLabel: "Airpark Lisboa", groupOrder: 0, ours: true,
  clientName: null, clientEmail: null, clientPhone: null, plate: null, vehicleBrand: null, vehicleModel: null, vehicleColor: null, vehicleType: null,
  departingFlight: null, departingFlightEta: null, returnFlight: null, returnFlightEta: null, deliveryType: null, deliveryLocation: null,
  extrasCount: 0, extrasPending: 0, origin: "API", paymentSource: null, partnerId: null, partnerName: null, partnerType: null,
  garage: null, spot: null, price: null, paid: null, toPay: null, paymentMethod: null, currency: "EUR", pro: false, remarks: null,
  checkInDriverName: null, checkOutDriverName: null, cancelledAt: null, cancelReason: null, customerCheckinEta: null,
  phases: { checkingInAt: null, movingAt: null, pendingCheckoutAt: null, checkingOutAt: null, arrivedAtDeliveryAt: null, baggageWaitingAt: null },
  ...o,
});
const move = (b: DayBooking, kind: "entrada" | "saida", at: string, done = false): DayMovement => ({ key: `${b.id}:${kind}`, kind, at, flight: null, flightEta: null, done, booking: b });

describe("42d — Marketplace", () => {
  it("parques que não são nossos e as nossas marcas vindas pelo Marketplace contam no Marketplace; o resto na marca", () => {
    expect(dayBucketOf({ ours: false, brand: null, origin: "API", paymentSource: null, partnerId: null })).toBe("marketplace"); // Travelparking
    expect(dayBucketOf({ ours: true, brand: "airpark", origin: "MARKETPLACE", paymentSource: null, partnerId: null })).toBe("marketplace");
    expect(dayBucketOf({ ours: true, brand: "redpark", origin: "API", paymentSource: null, partnerId: null })).toBe("redpark");
    // parceiro num parque nosso continua na marca (o canal Parceiro é da contabilidade)
    expect(dayBucketOf({ ours: true, brand: "skypark", origin: "PARTNER_API", paymentSource: null, partnerId: "x" })).toBe("skypark");
    // marca nossa fora das 3 cidades não é nossa → Marketplace
    expect(dayBucketOf({ ours: false, brand: "airpark", origin: "API", paymentSource: null, partnerId: null })).toBe("marketplace");
  });
});

describe("42d — por cidade e por hora", () => {
  // 7 out 2026 = hora de verão (UTC+1)
  const a = booking({ id: "a" });
  const mk = booking({ id: "mk", origin: "MARKETPLACE" });
  const tp = booking({ id: "tp", ours: false, brand: null, parkName: "Travelparking", groupKey: "park:t", groupLabel: "Travelparking" });
  const bp = booking({ id: "bp", ours: false, brand: null, parkName: "Boardingpark", cityKey: "porto", parkCity: "Porto", groupKey: "park:b", groupLabel: "Boardingpark" });
  const rp = booking({ id: "rp", brand: "redpark", parkName: "Redpark", cityKey: "porto", parkCity: "Porto" });
  const cx = booking({ id: "cx", status: "CANCELLED" });
  const rows = [
    move(a, "entrada", "2026-10-07T07:30:00Z", true), move(a, "saida", "2026-10-07T17:10:00Z"),
    move(mk, "entrada", "2026-10-07T07:45:00Z"), move(tp, "saida", "2026-10-07T07:05:00Z"),
    move(bp, "entrada", "2026-10-07T09:00:00Z"), move(rp, "saida", "2026-10-07T22:30:00Z"),
    move(cx, "entrada", "2026-10-07T07:00:00Z"),
  ];

  it("hora do relógio de Lisboa", () => {
    expect(lisbonClockHour("2026-10-07T07:30:00Z")).toBe(8);
    expect(lisbonClockHour("2026-10-07T22:30:00Z")).toBe(23);
    expect(lisbonClockHour("2026-12-07T22:30:00Z")).toBe(22); // inverno
    expect(lisbonClockHour("lixo")).toBe(-1);
  });

  it("Lisboa e Porto, sem as canceladas; marcas, Marketplace por parque e as 24 horas", () => {
    const [lx, po] = summarizeByCity(rows);
    expect(lx).toMatchObject({ city: "lisboa", label: "Lisboa", entradas: 2, saidas: 2, entradasPorFazer: 1, saidasPorFazer: 2 });
    expect(lx.byBucket.airpark).toMatchObject({ entradas: 1, saidas: 1 });
    expect(lx.byBucket.marketplace).toMatchObject({ entradas: 1, saidas: 1 });
    expect(lx.marketplaceParks.map((p) => p.name).sort()).toEqual(["Airpark (pelo Marketplace)", "Travelparking"]);
    expect(lx.hours).toHaveLength(24);
    expect(lx.hours[8]).toMatchObject({ entradas: 2, saidas: 1 }); // 08h: Airpark + Marketplace entram; Travelparking sai
    expect(lx.hours[18]).toMatchObject({ saidas: 1 });
    expect(po).toMatchObject({ city: "porto", entradas: 1, saidas: 1 });
    expect(po.byBucket.redpark.saidas).toBe(1);
    expect(po.marketplaceParks).toEqual([expect.objectContaining({ name: "Boardingpark", entradas: 1 })]);
  });

  it("filtros da lista: cidade e hora", () => {
    expect(filterMovements(rows, { city: "porto" }).map((m) => m.key)).toEqual(["bp:entrada", "rp:saida"]);
    expect(filterMovements(rows, { city: "lisboa", hour: 8 }).map((m) => m.key).sort()).toEqual(["a:entrada", "mk:entrada", "tp:saida"]);
    expect(filterMovements(rows, { hour: 23 }).map((m) => m.key)).toEqual(["rp:saida"]);
  });
});

describe("42d — cidade do parque também pelo nome", () => {
  it("parque sem cidade gravada entra pela cidade do nome; os outros pela cidade gravada", () => {
    const rows = [
      { id: "1", name: "Boardingpark Porto", city: null },
      { id: "2", name: "Travelparking", city: "Lisboa" },
      { id: "3", name: "Airpark", city: "Porto" },
      { id: "4", name: "Sem Nada", city: null },
    ];
    expect(mapParks(rows, ["Porto"]).map((p) => p.id).sort()).toEqual(["1", "3"]);
    expect(mapParks(rows, ["Lisboa"]).map((p) => p.id)).toEqual(["2"]);
    expect(mapParks(rows).map((p) => p.id).sort()).toEqual(["1", "2", "3", "4"]);
  });

  it("a rota aceita o filtro do topo e o ecrã manda-o", () => {
    expect(src("server/routers.ts")).toMatch(/reservasDoDia: protectedProcedure[\s\S]{0,300}projectId: z\.number\(\)\.int\(\)\.optional\(\)/);
    expect(src("client/src/components/operacoes/ReservasDoDia.tsx")).toContain("{ day, projectId: projectId ?? undefined }");
  });
});

// ─── Alertas que se tiram ────────────────────────────────────────────────────
const h = vi.hoisted(() => ({ texts: [] as string[], affected: 1 }));
vi.mock("./db", () => ({
  getDb: async () => ({
    execute: async (q: any) => {
      const flat = (c: any): string => (c?.queryChunks ? c.queryChunks.map(flat).join("") : Array.isArray(c?.value) ? c.value.join("") : typeof c === "string" ? c : "");
      const text = flat(q);
      h.texts.push(text);
      if (/^\s*UPDATE ops_anomalies/.test(text)) return [{ affectedRows: h.affected }];
      return [[{ id: 1, day: "2026-10-06", domain: "bookings", kind: "k", cityKey: "lisbon", subject: "s", value: 1, expected: 2, zScore: 3, severity: "warning", detail: "d", explanation: null, refIds: null, dismissedAt: "2026-10-07 07:00:00" }]];
    },
  }),
}));

describe("42d — alertas", () => {
  it("a lista não traz os tirados; 'tirados' traz só esses", async () => {
    const { listAnomalies } = await import("./aiOps/anomalies");
    h.texts.length = 0;
    await listAnomalies("bookings", { today: "2026-10-07" });
    expect(h.texts[0]).toContain("dismissedAt IS NULL");
    const d = await listAnomalies("bookings", { today: "2026-10-07", dismissed: true });
    expect(h.texts[1]).toContain("dismissedAt IS NOT NULL");
    expect(d[0].dismissedAt).toBe("2026-10-07 07:00:00");
  });

  it("tirar e repor: marca quem e quando (nunca apaga), só no domínio e no âmbito", async () => {
    const { setAnomalyDismissed } = await import("./aiOps/anomalies");
    h.texts.length = 0;
    expect(await setAnomalyDismissed(5, "bookings", 9, true)).toBe(1);
    expect(h.texts[0]).toMatch(/UPDATE ops_anomalies SET dismissedAt = UTC_TIMESTAMP\(\), dismissedById = /);
    expect(h.texts[0]).toContain("AND dismissedAt IS NULL");
    expect(h.texts[0]).toMatch(/WHERE id = .* AND domain = /);
    await setAnomalyDismissed(5, "bookings", 9, false);
    expect(h.texts[1]).toMatch(/SET dismissedAt = NULL, dismissedById = /);
    expect(h.texts[1]).toContain("AND dismissedAt IS NOT NULL");
    h.affected = 0;
    expect(await setAnomalyDismissed(5, "bookings", 9, true)).toBe(0);
    expect(src("server/aiOps/anomalies.ts")).not.toMatch(/DELETE FROM ops_anomalies/);
  });

  it("migração 0505 registada; rota com o mesmo acesso de ver e com registo no histórico", () => {
    expect(src("server/migrations/index.ts")).toContain('["0505", () => import("./migration_0505")');
    const m = src("server/migrations/migration_0505.ts");
    expect(m).toContain("ADD COLUMN `dismissedAt` DATETIME NULL");
    expect(m).toContain("ADD COLUMN `dismissedById` INT NULL");
    expect(m).not.toMatch(/DROP|DELETE/);
    const r = src("server/aiOps/router.ts");
    expect(r).toMatch(/dismissAnomaly: protectedProcedure[\s\S]{0,800}if \(!canSeeAnomalies\(ctx\.user, input\.domain\)\) throw/);
    expect(r).toMatch(/action: input\.restore \? "anomaly_restored" : "anomaly_dismissed", entity: "ops_anomaly"/);
  });

  it("ecrã: pequeno, encolhe, X para tirar e Repor; nas Reservas fica de lado", () => {
    const c = src("client/src/components/aiOps/AnomalyAlerts.tsx");
    expect(c).toContain('aria-label="Tirar da lista"');
    expect(c).toContain("Repor");
    expect(c).toContain("usePersistedState(`alerts.${domain}.collapsed`, false)");
    const p = src("client/src/pages/OperacoesPage.tsx");
    expect(p).toContain("lg:grid-cols-[minmax(0,1fr)_280px]");
    expect(p).toMatch(/<aside className="order-first min-w-0 lg:order-last"><BookingAlerts \/><\/aside>/);
  });
});
