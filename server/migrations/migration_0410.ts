// Migration 0410 — Logs (P3 lote 20c).
//  - activity_logs.source: de onde veio a ação (ui, cron, api_key, site,
//    system…) — "Sistema" deixa de ser uma caixa negra.
//  - employees.cityRequestedAt / autoCreatedAt: marcadores de estado que
//    viviam só no registo de atividade ("já se pediu a cidade", "ficha
//    criada pelo site"). Com a retenção dos logs (24 meses) sumiam; agora
//    ficam na ficha. Preenchem-se uma vez a partir dos logs (passo de dados
//    abaixo, guardado em app_notification_maintenance).
// Idempotente: ADD COLUMN/INDEX ignoram o que já existe. Não apaga nada.
import { sql } from "drizzle-orm";

export const MIGRATION_0410_STATEMENTS: string[] = [
  "ALTER TABLE `activity_logs` ADD COLUMN `source` VARCHAR(16) NULL",
  "ALTER TABLE `activity_logs` ADD INDEX `idx_activity_logs_source_createdAt` (`source`, `createdAt`)",
  "ALTER TABLE `employees` ADD COLUMN `cityRequestedAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `employees` ADD COLUMN `autoCreatedAt` TIMESTAMP NULL DEFAULT NULL",
];

export const IDEMPOTENT_ERROR_CODES_0410 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);

export const DATA_0410_ID = "0410_employee_markers_from_logs";

type Executor = { execute: (q: any) => Promise<unknown> };
const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};

/**
 * Copia para as fichas os marcadores que estavam só nos logs (uma vez).
 * "applied" = correu agora; "skipped" = já tinha corrido. Lança em erro
 * (volta a tentar no arranque seguinte — os UPDATE são idempotentes).
 */
export async function runMigration0410Data(db: Executor): Promise<{ status: "applied" | "skipped" }> {
  const done = rowsOf(await db.execute(sql`SELECT id FROM app_notification_maintenance WHERE id = ${DATA_0410_ID} LIMIT 1`));
  if (done.length) return { status: "skipped" };
  await db.execute(sql`
    UPDATE employees e
      JOIN (SELECT entityId, MIN(createdAt) AS at FROM activity_logs
             WHERE entity = 'employee' AND action = 'extra_city_requested' AND entityId IS NOT NULL GROUP BY entityId) x
        ON x.entityId = e.id
       SET e.cityRequestedAt = x.at
     WHERE e.cityRequestedAt IS NULL`);
  await db.execute(sql`
    UPDATE employees e
      JOIN (SELECT entityId, MIN(createdAt) AS at FROM activity_logs
             WHERE entity = 'employees' AND action = 'employee_autocreate' AND entityId IS NOT NULL GROUP BY entityId) x
        ON x.entityId = e.id
       SET e.autoCreatedAt = x.at
     WHERE e.autoCreatedAt IS NULL`);
  await db.execute(sql`INSERT INTO app_notification_maintenance (id) VALUES (${DATA_0410_ID})`);
  return { status: "applied" };
}
