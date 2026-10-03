/**
 * P3 lote 21b — Ficha do cliente: retirar não apaga sem rasto (fica em
 * "Retirados" e repõe-se), juntar não repõe o que se tirou à ficha que fica,
 * separar devolve tudo (contactos, reservas, retirados, conta Pro, Pro,
 * notas, etiquetas, bloqueios), o que se mexe à mão fica trancado, a ficha
 * aguenta a Multipark em baixo e o registo não guarda NIFs por inteiro.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";

vi.mock("./sync", () => ({ recomputeMetrics: vi.fn(async () => {}) }));
const logged = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock("../db", () => ({ logActivity: vi.fn(async (x: any) => { logged.calls.push(x); }) }));
const live = vi.hoisted(() => ({ readCrmBookingFacts: vi.fn(async (): Promise<any[]> => []) }));
vi.mock("../multiparkDb/crmLive", () => live);

import { MiniDb, ficha } from "./miniDb.testutil";
import { mergeClients, mergeNotes, mergeTags, splitMerge } from "./merge";
import { removeEmail, removeVehicle, restoreRemoved, updateClient } from "./edit";
import { getClientFile } from "./queries";
import { maskSensitive } from "../../shared/logMask";

beforeEach(() => { logged.calls = []; live.readCrmBookingFacts.mockReset(); live.readCrmBookingFacts.mockResolvedValue([]); });

/** Duas fichas com contactos, reservas, um retirado, uma conta Pro, notas e etiquetas. */
function twoClients() {
  const db = new MiniDb();
  ficha(db, 1, { displayName: "Ana Silva", notes: "Prefere o P2", tagsJson: JSON.stringify(["vip"]), bookings: 5 });
  ficha(db, 2, { displayName: "Ana Silva", notes: "Cliente desde 2019", tagsJson: JSON.stringify(["pro", "vip"]), isPro: 1, bookings: 2 });
  db.insert("crm_client_emails", { id: 11, clientId: 1, email: "ana@x.pt", isPrimary: 1, generic: 0, source: "bookings" });
  db.insert("crm_client_emails", { id: 21, clientId: 2, email: "ana.silva@y.pt", isPrimary: 1, generic: 0, source: "bookings" });
  db.insert("crm_client_emails", { id: 22, clientId: 2, email: "ana@x.pt", isPrimary: 0, generic: 0, source: "bookings" });
  db.insert("crm_client_phones", { id: 23, clientId: 2, phone: "+351912345678", isPrimary: 1, source: "bookings" });
  db.insert("crm_client_vehicles", { id: 24, clientId: 2, plate: "AA12BB", plateDisplay: "AA-12-BB", brand: "Renault", bookings: 2 });
  db.insert("crm_booking_links", { id: 25, clientId: 2, bookingExternalId: "bk-2", role: "traveler" });
  db.insert("crm_client_external_ids", { id: 26, clientId: 2, system: "multipark_client", externalId: "mp-2" });
  db.insert("crm_removed_items", { id: 27, clientId: 2, kind: "phone", value: "+351210000000", rowJson: "{}", restoredAt: null });
  db.insert("crm_pro_accounts", { id: 28, crmClientId: 2, mpClientId: "mp-2" });
  db.insert("crm_blocked_identifiers", { clientId: 2, kind: "email", value: "velho@y.pt" });
  return db;
}

