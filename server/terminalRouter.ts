/**
 * Router `terminal` — terminal pelo perfil (plano 56 B1 + B2). As regras estão
 * em server/terminalSessions.ts, server/terminalWatch.ts ("Ainda estás no
 * terminal?", reabrir) e server/terminalReview.ts (RH, Resumo do dia); as
 * puras em shared/terminalSession.ts e shared/terminalWatch.ts. Aqui só se lê
 * quem pede (ficha, papel, cidades), se verificam as permissões e se
 * convertem os erros. Interruptor PONTO_TERMINAL desligado → as leituras
 * dizem "desligado" e o resto recusa.
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
const reasonNote = z.string().trim().min(TERMINAL_REASON_MIN, "Escreve o motivo (mín. 3 letras).").max(255);
/** Instante UTC como na BD ("YYYY-MM-DD HH:MM:SS") ou ISO. */
const utcStamp = z.string().trim().min(10).max(40).refine((v) => Number.isFinite(Date.parse(v.includes("T") ? v : v.replace(" ", "T") + "Z")), "Hora inválida.");

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

/** RH: a sessão é de uma ficha que quem pede gere (a mesma guarda do "Confirmar terminal" no ponto). */
async function assertManagesSession(user: { id: number; role: string }, sessionId: number): Promise<void> {
  const { mysqlTerminalStore } = await import("./terminalSessions");
  const s = await (await mysqlTerminalStore()).byId(sessionId);
  if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "Troço de terminal não encontrado." });
  const { assertCanManageEmployee } = await import("./rhGuards");
  await assertCanManageEmployee(user, s.employeeId, "Sem permissão para rever o ponto desta pessoa.");
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

  /** B2: "Ainda estás no terminal?" → "Sim, estou" / "Já saí" (GPS do telemóvel, se der: também é prova). */
  answerStillHere: protectedProcedure
    .input(z.object({ answer: z.enum(["yes", "left"]), ...gpsFields }))
    .mutation(async ({ ctx, input }) => run(async () => {
      const { answerStillHere } = await import("./terminalWatch");
      return answerStillHere(await deps(), { employeeId: await myEmployeeId(ctx.user.id), actorUserId: ctx.user.id, answer: input.answer, fix: fixOf(input) });
    })),

  /** B2: "Ainda estou" depois de o lugar ter sido libertado (até 30 min, sem buraco). */
  reopen: protectedProcedure.input(z.object(gpsFields)).mutation(async ({ ctx, input }) => run(async () => {
    const { reopenTerminal } = await import("./terminalWatch");
    return reopenTerminal(await deps(), { employeeId: await myEmployeeId(ctx.user.id), actorUserId: ctx.user.id, fix: fixOf(input) });
  })),

  /** B2: Atividade diária → Resumo do dia: linha do tempo do terminal da cidade (com os buracos). */
  dayTimeline: protectedProcedure
    .input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida (AAAA-MM-DD)"), city: cityKey }))
    .query(async ({ ctx, input }) => {
      const d = await deps();
      const { terminalDayTimeline } = await import("./terminalReview");
      // desligado → nada (nem erro de acesso no Resumo do dia)
      if (!(await d.enabled())) return terminalDayTimeline(d, { date: input.date, city: input.city });
      requireAccess(ctx.user, "passagem_resumo_dia", "view");
      const actor = await actorOf(ctx.user);
      if (!actor.cities.includes(input.city)) throw new TRPCError({ code: "FORBIDDEN", message: "Essa cidade não é tua." });
      return terminalDayTimeline(d, { date: input.date, city: input.city });
    }),

  /** B2: Definições → zonas dos terminais: os centros de custos com raio de picagem (para avisar se um parque cai numa zona). */
  parkPoints: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "definicoes", "view");
    const [{ listProjectGeofences, getDb }, { sql }] = await Promise.all([import("./db"), import("drizzle-orm")]);
    const fences = await listProjectGeofences().catch(() => []);
    if (!fences.length) return [];
    const db = await getDb();
    const names = new Map<number, string>();
    if (db) {
      const res: any = await db.execute(sql`SELECT id, name FROM projects WHERE id IN (${sql.join(fences.map((f) => sql`${f.projectId}`), sql`, `)})`).catch(() => [[]]);
      const rows: any[] = Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : [];
      for (const r of rows) names.set(Number(r.id), String(r.name ?? ""));
    }
    return fences.map((f) => ({ projectId: f.projectId, name: names.get(f.projectId) || `Centro de custos ${f.projectId}`, lat: f.lat, lng: f.lng }));
  }),

  /** B2: RH → ficha → Ponto: os troços de terminal, e confirmar / corrigir / desmarcar (com motivo). */
  rh: router({
    list: protectedProcedure
      .input(z.object({ employeeId: z.number().int().positive(), days: z.number().int().min(1).max(120).optional() }))
      .query(async ({ ctx, input }) => {
        const { assertCanViewTimeRecords, assertCanManageEmployee } = await import("./rhGuards");
        await assertCanViewTimeRecords(ctx.user, input.employeeId);
        const canManage = await assertCanManageEmployee(ctx.user, input.employeeId).then(() => true, () => false);
        const { rhSessionsOf } = await import("./terminalReview");
        const { toDbUtc } = await import("../shared/terminalSession");
        const now = Date.now();
        const r = await rhSessionsOf(await deps(), { employeeId: input.employeeId, fromUtc: toDbUtc(now - (input.days ?? 45) * 86_400_000), toUtc: toDbUtc(now + 60_000) });
        return { ...r, canManage };
      }),
    confirm: protectedProcedure
      .input(z.object({ sessionId: z.number().int().positive(), note: reasonNote }))
      .mutation(async ({ ctx, input }) => run(async () => {
        await assertManagesSession(ctx.user, input.sessionId);
        const { rhConfirm } = await import("./terminalReview");
        return rhConfirm(await deps(), { userId: ctx.user.id }, input);
      })),
    correct: protectedProcedure
      .input(z.object({ sessionId: z.number().int().positive(), from: utcStamp, until: utcStamp, note: reasonNote }))
      .mutation(async ({ ctx, input }) => run(async () => {
        await assertManagesSession(ctx.user, input.sessionId);
        const { rhCorrect } = await import("./terminalReview");
        return rhCorrect(await deps(), { userId: ctx.user.id }, input);
      })),
    reject: protectedProcedure
      .input(z.object({ sessionId: z.number().int().positive(), note: reasonNote }))
      .mutation(async ({ ctx, input }) => run(async () => {
        await assertManagesSession(ctx.user, input.sessionId);
        const { rhReject } = await import("./terminalReview");
        return rhReject(await deps(), { userId: ctx.user.id }, input);
      })),
  }),

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
