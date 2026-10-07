// Migration 0545 — Tarefas: filtros e tarefas de candidatura (Jorge, 7 out 2026:
// "Nas tarefas 'as minhas tarefas' deve estar filtrado por estado da reserva …,
// candidaturas de condutores, etc.").
//  1. `tasks.bookingRef` — a reserva (multipark_bookings.externalId) de uma
//     tarefa. As tarefas de serviço passam a gravá-la ao nascer; as antigas
//     vêm da `sourceKey` "svc:<reserva>:<linha>" (backfill idempotente: só as
//     que ainda não a têm). Índice para o JOIN do filtro "estado da reserva".
//  2. Chave única SÓ das tarefas de candidatura (`sourceModule = 'lead'`,
//     coluna gerada, como a 0325 fez para os serviços): o cron e o webhook ao
//     mesmo tempo nunca criam duas tarefas para o mesmo lead.
// Só acrescenta. O passo de collation (código, depois do SQL) põe
// `bookingRef` com a collation de `multipark_bookings.externalId` quando a
// BD tiver padrões diferentes (o JOIN não pode misturar collations — ver 0215).
export const MIGRATION_0545_NAME = "0545_tasks_booking_ref_lead_tasks";

export const MIGRATION_0545_STATEMENTS: string[] = [
  "ALTER TABLE `tasks` ADD COLUMN `bookingRef` VARCHAR(128) NULL",
  "ALTER TABLE `tasks` ADD INDEX `idx_tasks_booking_ref` (`bookingRef`)",
  "UPDATE `tasks` SET `bookingRef` = SUBSTRING_INDEX(SUBSTRING_INDEX(`sourceKey`, ':', 2), ':', -1) WHERE `sourceModule` = 'service' AND `sourceKey` LIKE 'svc:%:%' AND `bookingRef` IS NULL",
  "ALTER TABLE `tasks` ADD COLUMN `leadSourceKey` VARCHAR(128) GENERATED ALWAYS AS (IF(`sourceModule` = 'lead', `sourceKey`, NULL)) STORED",
  "ALTER TABLE `tasks` ADD UNIQUE INDEX `uq_tasks_lead_source_key` (`leadSourceKey`)",
];

export const IDEMPOTENT_ERROR_CODES_0545 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};

/**
 * Passo em código (depois do SQL): `tasks.bookingRef` fica com o charset e a
 * collation de `multipark_bookings.externalId`, lidos da própria BD. Sem
 * diferença (o normal: as duas tabelas nasceram com o padrão da BD) não faz
 * nada. Devolve true quando converteu.
 */
export async function runMigration0545Collation(db: { execute: (q: any) => Promise<unknown> }): Promise<boolean> {
  const { sql } = await import("drizzle-orm");
  const cols = rowsOf(await db.execute(sql`SELECT TABLE_NAME AS t, CHARACTER_SET_NAME AS cs, COLLATION_NAME AS coll FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND ((TABLE_NAME = 'multipark_bookings' AND COLUMN_NAME = 'externalId') OR (TABLE_NAME = 'tasks' AND COLUMN_NAME = 'bookingRef'))`));
  const target = cols.find((c) => String(c.t) === "multipark_bookings");
  const mine = cols.find((c) => String(c.t) === "tasks");
  if (!target || !mine) return false;
  const cs = String(target.cs ?? ""), coll = String(target.coll ?? "");
  if (!/^[a-z0-9_]+$/i.test(cs) || !/^[a-z0-9_]+$/i.test(coll) || String(mine.coll ?? "") === coll) return false;
  await db.execute(sql.raw(`ALTER TABLE \`tasks\` MODIFY \`bookingRef\` VARCHAR(128) CHARACTER SET ${cs} COLLATE ${coll} NULL`));
  return true;
}
