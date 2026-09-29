import { beforeEach, describe, expect, it } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { cityScope } from "./cityScope";
import { getClientProfile, invalidateClientsCache, listClients } from "./clientsCrm";

// Tudo o que o CRM lê tem de passar pelo âmbito de cidade — reservas,
// reclamações, perdidos e críticas. Aqui apanha-se o SQL gerado.
const dialect = new MySqlDialect();
const porto = { all: false, defaultCityId: 50, cityName: "Porto", cityIds: [50], projectIds: [50, 65], missingCostCenter: false };

let queries: { sql: string; params: unknown[] }[] = [];
const fakeDb = {
  execute: async (q: any) => {
    const r = dialect.sqlToQuery(q);
    queries.push(r);
    if (r.sql.includes("GROUP BY LOWER(TRIM(b.clientEmail))")) {
      return [[{ email: "ana@x.pt", bookings: 3, cancelled: 0, completed: 2, upcoming: 1, visitDays: 2, partnerBookings: 0, distinctNames: 1, totalSpent: 90, firstCheckIn: "2026-01-01", lastCheckIn: "2026-05-01", nextCheckIn: null, cities: "porto" }], []];
    }
    if (r.sql.includes("AS ref")) return [[{ ref: "MP123" }], []];
    if (r.sql.includes("SELECT v FROM") && r.sql.includes("licensePlate")) return [[{ v: "AA00BB" }], []];
    if (r.sql.includes("FROM complaints")) return [[{ id: 7, title: "Risco", status: "new", createdAt: "2026-05-02", email: null }], []];
    return [[], []];
  },
};

beforeEach(() => { queries = []; invalidateClientsCache(); });

describe("CRM — âmbito de cidade em todas as queries", () => {
  it("ficha: reservas, reclamações, perdidos, críticas e matrículas partilhadas filtram por cidade", async () => {
    const p = await cityScope.run(porto, () => getClientProfile(fakeDb, "  Ana@X.pt "));
    expect(p?.email).toBe("ana@x.pt");
    const bookingQs = queries.filter((q) => q.sql.includes("multipark_bookings"));
    expect(bookingQs.length).toBeGreaterThan(5);
    for (const q of bookingQs) expect(q.sql).toContain("b.projectId IN");

    const complaints = queries.find((q) => q.sql.includes("FROM complaints"))!;
    expect(complaints.sql).toContain("c.projectId IN");
    expect(complaints.sql).toContain("c.reservationRef");       // ligada pela reserva, mesmo sem email
    expect(complaints.params).toContain("MP123");
    const lost = queries.find((q) => q.sql.includes("FROM lost_found_items"))!;
    expect(lost.sql).toContain("l.projectId IN");
    expect(lost.sql).toContain("l.bookingRef");
    const reviews = queries.find((q) => q.sql.includes("FROM google_reviews"))!;
    expect(reviews.sql).toContain("g.projectId IN");
    expect(reviews.sql).toContain("g.complaintId IN");            // crítica que deu origem à reclamação 7
    expect(reviews.params).toContain(7);

    const shared = queries.find((q) => q.sql.includes("<>") && q.params.includes("AA00BB"))!;
    expect(shared.params).toContain("ana@x.pt");
    expect(p?.complaints).toEqual([expect.objectContaining({ id: 7, via: "reserva" })]);
  });

  it("lista: identidades e pesquisa com âmbito e parâmetros (sem injeção)", async () => {
    await cityScope.run(porto, () => listClients(fakeDb, { search: "x%' OR 1=1 --" }));
    for (const q of queries) {
      expect(q.sql).toContain("b.projectId IN");
      expect(q.sql).not.toContain("OR 1=1");
    }
    expect(queries.some((q) => q.params.includes("%x%' or 1=1 --%"))).toBe(true);
  });

  it("reservas futuras não contam como estadias nem gasto", async () => {
    const r = await cityScope.run(porto, () => listClients(fakeDb, {}));
    expect(r.rows).toHaveLength(1);                              // a página tem linhas → também lê identidades
    expect(queries.some((q) => q.sql.includes("ORDER BY b.checkIn DESC"))).toBe(true);
    for (const q of queries) expect(q.sql).toContain("b.projectId IN");
    const agg = queries.find((q) => q.sql.includes("GROUP BY LOWER(TRIM(b.clientEmail))"))!;
    expect(agg.sql).toMatch(/SUM\(CASE WHEN UPPER\(COALESCE\(b\.status, ''\)\) IN \(\?, \?, \?, \?\) THEN b\.totalPrice END\)/);
    expect(agg.params).toEqual(expect.arrayContaining(["CHECKED_IN", "CHECKED_OUT"]));
  });
});
