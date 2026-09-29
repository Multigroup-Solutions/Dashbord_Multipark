/**
 * tRPC do assistente da equipa (`assistant.*`). Qualquer pessoa com sessão
 * pode usar a parte "como se usa"; as ferramentas de dados só existem para
 * quem tem o módulo, e correm os procedimentos já existentes como a própria
 * pessoa (mesmas cidades, mesmos acessos).
 */
import { z } from "zod";
import { can, canSeeFinanceTotalsFor } from "../../shared/access";
import { assistantSuggestions } from "../../shared/assistant";
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
      if (!(await aiFeatureAvailableFresh(ASSISTANT_FEATURE))) {
        const reason = selectProvider(process.env, ASSISTANT_FEATURE) ? "disabled" : "not_configured";
        return { available: false, reason, message: CHAT_MESSAGES[reason], maxInputChars: limits.maxInputChars, suggestions };
      }
      try {
        const { budgetDecision, getMonthlyBudgetEur, monthSpendEur } = await import("../_core/ai/usage");
        if (budgetDecision(await monthSpendEur(), await getMonthlyBudgetEur(), false) === "blocked") {
          return { available: false, reason: "budget" as const, message: CHAT_MESSAGES.budget, maxInputChars: limits.maxInputChars, suggestions };
        }
      } catch { /* sem BD: segue */ }
      return { available: true, reason: null, message: null, maxInputChars: limits.maxInputChars, suggestions };
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
      return { conversationId: id, messages: msgs.map((m) => ({ id: m.id, role: m.role, content: m.content, tools: m.tools, createdAt: m.createdAt })) };
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
});
