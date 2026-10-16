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
import { sql, type SQL } from "drizzle-orm";
import { readLiveHistoryBookings } from "./multiparkDb/historyLive";
import { describeReadFailure } from "./multiparkDb/read";
import { redactSecrets } from "./multiparkDb/client";
import { operationalDayRangeUtc } from "../shared/lisbonDay";
import { chunked, departedRefs } from "../shared/departedComplaints";
import { COMPLAINT_SLA_RUNNING } from "../shared/caseRules";

export type DepartedComplaints =
  | { available: true; complaints: number; bookings: number; truncated: boolean }
  | { available: false; reason: string };

// ─── "Conta como reclamação" e "fora do prazo", em SQL (plano 64, E7) ───────

/** Só um nome de tabela/alias simples entra no SQL (nunca texto de fora). */
function complaintAlias(alias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error(`Alias de reclamações inválido: ${alias}`);
  return alias;
}

/**
 * A condição ÚNICA "conta como reclamação" sobre a tabela `complaints` (com o
 * alias dado): nem arquivada (16b: "sai dos contadores") nem convertida. A
 * mesma nos carros que saíram, no Resumo do dia e no relatório semanal.
 */
export function countableComplaintSql(alias: string): SQL {
  const a = complaintAlias(alias);
  return sql.raw(`${a}.archivedAt IS NULL AND ${a}.complaint_status <> 'converted'`);
}

/**
 * "Fora do prazo" em `atUtc` ("AAAA-MM-DD HH:MM:SS"): a tradução em SQL de
 * `complaintOverdue` (shared/caseRules.ts) — o prazo é só o `slaDeadline` e o
 * SLA só corre nos estados de COMPLAINT_SLA_RUNNING (pára em "Aguarda
 * Cliente"); o `dueDate` não conta. Montada a partir da MESMA constante.
 */
export function complaintSlaLateSql(alias: string, atUtc: string): SQL {
  const a = complaintAlias(alias);
  const running = sql.join(COMPLAINT_SLA_RUNNING.map((s) => sql`${s}`), sql`, `);
  return sql`${sql.raw(`${a}.slaDeadline`)} IS NOT NULL AND ${sql.raw(`${a}.slaDeadline`)} < ${atUtc} AND ${sql.raw(`${a}.complaint_status`)} IN (${running})`;
}

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
        AND ${countableComplaintSql("complaints")}
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
