/**
 * FECHO DO MÊS DE PARCEIROS (passo 3) — junta a Multipark (ao vivo) com a
 * nossa memória do webhook (último retrato de cada reserva), compara
 * (shared/partnerClose.ts) e guarda por (mês, parceiro) em
 * `partner_month_closes`. Linha FECHADA fica congelada; a comparação
 * automática (cron diário) só mexe nas abertas e avisa quando aparecem
 * diferenças novas (interruptor PARTNER_CLOSE_ALERTS, desligado por omissão).
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { comparePartnerMonth, canClose, monthRangeLisbon, type CloseOurSnap, type PartnerCloseRow } from "../shared/partnerClose";
import { lisbonDayRangeUtc, lisbonDayOf } from "../shared/lisbonDay";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const numOrNull = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const utcNow = () => new Date().toISOString().slice(0, 19).replace("T", " ");

export function isMonth(m: string): boolean { return /^\d{4}-(0[1-9]|1[0-2])$/.test(m); }
export function currentMonthLisbon(now = new Date()): string { return lisbonDayOf(now).slice(0, 7); }
export function previousMonth(m: string): string {
  const [y, mm] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mm - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Último retrato de cada reserva (memória do webhook), lotes de 1000. */
async function latestSnapshots(d: any, ids: string[]): Promise<Map<string, CloseOurSnap>> {
  const out = new Map<string, CloseOurSnap>();
  const uniq = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 1000) {
    const chunk = uniq.slice(i, i + 1000);
    const res = await d.execute(sql`SELECT s.bookingId, s.status, DATE_FORMAT(s.checkOut, '%Y-%m-%d %H:%i:%s') AS co, s.partnerId,
        s.bookingPrice, s.partnerContributedAmount, s.partnerAmountDue, DATE_FORMAT(s.receivedAt, '%Y-%m-%d %H:%i:%s') AS ra
      FROM multipark_webhook_snapshots s
      JOIN (SELECT bookingId, MAX(id) AS mid FROM multipark_webhook_snapshots
             WHERE bookingId IN (${sql.join(chunk.map((x) => sql`${x}`), sql`, `)}) GROUP BY bookingId) t ON t.mid = s.id`);
    for (const r of rowsOf(res)) {
      const contributed = numOrNull(r.partnerContributedAmount);
      out.set(String(r.bookingId), {
        bookingId: String(r.bookingId), status: r.status ?? null, checkOut: r.co ?? null, partnerId: r.partnerId ?? null,
        value: contributed ?? numOrNull(r.bookingPrice), ours: numOrNull(r.partnerAmountDue), receivedAt: r.ra ?? null,
      });
    }
  }
  return out;
}

export interface PartnerCloseCompute { available: boolean; reason?: string; month: string; rows: PartnerCloseRow[]; truncated: boolean }

/** Compara o mês (todas as cidades). Não grava. */
export async function computePartnerClose(month: string): Promise<PartnerCloseCompute> {
  if (!isMonth(month)) throw new Error("Mês inválido (AAAA-MM).");
  const d = await getDb();
  if (!d) throw new Error("BD indisponível.");
  const { start, end } = monthRangeLisbon(month, lisbonDayRangeUtc);
  const { readPartnerCloseLive, readBookingsState } = await import("./multiparkDb/partnerClose");
  const live = await readPartnerCloseLive({ start, end });
  if (!live.available) return { available: false, reason: live.reason, month, rows: [], truncated: false };
  const { bookings, partners, parkIds, truncated } = live.data;

  // reservas que a NOSSA memória dá com saída no mês, com parceiro, nos nossos parques
  const ourIds = parkIds.length ? rowsOf(await d.execute(sql`SELECT DISTINCT bookingId FROM multipark_webhook_snapshots
      WHERE parkId IN (${sql.join(parkIds.map((x) => sql`${x}`), sql`, `)}) AND checkOut >= ${start} AND checkOut < ${end}
        AND partnerId IS NOT NULL AND partnerId <> '' LIMIT 20000`)).map((r) => String(r.bookingId)) : [];
  const ours = await latestSnapshots(d, [...bookings.map((b) => b.id), ...ourIds]);

  const partnerOf = new Map(partners.map((p) => [p.id, { key: p.userId || p.id, name: p.name }]));
  const mpIds = new Set(bookings.map((b) => b.id));
  const onlyOurs = [...ours.keys()].filter((id) => !mpIds.has(id));
  const stateRead = onlyOurs.length ? await readBookingsState(onlyOurs) : null;
  const mpState = stateRead?.available ? stateRead.data : new Map();

  const rows = comparePartnerMonth({
    mp: bookings.map((b) => ({ id: b.id, code: b.code, partnerKey: b.partnerKey, partnerName: b.partnerName, value: b.value, ours: b.ours, dueMissing: b.dueMissing, checkOut: b.checkOut, invoices: b.invoices })),
    ours, partnerOf, mpState, start, end,
  });
  return { available: true, month, rows, truncated };
}

