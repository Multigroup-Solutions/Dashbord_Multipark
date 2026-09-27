import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertReadOnlySql } from "./client";
import {
  buildParkMonthsSql, buildParksFullSql, buildPartnerMonthsSql, buildPartnersSql, buildRecentBookingsSql,
  groupPartners, inCities, mapParks, mapRecent, monthsAgo, readPartnersOverview, sumMonths, totalsOf,
} from "./partners";
import { matchPartnership } from "../crm/partners";
import { MIGRATION_0225_STATEMENTS } from "../migrations/migration_0225";

const parkRows = [
  { id: "pk-al", name: "Airpark Lisboa", city: "Lisboa", firebase_brand: "airpark", listing_type: "ON_PLATFORM", status: "ACTIVE" },
  { id: "pk-rp", name: "Redpark Porto", city: "Porto", firebase_brand: "redpark", status: "ACTIVE" },
  { id: "pk-x", name: "Parque do Zé", city: "Lisboa", company_name: "Zé Lda", email: "ze@parque.pt", status: "ACTIVE" },
  { id: "pk-y", name: "Parking Faro Sul", city: "Faro", status: "PENDING" },
];
const parks = mapParks(parkRows);

describe("Parceiros na BD Multipark — SQL", () => {
  it("todas as leituras passam na guarda só de leitura e têm LIMIT", () => {
    const all = [
      buildParksFullSql(), buildPartnersSql(), buildPartnerMonthsSql("2025-09-30 00:00:00"), buildPartnerMonthsSql("2025-09-30 00:00:00", ["p1", "p2"]),
      buildParkMonthsSql("2025-09-30 00:00:00", ["pk-x"]), buildRecentBookingsSql({ partnerIds: ["p1"] }), buildRecentBookingsSql({ parkIds: ["pk-x"] }),
    ];
    for (const b of all) {
      expect(() => assertReadOnlySql(b.sql)).not.toThrow();
      expect(b.sql).toMatch(/LIMIT (\$\d+|\d+)/);
    }
  });
  it("mês = entrada do carro em Lisboa; comissão deles = contribuído − devido", () => {
    const s = buildPartnerMonthsSql("2025-09-30 00:00:00").sql;
    expect(s).toContain(`AT TIME ZONE 'Europe/Lisbon'`);
    expect(s).toContain(`b."partnerContributedAmount" - b."partnerAmountDue"`);
    expect(s).toContain(`SUM(CASE WHEN b."status"::text <> 'CANCELLED' THEN b."partnerAmountDue" END) AS ours`);
  });
  it("sem filtro nas últimas reservas não se lê nada", () => {
    expect(() => buildRecentBookingsSql({})).toThrow();
    expect(() => buildParkMonthsSql("2025-01-01 00:00:00", [])).toThrow();
  });
});

describe("Parceiros — agrupar por empresa, só nos nossos parques", () => {
  const rows = [
    { partner_id: "p1", user_id: "u-parkos", park_id: "pk-al", name: "Parkos", active: true, fee_type: "PERCENTAGE", fee_pct: 25, partner_type: "AGGREGATOR", tax_number: "509999999", created_at: "2024-03-01 10:00:00" },
    { partner_id: "p2", user_id: "u-parkos", park_id: "pk-rp", name: "Parkos", active: false, fee_type: "PERCENTAGE", fee_pct: 20, partner_type: "AGGREGATOR" },
    // parceiro de um parque que não é nosso: não entra
    { partner_id: "p3", user_id: "u-zeagencia", park_id: "pk-x", name: "Agência do Zé", active: true, fee_pct: 10, partner_type: "AGENCY" },
    { partner_id: "p4", user_id: "u-viagens", park_id: "pk-al", name: null, tax_name: "Viagens Lda", active: true, fee_pct: 15, partner_type: "AGENCY" },
  ];
  it("uma empresa por userId, com as linhas dos parques e percentagens", () => {
    const g = groupPartners(rows, parks, undefined);
    expect(g.map((x) => x.userId)).toEqual(["u-parkos", "u-viagens"]);
    const parkos = g[0];
    expect(parkos).toMatchObject({ name: "Parkos", type: "AGGREGATOR", active: true, taxNumber: "509999999", since: "2024-03-01 10:00:00" });
    expect(parkos.parks.map((p) => [p.parkName, p.feePct, p.active])).toEqual([["Airpark Lisboa", 25, true], ["Redpark Porto", 20, false]]);
    expect(g[1].name).toBe("Viagens Lda");
  });
  it("âmbito de cidade: só os parques das cidades do utilizador", () => {
    const g = groupPartners(rows, parks, ["Porto"]);
    expect(g).toHaveLength(1);
    expect(g[0].parks.map((p) => p.parkName)).toEqual(["Redpark Porto"]);
    expect(g[0].active).toBe(false);
    expect(inCities(null, ["Lisboa"])).toBe(false);
    expect(inCities("lisbon", ["Lisboa"])).toBe(true);
  });
  it("tipo mais frequente; empate → agregador", () => {
    const g = groupPartners([
      { partner_id: "a", user_id: "u", park_id: "pk-al", partner_type: "AGENCY" },
      { partner_id: "b", user_id: "u", park_id: "pk-rp", partner_type: "AGGREGATOR" },
    ], parks, undefined);
    expect(g[0].type).toBe("AGGREGATOR");
  });
});

