/**
 * Tirar uma linha de um caso sem a perder (P3 lote 16b). A linha inteira vai
 * para `removed_records` (com quem, quando e porquê) e só depois sai da tabela
 * dela, na mesma transação. Serve as fotos e os condutores associados das
 * Reclamações (e dos Perdidos e Achados). Os ficheiros no storage ficam.
 */
import { eq } from "drizzle-orm";
import type { MySqlColumn, MySqlTable } from "drizzle-orm/mysql-core";
import { removedRecords } from "../drizzle/schema";
import { getDb } from "./db";

export type RemovedEntity = "complaint_photo" | "complaint_driver" | "lost_found_photo" | "lost_found_driver" | "lost_found_return_photo";

/** Linha → texto JSON para o arquivo (datas como texto). PURA. */
export function removedRowJson(row: Record<string, unknown>): string {
  return JSON.stringify(row, (_k, v) => (v instanceof Date ? v.toISOString() : v));
}

export async function removeWithRecord(opts: {
  table: MySqlTable & { id: MySqlColumn };
  entity: RemovedEntity;
  id: number;
  /** Campo da linha que aponta para o caso (ex.: "complaintId"). */
  parentField: string;
  reason?: string | null;
  removedById?: number | null;
}): Promise<{ removed: boolean; row: Record<string, unknown> | null }> {
  const db = await getDb();
  if (!db) throw new Error("DB indisponível");
  return db.transaction(async (tx) => {
    const [row] = (await tx.select().from(opts.table as any).where(eq(opts.table.id, opts.id)).limit(1).for("update")) as Array<Record<string, unknown>>;
    if (!row) return { removed: false, row: null };
    const parent = row[opts.parentField];
    await tx.insert(removedRecords).values({
      entity: opts.entity,
      recordId: opts.id,
      parentId: parent == null ? null : Number(parent),
      rowJson: removedRowJson(row),
      reason: opts.reason ? opts.reason.slice(0, 255) : null,
      removedById: opts.removedById ?? null,
    });
    await tx.delete(opts.table as any).where(eq(opts.table.id, opts.id));
    return { removed: true, row };
  });
}