/** Compara e grava as linhas ABERTAS do mês (as fechadas ficam como estão). */
export async function refreshPartnerClose(month: string): Promise<{ available: boolean; reason?: string; partners: number; diffs: number; newDiffs: Array<{ partnerName: string | null; diffs: number }> }> {
  const r = await computePartnerClose(month);
  if (!r.available) return { available: false, reason: r.reason, partners: 0, diffs: 0, newDiffs: [] };
  const d = await getDb();
  if (!d) throw new Error("BD indisponível.");
  const existing = new Map(rowsOf(await d.execute(sql`SELECT partnerKey, state, alertedDiffs FROM partner_month_closes WHERE month = ${month}`)).map((x) => [String(x.partnerKey), x]));
  const now = utcNow();
  const newDiffs: Array<{ partnerName: string | null; diffs: number }> = [];
  for (const row of r.rows) {
    const ex = existing.get(row.partnerKey);
    if (ex && ex.state === "fechado") continue;
    const diffs = row.diffs.length;
    await d.execute(sql`INSERT INTO partner_month_closes
        (month, partnerKey, partnerName, mpBookings, mpValue, mpOurs, mpInvoices, mpNoInvoice, mpNoDue, copyBookings, copyValue, copyOurs, beforeMemory, diffs, diffsJson, computedAt)
      VALUES (${month}, ${row.partnerKey}, ${row.partnerName}, ${row.mp.bookings}, ${row.mp.value}, ${row.mp.ours}, ${row.mp.invoices}, ${row.mp.noInvoice}, ${row.mp.noDue},
        ${row.copy.bookings}, ${row.copy.value}, ${row.copy.ours}, ${row.beforeMemory}, ${diffs}, ${JSON.stringify(row.diffs.slice(0, 2000))}, ${now})
      ON DUPLICATE KEY UPDATE partnerName = VALUES(partnerName), mpBookings = VALUES(mpBookings), mpValue = VALUES(mpValue), mpOurs = VALUES(mpOurs),
        mpInvoices = VALUES(mpInvoices), mpNoInvoice = VALUES(mpNoInvoice), mpNoDue = VALUES(mpNoDue), copyBookings = VALUES(copyBookings),
        copyValue = VALUES(copyValue), copyOurs = VALUES(copyOurs), beforeMemory = VALUES(beforeMemory), diffs = VALUES(diffs),
        diffsJson = VALUES(diffsJson), computedAt = VALUES(computedAt)`);
    if (diffs > Number(ex?.alertedDiffs ?? 0)) newDiffs.push({ partnerName: row.partnerName, diffs });
  }
  return { available: true, partners: r.rows.length, diffs: r.rows.reduce((a, x) => a + x.diffs.length, 0), newDiffs };
}

