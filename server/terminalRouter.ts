/**
 * Router `terminal` — terminal pelo perfil (plano 56 B1). As regras estão em
 * server/terminalSessions.ts (e as puras em shared/terminalSession.ts); aqui
 * só se lê quem pede (ficha, papel, cidades) e se convertem os erros.
 * Interruptor PONTO_TERMINAL desligado → `status`/`liveByCity` dizem
 * "desligado" e o resto recusa.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { requireAccess } from "./_core/access";
import { roleRank } from "../shared/access";
import { TERMINAL_CITY_KEYS, TERMINAL_REASON_MIN, type GpsFix } from "../shared/terminalSession";
import type { TerminalActor, TerminalDeps } from "./terminalSessions";

const gpsFields = {
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  accuracy: z.number().min(0).max(1_000_000).nullable().optional(),
};
const cityKey = z.enum(TERMINAL_CITY_KEYS as unknown as [string, ...string[]]) as z.ZodType<"lisbon" | "porto" | "faro">;
const reason = z.string().trim().min(TERMINAL_REASON_MIN, "Escreve o motivo (mín. 3 letras).").max(200);

const fixOf = (i: { lat?: number | null; lng?: number | null; accuracy?: number | null }): GpsFix | null =>
  i.lat == null || i.lng == null ? null : { lat: i.lat, lng: i.lng, accuracy: i.accuracy ?? null };

async function deps(): Promise<TerminalDeps> {
  const { realTerminalDeps } = await import("./terminalSessions");
  return realTerminalDeps();
}

/** Corre um passo e converte os erros da regra em TRPCError. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const { TerminalError } = await import("./terminalSessions");
    if (err instanceof TerminalError) throw new TRPCError({ code: err.code, message: err.message });
    throw err;
  }
}

/** A ficha de quem pede (conta principal ou extra). */
async function myEmployeeId(userId: number): Promise<number> {
  const { getEmployeeByUserId } = await import("./db");
  const me = await getEmployeeByUserId(userId);
  if (!me?.employee) throw new TRPCError({ code: "FORBIDDEN", message: "A tua conta não está ligada a uma ficha." });
  return Number(me.employee.id);
}

/** TL/supervisor: papel e cidades do pedido (as do centro de custos + dadas; nacionais = todas). */
async function actorOf(user: { id: number; role: string }): Promise<TerminalActor> {
  const [{ cityScope }, { loadCityAccess }, { cityKeysOfAccess }] = await Promise.all([
    import("./cityScope"), import("./cityAccess"), import("./terminalSessions"),
  ]);
  const access = cityScope.getStore() ?? await loadCityAccess(user.id, user.role);
  return { userId: user.id, role: user.role, cities: cityKeysOfAccess(access) };
}

export const terminalRouter = router({
  /** Estado da própria pessoa (barra fina + menu da foto). */
  status: protectedProcedure.query(async ({ ctx }) => {
    const { getEmployeeByUserId } = await import("./db");
    const { terminalStatus } = await import("./terminalSessions");
    const me = await getEmployeeByUserId(ctx.user.id);
    return terminalStatus(await deps(), me?.employee ? Number(me.employee.id) : null);
  }),

  /** "Estou no terminal" (com o ponto já aberto). */
  start: protectedProcedure.input(z.object(gpsFields)).mutation(async ({ ctx, input }) => run(async () => {
    const { startTerminal } = await import("./terminalSessions");
    return startTerminal(await deps(), { employeeId: await myEmployeeId(ctx.user.id), actorUserId: ctx.user.id, fix: fixOf(input), source: "button" });
  })),

  /** "Sair" do terminal (pede confirmação no ecrã). */
  stop: protectedProcedure.input(z.object(gpsFields).optional()).mutation(async ({ ctx, input }) => run(async () => {
    const { stopTerminal } = await import("./terminalSessions");
    return stopTerminal(await deps(), { employeeId: await myEmployeeId(ctx.user.id), actorUserId: ctx.user.id, fix: fixOf(input ?? {}) });
  })),

  /** "Pedir ao João para passar" (sem ponto do João → entra logo). */
  requestHandover: protectedProcedure.input(z.object(gpsFields)).mutation(async ({ ctx, input }) => run(async () => {
    const { requestHandover } = await import("./terminalSessions");
    return requestHandover(await deps(), { employeeId: await myEmployeeId(ctx.user.id), actorUserId: ctx.user.id, fix: fixOf(input) });
  })),

  /** O João responde: Passar / Ainda estou. */
  answerHandover: protectedProcedure
    .input(z.object({ requestId: z.number().int().positive(), answer: z.enum(["pass", "stay"]), ...gpsFields }))
    .mutation(async ({ ctx, input }) => run(async () => {
      const { answerHandover } = await import("./terminalSessions");
      return answerHandover(await deps(), { employeeId: await myEmployeeId(ctx.user.id), actorUserId: ctx.user.id, requestId: input.requestId, answer: input.answer, fix: fixOf(input) });
    })),

  /** "Terminal agora" (Atividade diária → Ao vivo): quem vê a Atividade diária para além do próprio. */
  liveByCity: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "atividade_diaria", "view");
    const { liveByCity } = await import("./terminalSessions");
    const actor = await actorOf(ctx.user);
    const manage = roleRank(ctx.user.role) >= roleRank("team_leader") ? actor.cities : [];
    return liveByCity(await deps(), { cities: actor.cities, manage });
  }),

  /** TL e acima, só das suas cidades, sempre com motivo. */
  tl: router({
    put: protectedProcedure
      .input(z.object({ cityKey, employeeId: z.number().int().positive(), reason }))
      .mutation(async ({ ctx, input }) => run(async () => {
        const { tlPut } = await import("./terminalSessions");
        return tlPut(await deps(), await actorOf(ctx.user), { city: input.cityKey, employeeId: input.employeeId, reason: input.reason });
      })),
    pass: protectedProcedure
      .input(z.object({ cityKey, toEmployeeId: z.number().int().positive(), reason }))
      .mutation(async ({ ctx, input }) => run(async () => {
        const { tlPass } = await import("./terminalSessions");
        return tlPass(await deps(), await actorOf(ctx.user), { city: input.cityKey, toEmployeeId: input.toEmployeeId, reason: input.reason });
      })),
    close: protectedProcedure
      .input(z.object({ cityKey, reason }))
      .mutation(async ({ ctx, input }) => run(async () => {
        const { tlClose } = await import("./terminalSessions");
        return tlClose(await deps(), await actorOf(ctx.user), { city: input.cityKey, reason: input.reason });
      })),
  }),
});
