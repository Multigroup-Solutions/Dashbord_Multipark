/**
 * MultiPark Backoffice API Client
 * 
 * Discovered endpoints:
 * - GET    /health                          → Health check (public)
 * - GET    /availability                    → Check parking availability (requires vehicleType + parkingType)
 * - POST   /bookings                       → Create booking
 * - PUT    /bookings/:id                   → Update booking
 * - GET    /bookings/:id/history           → Booking history (timeline of actions)
 * - GET    /agent/history                  → Agent history (all actions by agent in period)
 * - GET    /bookings/checkoutDrivers       → Checkout drivers ranking for a period
 * - GET    /api/v1/parks                   → List parks (public, different base)
 *
 * Auth: X-Api-Key header for bookings-api endpoints
 */

import { ENV } from "./_core/env";

const MAX_RETRIES = 3;
// Sem timeout, um pedido pendurado segura a função serverless até o Vercel a
// matar aos 60s (maxDuration) — o cron fica vermelho sem resposta nenhuma.
const FETCH_TIMEOUT_MS = Number(process.env.MULTIPARK_FETCH_TIMEOUT_MS || 15_000);

// ─── Park API key mapping ───

export interface ParkConfig {
  id: string;
  name: string;
  city: string;
  envKey: string;
  externalId?: string;
  closed?: boolean; // se true, sync e enrichment ignoram
}

export const PARK_CONFIGS: ParkConfig[] = [
  { id: "LISBON_AIRPARK", name: "Airpark", city: "Lisboa", envKey: "MULTIPARK_API_KEY_LISBON_AIRPARK" },
  { id: "LISBON_REDPARK", name: "Redpark", city: "Lisboa", envKey: "MULTIPARK_API_KEY_LISBON_REDPARK" },
  { id: "LISBON_SKYPARK", name: "Skypark", city: "Lisboa", envKey: "MULTIPARK_API_KEY_LISBON_SKYPARK" },
  { id: "LISBON_TOP_PARKING", name: "Top-Parking", city: "Lisboa", envKey: "MULTIPARK_API_KEY_LISBON_TOP_PARKING", closed: true },
  { id: "FARO_AIRPARK", name: "Airpark", city: "Faro", envKey: "MULTIPARK_API_KEY_FARO_AIRPARK" },
  { id: "FARO_REDPARK", name: "Redpark", city: "Faro", envKey: "MULTIPARK_API_KEY_FARO_REDPARK" },
  { id: "FARO_SKYPARK", name: "Skypark", city: "Faro", envKey: "MULTIPARK_API_KEY_FARO_SKYPARK" },
  { id: "PORTO_AIRPARK", name: "Airpark", city: "Porto", envKey: "MULTIPARK_API_KEY_PORTO_AIRPARK" },
  { id: "PORTO_REDPARK", name: "Redpark", city: "Porto", envKey: "MULTIPARK_API_KEY_PORTO_REDPARK" },
  { id: "PORTO_SKYPARK", name: "Skypark", city: "Porto", envKey: "MULTIPARK_API_KEY_PORTO_SKYPARK" },
  { id: "PORTO_TOP_PARKING", name: "Top Parking", city: "Porto", envKey: "MULTIPARK_API_KEY_PORTO_TOP_PARKING", externalId: "cmr2qq7tp05viql2zi4ah8dcl" },
  { id: "LISBON_BOARDINGPARK", name: "Boardingpark", city: "Lisboa", envKey: "MULTIPARK_API_KEY_LISBON_BOARDINGPARK" },
  { id: "LISBON_PARKDIRECT", name: "Parkdirect", city: "Lisboa", envKey: "MULTIPARK_API_KEY_LISBON_PARKDIRECT" },
  { id: "LISBON_PREMIUM_PARK", name: "Premium Park", city: "Lisboa", envKey: "MULTIPARK_API_KEY_LISBON_PREMIUM_PARK" },
  { id: "LISBON_READYPARK", name: "Readypark", city: "Lisboa", envKey: "MULTIPARK_API_KEY_LISBON_READYPARK" },
  { id: "LISBON_STOP_FLY_PARK", name: "Stop & Fly Park", city: "Lisboa", envKey: "MULTIPARK_API_KEY_LISBON_STOP_FLY_PARK" },
  { id: "LISBON_TRAVELPARKING", name: "Travelparking", city: "Lisboa", envKey: "MULTIPARK_API_KEY_LISBON_TRAVELPARKING" },
  { id: "LISBON_VIAGENSPARKING", name: "Viagensparking", city: "Lisboa", envKey: "MULTIPARK_API_KEY_LISBON_VIAGENSPARKING" },
  // Chave substituída e validada com o report de setembro em 2026-09-10.
  { id: "FARO_BOARDINGPARK", name: "Boardingpark", city: "Faro", envKey: "MULTIPARK_API_KEY_FARO_BOARDINGPARK" },
  { id: "FARO_PARKDIRECT", name: "Parkdirect", city: "Faro", envKey: "MULTIPARK_API_KEY_FARO_PARKDIRECT" },
  { id: "FARO_PREMIUM_PARK", name: "Premium Park", city: "Faro", envKey: "MULTIPARK_API_KEY_FARO_PREMIUM_PARK" },
  { id: "FARO_READYPARK", name: "Readypark", city: "Faro", envKey: "MULTIPARK_API_KEY_FARO_READYPARK" },
  { id: "FARO_STOP_FLY_PARK", name: "Stop & Fly Park", city: "Faro", envKey: "MULTIPARK_API_KEY_FARO_STOP_FLY_PARK" },
  { id: "FARO_TRAVELPARKING", name: "Travelparking", city: "Faro", envKey: "MULTIPARK_API_KEY_FARO_TRAVELPARKING" },
  { id: "FARO_VIAGENSPARKING", name: "Viagensparking", city: "Faro", envKey: "MULTIPARK_API_KEY_FARO_VIAGENSPARKING" },
  { id: "PORTO_BOARDINGPARK", name: "Boardingpark", city: "Porto", envKey: "MULTIPARK_API_KEY_PORTO_BOARDINGPARK" },
  { id: "PORTO_PARKDIRECT", name: "Parkdirect", city: "Porto", envKey: "MULTIPARK_API_KEY_PORTO_PARKDIRECT" },
  { id: "PORTO_PREMIUM_PARK", name: "Premium Park", city: "Porto", envKey: "MULTIPARK_API_KEY_PORTO_PREMIUM_PARK" },
  { id: "PORTO_READYPARK", name: "Readypark", city: "Porto", envKey: "MULTIPARK_API_KEY_PORTO_READYPARK" },
  { id: "PORTO_STOP_FLY_PARK", name: "Stop & Fly Park", city: "Porto", envKey: "MULTIPARK_API_KEY_PORTO_STOP_FLY_PARK" },
  { id: "PORTO_TRAVELPARKING", name: "Travelparking", city: "Porto", envKey: "MULTIPARK_API_KEY_PORTO_TRAVELPARKING" },
  { id: "PORTO_VIAGENSPARKING", name: "Viagensparking", city: "Porto", envKey: "MULTIPARK_API_KEY_PORTO_VIAGENSPARKING" },
];

