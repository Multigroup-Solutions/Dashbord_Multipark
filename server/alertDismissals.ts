/**
 * Alertas CALCULADOS tirados da lista para toda a gente (Jorge, 7 out 2026,
 * sobre o X dos alertas do Marketing: "pode ser para todos"). Os das Reservas
 * vivem em ops_anomalies (dismissedAt); estes não têm linha própria, por isso
 * guarda-se a chave do alerta (shared/marketingAlerts.ts → marketingAlertKey)
 * por âmbito, projeto e mês. Um alerta tirado fica escondido até ao fim do mês
 * e volta sozinho no seguinte; "Repor" marca restoredAt — nada se apaga.
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";

export type AlertScope = "marketing";

const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r?.rows ?? r) as any[]) ?? [];
const nowMysql = () => new Date().toISOString().slice(0, 19).replace("T", " ");

/** Chaves tiradas neste mês (chave → "AAAA-MM"), no formato de splitHiddenAlerts. */
export async function hiddenAlerts(scope: AlertScope, projectId: number | null | undefined, month: string): Promise<Record<string, string>> {
  const db = await getDb();
  if (!db) throw new Error("BD indisponível");
  const rows = rowsOf(await db.execute(sql`SELECT alertKey FROM alert_dismissals
    WHERE scope = ${scope} AND projectId = ${projectId ?? 0} AND period = ${month} AND restoredAt IS NULL`));
  return Object.fromEntries(rows.map((r) => [String(r.alertKey), month]));
}

/** Tira (hide) ou repõe um alerta deste mês. Devolve se mudou alguma coisa. */
export async function setAlertHidden(scope: AlertScope, projectId: number | null | undefined, alertKey: string, month: string, userId: number, hide: boolean): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("BD indisponível");
  const pid = projectId ?? 0;
  if (hide) {
    await db.execute(sql`INSERT INTO alert_dismissals (scope, projectId, alertKey, period, dismissedById, dismissedAt)
      VALUES (${scope}, ${pid}, ${alertKey}, ${month}, ${userId}, ${nowMysql()})
      ON DUPLICATE KEY UPDATE dismissedById = VALUES(dismissedById), dismissedAt = VALUES(dismissedAt), restoredById = NULL, restoredAt = NULL`);
    return true;
  }
  const res: any = await db.execute(sql`UPDATE alert_dismissals SET restoredById = ${userId}, restoredAt = ${nowMysql()}
    WHERE scope = ${scope} AND projectId = ${pid} AND alertKey = ${alertKey} AND period = ${month} AND restoredAt IS NULL`);
  const affected = Number((Array.isArray(res) ? res[0] : res)?.affectedRows ?? 0);
  return affected > 0;
}
