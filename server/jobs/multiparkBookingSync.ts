/**
 * MultiPark Booking Sync Job
 *
 * Vai buscar reservas ao /bookings/report da API MultiPark e guarda-as na BD.
 * O agendador oficial é o GitHub Actions (.github/workflows/multipark-cron.yml):
 *  - sync recente de hora a hora (/api/cron/multipark-sync), com janela por
 *    parque a partir da última cobertura completa desse parque (máx. 3 dias);
 *  - janela futura de 2 em 2 horas (/api/cron/multipark-future), retomável;
 *  - fila de notificações/detalhe/histórico de 5 em 5 min
 *    (/api/cron/multipark-deliveries).
 * Ações: creation, checkin, checkout, cancelation.
 *
 * Também serve o "Reparar período" manual (máx. 3 dias, com prazo) e o MCP.
 * Todos partilham o trinco de server/syncLock.ts.
 */

import {
  getBookingsReport,
  getBooking,
  getBookingHistory,
  getAgentHistory,
  isMultiparkConfigured,
  getConfiguredParks,
  getParkApiKey,
  matchParkConfig,
  PARK_CONFIGS,
  type MultiparkBooking,
  type BookingActionType,
  type ParkConfig,
} from "../multipark";
import {
  upsertMultiparkBooking,
  upsertBookingExtras,
  createSyncLog,
  getProjects,
  getDb,
  getLastSyncSuccessAt,
} from "../db";
import { chunkNeedsRetry, computeRecentWindows, mysqlToMs, utcDay, utcMysql } from "../syncRules";
import { eq, and, or, sql, isNull, lte } from "drizzle-orm";
import { multiparkBookings, multiparkBookingHistory, multiparkSyncCoverage } from "../../drizzle/schema";
import { withSyncLock, type SyncLockOwner } from "../syncLock";
import { parseBookingDate, bookingDetailCore } from "../bookingRefresh";
import { deliveryErrorCode, retryDelaySeconds } from "../bookingDeliveryQueue";
import { classifyAllocation } from "../spotClassification";
import { autoAttachAgentsByEmail, type SeenAgent } from "../identityReconcile";
import { bookingCampaignFallback } from "../../shared/partnerRules";
import { createParkMatcher } from "../../shared/projectTree";

// ─── Map park name/city to projectId ─────────────────────────────────────────

// Matcher determinístico partilhado com o backfill (shared/projectTree.ts):
// só nós level='project' ativos, cidade obrigatória, nomes normalizados.
type ProjectMatcher = ReturnType<typeof createParkMatcher>;
let projectMapCache: ProjectMatcher | null = null;
let projectMapCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** Chamado depois de criar/alterar nós de projeto (ex.: "Criar nós em falta"). */
export function invalidateProjectMatcherCache() {
  projectMapCache = null;
}

async function getProjectMap(): Promise<ProjectMatcher> {
  if (projectMapCache && Date.now() - projectMapCacheTime < CACHE_TTL) {
    return projectMapCache;
  }
  const projects = await getProjects();
  projectMapCache = createParkMatcher(projects, PARK_CONFIGS);
  projectMapCacheTime = Date.now();
  return projectMapCache;
}

// ─── Alias resolver: lookup de partnerId/paymentMethod → nome do parceiro ──
// Cada parceiro tem normalmente vários códigos (1 por cidade × marca). A
// tabela partner_aliases guarda essas associações. Antes de gravar uma
// reserva nova no sync, resolvemos o partnerId raw da API contra os aliases
// e, se encontrarmos, definimos campaign = nome do parceiro automaticamente.
// Assim deixa de ser preciso clicar "Associar" manualmente para cada nova
// reserva com um código já conhecido.
let aliasResolverCache: Map<string, string> | null = null;
let aliasResolverCacheTime = 0;

async function getAliasResolver(): Promise<Map<string, string>> {
  if (aliasResolverCache && Date.now() - aliasResolverCacheTime < CACHE_TTL) {
    return aliasResolverCache;
  }
  const db = await getDb();
  const map = new Map<string, string>();
  if (!db) {
    aliasResolverCache = map;
    aliasResolverCacheTime = Date.now();
    return map;
  }
  const { partnerAliases, partnerships } = await import("../../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select({
      aliasType: partnerAliases.aliasType,
      aliasValue: partnerAliases.aliasValue,
      partnerName: partnerships.name,
    })
    .from(partnerAliases)
    .leftJoin(partnerships, eq(partnerships.id, partnerAliases.partnershipId));
  for (const r of rows) {
    if (!r.partnerName) continue;
    const key = `${r.aliasType}:${(r.aliasValue ?? "").trim().toLowerCase()}`;
    map.set(key, r.partnerName);
  }
  aliasResolverCache = map;
  aliasResolverCacheTime = Date.now();
  return map;
}

function resolvePartnerCampaign(
  booking: MultiparkBooking,
  pricing: any,
  aliases: Map<string, string>,
  fallback: string | null,
): string | null {
  // 1. Tenta o partnerId da Multipark (no rawJson, propriedade nivel topo)
  const partnerId = (booking as any).partnerId ?? (booking as any).partner?.id ?? null;
  if (partnerId) {
    const hit = aliases.get(`multipark_partner_id:${String(partnerId).trim().toLowerCase()}`);
    if (hit) return hit;
  }
  // 2. Tenta o paymentMethod
  const pm = typeof pricing?.paymentMethod === "string" ? pricing.paymentMethod : null;
  if (pm) {
    const hit = aliases.get(`payment_method:${pm.trim().toLowerCase()}`);
    if (hit) return hit;
  }
  return fallback;
}

function findProjectId(
  parkName: string | undefined,
  city: string | undefined,
  projectMap: ProjectMatcher
): number | undefined {
  return projectMap({ parkName, city });
}

// ─── Parse date from MultiPark format "DD/MM/YYYY, HH:mm" ────────────────────

const parseMultiparkDate = parseBookingDate;

// ─── Convert API booking to DB record ────────────────────────────────────────

