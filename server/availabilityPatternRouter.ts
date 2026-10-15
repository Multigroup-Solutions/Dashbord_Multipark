/**
 * Dias livres HABITUAIS (Jorge, 8 out 2026) — procedimentos juntos ao router
 * `extrasAvailability` em routers.ts:
 *  - `myPattern` / `setMyPattern` — a própria pessoa, pela ficha ligada à
 *    conta. Funciona com a ficha INATIVA (candidatos e inativos que voltam) e
 *    sem centro de custos (caminhos pessoais, server/cityAccess.ts).
 *  - `patternFor` / `setPatternFor` — RH/supervisor: o mesmo controlo que
 *    `forEmployee` (ver: a ficha no âmbito de cidade e canViewEmployee) e
 *    `setForEmployee` (editar: "Disponibilidade dos extras" com editar + a
 *    ficha no âmbito de cidade).
 * Cada gravação fica no registo de atividade com o que estava antes.
 * É só uma dica para quem escala: nada daqui muda a escala.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure } from "./_core/trpc";
import { canAccess, requireAccess } from "./_core/access";
import { assertEmployeeAccess } from "./cityScope";
import { getEmployeeById, getEmployeeByUserId, logActivity } from "./db";
import { rhViewer } from "./rhGuards";
import { canViewEmployee } from "./rhAccess";
import { noLinkedRecordMessage } from "../shared/ownAccess";
import { patternInputSchema } from "../shared/availabilityPattern";
import { getAvailabilityPattern, saveAvailabilityPattern } from "./availabilityPattern";

const employeeIdSchema = z.number().int().positive();

/** A ficha da conta (ativa primeiro; se só houver a inativa, essa). */
async function ownEmployeeId(user: { id: number; email?: string | null }): Promise<number> {
  const emp = await getEmployeeByUserId(user.id);
  // Lote 46: diz QUAL é a conta Google e o que fazer (pôr o email na ficha).
  if (!emp) throw new TRPCError({ code: "FORBIDDEN", message: noLinkedRecordMessage(user.email ?? null) });
  return emp.employee.id;
}

export const availabilityPatternProcedures = {
  // A pessoa vê os SEUS dias livres habituais.
  myPattern: protectedProcedure.query(async ({ ctx }) => {
    const employeeId = await ownEmployeeId(ctx.user);
    return { ...(await getAvailabilityPattern(employeeId)), own: true, canEdit: true };
  }),

  // A pessoa grava os SEUS dias livres habituais (substitui o que havia).
  setMyPattern: protectedProcedure
    .input(patternInputSchema)
    .mutation(async ({ ctx, input }) => {
      const employeeId = await ownEmployeeId(ctx.user);
      const r = await saveAvailabilityPattern(employeeId, input.slots, input.note ?? null, ctx.user.id);
      await logActivity({
        userId: ctx.user.id, action: "availability_pattern_set", entity: "extras_availability_pattern", entityId: employeeId,
        details: `Dias livres habituais: ${r.current} · antes: ${r.previous}`.slice(0, 1000),
      });
      return { ...r.view, own: true, canEdit: true };
    }),

  // Ficha no RH / gestão: o padrão de uma pessoa (o mesmo controlo que forEmployee).
  patternFor: protectedProcedure
    .input(z.object({ employeeId: employeeIdSchema }))
    .query(async ({ ctx, input }) => {
      const viewer = await rhViewer(ctx.user);
      const person = await getEmployeeById(input.employeeId);
      if (!person) throw new TRPCError({ code: "NOT_FOUND", message: "Colaborador não encontrado." });
      const own = viewer.employeeId === input.employeeId;
      // A própria ficha abre mesmo sem cidade (como a disponibilidade da semana).
      if (!own) await assertEmployeeAccess(input.employeeId);
      if (!canViewEmployee(viewer, person.employee)) throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão" });
      const view = await getAvailabilityPattern(input.employeeId);
      return { ...view, own, canEdit: own || canAccess(ctx.user, "disponibilidade_extras", "edit") };
    }),

  // RH/supervisor marca os dias habituais POR alguém (o mesmo controlo que setForEmployee).
  setPatternFor: protectedProcedure
    .input(patternInputSchema.extend({ employeeId: employeeIdSchema }))
    .mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "disponibilidade_extras", "edit");
      await assertEmployeeAccess(input.employeeId);
      const person = await getEmployeeById(input.employeeId);
      if (!person) throw new TRPCError({ code: "NOT_FOUND", message: "Colaborador não encontrado." });
      let r: Awaited<ReturnType<typeof saveAvailabilityPattern>>;
      try {
        r = await saveAvailabilityPattern(input.employeeId, input.slots, input.note ?? null, ctx.user.id);
      } catch (err) {
        throw new TRPCError({ code: "BAD_REQUEST", message: (err as Error).message || "Falha ao guardar os dias habituais" });
      }
      await logActivity({
        userId: ctx.user.id, action: "availability_pattern_manual", entity: "extras_availability_pattern", entityId: input.employeeId,
        details: `Dias livres habituais marcados por outra pessoa para ${person.employee.fullName ?? `#${input.employeeId}`}: ${r.current} · antes: ${r.previous}`.slice(0, 1000),
      });
      return { ...r.view, own: false, canEdit: true };
    }),
};
