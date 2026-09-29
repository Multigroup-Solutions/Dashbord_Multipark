/**
 * tRPC — Conferência de caixa (era / é), SÓ A PEDIDO.
 *
 * "Era" = memória do webhook (`multipark_webhook_snapshots`, na nossa BD, só
 * acréscimo). "É" = BD da Multipark ao vivo. Nada corre sozinho: cada
 * comparação é feita quando alguém a pede (ficha da reserva ou Faturação →
 * "Correção de caixa"). Só leitura; não abre casos nem grava nada.
 *
 * Acesso: a porta da Faturação → Caixa (módulo "faturacao" ver + totais
 * financeiros), ver server/cashCheck/access.ts. Âmbito de cidade por
 * Park.city em todas as leituras da Multipark.
 *
 * Orçamento (Vercel 60 s): a página do dia lê no máximo 200 saídas por
 * pedido (paginado por id); a "só na memória" lê no máximo 300 reservas.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "./_core/trpc";
import { requireAccess } from "./_core/access";
import { scopedCityNames } from "./bookingFileRouter";
import { cashCheckAllowed } from "./cashCheck/access";
import {
  compareBooking, eraRows, memoryMoments, worstSeverity, severityRank, expectedAmount, paidAmount,
  MONEY_HISTORY_FIELDS, type Divergence, type LiveFinance,
} from "./cashCheck/rules";
import type { MemorySnapshot } from "./webhookMemory";

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Motivos para fechar um caso (a explicação escrita é sempre obrigatória). */
export const CLOSE_REASONS = ["desconto_autorizado", "erro_corrigido", "cortesia", "pago_noutro_canal", "parceiro_ou_pro", "perda", "outro"] as const;
export const ONLY_MEMORY_MAX = 300;

async function permissionOverrides(userId: number): Promise<Record<string, string>> {
  try {
    const { getUserPermissionOverrides } = await import("./db");
    return await getUserPermissionOverrides(userId);
  } catch {
    return {};
  }
}

/** Porta: Faturação (ver) + totais financeiros. */
export async function requireCashCheck(user: { id: number; role: string }) {
  requireAccess(user, "faturacao", "view");
  if (!cashCheckAllowed(user, await permissionOverrides(user.id))) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para ver totais financeiros." });
  }
}

type Unavailable = { available: false; reason: string };

function snapshotOut(s: MemorySnapshot) {
  return {
    id: s.id, eventType: s.eventType, receivedAt: s.receivedAt, sourceUpdatedAt: s.sourceUpdatedAt, status: s.status,
    checkIn: s.checkIn, checkOut: s.checkOut, bookingPrice: s.bookingPrice, paymentMethod: s.paymentMethod,
  };
}

export interface DayDivergentRow {
  id: string;
  code: string | null;
  parkId: string | null;
  parkName: string | null;
  status: string | null;
  checkOut: string | null;
  webhooks: number;
  priceFirst: number | null;
  priceCheckin: number | null;
  priceLast: number | null;
  priceNow: number | null;
  expected: number | null;
  paid: number | null;
  methodEra: string | null;
  methodNow: string | null;
  paymentMethods: string[];
  cashierClosed: boolean;
  severity: Divergence["severity"] | null;
  divergences: Divergence[];
}

/** Linha da lista "Correção de caixa". PURA. */
export function dayRow(live: LiveFinance | null, memory: readonly MemorySnapshot[], divergences: Divergence[], fallback?: { id: string; parkName?: string | null }): DayDivergentRow {
  const m = memoryMoments(memory);
  return {
    id: live?.id ?? fallback?.id ?? m.last?.bookingId ?? "",
    code: live?.code ?? null,
    parkId: live?.parkId ?? m.last?.parkId ?? null,
    parkName: live?.parkName ?? fallback?.parkName ?? null,
    status: live?.status ?? m.last?.status ?? null,
    checkOut: live?.checkOut ?? m.last?.checkOut ?? null,
    webhooks: m.count,
    priceFirst: m.first?.bookingPrice ?? null,
    priceCheckin: m.checkin?.bookingPrice ?? null,
    priceLast: m.last?.bookingPrice ?? null,
    priceNow: live?.bookingPrice ?? null,
    expected: live ? expectedAmount(live) : null,
    paid: live ? paidAmount(live) : null,
    methodEra: m.lastMethod,
    methodNow: live?.paymentMethod ?? null,
    paymentMethods: live?.paymentMethods ?? [],
    cashierClosed: live?.cashierClosed.done ?? false,
    severity: worstSeverity(divergences),
    divergences,
  };
}