function bookingToRecord(
  booking: MultiparkBooking,
  projectMap: ProjectMatcher,
  aliasResolver: Map<string, string>,
) {
  const client = booking.customer || booking.client;
  const pricing = booking.pricing;
  const park = booking.park;
  const parkName = park?.name || booking.parkName;
  const city = park?.city;
  const projectId = findProjectId(parkName, city, projectMap);

  // Resolução automática do parceiro: se a API ainda devolve "Unknown User"
  // mas o partnerId/paymentMethod já está associado a um parceiro nosso, usa
  // o nome do parceiro em vez do fallback.
  // "Unknown User" (mascarado) é saltado mas NÃO descarta o código de desconto.
  const effectiveFallback = bookingCampaignFallback(booking as any);
  const resolvedCampaign = resolvePartnerCampaign(booking, pricing, aliasResolver, effectiveFallback);

  return {
    externalId: booking.id,
    bookingNumber: booking.bookingNumber || booking.allocation || null,
    status: booking.status || null,
    checkIn: parseMultiparkDate(booking.checkInDate || booking.checkIn),
    checkOut: parseMultiparkDate(booking.checkOutDate || booking.checkOut),
    checkInTime: booking.checkInTime || null,
    checkOutTime: booking.checkOutTime || null,
    parkingType: booking.parkingType || (park?.types?.[0]) || null,
    vehicleType: booking.vehicle?.type || booking.vehicleType || null,
    clientFirstName: client?.firstName || null,
    clientLastName: client?.lastName || null,
    clientEmail: client?.email || null,
    clientPhone: client?.phoneNumber || null,
    clientNif: client?.nif || null,
    licensePlate: booking.vehicle?.licensePlate || null,
    vehicleBrand: booking.vehicle?.brand || null,
    vehicleModel: booking.vehicle?.model || null,
    vehicleColor: booking.vehicle?.color || null,
    totalPrice: pricing?.totalPrice?.toString() ?? pricing?.total?.toString() ?? null,
    currency: pricing?.currency || "EUR",
    parkId: park?.id || booking.parkId || null,
    parkName: parkName || null,
    city: city || null,
    projectId: projectId || null,
    deliveryService: booking.deliveryService ? 1 : 0,
    deliveryAddress: booking.deliveryAddress || null,
    pickupAddress: booking.pickupAddress || null,
    campaign: resolvedCampaign,
    parkingPrice: pricing?.parkingPrice?.toString() ?? null,
    deliveryCharges: pricing?.deliveryCharges?.toString() ?? null,
    extrasTotal: pricing?.extraServicesTotal?.toString() ?? null,
    discount: pricing?.discount?.toString() ?? null,
    remainingToPay: pricing?.remainingToPay?.toString() ?? null,
    arrivalFlight: booking.flightInfo?.arrivalFlight || booking.arrivalFlight || null,
    departureFlight: booking.flightInfo?.departureFlight || booking.departureFlight || null,
    cancelledAt: parseMultiparkDate(booking.cancelledAt),
    cancelReason: booking.cancelReason || null,
    notes: booking.notes || null,
    rawJson: JSON.stringify(booking),
    bookingCreatedAt: parseMultiparkDate(booking.createdAt),
    paymentMethod: typeof (pricing as any)?.paymentMethod === "string"
      ? (pricing as any).paymentMethod.slice(0, 128)
      : null,
    totalPaid: (pricing as any)?.totalPaid?.toString() ?? null,
    pro: (booking as any).pro ? 1 : 0,
    partnerId: (booking as any).partnerId ? String((booking as any).partnerId).slice(0, 128) : null,
    // partnerName no /report vem mascarado ("Unknown User") — filtra-o; o nome
    // real (quando existe) vem do enrichment. partnerId é o que casa com o alias.
    partnerName: (() => {
      const pn = (booking as any).partnerName;
      return typeof pn === "string" && pn && !/unknown/i.test(pn) ? pn.slice(0, 256) : null;
    })(),
    // campaignId/campaignName NÃO existem no /report — só no /bookings/:id.
    // São preenchidos no enrichment (não aqui, senão o sync sobrescrevia-os com null).
    cashValidatedByName: typeof (booking as any).cashValidatedByName === "string" ? (booking as any).cashValidatedByName.slice(0, 256) : null,
    driverValidatedByName: typeof (booking as any).driverValidatedByName === "string" ? (booking as any).driverValidatedByName.slice(0, 256) : null,
    cashierClosedByName: typeof (booking as any).cashierClosedByName === "string" ? (booking as any).cashierClosedByName.slice(0, 256) : null,
    ...classifyAllocation((booking as any).allocation),
  };
}

// ─── Enrichment via /bookings/:id (apanha deliveryType, flights, remarks) ────

const ENRICH_CONCURRENCY = 5;

// Max simultaneous /bookings/report calls in the sync fan-out. Each report
// request holds several be-multipark Prisma connections for its duration;
// firing all parks×actionTypes (~108) at once via Promise.allSettled saturated
// the 25→40-slot pool and produced P2024 cascades. Cap the fan-out so the pool
// drains comfortably (tunable 6–8). See memory/p2024-regression-sync-burst.md.
const REPORT_CONCURRENCY = 6;

function nowMysql(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/** O sucesso anterior não impede uma atualização. As falhas mantêm o último
 * detalhe válido e voltam à fila com um intervalo crescente entre tentativas. */
async function enrichBookingIfNeeded(externalId: string, apiKey: string, prefetched?: MultiparkBooking,
  context?: { parkName: string | null; city: string | null }): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  try {
    const detailed = prefetched ?? await getBooking(externalId, apiKey, { maxAttempts: 1, timeoutMs: 8000 });
    if (detailed?.id !== externalId) throw Object.assign(new Error("Detalhe não corresponde à reserva"), { code: "BOOKING_ID_MISMATCH" });
    const b: any = detailed;
    const projectMap = await getProjectMap();
    const mapped = bookingToRecord(detailed, projectMap, await getAliasResolver());

    // Cliente + veículo só são preenchidos se vierem (o report mascara estes
    // campos para reservas de parceiros; o /bookings/:id devolve-os reais).
    const update: Record<string, any> = {
      // MySQL avalia SET da esquerda para a direita: comparar antes de alterar status.
      ...(typeof b.status === 'string' && b.status ? {
        historyFetchedAt: sql`CASE WHEN status <> ${b.status} THEN NULL ELSE historyFetchedAt END`,
        historyRetryAt: sql`CASE WHEN status <> ${b.status} THEN NULL ELSE historyRetryAt END`,
      } : {}),
      ...bookingDetailCore(b),
      detailRetryAt: null, detailAttempts: 0, detailErrorCode: null,
      deliveryType: typeof b.deliveryType === "string" && b.deliveryType ? b.deliveryType : null,
      returnFlight: typeof b.returnFlight === "string" && b.returnFlight ? b.returnFlight : null,
      departingFlight: typeof b.departingFlight === "string" && b.departingFlight ? b.departingFlight : null,
      remarks: typeof b.remarks === "string" && b.remarks ? b.remarks.slice(0, 512) : null,
      enrichedAt: nowMysql(),
    };
    for (const key of ['bookingNumber', 'parkId', 'parkName', 'city', 'projectId', 'campaign', 'parkingType', 'clientNif'] as const) {
      if (mapped[key] != null && mapped[key] !== '') update[key] = mapped[key];
    }
    const projectId = findProjectId(context?.parkName ?? undefined, context?.city ?? undefined, projectMap);
    if (projectId) update.projectId = projectId;
    if (b.client?.firstName) update.clientFirstName = b.client.firstName;
    if (b.client?.lastName) update.clientLastName = b.client.lastName;
    if (b.client?.email) update.clientEmail = b.client.email;
    if (b.client?.phoneNumber) update.clientPhone = b.client.phoneNumber;
    if (b.vehicle?.licensePlate) update.licensePlate = b.vehicle.licensePlate;
    if (b.vehicle?.brand) update.vehicleBrand = b.vehicle.brand;
    if (b.vehicle?.model) update.vehicleModel = b.vehicle.model;
    if (b.vehicle?.color) update.vehicleColor = b.vehicle.color;
    if (b.vehicle?.vehicleType) update.vehicleType = b.vehicle.vehicleType;
    if (typeof b.origin === "string" && b.origin) update.origin = b.origin.slice(0, 64);
    if (typeof b.originUrl === "string" && b.originUrl) {
      update.originUrl = b.originUrl.slice(0, 512);
      // Atribuição ao Google Ads (gclid/gbraid/wbraid/utm_*) — regra local, ver
      // server/integrations/googleAds/attribution.ts. Sem parâmetros = "unknown".
      try {
        const { attributionFromUrl, attributionColumns } = await import("../integrations/googleAds/attribution");
        Object.assign(update, attributionColumns(attributionFromUrl(b.originUrl)), { adAttributedAt: nowMysql() });
      } catch { /* atribuição é opcional */ }
    }
    // Campanha só existe no detalhe (/bookings/:id), não no /report.
    if (typeof b.campaignId === "string" && b.campaignId) update.campaignId = b.campaignId.slice(0, 128);
    if (typeof b.campaignName === "string" && b.campaignName) update.campaignName = b.campaignName.slice(0, 256);
    // Nome real do parceiro (o /report mascara como "Unknown User").
    if (typeof b.partnerId === "string" && b.partnerId) update.partnerId = b.partnerId.slice(0, 128);
    if (typeof b.partnerName === "string" && b.partnerName && !/unknown/i.test(b.partnerName)) update.partnerName = b.partnerName.slice(0, 256);

    // Uma resposta antiga não pode recuar uma atualização mais recente.
    const version = update.sourceUpdatedAt as string | undefined;
    await db.update(multiparkBookings).set(update).where(and(
      eq(multiparkBookings.externalId, externalId),
      version ? or(isNull(multiparkBookings.sourceUpdatedAt), lte(multiparkBookings.sourceUpdatedAt, version)) : undefined,
    ));
    return true;
  } catch (error) {
    await deferBookingDetail(externalId, deliveryErrorCode(error));
    return false;
  }
}

