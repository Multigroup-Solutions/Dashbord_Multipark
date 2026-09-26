/**
 * Daily Driver Data Collection Job
 *
 * Corre no trabalho diário `daily-ops` do agendador (/api/cron/tick, a partir
 * das 04:30 de Lisboa). Recolhe o histórico GPS do Zello de D-2 (Lisboa): o
 * Zello só disponibiliza um dia depois da meia-noite do dia a seguir ao
 * seguinte. Recupera também os dias dos últimos 7 (até D-2) que ficaram
 * incompletos (incompleteCollectionDays), o mais antigo primeiro.
 *
 * For each Zello user, it:
 * 1. Fetches location history for the target day
 * 2. Calculates km driven, hours worked, idle time, speeds
 * 3. Records battery levels
 * 4. Counts speed violations
 * 5. Stores a GeoJSON route in S3
 * 6. Creates a daily_driver_history record
 * 
 * Also checks for GPS/Zello disabled alerts.
 */

import { getZelloUsers, getZelloUserHistory, getZelloLocations } from "../zello";
import {
  createDailyDriverHistory,
  createGpsAlert,
  getDefaultSpeedLimit,
} from "../db";
import { storagePut } from "../storage";
import { MAX_PLAUSIBLE_KMH, MIN_IMPLICIT_GAP_S, STOPPED_SPEED_KMH, gpsPointsFromGeoJson, splitByHolder, zelloAccuracyOk, zelloBattery, zelloSpeedKmh, zelloTimestamp } from "../zelloGps";
import { addDays, lisbonDayOf, lisbonDayRangeUtc, zelloLatestDay } from "../../shared/lisbonDay";

