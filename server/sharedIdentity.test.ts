import { describe, expect, it, vi } from "vitest";
import { SharedAuthError, type SharedSession, type SharedUser } from "./_core/sharedAuth";
import {
  backfillConfirmed,
  confirmProposal,
  createSharedAccountFor,
  decideAccessRequest,
  linkAccount,
  linkWithPassword,
  proposeLink,
  resolveGoogleShared,
  resolveSharedLogin,
  splitName,
  unlinkAccount,
  viewProposal,
  PROPOSAL_TTL_MS,
  type SharedIdentityDeps,
} from "./sharedIdentity";
import type { AccessRequestRow, DashUserRow, ProposalRow, SharedIdentityStore } from "./sharedIdentityStore";
import { methodAllowedForRole } from "@shared/loginCode";

const NOW = Date.parse("2026-10-14T10:00:00Z");

function dashUser(over: Partial<DashUserRow> & { id: number }): DashUserRow {
  return {
    openId: `google_${over.id}`, email: `u${over.id}@gmail.com`, name: `User ${over.id}`, role: "user", isActive: 1,
    deactivationReason: null, sessionVersion: 0, sharedUserId: null, sharedLinkedAt: null, sharedLinkMethod: null,
    lastSignedIn: null, loginMethod: "google", ...over,
  };
}
const sharedUser = (over: Partial<SharedUser> & { id: string }): SharedUser => ({
  email: `${over.id}@gmail.com`, firstName: "Ana", lastName: "Silva", isActive: true, emailVerifiedAt: null, ...over,
});
const session = (user: SharedUser): SharedSession => ({ user, sessionId: `sess_${user.id}`, refreshToken: "r", accessToken: "a" });

class MemStore implements SharedIdentityStore {
  users = new Map<number, DashUserRow>();
  fichas = new Set<number>();
  agents = new Map<number, string[]>();
  proposals: (ProposalRow & { tokenHash: string })[] = [];
  requests: AccessRequestRow[] = [];
  logs: { action: string; details: string }[] = [];
  constructor(users: DashUserRow[]) { for (const u of users) this.users.set(u.id, { ...u }); }
  async userById(id: number) { const u = this.users.get(id); return u ? { ...u } : null; }
  async userBySharedId(sid: string) { return [...this.users.values()].find((u) => u.sharedUserId === sid) ?? null; }
  async unlinkedUsersByEmail(email: string) { return [...this.users.values()].filter((u) => !u.sharedUserId && (u.email ?? "").toLowerCase() === email.toLowerCase()); }
  async setLink(userId: number, sid: string, method: any) {
    const u = this.users.get(userId)!;
    if (u.sharedUserId) return u.sharedUserId === sid ? "already_linked" as const : "taken" as const;
    if ([...this.users.values()].some((x) => x.sharedUserId === sid)) return "taken" as const;
    u.sharedUserId = sid; u.sharedLinkMethod = method; return "linked" as const;
  }
  async clearLink(userId: number) { const u = this.users.get(userId); if (!u) return false; u.sharedUserId = null; return true; }
  async touchChecked() {}
  async listUsers() { return [...this.users.values()].map((u) => ({ ...u, hasFicha: this.fichas.has(u.id) })); }
  async agentIdsOfUser(userId: number) { return this.agents.get(userId) ?? []; }
  async hasFicha(userId: number) { return this.fichas.has(userId); }
  async createProposal(p: any) {
    const id = this.proposals.length + 1;
    this.proposals.push({ id, userId: p.userId, sharedUserId: p.sharedUserId, sharedEmail: p.sharedEmail, tokenHash: p.tokenHash, proposedById: p.proposedById, expiresAt: new Date(p.expiresAt).toISOString(), confirmedAt: null, cancelledAt: null });
    return id;
  }
  async proposalByTokenHash(h: string) { return this.proposals.find((p) => p.tokenHash === h) ?? null; }
  async confirmProposal(id: number, now: number) { const p = this.proposals.find((x) => x.id === id)!; if (p.confirmedAt) return false; p.confirmedAt = new Date(now).toISOString(); return true; }
  async cancelOpenProposals(userId: number, now: number) { for (const p of this.proposals) if (p.userId === userId && !p.confirmedAt && !p.cancelledAt) p.cancelledAt = new Date(now).toISOString(); }
  async openProposals() { return this.proposals.filter((p) => !p.confirmedAt && !p.cancelledAt); }
  async upsertAccessRequest(r: any) {
    const ex = this.requests.find((x) => x.sharedUserId === r.sharedUserId);
    if (ex) { ex.requestCount++; return; }
    this.requests.push({ id: this.requests.length + 1, sharedUserId: r.sharedUserId, email: r.email, name: r.name, status: "pending", requestCount: 1, lastRequestedAt: null, decidedById: null, decidedAt: null, userId: null });
  }
  async accessRequests() { return this.requests; }
  async accessRequestById(id: number) { return this.requests.find((r) => r.id === id) ?? null; }
  async decideAccessRequest(id: number, d: any) { const r = this.requests.find((x) => x.id === id)!; if (r.status !== "pending") return false; r.status = d.status; r.userId = d.userId; return true; }
  async log(e: { action: string; details: string }) { this.logs.push({ action: e.action, details: e.details }); }
}

