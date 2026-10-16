/**
 * Dashboard Pessoas — contas PURAS dos cartões (plano 64, D3/D4).
 *
 * Os cartões partem da MESMA lista do RH (`rh.list({ isActive: true, projectId })`)
 * e do mesmo resumo de documentos da lista (`rh.documents.allStatus`): fichas
 * ativas, na cidade/marca do topo. Inativas, desativadas e candidatos ficam de
 * fora (o rótulo diz "ativas").
 */
import { addDays } from "./lisbonDay";

/** Dia (AAAA-MM-DD) de uma data da BD ("AAAA-MM-DD HH:MM:SS" ou "AAAA-MM-DD"); null se vazia. PURA. */
function dayOf(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/**
 * Contratos a expirar: fim do contrato entre HOJE e hoje + `days` (dias de
 * Lisboa, inclusive nas duas pontas). O contrato que acaba hoje conta. PURA.
 */
export function contractsExpiring(rows: ReadonlyArray<{ contractEnd?: string | null }>, today: string, days = 30): number {
  const until = addDays(today, days);
  let n = 0;
  for (const r of rows) {
    const end = dayOf(r.contractEnd);
    if (end && end >= today && end <= until) n++;
  }
  return n;
}

export interface MissingDocsTotals {
  /** documentos obrigatórios em falta, somados por ficha */
  missing: number;
  /** fichas com pelo menos um em falta */
  employees: number;
}

/**
 * Documentos em falta das fichas ATIVAS da lista: soma `total − present` do
 * resumo de cada ficha (a mesma conta da etiqueta "N em falta" da lista do
 * RH). Uma ficha sem resumo ainda não veio do servidor e não conta (o servidor
 * já devolve um resumo para cada ficha, também para as sem documentos). PURA.
 */
export function missingDocsTotals(
  activeEmployees: ReadonlyArray<{ id: number }>,
  statusMap: Readonly<Record<number, { total: number; present: number } | undefined>>,
): MissingDocsTotals {
  let missing = 0, employees = 0;
  for (const e of activeEmployees) {
    const s = statusMap[e.id];
    if (!s) continue;
    const m = Math.max(0, s.total - s.present);
    missing += m;
    if (m > 0) employees++;
  }
  return { missing, employees };
}
