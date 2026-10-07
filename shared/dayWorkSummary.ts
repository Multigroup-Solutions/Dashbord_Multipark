/**
 * 44b — Passagem de turno → Resumo do dia (Jorge, 7 out 2026: "põe-nos aqui
 * também quantas horas trabalhou, quantos quilómetros fez e o tempo que
 * tiveram parados"). Regras puras sobre a linha da Atividade do dia.
 */

export interface DayWorkInput {
  /** Horas do ponto (picagens aprovadas). */
  pontoHours: number | null;
  /** Horas com o Zello ligado (GPS). */
  hoursOnline: number | null;
  /** Horas em movimento (GPS). */
  hoursWorked: number | null;
}

/** Horas trabalhadas: as do ponto; sem picagens, o tempo com o Zello ligado (marcado). PURA. */
export function workedHours(p: DayWorkInput): { hours: number | null; source: "ponto" | "zello" | null } {
  if (p.pontoHours != null && p.pontoHours > 0) return { hours: round1(p.pontoHours), source: "ponto" };
  if (p.hoursOnline != null && p.hoursOnline > 0) return { hours: round1(p.hoursOnline), source: "zello" };
  return { hours: null, source: null };
}

/** Tempo parado: com o Zello ligado mas sem andar (online − em movimento). Sem GPS → null. PURA. */
export function stoppedHours(p: DayWorkInput): number | null {
  if (p.hoursOnline == null || p.hoursOnline <= 0) return null;
  return round1(Math.max(0, p.hoursOnline - (p.hoursWorked ?? 0)));
}

/** "7,5 h" / "45 min". PURA. */
export function fmtHours(h: number | null): string {
  if (h == null) return "—";
  if (h < 1) return `${Math.round(h * 60)} min`;
  return `${String(round1(h)).replace(".", ",")} h`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
