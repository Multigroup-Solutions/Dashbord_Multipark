/**
 * Cronómetros do AO VIVO (15 out 2026) — "Na fila há 12 min", "Em entrega há
 * 25 min", "Em recolha há 8 min" — no Estado do parque e nos pendentes da
 * Passagem de turno. PURO (o ecrã chama-o a cada 30 s).
 *
 *  - Só "Na fila" tem a cor da meta (o nosso tempo começa na fila): até à meta
 *    nada, a partir da meta âmbar, a partir do dobro vermelho.
 *  - "Em entrega" NÃO tem cor: inclui a espera pelo cliente no terminal, que
 *    não é tempo nosso (sem GPS ao vivo não se sabe se já chegou).
 *  - "Em recolha" também não: é o cliente a caminho.
 * A cor nunca é a única pista: o texto diz sempre os minutos.
 */
import type { LivePhase } from "./livePhases";

/** Minutos inteiros desde `since` (ISO ou "YYYY-MM-DD HH:MM:SS" UTC) até `nowMs`; null sem hora ou no futuro distante. PURA. */
export function elapsedMinutes(since: string | null | undefined, nowMs: number): number | null {
  if (!since) return null;
  const s = String(since).trim();
  const ms = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
  if (!Number.isFinite(ms)) return null;
  const m = Math.floor((nowMs - ms) / 60_000);
  return m < -1 ? null : Math.max(0, m);
}

/** "8 min", "1h05", "26h" (mais de um dia: só as horas). PURA. */
export function fmtElapsed(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return h >= 24 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
}

export type QueueTone = "late" | "warn" | null;

/** Cor da meta de um carro na fila: ≥ 2 × meta "late", ≥ meta "warn", antes nada. PURA. */
export function queueTone(mins: number | null, targetMinutes: number): QueueTone {
  if (mins == null || !(targetMinutes > 0)) return null;
  if (mins >= 2 * targetMinutes) return "late";
  if (mins >= targetMinutes) return "warn";
  return null;
}

const PHASE_TIMER: Partial<Record<LivePhase, string>> = {
  pending_checkout: "Na fila",
  checking_out: "Em entrega",
  at_delivery: "No terminal",
  checking_in: "Em recolha",
  moving: "Em movimento",
};

/** O cronómetro de uma fase ("Na fila há 12 min") e a cor (só na fila). Sem hora → só o nome. PURA. */
export function liveTimer(phase: LivePhase, since: string | null | undefined, nowMs: number, targetMinutes: number): { text: string; mins: number | null; tone: QueueTone } | null {
  const label = PHASE_TIMER[phase];
  if (!label) return null;
  const mins = elapsedMinutes(since, nowMs);
  return { text: mins == null ? label : `${label} há ${fmtElapsed(mins)}`, mins, tone: phase === "pending_checkout" ? queueTone(mins, targetMinutes) : null };
}
