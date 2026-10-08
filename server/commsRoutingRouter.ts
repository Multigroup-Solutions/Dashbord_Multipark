/**
 * Router `commsRouting` — o que a IA decidiu ao separar emails e WhatsApp pelas
 * caixas (server/commsRouting.ts): a linha "Movido pela IA → caixa (motivo)"
 * numa conversa e, no Recrutamento, o que entrou pela IA. Só leitura.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { requireAccess, withOverrides } from "./_core/access";

export const commsRoutingRouter = router({
  /** Linha da IA numa conversa (só quem vê a conversa). null = a IA não mexeu. */
  note: protectedProcedure
    .input(z.object({ channel: z.enum(["email", "whatsapp"]), id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      if (input.channel === "email") {
        const { threadAccess } = await import("./mail/inbox");
        const w = withOverrides(ctx.user as any);
        try { await threadAccess({ id: w.id, role: w.role, accessOverrides: (w as any).accessOverrides ?? null }, input.id); }
        catch { throw new TRPCError({ code: "NOT_FOUND", message: "Conversa não encontrada" }); }
      } else {
        requireAccess(ctx.user, "whatsapp", "view");
        const { conversationVisible } = await import("./whatsappInbox");
        if (!(await conversationVisible(input.id, ctx.user))) throw new TRPCError({ code: "NOT_FOUND", message: "Conversa não encontrada" });
      }
      const { routingNoteFor } = await import("./commsRouting");
      return (await routingNoteFor(input.channel, input.id)) ?? null;
    }),

  /** Recrutamento → o que entrou pela IA (leads e candidaturas criadas, ou ligadas). */
  recruitmentIntake: protectedProcedure
    .input(z.object({ days: z.number().int().min(1).max(90).optional() }).optional())
    .query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "leads_extras", "view");
      const { scopedProjectIds } = await import("./extrasCityFilter");
      const { listAiIntake } = await import("./commsRouting");
      return listAiIntake({ days: input?.days ?? 30, scope: scopedProjectIds() });
    }),
});