/** Enriquecimento só volta a rodar semanalmente em reservas vivas: não
 *  terminadas, ou com check-out há menos de ROTATION_MAX_AGE_DAYS dias. */
const ROTATION_MAX_AGE_DAYS = 30;
const TERMINAL_STATUSES_SQL = sql`('CHECKED_OUT', 'CANCELLED')`;
/** Código guardado quando o parque está fechado: não volta a ser agendado. */
export const PARK_CLOSED_CODE = "PARK_CLOSED";

/** Parque fechado (closed:true): marca e NÃO reagenda (sem retryAt). */
async function markParkClosed(externalId: string, kind: "detail" | "history") {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  await db.update(multiparkBookings).set(kind === "detail"
    ? { detailErrorCode: PARK_CLOSED_CODE, detailRetryAt: null }
    : { historyErrorCode: PARK_CLOSED_CODE, historyRetryAt: null })
    .where(eq(multiparkBookings.externalId, externalId));
}

async function deferBookingDetail(externalId: string, code: string) {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const [row] = await db.select({ attempts: multiparkBookings.detailAttempts })
    .from(multiparkBookings).where(eq(multiparkBookings.externalId, externalId)).limit(1);
  const attempts = (row?.attempts ?? 0) + 1;
  await db.update(multiparkBookings).set({ detailAttempts: attempts, detailErrorCode: code,
    detailRetryAt: new Date(Date.now() + retryDelaySeconds(attempts) * 1000).toISOString().slice(0, 19).replace('T', ' '),
  }).where(eq(multiparkBookings.externalId, externalId));
}

/** Corre N tarefas em paralelo com limite de concorrência.
 *  Se deadlineAt for passado, deixa de pegar em itens novos quando o tempo
 *  esgota — os restantes ficam por processar (apanhados em ciclos seguintes). */
async function runConcurrent<T>(items: T[], limit: number, fn: (item: T) => Promise<void>, deadlineAt?: number): Promise<void> {
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (idx < items.length) {
        if (deadlineAt && Date.now() >= deadlineAt) break;
        const i = idx++;
        try { await fn(items[i]); } catch {}
      }
    }),
  );
}

/**
 * Vai buscar a timeline de uma reserva (GET /bookings/:id/history) e
 * persiste na tabela multipark_booking_history. Também extrai resumos
 * (currentGarage/Spot, agente de check-in/out, última quilometragem)
 * para a tabela principal.
 */
function parseMpDate(s: string | null | undefined): string | null {
  return typeof s === 'string' ? parseBookingDate(s) : null;
}

