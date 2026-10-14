/**
 * Movimentos da app Multipark (tabela "History", coluna "changeType") — o
 * mesmo vocabulário no servidor (server/multiparkDb/movements.ts) e na página
 * da Avaliação. PURO.
 *
 * Enum "ChangeType" (docs/multipark-db/schema.md): CREATED, UPDATE,
 * CHECKING_IN, CHECK_IN, MOVEMENT, PENDING_CHECKOUT, CHECKING_OUT, CHECK_OUT,
 * CANCEL.
 *
 * ─── MOVIMENTO, MUDANÇA DE LUGAR E AÇÃO (Jorge, 14 out 2026) ───────────────
 * "Os movimentos, para os pontos, eram os que tocavam no parque. As mudanças
 * de lugar não contam como movimentos; contam como interações."
 *
 * A Multipark grava TODA a deslocação de um carro como `MOVEMENT` (o mesmo
 * evento serve para o levar ao parque e para o mudar de lugar/garagem/fila —
 * `modifiedFields` com o lugar/garagem). Não há um tipo "mudança de lugar":
 * por isso as "Mudanças de lugar" (que procuravam UPDATE com spot/garage)
 * davam sempre 0 e todas as mudanças de lugar entravam como movimentos (+2).
 * A distinção deduz-se da ORDEM das ações da MESMA reserva (o que veio antes
 * do MOVEMENT), que é fiável — o formato do `modifiedFields` não é:
 *
 *  - LEVAR AO PARQUE (toca no parque, entra): o 1.º MOVEMENT depois da
 *    recolha (CHECK_IN) — entre recolha, entrega, movimento e cancelamento,
 *    a ação anterior foi a recolha. Já era a regra (+5).
 *  - TIRAR DO PARQUE PARA A ENTREGA (toca no parque, sai): o 1.º MOVEMENT
 *    depois do pedido de entrega (PENDING_CHECKOUT) ou do início da entrega
 *    (CHECKING_OUT) — a ação anterior (contando também estas duas) foi uma
 *    delas. Movimento (+2).
 *  - MUDANÇA DE LUGAR: qualquer outro MOVEMENT — o carro já está no parque
 *    (já lá foi levado e não há entrega pedida) e só muda de lugar, garagem
 *    ou fila. Conta como AÇÃO (interação), não como movimento, nem pontos.
 *  - AÇÃO (interação): qualquer linha do histórico do agente — recolhas,
 *    entregas, movimentos, mudanças de lugar, pôr em recolha/entrega, pedidos
 *    de entrega, criações, alterações e cancelamentos.
 *
 * Esta regra está em DOIS sítios que têm de dizer o mesmo: aqui
 * (`moveKindsOf`, para as linhas soltas) e no SQL de
 * server/multiparkDb/movements.ts (`moveSeqCteSql` + `moveIsSpotSql`, para as contagens
 * agregadas na BD da Multipark). Os testes comparam os dois.
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

/**
 * Chave NOSSA (não existe na BD da Multipark) para um MOVEMENT que é uma
 * mudança de lugar: as contagens por tipo (`byType`, `actionsByType`) e as
 * listas de detalhe usam-na para a separar dos movimentos que tocam no parque.
 */
export const SPOT_CHANGE_KEY = "SPOT_CHANGE" as const;

const EXTRA_LABELS: Record<string, string> = { [SPOT_CHANGE_KEY]: "Mudança de lugar" };
const EXTRA_PHASES: Record<string, MovementPhase> = { [SPOT_CHANGE_KEY]: "move" };

/** Rótulo PT-PT de um changeType (desconhecido → o próprio texto). */
export function movementLabel(changeType: string | null | undefined): string {
  const k = String(changeType ?? "").trim().toUpperCase();
  return (MOVEMENT_LABELS as Record<string, string>)[k] ?? EXTRA_LABELS[k] ?? (k || "—");
}

/** Fase de um changeType (desconhecido → "other"). */
export function movementPhase(changeType: string | null | undefined): MovementPhase {
  const k = String(changeType ?? "").trim().toUpperCase();
  return (MOVEMENT_PHASE as Record<string, MovementPhase>)[k] ?? EXTRA_PHASES[k] ?? "other";
}

// ─── Movimento × mudança de lugar (regra no topo do ficheiro) ───────────────

