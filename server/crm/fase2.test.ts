import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { crmBookingIdsOf, crmEmailByPhone, crmEmailExists, findCrmClientIds, lookupCond } from "./lookup";
import { clientBookingStats } from "../db";
import { contactKindsFor } from "../../shared/contacts";

const dialect = new MySqlDialect();
const render = (q: any) => dialect.sqlToQuery(q);
const root = join(__dirname, "..", "..");
const src = (f: string) => readFileSync(join(root, f), "utf8").split("\n").filter((l) => !/^\s*(\*|\/\/)/.test(l)).join("\n");

function fakeDb(rows: any[] = []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  return { calls, execute: vi.fn(async (q: any) => { calls.push(render(q)); return [rows, []]; }) };
}

describe("CRM fase 2: quem é o cliente (fichas do CRM)", () => {
  it("email, telefone (E.164) e matrícula normalizados; o nome só entra sem os outros", () => {
    const q = render(lookupCond({ email: " Ana@X.pt ", phone: "912 345 678", plate: "aa-00-bb", name: "Ana Silva" }));
    expect(q.sql).toContain("crm_client_emails ce WHERE ce.email = ?");
    expect(q.sql).toContain("crm_client_phones cp WHERE cp.phone = ?");
    expect(q.sql).toContain("crm_client_vehicles cv WHERE cv.plate = ?");
    expect(q.sql).not.toContain("displayName");
    expect(q.params).toEqual(["ana@x.pt", "+351912345678", "AA00BB"]);
    const byName = render(lookupCond({ name: "Ana_Silva" }));
    expect(byName.sql).toContain("c.displayName LIKE ?");
    expect(byName.params).toEqual(["%Ana\\_Silva%"]);
    expect(lookupCond({ name: "Ana" })).toBeNull();
    expect(lookupCond({})).toBeNull();
    expect(render(lookupCond({ clientId: 42 })).sql).toContain("c.id = ?");
  });
  it("só fichas ativas; com âmbito de cidade a pedido (as ligações automáticas não têm)", async () => {
    const db = fakeDb([{ id: 3 }]);
    expect(await findCrmClientIds(db, { email: "ana@x.pt" }, { visible: false })).toEqual([3]);
    expect(db.calls[0].sql).toContain("c.status = 'active'");
    expect(db.calls[0].sql).toContain("1 = 1");
    const none = fakeDb();
    expect(await findCrmClientIds(none, { name: "Al" })).toEqual([]);
    expect(none.execute).not.toHaveBeenCalled();
  });
  it("ligações automáticas do email: email não genérico de uma ficha ativa; email pelo telefone", async () => {
    const db = fakeDb([{ x: 1 }]);
    expect(await crmEmailExists(db, "ANA@x.pt")).toBe(true);
    expect(db.calls[0].sql).toContain("ce.generic = 0");
    expect(db.calls[0].params).toEqual(["ana@x.pt"]);
    expect(await crmEmailExists(fakeDb(), "não é email")).toBe(false);
    const p = fakeDb([{ email: "ana@x.pt" }]);
    expect(await crmEmailByPhone(p, "+351 912 345 678")).toBe("ana@x.pt");
    expect(p.calls[0].params).toEqual(["+351912345678"]);
    expect(await crmEmailByPhone(fakeDb(), "12")).toBeNull();
  });
  it("reservas da ficha: pelas ligações reserva → ficha", async () => {
    const db = fakeDb([{ bookingExternalId: "bk1" }, { bookingExternalId: "bk2" }]);
    expect(await crmBookingIdsOf(db, [5, 5, 0])).toEqual(["bk1", "bk2"]);
    expect(db.calls[0].sql).toContain("FROM crm_booking_links");
    expect(await crmBookingIdsOf(fakeDb(), [])).toEqual([]);
  });
});

describe("CRM fase 2: histórico do cliente nas outras páginas", () => {
  it("estatísticas pelas reservas ao vivo (gasto só em estadias; canceladas contadas)", () => {
    const s = clientBookingStats([
      { status: "CHECKED_OUT", checkIn: "2026-01-10 08:00:00", total: 40 },
      { status: "CHECKED_IN", checkIn: "2026-05-01 08:00:00", total: 60 },
      { status: "CANCELLED", checkIn: "2026-06-01 08:00:00", total: 99 },
      { status: "BOOKED", checkIn: "2026-12-01 08:00:00", total: 30 },
    ]);
    expect(s).toEqual({ total: 4, firstCheckIn: "2026-01-10 08:00:00", lastCheckIn: "2026-12-01 08:00:00", totalSpent: 100, avgSpend: 50, cancelled: 1 });
    expect(clientBookingStats([])).toMatchObject({ total: 0, totalSpent: 0, avgSpend: 0 });
  });
  it("getClientHistory lê as fichas e as reservas ao vivo, não a cópia", () => {
    const db = src("server/db.ts");
    const fn = db.slice(db.indexOf("export async function getClientHistory"), db.indexOf("function inArraySql"));
    expect(fn).toContain("findCrmClientIds");
    expect(fn).toContain("readCrmBookingFacts");
    expect(fn).not.toMatch(/multiparkBookings|multipark_bookings/);
  });
});

describe("CRM fase 2: o CRM leve antigo saiu", () => {
  it("sem clientsCrm.ts, sem a página antiga e sem clients.list/stats/profile", () => {
    expect(existsSync(join(root, "server/clientsCrm.ts"))).toBe(false);
    expect(existsSync(join(root, "client/src/pages/ClientsPage.tsx"))).toBe(false);
    const r = src("server/routers.ts");
    expect(r).not.toMatch(/import\("\.\/clientsCrm"\)/);
    expect(src("client/src/pages/CrmClientsPage.tsx")).not.toContain("./ClientsPage");
  });
  it("email, Drive, reuniões, Contactos e dossiê da reserva encontram o cliente pelas fichas", () => {
    for (const f of ["server/crm/lookup.ts", "server/contactsSearch.ts", "server/contactsRouter.ts", "server/google/driveAccess.ts", "server/google/router.ts", "server/mail/service.ts"]) {
      expect(src(f), f).not.toMatch(/multipark_bookings|multiparkBookings/);
    }
    const inbox = src("server/mail/inbox.ts");
    const suggest = inbox.slice(inbox.indexOf("export async function contactSuggestions"), inbox.indexOf("export async function attachmentBytes"));
    expect(suggest).toContain("crm_client_emails");
    expect(suggest).not.toContain("multipark_bookings");
  });
  it("quem vê os Contactos pode ligar a um cliente (fichas do CRM)", () => {
    const kinds = contactKindsFor({ role: "condutor", accessOverrides: { contactos: { access: "city", actions: ["view"] } } as any }).map((k) => k.kind);
    expect(kinds).toContain("client");
  });
});
