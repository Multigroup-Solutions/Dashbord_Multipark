/**
 * Tempos de entrega e de recolha (plano 62, P7) — as dependências REAIS do
 * trabalho `service-times` (server/serviceTimesJob.ts): a BD da Multipark (só
 * leitura, pela guarda), a nossa BD (chamadas, CRM, PDAs, Zellos fixos, a
 * tabela service_times e o estado em app_settings), os ficheiros GPS do Zello
 * (o GeoJSON guardado na recolha, COM a posição) e o resolvedor de identidade
 * da Avaliação. Os testes usam dependências falsas.
 *
 * Telefones: só em memória (para cruzar com as chamadas), nunca gravados.
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { SETTINGS, type SettingKey } from "../shared/appSettings";
import { crmIdOfContactRef, phone9Of, type CallRecord, type FixedZelloLike, type PdaCheckinLike } from "../shared/serviceTimes";
import type { GpsFix } from "../shared/serviceGps";
import { utcTextMs } from "./multiparkDb/serviceRows";
import {
  SERVICE_TIMES_ROW_COLUMNS, gpsFileKey,
  type ExistingRowMeta, type GpsFile, type ServiceSettings, type ServiceTimesDeps, type ServiceTimesRow, type ServiceTimesState,
} from "./serviceTimesJob";

export const SERVICE_TIMES_FLAG = "SERVICE_TIMES" as const;
/** Onde fica o estado do trabalho (versão, impressão digital, noite feita, blocos por fazer). */
export const SERVICE_TIMES_STATE_KEY = "serviceTimes._state";

const rowsOf = (r: unknown): any[] => { const x = Array.isArray(r) ? r[0] : (r as any)?.rows ?? r; return Array.isArray(x) ? x : []; };
const mysql = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** Interruptor "Tempos de entrega e de recolha (trabalho noturno)" — desligado por omissão. */
export async function serviceTimesEnabled(): Promise<boolean> {
  try {
    const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
    await ensureFeatureFlagOverrides();
    return isFeatureEnabled(SERVICE_TIMES_FLAG, { defaultEnabled: automationFlagDefault(SERVICE_TIMES_FLAG) });
  } catch {
    return false;
  }
}

async function loadSettings(): Promise<ServiceSettings> {
  const { getSetting } = await import("./appSettings");
  const v = async <K extends SettingKey>(k: K) => ((await getSetting(k)) ?? SETTINGS[k].defaultValue) as any;
  return {
    excludedParks: await v("operations.excludedParks"),
    airports: await v("ponto.terminalAirports"),
    parkZones: await v("operations.parkZones"),
    garageRoles: await v("operations.garageRoles"),
    targetMinutes: await v("serviceTimes.targetMinutes"),
    t2TargetMinutes: await v("serviceTimes.pickupT2TargetMinutes"),
    since: await v("serviceTimes.since"),
    gpsSince: await v("serviceTimes.gpsSince"),
    useCalls: await v("serviceTimes.useCalls"),
  };
}

// ─── A nossa BD ─────────────────────────────────────────────────────────────

async function calls(fromMs: number, toMs: number): Promise<CallRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const out: CallRecord[] = [];
  try {
    for (const r of rowsOf(await db.execute(sql`SELECT startedAt, held, phone, contactRef FROM central_calls
        WHERE direction = 'in' AND startedAt >= ${mysql(fromMs)} AND startedAt < ${mysql(toMs)} LIMIT 50000`))) {
      const at = utcTextMs(r.startedAt);
      if (at != null) out.push({ at, source: "central", held: Number(r.held) === 1, phone9: phone9Of(r.phone), crmClientId: crmIdOfContactRef(r.contactRef) });
    }
  } catch { /* tabela da central por criar */ }
  try {
    for (const r of rowsOf(await db.execute(sql`SELECT startedAt, missed, phoneE164 FROM whatsapp_calls
        WHERE direction = 'in' AND startedAt >= ${mysql(fromMs)} AND startedAt < ${mysql(toMs)} LIMIT 50000`))) {
      const at = utcTextMs(r.startedAt);
      if (at != null) out.push({ at, source: "whatsapp", held: Number(r.missed) !== 1, phone9: phone9Of(r.phoneE164), crmClientId: null });
    }
  } catch { /* sem chamadas do WhatsApp */ }
  return out.sort((a, b) => a.at - b.at);
}

