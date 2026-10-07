/**
 * Procedimentos tRPC do Extras-dia para a Frente B (Jorge, 7 out 2026),
 * juntos ao router `extrasDia` em routers.ts:
 *  - `staffing`       — indicador de pessoal por hora (pedido 7);
 *  - `notifyPreview`  — o que "Avisar este turno" vai enviar, sem efeitos (pedido 8);
 *  - `notify`         — envia o aviso de trabalho do turno (WhatsApp e/ou email);
 *  - `dayNotes.*`     — notas internas do dia de trabalho (pedido 4).
 * Ver: extras_dia; editar/avisar/escrever: extras_dia (editar). Sempre no
 * âmbito de cidade do utilizador (assertCityInScope). Tudo fica no registo.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { requireAccess } from "./_core/access";
import { DAY_NOTE_MAX_CHARS, DAY_NOTE_MAX_HOUR, DAY_NOTE_MIN_HOUR } from "../shared/extrasDayNotes";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida");
const cityEnum = z.enum(["lisbon", "porto", "faro"]);
const shiftEnum = z.enum(["morning", "night"]);
const channelsSchema = z.array(z.enum(["whatsapp", "email"])).max(2).default(["whatsapp", "email"]);
/** Máximo de dias numa leitura de notas (o separador Pressão pede ~8 semanas). */
const MAX_NOTE_RANGE_DAYS = 120;

const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

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

  dayNotes: router({
    list: protectedProcedure
      .input(z.object({ city: cityEnum, from: isoDate, to: isoDate }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "extras_dia", "view");
        await inScope(input.city);
        const span = dayDiff(input.from, input.to);
        if (span < 0 || span > MAX_NOTE_RANGE_DAYS) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `Intervalo de datas inválido (máximo ${MAX_NOTE_RANGE_DAYS} dias).` });
        }
        const { listDayNotes } = await import("./extrasDayNotes");
        return listDayNotes(input.city, input.from, input.to, viewer(ctx));
      }),

    add: protectedProcedure
      .input(z.object({
        city: cityEnum,
        workDate: isoDate,
        hour: z.number().int().min(DAY_NOTE_MIN_HOUR).max(DAY_NOTE_MAX_HOUR).nullable().optional(),
        body: z.string().min(1, "Escreve a nota.").max(DAY_NOTE_MAX_CHARS),
      }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "extras_dia", "edit");
        await inScope(input.city);
        const { addDayNote, DayNoteError } = await import("./extrasDayNotes");
        try {
          return await addDayNote({ city: input.city, workDate: input.workDate, hour: input.hour ?? null, body: input.body, authorId: ctx.user.id });
        } catch (err: any) {
          if (err instanceof DayNoteError) throw new TRPCError({ code: err.code, message: err.message });
          throw err;
        }
      }),

    archive: protectedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "extras_dia", "edit");
        const { archiveDayNote, getDayNote, DayNoteError } = await import("./extrasDayNotes");
        const note = await getDayNote(input.id);
        if (!note) throw new TRPCError({ code: "NOT_FOUND", message: "Nota não encontrada." });
        await inScope(note.city);
        try {
          return await archiveDayNote(input.id, viewer(ctx));
        } catch (err: any) {
          if (err instanceof DayNoteError) throw new TRPCError({ code: err.code, message: err.message });
          throw err;
        }
      }),
  }),
};