/** Calculate distance between two GPS points using Haversine formula */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/** Process GeoJSON history data from Zello into driver metrics */
function processGeoJsonHistory(data: any): {
  totalKm: number;
  hoursWorked: number;
  hoursStopped: number;
  totalHoursOnline: number;
  avgSpeed: number;
  maxSpeed: number;
  avgBattery: number;
  minBattery: number;
  gpsPointsCount: number;
  geojson: any;
} {
  const defaultResult = {
    totalKm: 0,
    hoursWorked: 0,
    hoursStopped: 0,
    totalHoursOnline: 0,
    avgSpeed: 0,
    maxSpeed: 0,
    avgBattery: 0,
    minBattery: 100,
    gpsPointsCount: 0,
    geojson: null,
  };

  // Zello returns GeoJSON FeatureCollection
  if (!data || !data.features || !Array.isArray(data.features)) {
    return defaultResult;
  }

  let totalKm = 0;
  let maxSpeed = 0;
  let speedSum = 0;
  let speedCount = 0;
  let batterySum = 0;
  let batteryCount = 0;
  let minBattery = 100;
  let gpsPointsCount = 0;
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;
  let movingSeconds = 0;
  let stoppedSeconds = 0;

  const STOPPED_SPEED_THRESHOLD = STOPPED_SPEED_KMH; // km/h — abaixo disto está parado

  // Process each feature (typically LineString or Point)
  for (const feature of data.features) {
    if (!feature.geometry) continue;

    if (feature.geometry.type === "Point") {
      gpsPointsCount++;
      const props = feature.properties || {};
      // O Zello já devolve km/h (ver server/zelloGps.ts — antes multiplicava-se por 3,6)
      const speed = zelloSpeedKmh(props);
      const battery = zelloBattery(props);
      const ts = zelloTimestamp(props);
      const accurate = zelloAccuracyOk(props);

      // Filter GPS noise (>150 km/h is unrealistic for parking drivers) e pontos imprecisos
      if (accurate && speed > 0 && speed <= MAX_PLAUSIBLE_KMH) {
        speedSum += speed;
        speedCount++;
        if (speed > maxSpeed) maxSpeed = speed;
      }
      if (battery > 0) {
        batterySum += battery;
        batteryCount++;
        if (battery < minBattery) minBattery = battery;
      }
      if (ts > 0) {
        if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts;
        if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
      }
    }

    if (feature.geometry.type === "LineString" && feature.geometry.coordinates) {
      const coords = feature.geometry.coordinates;
      for (let i = 1; i < coords.length; i++) {
        const [lon1, lat1] = coords[i - 1];
        const [lon2, lat2] = coords[i];
        const segmentKm = haversineKm(lat1, lon1, lat2, lon2);
        // Filter out GPS jumps (>50km between consecutive points)
        if (segmentKm < 50) {
          totalKm += segmentKm;
        }
        gpsPointsCount++;
      }
    }
  }

  // Also check for properties on features with timestamps to calculate moving vs stopped
  // FIX 2026-08-06 (bug dos km a zero desde março): o Zello devolve PONTOS
  // soltos, não LineStrings — o cálculo de km acima nunca corria. Agora
  // guardamos também lat/lon por timestamp e somamos a distância entre pontos
  // consecutivos, com filtros de ruído: gap < 1h, salto < 2km entre reports,
  // e velocidade implícita ≤ 150 km/h.
  const timestamps: { ts: number; speed: number; lat: number | null; lon: number | null }[] = [];
  for (const feature of data.features) {
    const props = feature.properties || {};
    const ts = zelloTimestamp(props);
    const speed = zelloSpeedKmh(props);
    let lat: number | null = null, lon: number | null = null;
    if (feature.geometry?.type === "Point" && Array.isArray(feature.geometry.coordinates) && zelloAccuracyOk(props)) {
      const [gLon, gLat] = feature.geometry.coordinates;
      if (Number.isFinite(gLat) && Number.isFinite(gLon) && (gLat !== 0 || gLon !== 0)) {
        lat = gLat; lon = gLon;
      }
    }
    if (ts > 0) {
      timestamps.push({ ts, speed, lat, lon });
    }
  }
  timestamps.sort((a, b) => a.ts - b.ts);

  let pointsKm = 0;
  const implicitSpeeds: number[] = [];
  let lastFix: { ts: number; lat: number; lon: number } | null = null;
  for (let i = 1; i < timestamps.length; i++) {
    const dt = timestamps[i].ts - timestamps[i - 1].ts;
    if (dt > 0 && dt < 3600) {
      // Only count intervals < 1 hour (skip big gaps)
      if (timestamps[i - 1].speed > STOPPED_SPEED_THRESHOLD) {
        movingSeconds += dt;
      } else {
        stoppedSeconds += dt;
      }
    }
    const cur = timestamps[i];
    if (cur.lat != null && cur.lon != null) {
      if (lastFix) {
        const gapS = cur.ts - lastFix.ts;
        const segKm = haversineKm(lastFix.lat, lastFix.lon, cur.lat, cur.lon);
        // filtros de ruído: gaps longos e saltos GPS não contam
        if (gapS > 0 && gapS < 3600 && segKm < 2) {
          const implKmh = (segKm / gapS) * 3600;
          if (implKmh <= MAX_PLAUSIBLE_KMH) {
            pointsKm += segKm;
            // parado não conta; intervalos muito curtos amplificam o "tremer" do GPS
            if (implKmh > 3 && gapS >= MIN_IMPLICIT_GAP_S) implicitSpeeds.push(implKmh);
          }
        }
      }
      lastFix = { ts: cur.ts, lat: cur.lat, lon: cur.lon };
    }
  }
  // LineStrings (se algum dia voltarem) têm prioridade; senão usa os pontos
  if (totalKm === 0 && pointsKm > 0) totalKm = pointsKm;

  // Velocidades: se os reports não trazem speed, usa a implícita dos segmentos
  if (speedCount === 0 && implicitSpeeds.length > 0) {
    speedSum = implicitSpeeds.reduce((s, v) => s + v, 0);
    speedCount = implicitSpeeds.length;
    const implMax = Math.max(...implicitSpeeds);
    if (implMax > maxSpeed) maxSpeed = implMax;
  }

  const totalOnlineSeconds = firstTimestamp && lastTimestamp ? lastTimestamp - firstTimestamp : 0;

  return {
    totalKm: Math.round(totalKm * 100) / 100,
    hoursWorked: Math.round((movingSeconds / 3600) * 100) / 100,
    hoursStopped: Math.round((stoppedSeconds / 3600) * 100) / 100,
    totalHoursOnline: Math.round((totalOnlineSeconds / 3600) * 100) / 100,
    avgSpeed: speedCount > 0 ? Math.round((speedSum / speedCount) * 100) / 100 : 0,
    maxSpeed: Math.round(maxSpeed * 100) / 100,
    avgBattery: batteryCount > 0 ? Math.round(batterySum / batteryCount) : 0,
    minBattery: batteryCount > 0 ? minBattery : 0,
    gpsPointsCount: gpsPointsCount || timestamps.length,
    geojson: data,
  };
}

