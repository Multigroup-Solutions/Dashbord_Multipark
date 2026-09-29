import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { computePartnerPresence } from "./partnerPresence";
import { buildPartnerPresenceSql, mapPartnerPresenceRow } from "./multiparkDb/partnerPresence";
import { assertReadOnlySql } from "./multiparkDb/client";
import { campaignOf } from "./finance/liveBookings";
import { cityScope, partnerScope } from "./cityScope";
import { MIGRATION_0260_STATEMENTS } from "./migrations/migration_0260";

const row = (o: Partial<ReturnType<typeof mapPartnerPresenceRow>>) => ({
  parkId: "pA", partnerId: null, partnerName: null, paymentMethod: null, discountCode: null, campaignName: null, count: 1, lastCheckIn: null, ...o,
});

describe("parcerias por cidade ao vivo", () => {
  it("leitura só de leitura, com LIMIT, nossos parques, sem compras por acabar, desde a data", () => {
    const q = buildPartnerPresenceSql({ parkIds: ["pA", "pB"], since: "2024-09-29 00:00:00" });
    expect(() => assertReadOnlySql(q.sql)).not.toThrow();
    expect(q.sql).toContain(`b."status"::text <> 'PENDING'`);
    expect(q.sql).toContain("LIMIT");
    expect(q.params).toEqual(["pA", "pB", "2024-09-29 00:00:00", 50000]);
    expect(() => buildPartnerPresenceSql({ parkIds: [], since: "x" })).toThrow();
    expect(mapPartnerPresenceRow({ park_id: "pA", partner_id: "mp1", n: "4", last_check_in: "2026-09-01 10:00:00" })).toMatchObject({ parkId: "pA", partnerId: "mp1", count: 4 });
  });
  it("campanha (mesma regra do Financeiro) → parceria × centro; parques sem centro e campanhas sem parceria ficam fora", () => {
    const ctx = { ourParks: new Map<string, number | null>([["pA", 10], ["pB", 50], ["pX", null]]), aliases: new Map([["multipark_partner_id:mp1", "Parkos"]]) };
    const partners = new Map([["parkos", 1], ["bestparking", 2]]);
    const out = computePartnerPresence([
      row({ parkId: "pA", partnerId: "mp1", count: 3, lastCheckIn: "2026-09-01 10:00:00" }),
      row({ parkId: "pA", partnerId: "mp1", count: 2, lastCheckIn: "2026-09-10 10:00:00" }),
      row({ parkId: "pB", partnerName: "BestParking", count: 1 }),
      row({ parkId: "pX", partnerId: "mp1", count: 9 }),
      row({ parkId: "pA", partnerName: "Desconhecido", count: 5 }),
    ], ctx, (c) => partners.get(c.trim().toLowerCase()), campaignOf);
    expect(out).toEqual([
      { partnershipId: 1, projectId: 10, bookings: 5, lastCheckIn: "2026-09-10 10:00:00" },
      { partnershipId: 2, projectId: 50, bookings: 1, lastCheckIn: null },
    ]);
  });
  it("âmbito das Parcerias: pelo resumo (já não pela cópia) + parcerias que operam o centro", () => {
    const porto = { all: false, defaultCityId: 50, cityName: "Porto", cityIds: [50], projectIds: [50, 65], missingCostCenter: false };
    const q = cityScope.run(porto as any, () => new MySqlDialect().sqlToQuery(partnerScope(sql`p.id`)));
    expect(q.sql).toContain("FROM partner_city_presence city_presence");
    expect(q.sql).toContain("city_presence.projectId IN");
    expect(q.sql).toContain("operatesProjects");
    expect(q.sql).not.toContain("multipark_bookings");
    expect(q.params).toEqual(expect.arrayContaining([50, 65]));
    expect(new MySqlDialect().sqlToQuery(partnerScope(sql`p.id`)).sql).toBe("1 = 1");
  });
  it("migração 0260 e refresco no cron", () => {
    expect(MIGRATION_0260_STATEMENTS.join("\n")).toContain("CREATE TABLE IF NOT EXISTS `partner_city_presence`");
    expect(readFileSync(join(__dirname, "db.ts"), "utf8")).toContain('import("./migrations/migration_0260")');
    expect(readFileSync(join(__dirname, "cronJobs.ts"), "utf8")).toContain("maybeRefreshPartnerCityPresence");
  });
});