function makeDeps(store: MemStore, client: Partial<SharedIdentityDeps["client"]> = {}, extra: Partial<SharedIdentityDeps> = {}) {
  const sent: { to: string; link: string }[] = [];
  const deps: SharedIdentityDeps = {
    store,
    client: {
      configured: true,
      passwordLogin: vi.fn(async () => { throw new SharedAuthError("invalid_credentials", 401); }),
      googleLogin: vi.fn(async () => { throw new SharedAuthError("not_found", 404); }),
      logout: vi.fn(async () => undefined),
      endSession: vi.fn(async () => true),
      userByEmail: vi.fn(async () => null),
      userById: vi.fn(async () => null),
      createAccount: vi.fn(async () => { throw new SharedAuthError("unavailable"); }),
      ...client,
    } as SharedIdentityDeps["client"],
    now: () => NOW,
    sendProposalEmail: vi.fn(async (i) => { sent.push(i); return true; }),
    userHasFicha: (id) => store.hasFicha(id),
    createDashUser: vi.fn(async ({ name, email }) => { const id = 900 + store.users.size; store.users.set(id, dashUser({ id, name, email })); return id; }),
    ...extra,
  };
  return { deps, sent };
}

describe("linkAccount", () => {
  it("liga, e recusa uma conta Multipark já usada ou uma conta já ligada", async () => {
    const store = new MemStore([dashUser({ id: 1 }), dashUser({ id: 2 })]);
    const { deps } = makeDeps(store);
    expect(await linkAccount(deps, { userId: 1, shared: sharedUser({ id: "s1" }), method: "password", actorId: 1 })).toEqual({ ok: true, already: false });
    expect(await linkAccount(deps, { userId: 1, shared: sharedUser({ id: "s1" }), method: "password", actorId: 1 })).toEqual({ ok: true, already: true });
    expect(await linkAccount(deps, { userId: 2, shared: sharedUser({ id: "s1" }), method: "password", actorId: 2 })).toEqual({ ok: false, reason: "taken" });
    expect(await linkAccount(deps, { userId: 1, shared: sharedUser({ id: "s9" }), method: "password", actorId: 1 })).toEqual({ ok: false, reason: "linked_elsewhere" });
    expect(await linkAccount(deps, { userId: 2, shared: sharedUser({ id: "s3", isActive: false }), method: "password", actorId: 2 })).toEqual({ ok: false, reason: "inactive_shared" });
    expect(store.logs.map((l) => l.action)).toContain("identity_link_conflict");
  });

  it("desligar limpa a ligação e cancela propostas", async () => {
    const store = new MemStore([dashUser({ id: 1, sharedUserId: "s1" })]);
    const { deps } = makeDeps(store);
    expect(await unlinkAccount(deps, { userId: 1, actorId: 99 })).toBe(true);
    expect(store.users.get(1)!.sharedUserId).toBeNull();
    expect(await unlinkAccount(deps, { userId: 1, actorId: 99 })).toBe(false);
  });
});

