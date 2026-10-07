/**
 * Procedimentos tRPC do Extras-dia para a Frente B (Jorge, 7 out 2026),
 * juntos ao router `extrasDia` em routers.ts:
 *  - `staffing`       — indicador de pessoal por hora (pedido 7);
 *  - `notifyPreview`  — o que "Avisar este turno" vai enviar, sem efeitos (pedido 8);
 *  - `notify`         — envia o aviso de trabalho do turno (WhatsApp e/ou email);
 * Ver: extras_dia; avisar: extras_dia (editar). Sempre no
 * âmbito de cidade do utilizador (assertCityInScope). Tudo fica no registo.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure } from "./_core/trpc";
import { requireAccess } from "./_core/access";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida");
const cityEnum = z.enum(["lisbon", "porto", "faro"]);
const shiftEnum = z.enum(["morning", "night"]);
const channelsSchema = z.array(z.enum(["whatsapp", "email"])).max(2).default(["whatsapp", "email"]);


async function inScope(city: string): Promise<void> {
  const { assertCityInScope } = await import("./extrasSchedule");
  await assertCityInScope(city);
}

const viewer = (ctx: { user: { id: number; role: string } }) => ({ id: ctx.user.id, role: ctx.user.role });

export const extrasDiaShiftProcedures = {
  // Indicador por hora: precisas N (além do TL) · escalados M · disponíveis por escalar K.
  staffing: protectedProcedure
    .input(z.object({ date: isoDate, city: cityEnum }))
    .query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "extras_dia", "view");
      await inScope(input.city);
      const { getStaffingReport } = await import("./extrasDiaShift");
      return getStaffingReport(input.date, input.city);
    }),

  // Pré-visualização de "Avisar este turno": quem recebe, o texto exato, por que canal, quem fica de fora e porquê.
  notifyPreview: protectedProcedure
    .input(z.object({ date: isoDate, city: cityEnum, shift: shiftEnum, channels: channelsSchema }))
    .query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "extras_dia", "edit");
      await inScope(input.city);
      const { previewShiftNotice } = await import("./extrasDiaShift");
      return previewShiftNotice(input.date, input.city, input.shift, input.channels);
    }),

  // O botão é de um turno: avisa só esse turno, só as linhas CONFIRMADAS (as propostas não recebem).
  notify: protectedProcedure
    .input(z.object({ date: isoDate, city: cityEnum, shift: shiftEnum, channels: channelsSchema }))
    .mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "extras_dia", "edit");
      await inScope(input.city);
      const { sendShiftNotice } = await import("./extrasDiaShift");
      try {
        return await sendShiftNotice({ ...input, userId: ctx.user.id });
      } catch (err: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err?.message || "Erro ao avisar" });
      }
    }),

};
