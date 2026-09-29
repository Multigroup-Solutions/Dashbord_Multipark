/**
 * tRPC `marketing.gbp.*` — Google Business Profile no Marketing → Web & SEO.
 * Todas as rotas passam pela matriz de acessos do módulo Marketing (hoje só
 * super_admin — nada aqui alarga isso): ver = "view"; horários, publicações,
 * associação dos perfis, definições e "Atualizar agora" = "manage". Cada
 * perfil é filtrado pelo âmbito de cidade do utilizador; cada escrita fica no
 * registo de atividade.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../../_core/trpc";
import { can, requireAccess, withOverrides } from "../../_core/access";
import { CITY_KEYS, type CityKey } from "../../../shared/city";
import {
  GBP_METRIC_COLS, GBP_SETTING_KEY, POST_CTAS, POST_TOPICS, WEEKDAYS, gbpActions, gbpBusinessByCity, gbpConfigSchema, gbpImpressions,
  monthOf, postInputSchema, ratingByWeek, reviewKpis, sumGbpValues, type GbpMetricValues,
} from "../../../shared/googleBusinessProfile";
import { comparisonRange, daysBetweenInclusive } from "../../../shared/webAnalytics";
import { daysInRange } from "../../../shared/lisbonDay";

const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida (AAAA-MM-DD).");
const cityInput = z.union([z.enum(CITY_KEYS), z.literal("")]).optional();
const rangeInput = z.object({
  from: ISO, to: ISO, compare: z.enum(["previous", "yoy"]).default("previous"),
  city: cityInput, locationId: z.number().int().positive().optional(),
}).refine((v) => v.from <= v.to, "O início tem de ser antes do fim.").refine((v) => daysBetweenInclusive(v.from, v.to) <= 400, "No máximo 400 dias.");

const hhmm = z.string().max(5);
const intervalSchema = z.object({ open: hhmm, close: hhmm });
const dayHoursSchema = z.object({ day: z.enum(WEEKDAYS), mode: z.enum(["closed", "open24", "intervals"]), intervals: z.array(intervalSchema).max(6) });
const specialDaySchema = z.object({ date: ISO, closed: z.boolean(), intervals: z.array(intervalSchema).max(6) });
const locationIds = z.array(z.number().int().positive()).min(1, "Escolhe pelo menos um perfil.").max(50);

type CtxUser = { id: number; role: string; accessOverrides?: any };

function badRequest(e: unknown): never {
  if (e instanceof TRPCError) throw e;
  throw new TRPCError({ code: "BAD_REQUEST", message: String((e as any)?.message ?? e).slice(0, 700) });
}

async function log(userId: number, action: string, details: string, entityId: number | null) {
  try {
    const { logActivity } = await import("../../db");
    await logActivity({ userId, action, entity: "google_business_location", entityId, details: details.slice(0, 1000) } as any);
  } catch { /* o registo nunca parte a operação */ }
}

