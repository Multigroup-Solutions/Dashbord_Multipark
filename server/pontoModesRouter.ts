/**
 * Router `pontoModes` — o modo do ponto de cada pessoa (plano 63, passo 1).
 * Regras puras em shared/pontoMode.ts; a BD e as peças em server/pontoModes.ts.
 * Aqui só se veem as permissões e se convertem os erros.
 *
 *  - `get`: o cartão "Modo do ponto" (RH → ficha → Horário) — quem vê o ponto
 *    da ficha (a própria pessoa, o RH, quem a gere). Desligado → { enabled: false }.
 *  - `set`: só o super admin.
 *  - `ack`: "Li" — só a própria pessoa (qualquer login da ficha).
 *  - `ackPaper`: leitura em papel — quem gere a ficha (nunca a própria).
 *  - `reviewAlert`: rever um alerta — nunca na própria ficha; a zona, as caras e
 *    o fim de semana da isenção só o super admin.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { PONTO_MODES, PONTO_NOTICE_KEYS, type PontoMode, type PontoNoticeKey } from "../shared/pontoMode";
import type { PontoModeStore } from "./pontoModes";

const employeeId = z.number().int().positive();
const noticeKey = z.enum(PONTO_NOTICE_KEYS as unknown as [PontoNoticeKey, ...PontoNoticeKey[]]);
const modeInput = z.enum(PONTO_MODES as unknown as [PontoMode, ...PontoMode[]]).nullable();

const OFF_MESSAGE = "O modo do ponto está desligado (Definições → Automações → \"Ponto: modo de cada pessoa\").";

async function store(): Promise<PontoModeStore> {
  const { mysqlPontoModeStore } = await import("./pontoModes");
  return mysqlPontoModeStore();
}

async function requireEnabled(): Promise<void> {
  const { pontoModesEnabled } = await import("./pontoModes");
  if (!(await pontoModesEnabled())) throw new TRPCError({ code: "PRECONDITION_FAILED", message: OFF_MESSAGE });
}

/** Corre um passo e converte os erros da regra em TRPCError. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const { PontoModeError } = await import("./pontoModes");
    if (err instanceof PontoModeError) throw new TRPCError({ code: err.code, message: err.message });
    throw err;
  }
}

/** Quem pede, nesta ficha: a própria (qualquer login) e se a gere (RH da cidade). */
async function viewerOf(user: { id: number; role: string }, empId: number) {
  const [{ isLoginOfEmployee }, { assertCanManageEmployee }] = await Promise.all([import("./pontoModes"), import("./rhGuards")]);
  const isOwn = await isLoginOfEmployee(user.id, empId);
  const canManage = isOwn ? false : await assertCanManageEmployee(user, empId).then(() => true, () => false);
  return { id: user.id, role: user.role, isOwn, canManage };
}

export const pontoModesRouter = router({
  /** O cartão da ficha. Desligado → nada (o cartão não aparece). */
  get: protectedProcedure.input(z.object({ employeeId })).query(async ({ ctx, input }) => {
    const { pontoModesEnabled, pontoModeView } = await import("./pontoModes");
    if (!(await pontoModesEnabled())) return { enabled: false as const };
    const { assertCanViewTimeRecords } = await import("./rhGuards");
    await assertCanViewTimeRecords(ctx.user, input.employeeId);
    const viewer = await viewerOf(ctx.user, input.employeeId);
    const view = await run(async () => pontoModeView(await store(), { employeeId: input.employeeId, viewer, nowMs: Date.now() }));
    return { enabled: true as const, ...view };
  }),

  /** Mudar o modo (só o super admin). */
  set: protectedProcedure
    .input(z.object({
      employeeId,
      mode: modeInput,
      effectiveFrom: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida (AAAA-MM-DD)."),
      note: z.string().trim().min(3, "Escreve o motivo da mudança.").max(255),
    }))
    .mutation(async ({ ctx, input }) => {
      await requireEnabled();
      if (ctx.user.role !== "super_admin") throw new TRPCError({ code: "FORBIDDEN", message: "Só o super admin muda o modo do ponto." });
      const { setPontoMode } = await import("./pontoModes");
      return run(async () => setPontoMode(await store(), {
        actor: { id: ctx.user.id, role: ctx.user.role }, employeeId: input.employeeId, mode: input.mode,
        effectiveFrom: input.effectiveFrom, note: input.note, nowMs: Date.now(),
      }));
    }),

  /** "Li": a própria pessoa leu o aviso do seu modo. */
  ack: protectedProcedure.input(z.object({ employeeId, notice: noticeKey })).mutation(async ({ ctx, input }) => {
    await requireEnabled();
    const { isLoginOfEmployee, recordPontoNoticeAck } = await import("./pontoModes");
    if (!(await isLoginOfEmployee(ctx.user.id, input.employeeId))) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Só a própria pessoa carrega em \"Li\". A leitura em papel regista-a o RH." });
    }
    return run(async () => recordPontoNoticeAck(await store(), { employeeId: input.employeeId, notice: input.notice, channel: "app", actorUserId: ctx.user.id, nowMs: Date.now() }));
  }),

  /** Leitura em papel, registada pelo RH (nunca na própria ficha). */
  ackPaper: protectedProcedure
    .input(z.object({ employeeId, notice: noticeKey, note: z.string().trim().max(255).optional() }))
    .mutation(async ({ ctx, input }) => {
      await requireEnabled();
      const viewer = await viewerOf(ctx.user, input.employeeId);
      if (viewer.isOwn) throw new TRPCError({ code: "FORBIDDEN", message: "Na tua própria ficha carregas em \"Li\"." });
      if (!viewer.canManage && ctx.user.role !== "super_admin") throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para gerir esta ficha." });
      const { recordPontoNoticeAck } = await import("./pontoModes");
      return run(async () => recordPontoNoticeAck(await store(), { employeeId: input.employeeId, notice: input.notice, channel: "paper", actorUserId: ctx.user.id, note: input.note ?? null, nowMs: Date.now() }));
    }),

  /** Rever um alerta do ponto (visto / justificado / confirmado). */
  reviewAlert: protectedProcedure
    .input(z.object({ alertId: z.number().int().positive(), status: z.enum(["seen", "justified", "confirmed"]), note: z.string().trim().max(255).optional() }))
    .mutation(async ({ ctx, input }) => {
      await requireEnabled();
      const s = await store();
      const alert = await s.alertById(input.alertId);
      if (!alert) throw new TRPCError({ code: "NOT_FOUND", message: "Alerta não encontrado." });
      const viewer = await viewerOf(ctx.user, alert.employeeId);
      const { reviewPontoAlert } = await import("./pontoModes");
      await run(() => reviewPontoAlert(s, { alertId: input.alertId, status: input.status, note: input.note ?? null, viewer, nowMs: Date.now() }));
      return { success: true as const };
    }),
});
