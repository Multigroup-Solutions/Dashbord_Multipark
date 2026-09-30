import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

// Juntar parceiros tem de ser tudo ou nada (antes eram ~7 escritas soltas, a
// última era o registo para "Separar"). BD falsa: regista o que corre dentro e
// fora da transação e simula um alias que já é de OUTRO registo.
const dialect = new MySqlDialect();
const text = (q: any) => dialect.sqlToQuery(q).sql.replace(/\s+/g, " ");

const state = { inTx: [] as string[], outside: [] as string[], committed: false, aliasOwner: 1 };
const rec = (id: number, mp: string | null) => ({ id, name: `R${id}`, partnerType: "agencia_viagem", multiparkPartnerId: mp, campaignKey: null, contactName: null, contactEmail: null, contactPhone: null, partnerNif: null, billingAgreement: null, archivedAt: null, mergedIntoId: null, mergeJson: null });
const answer = (s: string): any[] => {
  if (s.startsWith("SELECT id, name, partnerType")) return [[rec(1, "u-a"), rec(2, "u-b")]];
  if (s.includes("COUNT(*)")) return [[{ n: 0 }]];
  if (s.startsWith("SELECT partnershipId FROM partner_aliases")) return [[{ partnershipId: state.aliasOwner }]];
  if (s.startsWith("INSERT IGNORE")) return [{ insertId: 0 }];
  return [[]];
};
const fakeDb = {
  execute: async (q: any) => { const s = text(q); state.outside.push(s); return answer(s); },
  transaction: async (fn: (tx: any) => Promise<void>) => {
    const tx = { execute: async (q: any) => { const s = text(q); state.inTx.push(s); return answer(s); } };
    await fn(tx); // se lançar, não há commit
    state.committed = true;
  },
};
vi.mock("./db", () => ({ getDb: async () => fakeDb, ensureAgentPartnerTable: async () => undefined, resetPartnerMapCache: () => undefined }));
vi.mock("./finance/liveBookings", () => ({ resetLiveContextCache: () => undefined }));

beforeEach(() => { state.inTx = []; state.outside = []; state.committed = false; state.aliasOwner = 1; });

describe("juntar parceiros: tudo ou nada", () => {
  it("todas as escritas (incluindo o registo para Separar) vão na transação", async () => {
    const { mergePartnerships } = await import("./partnershipMerge");
    await mergePartnerships({ keepId: 1, dropIds: [2], userId: 9 });
    expect(state.committed).toBe(true);
    expect(state.outside.some((s) => /^(UPDATE|INSERT)/.test(s))).toBe(false);
    expect(state.inTx.some((s) => s.includes("mergeJson"))).toBe(true);
  });
  it("id da Multipark já ligado a outro registo → erro e nada fica gravado", async () => {
    state.aliasOwner = 7;
    const { mergePartnerships } = await import("./partnershipMerge");
    await expect(mergePartnerships({ keepId: 1, dropIds: [2], userId: 9 })).rejects.toThrow(/já está ligado ao registo #7/);
    expect(state.committed).toBe(false);
  });
});