/** Perfis no âmbito (cidade) do utilizador; `ids` pedidos têm de estar todos. */
async function scopedLocations(ids?: readonly number[] | null, opts: { includeInactive?: boolean } = {}) {
  const { loadGbpConfig, resolvedLocations, scopeLocations } = await import("./insightsQueries");
  const cfg = await loadGbpConfig();
  const all = scopeLocations(await resolvedLocations(cfg), { includeInactive: opts.includeInactive ?? true });
  if (!ids) return { cfg, locs: all };
  const locs = ids.map((id) => all.find((l) => l.id === id));
  if (locs.some((l) => !l)) throw new TRPCError({ code: "FORBIDDEN", message: "Perfil fora do teu âmbito ou inexistente." });
  return { cfg, locs: locs as NonNullable<(typeof locs)[number]>[] };
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export const gbpRouter = router({
  overview: protectedProcedure.input(rangeInput).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "marketing", "view");
    try {
      const q = await import("./insightsQueries");
      const { dbGbpStore } = await import("./insightsStore");
      const { connection } = await import("./oauth");
      const cfg = await q.loadGbpConfig();
      const resolved = await q.resolvedLocations(cfg);
      const visible = q.scopeLocations(resolved, { includeInactive: true });
      const locs = q.scopeLocations(resolved, { city: (input.city || null) as CityKey | null, locationId: input.locationId ?? null });
      const ids = locs.map((l) => l.id);
      const prev = comparisonRange(input.from, input.to, input.compare);
      const [cur, before, byLocCur, byLocPrev, reviewsCur, reviewsPrev, unanswered, coverage] = await Promise.all([
        q.gbpDaily(ids, input.from, input.to), q.gbpDaily(ids, prev.from, prev.to),
        q.gbpTotalsByLocation(ids, input.from, input.to), q.gbpTotalsByLocation(ids, prev.from, prev.to),
        q.reviewsLite(locs, input.from, input.to), q.reviewsLite(locs, prev.from, prev.to),
        q.unansweredByLocation(ids), q.gbpCoverage(ids),
      ]);
      const curDays = daysInRange(input.from, input.to), prevDays = daysInRange(prev.from, prev.to);
      const curBy = new Map(cur.map((r) => [r.day, r.values])), prevBy = new Map(before.map((r) => [r.day, r.values]));
      const series = curDays.map((day, i) => {
        const v = curBy.get(day), p = prevDays[i] ? prevBy.get(prevDays[i]) : undefined;
        return {
          day,
          impMaps: v ? v.impDesktopMaps + v.impMobileMaps : 0, impSearch: v ? v.impDesktopSearch + v.impMobileSearch : 0,
          calls: v?.callClicks ?? 0, directions: v?.directionRequests ?? 0, website: v?.websiteClicks ?? 0,
          prevImpressions: p ? gbpImpressions(p) : null, prevActions: p ? gbpActions(p) : null,
        };
      });
      const conn = await connection().catch(() => null);
      const reviewsFor = (id: number, projectId: number | null, list: typeof reviewsCur) => list.filter((r) => r.locationId === id || (r.locationId == null && projectId != null && r.projectId === projectId));
      const zero = (): GbpMetricValues => Object.fromEntries(GBP_METRIC_COLS.map((c) => [c, 0])) as GbpMetricValues;
      return {
        connection: { status: conn?.status ?? "disconnected", accountEmail: conn?.accountEmail ?? null, lastError: conn?.lastError ?? null },
        enabled: cfg.enabled,
        range: { from: input.from, to: input.to }, prevRange: prev,
        totals: { cur: sumGbpValues(cur), prev: sumGbpValues(before) },
        series,
        coverage,
        cities: Array.from(new Set(visible.map((l) => l.city).filter((c): c is CityKey => !!c))),
        allLocations: visible.map((l) => ({ id: l.id, title: l.title, city: l.city, active: l.active && l.available })),
        locations: locs.map((l) => {
          const rc = reviewKpis(reviewsFor(l.id, l.projectId, reviewsCur));
          return {
            id: l.id, title: l.title, city: l.city, brand: l.brand, mappingSource: l.mappingSource, address: l.address, mapsUri: l.mapsUri,
            openStatus: l.openStatus, hasVoiceOfMerchant: l.hasVoiceOfMerchant, hasGoogleUpdated: l.hasGoogleUpdated, hasPendingEdits: l.hasPendingEdits,
            canOperateLocalPost: l.canOperateLocalPost, metaCheckedAt: l.metaCheckedAt,
            cur: byLocCur.get(l.id) ?? { ...zero(), days: 0 }, prev: byLocPrev.get(l.id) ?? { ...zero(), days: 0 },
            reviews: { count: rc.count, avgRating: rc.avgRating, responseRate: rc.responseRate, medianResponseHours: rc.medianResponseHours },
            unanswered: unanswered.get(l.id) ?? null,
          };
        }),
        reviews: { cur: reviewKpis(reviewsCur), prev: reviewKpis(reviewsPrev), byWeek: ratingByWeek(reviewsCur) },
        lastRun: parseJson<any>(await dbGbpStore.getState("gbp:lastRun").catch(() => null)),
        lastSuccessAt: await dbGbpStore.getState("gbp:lastSuccessAt").catch(() => null),
        lastError: await dbGbpStore.getState("gbp:lastError").catch(() => null),
        alerts: parseJson<{ day: string; alerts: any[] }>(await dbGbpStore.getState("gbp:alerts:latest").catch(() => null)),
        canEdit: can(withOverrides(ctx.user as CtxUser) as any, "marketing", "manage"),
      };
    } catch (e) { badRequest(e); }
  }),

  /** Pesquisas que mostraram os perfis (meses completos do período), paginadas no SQL. */
  keywords: protectedProcedure.input(z.object({
    from: ISO, to: ISO, city: cityInput, locationId: z.number().int().positive().optional(),
    page: z.number().int().min(1).max(10_000).default(1), pageSize: z.number().int().min(5).max(100).default(25), search: z.string().trim().max(100).optional(),
  })).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "marketing", "view");
    const q = await import("./insightsQueries");
    const cfg = await q.loadGbpConfig();
    const locs = q.scopeLocations(await q.resolvedLocations(cfg), { city: (input.city || null) as CityKey | null, locationId: input.locationId ?? null });
    const r = await q.gbpKeywords({ ids: locs.map((l) => l.id), fromMonth: monthOf(input.from), toMonth: monthOf(input.to), page: input.page, pageSize: input.pageSize, search: input.search });
    return { ...r, page: input.page, pageSize: input.pageSize, fromMonth: monthOf(input.from), toMonth: monthOf(input.to) };
  }),

  /** Negócio: chamadas e pedidos de direções vs reservas por cidade × dia. */
  business: protectedProcedure.input(z.object({ from: ISO, to: ISO }).refine((v) => v.from <= v.to && daysBetweenInclusive(v.from, v.to) <= 400, "Período inválido.")).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "marketing", "view");
    const q = await import("./insightsQueries");
    const cfg = await q.loadGbpConfig();
    const locs = q.scopeLocations(await q.resolvedLocations(cfg), {});
    const daily = await q.gbpDailyByLocation(locs.map((l) => l.id), input.from, input.to);
    const cityOf = new Map(locs.map((l) => [l.id, l.city]));
    const actions = new Map<CityKey, Map<string, { calls: number; directions: number; website: number }>>();
    for (const r of daily) {
      const c = cityOf.get(r.locationId);
      if (!c) continue;
      const m = actions.get(c) ?? new Map();
      const e = m.get(r.day) ?? { calls: 0, directions: 0, website: 0 };
      e.calls += r.values.callClicks; e.directions += r.values.directionRequests; e.website += r.values.websiteClicks;
      m.set(r.day, e); actions.set(c, m);
    }
    const bookings = await q.bookingsByCityDay(input.from, input.to).catch(() => new Map());
    const allowed = q.allowedCities();
    return { cities: gbpBusinessByCity(daysInRange(input.from, input.to), actions, bookings).filter((c) => !allowed || allowed.has(c.city)), unmapped: locs.filter((l) => !l.city).length };
  }),

  settings: router({
    get: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "marketing", "view");
      const q = await import("./insightsQueries");
      const cfg = await q.loadGbpConfig();
      const locs = q.scopeLocations(await q.resolvedLocations(cfg), { includeInactive: true });
      return {
        canEdit: can(withOverrides(ctx.user as CtxUser) as any, "marketing", "manage"),
        config: cfg,
        locations: locs.map((l) => ({ id: l.id, locationName: l.locationName, title: l.title, address: l.address, city: l.city, brand: l.brand, active: l.active, available: l.available, mappingSource: l.mappingSource })),
      };
    }),
    save: protectedProcedure.input(gbpConfigSchema).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "marketing", "manage");
      const { setSetting } = await import("../../appSettings");
      try {
        const r = await setSetting(GBP_SETTING_KEY, input, ctx.user.id);
        if (r.changed) await log(ctx.user.id, "update", `${GBP_SETTING_KEY} atualizado (perfis associados: ${input.locationMap.length}; recolha ${input.enabled ? "ligada" : "desligada"})`, null);
        return { ok: true, changed: r.changed };
      } catch (e) { badRequest(e); }
    }),
    runNow: protectedProcedure.mutation(async ({ ctx }) => {
      requireAccess(ctx.user, "marketing", "manage");
      const { runGbpInsightsSync } = await import("./insights");
      const r = await runGbpInsightsSync({ deadlineAt: Date.now() + 45_000 });
      return { ok: r.ok, done: r.done, busy: !!r.busy, skipped: r.skipped ?? null, blocked: r.blocked, errors: r.errors, warnings: r.warnings, windows: r.windows, keywordMonths: r.keywordMonths };
    }),
  }),

  hours: router({
    get: protectedProcedure.input(z.object({ locationId: z.number().int().positive() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "marketing", "manage");
      const { locs } = await scopedLocations([input.locationId]);
      const { clientFor, readHours, manageLocationOf } = await import("./manage");
      try { return await readHours(await clientFor(), manageLocationOf(locs[0])); } catch (e) { badRequest(e); }
    }),
    save: protectedProcedure.input(z.object({
      locationIds, regular: z.array(dayHoursSchema).length(7).nullable().optional(),
      special: z.array(specialDaySchema).max(60).nullable().optional(), removeSpecial: z.array(ISO).max(60).optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "marketing", "manage");
      const { locs } = await scopedLocations(input.locationIds);
      const { clientFor, applyHours, manageLocationOf } = await import("./manage");
      const { lisbonToday } = await import("../../../shared/expensePeriods");
      try {
        const results = await applyHours(await clientFor(), locs.map(manageLocationOf),
          { regular: input.regular ?? null, special: input.special ?? null, removeSpecial: input.removeSpecial ?? [], today: lisbonToday() },
          (details, id) => log(ctx.user.id, "update", details, id));
        return { results, ok: results.every((r) => r.ok) };
      } catch (e) { badRequest(e); }
    }),
  }),

  posts: router({
    list: protectedProcedure.input(z.object({ locationId: z.number().int().positive() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "marketing", "view");
      const { locs } = await scopedLocations([input.locationId]);
      const { clientFor, listPosts, manageLocationOf } = await import("./manage");
      try { return { posts: await listPosts(await clientFor(), manageLocationOf(locs[0])) }; } catch (e) { badRequest(e); }
    }),
    create: protectedProcedure.input(z.object({ locationIds, post: postInputSchema })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "marketing", "manage");
      const { locs } = await scopedLocations(input.locationIds);
      const { clientFor, createPosts, manageLocationOf } = await import("./manage");
      try {
        const results = await createPosts(await clientFor(), locs.map(manageLocationOf), input.post, (details, id) => log(ctx.user.id, "create", details, id));
        return { results, ok: results.every((r) => r.ok) };
      } catch (e) { badRequest(e); }
    }),
    remove: protectedProcedure.input(z.object({ locationId: z.number().int().positive(), name: z.string().max(200) })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "marketing", "manage");
      const { locs } = await scopedLocations([input.locationId]);
      const { clientFor, deletePost, manageLocationOf } = await import("./manage");
      try { await deletePost(await clientFor(), manageLocationOf(locs[0]), input.name, (details, id) => log(ctx.user.id, "delete", details, id)); return { ok: true }; }
      catch (e) { badRequest(e); }
    }),
    /** Rascunho com IA (lite) — vai para o editor; publicar é sempre humano. */
    draft: protectedProcedure.input(z.object({
      topic: z.string().trim().min(3, "Descreve o tema.").max(800), topicType: z.enum(POST_TOPICS).default("STANDARD"),
      cta: z.union([z.enum(POST_CTAS), z.literal("")]).default(""), locationId: z.number().int().positive().optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "marketing", "manage");
      const { cfg, locs } = await scopedLocations(input.locationId ? [input.locationId] : null);
      if (!cfg.aiPostDrafts) return { text: null, skipped: "disabled" };
      const loc = input.locationId ? locs[0] : null;
      const { draftPost } = await import("./manage");
      const { GBP_BRAND_LABELS, GBP_CITY_LABELS } = await import("../../../shared/googleBusinessProfile");
      return draftPost({ topic: input.topic, topicType: input.topicType, cta: input.cta || null, userId: ctx.user.id,
        brand: loc?.brand ? GBP_BRAND_LABELS[loc.brand] : null, city: loc?.city ? GBP_CITY_LABELS[loc.city] : null });
    }),
  }),
});