async function crmLinks(bookingIds: string[]): Promise<Map<string, { phones: string[]; crmIds: number[] }>> {
  const out = new Map<string, { phones: string[]; crmIds: number[] }>();
  const db = await getDb();
  if (!db || !bookingIds.length) return out;
  for (let i = 0; i < bookingIds.length; i += 500) {
    const part = bookingIds.slice(i, i + 500);
    try {
      for (const r of rowsOf(await db.execute(sql`SELECT l.bookingExternalId AS b, l.clientId AS c, p.phone AS phone
          FROM crm_booking_links l LEFT JOIN crm_client_phones p ON p.clientId = l.clientId
         WHERE l.bookingExternalId IN (${sql.join(part.map((x) => sql`${x}`), sql`, `)})`))) {
        const k = String(r.b ?? "");
        if (!k) continue;
        const e = out.get(k) ?? { phones: [], crmIds: [] };
        const c = Number(r.c), p9 = phone9Of(r.phone);
        if (Number.isFinite(c) && !e.crmIds.includes(c)) e.crmIds.push(c);
        if (p9 && !e.phones.includes(p9)) e.phones.push(p9);
        out.set(k, e);
      }
    } catch { /* CRM por criar */ }
  }
  return out;
}

async function pdaCheckins(fromMs: number, toMs: number): Promise<PdaCheckinLike[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    return rowsOf(await db.execute(sql`SELECT COALESCE(NULLIF(c.zelloUsername, ''), NULLIF(p.zelloUsername, '')) AS zello, c.employeeId, c.checkinAt, c.checkoutAt
        FROM pda_checkins c LEFT JOIN pdas p ON p.id = c.pdaId
       WHERE c.employeeId IS NOT NULL AND COALESCE(NULLIF(c.zelloUsername, ''), NULLIF(p.zelloUsername, '')) IS NOT NULL
         AND c.checkinAt < ${mysql(toMs)} AND (c.checkoutAt IS NULL OR c.checkoutAt >= ${mysql(fromMs)})
       ORDER BY c.checkinAt, c.id`))
      .map((r) => ({ employeeId: Number(r.employeeId), zello: String(r.zello), start: utcTextMs(r.checkinAt) ?? 0, end: utcTextMs(r.checkoutAt) }))
      .filter((c) => c.start > 0);
  } catch {
    return [];
  }
}

async function fixedZellos(): Promise<FixedZelloLike[]> {
  const db = await getDb();
  if (!db) return [];
  return rowsOf(await db.execute(sql`SELECT id, zelloUsername, isActive FROM employees WHERE zelloUsername IS NOT NULL AND zelloUsername <> ''`))
    .map((r) => ({ employeeId: Number(r.id), zello: String(r.zelloUsername), active: Number(r.isActive) === 1 }));
}

// ─── GPS: o GeoJSON de cada (Zello, dia de Lisboa), com a posição ───────────

