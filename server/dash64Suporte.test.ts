/**
 * Plano 64, PR E — Suporte, reclamações, resumos e badges: cada número lê a
 * MESMA função da página de referência, segue a cidade do topo e uma leitura
 * falhada mostra "—" (nunca 0).
 *  E1 Reclamações abertas (complaintCounts) · E2 Críticas (reviews.stats) ·
 *  E3 Perdidos abertos (lostFound.dashboard) · E4/E5/E6 Suporte (rótulos, "—",
 *  sem Período) · E7 Resumo do dia (countableComplaintSql) · E8 Briefing
 *  (complaintSlaLateSql, sem `incidents`) · E8b aviso da previsão ·
 *  E10 badge das caixas de email (só as ativas) · E11 badge do WhatsApp
 *  (só as caixas que a pessoa vê).
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const h = vi.hoisted(() => ({
  complaintStatsArgs: [] as unknown[],
  reviewStatsArgs: [] as unknown[],
  executed: [] as unknown[],
  forecast: null as any,
  mailboxes: [] as any[],
  waWhere: null as unknown,
  liveHistoryReads: 0,
}));

const national = vi.hoisted(() => ({ all: true, defaultCityId: null, cityName: null, cityIds: [1], projectIds: [1, 10, 20], missingCostCenter: false }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => national,
  loadCityAccessParts: async () => ({ access: national, base: national, all: national }),
}));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getUserPermissionOverrides: async () => ({}),
  getUserModuleOverrides: async () => ({}),
  getProjects: async () => [
    { id: 1, level: "group", name: "Multipark", parentId: null, isActive: 1 },
    { id: 10, level: "city", name: "Lisboa", parentId: 1, isActive: 1 },
    { id: 20, level: "city", name: "Porto", parentId: 1, isActive: 1 },
  ],
  resolveProjectIds: async (id: number) => [id],
  getComplaintStats: async (projectId?: number) => { h.complaintStatsArgs.push(projectId); return { total: 0, open: 0 }; },
  getGoogleReviewStats: async (f?: unknown) => { h.reviewStatsArgs.push(f); return { total: 0, avg: 0 }; },
  getDb: async () => ({
    execute: async (q: unknown) => {
      h.executed.push(q);
      const text = new MySqlDialect().sqlToQuery(q as any).sql;
      if (/FROM complaints/.test(text)) return [[{ id: 9, title: "Risco na porta", dueAt: "2026-10-15 05:00:00" }], []];
      return [[], []];
    },
    select: () => ({
      // `.from(t)` sozinho (ex.: os projetos do painel dos Perdidos) dá uma lista vazia;
      // `.from(t).leftJoin().where()` é o badge do WhatsApp.
      from: () => Object.assign(Promise.resolve([]), {
        leftJoin: () => ({
          where: (w: unknown) => { h.waWhere = w; return Promise.resolve([{ attention: 2, overdue: 1 }]); },
        }),
      }),
    }),
  }),
}));
vi.mock("./extrasDia", async (original) => ({
  ...(await original<object>()),
  getExtrasDiaForecast: async () => h.forecast,
}));
vi.mock("./aiOps/handoverRepeats", async (original) => ({
  ...(await original<object>()),
  repeatedItemsFor: async () => ({ latest: null, pending: [], repeated: [] }),
}));
vi.mock("./marketingAlertsService", () => ({ computeAlertsFor: async () => ({ alerts: [] }) }));
vi.mock("./mail/store", async (original) => ({
  ...(await original<object>()),
  listMailboxes: async () => h.mailboxes,
  getMailbox: async (key: string | null | undefined) => h.mailboxes.find((m) => m.key === key) ?? null,
  db: async () => ({ execute: async () => [[{ unread: 3, awaiting: 1, open: 2, n: 0 }], []] }),
}));
// O cruzamento dos condutores do painel dos Perdidos lê o histórico da Multipark ao vivo.
vi.mock("./multiparkDb/historyLive", async (original) => ({
  ...(await original<object>()),
  readLiveHistoryByAgent: async () => { h.liveHistoryReads++; return []; },
  readLiveHistory: async () => { h.liveHistoryReads++; return []; },
}));

import { appRouter } from "./routers";
import { COMPLAINT_OPEN_STATUSES, COMPLAINT_SLA_RUNNING, LOST_STATUSES, complaintCounts, complaintOverdue, isLostClosed } from "../shared/caseRules";
import { complaintSlaLateSql, countableComplaintSql } from "./departedComplaints";
import { buildBriefingData, collectBriefing, filterBriefingFor, renderBriefingEmail, viewerPerms, type BriefingData } from "./aiOps/briefing";
import { forecastIncompleteReason } from "./extrasSchedule";
import { badgeTotal, mailboxSections } from "../shared/mail";
import { mailBadge, sendMail, visibleMailboxes } from "./mail/inbox";
import { inboxBadge, inboxBadgeConds } from "./whatsappInboxOps";
import { boxVisibleSql, visibilitySql } from "./whatsappInbox";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const render = (q: unknown) => new MySqlDialect().sqlToQuery(q as any);
const caller = (role: string) => appRouter.createCaller({ user: { id: 77, role, name: "Rita" }, req: { headers: {} }, res: {} } as any);
const NOW = Date.parse("2026-10-15T10:00:00Z");

beforeEach(() => {
  h.complaintStatsArgs = []; h.reviewStatsArgs = []; h.executed = []; h.waWhere = null;
  h.forecast = null; h.mailboxes = []; h.liveHistoryReads = 0;
});

// ─── E1 ──────────────────────────────────────────────────────────────────────

describe("E1 — Reclamações abertas: uma conta (complaintCounts) para o Suporte e o complaints.stats", () => {
  const rows = [
    { complaintStatus: "new", slaDeadline: "2026-10-15 09:00:00" }, // aberta e em atraso
    { complaintStatus: "analyzing", slaDeadline: "2026-10-16 09:00:00" }, // aberta, no prazo
    { complaintStatus: "waiting_client", slaDeadline: "2026-10-14 09:00:00" }, // aberta; o SLA para → não está em atraso
    { complaintStatus: "resolved", slaDeadline: null },
    { complaintStatus: "closed", slaDeadline: null },
    { complaintStatus: "converted", slaDeadline: null },
    { complaintStatus: "new", slaDeadline: "2026-10-01 09:00:00", archivedAt: "2026-10-02 10:00:00" }, // arquivada: fora
  ];
  it("abertas = Novo + Em análise + Aguarda cliente; arquivadas fora; atraso = complaintOverdue", () => {
    const c = complaintCounts(rows, NOW);
    expect(COMPLAINT_OPEN_STATUSES).toEqual(["new", "analyzing", "waiting_client"]);
    expect(c.open).toBe(3);
    expect(c.total).toBe(6);
    expect(c.overdue).toBe(1);
    expect(c.overdue).toBe(rows.filter((r) => !r.archivedAt && complaintOverdue(r, NOW)).length);
  });
  it("igual: os campos de antes continuam lá, com os mesmos valores (o `open` é novo)", () => {
    expect(complaintCounts(rows, NOW)).toEqual({ total: 6, open: 3, new: 1, analyzing: 1, waitingClient: 1, resolved: 1, closed: 2, converted: 1, overdue: 1 });
    const db = src("server/db.ts");
    const fn = db.slice(db.indexOf("export async function getComplaintStats"), db.indexOf("// ─── GOOGLE REVIEWS"));
    expect(fn).toContain("return complaintCounts(all, Date.now());");
    expect(fn).toContain("archivedAt} IS NULL");
  });
  it("a página Reclamações conta os cartões pela MESMA função (Novos + Em Análise + Aguarda Cliente = abertas)", () => {
    const page = src("client/src/pages/ComplaintsPage.tsx");
    expect(page).toContain("const stats = useMemo(() => complaintCounts(complaints as any[], Date.now()), [complaints]);");
    // a lista da página (sem filtros) traz sempre todas as abertas (a janela dos 90 dias não as corta)
    expect(src("server/db.ts")).toContain("OR ${complaints.complaintStatus} IN (${sql.join(COMPLAINT_OPEN_STATUSES.map((x) => sql`${x}`), sql`, `)}))");
    const c = complaintCounts(rows, NOW);
    expect(c.new + c.analyzing + c.waitingClient).toBe(c.open);
  });
  it("router: com a cidade do topo a função recebe-a; sem ela, como antes", async () => {
    await caller("super_admin").complaints.stats({ projectId: 10 });
    await caller("super_admin").complaints.stats();
    expect(h.complaintStatsArgs).toEqual([10, undefined]);
  });
});

// ─── E2 / E3 / E4 / E5 / E6 ──────────────────────────────────────────────────

describe("E2–E6 — Suporte: a cidade do topo em todos os cartões, as consultas das páginas, '—' quando falha", () => {
  it("E2: reviews.stats com a cidade → a função recebe o filtro (a mesma consulta das Críticas)", async () => {
    await caller("super_admin").reviews.stats({ projectId: 20 });
    expect(h.reviewStatsArgs).toEqual([{ projectId: 20 }]);
    expect(src("client/src/pages/GoogleReviewsPage.tsx")).toContain("trpc.reviews.stats.useQuery({ projectId })");
  });
  it("o Suporte chama as mesmas consultas, com a cidade/marca do topo", () => {
    const s = src("client/src/pages/SuporteDashboard.tsx");
    expect(s).toContain("const scope = globalFilters.projectId !== undefined ? { projectId: globalFilters.projectId } : {};");
    expect(s).toContain("trpc.complaints.stats.useQuery(scope,");
    expect(s).toContain("trpc.reviews.stats.useQuery(scope,");
    expect(s).toContain("trpc.lostFound.dashboard.useQuery({ ...scope, countsOnly: true },");
    expect(s).toContain('trpc.complaints.list.useQuery({ status: "new", ...scope }');
    // E1: o número vem do servidor (sem somar estados no cliente); "de sempre" no subtítulo
    expect(s).toContain("complaintStats ? complaintStats.open : null");
    expect(s).toContain("de sempre");
    // E3: já não conta a lista no cliente
    expect(s).not.toContain("trpc.lostFound.list");
    expect(s).toContain("lostQ.data ? lostQ.data.open : null");
  });
  it("E3: os Perdidos 'abertos' do painel = os estados não fechados (o Encontrado ainda por devolver conta)", () => {
    const caseOps = src("server/caseOps.ts");
    const fn = caseOps.slice(caseOps.indexOf("export async function getLostDashboard"), caseOps.indexOf("// ─── Lembretes de SLA"));
    const m = fn.match(/const open = sql`l\.status IN \(([^)]*)\)`;/);
    expect(m).not.toBeNull();
    const inSql = m![1].split(",").map((x) => x.trim().replace(/'/g, "")).sort();
    expect(inSql).toEqual(LOST_STATUSES.filter((st) => !isLostClosed(st)).slice().sort());
    expect(inSql).toContain("found");
    expect(fn).toContain("open: Number(agg?.openCount ?? 0)");
    // o procedimento do painel é o da página Perdidos (KanbanView)
    expect(src("client/src/pages/lostFound/KanbanView.tsx")).toContain("trpc.lostFound.dashboard.useQuery(");
  });
  it("E3: o Suporte pede só os contadores — o cruzamento dos condutores (Multipark ao vivo) não corre; o 'open' é o mesmo", async () => {
    const counts = await caller("super_admin").lostFound.dashboard({ projectId: 10, countsOnly: true });
    expect(h.liveHistoryReads).toBe(0);
    expect(counts.repeatDrivers).toEqual([]);
    // a página Perdidos (sem countsOnly) continua a pedir o cruzamento — e o 'open' vem da mesma conta
    const page = await caller("super_admin").lostFound.dashboard({ projectId: 10 });
    expect(h.liveHistoryReads).toBeGreaterThan(0);
    expect(page.open).toBe(counts.open);
    // quem não recebe o cruzamento (abaixo de team leader) também não o faz calcular
    const r = src("server/routers.ts");
    expect(r).toContain("const d = await getLostDashboard(scope, { repeatDrivers: seesDrivers && !countsOnly });");
    expect(r).toContain("return seesDrivers ? d : { ...d, repeatDrivers: [] };");
  });
  it("E4/E5/E6: rótulo das novas; '—' + nota quando a leitura falha (nunca 0); sem Período", () => {
    const s = src("client/src/pages/SuporteDashboard.tsx");
    expect(s).toContain("Últimas reclamações novas");
    expect(s).not.toContain("Últimas Reclamações Pendentes");
    expect(s).toContain('{openComplaints ?? "—"}');
    expect(s).toContain('{reviewStats ? reviewStats.pending : "—"}');
    expect(s).toContain('{openLostFound ?? "—"}');
    expect(s).toContain('isForbidden(error) ? "Sem acesso" : "Leitura falhou — não é 0"');
    expect(s).toContain('<QueryErrorNote error={complaintsQ.error} what="as reclamações"');
    expect(s).toContain('<QueryErrorNote error={reviewsQ.error} what="as críticas Google"');
    expect(s).not.toMatch(/\?\? 0\}/);
    expect(s).toContain("showDates={false}");
  });
  it("E6 igual: a barra mostra o Período por omissão (as outras páginas não mudam)", () => {
    const bar = src("client/src/components/DashboardFilterBar.tsx");
    expect(bar).toContain("showDates = true,");
    expect(bar).toContain("{showDates && (");
    // (o Pessoas passa a usar a prop no PR D; aqui só as que ficam com o Período)
    for (const p of ["FinanceiroDashboard", "OperacoesDashboard"]) {
      expect(src(`client/src/pages/${p}.tsx`)).not.toContain("showDates");
    }
  });
});

// ─── E7 ──────────────────────────────────────────────────────────────────────

describe("E7 — 'conta como reclamação' e 'fora do prazo': uma condição em SQL", () => {
  it("countableComplaintSql: sem arquivadas nem convertidas (o texto de sempre dos carros que saíram)", () => {
    expect(render(countableComplaintSql("complaints")).sql).toBe("complaints.archivedAt IS NULL AND complaints.complaint_status <> 'converted'");
    expect(render(countableComplaintSql("c")).sql).toBe("c.archivedAt IS NULL AND c.complaint_status <> 'converted'");
    expect(() => countableComplaintSql("c; DROP TABLE x")).toThrow();
  });
  it("complaintSlaLateSql: exatamente os estados de COMPLAINT_SLA_RUNNING, só o slaDeadline, nenhum dueDate", () => {
    const q = render(complaintSlaLateSql("complaints", "2026-10-15 23:00:00"));
    expect(COMPLAINT_SLA_RUNNING).toEqual(["new", "analyzing"]);
    expect(q.sql).toBe("complaints.slaDeadline IS NOT NULL AND complaints.slaDeadline < ? AND complaints.complaint_status IN (?, ?)");
    expect(q.params).toEqual(["2026-10-15 23:00:00", ...COMPLAINT_SLA_RUNNING]);
    expect(q.sql).not.toContain("dueDate");
    expect(q.params).not.toContain("waiting_client");
  });
  it("paridade com complaintOverdue: 'Aguarda cliente' e o dueDate sem SLA ficam fora nas duas", () => {
    expect(complaintOverdue({ complaintStatus: "waiting_client", slaDeadline: "2026-10-01 00:00:00" }, NOW)).toBe(false);
    expect(complaintOverdue({ complaintStatus: "new", slaDeadline: null }, NOW)).toBe(false);
    const caseRules = src("shared/caseRules.ts");
    expect(caseRules).toContain("COMPLAINT_SLA_RUNNING.includes(String(c.complaintStatus");
    expect(caseRules).toContain("parseUtc(c.slaDeadline ?? null)");
  });
  it("o Resumo do dia e os carros que saíram usam a mesma condição; o rótulo diz o dia operacional", () => {
    const day = src("server/supervisorDay.ts");
    expect(day).toContain('AND ${countableComplaintSql("complaints")}');
    expect(src("server/departedComplaints.ts")).toContain('AND ${countableComplaintSql("complaints")}');
    expect(src("client/src/components/shiftDay/DaySummaryTab.tsx")).toContain("dia operacional 03h–03h");
  });
});

// ─── E8 / E8b ────────────────────────────────────────────────────────────────

describe("E8/E8b — Briefing: prazos pela regra do cartão, sem a tabela antiga, e o aviso da previsão", () => {
  const forecast = (o: any = {}) => ({
    hourly: [{ hour: 9, checkins: 2, checkouts: 1 }],
    allocation: { cheapest: { peakDrivers: 2, totalDriverHours: 12 } },
    bookingSource: "multipark-db", bookingSourceNotice: null, bookingsTruncated: false, ...o,
  });
  const tree = { city: "lisbon", ids: [10], rootId: 10 } as any;

  it("loadSla: só reclamações, com countableComplaintSql + complaintSlaLateSql no fim do dia; incidents já não é lida", async () => {
    h.forecast = forecast();
    const d = await collectBriefing("2026-10-15", tree, "2026-10-15 06:30:00");
    const texts = h.executed.map((q) => render(q));
    expect(texts.some((t) => /FROM incidents/.test(t.sql))).toBe(false);
    const sla = texts.find((t) => /FROM complaints/.test(t.sql))!;
    expect(sla.sql).toContain("complaints.archivedAt IS NULL AND complaints.complaint_status <> 'converted'");
    expect(sla.sql).toContain("complaints.slaDeadline IS NOT NULL AND complaints.slaDeadline < ? AND complaints.complaint_status IN (?, ?)");
    expect(sla.sql).not.toContain("dueDate");
    expect(sla.params).toEqual(expect.arrayContaining(["new", "analyzing"]));
    expect(sla.params).not.toContain("waiting_client");
    // o prazo das 05:00 já passou às 06:30 → em atraso (a mesma regra do cartão Reclamações)
    expect(d.sla).toMatchObject({ complaintsOverdue: 1, complaintsDueToday: 0, incidentsOverdue: 0, incidentsDueToday: 0 });
    expect(d.forecastNotice).toBeNull();
    const b = src("server/aiOps/briefing.ts");
    expect(b).toContain('${countableComplaintSql("complaints")} AND ${complaintSlaLateSql("complaints", end)}');
  });

  it("previsão só com a cópia → o briefing guarda o aviso e mostra-o no email e no cartão", async () => {
    h.forecast = forecast({ bookingSource: "copy", bookingSourceNotice: "A BD da Multipark não respondeu. A usar a cópia das reservas (pode estar desatualizada)." });
    const d = await collectBriefing("2026-10-15", tree, "2026-10-15 06:30:00");
    expect(d.forecastNotice).toBe(forecastIncompleteReason(h.forecast));
    expect(d.forecastNotice).toMatch(/^previsão incompleta: .*cópia das reservas/);
    const mail = renderBriefingEmail(filterBriefingFor(d, viewerPerms({ role: "team_leader" })), "Resumo.", "https://app");
    expect(mail.html).toContain("previsão incompleta");
    expect(mail.text).toContain("previsão incompleta");
    const card = src("client/src/components/aiOps/OpsBriefingCard.tsx");
    expect(card).toContain("{d.forecastNotice && (");
  });

  it("previsão cortada no limite também avisa; briefings antigos (sem o campo) abrem sem erro", () => {
    expect(forecastIncompleteReason({ bookingsTruncated: true })).toMatch(/previsão incompleta/);
    const fresh = buildBriefingData({
      city: "lisbon", day: "2026-10-15", hourly: [], extras: null, sla: [], nowUtc: "2026-10-15 06:30:00",
      handover: { last: null, pending: [], repeated: [] }, anomalies: [], marketingAlerts: [],
    });
    expect(fresh.forecastNotice).toBeNull();
    const { forecastNotice: _omit, ...old } = fresh;
    const oldData = old as BriefingData;
    const f = filterBriefingFor(oldData, viewerPerms({ role: "super_admin" }));
    const mail = renderBriefingEmail(f, "Resumo.", "https://app");
    expect(mail.html).not.toContain("previsão incompleta");
    expect(mail.subject).toContain("Briefing Lisboa");
  });
});

// ─── E10 ─────────────────────────────────────────────────────────────────────

describe("E10 — Comunicação: as caixas desativadas saem do badge e vão para 'Antigas'", () => {
  const box = (key: string, active: boolean, module = "comunicacao") => ({
    id: 1, key, label: key.toUpperCase(), module, visibleRoles: [], active, addresses: [], signatures: {}, pipeline: null, sourceKind: "conta",
  });
  it("badgeTotal ignora as inativas; mailboxSections separa (a ordem fica)", () => {
    expect(badgeTotal([{ unread: 3, active: true }, { unread: 5, active: false }, { unread: 2 }])).toBe(5);
    expect(badgeTotal([])).toBe(0);
    const s = mailboxSections([{ key: "a", active: true }, { key: "old", active: false }, { key: "b", active: true }]);
    expect(s.active.map((b) => b.key)).toEqual(["a", "b"]);
    expect(s.old.map((b) => b.key)).toEqual(["old"]);
  });
  it("super admin: a caixa desativada vem na lista (com active=false) mas não conta no badge", async () => {
    h.mailboxes = [box("info", true), box("antiga", false)];
    const v = await visibleMailboxes({ id: 1, role: "super_admin" });
    expect(v.mailboxes.map((m) => [m.key, m.active])).toEqual([["info", true], ["antiga", false]]);
    const b = await mailBadge({ id: 1, role: "super_admin" });
    expect(b.shared).toBe(3); // era 6 (3 + 3 da antiga)
  });
  it("igual: para quem não é super admin o número não muda (já não via as desativadas)", async () => {
    h.mailboxes = [box("info", true), box("antiga", false)];
    const v = await visibleMailboxes({ id: 2, role: "admin" });
    expect(v.mailboxes.map((m) => m.key)).toEqual(["info"]);
    const b = await mailBadge({ id: 2, role: "admin" });
    expect(b.shared).toBe(v.mailboxes.reduce((s, m) => s + m.unread, 0));
  });
  it("super admin, admin, supervisor, team leader e frontoffice: o badge = as caixas ATIVAS que cada um vê na lista", async () => {
    h.mailboxes = [box("info", true), box("antiga", false)];
    for (const role of ["super_admin", "admin", "supervisor", "team_leader", "frontoffice"]) {
      const viewer = { id: 9, role };
      const v = await visibleMailboxes(viewer);
      const b = await mailBadge(viewer);
      expect(b.shared).toBe(v.mailboxes.filter((m) => m.active).reduce((s, m) => s + m.unread, 0));
      if (role !== "super_admin") expect(v.mailboxes.some((m) => !m.active)).toBe(false);
    }
    expect((await mailBadge({ id: 9, role: "admin" })).shared).toBe(3);
  });
  it("servidor: das 'Antigas' não se escreve (sem 'Nova mensagem' e o envio recusa) nem são caixa inicial", async () => {
    h.mailboxes = [box("info", true), box("antiga", false)];
    const v = await visibleMailboxes({ id: 1, role: "super_admin" });
    expect(Object.fromEntries(v.mailboxes.map((m) => [m.key, m.canCompose]))).toEqual({ info: true, antiga: false });
    const send = (mailbox: string) => sendMail({ id: 1, role: "super_admin" }, { mode: "new", mailbox, to: ["cliente@exemplo.pt"], cc: [], bcc: [], body: "Olá", attachments: [] } as any);
    await expect(send("antiga")).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/desativada/) });
    // a ativa passa este passo (pára mais à frente, por não ter conta Google de origem neste teste)
    await expect(send("info")).rejects.not.toMatchObject({ message: expect.stringMatching(/desativada/) });
    await expect(caller("super_admin").mail.setHomeBox({ key: "antiga" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/desativada/) });
    await expect(caller("super_admin").mail.setHomeBox({ key: "info" })).resolves.toEqual({ ok: true, key: "info" });
  });
  it("o ecrã: 'Antigas' fechada por omissão, sem contadores", () => {
    const p = src("client/src/pages/ComunicacaoPage.tsx");
    expect(p).toContain("mailboxSections(overview.data?.mailboxes ?? [])");
    expect(p).toContain("const [showOld, setShowOld] = useState(false);");
    expect(p).toContain("oldBoxes.map((b) => boxButton(b.key, b.label, 0,");
    expect(p).toContain("Antigas ({oldBoxes.length})");
  });
});

// ─── E11 ─────────────────────────────────────────────────────────────────────

describe("E11 — WhatsApp: o badge conta só as conversas das caixas que a pessoa vê", () => {
  it("inboxBadgeConds = as duas condições da lista; sem caixas escondidas fica igual a hoje", () => {
    const none = inboxBadgeConds([10, 20], []);
    expect(none).toHaveLength(1);
    expect(render(none[0])).toEqual(render(visibilitySql([10, 20])));
    const two = inboxBadgeConds(undefined, ["financeiro"]);
    expect(two).toHaveLength(2);
    expect(render(two[0])).toEqual(render(visibilitySql(undefined)));
    expect(render(two[1])).toEqual(render(boxVisibleSql(["financeiro"])!));
    // a lista usa as mesmas duas funções
    const inbox = src("server/whatsappInbox.ts");
    expect(inbox).toContain("const conds: SQL[] = [visibilitySql(scopedProjectIds())];");
    expect(inbox).toContain("const boxCond = boxVisibleSql(opts.hiddenBoxes ?? []);");
  });
  it("inboxBadge(pessoa): as caixas que a pessoa não vê saem; o router passa quem pede", async () => {
    h.mailboxes = [
      { key: "rh", module: "rh", visibleRoles: [], active: true },
      { key: "faturacao", module: "financeiro", visibleRoles: [], active: true },
    ];
    const r = await inboxBadge({ id: 5, role: "team_leader" });
    expect(r).toMatchObject({ attention: 2, overdue: 1 });
    const q = render(h.waWhere);
    expect(q.sql).toContain("`boxKey` NOT IN (?)");
    expect(q.params).toContain("faturacao");
    expect(q.params).not.toContain("rh");
    // super admin: sem caixas escondidas (como hoje)
    await inboxBadge({ id: 1, role: "super_admin" });
    expect(render(h.waWhere).sql).not.toMatch(/NOT IN/);
    expect(src("server/routers.ts")).toContain("return inboxBadge(ctx.user);");
  });
});