export { processGeoJsonHistory };

/**
 * Versão das métricas GPS. 2 = velocidades em km/h (sem o ×3,6), filtro de
 * precisão e funcionário resolvido. Linhas antigas (1) são apagadas
 * (purgeLegacyDriverHistory).
 */
// 3 = + GPS partido por quem tinha o PDA (Fase 3)
// 4 = partes com minutos em movimento (0086) e dias de Lisboa nos intervalos do PDA
export const DRIVER_METRICS_VERSION = 4;

/** Excessos de velocidade num GeoJSON do Zello (já em km/h). */
export function countSpeedViolations(data: any, threshold: number): number {
  let n = 0;
  for (const f of data?.features ?? []) {
    if (!zelloAccuracyOk(f.properties)) continue;
    const v = zelloSpeedKmh(f.properties);
    if (v > threshold && v <= MAX_PLAUSIBLE_KMH) n++;
  }
  return n;
}

/**
 * Linhas GPS antigas por corrigir = v1 (`metricsVersion < 2`): velocidades
 * gravadas ×3,6 e sem funcionário. Decisão do Jorge (26 set 2026): em vez de
 * as recalcular (a antiga "Fase 0"), APAGAM-SE — com as partes por pessoa
 * delas (driver_day_shares, ligadas pelo `historyId`). Nunca toca em linhas
 * já recalculadas nem gravadas depois da correção da velocidade (v ≥ 2).
 * Os alertas GPS e de velocidade não têm ligação à linha (só nome Zello e
 * hora) e ficam. Em lotes (DELETE … WHERE id IN, com prazo); quando não
 * houver mais nenhuma, é um no-op.
 */
export const LEGACY_GPS_PREDICATE = "metricsVersion < 2";

export async function purgeLegacyDriverHistory(opts: { deadlineAt: number; batch?: number }): Promise<{ deleted: number; sharesDeleted: number; done: boolean }> {
  const { getDb } = await import("../db");
  const { sql } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) return { deleted: 0, sharesDeleted: 0, done: true };
  const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r) as any[]) ?? [];
  const affected = (r: any): number => Number((Array.isArray(r) ? r[0] : r)?.affectedRows ?? 0);
  let deleted = 0;
  let sharesDeleted = 0;
  for (;;) {
    if (Date.now() > opts.deadlineAt) return { deleted, sharesDeleted, done: false };
    const ids = rowsOf(await db.execute(sql`SELECT id FROM daily_driver_history WHERE metricsVersion < 2 ORDER BY id LIMIT ${opts.batch ?? 500}`)).map((r) => Number(r.id));
    if (!ids.length) return { deleted, sharesDeleted, done: true };
    const list = sql.join(ids.map((id) => sql`${id}`), sql`, `);
    sharesDeleted += affected(await db.execute(sql`DELETE FROM driver_day_shares WHERE historyId IN (${list})`));
    deleted += affected(await db.execute(sql`DELETE FROM daily_driver_history WHERE id IN (${list}) AND metricsVersion < 2`));
  }
}

/**
 * "Forçar re-divisão": volta a partir o GPS JÁ recolhido de um dia por quem
 * tinha cada PDA — para depois de corrigir check-ins de PDA. Só refaz as
 * partes (driver_day_shares) e o funcionário da linha; os km/velocidades da
 * linha não mudam (já estão em km/h — nada de ×3,6 outra vez). Retomável por
 * `afterId` (id da última linha feita) e com prazo.
 */