/** A última saída que a memória conhece (último retrato com saída). PURA. */
export function memoryCheckout(memory: readonly MemorySnapshot[]): string | null {
  const withOut = [...memory].filter((s) => s.checkOut).sort((a, b) => (a.receivedAt ?? "").localeCompare(b.receivedAt ?? "") || a.id - b.id);
  return withOut.length ? withOut[withOut.length - 1].checkOut : null;
}

/** "Só na memória": motivo com o que a Multipark diz agora. PURA. */
export function onlyMemoryDivergence(live: LiveFinance | null, memCount: number, ctx: { startMs: number; endMs: number; allowedParkIds: ReadonlySet<string> }): Divergence | null {
  if (!live) {
    return { code: "only_memory", severity: "medium", label: "Só na memória do webhook", detail: `A memória tem ${memCount} webhook(s) com saída neste dia, mas a Multipark já não devolve a reserva (apagada ou fora das tuas cidades).` };
  }
  const outMs = live.checkOut ? Date.parse(live.checkOut) : NaN;
  const inDay = Number.isFinite(outMs) && outMs >= ctx.startMs && outMs < ctx.endMs;
  const inParks = live.parkId != null && ctx.allowedParkIds.has(live.parkId);
  if (inDay && inParks) return null; // está na lista do dia: comparada lá
  const why = [
    !inDay ? `a saída agora é ${live.checkOut ? live.checkOut.slice(0, 16).replace("T", " ") + " UTC" : "sem data"}` : null,
    !inParks ? `o parque agora é ${live.parkName ?? live.parkId ?? "?"}` : null,
    live.status ? `estado ${live.status}` : null,
  ].filter(Boolean).join("; ");
  return { code: "only_memory", severity: "medium", label: "Só na memória do webhook", detail: `O webhook deu saída neste dia, mas na Multipark ${why}.` };
}