/** Que movimento é: leva ao parque, tira do parque para a entrega, ou só muda de lugar. */
export type MoveKind = "park" | "exit" | "spot";

export const MOVE_KIND_LABELS: Record<MoveKind, string> = {
  park: "Levar ao parque",
  exit: "Tirar do parque (entrega)",
  spot: "Mudança de lugar",
};

/** Ações que decidem o "levar ao parque" (a regra antiga, sem mudar). */
export const MOVE_SEQ_PARK_TYPES = ["CHECK_IN", "CHECK_OUT", "MOVEMENT", "CANCEL"] as const;
/** As mesmas mais o pedido e o início da entrega (decidem o "tirar do parque"). */
export const MOVE_SEQ_TYPES = [...MOVE_SEQ_PARK_TYPES, "PENDING_CHECKOUT", "CHECKING_OUT"] as const;
/** Ação anterior que faz de um MOVEMENT a saída para a entrega. */
export const MOVE_EXIT_AFTER = ["PENDING_CHECKOUT", "CHECKING_OUT"] as const;

/** Nomes antigos/variantes (API e cópia local) → o tipo da BD. PURA. */
export function canonicalChangeType(changeType: string | null | undefined): string {
  const k = String(changeType ?? "").trim().toUpperCase();
  switch (k) {
    case "CHECKIN": return "CHECK_IN";
    case "CHECKOUT": return "CHECK_OUT";
    case "MOVE": return "MOVEMENT";
    case "CANCELLATION": case "CANCELLED": return "CANCEL";
    default: return k;
  }
}

/** O movimento conta como movimento (toca no parque)? */
export const moveTouchesPark = (k: MoveKind | null | undefined): boolean => k === "park" || k === "exit";

export interface SeqAction {
  /** id da linha (History.id) — desempata ações no mesmo instante */
  id: string;
  bookingId: string;
  changeType: string | null;
  /** instante UTC (qualquer formato que o Date perceba; "YYYY-MM-DD HH:MM:SS" = UTC) */
  actionTime: string;
}

const msOf = (t: string): number => {
  const s = String(t ?? "").trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? `${s.replace(" ", "T")}Z` : s;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
};

/**
 * Para cada MOVEMENT (pelo id), que movimento é — com a regra do topo do
 * ficheiro, pela ordem das ações da MESMA reserva (instante, depois id).
 * As outras ações não aparecem no resultado. PURA.
 */
export function moveKindsOf(rows: readonly SeqAction[]): Map<string, MoveKind> {
  const byBooking = new Map<string, Array<{ r: SeqAction; ms: number; ct: string }>>();
  for (const r of rows) {
    const ct = canonicalChangeType(r.changeType);
    if (!(MOVE_SEQ_TYPES as readonly string[]).includes(ct)) continue;
    const list = byBooking.get(r.bookingId) ?? [];
    list.push({ r, ms: msOf(r.actionTime), ct });
    byBooking.set(r.bookingId, list);
  }
  const out = new Map<string, MoveKind>();
  for (const list of byBooking.values()) {
    list.sort((a, b) => a.ms - b.ms || (a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0));
    let lastPark: string | null = null; // anterior entre recolha/entrega/movimento/cancelamento
    let lastAny: string | null = null;  // anterior contando também o pedido e o início da entrega
    for (const { r, ct } of list) {
      if (ct === "MOVEMENT") {
        const kind: MoveKind = lastPark === "CHECK_IN" ? "park" : lastAny != null && (MOVE_EXIT_AFTER as readonly string[]).includes(lastAny) ? "exit" : "spot";
        out.set(r.id, kind);
      }
      if ((MOVE_SEQ_PARK_TYPES as readonly string[]).includes(ct)) lastPark = ct;
      lastAny = ct;
    }
  }
  return out;
}

/**
 * Chave de uma linha para as contagens e o detalhe: a mudança de lugar passa
 * a SPOT_CHANGE; o resto fica com o seu tipo. PURA.
 */
export function actionKeyOf(changeType: string | null | undefined, kind: MoveKind | null | undefined): string {
  const ct = String(changeType ?? "").trim().toUpperCase();
  return canonicalChangeType(ct) === "MOVEMENT" && kind === "spot" ? SPOT_CHANGE_KEY : ct;
}
