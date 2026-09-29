/**
 * Cliente da API Multipark — só o que o webhook e a fila de detalhe usam
 * (cópia financeira em multipark_bookings + CRM):
 * - GET /bookings/:id    → detalhe de uma reserva (chave do parque)
 * - GET /api/v1/parks    → catálogo público de parques (resolver parque do webhook)
 *
 * O resto (report por período, histórico, disponibilidade, criar/cancelar)
 * saiu: as páginas leem a BD da Multipark ao vivo (server/multiparkDb).
 *
 * Auth: cabeçalho X-Api-Key (chave geral ou por parque).
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

function getConfiguredParks(): ParkConfig[] {
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

export type ParkingType = "COVERED" | "UNCOVERED" | "INDOOR" | "VIP";

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
