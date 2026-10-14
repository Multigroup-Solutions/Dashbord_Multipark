/**
 * Plano 62, P0 — `extrasDia.timesProbe`: o diagnóstico dos tempos
 * (calibração), Extras-Dia → Pressão. SÓ o super admin; só lê; um dia
 * operacional por pedido; nunca lança para fora (os erros vêm em
 * `failures`). Sem interruptor: não escreve nem avisa ninguém (§11.0).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure } from "./_core/trpc";
import { PROBE_CITIES } from "../shared/sondaTempos";

/** Só o super admin (PURA, testada). */
export function canRunTimesProbe(user: { role?: string | null } | null | undefined): boolean {
  return user?.role === "super_admin";
}

const superOnly = protectedProcedure.use(({ ctx, next }) => {
  if (!canRunTimesProbe(ctx.user)) throw new TRPCError({ code: "FORBIDDEN", message: "Só o super admin corre o diagnóstico dos tempos." });
  return next({ ctx });
});

export const timesProbeInput = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  cities: z.array(z.enum(PROBE_CITIES)).min(1).max(3),
});

export const timesProbeProcedures = {
  timesProbe: superOnly.input(timesProbeInput).mutation(async ({ input }) => {
    const { runTimesProbe, defaultProbeDeps } = await import("./sondaTempos");
    return runTimesProbe(input, defaultProbeDeps());
  }),
  /**
   * 15 out 2026 — "De onde vêm os tempos" (Pressão, super admin): por cidade e
   * semana, chamadas, GPS, botão, motivos, Zellos que não batem, zonas em
   * falta e garagens sem papel. Só contagens (a tabela dos tempos).
   */
  serviceTimesCoverage: superOnly.query(async () => {
    const [{ getCoverageCard }, { scopedServiceCityKeys }, { operationalDayOf }] = await Promise.all([import("./serviceTimesViews"), import("./serviceTimesRead"), import("../shared/lisbonDay")]);
    return getCoverageCard({ today: operationalDayOf(Date.now()), cityKeys: await scopedServiceCityKeys() });
  }),
};
