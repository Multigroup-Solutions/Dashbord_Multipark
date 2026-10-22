/**
 * Plano 05 — identidade partilhada: a AUTENTICAÇÃO é do be-shared (conta
 * Multipark), a AUTORIZAÇÃO fica no dashboard (papel, permissões, cidade,
 * ficha). Uma conta do dashboard liga-se a UMA conta Multipark por
 * `users.sharedUserId`. Docs: docs/integration/05-dashboard-auth-unificada.md §3.1.
 *
 * Ligar exige SEMPRE prova dos dois lados — nunca "os emails são iguais":
 *   L1 a pessoa, com sessão no dashboard, entra com a conta Multipark (password ou Google);
 *   L2 o admin PROPÕE, a pessoa confirma no link enviado ao email da conta Multipark;
 *   L4 o admin cria a conta Multipark (só se não existir — nova, só chega lá quem tem o email);
 *   L5 pedido de acesso de quem entrou com conta Multipark sem ligação → admin aprova;
 *   A  backfill: a ficha já aponta (agente Multipark) para essa conta E o email é o mesmo;
 *   sombra: no login Google do dashboard o mesmo ID token (email verificado pela Google)
 *     encontra a conta Multipark; email verificado no be-shared também liga (F3).
 *
 * Interruptores (desligados por omissão, só super admin):
 *   SHARED_AUTH_LINK  — sombra no login Google + ferramentas de ligação;
 *   SHARED_AUTH_LOGIN — página de entrada com a conta Multipark + sessões revalidadas.
 */
import { isFeatureEnabled } from "./_core/featureFlags";
import { normalizeEmail } from "@shared/email";
import type { ClientMeta, SharedAuthClient, SharedSession, SharedUser } from "./_core/sharedAuth";
import { SharedAuthError, emailDomain, sharedDisplayName } from "./_core/sharedAuth";
import { hashProposalToken, newProposalToken, type DashUserRow, type SharedIdentityStore, type SharedLinkMethod } from "./sharedIdentityStore";

export const PROPOSAL_TTL_MS = 72 * 60 * 60 * 1000;

export function sharedLinkEnabled(): boolean {
  return isFeatureEnabled("SHARED_AUTH_LINK", { defaultEnabled: false });
}
export function sharedLoginEnabled(): boolean {
  return isFeatureEnabled("SHARED_AUTH_LOGIN", { defaultEnabled: false });
}

export interface SharedIdentityDeps {
  store: SharedIdentityStore;
  client: Pick<SharedAuthClient, "configured" | "passwordLogin" | "googleLogin" | "logout" | "endSession" | "userByEmail" | "userById" | "createAccount">;
  now(): number;
  /** Email da proposta (L2). Nunca lança. */
  sendProposalEmail(input: { to: string; link: string; dashName: string; proposedBy: string }): Promise<boolean>;
  /** Utilizador com ficha (para criar conta Multipark no login Google sem conta). */
  userHasFicha(userId: number): Promise<boolean>;
  /** Cria uma conta do dashboard (L5 aprovado sem conta existente). */
  createDashUser(input: { name: string; email: string }): Promise<number>;
}

const name = (u: { name: string | null; email: string | null; id: number }) => u.name || u.email || `#${u.id}`;

// ─── Ligar ──────────────────────────────────────────────────────────────────

export type LinkOutcome =
  | { ok: true; already: boolean }
  | { ok: false; reason: "taken" | "linked_elsewhere" | "inactive_shared" | "missing_user" | "unavailable" };

/**
 * Liga `userId` à conta Multipark `shared`. Recusa se a conta Multipark já
 * estiver noutra conta do dashboard (UNIQUE) ou se esta já tiver outra ligação
 * (desligar é decisão do admin). Regista `identity_link` / `identity_link_conflict`.
 */
