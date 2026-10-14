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
  return (MOVEMENT_LABELS as Record<string, string>)[k] ?? MOVEMENT_KIND_LABELS[k] ?? (k || "—");
}

/** Fase de um changeType (desconhecido → "other"). */
export function movementPhase(changeType: string | null | undefined): MovementPhase {
  const k = String(changeType ?? "").trim().toUpperCase();
  if (k === "MOVEMENT_START" || k === "SPOT_CHANGE") return "move"; // MOVEMENT com outro nome no detalhe
  return (MOVEMENT_PHASE as Record<string, MovementPhase>)[k] ?? "other";
}

// ─── Que movimento foi (Jorge, 14 out 2026) ─────────────────────────────────
//
// A app Multipark grava DUAS linhas MOVEMENT por cada vez que um carro muda de
// sítio: o INÍCIO ({"status":{"from":"CHECKED_IN","to":"MOVING"}}, sem garagem
// nem lugar) e o FIM ({"garageName":{"from":X,"to":Y},"spot":{"from":a,"to":b}}).
// "Parque" = a GARAGEM (PD, PD FORA, COBERTO, Central…), não o Park da reserva
// (esse nunca muda num movimento). Regras:
//  - início (status → MOVING, sem garagem/lugar): NÃO conta (nem como ação);
//  - fim sem garagem de origem: "levar ao parque" (arrumar o carro);
//  - mesma garagem (from = to, ou só muda o lugar): "mudança de lugar";
//  - garagens diferentes: "movimento entre parques";
//  - sem garagem/lugar nem início, ou com um valor simples sem origem (formato
//    da cópia local: {"garagem":"G2","lugar":"114"}): "antigo" — fica a regra
//    de antes (1.º movimento depois de uma recolha = levar ao parque; o resto,
//    movimento).
// Chaves com evidência nos dados: garageName/spot (History da Multipark, out
// 2026) e garagem/lugar (cópia local). A classificação é feita com OS MESMOS
// padrões (regex POSIX) no Postgres (server/multiparkDb/movements.ts →
// movementKindSql) e aqui em JS (posixToJs): o resultado é igual por
// construção, também com JSON que não se lê ou cortado.

/** inicio · arrumar (levar ao parque) · lugar (mudança de lugar) · parques (entre parques) · antigo (sem dados). */
export type MovementKind = "inicio" | "arrumar" | "lugar" | "parques" | "antigo";

export const MOVEMENT_GARAGE_KEYS = ["garageName", "garagem"] as const;
export const MOVEMENT_SPOT_KEYS = ["spot", "lugar"] as const;

const SP = "[[:space:]]*";
/**
 * Padrões em regex POSIX (sem barras invertidas: a guarda de SQL recusa-as).
 * `side` captura o valor inteiro (com as aspas, ou um número/null) — o
 * `placeValue` tira as aspas, apara, passa a minúsculas e trata vazio/null
 * como nulo.
 */
export const MOVEMENT_PATTERNS = {
  /** a chave existe (qualquer valor) */
  hasKey: (keys: readonly string[]) => `"(${keys.join("|")})"${SP}:`,
  /** a chave tem um valor simples (texto/número/lista: formato antigo, sem origem) */
  plainKey: (keys: readonly string[]) => `"(${keys.join("|")})"${SP}:${SP}[^{n[:space:]]`,
  /** início do movimento: status → MOVING (sem distinguir maiúsculas) */
  moving: `"status"${SP}:${SP}[{][^}]*"to"${SP}:${SP}"moving"`,
  /** o "from"/"to" de {"key":{"from":…,"to":…}} — 1.º grupo: "texto", número, null… */
  side: (key: string, side: "from" | "to") => `"${key}"${SP}:${SP}[{][^}]*"${side}"${SP}:${SP}("[^"]*"|[^",}[:space:]]+)`,
  /** a hora marcada da entrega: checkOut.from (ISO COM fuso: Z ou ±hh:mm; sem fuso = sem hora marcada) — 1.º grupo */
  checkOutFrom: `"checkOut"${SP}:${SP}[{][^}]*"from"${SP}:${SP}"([0-9]{4}-[0-9]{2}-[0-9]{2}T[^"]*(Z|[+-][0-9]{2}:?[0-9]{2}))"`,
} as const;

