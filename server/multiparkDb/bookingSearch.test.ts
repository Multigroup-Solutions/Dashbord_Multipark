import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildBookingSearchSql, mapLiveBookingRow, searchConditions, searchLiveBookings } from "./bookingSearch";
import { ParamList } from "./read";
import { assertReadOnlySql } from "./client";
import { splitBookingLabel } from "../whatsappCallsQueries";
import { bookingLabelOf } from "../whatsappInboxOps";
import { dossierBookingFromCore } from "../complaintDossier";
import { MIGRATION_0250_STATEMENTS } from "../migrations/migration_0250";

vi.mock("../finance/liveBookings", () => ({
  loadLiveContext: async () => ({ ourParks: new Map([["pA", 10], ["pB", null]]), aliases: new Map() }),
}));

const root = join(__dirname, "..", "..");
const code = (f: string) => readFileSync(join(root, f), "utf8").split("\n").filter((l) => !/^\s*(\*|\/\/)/.test(l)).join("\n");

describe("pesquisa de reservas ao vivo", () => {
  it("critérios: ref exata, matrícula/email/telefone normalizados, nome só com 4+ letras", () => {
    const p = new ParamList();
    const c = searchConditions({ ref: " #29484 ", plate: "aa-00-bb", email: " Ana@X.pt ", phone: "+351 912 345 678", name: "Ana Silva" }, p);
    expect(c.join(" ")).toContain(`b."allocation" = $1`);
    expect(p.values).toEqual(["29484", "AA00BB", "ana@x.pt", "912345678", "%Ana Silva%"]);
    expect(searchConditions({ name: "Ana", phone: "1234", plate: "AB" }, new ParamList())).toEqual([]);
  });
  it("texto livre: n.º, id, email, nome; matrícula com números; telefone só com dígitos", () => {
    const p = new ParamList();
    const t = searchConditions({ text: "12-AB-34" }, p).join(" ");
    expect(t).toContain(`b."allocation" ILIKE`);
    expect(p.values).toContain("%12AB34%");
    const ph = new ParamList();
    expect(searchConditions({ text: "912 345 678" }, ph).join(" ")).toContain("right(regexp_replace");
    expect(ph.values).toContain("%912345678");
    expect(searchConditions({ text: "a" }, new ParamList())).toEqual([]);
  });
  it("SQL só de leitura, com LIMIT, nossos parques/vendas e cidades (vazio = nada)", () => {
    const q = buildBookingSearchSql({ text: "ana" }, { ourParkIds: ["pA"], cities: ["Lisboa"], limit: 500 })!;
    expect(() => assertReadOnlySql(q.sql)).not.toThrow();
    expect(q.sql).toContain(`b."parkId" IN (`);
    expect(q.sql).toContain(`b."origin"::text = 'MARKETPLACE'`);
    expect(q.params).toEqual(expect.arrayContaining(["lisboa", "lisbon", 100]));
    expect(buildBookingSearchSql({ text: "ana" }, { ourParkIds: [], cities: [] })!.sql).toContain("FALSE");
    expect(buildBookingSearchSql({}, { ourParkIds: ["pA"] })).toBeNull();
  });
  it("linha no formato da cópia, com o projeto pelo parque", async () => {
    const row = { id: "ck1", code: "29484", status: "CHECKED_OUT", park_id: "pA", park_name: "Airpark Lisboa", city: "Lisboa", check_in: "2026-09-01 10:00:00",
      total: "45.5", first_name: "Ana", last_name: "Silva", email: "ANA@x.pt", phone: "+351912345678", plate: "AA-00-BB" };
    expect(mapLiveBookingRow(row, () => 10)).toMatchObject({ id: "ck1", externalId: "ck1", bookingNumber: "29484", projectId: 10, totalPrice: 45.5, clientEmail: "ana@x.pt" });
    const query = vi.fn(async () => [row]) as any;
    const out = await searchLiveBookings({ ref: "29484" }, {}, query);
    expect(out[0]).toMatchObject({ projectId: 10, licensePlate: "AA-00-BB" });
    expect(await searchLiveBookings({}, {}, query)).toEqual([]);
  });
});

