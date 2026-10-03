/**
 * P3 lote 21a — Clientes (lista): a exportação é exatamente o conjunto
 * escolhido, os filtros ao vivo dizem quando cortam, "nos últimos N dias" não
 * apanha o futuro, "não é" das reservas = nenhuma reserva é, a ordem não
 * repete/salta fichas, os filtros guardados validam-se e recuperam-se, e as
 * opções aguentam a Multipark em baixo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";

const live = vi.hoisted(() => ({
  readBookingIdsForFilter: vi.fn(async (_f: any, _p: any): Promise<string[]> => []),
  readCrmFilterOptions: vi.fn(async (): Promise<any[]> => []),
}));
vi.mock("../multiparkDb/crmLive", () => ({ ...live, CRM_RULE_MAX_BOOKINGS: 3 }));
vi.mock("../finance/liveBookings", () => ({ loadLiveContext: async () => ({ ourParks: new Map([["p1", {}]]) }) }));

import { buildWhere, filterOptions, liveDateRange, listClients, prepareLiveFilters, ruleSql } from "./queries";
import { sanitizeSavedView, savedViewSchema, SAVED_VIEW_MAX_CHARS } from "../../shared/crmFilters";
import { saveFilter } from "./edit";
import { SHEET_REPORTS } from "../google/sheetsExport";

const compile = (s: SQL) => new MySqlDialect().sqlToQuery(s);
const opts = { vipThreshold: 500, canSeeTotals: true };

/** BD falsa: guarda o SQL e responde às consultas da lista e das ligações. */
function fakeDb(handler: (sqlText: string, params: unknown[]) => unknown[] = () => []) {
  const seen: { sql: string; params: unknown[] }[] = [];
  return {
    seen,
    execute: async (q: SQL) => {
      const c = compile(q);
      seen.push(c);
      return [handler(c.sql, c.params)];
    },
  };
}

beforeEach(() => {
  live.readBookingIdsForFilter.mockReset();
  live.readBookingIdsForFilter.mockResolvedValue([]);
  live.readCrmFilterOptions.mockReset();
  live.readCrmFilterOptions.mockResolvedValue([]);
});

describe("21a — datas", () => {
  it("«nos últimos N dias» acaba agora: as reservas futuras ficam de fora", () => {
    const r = liveDateRange("within_days", 7)!;
    expect(r.from).toBeTruthy();
    expect(r.to).toBeTruthy();
    // o fim é ~agora (não há data de fim a contar o futuro)
    expect(Math.abs(Date.parse(`${r.to}Z`) - Date.now())).toBeLessThan(60_000);
  });
  it("também na última vinda do cliente (resumo da ficha)", () => {
    const q = compile(ruleSql({ field: "client.lastVisit", op: "within_days", value: 30 }, { canSeeTotals: false })!);
    expect(q.sql).toBe("(c.lastVisit >= ? AND c.lastVisit <= ?)");
  });
});

describe("21a — «não é» das reservas = nenhuma reserva é (como nos carros)", () => {
  it("lê as reservas que SÃO e nega na nossa BD", () => {
    expect(compile(ruleSql({ field: "booking.status", op: "is_not", value: "CANCELLED" }, { canSeeTotals: false }, [4, 5])!).sql).toBe("c.id NOT IN (?, ?)");
    // ninguém tem a reserva → todos cumprem "não é"
    expect(compile(ruleSql({ field: "booking.status", op: "is_not", value: "CANCELLED" }, { canSeeTotals: false }, [])!).sql).toBe("1 = 1");
    expect(compile(ruleSql({ field: "booking.status", op: "is", value: "CANCELLED" }, { canSeeTotals: false }, [4])!).sql).toBe("c.id IN (?)");
  });
  it("a leitura ao vivo do «não é» pede as que são", async () => {
    await prepareLiveFilters(fakeDb(), { rules: { match: "all", items: [{ field: "booking.flight", op: "is_not", value: "TP123" }] } });
    expect(live.readBookingIdsForFilter).toHaveBeenCalledWith({ kind: "flight", op: "is", value: "TP123" }, ["p1"]);
  });
});

describe("21a — resultado incompleto avisa", () => {
  it("uma regra que bate no limite de reservas devolve um aviso", async () => {
    live.readBookingIdsForFilter.mockResolvedValue(["b1", "b2", "b3"]); // limite (mock) = 3
    const r = await prepareLiveFilters(fakeDb(() => [{ clientId: 1 }]), { rules: { match: "all", items: [{ field: "booking.status", op: "is", value: "CHECKED_OUT" }] } });
    expect(r.warnings.join(" ")).toMatch(/Reserva › Estado.*incompleto/);
  });
  it("as regras ao vivo correm em paralelo (não uma a uma)", async () => {
    let inFlight = 0, peak = 0;
    live.readBookingIdsForFilter.mockImplementation(async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((res) => setTimeout(res, 5));
      inFlight--;
      return [];
    });
    const items = ["A", "B", "C", "D"].map((v) => ({ field: "booking.flight", op: "contains" as const, value: v }));
    await prepareLiveFilters(fakeDb(), { rules: { match: "all", items } });
    expect(peak).toBeGreaterThan(1);
  });
});

