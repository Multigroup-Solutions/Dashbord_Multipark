import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

// H01 (P1, 1 out 2026): uma leitura do rascunho da passagem de turno que falhou
// ou veio cortada pelo LIMIT dava os pendentes desse tipo como "resolvidos pelo
// sistema" — e o afterSave gravava isso na passagem anterior. Agora só se
// fecham por ausência os tipos lidos por inteiro.

const state = vi.hoisted(() => ({
  complaintsFail: false,
  pdasFail: false,
  pdaRows: [] as any[],
  lostRows: [] as any[],
  previousOpenItems: [] as any[],
}));

const dialect = new MySqlDialect();
const fakeDb = {
  select: () => ({ from: async () => [{ id: 49, parentId: null, name: "Lisboa", level: "city" }] }),
  execute: async (q: any) => {
    const text = dialect.sqlToQuery(q).sql;
    if (/FROM complaints/.test(text)) {
      if (state.complaintsFail) throw new Error("ligação perdida");
      return [[]];
    }
    if (/FROM lost_found_items/.test(text)) return [state.lostRows];
    if (/FROM pda_checkins/.test(text)) {
      if (state.pdasFail) throw new Error("ligação perdida");
      return [state.pdaRows];
    }
    if (/FROM `shift_handovers`/.test(text)) {
      return [[{ id: 7, notes: null, aiSummary: null, createdByName: "Ana", createdById: 1, ackByName: null, ackAt: null, openItems: JSON.stringify(state.previousOpenItems) }]];
    }
    return [[]];
  },
};

vi.mock("./db", async (original) => ({ ...(await original<object>()), getDb: async () => fakeDb }));
vi.mock("./multiparkDb/shiftState", () => ({
  getMultiparkShiftState: async () => ({ available: false, code: "QUERY_FAILED", reason: "sem BD da Multipark" }),
}));
vi.mock("./appSettings", async (original) => ({ ...(await original<object>()), getSetting: async () => [] }));
vi.mock("./whatsappInbox", () => ({ listConversations: async () => [] }));

import { confirmedDraftKinds, mergeCarryOver, openItemKey, type OpenItem } from "../shared/shiftHandoverAuto";
import { buildHandoverDraft } from "./shiftHandoverDraft";

const item = (kind: OpenItem["kind"], id: number): OpenItem => ({ key: openItemKey(kind, id), kind, text: `${kind} #${id}`, resolved: false, since: "2026-09-30 morning" });

beforeEach(() => {
  state.complaintsFail = false;
  state.pdasFail = false;
  state.pdaRows = [];
  state.lostRows = [];
  // 44b: só PDAs e notas passam de turno (a reclamação herdada já não passa)
  state.previousOpenItems = [item("pda", 5), item("pda", 9), item("complaint", 7)];
});

describe("confirmedDraftKinds", () => {
  it("só os tipos lidos sem falha e sem corte", () => {
    expect(confirmedDraftKinds({
      complaint: { ok: false, truncated: false },
      lost_found: { ok: true, truncated: false },
      pda: { ok: true, truncated: true },
      incident: { ok: true, truncated: false },
    }).sort()).toEqual(["incident", "lost_found"]);
  });

  it("mergeCarryOver: um tipo não confirmado fica aberto; um confirmado e ausente fecha", () => {
    const previous = [item("pda", 3)];
    // PDAs lidos mas cortados pelo LIMIT → não se fecham
    const cut = mergeCarryOver({ previous, draft: [], draftKinds: confirmedDraftKinds({ pda: { ok: true, truncated: true } }), nowIso: "2026-10-01T02:30:00.000Z" });
    expect(cut[0]).toMatchObject({ key: "pda:3", resolved: false });
    // leitura que falhou → também não
    const failed = mergeCarryOver({ previous, draft: [], draftKinds: confirmedDraftKinds({ pda: { ok: false, truncated: false } }), nowIso: "2026-10-01T02:30:00.000Z" });
    expect(failed[0]).toMatchObject({ key: "pda:3", resolved: false });
    // lidos por inteiro e ausente → fecha pelo sistema
    const ok = mergeCarryOver({ previous, draft: [], draftKinds: confirmedDraftKinds({ pda: { ok: true, truncated: false } }), nowIso: "2026-10-01T02:30:00.000Z" });
    expect(ok[0]).toMatchObject({ key: "pda:3", resolved: true, resolvedByName: "sistema" });
  });
});

describe("buildHandoverDraft — leitura falhada não fecha pendentes", () => {
  const key = { date: "2026-10-01", shift: "morning" as const, city: "lisbon" as const };

  it("os PDAs falham ao ler → os PDAs pendentes continuam abertos; a reclamação herdada já não passa", async () => {
    state.pdasFail = true;
    const d = await buildHandoverDraft(key, Date.UTC(2026, 9, 1, 9, 0));
    const by = new Map(d!.carryOver.map((i) => [i.key, i]));
    expect(by.get("pda:5")?.resolved).toBe(false);
    expect(by.get("pda:9")?.resolved).toBe(false);
    expect(by.has("complaint:7")).toBe(false);
  });

  it("lista de PDAs cortada pelo LIMIT → o pendente que não aparece NÃO se dá como resolvido", async () => {
    state.pdaRows = Array.from({ length: 200 }, (_, i) => ({ id: 1000 + i, pdaName: "PDA", employeeName: "x", t: 0 }));
    const d = await buildHandoverDraft(key, Date.UTC(2026, 9, 1, 9, 0));
    const by = new Map(d!.carryOver.map((i) => [i.key, i]));
    expect(by.get("pda:5")?.resolved).toBe(false);
  });

  it("PDAs lidos por inteiro e sem o pendente → fecha pelo sistema", async () => {
    state.pdaRows = [{ id: 9, pdaName: "PDA 9", employeeName: "Rui", t: 0 }];
    const d = await buildHandoverDraft(key, Date.UTC(2026, 9, 1, 9, 0));
    const by = new Map(d!.carryOver.map((i) => [i.key, i]));
    expect(by.get("pda:5")).toMatchObject({ resolved: true, resolvedByName: "sistema" });
    expect(by.get("pda:9")?.resolved).toBe(false);
  });
});
