/**
 * Daily Driver Data Collection Job
 * 
 * Runs at 2:00 AM Lisbon time (Europe/Lisbon) every day.
 * Collects the PREVIOUS day's data from Zello GPS history.
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
  getDailyDriverHistoryByDate,
  getDefaultSpeedLimit,
} from "../db";
import { storagePut } from "../storage";
import { notifyOwner } from "../_core/notification";

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

  const STOPPED_SPEED_THRESHOLD = 2; // km/h — below this is "stopped"

  // Process each feature (typically LineString or Point)
  for (const feature of data.features) {
    if (!feature.geometry) continue;

    if (feature.geometry.type === "Point") {
      gpsPointsCount++;
      const props = feature.properties || {};
      const rawSpeed = parseFloat(props.speed) || 0;
      const speed = rawSpeed * 3.6; // Zello returns m/s, convert to km/h
      const battery = parseInt(props.battery_level || props.batteryLevel) || 0;
      const ts = parseInt(props.timestamp || props.time || props.lastReport) || 0;

      // Filter GPS noise (>150 km/h is unrealistic for parking drivers)
      if (speed > 0 && speed <= 150) {
        speedSum += speed;
        speedCount++;
      }
      if (speed > maxSpeed && speed <= 150) maxSpeed = speed;
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
  const timestamps: { ts: number; speed: number }[] = [];
  for (const feature of data.features) {
    const props = feature.properties || {};
    const ts = parseInt(props.timestamp || props.time || props.lastReport) || 0;
    const rawSpd = parseFloat(props.speed) || 0;
    const speed = rawSpd * 3.6; // m/s to km/h
    if (ts > 0) {
      timestamps.push({ ts, speed });
    }
  }
  timestamps.sort((a, b) => a.ts - b.ts);

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
    gpsPointsCount,
    geojson: data,
  };
}

/**
 * Run the daily collection for a specific date.
 *
 * RETOMÁVEL: processa só os condutores ainda SEM registo nesse dia e para no
 * `deadlineAt` (Vercel guilhotina aos 60s → antes disto, uma corrida parcial
 * deixava registos a meio e a seguinte via "already exists" e nunca acabava).
 * Devolve `done:false` quando ficou trabalho por fazer — o chamador (workflow)
 * volta a chamar até `done:true`.
 */
