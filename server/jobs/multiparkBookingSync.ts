/**
 * Detalhe das reservas Multipark para a cópia financeira (multipark_bookings)
 * e o CRM. Alimentado pelo webhook (server/multiparkWebhook.ts) e pela fila
 * multipark-deliveries (agendador /api/cron/tick): cada reserva nova ou
 * alterada é completada com o /bookings/:id da API Multipark (cliente,
 * matrícula, campanha, parceiro, origem, entrega, voos).
 *
 * Já não há sync por report (recente/futuro), reparação de períodos nem
 * cópia do histórico (multipark_booking_history fica só com o que já lá
 * estava): as páginas leem a BD da Multipark ao vivo (server/multiparkDb).
 */

import {
  getBooking,
  getParkApiKey,
  matchParkConfig,
  PARK_CONFIGS,
  type MultiparkBooking,
} from "../multipark";
import { getProjects, getDb, upsertBookingExtras } from "../db";
import { eq, and, or, sql, isNull, lte } from "drizzle-orm";
import { multiparkBookings } from "../../drizzle/schema";
import { parseBookingDate, bookingDetailCore } from "../bookingRefresh";
import { deliveryErrorCode, retryDelaySeconds } from "../bookingDeliveryQueue";
import { classifyAllocation } from "../spotClassification";
import { runConcurrent } from "../_core/concurrency";
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
    await applyBookingDetail(db, externalId, detailed, context);
    return true;
  } catch (error) {
    await deferBookingDetail(externalId, deliveryErrorCode(error));
    return false;
  }
}

type SyncDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Grava o detalhe de uma reserva (formato /bookings/:id) na linha de
 * multipark_bookings. Lança em erro — quem chama decide o que fazer (o
 * enriquecimento reagenda com deferBookingDetail).
 */
export async function applyBookingDetail(db: SyncDb, externalId: string, detailed: MultiparkBooking,
  context?: { parkName: string | null; city: string | null }): Promise<void> {
    const b: any = detailed;
    const projectMap = await getProjectMap();
    const mapped = bookingToRecord(detailed, projectMap, await getAliasResolver());

    // Cliente + veículo só são preenchidos se vierem (o report mascara estes
    // campos para reservas de parceiros; o /bookings/:id devolve-os reais).
    const update: Record<string, any> = {
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
    // Serviços extra itemizados (antes vinham do sync por report, que saiu).
    // Sem lista no detalhe não mexe (upsertBookingExtras ignora vazio/ausente).
    if (Array.isArray(b.extraServices)) await upsertBookingExtras(externalId, b.extraServices);
}

/** Enriquecimento só volta a rodar semanalmente em reservas vivas: não
 *  terminadas, ou com check-out há menos de ROTATION_MAX_AGE_DAYS dias. */
const ROTATION_MAX_AGE_DAYS = 30;
const TERMINAL_STATUSES_SQL = sql`('CHECKED_OUT', 'CANCELLED')`;
/** Código guardado quando o parque está fechado: não volta a ser agendado. */
export const PARK_CLOSED_CODE = "PARK_CLOSED";

/** Parque fechado (closed:true): marca e NÃO reagenda (sem retryAt). */
async function markParkClosed(externalId: string) {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  await db.update(multiparkBookings).set({ detailErrorCode: PARK_CLOSED_CODE, detailRetryAt: null })
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

  // Prioridade: reservas recentes/ativas primeiro, depois
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
      await markParkClosed(p.externalId);
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