export async function resplitDriverDay(day: string, opts: { deadlineAt: number; afterId?: number }): Promise<{ processed: number; done: boolean; nextAfterId: number | null; errors: string[] }> {
  const { getDb, resolveZelloHoldersForDay, pdaIntervalsForDay, saveDriverShares } = await import("../db");
  const { sql } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) return { processed: 0, done: true, nextAfterId: null, errors: ["BD indisponível"] };
  const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r) as any[]) ?? [];
  const speedLimit = await getDefaultSpeedLimit();
  const threshold = speedLimit ? speedLimit.maxSpeed * (1 + speedLimit.tolerancePercent / 100) : 999;
  const [holders, intervals] = await Promise.all([resolveZelloHoldersForDay(day), pdaIntervalsForDay(day)]);
  const rows = rowsOf(await db.execute(sql`
    SELECT id, zelloUsername, geoJsonUrl FROM daily_driver_history
     WHERE DATE(date) = ${day} AND id > ${opts.afterId ?? 0} ORDER BY id`));
  const errors: string[] = [];
  let processed = 0;
  let last: number | null = null;
  for (const r of rows) {
    if (Date.now() > opts.deadlineAt) return { processed, done: false, nextAfterId: last, errors };
    const zello = String(r.zelloUsername);
    try {
      const zi = intervals.get(zello) ?? [];
      if (r.geoJsonUrl && zi.length) {
        const resp = await fetch(String(r.geoJsonUrl));
        if (!resp.ok) throw new Error(`GeoJSON HTTP ${resp.status}`);
        const data = await resp.json();
        await saveDriverShares(Number(r.id), zello, day, splitByHolder(gpsPointsFromGeoJson(data), zi, threshold));
      } else if (!zi.length) {
        await saveDriverShares(Number(r.id), zello, day, []); // já ninguém teve o PDA
      } // sem GeoJSON guardado não dá para partir de novo: ficam as partes que havia
      await db.execute(sql`UPDATE daily_driver_history SET employeeId = ${holders.get(zello) ?? null} WHERE id = ${r.id}`);
      processed++;
    } catch (err: any) {
      errors.push(`${zello}: ${String(err?.message ?? err).slice(0, 120)}`);
    }
    last = Number(r.id);
  }
  return { processed, done: true, nextAfterId: null, errors };
}

/**
 * Passagens da recolha GPS: o Zello dá o dia de HOJE durante o próprio dia,
 * deixa de o dar à meia-noite e só o volta a dar ~2 dias depois (D-2).
 *  - 'sameday': provisória, 23:15–23:55 de Lisboa (trabalho zello-sameday);
 *  - 'final': D-2 às 04:30 (daily-ops) — completa (turnos depois da
 *    meia-noite incluídos) e SUBSTITUI a provisória na mesma linha.
 */
export type CollectionPass = "sameday" | "final";

export interface ExistingDriverRow { id: number; pass: string; collectedAtMs: number | null }

/**
 * Condutores a (re)recolher numa passagem. PURA.
 *  - final: sem linha, ou com linha provisória (a final substitui-a);
 *  - sameday: sem linha, ou provisória recolhida ANTES desta passagem
 *    (`passStartedAt`) — as feitas nesta passagem ficam (retoma entre ticks);
 *    uma linha final nunca é tocada.
 */
export function usersToCollect(users: readonly string[], existing: ReadonlyMap<string, ExistingDriverRow>, pass: CollectionPass, passStartedAt: number): string[] {
  return users.filter((u) => {
    const row = existing.get(u);
    if (!row) return true;
    if (row.pass === "final") return false;
    if (pass === "final") return true;
    return row.collectedAtMs == null || row.collectedAtMs < passStartedAt;
  });
}

/** Que passagem serve para um dia (Lisboa): hoje → provisória; até D-2 → final; ontem → nenhuma. PURA. */
export function passForDay(day: string, nowMs: number): CollectionPass | null {
  if (day === lisbonDayOf(nowMs)) return "sameday";
  return day <= zelloLatestDay(nowMs) ? "final" : null;
}

