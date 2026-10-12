/**
 * Lote 57 — Reclamações (Jorge, 12 out 2026):
 *  1. a ficha mostra o histórico de emails do CLIENTE (todas as caixas
 *     partilhadas que a pessoa vê), não só os da própria reclamação;
 *  2. telemóvel (validado com capturas no harness; aqui só o que é código);
 *  3. filtros que filtram mesmo (contador = lista) e "se a IA vê que é uma
 *     reclamação, envia para lá" — mesmo vinda de info@/reservas@ — sem
 *     duplicar, sem responder ao cliente, com limiar e interruptor próprio.
 */
import { readFileSync } from "node:fs";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  db: null as any,
  claimed: new Set<string>(),
  created: [] as any[],
  messages: [] as any[],
  autoAck: vi.fn(async () => ({ sent: true })),
  notifyCreated: vi.fn(async () => {}),
  clientReply: vi.fn(async () => {}),
  bySignals: vi.fn(async (..._a: any[]) => null as any),
  bySubject: vi.fn(async (..._a: any[]) => null as any),
  byThread: vi.fn(async (..._a: any[]) => null as any),
  byBooking: vi.fn(async (..._a: any[]) => null as any),
  byId: vi.fn(async (id: number) => ({ id, projectId: 1, complaintStatus: "new", clientEmail: "cliente@gmail.com", reservationRef: null }) as any),
  sendMail: vi.fn(async () => ({ ok: true })),
  inboundByMessageId: vi.fn(async (_id: string) => null as any),
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
    logActivity: async () => {},
    claimInboundEmail: vi.fn(async (d: any) => (h.claimed.has(d.messageId) ? null : (h.claimed.add(d.messageId), h.claimed.size))),
    updateInboundEmail: vi.fn(async () => {}),
    deleteInboundEmail: vi.fn(async () => {}),
    createComplaint: vi.fn(async (d: any) => { h.created.push(d); return 900 + h.created.length; }),
    addComplaintMessage: vi.fn(async (m: any) => { h.messages.push(m); return 1; }),
    addComplaintPhoto: vi.fn(async () => 1),
    updateComplaint: vi.fn(async () => {}),
    getSystemUserId: vi.fn(async () => 1),
    getComplaintById: h.byId,
    findComplaintByClientSignals: h.bySignals,
    findOpenComplaintBySubject: h.bySubject,
    findComplaintByThread: h.byThread,
    findOpenComplaintByBookingRef: h.byBooking,
    getInboundEmailByMessageId: h.inboundByMessageId,
  };
});
vi.mock("./complaintDossier", async (orig) => ({
  ...(await orig<object>()),
  matchBookingForComplaint: vi.fn(async () => null),
  autoLinkComplaintBooking: vi.fn(async () => ({ linked: false })),
}));
vi.mock("./complaintsExtended", async (orig) => ({
  ...(await orig<object>()),
  notifyComplaintCreated: h.notifyCreated,
  sendComplaintAutoAck: h.autoAck,
}));
vi.mock("./complaintClientReply", async (orig) => ({ ...(await orig<object>()), notifyComplaintClientReply: h.clientReply }));
vi.mock("./mail/systemMail", async (orig) => ({ ...(await orig<object>()), sendEmailDetailed: h.sendMail, sendEmail: h.sendMail }));

import {
  COMPLAINT_ORIGINS, activeComplaintFilterCount, complaintAssigneeOptions, complaintDateRangeInvalid, complaintFiltersNeedAllTime,
  complaintOriginLabel, filterComplaintRows, type ComplaintFilterRow,
} from "../shared/complaintFilters";
import {
  COMPLAINT_INTAKE_DEFAULTS, COMPLAINT_INTAKE_FLAG, complaintIntakeDecision, complaintIntakeSettings, intakeNote, isPartnerSender,
  looksLikeNewsletter, looksLikeReviewNotice, type IntakeFacts,
} from "../shared/complaintIntake";
import { clientThreadAllowed, identityEmails, lastMessageDirection, visibleSharedBoxes, clientMailLimit, CLIENT_MAIL_MAX } from "../shared/complaintClientMail";
import { AUTOMATION_FLAGS, SETTINGS, automationFlagDefault, validateSetting } from "../shared/appSettings";
import { isCompanyAddress } from "../shared/mail";
import { clientMailHistory, clientThreadsUnion, dbClientMailDeps, type ClientMailDeps } from "./complaintClientMail";
import { createFromSuggestion, dbIntakeDeps, intakeFromRouting, type IntakeDeps, type IntakeMessage } from "./complaintMailIntake";
import { routeEmailMessage, type EmailRoutingDeps, type EmailRoutingMessage } from "./commsRouting";
import { availableTargets } from "../shared/commsBoxes";
import { MIGRATION_0630_STATEMENTS, IDEMPOTENT_ERROR_CODES_0630 } from "./migrations/migration_0630";
import { SCHEMA_MIGRATION_IDS } from "./migrations";
import { createFakeDb } from "./_core/ai/testUtils";
import { appRouter } from "./routers";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const render = (q: any) => new MySqlDialect().sqlToQuery(q);
const caller = (role: string) => appRouter.createCaller({ user: { id: 77, role, name: "Rita" }, req: { headers: {} }, res: {} } as any);

beforeEach(() => {
  h.db = null;
  h.claimed.clear();
  h.created = [];
  h.messages = [];
  for (const f of [h.autoAck, h.notifyCreated, h.clientReply, h.bySignals, h.bySubject, h.byThread, h.byBooking, h.sendMail]) f.mockClear();
  h.bySignals.mockImplementation(async () => null);
  h.byThread.mockImplementation(async () => null);
  h.byBooking.mockImplementation(async () => null);
});

// ─── 3a. Filtros: cada filtro filtra mesmo; o contador conta a mesma lista ───

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const ROWS: ComplaintFilterRow[] = [
  { id: 1, title: "Risco na porta", complaintType: "damage", complaintStatus: "new", slaDeadline: "2026-10-11 10:00:00", clientName: "João Gonçalves", clientEmail: "joao@gmail.com", clientPhone: "+351 912 345 678", reservationRef: "cmgAAA", vehiclePlate: "AA-12-BB", assignedToId: 11, assignedToName: "Maria", projectId: 1, origin: "email", createdAt: "2026-10-09 23:30:00" },
  { id: 2, title: "Atraso", complaintType: "delay", complaintStatus: "analyzing", slaDeadline: "2026-10-20 10:00:00", clientName: "Ana Sousa", clientEmail: "ana@sapo.pt", vehiclePlate: "12-CD-34", assignedToId: null, projectId: 2, origin: "ia", createdAt: "2026-10-01 10:00:00" },
  { id: 3, title: "Cobrança", complaintType: "overcharge", complaintStatus: "waiting_client", slaDeadline: "2026-10-01 10:00:00", clientName: "Li Wei", assignedToId: 12, assignedToName: "João", projectId: null, origin: "whatsapp", createdAt: "2026-09-20 10:00:00" },
  { id: 4, title: "Sujidade", complaintType: "dirt", complaintStatus: "resolved", clientName: "Rui", assignedToId: 11, assignedToName: "Maria", projectId: 1, origin: null, createdAt: "2026-08-01 10:00:00" },
  { id: 5, title: "Convertida", complaintType: "other", complaintStatus: "converted", clientName: "Eva", assignedToId: null, projectId: 3, origin: "conversao", createdAt: "2026-10-10 10:00:00" },
  { id: 6, title: "Fechada", complaintType: "staff", complaintStatus: "closed", clientName: "Bruno", assignedToId: 12, assignedToName: "João", projectId: 1, origin: "manual", createdAt: "2026-10-10 00:30:00" },
];
const ids = (f: Parameters<typeof filterComplaintRows>[1]) => filterComplaintRows(ROWS, f, NOW).map((r) => r.id);