async function pool<T>(items: readonly T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const run = async () => { while (i < items.length) { const x = items[i++]; await fn(x); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

export async function loadGps(requests: Array<{ zello: string; day: string }>, o: { deadlineAt: number }): Promise<Map<string, GpsFile>> {
  const out = new Map<string, GpsFile>();
  const db = await getDb();
  if (!db || !requests.length) return out;
  const days = [...new Set(requests.map((r) => r.day))];
  const zellos = [...new Set(requests.map((r) => r.zello.trim().toLowerCase()))];
  const rows = new Map<string, { url: string | null; pass: "sameday" | "final" }>();
  for (const r of rowsOf(await db.execute(sql`SELECT LOWER(zelloUsername) AS z, DATE_FORMAT(date, '%Y-%m-%d') AS d, geoJsonUrl, collectionPass
      FROM daily_driver_history
     WHERE DATE(date) IN (${sql.join(days.map((d) => sql`${d}`), sql`, `)})
       AND LOWER(zelloUsername) IN (${sql.join(zellos.map((z) => sql`${z}`), sql`, `)})
     ORDER BY id`))) {
    const k = gpsFileKey(String(r.z), String(r.d));
    if (!rows.has(k)) rows.set(k, { url: r.geoJsonUrl ? String(r.geoJsonUrl) : null, pass: String(r.collectionPass ?? "final") === "sameday" ? "sameday" : "final" });
  }
  const [{ storageReadableUrl }, { gpsPointsFromGeoJson }] = await Promise.all([import("./storageSign"), import("./zelloGps")]);
  await pool(requests, 6, async (req) => {
    const k = gpsFileKey(req.zello, req.day);
    if (out.has(k)) return;
    const row = rows.get(k);
    if (!row?.url) { out.set(k, { status: "missing" }); return; }
    if (Date.now() > o.deadlineAt - 1_000) { out.set(k, { status: "failed", reason: "prazo" }); return; }
    try {
      const res = await fetch(await storageReadableUrl(row.url), { signal: AbortSignal.timeout(Math.max(1_000, Math.min(15_000, o.deadlineAt - Date.now()))) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const points: GpsFix[] = gpsPointsFromGeoJson(await res.json()).map((p) => ({ ts: p.ts, speed: p.speed, lat: p.lat, lon: p.lon, accurate: p.accurate }));
      out.set(k, { status: "ok", pass: row.pass, points });
    } catch (err) {
      console.warn(`[tempos] GPS ${req.zello} ${req.day}:`, String((err as Error)?.message ?? err).slice(0, 120));
      out.set(k, { status: "failed" });
    }
  });
  return out;
}

// ─── A tabela service_times e o estado ──────────────────────────────────────

const KEY_COLUMNS = new Set(["kind", "bookingId", "anchorHistoryId"]);

async function loadState(): Promise<ServiceTimesState | null> {
  const db = await getDb();
  if (!db) return null;
  const { parseJsonValue } = await import("./appSettings");
  const r = rowsOf(await db.execute(sql`SELECT \`value\` FROM app_settings WHERE settingKey = ${SERVICE_TIMES_STATE_KEY} LIMIT 1`))[0];
  const v = r ? parseJsonValue(r.value) as ServiceTimesState | null : null;
  return v && typeof v === "object" && Number.isFinite(v.v) && typeof v.h === "string" && Array.isArray(v.todo) ? v : null;
}

async function saveState(s: ServiceTimesState): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  await db.execute(sql`INSERT INTO app_settings (settingKey, \`value\`) VALUES (${SERVICE_TIMES_STATE_KEY}, ${JSON.stringify(s)})
    ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`)`);
}

async function existing(fromUtc: string, toUtc: string): Promise<ExistingRowMeta[]> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  return rowsOf(await db.execute(sql`SELECT id, kind, bookingId, anchorHistoryId, gpsPass, calcVersion, paramsHash, voidedAt
      FROM service_times WHERE anchorAt >= ${fromUtc} AND anchorAt < ${toUtc}`))
    .map((r) => ({ id: Number(r.id), kind: String(r.kind), bookingId: String(r.bookingId), anchorHistoryId: String(r.anchorHistoryId), gpsPass: String(r.gpsPass), calcVersion: Number(r.calcVersion), paramsHash: String(r.paramsHash), voided: r.voidedAt != null }));
}

async function upsert(rows: ServiceTimesRow[]): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  const cols = SERVICE_TIMES_ROW_COLUMNS;
  const colList = sql.raw(cols.map((c) => `\`${c}\``).join(", "));
  const updates = sql.raw(cols.filter((c) => !KEY_COLUMNS.has(c)).map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(", "));
  for (let i = 0; i < rows.length; i += 100) {
    const part = rows.slice(i, i + 100);
    const values = sql.join(part.map((r) => sql`(${sql.join(cols.map((c) => sql`${(r as any)[c] ?? null}`), sql`, `)})`), sql`, `);
    await db.execute(sql`INSERT INTO service_times (${colList}) VALUES ${values} ON DUPLICATE KEY UPDATE ${updates}`);
  }
}

async function voidRows(ids: number[], atUtc: string): Promise<void> {
  const db = await getDb();
  if (!db || !ids.length) return;
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    await db.execute(sql`UPDATE service_times SET voidedAt = ${atUtc} WHERE voidedAt IS NULL AND id IN (${sql.join(part.map((x) => sql`${x}`), sql`, `)})`);
  }
}

/** As dependências reais do trabalho. */
export async function realServiceTimesDeps(): Promise<ServiceTimesDeps> {
  const [{ multiparkDbQuery }, { loadEvaluationIdentity }] = await Promise.all([import("./multiparkDb/client"), import("./evaluationIdentity")]);
  return {
    query: (q, params, opts) => multiparkDbQuery(q, params ?? [], opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : undefined),
    now: () => Date.now(),
    settings: loadSettings,
    ourDb: { calls, crmLinks, pdaCheckins, fixedZellos },
    loadGps,
    identity: async () => {
      const { identity } = await loadEvaluationIdentity();
      return { agent: (userId, name) => { const r = identity.agent(userId, name); return { kind: r.kind, employeeId: r.kind === "colaborador" ? r.employeeId : null }; } };
    },
    store: { loadState, saveState, existing, upsert, voidRows },
  };
}
