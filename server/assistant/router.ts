/**
 * tRPC do assistente da equipa (`assistant.*`). Qualquer pessoa com sessão
 * pode usar a parte "como se usa"; as ferramentas de dados só existem para
 * quem tem o módulo, e correm os procedimentos já existentes como a própria
 * pessoa (mesmas cidades, mesmos acessos).
 *
 * Multis 2: `memory.*` (notas pessoais da própria pessoa; as da empresa só
 * admin/super_admin mexem, toda a gente lê) e `feedback.*` (👍/👎 só nas
 * respostas das próprias conversas; a lista "Perguntas que falharam" só
 * admin/super_admin). Nada se apaga.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { can, canSeeFinanceTotalsFor } from "../../shared/access";
import { assistantSuggestions } from "../../shared/assistant";
import { MEMORY_MAX_CHARS, MEMORY_MAX_COMPANY, MEMORY_MAX_PERSONAL, isMultisAdmin } from "../../shared/assistantMemory";
import { FEEDBACK_COMMENT_MAX, FEEDBACK_PERIODS, FEEDBACK_REASONS, FEEDBACK_STATUSES } from "../../shared/assistantFeedback";
import { protectedProcedure, router } from "../_core/trpc";
import { withOverrides } from "../_core/access";
import { cityScope } from "../cityScope";
import { selectProvider } from "../_core/ai/client";
import { CHAT_MESSAGES } from "../_core/ai/chat/engine";
import { deleteConversation, listConversations, loadMessages, resolveConversation } from "../_core/ai/chat/store";
import type { StaffToolCtx } from "./tools";
import { ASSISTANT_CHANNEL, ASSISTANT_FEATURE, askAssistant, assistantLimits, lisbonDay, ownerKeyFor, staffHelpDocs } from "./service";

type Ctx = { req: any; res: any; user: any; accessDenied?: boolean };

/** Contexto das ferramentas para a pessoa do pedido. */
async function toolCtxFor(ctx: Ctx): Promise<StaffToolCtx> {
  const user = withOverrides(ctx.user);
  const { getUserPermissionOverrides } = await import("../db");
  const perm = await getUserPermissionOverrides(user.id).catch(() => ({}));
  const financeAllowed = (can(user, "financeiro", "view") || can(user, "faturacao", "view")) && canSeeFinanceTotalsFor(user, perm);
  // Snapshot das cidades deste pedido; cada ferramenta volta a passar pelo
  // middleware (createCaller), que recalcula as cidades da pessoa.
  const access = cityScope.getStore();
  const call = async (path: string, input?: unknown) => {
    const { appRouter } = await import("../routers");
    const caller: any = appRouter.createCaller({ req: ctx.req, res: ctx.res, user: ctx.user, accessDenied: false } as any);
    const fn = path.split(".").reduce((o: any, k) => (o == null ? o : o[k]), caller);
    if (typeof fn !== "function") throw new Error(`procedimento desconhecido: ${path}`);
    return fn(input);
  };
  return { user, access, call, today: lisbonDay(), financeAllowed, helpDocs: staffHelpDocs() };
}

async function logToolCall(userId: number, name: string, args: Record<string, unknown>, conversationId: number | null) {
  try {
    const { logActivity } = await import("../db");
    await logActivity({
      userId,
      action: "assistant_tool",
      entity: "assistant",
      entityId: conversationId != null && conversationId <= 2_147_483_647 ? conversationId : null,
      details: JSON.stringify({ tool: name, params: args }).slice(0, 1000),
    });
  } catch { /* o registo nunca parte o chat */ }
}

