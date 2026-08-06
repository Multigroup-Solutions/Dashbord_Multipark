import crypto from "crypto";
import { ENV } from "./_core/env";

const NETWORK = process.env.ZELLO_NETWORK ?? "airpark";
const BASE_URL = `https://${NETWORK}.zellowork.com`;
const USERNAME = process.env.ZELLO_USERNAME ?? "";
const PASSWORD = process.env.ZELLO_PASSWORD ?? "";

// Session management — reuse sid across calls
let currentSid: string | null = null;
let sidExpiresAt = 0;

/** Get a fresh token + sid from Zello */
async function getToken(): Promise<{ token: string; sid: string }> {
  const res = await fetch(`${BASE_URL}/user/gettoken`);
  const data = await res.json();
  if (data.status !== "OK") throw new Error(`Zello gettoken failed: ${data.status}`);
  return { token: data.token, sid: data.sid };
}

/** Authenticate and get a valid session */
async function authenticate(): Promise<string> {
  // Reuse session if still valid (sessions last ~10 min, we refresh every 8)
  if (currentSid && Date.now() < sidExpiresAt) return currentSid;

  const apiKey = ENV.zelloApiKey;
  if (!apiKey) throw new Error("ZELLO_API_KEY not configured");
  if (!USERNAME) throw new Error("ZELLO_USERNAME not configured");
  if (!PASSWORD) throw new Error("ZELLO_PASSWORD not configured");

  const { token, sid } = await getToken();

  // Hash: md5(md5(password) + token + api_key)
  const md5pass = crypto.createHash("md5").update(PASSWORD).digest("hex");
  const combined = md5pass + token + apiKey;
  const authHash = crypto.createHash("md5").update(combined).digest("hex");

  const params = new URLSearchParams({ username: USERNAME, password: authHash });
  const res = await fetch(`${BASE_URL}/user/login?sid=${sid}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await res.json();
  if (data.status !== "OK") throw new Error(`Zello login failed: ${data.status}`);

  currentSid = sid;
  sidExpiresAt = Date.now() + 8 * 60 * 1000; // 8 minutes
  return sid;
}

/** Helper to make authenticated GET requests */
async function zelloGet(path: string, params?: Record<string, string>): Promise<any> {
  const sid = await authenticate();
  const url = new URL(`${BASE_URL}/${path}`);
  url.searchParams.set("sid", sid);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString());
  const data = await res.json();

  // If session expired, retry once
  if (data.code === "301") {
    currentSid = null;
    sidExpiresAt = 0;
    const newSid = await authenticate();
    url.searchParams.set("sid", newSid);
    const retryRes = await fetch(url.toString());
    return retryRes.json();
  }

  return data;
}

// ============ PUBLIC API ============

export interface ZelloUser {
  name: string;
  email: string;
  phone: string;
  fullName: string;
  job: string;
  admin: boolean;
  channels: string[];
  geotrackingOff: boolean;
}

export interface ZelloLocation {
  username: string;
  displayName: string;
  latitude: number;
  longitude: number;
  speed: number; // km/h
  heading: number;
  altitude: number;
  batteryLevel: number;
  chargingStatus: number;
  signalStrength: number;
  accuracy: number;
  status: string;
  lastReport: number; // epoch seconds
  lastReportDelay: number;
}

export interface ZelloChannel {
  name: string;
  count: number;
  isShared: boolean;
  isDispatch: boolean;
}

function isZelloConfigured(): boolean {
  return !!(ENV.zelloApiKey && USERNAME && PASSWORD);
}

/** Get all users in the network */
export async function getZelloUsers(): Promise<ZelloUser[]> {
  if (!isZelloConfigured()) return [];
  const data = await zelloGet("user/get");
  if (data.status !== "OK") throw new Error(`Zello user/get failed: ${data.status}`);
  return (data.users || []).map((u: any) => ({
    name: u.name,
    email: u.email || "",
    phone: u.phone || u.profile_phone || "",
    fullName: u.full_name || u.name,
    job: u.job || "",
    admin: !!u.admin,
    channels: u.channels || [],
    geotrackingOff: !!u.geotracking_off,
  }));
}

/** Get all channels */
export async function getZelloChannels(): Promise<ZelloChannel[]> {
  if (!isZelloConfigured()) return [];
  const data = await zelloGet("channel/get");
  if (data.status !== "OK") throw new Error(`Zello channel/get failed: ${data.status}`);
  return (data.channels || []).map((c: any) => ({
    name: c.name,
    count: parseInt(c.count, 10) || 0,
    isShared: !!c.is_shared,
    isDispatch: !!c.is_dispatch,
  }));
}

/** Get current GPS locations of all active users */
export async function getZelloLocations(): Promise<ZelloLocation[]> {
  if (!isZelloConfigured()) return [];
  const data = await zelloGet("location/get", { filter: "none", max: "100" });
  if (data.status !== "OK") throw new Error(`Zello location/get failed: ${data.status}`);
  return (data.locations || []).map((l: any) => ({
    username: l.username || l.name || "",
    displayName: l.display_name || l.username || "",
    latitude: parseFloat(l.latitude) || 0,
    longitude: parseFloat(l.longitude) || 0,
    speed: (parseFloat(l.speed) || 0) * 3.6, // m/s to km/h
    heading: parseFloat(l.heading) || 0,
    altitude: parseFloat(l.altitude) || 0,
    batteryLevel: parseInt(l.battery_level, 10) || 0,
    chargingStatus: parseInt(l.charging_status, 10) || 0,
    signalStrength: parseInt(l.signal_strength, 10) || 0,
    accuracy: parseFloat(l.accuracy) || 0,
    status: l.status || "unknown",
    lastReport: parseInt(l.last_report, 10) || 0,
    lastReportDelay: parseInt(l.last_report_delay, 10) || 0,
  }));
}

/** Get location history for a specific user */
export async function getZelloUserHistory(
  username: string,
  startTs: number,
  endTs: number
): Promise<any> {
  if (!isZelloConfigured()) return { locations: [] };
  const data = await zelloGet(`location/getuser/${encodeURIComponent(username)}/history`, {
    start_ts: String(startTs),
    end_ts: String(endTs),
    format: "geojson",
    speedUnits: "kmh",
  });
  return data;
}

/** Get current location for a specific user */
export async function getZelloUserLocation(username: string): Promise<any> {
  if (!isZelloConfigured()) return { locations: [] };
  const data = await zelloGet(`location/getuser/${encodeURIComponent(username)}`);
  return data;
}

export interface ZelloShiftSummary {
  km: number;
  avgSpeed: number;
  maxSpeed: number;
  /** minutos SEM reports do Zello dentro do turno (gaps > 10 min + pontas) */
  offlineMinutes: number;
  /** minutos com o Zello a reportar */
  onlineMinutes: number;
  points: number;
}

/**
 * Resumo do turno de um condutor a partir do histórico GPS do Zello:
 * km percorridos, velocidades e tempo com o Zello desligado (sem reports).
 * Usado no check-out do ponto — melhor esforço, nunca deve rebentar o ponto.
 */
export async function summarizeZelloShift(
  username: string,
  start: Date,
  end: Date
): Promise<ZelloShiftSummary | null> {
  if (!isZelloConfigured()) return null;
  const startTs = Math.floor(start.getTime() / 1000);
  const endTs = Math.floor(end.getTime() / 1000);
  if (endTs <= startTs) return null;
  const shiftMinutes = Math.round((endTs - startTs) / 60);

  const data = await getZelloUserHistory(username, startTs, endTs);
  const features: any[] = Array.isArray(data?.features) ? data.features : [];

  // Extrai pontos (ts, speed, lat/lon) — mesmo parsing do job diário
  const pts: { ts: number; speed: number; lat: number | null; lon: number | null }[] = [];
  for (const f of features) {
    const p = f.properties || {};
    const ts = parseInt(p.timestamp || p.time || p.lastReport) || 0;
    if (ts <= 0) continue;
    const speed = (parseFloat(p.speed) || 0) * 3.6; // m/s → km/h
    let lat: number | null = null, lon: number | null = null;
    if (f.geometry?.type === "Point" && Array.isArray(f.geometry.coordinates)) {
      const [gLon, gLat] = f.geometry.coordinates;
      if (Number.isFinite(gLat) && Number.isFinite(gLon) && (gLat !== 0 || gLon !== 0)) {
        lat = gLat; lon = gLon;
      }
    }
    pts.push({ ts, speed, lat, lon });
  }
  pts.sort((a, b) => a.ts - b.ts);

  // Sem um único report durante o turno = Zello desligado o turno inteiro
  if (pts.length === 0) {
    return { km: 0, avgSpeed: 0, maxSpeed: 0, offlineMinutes: shiftMinutes, onlineMinutes: 0, points: 0 };
  }

  const haversine = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371, dLat = ((lat2 - lat1) * Math.PI) / 180, dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  // km e velocidades (mesmos filtros de ruído do job diário: gap < 1h,
  // salto < 2 km entre reports, velocidade implícita ≤ 150 km/h)
  let km = 0, maxSpeed = 0, speedSum = 0, speedCount = 0;
  const implicit: number[] = [];
  let lastFix: { ts: number; lat: number; lon: number } | null = null;
  for (const cur of pts) {
    if (cur.speed > 0 && cur.speed <= 150) { speedSum += cur.speed; speedCount++; if (cur.speed > maxSpeed) maxSpeed = cur.speed; }
    if (cur.lat != null && cur.lon != null) {
      if (lastFix) {
        const gapS = cur.ts - lastFix.ts;
        const segKm = haversine(lastFix.lat, lastFix.lon, cur.lat, cur.lon);
        if (gapS > 0 && gapS < 3600 && segKm < 2) {
          const implKmh = (segKm / gapS) * 3600;
          if (implKmh <= 150) { km += segKm; if (implKmh > 3) implicit.push(implKmh); }
        }
      }
      lastFix = { ts: cur.ts, lat: cur.lat, lon: cur.lon };
    }
  }
  if (speedCount === 0 && implicit.length > 0) {
    speedSum = implicit.reduce((s, v) => s + v, 0);
    speedCount = implicit.length;
    maxSpeed = Math.max(...implicit);
  }

  // Offline: gaps > 10 min entre reports consecutivos, mais as pontas
  // (entrada→1º report e último report→saída)
  const GAP_S = 10 * 60;
  let offlineS = 0;
  if (pts[0].ts - startTs > GAP_S) offlineS += pts[0].ts - startTs;
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i].ts - pts[i - 1].ts;
    if (dt > GAP_S) offlineS += dt;
  }
  if (endTs - pts[pts.length - 1].ts > GAP_S) offlineS += endTs - pts[pts.length - 1].ts;
  const offlineMinutes = Math.min(shiftMinutes, Math.round(offlineS / 60));

  return {
    km: Math.round(km * 100) / 100,
    avgSpeed: speedCount > 0 ? Math.round((speedSum / speedCount) * 100) / 100 : 0,
    maxSpeed: Math.round(maxSpeed * 100) / 100,
    offlineMinutes,
    onlineMinutes: Math.max(0, shiftMinutes - offlineMinutes),
    points: pts.length,
  };
}