describe("resolveGoogleShared (login Google do dashboard)", () => {
  it("encontra a conta Multipark pelo ID token e liga", async () => {
    const store = new MemStore([dashUser({ id: 1 })]);
    const s = sharedUser({ id: "s1" });
    const { deps } = makeDeps(store, { googleLogin: vi.fn(async () => session(s)) });
    const r = await resolveGoogleShared(deps, { userId: 1, idToken: "idt" });
    expect(r.kind).toBe("linked");
    expect(store.users.get(1)!.sharedLinkMethod).toBe("google_shadow");
    expect(deps.client.googleLogin).toHaveBeenCalledWith("idt", false, undefined);
  });

  it("sem conta Multipark: cria pela Google só para staff (ficha ou papel acima de utilizador)", async () => {
    const store = new MemStore([dashUser({ id: 1 }), dashUser({ id: 2 }), dashUser({ id: 3, role: "team_leader" })]);
    store.fichas.add(2);
    const s = sharedUser({ id: "new" });
    const googleLogin = vi.fn(async (_t: string, allowCreate: boolean) => { if (!allowCreate) throw new SharedAuthError("not_found", 404); return session(s); });
    const { deps } = makeDeps(store, { googleLogin });
    expect((await resolveGoogleShared(deps, { userId: 1, idToken: "t" })).kind).toBe("not_found");
    expect(googleLogin).toHaveBeenCalledTimes(1);
    expect((await resolveGoogleShared(deps, { userId: 2, idToken: "t" })).kind).toBe("linked");
    expect(googleLogin).toHaveBeenLastCalledWith("t", true, undefined);
  });

  it("nunca parte: be-shared em baixo, sem token ou conta inativa → não liga", async () => {
    const store = new MemStore([dashUser({ id: 1 }), dashUser({ id: 2, isActive: 0 })]);
    const { deps } = makeDeps(store, { googleLogin: vi.fn(async () => { throw new SharedAuthError("unavailable"); }) });
    expect((await resolveGoogleShared(deps, { userId: 1, idToken: "t" })).kind).toBe("unavailable");
    expect((await resolveGoogleShared(deps, { userId: 1, idToken: null })).kind).toBe("skipped");
    expect((await resolveGoogleShared(deps, { userId: 2, idToken: "t" })).kind).toBe("skipped");
    expect(store.users.get(1)!.sharedUserId).toBeNull();
  });

  it("conflito (a conta Multipark já é de outra conta do dashboard) → termina a sessão Multipark", async () => {
    const store = new MemStore([dashUser({ id: 1 }), dashUser({ id: 2, sharedUserId: "s1" })]);
    const { deps } = makeDeps(store, { googleLogin: vi.fn(async () => session(sharedUser({ id: "s1" }))) });
    expect((await resolveGoogleShared(deps, { userId: 1, idToken: "t" })).kind).toBe("conflict");
    expect(deps.client.logout).toHaveBeenCalled();
  });
});

describe("L1 linkWithPassword", () => {
  it("prova a conta com a palavra-passe, liga e termina logo a sessão Multipark", async () => {
    const store = new MemStore([dashUser({ id: 1, email: "ana@empresa.pt" })]);
    const s = sharedUser({ id: "s1", email: "ana.pessoal@gmail.com" });
    const { deps } = makeDeps(store, { passwordLogin: vi.fn(async () => session(s)) });
    expect(await linkWithPassword(deps, { userId: 1, email: "ana.pessoal@gmail.com", password: "x" })).toEqual({ ok: true, sharedEmail: "ana.pessoal@gmail.com" });
    expect(store.users.get(1)!.sharedUserId).toBe("s1");
    expect(deps.client.logout).toHaveBeenCalledTimes(1);
  });

  it("palavra-passe errada não liga nada", async () => {
    const store = new MemStore([dashUser({ id: 1 })]);
    const { deps } = makeDeps(store);
    expect(await linkWithPassword(deps, { userId: 1, email: "a@b.pt", password: "x" })).toEqual({ ok: false, reason: "invalid_credentials" });
    expect(store.users.get(1)!.sharedUserId).toBeNull();
  });
});

