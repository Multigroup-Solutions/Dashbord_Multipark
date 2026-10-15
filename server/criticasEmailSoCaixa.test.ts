/**
 * Críticas por email ficam só na caixa de correio (Jorge, 15 out 2026):
 * "As críticas do Google vêm diretamente pela API da Google. Quero que
 * desligues a importação das críticas por email — ficam só na caixa de
 * correio. Só quando alguém põe que aquilo é uma crítica é que importa para as
 * Críticas. As críticas que entraram por email estão a repetir: tira-as das
 * Críticas, mas não apagues — nem os emails."
 *
 * Sem BD nem IA reais: a BD é simulada onde é preciso e o SQL é lido já
 * compilado (MySqlDialect).
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";

const h = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  claimed: new Set<string>(),
  created: [] as any[],
  dupQueries: [] as any[],
  dupResult: null as number | null,
  parkQueries: [] as any[],
  autoDraft: vi.fn(async (..._a: any[]) => ({ drafted: true })),
  logs: [] as any[],
  db: null as any,
  review: null as any,
  listFilters: [] as any[],
  updates: [] as any[],
}));
const national = vi.hoisted(() => ({ all: true, defaultCityId: null, cityName: null, cityIds: [] as number[], projectIds: [] as number[], missingCostCenter: false }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => national,
  loadCityAccessParts: async () => ({ access: national, base: national, all: national }),
}));
vi.mock("./db", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    getDb: async () => h.db,
    getUserPermissionOverrides: async () => ({}),
    getUserModuleOverrides: async () => ({}),
    claimInboundEmail: vi.fn(async (d: any) => (h.claimed.has(d.messageId) ? null : (h.claimed.add(d.messageId), h.claimed.size))),
    updateInboundEmail: vi.fn(async () => {}),
    deleteInboundEmail: vi.fn(async () => {}),
    createGoogleReview: vi.fn(async (d: any) => { h.created.push(d); return 700 + h.created.length; }),
    logActivity: vi.fn(async (e: any) => { h.logs.push(e); }),
    getGoogleReviewById: async () => h.review,
    updateGoogleReview: async (id: number, data: any) => { h.updates.push([id, data]); },
    getGoogleReviews: async (f: any) => { h.listFilters.push(f ?? null); return []; },
  };
});
vi.mock("./reviewCleanup", async (orig) => ({
  ...(await orig<object>()),
  reviewFlagOn: async (name: string) => !!h.flags[name],
  findEmailReviewDuplicate: async (n: any) => { h.dupQueries.push(n); return h.dupResult; },
}));
vi.mock("./reviewOps", async (orig) => ({
  ...(await orig<object>()),
  projectIdForReviewPark: async (name?: string) => { h.parkQueries.push(name ?? null); return name && /airpark/i.test(name) ? 7 : null; },
}));
vi.mock("./reviewAutoDraft", async (orig) => ({ ...(await orig<object>()), autoDraftEmailReview: h.autoDraft }));

import { processInboundEmail, reviewFromEmail } from "./jobs/emailInboundSync";
import { NOT_A_REVIEW_IMPORT, importMailMessageAsReview, reviewsOfMessageIds } from "./reviewEmailImport";
import { reviewInCriticas, reviewInCriticasSql, reviewLinkableToApi } from "./reviewVisibility";
import { EMAIL_ONLY_REVIEW_READONLY, isEmailOnlyReview } from "../shared/reviewRules";
import { isReviewMailbox } from "../shared/mail";
import { AUTOMATION_FLAGS, automationFlagDefault } from "../shared/appSettings";
import { autoPublishEntryRefusal } from "../shared/reviewAutoPublish";
import { routeEmailMessage, type EmailRoutingDeps, type EmailRoutingMessage } from "./commsRouting";
import { ALL_TRIAGE_FEATURES } from "../shared/mailTriage";
import { realAutoPublishDeps } from "./reviewAutoPublish";
import { userSources } from "./peoplePerformance";
import { appRouter } from "./routers";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const compile = (s: SQL) => new MySqlDialect().sqlToQuery(s);
const caller = (role: string) => appRouter.createCaller({ user: { id: 77, role, name: "Rita" }, req: { headers: {} }, res: {} } as any);

const GOOGLE = "businessprofile-noreply@google.com";
const SUBJECT = "Rui deixou uma crítica sobre Airpark - Estacionamento Aeroporto de Lisboa";
const BODY = `Rui deixou uma crítica sobre Airpark - Estacionamento Aeroporto de Lisboa

Bom trabalho, recebeu uma nova crítica de 5 estrela(s)

Rui Costa

O serviço foi rápido e o condutor muito simpático, recomendo.

Responder à crítica <https://business.google.com/n/1>`;

const inbound = (o: any = {}) => ({
  alias: "criticas" as const, messageId: `<m-${Math.random()}@google.com>`, gmThreadId: null, refs: [], fromName: "Google Business Profile", fromEmail: GOOGLE,
  subject: SUBJECT, receivedAt: "2026-10-15 09:00:00", text: BODY, html: null, loadAttachments: async () => [], ...o,
});

beforeEach(() => {
  h.flags = { REVIEWS_EMAIL_STRICT: false, REVIEWS_DEDUP: false, REVIEWS_FROM_EMAIL: false };
  h.created = [];
  h.dupQueries = [];
  h.dupResult = null;
  h.parkQueries = [];
  h.logs = [];
  h.autoDraft.mockClear();
  h.db = null;
  h.review = null;
  h.listFilters = [];
  h.updates = [];
});

// ─── 1. Importação automática desligada ─────────────────────────────────────

describe("interruptor REVIEWS_FROM_EMAIL (desligado por omissão, só o super admin)", () => {
  it("está no catálogo das automações: desligado e só do super admin", () => {
    const f = AUTOMATION_FLAGS.find((x) => x.name === "REVIEWS_FROM_EMAIL");
    expect(f).toMatchObject({ defaultEnabled: false, superAdminOnly: true });
    expect(automationFlagDefault("REVIEWS_FROM_EMAIL")).toBe(false);
    expect(f!.description).toMatch(/Importar para as Críticas/);
  });

  it("email da Google pela criticas@, desligado: não cria crítica, não pede rascunho e nem lê a BD das críticas", async () => {
    const out = await processInboundEmail(inbound());
    expect(out).toMatchObject({ status: "processed", routed: { targetModule: "review_off" } });
    expect(h.created).toHaveLength(0);
    expect(h.autoDraft).not.toHaveBeenCalled();
    expect(h.parkQueries).toEqual([]);
    expect(h.dupQueries).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  it("desligado com o STRICT e o DEDUP ligados: o aviso da Google também fica só na caixa", async () => {
    h.flags.REVIEWS_EMAIL_STRICT = true;
    h.flags.REVIEWS_DEDUP = true;
    const out = await processInboundEmail(inbound());
    expect(out).toMatchObject({ routed: { targetModule: "review_off" } });
    expect(h.created).toHaveLength(0);
    expect(h.autoDraft).not.toHaveBeenCalled();
  });

  it("o que nunca seria crítica continua como antes (resumo, 'não é crítica' com o STRICT)", async () => {
    h.flags.REVIEWS_DEDUP = true;
    expect(await processInboundEmail(inbound({ subject: "Recebeu 3 novas críticas", text: "Veja o que os clientes dizem." }))).toMatchObject({ routed: { targetModule: "review_summary" } });
    h.flags.REVIEWS_EMAIL_STRICT = true;
    expect(await processInboundEmail(inbound({ fromEmail: "ana@gmail.com", subject: "Candidatura", text: "Envio o CV." }))).toMatchObject({ routed: { targetModule: "not_review" } });
    expect(h.created).toHaveLength(0);
  });

  it("ligado: como até hoje — cria a crítica (marcada como importada pelo sistema) e pede o rascunho", async () => {
    h.flags.REVIEWS_FROM_EMAIL = true;
    const out = await processInboundEmail(inbound());
    expect(out).toMatchObject({ routed: { targetModule: "review", targetId: 701 } });
    expect(h.created[0]).toMatchObject({ rating: 5, reviewerName: "Rui Costa", projectId: 7, status: "pending_response", emailImportedById: null });
    expect(h.created[0].emailImportedAt).toBeTruthy();
    expect(isEmailOnlyReview({ ...h.created[0], googleReviewKey: null })).toBe(false);
    expect(h.autoDraft).toHaveBeenCalledWith(701, "2026-10-15 09:00:00", { timeoutMs: 15_000 });
    expect(h.logs).toEqual([]);
  });

  it("todos os caminhos automáticos passam pelo mesmo portão (sincronização, push, novas tentativas)", () => {
    const job = src("server/jobs/emailInboundSync.ts");
    expect(job).toContain('if (!manual && !(await reviewFlagOn("REVIEWS_FROM_EMAIL"))) return { targetModule: "review_off" };');
    // O portão vem ANTES de qualquer escrita (parque, repetida, INSERT, IA).
    const fn = job.slice(job.indexOf("export async function reviewFromEmail("));
    const gate = fn.indexOf('reviewFlagOn("REVIEWS_FROM_EMAIL")');
    for (const later of ["projectIdForReviewPark(", "findEmailReviewDuplicate(", "(opts.insert ?? createGoogleReview)(", "reviewEmailFollowUps({"]) expect(fn.indexOf(later)).toBeGreaterThan(gate);
    // routeToModule (sincronização, push e as novas tentativas chamam processInboundEmail) só tem este caminho para as críticas.
    expect(job.split('if (alias === "criticas")')[1].split("\n  }")[0]).toContain("return reviewFromEmail(parsed, { ...ctx, clientName, desc }, { manualBy: ctx.manualReview?.userId ?? null });");
    const svc = src("server/mail/service.ts");
    expect(svc).toContain("if (releasedStatusOf(routed?.targetModule)) {");
  });
});

// ─── 2. O email fica na caixa; reclamação e perdido abrem caso ──────────────

const BOXES = ["info", "reservas", "rh", "reclamacoes", "perdidos", "criticas"].map((key) => ({ key, label: key, active: true }));
const MSG: EmailRoutingMessage = { threadId: 10, messageId: 100, fromBoxKey: "criticas", subject: "Assunto", text: "Texto", fromName: "Ana", fromEmail: "ana@gmail.com", attachmentNames: [], projectId: null, keepBox: true };

function deps(output: any) {
  const calls = { move: [] as any[], intake: [] as any[], firstContact: 0 };
  const claimed = new Set<number>();
  const d: EmailRoutingDeps = {
    enabled: async () => true,
    settings: async () => ({ minConfidence: 0.7, perRun: 10 }),
    caseSettings: async () => ({ createMinConfidence: 0.85, suggestMinConfidence: 0.5 }),
    features: async () => ({ ...ALL_TRIAGE_FEATURES }),
    boxes: async () => BOXES,
    claim: async (m) => { if (claimed.has(m.messageId)) return false; claimed.add(m.messageId); return true; },
    classify: async () => ({ output, restore: (s: string) => s }),
    move: async (t, b, opts) => { calls.move.push([t, b, opts ?? null]); return true; },
    record: async () => {},
    firstContact: async () => { calls.firstContact++; return { outcome: "created", leadId: 1, applicationId: null } as any; },
    cityProjectId: async () => null,
    afterRh: async () => {},
    caseIntake: async (_m, v) => { calls.intake.push(v); return { status: "created", complaintId: 9 } as any; },
    markRead: async () => {},
  };
  return { d, calls };
}

describe("o email fica na caixa Críticas — só uma reclamação ou um perdido o tiram de lá", () => {
  it("uma reclamação escrita para a criticas@ continua a abrir o caso (e a conversa vai para as Reclamações)", async () => {
    const out = await processInboundEmail(inbound({ fromEmail: "joana@gmail.com", fromName: "Joana", subject: "Riscaram-me o carro", text: "O carro voltou com um risco na porta. Quero uma solução." }));
    expect(out).toMatchObject({ routed: { targetModule: "review_off" } }); // largado para a triagem (não vira crítica)
    expect(h.created).toHaveLength(0);
    const { d, calls } = deps({ box: "reclamacoes", confidence: 0.93, reason: "Risco na porta", complaint: 0.95 });
    expect(await routeEmailMessage(MSG, d)).toMatchObject({ status: "moved", boxKey: "reclamacoes", complaint: { status: "created" } });
    expect(calls.intake[0]).toMatchObject({ kind: "complaint" });
  });

  it("um perdido também abre o caso", async () => {
    const { d, calls } = deps({ box: "perdidos", confidence: 0.9, reason: "Deixou o casaco", lostItem: 0.95 });
    expect(await routeEmailMessage(MSG, d)).toMatchObject({ status: "moved", boxKey: "perdidos" });
    expect(calls.intake[0]).toMatchObject({ kind: "lost_found" });
  });

  it("sem caso fica na caixa Críticas: nem caixa do tema, nem o info, nem lead do RH", async () => {
    for (const output of [
      { box: "reservas", confidence: 0.95, reason: "preço" },
      { box: "criticas", confidence: 0.95, reason: "elogio" },
      { box: "geral", confidence: 0.2, reason: "não percebi" },
      { box: "rh", confidence: 0.95, reason: "candidatura", candidate: true },
    ]) {
      const { d, calls } = deps(output);
      expect(await routeEmailMessage(MSG, d)).toMatchObject({ status: "kept", boxKey: "criticas" });
      expect(calls.move).toEqual([]);
      expect(calls.firstContact).toBe(0);
    }
  });

  it("sem a marca (outra caixa, 'not_review') a triagem continua a pôr na caixa do tema", async () => {
    const { d, calls } = deps({ box: "reservas", confidence: 0.95, reason: "preço" });
    expect(await routeEmailMessage({ ...MSG, keepBox: false }, d)).toMatchObject({ status: "moved", boxKey: "reservas" });
    expect(calls.move).toEqual([[10, "reservas", null]]);
  });

  it("a marca acompanha o email na sincronização, na nova tentativa e nos pendentes; o aviso de email novo fica como quando criava a crítica", () => {
    const svc = src("server/mail/service.ts");
    expect(svc).toContain('keepBox = released === "review_off";');
    expect(svc).toContain("keepBox: !!ctx.keepBox,");
    expect(svc).toContain("const stayedAsReviewMail = keepBox && noticeBox === mailbox;");
    const routing = src("server/commsRouting.ts");
    expect(routing).toContain('keepBox: r.pipelineStatus === "review_off",');
    expect(routing).toContain("const target = caseBox && active.has(caseBox) ? caseBox : msg.keepBox ? null : d.routeBox;");
  });
});

// ─── 3. Importação à mão ────────────────────────────────────────────────────

describe("uma pessoa importa: cria a crítica e ela aparece", () => {
  const parsed = { clientEmail: undefined, vehiclePlate: undefined, clientName: undefined } as any;
  const ctx = (o: any = {}) => ({ subject: SUBJECT, bodyText: BODY, messageId: "<abc@google.com>", receivedAt: "2026-10-15 09:00:00", fromEmail: GOOGLE, clientName: "Desconhecido", desc: `${SUBJECT}\n\n${BODY}`, ...o });

  it("com o interruptor desligado e o STRICT ligado, à mão cria — com quem e quando — e fica no registo", async () => {
    h.flags.REVIEWS_EMAIL_STRICT = true;
    const r = await reviewFromEmail(parsed, ctx(), { manualBy: 42 });
    expect(r).toMatchObject({ targetModule: "review", targetId: 701, createdId: 701 });
    expect(h.created[0]).toMatchObject({ emailImportedById: 42, sourceEmailId: "<abc@google.com>", rating: 5, reviewerName: "Rui Costa" });
    expect(h.created[0].emailImportedAt).toBeTruthy();
    // aparece: não é "só da caixa de correio"
    expect(isEmailOnlyReview({ ...h.created[0], googleReviewKey: null })).toBe(false);
    expect(h.logs[0]).toMatchObject({ userId: 42, action: "review_email_import", entity: "google_review", entityId: 701 });
    expect(h.autoDraft).toHaveBeenCalledWith(701, "2026-10-15 09:00:00", { timeoutMs: 15_000 });
    // à mão compara SEMPRE com as que estão nas Críticas (o REVIEWS_DEDUP está desligado aqui)
    expect(h.dupQueries).toHaveLength(1);
    expect(h.dupQueries[0]).toMatchObject({ rating: 5, parkKey: "p7", apiKey: false });
  });

  it("à mão, a crítica que a API já trouxe não se repete: a do email fica marcada como repetida (sem rascunho)", async () => {
    h.dupResult = 321;
    const r = await reviewFromEmail(parsed, ctx(), { manualBy: 42 });
    expect(r).toMatchObject({ targetModule: "review", targetId: 321, createdId: 701, duplicateOf: 321 });
    expect(h.created[0]).toMatchObject({ duplicateOf: 321, emailImportedById: 42 });
    expect(isEmailOnlyReview({ ...h.created[0], googleReviewKey: null })).toBe(false);
    expect(h.logs[0]).toMatchObject({ userId: 42, action: "review_email_import", entityId: 701 });
    expect(String(h.logs[0].details)).toContain("repetida de #321");
    expect(h.autoDraft).not.toHaveBeenCalled();
  });

  it("cidade: quem só vê as suas cidades e importa um email sem parque reconhecido fica com a crítica na cidade da conversa", async () => {
    const other = ctx({ subject: "Opinião", bodyText: "Gostei muito do serviço, voltarei.", fromEmail: "ana@gmail.com", clientName: "Ana" });
    await reviewFromEmail(parsed, other, { manualBy: 42, fallbackProjectId: 3 });
    expect(h.created[0].projectId).toBe(3);
    // parque reconhecido no email ganha sempre
    await reviewFromEmail(parsed, ctx(), { manualBy: 42, fallbackProjectId: 3 });
    expect(h.created[1].projectId).toBe(7);
    // automático nunca adivinha
    h.flags.REVIEWS_FROM_EMAIL = true;
    await reviewFromEmail(parsed, other, { fallbackProjectId: 3 });
    expect(h.created[2].projectId).toBeNull();
    const inbox = src("server/mail/inbox.ts");
    expect(inbox).toContain("const fallbackProjectId = scoped === undefined ? null");
    expect(inbox).toContain("return await importMailMessageAsReview(messageId, viewer.id, { fallbackProjectId });");
  });

  it("automático (ligado) sem o REVIEWS_DEDUP: não compara (como até hoje)", async () => {
    h.flags.REVIEWS_FROM_EMAIL = true;
    await reviewFromEmail(parsed, ctx(), {});
    expect(h.dupQueries).toEqual([]);
  });

  it("a pessoa decide: um email que a regra não daria como crítica (não é da Google, sem estrelas) também entra", async () => {
    h.flags.REVIEWS_EMAIL_STRICT = true;
    const r = await reviewFromEmail(parsed, ctx({ fromEmail: "ana@gmail.com", subject: "Opinião", bodyText: "Gostei muito do serviço, voltarei.", clientName: "Ana" }), { manualBy: 42 });
    expect(r).toMatchObject({ targetModule: "review" });
    expect(h.created[0]).toMatchObject({ reviewerName: "Ana", emailImportedById: 42 });
  });

  it("'Por classificar → Críticas' conta como à mão (passa a pessoa ao pipeline)", async () => {
    const out = await processInboundEmail({ ...inbound(), manualReview: { userId: 42 } });
    expect(out).toMatchObject({ routed: { targetModule: "review" } });
    expect(h.created[0]).toMatchObject({ emailImportedById: 42 });
    const inbox = src("server/mail/inbox.ts");
    expect(inbox).toContain("return reprocessThreadPipeline(threadId, mailbox, alias, { manualBy: viewer.id });");
    const svc = src("server/mail/service.ts");
    expect(svc).toContain('const manualReview = pipeline === "criticas" && opts.manualBy != null ? { userId: opts.manualBy } : null;');
    // o Message-ID já tinha passado (outra conta, ou crítica antiga fora das Críticas) → o mesmo "Importar para as Críticas"
    expect(svc).toContain('if (manualReview && (routed?.targetModule !== "review" || routed.existing)) {');
    expect(svc).toContain("await importMailMessageAsReview(Number(m.id), manualReview.userId)");
  });

  // BD simulada: a transação, o email guardado e as críticas desse Message-ID.
  function fakeDb(o: { existing?: any | null; rfc?: string; byId?: Record<number, any> }) {
    const executed: string[] = [];
    const params: unknown[][] = [];
    const inserted: any[] = [];
    const exec = async (q: SQL) => {
      const c = compile(q);
      const text = c.sql;
      executed.push(text);
      params.push(c.params);
      if (/FROM mail_messages WHERE id =/.test(text)) {
        return [[{ id: 31, threadId: 5, direction: "in", rfcMessageId: o.rfc ?? "<abc@google.com>", subject: SUBJECT, fromName: "Google Business Profile", fromEmail: GOOGLE, bodyText: BODY, bodyHtml: null, sentAt: "2026-10-15 09:00:00" }]];
      }
      if (/FROM google_reviews\s+WHERE sourceEmailId =/.test(text)) return [o.existing ? (Array.isArray(o.existing) ? o.existing : [o.existing]) : []];
      if (/FROM google_reviews WHERE id =/.test(text)) return [[o.byId?.[Number(c.params[0])]].filter(Boolean)];
      if (/^SELECT/.test(text.trim())) return [[]];
      return [{ affectedRows: 1 }];
    };
    const tx = {
      execute: exec,
      insert: () => ({ values: async (data: any) => { inserted.push(data); return [{ insertId: 900 }]; } }),
    };
    return { db: { execute: exec, transaction: async (fn: any) => fn(tx) }, executed, params, inserted };
  }

  it("'Importar para as Críticas': cria uma vez, tranca o email, liga o email e o registo de entrada; o registo e a IA só depois", async () => {
    const f = fakeDb({ existing: null });
    h.db = f.db;
    const r = await importMailMessageAsReview(31, 42);
    expect(r).toEqual({ status: "created", reviewId: 900, duplicateOf: null });
    expect(f.inserted).toHaveLength(1);
    expect(f.inserted[0]).toMatchObject({ sourceEmailId: "<abc@google.com>", emailImportedById: 42, rating: 5 });
    // trinco: todas as cópias deste email (outras contas) pela ordem do id, ANTES de procurar a crítica
    const lock = f.executed.findIndex((t) => /SELECT id FROM mail_messages WHERE rfcMessageId = \? ORDER BY id FOR UPDATE/.test(t));
    const look = f.executed.findIndex((t) => /FROM google_reviews\s+WHERE sourceEmailId =/.test(t));
    expect(lock).toBeGreaterThan(-1);
    expect(look).toBeGreaterThan(lock);
    expect(h.dupQueries).toHaveLength(1); // compara sempre com as que estão nas Críticas
    expect(f.executed.some((t) => /UPDATE mail_messages SET pipeline = 'criticas', pipelineStatus = 'processed'/.test(t))).toBe(true);
    // o Message-ID fica reservado: uma 2.ª cópia do mesmo email liga-se a esta crítica e nunca cria outra
    expect(f.executed.some((t) => /INSERT IGNORE INTO inbound_emails \(messageId, alias, fromName, fromEmail, subject, targetModule, targetId, status, receivedAt\)/.test(t))).toBe(true);
    expect(f.executed.some((t) => /UPDATE inbound_emails SET targetModule = 'review'/.test(t))).toBe(true);
    expect(f.executed.some((t) => /DELETE/i.test(t))).toBe(false);
    expect(h.created).toHaveLength(0); // dentro da transação, nunca pelo createGoogleReview
    expect(h.logs[0]).toMatchObject({ userId: 42, action: "review_email_import", entityId: 900 });
    expect(h.autoDraft).toHaveBeenCalledWith(900, "2026-10-15 09:00:00", { timeoutMs: 15_000 });
  });

  const OLD = { id: 55, sourceEmailId: "<abc@google.com>", googleReviewKey: null, emailImportedAt: null, notAReview: 0, duplicateOf: null,
    reviewerName: "Rui Costa", rating: 5, reviewText: `${SUBJECT}\n\nO serviço foi rápido`, reviewDate: null, sourceEmailDate: "2026-10-15 09:00:00", createdAt: "2026-10-15 09:01:00", projectId: 7 };

  it("a crítica antiga desse email (fora das Críticas) volta a contar — só essa linha, sem criar outra", async () => {
    const f = fakeDb({ existing: OLD });
    h.db = f.db;
    expect(await importMailMessageAsReview(31, 42)).toEqual({ status: "restored", reviewId: 55, duplicateOf: null });
    expect(f.inserted).toHaveLength(0);
    const upd = f.executed.filter((t) => /^UPDATE google_reviews/.test(t.trim()));
    expect(upd).toHaveLength(1);
    expect(upd[0]).toMatch(/SET emailImportedAt = \?, emailImportedById = \?\s+WHERE id = \? AND emailImportedAt IS NULL AND googleReviewKey IS NULL AND notAReview = 0 AND duplicateOf IS NULL/);
    expect(upd[0]).not.toContain("duplicateOf =");
    // comparou com as que estão nas Críticas (com os factos da guardada)
    expect(h.dupQueries[0]).toMatchObject({ rating: 5, parkKey: "p7", apiKey: false });
    expect(h.logs[0]).toMatchObject({ userId: 42, action: "review_email_import", entityId: 55 });
    expect(h.autoDraft).not.toHaveBeenCalled();
  });

  it("a antiga que a API já trouxe: volta como repetida da da API (não aparece duas vezes)", async () => {
    h.dupResult = 400;
    const f = fakeDb({ existing: OLD });
    h.db = f.db;
    expect(await importMailMessageAsReview(31, 42)).toEqual({ status: "restored", reviewId: 400, duplicateOf: 400 });
    const upd = f.executed.filter((t) => /^UPDATE google_reviews/.test(t.trim()));
    expect(upd).toHaveLength(1);
    expect(upd[0]).toMatch(/SET emailImportedAt = \?, emailImportedById = \?\s*, duplicateOf = \?, reviewMarkedAt = \?, reviewMarkedById = \?/);
    expect(h.logs[0]).toMatchObject({ entityId: 55 });
    expect(String(h.logs[0].details)).toContain("repetida de #400");
  });

  it("marcada como «não é crítica»: não mexe e diz onde se desfaz", async () => {
    const f = fakeDb({ existing: { ...OLD, notAReview: 1 } });
    h.db = f.db;
    await expect(importMailMessageAsReview(31, 42)).rejects.toThrow(NOT_A_REVIEW_IMPORT);
    expect(f.executed.some((t) => /^(UPDATE|INSERT)/.test(t.trim()))).toBe(false);
    expect(h.logs).toEqual([]);
  });

  it("a do email era repetida de uma que conta: já está nas Críticas (a original); a do email fica com a marca", async () => {
    const f = fakeDb({ existing: { ...OLD, duplicateOf: 12 }, byId: { 12: { ...OLD, id: 12, sourceEmailId: null, googleReviewKey: "k" } } });
    h.db = f.db;
    expect(await importMailMessageAsReview(31, 42)).toEqual({ status: "already", reviewId: 12 });
    const upd = f.executed.filter((t) => /^UPDATE google_reviews/.test(t.trim()));
    expect(upd).toHaveLength(1);
    expect(f.params[f.executed.indexOf(upd[0])]).toContain(55);
  });

  it("Message-ID comprido: a crítica guarda os 100 primeiros, o registo de entrada o inteiro", async () => {
    const rfc = `<${"x".repeat(150)}@google.com>`;
    const f = fakeDb({ existing: null, rfc });
    h.db = f.db;
    await importMailMessageAsReview(31, 42);
    expect(f.inserted[0].sourceEmailId).toBe(rfc.slice(0, 100));
    const ins = f.executed.findIndex((t) => /INSERT IGNORE INTO inbound_emails/.test(t));
    expect(f.params[ins][0]).toBe(rfc);
    const look = f.executed.findIndex((t) => /FROM google_reviews\s+WHERE sourceEmailId =/.test(t));
    expect(f.params[look][0]).toBe(rfc.slice(0, 100));
  });

  it("já nas Críticas → nada muda", async () => {
    const f = fakeDb({ existing: { id: 56, sourceEmailId: "<abc@google.com>", googleReviewKey: "k", emailImportedAt: null } });
    h.db = f.db;
    expect(await importMailMessageAsReview(31, 42)).toEqual({ status: "already", reviewId: 56 });
    expect(f.inserted).toHaveLength(0);
    expect(f.executed.some((t) => /^UPDATE/.test(t.trim()))).toBe(false);
    expect(h.logs).toEqual([]);
  });

  it("a conversa diz se cada email já está nas Críticas (a que conta ganha a uma cópia que ficou fora)", async () => {
    const long = `<${"y".repeat(150)}>`;
    h.db = { execute: async () => [[
      { id: 1, sourceEmailId: "<a>", googleReviewKey: null, emailImportedAt: null },
      { id: 2, sourceEmailId: "<a>", googleReviewKey: null, emailImportedAt: "2026-10-15 10:00:00" },
      { id: 3, sourceEmailId: "<b>", googleReviewKey: null, emailImportedAt: null },
      { id: 4, sourceEmailId: "<d>", googleReviewKey: null, emailImportedAt: "2026-10-15 10:00:00", duplicateOf: 40 },
      { id: 5, sourceEmailId: "<e>", googleReviewKey: "k", emailImportedAt: null, notAReview: 1 },
      { id: 6, sourceEmailId: long.slice(0, 100), googleReviewKey: null, emailImportedAt: "2026-10-15 10:00:00" },
    ]] };
    const m = await reviewsOfMessageIds(["<a>", "<b>", "<c>", "<d>", "<e>", long]);
    expect(m.get("<a>")).toEqual({ id: 2, inCriticas: true });
    expect(m.get("<b>")).toEqual({ id: 3, inCriticas: false });
    expect(m.has("<c>")).toBe(false);
    expect(m.get("<d>")).toEqual({ id: 40, inCriticas: true }); // repetida → a original
    expect(m.get("<e>")).toEqual({ id: 5, inCriticas: false }); // «não é crítica» não está na lista
    expect(m.get(long)).toEqual({ id: 6, inCriticas: true }); // a crítica guarda só os 100 primeiros
  });

  it("o botão só existe na caixa das Críticas, para quem age na caixa e edita as Críticas", () => {
    expect(isReviewMailbox({ key: "criticas", module: "criticas", pipeline: "criticas" })).toBe(true);
    expect(isReviewMailbox({ key: "outra", module: "comunicacao", pipeline: "criticas" })).toBe(true);
    expect(isReviewMailbox({ key: "info", module: "comunicacao", pipeline: null })).toBe(false);
    expect(isReviewMailbox(null)).toBe(false);
    const inbox = src("server/mail/inbox.ts");
    expect(inbox).toContain('const canImportReview = reviewBox && acc.canAct && can(viewer, "criticas", "edit");');
    expect(inbox).toContain("const acc = await requireAct(viewer, Number(m.threadId));");
    expect(inbox).toContain('if (!can(viewer, "criticas", "edit")) throw forbidden(');
    const view = src("client/src/components/mail/MailThreadView.tsx");
    expect(view).toContain("Importar para as Críticas");
    expect(view).toContain("trpc.mail.threads.importReview.useMutation");
  });
});

// ─── 4. As que vieram por email saem das Críticas (sem DELETE) ──────────────

describe("as críticas que entraram sozinhas por email não contam em lado nenhum", () => {
  it("regra pura: de email, sem chave da API e sem importação → fora; o resto conta", () => {
    expect(isEmailOnlyReview({ sourceEmailId: "<m@x>", googleReviewKey: null, emailImportedAt: null })).toBe(true);
    expect(isEmailOnlyReview({ sourceEmailId: "<m@x>", googleReviewKey: null, emailImportedAt: "" })).toBe(true);
    expect(isEmailOnlyReview({ sourceEmailId: "<m@x>", googleReviewKey: "abc", emailImportedAt: null })).toBe(false); // ligada à da API
    expect(isEmailOnlyReview({ sourceEmailId: "<m@x>", googleReviewKey: null, emailImportedAt: "2026-10-15 10:00:00" })).toBe(false); // importada
    expect(isEmailOnlyReview({ sourceEmailId: null, googleReviewKey: "abc" })).toBe(false); // API
    expect(isEmailOnlyReview({ sourceEmailId: null, googleReviewKey: null })).toBe(false); // à mão no formulário / MCP
  });

  it("a mesma regra em SQL (Drizzle e cru com alias)", () => {
    // vazio = NULL ou só espaços, como na regra pura (a lista e o "só consulta" nunca discordam)
    expect(compile(reviewInCriticas()).sql).toBe("(NULLIF(TRIM(`google_reviews`.`sourceEmailId`), '') IS NULL OR NULLIF(TRIM(`google_reviews`.`googleReviewKey`), '') IS NOT NULL OR `google_reviews`.`emailImportedAt` IS NOT NULL)");
    expect(compile(reviewInCriticasSql("r")).sql).toBe("(NULLIF(TRIM(r.`sourceEmailId`), '') IS NULL OR NULLIF(TRIM(r.`googleReviewKey`), '') IS NOT NULL OR r.`emailImportedAt` IS NOT NULL)");
    expect(compile(reviewInCriticasSql()).sql).toBe("(NULLIF(TRIM(`sourceEmailId`), '') IS NULL OR NULLIF(TRIM(`googleReviewKey`), '') IS NOT NULL OR `emailImportedAt` IS NOT NULL)");
    expect(isEmailOnlyReview({ sourceEmailId: "  ", googleReviewKey: null, emailImportedAt: null })).toBe(false);
    expect(isEmailOnlyReview({ sourceEmailId: "<m@x>", googleReviewKey: "  ", emailImportedAt: null })).toBe(true);
    expect(() => reviewInCriticasSql("r; DROP")).toThrow();
  });

  it("lista, números (Média Google, Suporte, pendentes) e ficha do cliente", () => {
    const db = src("server/db.ts");
    const list = db.slice(db.indexOf("export async function getGoogleReviews("), db.indexOf("async function withReviewLocationTitles"));
    expect(list).toContain("conditions.push(filters?.fromEmail ? sql`NOT ${reviewInCriticas()}` : reviewInCriticas());");
    const stats = db.slice(db.indexOf("export async function getGoogleReviewStats("), db.indexOf("// ─── FORMAÇÃO E APOIO"));
    expect(stats).toContain("isNull(googleReviews.duplicateOf), reviewInCriticas()];");
    expect(db).toContain("eq(googleReviews.notAReview, 0), isNull(googleReviews.duplicateOf), reviewInCriticas())).orderBy(desc(googleReviews.createdAt)).limit(30)");
  });

  it("Marketing → perfil Google (média, contagem) e o alerta das sem resposta", () => {
    const q = src("server/integrations/googleBusiness/insightsQueries.ts");
    expect(q).toContain('AND ${reviewInCriticasSql("r")} LIMIT 20000');
    expect(q).toContain("duplicateOf IS NULL AND ${reviewInCriticasSql()}");
  });

  it("fila dos rascunhos da IA e o rascunho de uma crítica", () => {
    const d = src("server/reviewAutoDraft.ts");
    const q = d.slice(d.indexOf("export async function draftPendingReviewReplies("));
    expect(q).toContain("reviewInCriticas(),");
    expect(d).toContain('if (isEmailOnlyReview(r)) return { ok: false, error: "email_only" };');
  });

  it("respostas automáticas às 5★: as de email nunca entram na fila", async () => {
    const seen: string[] = [];
    h.db = { execute: async (q: SQL) => { seen.push(compile(q).sql); return [[]]; } };
    await realAutoPublishDeps.candidates(5);
    expect(seen[0]).toContain("NULLIF(TRIM(r.`sourceEmailId`), '') IS NULL OR NULLIF(TRIM(r.`googleReviewKey`), '') IS NOT NULL OR r.`emailImportedAt` IS NOT NULL");
    expect(seen[0]).toContain("r.googleReviewName IS NOT NULL");
    // e a regra pura recusa uma de email (não está ligada ao Google)
    expect(autoPublishEntryRefusal({ rating: 5, googleReviewName: null, status: "pending_response", reviewDate: new Date().toISOString() }, Date.now())).toMatch(/veio por email/);
  });

  it("Desempenho: as respostas já dadas continuam a contar (foi trabalho feito; os meses passados não mudam)", () => {
    const s = userSources("2026-10-01 00:00:00", "2026-10-15 00:00:00").find((x) => x.key === "reviewsReplied")!;
    const q = compile(s.q).sql;
    expect(q).toContain("FROM google_reviews");
    expect(q).not.toContain("sourceEmailId");
    expect(q).not.toContain("emailImportedAt");
  });

  it("conciliação da API: as que ficaram só no email não prendem uma crítica nova 'por conciliar' — salvo a que já virou reclamação", () => {
    expect(compile(reviewLinkableToApi()).sql).toBe(`(${compile(reviewInCriticas()).sql} OR \`google_reviews\`.\`complaintId\` IS NOT NULL)`);
    const s = src("server/integrations/googleBusiness/service.ts");
    expect(s.split("reviewLinkableToApi()").length - 1).toBe(3); // por nome, por texto e na lista dos candidatos
    expect(s).not.toContain("reviewInCriticas()");
    // a lista dos candidatos diz quais vieram por email (fora das Críticas)
    expect(s).toContain("fromEmailOnly: isEmailOnlyReview({ sourceEmailId, googleReviewKey, emailImportedAt })");
    expect(src("client/src/components/GoogleBusinessConnection.tsx")).toContain("c.fromEmailOnly");
  });

  it("Limpeza e repetidas: não propõe as que já estão fora (as marcadas continuam para desfazer)", () => {
    const c = src("server/reviewCleanup.ts");
    expect(c).toContain("AND (${reviewInCriticasSql()} OR notAReview = 1 OR duplicateOf IS NOT NULL)");
    expect(c).toContain("duplicateOf IS NULL AND ${reviewInCriticasSql()}");
  });

  it("MCP/relatórios e o Multis leem a mesma lista e os mesmos números", () => {
    expect(src("server/mcpApi.ts")).toContain("const list = await getGoogleReviews({");
    const tools = src("server/assistant/mpvDataTools.ts");
    expect(tools).toContain('ctx.call("reviews.stats", filter)');
    expect(tools).toContain('slowCall(ctx, "reviews.list"');
  });

  it("nada se apaga: a migração só acrescenta (sem UPDATE em massa) e está registada no fim", () => {
    const m = src("server/migrations/migration_0835.ts");
    const stmts = m.slice(m.indexOf("MIGRATION_0835_STATEMENTS"));
    expect(stmts).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE)\b/);
    expect(stmts).toContain("ADD COLUMN `emailImportedAt` DATETIME NULL");
    expect(stmts).toContain("ADD COLUMN `emailImportedById` INT NULL");
    const idx = src("server/migrations/index.ts");
    expect(idx.indexOf('["0835"')).toBeGreaterThan(idx.indexOf('["0830"'));
    for (const f of ["server/reviewVisibility.ts", "server/reviewEmailImport.ts"]) expect(src(f)).not.toMatch(/\bDELETE\b/);
  });
});

// ─── 5. Super admin vê-as (só consulta); ninguém mexe nelas ─────────────────

describe("as que vieram por email: o super admin vê-as, só para consulta", () => {
  const emailOnly = { id: 9, projectId: 10, rating: 4, status: "pending_response", complaintId: null, respondedAt: null, googleReply: null, googleReviewName: null,
    aiResponse: "Obrigado!", aiResponseApproved: 0, reviewerName: "Ana", sourceEmailId: "<m@x>", googleReviewKey: null, emailImportedAt: null };

  it("'Mostrar as que vieram por email' só para o super admin", async () => {
    await expect(caller("admin").reviews.list({ fromEmail: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await caller("super_admin").reviews.list({ fromEmail: true });
    expect(h.listFilters.at(-1)).toMatchObject({ fromEmail: true });
    await caller("admin").reviews.list();
    expect(h.listFilters.at(-1)).toBeNull();
  });

  it("abertas pelo número, não se mexem: responder, aprovar, publicar, gerar, dispensar, parque e reclamação recusam", async () => {
    h.review = emailOnly;
    const c = caller("super_admin");
    for (const call of [
      () => c.reviews.update({ id: 9, aiResponse: "x" }),
      () => c.reviews.update({ id: 9, status: "dismissed" }),
      () => c.reviews.approveResponse({ id: 9 }),
      () => c.reviews.publishReply({ id: 9, comment: "x" }),
      () => c.reviews.generateResponse({ id: 9 }),
      () => c.reviews.setPark({ id: 9, projectId: 10 }),
      () => c.reviews.convertToComplaint({ id: 9 }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "BAD_REQUEST", message: EMAIL_ONLY_REVIEW_READONLY });
    }
    expect(h.updates).toEqual([]);
  });

  it("uma importada (ou da API) continua a poder ser tratada", async () => {
    h.review = { ...emailOnly, emailImportedAt: "2026-10-15 10:00:00" };
    await caller("super_admin").reviews.approveResponse({ id: 9 });
    expect(h.updates).toEqual([[9, { aiResponseApproved: 1 }]]);
  });

  it("a página: botão do super admin, aviso na crítica e ações escondidas", () => {
    const page = src("client/src/pages/GoogleReviewsPage.tsx");
    expect(page).toContain("Mostrar as que vieram por email");
    expect(page).toContain("const canEdit = canEditModule && !emailOnly;");
    expect(page).toContain("veio por email — fora das Críticas");
  });
});