describe("3a — filtros da página (uma regra só)", () => {
  it("sem filtros: tudo; contador = lista = soma das colunas do quadro", () => {
    const list = filterComplaintRows(ROWS, {}, NOW);
    expect(list).toHaveLength(6);
    const col = (s: string) => list.filter((c) => (c.complaintStatus === "converted" ? "closed" : c.complaintStatus) === s).length;
    expect(["new", "analyzing", "waiting_client", "resolved", "closed"].reduce((n, s) => n + col(s), 0)).toBe(list.length);
  });
  it("estado: cada um, em aberto, em atraso (SLA a correr) e Fechado com as convertidas", () => {
    expect(ids({ status: "new" })).toEqual([1]);
    expect(ids({ status: "analyzing" })).toEqual([2]);
    expect(ids({ status: "waiting_client" })).toEqual([3]);
    expect(ids({ status: "resolved" })).toEqual([4]);
    expect(ids({ status: "closed" })).toEqual([5, 6]);
    expect(ids({ status: "open" })).toEqual([1, 2, 3]);
    // o 3 tem prazo passado mas está em "Aguarda Cliente" (o SLA para) → não está em atraso
    expect(ids({ status: "overdue" })).toEqual([1]);
  });
  it("tipo", () => {
    expect(ids({ type: "delay" })).toEqual([2]);
    expect(ids({ type: "all" })).toHaveLength(6);
  });
  it("responsável: pessoa e sem responsável", () => {
    expect(ids({ assignee: 11 })).toEqual([1, 4]);
    expect(ids({ assignee: "none" })).toEqual([2, 5]);
    expect(ids({ assignee: 99 })).toEqual([]);
  });
  it("origem: cada uma e 'sem origem registada'", () => {
    expect(ids({ origin: "ia" })).toEqual([2]);
    expect(ids({ origin: "email" })).toEqual([1]);
    expect(ids({ origin: "unknown" })).toEqual([4]);
    expect(COMPLAINT_ORIGINS).toContain("ia");
    expect(complaintOriginLabel("ia")).toBe("IA (email noutra caixa)");
    expect(complaintOriginLabel(null)).toBe("Sem origem registada");
  });
  it("cidade: 'sem cidade' (a cidade em si vem do filtro global, no servidor)", () => {
    expect(ids({ noCity: true })).toEqual([3]);
  });
  it("datas pelo dia de LISBOA, inclusivas (23:30 UTC de 9 out = 10 out em Lisboa)", () => {
    expect(ids({ from: "2026-10-10", to: "2026-10-10" })).toEqual([1, 5, 6]);
    expect(ids({ from: "2026-10-01" })).toEqual([1, 2, 5, 6]);
    expect(ids({ to: "2026-09-30" })).toEqual([3, 4]);
    expect(ids({ from: "lixo" })).toHaveLength(6);
    expect(complaintFiltersNeedAllTime({ from: "2026-10-01" })).toBe(true);
    expect(complaintFiltersNeedAllTime({})).toBe(false);
    expect(complaintDateRangeInvalid({ from: "2026-10-10", to: "2026-10-01" })).toBe(true);
    expect(ids({ from: "2026-10-10", to: "2026-10-01" })).toEqual([]);
  });
  it("pesquisa pela regra única de texto: acentos, matrícula sem traços, telefone, email, #nº", () => {
    expect(ids({ q: "goncalves" })).toEqual([1]);
    expect(ids({ q: "aa12bb" })).toEqual([1]);
    expect(ids({ q: "912345678" })).toEqual([1]);
    expect(ids({ q: "ana@sapo.pt" })).toEqual([2]);
    expect(ids({ q: "#3" })).toContain(3);
    expect(ids({ q: "maria" })).toEqual([1, 4]); // responsável também conta
    expect(ids({ q: "ninguem-com-isto" })).toEqual([]);
  });
  it("filtros juntos e o contador de ativos", () => {
    expect(ids({ status: "open", assignee: "none", origin: "ia" })).toEqual([2]);
    expect(activeComplaintFilterCount({ q: " ", status: "all", type: "all", assignee: "all", origin: "all", noCity: false, from: "", to: "" })).toBe(0);
    expect(activeComplaintFilterCount({ q: "x", status: "new", type: "delay", assignee: 3, origin: "ia", noCity: true, from: "2026-10-01" })).toBe(7);
    expect(complaintAssigneeOptions(ROWS)).toEqual([{ id: 12, name: "João" }, { id: 11, name: "Maria" }]);
  });
  it("a página usa ESTA lista no quadro, no CSV e nos contadores; o servidor não devolve 'vazio' com a BD em baixo", () => {
    const page = src("client/src/pages/ComplaintsPage.tsx");
    expect(page).toContain("filterComplaintRows(allComplaints as any[], filters, Date.now())");
    expect(page).toContain("const allTime = allTimeChosen || complaintFiltersNeedAllTime(filters);");
    expect(page).not.toMatch(/input\.type = filterType/);
    const db = src("server/db.ts");
    const fn = db.slice(db.indexOf("export async function getComplaints("), db.indexOf("export async function getComplaintById("));
    expect(fn).toContain('throw new Error("Base de dados indisponível.")');
    expect(fn).not.toContain("return [];");
  });
});

// ─── 1. Histórico de emails do CLIENTE ───────────────────────────────────────

