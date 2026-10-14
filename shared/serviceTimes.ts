/**
 * Tempos de ENTREGA e de RECOLHA (plano 62, P3) — regras PURAS, sem BD nem
 * rede. O trabalho noturno `service-times` (server/serviceTimesJob.ts) lê a
 * "History" da Multipark (só leitura), as chamadas e o GPS, e passa tudo por
 * aqui; o GPS (paragem, saída de uma zona) está em shared/serviceGps.ts.
 *
 * Entregas (fluxo A, decisões do Jorge de 14 out 2026):
 *   chamada do cliente (C) / pendente (R = PENDING_CHECKOUT)
 *     → em entrega (S = CHECKING_OUT, o condutor pega no carro)
 *     → chegada ao terminal (A, pelo GPS; o "Cheguei" só como recurso)
 *     → assinatura (E = CHECK_OUT).
 *   Fila = S − Q0 (Q0 = o mais cedo entre C e R) · Trânsito = A − S ·
 *   Cliente = E − A · Nosso = Fila + Trânsito (meta 15 min) · Total = E − T0.
 *   A hora MARCADA na ficha não entra em nenhum tempo (D6).
 *
 * Recolhas (manhã):
 *   chamada (C) / em recolha (K = CHECKING_IN) → check-in (I = CHECK_IN)
 *     → o carro sai do terminal (X, pelo GPS) → 1.ª garagem (MOVEMENT)
 *     → P2 (provisória) → parque certo.
 *   Cliente = I − K0 (K0 = o mais cedo entre C e K) · No terminal = X − I ·
 *   Até à 1.ª garagem · No P2 · Até arrumado. Atrasadas só no T2.
 *
 * "Sem medição" nunca é 0: cada tempo leva o estado ("medido" ou o motivo).
 * Q7 (Jorge, 14 out): os tempos também são POR CONDUTOR (médias por semana,
 * mês, 6 meses, comparadas com os colegas da mesma cidade e do mesmo tipo de
 * serviço — driverTimeStats/driverTimeSeries, no fim). Só informação: não dá
 * pontos; os que dependem do GPS continuam atrás do portão (§8.1).
 * Os PARÂMETROS são provisórios até a P0 (diagnóstico na app) correr em
 * produção — ficam aqui como constantes com nome, para o PR dos parâmetros
 * os trocar (e subir SERVICE_TIMES_CALC_VERSION).
 */
import { MOVEMENT_GARAGE_KEYS, MOVEMENT_PATTERNS, classifyMovement, posixToJs, type MovementKind } from "./multiparkMovements";
import { garageFit } from "./garageFit";
import { matchKey } from "./textKey";
import { zelloKey } from "./zelloKey";
import { last9 } from "./centralXsi";
import { lisbonHourOf, operationalDayOf } from "./lisbonDay";

// ─── Parâmetros (provisórios até à P0, §11.1) ───────────────────────────────

/** Versão do cálculo: mudar regras ou parâmetros sobe-a (o trabalho recomeça o preenchimento para trás). */
export const SERVICE_TIMES_CALC_VERSION = 1;

/** Janela da chamada à volta do pendente / do "em recolha" (P0, item 5). */
export const CALL_WINDOW_BEFORE_MIN = 60;
export const CALL_WINDOW_AFTER_MIN = 5;
/** "Chamada fora da janela" só se conta até isto antes da janela (para calibrar). */
export const CALL_OUTSIDE_LOOKBACK_MIN = 120;
/** O mesmo número em ≥ N reservas com pedido no mesmo dia = agência/hotel: não conta. */
export const SHARED_PHONE_MIN_BOOKINGS = 3;
/** Pendente posto antes de o cliente ligar (voo seguido): chamada > R + isto. */
export const REQUEST_BEFORE_CALL_MIN = 15;
/** Dois pendentes com mais do que isto entre eles = "pedido repetido". */
export const REPEATED_REQUEST_GAP_MIN = 30;
/** Dois inícios do mesmo agente a menos disto = quem despacha, não quem conduz (P0, itens 7–8). */
export const DISPATCH_MIN_MINUTES = 8;
/** Papéis de chefia na Multipark (Agent.role): quem marca o "em entrega" a despachar. */
export const MANAGER_AGENT_ROLES: readonly string[] = ["LEADER", "SUPERVISOR", "ADMIN", "ACCOUNTANT"];

/** Limites (acima → "fora_dos_limites"). */
export const MAX_QUEUE_MIN = 240;
export const MAX_TRANSIT_MIN = 120;
export const MAX_CUSTOMER_MIN = 240;
/** Recolhas: cliente (em recolha → check-in), no terminal, até à 1.ª garagem. */
export const MAX_PICKUP_CUSTOMER_MIN = 180;
export const MAX_TERMINAL_MIN = 120;
export const MAX_TO_FIRST_GARAGE_MIN = 120;
/** Chegada até isto depois da assinatura = a própria assinatura ("chegada_ajustada"). */
export const ARRIVAL_ADJUST_S = 60;
/** Os MOVEMENT contam até isto depois do check-in (depois: "por_arrumar"; P0, item 9). */
export const PICKUP_TRACK_MAX_HOURS = 48;
/** "Em recolha" → check-in abaixo disto: pode ter sido marcado já no terminal. */
export const LATE_PICKUP_MARK_MIN = 2;
/** T2: procura-se a chegada do condutor desde isto antes de K0. */
export const T2_LOOKBACK_MIN = 30;
/** Um check-in de PDA aberto conta no máximo isto. */
export const PDA_OPEN_CHECKIN_MAX_HOURS = 16;
/** O "Cheguei" só conta como recurso se carregado mais disto depois do início. */
export const BUTTON_MIN_AFTER_START_S = 120;

/** Definições (omissões; os valores vivem em Definições → Parâmetros → Operação). */
export const DEFAULT_SERVICE_TARGET_MINUTES = 15;
/** Q4 (Jorge, 14 out): a recolha no T2 é atrasada a partir de 15 min depois da chamada (não 10). */
export const DEFAULT_PICKUP_T2_TARGET_MINUTES = 15;
export const SERVICE_TIMES_SINCE_DEFAULT = "2026-04-03";
export const SERVICE_TIMES_GPS_SINCE_DEFAULT = "2026-09-15";
/** Chamadas só existem desde a consola (lote 39a). */
export const SERVICE_CALLS_SINCE = "2026-10-06";

// ─── Estados ────────────────────────────────────────────────────────────────

export type DeliveryOutcome = "entregue" | "cancelado" | "reaberta";
export type PickupOutcome = "recebido" | "cancelado";

export type QueueStatus = "medido" | "sem_pedido" | "sem_inicio" | "inicio_no_terminal" | "fora_dos_limites" | "cancelado";
export type TransitStatus =
  | "medido" | "sem_inicio" | "inicio_no_terminal" | "condutor_desconhecido" | "condutor_por_confirmar" | "condutor_fora_da_equipa"
  | "sem_zello" | "gps_por_recolher" | "gps_fora_do_periodo" | "sem_pontos" | "buraco_no_gps" | "gps_nao_bate" | "gps_parado"
  | "sem_paragem" | "sem_destino" | "destino_ambiguo" | "chegada_depois_da_assinatura" | "fora_dos_limites" | "cancelado";
export type ArrivalSource = "gps_zona" | "gps_ponto_assinatura" | "gps_aeroporto" | "botao";
export type StartSource = "chamada" | "pendente" | "inicio";
export type PickupStartSource = "chamada" | "em_recolha";

export const SERVICE_STATUS_LABELS: Record<string, string> = {
  medido: "Medido",
  aproximado: "Aproximado",
  sem_pedido: "Sem pedido nem chamada",
  sem_inicio: "Sem \"em entrega\"",
  inicio_no_terminal: "\"Em entrega\" marcado já no terminal",
  fora_dos_limites: "Fora dos limites",
  cancelado: "Cancelada",
  condutor_desconhecido: "Condutor desconhecido",
  condutor_por_confirmar: "Condutor por confirmar (quem despachou)",
  condutor_fora_da_equipa: "Condutor fora da equipa",
  sem_zello: "Sem Zello",
  gps_por_recolher: "GPS por recolher",
  gps_fora_do_periodo: "Antes do GPS",
  sem_pontos: "Sem pontos GPS",
  buraco_no_gps: "Buraco no GPS",
  gps_nao_bate: "GPS não bate com a reserva",
  gps_parado: "GPS parado",
  sem_paragem: "Sem paragem no destino",
  sem_destino: "Sem zona de destino",
  destino_ambiguo: "Destino ambíguo (parque dentro da zona)",
  chegada_depois_da_assinatura: "Chegada depois da assinatura",
  sem_em_recolha: "Sem \"em recolha\" nem chamada",
  em_recolha_tardio: "\"Em recolha\" marcado já no terminal",
  sem_saida: "Sem saída do terminal",
  nunca_na_zona: "O GPS nunca esteve na zona do terminal",
  sem_zona: "Sem zona do terminal",
  zonas_sobrepostas: "Zonas P2 e terminal sobrepostas",
  sem_garagem: "Sem garagem nos movimentos",
  arrumado: "Arrumado",
  por_arrumar: "Por arrumar",
  nao_passou_no_p2: "Não passou pelo P2",
  sem_garagem_provisoria: "Sem garagem provisória configurada",
  no_p2: "Ainda no P2",
  nao_aplicavel: "Não se aplica",
  sem_zona_t2: "Sem zona T2 com rótulo",
  sem_gps: "Sem GPS",
};

// ─── Eventos da History ─────────────────────────────────────────────────────

