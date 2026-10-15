/**
 * Fases AO VIVO de uma reserva (tarefa 62, P2c) — a regra ÚNICA, usada no
 * estado ao vivo da Passagem de turno (server/multiparkDb/shiftState.ts), no
 * rascunho da passagem (server/shiftHandoverDraft.ts) e nas Reservas do dia
 * (shared/reservasDoDia.ts → phaseLabel). PURA.
 *
 * Fluxo A (confirmado pelo Jorge, 14 out 2026):
 *  - ENTREGAS: o cliente liga → PENDING_CHECKOUT ("pendente": está NA FILA) →
 *    o condutor pega no carro → CHECKING_OUT ("EM ENTREGA": o carro já saiu do
 *    parque, a caminho do terminal ou lá à espera do cliente) → o cliente
 *    assina → CHECK_OUT. O botão "Cheguei" (`arrivedAtDeliveryAt`) quase não
 *    se usa (≈ 3 vezes em 2–3 meses): só diz "No terminal" quando é DESTE
 *    ciclo (≥ o início da entrega; a coluna guarda só o último). Sem GPS ao
 *    vivo não se sabe se já chegou — por isso "Em entrega" e não "A caminho".
 *  - RECOLHAS: o cliente liga ~10 min antes → CHECKING_IN ("EM RECOLHA": o
 *    cliente vem a caminho) → check-in feito (CHECK_IN).
 *  - "À espera das malas" deixou de ser uma fase: é uma ETIQUETA, só quando o
 *    `baggageWaitingAt` é deste pedido (≥ `pendingCheckoutAt`).
 */

export type LivePhase = "checking_in" | "in_park" | "moving" | "pending_checkout" | "at_delivery" | "checking_out";

export const LIVE_PHASE_LABELS: Record<LivePhase, string> = {
  checking_in: "Em recolha (cliente a caminho)",
  in_park: "No parque",
  moving: "Em movimento",
  pending_checkout: "Na fila",
  at_delivery: "No terminal",
  checking_out: "Em entrega",
};

/** A etiqueta das malas (já não é uma fase). */
export const BAGGAGE_WAITING_LABEL = "À espera das malas";

/** Fases que contam como "pendentes" na passagem de turno: só as que estão na fila (o carro ainda está no parque). */
export const QUEUE_PHASES: ReadonlySet<LivePhase> = new Set<LivePhase>(["pending_checkout"]);

export interface LivePhaseInput {
  status: string | null | undefined;
  checkingInAt?: string | null;
  movingAt?: string | null;
  pendingCheckoutAt?: string | null;
  checkingOutAt?: string | null;
  arrivedAtDeliveryAt?: string | null;
  baggageWaitingAt?: string | null;
}

const ms = (v: string | null | undefined): number => {
  if (!v) return NaN;
  const s = String(v).trim();
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
};
/** `a` é do mesmo ciclo que `since` (a ≥ since)? Sem um dos dois: não se sabe → não. */
const sameCycle = (a: string | null | undefined, since: string | null | undefined): boolean => {
  const x = ms(a), y = ms(since);
  return Number.isFinite(x) && Number.isFinite(y) && x >= y;
};

/** Fase ao vivo de uma reserva (a mais específica). PURA. */
export function livePhaseOf(r: LivePhaseInput): LivePhase {
  const st = String(r.status ?? "").toUpperCase();
  if (st === "CHECKING_IN") return "checking_in";
  if (st === "MOVING") return "moving";
  if (st === "PENDING_CHECKOUT") return "pending_checkout";
  // "Cheguei" só se for deste ciclo (carregado depois de a entrega começar); um mais velho ignora-se
  if (st === "CHECKING_OUT") return sameCycle(r.arrivedAtDeliveryAt, r.checkingOutAt) ? "at_delivery" : "checking_out";
  return "in_park";
}

/** "À espera das malas" deste pedido (≥ o pendente), com o carro na fila ou já em entrega. PURA. */
export function baggageWaitingOf(r: LivePhaseInput): boolean {
  const st = String(r.status ?? "").toUpperCase();
  if (st !== "PENDING_CHECKOUT" && st !== "CHECKING_OUT") return false;
  return sameCycle(r.baggageWaitingAt, r.pendingCheckoutAt);
}

/** Desde quando está na fase (o instante da coluna dessa fase); null em "No parque". PURA. */
export function livePhaseSince(phase: LivePhase, r: LivePhaseInput): string | null {
  switch (phase) {
    case "checking_in": return r.checkingInAt ?? null;
    case "moving": return r.movingAt ?? null;
    case "pending_checkout": return r.pendingCheckoutAt ?? null;
    case "checking_out": return r.checkingOutAt ?? null;
    case "at_delivery": return r.arrivedAtDeliveryAt ?? null;
    case "in_park": return null;
  }
}

/** Rótulo curto da fase, com a etiqueta das malas ("Na fila · à espera das malas"). PURA. */
export function livePhaseText(r: LivePhaseInput): string {
  const p = livePhaseOf(r);
  return baggageWaitingOf(r) ? `${LIVE_PHASE_LABELS[p]} · ${BAGGAGE_WAITING_LABEL.toLowerCase()}` : LIVE_PHASE_LABELS[p];
}
