/**
 * P3 lote 16c — Perdidos e Achados: nada se apaga (arquivar, condutores e a
 * foto da entrega anterior ficam em removed_records, os ficheiros ficam), a
 * pessoa é sempre a ficha ligada à conta do agente (nunca o nome), a reserva só
 * se liga com um sinal forte e uma leitura falhada (ou cortada) é dita.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  item: null as any,
  archived: [] as Array<[number, number, string]>,
  updates: [] as Array<[number, any]>,
  messages: [] as any[],
  historyRows: 0,
}));
const national = vi.hoisted(() => ({ all: true, defaultCityId: null, cityName: null, cityIds: [] as number[], projectIds: [] as number[], missingCostCenter: false }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => national,
  loadCityAccessParts: async () => ({ access: national, base: national, all: national }),
}));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getUserPermissionOverrides: async () => ({}),
  getUserModuleOverrides: async () => ({}),
  logActivity: async () => {},
  getLostFoundItemById: async () => state.item,
  updateLostFoundItem: async (id: number, data: any) => { state.updates.push([id, data]); },
  archiveLostFoundItem: async (id: number, by: number, reason: string) => { state.archived.push([id, by, reason]); return true; },
  addLostFoundMessage: async (m: any) => { state.messages.push(m); },
  getBookingHistoryByBookingId: async () => Array.from({ length: state.historyRows }, (_, i) => ({ id: i })),
  searchBookingHistory: async () => Array.from({ length: state.historyRows }, (_, i) => ({ id: i })),
}));

import { appRouter } from "./routers";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { MIGRATION_0345_STATEMENTS } from "./migrations/migration_0345";
import { isStrongBookingMatch } from "./complaintDossier";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const caller = (role: string) => appRouter.createCaller({ user: { id: 77, role, name: "Rita" }, req: { headers: {} }, res: {} } as any);
const item = (o: any = {}) => ({ id: 9, projectId: 10, status: "new", archivedAt: null, returnPhotoKey: null, returnPhotoUrl: null, ...o });

beforeEach(() => { state.item = item(); state.archived = []; state.updates = []; state.messages = []; state.historyRows = 0; });

describe("Migração 0345: arquivo dos perdidos", () => {
  it("registada depois da 0340, só colunas e chave (nada se apaga)", () => {
    expect(SCHEMA_MIGRATION_IDS).toContain("0345");
    expect(SCHEMA_MIGRATION_IDS.indexOf("0345")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0340"));
    const all = MIGRATION_0345_STATEMENTS.join("\n");
    for (const c of ["`archivedAt`", "`archivedById`", "`archiveReason`", "`idx_lost_found_archived`"]) expect(all).toContain(c);
    expect(all).not.toMatch(/\bDELETE\b|\bDROP\b/);
  });
});

describe("Arquivar em vez de apagar (nem os ficheiros)", () => {
  it("delete deixou de existir; archive pede gerir e um motivo", async () => {
    const procs = (appRouter as any)._def.procedures as Record<string, unknown>;
    expect(procs["lostFound.delete"]).toBeUndefined();
    expect(procs["lostFound.archive"]).toBeDefined();
    expect(procs["lostFound.unarchive"]).toBeDefined();
    await expect(caller("team_leader").lostFound.archive({ id: 9, reason: "duplicado" })).rejects.toThrow();
    await expect(caller("admin").lostFound.archive({ id: 9, reason: "x" })).rejects.toThrow(/porquê/);
    await caller("admin").lostFound.archive({ id: 9, reason: "duplicado do #8" });
    expect(state.archived).toEqual([[9, 77, "duplicado do #8"]]);
    expect(state.messages.at(-1)).toMatchObject({ itemId: 9, isInternal: 1 });
  });
  it("já não há código que apague o caso, as fotos, as mensagens ou os ficheiros", () => {
    const caseOps = src("server/caseOps.ts");
    expect(caseOps).not.toContain("deleteLostCaseFully");
    expect(caseOps).not.toContain("storageDelete");
    const db = src("server/db.ts");
    expect(db).not.toContain("export async function deleteLostFoundItem");
    expect(db).not.toMatch(/db\.delete\(lostFoundAttachedDrivers\)/);
  });
  it("arquivar anula os pontos ainda por confirmar (marca, não apaga) e fecha as tarefas", () => {
    const db = src("server/db.ts");
    const fn = db.slice(db.indexOf("export async function archiveLostFoundItem"), db.indexOf("export async function addLostFoundPhoto"));
    expect(fn).toContain('eq(employeePenalties.status, "pending")');
    expect(fn).toContain('status: "dismissed"');
    expect(fn).toContain('closeTasksForSource("lost_found", id)');
  });
  it("tirar do arquivo; um arquivado não muda de estado", async () => {
    state.item = item({ archivedAt: "2026-10-01 10:00:00" });
    await caller("admin").lostFound.unarchive({ id: 9 });
    expect(state.updates).toEqual([[9, { archivedAt: null, archivedById: null, archiveReason: null }]]);
    await expect(caller("supervisor").lostFound.update({ id: 9, status: "closed" })).rejects.toThrow(/arquivado/);
  });
  it("tirar um condutor e trocar a foto da entrega deixam registo em removed_records", () => {
    const r = src("server/routers.ts");
    expect(r).toContain("const r = await detachLostFoundDriver(input.id, ctx.user.id);");
    expect(r).toContain('entity: "lost_found_return_photo"');
    expect(src("server/db.ts")).toContain('entity: "lost_found_driver"');
  });
  it("os arquivados saem do painel, lembretes, cruzamento, correspondências e passagem", () => {
    const caseOps = src("server/caseOps.ts");
    expect(caseOps).toContain("const scope = sql`${await caseScopeSql(sql`l.projectId`, f)} AND l.archivedAt IS NULL`;");
    expect(caseOps).toContain("WHERE status IN ('new','investigating','found') AND archivedAt IS NULL");
    expect(caseOps).toContain("l.status <> 'converted' AND l.archivedAt IS NULL AND l.createdAt >=");
    expect((src("server/lostFoundMatch.ts").match(/archivedAt IS NULL/g) ?? []).length).toBe(2);
    expect(src("server/shiftHandoverDraft.ts")).toContain("WHERE status IN ('new', 'investigating', 'found') AND archivedAt IS NULL");
    const db = src("server/db.ts");
    const list = db.slice(db.indexOf("export async function getLostFoundItems"), db.indexOf("export async function getLostFoundItemById"));
    expect(list).toContain("filters?.archived ? sql`${lostFoundItems.archivedAt} IS NOT NULL` : sql`${lostFoundItems.archivedAt} IS NULL`");
  });
  it("a lista dos arquivados é só para quem gere", async () => {
    await expect(caller("team_leader").lostFound.list({ archived: true })).rejects.toThrow();
  });
});

describe("A pessoa é a ficha da conta do agente — nunca o nome", () => {
  it("cruzamento e condutores repetidos: sem mapa por nome, sem agentes de sistema", () => {
    const caseOps = src("server/caseOps.ts");
    expect(caseOps).not.toContain("AGENT_MAP");
    expect(caseOps).not.toContain("multiparkAgentName");
    expect(caseOps).toContain("employeesForAgentIds(");
    expect((caseOps.match(/isLinkableAgent\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it("pontos só a uma ficha anexada explicitamente", () => {
    const caseOps = src("server/caseOps.ts");
    const fn = caseOps.slice(caseOps.indexOf("export async function setLostDriverAccountability"), caseOps.indexOf("export async function reviewLostDriverPoints"));
    expect(fn).toContain("const empId = link.employeeId;");
    expect(fn).not.toMatch(/driverName/);
  });
  it("'quem mexeu no carro' tira sistema/API e devolve a ficha pela conta; anexar leva a ficha", () => {
    const db = src("server/db.ts");
    const fn = db.slice(db.indexOf("export async function getVehicleAgentsByPlate"), db.indexOf("export const AGENT_MOVEMENTS_LIMIT"));
    expect(fn).toContain("isLinkableAgent(r.agentUserId, r.agentName)");
    expect(fn).toContain("employeeId: e.agentUserId ? owners.get(e.agentUserId)?.id ?? null : null");
    const panel = src("client/src/pages/lostFound/CaseDriversPanel.tsx");
    expect(panel).toContain("employeeId: ag.employeeId ?? null, driverName: ag.employeeName ?? ag.agentName");
    expect(panel).toContain("lisbonDayOf(String(ag.lastActionAt))");
  });
  it("a mesma pessoa não fica anexada duas vezes", () => {
    expect(src("server/routers.ts")).toContain("if (already) return { id: already.id, duplicate: true };");
  });
});

describe("Ligação à reserva: só com sinal forte, e a ref. à mão nunca é trocada", () => {
  it("matrícula, email ou telefone; o nome e a janela de datas não chegam", () => {
    expect(isStrongBookingMatch(["nome", "janela"])).toBe(false);
    expect(isStrongBookingMatch(["nome"])).toBe(false);
    expect(isStrongBookingMatch(["matricula"])).toBe(true);
    expect(isStrongBookingMatch(["email", "janela"])).toBe(true);
    expect(isStrongBookingMatch(["telefone"])).toBe(true);
  });
  it("ref. que não se encontra fica como está (reclamações e perdidos)", () => {
    const d = src("server/complaintDossier.ts");
    expect((d.match(/Ref escrita à mão que não se encontra/g) ?? []).length).toBe(2);
    expect(d).toContain("if (!isStrongBookingMatch(matchedBy)) continue;");
  });
});

describe("Correspondências", () => {
  it("só se decide o que está sugerido (confirmar 2× não duplica notas)", () => {
    expect(src("server/lostFoundMatch.ts")).toContain('eq(lostFoundMatches.status, "suggested")');
  });
  it("uma confirmada continua visível depois de o caso fechar", () => {
    const p = src("client/src/pages/lostFound/MatchesPanel.tsx");
    expect(p).toContain('const rows = side ? all : all.filter((m) => m.status === "confirmed");');
    expect(p).not.toContain("enabled: !!side");
  });
});

describe("Leitura falhada ou cortada ≠ vazio", () => {
  it("histórico de reservas diz quando bateu no teto", async () => {
    state.historyRows = 200;
    const r = await caller("supervisor").lostFound.bookingHistory({ search: "AA-00-BB" });
    expect(r).toMatchObject({ truncated: true, limit: 200 });
    state.historyRows = 3;
    expect(await caller("supervisor").lostFound.bookingHistory({ bookingId: "bk1" })).toMatchObject({ truncated: false, limit: 500 });
  });
  it("Multipark sem resposta ≠ fora do âmbito / sem histórico", () => {
    const r = src("server/routers.ts");
    expect(r).toContain('try { return !!(await liveBookingByRef(ref, { cities })); } catch { return "unavailable"; }');
    expect(r).toContain('if (inScope === "unavailable") return { bookingId: input.bookingId, total: 0, history: [], error:');
  });
  it("cruzamento e movimentos dizem quando o resultado é incompleto", () => {
    expect(src("server/caseOps.ts")).toContain("truncated: cut.truncated");
    expect(src("server/db.ts")).toContain("truncated: rows.length >= AGENT_MOVEMENTS_LIMIT");
    const cross = src("client/src/pages/lostFound/CrossRefView.tsx");
    expect(cross).toContain("cross?.truncated");
    expect(cross).toContain("mov.truncated");
  });
  it("as vistas usam QueryErrorNote", () => {
    const has = (f: string, what: string) => expect(src(f), `${f}: ${what}`).toContain(what);
    has("client/src/pages/lostFound/KanbanView.tsx", 'what="os casos"');
    has("client/src/pages/lostFound/DetailView.tsx", "what={`o caso #${id}`}");
    has("client/src/pages/lostFound/DetailView.tsx", 'what="a reserva"');
    has("client/src/pages/lostFound/DetailView.tsx", 'what="as fotos"');
    has("client/src/pages/lostFound/DetailView.tsx", 'what="as mensagens"');
    has("client/src/pages/lostFound/DetailView.tsx", 'what="o histórico da reserva"');
    has("client/src/pages/lostFound/CaseDriversPanel.tsx", 'what="os condutores do caso"');
    has("client/src/pages/lostFound/MatchesPanel.tsx", 'what="as correspondências"');
    has("client/src/pages/lostFound/BookingHistoryView.tsx", 'what="o histórico"');
    has("client/src/pages/lostFound/CrossRefView.tsx", 'what="o cruzamento"');
    has("client/src/pages/lostFound/CreateDialog.tsx", 'what="o histórico"');
  });
});

describe("Página", () => {
  it("botões pela matriz; CSV só para quem exporta, com datas de Lisboa e células seguras", () => {
    const k = src("client/src/pages/lostFound/KanbanView.tsx");
    expect(k).toContain('can(user, "perdidos", "export")');
    expect(k).toContain("toCsv(headers, rows)");
    expect(k).not.toMatch(/toISOString\(\)\.slice/);
    expect(k).toContain("{canEdit && <Button onClick={onNew}>");
    const d = src("client/src/pages/lostFound/DetailView.tsx");
    expect(d).not.toContain("trpc.lostFound.delete.");
    expect(d).toContain("trpc.lostFound.archive.useMutation");
    expect(d).toContain("await compressImage(original, 1600, 0.85)");
    expect(d).toContain("clientEmail: editForm.clientEmail.trim()");
  });
  it("tirar condutor e converter pedem confirmação", () => {
    expect(src("client/src/pages/lostFound/CaseDriversPanel.tsx")).toContain("title: `Tirar ${a.driverName} do caso?`");
    expect(src("client/src/pages/lostFound/DetailView.tsx")).toContain('title: "Converter em Reclamação?"');
  });
  it("ajuda com o nome certo do botão e as regras novas", () => {
    const h = src("docs/ajuda/perdidos.md");
    expect(h).toContain("**Novo Registo**");
    expect(h).toContain("**Arquivar**");
    expect(h).not.toContain("Criar Registo");
  });
});