/** Uma linha da "History" já lida (UTC em ms; só as chaves do snapshot que interessam). */
export interface ServiceEvent {
  id: string;
  bookingId: string;
  /** changeType em maiúsculas */
  type: string;
  at: number;
  agentUserId: string | null;
  agentName: string | null;
  platform: string | null;
  lat: number | null;
  lng: number | null;
  /** UPDATE: estado de → para (modifiedFields.status, ou o snapshot). */
  statusFrom?: string | null;
  statusTo?: string | null;
  /** MOVEMENT: o tipo (shared/multiparkMovements.ts) e as garagens (texto original). */
  moveKind?: MovementKind | null;
  garageFrom?: string | null;
  garageTo?: string | null;
  /** snapshot."arrivedAtDeliveryAt" / ."baggageWaitingAt" depois desta ação (ms UTC). */
  snapArrivedAt?: number | null;
  snapBaggageAt?: number | null;
}

const reCache = new Map<string, RegExp>();
const rx = (pat: string, flags = "") => {
  const k = `${flags}|${pat}`;
  let r = reCache.get(k);
  if (!r) { r = posixToJs(pat, flags); reCache.set(k, r); }
  return r;
};
const unquote = (raw: string | undefined | null): string | null => {
  if (raw == null) return null;
  const v = raw.replace(/^"+|"+$/g, "").trim();
  return v === "" || v.toLowerCase() === "null" ? null : v;
};

/** modifiedFields → estado de/para (maiúsculas), se a linha mudou o estado. PURA. */
export function statusChangeOf(modifiedFields: unknown): { from: string | null; to: string | null } {
  const text = modifiedFields == null ? "" : typeof modifiedFields === "string" ? modifiedFields : JSON.stringify(modifiedFields);
  const from = unquote(rx(MOVEMENT_PATTERNS.side("status", "from")).exec(text)?.[1]);
  const to = unquote(rx(MOVEMENT_PATTERNS.side("status", "to")).exec(text)?.[1]);
  return { from: from ? from.toUpperCase() : null, to: to ? to.toUpperCase() : null };
}

/** modifiedFields mexe no estado? (chave "status" presente). PURA. */
export function mentionsStatus(modifiedFields: unknown): boolean {
  const text = modifiedFields == null ? "" : typeof modifiedFields === "string" ? modifiedFields : JSON.stringify(modifiedFields);
  return /"status"\s*:/.test(text);
}

/** Garagem de origem e de destino de um MOVEMENT (texto original, sem aspas). PURA. */
export function movementGarages(modifiedFields: unknown): { from: string | null; to: string | null } {
  const text = modifiedFields == null ? "" : typeof modifiedFields === "string" ? modifiedFields : JSON.stringify(modifiedFields);
  let from: string | null = null, to: string | null = null;
  for (const k of MOVEMENT_GARAGE_KEYS) {
    from ??= unquote(rx(MOVEMENT_PATTERNS.side(k, "from")).exec(text)?.[1]);
    to ??= unquote(rx(MOVEMENT_PATTERNS.side(k, "to")).exec(text)?.[1]);
  }
  return { from, to };
}

/** Linha crua (como vem da Multipark) → ServiceEvent. PURA. */
export function serviceEventOf(r: {
  id: string; bookingId: string; changeType: string | null; at: number; agentUserId?: string | null; agentName?: string | null;
  platform?: string | null; lat?: number | null; lng?: number | null; modifiedFields?: string | null;
  snapStatus?: string | null; snapArrivedAt?: number | null; snapBaggageAt?: number | null;
}): ServiceEvent {
  const type = String(r.changeType ?? "").trim().toUpperCase();
  const ev: ServiceEvent = {
    id: String(r.id), bookingId: String(r.bookingId), type, at: r.at,
    agentUserId: r.agentUserId ?? null, agentName: r.agentName ?? null, platform: r.platform ?? null,
    lat: Number.isFinite(r.lat as number) ? (r.lat as number) : null, lng: Number.isFinite(r.lng as number) ? (r.lng as number) : null,
    snapArrivedAt: r.snapArrivedAt ?? null, snapBaggageAt: r.snapBaggageAt ?? null,
  };
  if (type === "UPDATE") {
    const s = statusChangeOf(r.modifiedFields);
    ev.statusFrom = s.from;
    ev.statusTo = s.to ?? (mentionsStatus(r.modifiedFields) && r.snapStatus ? String(r.snapStatus).toUpperCase() : null);
  }
  if (type === "MOVEMENT") {
    ev.moveKind = classifyMovement(r.modifiedFields ?? "");
    const g = movementGarages(r.modifiedFields);
    ev.garageFrom = g.from;
    ev.garageTo = g.to;
  }
  return ev;
}

/** Ordem lógica dos tipos no mesmo instante (desempate). */
const TYPE_ORDER: Record<string, number> = {
  CREATED: 0, CHECKING_IN: 1, CHECK_IN: 2, MOVEMENT: 3, UPDATE: 4, PENDING_CHECKOUT: 5, CHECKING_OUT: 6, CHECK_OUT: 7, CANCEL: 8,
};

