/**
 * Plano 05 — rotas da identidade partilhada (conta Multipark / be-shared).
 *
 *  - da própria pessoa: `sharedIdentity.me`, `sharedIdentity.linkWithPassword` (L1);
 *  - públicas: `sharedIdentity.proposal.view/confirm` (L2, o link do email);
 *  - SÓ super admin (ligar contas dá acesso — um admin não pode ligar a sua
 *    conta Multipark a uma conta mais alta): `sharedIdentity.admin.*`.
 * Tudo atrás de SHARED_AUTH_LINK ou SHARED_AUTH_LOGIN (desligados por omissão).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { sharedRefusal } from "@shared/sharedIdentity";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { assertSameOriginJson } from "./loginRouter";
import type { TrpcContext } from "./_core/context";

type Req = TrpcContext["req"];

async function flagsOn(): Promise<{ link: boolean; login: boolean }> {
  const { ensureFeatureFlagOverrides } = await import("./_core/featureFlags");
  await ensureFeatureFlagOverrides();
  const { sharedLinkEnabled, sharedLoginEnabled } = await import("./sharedIdentity");
  return { link: sharedLinkEnabled(), login: sharedLoginEnabled() };
}

async function requireFeature(): Promise<void> {
  const f = await flagsOn();
  if (!f.link && !f.login) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A ligação à conta Multipark ainda não está ligada." });
}

const superAdminProcedure = adminProcedure.use(async ({ ctx, next }) => {
  if (ctx.user?.role !== "super_admin") throw new TRPCError({ code: "FORBIDDEN", message: "Só o super admin liga contas Multipark." });
  return next();
});

const refuse = (reason: string): never => {
  throw new TRPCError({ code: "BAD_REQUEST", message: sharedRefusal(reason) });
};

function originOf(req: Req): string {
  const h = (req?.headers ?? {}) as Record<string, string | string[] | undefined>;
  const one = (v: string | string[] | undefined) => String((Array.isArray(v) ? v[0] : v) ?? "").split(",")[0].trim();
  const proto = one(h["x-forwarded-proto"]) || "https";
  const host = one(h["x-forwarded-host"]) || one(h.host);
  return host ? `${proto}://${host}` : "";
}

function metaOf(req: Req) {
  const h = (req?.headers ?? {}) as Record<string, string | string[] | undefined>;
  const fwd = String(h["x-forwarded-for"] ?? "").split(",")[0].trim();
  const ua = h["user-agent"];
  return { ip: fwd || (req as any)?.ip || null, userAgent: typeof ua === "string" ? ua.slice(0, 400) : null };
}

const TOKEN = z.string().min(20).max(128).regex(/^[A-Za-z0-9_-]+$/);

export const sharedIdentityRouter = router({
  /** Cartão "Conta Multipark" no perfil. */
  me: protectedProcedure.query(async ({ ctx }) => {
    const f = await flagsOn();
    const [{ sharedIdentityStore }, { sharedAuth }] = await Promise.all([import("./sharedIdentityStore"), import("./_core/sharedAuth")]);
    const row = f.link || f.login ? await sharedIdentityStore().userById(ctx.user.id).catch(() => null) : null;
    return {
      enabled: (f.link || f.login) && sharedAuth().configured,
      loginEnabled: f.login,
      linked: !!row?.sharedUserId,
      linkMethod: row?.sharedLinkMethod ?? null,
      linkedAt: row?.sharedLinkedAt ?? null,
    };
  }),

  /** L1: a pessoa (com sessão no dashboard) prova a conta Multipark com email + palavra-passe. */
  linkWithPassword: protectedProcedure
    .input(z.object({ email: z.string().trim().min(3).max(320), password: z.string().min(1).max(256) }))
    .mutation(async ({ ctx, input }) => {
      assertSameOriginJson(ctx.req);
      await requireFeature();
      const { linkWithPassword, realSharedIdentityDeps } = await import("./sharedIdentity");
      const r = await linkWithPassword(await realSharedIdentityDeps(), { userId: ctx.user.id, email: input.email, password: input.password, meta: metaOf(ctx.req) });
      if (!r.ok) refuse(r.reason);
      return { ok: true as const, sharedEmail: (r as { sharedEmail: string }).sharedEmail };
    }),

  /** L2: o link do email (página /ligar-conta-multipark/:token). */
  proposal: router({
    view: publicProcedure.input(z.object({ token: TOKEN })).query(async ({ input }) => {
      await requireFeature();
      const { viewProposal, realSharedIdentityDeps } = await import("./sharedIdentity");
      const r = await viewProposal(await realSharedIdentityDeps(), input.token);
      return r.ok ? r : { ok: false as const, reason: r.reason, message: sharedRefusal(r.reason) };
    }),
    confirm: publicProcedure.input(z.object({ token: TOKEN })).mutation(async ({ ctx, input }) => {
      assertSameOriginJson(ctx.req);
      await requireFeature();
      const { confirmProposal, realSharedIdentityDeps } = await import("./sharedIdentity");
      const r = await confirmProposal(await realSharedIdentityDeps(), input.token);
      if (!r.ok) refuse(r.reason);
      return { ok: true as const };
    }),
  }),

  admin: router({
    /** Ecrã "Identidade partilhada": todas as contas, ligadas ou não, + propostas abertas + pedidos. */
    overview: superAdminProcedure.query(async () => {
      const f = await flagsOn();
      const [{ sharedIdentityStore }, { sharedAuth }] = await Promise.all([import("./sharedIdentityStore"), import("./_core/sharedAuth")]);
      const store = sharedIdentityStore();
      const [users, proposals, requests] = await Promise.all([
        store.listUsers().catch(() => []),
        store.openProposals().catch(() => []),
        store.accessRequests("pending").catch(() => []),
      ]);
      const openByUser = new Map(proposals.map((p) => [p.userId, p]));
      return {
        flags: f,
        configured: sharedAuth().configured,
        users: users.map((u) => ({
          id: u.id, name: u.name, email: u.email, role: u.role, isActive: u.isActive === 1, hasFicha: u.hasFicha,
          lastSignedIn: u.lastSignedIn, sharedUserId: u.sharedUserId, linkMethod: u.sharedLinkMethod, linkedAt: u.sharedLinkedAt,
          proposal: openByUser.has(u.id) ? { sharedEmail: openByUser.get(u.id)!.sharedEmail, expiresAt: openByUser.get(u.id)!.expiresAt } : null,
        })),
        pendingRequests: requests.length,
      };
    }),

    /** L2: propor a ligação a uma conta Multipark (a pessoa confirma no email dessa conta). */
    propose: superAdminProcedure
      .input(z.object({ userId: z.number().int().positive(), sharedEmail: z.string().trim().min(3).max(320) }))
      .mutation(async ({ ctx, input }) => {
        await requireFeature();
        const { proposeLink, realSharedIdentityDeps } = await import("./sharedIdentity");
        const origin = originOf(ctx.req);
        if (!origin) refuse("unavailable");
        const r = await proposeLink(await realSharedIdentityDeps(), { userId: input.userId, sharedEmail: input.sharedEmail, actor: { id: ctx.user.id, name: ctx.user.name ?? null }, origin });
        if (!r.ok) refuse(r.reason);
        return r as { ok: true; sharedEmail: string; expiresAt: string };
      }),

    /** L4: criar a conta Multipark desta pessoa (só se não existir) e ligá-la. */
    createAccount: superAdminProcedure
      .input(z.object({ userId: z.number().int().positive(), lang: z.enum(["pt", "en", "es", "fr", "it"]).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireFeature();
        const { createSharedAccountFor, realSharedIdentityDeps } = await import("./sharedIdentity");
        const r = await createSharedAccountFor(await realSharedIdentityDeps(), { userId: input.userId, actorId: ctx.user.id, lang: input.lang });
        if (!r.ok) refuse(r.reason);
        return r as { ok: true; sharedEmail: string; setPasswordEmailSent: boolean };
      }),

    /** Desligar: as sessões da pessoa caem (sessionVersion). */
    unlink: superAdminProcedure
      .input(z.object({ userId: z.number().int().positive(), reason: z.string().max(300).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireFeature();
        const { unlinkAccount, realSharedIdentityDeps } = await import("./sharedIdentity");
        const done = await unlinkAccount(await realSharedIdentityDeps(), { userId: input.userId, actorId: ctx.user.id, reason: input.reason });
        if (done) {
          const { bumpSessionVersion } = await import("./appSettings");
          await bumpSessionVersion(input.userId).catch(() => undefined);
        }
        return { ok: done };
      }),

    /** A: liga quem tem a ficha a apontar para a conta Multipark com o MESMO email. Simulação por omissão. */
    backfill: superAdminProcedure
      .input(z.object({ dryRun: z.boolean().default(true) }))
      .mutation(async ({ ctx, input }) => {
        await requireFeature();
        const { backfillConfirmed, realSharedIdentityDeps } = await import("./sharedIdentity");
        return backfillConfirmed(await realSharedIdentityDeps(), { actorId: ctx.user.id, dryRun: input.dryRun });
      }),

    /** L5: pedidos de acesso. */
    accessRequests: superAdminProcedure
      .input(z.object({ status: z.enum(["pending", "approved", "rejected", "all"]).default("pending") }))
      .query(async ({ input }) => {
        const { sharedIdentityStore } = await import("./sharedIdentityStore");
        return sharedIdentityStore().accessRequests(input.status).catch(() => []);
      }),

    decideAccessRequest: superAdminProcedure
      .input(z.object({
        requestId: z.number().int().positive(),
        decision: z.enum(["approve_existing", "approve_new", "reject"]),
        userId: z.number().int().positive().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        await requireFeature();
        if (input.decision === "approve_existing" && !input.userId) refuse("missing_user");
        const { decideAccessRequest, realSharedIdentityDeps } = await import("./sharedIdentity");
        let r;
        try {
          r = await decideAccessRequest(await realSharedIdentityDeps(), { requestId: input.requestId, actorId: ctx.user.id, decision: input.decision, userId: input.userId });
        } catch (err) {
          throw new TRPCError({ code: "BAD_REQUEST", message: String((err as Error)?.message ?? err).slice(0, 200) });
        }
        if (!r.ok) refuse(r.reason);
        return r as { ok: true; userId: number | null };
      }),
  }),
});