export async function linkAccount(
  deps: SharedIdentityDeps,
  input: { userId: number; shared: SharedUser; method: SharedLinkMethod; actorId: number; note?: string },
): Promise<LinkOutcome> {
  const { store } = deps;
  if (!input.shared.isActive) return { ok: false, reason: "inactive_shared" };
  const user = await store.userById(input.userId);
  if (!user) return { ok: false, reason: "missing_user" };
  if (user.sharedUserId === input.shared.id) return { ok: true, already: true };
  if (user.sharedUserId) {
    await store.log({ userId: input.actorId, action: "identity_link_conflict", entityId: user.id, details: `Conta já ligada a outra conta Multipark (${user.sharedUserId}); pedido ${input.method} → ${input.shared.id} recusado` });
    return { ok: false, reason: "linked_elsewhere" };
  }
  const holder = await store.userBySharedId(input.shared.id);
  if (holder && holder.id !== user.id) {
    await store.log({ userId: input.actorId, action: "identity_link_conflict", entityId: user.id, details: `A conta Multipark ${input.shared.id} já está ligada à conta #${holder.id} (${name(holder)}); pedido ${input.method} recusado` });
    return { ok: false, reason: "taken" };
  }
  const r = await store.setLink(user.id, input.shared.id, input.method, deps.now());
  if (r === "unavailable") return { ok: false, reason: "unavailable" };
  if (r === "taken") {
    await store.log({ userId: input.actorId, action: "identity_link_conflict", entityId: user.id, details: `Ligação ${input.method} → ${input.shared.id} recusada (já usada ou conta já ligada)` });
    return { ok: false, reason: "taken" };
  }
  await store.log({
    userId: input.actorId, action: "identity_link", entityId: user.id,
    details: `Ligada à conta Multipark ${input.shared.id} (@${emailDomain(input.shared.email)}) por ${input.method}${input.note ? ` — ${input.note}` : ""}`,
  });
  return { ok: true, already: r === "already_linked" };
}

/** Desligar (só admin). Quem chama sobe o sessionVersion (as sessões caem). */
export async function unlinkAccount(deps: SharedIdentityDeps, input: { userId: number; actorId: number; reason?: string }): Promise<boolean> {
  const user = await deps.store.userById(input.userId);
  if (!user?.sharedUserId) return false;
  const done = await deps.store.clearLink(user.id);
  await deps.store.cancelOpenProposals(user.id, deps.now());
  if (done) await deps.store.log({ userId: input.actorId, action: "identity_unlink", entityId: user.id, details: `Desligada da conta Multipark ${user.sharedUserId}${input.reason ? `: ${input.reason}` : ""}` });
  return done;
}

// ─── Sombra: login Google do dashboard ──────────────────────────────────────

/** Pode ganhar conta Multipark automaticamente (Google verificado, mas sem conta): staff com ficha ou papel acima de utilizador. */
async function eligibleForAutoCreate(deps: SharedIdentityDeps, user: DashUserRow): Promise<boolean> {
  if (user.isActive !== 1) return false;
  if (user.role !== "user") return true;
  return deps.userHasFicha(user.id).catch(() => false);
}

export type GoogleSharedOutcome =
  | { kind: "linked" | "matched"; session: SharedSession }
  | { kind: "skipped" | "not_found" | "conflict" | "unavailable" };

/**
 * Com o ID token do login Google do dashboard: encontra a conta Multipark (o
 * email vem verificado pela Google) e liga-a. Sem conta e com direito → cria-a
 * pela Google (a pessoa nunca precisa de palavra-passe). Devolve a sessão do
 * be-shared — quem chama decide se a guarda (F3) ou a termina (sombra).
 * Nunca lança: o login do dashboard nunca falha por causa disto.
 */
export async function resolveGoogleShared(
  deps: SharedIdentityDeps,
  input: { userId: number; idToken: string | null | undefined; meta?: ClientMeta },
): Promise<GoogleSharedOutcome> {
  if (!deps.client.configured || !input.idToken) return { kind: "skipped" };
  const user = await deps.store.userById(input.userId).catch(() => null);
  if (!user || user.isActive !== 1) return { kind: "skipped" };

  let session: SharedSession;
  try {
    session = await deps.client.googleLogin(input.idToken, false, input.meta);
  } catch (err) {
    const code = err instanceof SharedAuthError ? err.code : "unavailable";
    if (code !== "not_found") {
      if (code !== "unavailable") console.warn(`[SharedAuth] Google → conta Multipark: ${code} (conta #${user.id})`);
      return { kind: code === "conflict" ? "conflict" : "unavailable" };
    }
    if (!(await eligibleForAutoCreate(deps, user))) return { kind: "not_found" };
    try {
      session = await deps.client.googleLogin(input.idToken, true, input.meta);
      console.log(`[SharedAuth] conta Multipark criada pela Google para a conta #${user.id}`);
    } catch (err2) {
      console.warn(`[SharedAuth] não criou a conta Multipark pela Google (conta #${user.id}): ${err2 instanceof SharedAuthError ? err2.code : "erro"}`);
      return { kind: "unavailable" };
    }
  }

  if (user.sharedUserId === session.user.id) return { kind: "matched", session };
  const linked = await linkAccount(deps, { userId: user.id, shared: session.user, method: "google_shadow", actorId: user.id });
  if (!linked.ok) {
    await deps.client.logout(session);
    return { kind: linked.reason === "unavailable" ? "unavailable" : "conflict" };
  }
  return { kind: "linked", session };
}