/** Linhas guardadas do mês (+ o registo das Parcerias de cada parceiro). */
export async function listPartnerClose(month: string) {
  if (!isMonth(month)) throw new Error("Mês inválido (AAAA-MM).");
  const d = await getDb();
  if (!d) throw new Error("BD indisponível.");
  const rows = rowsOf(await d.execute(sql`SELECT c.*, DATE_FORMAT(c.computedAt, '%Y-%m-%d %H:%i') AS computedAtText, DATE_FORMAT(c.closedAt, '%Y-%m-%d %H:%i') AS closedAtText
    FROM partner_month_closes c WHERE c.month = ${month} ORDER BY c.state = 'fechado', c.diffs DESC, c.mpOurs DESC`));
  // registo das Parcerias e quem fechou — lidos à parte (sem JOIN entre tabelas de collations diferentes)
  const recs = rowsOf(await d.execute(sql`SELECT id, name, multiparkPartnerId FROM partnerships WHERE multiparkPartnerId IS NOT NULL AND archivedAt IS NULL`).catch(() => [[]]));
  const recByKey = new Map(recs.map((x) => [String(x.multiparkPartnerId), { id: Number(x.id), name: String(x.name ?? "") }]));
  const closers = [...new Set(rows.map((r) => Number(r.closedBy)).filter((x) => x > 0))];
  const names = new Map<number, string>();
  if (closers.length) for (const u of rowsOf(await d.execute(sql`SELECT id, name FROM users WHERE id IN (${sql.join(closers.map((x) => sql`${x}`), sql`, `)})`).catch(() => [[]]))) names.set(Number(u.id), String(u.name ?? ""));
  return rows.map((r) => {
    const rec = recByKey.get(String(r.partnerKey));
    r.partnershipId = rec?.id ?? null; r.partnershipName = rec?.name ?? null; r.closedByName = r.closedBy ? names.get(Number(r.closedBy)) ?? null : null;
    let diffs: unknown[] = [];
    try { diffs = r.diffsJson ? JSON.parse(String(r.diffsJson)) : []; } catch { diffs = []; }
    return {
      partnerKey: String(r.partnerKey), partnerName: r.partnerName ?? null, partnershipId: r.partnershipId == null ? null : Number(r.partnershipId), partnershipName: r.partnershipName ?? null,
      mp: { bookings: Number(r.mpBookings), value: Number(r.mpValue), ours: Number(r.mpOurs), invoices: Number(r.mpInvoices), noInvoice: Number(r.mpNoInvoice), noDue: Number(r.mpNoDue) },
      copy: { bookings: Number(r.copyBookings), value: Number(r.copyValue), ours: Number(r.copyOurs) },
      beforeMemory: Number(r.beforeMemory), diffs: Number(r.diffs), diffList: diffs as Array<{ bookingId: string; code: string | null; codes: string[]; detail: string }>,
      computedAt: r.computedAtText ?? null, state: String(r.state), closedAt: r.closedAtText ?? null, closedByName: r.closedByName ?? null, closeNote: r.closeNote ?? null,
    };
  });
}

export async function closePartnerMonth(o: { month: string; partnerKey: string; note: string | null; userId: number }): Promise<void> {
  const d = await getDb();
  if (!d) throw new Error("BD indisponível.");
  const [row] = rowsOf(await d.execute(sql`SELECT diffs, state FROM partner_month_closes WHERE month = ${o.month} AND partnerKey = ${o.partnerKey} LIMIT 1`));
  if (!row) throw new Error("Parceiro sem comparação neste mês: carrega em \"Comparar agora\".");
  if (row.state === "fechado") throw new Error("Já está fechado.");
  const err = canClose(Number(row.diffs ?? 0), o.note);
  if (err) throw new Error(err);
  await d.execute(sql`UPDATE partner_month_closes SET state = 'fechado', closedAt = ${utcNow()}, closedBy = ${o.userId}, closeNote = ${o.note?.trim().slice(0, 2000) || null}
    WHERE month = ${o.month} AND partnerKey = ${o.partnerKey}`);
}

export async function reopenPartnerMonth(o: { month: string; partnerKey: string }): Promise<void> {
  const d = await getDb();
  if (!d) throw new Error("BD indisponível.");
  await d.execute(sql`UPDATE partner_month_closes SET state = 'aberto' WHERE month = ${o.month} AND partnerKey = ${o.partnerKey}`);
}

/** Marca os avisos dados (para só avisar de diferenças NOVAS). */
export async function markAlerted(month: string): Promise<void> {
  const d = await getDb();
  if (!d) return;
  await d.execute(sql`UPDATE partner_month_closes SET alertedDiffs = diffs WHERE month = ${month} AND state <> 'fechado'`);
}