export function getParkApiKey(parkConfig: ParkConfig): string | undefined {
  return process.env[parkConfig.envKey];
}

export function getConfiguredParks(): ParkConfig[] {
  return PARK_CONFIGS.filter(p => !p.closed && !!process.env[p.envKey]);
}

const normalizedName = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const normalizedCity = (s: string) => (({ lisbon: "lisboa", oporto: "porto" } as Record<string, string>)[s.toLowerCase()] ?? s.toLowerCase());

export function matchParkConfig(input: { parkId?: string | null; parkName?: string | null; city?: string | null }, configs = PARK_CONFIGS): ParkConfig | undefined {
  if (input.parkId) {
    const exact = configs.find(p => p.externalId === input.parkId || p.id === input.parkId);
    if (exact) return exact;
  }
  if (!input.parkName) return undefined;
  const name = normalizedName(input.parkName);
  const matches = configs.filter(p => {
    if (input.city && normalizedCity(input.city) !== normalizedCity(p.city)) return false;
    return [p.name, `${p.name} ${p.city}`, `${p.name} ${normalizedCity(p.city) === "lisboa" ? "lisbon" : p.city}`].some(n => normalizedName(n) === name);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

let publicParksCache: { at: number; parks: MultiparkPark[] } | null = null;
export async function resolveParkForBooking(input: { parkId?: string | null; parkName?: string | null; city?: string | null }): Promise<ParkConfig | undefined> {
  let config = matchParkConfig(input);
  if (!config && input.parkId) {
    if (!publicParksCache || Date.now() - publicParksCache.at > 300_000) {
      const response = await fetch("https://api.multipark.pt/api/v1/parks", { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("Catálogo de parques indisponível");
      const body = await response.json();
      const parks = Array.isArray(body) ? body : body.parks ?? body.data;
      if (!Array.isArray(parks)) throw new Error("Formato do catálogo de parques inválido");
      publicParksCache = { at: Date.now(), parks };
    }
    const source = publicParksCache.parks.find(p => p.id === input.parkId);
    if (source) config = matchParkConfig({ parkName: source.name, city: source.city });
    if (!config) throw Object.assign(new Error("Parque sem correspondência configurada"), { code: "PARK_NOT_MAPPED" });
  }
  if (config && (config.closed || !getParkApiKey(config))) {
    // Conhecemos o parque: não testar chaves de outros parques indiscriminadamente.
    throw Object.assign(new Error("Parque sem acesso de sincronização"), { code: "PARK_ACCESS_MISSING" });
  }
  return config;
}

export function parkCoverage() {
  return PARK_CONFIGS.map(p => ({ id: p.id, name: p.name, city: p.city,
    state: p.closed ? "excluded" : getParkApiKey(p) ? "configured" : "missing_key" }));
}

// ─── Core request helper with retry + rate-limit handling ───

async function multiparkRequest<T = any>(opts: {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: Record<string, any>;
  params?: Record<string, string>;
  baseUrl?: string;
  apiKey?: string;
  maxAttempts?: number;
  timeoutMs?: number;
}): Promise<T> {
  const { method = "GET", path, body, params, baseUrl } = opts;
  const base = baseUrl || ENV.multiparkApiUrl;
  const apiKey = opts.apiKey || ENV.multiparkApiKey;

  if (!apiKey) throw new Error("MULTIPARK_API_KEY não configurada");

  let url = `${base}${path}`;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    url += `?${qs}`;
  }

  const maxAttempts = opts.maxAttempts ?? MAX_RETRIES;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          "X-Api-Key": apiKey,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS),
      });

      // Rate limited — exponential backoff
      if (res.status === 429 && attempt < maxAttempts - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (!res.ok) {
        let errorBody: any = null;
        try { errorBody = await res.json(); } catch {}
        const msg = errorBody?.error?.message || errorBody?.message || `HTTP ${res.status}`;
        const err = new Error(`MultiPark API: ${Array.isArray(msg) ? msg.join(", ") : msg}`) as Error & { status: number; details: any };
        err.status = res.status;
        err.details = errorBody?.error?.details || errorBody?.details;
        throw err;
      }

      if (res.status === 204) return {} as T;
      return (await res.json()) as T;
    } catch (error: any) {
      if (error.status) throw error;
      if (attempt === maxAttempts - 1) throw error;
    }
  }
  throw new Error("MultiPark API: max retries exceeded");
}

