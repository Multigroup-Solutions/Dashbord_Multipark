/**
 * Router `rh.docsRequest` — pedir os documentos em falta aos extras (pauta do
 * Rafael, 7 out 2026), à mão:
 *  - `preview` / `send`         — na ficha de um extra;
 *  - `bulkPreview` / `bulkSend` — em grupo, na lista do RH (os extras com
 *    documentos em falta no âmbito de quem pede);
 *  - `history`                  — "Último pedido: dd/mm por X (canais)".
 * Quem pode: quem valida os documentos (o RH da ficha — canRequestDocuments
 * em server/rhAccess.ts), com o módulo RH em "editar", no seu âmbito de
 * cidade. O envio volta a calcular o plano no servidor (nunca confia na lista
 * do ecrã) e repetir o mesmo pedido (requestKey) não reenvia.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { requireAccess } from "./_core/access";
import { assertEmployeeAccess, scopedProjectIds } from "./cityScope";
import { canRequestDocuments, canValidateDocuments, docsRequestableRows, isOwn } from "./rhAccess";
import { rhEmployeeRefOrThrow, rhViewer } from "./rhGuards";
import { resolveProjectIds } from "./db";

const channelsSchema = z.array(z.enum(["whatsapp", "email"])).min(1, "Escolhe pelo menos um canal (WhatsApp ou email).").max(2);
const requestKeySchema = z.string().trim().regex(/^[A-Za-z0-9_-]{8,64}$/, "Código do pedido inválido.");
/** Tempo para enviar dentro de um pedido (a função tem ~60 s). */
const SEND_BUDGET_MS = 40_000;

type User = { id: number; role: string };

async function assertCanRequest(user: User, employeeId: number): Promise<void> {
  requireAccess(user as any, "rh", "edit");
  const viewer = await rhViewer(user);
  const ref = await rhEmployeeRefOrThrow(employeeId);
  if (!canRequestDocuments(viewer, ref)) {
    const message = isOwn(viewer, employeeId) ? "Os teus documentos pede-tos outra pessoa do RH."
      : ref.position !== "extra" ? "O pedido de documentos em falta é só para extras."
      : "Só o RH desta ficha pede os documentos em falta.";
    throw new TRPCError({ code: "FORBIDDEN", message });
  }
  await assertEmployeeAccess(employeeId);
}

/** Extras ativos no âmbito de quem pede (cidades do pedido + filtro global), a quem pode pedir. */
async function scopedCandidates(user: User, projectId?: number | null) {
  requireAccess(user as any, "rh", "edit");
  const viewer = await rhViewer(user);
  const scoped = scopedProjectIds();
  const { loadDocsCandidates } = await import("./rhDocsRequest");
  let rows = await loadDocsCandidates({ activeExtras: true, projectIds: scoped });
  if (projectId) {
    const ids = new Set(await resolveProjectIds(projectId));
    rows = rows.filter((r) => r.projectId != null && ids.has(r.projectId));
  }
  return docsRequestableRows(viewer, rows, scoped);
}

export const docsRequestRouter = router({
  // Ficha: o texto exato por canal, quem recebe e porquê não (sem efeitos).
  preview: protectedProcedure
    .input(z.object({ employeeId: z.number().int().positive(), channels: channelsSchema, force: z.boolean().optional() }))
    .query(async ({ ctx, input }) => {
      await assertCanRequest(ctx.user, input.employeeId);
      const { buildDocsPlan, loadDocsCandidates } = await import("./rhDocsRequest");
      const people = await loadDocsCandidates({ ids: [input.employeeId] });
      const plan = await buildDocsPlan(people, { mode: "manual", channels: input.channels, force: input.force });
      return { ...plan, person: plan.people[0] ?? null };
    }),

  send: protectedProcedure
    .input(z.object({ employeeId: z.number().int().positive(), channels: channelsSchema, force: z.boolean().optional(), requestKey: requestKeySchema }))
    .mutation(async ({ ctx, input }) => {
      await assertCanRequest(ctx.user, input.employeeId);
      const { buildDocsPlan, executeDocsPlan, loadDocsCandidates } = await import("./rhDocsRequest");
      const people = await loadDocsCandidates({ ids: [input.employeeId] });
      const plan = await buildDocsPlan(people, { mode: "manual", channels: input.channels, force: input.force });
      return executeDocsPlan(plan, {
        people, mode: "manual", userId: ctx.user.id, channels: input.channels,
        keyFor: (id) => `m:${input.requestKey}:${id}`, deadlineAt: Date.now() + SEND_BUDGET_MS,
      });
    }),

  // Lista do RH: os extras com documentos em falta no teu âmbito (quem recebe e quem fica de fora, e porquê).
  bulkPreview: protectedProcedure
    .input(z.object({ channels: channelsSchema, projectId: z.number().int().positive().nullish() }))
    .query(async ({ ctx, input }) => {
      const people = await scopedCandidates(ctx.user, input.projectId);
      const { buildDocsPlan } = await import("./rhDocsRequest");
      const plan = await buildDocsPlan(people, { mode: "manual", channels: input.channels });
      const withMissing = plan.people.filter((p) => p.skip?.kind !== "no_missing");
      return { ...plan, people: withMissing };
    }),

  bulkSend: protectedProcedure
    .input(z.object({
      channels: channelsSchema,
      projectId: z.number().int().positive().nullish(),
      employeeIds: z.array(z.number().int().positive()).min(1).max(2000),
      requestKey: requestKeySchema,
    }))
    .mutation(async ({ ctx, input }) => {
      const wanted = new Set(input.employeeIds);
      const people = (await scopedCandidates(ctx.user, input.projectId)).filter((p) => wanted.has(p.id));
      const { buildDocsPlan, executeDocsPlan } = await import("./rhDocsRequest");
      const plan = await buildDocsPlan(people, { mode: "manual", channels: input.channels });
      const out = await executeDocsPlan(plan, {
        people, mode: "manual", userId: ctx.user.id, channels: input.channels,
        keyFor: (id) => `m:${input.requestKey}:${id}`, deadlineAt: Date.now() + SEND_BUDGET_MS,
      });
      // Os que já não estão no teu âmbito (ou deixaram de ser extras ativos) não recebem.
      const missing = wanted.size - people.length;
      return { ...out, outOfScope: Math.max(0, missing) };
    }),

  // "Último pedido" na ficha (só para quem pede documentos; os outros não veem nada).
  history: protectedProcedure
    .input(z.object({ employeeId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      requireAccess(ctx.user as any, "rh", "view");
      const viewer = await rhViewer(ctx.user);
      const ref = await rhEmployeeRefOrThrow(input.employeeId);
      if (!canValidateDocuments(viewer, ref)) return { last: null, label: null, autoCount: 0, rows: [] };
      await assertEmployeeAccess(input.employeeId);
      const { listDocsRequestHistory } = await import("./rhDocsRequest");
      return listDocsRequestHistory(input.employeeId);
    }),
});