describe("L2 proposta confirmada no email", () => {
  async function proposed() {
    const store = new MemStore([dashUser({ id: 1, name: "Rui Costa" })]);
    const s = sharedUser({ id: "s1", email: "rui@gmail.com" });
    const { deps, sent } = makeDeps(store, { userByEmail: vi.fn(async () => s), userById: vi.fn(async () => s) });
    const r = await proposeLink(deps, { userId: 1, sharedEmail: "Rui@Gmail.com", actor: { id: 99, name: "Jorge" }, origin: "https://dash.example/" });
    const token = sent[0]?.link.split("/").pop() ?? "";
    return { store, deps, sent, r, token, s };
  }

  it("envia o link para o email da conta Multipark e mostra a que conta liga", async () => {
    const { r, sent, token, deps } = await proposed();
    expect(r).toMatchObject({ ok: true, sharedEmail: "rui@gmail.com" });
    expect(sent[0].to).toBe("rui@gmail.com");
    expect(sent[0].link).toMatch(/^https:\/\/dash\.example\/ligar-conta-multipark\/[A-Za-z0-9_-]{40,}$/);
    expect(await viewProposal(deps, token)).toMatchObject({ ok: true, dashName: "Rui Costa", sharedEmail: "rui@gmail.com" });
  });

  it("confirma uma vez; depois diz 'usado'", async () => {
    const { deps, token, store } = await proposed();
    expect(await confirmProposal(deps, token)).toEqual({ ok: true });
    expect(store.users.get(1)!.sharedLinkMethod).toBe("proposal");
    expect(await confirmProposal(deps, token)).toEqual({ ok: false, reason: "used" });
  });

  it("recusa link expirado, inválido ou se a conta Multipark mudou de email", async () => {
    const { deps, token, s } = await proposed();
    expect(await confirmProposal({ ...deps, now: () => NOW + PROPOSAL_TTL_MS + 1 }, token)).toEqual({ ok: false, reason: "expired" });
    expect(await confirmProposal(deps, "x".repeat(43))).toEqual({ ok: false, reason: "invalid" });
    (deps.client.userById as any).mockResolvedValueOnce({ ...s, email: "outro@gmail.com" });
    expect(await confirmProposal(deps, token)).toEqual({ ok: false, reason: "changed" });
  });

  it("sem conta Multipark com esse email → sugere criar; email que não sai → cancela a proposta", async () => {
    const store = new MemStore([dashUser({ id: 1 })]);
    const { deps } = makeDeps(store);
    expect(await proposeLink(deps, { userId: 1, sharedEmail: "x@y.pt", actor: { id: 9, name: null }, origin: "https://d" })).toEqual({ ok: false, reason: "no_shared_account" });
    const s = sharedUser({ id: "s1" });
    const failing = makeDeps(store, { userByEmail: vi.fn(async () => s) }, { sendProposalEmail: vi.fn(async () => false) }).deps;
    expect(await proposeLink(failing, { userId: 1, sharedEmail: "s1@gmail.com", actor: { id: 9, name: null }, origin: "https://d" })).toEqual({ ok: false, reason: "email_failed" });
    expect(store.proposals.every((p) => p.cancelledAt)).toBe(true);
  });
});

describe("L4 criar a conta Multipark", () => {
  it("cria e liga; se já existir NÃO liga (pode não ser esta pessoa)", async () => {
    const store = new MemStore([dashUser({ id: 1, name: "Ana Maria Silva", email: "ana@empresa.pt" }), dashUser({ id: 2, email: "rui@empresa.pt" })]);
    const createAccount = vi.fn(async (i: any) => ({ user: sharedUser({ id: `s_${i.email}`, email: i.email }), created: i.email === "ana@empresa.pt", setPasswordEmailSent: true }));
    const { deps } = makeDeps(store, { createAccount });
    expect(await createSharedAccountFor(deps, { userId: 1, actorId: 9 })).toEqual({ ok: true, sharedEmail: "ana@empresa.pt", setPasswordEmailSent: true });
    expect(createAccount).toHaveBeenCalledWith(expect.objectContaining({ firstName: "Ana Maria", lastName: "Silva", sendSetPasswordEmail: true }));
    expect(await createSharedAccountFor(deps, { userId: 2, actorId: 9 })).toEqual({ ok: false, reason: "exists" });
    expect(store.users.get(2)!.sharedUserId).toBeNull();
  });

  it("splitName", () => {
    expect(splitName("Ana", "x")).toEqual({ firstName: "Ana", lastName: "" });
    expect(splitName("  ", "fallback")).toEqual({ firstName: "fallback", lastName: "" });
    expect(splitName("Ana Maria Silva", "x")).toEqual({ firstName: "Ana Maria", lastName: "Silva" });
  });
});

describe("A backfill pelos agentes da ficha", () => {
  it("só liga quando a ficha aponta para a conta Multipark com o MESMO email; simulação não escreve", async () => {
    const store = new MemStore([
      dashUser({ id: 1, email: "ana@gmail.com" }),
      dashUser({ id: 2, email: "rui@empresa.pt" }),
      dashUser({ id: 3, email: "sem@agente.pt" }),
    ]);
    store.agents.set(1, ["s_ana"]);
    store.agents.set(2, ["s_rui"]);
    const userById = vi.fn(async (id: string) => (id === "s_ana" ? sharedUser({ id, email: "ana@gmail.com" }) : sharedUser({ id, email: "rui.pessoal@gmail.com" })));
    const { deps } = makeDeps(store, { userById });
    const dry = await backfillConfirmed(deps, { actorId: 9, dryRun: true });
    expect(dry.candidates).toEqual([{ userId: 1, sharedUserId: "s_ana" }]);
    expect(dry.mismatches).toEqual([{ userId: 2, sharedUserId: "s_rui" }]);
    expect(store.users.get(1)!.sharedUserId).toBeNull();
    const applied = await backfillConfirmed(deps, { actorId: 9, dryRun: false });
    expect(applied.linked).toEqual([{ userId: 1, sharedUserId: "s_ana" }]);
    expect(store.users.get(1)!.sharedLinkMethod).toBe("agent_confirmed");
  });
});