export async function syncBookingHistory(externalId: string, apiKey: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  try {
    const response = await getBookingHistory(externalId, apiKey, { maxAttempts: 1, timeoutMs: 8000 });
    if (!Array.isArray(response?.history) || (response.bookingId && response.bookingId !== externalId)
      || (typeof response.total === 'number' && response.total > response.history.length)) {
      throw Object.assign(new Error('Histórico incompleto ou inválido'), { code: 'HISTORY_INCOMPLETE' });
    }
    const items = response.history.map(item => {
      if (!item?.id || String(item.id).length > 128 || !parseMpDate(item.actionTime)) {
        throw Object.assign(new Error('Evento sem identidade ou data válida'), { code: 'HISTORY_EVENT_INVALID' });
      }
      return item;
    }).sort((a, b) => parseMpDate(a.actionTime)!.localeCompare(parseMpDate(b.actionTime)!) || String(a.id).localeCompare(String(b.id)));

    const seenAgents: SeenAgent[] = [];
    await db.transaction(async tx => {

    let checkinAgentName: string | null = null;
    let checkinAgentUserId: string | null = null;
    let checkoutAgentName: string | null = null;
    let checkoutAgentUserId: string | null = null;
    let currentGarage: string | null = null;
    let currentSpot: string | null = null;
    let lastKnownMileage: number | null = null;

    for (const item of items as any[]) {
      const historyId = item.id ?? null;
      if (!historyId) continue;
      const actionTime = parseMpDate(item.actionTime);
      const agentName = item.agentName ?? null;
      const agentUserId = item.userId ?? item.user?.id ?? null;
      const agentEmail = item.user?.email ?? null;
      if (agentUserId) seenAgents.push({ agentUserId: String(agentUserId), agentName, agentEmail });
      const modifiedFields = item.modifiedFields
        ? typeof item.modifiedFields === 'string' ? item.modifiedFields : JSON.stringify(item.modifiedFields)
        : null;
      const changeType = item.changeType ?? null;
      const platform = item.platform ?? null;
      const remarks = item.remarks ?? null;

      // Os eventos e o resumo são guardados na mesma transação.
      const values = {
          bookingExternalId: externalId,
          historyId: String(historyId).slice(0, 128),
          changeType: changeType ? String(changeType).slice(0, 32) : null,
          actionTime,
          remarks,
          agentName: agentName ? String(agentName).slice(0, 256) : null,
          agentUserId: agentUserId ? String(agentUserId).slice(0, 128) : null,
          agentEmail,
          modifiedFields,
          platform: platform ? String(platform).slice(0, 32) : null,
      };
      await tx.insert(multiparkBookingHistory).values(values).onDuplicateKeyUpdate({ set: values });

      // Extrair resumos
      if (changeType === "CHECK_IN") {
        if (agentName) checkinAgentName = agentName;
        if (agentUserId) checkinAgentUserId = agentUserId;
      } else if (changeType === "CHECK_OUT") {
        if (agentName) checkoutAgentName = agentName;
        if (agentUserId) checkoutAgentUserId = agentUserId;
      }
      if (modifiedFields) {
        try {
          const mf = JSON.parse(modifiedFields);
          if (mf.garagem) currentGarage = String(mf.garagem).slice(0, 64);
          if (mf.lugar) currentSpot = String(mf.lugar).slice(0, 64);
          if (mf.km !== undefined) {
            const km = parseInt(String(mf.km), 10);
            if (Number.isFinite(km)) lastKnownMileage = km;
          }
        } catch {}
      }
    }

    const update: Record<string, any> = { historyFetchedAt: nowMysql(),
      historyRetryAt: null, historyAttempts: 0, historyErrorCode: null };
    if (checkinAgentName) update.checkinAgentName = checkinAgentName;
    if (checkinAgentUserId) update.checkinAgentUserId = checkinAgentUserId;
    if (checkoutAgentName) update.checkoutAgentName = checkoutAgentName;
    if (checkoutAgentUserId) update.checkoutAgentUserId = checkoutAgentUserId;
    if (currentGarage) update.currentGarage = currentGarage;
    if (currentSpot) update.currentSpot = currentSpot;
    if (lastKnownMileage !== null) update.lastKnownMileage = lastKnownMileage;

    await tx.update(multiparkBookings)
      .set(update)
      .where(eq(multiparkBookings.externalId, externalId));
    });
    if (seenAgents.length) {
      try { await autoAttachAgentsByEmail(db, seenAgents); } catch {}
    }
    return true;
  } catch (error) {
    await deferBookingHistory(externalId, deliveryErrorCode(error));
    return false;
  }
}

async function deferBookingHistory(externalId: string, code: string) {
  const db = await getDb();
  if (!db) throw new Error('Base de dados indisponível');
  await db.update(multiparkBookings).set({
    historyErrorCode: code,
    historyRetryAt: sql`DATE_ADD(UTC_TIMESTAMP(), INTERVAL LEAST(21600, 60 * POW(2, LEAST(historyAttempts, 9))) SECOND)`,
    historyAttempts: sql`historyAttempts + 1`,
  }).where(eq(multiparkBookings.externalId, externalId));
}

/**
 * Endpoint separado que enriquece um lote de reservas (deliveryType, flights,
 * remarks) chamando /bookings/:id por reserva. Usa o parkId guardado em DB
 * para escolher a chave de API correcta sem ter de tentar todos os parques.
 * Limite default 30 para caber no timeout do Vercel.
 */
export async function enrichBookingsBatch(
  arg: number | { externalIds?: string[]; limit?: number; deadlineAt?: number; force?: boolean; details?: Map<string, MultiparkBooking> } = 100,
): Promise<{
  scanned: number;
  enriched: number;
  errors: number;
  noKey: number;
  closed?: number;
}> {
  const db = await getDb();
  if (!db) return { scanned: 0, enriched: 0, errors: 0, noKey: 0 };

  const opts = typeof arg === "number" ? { limit: arg } : arg;
  const limit = opts.limit ?? 100;
  const targetIds = opts.externalIds;
  const deadlineAt = opts.deadlineAt;
  // Alvo explícito mas vazio → nada a enriquecer.
  if (targetIds && targetIds.length === 0) return { scanned: 0, enriched: 0, errors: 0, noKey: 0 };

  const { inArray } = await import("drizzle-orm");
  const due = sql`(detailRetryAt IS NULL OR detailRetryAt <= UTC_TIMESTAMP())`;
  // Detalhe novo, falhado ou desatualizado. A rotação semanal cobre também
  // alterações de matrícula/campanha sem mudança de estado, mas só em reservas
  // vivas (não terminadas ou com check-out há < 30 dias). Parques fechados
  // (PARK_CLOSED) ficam de fora até alguém limpar o código.
  const stale = sql`(enrichedAt IS NULL OR detailErrorCode IS NOT NULL
    OR (enrichedAt < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)
      AND (status IS NULL OR status NOT IN ${TERMINAL_STATUSES_SQL}
        OR checkOut >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${ROTATION_MAX_AGE_DAYS} DAY)))
    OR (COALESCE(checkOut, checkIn, bookingCreatedAt) >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)
      AND enrichedAt < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 6 HOUR)))`;
  const notClosed = sql`(detailErrorCode IS NULL OR detailErrorCode <> ${PARK_CLOSED_CODE})`;
  const auto = !(opts.force && targetIds);
  const whereCond = and(targetIds ? inArray(multiparkBookings.externalId, targetIds) : undefined,
    auto ? due : undefined, auto ? stale : undefined, auto ? notClosed : undefined);

  // Prioridade igual à do histórico: reservas recentes/ativas primeiro, depois
  // as nunca enriquecidas, depois as mais antigas.
  const pending = await db
    .select({
      externalId: multiparkBookings.externalId,
      parkName: multiparkBookings.parkName,
      city: multiparkBookings.city,
    })
    .from(multiparkBookings)
    .where(whereCond)
    .orderBy(
      sql`(COALESCE(checkOut, checkIn, bookingCreatedAt) >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)) DESC`,
      sql`(enrichedAt IS NULL) DESC`,
      sql`COALESCE(detailRetryAt, enrichedAt, bookingCreatedAt) ASC`,
    )
    .limit(limit);

  if (pending.length === 0) return { scanned: 0, enriched: 0, errors: 0, noKey: 0, closed: 0 };

  let enriched = 0;
  let errs = 0;
  let noKey = 0;
  let closed = 0;
  await runConcurrent(pending, ENRICH_CONCURRENCY, async (p) => {
    const park = matchParkConfig({ parkName: p.parkName, city: p.city });
    if (park?.closed) {
      closed++;
      await markParkClosed(p.externalId, "detail");
      return;
    }
    const apiKey = park ? getParkApiKey(park) : undefined;
    if (!apiKey) {
      noKey++;
      await deferBookingDetail(p.externalId, "PARK_ACCESS_MISSING");
      return;
    }
    const ok = await enrichBookingIfNeeded(p.externalId, apiKey, opts.details?.get(p.externalId), p);
    if (ok) enriched++; else errs++;
  }, deadlineAt);

  return { scanned: pending.length, enriched, errors: errs, noKey, closed };
}