export const assistantRouter = router({
  /** Pode usar? (para esconder/mostrar e dar a mensagem certa) + sugestões da página. */
  status: protectedProcedure
    .input(z.object({ path: z.string().max(200).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const { aiFeatureAvailableFresh } = await import("../_core/ai/status");
      const limits = await assistantLimits();
      const suggestions = assistantSuggestions(input?.path, withOverrides(ctx.user));
      // Multis 2: mostrar a Memória? e o link "Perguntas que falharam" (admins).
      const { assistantMemoryEnabled } = await import("./memory");
      const extra = { memoryEnabled: await assistantMemoryEnabled(), canReview: isMultisAdmin(ctx.user.role) };
      if (!(await aiFeatureAvailableFresh(ASSISTANT_FEATURE))) {
        const reason = selectProvider(process.env, ASSISTANT_FEATURE) ? "disabled" : "not_configured";
        return { available: false, reason, message: CHAT_MESSAGES[reason], maxInputChars: limits.maxInputChars, suggestions, ...extra };
      }
      try {
        const { budgetDecision, getMonthlyBudgetEur, monthSpendEur } = await import("../_core/ai/usage");
        if (budgetDecision(await monthSpendEur(), await getMonthlyBudgetEur(), false) === "blocked") {
          return { available: false, reason: "budget" as const, message: CHAT_MESSAGES.budget, maxInputChars: limits.maxInputChars, suggestions, ...extra };
        }
      } catch { /* sem BD: segue */ }
      return { available: true, reason: null, message: null, maxInputChars: limits.maxInputChars, suggestions, ...extra };
    }),

  /** Conversas dos últimos 30 dias. */
  conversations: protectedProcedure.query(async ({ ctx }) => listConversations(ASSISTANT_CHANNEL, ownerKeyFor(ctx.user.id))),

  /** Mensagens de uma conversa (omissão: a mais recente). */
  messages: protectedProcedure
    .input(z.object({ conversationId: z.number().int().positive().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const owner = ownerKeyFor(ctx.user.id);
      const { getDb } = await import("../db");
      if (!(await getDb())) return { conversationId: null, messages: [] };
      // Sem conversa pedida: a mais recente (sem criar uma nova só por abrir o painel).
      let id: number | null = input?.conversationId ?? null;
      if (!id) {
        const list = await listConversations(ASSISTANT_CHANNEL, owner, 1);
        id = list[0]?.id ?? null;
      } else {
        id = await resolveConversation(ASSISTANT_CHANNEL, owner, { conversationId: id });
      }
      if (!id) return { conversationId: null, messages: [] };
      const msgs = await loadMessages(ASSISTANT_CHANNEL, owner, id, 60);
      // 👍/👎 que a pessoa já deu a estas respostas.
      const { myRatings } = await import("./feedback");
      const rated = await myRatings(ctx.user.id, msgs.filter((m) => m.role === "assistant").map((m) => m.id));
      return {
        conversationId: id,
        messages: msgs.map((m) => ({ id: m.id, role: m.role, content: m.content, tools: m.tools, createdAt: m.createdAt, myRating: rated.get(m.id)?.rating ?? null })),
      };
    }),

  /** Pergunta ao assistente. Nunca lança por causa da IA: devolve `{ ok: false, message }`. */
  ask: protectedProcedure
    .input(z.object({
      question: z.string().max(8000),
      conversationId: z.number().int().positive().nullable().optional(),
      newConversation: z.boolean().optional(),
      path: z.string().max(200).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const toolCtx = await toolCtxFor(ctx as Ctx);
      return askAssistant(input, toolCtx, {
        logToolCall: (name, args, conversationId) => logToolCall(ctx.user.id, name, args, conversationId),
      });
    }),

  deleteConversation: protectedProcedure
    .input(z.object({ conversationId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => ({ ok: await deleteConversation(ASSISTANT_CHANNEL, ownerKeyFor(ctx.user.id), input.conversationId) })),

  // ─── Memória (Multis 2) ───────────────────────────────────────────────────
  memory: router({
    /** As minhas notas e as da empresa (desligada → enabled: false, listas vazias). */
    list: protectedProcedure.query(async ({ ctx }) => {
      const m = await import("./memory");
      const canManageCompany = isMultisAdmin(ctx.user.role);
      const limits = { maxChars: MEMORY_MAX_CHARS, personal: MEMORY_MAX_PERSONAL, company: MEMORY_MAX_COMPANY };
      if (!(await m.assistantMemoryEnabled())) {
        return { enabled: false, canManageCompany, limits, mine: [], mineArchived: [], company: [], companyArchived: [] };
      }
      const r = await m.listMemories(ctx.user.id, { withCompanyArchived: canManageCompany });
      return { enabled: true, canManageCompany, limits, ...r };
    }),

    add: protectedProcedure
      .input(z.object({ scope: z.enum(["user", "company"]), text: z.string().trim().min(1, "Escreve a nota.").max(MEMORY_MAX_CHARS, `Máximo ${MEMORY_MAX_CHARS} caracteres.`) }))
      .mutation(async ({ ctx, input }) => {
        const m = await import("./memory");
        await assertMemoryOn(m);
        if (input.scope === "company" && !isMultisAdmin(ctx.user.role)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Só os administradores mexem na memória da empresa." });
        }
        const r = await m.addMemory(input.scope, ctx.user.id, input.text);
        if (r.ok) return { ok: true as const, id: r.id };
        if (r.reason === "exists") throw new TRPCError({ code: "CONFLICT", message: "Essa nota já está guardada." });
        if (r.reason === "full") {
          throw new TRPCError({ code: "BAD_REQUEST", message: input.scope === "company"
            ? `A memória da empresa já tem ${MEMORY_MAX_COMPANY} notas. Arquiva alguma primeiro.`
            : `Já tens ${MEMORY_MAX_PERSONAL} notas. Arquiva alguma primeiro.` });
        }
        if (r.reason === "invalid") throw new TRPCError({ code: "BAD_REQUEST", message: `Escreve a nota (máximo ${MEMORY_MAX_CHARS} caracteres).` });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível guardar agora. Tenta outra vez." });
      }),

    /** Arquivar (nunca apaga). Pessoal: só a minha; da empresa: só admins. */
    archive: protectedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const m = await import("./memory");
        await assertMemoryOn(m);
        const note = await ownNoteOrThrow(m, input.id, ctx.user);
        const ok = await m.archiveMemory(note.id, ctx.user.id, note.scope);
        return { ok };
      }),

    /** "Desfazer" / "Repor" uma nota arquivada. */
    restore: protectedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const m = await import("./memory");
        await assertMemoryOn(m);
        const note = await ownNoteOrThrow(m, input.id, ctx.user);
        const r = await m.restoreMemory(note.id, ctx.user.id, note.scope);
        if (r === "full") throw new TRPCError({ code: "BAD_REQUEST", message: "Já não cabe: arquiva outra nota primeiro." });
        return { ok: r === "ok" };
      }),
  }),

  // ─── 👍/👎 e "Perguntas que falharam" (Multis 2) ───────────────────────────
  feedback: router({
    /** 👍/👎 a uma resposta de uma conversa MINHA (mudar de ideias = atualizar). */
    give: protectedProcedure
      .input(z.object({
        messageId: z.number().int().positive(),
        rating: z.union([z.literal(1), z.literal(-1)]),
        reason: z.enum(FEEDBACK_REASONS).nullable().optional(),
        comment: z.string().max(FEEDBACK_COMMENT_MAX).nullable().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { giveFeedback } = await import("./feedback");
        const r = await giveFeedback({
          channel: ASSISTANT_CHANNEL, ownerKey: ownerKeyFor(ctx.user.id), userId: ctx.user.id,
          messageId: input.messageId, rating: input.rating, reason: input.reason ?? null, comment: input.comment ?? null,
        });
        if (!r.ok && r.reason === "not_found") throw new TRPCError({ code: "NOT_FOUND", message: "Só podes avaliar respostas das tuas conversas." });
        if (!r.ok) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível guardar agora. Tenta outra vez." });
        return { ok: true };
      }),

    /** "Perguntas que falharam" — só admin/super_admin. */
    list: protectedProcedure
      .input(z.object({
        days: z.union([z.literal(FEEDBACK_PERIODS[0]), z.literal(FEEDBACK_PERIODS[1]), z.literal(FEEDBACK_PERIODS[2])]).default(30),
        reason: z.enum(FEEDBACK_REASONS).nullable().optional(),
        status: z.enum(FEEDBACK_STATUSES).default("open"),
      }))
      .query(async ({ ctx, input }) => {
        assertReviewer(ctx.user);
        const { listFailed } = await import("./feedback");
        return listFailed({ days: input.days, reason: input.reason ?? null, status: input.status });
      }),

    resolve: protectedProcedure
      .input(z.object({ id: z.number().int().positive(), note: z.string().max(FEEDBACK_COMMENT_MAX).nullable().optional() }))
      .mutation(async ({ ctx, input }) => {
        assertReviewer(ctx.user);
        const { resolveFailed } = await import("./feedback");
        return { ok: await resolveFailed(input.id, ctx.user.id, input.note ?? null) };
      }),

    unresolve: protectedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        assertReviewer(ctx.user);
        const { unresolveFailed } = await import("./feedback");
        return { ok: await unresolveFailed(input.id, ctx.user.id) };
      }),
  }),
});

/** Só admin/super_admin veem e tratam as perguntas que falharam. */
export function assertReviewer(user: { role?: string | null } | null | undefined): void {
  if (!isMultisAdmin(user?.role)) throw new TRPCError({ code: "FORBIDDEN", message: "Só os administradores veem as perguntas que falharam." });
}

async function assertMemoryOn(m: typeof import("./memory")): Promise<void> {
  if (!(await m.assistantMemoryEnabled())) throw new TRPCError({ code: "FORBIDDEN", message: "A memória do Multis está desligada (Definições → Automações)." });
}

/** A nota existe e esta pessoa pode mexer-lhe (a sua; ou da empresa, sendo admin). */
async function ownNoteOrThrow(m: typeof import("./memory"), id: number, user: { id: number; role?: string | null }) {
  const note = await m.getMemory(id);
  if (!note) throw new TRPCError({ code: "NOT_FOUND", message: "Nota não encontrada." });
  if (note.scope === "company") {
    if (!isMultisAdmin(user.role)) throw new TRPCError({ code: "FORBIDDEN", message: "Só os administradores mexem na memória da empresa." });
  } else if (note.userId !== user.id) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Nota não encontrada." });
  }
  return note;
}