// ─── Type definitions ───

export interface MultiparkClient {
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber: string;
  nif?: string;
}

export interface MultiparkVehicle {
  licensePlate: string; // No spaces or hyphens
  brand?: string;
  model?: string;
  color?: string;
  type?: "MOTORCYCLE" | "CAR" | "VAN" | "TRUCK";
}

export interface MultiparkFlightInfo {
  arrivalFlight?: string;
  arrivalTime?: string;
  departureFlight?: string;
  departureTime?: string;
}

export type ParkingType = "COVERED" | "UNCOVERED" | "INDOOR" | "VIP";
export type VehicleType = "MOTORCYCLE" | "CAR" | "VAN" | "TRUCK";

export interface MultiparkBookingInput {
  checkIn: string;
  checkOut: string;
  checkInTime: string;
  checkOutTime: string;
  client?: MultiparkClient;
  vehicle?: MultiparkVehicle;
  parkingType: ParkingType;
  pricingType?: "DAY" | "HOUR";
  deliveryType?: string;
  deliveryService?: boolean;
  deliveryAddress?: string;
  pickupAddress?: string;
  flightInfo?: MultiparkFlightInfo;
  extraServices?: string[];
  discountCode?: string;
  notes?: string;
}

export interface MultiparkBooking {
  id: string;
  bookingNumber: string;
  status: string;
  checkIn: string;
  checkOut: string;
  checkInTime: string;
  checkOutTime?: string;
  parkId?: string;
  parkName?: string;
  park?: {
    id: string;
    name: string;
    city: string;
    types?: string[];
    isPro?: boolean;
  };
  customer?: MultiparkClient;
  client?: MultiparkClient;
  vehicle?: MultiparkVehicle;
  pricing?: {
    total?: number;
    totalPrice?: number;
    parkingPrice?: number;
    deliveryCharges?: number;
    extraServicesTotal?: number;
    discount?: number;
    remainingToPay?: number;
    currency: string;
  };
  deliveryService?: boolean;
  deliveryAddress?: string;
  pickupAddress?: string;
  extraServices?: Array<{ name: string; quantity: number; price: number }>;
  discountCode?: string;
  cancelledAt?: string;
  cancelReason?: string;
  createdAt?: string;
  updatedAt: string;
  [key: string]: any;
}