/**
 * Vai buscar history de um agente (por nome) num dia, para CADA parque
 * configurado. Persiste em multipark_booking_history. Útil para avaliar
 * a atividade de um extra num dia específico.
 */
export async function fetchAgentHistoryByName(
  agentName: string,
  date: string, // YYYY-MM-DD
): Promise<{
  parks: number;
  totalEntries: number;
  byType: Record<string, number>;
  perPark: Array<{ park: string; entries: number }>;
}> {
  const db = await getDb();
  const parks = getConfiguredParks();
  const byType: Record<string, number> = {};
  let totalEntries = 0;
  const perPark: Array<{ park: string; entries: number }> = [];

  await runConcurrent(parks, ENRICH_CONCURRENCY, async (park) => {
    const apiKey = getParkApiKey(park);
    if (!apiKey) return;
    try {
      const response = await getAgentHistory({
        agentName,
        startDate: date,
        endDate: date,
        apiKey,
      });
      const items = (response?.history ?? []) as any[];
      perPark.push({ park: `${park.name} ${park.city}`, entries: items.length });
      totalEntries += items.length;
      if (!db || items.length === 0) return;

      for (const item of items) {
        const historyId = item.id ?? null;
        const bookingExternalId = item.booking?.id ?? null;
        if (!historyId || !bookingExternalId) continue;
        const changeType = item.changeType ?? null;
        if (changeType) byType[changeType] = (byType[changeType] ?? 0) + 1;
        try {
          await db.insert(multiparkBookingHistory).values({
            bookingExternalId: String(bookingExternalId).slice(0, 128),
            historyId: String(historyId).slice(0, 128),
            changeType: changeType ? String(changeType).slice(0, 32) : null,
            actionTime: parseMpDate(item.actionTime),
            remarks: item.remarks ?? null,
            agentName: item.agentName ?? agentName,
            agentUserId: item.userId ?? item.user?.id ?? null,
            agentEmail: item.user?.email ?? null,
            modifiedFields: item.modifiedFields ? String(item.modifiedFields) : null,
            platform: item.platform ?? null,
          });
        } catch (err: any) {
          if (!String(err.message).includes("Duplicate")) throw err;
        }
      }
      // Mesmo email = mesma pessoa → anexa o agente à ficha (best-effort).
      try {
        await autoAttachAgentsByEmail(
          db,
          items
            .filter((it) => it.userId ?? it.user?.id)
            .map((it) => ({ agentUserId: String(it.userId ?? it.user?.id), agentName: it.agentName ?? agentName, agentEmail: it.user?.email ?? null })),
        );
      } catch {}
    } catch {
      perPark.push({ park: `${park.name} ${park.city}`, entries: 0 });
    }
  });

  return { parks: parks.length, totalEntries, byType, perPark };
}

/**
 * Vai buscar history das reservas que ainda não tinham. Mesma estratégia
 * do enrich: lote pequeno por execução para caber no timeout do Vercel.
 */
export async function syncBookingHistoryBatch(
  arg: number | { limit?: number; externalIds?: string[]; force?: boolean } = 50,
  deadlineAt?: number,
): Promise<{ scanned: number; fetched: number; errors: number; noKey: number; closed?: number }> {
  const db = await getDb();
  if (!db) throw new Error('Base de dados indisponível');
  const opts = typeof arg === 'number' ? { limit: arg } : arg;
  if (opts.externalIds?.length === 0) return { scanned: 0, fetched: 0, errors: 0, noKey: 0, closed: 0 };
  const { inArray } = await import('drizzle-orm');
  const forced = opts.force && opts.externalIds;
  const pending = await db.select({ externalId: multiparkBookings.externalId,
    parkId: multiparkBookings.parkId, parkName: multiparkBookings.parkName, city: multiparkBookings.city,
  }).from(multiparkBookings).where(and(
    opts.externalIds ? inArray(multiparkBookings.externalId, opts.externalIds) : undefined,
    forced ? undefined : sql`(historyRetryAt IS NULL OR historyRetryAt <= UTC_TIMESTAMP())`,
    forced ? undefined : sql`COALESCE(checkIn, bookingCreatedAt) <= DATE_ADD(UTC_TIMESTAMP(), INTERVAL 30 DAY)`,
    forced ? undefined : sql`(historyErrorCode IS NULL OR historyErrorCode <> ${PARK_CLOSED_CODE})`,
    forced ? undefined : sql`(historyFetchedAt IS NULL OR historyErrorCode IS NOT NULL
      OR (historyFetchedAt < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)
        AND (status IS NULL OR status NOT IN ${TERMINAL_STATUSES_SQL}
          OR checkOut >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${ROTATION_MAX_AGE_DAYS} DAY)))
      OR (COALESCE(checkOut, checkIn, bookingCreatedAt) >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)
        AND historyFetchedAt < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 6 HOUR)))`,
  )).orderBy(
    sql`(COALESCE(checkOut, checkIn, bookingCreatedAt) >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)) DESC`,
    sql`COALESCE(historyRetryAt, historyFetchedAt, bookingCreatedAt) ASC`,
  ).limit(opts.limit ?? 50);

  let scanned = 0, fetched = 0, errors = 0, noKey = 0, closed = 0;
  await runConcurrent(pending, ENRICH_CONCURRENCY, async p => {
    scanned++;
    try {
      const park = matchParkConfig(p);
      if (park?.closed) {
        closed++;
        await markParkClosed(p.externalId, 'history');
        return;
      }
      const key = park ? getParkApiKey(park) : undefined;
      if (!key) {
        noKey++;
        await deferBookingHistory(p.externalId, 'PARK_ACCESS_MISSING');
        return;
      }
      if (await syncBookingHistory(p.externalId, key)) fetched++; else errors++;
    } catch { errors++; }
  }, deadlineAt);
  return { scanned, fetched, errors, noKey, closed };
}

// ─── Core sync function ──────────────────────────────────────────────────────

/** Tipo gravado em multipark_sync_logs. Linhas antigas: "api_sync" (recente e
 *  futuro misturados), "api_sync_recovery" e "excel_import" — continuam a ser
 *  lidas/mostradas, mas já não são escritas. */
export type SyncLogType = "api_sync_recent" | "api_sync_future" | "manual";

export type ParkRunState = "ok" | "error" | "incomplete";