export async function collectDailyDriverData(targetDate: Date, opts?: { deadlineAt?: number }): Promise<{
  success: boolean;
  driversProcessed: number;
  errors: string[];
  done: boolean;
}> {
  const errors: string[] = [];
  let driversProcessed = 0;
  const deadlineAt = opts?.deadlineAt ?? Number.POSITIVE_INFINITY;

  try {
    const dateStr = targetDate.toISOString().split("T")[0];
    const existing = await getDailyDriverHistoryByDate(dateStr);
    const alreadyDone = new Set(existing.map((r: any) => r.zelloUsername));

    // Get all Zello users
    const users = await getZelloUsers();
    let nonAdminUsers = users.filter(u => !u.admin);
    if (nonAdminUsers.length > 0 && alreadyDone.size > 0) {
      nonAdminUsers = nonAdminUsers.filter(u => !alreadyDone.has(u.name));
      if (nonAdminUsers.length === 0) {
        console.log(`[DailyCollection] ${dateStr} já completo (${alreadyDone.size} registos).`);
        return { success: true, driversProcessed: alreadyDone.size, errors: [], done: true };
      }
      console.log(`[DailyCollection] ${dateStr}: a retomar — faltam ${nonAdminUsers.length} de ${users.filter(u => !u.admin).length}.`);
    }

    // Define the time range for the target date (midnight to midnight UTC)
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);
    const startTs = Math.floor(startOfDay.getTime() / 1000);
    const endTs = Math.floor(endOfDay.getTime() / 1000);

    // Get speed limit for violation counting
    const speedLimit = await getDefaultSpeedLimit();
    const threshold = speedLimit
      ? speedLimit.maxSpeed * (1 + speedLimit.tolerancePercent / 100)
      : 999;

    console.log(`[DailyCollection] Processing ${nonAdminUsers.length} users for ${dateStr}`);

    let stoppedAtDeadline = false;
    for (const user of nonAdminUsers) {
      if (Date.now() > deadlineAt) { stoppedAtDeadline = true; break; }
      try {
        // Fetch history from Zello
        const historyData = await getZelloUserHistory(user.name, startTs, endTs);
        const metrics = processGeoJsonHistory(historyData);

        // Count speed violations from the data
        let violations = 0;
        if (historyData?.features) {
          for (const feature of historyData.features) {
            const rawSpd = parseFloat(feature.properties?.speed) || 0;
            const speedKmh = rawSpd * 3.6; // m/s to km/h
            if (speedKmh > threshold && speedKmh <= 150) violations++;
          }
        }

        // Store GeoJSON in S3 if we have data
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

        // Create the daily record
        await createDailyDriverHistory({
          zelloUsername: user.name,
          displayName: user.fullName || user.name,
          date: targetDate.toISOString().slice(0, 19).replace("T", " "),
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
        });

        driversProcessed++;

        // Check for GPS disabled
        if (user.geotrackingOff) {
          await createGpsAlert({
            zelloUsername: user.name,
            displayName: user.fullName || user.name,
            alertType: "gps_off",
            message: `${user.fullName || user.name} tinha o GPS desligado em ${dateStr}`,
            notificationSent: 1,
            occurredAt: targetDate.toISOString().slice(0, 19).replace("T", " "),
          });
        }
      } catch (userError: any) {
        errors.push(`${user.name}: ${userError.message}`);
        console.error(`[DailyCollection] Error processing ${user.name}:`, userError);
      }
    }

    const done = !stoppedAtDeadline;
    console.log(`[DailyCollection] ${done ? "Completed" : "Partial (deadline)"}: ${driversProcessed}/${nonAdminUsers.length} users processed for ${dateStr}`);

    // Send summary notification (só quando termina, para não duplicar em corridas parciais)
    if (done && driversProcessed > 0) {
      await notifyOwner({
        title: "Relatório Diário de Motoristas",
        content: `Recolha automática para ${dateStr}: ${driversProcessed + alreadyDone.size} motoristas processados${errors.length > 0 ? `, ${errors.length} erros` : ""}`,
      });
    }

    return { success: true, driversProcessed, errors, done };
  } catch (error: any) {
    console.error("[DailyCollection] Fatal error:", error);
    errors.push(`Fatal: ${error.message}`);
    return { success: false, driversProcessed, errors, done: false };
  }
}

/**
 * Start the daily collection scheduler.
 * Runs at 2:00 AM Lisbon time every day, collecting the previous day's data.
 */
export function startDailyCollectionScheduler() {
  // Calculate ms until next 2:00 AM Lisbon time
  function msUntilNext2AM(): number {
    const now = new Date();
    // Get current time in Lisbon
    const lisbonNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Lisbon" }));
    const target = new Date(lisbonNow);
    target.setHours(2, 0, 0, 0);
    if (target <= lisbonNow) {
      target.setDate(target.getDate() + 1);
    }
    // Convert back to UTC difference
    const diff = target.getTime() - lisbonNow.getTime();
    return diff;
  }

  function scheduleNext() {
    const delay = msUntilNext2AM();
    const nextRun = new Date(Date.now() + delay);
    console.log(`[DailyCollection] Next run scheduled for ${nextRun.toISOString()} (in ${Math.round(delay / 60000)} minutes)`);

    setTimeout(async () => {
      try {
        // Collect yesterday's data
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(0, 0, 0, 0);

        console.log(`[DailyCollection] Starting collection for ${yesterday.toISOString().split("T")[0]}`);
        const result = await collectDailyDriverData(yesterday);
        console.log(`[DailyCollection] Result:`, result);
      } catch (error) {
        console.error("[DailyCollection] Scheduler error:", error);
      }

      // Schedule the next run
      scheduleNext();
    }, delay);
  }

  scheduleNext();
  console.log("[DailyCollection] Scheduler started — runs daily at 2:00 AM Lisbon time");
}