export const cashCheckRouter = router({
  /** Pode ver a conferência? (para a ficha mostrar ou esconder a secção) */
  access: protectedProcedure.query(async ({ ctx }) => {
    try {
      await requireCashCheck(ctx.user);
      return { allowed: true };
    } catch {
      return { allowed: false };
    }
  }),

  /** Parques do âmbito (para escolher na "Correção de caixa"). */
  parks: protectedProcedure.input(z.object({ projectId: z.number().optional() }).optional()).query(async ({ ctx }) => {
    await requireCashCheck(ctx.user);
    const { getMultiparkParkClassification } = await import("./multiparkDb/dayBookings");
    const r = await getMultiparkParkClassification(scopedCityNames());
    if (!r.available) return { available: false as const, reason: r.reason };
    return {
      available: true as const,
      parks: r.data.parks.map((p) => ({ id: p.id, name: p.name, city: p.cityName, ours: p.ours, groupLabel: p.groupLabel })),
    };
  }),

  /** Ficha da reserva → "Conferência (era / é)". */
  booking: protectedProcedure.input(z.object({ id: z.string().trim().min(1).max(64), projectId: z.number().optional() })).query(async ({ ctx, input }) => {
    await requireCashCheck(ctx.user);
    const cities = scopedCityNames();
    const { safeMultiparkRead } = await import("./multiparkDb/read");
    const { readLiveFinanceByIds } = await import("./multiparkDb/cashCheck");
    const { getBookingFileTimeline } = await import("./multiparkDb/bookingFile");
    const { listMemoryForBookings } = await import("./webhookMemory");

    const liveR = await safeMultiparkRead("caixa/reserva", async () => (await readLiveFinanceByIds([input.id], cities))[0] ?? null);
    let memory: MemorySnapshot[] = [];
    let memoryError: string | null = null;
    try {
      memory = (await listMemoryForBookings([input.id])).get(input.id) ?? [];
    } catch {
      memoryError = "Não foi possível ler a memória do webhook (BD do dashboard).";
    }
    const live = liveR.available ? liveR.data : null;
    // Âmbito: sem a reserva confirmada nas cidades da pessoa, não se mostra a memória.
    if (cities !== undefined && !live) memory = [];

    const tl = await getBookingFileTimeline(input.id, cities);
    const history = tl.available
      ? tl.data.entries
        .map((e) => ({ id: e.id, at: e.at, who: e.who, kindLabel: e.kindLabel, platform: e.platform, source: e.source, changes: e.changes.filter((c) => MONEY_HISTORY_FIELDS.has(c.field)) }))
        .filter((e) => e.changes.length > 0)
      : [];

    return {
      live: liveR.available ? (live ? { available: true as const, found: true as const, data: live } : { available: true as const, found: false as const }) : ({ available: false, reason: liveR.reason } as Unavailable),
      memory: memory.map(snapshotOut),
      memoryError,
      rows: eraRows(memory, live),
      divergences: liveR.available ? compareBooking(memory, live) : [],
      history,
      historyUnavailable: tl.available ? null : tl.reason,
    };
  }),

  /**
   * Faturação → "Correção de caixa": parque(s) + dia de Lisboa. Compara as
   * saídas desse dia (memória vs Multipark ao vivo) e devolve SÓ as
   * divergências. Paginado: `cursor` = último id da página anterior.
   */
  day: protectedProcedure.input(z.object({
    parkIds: z.array(z.string().trim().min(1).max(128)).min(1).max(100),
    day: DAY,
    cursor: z.string().max(128).nullable().optional(),
    pageSize: z.number().int().min(10).max(200).optional(),
    projectId: z.number().optional(),
  })).query(async ({ ctx, input }) => {
    await requireCashCheck(ctx.user);
    const cities = scopedCityNames();
    const { safeMultiparkRead } = await import("./multiparkDb/read");
    const { lisbonDayBounds, buildParksSql, mapParks } = await import("./multiparkDb/dayBookings");
    const { multiparkDbQuery } = await import("./multiparkDb/client");
    const { readLiveCheckoutPage, readLiveFinanceByIds } = await import("./multiparkDb/cashCheck");
    const { listMemoryForBookings, listMemoryBookingIdsByCheckout } = await import("./webhookMemory");
    const bounds = lisbonDayBounds(input.day);

    const r = await safeMultiparkRead("caixa/dia", async () => {
      const ps = buildParksSql();
      const inScope = mapParks(await multiparkDbQuery(ps.sql, ps.params), cities);
      const wanted = new Set(input.parkIds);
      const parks = inScope.filter((p) => wanted.has(p.id));
      if (!parks.length) return { parks: [], page: { rows: [] as LiveFinance[], nextCursor: null as string | null }, onlyMemoryLive: null as LiveFinance[] | null, onlyMemoryIds: [] as string[] };
      const parkIds = parks.map((p) => p.id);
      const page = await readLiveCheckoutPage(bounds, parkIds, input.cursor ?? null, input.pageSize ?? 100, cities);
      // "Só na memória" só na 1.ª página (não depende da paginação da Multipark).
      let onlyMemoryIds: string[] = [];
      let onlyMemoryLive: LiveFinance[] | null = null;
      if (!input.cursor) {
        onlyMemoryIds = await listMemoryBookingIdsByCheckout(parkIds, bounds.start, bounds.end, ONLY_MEMORY_MAX + 1);
        onlyMemoryLive = onlyMemoryIds.length ? await readLiveFinanceByIds(onlyMemoryIds.slice(0, ONLY_MEMORY_MAX), cities) : [];
      }
      return { parks, page, onlyMemoryLive, onlyMemoryIds };
    });
    if (!r.available) return { available: false as const, reason: r.reason };
    const { parks, page, onlyMemoryLive, onlyMemoryIds } = r.data;
    const allowed = new Set(parks.map((p) => p.id));
    const parkName = new Map(parks.map((p) => [p.id, p.name]));

    let memory = new Map<string, MemorySnapshot[]>();
    let memoryError: string | null = null;
    try {
      memory = await listMemoryForBookings([...page.rows.map((x) => x.id), ...onlyMemoryIds.slice(0, ONLY_MEMORY_MAX)]);
    } catch {
      memoryError = "Não foi possível ler a memória do webhook (BD do dashboard): a lista mostra só o que se vê na Multipark.";
    }

    const rows: DayDivergentRow[] = [];
    for (const live of page.rows) {
      const mem = memory.get(live.id) ?? [];
      const divs = memoryError ? compareBooking([], live).filter((d) => d.code !== "only_live") : compareBooking(mem, live);
      if (divs.length) rows.push(dayRow(live, mem, divs));
    }

    let onlyMemory: DayDivergentRow[] | null = null;
    if (onlyMemoryLive && !memoryError) {
      onlyMemory = [];
      const liveById = new Map(onlyMemoryLive.map((x) => [x.id, x]));
      for (const id of onlyMemoryIds.slice(0, ONLY_MEMORY_MAX)) {
        const mem = memory.get(id) ?? [];
        const out = memoryCheckout(mem);
        const outMs = out ? Date.parse(out) : NaN;
        // A última saída que a memória conhece tem de ser neste dia.
        if (!(Number.isFinite(outMs) && outMs >= bounds.startMs && outMs < bounds.endMs)) continue;
        const d = onlyMemoryDivergence(liveById.get(id) ?? null, mem.length, { startMs: bounds.startMs, endMs: bounds.endMs, allowedParkIds: allowed });
        if (d) onlyMemory.push(dayRow(liveById.get(id) ?? null, mem, [d], { id, parkName: parkName.get(mem[mem.length - 1]?.parkId ?? "") ?? null }));
      }
    }

    rows.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || (a.checkOut ?? "").localeCompare(b.checkOut ?? ""));
    return {
      available: true as const,
      day: input.day,
      parks: parks.map((p) => ({ id: p.id, name: p.name })),
      scanned: page.rows.length,
      nextCursor: page.nextCursor,
      rows,
      onlyMemory,
      onlyMemoryTruncated: onlyMemoryIds.length > ONLY_MEMORY_MAX,
      memoryError,
    };
  }),

  // ─── Fase 3: casos da "Correção de caixa" (varredura automática) ─────────

  /** Fila de casos, no âmbito de cidade de quem vê. */
  cases: protectedProcedure.input(z.object({
    view: z.enum(["abertos", "fechados", "todos"]).optional(),
    severity: z.enum(["critical", "high", "medium"]).optional(),
    code: z.string().max(40).optional(),
    parkId: z.string().max(128).optional(),
    day: DAY.optional(),
    limit: z.number().int().min(10).max(200).optional(),
    offset: z.number().int().min(0).max(100_000).optional(),
    projectId: z.number().optional(),
  }).optional()).query(async ({ ctx, input }) => {
    await requireCashCheck(ctx.user);
    const { listCases } = await import("./cashCheck/caseQueries");
    return listCases(input ?? {});
  }),

  /** Detalhe de um caso: o caso, a história, e (reserva) o era/é e quem mexeu no dinheiro. */
  caseDetail: protectedProcedure.input(z.object({ id: z.number().int().positive(), projectId: z.number().optional() })).query(async ({ ctx, input }) => {
    await requireCashCheck(ctx.user);
    const { getCaseDetail } = await import("./cashCheck/caseQueries");
    const r = await getCaseDetail(input.id, scopedCityNames());
    if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Caso não encontrado (ou fora das tuas cidades)." });
    return { ...r, canManage: await canManageCases(ctx.user) };
  }),

  /** Mudar o estado: em análise · fechar (motivo + explicação obrigatórios) · reabrir · nota. */
  caseAction: protectedProcedure.input(z.object({
    id: z.number().int().positive(),
    action: z.enum(["analise", "fechar", "reabrir", "nota"]),
    reason: z.enum(CLOSE_REASONS).optional(),
    explanation: z.string().trim().max(4000).optional(),
    projectId: z.number().optional(),
  })).mutation(async ({ ctx, input }) => {
    await requireCashCheck(ctx.user);
    if (!(await canManageCases(ctx.user))) throw new TRPCError({ code: "FORBIDDEN", message: "Só quem confere a caixa (Faturação → gerir) pode mudar os casos." });
    const { applyCaseAction } = await import("./cashCheck/caseQueries");
    const r = await applyCaseAction({ id: input.id, action: input.action, reason: input.reason ?? null, explanation: input.explanation ?? null, userId: ctx.user.id });
    if (!r.ok) throw new TRPCError({ code: r.code, message: r.message });
    return { success: true };
  }),

  // ─── Fase 3: contagem da caixa (R24) ─────────────────────────────────────

  /** Parque + dia: recebido em dinheiro (Multipark ao vivo), gastos pagos da caixa e a contagem gravada. */
  countDay: protectedProcedure.input(z.object({ parkId: z.string().trim().min(1).max(128), day: DAY, projectId: z.number().optional() })).query(async ({ ctx, input }) => {
    await requireCashCheck(ctx.user);
    const { getCountDay } = await import("./cashCheck/caseQueries");
    return getCountDay(input.parkId, input.day);
  }),

  saveCount: protectedProcedure.input(z.object({
    parkId: z.string().trim().min(1).max(128),
    day: DAY,
    counted: z.number().min(0).max(10_000_000),
    note: z.string().trim().max(2000).optional(),
    expenses: z.array(z.object({ description: z.string().trim().min(2).max(255), amount: z.number().min(0).max(1_000_000), receipt: z.string().trim().max(255).optional() })).max(100),
    projectId: z.number().optional(),
  })).mutation(async ({ ctx, input }) => {
    await requireCashCheck(ctx.user);
    requireAccess(ctx.user, "faturacao", "edit");
    const { saveCount } = await import("./cashCheck/caseQueries");
    const r = await saveCount({ ...input, userId: ctx.user.id });
    if (!r.ok) throw new TRPCError({ code: r.code, message: r.message });
    return r;
  }),

  // ─── Fase 4: cruzar com o exterior ───────────────────────────────────────

  /** Chaves da InvoiceExpress e da Stripe (só se configuradas, nunca os valores) e a última corrida diária. */
  externalStatus: protectedProcedure.input(z.object({ projectId: z.number().optional() }).optional()).query(async ({ ctx }) => {
    await requireCashCheck(ctx.user);
    const { externalStatus } = await import("./cashExternal");
    return externalStatus();
  }),

  // Multibanco do dia (R30): talões fotografados na contagem da caixa.
  mbDay: protectedProcedure.input(z.object({ parkId: z.string().trim().min(1).max(128), day: DAY, projectId: z.number().optional() })).query(async ({ ctx, input }) => {
    await requireCashCheck(ctx.user);
    const { getMbDay } = await import("./cashExternal");
    return getMbDay(input.parkId, input.day);
  }),

  addMbReceipt: protectedProcedure.input(z.object({
    parkId: z.string().trim().min(1).max(128),
    day: DAY,
    amount: z.number().positive().max(100_000),
    bookingId: z.string().trim().max(128).optional(),
    note: z.string().trim().max(500).optional(),
    photoBase64: z.string().max(12_000_000).optional(),
    mimeType: z.string().max(64).optional(),
    projectId: z.number().optional(),
  })).mutation(async ({ ctx, input }) => {
    await requireCashCheck(ctx.user);
    requireAccess(ctx.user, "faturacao", "edit");
    const { addMbReceipt } = await import("./cashExternal");
    const r = await addMbReceipt({ ...input, userId: ctx.user.id });
    if (!r.ok) throw new TRPCError({ code: r.code, message: r.message });
    return r;
  }),

  removeMbReceipt: protectedProcedure.input(z.object({ id: z.number().int().positive(), projectId: z.number().optional() })).mutation(async ({ ctx, input }) => {
    await requireCashCheck(ctx.user);
    requireAccess(ctx.user, "faturacao", "edit");
    const { removeMbReceipt } = await import("./cashExternal");
    const r = await removeMbReceipt({ id: input.id, userId: ctx.user.id });
    if (!r.ok) throw new TRPCError({ code: r.code, message: r.message });
    return r;
  }),

  confirmMbDay: protectedProcedure.input(z.object({ parkId: z.string().trim().min(1).max(128), day: DAY, projectId: z.number().optional() })).mutation(async ({ ctx, input }) => {
    await requireCashCheck(ctx.user);
    requireAccess(ctx.user, "faturacao", "edit");
    const { confirmMbDay } = await import("./cashExternal");
    const r = await confirmMbDay({ parkId: input.parkId, day: input.day, userId: ctx.user.id });
    if (!r.ok) throw new TRPCError({ code: r.code, message: r.message });
    return r;
  }),

  // Viva Wallet: CSV exportado (enquanto o cruzamento automático está desligado).
  importVivaCsv: protectedProcedure.input(z.object({ csv: z.string().min(10).max(4_000_000), fileName: z.string().trim().max(255).optional(), projectId: z.number().optional() })).mutation(async ({ ctx, input }) => {
    await requireCashCheck(ctx.user);
    if (!(await canManageCases(ctx.user))) throw new TRPCError({ code: "FORBIDDEN", message: "Só quem confere a caixa (Faturação → gerir)." });
    const { importVivaCsv } = await import("./cashExternal");
    const r = await importVivaCsv({ csv: input.csv, fileName: input.fileName ?? null, userId: ctx.user.id });
    if (!r.ok) throw new TRPCError({ code: r.code, message: r.message });
    return r;
  }),

  vivaImports: protectedProcedure.input(z.object({ projectId: z.number().optional() }).optional()).query(async ({ ctx }) => {
    await requireCashCheck(ctx.user);
    const { listVivaImports } = await import("./cashExternal");
    return listVivaImports();
  }),

  // Recebimentos do fim do mês (Pro, agentes, agregadores), conferidos à mão.
  monthly: protectedProcedure.input(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), projectId: z.number().optional() })).query(async ({ ctx, input }) => {
    await requireCashCheck(ctx.user);
    const { monthlyOverview } = await import("./cashExternal");
    return monthlyOverview(input.month);
  }),

  addMonthlyReceipt: protectedProcedure.input(z.object({
    kind: z.enum(["pro", "agente", "agregador"]),
    entityId: z.string().trim().min(1).max(191),
    entityName: z.string().trim().min(1).max(255),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    amount: z.number().positive().max(10_000_000),
    receivedOn: DAY.optional(),
    note: z.string().trim().max(500).optional(),
    proofBase64: z.string().max(12_000_000).optional(),
    mimeType: z.string().max(64).optional(),
    projectId: z.number().optional(),
  })).mutation(async ({ ctx, input }) => {
    await requireCashCheck(ctx.user);
    if (!(await canManageCases(ctx.user))) throw new TRPCError({ code: "FORBIDDEN", message: "Só quem confere a caixa (Faturação → gerir)." });
    const { addMonthlyReceipt } = await import("./cashExternal");
    const r = await addMonthlyReceipt({ ...input, userId: ctx.user.id });
    if (!r.ok) throw new TRPCError({ code: r.code, message: r.message });
    return r;
  }),

  removeMonthlyReceipt: protectedProcedure.input(z.object({ id: z.number().int().positive(), projectId: z.number().optional() })).mutation(async ({ ctx, input }) => {
    await requireCashCheck(ctx.user);
    if (!(await canManageCases(ctx.user))) throw new TRPCError({ code: "FORBIDDEN", message: "Só quem confere a caixa (Faturação → gerir)." });
    const { removeMonthlyReceipt } = await import("./cashExternal");
    const r = await removeMonthlyReceipt({ id: input.id, userId: ctx.user.id });
    if (!r.ok) throw new TRPCError({ code: r.code, message: r.message });
    return r;
  }),
});

/** Fechar/reabrir casos: Faturação → gerir (o papel de conferência de caixa). */
async function canManageCases(user: { id: number; role: string; accessOverrides?: unknown }): Promise<boolean> {
  const { canAccess } = await import("./_core/access");
  return canAccess(user as any, "faturacao", "manage");
}
