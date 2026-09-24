import { describe, expect, it } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { cityScope } from "./cityScope";
import { buildChannels, clientsSql, mixSql, type ClientRowAgg, type MixRow } from "./marketingChannels";
import { channelOf, groupOf, parseFirstBooking } from "../shared/marketingChannels";

const partners: Record<string, { id: number; name: string; commissionRate: number }> = {
  parclick: { id: 1, name: "Parclick", commissionRate: 20 },
};
const partnerFor = (c: string) => partners[c.trim().toLowerCase()];
const hasPartner = (c: string) => !!partnerFor(c);
const range = { from: "2026-09-01", to: "2026-09-30" };
const mix = (o: Partial<MixRow>): MixRow => ({ origin: "API", googlePaid: false, campaign: null, bookings: 1, revenue: 50, withEmail: 1, newClient: true, ...o });
const client = (first: string, o: Partial<ClientRowAgg> = {}): ClientRowAgg => ({ first, bookings: 1, periodBookings: 1, value: 50, ...o });

describe("canal de uma reserva", () => {
  it("marketplace antes de campanha; campanha com parceiro = parceiro; o clique pago não decide o canal", () => {
    expect(channelOf({ origin: "MARKETPLACE", campaign: "Parclick" }, hasPartner)).toBe("marketplace");
    expect(channelOf({ origin: "API", campaign: " Parclick " }, hasPartner)).toBe("parceiro");
    expect(channelOf({ origin: "API", campaign: "Verão" }, hasPartner)).toBe("campanha");
    expect(channelOf({ origin: "MANUAL" }, hasPartner)).toBe("telefone");
    expect(channelOf({ origin: "GENERAL_FORM" }, hasPartner)).toBe("site");
    expect(channelOf({ origin: null }, hasPartner)).toBe("outros");
  });
  it("canais próprios: cliente novo = anúncios, quem já era cliente = orgânico", () => {
    expect(groupOf("marketplace", true)).toBe("anuncios");
    expect(groupOf("site", false)).toBe("organico");
    expect(groupOf("telefone", false)).toBe("organico");
    expect(groupOf("parceiro", true)).toBe("parceiros");
    expect(groupOf("campanha", false)).toBe("campanhas");
  });
  it("primeira reserva codificada (campanha pode ter |)", () => {
    expect(parseFirstBooking("2026-09-02 10:00:00|API|1|a|b")).toEqual({ at: "2026-09-02 10:00:00", origin: "API", googlePaid: true, campaign: "a|b" });
    expect(parseFirstBooking(null)).toBeNull();
  });
});

describe("canais e clientes", () => {
  const r = buildChannels(
    [
      mix({ origin: "MARKETPLACE", newClient: true, bookings: 6, revenue: 300 }),
      mix({ origin: "API", newClient: true, googlePaid: true, bookings: 4, revenue: 200 }),
      mix({ origin: "API", newClient: false, bookings: 5, revenue: 250 }),
      mix({ origin: "MANUAL", newClient: false, bookings: 3, revenue: 90 }),
      mix({ campaign: "Parclick", newClient: true, bookings: 5, revenue: 1000 }),
    ],
    [
      client("2026-09-05 09:00:00|API|1|", { bookings: 3, periodBookings: 2, value: 150 }),        // novo via site
      client("2026-09-10 09:00:00|API|0|Parclick", { value: 200 }),                             // novo via parceiro
      client("2025-01-01 09:00:00|MARKETPLACE|0|", { bookings: 4, periodBookings: 1, value: 300 }), // antigo, repetiu
    ],
    range, 300, partnerFor,
  );
  const g = Object.fromEntries(r.groups.map((x) => [x.key, x]));

  it("anúncios = canais próprios de clientes novos, com o gasto do Google; orgânico sem custo", () => {
    expect(g.anuncios).toMatchObject({ bookings: 10, revenue: 500, paidProof: 4, cost: 300, costPerBooking: 30 });
    expect(g.anuncios.channels.map((c) => [c.key, c.bookings])).toEqual([["marketplace", 6], ["site", 4]]);
    expect(g.organico).toMatchObject({ bookings: 8, cost: null, costPerBooking: null });
    expect(g.organico.channels.map((c) => [c.key, c.bookings])).toEqual([["site", 5], ["telefone", 3]]);
  });

  it("parceiros com comissão", () => {
    expect(g.parceiros).toMatchObject({ bookings: 5, cost: 200, costPerBooking: 40 });
    expect(r.partners).toEqual([{ name: "Parclick", bookings: 5, revenue: 1000, commissionRate: 20, commission: 200 }]);
    expect(r.bookingsTotal).toBe(23);
  });

  it("clientes novos no grupo de entrada e custo por cliente novo", () => {
    expect(r.newClients).toBe(2);
    expect(g.anuncios).toMatchObject({ newClients: 1, costPerNewClient: 300 });
    expect(g.parceiros).toMatchObject({ newClients: 1, costPerNewClient: 200 });
    expect(r.returningBookings).toBe(2);
  });

  it("valor por cliente consoante o canal de entrada", () => {
    const m = r.valueByChannel.find((v) => v.key === "marketplace")!;
    expect(m).toMatchObject({ group: "anuncios", clients: 1, avgBookings: 4, repeatRate: 1, avgValue: 300 });
  });
});

describe("âmbito de cidade nas queries", () => {
  const dialect = new MySqlDialect();
  const porto = { all: false, defaultCityId: 50, cityName: "Porto", cityIds: [50], projectIds: [50, 65], missingCostCenter: false };
  it("mistura por canal e clientes filtram pelas cidades do utilizador", () => cityScope.run(porto, () => {
    for (const q of [mixSql("2026-09-01", "2026-09-30"), clientsSql("2026-09-01", "2026-09-30")]) {
      // a query principal (reservas "b") tem sempre o âmbito; o derivado "x" só dá a 1.ª data por email
      const r = dialect.sqlToQuery(q);
      expect(r.sql).toContain("b.projectId IN");
      expect(r.params).toEqual(expect.arrayContaining([50, 65, "2026-09-01 00:00:00", "2026-09-30 23:59:59"]));
    }
  }));
  it("projeto filtrado vazio → nada", () => {
    expect(dialect.sqlToQuery(mixSql("2026-09-01", "2026-09-30", [])).sql).toContain("1 = 0");
  });
});
