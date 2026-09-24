import { describe, expect, it } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { cityScope } from "./cityScope";
import { buildChannels, clientsSql, mixSql, type ClientRowAgg, type MixRow } from "./marketingChannels";
import { channelOf, parseFirstBooking } from "../shared/marketingChannels";

const partners: Record<string, { id: number; name: string; commissionRate: number }> = {
  parclick: { id: 1, name: "Parclick", commissionRate: 20 },
};
const partnerFor = (c: string) => partners[c.trim().toLowerCase()];
const hasPartner = (c: string) => !!partnerFor(c);
const range = { from: "2026-09-01", to: "2026-09-30" };
const mix = (o: Partial<MixRow>): MixRow => ({ origin: "API", googlePaid: false, campaign: null, bookings: 1, revenue: 50, withEmail: 1, ...o });
const client = (first: string, o: Partial<ClientRowAgg> = {}): ClientRowAgg => ({ first, bookings: 1, periodBookings: 1, value: 50, ...o });

describe("canal de uma reserva", () => {
  it("clique pago ganha a tudo; marketplace antes de campanha; campanha com parceiro = parceiro", () => {
    expect(channelOf({ origin: "API", googlePaid: true }, hasPartner)).toBe("google_ads");
    expect(channelOf({ origin: "MARKETPLACE", campaign: "Parclick" }, hasPartner)).toBe("marketplace");
    expect(channelOf({ origin: "API", campaign: " Parclick " }, hasPartner)).toBe("parceiro");
    expect(channelOf({ origin: "API", campaign: "Verão" }, hasPartner)).toBe("campanha");
    expect(channelOf({ origin: "MANUAL" }, hasPartner)).toBe("telefone");
    expect(channelOf({ origin: "GENERAL_FORM" }, hasPartner)).toBe("site");
    expect(channelOf({ origin: null }, hasPartner)).toBe("outros");
  });
  it("primeira reserva codificada (campanha pode ter |)", () => {
    expect(parseFirstBooking("2026-09-02 10:00:00|API|1|a|b")).toEqual({ at: "2026-09-02 10:00:00", origin: "API", googlePaid: true, campaign: "a|b" });
    expect(parseFirstBooking(null)).toBeNull();
  });
});

describe("canais e clientes", () => {
  const r = buildChannels(
    [
      mix({ googlePaid: true, bookings: 10, revenue: 500 }),
      mix({ campaign: "Parclick", bookings: 5, revenue: 1000 }),
      mix({ origin: "MANUAL", bookings: 3, revenue: 90, withEmail: 1 }),
    ],
    [
      client("2026-09-05 09:00:00|API|1|", { bookings: 3, periodBookings: 2, value: 150 }),   // novo via Google, voltou no período
      client("2026-09-10 09:00:00|API|0|Parclick", { value: 200 }),                        // novo via parceiro
      client("2025-01-01 09:00:00|API|1|", { bookings: 4, periodBookings: 1, value: 300 }),   // antigo via Google, repetiu
    ],
    range, 300, partnerFor,
  );
  const ch = Object.fromEntries(r.channels.map((c) => [c.key, c]));

  it("custo por canal: gasto do Google e comissão do parceiro; sem custo = null", () => {
    expect(ch.google_ads).toMatchObject({ bookings: 10, cost: 300, costPerBooking: 30 });
    expect(ch.parceiro).toMatchObject({ bookings: 5, cost: 200, costPerBooking: 40 });
    expect(ch.telefone).toMatchObject({ bookings: 3, cost: null, costPerBooking: null });
    expect(r.partners).toEqual([{ name: "Parclick", bookings: 5, revenue: 1000, commissionRate: 20, commission: 200 }]);
    expect(r.bookingsTotal).toBe(18);
    expect(r.bookingsWithoutEmail).toBe(15);
  });

  it("clientes novos pelo canal da 1.ª reserva e custo por cliente novo", () => {
    expect(r.newClients).toBe(2);
    expect(ch.google_ads).toMatchObject({ newClients: 1, costPerNewClient: 300 });
    expect(ch.parceiro).toMatchObject({ newClients: 1, costPerNewClient: 200 });
    // repetentes no período: 1 do novo (2.ª reserva) + 1 do antigo
    expect(r.returningBookings).toBe(2);
  });

  it("valor por cliente consoante o canal de entrada", () => {
    const g = r.valueByChannel.find((v) => v.key === "google_ads")!;
    expect(g).toMatchObject({ clients: 2, avgBookings: 3.5, repeatRate: 1, avgValue: 225 });
  });
});

describe("âmbito de cidade nas queries", () => {
  const dialect = new MySqlDialect();
  const porto = { all: false, defaultCityId: 50, cityName: "Porto", cityIds: [50], projectIds: [50, 65], missingCostCenter: false };
  it("mistura por canal e clientes filtram pelas cidades do utilizador", () => cityScope.run(porto, () => {
    for (const q of [mixSql("2026-09-01", "2026-09-30"), clientsSql("2026-09-01", "2026-09-30")]) {
      const r = dialect.sqlToQuery(q);
      expect(r.sql).toContain("b.projectId IN");
      expect(r.params).toEqual(expect.arrayContaining([50, 65, "2026-09-01 00:00:00", "2026-09-30 23:59:59"]));
    }
  }));
  it("projeto filtrado vazio → nada", () => {
    expect(dialect.sqlToQuery(mixSql("2026-09-01", "2026-09-30", [])).sql).toContain("1 = 0");
  });
});
