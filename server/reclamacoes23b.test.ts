/**
 * P3 lote 23b — Reclamações (decisões do Jorge, 3 out 2026):
 *  - D19: condutores e extras não veem reclamações — nem as em que estão
 *    envolvidos; só a partir de team leader;
 *  - D20: o cliente volta a escrever → aviso no sino ao responsável
 *    (interruptor COMPLAINT_CLIENT_REPLY_NOTIFY, desligado por omissão);
 *  - D21: a lista abre nos últimos 90 dias (+ as ainda abertas).
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ listCalls: [] as any[] }));
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
  getComplaints: async (f: any) => { state.listCalls.push(f); return [{ id: 1 }, { id: 2 }]; },
  getComplaintById: async () => ({ id: 5, projectId: 10 }),
}));

import { appRouter } from "./routers";
import { can, scopeFor, type ModuleId } from "../shared/access";
import { AUTOMATION_FLAGS, automationFlagDefault } from "../shared/appSettings";
import { COMPLAINT_LIST_DEFAULT_DAYS, COMPLAINT_OPEN_STATUSES } from "../shared/caseRules";
import { kindDef, resolveRecipients, type RoutingCandidate } from "../shared/notificationRouting";
import { KIND_SOURCES } from "../shared/notificationRoutingDoc";
import { CLIENT_REPLY_FLAG, isRecentInbound, notifyClientReplyWith, type ClientReplyDeps } from "./complaintClientReply";
import { clientSignalEmail } from "./complaintEmail";

const sees = (role: string, m: ModuleId) => can(role as any, m, "view");
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const caller = (role: string) => appRouter.createCaller({ user: { id: 77, role, name: "Rita" }, req: { headers: {} }, res: {} } as any);

beforeEach(() => { state.listCalls = []; });

describe("D19 — condutores e extras não veem reclamações", () => {
  it("matriz: nada para extra/condutor; team leader na cidade; Críticas continuam 'só as suas'", () => {
    for (const r of ["extra", "condutor", "user"]) expect(sees(r, "reclamacoes")).toBe(false);
    expect(scopeFor("team_leader", "reclamacoes")).toBe("city");
    expect(can("team_leader", "reclamacoes", "edit")).toBe(true);
    expect(scopeFor("condutor", "criticas")).toBe("own");
    expect(scopeFor("extra", "ocorrencias")).toBe("own");
  });

  it("lista, caso e sugestões da IA recusam extra e condutor (mesmo envolvidos)", async () => {
    for (const role of ["extra", "condutor"]) {
      await expect(caller(role).complaints.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller(role).complaints.getById({ id: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller(role).complaints.aiSuggestions({ complaintId: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(state.listCalls).toEqual([]);
  });

  it("team leader vê a lista toda (sem filtro de 'casos próprios')", async () => {
    expect(await caller("team_leader").complaints.list()).toHaveLength(2);
  });

  it("as rotas deixaram de aceitar o alcance 'own' e os links para a reclamação escondem-se a quem não a abre", () => {
    const r = src("server/routers.ts");
    expect(r).not.toMatch(/"reclamacoes", "view", \{ allowOwn: true \}/);
    expect(r).not.toMatch(/assertOwnCase\(ctx\.user, "reclamacoes"/);
    expect(r).not.toMatch(/filterOwnCases\(ctx\.user, "reclamacoes"/);
    expect(r).toMatch(/type OwnCaseKind = "review" \| "incident" \| "lost_found";/);
    const reviews = src("client/src/pages/GoogleReviewsPage.tsx");
    expect(reviews).toMatch(/const canOpenComplaint = seesBeyondOwn\(user as any, "reclamacoes"\)/);
    expect(reviews).toMatch(/\{canOpenComplaint && \(\s*<Button[^]*?Ver Reclamação/);
    const lost = src("client/src/pages/lostFound/DetailView.tsx");
    expect(lost).toMatch(/seesBeyondOwn\(user, "reclamacoes"\) \? `\/reclamacoes\?id=\$\{cid\}` : undefined/);
    expect(lost).not.toMatch(/href=\{`\/reclamacoes\?id=/);
  });
});

describe("D20 — aviso ao responsável quando o cliente responde", () => {
  const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
  const mk = (o: Partial<ClientReplyDeps> = {}) => {
    const sent: any[] = [];
    const deps: ClientReplyDeps = {
      flagOn: async () => true,
      clientSignalEmail,
      loadComplaint: async (id) => ({ id, title: "Risco na porta", projectId: 10, assignedToId: 42 }),
      assigneeUserIds: async (ids) => ids.filter((x): x is number => typeof x === "number").map((x) => x + 1000),
      notify: async (n) => { sent.push(n); },
      nowMs: () => NOW,
      ...o,
    };
    return { deps, sent };
  };
  const reply = { fromEmail: "ana.silva@gmail.com", fromName: "Ana Silva", subject: "Re: [REC-5] A minha reclamação", receivedAt: "2026-10-03 11:40:00" };

  it("interruptor existe e entra DESLIGADO; tipo pessoal de Reclamações documentado", () => {
    expect(CLIENT_REPLY_FLAG).toBe("COMPLAINT_CLIENT_REPLY_NOTIFY");
    expect(AUTOMATION_FLAGS.some((f) => f.name === CLIENT_REPLY_FLAG)).toBe(true);
    expect(automationFlagDefault(CLIENT_REPLY_FLAG)).toBe(false);
    expect(kindDef("complaint_client_reply")).toMatchObject({ module: "reclamacoes", personal: true, action: "view" });
    expect(KIND_SOURCES.complaint_client_reply).toMatch(/COMPLAINT_CLIENT_REPLY_NOTIFY/);
    expect(src("docs/notificacoes.md")).toMatch(/complaint_client_reply/);
  });

  it("desligado → não avisa ninguém", async () => {
    const { deps, sent } = mk({ flagOn: async () => false });
    expect(await notifyClientReplyWith(deps, 5, reply)).toBe("flag_off");
    expect(sent).toEqual([]);
  });

  it("ligado: avisa o responsável com o nº, quem escreveu e o link do caso", async () => {
    const { deps, sent } = mk();
    expect(await notifyClientReplyWith(deps, 5, reply)).toBe("notified");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: "complaint_client_reply", targetUserIds: [1042], projectId: 10,
      title: "O cliente respondeu à reclamação #5", link: "/reclamacoes?id=5",
      entity: { type: "complaint", id: 5 },
    });
    expect(sent[0].body).toBe("Ana Silva: Re: [REC-5] A minha reclamação · Risco na porta");
    // só quem ainda vê Reclamações (D19): um responsável que passou a condutor não recebe
    expect(sent[0].recipientFilter({ id: 1042, role: "condutor" })).toBe(false);
    expect(sent[0].recipientFilter({ id: 1042, role: "team_leader" })).toBe(true);
    expect(sent[0].recipientFilter({ id: 1042, role: "backoffice" })).toBe(true);
  });

  it("reencaminhamento interno (backoffice) não é o cliente a responder", async () => {
    const { deps, sent } = mk();
    expect(await notifyClientReplyWith(deps, 5, { ...reply, fromEmail: "reservas@multipark.pt" })).toBe("not_client");
    expect(await notifyClientReplyWith(deps, 5, { ...reply, fromEmail: null })).toBe("not_client");
    expect(sent).toEqual([]);
  });

  it("emails antigos (recuperação) e sem data não acordam ninguém", async () => {
    const { deps, sent } = mk();
    expect(await notifyClientReplyWith(deps, 5, { ...reply, receivedAt: "2026-09-30 10:00:00" })).toBe("old");
    expect(await notifyClientReplyWith(deps, 5, { ...reply, receivedAt: null })).toBe("old");
    expect(sent).toEqual([]);
  });

  it("sem responsável não avisa ninguém (o caso volta na mesma a 'Em análise')", async () => {
    const { deps, sent } = mk({ loadComplaint: async (id) => ({ id, projectId: 10, assignedToId: null }) });
    expect(await notifyClientReplyWith(deps, 5, reply)).toBe("no_assignee");
    expect(sent).toEqual([]);
  });

  it("isRecentInbound: ≤ 48 h, tolera 1 h de relógio adiantado, aceita 'T'", () => {
    const now = Date.UTC(2026, 9, 3, 12, 0, 0);
    expect(isRecentInbound("2026-10-01 12:30:00", now)).toBe(true);
    expect(isRecentInbound("2026-10-01 11:30:00", now)).toBe(false);
    expect(isRecentInbound("2026-10-03T12:30:00Z", now)).toBe(true);
    expect(isRecentInbound("2026-10-03 14:00:00", now)).toBe(false);
    expect(isRecentInbound("ontem", now)).toBe(false);
  });

  it("avisos pessoais respeitam o filtro do chamador", () => {
    const people: RoutingCandidate[] = [
      { id: 1, role: "condutor", isActive: true, prefs: { muted: [], email: {} }, email: null, accessOverrides: {} } as any,
      { id: 2, role: "supervisor", isActive: true, prefs: { muted: [], email: {} }, email: null, accessOverrides: {} } as any,
    ];
    const all = resolveRecipients({ kind: "complaint_client_reply", city: null, targetUserIds: [1, 2] }, people);
    expect(all.map((r) => r.userId)).toEqual([1, 2]);
    const filtered = resolveRecipients({ kind: "complaint_client_reply", city: null, targetUserIds: [1, 2], filter: (c) => c.role !== "condutor" }, people);
    expect(filtered.map((r) => r.userId)).toEqual([2]);
  });

  it("a entrada do email chama o aviso só nas respostas (não nas reclamações novas)", () => {
    const s = src("server/jobs/emailInboundSync.ts");
    expect(s).toMatch(/if \(!ctx\.isNew\) \{[^]*?notifyComplaintClientReply\(complaintId, \{ fromEmail: ctx\.fromEmail, fromName: ctx\.fromName, subject: ctx\.subject, receivedAt: ctx\.receivedAt \}\)[^]*?return;\s*\}/);
    expect(s).toMatch(/fromName,\s*subject,\s*receivedAt,\s*\}\);/);
  });
});

describe("D21 — lista das Reclamações nos últimos 90 dias (+ abertas)", () => {
  it("constantes: 90 dias e os estados abertos", () => {
    expect(COMPLAINT_LIST_DEFAULT_DAYS).toBe(90);
    expect([...COMPLAINT_OPEN_STATUSES]).toEqual(["new", "analyzing", "waiting_client"]);
  });

  it("a rota passa sinceDays ao servidor e recusa valores fora (0, > 10 anos)", async () => {
    await caller("supervisor").complaints.list({ sinceDays: 90 });
    expect(state.listCalls.at(-1)).toMatchObject({ sinceDays: 90 });
    await caller("supervisor").complaints.list();
    expect(state.listCalls.at(-1)).toEqual({});
    await expect(caller("supervisor").complaints.list({ sinceDays: 0 })).rejects.toBeTruthy();
    await expect(caller("supervisor").complaints.list({ sinceDays: 9999 })).rejects.toBeTruthy();
  });

  it("servidor: janela pela data de criação OU ainda aberta; nunca nas arquivadas", () => {
    const db = src("server/db.ts");
    expect(db).toMatch(/if \(!filters\?\.archived && since > 0\)/);
    expect(db).toMatch(/\$\{complaints\.createdAt\} >= DATE_SUB\(UTC_TIMESTAMP\(\), INTERVAL \$\{Math\.min\(since, 3650\)\} DAY\) OR \$\{complaints\.complaintStatus\} IN/);
  });

  it("página: abre nos 90 dias, 'Ver todas' tira o limite, pesquisar e arquivadas também", () => {
    const p = src("client/src/pages/ComplaintsPage.tsx");
    expect(p).toMatch(/const windowed = !showArchived && !allTime && !searching;/);
    expect(p).toMatch(/if \(windowed\) input\.sinceDays = COMPLAINT_LIST_DEFAULT_DAYS;/);
    expect(p).toMatch(/onClick=\{\(\) => setAllTime\(true\)\}>Ver todas</);
    expect(p).toMatch(/Só os últimos \{COMPLAINT_LIST_DEFAULT_DAYS\} dias/);
  });
});