describe("21a — «Qualquer campo» também procura o n.º de reserva", () => {
  it("quando o texto é um número", async () => {
    live.readBookingIdsForFilter.mockResolvedValue(["bk1"]);
    const r = await prepareLiveFilters(fakeDb(() => [{ clientId: 42 }]), { search: { text: "123456", field: "all" } });
    expect(live.readBookingIdsForFilter).toHaveBeenCalledWith({ kind: "ref", value: "123456" }, ["p1"]);
    expect(r.bookingSearch).toEqual([42]);
    const where = compile(buildWhere({ search: { text: "123456", field: "all" } }, { ...opts, live: r }));
    expect(where.sql).toContain("c.id IN (?)");
  });
  it("texto que não é número não vai à Multipark", async () => {
    await prepareLiveFilters(fakeDb(), { search: { text: "Silva", field: "all" } });
    expect(live.readBookingIdsForFilter).not.toHaveBeenCalled();
  });
  it("se a Multipark falhar na pesquisa livre, avisa em vez de partir a lista", async () => {
    live.readBookingIdsForFilter.mockRejectedValue(new Error("timeout"));
    const r = await prepareLiveFilters(fakeDb(), { search: { text: "123456", field: "all" } });
    expect(r.bookingSearch).toBeNull();
    expect(r.warnings.join(" ")).toMatch(/n\.º de reserva/);
  });
  it("na pesquisa só por n.º de reserva, a falha é um erro (não um vazio)", async () => {
    live.readBookingIdsForFilter.mockRejectedValue(new Error("timeout"));
    await expect(prepareLiveFilters(fakeDb(), { search: { text: "123456", field: "booking" } })).rejects.toThrow("timeout");
  });
});

describe("21a — pessoa ou empresa", () => {
  it("filtro próprio (o Pro/particular não distinguia uma empresa que não é Pro)", () => {
    expect(compile(buildWhere({ groups: { type: ["company"] } }, opts)).sql).toContain("c.kind = 'company'");
    expect(compile(buildWhere({ groups: { type: ["person"] } }, opts)).sql).toContain("c.kind <> 'company'");
    expect(compile(buildWhere({ groups: { type: ["person", "company"] } }, opts)).sql).not.toContain("c.kind");
  });
});

describe("21a — a ordem acaba sempre no n.º da ficha (paginação estável)", () => {
  const listDb = () => fakeDb((s) => (s.includes("COUNT(*)") ? [{ n: 0 }] : []));
  for (const sort of ["name", "nextCheckIn", "totalSpent", "firstVisit", "lastVisit", "bookings"] as const) {
    it(sort, async () => {
      const db = listDb();
      await listClients(db, { sort, dir: "asc" }, { canSeeTotals: true });
      const q = db.seen.find((x) => x.sql.includes("ORDER BY"))!;
      expect(q.sql).toMatch(/ORDER BY .*c\.id (ASC|DESC)\s+LIMIT/s);
    });
  }
  it("o telefone só vai na resposta para a exportação", async () => {
    const row = { id: 1, displayName: "Ana", kind: "person", isPro: 0, primaryEmail: "a@x.pt", primaryPhone: "+351912345678", bookings: 1, completed: 1, cancelled: 0, upcoming: 0, partnerBookings: 0 };
    const db = fakeDb((s) => (s.includes("COUNT(*)") ? [{ n: 1 }] : s.includes("FROM crm_clients c") ? [row] : []));
    expect((await listClients(db, {}, { canSeeTotals: false })).rows[0].primaryPhone).toBeNull();
    expect((await listClients(db, {}, { canSeeTotals: false, includeContacts: true })).rows[0].primaryPhone).toBe("+351912345678");
  });
});