/** Regex POSIX (as nossas: [[:space:]] e [[:space:]] dentro de […]) → RegExp do JS. PURA. */
export function posixToJs(pat: string, flags = ""): RegExp {
  return new RegExp(pat.replace(/\[\[:space:\]\]/g, "\\s").replace(/\[:space:\]/g, "\\s"), flags);
}

/** O valor capturado → texto normalizado ou null (o mesmo que no SQL: btrim das aspas, trim, lower, ''/null → NULL). PURA. */
export function placeValue(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const v = raw.replace(/^"+|"+$/g, "").trim().toLowerCase();
  return v === "" || v === "null" ? null : v;
}

const jsCache = new Map<string, RegExp>();
const re = (pat: string, flags = "") => {
  const k = `${flags}|${pat}`;
  let r = jsCache.get(k);
  if (!r) { r = posixToJs(pat, flags); jsCache.set(k, r); }
  return r;
};
const sideOf = (text: string, keys: readonly string[], side: "from" | "to"): string | null => {
  for (const k of keys) {
    const v = placeValue(re(MOVEMENT_PATTERNS.side(k, side)).exec(text)?.[1]);
    if (v != null) return v;
  }
  return null;
};

/**
 * Classifica UMA linha MOVEMENT pelo modifiedFields (texto, ou objeto — que
 * passa a JSON). A MESMA árvore de movementKindSql. PURA.
 */
export function classifyMovement(modifiedFields: unknown): MovementKind {
  const text = modifiedFields == null ? "" : typeof modifiedFields === "string" ? modifiedFields : JSON.stringify(modifiedFields);
  const P = MOVEMENT_PATTERNS, G = MOVEMENT_GARAGE_KEYS, S = MOVEMENT_SPOT_KEYS;
  const hasG = re(P.hasKey(G)).test(text), hasS = re(P.hasKey(S)).test(text);
  if (!hasG && !hasS) return re(P.moving, "i").test(text) ? "inicio" : "antigo";
  if (re(P.plainKey(G)).test(text) || re(P.plainKey(S)).test(text)) return "antigo";
  if (hasG) {
    const gf = sideOf(text, G, "from");
    if (gf == null) return "arrumar";
    return gf !== (sideOf(text, G, "to") ?? "") ? "parques" : "lugar";
  }
  return sideOf(text, S, "from") == null ? "arrumar" : "lugar";
}

/**
 * Hora MARCADA da entrega numa linha CHECK_OUT: `modifiedFields.checkOut.from`
 * (a app reescreve o Booking.checkOut com a hora real; a marcada fica no
 * "from"). Devolve ms UTC, ou null se não houver ou não for uma data. PURA.
 */
export function scheduledCheckOutMs(modifiedFields: unknown): number | null {
  const text = modifiedFields == null ? "" : typeof modifiedFields === "string" ? modifiedFields : JSON.stringify(modifiedFields);
  const from = re(MOVEMENT_PATTERNS.checkOutFrom).exec(text)?.[1];
  if (!from) return null;
  const ms = Date.parse(from);
  return Number.isFinite(ms) ? ms : null;
}

/** Rótulos das linhas MOVEMENT que não são movimentos (os detalhes do Condutores e agentes e da Avaliação do dia). */
export const MOVEMENT_KIND_CHANGE_TYPES = { inicio: "MOVEMENT_START", lugar: "SPOT_CHANGE" } as const;
export const MOVEMENT_KIND_LABELS: Record<string, string> = {
  MOVEMENT_START: "Início de movimento (não conta)",
  SPOT_CHANGE: "Mudança de lugar",
};

/** changeType a mostrar no detalhe: MOVEMENT → MOVEMENT_START / SPOT_CHANGE quando não é movimento. PURA. */
export function displayChangeType(changeType: string | null | undefined, kind: MovementKind | string | null | undefined): string {
  const ct = String(changeType ?? "");
  if (ct.toUpperCase() !== "MOVEMENT") return ct;
  return kind === "inicio" ? MOVEMENT_KIND_CHANGE_TYPES.inicio : kind === "lugar" ? MOVEMENT_KIND_CHANGE_TYPES.lugar : ct;
}