export type BookingActionType = "creation" | "checkin" | "checkout" | "cancelation";

export interface MultiparkBookingsReport {
  total: number;
  actionType: BookingActionType;
  period: { startDate: string; endDate: string };
  bookings: MultiparkBooking[];
}

export interface MultiparkAvailability {
  available: boolean;
  totalSpots: number;
  availableSpots: number;
  message: string;
}

export interface MultiparkPark {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  featured: boolean;
  status?: string;
  [key: string]: any;
}

// ─── Public API methods ───

/** Health check */
export async function healthCheck(): Promise<{ status: string; timestamp: string; version: string }> {
  return multiparkRequest({ path: "/health" });
}

/** Check availability for a date range */
export async function checkAvailability(
  checkIn: string,
  checkOut: string,
  vehicleType: VehicleType = "CAR",
  parkingType: ParkingType = "COVERED"
): Promise<MultiparkAvailability> {
  return multiparkRequest({
    path: "/availability",
    params: { checkIn, checkOut, vehicleType, parkingType },
  });
}

/** Create a new booking */
export async function createBooking(data: MultiparkBookingInput): Promise<MultiparkBooking> {
  return multiparkRequest({ method: "POST", path: "/bookings", body: data });
}

/** Update an existing booking */
export async function updateBooking(id: string, data: Partial<MultiparkBookingInput>): Promise<MultiparkBooking> {
  return multiparkRequest({ method: "PUT", path: `/bookings/${id}`, body: data });
}

/** Get booking by ID (optionally with specific park's API key) */
export async function getBooking(id: string, apiKey?: string, opts: { maxAttempts?: number; timeoutMs?: number } = {}): Promise<MultiparkBooking> {
  return multiparkRequest({ path: `/bookings/${encodeURIComponent(id)}`, apiKey, ...opts });
}

/**
 * Try to fetch a booking using each configured park API key until one succeeds.
 * Returns the booking + the park that owned it. Useful when we don't know which
 * park a booking belongs to in advance.
 */
export async function getBookingTryAllParks(id: string, opts: { deadlineAt?: number } = {}): Promise<{
  booking: MultiparkBooking;
  parkConfig: ParkConfig;
} | null> {
  const parks = getConfiguredParks();
  for (const park of parks) {
    if (opts.deadlineAt && Date.now() >= opts.deadlineAt) break;
    try {
      const apiKey = getParkApiKey(park);
      if (!apiKey) continue;
      const booking = await multiparkRequest<MultiparkBooking>({
        path: `/bookings/${encodeURIComponent(id)}`,
        apiKey,
        ...(opts.deadlineAt ? { maxAttempts: 1, timeoutMs: Math.max(1, Math.min(4000, opts.deadlineAt - Date.now())) } : {}),
      });
      if (booking?.id) return { booking, parkConfig: park };
    } catch {
      // try next park
    }
  }
  return null;
}

/** Check if MultiPark API is configured */
export function isMultiparkConfigured(): boolean {
  return !!ENV.multiparkApiKey || getConfiguredParks().length > 0;
}

/** List parks (public endpoint, no auth needed) */
export async function listParks(): Promise<{ parks: MultiparkPark[] }> {
  if (!isMultiparkConfigured()) return { parks: [] };
  return multiparkRequest({
    path: "/parks",
    baseUrl: "https://api.multipark.pt/api/v1",
  });
}

/** Get bookings report by period and action type */
export async function getBookingsReport(
  startDate: string,
  endDate: string,
  actionType: BookingActionType,
  apiKey?: string
): Promise<MultiparkBookingsReport> {
  return multiparkRequest({
    path: "/bookings/report",
    params: { startDate, endDate, actionType },
    apiKey,
  });
}