describe("21a — filtros guardados", () => {
  it("um filtro válido passa tal e qual", () => {
    const v = { tab: "clients", search: { text: "ana", field: "name" }, groups: { city: ["Lisboa"] }, rules: { match: "all", items: [{ field: "vehicle.color", op: "is", value: "vermelho" }] }, sort: "name", dir: "asc" };
    const r = sanitizeSavedView(v);
    expect(r.dropped).toBe(0);
    expect(r.view).toEqual(v);
  });
  it("regras com campos que deixaram de existir caem e contam-se; o resto aplica-se", () => {
    const r = sanitizeSavedView({ groups: { city: ["Porto"] }, rules: { match: "any", items: [{ field: "campo.velho", op: "is", value: "x" }, { field: "client.nif", op: "yes" }] } });
    expect(r.dropped).toBe(1);
    expect(r.view.rules).toEqual({ match: "any", items: [{ field: "client.nif", op: "yes" }] });
    expect(r.view.groups).toEqual({ city: ["Porto"] });
  });
  it("um grupo mau não leva os outros (nem a pesquisa)", () => {
    const r = sanitizeSavedView({ search: { text: "x", field: "all" }, groups: { city: ["Faro"], segment: ["inventado"], novoGrupo: ["?"] }, sort: "qualquer" });
    expect(r.view.groups).toEqual({ city: ["Faro"] });
    expect(r.view.search).toEqual({ text: "x", field: "all" });
    expect(r.view.sort).toBeUndefined();
    expect(r.dropped).toBe(3);
  });
  it("lixo não parte a página", () => {
    expect(() => sanitizeSavedView("nada")).not.toThrow();
    expect(sanitizeSavedView(null).view).toEqual({ search: null, groups: {} });
  });
  it("ao guardar: inválido ou grande demais é recusado (nunca cortado a meio)", async () => {
    const db = fakeDb();
    await expect(saveFilter(db, 1, { name: "x", payload: { sort: "inventado" }, shared: false, isDefault: false })).rejects.toThrow(/inválidos/);
    const big = { groups: { park: Array.from({ length: 200 }, (_, i) => `Parque ${i} `.padEnd(150, "x")) }, rules: null };
    expect(JSON.stringify(savedViewSchema.parse(big)).length).toBeGreaterThan(SAVED_VIEW_MAX_CHARS / 3);
    const huge = { groups: Object.fromEntries(["park", "partner"].map((k) => [k, Array.from({ length: 200 }, (_, i) => `${k}${i}`.padEnd(160, "y"))])) };
    await expect(saveFilter(db, 1, { name: "x", payload: huge, shared: false, isDefault: false })).rejects.toThrow(/grande demais/);
    expect(db.seen.some((q) => q.sql.includes("INSERT"))).toBe(false);
    await saveFilter(db, 1, { name: "ok", payload: { groups: { city: ["Lisboa"] } }, shared: true, isDefault: false });
    const ins = db.seen.find((q) => q.sql.includes("INSERT INTO crm_saved_filters"))!;
    expect(JSON.parse(String(ins.params[2]))).toEqual({ groups: { city: ["Lisboa"] } });
  });
});

describe("21a — opções dos filtros com a Multipark em baixo", () => {
  it("as nossas opções aparecem e o motivo vem à parte (o pedido não falha)", async () => {
    live.readCrmFilterOptions.mockRejectedValue(new Error("ECONNREFUSED"));
    const db = fakeDb((s) => (s.includes("FROM crm_clients") ? [{ v: "PT", n: 3 }] : []));
    const o = await filterOptions(db);
    expect(o.liveError).toMatch(/Multipark não respondeu/);
    expect(o.parks).toEqual([]);
    expect(o.clientCountries[0]).toMatchObject({ value: "PT", n: 3 });
    expect(o.regions.length).toBeGreaterThan(0);
  });
});

describe("21a — exportação = exatamente o conjunto da lista", () => {
  it("leva a pesquisa toda (campo, grupos, regras, ordem), pede os contactos e avisa quando corta", async () => {
    const calls: any[] = [];
    const call = async (path: string, input: any) => {
      calls.push({ path, input });
      return { canSeeTotals: false, total: 3, warnings: [], rows: [{ id: 1, displayName: "Ana", kind: "company", primaryEmail: "a@x.pt", primaryPhone: "+351", bookings: 2, completed: 1, upcoming: 0, cancelled: 0, firstVisit: null, lastVisit: null }] };
    };
    const query = { tab: "clients" as const, search: { text: "TP12", field: "booking" as const }, groups: { park: ["Redpark Porto"] }, rules: { match: "all" as const, items: [{ field: "vehicle.color", op: "is" as const, value: "vermelho" }] }, sort: "name" as const, dir: "asc" as const };
    const tabs = await SHEET_REPORTS.clientes.load(call, { report: "clientes", query }, Date.now() + 60_000);
    expect(calls[0].path).toBe("crm.list");
    expect(calls[0].input).toMatchObject({ ...query, offset: 0, limit: 200, includeContacts: true });
    expect(tabs[0].rows[1]).toContain("Empresa");
    expect(tabs[0].note).toMatch(/1 de 3 clientes/);
  });
  it("sem corte não há aviso", async () => {
    const call = async () => ({ canSeeTotals: false, total: 1, warnings: [], rows: [{ id: 1, displayName: "Ana", kind: "person", bookings: 1, completed: 1, upcoming: 0, cancelled: 0 }] });
    const tabs = await SHEET_REPORTS.clientes.load(call, { report: "clientes", query: { tab: "clients" } }, Date.now() + 60_000);
    expect(tabs[0].note).toBeUndefined();
  });
  it("os avisos da lista (filtro ao vivo cortado) passam para a folha", async () => {
    const call = async () => ({ canSeeTotals: false, total: 0, warnings: ["«Reserva › Estado» apanhou mais de 50 000 reservas"], rows: [] });
    const tabs = await SHEET_REPORTS.clientes.load(call, { report: "clientes", query: { tab: "clients" } }, Date.now() + 60_000);
    expect(tabs[0].note).toMatch(/50 000 reservas/);
  });
});
