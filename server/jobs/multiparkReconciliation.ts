/**
 * Reconciliação diária (daily-ops): corre o /bookings/report de D-1 e D-2
 * (dias de Lisboa) para cada parque e ação e compara com a BD — reservas do
 * report que não existem em multipark_bookings e `total` ≠ tamanho da lista.
 * As diferenças ficam em multipark_reconciliation (painel de saúde); drift
 * acima do limiar → alerta aos admins (uma vez por transição).
 *
 * Retomável: cada (dia, parque, ação) verificado nas últimas 20 h conta como
 * feito, por isso as repetições do daily-ops (?collectOnly=1) continuam onde
 * a anterior parou. Só lê: a reparação é o sync (ou "Reparar período").
 */
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { getBookingsReport, getConfiguredParks, getParkApiKey, type BookingActionType, type ParkConfig } from "../multipark";
import { deliveryErrorCode } from "../bookingDeliveryQueue";
import { reconciliationAlert, reconciliationDiff, utcMysql, type ReconciliationRow } from "../syncRules";
import { RECONCILIATION_ALERT_KEY, notifySyncAlert, transitionAlert } from "../syncHealth";

const ACTIONS: BookingActionType[] = ["creation", "checkin", "checkout", "cancelation"];
const CONCURRENCY = 4;

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};

/** "YYYY-MM-DD" em Lisboa, `daysAgo` dias antes de `now`. */
export function lisbonDayOffset(now: number, daysAgo: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(now - daysAgo * 86_400_000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function saveRow(row: ReconciliationRow) {
  const db = await getDb();
  if (!db) return;
  const at = utcMysql(Date.now());
  await db.execute(sql`INSERT INTO multipark_reconciliation
      (day, parkId, actionType, apiTotal, apiCount, dbFound, missing, status, errorCode, checkedAt)
    VALUES (${row.day}, ${row.parkId}, ${row.actionType}, ${row.apiTotal}, ${row.apiCount}, ${row.dbFound}, ${row.missing}, ${row.status}, ${row.errorCode}, ${at})
    ON DUPLICATE KEY UPDATE apiTotal = VALUES(apiTotal), apiCount = VALUES(apiCount), dbFound = VALUES(dbFound),
      missing = VALUES(missing), status = VALUES(status), errorCode = VALUES(errorCode), checkedAt = VALUES(checkedAt)`);
}

async function existingIds(ids: string[]): Promise<Set<string>> {
  const db = await getDb();
  const out = new Set<string>();
  if (!db || ids.length === 0) return out;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = rowsOf(await db.execute(sql`SELECT externalId FROM multipark_bookings
      WHERE externalId IN (${sql.join(chunk.map((id) => sql`${id}`), sql`, `)})`));
    for (const r of rows) out.add(String(r.externalId));
  }
  return out;
}

export async function runDailyReconciliation(opts: { deadlineAt: number; now?: number }) {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const now = opts.now ?? Date.now();
  const days = [lisbonDayOffset(now, 1), lisbonDayOffset(now, 2)];
  const parks = getConfiguredParks();

  const done = new Set(rowsOf(await db.execute(sql`SELECT day, parkId, actionType FROM multipark_reconciliation
      WHERE day IN (${days[0]}, ${days[1]}) AND checkedAt >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 HOUR)`))
    .map((r) => `${r.day}|${r.parkId}|${r.actionType}`));

  type Pair = { day: string; park: ParkConfig; actionType: BookingActionType };
  const pending: Pair[] = [];
  for (const day of days) for (const park of parks) for (const actionType of ACTIONS) {
    if (!done.has(`${day}|${park.id}|${actionType}`)) pending.push({ day, park, actionType });
  }

  let checked = 0, errors = 0, idx = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, async () => {
    while (idx < pending.length && Date.now() < opts.deadlineAt) {
      const p = pending[idx++];
      try {
        const report = await getBookingsReport(p.day, p.day, p.actionType, getParkApiKey(p.park));
        const ids = (Array.isArray(report?.bookings) ? report.bookings : []).map((b) => String(b.id)).filter(Boolean);
        const row = reconciliationDiff({ day: p.day, parkId: p.park.id, actionType: p.actionType, apiTotal: report?.total,
          apiIds: ids, dbIds: await existingIds(Array.from(new Set(ids))) });
        await saveRow(row);
        if (row.status === "drift") {
          console.warn(`[Reconciliação] ${p.day} ${p.park.id}/${p.actionType}: em falta=${row.missing} total=${row.apiTotal ?? "-"} lista=${ids.length}`);
        }
      } catch (err) {
        errors++;
        const code = deliveryErrorCode(err);
        console.error(`[Reconciliação] ${p.day} ${p.park.id}/${p.actionType}: ${code}`);
        try {
          await saveRow({ day: p.day, parkId: p.park.id, actionType: p.actionType, apiTotal: null, apiCount: 0, dbFound: 0,
            missing: 0, status: "error", errorCode: code });
        } catch { /* fica por verificar */ }
      }
      checked++;
    }
  }));

  const remaining = pending.length - checked;
  let summary: ReturnType<typeof reconciliationAlert> | null = null;
  let notified = 0;
  if (remaining === 0) {
    const rows = rowsOf(await db.execute(sql`SELECT day, parkId, actionType, apiTotal, apiCount, dbFound, missing, status, errorCode
      FROM multipark_reconciliation WHERE day IN (${days[0]}, ${days[1]})`)).map((r) => ({
        day: String(r.day), parkId: String(r.parkId), actionType: String(r.actionType),
        apiTotal: r.apiTotal == null ? null : Number(r.apiTotal), apiCount: Number(r.apiCount), dbFound: Number(r.dbFound),
        missing: Number(r.missing), status: String(r.status) as ReconciliationRow["status"], errorCode: r.errorCode ?? null,
      }));
    summary = reconciliationAlert(rows);
    if (summary.alert) {
      if (await transitionAlert(RECONCILIATION_ALERT_KEY, true, `drift ${summary.drift} em ${days.join(", ")}`)) {
        notified = await notifySyncAlert("Reservas Multipark por sincronizar",
          `A reconciliação de ${days.join(" e ")} encontrou ${summary.missing} reserva(s) do report que não estão na BD` +
          (summary.mismatch ? ` e ${summary.mismatch} de diferença entre o total e a lista` : "") +
          ` (${summary.parks.length} parque(s)). Usar "Reparar período" na Sincronização.`);
      }
    } else {
      await transitionAlert(RECONCILIATION_ALERT_KEY, false, null);
    }
  }
  return { days, pending: pending.length, checked, errors, remaining, done: remaining === 0, summary, notified };
}