const BOXES = [
  { key: "info", label: "Info (geral)", module: "comunicacao", visibleRoles: [] as string[], active: true, cityRule: "all" as const },
  { key: "reclamacoes", label: "Reclamações", module: "reclamacoes", visibleRoles: [] as string[], active: true, cityRule: "linked" as const },
  { key: "cancelamentos", label: "Cancelamentos", module: "reservas_operacoes", visibleRoles: [] as string[], active: true, cityRule: "linked" as const },
  { key: "admin", label: "Administração", module: "comunicacao", visibleRoles: ["admin", "super_admin"], active: true, cityRule: "all" as const },
  { key: "campanhas", label: "Campanhas", module: "marketing", visibleRoles: [] as string[], active: true, cityRule: "all" as const },
  { key: "velha", label: "Antiga", module: "comunicacao", visibleRoles: [] as string[], active: false, cityRule: "all" as const },
];
const TL = { id: 5, role: "team_leader", accessOverrides: null };
const thread = (o: any) => ({ id: 1, mailboxKey: "info", projectId: 1, ownerUserId: null, archivedAt: null, automated: 0, subject: "S", snippet: "x", lastMessageAt: "2026-10-10 10:00:00", lastInboundAt: "2026-10-10 10:00:00", lastOutboundAt: null, messageCount: 1, unreadCount: 0, status: "aberto", contactEmail: "cliente@gmail.com", ...o });

function mailDeps(o: Partial<ClientMailDeps> = {}) {
  const calls = { threads: [] as any[], crm: [] as any[] };
  const deps: ClientMailDeps = {
    boxes: async () => BOXES as any,
    brandDomains: async () => ({ multipark: ["multipark.pt"] }),
    complaintEmails: async () => ["cliente@gmail.com", "reservas@multipark.pt"],
    booking: async () => ({ emails: ["Cliente.Reserva@Hotmail.com"], clientIds: [] }),
    crm: async (q) => { calls.crm.push(q); return { emails: ["cliente.outro@gmail.com", "info@empresa-do-cliente.pt"] }; },
    threads: async (q) => {
      calls.threads.push(q);
      return {
        total: 6,
        rows: [
          thread({ id: 1, mailboxKey: "reclamacoes", projectId: 1 }),
          thread({ id: 2, mailboxKey: "cancelamentos", projectId: 1, lastOutboundAt: "2026-10-11 10:00:00" }),
          thread({ id: 3, mailboxKey: null, ownerUserId: 5 }), // "O meu email" — nunca
          thread({ id: 4, mailboxKey: "campanhas" }), // caixa sem acesso — nunca
          thread({ id: 5, mailboxKey: "reclamacoes", projectId: 2 }), // outra cidade — nunca
          thread({ id: 6, mailboxKey: "info", projectId: null }),
        ],
      };
    },
    complaintLinks: async () => new Map([[1, [42]], [6, [7]]]),
    ...o,
  };
  return { deps, calls };
}
const COMPLAINT = { id: 42, clientEmail: "Cliente@Gmail.com", clientPhone: "+351912345678", reservationRef: "cmgAAA" };