/**
 * Recolhe o GPS de um dia (Lisboa; `targetDate` = meio-dia UTC desse dia).
 *
 * RETOMÁVEL: processa só os condutores em falta nesta passagem
 * (usersToCollect) e para no `deadlineAt` (o Vercel corta aos 60 s).
 * Devolve `done:false` quando ficou trabalho por fazer — o chamador volta a
 * chamar até `done:true`. Uma linha existente é ATUALIZADA (nunca duplica);
 * o alerta "GPS desligado" é criado uma só vez por condutor e dia; o resumo
 * "Relatório Diário de Motoristas" só sai na passagem final.
 */
export async function collectDailyDriverData(targetDate: Date, opts?: { deadlineAt?: number; pass?: CollectionPass; passStartedAt?: number }): Promise<{
  success: boolean;
  driversProcessed: number;
  errors: string[];
  done: boolean;
}> {
  const errors: string[] = [];
  let driversProcessed = 0;
  const deadlineAt = opts?.deadlineAt ?? Number.POSITIVE_INFINITY;

  try {
    const dateStr = lisbonDayOf(targetDate);
    // Ontem (D-1) o Zello já não dá e ainda não voltou a dar: recolher dava
    // linhas VAZIAS (0 km) — nunca. Hoje → provisória; até D-2 → final.
    const pass = opts?.pass ?? passForDay(dateStr, Date.now());
    if (!pass || passForDay(dateStr, Date.now()) !== pass) {
      return { success: false, driversProcessed: 0, errors: [`O Zello não disponibiliza agora o histórico de ${dateStr} (só o dia de hoje até à meia-noite, e os dias até ${zelloLatestDay(Date.now())}).`], done: true };
    }
    // Uma passagem provisória "começa" 15 min antes (chamadas repetidas do
    // botão ou do agendador não voltam a buscar quem já foi feito).
    const passStartedAt = opts?.passStartedAt ?? Date.now() - 15 * 60_000;
    const existing = await existingRowsForDay(dateStr);

    // Get all Zello users
    const users = await getZelloUsers();
    const allNonAdmin = users.filter(u => !u.admin);
    const todo = new Set(usersToCollect(allNonAdmin.map((u) => u.name), existing, pass, passStartedAt));
    const nonAdminUsers = allNonAdmin.filter((u) => todo.has(u.name));
    if (allNonAdmin.length > 0 && nonAdminUsers.length === 0) {
      console.log(`[DailyCollection] ${dateStr} (${pass}) já completo (${existing.size} registos).`);
      return { success: true, driversProcessed: 0, errors: [], done: true };
    }
    if (existing.size > 0) console.log(`[DailyCollection] ${dateStr} (${pass}): faltam ${nonAdminUsers.length} de ${allNonAdmin.length}.`);

    // Janela do dia de Lisboa (meia-noite a meia-noite, com a mudança de hora)
    const win = lisbonDayRangeUtc(dateStr);
    const startTs = Math.floor(win.startMs / 1000);
    const endTs = Math.min(Math.floor(win.endMs / 1000), Math.floor(Date.now() / 1000)) - 1;

    // Quem tinha cada Zello nesse dia (PDA partilhado → quem o teve mais tempo)
    const { resolveZelloHoldersForDay, pdaIntervalsForDay, saveDriverShares } = await import("../db");
    const holders = await resolveZelloHoldersForDay(dateStr);
    // Fase 3: intervalos de cada pessoa em cada PDA → GPS partido por pessoa
    const intervals = await pdaIntervalsForDay(dateStr);

    // Get speed limit for violation counting
    const speedLimit = await getDefaultSpeedLimit();
    const threshold = speedLimit
      ? speedLimit.maxSpeed * (1 + speedLimit.tolerancePercent / 100)
      : 999;

    console.log(`[DailyCollection] Processing ${nonAdminUsers.length} users for ${dateStr} (${pass})`);

    let stoppedAtDeadline = false;
    for (const user of nonAdminUsers) {
      if (Date.now() > deadlineAt) { stoppedAtDeadline = true; break; }
      try {
        // Fetch history from Zello
        const historyData = await getZelloUserHistory(user.name, startTs, endTs);
        const metrics = processGeoJsonHistory(historyData);
        const violations = countSpeedViolations(historyData, threshold);

        // Store GeoJSON in S3 if we have data (a final substitui a provisória)
        let geoJsonUrl: string | null = null;
        if (metrics.gpsPointsCount > 0 && metrics.geojson) {
          try {
            const key = `driver-history/${dateStr}/${user.name}.geojson`;
            const result = await storagePut(
              key,
              JSON.stringify(metrics.geojson),
              "application/geo+json"
            );
            geoJsonUrl = result.url;
          } catch (e) {
            // Non-critical — continue without S3
            console.warn(`[DailyCollection] Failed to upload GeoJSON for ${user.name}:`, e);
          }
        }

        const row = {
          zelloUsername: user.name,
          displayName: user.fullName || user.name,
          // Antes ficava sempre vazio → km/horas soltos na Atividade do Dia
          employeeId: holders.get(user.name) ?? null,
          metricsVersion: DRIVER_METRICS_VERSION,
          date: `${dateStr} 00:00:00`,
          totalKm: String(metrics.totalKm),
          hoursWorked: String(metrics.hoursWorked),
          hoursStopped: String(metrics.hoursStopped),
          totalHoursOnline: String(metrics.totalHoursOnline),
          avgSpeed: String(metrics.avgSpeed),
          maxSpeed: String(metrics.maxSpeed),
          speedViolations: violations,
          avgBattery: metrics.avgBattery,
          minBattery: metrics.minBattery,
          gpsPointsCount: metrics.gpsPointsCount,
          geoJsonUrl,
          collectionPass: pass,
          collectedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
        };
        // Linha já existente (provisória) → atualiza a MESMA linha; senão cria.
        const prev = existing.get(user.name);
        const historyId = prev ? (await updateDriverHistoryRow(prev.id, row), prev.id) : await createDailyDriverHistory(row);

        const zIntervals = intervals.get(user.name);
        if (historyId) {
          try {
            // Substitui as partes (DELETE + INSERT por historyId): sem PDA partilhado, nenhuma.
            if (zIntervals?.length && historyData?.features) await saveDriverShares(Number(historyId), user.name, dateStr, splitByHolder(gpsPointsFromGeoJson(historyData), zIntervals, threshold));
            else if (prev) await saveDriverShares(Number(historyId), user.name, dateStr, []);
          } catch (err) { console.warn(`[DailyCollection] partes do GPS ${user.name}:`, err); }
        }

        driversProcessed++;

        // GPS desligado: um alerta por condutor e dia (as duas passagens não o repetem)
        if (user.geotrackingOff && !(await hasGpsAlert(user.name, "gps_off", win.start))) {
          await createGpsAlert({
            zelloUsername: user.name,
            displayName: user.fullName || user.name,
            alertType: "gps_off",
            message: `${user.fullName || user.name} tinha o GPS desligado em ${dateStr}`,
            notificationSent: 1,
            occurredAt: win.start,
          });
        }
      } catch (userError: any) {
        errors.push(`${user.name}: ${userError.message}`);
        console.error(`[DailyCollection] Error processing ${user.name}:`, userError);
      }
    }

    const done = !stoppedAtDeadline;
    console.log(`[DailyCollection] ${done ? "Completed" : "Partial (deadline)"}: ${driversProcessed}/${nonAdminUsers.length} users processed for ${dateStr} (${pass})`);

    // Resumo só na passagem final e quando termina (não duplica em corridas parciais)
    if (pass === "final" && done && driversProcessed > 0) {
      const { notify } = await import("../notify");
      await notify({
        kind: "driver_daily_report",
        title: "Relatório Diário de Motoristas",
        body: `Recolha automática para ${dateStr}: ${allNonAdmin.length - nonAdminUsers.length + driversProcessed} motoristas processados${errors.length > 0 ? `, ${errors.length} erros` : ""}`,
        link: "/operacional", entity: { type: "driver_daily_report", id: dateStr },
      });
    }

    return { success: true, driversProcessed, errors, done };
  } catch (error: any) {
    console.error("[DailyCollection] Fatal error:", error);
    errors.push(`Fatal: ${error.message}`);
    return { success: false, driversProcessed, errors, done: false };
  }
}