export interface SyncBookingsResult {
  success: boolean;
  processed: number;
  created: number;
  updated: number;
  errors: string[];
  enrichTargets: string[];
  /** Houve trabalhos (parque × ação) que ficaram por fazer por falta de tempo. */
  partial: boolean;
  skippedJobs: number;
  /** Estado de cada parque nesta corrida (id da config; "global" sem chaves por parque). */
  parkStatus: Record<string, { state: ParkRunState; errorCode?: string }>;
  /** Ids dos parques cujo report falhou (precisam de repetição). */
  parkErrors: string[];
  /** Reports cujo `total` não bate com a lista devolvida. */
  totalMismatches: Array<{ parkId: string; actionType: BookingActionType; total: number; length: number }>;
}

export async function syncBookings(opts: {
  startDate: string;
  endDate: string;
  actionTypes?: BookingActionType[];
  triggeredById?: number;
  /** Início por parque (YYYY-MM-DD), sobrepõe-se a startDate. */
  parkStartDates?: Record<string, string>;
  /** Deixa de pegar em trabalhos novos a partir daqui (a corrida fica parcial). */
  deadlineAt?: number;
  syncType?: SyncLogType;
  /** Janela para o log (DATETIME UTC); omissão = startDate/endDate. */
  windowStart?: string;
  windowEnd?: string;
}): Promise<SyncBookingsResult> {
  const actionTypes = opts.actionTypes || ["creation", "checkin", "checkout", "cancelation"];
  const projectMap = await getProjectMap();
  const aliasResolver = await getAliasResolver();

  const errors: string[] = [];

  const parks = getConfiguredParks();
  const parksToSync = parks.length > 0 ? parks : [null]; // null = use global key
  const idOf = (park: ParkConfig | null) => park?.id ?? "global";

  // Fan-out limitado (parque × actionType). Cada job regista se chegou a
  // correr: com prazo, os que não arrancarem ficam "incompletos".
  type Job = { park: ParkConfig | null; actionType: BookingActionType; startDate: string; started: boolean };
  const jobs: Job[] = [];
  for (const park of parksToSync) {
    const startDate = (park && opts.parkStartDates?.[park.id]) || opts.startDate;
    for (const actionType of actionTypes) {
      jobs.push({ park, actionType, startDate, started: false });
    }
  }

  let totalProcessed = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  const enrichTargets = new Set<string>();
  const parkStatus: SyncBookingsResult["parkStatus"] = {};
  for (const park of parksToSync) parkStatus[idOf(park)] = { state: "ok" };
  const totalMismatches: SyncBookingsResult["totalMismatches"] = [];

  // Bounded fan-out (was Promise.allSettled = unbounded ~108-wide burst). Up to
  // REPORT_CONCURRENCY report calls run at once; the rest queue. JS is
  // single-threaded, so the synchronous accumulations below are race-free
  // across the concurrent workers.
  await runConcurrent(jobs, REPORT_CONCURRENCY, async (job) => {
    job.started = true;
    const { park, actionType } = job;
    const apiKey = park ? getParkApiKey(park) : undefined;
    const parkLabel = park ? `${park.name} ${park.city}` : "global";
    const parkErrors: string[] = [];

    try {
      const report = await getBookingsReport(job.startDate, opts.endDate, actionType, apiKey);
      const list = Array.isArray(report?.bookings) ? report.bookings : [];
      // O report não pagina: um total diferente da lista = dados em falta.
      if (typeof report?.total === "number" && report.total !== list.length) {
        totalMismatches.push({ parkId: idOf(park), actionType, total: report.total, length: list.length });
        console.warn(`[BookingSync] total≠lista ${parkLabel}/${actionType} ${job.startDate}→${opts.endDate}: total=${report.total} lista=${list.length}`);
      }
      for (const booking of list) {
        try {
          const record = bookingToRecord(booking, projectMap, aliasResolver);
          const result = await upsertMultiparkBooking(record);
          await upsertBookingExtras(booking.id, (booking as any).extraServices);
          totalProcessed++;
          if (result?.action === "created") totalCreated++;
          else totalUpdated++;
          // Marca para enriquecimento imediato: novas, ou as que mudaram de
          // estado (o detalhe foi reaberto via enrichedAt=null no upsert).
          if (result?.action === "created" || result?.statusChanged) {
            enrichTargets.add(booking.id);
          }
        } catch (err: any) {
          parkErrors.push(`Booking ${booking.id}: ${err.message}`);
        }
      }
    } catch (err: any) {
      parkErrors.push(`${parkLabel}/${actionType}: ${err.message}`);
      parkStatus[idOf(park)] = { state: "error", errorCode: deliveryErrorCode(err) };
    }
    if (parkErrors.length) errors.push(...parkErrors);
  }, opts.deadlineAt);

  const skipped = jobs.filter((j) => !j.started);
  for (const j of skipped) {
    const id = idOf(j.park);
    if (parkStatus[id]?.state === "ok") parkStatus[id] = { state: "incomplete" };
  }
  const parkErrors = Object.entries(parkStatus).filter(([, v]) => v.state === "error").map(([k]) => k);
  const partial = skipped.length > 0;

  // Nota: o enriquecimento (/bookings/:id) corre à parte (runRecentCronSync e
  // cron multipark-deliveries) para caber no prazo.
  try {
    await createSyncLog({
      syncType: opts.syncType ?? "manual",
      status: errors.length === 0 && !partial ? "success" : "partial",
      recordsProcessed: totalProcessed,
      recordsCreated: totalCreated,
      recordsUpdated: totalUpdated,
      errorMessage: errors.length > 0
        ? errors.slice(0, 50).join("; ").slice(0, 8000)
        : partial ? `${skipped.length} trabalho(s) por fazer — prazo esgotado` : undefined,
      triggeredById: opts.triggeredById ?? undefined,
      completedAt: new Date(),
      windowStart: opts.windowStart ?? `${opts.startDate} 00:00:00`,
      windowEnd: opts.windowEnd ?? `${opts.endDate} 23:59:59`,
      meta: JSON.stringify({ parkErrors, skippedJobs: skipped.length, totalMismatches }),
    });
  } catch (err) {
    console.error("[BookingSync] registo do log falhou:", deliveryErrorCode(err));
  }

  return {
    success: errors.length === 0 && !partial,
    processed: totalProcessed,
    created: totalCreated,
    updated: totalUpdated,
    errors,
    enrichTargets: Array.from(enrichTargets),
    partial,
    skippedJobs: skipped.length,
    parkStatus,
    parkErrors,
    totalMismatches,
  };
}

// ─── Automatic scheduler ─────────────────────────────────────────────────────

const SYNC_INTERVAL = 15 * 60 * 1000; // 15 minutes

/**
 * Timer in-process (servidor Node persistente). SÓ arranca com
 * INPROCESS_SCHEDULERS=on — o agendador oficial é o GitHub Actions
 * (/api/cron/multipark-sync de hora a hora e /api/cron/multipark-future).
 * Usa os mesmos wrappers do cron (janela por parque, trinco e prazo).
 */
