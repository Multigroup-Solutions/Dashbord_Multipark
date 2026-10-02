/**
 * "Não enviar" por pessoa (0370, 17g): quem, de uma lista de fichas, desligou
 * um canal. Uma consulta por envio (não por pessoa). Se a leitura falhar, não
 * bloqueia ninguém (o envio segue e fica o aviso no registo).
 */
import { sql } from "drizzle-orm";
import type { ContactChannel } from "../shared/contactPrefs";

const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r?.rows ?? r) as any[]) ?? [];

export async function employeesWithNoAuto(ids: ReadonlyArray<number>, channel: ContactChannel): Promise<Set<number>> {
  const list = Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)));
  if (!list.length) return new Set();
  try {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) return new Set();
    const col = channel === "whatsapp" ? sql`noAutoWhatsapp` : sql`noAutoEmail`;
    const res = await db.execute(sql`SELECT id FROM employees WHERE ${col} = 1 AND id IN (${sql.join(list.map((id) => sql`${id}`), sql`, `)})`);
    return new Set(rowsOf(res).map((r) => Number(r.id)));
  } catch (err: any) {
    console.warn("[não enviar] leitura falhou:", String(err?.message ?? err).slice(0, 160));
    return new Set();
  }
}