describe("21b — juntar e separar: nada se perde", () => {
  it("juntar leva tudo para a que fica; separar devolve tudo a cada uma", async () => {
    const db = twoClients();
    const { eventId } = await mergeClients(db, { survivorId: 1, mergedId: 2, userId: 9 });
    // depois de juntar
    expect(db.rows("crm_clients", (r) => r.id === 2)[0]).toMatchObject({ status: "merged", mergedInto: 1 });
    expect(db.rows("crm_client_emails", (r) => r.clientId === 1).map((r) => r.email).sort()).toEqual(["ana.silva@y.pt", "ana@x.pt"]);
    expect(db.rows("crm_client_phones", (r) => r.clientId === 1)).toHaveLength(1);
    expect(db.rows("crm_booking_links", (r) => r.clientId === 1)).toHaveLength(1);
    expect(db.rows("crm_removed_items", (r) => r.clientId === 1)).toHaveLength(1);
    expect(db.rows("crm_pro_accounts")[0].crmClientId).toBe(1);
    const s = db.rows("crm_clients", (r) => r.id === 1)[0];
    expect(s.isPro).toBe(1);
    expect(s.notes).toContain("Prefere o P2");
    expect(s.notes).toContain("Da ficha N.º 2");
    expect(s.notes).toContain("Cliente desde 2019");
    expect(JSON.parse(s.tagsJson).sort()).toEqual(["pro", "vip"]);
    expect(db.rows("crm_blocked_identifiers", (r) => r.clientId === 1 && r.value === "velho@y.pt")).toHaveLength(1);

    await splitMerge(db, { eventId, userId: 9 });
    // depois de separar: cada uma como estava
    expect(db.rows("crm_clients", (r) => r.id === 2)[0]).toMatchObject({ status: "active", mergedInto: null });
    expect(db.rows("crm_client_emails", (r) => r.clientId === 1).map((r) => r.email)).toEqual(["ana@x.pt"]);
    expect(db.rows("crm_client_emails", (r) => r.clientId === 2).map((r) => r.email).sort()).toEqual(["ana.silva@y.pt", "ana@x.pt"]);
    expect(db.rows("crm_client_phones", (r) => r.clientId === 2)).toHaveLength(1);
    expect(db.rows("crm_client_vehicles", (r) => r.clientId === 2)).toHaveLength(1);
    expect(db.rows("crm_booking_links", (r) => r.clientId === 2)).toHaveLength(1);
    expect(db.rows("crm_removed_items", (r) => r.clientId === 2)).toHaveLength(1);
    expect(db.rows("crm_pro_accounts")[0].crmClientId).toBe(2);
    const back = db.rows("crm_clients", (r) => r.id === 1)[0];
    expect(back.isPro).toBe(0);
    expect(back.notes).toBe("Prefere o P2");
    expect(back.tagsJson).toBe(JSON.stringify(["vip"]));
    expect(db.rows("crm_blocked_identifiers", (r) => r.clientId === 1)).toHaveLength(0);
    expect(db.rows("crm_blocked_identifiers", (r) => r.clientId === 2)).toHaveLength(1);
  });

  it("separar devolve a conta Pro mesmo que o crm-pro-sync a tenha ligado à que ficou", async () => {
    const db = twoClients();
    db.tables.set("crm_pro_accounts", []); // a conta só aparece DEPOIS da junção
    const { eventId } = await mergeClients(db, { survivorId: 1, mergedId: 2, userId: 9 });
    db.insert("crm_pro_accounts", { id: 40, crmClientId: 1, mpClientId: "mp-2" }); // o sync seguiu a junção
    await splitMerge(db, { eventId, userId: 9 });
    expect(db.rows("crm_pro_accounts")[0].crmClientId).toBe(2);
  });

  it("juntar não repõe na ficha que fica o que lhe foi tirado à mão", async () => {
    const db = twoClients();
    db.insert("crm_blocked_identifiers", { clientId: 1, kind: "phone", value: "+351912345678" });
    const { eventId } = await mergeClients(db, { survivorId: 1, mergedId: 2, userId: 9 });
    expect(db.rows("crm_client_phones", (r) => r.clientId === 1)).toHaveLength(0);
    // fica no retrato da junção: ao separar volta à absorvida
    await splitMerge(db, { eventId, userId: 9 });
    expect(db.rows("crm_client_phones", (r) => r.clientId === 2).map((r) => r.phone)).toEqual(["+351912345678"]);
  });

  it("separar não desfaz o que alguém mudou depois da junção (notas editadas ficam)", async () => {
    const db = twoClients();
    const { eventId } = await mergeClients(db, { survivorId: 1, mergedId: 2, userId: 9 });
    db.rows("crm_clients", (r) => r.id === 1)[0].notes = "Reescrito depois";
    await splitMerge(db, { eventId, userId: 9 });
    expect(db.rows("crm_clients", (r) => r.id === 1)[0].notes).toBe("Reescrito depois");
  });

  it("notas e etiquetas: juntam-se sem repetir e sem perder as da absorvida", () => {
    expect(mergeNotes(null, "B", 7)).toBe("B");
    expect(mergeNotes("A", null, 7)).toBe("A");
    expect(mergeNotes("A e B", "B", 7)).toBe("A e B");
    expect(mergeNotes("A", "B", 7)).toBe("A\n\n— Da ficha N.º 7 —\nB");
    expect(JSON.parse(mergeTags('["a","b"]', '["b","c"]')!)).toEqual(["a", "b", "c"]);
    expect(mergeTags(null, "lixo")).toBeNull();
  });
});

