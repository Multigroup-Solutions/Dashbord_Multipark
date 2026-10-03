/**
 * P3 lote 16d — Críticas: "respondida" é publicada (guardar é rascunho), uma
 * convertida não volta atrás nem abre duas reclamações, as contas batem com a
 * página, as críticas de email ganham o parque do perfil e uma leitura falhada
 * diz que falhou.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  review: null as any,
  updates: [] as Array<[number, any]>,
  created: [] as any[],
  converted: [] as Array<[number, any]>,
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
  getGoogleReviewById: async () => state.review,
  updateGoogleReview: async (id: number, data: any) => { state.updates.push([id, data]); },
  createGoogleReview: async (data: any) => { state.created.push(data); return 55; },
}));
vi.mock("./reviewOps", async (original) => ({
  ...(await original<object>()),
  convertReviewToComplaint: async (id: number, _actor: any, opts: any) => { state.converted.push([id, opts]); return { complaintId: 900, alreadyConverted: false }; },
}));

import { appRouter } from "./routers";
import { reviewUpdatePatch, isMarkedPublished, draftStatusAfterGenerate, reviewComplaintPriority } from "../shared/reviewRules";
import { groupReviewsByPark, isReviewClosed, isReviewPending } from "../shared/reviewParks";
import { projectForLocationTitle } from "./reviewOps";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const caller = (role: string) => appRouter.createCaller({ user: { id: 77, role, name: "Rita" }, req: { headers: {} }, res: {} } as any);
const review = (o: any = {}) => ({
  id: 9, projectId: 10, rating: 2, status: "pending_response", complaintId: null, respondedAt: null,
  googleReply: null, googleReviewName: null, aiResponse: null, aiResponseApproved: 0, reviewerName: "Ana", ...o,
});
const NOW = "2026-10-02 10:00:00";

beforeEach(() => { state.review = review(); state.updates = []; state.created = []; state.converted = []; });

describe("Respondida = publicada (guardar é rascunho)", () => {
  it("guardar texto é rascunho por aprovar: não marca respondida nem muda o estado", () => {
    const r = reviewUpdatePatch(review(), { aiResponse: "  Obrigado!  " }, 77, NOW);
    expect(r).toEqual({ ok: true, patch: { aiResponse: "Obrigado!", aiResponseApproved: 0 } });
  });
  it("'Já publiquei no Google' só nas de email, com texto, e marca data e pessoa", () => {
    expect(reviewUpdatePatch(review({ googleReviewName: "accounts/1/locations/2/reviews/3" }), { status: "manually_responded" }, 77, NOW))
      .toMatchObject({ ok: false, error: expect.stringMatching(/Aprovar e publicar/) });
    expect(reviewUpdatePatch(review(), { status: "manually_responded" }, 77, NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/Escreve/) });
    expect(reviewUpdatePatch(review({ aiResponse: "Olá" }), { status: "manually_responded" }, 77, NOW))
      .toEqual({ ok: true, patch: { aiResponseApproved: 1, respondedAt: NOW, respondedBy: 77, status: "manually_responded" } });
  });
  it("marcada como publicada: o texto fica como foi enviado; Desfazer volta a por responder", () => {
    const marked = review({ aiResponse: "Olá", status: "manually_responded", respondedAt: NOW });
    expect(isMarkedPublished(marked)).toBe(true);
    expect(reviewUpdatePatch(marked, { aiResponse: "outro" }, 77, NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/Desfazer/) });
    expect(reviewUpdatePatch(marked, { status: "pending_response" }, 77, NOW))
      .toEqual({ ok: true, patch: { respondedAt: null, respondedBy: null, status: "pending_response" } });
    // publicada pela API não se desfaz cá
    expect(reviewUpdatePatch(review({ googleReply: "Olá", status: "manually_responded", respondedAt: NOW }), { status: "pending_response" }, 77, NOW).ok).toBe(false);
  });
  it("reabrir uma dispensada devolve o estado certo", () => {
    expect(reviewUpdatePatch(review({ status: "dismissed" }), { status: "pending_response" }, 77, NOW)).toEqual({ ok: true, patch: { status: "pending_response" } });
    expect(reviewUpdatePatch(review({ status: "dismissed", googleReply: "x", respondedAt: NOW }), { status: "pending_response" }, 77, NOW))
      .toEqual({ ok: true, patch: { status: "manually_responded" } });
  });
  it("convertida: não muda de estado nem se dispensa; marcar publicada só mexe na data", () => {
    const conv = review({ status: "converted_complaint", complaintId: 900, aiResponse: "Lamentamos" });
    expect(reviewUpdatePatch(conv, { status: "dismissed" }, 77, NOW).ok).toBe(false);
    expect(reviewUpdatePatch(review(), { status: "converted_complaint" }, 77, NOW).ok).toBe(false);
    expect(reviewUpdatePatch(review(), { status: "ai_responded" }, 77, NOW).ok).toBe(false);
    expect(reviewUpdatePatch(conv, { status: "manually_responded" }, 77, NOW))
      .toEqual({ ok: true, patch: { aiResponseApproved: 1, respondedAt: NOW, respondedBy: 77 } });
    // estado desalinhado (pending mas com reclamação) também conta como convertida
    expect(reviewUpdatePatch(review({ complaintId: 900 }), { status: "dismissed" }, 77, NOW).ok).toBe(false);
  });
  it("rascunho da IA só passa a 'Rascunho IA' quando ainda estava por responder", () => {
    expect(draftStatusAfterGenerate("pending_response")).toBe("ai_responded");
    expect(draftStatusAfterGenerate("ai_responded")).toBe("ai_responded");
    for (const s of ["manually_responded", "converted_complaint", "dismissed"]) expect(draftStatusAfterGenerate(s)).toBeUndefined();
  });
});

describe("Router das críticas", () => {
  it("update grava o patch das regras e recusa o resto com a mensagem", async () => {
    await caller("team_leader").reviews.update({ id: 9, aiResponse: "Obrigado" });
    expect(state.updates).toEqual([[9, { aiResponse: "Obrigado", aiResponseApproved: 0 }]]);
    state.review = review({ complaintId: 900, status: "converted_complaint" });
    await expect(caller("team_leader").reviews.update({ id: 9, status: "dismissed" })).rejects.toThrow(/reclamação/);
  });
  it("update e aprovar pedem editar; crítica fora de âmbito → não encontrada", async () => {
    await expect(caller("condutor").reviews.update({ id: 9, aiResponse: "x" })).rejects.toThrow();
    state.review = undefined;
    await expect(caller("team_leader").reviews.update({ id: 9, aiResponse: "x" })).rejects.toThrow(/não encontrada/);
    await expect(caller("team_leader").reviews.approveResponse({ id: 9 })).rejects.toThrow(/não encontrada/);
  });
  it("aprovar só aprova o texto (não é respondida) e precisa de texto", async () => {
    await expect(caller("team_leader").reviews.approveResponse({ id: 9 })).rejects.toThrow(/Não há resposta/);
    state.review = review({ aiResponse: "Olá" });
    await caller("team_leader").reviews.approveResponse({ id: 9 });
    expect(state.updates).toEqual([[9, { aiResponseApproved: 1 }]]);
  });
  it("converter usa a conversão transacional; a importação 1–3★ também, e diz o que aconteceu", async () => {
    const r = await caller("team_leader").reviews.convertToComplaint({ id: 9 });
    expect(r).toEqual({ complaintId: 900, alreadyConverted: false });
    expect(state.converted[0][0]).toBe(9);
    state.converted = [];
    const created = await caller("team_leader").reviews.create({ reviewerName: "Ana", rating: 2, projectId: 10 });
    expect(created).toEqual({ id: 55, aiDrafted: false, complaintId: 900 });
    expect(state.converted).toEqual([[55, { defaultProjectId: null, via: "import" }]]);
  });
  it("a pesquisa de cliente sem âmbito de cidade saiu", () => {
    const procs = (appRouter as any)._def.procedures as Record<string, unknown>;
    expect(procs["reviews.searchClient"]).toBeUndefined();
    expect(src("server/db.ts")).not.toContain("searchClientHistory");
  });
  it("sincronizar Gmail devolve os números verdadeiros e os erros", () => {
    const r = src("server/routers.ts");
    const fn = r.slice(r.indexOf("syncFromGmail: protectedProcedure"), r.indexOf("// Checkout drivers ranking"));
    expect(fn).toContain("recordsCreated: r.pipelineCreated");
    expect(fn).toContain("errors: r.errors.slice(0, 10)");
    expect(fn).not.toContain("reviewsSkipped: 0");
  });
});

describe("Conversão: uma crítica, uma reclamação", () => {
  it("transação com a crítica bloqueada; se já tem reclamação devolve-a", () => {
    const ops = src("server/reviewOps.ts");
    expect(ops).toContain('.where(eq(googleReviews.id, reviewId)).limit(1).for("update")');
    expect(ops).toContain("if (review.complaintId) {");
    expect(ops).toContain("slaDeadline: sqlNow(Date.now() + REVIEW_COMPLAINT_SLA_HOURS * 3_600_000)");
  });
  it("prioridade igual nos três caminhos (1★ urgente, resto alta)", () => {
    expect(reviewComplaintPriority(1)).toBe("urgent");
    expect(reviewComplaintPriority(2)).toBe("high");
    expect(reviewComplaintPriority(3)).toBe("high");
  });
});

describe("As contas batem com a página", () => {
  it("com reclamação conta como convertida/fechada, mesmo com o estado desalinhado", () => {
    const r = { id: 1, projectId: 10, rating: 2, status: "pending_response", respondedAt: null, complaintId: 900 };
    expect(isReviewClosed(r)).toBe(true);
    expect(isReviewPending(r)).toBe(false);
    const [g] = groupReviewsByPark([r], [{ id: 10, name: "Airpark Lisboa" }]);
    expect(g).toMatchObject({ pending: 0, complaints: 1 });
  });
  it("as estatísticas do servidor usam as mesmas regras", () => {
    const db = src("server/db.ts");
    const fn = db.slice(db.indexOf("export async function getGoogleReviewStats"), db.indexOf("// ─── FORMAÇÃO E APOIO"));
    expect(fn).toContain('await import("../shared/reviewParks")');
    expect(fn).toContain("all.filter(isReviewConverted).length");
  });
  it("a importação externa antiga do Gmail está desligada (23a, D18): 410, nada se grava", () => {
    const ext = src("server/externalApi.ts");
    expect(ext).not.toContain("rev.rating || 5");
    const handler = ext.split('r.post("/gmail-import"')[1].split("\n  });")[0];
    expect(handler).toContain("res.status(410)");
    expect(handler).not.toMatch(/createGoogleReview|createIncident/);
  });
  it("a importação do Google não apaga o texto da resposta quando o cliente edita", () => {
    const svc = src("server/integrations/googleBusiness/service.ts");
    expect(svc).not.toContain("aiResponse: null, aiResponseApproved: 0");
    expect(svc).toContain("...(contentChanged ? { aiResponseApproved: 0 } : {})");
  });
});

describe("Críticas de email: parque do perfil Google", () => {
  const locs = [
    { title: "Airpark - Estacionamento Aeroporto Lisboa", projectId: 21 },
    { title: "Redpark Porto", projectId: 31 },
    { title: "Duplicado", projectId: 1 },
    { title: "duplicado", projectId: 2 },
    { title: "Sem parque", projectId: null },
  ];
  it("só com o título exato (acentos/hífens à parte) e sem ambiguidade", () => {
    expect(projectForLocationTitle("Airpark – Estacionamento Aeroporto Lisboa", locs)).toBe(21);
    expect(projectForLocationTitle("redpark porto", locs)).toBe(31);
    expect(projectForLocationTitle("Airpark", locs)).toBeNull();
    expect(projectForLocationTitle("Duplicado", locs)).toBeNull();
    expect(projectForLocationTitle("Sem parque", locs)).toBeNull();
    expect(projectForLocationTitle(undefined, locs)).toBeNull();
  });
  it("o leitor de email grava o parque da crítica", () => {
    const sync = src("server/jobs/emailInboundSync.ts");
    expect(sync).toContain("const projectId = await projectIdForReviewPark(g.parkName);");
  });
});

describe("Página: erro ≠ vazio, permissões, datas de Lisboa", () => {
  const page = src("client/src/pages/GoogleReviewsPage.tsx");
  // 23e (Jorge, 3 out 2026): Condutores e Agentes passaram para Pessoas → Condutores e agentes.
  const people = src("client/src/pages/CondutoresAgentesPage.tsx");
  it("lista, números, parques, crítica, condutores e agentes dizem quando falham", () => {
    for (const what of ['what="as críticas"', 'what="os números das críticas"', 'what="a crítica"', 'what="as críticas por parque"'])
      expect(page).toContain(what);
    for (const what of ['what="o ranking (BD da Multipark)"', 'what="as ações do agente (BD da Multipark)"'])
      expect(people).toContain(what);
  });
  it("ações só para quem edita; CSV só para quem exporta; sem o histórico sem âmbito", () => {
    expect(page).toContain('can(user as any, "criticas", "edit")');
    expect(page).toContain('can(user as any, "criticas", "export")');
    expect(page).toContain("toCsv(headers, rows)");
    expect(page).not.toContain("searchClient");
    expect(page).not.toContain("window.location.href");
    expect(page).not.toMatch(/[^.]confirm\(`|!confirm\(/);
  });
  it("início do mês e hoje em dias de Lisboa (não no fuso do browser)", () => {
    expect(people).toContain("const today = lisbonDayOf(new Date());");
    expect(people).not.toContain("today.toISOString().slice(0, 10)");
  });
  it("ajuda das Críticas existe e explica 'Já publiquei no Google'", () => {
    const doc = src("docs/ajuda/criticas.md");
    expect(doc).toContain("modulo: criticas");
    expect(doc).toContain("Já publiquei no Google");
    expect(src("client/src/pages/CrmClientPage.tsx")).toContain("href: `/criticas?id=${x.id}`");
  });
});
