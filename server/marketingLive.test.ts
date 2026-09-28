import { describe, expect, it } from "vitest";
import { buildMarketingBookingsSql, buildMarketingClientsSql, mapMarketingBookingRow, mapMarketingClientRow, type MarketingBookingRow } from "./multiparkDb/marketingBookings";
import { assertReadOnlySql } from "./multiparkDb/client";
import { parksFor, toMarketingBooking, toMarketingClient } from "./marketingLive";
import { buildChannels, mixFromBookings } from "./marketingChannels";
import { parseFirstBooking } from "../shared/marketingChannels";

const spec = { start: "2026-07-31 23:00:00", end: "2026-08-31 23:00:00", parkIds: ["pA", "pB"], internalDomains: ["multipark.pt", "airpark.pt"] };

describe("marketing ao vivo: SQL na BD da Multipark", () => {
  it("reservas: criadas no período, sem canceladas, só os parques pedidos; email nunca sai (só booleano)", () => {
    const { sql, params } = buildMarketingBookingsSql(spec);
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain(`b."status"::text <> 'CANCELLED'`);
    expect(sql).toContain(`b."createdAt" >= `);
    expect(sql).toContain(`AT TIME ZONE 'Europe/Lisbon'`);
    expect(sql).toMatch(/\(d\.em IS NOT NULL\) AS has_email/);
    // o SELECT final não devolve o email
    const finalSelect = sql.slice(sql.lastIndexOf("SELECT d.id"));
    expect(finalSelect).not.toMatch(/\bd\.em\b AS|c\."email"/);
    expect(params).toEqual(expect.arrayContaining(["pA", "pB", spec.start, spec.end, "multipark.pt", "airpark.pt"]));
    expect(() => buildMarketingBookingsSql({ ...spec, parkIds: [] })).toThrow();
  });
  it("clientes: chave md5 do email, 1.ª reserva, contagem no período e valor realizado", () => {
    const { sql, params } = buildMarketingClientsSql(spec);
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain("md5(a.em) AS client_key");
    expect(sql).toContain("DISTINCT ON (y.em)");
    expect(sql).toMatch(/LIMIT \$\d+$/);
    expect(params).toEqual(expect.arrayContaining(["CHECKED_IN", "CHECKED_OUT"]));
  });
  it("mapeadores", () => {
    expect(mapMarketingBookingRow({ id: "b1", created_at: "2026-08-10 09:00:00", day: "2026-08-10", park_id: "pA", status: "BOOKED", origin: "API", origin_url: "https://x.pt/?gclid=abc", partner_id: null, partner_name: "", payment_method: null, campaign_name: null, discount_code: null, total: "45.5", has_email: "t", new_client: false }))
      .toMatchObject({ id: "b1", total: 45.5, hasEmail: true, newClient: false, partnerName: null, originUrl: "https://x.pt/?gclid=abc" });
    expect(mapMarketingClientRow({ client_key: "k", first_at: "2026-01-01 10:00:00", first_origin: "API", bookings: "3", period_bookings: "1", value: "120" }))
      .toMatchObject({ clientKey: "k", bookings: 3, periodBookings: 1, value: 120 });
  });
});

describe("marketing ao vivo: atribuição, centro e campanha", () => {
  const ctx = { ourParks: new Map<string, number | null>([["pA", 10], ["pB", 11], ["pC", null]]), aliases: new Map([["multipark_partner_id:p1", "Parceiro Um"]]) };
  const row = (o: Partial<MarketingBookingRow>): MarketingBookingRow => ({ id: "b", createdAt: "2026-08-10 09:00:00", day: "2026-08-10", parkId: "pA", status: "BOOKED", origin: "API", originUrl: null, partnerId: null, partnerName: null, paymentMethod: null, campaignName: null, discountCode: null, total: 50, hasEmail: true, newClient: true, ...o });
  it("atribuição pelo link: gclid = Google pago (com ID da campanha), fbclid = Meta, sem link = desconhecido", () => {
    const g = toMarketingBooking(row({ originUrl: "https://airpark.pt/?gclid=X1&campaignid=987" }), ctx)!;
    expect(g).toMatchObject({ projectId: 10, adAttribution: "google_paid", adCampaignExternalId: "987", hasClickId: true, hasOriginUrl: true });
    expect(toMarketingBooking(row({ originUrl: "https://airpark.pt/?fbclid=Y" }), ctx)!.adAttribution).toBe("meta_paid");
    expect(toMarketingBooking(row({}), ctx)!).toMatchObject({ adAttribution: "unknown", hasOriginUrl: false });
    expect(toMarketingBooking(row({ parkId: "fora" }), ctx)).toBeNull();
  });
  it("campanha pelo alias do parceiro", () => {
    expect(toMarketingBooking(row({ partnerId: "P1" }), ctx)!.campaign).toBe("Parceiro Um");
  });
  it("parques no âmbito: filtro de centro e cidade do utilizador; sem centro só sem filtros", () => {
    expect(parksFor(ctx)).toEqual(["pA", "pB", "pC"]);
    expect(parksFor(ctx, [11])).toEqual(["pB"]);
    expect(parksFor(ctx, null, [10])).toEqual(["pA"]);
    expect(parksFor(ctx, [11], [10])).toEqual([]);
  });
  it("canais: mix das reservas e 1.ª reserva do cliente no formato antigo", () => {
    const bookings = [
      toMarketingBooking(row({ originUrl: "https://x/?gclid=1", total: 100 }), ctx)!,
      toMarketingBooking(row({ newClient: false, total: 40 }), ctx)!,
      toMarketingBooking(row({ newClient: false, total: 60, hasEmail: false }), ctx)!,
    ];
    const mix = mixFromBookings(bookings);
    expect(mix.find((m) => m.googlePaid)).toMatchObject({ bookings: 1, revenue: 100, newClient: true });
    expect(mix.find((m) => !m.googlePaid && !m.newClient)).toMatchObject({ bookings: 2, revenue: 100, withEmail: 1 });
    const client = toMarketingClient({ clientKey: "k", firstAt: "2026-08-10 09:00:00", firstOrigin: "API", firstUrl: "https://x/?gclid=1", firstPartnerId: null, firstPartnerName: null, firstPaymentMethod: null, firstCampaignName: null, firstDiscountCode: null, bookings: 2, periodBookings: 2, value: 140 }, ctx.aliases);
    expect(parseFirstBooking(client.first)).toEqual({ at: "2026-08-10 09:00:00", origin: "API", googlePaid: true, campaign: "" });
    const r = buildChannels(mix, [client], { from: "2026-08-01", to: "2026-08-31" }, 300, () => undefined);
    expect(r.bookingsTotal).toBe(3);
    expect(r.bookingsWithoutEmail).toBe(1);
    expect(r.newClients).toBe(1);
  });
});