export function startBookingSyncScheduler() {
  async function runSync() {
    if (!isMultiparkConfigured()) {
      console.log("[BookingSync] Skipped — MULTIPARK_API_KEY not configured");
      return;
    }
    try {
      const recent = await runRecentCronSync(30);
      if (recent.busy) { console.log("[BookingSync] recente: já a correr"); return; }
      console.log(`[BookingSync] recente: ${recent.report.processed} processadas, ${recent.report.created} novas${recent.report.errors.length ? `, ${recent.report.errors.length} erros` : ""}`);
      let offset = 0;
      for (let i = 0; i < 6; i++) {
        const future = await runFutureCronSync(4, { offsetDays: offset });
        if (future.busy || future.done || future.nextOffset == null || future.nextOffset <= offset) break;
        offset = future.nextOffset;
      }
    } catch (error) {
      console.error("[BookingSync] Scheduler error:", deliveryErrorCode(error));
    }
  }

  // Arranca 10s depois do servidor e repete a cada 15 minutos.
  setTimeout(runSync, 10_000);
  setInterval(runSync, SYNC_INTERVAL);
  console.log("[BookingSync] Scheduler in-process ligado — corre a cada 15 minutos");
}

// ─── Cron wrappers (GitHub Actions chama os endpoints HTTP) ──────────────────

/** Orçamento de tempo do cron: tem de caber DENTRO do maxDuration do Vercel
 *  (60s em vercel.json) com margem para a resposta HTTP sair. Sem isto, um
 *  ciclo mais pesado é morto aos 60s → 504 → run vermelho no GitHub Actions. */
const CRON_BUDGET_MS = Number(process.env.CRON_BUDGET_MS || 50_000);
/** Os reports param de arrancar aqui, para sobrar tempo ao enriquecimento. */
const REPORT_RESERVE_MS = 12_000;

/** Última cobertura completa do sync recente, por parque (epoch ms). */
async function loadRecentCoverage(): Promise<Map<string, number | null>> {
  const db = await getDb();
  const out = new Map<string, number | null>();
  if (!db) return out;
  const rows = await db.select({ parkId: multiparkSyncCoverage.parkId, at: multiparkSyncCoverage.recentCoveredAt })
    .from(multiparkSyncCoverage);
  for (const r of rows) out.set(r.parkId, mysqlToMs(r.at));
  return out;
}

/** Grava o resultado por parque: só um parque "ok" avança a cobertura. */
async function saveRecentCoverage(runStartedAt: number, status: SyncBookingsResult["parkStatus"]) {
  const db = await getDb();
  if (!db) return;
  const now = utcMysql(Date.now());
  const covered = utcMysql(runStartedAt);
  for (const [parkId, st] of Object.entries(status)) {
    const set = {
      lastRunAt: now,
      lastStatus: st.state,
      lastErrorCode: st.state === "error" ? (st.errorCode ?? "REPORT_FAILED").slice(0, 64) : null,
      ...(st.state === "ok" ? { recentCoveredAt: covered } : {}),
    };
    await db.insert(multiparkSyncCoverage).values({ parkId, ...set }).onDuplicateKeyUpdate({ set });
  }
}

export interface RecentCronResult {
  busy?: boolean;
  report: { processed: number; created: number; updated: number; errors: string[] };
  parkErrors: string[];
  enriched: number;
  historyFetched: number;
  durationMs: number;
  windowStart: string;
  partial: boolean;
  totalMismatches: SyncBookingsResult["totalMismatches"];
}

/** Sync recente: report por parque + enrich + history, com trinco e prazo.
 *  Chamado pelo cron (GitHub Actions) de hora a hora — mas o agendamento do
 *  GitHub atrasa com frequência, por isso a janela de CADA parque alarga até
 *  à última cobertura completa desse parque (clamp: 3 dias).
 *
 *  Todas as fases respeitam o prazo: o que não couber fica para os ciclos
 *  seguintes (enrichedAt/historyFetchedAt NULL = fila persistente; parque
 *  incompleto ou com erro = a cobertura dele não avança). */
export async function runRecentCronSync(windowMinutes = 30, opts: { deadlineAt?: number; owner?: SyncLockOwner } = {}): Promise<RecentCronResult> {
  const t0 = Date.now();
  const deadlineAt = opts.deadlineAt ?? t0 + CRON_BUDGET_MS;
  const locked = await withSyncLock(opts.owner ?? "cron_recent", () => runRecentCronSyncUnlocked(windowMinutes, t0, deadlineAt));
  if (locked.busy) {
    return { busy: true, report: { processed: 0, created: 0, updated: 0, errors: [] }, parkErrors: [], enriched: 0,
      historyFetched: 0, durationMs: Date.now() - t0, windowStart: utcDay(t0), partial: false, totalMismatches: [] };
  }
  return locked.value;
}

async function runRecentCronSyncUnlocked(windowMinutes: number, t0: number, deadlineAt: number): Promise<RecentCronResult> {
  const parks = getConfiguredParks();
  const parkIds = parks.length ? parks.map((p) => p.id) : ["global"];

  let coverage = new Map<string, number | null>();
  let fallback: number | null = null;
  try {
    coverage = await loadRecentCoverage();
    // Compatibilidade: antes da 0101 o recente e o futuro gravavam os dois
    // "api_sync" — um sucesso do futuro podia encolher a janela. Por isso o
    // legado entra com 2 h de folga extra e só para parques sem cobertura.
    const recent = mysqlToMs(await getLastSyncSuccessAt("api_sync_recent"));
    const legacy = recent == null ? mysqlToMs(await getLastSyncSuccessAt("api_sync")) : null;
    fallback = recent ?? (legacy != null ? legacy - 2 * 3_600_000 : null);
  } catch (err) {
    console.warn("[BookingSync] cobertura indisponível — janela máxima:", deliveryErrorCode(err));
  }
  const windows = computeRecentWindows({ now: t0, windowMinutes, parkIds, coverage, fallback });
  const starts = Array.from(windows.values());
  const minStart = starts.length ? Math.min(...starts) : t0 - windowMinutes * 60_000;
  const parkStartDates = Object.fromEntries(Array.from(windows.entries()).map(([id, ms]) => [id, utcDay(ms)]));

  // Fase 1: report (puxa o que estiver novo/alterado). Deixa de arrancar
  // trabalhos novos antes do fim para sobrar tempo ao enriquecimento.
  const report = await syncBookings({
    startDate: utcDay(minStart),
    endDate: utcDay(t0),
    parkStartDates,
    deadlineAt: deadlineAt - REPORT_RESERVE_MS,
    syncType: "api_sync_recent",
    windowStart: utcMysql(minStart),
    windowEnd: utcMysql(t0),
  });
  try {
    await saveRecentCoverage(t0, report.parkStatus);
  } catch (err) {
    console.error("[BookingSync] gravar cobertura falhou:", deliveryErrorCode(err));
  }

  // Fase 2a: enrichment IMEDIATO e direcionado às reservas que acabaram de
  // entrar/mudar neste ciclo (origem, nome real do parceiro, pagamento).
  const targeted = Date.now() < deadlineAt - 5_000
    ? await enrichBookingsBatch({
        externalIds: report.enrichTargets,
        limit: Math.min(Math.max(report.enrichTargets.length, 1), 120),
        deadlineAt,
      })
    : { scanned: 0, enriched: 0, errors: 0, noKey: 0 };

  // Fase 2b + 3 em paralelo: resto do backlog + history, se sobrar orçamento.
  let backlogEnriched = 0;
  let historyFetched = 0;
  if (Date.now() < deadlineAt - 5_000) {
    const [backlogResult, historyResult] = await Promise.allSettled([
      enrichBookingsBatch({ limit: 20, deadlineAt }),
      syncBookingHistoryBatch(30, deadlineAt),
    ]);
    backlogEnriched = backlogResult.status === "fulfilled" ? backlogResult.value.enriched : 0;
    historyFetched = historyResult.status === "fulfilled" ? historyResult.value.fetched : 0;
  }

  return {
    report: { processed: report.processed, created: report.created, updated: report.updated, errors: report.errors },
    parkErrors: report.parkErrors,
    enriched: targeted.enriched + backlogEnriched,
    historyFetched,
    durationMs: Date.now() - t0,
    windowStart: utcDay(minStart),
    partial: report.partial || Date.now() >= deadlineAt - 5_000,
    totalMismatches: report.totalMismatches,
  };
}