describe("F3 resolveSharedLogin + L5", () => {
  it("conta ligada → entra", async () => {
    const store = new MemStore([dashUser({ id: 1, sharedUserId: "s1" })]);
    const { deps } = makeDeps(store);
    const r = await resolveSharedLogin(deps, session(sharedUser({ id: "s1" })));
    expect(r).toMatchObject({ kind: "ok", linkedNow: false });
  });

  it("email CONFIRMADO no be-shared + uma só conta com esse email → liga e entra", async () => {
    const store = new MemStore([dashUser({ id: 1, email: "ana@gmail.com" })]);
    const { deps } = makeDeps(store);
    const r = await resolveSharedLogin(deps, session(sharedUser({ id: "s1", email: "ana@gmail.com", emailVerifiedAt: "2026-10-01T00:00:00Z" })));
    expect(r).toMatchObject({ kind: "ok", linkedNow: true });
    expect(store.users.get(1)!.sharedLinkMethod).toBe("email_verified");
  });

  it("email por confirmar, variante Gmail ou várias contas → pedido de acesso (nunca liga sozinho)", async () => {
    const store = new MemStore([dashUser({ id: 1, email: "ana@gmail.com" }), dashUser({ id: 2, email: "rui@gmail.com" }), dashUser({ id: 3, email: "rui@gmail.com" })]);
    const { deps } = makeDeps(store);
    expect((await resolveSharedLogin(deps, session(sharedUser({ id: "s1", email: "ana@gmail.com", emailVerifiedAt: null })))).kind).toBe("access_requested");
    expect((await resolveSharedLogin(deps, session(sharedUser({ id: "s2", email: "a.na@gmail.com", emailVerifiedAt: "2026-10-01" })))).kind).toBe("access_requested");
    expect((await resolveSharedLogin(deps, session(sharedUser({ id: "s3", email: "rui@gmail.com", emailVerifiedAt: "2026-10-01" })))).kind).toBe("access_requested");
    expect([...store.users.values()].every((u) => !u.sharedUserId)).toBe(true);
    expect(store.requests).toHaveLength(3);
  });

  it("o super admin aprova (conta nova ou existente) ou recusa um pedido", async () => {
    const store = new MemStore([dashUser({ id: 1, email: "ana@empresa.pt" })]);
    const s = sharedUser({ id: "s1", email: "ana@gmail.com" });
    const { deps } = makeDeps(store, { userById: vi.fn(async () => s) });
    await resolveSharedLogin(deps, session(s));
    expect(await decideAccessRequest(deps, { requestId: 1, actorId: 9, decision: "approve_existing", userId: 1 })).toEqual({ ok: true, userId: 1 });
    expect(store.users.get(1)!.sharedLinkMethod).toBe("access_request");
    expect(await decideAccessRequest(deps, { requestId: 1, actorId: 9, decision: "reject" })).toEqual({ ok: false, reason: "decided" });

    const store2 = new MemStore([]);
    const d2 = makeDeps(store2, { userById: vi.fn(async () => sharedUser({ id: "s2", email: "novo@gmail.com" })) }).deps;
    await resolveSharedLogin(d2, session(sharedUser({ id: "s2", email: "novo@gmail.com" })));
    const r = await decideAccessRequest(d2, { requestId: 1, actorId: 9, decision: "approve_new" });
    expect(r.ok).toBe(true);
    expect(d2.createDashUser).toHaveBeenCalledWith({ name: "Ana Silva", email: "novo@gmail.com" });
  });
});

describe("papel × forma de entrar", () => {
  it("a conta Multipark vale para todos os papéis, como o Google", () => {
    for (const role of ["user", "extra", "team_leader", "admin", "super_admin"]) expect(methodAllowedForRole("shared", role)).toBe(true);
    expect(methodAllowedForRole("password", "admin")).toBe(false);
  });
});