// ─── L1: "Liga a tua conta Multipark" (com sessão no dashboard) ────────────

export type SelfLinkOutcome =
  | { ok: true; sharedEmail: string }
  | { ok: false; reason: "invalid_credentials" | "account_deactivated" | "rate_limited" | "taken" | "linked_elsewhere" | "unavailable" | "not_configured" };

export async function linkWithPassword(
  deps: SharedIdentityDeps,
  input: { userId: number; email: string; password: string; meta?: ClientMeta },
): Promise<SelfLinkOutcome> {
  if (!deps.client.configured) return { ok: false, reason: "not_configured" };
  let session: SharedSession;
  try {
    session = await deps.client.passwordLogin(input.email, input.password, input.meta);
  } catch (err) {
    const code = err instanceof SharedAuthError ? err.code : "unavailable";
    if (code === "invalid_credentials" || code === "account_deactivated" || code === "rate_limited") return { ok: false, reason: code };
    return { ok: false, reason: "unavailable" };
  }
  try {
    const linked = await linkAccount(deps, { userId: input.userId, shared: session.user, method: "password", actorId: input.userId });
    if (!linked.ok) return { ok: false, reason: linked.reason === "taken" || linked.reason === "linked_elsewhere" ? linked.reason : "unavailable" };
    return { ok: true, sharedEmail: session.user.email };
  } finally {
    // L1 só prova a identidade: a sessão Multipark aberta para isso termina já.
    await deps.client.logout(session);
  }
}

// ─── L2: proposta do admin, confirmada no email da conta Multipark ─────────

export type ProposeOutcome =
  | { ok: true; sharedEmail: string; expiresAt: string }
  | { ok: false; reason: "no_shared_account" | "already_linked" | "taken" | "missing_user" | "email_failed" | "inactive_shared" | "not_configured" };

export async function proposeLink(
  deps: SharedIdentityDeps,
  input: { userId: number; sharedEmail: string; actor: { id: number; name: string | null }; origin: string },
): Promise<ProposeOutcome> {
  if (!deps.client.configured) return { ok: false, reason: "not_configured" };
  const user = await deps.store.userById(input.userId);
  if (!user) return { ok: false, reason: "missing_user" };
  if (user.sharedUserId) return { ok: false, reason: "already_linked" };
  const shared = await deps.client.userByEmail(normalizeEmail(input.sharedEmail));
  if (!shared) return { ok: false, reason: "no_shared_account" };
  if (!shared.isActive) return { ok: false, reason: "inactive_shared" };
  const holder = await deps.store.userBySharedId(shared.id);
  if (holder && holder.id !== user.id) return { ok: false, reason: "taken" };

  const now = deps.now();
  await deps.store.cancelOpenProposals(user.id, now);
  const { token, hash } = newProposalToken();
  const expiresAt = now + PROPOSAL_TTL_MS;
  await deps.store.createProposal({ userId: user.id, sharedUserId: shared.id, sharedEmail: shared.email, tokenHash: hash, proposedById: input.actor.id, expiresAt });
  const link = `${input.origin.replace(/\/+$/, "")}/ligar-conta-multipark/${token}`;
  const sent = await deps.sendProposalEmail({ to: shared.email, link, dashName: name(user), proposedBy: input.actor.name || `#${input.actor.id}` });
  await deps.store.log({ userId: input.actor.id, action: "identity_link_proposed", entityId: user.id, details: `Proposta de ligação à conta Multipark ${shared.id} (@${emailDomain(shared.email)})${sent ? "" : " — o email NÃO saiu"}` });
  if (!sent) {
    await deps.store.cancelOpenProposals(user.id, now);
    return { ok: false, reason: "email_failed" };
  }
  return { ok: true, sharedEmail: shared.email, expiresAt: new Date(expiresAt).toISOString() };
}

export type ProposalView =
  | { ok: true; dashName: string; sharedEmail: string; expiresAt: string }
  | { ok: false; reason: "invalid" | "expired" | "used" | "cancelled" };