/** Sync de janela futura (próximas 4 semanas) para Extras Dia planear.
 *  Mais leve — só checkin/checkout, sem enrich/history.
 *
 *  A janela completa (4 semanas × parques × 2 actionTypes) não cabe nos 60s
 *  do Vercel, por isso é RETOMÁVEL: processa fatias de FUTURE_CHUNK_DAYS a
 *  partir de offsetDays enquanto houver orçamento, e devolve done:false +
 *  nextOffset quando faltarem fatias — o chamador repete com esse offset.
 *  Grava "api_sync_future": nunca mexe na janela do sync recente. */
const FUTURE_CHUNK_DAYS = 7;

export { chunkNeedsRetry };

export interface FutureCronResult {
  busy?: boolean;
  report: { processed: number; created: number; updated: number; errors: string[] };
  parkErrors: string[];
  durationMs: number;
  done: boolean;
  nextOffset?: number;
  startOffset: number;
  /** A fatia parou por falha de um report (não por falta de tempo). */
  needsRetry: boolean;
}

export async function runFutureCronSync(
  weeksAhead = 4,
  opts: { offsetDays?: number; deadlineAt?: number; owner?: SyncLockOwner } = {},
): Promise<FutureCronResult> {
  const t0 = Date.now();
  const deadlineAt = opts.deadlineAt ?? t0 + CRON_BUDGET_MS;
  const totalDays = weeksAhead * 7;
  const startOffset = Math.min(Math.max(0, Math.trunc(opts.offsetDays ?? 0)), totalDays);
  const locked = await withSyncLock(opts.owner ?? "cron_future", async () => {
    const agg = { processed: 0, created: 0, updated: 0, errors: [] as string[] };
    const parkErrors = new Set<string>();
    let offset = startOffset;
    let needsRetry = false;
    while (offset < totalDays) {
      // A 1ª fatia corre sempre; as seguintes só se sobrar margem.
      if (offset > startOffset && Date.now() >= deadlineAt - 20_000) break;
      const chunkStart = t0 + offset * 86_400_000;
      const chunkEnd = t0 + Math.min(offset + FUTURE_CHUNK_DAYS, totalDays) * 86_400_000;
      const report = await syncBookings({
        startDate: utcDay(chunkStart),
        endDate: utcDay(chunkEnd),
        actionTypes: ["checkin", "checkout"],
        deadlineAt,
        syncType: "api_sync_future",
      });
      agg.processed += report.processed;
      agg.created += report.created;
      agg.updated += report.updated;
      agg.errors.push(...report.errors);
      report.parkErrors.forEach((id) => parkErrors.add(id));
      // Só uma fatia INCOMPLETA (report falhado ou por fazer) é repetida sem
      // avançar o marcador. Erros de reservas individuais ("Booking X: …") já
      // ficaram registados e não podem prender o sync futuro na mesma fatia.
      if (chunkNeedsRetry(report.errors)) { needsRetry = true; break; }
      if (report.partial) break;
      offset += FUTURE_CHUNK_DAYS;
    }
    return { agg, parkErrors: Array.from(parkErrors), offset, needsRetry };
  });
  if (locked.busy) {
    return { busy: true, report: { processed: 0, created: 0, updated: 0, errors: [] }, parkErrors: [],
      durationMs: Date.now() - t0, done: false, nextOffset: startOffset, startOffset, needsRetry: false };
  }
  const { agg, parkErrors, offset, needsRetry } = locked.value;
  const done = offset >= totalDays;
  return {
    report: agg,
    parkErrors,
    durationMs: Date.now() - t0,
    done,
    startOffset,
    needsRetry,
    ...(done ? {} : { nextOffset: offset }),
  };
}

/** "Reparar período" (botão e MCP /sync/day): no máximo 3 dias, com prazo e
 *  trinco. O que não couber fica marcado como parcial para repetir. */
export const REPAIR_MAX_DAYS = 3;
export async function runRepairSync(opts: {
  startDate: string;
  endDate: string;
  triggeredById?: number;
  owner?: SyncLockOwner;
  deadlineAt?: number;
  enrich?: boolean;
}): Promise<{ busy: true } | { busy: false; result: SyncBookingsResult; enriched: number; historyFetched: number }> {
  const deadlineAt = opts.deadlineAt ?? Date.now() + 45_000;
  const locked = await withSyncLock(opts.owner ?? "manual", async () => {
    const result = await syncBookings({
      startDate: opts.startDate,
      endDate: opts.endDate,
      triggeredById: opts.triggeredById,
      deadlineAt: deadlineAt - (opts.enrich ? 10_000 : 0),
      syncType: "manual",
    });
    let enriched = 0, historyFetched = 0;
    if (opts.enrich && Date.now() < deadlineAt - 5_000) {
      const [e, h] = await Promise.allSettled([
        enrichBookingsBatch({ externalIds: result.enrichTargets, limit: Math.min(Math.max(result.enrichTargets.length, 1), 100), deadlineAt }),
        syncBookingHistoryBatch(30, deadlineAt),
      ]);
      enriched = e.status === "fulfilled" ? e.value.enriched : 0;
      historyFetched = h.status === "fulfilled" ? h.value.fetched : 0;
    }
    return { result, enriched, historyFetched };
  });
  return locked.busy ? { busy: true } : { busy: false, ...locked.value };
}