describe("Parques em que agregamos", () => {
  it("nossos vs marketplace pelo classificador", () => {
    expect(parks.filter((p) => !p.ours).map((p) => p.id)).toEqual(["pk-x", "pk-y"]);
    expect(parks.find((p) => p.id === "pk-x")).toMatchObject({ companyName: "Zé Lda", email: "ze@parque.pt" });
  });
});

describe("Mês a mês e totais", () => {
  const monthRows = [
    { partner_id: "p1", month: "2026-09", bookings: 5, cancelled: 1, value: 400, commission: 100, ours: 300, paid: 0 },
    { partner_id: "p2", month: "2026-09", bookings: 2, cancelled: 0, value: 100, commission: 20, ours: 80, paid: null },
    { partner_id: "p1", month: "2026-08", bookings: 3, cancelled: 0, value: 240.5, commission: 60.13, ours: 180.37, paid: 50 },
    { partner_id: "p9", month: "2026-08", bookings: 9, value: 1 },
  ];
  const group = new Map([["p1", "u-parkos"], ["p2", "u-parkos"]]);
  const sums = sumMonths(monthRows, (r) => group.get(String(r.partner_id)) ?? null);
  it("soma as linhas dos parques da mesma empresa por mês (mais recente primeiro)", () => {
    expect([...sums.keys()]).toEqual(["u-parkos"]);
    expect(sums.get("u-parkos")).toEqual([
      { month: "2026-09", bookings: 7, cancelled: 1, value: 500, commission: 120, ours: 380, paid: 0 },
      { month: "2026-08", bookings: 3, cancelled: 0, value: 240.5, commission: 60.13, ours: 180.37, paid: 50 },
    ]);
  });
  it("totais de um intervalo", () => {
    expect(totalsOf(sums.get("u-parkos")!, "2026-09", "2026-09")).toMatchObject({ bookings: 7, ours: 380 });
    expect(totalsOf(sums.get("u-parkos")!, "2025-10")).toMatchObject({ bookings: 10, value: 740.5, ours: 560.37 });
  });
  it("12 meses atrás (1.º dia) com 1 dia de folga para Lisboa", () => {
    expect(monthsAgo(11, new Date("2026-09-27T10:00:00Z"))).toEqual({ month: "2025-10", since: "2025-09-30 00:00:00" });
  });
});

describe("Últimas reservas", () => {
  it("valor = contribuído (senão preço); comissão = contribuído − devido; nosso = devido", () => {
    const r = mapRecent([
      { id: "b1", code: "10", status: "CHECKED_OUT", booking_price: 402, contributed: 402, due: 301.5, fee_value: 25, client_name: "Ana" },
      { id: "b2", status: "BOOKED", booking_price: 60, contributed: null, due: null, commission_amount: 1.2 },
    ]);
    expect(r[0]).toMatchObject({ value: 402, commission: 100.5, ours: 301.5, feePct: 25, clientName: "Ana" });
    expect(r[1]).toMatchObject({ value: 60, commission: null, ours: null, marketplaceCommission: 1.2 });
  });
});

describe("Ligação às Parcerias", () => {
  const list = [
    { id: 1, name: "Parkos (Parcerias)", partnerType: "agregador", contactName: null, contactEmail: null, contactPhone: null, nif: null, mpPartnerIds: ["p1"] },
    { id: 2, name: "Viagens", partnerType: "agencia_viagem", contactName: null, contactEmail: null, contactPhone: null, nif: "PT 509 888 888", mpPartnerIds: [] },
  ];
  const parks1 = [{ partnerId: "p1", parkId: "pk-al", parkName: "Airpark Lisboa", city: "Lisboa", feeType: null, feePct: 25, feeFixed: null, active: true }];
  it("pelo id da Multipark (também por alias), senão pelo NIF", () => {
    expect(matchPartnership({ parks: parks1, taxNumber: null }, list)).toMatchObject({ ref: { id: 1 }, how: "id" });
    expect(matchPartnership({ parks: [{ ...parks1[0], partnerId: "pz" }], taxNumber: "509888888" }, list)).toMatchObject({ ref: { id: 2 }, how: "nif" });
    expect(matchPartnership({ parks: [{ ...parks1[0], partnerId: "pz" }], taxNumber: null }, list)).toBeNull();
  });
});

describe("Leitura — sem BD", () => {
  it("não lança", async () => {
    const prev = process.env.DATABASE_URL_MULTIPARK;
    delete process.env.DATABASE_URL_MULTIPARK;
    try {
      const r = await readPartnersOverview(undefined, async () => { throw new Error("não devia ler"); });
      expect(r.available).toBe(false);
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL_MULTIPARK = prev;
    }
  });
});

describe("migração 0225", () => {
  it("só cria a tabela do CRM; registada no ensureRecentSchema", () => {
    const all = MIGRATION_0225_STATEMENTS.join("\n");
    expect(all).not.toMatch(/\bDROP\b|\bDELETE\b|COLLATE/i);
    expect(all).toContain("UNIQUE KEY `uq_crm_partner_link` (`kind`, `mpId`)");
    expect(readFileSync(resolve(__dirname, "..", "db.ts"), "utf8")).toContain('import("./migrations/migration_0225")');
  });
});
