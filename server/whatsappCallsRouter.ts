/**
 * tRPC — Chamadas de voz do WhatsApp (`whatsapp.calls.*`, módulo "whatsapp").
 *
 *  - toque/atender/recusar/desligar e ligar: WhatsApp EDITAR + conversa no
 *    âmbito de cidade do utilizador (mesma regra do inbox; super admin vê
 *    todas). O "atender" é atómico: o primeiro ganha.
 *  - linha do tempo e "por devolver": WhatsApp VER (+ cidade);
 *  - configuração das chamadas na Meta: só super admin.
 *
 * Nunca regista SDP nem números completos. A oferta SDP só é devolvida a quem
 * ganhou o "atender"; a resposta SDP (chamada nossa) só a quem ligou.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { requireAccess } from "./_core/access";
import { scopedProjectIds } from "./cityScope";
import { maskPhone } from "../shared/maskPhone";

const SDP = z.string().min(20).max(20_000);
const ID = z.number().int().positive();

async function assertConversation(conversationId: number | null | undefined): Promise<void> {
  if (!conversationId) throw new TRPCError({ code: "NOT_FOUND", message: "Chamada sem conversa associada." });
  const { conversationVisible } = await import("./whatsappInbox");
  if (!(await conversationVisible(conversationId))) throw new TRPCError({ code: "NOT_FOUND", message: "Conversa não encontrada" });
}

/** Chamada existe e a conversa dela é visível ao utilizador. */
async function assertCallVisible(id: number) {
  const { createDbCallRepo } = await import("./whatsappCalls");
  const row = await createDbCallRepo().getById(id);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Chamada não encontrada." });
  await assertConversation(row.conversationId);
  return row;
}

async function deps() {
  const { realCallDeps } = await import("./whatsappCalls");
  return realCallDeps();
}

async function log(userId: number, action: string, entityId: number | null, details: string) {
  try {
    const { logActivity } = await import("./db");
    await logActivity({ userId, action, entity: "whatsapp_conversation", entityId: entityId ?? undefined, details });
  } catch { /* best-effort */ }
}

const superOnly = (role: string) => {
  if (role !== "super_admin") throw new TRPCError({ code: "FORBIDDEN", message: "Só o super admin configura as chamadas do WhatsApp." });
};

const WEEKDAY = z.enum(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]);

/** Chamadas desligadas (interruptor WHATSAPP_CALLS) → erro claro. */
async function requireCallsEnabled(): Promise<void> {
  const { whatsappCallsEnabled } = await import("./whatsappCalls");
  if (!(await whatsappCallsEnabled())) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "As chamadas do WhatsApp estão desligadas (Definições → Automações → Chamadas de voz do WhatsApp)." });
  }
}