/** Get bookings report for a specific park */
export async function getBookingsReportForPark(
  parkConfig: ParkConfig,
  startDate: string,
  endDate: string,
  actionType: BookingActionType
): Promise<MultiparkBookingsReport & { parkConfig: ParkConfig }> {
  const apiKey = getParkApiKey(parkConfig);
  if (!apiKey) throw new Error(`API key not configured for ${parkConfig.name} - ${parkConfig.city}`);
  const report = await getBookingsReport(startDate, endDate, actionType, apiKey);
  return { ...report, parkConfig };
}

/** Get bookings report for ALL configured parks */
export async function getBookingsReportAllParks(
  startDate: string,
  endDate: string,
  actionType: BookingActionType
): Promise<{ park: ParkConfig; report: MultiparkBookingsReport }[]> {
  const parks = getConfiguredParks();
  const results: { park: ParkConfig; report: MultiparkBookingsReport }[] = [];
  for (const park of parks) {
    try {
      const report = await getBookingsReport(startDate, endDate, actionType, getParkApiKey(park));
      results.push({ park, report });
    } catch (err: any) {
      console.error(`[MultiPark] Report failed for ${park.name} ${park.city}: ${err.message}`);
    }
  }
  return results;
}

/** Cancel a booking */
export async function cancelBooking(
  id: string,
  reason: string
): Promise<MultiparkBooking> {
  return multiparkRequest({
    method: "PUT",
    path: `/bookings/${id}/status`,
    body: { status: "CANCELLED", reason },
  });
}

/** Calculate pricing */
export async function calculatePricing(data: {
  checkIn: string;
  checkOut: string;
  vehicleType?: VehicleType;
  parkingType?: ParkingType;
  deliveryService?: boolean;
  deliveryAddress?: string;
  extraServices?: Array<{ serviceId: string; quantity: number }>;
  discountCode?: string;
}): Promise<any> {
  return multiparkRequest({ method: "POST", path: "/pricing", body: data });
}

/** Test API connectivity */
export async function testConnection(): Promise<{ ok: boolean; message: string; version?: string }> {
  try {
    const health = await healthCheck();
    return { ok: true, message: `API OK (v${health.version})`, version: health.version };
  } catch (error: any) {
    return { ok: false, message: `Erro: ${error.message}` };
  }
}

// ─── Booking history & agent tracking ───

export interface BookingHistoryEntry {
  id: string;
  changeType: string; // CHECK_IN, CHECK_OUT, MOVEMENT, UPDATE, CREATED, CHECKING_IN, CHECKING_OUT, PENDING_CHECKOUT, CANCELLED
  actionTime: string;
  remarks?: string;
  agentName: string;
  userId: string;
  user: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
  modifiedFields?: string; // JSON string
  platform?: string;
  booking?: {
    id: string;
    status: string;
    checkIn: string;
    checkOut?: string;
    parkName: string;
    licensePlate: string;
  };
}

export interface CheckoutDriver {
  name: string;
  userId?: string;
  count: number;
}

/** Get booking history (timeline of all actions on a booking) */
export async function getBookingHistory(
  bookingId: string,
  apiKey?: string,
  opts: { maxAttempts?: number; timeoutMs?: number } = {},
): Promise<{ bookingId: string; total: number; history: BookingHistoryEntry[] }> {
  return multiparkRequest({
    path: `/bookings/${encodeURIComponent(bookingId)}/history`,
    apiKey, ...opts,
  });
}

/** Get agent history (all actions by a specific agent in a period) */
export async function getAgentHistory(opts: {
  startDate: string;
  endDate: string;
  agentName?: string;
  userId?: string;
  apiKey?: string;
}): Promise<{ total: number; period: { startDate: string; endDate: string }; agentName: string; agentUserId: string; history: BookingHistoryEntry[] }> {
  const params: Record<string, string> = {
    startDate: opts.startDate,
    endDate: opts.endDate,
  };
  if (opts.userId) params.userId = opts.userId;
  else if (opts.agentName) params.agentName = opts.agentName;
  else throw new Error("Either userId or agentName must be provided");

  return multiparkRequest({
    path: "/agent/history",
    params,
    apiKey: opts.apiKey,
  });
}

/** Get checkout drivers ranking for a period */
export async function getCheckoutDrivers(
  startDate: string,
  endDate: string,
  apiKey?: string
): Promise<{ total: number; period: { startDate: string; endDate: string }; drivers: CheckoutDriver[] }> {
  return multiparkRequest({
    path: "/bookings/checkoutDrivers",
    params: { startDate, endDate },
    apiKey,
  });
}
