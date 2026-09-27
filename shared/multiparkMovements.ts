/**
 * Movimentos da app Multipark (tabela "History", coluna "changeType") — o
 * mesmo vocabulário no servidor (server/multiparkDb/movements.ts) e na página
 * da Avaliação. PURO.
 *
 * Enum "ChangeType" (docs/multipark-db/schema.md): CREATED, UPDATE,
 * CHECKING_IN, CHECK_IN, MOVEMENT, PENDING_CHECKOUT, CHECKING_OUT, CHECK_OUT,
 * CANCEL.
 */

export const MOVEMENT_CHANGE_TYPES = [
  "CHECKING_IN", "CHECK_IN", "MOVEMENT", "PENDING_CHECKOUT", "CHECKING_OUT", "CHECK_OUT", "CANCEL", "UPDATE", "CREATED",
] as const;
export type MovementChangeType = (typeof MOVEMENT_CHANGE_TYPES)[number];

/** Fase da reserva a que cada ação pertence. */
export type MovementPhase = "checkin" | "move" | "checkout" | "other";

export const MOVEMENT_PHASE: Record<MovementChangeType, MovementPhase> = {
  CHECKING_IN: "checkin",
  CHECK_IN: "checkin",
  MOVEMENT: "move",
  PENDING_CHECKOUT: "checkout",
  CHECKING_OUT: "checkout",
  CHECK_OUT: "checkout",
  CANCEL: "other",
  UPDATE: "other",
  CREATED: "other",
};

export const MOVEMENT_PHASE_LABELS: Record<MovementPhase, string> = {
  checkin: "Check-in",
  move: "Movimento",
  checkout: "Check-out",
  other: "Outras",
};

export const MOVEMENT_LABELS: Record<MovementChangeType, string> = {
  CHECKING_IN: "Início da recolha",
  CHECK_IN: "Recolha (check-in)",
  MOVEMENT: "Movimento",
  PENDING_CHECKOUT: "Pedido de entrega",
  CHECKING_OUT: "Início da entrega",
  CHECK_OUT: "Entrega (check-out)",
  CANCEL: "Cancelamento",
  UPDATE: "Alteração",
  CREATED: "Criação",
};

/** Rótulo PT-PT de um changeType (desconhecido → o próprio texto). */
export function movementLabel(changeType: string | null | undefined): string {
  const k = String(changeType ?? "").trim().toUpperCase();
  return (MOVEMENT_LABELS as Record<string, string>)[k] ?? (k || "—");
}

/** Fase de um changeType (desconhecido → "other"). */
export function movementPhase(changeType: string | null | undefined): MovementPhase {
  const k = String(changeType ?? "").trim().toUpperCase();
  return (MOVEMENT_PHASE as Record<string, MovementPhase>)[k] ?? "other";
}
