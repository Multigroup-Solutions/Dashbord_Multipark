/**
 * P3 lote 15a — Passagem de turno: os pendentes não se perdem (passagem
 * anterior em falta, leitura falhada, limite, notas editadas), quem resolve
 * vem da conta e não do formulário, uma leitura falhada nunca vale 0, o
 * "Recebi" é do turno seguinte e a regra das 24h é a mesma no ecrã e no servidor.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const state = vi.hoisted(() => ({
  prevRow: null as any,
  complaintsFail: false,
  currentRow: null as any,
  ackRow: null as any,
  updates: [] as string[],
  saved: [] as any[],
  overrides: {} as Record<string, unknown>,
}));

const dialect = new MySqlDialect();
const fakeDb = {
  select: () => ({ from: async () => [{ id: 49, parentId: null, name: "Lisboa", level: "city" }] }),
  execute: async (q: any) => {
    const text = dialect.sqlToQuery(q).sql;
    if (/^\s*UPDATE/.test(text)) { state.updates.push(text); return [{ affectedRows: 1 }]; }
    if (/FROM complaints/.test(text)) {
      if (state.complaintsFail) throw new Error("ligação perdida");
      return [[]];
    }
    if (/SELECT id, city, createdById, filledById, ackAt FROM shift_handovers/.test(text)) return [state.ackRow ? [state.ackRow] : []];
    if (/FROM `shift_handovers`/.test(text) && /`handoverDate` </.test(text)) return [state.prevRow ? [state.prevRow] : []];
    if (/FROM `shift_handovers`/.test(text)) return [state.currentRow ? [state.currentRow] : []];
    return [[]];
  },
};

vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => fakeDb,
  getUserPermissionOverrides: async () => ({}),
  getUserModuleOverrides: async () => state.overrides,
  logActivity: async () => {},
  saveShiftHandover: async (key: any, data: any, opts: any) => { state.saved.push({ key, data, opts }); return { mode: "insert", changed: [] }; },
}));
const national = vi.hoisted(() => ({ all: true, defaultCityId: null, cityName: null, cityIds: [] as number[], projectIds: [] as number[], missingCostCenter: false }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => national,
  loadCityAccessParts: async () => ({ access: national, base: national, all: national }),
}));
vi.mock("./multiparkDb/shiftState", async (original) => ({
  ...(await original<object>()),
  getMultiparkShiftState: async () => ({ available: false, code: "QUERY_FAILED", reason: "sem BD da Multipark" }),
}));
vi.mock("./appSettings", async (original) => ({ ...(await original<object>()), getSetting: async () => [] }));
vi.mock("./whatsappInbox", () => ({ listConversations: async () => [] }));

import { appRouter } from "./routers";
import { buildHandoverDraft } from "./shiftHandoverDraft";
import { ackHandover, saveHandoverAiSummary } from "./shiftHandoverAutomation";
import { buildHandoverLatestBefore } from "./shiftHandoverSql";
import { buildUpcomingSql } from "./multiparkDb/shiftState";
import { canEditOldHandover, findPersonShift } from "../shared/shiftHandover";
import {
  OPEN_ITEMS_MAX,
  buildHandoverEmail,
  canRemoveOpenItem,
  capOpenItems,
  draftKeyLines,
  mergeCarryOver,
  openItemKey,
  shiftsBetween,
  stampOpenItems,
  unavailableCounts,
  withNoteItems,
  type HandoverDraftCounts,
  type OpenItem,
} from "../shared/shiftHandoverAuto";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const compile = (q: any) => dialect.sqlToQuery(q);
const caller = (user: Record<string, unknown>) => appRouter.createCaller({ user: { id: 77, name: "Rita", ...user }, req: { headers: {} }, res: {} } as any);

const note = (text: string, extra: Partial<OpenItem> = {}): OpenItem => ({ key: openItemKey("note", text), kind: "note", text, resolved: false, ...extra });
const ent = (kind: OpenItem["kind"], id: number | string, extra: Partial<OpenItem> = {}): OpenItem => ({ key: openItemKey(kind, id), kind, refId: id, text: `${kind} ${id}`, resolved: false, ...extra });

beforeEach(() => {
  state.prevRow = null; state.complaintsFail = false; state.currentRow = null; state.ackRow = null;
  state.updates = []; state.saved = []; state.overrides = {};
});

describe("Pendentes: vêm da última passagem, mesmo que o turno anterior não a tenha feito", () => {
  it("SQL: mesma cidade, até à data-limite, antes deste turno (à noite conta a manhã do mesmo dia)", () => {
    const night = compile(buildHandoverLatestBefore({ handoverDate: "2026-10-02", shift: "night", city: "lisbon" }, "2026-09-29"));
    expect(night.sql).toContain("`handoverDate` >= ?");
    expect(night.sql).toContain("`shift` = 'morning'");
    expect(night.sql).toMatch(/ORDER BY `handoverDate` DESC, \(`shift` = 'night'\) DESC/);
    expect(night.params).toEqual(["lisbon", "2026-09-29", "2026-10-02", "2026-10-02"]);
    const morning = compile(buildHandoverLatestBefore({ handoverDate: "2026-10-02", shift: "morning", city: "porto" }, "2026-09-29"));
    expect(morning.sql).not.toContain("'morning'");
    expect(morning.params).toEqual(["porto", "2026-09-29", "2026-10-02"]);
  });

  it("turnos em falta entre duas passagens", () => {
    expect(shiftsBetween({ date: "2026-10-02", shift: "morning" }, { date: "2026-10-02", shift: "night" })).toBe(0);
    expect(shiftsBetween({ date: "2026-10-01", shift: "night" }, { date: "2026-10-02", shift: "morning" })).toBe(0);
    expect(shiftsBetween({ date: "2026-09-30", shift: "morning" }, { date: "2026-10-01", shift: "morning" })).toBe(1);
    expect(shiftsBetween({ date: "2026-09-30", shift: "night" }, { date: "2026-10-02", shift: "night" })).toBe(3);
  });

  it("rascunho: a manhã de 30/09 passa os pendentes à manhã de 01/10 (a noite falhou) e diz quantos turnos faltam", async () => {
    state.prevRow = {
      id: 5, handoverDate: "2026-09-30", shift: "morning", createdByName: "Ana", createdById: 1, filledById: 3,
      notes: null, aiSummary: null, ackAt: null, ackByName: null,
      openItems: JSON.stringify([note("Chave do Clio no cofre", { since: "2026-09-30 morning" })]),
    };
    const d = await buildHandoverDraft({ date: "2026-10-01", shift: "morning", city: "lisbon" }, Date.UTC(2026, 9, 1, 9, 0));
    expect(d!.previous).toMatchObject({ id: 5, date: "2026-09-30", shift: "morning", missingShifts: 1, filledById: 3 });
    expect(d!.carryOver.map((i) => i.text)).toContain("Chave do Clio no cofre");
  });

  it("rascunho: uma leitura que falhou vai em `failed` e as contagens dela deixam de valer", async () => {
    state.complaintsFail = true;
    const d = await buildHandoverDraft({ date: "2026-10-01", shift: "morning", city: "lisbon" }, Date.UTC(2026, 9, 1, 9, 0));
    expect(d!.failed).toContain("complaints");
    expect(d!.unavailable).toEqual(expect.arrayContaining(["complaintsNew", "complaintsOpen"]));
  });
});

describe("Leitura falhada ≠ 0 (email, IA, notificação)", () => {
  const counts: HandoverDraftCounts = {
    checkinsNext: 4, checkoutsNext: 2, pendingDeliveries: 0, complaintsNew: 0, complaintsOpen: 0, lostFoundOpen: 1,
    incidentsOpen: 0, whatsappUnread: 0, pdasCheckedIn: 0, clockInsOpen: 0, speedAlerts: 0, gpsAlerts: 0, toCollectEur: 0,
  } as HandoverDraftCounts;

  it("draftKeyLines diz 'sem dados' em vez de 0", () => {
    const lines = draftKeyLines(counts, unavailableCounts(["complaints", "speed"]));
    expect(lines.find((l) => l.startsWith("Reclamações"))).toBe("Reclamações novas no turno: sem dados (falhou a leitura) · abertas: sem dados (falhou a leitura)");
    expect(lines.find((l) => l.startsWith("Alertas"))).toBe("Alertas de velocidade/GPS no turno: sem dados (falhou a leitura)/0");
    expect(lines.find((l) => l.startsWith("Perdidos"))).toBe("Perdidos e achados abertos: 1");
  });

  it("o email ao turno seguinte também", () => {
    const mail = buildHandoverEmail({
      city: "lisbon", shift: { date: "2026-10-01", shift: "morning" }, authorName: "Ana", aiSummary: null, counts,
      unavailable: unavailableCounts(["bookings checkOut"]), notes: null, openItems: [], link: "https://x/passagem-turno",
    });
    expect(mail.text).toContain("Entregas no próximo turno: sem dados (falhou a leitura)");
    expect(mail.text).not.toContain("Entregas no próximo turno: 2");
  });

  it("partes desconhecidas não inventam contagens", () => {
    expect(unavailableCounts(["multipark ao vivo", "previous", "assignments"])).toEqual([]);
  });
});

describe("Lista de pendentes: o que herdas resolve-se, não se apaga; o limite nunca corta notas", () => {
  const cur = "2026-10-02 morning";
  it("só sai uma nota deste turno, por resolver", () => {
    expect(canRemoveOpenItem(note("nova"), cur)).toBe(true);
    expect(canRemoveOpenItem(note("deste turno", { since: cur }), cur)).toBe(true);
    expect(canRemoveOpenItem(note("herdada", { since: "2026-10-01 night" }), cur)).toBe(false);
    expect(canRemoveOpenItem(note("feita", { resolved: true }), cur)).toBe(false);
    expect(canRemoveOpenItem(ent("complaint", 5), cur)).toBe(false);
  });

  it("no limite ficam as notas e os herdados; saem primeiro as entidades novas (que têm página própria)", () => {
    const fresh = Array.from({ length: OPEN_ITEMS_MAX }, (_, i) => ent("complaint", i, { since: cur }));
    const notes = [note("herdada", { since: "2026-10-01 night" }), note("minha", { since: cur })];
    const { items, cut } = capOpenItems([...fresh, ...notes], cur);
    expect(items).toHaveLength(OPEN_ITEMS_MAX);
    expect(cut).toBe(2);
    expect(items.map((i) => i.text)).toEqual(expect.arrayContaining(["herdada", "minha"]));
  });

  it("mergeCarryOver respeita o mesmo limite", () => {
    const previous = [note("herdada", { since: "2026-10-01 night" })];
    const draft = Array.from({ length: OPEN_ITEMS_MAX + 5 }, (_, i) => ent("lost_found", i, { since: cur }));
    const out = mergeCarryOver({ previous, draft, currentSince: cur });
    expect(out).toHaveLength(OPEN_ITEMS_MAX);
    expect(out.some((i) => i.text === "herdada")).toBe(true);
  });

  it("ocorrência guardada com o id da nossa cópia não se fecha só porque agora a leitura é ao vivo", () => {
    const out = mergeCarryOver({
      previous: [ent("incident", 12, { since: "2026-10-01 night" })], draft: [],
      isCheckable: (i) => i.kind !== "incident" || typeof i.refId === "string", nowIso: "2026-10-02T08:00:00Z",
    });
    expect(out[0].resolved).toBe(false);
  });

  it("linha das notas editada: o pendente antigo deste turno sai, o novo entra; os herdados ficam", () => {
    const first = withNoteItems([], "- ligar ao cliente do Golf", cur);
    expect(first).toHaveLength(1);
    const edited = withNoteItems([...first, note("herdada", { since: "2026-10-01 night", fromNotes: true })], "- ligar ao cliente do Golf às 9h", cur);
    expect(edited.map((i) => i.text).sort()).toEqual(["herdada", "ligar ao cliente do Golf às 9h"]);
  });
});

describe("Quem resolveu: da conta que grava, nunca do formulário", () => {
  const ctx = { since: "2026-10-02 morning", userName: "Rita", nowIso: "2026-10-02T09:00:00.000Z" };
  it("o que passa agora a resolvido leva quem grava (ignora o nome que o formulário mandou)", () => {
    const [i] = stampOpenItems([], [note("x", { resolved: true, resolvedByName: "Outra pessoa", resolvedAt: "2020-01-01" })], ctx);
    expect(i).toMatchObject({ resolved: true, resolvedByName: "Rita", resolvedAt: ctx.nowIso, since: ctx.since });
  });
  it("o que já estava resolvido mantém quem e quando", () => {
    const stored = [note("x", { resolved: true, resolvedByName: "Ana", resolvedAt: "2026-10-01T20:00:00Z", since: "2026-10-01 night" })];
    const [i] = stampOpenItems(stored, [note("x", { resolved: true, resolvedByName: "Rita" })], ctx);
    expect(i).toMatchObject({ resolvedByName: "Ana", resolvedAt: "2026-10-01T20:00:00Z", since: "2026-10-01 night" });
  });
  it("por resolver não leva nome; 'sistema' só vale para entidades, nunca para notas", () => {
    const [open] = stampOpenItems([], [note("y", { resolvedByName: "Rita", resolvedAt: "x" })], ctx);
    expect(open).toMatchObject({ resolved: false, resolvedByName: null, resolvedAt: null });
    const [sys] = stampOpenItems([], [ent("complaint", 5, { resolved: true, resolvedByName: "sistema", resolvedAt: "2026-10-02T08:00:00Z" })], ctx);
    expect(sys.resolvedByName).toBe("sistema");
    const [fake] = stampOpenItems([], [note("z", { resolved: true, resolvedByName: "sistema", resolvedAt: "2026-10-02T08:00:00Z" })], ctx);
    expect(fake.resolvedByName).toBe("Rita");
  });
  it("a gravação carimba no servidor (db.ts) e o router já não aceita o carimbo do formulário", () => {
    expect(src("server/db.ts")).toMatch(/stampOpenItems\(stored, data\.openItems as OpenItem\[\], \{ since: `\$\{key\.handoverDate\} \$\{key\.shift\}`, userName: opts\.userName/);
    expect(src("server/routers.ts")).not.toMatch(/resolvedByName: i\.resolvedByName \?\? ctx\.user\.name/);
  });
});

describe("Regra das 24h e 'Recebi'", () => {
  it("passagens antigas: quem vê o Resumo do dia (com as permissões por utilizador)", () => {
    expect(canEditOldHandover({ role: "supervisor" } as any)).toBe(true);
    expect(canEditOldHandover({ role: "team_leader" } as any)).toBe(false);
    expect(canEditOldHandover({ role: "team_leader", accessOverrides: { passagem_resumo_dia: { access: "city", actions: ["view"] } } } as any)).toBe(true);
    expect(canEditOldHandover(null)).toBe(false);
  });

  it("o servidor grava com a mesma regra (override incluído)", async () => {
    state.overrides = { passagem_resumo_dia: { access: "city", actions: ["view"] } };
    await caller({ role: "team_leader" }).shiftHandover.save({ handoverDate: "2026-10-01", shift: "morning", city: "lisbon", expectedVersion: null });
    state.overrides = {};
    await caller({ role: "team_leader" }).shiftHandover.save({ handoverDate: "2026-10-01", shift: "morning", city: "lisbon", expectedVersion: null });
    expect(state.saved.map((s) => s.opts.canEditOld)).toEqual([true, false]);
  });

  it("o resumo IA não fura o prazo de 24h", async () => {
    state.currentRow = { id: 8, ageMinutes: 3000 };
    expect(await saveHandoverAiSummary({ handoverDate: "2026-09-28", shift: "night", city: "lisbon" }, "• ok", { canEditOld: false })).toBeNull();
    expect(state.updates).toHaveLength(0);
    expect(await saveHandoverAiSummary({ handoverDate: "2026-09-28", shift: "night", city: "lisbon" }, "• ok", { canEditOld: true })).toBe(8);
    state.currentRow = { id: 9, ageMinutes: 30 };
    expect(await saveHandoverAiSummary({ handoverDate: "2026-10-02", shift: "morning", city: "lisbon" }, "• ok", { canEditOld: false })).toBe(9);
    state.currentRow = null;
    expect(await saveHandoverAiSummary({ handoverDate: "2026-10-02", shift: "night", city: "lisbon" }, "• ok", { canEditOld: true })).toBeNull();
  });

  it("'Recebi': nem quem a criou nem quem a editou por último", async () => {
    state.ackRow = { id: 3, city: "lisbon", createdById: 1, filledById: 77, ackAt: null };
    expect(await ackHandover(3, "lisbon", { id: 77, name: "Rita" })).toMatchObject({ ok: false });
    expect(await ackHandover(3, "lisbon", { id: 1, name: "Ana" })).toMatchObject({ ok: false });
    expect(await ackHandover(3, "lisbon", { id: 50, name: "Rui" })).toEqual({ ok: true });
  });
});

describe("Compras online por acabar (PENDING) não são trabalho do turno", () => {
  it("as próximas recolhas/entregas ao vivo tiram PENDING e canceladas", () => {
    const q = buildUpcomingSql("checkin", ["p1"], Date.UTC(2026, 9, 2, 8), Date.UTC(2026, 9, 2, 16));
    expect(q.sql).toContain(`NOT IN ('CANCELLED', 'PENDING')`);
  });
  it("a leitura de recurso (nossa cópia) também", () => {
    expect(src("server/shiftHandoverDraft.ts")).toMatch(/b\.status NOT IN \('CANCELLED', 'PENDING'\)/);
  });
});

describe("Resumo do dia: o nome da escala sem acentos nem maiúsculas", () => {
  it("'João  Silva' encontra 'joao silva'", () => {
    const shifts = [{ employeeId: null, personName: "joao silva", city: "lisbon", shift: "night" }];
    expect(findPersonShift(shifts, { employeeId: null, name: "João  Silva" }, "lisbon")?.shift).toBe("night");
  });
});

describe("Ecrã: erro ≠ vazio, permissões e nada se perde", () => {
  const page = src("client/src/pages/ShiftHandoverPage.tsx");
  const panel = src("client/src/components/ShiftHandoverDraftPanel.tsx");
  it("cada leitura tem o seu aviso de erro com 'Tentar de novo'", () => {
    for (const what of ["as tuas cidades", "o registo deste turno", "o resumo automático do turno", "o histórico de passagens", "o resumo do dia", "o cumprimento das passagens"]) {
      expect(page).toContain(`what="${what}`);
    }
    expect(panel).toContain(`{failed ? "erro" : count}`);
  });
  it("não grava uma passagem nova sem os pendentes do turno anterior (a não ser que se confirme)", () => {
    expect(page).toContain("A juntar os pendentes do turno anterior…");
    expect(page).toMatch(/prevUnknown && !saveWithoutPrev/);
  });
  it("as regras do ecrã são as do servidor", () => {
    expect(page).toContain("canEditOldHandover(user)");
    expect(page).toContain(`can(user, "passagem_turno", "edit")`);
    expect(page).toMatch(/h\.createdById !== userId && h\.filledById !== userId/);
    expect(panel).toContain("canRemoveOpenItem(i, currentSince)");
  });
  it("mudar de separador não perde o que se escreveu; mudar de turno pergunta antes", () => {
    expect(page).toMatch(/TabsContent value="preencher" forceMount/);
    expect(page).toContain("Tens alterações por gravar nesta passagem");
  });
});