async function openProposal(deps: SharedIdentityDeps, token: string) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) return { ok: false as const, reason: "invalid" as const };
  const p = await deps.store.proposalByTokenHash(hashProposalToken(token));
  if (!p) return { ok: false as const, reason: "invalid" as const };
  if (p.confirmedAt) return { ok: false as const, reason: "used" as const };
  if (p.cancelledAt) return { ok: false as const, reason: "cancelled" as const };
  if (Date.parse(p.expiresAt) <= deps.now()) return { ok: false as const, reason: "expired" as const };
  return { ok: true as const, proposal: p };
}

/** A página de confirmação mostra a que conta do dashboard vai ligar ANTES de confirmar. */
export async function viewProposal(deps: SharedIdentityDeps, token: string): Promise<ProposalView> {
  const r = await openProposal(deps, token);
  if (!r.ok) return r;
  const user = await deps.store.userById(r.proposal.userId);
  return { ok: true, dashName: user ? name(user) : `#${r.proposal.userId}`, sharedEmail: r.proposal.sharedEmail, expiresAt: r.proposal.expiresAt };
}

export type ConfirmOutcome = { ok: true } | { ok: false; reason: "invalid" | "expired" | "used" | "cancelled" | "taken" | "linked_elsewhere" | "inactive_shared" | "changed" | "unavailable" };

