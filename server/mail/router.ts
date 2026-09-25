/**
 * tRPC: `mail.*` (Comunicação) e `googleAccount.*` (ligar a conta Google).
 * As regras de quem vê o quê estão em shared/mail.ts e server/mail/inbox.ts;
 * aqui só validação de input e as verificações de papel da configuração.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { requireAccess, withOverrides } from "../_core/access";
import { googleSyncRouter } from "../google/router";
import {
  MAIL_LINK_TYPES, MAIL_THREAD_STATUSES, mailboxConfigSchema, userIdOfAccountKey, type MailViewer,
} from "../../shared/mail";

type CtxUser = { id: number; role: string; accessOverrides?: any };
const viewerOf = (u: CtxUser): MailViewer => {
  const w = withOverrides(u);
  return { id: w.id, role: w.role, accessOverrides: w.accessOverrides ?? null };
};
const sharedGate = (u: CtxUser, mailbox: string | null | undefined) => {
  // Caixas partilhadas passam pela matriz (ajusta a cidade de quem tem overrides);
  // "O meu email" não depende do módulo.
  if (mailbox && mailbox !== "me") requireAccess(u, "comunicacao", "view");
};
const superOnly = (u: CtxUser) => {
  if (u.role !== "super_admin") throw new TRPCError({ code: "FORBIDDEN", message: "Só o super admin configura as caixas de email." });
};
const adminOnly = (u: CtxUser) => {
  if (!["admin", "super_admin"].includes(u.role)) throw new TRPCError({ code: "FORBIDDEN", message: "Acesso não autorizado." });
};

const threadId = z.object({ id: z.number().int().positive() });

export const mailRouter = router({
  overview: protectedProcedure.query(async ({ ctx }) => {
    const v = viewerOf(ctx.user as CtxUser);
    const { visibleMailboxes } = await import("./inbox");
    const { googleAccountSummary } = await import("../google/userAccounts");
    const [boxes, google] = await Promise.all([visibleMailboxes(v), googleAccountSummary(v.id)]);
    let others: Array<{ userId: number; name: string; email: string }> = [];
    if (v.role === "super_admin") {
      const { db, rowsOf } = await import("./store");
      const { sql } = await import("drizzle-orm");
      const d = await db();
      others = rowsOf(await d.execute(sql`SELECT g.userId, g.email, u.name FROM google_user_accounts g JOIN users u ON u.id = g.userId
        WHERE g.status <> 'disconnected' AND g.userId <> ${v.id} ORDER BY u.name LIMIT 300`))
        .map((r) => ({ userId: Number(r.userId), name: String(r.name ?? r.email), email: String(r.email) }));
    }
    return { ...boxes, google, others, slaHours: await slaHours() };
  }),

  badge: protectedProcedure.query(async ({ ctx }) => {
    const { mailBadge } = await import("./inbox");
    try { return await mailBadge(viewerOf(ctx.user as CtxUser)); } catch { return { shared: 0, personal: 0 }; }
  }),

  threads: router({
    list: protectedProcedure
      .input(z.object({
        mailbox: z.string().min(1).max(40),
        ownerUserId: z.number().int().positive().nullish(),
        brand: z.string().max(16).nullish(),
        status: z.enum([...MAIL_THREAD_STATUSES, "all"]).nullish(),
        assigned: z.union([z.enum(["all", "me", "none"]), z.number().int().positive()]).nullish(),
        awaiting: z.boolean().optional(),
        unread: z.boolean().optional(),
        search: z.string().max(100).nullish(),
        page: z.number().int().min(1).max(500).optional(),
        pageSize: z.number().int().min(10).max(100).optional(),
      }))
      .query(async ({ ctx, input }) => {
        sharedGate(ctx.user as CtxUser, input.mailbox);
        const { listThreads } = await import("./inbox");
        return listThreads(viewerOf(ctx.user as CtxUser), input);
      }),
    get: protectedProcedure.input(threadId.extend({ showImages: z.boolean().optional() })).query(async ({ ctx, input }) => {
      const { getThread } = await import("./inbox");
      return getThread(viewerOf(ctx.user as CtxUser), input.id, { showImages: input.showImages });
    }),
    markRead: protectedProcedure.input(threadId.extend({ read: z.boolean() })).mutation(async ({ ctx, input }) => {
      const { markThreadRead } = await import("./inbox");
      await markThreadRead(viewerOf(ctx.user as CtxUser), input.id, input.read);
      return { ok: true };
    }),
    setStatus: protectedProcedure.input(threadId.extend({ status: z.enum(MAIL_THREAD_STATUSES) })).mutation(async ({ ctx, input }) => {
      const { setThreadStatus } = await import("./inbox");
      await setThreadStatus(viewerOf(ctx.user as CtxUser), input.id, input.status);
      return { ok: true };
    }),
    assign: protectedProcedure.input(threadId.extend({ userId: z.number().int().positive().nullable() })).mutation(async ({ ctx, input }) => {
      const { assignThread } = await import("./inbox");
      await assignThread(viewerOf(ctx.user as CtxUser), input.id, input.userId);
      return { ok: true };
    }),
    assignees: protectedProcedure.input(z.object({ mailbox: z.string().min(1).max(40) })).query(async ({ ctx, input }) => {
      sharedGate(ctx.user as CtxUser, input.mailbox);
      const { assigneesFor } = await import("./inbox");
      return assigneesFor(viewerOf(ctx.user as CtxUser), input.mailbox);
    }),
    link: protectedProcedure.input(threadId.extend({ type: z.enum(MAIL_LINK_TYPES), entityId: z.string().trim().min(1).max(320) })).mutation(async ({ ctx, input }) => {
      const { linkThread } = await import("./inbox");
      return linkThread(viewerOf(ctx.user as CtxUser), input.id, input.type, input.entityId);
    }),
    unlink: protectedProcedure.input(threadId.extend({ type: z.enum(MAIL_LINK_TYPES), entityId: z.string().trim().min(1).max(320) })).mutation(async ({ ctx, input }) => {
      const { unlinkThread } = await import("./inbox");
      await unlinkThread(viewerOf(ctx.user as CtxUser), input.id, input.type, input.entityId);
      return { ok: true };
    }),
    aiDraft: protectedProcedure.input(threadId).mutation(async ({ ctx, input }) => {
      const { aiDraft } = await import("./inbox");
      const r = await aiDraft(viewerOf(ctx.user as CtxUser), input.id);
      if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: r.error ?? "IA indisponível." });
      return { text: r.text! };
    }),
  }),

  send: protectedProcedure
    .input(z.object({
      mode: z.enum(["reply", "replyAll", "forward", "new"]),
      threadId: z.number().int().positive().nullish(),
      mailbox: z.string().max(40).nullish(),
      from: z.string().max(320).nullish(),
      to: z.array(z.string().max(320)).max(50),
      cc: z.array(z.string().max(320)).max(50).default([]),
      bcc: z.array(z.string().max(320)).max(50).default([]),
      subject: z.string().max(300).nullish(),
      body: z.string().min(1).max(100_000),
      attachments: z.array(z.object({ key: z.string().max(300), filename: z.string().max(200), contentType: z.string().max(120) })).max(10).default([]),
      includeOriginalAttachments: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (input.mode === "new") sharedGate(ctx.user as CtxUser, input.mailbox);
      const { sendMail } = await import("./inbox");
      return sendMail(viewerOf(ctx.user as CtxUser), input);
    }),

  timeline: protectedProcedure
    .input(z.object({ type: z.enum(MAIL_LINK_TYPES), id: z.string().trim().min(1).max(320) }))
    .query(async ({ ctx, input }) => {
      const { entityTimeline } = await import("./inbox");
      return entityTimeline(viewerOf(ctx.user as CtxUser), input.type, input.id);
    }),

  contacts: protectedProcedure.input(z.object({ q: z.string().max(60) })).query(async ({ ctx, input }) => {
    const { contactSuggestions } = await import("./inbox");
    return contactSuggestions(viewerOf(ctx.user as CtxUser), input.q);
  }),

  settings: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      adminOnly(ctx.user as CtxUser);
      const { listMailboxes, listMailAccountRows, db, rowsOf } = await import("./store");
      const { dwdConfigured, oauthConfigured, workspaceConfig } = await import("../google/workspace");
      const { sql } = await import("drizzle-orm");
      const d = await db();
      const googleUsers = rowsOf(await d.execute(sql`SELECT g.userId, g.email, g.status, u.name FROM google_user_accounts g JOIN users u ON u.id = g.userId
        WHERE g.status <> 'disconnected' ORDER BY u.name LIMIT 500`)).map((r) => ({ userId: Number(r.userId), email: String(r.email), status: String(r.status), name: String(r.name ?? r.email) }));
      const cfg = workspaceConfig();
      return {
        canEdit: (ctx.user as CtxUser).role === "super_admin",
        mailboxes: await listMailboxes({ fresh: true }),
        accounts: (await listMailAccountRows()).map((a) => ({ ...a, ownerUserId: userIdOfAccountKey(a.accountKey) })),
        googleUsers,
        env: {
          dwd: dwdConfigured(), oauth: oauthConfigured(), domains: cfg.domains,
          serviceAccountEmail: cfg.serviceAccount?.client_email ?? null,
          pushTopic: !!String(process.env.GMAIL_PUSH_TOPIC ?? "").trim(),
        },
      };
    }),
    save: protectedProcedure.input(mailboxConfigSchema).mutation(async ({ ctx, input }) => {
      superOnly(ctx.user as CtxUser);
      const { saveMailbox } = await import("./store");
      await saveMailbox(input, ctx.user.id);
      try {
        const { logActivity } = await import("../db");
        await logActivity({ userId: ctx.user.id, action: "update", entity: "mail_mailbox", entityId: null, details: `Caixa ${input.key}: ${input.addresses.map((a) => a.address).join(", ")}` } as any);
      } catch { /* registo */ }
      return { ok: true };
    }),
    remove: protectedProcedure.input(z.object({ key: z.string().min(1).max(40) })).mutation(async ({ ctx, input }) => {
      superOnly(ctx.user as CtxUser);
      const { deleteMailbox } = await import("./store");
      await deleteMailbox(input.key);
      try {
        const { logActivity } = await import("../db");
        await logActivity({ userId: ctx.user.id, action: "delete", entity: "mail_mailbox", entityId: null, details: `Caixa ${input.key} apagada` } as any);
      } catch { /* registo */ }
      return { ok: true };
    }),
    syncNow: protectedProcedure.mutation(async ({ ctx }) => {
      adminOnly(ctx.user as CtxUser);
      const { runMailSync } = await import("./service");
      return runMailSync({ deadlineAt: Date.now() + 40_000 });
    }),
  }),

  /** Sincronizar já a MINHA caixa pessoal (botão em "O meu email"). */
  syncMine: protectedProcedure.mutation(async ({ ctx }) => {
    const { runMailSync } = await import("./service");
    const { personalAccountKey } = await import("../../shared/mail");
    return runMailSync({ deadlineAt: Date.now() + 25_000, onlyAccountKey: personalAccountKey(ctx.user.id) });
  }),
});

async function slaHours(): Promise<number> {
  try {
    const { getSetting } = await import("../appSettings");
    return (await getSetting("sla.mailHours")) ?? 24;
  } catch { return 24; }
}

export const googleAccountRouter = router({
  /** Google Tarefas & Calendário (Perfil → Google): estado, preferências, sincronizar, livre/ocupado. */
  sync: googleSyncRouter,
  status: protectedProcedure.query(async ({ ctx }) => {
    const { googleAccountSummary } = await import("../google/userAccounts");
    return googleAccountSummary(ctx.user.id);
  }),
  disconnect: protectedProcedure.mutation(async ({ ctx }) => {
    const { disconnectGoogleAccount } = await import("../google/userAccounts");
    await disconnectGoogleAccount(ctx.user.id);
    try {
      const { logActivity } = await import("../db");
      await logActivity({ userId: ctx.user.id, action: "disconnect", entity: "google_account", entityId: null, details: "Conta Google desligada (token revogado)" } as any);
    } catch { /* registo */ }
    return { ok: true };
  }),
});