describe("1 — histórico de emails do CLIENTE na reclamação", () => {
  it("caixas visíveis: só as partilhadas que a pessoa vê (cidade nas 'por cidade'); nunca inativas, de outros papéis ou sem módulo", () => {
    const acc = visibleSharedBoxes(TL, BOXES as any, [1]);
    expect(acc.map((b) => b.key)).toEqual(["info", "reclamacoes", "cancelamentos"]);
    expect(acc.find((b) => b.key === "info")?.cityIds).toBeNull();
    expect(acc.find((b) => b.key === "reclamacoes")?.cityIds).toEqual([1]);
    const sa = visibleSharedBoxes({ id: 1, role: "super_admin" }, BOXES as any, undefined);
    expect(sa.map((b) => b.key)).toContain("admin");
    expect(visibleSharedBoxes({ id: 6, role: "team_leader", accessOverrides: { comunicacao: { access: "none", actions: [] } } }, BOXES as any, [1])).toEqual([]);
  });
  it("conversa: pessoal, sem caixa, caixa sem acesso, outra cidade, arquivada ou só automática → nunca", () => {
    const acc = visibleSharedBoxes(TL, BOXES as any, [1]);
    expect(clientThreadAllowed(thread({ mailboxKey: null, ownerUserId: 5 }), acc)).toBe(false);
    expect(clientThreadAllowed(thread({ mailboxKey: "campanhas" }), acc)).toBe(false);
    expect(clientThreadAllowed(thread({ mailboxKey: "reclamacoes", projectId: 2 }), acc)).toBe(false);
    expect(clientThreadAllowed(thread({ archivedAt: "2020-01-01 00:00:00" }), acc)).toBe(false);
    expect(clientThreadAllowed(thread({ automated: 1 }), acc)).toBe(false);
    expect(clientThreadAllowed(thread({ mailboxKey: "reclamacoes", projectId: 1 }), acc)).toBe(true);
  });
  it("junta as caixas certas (por data, como vêm), marca a desta reclamação e esconde pessoais/sem acesso/outra cidade", async () => {
    const { deps, calls } = mailDeps();
    const r = await clientMailHistory(TL, COMPLAINT, { limit: 10, scopeIds: [1] }, deps);
    expect(r.noMailAccess).toBe(false);
    expect(r.threads.map((t) => t.id)).toEqual([1, 2, 6]);
    expect(r.threads.map((t) => t.mailboxLabel)).toEqual(["Reclamações", "Cancelamentos", "Info (geral)"]);
    expect(r.threads[0]).toMatchObject({ thisComplaint: true, otherComplaintIds: [], link: "/comunicacao?caixa=reclamacoes&t=1" });
    expect(r.threads[2]).toMatchObject({ thisComplaint: false, otherComplaintIds: [7] });
    expect(r.threads[1].lastDirection).toBe("out");
    // O SQL só recebe as caixas que a pessoa vê.
    expect(calls.threads[0].access.map((b: any) => b.key)).toEqual(["info", "reclamacoes", "cancelamentos"]);
  });
  it("quem é o cliente: emails da reclamação + reserva + ficha do CRM; só pessoais e de fora da empresa, sem repetir", async () => {
    const { deps, calls } = mailDeps();
    const r = await clientMailHistory(TL, COMPLAINT, { limit: 10, scopeIds: [1] }, deps);
    expect(r.emails.map((e) => e.email)).toEqual(["cliente@gmail.com", "cliente.reserva@hotmail.com", "cliente.outro@gmail.com"]);
    expect(r.emails[0].sources).toEqual(["reclamacao"]);
    expect(calls.crm[0]).toMatchObject({ emails: ["cliente@gmail.com", "cliente.reserva@hotmail.com"], phone: "+351912345678" });
    expect(calls.threads[0].emails).toEqual(["cliente@gmail.com", "cliente.reserva@hotmail.com", "cliente.outro@gmail.com"]);
    expect(identityEmails([{ email: "info@x.pt", source: "crm" }, { email: "a@multipark.pt", source: "crm" }], (e) => isCompanyAddress(e))).toEqual([]);
  });
  it("erro ≠ vazio: as conversas não se leem → erro; uma fonte da identidade falha → aviso (nunca 'sem emails')", async () => {
    const a = mailDeps({ threads: async () => { throw new Error("BD em baixo"); } });
    await expect(clientMailHistory(TL, COMPLAINT, { scopeIds: [1] }, a.deps)).rejects.toThrow("BD em baixo");
    const b = mailDeps({ booking: async () => { throw new Error("Multipark sem resposta"); }, crm: async () => { throw new Error("x"); } });
    const r = await clientMailHistory(TL, COMPLAINT, { scopeIds: [1] }, b.deps);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/Não foi possível ler a reserva ligada/);
    expect(r.threads.length).toBeGreaterThan(0);
    // Sem nenhuma caixa partilhada: "sem acesso", não "sem emails".
    const c = await clientMailHistory({ id: 6, role: "team_leader", accessOverrides: { comunicacao: { access: "none", actions: [] } } }, COMPLAINT, { scopeIds: [1] }, mailDeps().deps);
    expect(c).toMatchObject({ noMailAccess: true, threads: [] });
  });
  it("limites: página de 10, 'ver mais' até 100 (pede +1 para saber se há mais)", async () => {
    const { deps, calls } = mailDeps();
    const r = await clientMailHistory(TL, COMPLAINT, { limit: 2, scopeIds: [1] }, deps);
    expect(calls.threads[0].limit).toBe(3);
    expect(r.threads).toHaveLength(2);
    expect(r.hasMore).toBe(true);
    expect(clientMailLimit(999)).toBe(CLIENT_MAIL_MAX);
    expect(clientMailLimit(undefined)).toBe(10);
    expect(lastMessageDirection({ lastInboundAt: null, lastOutboundAt: null })).toBeNull();
  });
  it("SQL: união de dois ramos indexados — só caixas partilhadas (nunca pessoais), cidade por caixa, sem arquivadas nem automáticas", () => {
    const acc = visibleSharedBoxes(TL, BOXES as any, [1]);
    const q = render(clientThreadsUnion({ emails: ["cliente@gmail.com"], complaintId: 42, access: acc }));
    const s = q.sql.replace(/\s+/g, " ");
    expect(s).toContain(" UNION ");
    expect(s.match(/t\.mailboxKey IS NOT NULL AND t\.archivedAt IS NULL AND COALESCE\(t\.automated, 0\) = 0/g)).toHaveLength(2);
    expect(s).toContain("(t.mailboxKey = ? AND t.projectId IN (?))");
    expect(s).toContain("FROM mail_threads t WHERE t.contactEmail IN (?)");
    expect(s).toContain("l.entityType = 'complaint' AND l.entityId = ?");
    expect(s).not.toMatch(/ownerUserId =|ownerUserId IS NULL/);
    expect(s).not.toMatch(/contactEmail IN \(\?\) OR/);
    expect(q.params).toEqual(expect.arrayContaining(["info", "reclamacoes", 1, "cliente@gmail.com", "42"]));
    // sem emails do cliente: só as conversas ligadas à reclamação
    const only = render(clientThreadsUnion({ emails: [], complaintId: 42, access: acc })).sql;
    expect(only).not.toContain("UNION");
    expect(only).toContain("mail_links");
  });
  it("BD: a lista ordena pela data da última mensagem e conta sem repetir (pela mesma união)", async () => {
    h.db = createFakeDb((qq) => (qq.sql.startsWith("SELECT COUNT(*)") ? [[{ n: 7 }]] : [[thread({ id: 9 })]]));
    const r = await dbClientMailDeps.threads({ emails: ["cliente@gmail.com"], complaintId: 42, access: visibleSharedBoxes(TL, BOXES as any, [1]), limit: 11 });
    expect(r).toMatchObject({ total: 7, rows: [{ id: 9 }] });
    expect(h.db.queries[0].sql).toMatch(/ORDER BY sortAt DESC, id DESC LIMIT \?$/);
    expect(h.db.queries[0].sql).toMatch(/^SELECT t\.id, t\.mailboxKey/);
    expect(h.db.queries[1].sql).toMatch(/^SELECT COUNT\(\*\) AS n FROM \(SELECT t\.id FROM mail_threads t WHERE t\.contactEmail IN \(\?\)[^]* UNION SELECT t\.id FROM mail_links l/);
  });
  it("rotas: extra/condutor não chegam; a ficha usa o histórico do cliente no separador de emails", async () => {
    for (const role of ["extra", "condutor"]) {
      await expect(caller(role).complaints.clientMail({ complaintId: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller(role).complaints.mailSuggestions()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller(role).complaints.createFromMailSuggestion({ id: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller(role).complaints.dismissMailSuggestion({ id: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    const page = src("client/src/pages/ComplaintsPage.tsx");
    expect(page).toContain("<ComplaintClientMail complaintId={id} />");
    expect(page).toContain('<TabsTrigger value="comms">Emails do cliente</TabsTrigger>');
    const comp = src("client/src/components/ComplaintClientMail.tsx");
    expect(comp).toContain('what="os emails do cliente"');
    expect(comp).toContain("data.noMailAccess");
  });
});

// ─── 3b. A IA viu uma reclamação noutra caixa ────────────────────────────────

const FACTS: IntakeFacts = {
  fromBoxKey: "info", fromBoxPipeline: null, outbound: false, automated: false, systemMail: false, personal: false,
  senderIsCompany: false, senderIsAutomated: false, senderIsPartner: false,
  subject: "Carro riscado", text: "O meu carro veio com um risco.", senderEmail: "cliente@gmail.com",
};
const SETTINGS_57 = { ...COMPLAINT_INTAKE_DEFAULTS };

describe("3b — regras: criar, sugerir ou ignorar", () => {
  it("só quando a IA diz 'reclamacoes'", () => {
    expect(complaintIntakeDecision({ aiBoxKey: "reservas", confidence: 0.99 }, FACTS, SETTINGS_57)).toEqual({ action: "ignore" });
    expect(complaintIntakeDecision({ aiBoxKey: null, confidence: 0.99 }, FACTS, SETTINGS_57)).toEqual({ action: "ignore" });
  });
  it("certeza ≥ limiar → cria; entre os dois → só sugere; abaixo → ignora; sem certeza → sugere", () => {
    expect(complaintIntakeDecision({ aiBoxKey: "reclamacoes", confidence: 0.9 }, FACTS, SETTINGS_57)).toEqual({ action: "create" });
    expect(complaintIntakeDecision({ aiBoxKey: "reclamacoes", confidence: 0.85 }, FACTS, SETTINGS_57)).toEqual({ action: "create" });
    expect(complaintIntakeDecision({ aiBoxKey: "reclamacoes", confidence: 0.84 }, FACTS, SETTINGS_57)).toEqual({ action: "suggest" });
    expect(complaintIntakeDecision({ aiBoxKey: "reclamacoes", confidence: 0.5 }, FACTS, SETTINGS_57)).toEqual({ action: "suggest" });
    expect(complaintIntakeDecision({ aiBoxKey: "reclamacoes", confidence: 0.3 }, FACTS, SETTINGS_57)).toEqual({ action: "skip", why: "low_confidence" });
    expect(complaintIntakeDecision({ aiBoxKey: "reclamacoes", confidence: null }, FACTS, SETTINGS_57)).toEqual({ action: "suggest" });
  });
  it("newsletter, parceiro, interno, automático, avaliação, pessoal ou já da caixa das reclamações → nunca cria", () => {
    const v = { aiBoxKey: "reclamacoes", confidence: 0.99 };
    expect(complaintIntakeDecision(v, { ...FACTS, text: "Promoções da semana… Clique aqui para cancelar a subscrição." }, SETTINGS_57)).toEqual({ action: "skip", why: "newsletter" });
    expect(complaintIntakeDecision(v, { ...FACTS, senderIsPartner: true }, SETTINGS_57)).toEqual({ action: "skip", why: "partner" });
    expect(complaintIntakeDecision(v, { ...FACTS, senderIsCompany: true, senderEmail: "rui@multipark.pt" }, SETTINGS_57)).toEqual({ action: "skip", why: "internal" });
    expect(complaintIntakeDecision(v, { ...FACTS, automated: true }, SETTINGS_57)).toEqual({ action: "skip", why: "automatic" });
    expect(complaintIntakeDecision(v, { ...FACTS, senderIsAutomated: true }, SETTINGS_57)).toEqual({ action: "skip", why: "automatic" });
    expect(complaintIntakeDecision(v, { ...FACTS, subject: "Nova avaliação de 1 estrela no Google" }, SETTINGS_57)).toEqual({ action: "skip", why: "review" });
    expect(complaintIntakeDecision(v, { ...FACTS, personal: true }, SETTINGS_57)).toEqual({ action: "skip", why: "personal" });
    expect(complaintIntakeDecision(v, { ...FACTS, fromBoxPipeline: "reclamacoes" }, SETTINGS_57)).toEqual({ action: "skip", why: "complaints_box" });
    expect(looksLikeNewsletter("Newsletter de outubro", "")).toBe(true);
    expect(looksLikeNewsletter("Carro riscado", "Quero ser ressarcido.")).toBe(false);
    expect(looksLikeReviewNotice("Olá", "noreply-business@google.com")).toBe(true);
  });
  it("parceiro: email exato do contacto ou o mesmo domínio de empresa (nunca por gmail.com)", () => {
    const partners = ["reservas@agencia-viagens.pt", "ana@gmail.com"];
    expect(isPartnerSender("Reservas@Agencia-Viagens.pt", partners)).toBe(true);
    expect(isPartnerSender("joao@agencia-viagens.pt", partners)).toBe(true);
    expect(isPartnerSender("ana@gmail.com", partners)).toBe(true);
    expect(isPartnerSender("outra@gmail.com", partners)).toBe(false);
    expect(isPartnerSender(null, partners)).toBe(false);
  });
  it("definições: omissão 0,85/0,5 e validação (sugerir ≤ criar)", () => {
    expect(complaintIntakeSettings(null)).toEqual({ createMinConfidence: 0.85, suggestMinConfidence: 0.5 });
    expect(SETTINGS["ai.mailComplaints"].defaultValue).toEqual({ createMinConfidence: 0.85, suggestMinConfidence: 0.5 });
    expect(validateSetting("ai.mailComplaints", { createMinConfidence: 0.6, suggestMinConfidence: 0.9 }).ok).toBe(false);
    expect(validateSetting("ai.mailComplaints", { createMinConfidence: 0.3, suggestMinConfidence: 0.1 }).ok).toBe(false);
    expect(validateSetting("ai.mailComplaints", { createMinConfidence: 0.9, suggestMinConfidence: 0.6 }).ok).toBe(true);
  });
  it("interruptor próprio, LIGADO por omissão (pedido explícito do Jorge), na secção da IA", () => {
    const f = AUTOMATION_FLAGS.find((x) => x.name === COMPLAINT_INTAKE_FLAG);
    expect(f).toMatchObject({ group: "ia" });
    expect(automationFlagDefault(COMPLAINT_INTAKE_FLAG)).toBe(true);
    expect(f!.description).toMatch(/NUNCA se responde ao cliente/);
    // logo a seguir ao da separação pelas caixas (é a mesma leitura da IA)
    const names = AUTOMATION_FLAGS.map((x) => x.name);
    expect(names.indexOf(COMPLAINT_INTAKE_FLAG)).toBe(names.indexOf("AI_MAIL_ROUTING") + 1);
  });
  it("a nota na reclamação diz que veio da IA, de que caixa e porquê", () => {
    const n = intakeNote("created", { boxLabel: "Info (geral)", reason: "Cliente queixa-se de dano", confidence: 0.93 });
    expect(n).toContain("Criada pela IA");
    expect(n).toContain("«Info (geral)»");
    expect(n).toContain("Motivo da IA: Cliente queixa-se de dano");
    expect(n).toContain("certeza 93%");
    expect(n).toContain("Ninguém respondeu ao cliente");
    expect(intakeNote("created", { boxLabel: "X", reason: null, confidence: null, by: "Rita" })).toContain("Criada por Rita a partir da sugestão da IA");
  });
});

const MSG: IntakeMessage = { threadId: 10, messageId: 100, fromBoxKey: "info", subject: "Carro riscado", text: "Risco na porta", fromName: "Ana Sousa", fromEmail: "ana@gmail.com", projectId: 1 };

function intakeDeps(o: Partial<IntakeDeps> & { facts?: Partial<IntakeFacts> & { uncertain?: boolean } } = {}) {
  const claimed = new Set<number>();
  const calls = { enabled: 0, facts: 0, claim: [] as any[], record: [] as any[], create: [] as any[] };
  const { facts: factsPatch, ...rest } = o;
  const deps: IntakeDeps = {
    enabled: async () => { calls.enabled++; return true; },
    settings: async () => ({ ...COMPLAINT_INTAKE_DEFAULTS }),
    facts: async () => { calls.facts++; return { ...FACTS, boxLabel: "Info (geral)", ...factsPatch }; },
    claim: async (row) => { calls.claim.push(row); if (claimed.has(row.msg.threadId)) return false; claimed.add(row.msg.threadId); return true; },
    record: async (t, p) => { calls.record.push([t, p]); },
    createOrLink: async (i) => { calls.create.push(i); return { complaintId: 555, isNew: true }; },
    ...rest,
  };
  return { deps, calls };
}

describe("3b — a IA viu uma reclamação noutra caixa", () => {
  it("reclamação em info@ com certeza alta → cria a reclamação (pela IA, sem pessoa) e regista de onde veio", async () => {
    const { deps, calls } = intakeDeps();
    const r = await intakeFromRouting(MSG, { aiBoxKey: "reclamacoes", confidence: 0.93, reason: "Queixa de dano" }, deps);
    expect(r).toEqual({ status: "created", complaintId: 555 });
    expect(calls.claim[0]).toMatchObject({ status: "creating", skipReason: null, verdict: { confidence: 0.93, reason: "Queixa de dano" } });
    expect(calls.create[0]).toMatchObject({ threadId: 10, messageId: 100, boxLabel: "Info (geral)", actor: null, projectId: 1 });
    expect(calls.record[0]).toEqual([10, { status: "created", complaintId: 555, error: null, decidedById: null }]);
  });
  it("a mesma conversa nunca dá duas reclamações (o cron a correr outra vez não repete)", async () => {
    const { deps, calls } = intakeDeps();
    const v = { aiBoxKey: "reclamacoes", confidence: 0.93, reason: "x" };
    await intakeFromRouting(MSG, v, deps);
    expect(await intakeFromRouting({ ...MSG, messageId: 101 }, v, deps)).toEqual({ status: "seen" });
    expect(calls.create).toHaveLength(1);
  });
  it("já havia uma reclamação aberta do cliente → junta (linked), não cria outra", async () => {
    const { deps, calls } = intakeDeps({ createOrLink: async () => ({ complaintId: 12, isNew: false }) });
    expect(await intakeFromRouting(MSG, { aiBoxKey: "reclamacoes", confidence: 0.9, reason: null }, deps)).toEqual({ status: "linked", complaintId: 12 });
    expect(calls.record[0][1]).toMatchObject({ status: "linked", complaintId: 12 });
  });
  it("abaixo do limiar só sugere (nada é criado)", async () => {
    const { deps, calls } = intakeDeps();
    expect(await intakeFromRouting(MSG, { aiBoxKey: "reclamacoes", confidence: 0.7, reason: "Talvez" }, deps)).toEqual({ status: "suggested" });
    expect(calls.claim[0].status).toBe("suggested");
    expect(calls.create).toEqual([]);
    // não se confirmou se é parceiro (lista em baixo) → também só sugere
    const b = intakeDeps({ facts: { uncertain: true } });
    expect(await intakeFromRouting(MSG, { aiBoxKey: "reclamacoes", confidence: 0.99, reason: null }, b.deps)).toEqual({ status: "suggested" });
    expect(b.calls.create).toEqual([]);
  });
  it("newsletter, parceiro e interno não criam (fica registado porquê)", async () => {
    for (const [patch, why] of [[{ text: "Newsletter… unsubscribe" }, "newsletter"], [{ senderIsPartner: true }, "partner"], [{ senderIsCompany: true }, "internal"]] as const) {
      const { deps, calls } = intakeDeps({ facts: patch as any });
      expect(await intakeFromRouting(MSG, { aiBoxKey: "reclamacoes", confidence: 0.99, reason: null }, deps)).toEqual({ status: "skipped", why });
      expect(calls.claim[0]).toMatchObject({ status: "skipped", skipReason: why });
      expect(calls.create).toEqual([]);
    }
  });
  it("o interruptor desligado não faz nada (nem lê a BD, nem cria, nem sugere)", async () => {
    const { deps, calls } = intakeDeps({ enabled: async () => false });
    expect(await intakeFromRouting(MSG, { aiBoxKey: "reclamacoes", confidence: 0.99, reason: null }, deps)).toEqual({ status: "off" });
    expect(calls).toMatchObject({ facts: 0, claim: [], record: [], create: [] });
  });
  it("a IA não disse reclamação → nem pergunta pelo interruptor", async () => {
    const { deps, calls } = intakeDeps();
    expect(await intakeFromRouting(MSG, { aiBoxKey: "reservas", confidence: 0.99, reason: null }, deps)).toEqual({ status: "ignored" });
    expect(calls.enabled).toBe(0);
  });
  it("falha ao criar → 'failed' registado (volta a ser tentado), sem partir a separação pelas caixas", async () => {
    const { deps, calls } = intakeDeps({ createOrLink: async () => { throw new Error("O Gmail não respondeu"); } });
    expect(await intakeFromRouting(MSG, { aiBoxKey: "reclamacoes", confidence: 0.95, reason: null }, deps)).toEqual({ status: "failed", error: "O Gmail não respondeu" });
    expect(calls.record[0][1]).toMatchObject({ status: "failed", error: "O Gmail não respondeu" });
    const b = intakeDeps({ facts: undefined, enabled: async () => { throw new Error("BD"); } });
    expect(await intakeFromRouting(MSG, { aiBoxKey: "reclamacoes", confidence: 0.95, reason: null }, b.deps)).toMatchObject({ status: "failed" });
  });
  it("BD: reserva por INSERT IGNORE (threadId único) — 0 linhas = já decidida", async () => {
    h.db = createFakeDb((q) => (q.sql.startsWith("insert ignore") || q.sql.startsWith("INSERT IGNORE") ? [{ affectedRows: 0 }] : [[]]));
    const deps = dbIntakeDeps();
    expect(await deps.claim({ msg: MSG, verdict: { aiBoxKey: "reclamacoes", confidence: 0.9, reason: "r" }, status: "creating", skipReason: null })).toBe(false);
    expect(h.db.queries[0].sql).toMatch(/^INSERT IGNORE INTO complaint_mail_intake \(threadId,/);
    const mig = MIGRATION_0630_STATEMENTS.join("\n");
    expect(mig).toContain("UNIQUE KEY `uq_complaint_mail_intake_thread` (`threadId`)");
  });
  it("'Criar reclamação' numa sugestão: uma só vez (dois cliques não dão duas)", async () => {
    let status = "suggested";
    let complaintId: number | null = null;
    h.db = createFakeDb((q) => {
      if (q.sql.startsWith("SELECT i.id")) return [[{ id: 1, threadId: 10, messageId: 100, fromBoxKey: "info", aiBoxKey: "reclamacoes", confidence: "0.700", reason: "r", status, complaintId, projectId: 1, decidedById: null }]];
      if (q.sql.startsWith("UPDATE complaint_mail_intake SET status = 'creating'")) {
        if (status === "suggested") { status = "creating"; return [{ affectedRows: 1 }]; }
        return [{ affectedRows: 0 }];
      }
      if (q.sql.startsWith("SELECT * FROM mail_mailboxes")) return [[]];
      return [[]];
    });
    const create = vi.fn(async () => ({ complaintId: 777, isNew: true }));
    const record = vi.fn(async (_t: number, p: any) => { status = p.status; complaintId = p.complaintId ?? complaintId; });
    const first = await createFromSuggestion(1, { id: 77, name: "Rita" }, { createOrLink: create, record });
    expect(first).toEqual({ complaintId: 777, isNew: true, already: false });
    expect((create.mock.calls[0] as any)[0]).toMatchObject({ actor: { id: 77, name: "Rita" } });
    const second = await createFromSuggestion(1, { id: 78, name: "Rui" }, { createOrLink: create, record });
    expect(second).toEqual({ complaintId: 777, isNew: false, already: true });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

// ─── 3b. Ligado ao encaminhador (#351) ───────────────────────────────────────

const RBOXES = [
  { key: "info", label: "Info (geral)", active: true },
  { key: "reservas", label: "Reservas", active: true },
  { key: "reclamacoes", label: "Reclamações", active: true },
];
function routingDeps(output: any, intake = vi.fn(async (..._a: any[]) => ({ status: "created", complaintId: 1 }) as any)) {
  const deps: EmailRoutingDeps = {
    enabled: async () => true,
    settings: async () => ({ minConfidence: 0.7, perRun: 10 }),
    boxes: async () => RBOXES,
    claim: async () => true,
    classify: async () => ({ output, restore: (s: string) => s }),
    move: async () => true,
    record: async () => {},
    firstContact: async () => ({ outcome: "created", leadId: 1, applicationId: null }) as any,
    cityProjectId: async () => null,
    afterRh: async () => {},
    complaintIntake: intake,
  };
  return { deps, intake };
}
const RMSG: EmailRoutingMessage = { threadId: 10, messageId: 100, fromBoxKey: "info", subject: "Carro riscado", text: "…", fromName: "Ana", fromEmail: "ana@gmail.com", attachmentNames: [], projectId: null };

describe("3b — porque não chegavam: mover para a caixa Reclamações não criava o caso", () => {
  it("a IA diz reclamação → depois de mover, a reclamação nasce (com a certeza e o motivo da IA)", async () => {
    const { deps, intake } = routingDeps({ box: "reclamacoes", confidence: 0.92, reason: "Dano no carro" });
    const r = await routeEmailMessage(RMSG, deps);
    expect(r).toMatchObject({ status: "moved", boxKey: "reclamacoes", complaint: { status: "created" } });
    expect(intake).toHaveBeenCalledWith(RMSG, { aiBoxKey: "reclamacoes", confidence: 0.92, reason: "Dano no carro" });
  });
  it("com pouca certeza fica no info, mas a sugestão ainda chega às Reclamações", async () => {
    const { deps, intake } = routingDeps({ box: "reclamacoes", confidence: 0.6, reason: "?" });
    // entrou pelo info e fica no info (a dúvida não muda de caixa)
    expect(await routeEmailMessage(RMSG, deps)).toMatchObject({ status: "kept", boxKey: "info" });
    expect(intake).toHaveBeenCalledWith(RMSG, { aiBoxKey: "reclamacoes", confidence: 0.6, reason: "?" });
  });
  it("outra caixa ou falha da IA → nada nas Reclamações", async () => {
    const a = routingDeps({ box: "reservas", confidence: 0.95, reason: "preço" });
    await routeEmailMessage(RMSG, a.deps);
    expect(a.intake).not.toHaveBeenCalled();
    const b = routingDeps(null);
    b.deps.classify = async () => { throw Object.assign(new Error("timeout"), { code: "timeout" }); };
    await routeEmailMessage(RMSG, b.deps);
    expect(b.intake).not.toHaveBeenCalled();
  });
  it("o pipeline das reclamações corre também nas respostas do cliente numa conversa que a IA ligou (nunca cria outra)", () => {
    const svc = src("server/mail/service.ts");
    expect(svc).toContain("intakeComplaintOfThread(e.result.threadId)");
    expect(svc).toContain('aiIntake = { forceComplaintId: complaintId, replyOnly: true }');
    expect(svc).toContain("intakeFromRouting(msg, verdict, dbIntakeDeps({ parsed: p, api }))");
    expect(src("server/commsAiSweep.ts")).toContain("retryFailedIntakes");
    // a nova tentativa de uma resposta que falhou nunca corre o pipeline "normal" numa conversa da IA
    const retry = svc.slice(svc.indexOf("export async function retryPipelineMessage"), svc.indexOf("export async function retryFailedPipelines"));
    expect(retry).toContain("intakeOfThread(threadId)");
    expect(retry).toContain("aiIntake = { forceComplaintId: seen.complaintId, replyOnly: true }");
  });
});

// ─── Nunca escreve ao cliente (o pipeline das reclamações com aiIntake) ─────

describe("3b — nunca envia nada ao cliente; agrupa sem duplicar", () => {
  const base = (o: any = {}) => ({
    alias: "reclamacoes" as const, messageId: `<m-${Math.random()}@x>`, gmThreadId: "123", refs: [], fromName: "Ana Sousa", fromEmail: "ana.sousa@gmail.com",
    subject: "Reclamação", receivedAt: "2026-10-12 10:00:00", text: "O carro veio riscado na porta.", html: null, loadAttachments: async () => [], ...o,
  });
  it("com aiIntake: cria com origem 'ia', avisa a equipa no sino, mas NUNCA o aviso de receção ao cliente", async () => {
    const { processInboundEmail } = await import("./jobs/emailInboundSync");
    const out = await processInboundEmail(base({ aiIntake: { actorId: null, projectId: 3 } }));
    expect(out).toMatchObject({ status: "processed", routed: { targetModule: "complaint", isNew: true } });
    expect(h.created[0]).toMatchObject({ origin: "ia", createdById: null, projectId: 3, clientEmail: "ana.sousa@gmail.com" });
    expect(h.notifyCreated).toHaveBeenCalledTimes(1);
    expect(h.autoAck).not.toHaveBeenCalled();
    expect(h.sendMail).not.toHaveBeenCalled();
  });
  it("sem aiIntake (email que chegou mesmo à reclamacoes@) o aviso de receção continua como estava", async () => {
    const { processInboundEmail } = await import("./jobs/emailInboundSync");
    await processInboundEmail(base());
    expect(h.created[0]).toMatchObject({ origin: "email" });
    expect(h.autoAck).toHaveBeenCalledTimes(1);
  });
  it("aiIntake só junta pela conversa, email/matrícula ou mesma reserva — nunca pelo nome nem pelo assunto", async () => {
    const { processInboundEmail } = await import("./jobs/emailInboundSync");
    await processInboundEmail(base({ aiIntake: { actorId: null }, text: "Reserva: 20451. O carro veio riscado." }));
    expect(h.bySubject).not.toHaveBeenCalled();
    expect(h.bySignals).toHaveBeenCalledWith("ana.sousa@gmail.com", undefined, null);
    h.byBooking.mockImplementationOnce(async () => ({ id: 12, complaintStatus: "analyzing", reservationRef: "20451" }));
    h.created = [];
    const out = await processInboundEmail(base({ aiIntake: { actorId: null }, text: "Reserva: 20451. Outra vez." }));
    expect(out).toMatchObject({ routed: { targetModule: "complaint", targetId: 12, isNew: false } });
    expect(h.created).toEqual([]);
    expect(h.autoAck).not.toHaveBeenCalled();
  });
  it("o mesmo email outra vez → 'duplicado' (o Message-ID reservado impede um 2.º caso)", async () => {
    const { processInboundEmail } = await import("./jobs/emailInboundSync");
    const b = base({ aiIntake: { actorId: null } });
    await processInboundEmail(b);
    expect(await processInboundEmail(b)).toEqual({ status: "duplicate" });
    expect(h.created).toHaveLength(1);
  });
  it("resposta numa conversa ligada: só a ESSA reclamação; sem ela, não cria nada", async () => {
    const { processInboundEmail } = await import("./jobs/emailInboundSync");
    h.byId.mockImplementationOnce(async () => null);
    const out = await processInboundEmail(base({ aiIntake: { forceComplaintId: 31, replyOnly: true } }));
    expect(out).toMatchObject({ routed: { targetModule: "ignored" } });
    expect(h.created).toEqual([]);
    h.byId.mockImplementation(async (id: number) => ({ id, projectId: 1, complaintStatus: "waiting_client", clientEmail: "ana.sousa@gmail.com", reservationRef: "x" }) as any);
    const out2 = await processInboundEmail(base({ aiIntake: { forceComplaintId: 31, replyOnly: true } }));
    expect(out2).toMatchObject({ routed: { targetModule: "complaint", targetId: 31, isNew: false } });
    expect(h.autoAck).not.toHaveBeenCalled();
  });
});

describe("3b — de ponta a ponta: email de info@ → reclamação (sem tocar no cliente)", () => {
  const parsed = {
    gmailMessageId: "18c0ffee", gmailThreadId: "18c0ffee", labelIds: [], historyId: null, sentAt: "2026-10-12 10:00:00",
    rfcMessageId: "<cliente-1@gmail.com>", inReplyTo: null, references: [], subject: "O meu carro veio riscado", snippet: "",
    fromName: "Ana Sousa", fromEmail: "ana.sousa@gmail.com", to: ["info@multipark.pt"], cc: [], bcc: [], deliveredTo: [], xOriginalTo: [],
    replyTo: null, autoSubmitted: null, precedence: null, systemMail: false, autoKind: null,
    text: "Bom dia, levantei o carro e tinha um risco na porta.", html: "", attachments: [], outbound: false, unread: true,
  } as any;
  it("cria pelo pipeline das reclamações com aiIntake, liga a conversa, deixa a nota — e nunca envia nada", async () => {
    h.db = createFakeDb((q) => {
      if (q.sql.startsWith("SELECT m.id, m.threadId, m.accountKey")) return [[{ id: 100, threadId: 10, accountKey: "dwd:reservas@multipark.pt", gmailMessageId: "18c0ffee" }]];
      return [{ affectedRows: 1 }];
    });
    const { createOrLinkFromThread } = await import("./complaintMailIntake");
    const out = await createOrLinkFromThread(
      { threadId: 10, messageId: 100, boxLabel: "Info (geral)", verdict: { aiBoxKey: "reclamacoes", confidence: 0.93, reason: "Dano no carro" }, actor: null, projectId: 2 },
      { parsed, api: { getAttachment: async () => Buffer.from(""), getMessage: async () => null } },
    );
    expect(out).toMatchObject({ isNew: true });
    expect(h.created[0]).toMatchObject({ origin: "ia", createdById: null, projectId: 2, clientEmail: "ana.sousa@gmail.com", title: "O meu carro veio riscado" });
    const all = h.db.queries.map((q: any) => q.sql).join("\n");
    expect(all).toMatch(/INSERT INTO mail_links \(threadId, messageId, entityType, entityId, confidence, source, reason\)/);
    expect(all).toContain("UPDATE mail_messages SET pipeline = ?");
    expect(all).not.toMatch(/DELETE FROM|mailboxKey = \?/); // não apaga nem tira o email da caixa
    expect(h.messages.some((m) => m.isInternal === 1 && String(m.message).includes("Criada pela IA") && String(m.message).includes("«Info (geral)»"))).toBe(true);
    expect(h.autoAck).not.toHaveBeenCalled();
    expect(h.sendMail).not.toHaveBeenCalled();
    // a 2.ª vez (cron outra vez) o Message-ID já está reservado: liga à mesma, sem nova reclamação nem nova nota
    const before = h.messages.length;
    h.db = createFakeDb((q) => (q.sql.startsWith("SELECT m.id, m.threadId, m.accountKey") ? [[{ id: 100, threadId: 10, accountKey: "dwd:x", gmailMessageId: "18c0ffee" }]] : [{ affectedRows: 1 }]));
    h.inboundByMessageId.mockImplementationOnce(async () => ({ targetModule: "complaint", targetId: 901 }));
    await expect(createOrLinkFromThread(
      { threadId: 10, messageId: 100, boxLabel: "Info (geral)", verdict: { aiBoxKey: "reclamacoes", confidence: 0.93, reason: null }, actor: null, projectId: 2 },
      { parsed, api: { getAttachment: async () => Buffer.from(""), getMessage: async () => null } },
    )).resolves.toEqual({ complaintId: 901, isNew: false, already: true });
    expect(h.created).toHaveLength(1);
    expect(h.messages.length).toBe(before);
    expect(h.autoAck).not.toHaveBeenCalled();
  });
});

// ─── Migração e origem ───────────────────────────────────────────────────────

describe("0630 — origem das reclamações e registo da IA (só acrescenta)", () => {
  it("registada no fim, idempotente, sem apagar nada", () => {
    expect(SCHEMA_MIGRATION_IDS[SCHEMA_MIGRATION_IDS.length - 1]).toBe("0630");
    const all = MIGRATION_0630_STATEMENTS.join("\n");
    expect(all).not.toMatch(/\bDELETE\b|\bDROP\b|TRUNCATE/i);
    for (const u of MIGRATION_0630_STATEMENTS.filter((x) => x.startsWith("UPDATE"))) expect(u).toContain("`origin` IS NULL");
    expect(IDEMPOTENT_ERROR_CODES_0630.has("ER_DUP_FIELDNAME")).toBe(true);
    expect(IDEMPOTENT_ERROR_CODES_0630.has("ER_TABLE_EXISTS_ERROR")).toBe(true);
  });
  it("cada caminho que cria uma reclamação grava a origem", () => {
    expect(src("server/routers.ts")).toContain('origin: "manual",');
    expect(src("server/whatsappCaseProposal.ts")).toContain('origin: "whatsapp",');
    expect(src("server/mcpApi.ts")).toContain('origin: "api",');
    expect(src("server/reviewOps.ts")).toContain('origin: "critica",');
    expect(src("server/integrations/googleBusiness/service.ts")).toContain("origin: 'critica'");
    expect(src("server/caseOps.ts").match(/origin: "conversao"/g)).toHaveLength(2);
    expect(src("server/jobs/emailInboundSync.ts")).toContain('origin: ai ? "ia" : "email"');
  });
});