/** Eventos por ordem: instante, ordem lógica do tipo, id. PURA. */
export function sortServiceEvents(events: readonly ServiceEvent[]): ServiceEvent[] {
  return [...events].sort((a, b) => a.at - b.at || (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || a.id.localeCompare(b.id));
}

function byBooking(events: readonly ServiceEvent[]): Map<string, ServiceEvent[]> {
  const m = new Map<string, ServiceEvent[]>();
  for (const e of events) {
    const l = m.get(e.bookingId);
    if (l) l.push(e); else m.set(e.bookingId, [e]);
  }
  return m;
}

const addFlag = (flags: string[], f: string) => { if (!flags.includes(f)) flags.push(f); };

// ─── Ciclos de entrega ──────────────────────────────────────────────────────

export interface DeliveryCycle {
  bookingId: string;
  /** A linha que fecha o ciclo (CHECK_OUT ou CANCEL) — a chave da linha guardada. */
  anchor: ServiceEvent;
  outcome: DeliveryOutcome;
  /** PENDING_CHECKOUT depois do último reinício. */
  requests: ServiceEvent[];
  /** 1.º CHECKING_OUT do ciclo. */
  start: ServiceEvent | null;
  startCount: number;
  /** CHECK_OUT (null nos cancelados). */
  checkout: ServiceEvent | null;
  /** "Cheguei" deste ciclo (pelo snapshot) e a linha que o mostrou (se foi carregado com linha própria). */
  button: { at: number; event: ServiceEvent | null } | null;
  /** "À espera das malas" deste ciclo (só se guarda). */
  baggageAt: number | null;
  flags: string[];
}

interface OpenDelivery { requests: ServiceEvent[]; starts: ServiceEvent[]; events: ServiceEvent[]; flags: string[] }
const newOpenDelivery = (): OpenDelivery => ({ requests: [], starts: [], events: [], flags: [] });
const activeDelivery = (o: OpenDelivery) => o.requests.length > 0 || o.starts.length > 0;

function snapshotValue(events: readonly ServiceEvent[], key: "snapArrivedAt" | "snapBaggageAt", from: number | null, until: number): { at: number; event: ServiceEvent | null } | null {
  let best: number | null = null;
  for (const e of events) {
    const v = e[key];
    if (v == null || !Number.isFinite(v)) continue;
    if (from != null && v < from - 1000) continue; // de um ciclo anterior (a coluna guarda só o último)
    if (v > until) continue;
    if (best == null || v < best) best = v;
  }
  if (best == null) return null;
  // a linha do próprio "Cheguei" (instante = valor, ±5 s); sem ela não se sabe quem carregou
  const event = events.find((e) => e[key] === best && Math.abs(e.at - best!) <= 5_000) ?? null;
  return { at: best, event };
}

function closeDelivery(bookingId: string, o: OpenDelivery, anchor: ServiceEvent, outcome: DeliveryOutcome): DeliveryCycle {
  const flags = [...o.flags];
  const start = o.starts[0] ?? null;
  const requests = o.requests;
  if (requests.length > 1 && requests[requests.length - 1].at - requests[0].at > REPEATED_REQUEST_GAP_MIN * 60_000) addFlag(flags, "pedido_repetido");
  const base = start?.at ?? requests[0]?.at ?? null;
  const all = [...o.events, anchor];
  const button = outcome === "cancelado" ? null : snapshotValue(all, "snapArrivedAt", base, anchor.at + 60 * 60_000);
  const baggage = snapshotValue(all, "snapBaggageAt", requests[0]?.at ?? base, anchor.at + 60 * 60_000);
  return {
    bookingId, anchor, outcome, requests: [...requests], start, startCount: o.starts.length,
    checkout: outcome === "cancelado" ? null : anchor, button, baggageAt: baggage?.at ?? null, flags,
  };
}

/**
 * Ciclos de entrega de cada reserva (eventos de várias reservas, qualquer
 * ordem). Regras (§2.2):
 *  - reinício só com um UPDATE que põe o estado em CHECKED_IN (o pedido
 *    desfaz-se); um MOVEMENT nunca reinicia (flag `movimento_durante_pedido`);
 *  - CANCEL fecha o ciclo sem entrega (`cancelado`), se havia pedido ou início;
 *  - reabertura (UPDATE → CHECKED_IN depois de um CHECK_OUT): a entrega
 *    anterior fica `reaberta` só se vier pedido ou início novo; senão o 2.º
 *    CHECK_OUT é `fecho_repetido` (a 1.ª entrega fica);
 *  - dois CHECK_OUT sem reabertura → o 2.º é `checkout_repetido`;
 *  - um ciclo ainda aberto no fim (pedido sem CHECK_OUT) não sai: conta em `openCycles`.
 * PURA.
 */
export function buildDeliveryCycles(events: readonly ServiceEvent[]): { cycles: DeliveryCycle[]; openCycles: number } {
  const out: DeliveryCycle[] = [];
  let openCycles = 0;
  for (const [bookingId, list] of byBooking(events)) {
    let open = newOpenDelivery();
    let last: DeliveryCycle | null = null;
    let reopened = false;
    for (const ev of sortServiceEvents(list)) {
      const t = ev.type;
      if (t === "UPDATE" && ev.statusTo === "CHECKED_IN") {
        open = newOpenDelivery();
        if (last) reopened = true;
        continue;
      }
      if (t === "PENDING_CHECKOUT" || t === "CHECKING_OUT") {
        if (last && !activeDelivery(open)) {
          if (reopened) last.outcome = "reaberta";
          last = null;
          reopened = false;
        }
        if (t === "PENDING_CHECKOUT") open.requests.push(ev); else open.starts.push(ev);
        open.events.push(ev);
        continue;
      }
      if (t === "CHECK_OUT") {
        if (!activeDelivery(open) && last) {
          addFlag(last.flags, reopened ? "fecho_repetido" : "checkout_repetido");
          reopened = false;
          continue;
        }
        const c = closeDelivery(bookingId, open, ev, "entregue");
        out.push(c);
        last = c;
        reopened = false;
        open = newOpenDelivery();
        continue;
      }
      if (t === "CANCEL") {
        if (activeDelivery(open)) out.push(closeDelivery(bookingId, open, ev, "cancelado"));
        open = newOpenDelivery();
        last = null;
        reopened = false;
        continue;
      }
      if (t === "MOVEMENT" && activeDelivery(open)) addFlag(open.flags, "movimento_durante_pedido");
      open.events.push(ev);
    }
    if (activeDelivery(open)) openCycles++;
  }
  return { cycles: out, openCycles };
}

// ─── Ciclos de recolha ──────────────────────────────────────────────────────

export interface PickupCycle {
  bookingId: string;
  /** A linha que fecha o ciclo (CHECK_IN ou CANCEL). */
  anchor: ServiceEvent;
  outcome: PickupOutcome;
  /** 1.º CHECKING_IN depois do último reinício ("em recolha"). */
  checkingIn: ServiceEvent | null;
  checkingInCount: number;
  checkIn: ServiceEvent | null;
  /** MOVEMENT da reserva depois do check-in (até PICKUP_TRACK_MAX_HOURS e até ao pedido de entrega). */
  moves: ServiceEvent[];
  flags: string[];
}

/**
 * Ciclos de recolha (§3.1): "em recolha" = CHECKING_IN; reinício = UPDATE que
 * tira o estado de CHECKING_IN (para BOOKED/PENDING: o cliente não veio);
 * fecho = CHECK_IN (ou CANCEL depois do "em recolha"). Depois do check-in, os
 * MOVEMENT da mesma reserva até 48 h contam a viagem pelas garagens (param no
 * pedido de entrega). Um 2.º CHECK_IN sem "em recolha" novo = `checkin_repetido`.
 * PURA.
 */
export function buildPickupCycles(events: readonly ServiceEvent[]): PickupCycle[] {
  const out: PickupCycle[] = [];
  const trackMs = PICKUP_TRACK_MAX_HOURS * 3_600_000;
  for (const [bookingId, list] of byBooking(events)) {
    let k: ServiceEvent | null = null;
    let kCount = 0;
    let last: PickupCycle | null = null;
    let tracking: PickupCycle | null = null;
    for (const ev of sortServiceEvents(list)) {
      const t = ev.type;
      if (t === "CHECKING_IN") {
        if (!k) k = ev;
        kCount++;
        tracking = null;
        continue;
      }
      if (t === "UPDATE" && k && (ev.statusTo === "BOOKED" || ev.statusTo === "PENDING")) {
        k = null;
        kCount = 0;
        continue;
      }
      if (t === "CHECK_IN") {
        if (!k && last && last.outcome === "recebido") {
          addFlag(last.flags, "checkin_repetido");
          continue;
        }
        const c: PickupCycle = { bookingId, anchor: ev, outcome: "recebido", checkingIn: k, checkingInCount: kCount, checkIn: ev, moves: [], flags: [] };
        out.push(c);
        last = c;
        tracking = c;
        k = null;
        kCount = 0;
        continue;
      }
      if (t === "CANCEL") {
        if (k) out.push({ bookingId, anchor: ev, outcome: "cancelado", checkingIn: k, checkingInCount: kCount, checkIn: null, moves: [], flags: [] });
        k = null;
        kCount = 0;
        tracking = null;
        last = null;
        continue;
      }
      if (t === "MOVEMENT") {
        if (tracking?.checkIn && ev.at - tracking.checkIn.at <= trackMs) tracking.moves.push(ev);
        continue;
      }
      if (t === "PENDING_CHECKOUT" || t === "CHECKING_OUT" || t === "CHECK_OUT") tracking = null;
    }
  }
  return out;
}

// ─── Chamadas → reserva (§5.1) ──────────────────────────────────────────────

export interface CallRecord {
  at: number;
  source: "central" | "whatsapp";
  /** Atendida (central: held; WhatsApp: não perdida). */
  held: boolean;
  /** Últimos 9 algarismos do número (null = sem número). */
  phone9: string | null;
  /** contactRef "crm-<id>" da consola. */
  crmClientId: number | null;
}

export interface CallMatch { call: CallRecord | null; flags: string[] }

/** Telefone → últimos 9 algarismos (o cruzamento com a consola). PURA. */
export function phone9Of(raw: unknown): string | null {
  return last9(raw);
}

/** "crm-123" → 123. PURA. */
export function crmIdOfContactRef(ref: unknown): number | null {
  const m = /^crm-(\d{1,10})$/.exec(String(ref ?? "").trim());
  return m ? Number(m[1]) : null;
}

/**
 * Números partilhados por dia: o mesmo número em ≥ SHARED_PHONE_MIN_BOOKINGS
 * reservas diferentes com pedido nesse dia (agência, hotel). PURA.
 */
export function sharedPhonesByDay(entries: ReadonlyArray<{ day: string; bookingId: string; phones: readonly (string | null)[] }>, min = SHARED_PHONE_MIN_BOOKINGS): Map<string, Set<string>> {
  const count = new Map<string, Set<string>>();
  for (const e of entries) {
    for (const p of new Set(e.phones.filter((x): x is string => !!x))) {
      const k = `${e.day}|${p}`;
      const s = count.get(k) ?? new Set<string>();
      s.add(e.bookingId);
      count.set(k, s);
    }
  }
  const out = new Map<string, Set<string>>();
  for (const [k, s] of count) {
    if (s.size < min) continue;
    const [day, phone] = k.split("|");
    const set = out.get(day) ?? new Set<string>();
    set.add(phone);
    out.set(day, set);
  }
  return out;
}

/**
 * A 1.ª chamada RECEBIDA do cliente que bate com a reserva (telefone da
 * reserva pelos últimos 9 algarismos, ou contactRef "crm-<id>" de uma ficha
 * ligada) dentro da janela [anchor − antes, anchor + depois]; sem pendente
 * (ou "em recolha"), [fallback − antes, fallback]. As chamadas perdidas e as
 * do WhatsApp contam (flags). Números partilhados não contam. PURA.
 *  - `chamada_fora_da_janela`: só havia chamada antes da janela (até 2 h);
 *  - `pedido_antes_da_chamada`: chamada > anchor + 15 min (o TL pôs o pendente
 *    antes de o cliente ligar — voo seguido); não conta para a Fila (D8).
 */
export function matchCallToBooking(o: {
  calls: readonly CallRecord[];
  phones: ReadonlySet<string>;
  crmIds?: ReadonlySet<number>;
  anchorAt: number | null;
  fallbackAt: number | null;
  /** Até quando procurar a chamada "depois do pendente" (a assinatura ou o check-in). */
  untilAt?: number | null;
  shared?: ReadonlySet<string>;
  beforeMin?: number;
  afterMin?: number;
}): CallMatch {
  const flags: string[] = [];
  const shared = o.shared ?? new Set<string>();
  const sharedHit = [...o.phones].some((p) => shared.has(p));
  if (sharedHit) flags.push("telefone_partilhado");
  const ref = o.anchorAt ?? o.fallbackAt;
  if (ref == null) return { call: null, flags };
  const before = (o.beforeMin ?? CALL_WINDOW_BEFORE_MIN) * 60_000;
  const after = o.anchorAt != null ? (o.afterMin ?? CALL_WINDOW_AFTER_MIN) * 60_000 : 0;
  const from = ref - before, to = ref + after;
  const mine = o.calls
    .filter((c) => (c.phone9 != null && o.phones.has(c.phone9) && !shared.has(c.phone9)) || (c.crmClientId != null && !!o.crmIds?.has(c.crmClientId)))
    .sort((a, b) => a.at - b.at);
  const hit = mine.find((c) => c.at >= from && c.at <= to) ?? null;
  if (hit) {
    if (!hit.held) flags.push("chamada_perdida");
    if (hit.source === "whatsapp") flags.push("chamada_whatsapp");
  } else if (mine.some((c) => c.at < from && c.at >= from - CALL_OUTSIDE_LOOKBACK_MIN * 60_000)) {
    flags.push("chamada_fora_da_janela");
  }
  // só quando o cliente NÃO ligou antes do pendente: uma 2.ª chamada ("então?") depois de
  // uma 1.ª antes do pendente não é um pendente posto antes da chamada (auditoria final)
  if (o.anchorAt != null && (hit == null || hit.at > o.anchorAt)) {
    const until = o.untilAt ?? o.anchorAt + MAX_QUEUE_MIN * 60_000;
    if (mine.some((c) => c.at > o.anchorAt! + REQUEST_BEFORE_CALL_MIN * 60_000 && c.at <= until)) flags.push("pedido_antes_da_chamada");
  }
  return { call: hit, flags };
}

// ─── Condutor ───────────────────────────────────────────────────────────────

const ROLE_RANK: Record<string, number> = { ADMIN: 6, SUPERVISOR: 5, LEADER: 4, ACCOUNTANT: 3, DRIVER: 2, JUNIOR: 1, PARTNER: 0 };

/**
 * Papel do agente NO PARQUE DA RESERVA (há uma linha Agent por pessoa e
 * parque, com papéis que podem diferir). Sem linha nesse parque, o papel mais
 * alto das outras, com `otherPark`. PURA.
 */
export function agentRoleIn(rows: ReadonlyArray<{ userId: string; parkId: string | null; role: string | null }>, userId: string | null, parkId: string | null): { role: string | null; otherPark: boolean } {
  if (!userId) return { role: null, otherPark: false };
  const mine = rows.filter((r) => r.userId === userId);
  const here = mine.find((r) => r.parkId != null && r.parkId === parkId);
  if (here) return { role: here.role ? String(here.role).toUpperCase() : null, otherPark: false };
  let best: string | null = null;
  for (const r of mine) {
    const role = r.role ? String(r.role).toUpperCase() : null;
    if (role && (best == null || (ROLE_RANK[role] ?? -1) > (ROLE_RANK[best] ?? -1))) best = role;
  }
  return { role: best, otherPark: best != null };
}

/**
 * Inícios de quem DESPACHA: dois CHECKING_OUT do mesmo agente a menos de
 * DISPATCH_MIN_MINUTES (um condutor não começa duas entregas em 8 min). PURA.
 */
export function dispatchStartIds(starts: ReadonlyArray<{ id: string; agentUserId: string | null; at: number }>, minMinutes = DISPATCH_MIN_MINUTES): Set<string> {
  const out = new Set<string>();
  const byAgent = new Map<string, Array<{ id: string; at: number }>>();
  for (const s of starts) {
    if (!s.agentUserId) continue;
    const l = byAgent.get(s.agentUserId) ?? [];
    l.push({ id: s.id, at: s.at });
    byAgent.set(s.agentUserId, l);
  }
  for (const l of byAgent.values()) {
    l.sort((a, b) => a.at - b.at);
    for (let i = 1; i < l.length; i++) {
      if (l[i].at - l[i - 1].at < minMinutes * 60_000) { out.add(l[i].id); out.add(l[i - 1].id); }
    }
  }
  return out;
}

/** Resultado do resolvedor de identidade (server/activityHelpers.ts → ResolvedAgent), só o que interessa. */
export type AgentKind = "colaborador" | "parceiro" | "por_ligar" | "ignorado";

/**
 * Quem conduziu dá para medir? colaborador → sim; parceiro/sistema/API →
 * `condutor_fora_da_equipa`; por ligar ou sem agente → `condutor_desconhecido`;
 * papel de chefia ou dois inícios seguidos → `condutor_por_confirmar`. PURA.
 */
export function driverBlockOf(o: { kind: AgentKind | null; role: string | null; dispatch: boolean }): TransitStatus | null {
  if (o.kind === "parceiro" || o.kind === "ignorado") return "condutor_fora_da_equipa";
  if (o.kind !== "colaborador") return "condutor_desconhecido";
  if (o.dispatch || (o.role != null && MANAGER_AGENT_ROLES.includes(o.role))) return "condutor_por_confirmar";
  return null;
}

// ─── Zello no instante (§4.2) ───────────────────────────────────────────────

export interface PdaCheckinLike { employeeId: number; zello: string; start: number; end: number | null }
export interface FixedZelloLike { employeeId: number; zello: string; active: boolean }

const checkinEnd = (c: PdaCheckinLike) => c.end ?? c.start + PDA_OPEN_CHECKIN_MAX_HOURS * 3_600_000;
/** O check-in que cobre o instante e começou mais tarde (o mais recente ganha). */
function latestCovering(list: readonly PdaCheckinLike[], at: number): PdaCheckinLike | null {
  let best: PdaCheckinLike | null = null;
  for (const x of list) if (at >= x.start && at < checkinEnd(x) && (!best || x.start > best.start)) best = x;
  return best;
}

/**
 * Quem tinha um Zello num instante: o check-in de PDA que o cobre (um aberto
 * vale no máximo 16 h) e, fora deles, o dono fixo — só fichas ATIVAS e só se
 * for o único (o mesmo Zello em 2 fichas ativas = ninguém). PURA.
 */
export function zelloHolderAt(zello: string, at: number, o: { checkins: readonly PdaCheckinLike[]; fixed: readonly FixedZelloLike[] }): number | null {
  const k = zelloKey(zello);
  if (!k) return null;
  // Um check-in que ficou aberto (ninguém fez check-out) acaba no check-in seguinte do
  // mesmo PDA: com dois a cobrir o instante, ganha o MAIS RECENTE (auditoria final —
  // antes ganhava o 1.º da lista, e a lista da BD não tem ordem).
  const c = latestCovering(o.checkins.filter((x) => zelloKey(x.zello) === k), at);
  if (c) return c.employeeId;
  const owners = new Set(o.fixed.filter((f) => f.active && zelloKey(f.zello) === k).map((f) => f.employeeId));
  return owners.size === 1 ? [...owners][0] : null;
}

/**
 * O Zello de uma pessoa num instante (§4.2): o check-in de PDA dela que cobre
 * o instante; senão o Zello fixo da ficha ATIVA — que tem de ser só dela e não
 * pode estar, nesse instante, num PDA com o check-in de outra pessoa. PURA.
 */
export function zelloOfAt(employeeId: number, at: number, o: { checkins: readonly PdaCheckinLike[]; fixed: readonly FixedZelloLike[] }): { zello: string; source: "pda" | "fixo" } | { zello: null; reason: "sem_zello" } {
  // o PDA dela que cobre o instante e que, nesse instante, é mesmo dela (um check-in
  // aberto dela acaba quando outra pessoa faz check-in no mesmo PDA)
  const mineNow = o.checkins
    .filter((x) => x.employeeId === employeeId && zelloKey(x.zello) && at >= x.start && at < checkinEnd(x))
    .sort((a, b) => b.start - a.start)
    .find((x) => zelloHolderAt(x.zello, at, o) === employeeId);
  if (mineNow) return { zello: zelloKey(mineNow.zello), source: "pda" };
  const own = o.fixed.find((f) => f.employeeId === employeeId && f.active && zelloKey(f.zello));
  if (!own) return { zello: null, reason: "sem_zello" };
  const k = zelloKey(own.zello);
  if (zelloHolderAt(k, at, o) !== employeeId) return { zello: null, reason: "sem_zello" };
  return { zello: k, source: "fixo" };
}

// ─── Chegada (GPS ou "Cheguei") ─────────────────────────────────────────────

export type GpsArrival =
  | { kind: "chegada"; at: number; source: Exclude<ArrivalSource, "botao">; precisionS: number; flags: string[] }
  | { kind: "sem_chegada"; status: TransitStatus; flags: string[] };

export type ArrivalResolution =
  | { kind: "medido"; at: number; source: ArrivalSource; precisionS: number | null; flags: string[]; buttonGapS: number | null }
  | { kind: "sem_medicao"; status: TransitStatus; flags: string[] };

/**
 * O "Cheguei" serve de recurso? (§4.4) Entre o início e a assinatura, mais de
 * 2 min depois do início, carregado pelo condutor (se se souber quem) e longe
 * do parque (se se souber onde). PURA.
 */
export function buttonCoherent(o: {
  buttonAt: number; startAt: number; endAt: number;
  pressedBy?: string | null; driverAgentId?: string | null;
  /** distância (m) do sítio onde foi carregado ao parque, se se souber */
  distanceFromParkM?: number | null;
}): boolean {
  if (!(o.buttonAt >= o.startAt && o.buttonAt <= o.endAt)) return false;
  if (o.buttonAt - o.startAt <= BUTTON_MIN_AFTER_START_S * 1000) return false;
  if (o.pressedBy && o.driverAgentId && o.pressedBy !== o.driverAgentId) return false;
  if (o.distanceFromParkM != null && o.distanceFromParkM <= 500) return false;
  return true;
}

/**
 * Chegada final: a do GPS; sem ela, o "Cheguei" coerente (fonte `botao`);
 * sem nenhum, o motivo do GPS. Com os dois, guarda-se a diferença (só
 * informação). PURA.
 */
export function resolveArrival(gps: GpsArrival | null, button: { at: number; coherent: boolean } | null, noGpsStatus: TransitStatus = "sem_pontos"): ArrivalResolution {
  if (gps?.kind === "chegada") {
    return { kind: "medido", at: gps.at, source: gps.source, precisionS: gps.precisionS, flags: [...gps.flags], buttonGapS: button ? Math.round((button.at - gps.at) / 1000) : null };
  }
  if (button?.coherent) return { kind: "medido", at: button.at, source: "botao", precisionS: null, flags: [...(gps?.flags ?? [])], buttonGapS: null };
  return { kind: "sem_medicao", status: gps?.status ?? noGpsStatus, flags: [...(gps?.flags ?? [])] };
}

// ─── Tempos das entregas (§2.3) ─────────────────────────────────────────────

export interface DeliveryTimes {
  outcome: DeliveryOutcome;
  callAt: number | null;
  callSource: "central" | "whatsapp" | null;
  callHeld: boolean | null;
  requestAt: number | null;
  requestCount: number;
  /** Início da Fila (Q0 = min(C, R)) e de onde veio. */
  queueStartAt: number | null;
  startSource: StartSource | null;
  /** S efetivo (a saída do parque pelo GPS, com "em entrega" marcado no terminal). */
  startedAt: number | null;
  arrivedAt: number | null;
  arrivedSource: ArrivalSource | null;
  arrivedPrecisionS: number | null;
  buttonArrivedAt: number | null;
  buttonGapS: number | null;
  deliveredAt: number | null;
  queueMs: number | null;
  transitMs: number | null;
  ourMs: number | null;
  customerMs: number | null;
  totalMs: number | null;
  queueStatus: QueueStatus;
  transitStatus: TransitStatus;
  ourStatus: string;
  customerStatus: string;
  flags: string[];
  /** Hora de referência (T0; sem T0, a assinatura ou o fecho): dia operacional e hora de Lisboa. */
  refAt: number;
  opDay: string;
  refHour: number;
}

const over = (ms: number, maxMin: number) => ms > maxMin * 60_000;

/**
 * Os tempos de uma entrega. `call` já passou pela janela (matchCallToBooking)
 * e por `serviceTimes.useCalls`. `arrival` vem do GPS/"Cheguei"
 * (resolveArrival). `inicioNoTerminal`: o "em entrega" foi marcado já no
 * terminal — com GPS, S passa a ser a saída do parque (`parkExitAt`); sem GPS,
 * a Fila e o Trânsito ficam sem medição e o Nosso é aproximado (S − Q0).
 * Invariante: tudo medido → Fila + Trânsito + Cliente = Total. PURA.
 */
export function deliveryTimes(o: {
  cycle: DeliveryCycle;
  call: CallRecord | null;
  arrival: ArrivalResolution;
  inicioNoTerminal?: { parkExitAt: number | null } | null;
  driverBlock?: TransitStatus | null;
}): DeliveryTimes {
  const c = o.cycle;
  const flags = [...c.flags];
  const R = c.requests[0]?.at ?? null;
  const C = o.call?.at ?? null;
  const E = c.checkout?.at ?? null;
  let Q0: number | null = null;
  let startSource: StartSource | null = null;
  if (C != null && (R == null || C < R)) { Q0 = C; startSource = "chamada"; } else if (R != null) { Q0 = R; startSource = "pendente"; }
  const markedS = c.start?.at ?? null;
  const term = o.inicioNoTerminal ?? null;
  if (term) addFlag(flags, "inicio_no_terminal");
  // o condutor ficou à espera do cliente (fez o próprio check-out): mede-se na mesma (Q3)
  if (c.start?.agentUserId && c.checkout?.agentUserId === c.start.agentUserId) addFlag(flags, "condutor_esperou");
  const S = term ? term.parkExitAt : markedS;
  if (Q0 == null && markedS != null) startSource = "inicio";
  let T0: number | null = Q0;
  if (S != null && (T0 == null || S < T0)) {
    if (Q0 != null) addFlag(flags, "inicio_antes_do_pedido");
    T0 = S;
  }
  if (Q0 == null && S == null && markedS != null) T0 = markedS;
  const refAt = T0 ?? E ?? c.anchor.at;
  const base = {
    outcome: c.outcome, callAt: C, callSource: o.call?.source ?? null, callHeld: o.call ? o.call.held : null,
    requestAt: R, requestCount: c.requests.length, queueStartAt: Q0, startSource,
    startedAt: S ?? markedS, buttonArrivedAt: c.button?.at ?? null, deliveredAt: E,
    refAt, opDay: operationalDayOf(refAt), refHour: lisbonHourOf(refAt),
  };
  if (c.outcome === "cancelado") {
    return { ...base, arrivedAt: null, arrivedSource: null, arrivedPrecisionS: null, buttonGapS: null, queueMs: null, transitMs: null, ourMs: null, customerMs: null, totalMs: null,
      queueStatus: "cancelado", transitStatus: "cancelado", ourStatus: "cancelado", customerStatus: "cancelado", flags };
  }

  // Fila
  let queueMs: number | null = null;
  let queueStatus: QueueStatus;
  if (term && term.parkExitAt == null) queueStatus = "inicio_no_terminal";
  else if (S == null) queueStatus = "sem_inicio";
  else if (Q0 == null) queueStatus = "sem_pedido";
  else {
    queueMs = Math.max(0, S - Q0);
    queueStatus = over(queueMs, MAX_QUEUE_MIN) ? "fora_dos_limites" : "medido";
  }

  // Trânsito e Cliente
  let transitMs: number | null = null, customerMs: number | null = null;
  let transitStatus: TransitStatus;
  let arrivedAt: number | null = null, arrivedSource: ArrivalSource | null = null, arrivedPrecisionS: number | null = null, buttonGapS: number | null = null;
  for (const f of o.arrival.flags) addFlag(flags, f);
  if (term && term.parkExitAt == null) transitStatus = "inicio_no_terminal";
  else if (S == null) transitStatus = "sem_inicio";
  else if (o.driverBlock) transitStatus = o.driverBlock;
  else if (o.arrival.kind !== "medido") transitStatus = o.arrival.status;
  else {
    let A = Math.max(o.arrival.at, S);
    if (E != null && A > E) {
      if (A - E <= ARRIVAL_ADJUST_S * 1000) { A = E; addFlag(flags, "chegada_ajustada"); }
    }
    arrivedAt = A;
    arrivedSource = o.arrival.source;
    arrivedPrecisionS = o.arrival.precisionS;
    buttonGapS = o.arrival.buttonGapS;
    if (E != null && A > E) { transitStatus = "chegada_depois_da_assinatura"; arrivedAt = null; }
    else {
      transitMs = A - S;
      transitStatus = over(transitMs, MAX_TRANSIT_MIN) ? "fora_dos_limites" : "medido";
      if (E != null) customerMs = E - A;
    }
  }
  // Cliente: medido com a chegada; senão o motivo do Trânsito.
  const customerStatus: string = customerMs != null ? (over(customerMs, MAX_CUSTOMER_MIN) ? "fora_dos_limites" : "medido") : transitStatus;

  // Nosso
  let ourMs: number | null = null;
  let ourStatus: string;
  if (term && term.parkExitAt == null && Q0 != null && markedS != null) {
    ourMs = Math.max(0, markedS - Q0);
    ourStatus = "aproximado";
    addFlag(flags, "nosso_aproximado");
  } else if (queueStatus === "medido" && transitStatus === "medido" && queueMs != null && transitMs != null) {
    ourMs = queueMs + transitMs;
    ourStatus = "medido";
  } else ourStatus = queueStatus !== "medido" ? queueStatus : transitStatus;

  const totalMs = T0 != null && E != null && E >= T0 ? E - T0 : null;
  return { ...base, arrivedAt, arrivedSource, arrivedPrecisionS, buttonGapS, queueMs, transitMs, ourMs, customerMs, totalMs, queueStatus, transitStatus, ourStatus, customerStatus, flags };
}

/** O Nosso está dentro da meta (minutos)? Só com o Nosso medido. PURA. */
export function withinTarget(t: { ourMs: number | null; ourStatus: string }, targetMinutes = DEFAULT_SERVICE_TARGET_MINUTES): boolean | null {
  if (t.ourStatus !== "medido" || t.ourMs == null) return null;
  return t.ourMs <= targetMinutes * 60_000;
}

// ─── Garagens (§5.3) ────────────────────────────────────────────────────────

export const GARAGE_ROLES = ["provisoria", "parque", "final"] as const;
export type GarageRole = (typeof GARAGE_ROLES)[number];
export interface GarageRoleEntry { garage: string; role: GarageRole }

export const GARAGE_ROLE_LABELS: Record<GarageRole, string> = {
  provisoria: "Provisória (P2)",
  parque: "Já está num parque (pára de medir)",
  final: "Parque certo, se o tipo de lugar bater",
};

/** Omissão (Q5): P2 provisória; CENTRAL e CENTRAL COBERTO param; PD, PD FORA e COBERTO são o parque certo. */
export const DEFAULT_GARAGE_ROLES: readonly GarageRoleEntry[] = [
  { garage: "P2", role: "provisoria" },
  { garage: "CENTRAL", role: "parque" },
  { garage: "CENTRAL COBERTO", role: "parque" },
  { garage: "PD", role: "final" },
  { garage: "PD FORA", role: "final" },
  { garage: "COBERTO", role: "final" },
];

/** Papel de uma garagem (nome comparado com matchKey); sem papel → `final`, com `configured: false`. PURA. */
export function garageRoleOf(name: string | null | undefined, roles: readonly GarageRoleEntry[]): { role: GarageRole; configured: boolean } {
  const k = matchKey(name);
  const hit = k ? roles.find((r) => matchKey(r.garage) === k) : undefined;
  return hit ? { role: hit.role, configured: true } : { role: "final", configured: false };
}

// ─── Tempos das recolhas (§3) ───────────────────────────────────────────────

export type ExitResolution =
  | { kind: "medido"; at: number; source: "gps" | "app_inicio_movimento"; precisionS: number | null; flags: string[] }
  | { kind: "sem_medicao"; status: string; flags: string[] };

export interface PickupTimes {
  outcome: PickupOutcome;
  callAt: number | null;
  callSource: "central" | "whatsapp" | null;
  callHeld: boolean | null;
  /** "Em recolha" (K) e quantos houve. */
  requestAt: number | null;
  requestCount: number;
  customerStartAt: number | null;
  startSource: PickupStartSource | null;
  checkInAt: number | null;
  customerMs: number | null;
  customerStatus: string;
  terminalExitAt: number | null;
  terminalExitSource: string | null;
  terminalMs: number | null;
  terminalStatus: string;
  firstGarage: string | null;
  firstGarageRole: GarageRole | null;
  firstGarageAt: number | null;
  toFirstGarageMs: number | null;
  p2ExitAt: number | null;
  p2Ms: number | null;
  p2Status: string;
  parkedGarage: string | null;
  parkedAt: number | null;
  toParkedMs: number | null;
  parkedStatus: "arrumado" | "por_arrumar" | "sem_garagem" | "cancelado";
  t2DriverArrivedAt: number | null;
  t2LateMs: number | null;
  t2Status: string;
  /** Q7: as linhas de quem tirou o carro do P2 e de quem o arrumou (o tempo é deles). */
  p2Mover: ServiceEvent | null;
  parker: ServiceEvent | null;
  flags: string[];
  refAt: number;
  opDay: string;
  refHour: number;
}

/** O que se sabe dos MOVEMENT depois do check-in. PURA. */
export function pickupMoves(cycle: PickupCycle, roles: readonly GarageRoleEntry[], spotType: string): {
  firstMoveStart: ServiceEvent | null;
  first: { garage: string; role: GarageRole; at: number; event: ServiceEvent } | null;
  p2Exit: { at: number; event: ServiceEvent } | null;
  /** chegada a uma garagem `parque`/`final` depois do P2 (e a linha: quem o levou) */
  afterP2: { garage: string; at: number; event: ServiceEvent } | null;
  parked: { garage: string; at: number; flags: string[]; event: ServiceEvent } | null;
  unknownGarages: string[];
  wrongPlace: boolean;
  hasGarageRows: boolean;
} {
  const I = cycle.checkIn?.at ?? cycle.anchor.at;
  const moves = sortServiceEvents(cycle.moves.filter((m) => m.at >= I));
  const ends = moves.filter((m) => m.garageTo != null && (m.moveKind === "arrumar" || m.moveKind === "parques" || m.moveKind === "lugar"));
  const firstMoveStart = moves.find((m) => m.moveKind === "inicio") ?? null;
  const unknownGarages: string[] = [];
  for (const e of ends) if (!garageRoleOf(e.garageTo, roles).configured && !unknownGarages.includes(e.garageTo!)) unknownGarages.push(e.garageTo!);
  const firstEnd = ends[0] ?? null;
  const first = firstEnd ? { garage: firstEnd.garageTo!, role: garageRoleOf(firstEnd.garageTo, roles).role, at: firstEnd.at, event: firstEnd } : null;
  let p2Exit: { at: number; event: ServiceEvent } | null = null;
  let afterP2: { garage: string; at: number; event: ServiceEvent } | null = null;
  if (first?.role === "provisoria") {
    const p2Key = matchKey(first.garage);
    const leave = ends.find((e) => e.at > first.at && matchKey(e.garageTo) !== p2Key && garageRoleOf(e.garageTo, roles).role !== "provisoria");
    if (leave) {
      afterP2 = { garage: leave.garageTo!, at: leave.at, event: leave };
      // início do movimento que tirou o carro do P2 (a linha "inicio" logo antes do fim)
      const startRow = [...moves].reverse().find((m) => m.moveKind === "inicio" && m.at <= leave.at && m.at > first.at) ?? null;
      if (startRow) p2Exit = { at: startRow.at, event: startRow };
    }
  }
  let parked: { garage: string; at: number; flags: string[]; event: ServiceEvent } | null = null;
  let wrongPlace = false;
  for (const e of ends) {
    const role = garageRoleOf(e.garageTo, roles).role;
    if (role === "provisoria") continue;
    if (role === "parque") { parked = { garage: e.garageTo!, at: e.at, flags: [], event: e }; break; }
    const fit = garageFit(spotType, e.garageTo);
    if (fit === "bad") { wrongPlace = true; continue; }
    parked = { garage: e.garageTo!, at: e.at, flags: fit === "unknown" ? ["arrumo_por_confirmar"] : [], event: e };
    break;
  }
  return { firstMoveStart, first, p2Exit, afterP2, parked, unknownGarages, wrongPlace, hasGarageRows: ends.length > 0 };
}

/**
 * Os tempos de uma recolha (§3.3). `call` já passou pela janela;
 * `checkingInAtTerminal` = a linha CHECKING_IN tem a posição dentro da zona do
 * terminal (decidido pelo GPS, P4); `terminalExit` vem do GPS do condutor ou do
 * recurso da app; `t2` só nas recolhas T2. `now` decide o "por arrumar". PURA.
 */
export function pickupTimes(o: {
  cycle: PickupCycle;
  call: CallRecord | null;
  checkingInAtTerminal?: boolean;
  terminalExit: ExitResolution;
  roles: readonly GarageRoleEntry[];
  spotType: string;
  /** Saída do P2 pelo GPS (recurso quando não há início de movimento). */
  p2GpsExitAt?: number | null;
  t2?: { arrival: { at: number; alreadyThere: boolean } | { status: string }; targetMinutes: number } | null;
  now: number;
}): PickupTimes {
  const c = o.cycle;
  const flags = [...c.flags];
  const K = c.checkingIn?.at ?? null;
  const C = o.call?.at ?? null;
  const I = c.checkIn?.at ?? null;
  // "Em recolha" < 2 min antes do check-in, marcado por quem fez o check-in (ou já no
  // terminal): esse K não é quando o cliente pediu — não serve de início (nem do Cliente,
  // nem da referência do T2); só a chamada, se houver (§3.3; auditoria final: antes, com
  // a chamada DEPOIS do K, o K tardio ainda contava e dava um Cliente de ~0).
  const lateMark = K != null && I != null && I - K < LATE_PICKUP_MARK_MIN * 60_000
    && ((!!c.checkingIn?.agentUserId && c.checkingIn.agentUserId === c.checkIn?.agentUserId) || !!o.checkingInAtTerminal);
  const Kuse = lateMark ? null : K;
  // uma chamada já depois do check-in não é o pedido do cliente
  const Cuse = C != null && (I == null || C <= I) ? C : null;
  let K0: number | null = null;
  let startSource: PickupStartSource | null = null;
  if (Cuse != null && (Kuse == null || Cuse < Kuse)) { K0 = Cuse; startSource = "chamada"; } else if (Kuse != null) { K0 = Kuse; startSource = "em_recolha"; }
  const refAt = K0 ?? K ?? I ?? c.anchor.at;
  const base = {
    outcome: c.outcome, callAt: C, callSource: o.call?.source ?? null, callHeld: o.call ? o.call.held : null,
    requestAt: K, requestCount: c.checkingInCount, customerStartAt: K0, startSource, checkInAt: I,
    refAt, opDay: operationalDayOf(refAt), refHour: lisbonHourOf(refAt),
  };
  if (c.outcome === "cancelado" || I == null) {
    return { ...base, customerMs: null, customerStatus: "cancelado", terminalExitAt: null, terminalExitSource: null, terminalMs: null, terminalStatus: "cancelado",
      firstGarage: null, firstGarageRole: null, firstGarageAt: null, toFirstGarageMs: null, p2ExitAt: null, p2Ms: null, p2Status: "cancelado",
      parkedGarage: null, parkedAt: null, toParkedMs: null, parkedStatus: "cancelado", t2DriverArrivedAt: null, t2LateMs: null, t2Status: "cancelado", p2Mover: null, parker: null, flags };
  }

  // Cliente (chamada / em recolha → check-in)
  let customerMs: number | null = null;
  let customerStatus: string;
  if (lateMark) addFlag(flags, "em_recolha_tardio");
  if (K0 == null) customerStatus = lateMark ? "em_recolha_tardio" : "sem_em_recolha";
  else {
    customerMs = Math.max(0, I - K0);
    customerStatus = over(customerMs, MAX_PICKUP_CUSTOMER_MIN) ? "fora_dos_limites" : "medido";
  }

  // No terminal (X − I)
  let terminalExitAt: number | null = null, terminalExitSource: string | null = null, terminalMs: number | null = null;
  let terminalStatus: string;
  for (const f of o.terminalExit.flags) addFlag(flags, f);
  if (o.terminalExit.kind === "medido" && o.terminalExit.at >= I) {
    terminalExitAt = o.terminalExit.at;
    terminalExitSource = o.terminalExit.source;
    terminalMs = terminalExitAt - I;
    terminalStatus = over(terminalMs, MAX_TERMINAL_MIN) ? "fora_dos_limites" : "medido";
  } else terminalStatus = o.terminalExit.kind === "medido" ? "sem_saida" : o.terminalExit.status;

  // Garagens
  const mv = pickupMoves(c, o.roles, o.spotType);
  if (mv.unknownGarages.length) addFlag(flags, "garagem_sem_papel");
  if (mv.wrongPlace) addFlag(flags, "foi_para_o_sitio_errado");
  let toFirstGarageMs: number | null = null;
  if (mv.first) {
    const from = terminalStatus === "medido" && terminalExitAt != null ? terminalExitAt : I;
    if (from !== terminalExitAt) addFlag(flags, "garagem_desde_o_check_in");
    const ms = mv.first.at - from;
    toFirstGarageMs = ms >= 0 && !over(ms, MAX_TO_FIRST_GARAGE_MIN) ? ms : null;
    if (ms >= 0 && over(ms, MAX_TO_FIRST_GARAGE_MIN)) addFlag(flags, "garagem_fora_dos_limites");
  }

  // P2
  const p2Configured = o.roles.some((r) => r.role === "provisoria");
  let p2ExitAt: number | null = null, p2Ms: number | null = null;
  let p2Status: string;
  const trackMs = PICKUP_TRACK_MAX_HOURS * 3_600_000;
  if (!mv.hasGarageRows) p2Status = "sem_garagem";
  else if (!p2Configured) p2Status = "sem_garagem_provisoria";
  else if (mv.first?.role !== "provisoria") p2Status = "nao_passou_no_p2";
  else {
    p2ExitAt = mv.p2Exit?.at ?? o.p2GpsExitAt ?? null;
    if (!mv.p2Exit && o.p2GpsExitAt != null) addFlag(flags, "saida_do_p2_pelo_gps");
    if (mv.afterP2) {
      p2Ms = mv.afterP2.at - mv.first.at;
      p2Status = p2Ms > trackMs ? "fora_dos_limites" : "medido";
      if (p2Status !== "medido") p2Ms = null;
    } else p2Status = "no_p2";
  }

  // Arrumado
  let parkedGarage: string | null = null, parkedAt: number | null = null, toParkedMs: number | null = null;
  let parkedStatus: PickupTimes["parkedStatus"];
  if (mv.parked && mv.parked.at - I <= trackMs) {
    parkedGarage = mv.parked.garage;
    parkedAt = mv.parked.at;
    toParkedMs = mv.parked.at - I;
    parkedStatus = "arrumado";
    for (const f of mv.parked.flags) addFlag(flags, f);
  } else parkedStatus = mv.hasGarageRows ? "por_arrumar" : "sem_garagem";
  if (parkedStatus === "sem_garagem" && o.now - I < trackMs && c.moves.length === 0) parkedStatus = "por_arrumar";

  // T2
  let t2DriverArrivedAt: number | null = null, t2LateMs: number | null = null;
  let t2Status = "nao_aplicavel";
  if (o.t2) {
    if (K0 == null) t2Status = lateMark ? "em_recolha_tardio" : "sem_em_recolha";
    else if ("status" in o.t2.arrival) t2Status = o.t2.arrival.status;
    else {
      t2DriverArrivedAt = o.t2.arrival.at;
      t2LateMs = o.t2.arrival.alreadyThere ? 0 : Math.max(0, o.t2.arrival.at - (K0 + o.t2.targetMinutes * 60_000));
      t2Status = "medido";
    }
  }

  return {
    ...base, customerMs, customerStatus, terminalExitAt, terminalExitSource, terminalMs, terminalStatus,
    firstGarage: mv.first?.garage ?? null, firstGarageRole: mv.first?.role ?? null, firstGarageAt: mv.first?.at ?? null, toFirstGarageMs,
    p2ExitAt, p2Ms, p2Status, parkedGarage, parkedAt, toParkedMs, parkedStatus, t2DriverArrivedAt, t2LateMs, t2Status,
    p2Mover: p2Status === "medido" ? mv.p2Exit?.event ?? mv.afterP2?.event ?? null : null,
    parker: parkedStatus === "arrumado" ? mv.parked?.event ?? null : null,
    flags,
  };
}

/** Recurso da app para a saída do terminal: o início do 1.º MOVEMENT depois do check-in, se foi marcado na zona. PURA. */
export function appTerminalExit(cycle: PickupCycle, insideTerminal: (lat: number, lng: number) => boolean): ExitResolution | null {
  const I = cycle.checkIn?.at;
  if (I == null) return null;
  const start = sortServiceEvents(cycle.moves).find((m) => m.at >= I && m.moveKind === "inicio");
  if (!start || start.lat == null || start.lng == null || !insideTerminal(start.lat, start.lng)) return null;
  return { kind: "medido", at: start.at, source: "app_inicio_movimento", precisionS: null, flags: [] };
}

// ─── Portão dos tempos com GPS (§8.1) ───────────────────────────────────────

export interface GpsGate { visible: boolean; minCoveragePct: number; minN: number }
export const DEFAULT_GPS_GATE: GpsGate = { visible: false, minCoveragePct: 60, minN: 20 };

/**
 * Os tempos que dependem do GPS (Trânsito, Cliente das entregas, Nosso, % na
 * meta, No terminal, Até à 1.ª garagem, Atrasadas no T2) podem ir para este
 * ecrã? Aplicada NO SERVIDOR (com o portão fechado nem se mandam os números).
 * Super admin vê sempre, com "em calibração". PURA.
 */
export function gpsTimesVisible(o: { coveragePct: number; n: number; gate: GpsGate | null | undefined; isSuperAdmin: boolean }): { visible: boolean; label: string | null } {
  const gate = o.gate ?? DEFAULT_GPS_GATE;
  if (o.isSuperAdmin) return { visible: true, label: gate.visible ? null : "em calibração" };
  if (!gate.visible) return { visible: false, label: "Em calibração" };
  if (o.coveragePct >= gate.minCoveragePct && o.n >= gate.minN) return { visible: true, label: null };
  return { visible: false, label: `Sem dados suficientes (cobertura ${Math.round(o.coveragePct)} %, n = ${o.n})` };
}

// ─── Impressão digital dos parâmetros (§6.1) ────────────────────────────────

function stable(v: unknown): string {
  if (v == null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

/**
 * Impressão digital das definições usadas no cálculo (zonas, zonas T1/T2 dos
 * aeroportos, papéis das garagens, janela das chamadas, usar chamadas): outra
 * impressão = as linhas dos últimos 14 dias refazem-se. 16 hex (FNV-1a 64). PURA.
 */
export function serviceParamsHash(p: unknown): string {
  const s = stable(p);
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

// ─── Tempos por condutor (Q7, Jorge 14 out 2026) ────────────────────────────
//
// "Se durante 6 meses os colegas entregam todos entre 13 e 17 min e ele
// entrega sempre com 20 a 30, é importante saber." Cada tempo tem o seu
// condutor (a coluna da linha guardada); compara-se com os COLEGAS da mesma
// cidade e do mesmo tipo de serviço (T1, T2, VIP, Outro). Informação, NÃO
// pontos. Com menos de DRIVER_STATS_MIN_N medições não se mostra número.
// Os tempos com GPS só vão para o ecrã com o portão aberto (gpsTimesVisible).

export const DRIVER_STATS_MIN_N = 10;

/** O que interessa de uma linha guardada (service_times) para as contas por condutor. */
export interface DriverRowLike {
  kind: string;
  opDay: string;
  cityKey: string | null;
  terminalClass: string | null;
  outcome: string;
  voidedAt?: string | null;
  startEmployeeId?: number | null;
  deliverEmployeeId?: number | null;
  driverEmployeeId?: number | null;
  checkInEmployeeId?: number | null;
  p2EmployeeId?: number | null;
  parkedEmployeeId?: number | null;
  queueMs?: number | null; queueStatus?: string | null;
  transitMs?: number | null; transitStatus?: string | null;
  ourMs?: number | null; ourStatus?: string | null;
  customerMs?: number | null; customerStatus?: string | null;
  terminalMs?: number | null; terminalStatus?: string | null;
  toFirstGarageMs?: number | null;
  p2Ms?: number | null; p2Status?: string | null;
  toParkedMs?: number | null; parkedStatus?: string | null;
  t2LateMs?: number | null; t2Status?: string | null;
}

export type DriverMetric = "fila" | "transito" | "nosso" | "cliente" | "terminal" | "ate_garagem" | "p2" | "ate_arrumado" | "cliente_recolha" | "t2_atraso";

export interface DriverMetricDef {
  kind: "entrega" | "recolha";
  label: string;
  /** De quem é este tempo. */
  employee: (r: DriverRowLike) => number | null | undefined;
  /** O valor (ms), só quando medido. */
  value: (r: DriverRowLike) => number | null | undefined;
  /** Depende do GPS (fica atrás do portão). */
  gps: boolean;
}

const measured = (v: number | null | undefined, st: string | null | undefined) => (st === "medido" && v != null && Number.isFinite(v) ? v : null);

/**
 * O "em entrega" não foi marcado pelo condutor (quem despacha, parceiro, sistema,
 * agente por ligar): a Fila e o Nosso dessa entrega não são de ninguém (auditoria
 * final — antes iam para a ficha do TL que despachou).
 */
const START_NOT_DRIVER = new Set<string>(["condutor_por_confirmar", "condutor_fora_da_equipa", "condutor_desconhecido"]);
const startDriverOf = (r: DriverRowLike) => (r.transitStatus && START_NOT_DRIVER.has(r.transitStatus) ? null : r.startEmployeeId);

/** Cada tempo e o condutor a quem pertence. */
export const DRIVER_METRICS: Record<DriverMetric, DriverMetricDef> = {
  fila: { kind: "entrega", label: "Fila (até pegar no carro)", employee: startDriverOf, value: (r) => measured(r.queueMs, r.queueStatus), gps: false },
  transito: { kind: "entrega", label: "Trânsito (até chegar ao terminal)", employee: startDriverOf, value: (r) => measured(r.transitMs, r.transitStatus), gps: true },
  nosso: { kind: "entrega", label: "Nosso tempo (Fila + Trânsito)", employee: startDriverOf, value: (r) => measured(r.ourMs, r.ourStatus), gps: true },
  cliente: { kind: "entrega", label: "Espera pelo cliente (entrega)", employee: (r) => r.deliverEmployeeId, value: (r) => measured(r.customerMs, r.customerStatus), gps: true },
  terminal: { kind: "recolha", label: "No terminal (tirar o carro)", employee: (r) => r.driverEmployeeId, value: (r) => measured(r.terminalMs, r.terminalStatus), gps: true },
  ate_garagem: { kind: "recolha", label: "Até à 1.ª garagem", employee: (r) => r.driverEmployeeId, value: (r) => (r.terminalStatus === "medido" ? r.toFirstGarageMs ?? null : null), gps: true },
  p2: { kind: "recolha", label: "No P2", employee: (r) => r.p2EmployeeId, value: (r) => measured(r.p2Ms, r.p2Status), gps: false },
  ate_arrumado: { kind: "recolha", label: "Até arrumado", employee: (r) => r.parkedEmployeeId, value: (r) => (r.parkedStatus === "arrumado" ? r.toParkedMs ?? null : null), gps: false },
  cliente_recolha: { kind: "recolha", label: "Cliente (chamada → check-in)", employee: (r) => r.checkInEmployeeId, value: (r) => measured(r.customerMs, r.customerStatus), gps: false },
  t2_atraso: { kind: "recolha", label: "Atraso no T2", employee: (r) => r.checkInEmployeeId, value: (r) => measured(r.t2LateMs, r.t2Status), gps: true },
};

/** Períodos: semana (7 dias), mês (30), 6 meses (182), a acabar em `refDay`. PURA. */
export function driverPeriodRange(period: "semana" | "mes" | "6meses", refDay: string): { fromDay: string; toDay: string } {
  const days = period === "semana" ? 7 : period === "mes" ? 30 : 182;
  const d = new Date(`${refDay}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return { fromDay: d.toISOString().slice(0, 10), toDay: refDay };
}

function pctl(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const statsOf = (vals: number[]) => {
  const s = [...vals].sort((a, b) => a - b);
  return { n: s.length, meanMs: s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null, p50Ms: pctl(s, 0.5), p75Ms: pctl(s, 0.75) };
};

export interface DriverStat {
  employeeId: number;
  cityKey: string | null;
  /** Tipo de serviço (T1, T2, VIP, Outro, sem tipo) — "todos" sem separar. */
  serviceType: string;
  n: number;
  /** n ≥ mínimo: só aí há números (senão "sem dados suficientes"). */
  enough: boolean;
  meanMs: number | null;
  p50Ms: number | null;
  p75Ms: number | null;
  /** Os colegas da mesma cidade e tipo (sem ele). */
  peers: { drivers: number; n: number; meanMs: number | null; p50Ms: number | null };
  /** p50 dele − p50 dos colegas (só com os dois n suficientes). */
  deltaP50Ms: number | null;
  /**
   * Tempo com GPS (§8.1): `null` = pode mostrar-se; senão o texto a pôr no lugar
   * dos números ("Em calibração", "Sem dados suficientes (…)"). Para o super admin
   * com o portão fechado os números vêm, com `gpsLabel` "em calibração".
   */
  gpsHidden: string | null;
  gpsLabel: string | null;
}

/** Quem pede os números e o portão em vigor (`serviceTimes.gpsGate`). */
export interface DriverGpsGate { gate: GpsGate | null | undefined; isSuperAdmin: boolean }

const eligible = (r: DriverRowLike, def: DriverMetricDef, fromDay: string, toDay: string) =>
  r.kind === def.kind && !r.voidedAt && r.outcome !== "cancelado" && r.opDay >= fromDay && r.opDay <= toDay;

/**
 * O portão de um tempo com GPS numa cidade e período (§8.1): cobertura = % das
 * entregas (ou recolhas) da cidade no período com este tempo medido; n = quantas.
 * Tempos sem GPS → sempre visíveis. PURA.
 */
export function driverGateFor(rows: readonly DriverRowLike[], o: { metric: DriverMetric; cityKey: string | null; fromDay: string; toDay: string; gpsGate?: DriverGpsGate | null }): { visible: boolean; label: string | null } {
  const def = DRIVER_METRICS[o.metric];
  if (!def.gps) return { visible: true, label: null };
  let total = 0, n = 0;
  for (const r of rows) {
    if (!eligible(r, def, o.fromDay, o.toDay) || (r.cityKey ?? null) !== o.cityKey) continue;
    total++;
    const v = def.value(r);
    if (v != null && Number.isFinite(v)) n++;
  }
  // sem portão indicado = o fechado e quem não é super admin: ninguém se esquece dele
  return gpsTimesVisible({ coveragePct: total ? (n / total) * 100 : 0, n, gate: o.gpsGate?.gate ?? DEFAULT_GPS_GATE, isSuperAdmin: !!o.gpsGate?.isSuperAdmin });
}

/**
 * Médias e percentis de UM tempo por condutor num período, ao lado dos
 * colegas da mesma cidade e do mesmo tipo de serviço (sem ele). Linhas
 * anuladas e canceladas não contam; só tempos medidos; abaixo de `minN`
 * medições não há número. Os tempos com GPS passam pelo portão (§8.1) por
 * cidade e período — sem `gpsGate`, fechado. Só informação: não dá pontos. PURA.
 */
export function driverTimeStats(rows: readonly DriverRowLike[], o: { metric: DriverMetric; fromDay: string; toDay: string; minN?: number; byServiceType?: boolean; gpsGate?: DriverGpsGate | null }): DriverStat[] {
  const def = DRIVER_METRICS[o.metric];
  const minN = o.minN ?? DRIVER_STATS_MIN_N;
  const byType = o.byServiceType !== false;
  const items: Array<{ emp: number; group: string; city: string | null; type: string; v: number }> = [];
  for (const r of rows) {
    if (!eligible(r, def, o.fromDay, o.toDay)) continue;
    const emp = def.employee(r), v = def.value(r);
    if (emp == null || v == null || !Number.isFinite(v)) continue;
    const type = byType ? r.terminalClass ?? "unknown" : "todos";
    items.push({ emp, group: `${r.cityKey ?? ""}|${type}`, city: r.cityKey ?? null, type, v });
  }
  const groups = new Map<string, typeof items>();
  for (const it of items) { const l = groups.get(it.group) ?? []; l.push(it); groups.set(it.group, l); }
  const gateByCity = new Map<string, { visible: boolean; label: string | null }>();
  const gateOf = (city: string | null) => {
    const k = city ?? "";
    let g = gateByCity.get(k);
    if (!g) { g = driverGateFor(rows, { metric: o.metric, cityKey: city, fromDay: o.fromDay, toDay: o.toDay, gpsGate: o.gpsGate }); gateByCity.set(k, g); }
    return g;
  };
  const out: DriverStat[] = [];
  for (const list of groups.values()) {
    const emps = [...new Set(list.map((x) => x.emp))];
    const gate = gateOf(list[0].city);
    for (const emp of emps) {
      const mine = list.filter((x) => x.emp === emp).map((x) => x.v);
      const others = list.filter((x) => x.emp !== emp);
      const me = statsOf(mine), peers = statsOf(others.map((x) => x.v));
      const enough = me.n >= minN;
      const show = gate.visible;
      const peersOk = show && peers.n >= minN;
      out.push({
        employeeId: emp, cityKey: list[0].city, serviceType: list[0].type, n: me.n, enough,
        meanMs: show && enough ? me.meanMs : null, p50Ms: show && enough ? me.p50Ms : null, p75Ms: show && enough ? me.p75Ms : null,
        peers: { drivers: new Set(others.map((x) => x.emp)).size, n: peers.n, meanMs: peersOk ? peers.meanMs : null, p50Ms: peersOk ? peers.p50Ms : null },
        deltaP50Ms: show && enough && peersOk && me.p50Ms != null && peers.p50Ms != null ? Math.round(me.p50Ms - peers.p50Ms) : null,
        gpsHidden: show ? null : gate.label, gpsLabel: show ? gate.label : null,
      });
    }
  }
  return out.sort((a, b) => String(a.cityKey).localeCompare(String(b.cityKey)) || a.serviceType.localeCompare(b.serviceType) || (b.p50Ms ?? -1) - (a.p50Ms ?? -1) || a.employeeId - b.employeeId);
}

/** Início da semana ISO (segunda) ou do mês de um dia. PURA. */
function bucketOf(day: string, bucket: "semana" | "mes"): string {
  if (bucket === "mes") return day.slice(0, 7);
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() || 7) - 1));
  return d.toISOString().slice(0, 10);
}

/**
 * A evolução de um condutor (por semana ou mês) para o gráfico: em cada
 * período, o p50 dele e o dos colegas nas MESMAS cidades e tipos de serviço
 * em que ele trabalhou nesse período. Sem n mínimo → sem número. Tempos com
 * GPS: as cidades com o portão fechado nesse período saem das contas; sem
 * nenhuma aberta, sem números e `gpsHidden` com o porquê. PURA.
 */
export function driverTimeSeries(rows: readonly DriverRowLike[], o: { metric: DriverMetric; employeeId: number; fromDay: string; toDay: string; bucket: "semana" | "mes"; minN?: number; gpsGate?: DriverGpsGate | null }): Array<{ period: string; n: number; p50Ms: number | null; meanMs: number | null; peersN: number; peersP50Ms: number | null; gpsHidden: string | null }> {
  const def = DRIVER_METRICS[o.metric];
  const minN = o.minN ?? Math.max(3, Math.round(DRIVER_STATS_MIN_N / 2));
  type Item = { emp: number; city: string; group: string; v: number };
  const per = new Map<string, { items: Item[]; cov: Map<string, { total: number; n: number }> }>();
  for (const r of rows) {
    if (!eligible(r, def, o.fromDay, o.toDay)) continue;
    const k = bucketOf(r.opDay, o.bucket);
    let b = per.get(k);
    if (!b) { b = { items: [], cov: new Map() }; per.set(k, b); }
    const city = r.cityKey ?? "";
    const v = def.value(r);
    const measuredHere = v != null && Number.isFinite(v);
    const c = b.cov.get(city) ?? { total: 0, n: 0 };
    c.total++;
    if (measuredHere) c.n++;
    b.cov.set(city, c);
    const emp = def.employee(r);
    if (emp != null && measuredHere) b.items.push({ emp, city, group: `${city}|${r.terminalClass ?? "unknown"}`, v: v! });
  }
  return [...per.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, b]) => {
    const mineAll = b.items.filter((x) => x.emp === o.employeeId);
    // portão (§8.1) por cidade e período: as cidades fechadas saem das contas (dele e dos colegas)
    let gpsHidden: string | null = null;
    const visibleCities = new Set<string>();
    for (const city of new Set(mineAll.map((x) => x.city))) {
      if (!def.gps) { visibleCities.add(city); continue; }
      const c = b.cov.get(city) ?? { total: 0, n: 0 };
      const g = gpsTimesVisible({ coveragePct: c.total ? (c.n / c.total) * 100 : 0, n: c.n, gate: o.gpsGate?.gate ?? DEFAULT_GPS_GATE, isSuperAdmin: !!o.gpsGate?.isSuperAdmin });
      if (g.visible) visibleCities.add(city); else gpsHidden ??= g.label;
    }
    const mine = mineAll.filter((x) => visibleCities.has(x.city));
    const groups = new Set(mine.map((x) => x.group));
    const me = statsOf(mine.map((x) => x.v));
    const peers = statsOf(b.items.filter((x) => x.emp !== o.employeeId && groups.has(x.group)).map((x) => x.v));
    if (mine.length) gpsHidden = null;
    return { period, n: mineAll.length, p50Ms: me.n >= minN ? me.p50Ms : null, meanMs: me.n >= minN ? me.meanMs : null, peersN: peers.n, peersP50Ms: peers.n >= minN ? peers.p50Ms : null, gpsHidden };
  }).filter((x) => x.n > 0);
}
