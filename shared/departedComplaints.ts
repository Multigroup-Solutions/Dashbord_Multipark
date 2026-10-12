/**
 * Reclamações dos carros que SAÍRAM num dia (Jorge, 12 out 2026) — Atividade
 * do Dia e Resumo do dia. Conta as reclamações ligadas (complaints.
 * reservationRef = id da reserva na Multipark ou o código dela, como na Ficha
 * da reserva) às reservas com a entrega feita (CHECK_OUT) nesse(s) dia(s)
 * operacional(ais) — 03:00 → 03:00 —, seja qual for o dia em que a
 * reclamação chegou. Arquivadas e convertidas noutro caso não contam. PURO.
 */

/** Explicação curta para a dica do cartão. */
export const DEPARTED_COMPLAINTS_HINT =
  "Reclamações ligadas às reservas que saíram (entrega feita) neste dia operacional (03:00 → 03:00), seja qual for o dia em que a reclamação chegou. Não contam as arquivadas nem as convertidas noutro caso.";

/** Estados da reclamação que não contam (deixou de ser reclamação). */
export const DEPARTED_COMPLAINTS_EXCLUDED_STATUS = ["converted"] as const;

/** Referências a procurar nas reclamações: o id e o código de cada reserva, sem repetidos nem vazios. PURA. */
export function departedRefs(rows: ReadonlyArray<{ bookingId?: string | null; bookingCode?: string | null }>): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    for (const v of [r.bookingId, r.bookingCode]) {
      const t = String(v ?? "").trim();
      if (t) out.add(t.slice(0, 100));
    }
  }
  return [...out];
}

/**
 * Das linhas do histórico (Resumo do dia), as reservas com CHECK_OUT em
 * [start, end) (instantes UTC "AAAA-MM-DD HH:MM:SS"). PURA.
 */
export function departedFromHistory(
  rows: ReadonlyArray<{ changeType?: string | null; actionTime?: string | null; bookingExternalId?: string | null; bookingCode?: string | null }>,
  start: string,
  end: string,
): Array<{ bookingId: string; bookingCode: string | null }> {
  const seen = new Map<string, { bookingId: string; bookingCode: string | null }>();
  for (const r of rows) {
    if (String(r.changeType ?? "").toUpperCase() !== "CHECK_OUT") continue;
    const at = String(r.actionTime ?? "");
    const id = String(r.bookingExternalId ?? "").trim();
    if (!id || !at || at < start || at >= end) continue;
    if (!seen.has(id)) seen.set(id, { bookingId: id, bookingCode: r.bookingCode ?? null });
  }
  return [...seen.values()];
}

/** Partes de no máximo `size` (o IN da consulta). PURA. */
export function chunked<T>(xs: readonly T[], size = 1000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}