/** Clique no email: prova a caixa da conta Multipark (o lado do dashboard é a decisão do admin). */
export async function confirmProposal(deps: SharedIdentityDeps, token: string): Promise<ConfirmOutcome> {
  const r = await openProposal(deps, token);
  if (!r.ok) return r;
  const p = r.proposal;
  let shared: SharedUser | null;
  try {
    shared = await deps.client.userById(p.sharedUserId);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (!shared) return { ok: false, reason: "changed" };
  if (normalizeEmail(shared.email) !== normalizeEmail(p.sharedEmail)) return { ok: false, reason: "changed" };
  const linked = await linkAccount(deps, { userId: p.userId, shared, method: "proposal", actorId: p.proposedById, note: `proposta #${p.id} confirmada no email` });
  if (!linked.ok) return { ok: false, reason: linked.reason === "missing_user" ? "invalid" : linked.reason };
  await deps.store.confirmProposal(p.id, deps.now());
  return { ok: true };
}

// ─── L4: criar a conta Multipark ────────────────────────────────────────────

export type CreateOutcome =
  | { ok: true; sharedEmail: string; setPasswordEmailSent: boolean }
  | { ok: false; reason: "no_email" | "exists" | "already_linked" | "missing_user" | "taken" | "unavailable" | "not_configured" };

/** "A",  "Ana Maria Silva" → { firstName: "Ana Maria", lastName: "Silva" }. PURA. */
export function splitName(full: string | null | undefined, fallback: string): { firstName: string; lastName: string } {
  const parts = String(full ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: fallback, lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

export async function createSharedAccountFor(
  deps: SharedIdentityDeps,
  input: { userId: number; actorId: number; lang?: string },
): Promise<CreateOutcome> {
  if (!deps.client.configured) return { ok: false, reason: "not_configured" };
  const user = await deps.store.userById(input.userId);
  if (!user) return { ok: false, reason: "missing_user" };
  if (user.sharedUserId) return { ok: false, reason: "already_linked" };
  const email = normalizeEmail(user.email);
  if (!email) return { ok: false, reason: "no_email" };
  let r: Awaited<ReturnType<SharedIdentityDeps["client"]["createAccount"]>>;
  try {
    r = await deps.client.createAccount({ email, ...splitName(user.name, email.split("@")[0]), sendSetPasswordEmail: true, lang: input.lang ?? "pt" });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  // Já havia conta Multipark com este email: não se liga sozinha (pode não ser
  // esta pessoa) — usa-se L2 (proposta confirmada no email) ou L1.
  if (!r.created) return { ok: false, reason: "exists" };
  const linked = await linkAccount(deps, { userId: user.id, shared: r.user, method: "created", actorId: input.actorId });
  if (!linked.ok) return { ok: false, reason: linked.reason === "taken" ? "taken" : "unavailable" };
  return { ok: true, sharedEmail: r.user.email, setPasswordEmailSent: r.setPasswordEmailSent };
}

// ─── A: backfill pelos agentes da ficha ─────────────────────────────────────

export interface BackfillReport {
  checked: number;
  linked: Array<{ userId: number; sharedUserId: string }>;
  candidates: Array<{ userId: number; sharedUserId: string }>;
  /** A ficha aponta para uma conta Multipark com OUTRO email — manual (categoria E/C). */
  mismatches: Array<{ userId: number; sharedUserId: string }>;
  errors: number;
}

/**
 * Categoria A do plano: a ficha da pessoa já aponta para o agente Multipark X
 * (= conta be-shared X) E o email da conta X é o da conta do dashboard. Só
 * então liga. `dryRun` (por omissão) só conta.
 */
export async function backfillConfirmed(deps: SharedIdentityDeps, input: { actorId: number; dryRun: boolean; limit?: number }): Promise<BackfillReport> {
  const report: BackfillReport = { checked: 0, linked: [], candidates: [], mismatches: [], errors: 0 };
  if (!deps.client.configured) return report;
  const users = (await deps.store.listUsers()).filter((u) => u.isActive === 1 && !u.sharedUserId && u.email).slice(0, input.limit ?? 5000);
  for (const user of users) {
    const agentIds = await deps.store.agentIdsOfUser(user.id).catch(() => [] as string[]);
    if (agentIds.length === 0) continue;
    report.checked++;
    const matches: SharedUser[] = [];
    for (const id of agentIds.slice(0, 5)) {
      try {
        const shared = await deps.client.userById(id);
        if (!shared) continue;
        if (normalizeEmail(shared.email) === normalizeEmail(user.email)) matches.push(shared);
        else report.mismatches.push({ userId: user.id, sharedUserId: shared.id });
      } catch {
        report.errors++;
      }
    }
    const unique = [...new Map(matches.map((m) => [m.id, m])).values()];
    if (unique.length !== 1) continue;
    report.candidates.push({ userId: user.id, sharedUserId: unique[0].id });
    if (!input.dryRun) {
      const r = await linkAccount(deps, { userId: user.id, shared: unique[0], method: "agent_confirmed", actorId: input.actorId });
      if (r.ok && !r.already) report.linked.push({ userId: user.id, sharedUserId: unique[0].id });
    }
  }
  await deps.store.log({ userId: input.actorId, action: "identity_backfill", entityId: null, details: `Ligação pelos agentes (${input.dryRun ? "simulação" : "aplicada"}): ${report.checked} com agente, ${report.candidates.length} confirmadas, ${report.linked.length} ligadas, ${report.mismatches.length} com email diferente, ${report.errors} erros` });
  return report;
}

// ─── F3: entrar com a conta Multipark ───────────────────────────────────────

export type SharedLoginResolution =
  | { kind: "ok"; account: DashUserRow; session: SharedSession; linkedNow: boolean }
  | { kind: "access_requested"; session: SharedSession };

/**
 * Depois de o be-shared aceitar a palavra-passe: que conta do dashboard é?
 *   1. a ligada por `sharedUserId`;
 *   2. senão, se o be-shared diz que o email está CONFIRMADO e há exatamente uma
 *      conta ativa sem ligação com esse email (exato, sem variantes Gmail) → liga;
 *   3. senão → pedido de acesso (L5) para um admin decidir. Sem sessão no dashboard.
 */
export async function resolveSharedLogin(deps: SharedIdentityDeps, session: SharedSession): Promise<SharedLoginResolution> {
  const shared = session.user;
  const linked = await deps.store.userBySharedId(shared.id);
  if (linked) return { kind: "ok", account: linked, session, linkedNow: false };

  if (shared.emailVerifiedAt) {
    const candidates = (await deps.store.unlinkedUsersByEmail(shared.email)).filter((u) => u.isActive === 1);
    if (candidates.length === 1) {
      const r = await linkAccount(deps, { userId: candidates[0].id, shared, method: "email_verified", actorId: candidates[0].id });
      if (r.ok) {
        const account = await deps.store.userById(candidates[0].id);
        if (account) return { kind: "ok", account, session, linkedNow: true };
      }
    }
  }

  await deps.store.upsertAccessRequest({ sharedUserId: shared.id, email: shared.email, name: sharedDisplayName(shared), now: deps.now() });
  await deps.store.log({ userId: 0, action: "access_request", entityId: null, details: `Pedido de acesso ao dashboard da conta Multipark ${shared.id} (@${emailDomain(shared.email)})` });
  return { kind: "access_requested", session };
}

// ─── L5: decidir um pedido de acesso ────────────────────────────────────────

export type DecideOutcome = { ok: true; userId: number | null } | { ok: false; reason: "missing" | "decided" | "taken" | "linked_elsewhere" | "missing_user" | "inactive_shared" | "unavailable" };

export async function decideAccessRequest(
  deps: SharedIdentityDeps,
  input: { requestId: number; actorId: number; decision: "approve_existing" | "approve_new" | "reject"; userId?: number },
): Promise<DecideOutcome> {
  const req = await deps.store.accessRequestById(input.requestId);
  if (!req) return { ok: false, reason: "missing" };
  if (req.status !== "pending") return { ok: false, reason: "decided" };
  const now = deps.now();

  if (input.decision === "reject") {
    await deps.store.decideAccessRequest(req.id, { status: "rejected", decidedById: input.actorId, userId: null, now });
    await deps.store.log({ userId: input.actorId, action: "access_request_rejected", entityId: null, details: `Pedido de acesso #${req.id} recusado (conta Multipark ${req.sharedUserId})` });
    return { ok: true, userId: null };
  }

  let shared: SharedUser | null;
  try {
    shared = await deps.client.userById(req.sharedUserId);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (!shared) return { ok: false, reason: "inactive_shared" };

  let userId = input.userId ?? null;
  if (input.decision === "approve_new") {
    // Conta nova com o papel mais baixo (`user`): as permissões dão-se depois, como sempre.
    userId = await deps.createDashUser({ name: sharedDisplayName(shared), email: shared.email });
  }
  if (!userId) return { ok: false, reason: "missing_user" };

  const linked = await linkAccount(deps, { userId, shared, method: "access_request", actorId: input.actorId, note: `pedido #${req.id} aprovado` });
  if (!linked.ok) return { ok: false, reason: linked.reason };
  await deps.store.decideAccessRequest(req.id, { status: "approved", decidedById: input.actorId, userId, now });
  await deps.store.log({ userId: input.actorId, action: "access_request_approved", entityId: userId, details: `Pedido de acesso #${req.id} aprovado → conta #${userId}` });
  return { ok: true, userId };
}

// ─── Dependências reais ─────────────────────────────────────────────────────

export async function realSharedIdentityDeps(): Promise<SharedIdentityDeps> {
  const [{ sharedIdentityStore }, { sharedAuth }] = await Promise.all([import("./sharedIdentityStore"), import("./_core/sharedAuth")]);
  const store = sharedIdentityStore();
  return {
    store,
    client: sharedAuth(),
    now: () => Date.now(),
    async sendProposalEmail(input) {
      try {
        const [{ sendEmailDetailed }, { LOGIN_CODE_SENDER }, { LOGIN_MAIL_HEADER }, { loginStore }] = await Promise.all([
          import("./mail/systemMail"), import("@shared/loginCode"), import("@shared/mail"), import("./loginStore"),
        ]);
        // Como o código de entrada: sai da acesso@ e nunca de uma caixa da Comunicação.
        if (await loginStore().isMailboxAddress(LOGIN_CODE_SENDER).catch(() => true)) return false;
        const text = [
          "Olá,",
          "",
          `${input.proposedBy} quer ligar a tua conta Multipark (${input.to}) à conta do dashboard Multipark de: ${input.dashName}.`,
          "Depois de ligada, entras no dashboard com o email e a palavra-passe da tua conta Multipark.",
          "",
          "Se és tu, abre o link e confirma (válido 72 horas):",
          input.link,
          "",
          "Se não és esta pessoa ou não esperavas isto, ignora este email — nada muda.",
          "",
          "Equipa Multipark",
        ].join("\n");
        const r = await sendEmailDetailed({
          to: input.to, subject: "Liga a tua conta Multipark ao dashboard", text, kind: "system",
          account: LOGIN_CODE_SENDER, fromName: "Multipark", headers: { [LOGIN_MAIL_HEADER]: "1" },
        } as any);
        return !!r.ok;
      } catch (err) {
        console.warn("[SharedAuth] email da proposta não saiu:", String((err as Error)?.message ?? err).slice(0, 160));
        return false;
      }
    },
    userHasFicha: (userId) => store.hasFicha(userId),
    async createDashUser(input) {
      const { createManualUser } = await import("./db");
      const u = await createManualUser({ name: input.name, email: input.email, role: "user" });
      if (!u?.id) throw new Error("Conta não criada");
      return u.id;
    },
  };
}