describe("ligações a reservas pelo id da Multipark", () => {
  it("WhatsApp: etiqueta \"#n.º · nome\" guardada e lida nas chamadas", () => {
    const label = bookingLabelOf({ id: "ck1", bookingNumber: "29484", clientFirstName: "Ana", clientLastName: "Silva" });
    expect(label).toBe("#29484 · Ana Silva");
    expect(splitBookingLabel(label)).toEqual({ bookingNumber: "29484", bookingClient: "Ana Silva" });
    expect(splitBookingLabel("#ck1 · —")).toEqual({ bookingNumber: "ck1", bookingClient: null });
    expect(splitBookingLabel(null)).toEqual({ bookingNumber: null, bookingClient: null });
  });
  it("migração 0250: colunas novas e passagem das ligações antigas (nada se apaga)", () => {
    const all = MIGRATION_0250_STATEMENTS.join("\n");
    expect(all).toContain("ADD COLUMN `linkedBookingRef`");
    expect(all).toContain("ADD COLUMN `linkedBookingLabel`");
    expect(all).toContain("w.linkedBookingRef IS NULL");
    expect(all).not.toMatch(/DROP|DELETE/i);
    expect(code("server/db.ts")).toContain('import("./migrations/migration_0250")');
  });
  it("dossier: ficha ao vivo → campos que as páginas já mostram", () => {
    const core: any = {
      id: "ck1", code: "29484", status: "CHECKED_OUT", createdAt: "2026-08-01T10:00:00Z", phases: [],
      park: { name: "Airpark Lisboa", city: "Lisboa" }, checkIn: { day: "2026-09-01", time: "10:00", at: "2026-09-01T09:00:00Z" },
      checkOut: { day: "2026-09-05", time: "12:00", at: null }, flights: { departing: { flight: "TP1" }, return: { flight: "TP2" } },
      delivery: { type: "VALET", location: "T1" }, origin: { label: "Site", code: "API", partnerName: null, externalCampaign: null },
      price: { currency: "EUR", bookingPrice: 50, paymentMethod: "MB" }, client: { name: "Ana Silva", email: "ana@x.pt", phone: "+351" },
      vehicle: { plate: "AA-00-BB", brand: "VW", model: "Golf", color: "azul" }, agents: { checkIn: "Rui", checkOut: null }, remarks: "ok",
    };
    const b = dossierBookingFromCore(core, { code: null, allocation: null, garage: { name: "G1", parkingType: null, mapLink: null }, spot: { row: "A", spot: "12", size: null, hasCharger: false, chargerPower: null }, external: null });
    expect(b).toMatchObject({ externalId: "ck1", bookingNumber: "29484", checkIn: "2026-09-01T09:00:00Z", checkOut: "2026-09-05", totalPrice: 50, currentGarage: "G1", currentSpot: "A 12", returnFlight: "TP2", checkinAgentName: "Rui" });
  });
});

describe("a cópia multipark_bookings deixa de ser lida nas pesquisas e ligações", () => {
  it("pesquisas, dossiê, WhatsApp, email, pesquisa global e ficha da reserva", () => {
    for (const f of ["server/complaintDossier.ts", "server/whatsappInboxOps.ts", "server/whatsappCallsQueries.ts", "server/globalSearch.ts", "server/bookingFileRouter.ts", "server/mail/inbox.ts"]) {
      expect(code(f), f).not.toMatch(/multipark_bookings|multiparkBookings/);
    }
    const db = code("server/db.ts");
    const fn = db.slice(db.indexOf("export async function searchBookingByRef"), db.indexOf("\n}\n", db.indexOf("export async function searchBookingByRef")));
    expect(fn).toContain("searchLiveBookings");
    expect(fn).not.toMatch(/multiparkBookings/);
    const inbound = code("server/whatsappInbound.ts");
    const city = inbound.slice(inbound.indexOf("export async function matchBookingCity"));
    expect(city).not.toContain("multipark_bookings");
  });
  it("código morto apagado", () => {
    expect(code("server/db.ts")).not.toContain("findRecentBookingByClientSignals");
    expect(code("server/routers.ts")).not.toContain("bookingPeek");
    expect(code("server/finance/engine.ts")).not.toContain("deliveredConditions");
    expect(code("server/marketingChannels.ts")).not.toMatch(/export function (mixSql|clientsSql)/);
  });
});