/** Linhas já gravadas de um dia (por nome Zello), com a passagem e a hora da recolha. */
async function existingRowsForDay(day: string): Promise<Map<string, ExistingDriverRow>> {
  const { getDb } = await import("../db");
  const { sql } = await import("drizzle-orm");
  const db = await getDb();
  const out = new Map<string, ExistingDriverRow>();
  if (!db) return out;
  const res = await db.execute(sql`
    SELECT id, zelloUsername, collectionPass, DATE_FORMAT(collectedAt, '%Y-%m-%d %H:%i:%s') AS collectedAt
      FROM daily_driver_history WHERE DATE(date) = ${day} ORDER BY id`);
  const rows = ((Array.isArray(res) ? res[0] : res) as unknown as any[]) ?? [];
  for (const r of rows) {
    const at = r.collectedAt ? Date.parse(`${String(r.collectedAt).replace(" ", "T")}Z`) : NaN;
    // Duplicados antigos (se os houver): fica a 1.ª linha.
    if (!out.has(String(r.zelloUsername))) out.set(String(r.zelloUsername), { id: Number(r.id), pass: String(r.collectionPass ?? "final"), collectedAtMs: Number.isFinite(at) ? at : null });
  }
  return out;
}

async function updateDriverHistoryRow(id: number, row: Record<string, unknown>): Promise<void> {
  const { getDb } = await import("../db");
  const { eq } = await import("drizzle-orm");
  const { dailyDriverHistory } = await import("../../drizzle/schema");
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(dailyDriverHistory).set(row as any).where(eq(dailyDriverHistory.id, id));
}

