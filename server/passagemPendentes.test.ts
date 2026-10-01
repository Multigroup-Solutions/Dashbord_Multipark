import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

// H01 (P1, 1 out 2026): uma leitura do rascunho da passagem de turno que falhou
// ou veio cortada pelo LIMIT dava os pendentes desse tipo como "resolvidos pelo
// sistema" — e o afterSave gravava isso na passagem anterior. Agora só se
// fecham por ausência os tipos lidos por inteiro.

const state = vi.hoisted(() => ({
  complaintsFail: false,
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
  state.lostRows = [];
  state.previousOpenItems = [item("complaint", 5), item("lost_found", 9)];
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
    const merged = mergeCarryOver({
      previous: [item("complaint", 5), item("pda", 3), item("lost_found", 9)],
      draft: [],
      draftKinds: confirmedDraftKinds({ complaint: { ok: false, truncated: false }, pda: { ok: true, truncated: true }, lost_found: { ok: true, truncated: false } }),
      nowIso: "2026-10-01T02:30:00.000Z",
    });
    const by = new Map(merged.map((i) => [i.key, i]));
    expect(by.get("complaint:5")?.resolved).toBe(false);
    expect(by.get("pda:3")?.resolved).toBe(false);
    expect(by.get("lost_found:9")).toMatchObject({ resolved: true, resolvedByName: "sistema" });
  });
});

describe("buildHandoverDraft — leitura falhada não fecha pendentes", () => {
  const key = { date: "2026-10-01", shift: "morning" as const, city: "lisbon" as const };

  it("as reclamações falham ao ler → a reclamação pendente continua aberta; o perdido já fechado sai como resolvido", async () => {
    state.complaintsFail = true;
    const d = await buildHandoverDraft(key, Date.UTC(2026, 9, 1, 9, 0));
    const by = new Map(d!.carryOver.map((i) => [i.key, i]));
    expect(by.get("complaint:5")?.resolved).toBe(false);
    expect(by.get("lost_found:9")).toMatchObject({ resolved: true, resolvedByName: "sistema" });
  });

  it("lista de perdidos cortada pelo LIMIT → o pendente que não aparece NÃO se dá como resolvido", async () => {
    state.lostRows = Array.from({ length: 200 }, (_, i) => ({ id: 1000 + i, clientName: "x", description: "y", status: "new" }));
    const d = await buildHandoverDraft(key, Date.UTC(2026, 9, 1, 9, 0));
    const by = new Map(d!.carryOver.map((i) => [i.key, i]));
    expect(by.get("lost_found:9")?.resolved).toBe(false);
    // as reclamações leram-se bem (vazias) → a pendente fecha, como antes
    expect(by.get("complaint:5")).toMatchObject({ resolved: true, resolvedByName: "sistema" });
  });
});
