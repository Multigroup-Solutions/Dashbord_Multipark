/**
 * P3 lote 16b — Reclamações: nada se apaga (arquivar; fotos e condutores vão
 * para removed_records), as escritas confirmam a cidade do caso, o responsável
 * é uma ficha (avisos e calendário vão à conta dela), os estados seguem regras
 * (reabrir limpa o fecho, o email só passa a "Aguarda Cliente" um caso aberto)
 * e uma leitura falhada nunca aparece como vazio.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const state = vi.hoisted(() => ({
  complaint: null as any,
  updates: [] as Array<[number, any]>,
  archived: [] as Array<[number, number, string]>,
  removed: [] as any[],
  sent: [] as any[],
  messages: [] as any[],
  inbound: null as any,
  rows: new Map<unknown, any[]>(),
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
  getComplaintById: async () => state.complaint,
  updateComplaint: async (id: number, data: any) => { state.updates.push([id, data]); },
  archiveComplaint: async (id: number, by: number, reason: string) => { state.archived.push([id, by, reason]); return true; },
  addComplaintMessage: async (m: any) => { state.messages.push(m); return 1; },
  getInboundEmailById: async () => state.inbound,
  setInboundEmailTarget: async () => {},
  removeComplaintPhoto: async (id: number, by: number) => { state.removed.push({ kind: "photo", id, by }); return { removed: true, row: { complaintId: 5 } }; },
  getDb: async () => ({
    select: () => ({
      from: (t: unknown) => ({ where: () => ({ limit: async () => state.rows.get(t) ?? [] }) }),
    }),
  }),
}));
vi.mock("./complaintsExtended", async (original) => ({
  ...(await original<object>()),
  sendComplaintEmailToClient: async (input: any) => { state.sent.push(input); return { ok: true, subject: input.subject }; },
  detachComplaintDriver: async (id: number, by: number) => { state.removed.push({ kind: "driver", id, by }); return { removed: true, row: { complaintId: 5, employeeName: "Ana", penaltyPointsApplied: 3 } }; },
  assigneeUserIds: async (ids: any[]) => ids.filter((x) => typeof x === "number").map((x: number) => x + 1000),
}));

import { appRouter } from "./routers";
import { assertScopedOperation } from "./cityScopeGuards";
import { cityScope } from "./cityScope";
import { complaints, complaintPhotos, complaintDriversOnDuty } from "../drizzle/schema";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { MIGRATION_0340_STATEMENTS } from "./migrations/migration_0340";
import { removedRowJson } from "./removedRecords";
import { extrasCityKeyOf } from "./complaintsExtended";
import { reassignStatements } from "./userMerge";
import {
  caseDueToUtc, complaintOverdue, complaintPhotoType, complaintStatusAfterEmail, complaintStatusOnClientReply, complaintStatusPatch,
  COMPLAINT_MANUAL_STATUSES,
} from "../shared/caseRules";
import { can } from "../shared/access";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const caller = (role: string) => appRouter.createCaller({ user: { id: 77, role, name: "Rita" }, req: { headers: {} }, res: {} } as any);
const NOW = "2026-10-02 10:00:00";
const base = (o: any = {}) => ({ id: 5, projectId: 10, complaintStatus: "new", assignedToId: 42, convertedToType: null, convertedToId: null, archivedAt: null, ...o });

beforeEach(() => {
  state.complaint = base(); state.updates = []; state.archived = []; state.removed = []; state.sent = []; state.messages = [];
  state.inbound = null; state.rows = new Map();
});

describe("Migração 0340: arquivo e registo do que sai", () => {
  it("registada no fim, com as colunas do arquivo e a tabela removed_records", () => {
    expect(SCHEMA_MIGRATION_IDS.at(-1)).toBe("0340");
    const all = MIGRATION_0340_STATEMENTS.join("\n");
    for (const c of ["`archivedAt`", "`archivedById`", "`archiveReason`", "CREATE TABLE IF NOT EXISTS `removed_records`", "`rowJson` MEDIUMTEXT"]) expect(all).toContain(c);
    expect(all).not.toMatch(/\bDELETE\b|\bDROP\b/);
  });
  it("a linha arquivada leva as datas como texto", () => {
    expect(JSON.parse(removedRowJson({ id: 1, at: new Date("2026-10-02T10:00:00Z"), n: null }))).toEqual({ id: 1, at: "2026-10-02T10:00:00.000Z", n: null });
  });
});

describe("Regras de estado (puras)", () => {
  it("fechar regista quem/quando só na 1.ª vez; reabrir limpa o fecho e o aviso de SLA", () => {
    expect(complaintStatusPatch("analyzing", "resolved", 7, NOW)).toEqual({ complaintStatus: "resolved", resolvedAt: NOW, closedById: 7, closedAt: NOW });
    expect(complaintStatusPatch("resolved", "closed", 7, NOW)).toEqual({ complaintStatus: "closed" });
    expect(complaintStatusPatch("closed", "analyzing", 7, NOW)).toEqual({ complaintStatus: "analyzing", resolvedAt: null, closedAt: null, closedById: null, slaAlertedAt: null });
    expect(complaintStatusPatch("new", "new", 7, NOW)).toEqual({});
  });
  it("em atraso só com o SLA a correr (novo/em análise); em 'Aguarda Cliente' para", () => {
    const now = Date.UTC(2026, 9, 2, 12, 0);
    expect(complaintOverdue({ slaDeadline: "2026-10-02 11:00:00", complaintStatus: "new" }, now)).toBe(true);
    expect(complaintOverdue({ slaDeadline: "2026-10-02 11:00:00", complaintStatus: "waiting_client" }, now)).toBe(false);
    expect(complaintOverdue({ slaDeadline: "2026-10-02 11:00:00", complaintStatus: "converted" }, now)).toBe(false);
    expect(complaintOverdue({ slaDeadline: "2026-10-02 13:00:00", complaintStatus: "analyzing" }, now)).toBe(false);
    expect(complaintOverdue({ slaDeadline: null, complaintStatus: "new" }, now)).toBe(false);
  });
  it("email ao cliente → 'Aguarda Cliente' só se estava aberto; resposta do cliente → 'Em Análise'", () => {
    expect(complaintStatusAfterEmail("new")).toBe("waiting_client");
    expect(complaintStatusAfterEmail("analyzing")).toBe("waiting_client");
    for (const s of ["waiting_client", "resolved", "closed", "converted"]) expect(complaintStatusAfterEmail(s)).toBeNull();
    for (const s of ["waiting_client", "resolved", "closed"]) expect(complaintStatusOnClientReply(s)).toBe("analyzing");
    for (const s of ["new", "analyzing", "converted"]) expect(complaintStatusOnClientReply(s)).toBeNull();
    expect(COMPLAINT_MANUAL_STATUSES).not.toContain("converted");
  });
  it("só fotos, com o tipo certo", () => {
    expect(complaintPhotoType("IMG_1.JPEG")).toEqual({ ext: "jpg", mime: "image/jpeg" });
    expect(complaintPhotoType("a.heic")).toEqual({ ext: "heic", mime: "image/heic" });
    expect(complaintPhotoType("virus.html")).toBeNull();
    expect(complaintPhotoType("x.svg")).toBeNull();
  });
});

describe("Arquivar em vez de apagar", () => {
  it("delete e deletePhoto deixaram de existir; archive pede gerir e um motivo", async () => {
    const procs = (appRouter as any)._def.procedures as Record<string, unknown>;
    expect(procs["complaints.delete"]).toBeUndefined();
    expect(procs["complaints.deletePhoto"]).toBeUndefined();
    expect(procs["complaints.archive"]).toBeDefined();
    expect(procs["complaints.unarchive"]).toBeDefined();
    await expect(caller("team_leader").complaints.archive({ id: 5, reason: "duplicada" })).rejects.toThrow();
    await expect(caller("admin").complaints.archive({ id: 5, reason: "x" })).rejects.toThrow(/porquê/);
    await caller("admin").complaints.archive({ id: 5, reason: "duplicada da #4" });
    expect(state.archived).toEqual([[5, 77, "duplicada da #4"]]);
    expect(state.messages.at(-1)).toMatchObject({ complaintId: 5, isInternal: 1 });
    const db = src("server/db.ts");
    expect(db).not.toContain("export async function deleteComplaint");
    expect(db).not.toMatch(/db\.delete\(complaints\)|db\.delete\(complaintPhotos\)|db\.delete\(complaintMessages\)/);
  });
  it("tirar do arquivo volta a pô-la nas listas", async () => {
    state.complaint = base({ archivedAt: "2026-10-01 10:00:00" });
    await caller("admin").complaints.unarchive({ id: 5 });
    expect(state.updates).toEqual([[5, { archivedAt: null, archivedById: null, archiveReason: null }]]);
  });
  it("arquivada não muda de estado", async () => {
    state.complaint = base({ archivedAt: "2026-10-01 10:00:00" });
    await expect(caller("supervisor").complaints.update({ id: 5, status: "closed" })).rejects.toThrow(/arquivada/);
  });
  it("tirar foto e condutor: vão para removed_records, com quem tirou", async () => {
    await caller("supervisor").complaints.removePhoto({ id: 9 });
    await caller("supervisor").complaints.detachDriver({ id: 3 });
    expect(state.removed).toEqual([{ kind: "photo", id: 9, by: 77 }, { kind: "driver", id: 3, by: 77 }]);
    expect(src("server/complaintsExtended.ts")).not.toMatch(/db\.delete\(complaintDriversOnDuty\)/);
  });
  it("as arquivadas saem das listas, contadores, lembretes, passagem e avaliação", () => {
    const db = src("server/db.ts");
    const list = db.slice(db.indexOf("export async function getComplaints"), db.indexOf("export async function getComplaintById"));
    expect(list).toContain("filters?.archived ? sql`${complaints.archivedAt} IS NOT NULL` : sql`${complaints.archivedAt} IS NULL`");
    const stats = db.slice(db.indexOf("export async function getComplaintStats"), db.indexOf("// ─── GOOGLE REVIEWS"));
    expect(stats).toContain("archivedAt} IS NULL");
    expect(src("server/caseOps.ts")).toContain("AND slaAlertedAt IS NULL AND archivedAt IS NULL");
    expect(src("server/shiftHandoverDraft.ts")).toContain("complaints.archivedAt IS NULL");
    expect((src("server/evaluationEngine.ts").match(/c\.archivedAt IS NULL/g) ?? []).length).toBe(2);
  });
  it("a lista das arquivadas é só para quem gere", async () => {
    await expect(caller("team_leader").complaints.list({ archived: true })).rejects.toThrow();
  });
});

describe("Estados pelas mesmas regras", () => {
  it("reabrir limpa resolvedAt/closedAt/closedById e o aviso de SLA", async () => {
    state.complaint = base({ complaintStatus: "closed" });
    await caller("supervisor").complaints.update({ id: 5, status: "analyzing" });
    expect(state.updates[0][1]).toMatchObject({ complaintStatus: "analyzing", resolvedAt: null, closedAt: null, closedById: null, slaAlertedAt: null });
  });
  it("prazo novo → pode voltar a avisar", async () => {
    await caller("supervisor").complaints.update({ id: 5, slaHours: 24 });
    expect(state.updates[0][1]).toMatchObject({ slaAlertedAt: null });
  });
  it("prazo da atribuição = fim do dia escolhido em Lisboa (não 00:00 UTC)", async () => {
    await caller("supervisor").complaints.update({ id: 5, dueDate: "2026-10-05T23:59:59" });
    expect(state.updates[0][1]).toMatchObject({ dueDate: "2026-10-05 22:59:59" });
    expect(caseDueToUtc("2026-12-05")).toBe("2026-12-05 23:59:59"); // só o dia = fim do dia (inverno: UTC)
    await expect(caller("supervisor").complaints.update({ id: 5, dueDate: "amanhã" })).rejects.toThrow(/Prazo inválido/);
  });
  it("enviar email a uma reclamação resolvida não a passa a 'Aguarda Cliente'", async () => {
    state.complaint = base({ complaintStatus: "resolved" });
    await caller("supervisor").complaints.sendEmailToClient({ complaintId: 5, subject: "Olá", body: "Texto" });
    expect(state.sent).toHaveLength(1);
    expect(state.updates.some(([, d]) => d.complaintStatus)).toBe(false);
    state.complaint = base({ complaintStatus: "analyzing" }); state.updates = [];
    await caller("supervisor").complaints.sendEmailToClient({ complaintId: 5, subject: "Olá", body: "Texto" });
    expect(state.updates).toEqual([[5, { complaintStatus: "waiting_client" }]]);
  });
  it("a resposta do cliente por email usa a mesma regra e tira do arquivo", () => {
    const inbound = src("server/jobs/emailInboundSync.ts");
    expect(inbound).toContain("complaintStatusOnClientReply(existing.complaintStatus)");
    expect(inbound).toContain("archivedAt: null, archivedById: null, archiveReason: null");
  });
  it("API (MCP): estados manuais com as mesmas regras e DELETE arquiva", () => {
    const mcp = src("server/mcpApi.ts");
    expect(mcp).toContain("COMPLAINT_MANUAL_STATUSES.includes(String(b.status))");
    expect(mcp).toContain("complaintStatusPatch(cur.complaintStatus");
    expect(mcp).toContain("await archiveComplaint(id,");
    expect(mcp).not.toContain("deleteComplaint");
  });
});

describe("Âmbito de cidade nas escritas", () => {
  const lisboa = { all: false, defaultCityId: 10, cityIds: [10], projectIds: [10, 11], missingCostCenter: false };
  const inLisboa = (fn: () => Promise<unknown>) => cityScope.run(lisboa as any, fn);
  beforeEach(() => {
    state.rows.set(complaints, [{ projectId: 20 }]); // a reclamação é do Porto
    state.rows.set(complaintPhotos, [{ complaintId: 8 }]);
    state.rows.set(complaintDriversOnDuty, [{ complaintId: 8 }]);
  });
  it("um TL de Lisboa não mexe numa reclamação do Porto (por id, complaintId, foto ou condutor)", async () => {
    for (const [path, input] of [
      ["complaints.update", { id: 8, status: "closed" }],
      ["complaints.archive", { id: 8, reason: "xxx" }],
      ["complaints.sendEmailToClient", { complaintId: 8, subject: "a", body: "b" }],
      ["complaints.addMessage", { complaintId: 8, message: "a" }],
      ["complaints.attachDriver", { complaintId: 8, employeeName: "Ana", source: "manual" }],
      ["complaints.removePhoto", { id: 3 }],
      ["complaints.detachDriver", { id: 4 }],
    ] as const) {
      await expect(inLisboa(() => assertScopedOperation(path, "mutation", input)), path).rejects.toBeInstanceOf(TRPCError);
    }
  });
  it("na cidade dele passa; mudar para outra cidade (ou para nenhuma) não", async () => {
    state.rows.set(complaints, [{ projectId: 11 }]);
    await expect(inLisboa(() => assertScopedOperation("complaints.update", "mutation", { id: 8, status: "closed" }))).resolves.toBeUndefined();
    await expect(inLisboa(() => assertScopedOperation("complaints.update", "mutation", { id: 8, projectId: 20 }))).rejects.toBeInstanceOf(TRPCError);
    await expect(inLisboa(() => assertScopedOperation("complaints.update", "mutation", { id: 8, projectId: null }))).rejects.toBeInstanceOf(TRPCError);
  });
  it("quem não escolhe projeto ao criar fica com a cidade dele", () => {
    const r = src("server/routers.ts");
    expect(r).toContain("const projectId = input.projectId ?? defaultScopedProjectId();");
  });
});

describe("O responsável é uma ficha", () => {
  it("avisos e calendário vão à conta da ficha; juntar contas não lhe mexe", () => {
    expect(src("server/complaintsExtended.ts")).toContain("alsoUserIds: await assigneeUserIds([c.assignedToId])");
    expect(src("server/complaintTriage.ts")).toContain("assigneeUserIds([c.assignedToId])");
    expect(src("server/caseOps.ts")).toContain("assigneeUserIds(g.rows.map((x) => (x.assignedToId == null ? null : Number(x.assignedToId))))");
    expect(src("server/google/syncService.ts")).toContain("WHERE assignedToId = ${u.employeeId}");
    const st = reassignStatements(7, 3).join("\n");
    expect(st).not.toContain("`complaints`");
    expect(st).not.toContain("`lost_found_items`");
  });
  it("os links dos avisos abrem o caso (/reclamacoes?id=), não uma rota que não existe", () => {
    expect(src("server/complaintsExtended.ts")).toContain("link: `/reclamacoes?id=${complaintId}`");
    expect(src("server/complaintTriage.ts")).toContain("link: `/reclamacoes?id=${complaintId}`");
    expect(src("server/complaintsExtended.ts")).not.toContain("`/reclamacoes/${complaintId}`");
  });
});

describe("Em serviço: identidade explícita e só quem estava lá", () => {
  it("cidade da escala a partir do nome da cidade", () => {
    expect(extrasCityKeyOf("Lisboa")).toBe("lisbon");
    expect(extrasCityKeyOf("Porto")).toBe("porto");
    expect(extrasCityKeyOf("Faro")).toBe("faro");
    expect(extrasCityKeyOf(null)).toBeNull();
  });
  it("agente → ficha pelo ID (principal/extra), sem LIKE pelo nome; escalados confirmados, na cidade, entrada e saída", () => {
    const ext = src("server/complaintsExtended.ts");
    const fn = ext.slice(ext.indexOf("export async function findDriversOnDuty"), ext.indexOf("export async function attachDriverToComplaint"));
    expect(fn).toContain("employeesForAgentIds(");
    expect(fn).toContain("isLinkableAgent(h.agentUserId, h.agentName)");
    expect(fn).not.toMatch(/LIKE/);
    expect(fn).toContain('eq(extrasDiaAssignments.status, "confirmed")');
    expect(fn).toContain("inArray(extrasDiaAssignments.assignmentDate, days)");
    expect(fn).toContain("historyFailed = true");
  });
});

describe("Emails da caixa", () => {
  it("cada caixa pede o módulo dela: recursos-humanos@ = Leads de Extras, como a aba Recrutamento (antes bastava 'clientes')", async () => {
    const r = src("server/routers.ts");
    expect(r).toContain('"recursos-humanos": "leads_extras"');
    expect(r).toContain("requireAccess(ctx.user, INBOUND_ALIAS_MODULE[input.alias], \"view\");");
    const noLeads = ["team_leader", "supervisor", "frontoffice", "backoffice"].find((role) => can(role, "clientes", "view") && !can(role, "leads_extras", "view"));
    if (noLeads) await expect(caller(noLeads).clients.inboundEmails({ alias: "recursos-humanos" })).rejects.toThrow();
    const noComplaints = ["user", "extra", "condutor"].find((role) => !can(role, "reclamacoes", "view"));
    await expect(caller(noComplaints!).clients.inboundEmails({ alias: "reclamacoes" })).rejects.toThrow();
  });
  it("anexar o mesmo email ao mesmo caso não duplica a mensagem", async () => {
    state.inbound = { id: 3, subject: "x", bodyText: "y", targetModule: "complaint", targetId: 5 };
    const r = await caller("supervisor").clients.linkInbound({ inboundId: 3, module: "complaint", caseId: 5 });
    expect(r).toEqual({ ok: true, already: true });
    expect(state.messages).toHaveLength(0);
  });
});

describe("Leitura falhada ≠ vazio", () => {
  it("dossier e histórico da reserva dizem 'indisponível' em vez de vazio", () => {
    const d = src("server/complaintDossier.ts");
    expect(d).toContain("historyError: UNAVAILABLE_HISTORY");
    expect(d).toContain("extrasError:");
    expect(d).toContain("const error = history.length ? undefined : (d.error ?? d.historyError ?? liveError);");
    expect(d).not.toContain(".catch(() => [] as Array<typeof multiparkBookingHistory.$inferSelect>)");
    expect(src("server/routers.ts")).toContain("emailAttachmentsFailed = true");
  });
  it("a página usa QueryErrorNote em lista, caso, reserva, histórico, viatura, condutores e pesquisa", () => {
    const page = src("client/src/pages/ComplaintsPage.tsx");
    for (const what of ['what="as reclamações"', "what={`a reclamação #${id}`}", 'what="a reserva"', 'what="o histórico da reserva"', 'what="quem mexeu no carro"', 'what="os condutores associados"', 'what="os condutores sugeridos"', 'what="a pesquisa de reservas"']) {
      expect(page).toContain(what);
    }
    expect(page).toContain("candidatesQ.data?.historyFailed");
    expect(page).toContain("!dossier.error");
    expect(src("client/src/components/ClientHistoryCard.tsx")).toContain('what="o histórico do cliente"');
    expect(src("client/src/components/ComplaintAiPanel.tsx")).toContain('what="as sugestões da IA"');
    expect(src("client/src/components/LinkInboundEmailButton.tsx")).toContain('what="os emails da caixa"');
  });
});

describe("Página", () => {
  const page = src("client/src/pages/ComplaintsPage.tsx");
  it("botões conforme a matriz: editar, gerir (arquivar) e exportar (CSV)", () => {
    expect(page).toContain('can(user, "reclamacoes", "export")');
    expect(page).toContain('const canEdit = can(user, "reclamacoes", "edit");');
    expect(page).toContain("{canEdit && <Button onClick={onNew}>");
    expect(page).not.toContain("trpc.complaints.delete.");
    expect(page).toContain("trpc.complaints.archive.useMutation");
  });
  it("contadores contados do quadro (com os filtros) e o mesmo 'em atraso' do cron", () => {
    expect(page).not.toContain("trpc.complaints.stats.useQuery");
    expect(page).toContain("overdue: list.filter((c) => complaintOverdue(c, nowMs)).length");
    expect(page).toContain("closed: n(\"closed\") + n(\"converted\")");
  });
  it("CSV com datas de Lisboa e células seguras; fotos com fileKey e reduzidas; telemóvel sem colunas espremidas", () => {
    expect(page).toContain("toCsv(headers, rows)");
    expect(page).not.toMatch(/toISOString\(\)\.slice\(0, 10\)/);
    expect(page).toContain("fileHref(p.url, p.fileKey)");
    expect(page).toContain("await compressImage(original, 1600, 0.85)");
    const create = page.slice(page.indexOf("function CreateDialog("), page.indexOf("// ─── Panel: Condutores em serviço"));
    expect(create).not.toMatch(/className="col-span-2/);
  });
  it("tirar foto/condutor e converter pedem confirmação; ?id= segue a navegação", () => {
    expect(page).toContain('title: "Tirar esta foto do caso?"');
    expect(page).toContain("title: `Tirar ${d.employeeName} da reclamação?`");
    expect(page).toContain('title: "Converter em caso de Perdidos?"');
    expect(page).toContain("const search = useSearch();");
  });
});