describe("21b — retirar fica guardado e repõe-se", () => {
  it("email: a linha inteira vai para Retirados, sai da ficha, fica bloqueada; Repor desfaz", async () => {
    const db = twoClients();
    await removeEmail(db, 9, 2, 21, "email antigo");
    expect(db.rows("crm_client_emails", (r) => r.id === 21)).toHaveLength(0);
    const [r] = db.rows("crm_removed_items", (x) => x.kind === "email");
    expect(r).toMatchObject({ clientId: 2, value: "ana.silva@y.pt", reason: "email antigo", removedBy: 9 });
    expect(JSON.parse(r.rowJson)).toMatchObject({ email: "ana.silva@y.pt", source: "bookings" });
    expect(db.rows("crm_blocked_identifiers", (x) => x.clientId === 2 && x.value === "ana.silva@y.pt")).toHaveLength(1);

    await restoreRemoved(db, 9, 2, r.id);
    expect(db.rows("crm_client_emails", (x) => x.clientId === 2 && x.email === "ana.silva@y.pt")[0]).toMatchObject({ isPrimary: 0, source: "bookings" });
    expect(db.rows("crm_blocked_identifiers", (x) => x.clientId === 2 && x.value === "ana.silva@y.pt")).toHaveLength(0);
    expect(db.rows("crm_removed_items", (x) => x.id === r.id)[0].restoredAt).toBeTruthy();
    await expect(restoreRemoved(db, 9, 2, r.id)).rejects.toThrow(/Já não está/);
  });
  it("carro: marca, modelo e reservas voltam tal e qual", async () => {
    const db = twoClients();
    await removeVehicle(db, 9, 2, 24);
    const [r] = db.rows("crm_removed_items", (x) => x.kind === "vehicle");
    await restoreRemoved(db, 9, 2, r.id);
    expect(db.rows("crm_client_vehicles", (x) => x.clientId === 2)[0]).toMatchObject({ plate: "AA12BB", brand: "Renault", bookings: 2 });
  });
  it("retirar o que não existe nesta ficha não mexe em nada", async () => {
    const db = twoClients();
    await expect(removeEmail(db, 9, 1, 21)).rejects.toThrow(/não encontrado/);
    expect(db.rows("crm_removed_items", (x) => x.kind === "email")).toHaveLength(0);
  });
});

describe("21b — o que se mexe à mão fica trancado", () => {
  it("NIF limpo à mão e consentimento posto em «Por saber» ficam marcados para a carga não os repor", async () => {
    const db = twoClients();
    db.rows("crm_clients", (r) => r.id === 1)[0].nif = "123456789";
    db.rows("crm_clients", (r) => r.id === 1)[0].consentEmail = 1;
    const H = (db as any);
    // updateClient lê a ficha com "AND status = 'active'"
    const orig = H.execute.bind(db);
    H.execute = async (q: SQL) => {
      const { sql } = new MySqlDialect().sqlToQuery(q);
      if (/^SELECT \* FROM crm_clients WHERE id = \? AND status = 'active'$/.test(sql.replace(/\s+/g, " ").trim())) return [db.rows("crm_clients", (r) => r.id === 1).map((r) => ({ ...r }))];
      return orig(q);
    };
    await updateClient(db, 9, 1, { nif: null, consentEmail: null });
    const locks = db.rows("crm_blocked_identifiers", (r) => r.clientId === 1 && r.kind === "field").map((r) => r.value).sort();
    expect(locks).toEqual(["consentEmail", "nif"]);
  });
});

describe("21b — a ficha aguenta a Multipark em baixo", () => {
  it("as reservas dizem que não carregaram; o resto da ficha abre", async () => {
    live.readCrmBookingFacts.mockRejectedValue(new Error("ETIMEDOUT"));
    const client = { id: 1, kind: "person", status: "active", displayName: "Ana", bookings: 3, cancelled: 0, completed: 2, upcoming: 0, partnerBookings: 0, isPro: 0, metricsAtS: "2026-10-02 04:00:00" };
    const db = {
      execute: async (q: SQL) => {
        const t = new MySqlDialect().sqlToQuery(q).sql;
        if (/FROM crm_clients WHERE id = \?/.test(t) && /metricsAt/.test(t)) return [[client]];
        if (/FROM crm_booking_links/.test(t)) return [[{ bookingExternalId: "bk1", role: "traveler" }]];
        if (/FROM crm_client_emails/.test(t)) return [[{ id: 1, email: "ana@x.pt", isPrimary: 1, generic: 0, source: "bookings" }]];
        return [[]];
      },
    };
    const f: any = await getClientFile(db, 1, { canSeeTotals: false, canSeeIban: false });
    expect(f.bookingsError).toMatch(/Multipark não respondeu/);
    expect(f.bookings).toEqual([]);
    expect(f.metricsAt).toBe("2026-10-02 04:00:00");
    expect(f.emails[0].email).toBe("ana@x.pt");
    expect(f.metrics.bookings).toBe(3);
  });
});

describe("21b — registo sem NIF por inteiro (antes → depois)", () => {
  it("o NIF dentro de {from,to} fica só com a terminação", () => {
    const out = maskSensitive(JSON.stringify({ nif: { from: "123456789", to: null }, displayName: { from: "Ana", to: "Ana Silva" } }))!;
    expect(out).not.toContain("123456789");
    expect(out).toContain("•••789");
    expect(out).toContain("Ana Silva");
  });
  it("segredos aninhados ficam escondidos; texto que não é JSON não muda", () => {
    expect(maskSensitive(JSON.stringify({ token: { a: "abc" } }))).toBe(JSON.stringify({ token: { a: "•••" } }));
    expect(maskSensitive("Ficha 12 editada")).toBe("Ficha 12 editada");
    expect(maskSensitive(JSON.stringify({ phone: { kinds: "nif" } }))).toBe(JSON.stringify({ phone: { kinds: "nif" } }));
  });
});