export const whatsappCallsRouter = router({
  /** Interruptor WHATSAPP_CALLS: o cliente só faz polling/mostra "Ligar" se ligado. */
  enabled: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "whatsapp", "view");
    const { whatsappCallsEnabled } = await import("./whatsappCalls");
    return { enabled: await whatsappCallsEnabled() };
  }),

  /** Toque: chamadas recebidas a tocar visíveis (polling curto, 2–3 s). */
  incoming: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "whatsapp", "edit");
    const { whatsappCallsEnabled } = await import("./whatsappCalls");
    if (!(await whatsappCallsEnabled())) return [];
    const { sweepStaleCallsThrottled } = await import("./whatsappCalls");
    await sweepStaleCallsThrottled();
    const { listIncomingCalls } = await import("./whatsappCallsQueries");
    return listIncomingCalls(scopedProjectIds());
  }),

  /** "Atender": o primeiro ganha; devolve a oferta SDP só a esse. */
  claim: protectedProcedure.input(z.object({ id: ID })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "whatsapp", "edit");
    await requireCallsEnabled();
    await assertCallVisible(input.id);
    const { claimCall } = await import("./whatsappCalls");
    const r = await claimCall(input.id, ctx.user.id, await deps());
    if (!r.ok) return { ok: false as const, message: r.message, answeredByName: r.answeredByName ?? null };
    return { ok: true as const, sdpOffer: r.sdpOffer, conversationId: r.call.conversationId };
  }),

  /** O browser não conseguiu (microfone negado…) → volta a tocar para os outros. */
  release: protectedProcedure.input(z.object({ id: ID })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "whatsapp", "edit");
    await assertCallVisible(input.id);
    const { releaseCall } = await import("./whatsappCalls");
    return { ok: await releaseCall(input.id, ctx.user.id, await deps()) };
  }),

  /** Resposta SDP do browser → pre_accept + accept. */
  answer: protectedProcedure.input(z.object({ id: ID, sdp: SDP })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "whatsapp", "edit");
    await requireCallsEnabled();
    const row = await assertCallVisible(input.id);
    const { answerCall } = await import("./whatsappCalls");
    const r = await answerCall(input.id, ctx.user.id, input.sdp, await deps());
    if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: r.error });
    await log(ctx.user.id, "whatsapp_call_answer", row.conversationId, `Chamada WhatsApp atendida (${maskPhone(row.phoneE164)})`);
    try {
      const { claimIfUnassigned } = await import("./whatsappInboxOps");
      if (row.conversationId) await claimIfUnassigned(row.conversationId, ctx.user.id);
    } catch { /* best-effort */ }
    return { ok: true };
  }),

  reject: protectedProcedure.input(z.object({ id: ID })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "whatsapp", "edit");
    const row = await assertCallVisible(input.id);
    const { rejectCall } = await import("./whatsappCalls");
    const r = await rejectCall(input.id, ctx.user.id, await deps());
    if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: r.error });
    await log(ctx.user.id, "whatsapp_call_reject", row.conversationId, `Chamada WhatsApp recusada (${maskPhone(row.phoneE164)})`);
    return { ok: true };
  }),

  hangup: protectedProcedure.input(z.object({ id: ID })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "whatsapp", "edit");
    await assertCallVisible(input.id);
    const { hangupCall } = await import("./whatsappCalls");
    const r = await hangupCall(input.id, ctx.user, await deps());
    if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: r.error });
    return { ok: true };
  }),

  /** Estado durante a chamada (polling 1–2 s). */
  state: protectedProcedure.input(z.object({ id: ID })).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "whatsapp", "edit");
    await assertCallVisible(input.id);
    const { callState } = await import("./whatsappCalls");
    const s = await callState(input.id, ctx.user.id, await deps());
    if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "Chamada não encontrada." });
    return s;
  }),

  /** Chamadas da conversa (linha do tempo). */
  byConversation: protectedProcedure.input(z.object({ conversationId: ID })).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "whatsapp", "view");
    await assertConversation(input.conversationId);
    const { listConversationCalls } = await import("./whatsappCallsQueries");
    return listConversationCalls(input.conversationId);
  }),

  /** "Chamadas perdidas por devolver" (cidade do utilizador). */
  pendingCallbacks: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "whatsapp", "view");
    const { listPendingCallbacks } = await import("./whatsappCallsQueries");
    return listPendingCallbacks(scopedProjectIds());
  }),

  markCallbackDone: protectedProcedure.input(z.object({ id: ID })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "whatsapp", "edit");
    await assertCallVisible(input.id);
    const { markCallbackDone } = await import("./whatsappCallsQueries");
    return { updated: await markCallbackDone(input.id, ctx.user.id) };
  }),

  /** Autorização do cliente para ligarmos (+ limites da Meta). */
  permission: protectedProcedure.input(z.object({ conversationId: ID })).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "whatsapp", "edit");
    await assertConversation(input.conversationId);
    const { conversationCallContext } = await import("./whatsappCallsQueries");
    const conv = await conversationCallContext(input.conversationId);
    if (!conv) throw new TRPCError({ code: "NOT_FOUND", message: "Conversa não encontrada" });
    const { permissionInfo } = await import("./whatsappCalls");
    const { fetchCallPermission } = await import("./whatsappCallsApi");
    const { deriveWindowState } = await import("./whatsappInbox");
    const info = await permissionInfo(conv.phoneE164, { ...(await deps()), remote: fetchCallPermission });
    const windowOpen = deriveWindowState(conv.lastInboundAt).windowState === "open";
    const templateConfigured = !!process.env.WHATSAPP_CALL_PERMISSION_TEMPLATE?.trim();
    return { ...info, windowOpen, templateConfigured, optedOut: conv.optedOut };
  }),

  /** Envia o pedido de autorização (interativo com a janela aberta; senão template). */
  requestPermission: protectedProcedure
    .input(z.object({ conversationId: ID, text: z.string().trim().max(1024).optional() }))
    .mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "whatsapp", "edit");
    await requireCallsEnabled();
      await assertConversation(input.conversationId);
      const { conversationCallContext } = await import("./whatsappCallsQueries");
      const conv = await conversationCallContext(input.conversationId);
      if (!conv) throw new TRPCError({ code: "NOT_FOUND", message: "Conversa não encontrada" });
      if (conv.optedOut) throw new TRPCError({ code: "BAD_REQUEST", message: "Este contacto pediu para não receber mensagens (STOP)." });
      const d = await deps();
      const { permissionInfo, notePermissionRequested } = await import("./whatsappCalls");
      const { fetchCallPermission, sendPermissionRequest } = await import("./whatsappCallsApi");
      const info = await permissionInfo(conv.phoneE164, { ...d, remote: fetchCallPermission });
      if (info.valid) throw new TRPCError({ code: "BAD_REQUEST", message: "O cliente já autorizou chamadas — podes ligar." });
      if (!info.canRequest) throw new TRPCError({ code: "BAD_REQUEST", message: info.requestBlockedReason ?? "Não é possível pedir autorização agora." });
      const { deriveWindowState } = await import("./whatsappInbox");
      const windowOpen = deriveWindowState(conv.lastInboundAt).windowState === "open";
      const tplName = process.env.WHATSAPP_CALL_PERMISSION_TEMPLATE?.trim() || null;
      const tplLang = process.env.WHATSAPP_CALL_PERMISSION_TEMPLATE_LANG?.trim() || "pt_PT";
      if (!windowOpen && !tplName) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A janela de 24 h está fechada: o pedido de autorização só pode ir num template aprovado (com o botão de autorização de chamadas). Pede ao super admin para configurar WHATSAPP_CALL_PERMISSION_TEMPLATE, ou espera que o cliente escreva.",
        });
      }
      const body = input.text?.trim() || "Podemos ligar-lhe pelo WhatsApp para ajudar com o seu pedido?";
      const sent = await sendPermissionRequest(conv.phoneE164, windowOpen ? { bodyText: body } : { template: { name: tplName!, language: tplLang } });
      const { getDb } = await import("./db");
      const db = await getDb();
      if (db) {
        const { recordOutboundMessage } = await import("./whatsappStore");
        await recordOutboundMessage(db, {
          conversationId: input.conversationId,
          waMessageId: sent.ok ? sent.waMessageId : null,
          type: windowOpen ? "text" : "template",
          body: windowOpen ? `📞 Pedido de autorização para ligar: ${body}` : "📞 Pedido de autorização para ligar",
          templateName: windowOpen ? null : tplName,
          status: sent.ok ? "sent" : "failed",
          errorDetail: sent.ok ? null : sent.error,
          sentById: ctx.user.id,
        }).catch(() => undefined);
      }
      if (!sent.ok) throw new TRPCError({ code: "BAD_REQUEST", message: sent.error });
      await notePermissionRequested(conv.phoneE164, ctx.user.id, d);
      await log(ctx.user.id, "whatsapp_call_permission", input.conversationId, `Pedido de autorização para ligar (${maskPhone(conv.phoneE164)})`);
      return { ok: true };
    }),

  /** "Ligar": oferta SDP do browser → connect (com autorização e limites verificados). */
  start: protectedProcedure.input(z.object({ conversationId: ID, sdp: SDP })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "whatsapp", "edit");
    await requireCallsEnabled();
    await assertConversation(input.conversationId);
    const { conversationCallContext } = await import("./whatsappCallsQueries");
    const conv = await conversationCallContext(input.conversationId);
    if (!conv) throw new TRPCError({ code: "NOT_FOUND", message: "Conversa não encontrada" });
    const d = await deps();
    const { permissionInfo, startCall } = await import("./whatsappCalls");
    const { fetchCallPermission } = await import("./whatsappCallsApi");
    const permission = await permissionInfo(conv.phoneE164, { ...d, remote: fetchCallPermission });
    const r = await startCall(
      { conversationId: input.conversationId, phoneE164: conv.phoneE164, projectId: conv.projectId, sdpOffer: input.sdp, userId: ctx.user.id },
      { ...d, permission },
    );
    if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: r.error });
    await log(ctx.user.id, "whatsapp_call_start", input.conversationId, `Chamada WhatsApp feita (${maskPhone(conv.phoneE164)})`);
    return { id: r.id, warning: permission.warning };
  }),

  // ── Configuração (super admin) ────────────────────────────────────────────
  settings: protectedProcedure.query(async ({ ctx }) => {
    superOnly(ctx.user.role);
    const { getCallingSettings, summarizeCallingSettings } = await import("./whatsappCallsApi");
    const r = await getCallingSettings();
    if (!r.ok) return { ok: false as const, error: r.error };
    return { ok: true as const, summary: summarizeCallingSettings(r.data), calling: r.data?.calling ?? null };
  }),

  configure: protectedProcedure
    .input(z.object({
      enabled: z.boolean(),
      callbackPermission: z.boolean().optional(),
      callIconVisibility: z.enum(["DEFAULT", "DISABLE_ALL"]).optional(),
      callHours: z.object({
        enabled: z.boolean(),
        timezoneId: z.string().min(3).max(64),
        weekly: z.array(z.object({ day: WEEKDAY, open: z.string().regex(/^\d{4}$/), close: z.string().regex(/^\d{4}$/) })).max(14),
      }).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      superOnly(ctx.user.role);
      const { updateCallingSettings } = await import("./whatsappCallsApi");
      const r = await updateCallingSettings(input);
      if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: r.error });
      await log(ctx.user.id, "whatsapp_call_settings", null, `Chamadas WhatsApp: ${input.enabled ? "ativadas" : "desativadas"}${input.callHours?.enabled ? " com horário" : ""}`);
      return { ok: true };
    }),
});