/** Já há um alerta deste tipo para o condutor nesse instante (início do dia)? */
async function hasGpsAlert(zello: string, type: string, occurredAt: string): Promise<boolean> {
  const { getDb } = await import("../db");
  const { sql } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) return false;
  const res = await db.execute(sql`SELECT id FROM gps_alerts WHERE zelloUsername = ${zello} AND alertType = ${type} AND occurredAt = ${occurredAt} LIMIT 1`);
  const rows = ((Array.isArray(res) ? res[0] : res) as unknown as any[]) ?? [];
  return rows.length > 0;
}

/**
 * Dias a recolher agora, o mais antigo primeiro: dos últimos `lookbackDays`
 * até `latestDay` (D-2), os que têm menos registos do que condutores Zello
 * (`expected`). Um dia sem nenhum registo conta sempre como em falta. PURA.
 */
export function pickIncompleteDays(latestDay: string, counts: ReadonlyMap<string, number>, expected: number, lookbackDays = 7): string[] {
  const out: string[] = [];
  for (let i = lookbackDays - 1; i >= 0; i--) {
    const day = addDays(latestDay, -i);
    const n = counts.get(day) ?? 0;
    if (n === 0 || n < expected) out.push(day);
  }
  return out;
}

/**
 * Dias incompletos dos últimos 7 (até D-2): conta os registos FINAIS por dia
 * (os provisórios não contam) e compara com os condutores Zello atuais (não admin). A recolha é por
 * condutor sem registo, por isso voltar a um dia só busca os que faltam.
 */
export async function incompleteCollectionDays(latestDay: string, lookbackDays = 7): Promise<string[]> {
  const { getDb } = await import("../db");
  const { sql } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) return [latestDay];
  const first = addDays(latestDay, -(lookbackDays - 1));
  const res = await db.execute(sql`
    SELECT DATE_FORMAT(date, '%Y-%m-%d') AS d, COUNT(*) AS n FROM daily_driver_history
     WHERE collectionPass = 'final' AND date >= ${`${first} 00:00:00`} AND date < ${`${addDays(latestDay, 1)} 00:00:00`}
     GROUP BY DATE_FORMAT(date, '%Y-%m-%d')`);
  const rows = ((Array.isArray(res) ? res[0] : res) as unknown as any[]) ?? [];
  const counts = new Map<string, number>(rows.map((r: any) => [String(r.d), Number(r.n)]));
  const expected = (await getZelloUsers()).filter((u) => !u.admin).length;
  return pickIncompleteDays(latestDay, counts, expected, lookbackDays);
}
