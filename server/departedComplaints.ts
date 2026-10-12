/**
 * Reclamações dos carros que SAÍRAM num dia ou intervalo de dias operacionais
 * (Jorge, 12 out 2026) — cartão da Atividade do Dia e do Resumo do dia.
 * Regras em shared/departedComplaints.ts.
 *
 * 1. Reservas com a entrega feita (CHECK_OUT na "History" da Multipark, AO
 *    VIVO, só leitura) no período, nas cidades do pedido;
 * 2. reclamações (nossa BD) ligadas a essas reservas pelo `reservationRef`
 *    (id ou código da reserva — a ligação da Ficha da reserva), nas cidades
 *    do pedido, sem as arquivadas nem as convertidas.
 * Falha a ler a Multipark → `{ available:false, reason }` (erro ≠ zero).
 */
import { sql } from "drizzle-orm";
import { readLiveHistoryBookings } from "./multiparkDb/historyLive";
import { describeReadFailure } from "./multiparkDb/read";
import { redactSecrets } from "./multiparkDb/client";
import { operationalDayRangeUtc } from "../shared/lisbonDay";
import { chunked, departedRefs } from "../shared/departedComplaints";

export type DepartedComplaints =
  | { available: true; complaints: number; bookings: number; truncated: boolean }
  | { available: false; reason: string };

/** Reclamações (não arquivadas nem convertidas) ligadas a estas referências de reserva, nas cidades do pedido. */
export async function countComplaintsForRefs(refs: readonly string[]): Promise<number> {
  if (!refs.length) return 0;
  const { getDb } = await import("./db");
  const { projectScope } = await import("./cityScope");
  const db = await getDb();
  if (!db) throw new Error("BD do dashboard indisponível.");
  let n = 0;
  // Cada reclamação tem UMA referência: partir as referências não conta nada duas vezes.
  for (const part of chunked(refs, 1000)) {
    const res: any = await db.execute(sql`SELECT COUNT(*) AS n FROM complaints
      WHERE complaints.reservationRef IN (${sql.join(part.map((r) => sql`${r}`), sql`, `)})
        AND complaints.archivedAt IS NULL AND complaints.complaint_status <> 'converted'
        AND ${projectScope(sql`complaints.projectId`)}`);
    const row = (Array.isArray(res) ? res[0] : res?.rows ?? res)?.[0];
    n += Number(row?.n ?? 0);
  }
  return n;
}

export async function getDepartedComplaints(startDay: string, endDay: string = startDay): Promise<DepartedComplaints> {
  const { start, end } = operationalDayRangeUtc(startDay, endDay < startDay ? startDay : endDay);
  let bookings: Awaited<ReturnType<typeof readLiveHistoryBookings>>;
  try {
    const { scopedCityNamesLive } = await import("./cityScope");
    bookings = await readLiveHistoryBookings({ changeTypes: ["CHECK_OUT"], from: start, to: end, cities: scopedCityNamesLive() });
  } catch (err) {
    console.warn("[departed-complaints] Multipark:", redactSecrets(err).slice(0, 200));
    return { available: false, reason: describeReadFailure(err).reason };
  }
  try {
    const complaints = await countComplaintsForRefs(departedRefs(bookings.rows));
    return { available: true, complaints, bookings: bookings.rows.length, truncated: bookings.truncated };
  } catch (err: any) {
    console.warn("[departed-complaints] reclamações:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
    return { available: false, reason: "Não foi possível contar as reclamações neste momento." };
  }
}
