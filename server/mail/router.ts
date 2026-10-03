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
import { googleContactsRouter } from "../contactsRouter";
import {
  MAIL_LINK_TYPES, MAIL_THREAD_STATUSES, mailAliasRowSchema, mailboxConfigSchema, userIdOfAccountKey, type MailViewer,
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
    const { can } = await import("../../shared/access");
    // 17f: a lista da Comunicação junta as conversas de WhatsApp da caixa (quem tem o WhatsApp).
    return { ...boxes, google, others, slaHours: await slaHours(), isSuperAdmin: v.role === "super_admin", canWhatsapp: can(v as any, "whatsapp", "view") };
  }),

  badge: protectedProcedure.query(async ({ ctx }) => {
    // Falha = erro (o menu mostra "?"), nunca "0 por ler" (17d).
    const { mailBadge } = await import("./inbox");
    return mailBadge(viewerOf(ctx.user as CtxUser));
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
        showAutomatic: z.boolean().optional(),
        /** Arquivo da retenção (+5 anos, sem ligação) — só o super admin. */
        archived: z.boolean().optional(),
        page: z.number().int().min(1).max(500).optional(),
        pageSize: z.number().int().min(10).max(100).optional(),
      }))
      .query(async ({ ctx, input }) => {
        sharedGate(ctx.user as CtxUser, input.mailbox);
        const { listThreads } = await import("./inbox");
        return listThreads(viewerOf(ctx.user as CtxUser), input);
      }),
    get: protectedProcedure.input(threadId.extend({ showImages: z.boolean().optional(), showArchived: z.boolean().optional() })).query(async ({ ctx, input }) => {
      const { getThread } = await import("./inbox");
      return getThread(viewerOf(ctx.user as CtxUser), input.id, { showImages: input.showImages, showArchived: input.showArchived });
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
    assignees: protectedProcedure.input(z.object({ mailbox: z.string().min(1).max(40), threadId: z.number().int().positive().nullish() })).query(async ({ ctx, input }) => {
      sharedGate(ctx.user as CtxUser, input.mailbox);
      const { assigneesFor } = await import("./inbox");
      return assigneesFor(viewerOf(ctx.user as CtxUser), input.mailbox, input.threadId ?? null);
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
    /** "Mover para…" outra caixa (17f): quem trata a conversa e vê o destino. */
    move: protectedProcedure.input(threadId.extend({ box: z.string().min(1).max(40) })).mutation(async ({ ctx, input }) => {
      const { moveThread } = await import("./inbox");
      await moveThread(viewerOf(ctx.user as CtxUser), input.id, input.box);
      return { ok: true };
    }),
    /** "Por classificar" → caixa (admin/super_admin): opcionalmente pelo alias e acrescentando um endereço novo à tabela. */
    assignTriage: protectedProcedure
      .input(threadId.extend({
        mailbox: z.string().min(1).max(40),
        alias: z.string().trim().max(320).nullish(),
        addAlias: z.string().trim().max(320).nullish(),
      }))
      .mutation(async ({ ctx, input }) => {
        adminOnly(ctx.user as CtxUser);
        const { assignTriagedThread } = await import("./inbox");
        return assignTriagedThread(viewerOf(ctx.user as CtxUser), input.id, input);
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
      attachments: z.array(z.object({ key: z.string().max(300), filename: z.string().max(200), contentType: z.string().max(120), ticket: z.string().max(64).nullish() })).max(10).default([]),
      includeOriginalAttachments: z.boolean().optional(),
      /** Código do envio (o editor gera um por mensagem): carregar outra vez nunca manda 2 emails. */
      clientRequestId: z.string().max(64).nullish(),
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
      const mailboxes = await listMailboxes({ fresh: true });
      const { aliasTableOf } = await import("../../shared/mail");
      const { systemSenderAddress } = await import("./systemMail");
      const { getProjects } = await import("../db");
      const cities = (await getProjects().catch(() => [] as any[])).filter((p: any) => p.level === "city").map((p: any) => ({ id: Number(p.id), name: String(p.name) }));
      const staff = rowsOf(await d.execute(sql`SELECT id, name, role FROM users WHERE isActive = 1
        AND role IN ('team_leader','supervisor','frontoffice','backoffice','admin','super_admin') ORDER BY name LIMIT 500`))
        .map((r) => ({ id: Number(r.id), name: String(r.name ?? `#${r.id}`), role: String(r.role) }));
      const { mailRoutingWarningsNow } = await import("../integrationsStatus");
      return {
        canEdit: (ctx.user as CtxUser).role === "super_admin",
        /** A tabela de aliases e o remetente de sistema: admin e super_admin. */
        canEditAliases: true,
        mailboxes,
        aliases: aliasTableOf(mailboxes),
        cities,
        staff,
        systemSender: await systemSenderAddress(),
        routingWarnings: await mailRoutingWarningsNow().catch(() => [] as string[]),
        accounts: (await listMailAccountRows()).map((a) => ({ ...a, ownerUserId: userIdOfAccountKey(a.accountKey) })),
        pipelineFailures: await (await import("./service")).listPipelineFailures(),
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
    /** "Desativar" (17d): a caixa deixa de sincronizar e sai das listas; as conversas ficam (o super admin continua a vê-las). Nada se apaga. */
    deactivate: protectedProcedure.input(z.object({ key: z.string().min(1).max(40) })).mutation(async ({ ctx, input }) => {
      superOnly(ctx.user as CtxUser);
      const { setMailboxActive } = await import("./store");
      if (!(await setMailboxActive(input.key, false, ctx.user.id))) throw new TRPCError({ code: "NOT_FOUND", message: "Caixa não encontrada." });
      try {
        const { logActivity } = await import("../db");
        await logActivity({ userId: ctx.user.id, action: "update", entity: "mail_mailbox", entityId: null, details: `Caixa ${input.key} desativada` } as any);
      } catch { /* registo */ }
      return { ok: true };
    }),
    /** Emails que deviam ter criado um caso e falharam (17d): voltar a tentar já. */
    retryPipeline: protectedProcedure.input(z.object({ messageId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      adminOnly(ctx.user as CtxUser);
      const { retryPipelineMessage } = await import("./service");
      return retryPipelineMessage(input.messageId, { manual: true });
    }),
    /** Tabela de encaminhamento por alias (admin/super_admin): substitui os endereços das caixas. */
    saveAliases: protectedProcedure
      .input(z.object({ rows: z.array(mailAliasRowSchema).max(2000) }))
      .mutation(async ({ ctx, input }) => {
        adminOnly(ctx.user as CtxUser);
        const { listMailboxes, saveMailbox } = await import("./store");
        const { applyAliasTable } = await import("../../shared/mail");
        const current = await listMailboxes({ fresh: true });
        const r = applyAliasTable(current, input.rows);
        if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: r.error });
        for (const m of r.changed) {
          const { id: _id, updatedAt: _u, ...cfg } = m;
          const parsed = mailboxConfigSchema.safeParse(cfg);
          if (!parsed.success) throw new TRPCError({ code: "BAD_REQUEST", message: `Caixa "${m.label}": ${parsed.error.issues[0]?.message ?? "inválida"}` });
          await saveMailbox(parsed.data, ctx.user.id);
        }
        try {
          const { logActivity } = await import("../db");
          await logActivity({ userId: ctx.user.id, action: "update", entity: "mail_aliases", entityId: null, details: `Tabela de aliases: ${input.rows.length} linha(s); caixas alteradas: ${r.changed.map((m) => m.key).join(", ") || "nenhuma"}` } as any);
        } catch { /* registo */ }
        return { ok: true, changed: r.changed.length };
      }),
    /** Remetente dos emails de sistema (Gmail API) — só o super admin (20b, decisão do Jorge). */
    setSystemSender: protectedProcedure
      .input(z.object({ email: z.string().trim().toLowerCase().email("Email inválido.").max(320) }))
      .mutation(async ({ ctx, input }) => {
        adminOnly(ctx.user as CtxUser);
        if (ctx.user.role !== "super_admin") throw new TRPCError({ code: "FORBIDDEN", message: "Só o super admin muda o remetente dos emails de sistema." });
        const { systemSenderAddress } = await import("./systemMail");
        const before = await systemSenderAddress().catch(() => null);
        const { setSetting } = await import("../appSettings");
        const r = await setSetting("mail.systemSender", input.email, ctx.user.id);
        if (r.changed) {
          try {
            const { logActivity } = await import("../db");
            await logActivity({ userId: ctx.user.id, action: "update", entity: "app_setting", entityId: null, details: `Remetente dos emails de sistema: ${before ?? "—"} → ${input.email}` } as any);
          } catch { /* registo */ }
        }
        return { ok: true };
      }),
    /** Testa o remetente (delegação + "Enviar como") e envia um email de teste ao próprio. */
    testSystemSender: protectedProcedure.mutation(async ({ ctx }) => {
      adminOnly(ctx.user as CtxUser);
      const { testSystemSender, sendEmailDetailed } = await import("./systemMail");
      let message: string;
      try { message = await testSystemSender(); } catch (err: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: String(err?.message ?? err).slice(0, 300) });
      }
      const to = String((ctx.user as any).email ?? "").trim();
      if (!to) return { ok: true, message, sentTo: null };
      const r = await sendEmailDetailed({
        to, subject: "Teste do envio de email (Gmail) — Dashboard Multipark",
        text: "Este é um email de teste enviado pela API do Gmail a partir de Definições → Comunicação.",
        html: "<p>Este é um email de teste enviado pela API do Gmail a partir de Definições → Comunicação.</p>",
        kind: "system",
      });
      if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: `A delegação está OK mas o envio falhou: ${r.error ?? "erro"}` });
      return { ok: true, message, sentTo: to };
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
  /** Contactos Google (Perfil → Google): estado, preferências, sincronizar. */
  contacts: googleContactsRouter,
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
