/**
 * TERMINAL PELO PERFIL — a parte com BD (plano 56, parte B, entrega B1).
 * Regras puras em shared/terminalSession.ts; ecrãs na barra do terminal
 * (DashboardLayout) e no cartão "Terminal agora" (Atividade diária → Ao vivo).
 *
 * Como funciona:
 *  - "Estou no terminal" (botão ou entrada do ponto): ponto aberto + GPS na
 *    zona do aeroporto de uma cidade onde a pessoa trabalha → abre uma sessão
 *    em `terminal_sessions`.
 *  - 1 por cidade e 1 por pessoa vêm das chaves únicas (`activeCityKey`,
 *    `activeEmployeeId`): a BD recusa (ER_DUP_ENTRY) e responde-se "ocupado",
 *    com quem está e desde quando.
 *  - Ocupado → pedido ao João (sino ao João e ao TL de serviço). O João
 *    "Passa" (troca numa só transação) ou "Ainda está". Se o João já não tem
 *    ponto aberto, o Pedro entra logo ("takeover", na mesma transação).
 *  - TL e acima, só da cidade: Pôr / Passar / Fechar, sempre com motivo.
 *  - A saída do ponto (e o fecho automático dos pontos esquecidos) liberta o
 *    lugar.
 *  - Horas que contam (B1): fecho com GPS dentro → até ao fecho; senão
 *    "pending" e tenta-se já a última recolha/entrega dele na Multipark (só
 *    leitura, teto curto). O resto ("Ainda estás?", GPS de 5 em 5 min,
 *    ordenado a partir das sessões) é do B2.
 *
 * Interruptor PONTO_TERMINAL desligado → nada abre e nada aparece. Nada se
 * apaga: fechar uma sessão é pôr `endedAt` e libertar as chaves.
 * Os passos com regras recebem as dependências (`TerminalDeps`) para os
 * testes correrem sem BD (server/terminalPerfil.test.ts).
 */
import type { AirportsMap } from "../shared/pontoTerminal";
import type { TerminalResolution } from "../shared/pontoTerminal";
import { lisbonClock } from "../shared/pontoTerminal";
import { roleRank } from "../shared/access";
import {
  TERMINAL_CITY_KEYS, TERMINAL_CITY_LABELS, TERMINAL_CITY_OF, TERMINAL_START_SOURCE_LABELS,
  canUseTerminal, closeCounting, firstName, fixInsideCity, handoverStillValid, isDupEntry, isTerminalCityKey,
  matchAirport, terminalBusyMessage, terminalLeftMessage, terminalPayUplift, terminalStartedMessage, toDbUtc, toMs,
  type GpsFix, type TerminalCityKey, type TerminalCountedBasis, type TerminalEndReason, type TerminalHandoverStatus, type TerminalStartSource,
} from "../shared/terminalSession";

// ─── Linhas ─────────────────────────────────────────────────────────────────

export interface TerminalSessionRow {
  id: number;
  employeeId: number;
  userId: number | null;
  cityKey: TerminalCityKey;
  startedAt: string;
  startLat: string | null;
  startLng: string | null;
  startAccuracy: number | null;
  startSource: TerminalStartSource;
  startedByUserId: number | null;
  endedAt: string | null;
  endReason: TerminalEndReason | null;
  endedByUserId: number | null;
  endLat: string | null;
  endLng: string | null;
  endNote: string | null;
  lastInsideAt: string | null;
  countedUntil: string | null;
  countedBasis: TerminalCountedBasis | null;
  payUplift: number;
  note: string | null;
  timeRecordId: number | null;
  activeCityKey: string | null;
  activeEmployeeId: number | null;
}

export type NewTerminalSession = Pick<TerminalSessionRow,
  "employeeId" | "userId" | "cityKey" | "startedAt" | "startLat" | "startLng" | "startAccuracy" | "startSource" |
  "startedByUserId" | "lastInsideAt" | "payUplift" | "note" | "timeRecordId">;

export interface CloseFields {
  endedAt: string;
  endReason: TerminalEndReason;
  endedByUserId: number | null;
  endLat: string | null;
  endLng: string | null;
  endNote: string | null;
  countedUntil: string | null;
  countedBasis: TerminalCountedBasis;
}

export interface HandoverRow {
  id: number;
  sessionId: number;
  cityKey: TerminalCityKey;
  holderEmployeeId: number;
  requesterEmployeeId: number;
  requesterUserId: number | null;
  requestedAt: string;
  reqLat: string | null;
  reqLng: string | null;
  reqAccuracy: number | null;
  status: TerminalHandoverStatus;
  answeredAt: string | null;
  answeredByUserId: number | null;
  newSessionId: number | null;
  note: string | null;
}

export type NewHandover = Pick<HandoverRow, "sessionId" | "cityKey" | "holderEmployeeId" | "requesterEmployeeId" | "requesterUserId" | "requestedAt" | "reqLat" | "reqLng" | "reqAccuracy">;

/** Operações na BD (as mesmas dentro e fora de uma transação). */
export interface TerminalStoreOps {
  openByEmployee(employeeId: number): Promise<TerminalSessionRow | null>;
  openByCity(city: TerminalCityKey): Promise<TerminalSessionRow | null>;
  openAll(): Promise<TerminalSessionRow[]>;
  byId(id: number): Promise<TerminalSessionRow | null>;
  /** Lança ER_DUP_ENTRY quando a cidade ou a pessoa já têm sessão aberta. */
  insert(row: NewTerminalSession): Promise<number>;
  /** Fecha só se ainda estiver aberta (liberta as chaves). true = fechou. */
  close(id: number, c: CloseFields): Promise<boolean>;
  /** Grava até onde contam as horas — só se ainda estiver "pending". */
  setCounted(id: number, countedUntil: string, basis: TerminalCountedBasis): Promise<boolean>;
  insertHandover(row: NewHandover): Promise<number>;
  handoverById(id: number): Promise<HandoverRow | null>;
  pendingHandovers(): Promise<HandoverRow[]>;
  /** Muda o estado de um pedido ainda pendente. true = mudou. */
  answerHandover(id: number, status: Exclude<TerminalHandoverStatus, "pending">, f: { answeredAt: string; answeredByUserId: number | null; newSessionId?: number | null; note?: string | null }): Promise<boolean>;
}

export interface TerminalStore extends TerminalStoreOps {
  /** Tudo ou nada: um erro desfaz o que se fez dentro. */
  transaction<T>(fn: (tx: TerminalStoreOps) => Promise<T>): Promise<T>;
}

// ─── Dependências ───────────────────────────────────────────────────────────

export interface TerminalPerson {
  id: number;
  fullName: string;
  position: string | null;
  contractType: string | null;
  userId: number | null;
  isActive: boolean;
}

export interface TerminalNotice {
  city: TerminalCityKey;
  targetUserIds: number[];
  title: string;
  body: string;
  entity: { type: string; id: string | number };
}

export interface TerminalDeps {
  store: TerminalStore;
  now(): number;
  /** Interruptor PONTO_TERMINAL. */
  enabled(): Promise<boolean>;
  airports(): Promise<AirportsMap>;
  person(employeeId: number): Promise<TerminalPerson | null>;
  /** Cidades onde a pessoa trabalha: ficha (centro de custos) + cidades dadas (`city.extra.*`). */
  personCities(employeeId: number): Promise<TerminalCityKey[]>;
  /** Entrada do ponto em aberto (a última picagem é uma entrada), ou null. */
  openClock(employeeId: number): Promise<{ timeRecordId: number; since: string } | null>;
  /** Contas da ficha (principal + extras). */
  userIdsOf(employeeId: number): Promise<number[]>;
  /** Contas do TL de serviço na cidade (escala do turno atual + TL com ponto aberto). */
  tlOnDuty(city: TerminalCityKey): Promise<number[]>;
  /** Pessoas com ponto aberto que podem ir para o terminal desta cidade (para o TL escolher). */
  candidates(city: TerminalCityKey): Promise<Array<{ employeeId: number; name: string; position: string | null }>>;
  notify(n: TerminalNotice): Promise<void>;
  log(e: { userId: number; action: string; entityId: number | null; details: string }): Promise<void>;
  /** Última recolha/entrega dele na Multipark dentro da sessão (só leitura, teto curto). Opcional. */
  lastService?(o: { employeeId: number; inAt: string; outAt: string }): Promise<TerminalResolution>;
}

/** Erro para mostrar à pessoa (o router converte em TRPCError). */
export class TerminalError extends Error {
  constructor(message: string, public readonly code: "BAD_REQUEST" | "FORBIDDEN" | "NOT_FOUND" = "BAD_REQUEST") {
    super(message);
    this.name = "TerminalError";
  }
}

// ─── Respostas ──────────────────────────────────────────────────────────────

export interface TerminalSessionView {
  id: number;
  employeeId: number;
  cityKey: TerminalCityKey;
  cityLabel: string;
  startedAt: string;
  startSource: TerminalStartSource;
  payUplift: boolean;
}

export interface TerminalBusy {
  status: "busy";
  cityKey: TerminalCityKey;
  sessionId: number;
  holderEmployeeId: number;
  holderName: string;
  holderFirstName: string;
  since: string;
  message: string;
  /** "Pedir ao João para passar" */
  requestLabel: string;
}

export type TerminalOpenResult =
  | { status: "started"; session: TerminalSessionView; message: string; takeoverFrom: string | null }
  | { status: "already"; session: TerminalSessionView; message: string }
  | TerminalBusy
  | { status: "refused"; reason: string; message: string }
  | { status: "need_checkin"; message: string }
  | { status: "off"; message: string };

const OFF_MESSAGE = "O terminal pelo perfil está desligado.";

function view(s: TerminalSessionRow): TerminalSessionView {
  return {
    id: s.id, employeeId: s.employeeId, cityKey: s.cityKey, cityLabel: TERMINAL_CITY_LABELS[s.cityKey] ?? s.cityKey,
    startedAt: s.startedAt, startSource: s.startSource, payUplift: Number(s.payUplift) === 1,
  };
}

const coord = (v: number | null | undefined): string | null => (v == null || !Number.isFinite(v) ? null : v.toFixed(7));
const acc = (v: number | null | undefined): number | null => (v == null || !Number.isFinite(v) ? null : Math.max(0, Math.round(v)));
const cut = (s: string | null | undefined, n = 255): string | null => (s == null ? null : String(s).slice(0, n));

async function nameOf(deps: TerminalDeps, employeeId: number): Promise<string> {
  try { return (await deps.person(employeeId))?.fullName || `Ficha ${employeeId}`; } catch { return `Ficha ${employeeId}`; }
}

async function safeNotify(deps: TerminalDeps, n: TerminalNotice): Promise<void> {
  try {
    const ids = Array.from(new Set(n.targetUserIds.filter((x) => Number.isInteger(x) && x > 0)));
    if (ids.length) await deps.notify({ ...n, targetUserIds: ids });
  } catch (err) {
    console.warn("[terminal] aviso falhou:", String((err as Error)?.message ?? err).slice(0, 160));
  }
}

async function safeLog(deps: TerminalDeps, e: { userId: number; action: string; entityId: number | null; details: string }): Promise<void> {
  try { await deps.log(e); } catch (err) { console.warn("[terminal] registo falhou:", String((err as Error)?.message ?? err).slice(0, 160)); }
}

/**
 * Horas que contam de uma sessão fechada sem GPS dentro ("pending"): tenta a
 * última recolha/entrega dele na Multipark dentro da sessão. Nunca lança;
 * sem nada → fica "pending" (B2 / o RH decidem).
 */
export async function settleCounted(deps: TerminalDeps, s: { id: number; employeeId: number; startedAt: string; endedAt: string }): Promise<TerminalCountedBasis> {
  if (!deps.lastService) return "pending";
  try {
    const r = await deps.lastService({ employeeId: s.employeeId, inAt: s.startedAt, outAt: s.endedAt });
    if (r.status === "partial" && (await deps.store.setCounted(s.id, r.terminalUntil, "last_service"))) return "last_service";
  } catch (err) {
    console.warn("[terminal] última recolha/entrega não lida:", String((err as Error)?.message ?? err).slice(0, 160));
  }
  return "pending";
}

/** Pedidos pendentes desta sessão ficam "cancelados" (o terminal mudou de mãos ou fechou). */
async function cancelPendingFor(tx: TerminalStoreOps, sessionId: number, at: string, byUserId: number | null, note: string): Promise<void> {
  for (const r of (await tx.pendingHandovers()).filter((h) => h.sessionId === sessionId)) {
    await tx.answerHandover(r.id, "cancelled", { answeredAt: at, answeredByUserId: byUserId, note });
  }
}

// ─── Abrir ──────────────────────────────────────────────────────────────────

interface OpenArgs {
  person: TerminalPerson;
  city: TerminalCityKey;
  clock: { timeRecordId: number; since: string };
  source: TerminalStartSource;
  actorUserId: number;
  fix: GpsFix | null;
  /** quando o GPS provou que está dentro (null = sem prova: TL) */
  insideAt: string | null;
  note?: string | null;
}

function newRow(a: OpenArgs, startedAt: string): NewTerminalSession {
  const lat = a.fix?.lat != null ? Number(a.fix.lat) : null;
  const lng = a.fix?.lng != null ? Number(a.fix.lng) : null;
  return {
    employeeId: a.person.id,
    userId: a.person.userId,
    cityKey: a.city,
    startedAt,
    startLat: coord(lat),
    startLng: coord(lng),
    startAccuracy: acc(a.fix?.accuracy ?? null),
    startSource: a.source,
    startedByUserId: a.actorUserId,
    lastInsideAt: a.insideAt,
    payUplift: terminalPayUplift(a.person),
    note: cut(a.note ?? null),
    timeRecordId: a.clock.timeRecordId,
  };
}

/** Sessão aberta da pessoa noutra cidade (ou na mesma) → resposta. */
function alreadyResult(mine: TerminalSessionRow, city: TerminalCityKey): TerminalOpenResult {
  if (mine.cityKey === city) return { status: "already", session: view(mine), message: terminalStartedMessage(mine.cityKey, mine.startedAt) };
  return { status: "refused", reason: "other_terminal", message: `Já estás no terminal ${TERMINAL_CITY_OF[mine.cityKey]} desde ${lisbonClock(mine.startedAt)}. Sai primeiro.` };
}

async function busyResult(deps: TerminalDeps, holder: TerminalSessionRow): Promise<TerminalBusy> {
  const name = await nameOf(deps, holder.employeeId);
  const first = firstName(name);
  return {
    status: "busy", cityKey: holder.cityKey, sessionId: holder.id, holderEmployeeId: holder.employeeId,
    holderName: name, holderFirstName: first, since: holder.startedAt,
    message: terminalBusyMessage(holder.cityKey, name, holder.startedAt),
    requestLabel: `Pedir a ${first} para passar`,
  };
}

/**
 * Abre a sessão na cidade: a BD decide (chaves únicas). Ocupado por quem já
 * não tem ponto aberto → o lugar passa logo para esta pessoa ("takeover"),
 * numa só transação, e fica registado.
 */
async function openInCity(deps: TerminalDeps, a: OpenArgs): Promise<TerminalOpenResult> {
  const nowMs = deps.now();
  const startedAt = toDbUtc(nowMs);
  const mine = await deps.store.openByEmployee(a.person.id);
  if (mine) return alreadyResult(mine, a.city);

  const holder = await deps.store.openByCity(a.city);
  if (holder) {
    const holderClock = await deps.openClock(holder.employeeId);
    if (holderClock) return busyResult(deps, holder);
    return takeover(deps, a, holder, startedAt);
  }

  let id: number;
  try {
    id = await deps.store.insert(newRow(a, startedAt));
  } catch (err) {
    if (!isDupEntry(err)) throw err;
    // Outra pessoa (ou outro toque) chegou primeiro: a BD recusou.
    const again = await deps.store.openByEmployee(a.person.id);
    if (again) return alreadyResult(again, a.city);
    const h = await deps.store.openByCity(a.city);
    if (h) return busyResult(deps, h);
    throw err;
  }
  await safeLog(deps, {
    userId: a.actorUserId, action: "terminal_start", entityId: id,
    details: `Terminal ${TERMINAL_CITY_OF[a.city]}: ${a.person.fullName} (${TERMINAL_START_SOURCE_LABELS[a.source]})${a.note ? ` — ${a.note}` : ""}`,
  });
  const session = (await deps.store.byId(id)) ?? ({ ...newRow(a, startedAt), id } as unknown as TerminalSessionRow);
  return { status: "started", session: view(session as TerminalSessionRow), message: terminalStartedMessage(a.city, startedAt), takeoverFrom: null };
}

/** O João já não tem ponto aberto: fecha a dele e abre a do Pedro, na MESMA transação. */
async function takeover(deps: TerminalDeps, a: OpenArgs, holder: TerminalSessionRow, startedAt: string): Promise<TerminalOpenResult> {
  const holderName = await nameOf(deps, holder.employeeId);
  let id: number;
  try {
    id = await deps.store.transaction(async (tx) => {
      const closed = await tx.close(holder.id, {
        endedAt: startedAt, endReason: "checkout", endedByUserId: a.actorUserId, endLat: null, endLng: null,
        endNote: cut(`Lugar passou para ${a.person.fullName}: ${holderName} já não tinha o ponto aberto.`),
        countedUntil: null, countedBasis: "pending",
      });
      if (!closed) throw new TerminalError("O terminal mudou entretanto. Tenta outra vez.");
      await cancelPendingFor(tx, holder.id, startedAt, a.actorUserId, `Lugar passou para ${a.person.fullName}`);
      return tx.insert(newRow({ ...a, source: "takeover" }, startedAt));
    });
  } catch (err) {
    if (!isDupEntry(err)) throw err;
    const again = await deps.store.openByEmployee(a.person.id);
    if (again) return alreadyResult(again, a.city);
    const h = await deps.store.openByCity(a.city);
    if (h) return busyResult(deps, h);
    throw err;
  }
  await settleCounted(deps, { id: holder.id, employeeId: holder.employeeId, startedAt: holder.startedAt, endedAt: startedAt });
  await safeLog(deps, {
    userId: a.actorUserId, action: "terminal_takeover", entityId: id,
    details: `Terminal ${TERMINAL_CITY_OF[a.city]}: ${a.person.fullName} ficou com o lugar de ${holderName} (sem ponto aberto; sessão ${holder.id} fechada)`,
  });
  await safeNotify(deps, {
    city: a.city,
    targetUserIds: [...(await deps.userIdsOf(holder.employeeId)), ...(await deps.tlOnDuty(a.city))].filter((u) => u !== a.actorUserId),
    title: `${a.person.fullName} ficou com o terminal ${TERMINAL_CITY_OF[a.city]}`,
    body: `${holderName} já não tinha o ponto aberto: o lugar passou para ${a.person.fullName} às ${lisbonClock(startedAt)}.`,
    entity: { type: "terminal_session", id },
  });
  const session = await deps.store.byId(id);
  return {
    status: "started",
    session: view(session ?? ({ ...newRow(a, startedAt), id, startSource: "takeover" } as unknown as TerminalSessionRow)),
    message: `${terminalStartedMessage(a.city, startedAt)} ${firstName(holderName)} já não tinha o ponto aberto.`,
    takeoverFrom: holderName,
  };
}

/** Pessoa, ponto aberto e GPS na zona de uma cidade dela → cidade; senão a resposta a dar. */
async function checkPerson(deps: TerminalDeps, employeeId: number, fix: GpsFix | null):
  Promise<{ ok: true; person: TerminalPerson; clock: { timeRecordId: number; since: string }; city: TerminalCityKey } | { ok: false; result: TerminalOpenResult }> {
  const person = await deps.person(employeeId);
  if (!person || !person.isActive) return { ok: false, result: { status: "refused", reason: "no_employee", message: "A tua conta não está ligada a uma ficha ativa." } };
  if (!canUseTerminal(person)) return { ok: false, result: { status: "refused", reason: "position", message: "O terminal é para extras, condutores e team leaders." } };
  const clock = await deps.openClock(employeeId);
  if (!clock) return { ok: false, result: { status: "need_checkin", message: "Dá entrada no ponto primeiro (com \"Estou no terminal\" marcado)." } };
  const m = matchAirport(fix, await deps.airports(), await deps.personCities(employeeId));
  if (!m.ok) return { ok: false, result: { status: "refused", reason: m.reason, message: m.message } };
  return { ok: true, person, clock, city: m.city };
}

/**
 * "Estou no terminal" (botão ou entrada do ponto). Nunca lança erros da regra:
 * devolve started / already / busy / refused / need_checkin / off.
 */
export async function startTerminal(deps: TerminalDeps, o: { employeeId: number; actorUserId: number; fix: GpsFix | null; source: "button" | "checkin" }): Promise<TerminalOpenResult> {
  if (!(await deps.enabled())) return { status: "off", message: OFF_MESSAGE };
  const c = await checkPerson(deps, o.employeeId, o.fix);
  if (!c.ok) return c.result;
  return openInCity(deps, { person: c.person, city: c.city, clock: c.clock, source: o.source, actorUserId: o.actorUserId, fix: o.fix, insideAt: toDbUtc(deps.now()) });
}

// ─── Sair / libertar ────────────────────────────────────────────────────────

/** "Sair" do terminal (a própria pessoa). */
export async function stopTerminal(deps: TerminalDeps, o: { employeeId: number; actorUserId: number; fix: GpsFix | null }): Promise<{ message: string; cityKey: TerminalCityKey; startedAt: string; endedAt: string; countedBasis: TerminalCountedBasis }> {
  if (!(await deps.enabled())) throw new TerminalError(OFF_MESSAGE);
  const s = await deps.store.openByEmployee(o.employeeId);
  if (!s) throw new TerminalError("Não estás no terminal.");
  const endedMs = Math.max(deps.now(), toMs(s.startedAt));
  const endedAt = toDbUtc(endedMs);
  const inside = fixInsideCity(o.fix, await deps.airports(), s.cityKey);
  const counting = closeCounting({ endedAtMs: endedMs, insideAtClose: inside });
  const closed = await deps.store.close(s.id, {
    endedAt, endReason: "button", endedByUserId: o.actorUserId,
    endLat: coord(o.fix?.lat != null ? Number(o.fix.lat) : null), endLng: coord(o.fix?.lng != null ? Number(o.fix.lng) : null),
    endNote: null, ...counting,
  });
  if (!closed) throw new TerminalError("Já não estavas no terminal.");
  await deps.store.transaction((tx) => cancelPendingFor(tx, s.id, endedAt, o.actorUserId, "Saiu do terminal"));
  const basis = counting.countedBasis === "pending" ? await settleCounted(deps, { id: s.id, employeeId: s.employeeId, startedAt: s.startedAt, endedAt }) : counting.countedBasis;
  await safeLog(deps, { userId: o.actorUserId, action: "terminal_stop", entityId: s.id, details: `Saiu do terminal ${TERMINAL_CITY_OF[s.cityKey]} (${basis === "gps_close" ? "GPS dentro" : basis === "last_service" ? "até à última recolha/entrega" : "por confirmar"})` });
  return { message: terminalLeftMessage(s.startedAt, endedAt), cityKey: s.cityKey, startedAt: s.startedAt, endedAt, countedBasis: basis };
}

/**
 * Saída do ponto (ou fecho automático do ponto esquecido): liberta o lugar.
 * Corre com o interruptor desligado também (uma sessão que ficou aberta não
 * pode prender a cidade). Nunca lança; sem sessão → null.
 */
export async function releaseOnCheckout(deps: TerminalDeps, o: {
  employeeId: number; actorUserId: number | null; endedAtMs: number; fix: GpsFix | null;
  reason: "checkout" | "stale_checkout"; forgotten?: boolean; settle?: boolean;
}): Promise<{ message: string; cityKey: TerminalCityKey; startedAt: string; endedAt: string } | null> {
  try {
    const s = await deps.store.openByEmployee(o.employeeId);
    if (!s) return null;
    const endedMs = Math.max(o.endedAtMs, toMs(s.startedAt));
    const endedAt = toDbUtc(endedMs);
    const inside = o.reason === "checkout" ? fixInsideCity(o.fix, await deps.airports(), s.cityKey) : null;
    const counting = closeCounting({ endedAtMs: endedMs, insideAtClose: inside, forgotten: o.forgotten || o.reason === "stale_checkout" });
    const closed = await deps.store.close(s.id, {
      endedAt, endReason: o.reason, endedByUserId: o.actorUserId,
      endLat: coord(o.fix?.lat != null ? Number(o.fix.lat) : null), endLng: coord(o.fix?.lng != null ? Number(o.fix.lng) : null),
      endNote: o.reason === "stale_checkout" ? "Ponto esquecido fechado sozinho" : null, ...counting,
    });
    if (!closed) return null;
    await deps.store.transaction((tx) => cancelPendingFor(tx, s.id, endedAt, o.actorUserId, "Saída do ponto"));
    if (counting.countedBasis === "pending" && o.settle) await settleCounted(deps, { id: s.id, employeeId: s.employeeId, startedAt: s.startedAt, endedAt });
    await safeLog(deps, { userId: o.actorUserId ?? 0, action: "terminal_release", entityId: s.id, details: `Terminal ${TERMINAL_CITY_OF[s.cityKey]} libertado (${o.reason === "checkout" ? "saída do ponto" : "ponto esquecido fechado sozinho"})` });
    return { message: terminalLeftMessage(s.startedAt, endedAt), cityKey: s.cityKey, startedAt: s.startedAt, endedAt };
  } catch (err) {
    console.warn("[terminal] lugar não libertado na saída do ponto:", String((err as Error)?.message ?? err).slice(0, 160));
    return null;
  }
}

// ─── Troca ──────────────────────────────────────────────────────────────────

export type HandoverRequestResult =
  | { status: "requested"; requestId: number; message: string }
  | TerminalOpenResult;

/** "Pedir ao João para passar". Sem ponto do João → entra logo (takeover). */
export async function requestHandover(deps: TerminalDeps, o: { employeeId: number; actorUserId: number; fix: GpsFix | null }): Promise<HandoverRequestResult> {
  if (!(await deps.enabled())) return { status: "off", message: OFF_MESSAGE };
  const c = await checkPerson(deps, o.employeeId, o.fix);
  if (!c.ok) return c.result;
  const nowMs = deps.now();
  const at = toDbUtc(nowMs);
  const mine = await deps.store.openByEmployee(c.person.id);
  if (mine) return alreadyResult(mine, c.city);
  const holder = await deps.store.openByCity(c.city);
  // livre, ou o João já não tem ponto aberto → entra (takeover numa transação)
  if (!holder || !(await deps.openClock(holder.employeeId))) {
    return openInCity(deps, { person: c.person, city: c.city, clock: c.clock, source: "button", actorUserId: o.actorUserId, fix: o.fix, insideAt: at });
  }
  const holderName = await nameOf(deps, holder.employeeId);
  const existing = (await deps.store.pendingHandovers()).find((h) => h.sessionId === holder.id && h.requesterEmployeeId === c.person.id && handoverStillValid(h, nowMs));
  const requestId = existing?.id ?? await deps.store.insertHandover({
    sessionId: holder.id, cityKey: c.city, holderEmployeeId: holder.employeeId, requesterEmployeeId: c.person.id, requesterUserId: o.actorUserId,
    requestedAt: at, reqLat: coord(o.fix?.lat != null ? Number(o.fix.lat) : null), reqLng: coord(o.fix?.lng != null ? Number(o.fix.lng) : null),
    reqAccuracy: acc(o.fix?.accuracy ?? null),
  });
  if (!existing) {
    await safeLog(deps, { userId: o.actorUserId, action: "terminal_request", entityId: holder.id, details: `${c.person.fullName} pediu o terminal ${TERMINAL_CITY_OF[c.city]} a ${holderName} (pedido ${requestId})` });
  }
  const me = new Set(await deps.userIdsOf(c.person.id));
  await safeNotify(deps, {
    city: c.city,
    targetUserIds: [...(await deps.userIdsOf(holder.employeeId)), ...(await deps.tlOnDuty(c.city))].filter((u) => !me.has(u)),
    title: `${c.person.fullName} pede o terminal ${TERMINAL_CITY_OF[c.city]}`,
    body: `${holderName} está no terminal desde ${lisbonClock(holder.startedAt)}. Abre a app: "Passar" ou "Ainda estou".`,
    entity: { type: "terminal_handover", id: requestId },
  });
  return { status: "requested", requestId, message: `Pedido enviado a ${firstName(holderName)}. Espera pela resposta.` };
}

/** O João responde: "Passar" (troca numa só transação) ou "Ainda estou". */
export async function answerHandover(deps: TerminalDeps, o: { employeeId: number; actorUserId: number; requestId: number; answer: "pass" | "stay"; fix: GpsFix | null }): Promise<{ status: "passed" | "declined"; message: string; newSessionId?: number }> {
  if (!(await deps.enabled())) throw new TerminalError(OFF_MESSAGE);
  const nowMs = deps.now();
  const at = toDbUtc(nowMs);
  const req = await deps.store.handoverById(o.requestId);
  if (!req) throw new TerminalError("Pedido não encontrado.", "NOT_FOUND");
  if (req.holderEmployeeId !== o.employeeId) throw new TerminalError("Este pedido não é para ti.", "FORBIDDEN");
  if (req.status !== "pending") throw new TerminalError("Este pedido já foi respondido.");
  const session = await deps.store.byId(req.sessionId);
  if (!session || session.endedAt || session.employeeId !== o.employeeId) {
    await deps.store.answerHandover(req.id, "cancelled", { answeredAt: at, answeredByUserId: o.actorUserId, note: "Já não estava no terminal" });
    throw new TerminalError("Já não estás no terminal.");
  }
  if (!handoverStillValid(req, nowMs)) {
    await deps.store.answerHandover(req.id, "expired", { answeredAt: at, answeredByUserId: o.actorUserId });
    throw new TerminalError("O pedido caducou. O colega tem de pedir outra vez.");
  }
  const requester = await deps.person(req.requesterEmployeeId);
  const requesterName = requester?.fullName || `Ficha ${req.requesterEmployeeId}`;
  const holderName = await nameOf(deps, o.employeeId);
  const city = session.cityKey;
  const requesterUsers = await deps.userIdsOf(req.requesterEmployeeId);

  if (o.answer === "stay") {
    await deps.store.answerHandover(req.id, "declined", { answeredAt: at, answeredByUserId: o.actorUserId });
    await safeLog(deps, { userId: o.actorUserId, action: "terminal_stay", entityId: session.id, details: `${holderName} ainda está no terminal ${TERMINAL_CITY_OF[city]} (pedido de ${requesterName})` });
    await safeNotify(deps, {
      city, targetUserIds: requesterUsers,
      title: `${holderName} ainda está no terminal ${TERMINAL_CITY_OF[city]}`,
      body: `Respondeu "Ainda estou" ao teu pedido. Fala com o teu TL se for preciso.`,
      entity: { type: "terminal_handover_answer", id: req.id },
    });
    return { status: "declined", message: `Ficaste no terminal. Já dissemos a ${firstName(requesterName)}.` };
  }

  // "Passar": o colega ainda tem de poder entrar
  const clock = requester ? await deps.openClock(requester.id) : null;
  if (!requester || !requester.isActive || !canUseTerminal(requester) || !clock) {
    await deps.store.answerHandover(req.id, "cancelled", { answeredAt: at, answeredByUserId: o.actorUserId, note: "O colega já não tem o ponto aberto" });
    throw new TerminalError(`${requesterName} já não tem o ponto aberto. Ficas no terminal.`);
  }
  const inside = fixInsideCity(o.fix, await deps.airports(), city);
  const counting = closeCounting({ endedAtMs: nowMs, insideAtClose: inside });
  const reqFix: GpsFix = { lat: req.reqLat != null ? Number(req.reqLat) : null, lng: req.reqLng != null ? Number(req.reqLng) : null, accuracy: req.reqAccuracy };
  let newId: number;
  try {
    newId = await deps.store.transaction(async (tx) => {
      const closed = await tx.close(session.id, {
        endedAt: at, endReason: "handover", endedByUserId: o.actorUserId,
        endLat: coord(o.fix?.lat != null ? Number(o.fix.lat) : null), endLng: coord(o.fix?.lng != null ? Number(o.fix.lng) : null),
        endNote: cut(`Passou a ${requesterName}`), ...counting,
      });
      if (!closed) throw new TerminalError("Já não estás no terminal.");
      const id = await tx.insert(newRow({
        person: requester, city, clock, source: "handover", actorUserId: o.actorUserId, fix: reqFix, insideAt: req.requestedAt,
        note: `Passado por ${holderName}`,
      }, at));
      await tx.answerHandover(req.id, "passed", { answeredAt: at, answeredByUserId: o.actorUserId, newSessionId: id });
      await cancelPendingFor(tx, session.id, at, o.actorUserId, `O terminal passou para ${requesterName}`);
      return id;
    });
  } catch (err) {
    if (isDupEntry(err)) {
      // (a transação desfez tudo: o João continua no terminal)
      await deps.store.answerHandover(req.id, "cancelled", { answeredAt: at, answeredByUserId: o.actorUserId, note: "O colega já está noutro terminal" });
      throw new TerminalError(`Não deu para passar: ${requesterName} já está noutro terminal. Ficas no terminal.`);
    }
    throw err;
  }
  if (counting.countedBasis === "pending") await settleCounted(deps, { id: session.id, employeeId: session.employeeId, startedAt: session.startedAt, endedAt: at });
  await safeLog(deps, { userId: o.actorUserId, action: "terminal_handover", entityId: newId, details: `${holderName} passou o terminal ${TERMINAL_CITY_OF[city]} a ${requesterName} (sessão ${session.id} → ${newId})` });
  await safeNotify(deps, {
    city, targetUserIds: requesterUsers,
    title: `${holderName} passou-te o terminal ${TERMINAL_CITY_OF[city]}`,
    body: `${terminalStartedMessage(city, at)}`,
    entity: { type: "terminal_handover_answer", id: req.id },
  });
  return { status: "passed", message: `Passaste o terminal a ${firstName(requesterName)}. ${terminalLeftMessage(session.startedAt, at)}`, newSessionId: newId };
}

// ─── TL e supervisor ────────────────────────────────────────────────────────

export interface TerminalActor { userId: number; role: string; cities: readonly TerminalCityKey[] }

function assertTl(actor: TerminalActor, city: TerminalCityKey): void {
  if (roleRank(actor.role) < roleRank("team_leader")) throw new TerminalError("Só o team leader (ou acima) mexe no terminal dos outros.", "FORBIDDEN");
  if (!actor.cities.includes(city)) throw new TerminalError(`Só podes mexer no terminal das tuas cidades (${TERMINAL_CITY_LABELS[city]} não é tua).`, "FORBIDDEN");
}

async function assertTarget(deps: TerminalDeps, employeeId: number, city: TerminalCityKey): Promise<{ person: TerminalPerson; clock: { timeRecordId: number; since: string } }> {
  const person = await deps.person(employeeId);
  if (!person || !person.isActive) throw new TerminalError("Ficha não encontrada ou inativa.", "NOT_FOUND");
  if (!canUseTerminal(person)) throw new TerminalError("O terminal é para extras, condutores e team leaders.");
  const clock = await deps.openClock(employeeId);
  if (!clock) throw new TerminalError(`${person.fullName} não tem o ponto aberto.`);
  if (!(await deps.personCities(employeeId)).includes(city)) throw new TerminalError(`${person.fullName} não trabalha em ${TERMINAL_CITY_LABELS[city]}.`);
  const mine = await deps.store.openByEmployee(employeeId);
  if (mine) throw new TerminalError(`${person.fullName} já está no terminal ${TERMINAL_CITY_OF[mine.cityKey]} desde ${lisbonClock(mine.startedAt)}.`);
  return { person, clock };
}

const reasonOf = (r: string): string => {
  const t = String(r ?? "").trim();
  if (t.length < 3) throw new TerminalError("Escreve o motivo (mín. 3 letras).");
  return t.slice(0, 200);
};

/** TL: "Pôr" alguém no terminal (sem GPS), com motivo. */
export async function tlPut(deps: TerminalDeps, actor: TerminalActor, o: { city: TerminalCityKey; employeeId: number; reason: string }): Promise<{ message: string; sessionId: number }> {
  if (!(await deps.enabled())) throw new TerminalError(OFF_MESSAGE);
  assertTl(actor, o.city);
  const reason = reasonOf(o.reason);
  const { person, clock } = await assertTarget(deps, o.employeeId, o.city);
  const holder = await deps.store.openByCity(o.city);
  if (holder) throw new TerminalError(`${terminalBusyMessage(o.city, await nameOf(deps, holder.employeeId), holder.startedAt)} Usa "Passar".`);
  const startedAt = toDbUtc(deps.now());
  let id: number;
  try {
    id = await deps.store.insert(newRow({ person, city: o.city, clock, source: "tl", actorUserId: actor.userId, fix: null, insideAt: null, note: reason }, startedAt));
  } catch (err) {
    if (!isDupEntry(err)) throw err;
    const h = await deps.store.openByCity(o.city);
    throw new TerminalError(h ? `${terminalBusyMessage(o.city, await nameOf(deps, h.employeeId), h.startedAt)} Usa "Passar".` : `${person.fullName} já está noutro terminal.`);
  }
  await safeLog(deps, { userId: actor.userId, action: "terminal_tl_put", entityId: id, details: `TL pôs ${person.fullName} no terminal ${TERMINAL_CITY_OF[o.city]} — ${reason}` });
  await safeNotify(deps, {
    city: o.city, targetUserIds: (await deps.userIdsOf(person.id)).filter((u) => u !== actor.userId),
    title: `Estás no terminal ${TERMINAL_CITY_OF[o.city]}`,
    body: `O TL pôs-te no terminal às ${lisbonClock(startedAt)}. Motivo: ${reason}`,
    entity: { type: "terminal_session", id },
  });
  return { message: `${person.fullName} está no terminal ${TERMINAL_CITY_OF[o.city]}.`, sessionId: id };
}

/** TL: "Passar" o terminal de quem lá está para outra pessoa, numa só transação, com motivo. */
export async function tlPass(deps: TerminalDeps, actor: TerminalActor, o: { city: TerminalCityKey; toEmployeeId: number; reason: string }): Promise<{ message: string; sessionId: number }> {
  if (!(await deps.enabled())) throw new TerminalError(OFF_MESSAGE);
  assertTl(actor, o.city);
  const reason = reasonOf(o.reason);
  const current = await deps.store.openByCity(o.city);
  if (!current) throw new TerminalError(`O terminal ${TERMINAL_CITY_OF[o.city]} está livre. Usa "Pôr".`);
  if (current.employeeId === o.toEmployeeId) throw new TerminalError("Essa pessoa já está no terminal.");
  const { person, clock } = await assertTarget(deps, o.toEmployeeId, o.city);
  const fromName = await nameOf(deps, current.employeeId);
  const at = toDbUtc(Math.max(deps.now(), toMs(current.startedAt)));
  let id: number;
  try {
    id = await deps.store.transaction(async (tx) => {
      const closed = await tx.close(current.id, {
        endedAt: at, endReason: "tl", endedByUserId: actor.userId, endLat: null, endLng: null,
        endNote: cut(`TL passou a ${person.fullName}: ${reason}`), countedUntil: null, countedBasis: "pending",
      });
      if (!closed) throw new TerminalError("O terminal mudou entretanto. Vê outra vez.");
      await cancelPendingFor(tx, current.id, at, actor.userId, `TL passou o terminal a ${person.fullName}`);
      return tx.insert(newRow({ person, city: o.city, clock, source: "tl", actorUserId: actor.userId, fix: null, insideAt: null, note: reason }, at));
    });
  } catch (err) {
    if (isDupEntry(err)) throw new TerminalError(`Não deu para passar: ${person.fullName} já está noutro terminal.`);
    throw err;
  }
  await settleCounted(deps, { id: current.id, employeeId: current.employeeId, startedAt: current.startedAt, endedAt: at });
  await safeLog(deps, { userId: actor.userId, action: "terminal_tl_pass", entityId: id, details: `TL passou o terminal ${TERMINAL_CITY_OF[o.city]} de ${fromName} a ${person.fullName} — ${reason}` });
  await safeNotify(deps, {
    city: o.city, targetUserIds: (await deps.userIdsOf(current.employeeId)).filter((u) => u !== actor.userId),
    title: `Saíste do terminal ${TERMINAL_CITY_OF[o.city]}`,
    body: `O TL passou o terminal a ${person.fullName}. Motivo: ${reason}`,
    entity: { type: "terminal_session", id: current.id },
  });
  await safeNotify(deps, {
    city: o.city, targetUserIds: (await deps.userIdsOf(person.id)).filter((u) => u !== actor.userId),
    title: `Estás no terminal ${TERMINAL_CITY_OF[o.city]}`,
    body: `O TL passou-te o terminal às ${lisbonClock(at)}. Motivo: ${reason}`,
    entity: { type: "terminal_session", id },
  });
  return { message: `O terminal ${TERMINAL_CITY_OF[o.city]} passou de ${fromName} para ${person.fullName}.`, sessionId: id };
}

/** TL: "Fechar" o terminal da cidade, com motivo. */
export async function tlClose(deps: TerminalDeps, actor: TerminalActor, o: { city: TerminalCityKey; reason: string }): Promise<{ message: string }> {
  if (!(await deps.enabled())) throw new TerminalError(OFF_MESSAGE);
  assertTl(actor, o.city);
  const reason = reasonOf(o.reason);
  const current = await deps.store.openByCity(o.city);
  if (!current) throw new TerminalError(`O terminal ${TERMINAL_CITY_OF[o.city]} já está livre.`);
  const name = await nameOf(deps, current.employeeId);
  const at = toDbUtc(Math.max(deps.now(), toMs(current.startedAt)));
  const closed = await deps.store.transaction(async (tx) => {
    const ok = await tx.close(current.id, {
      endedAt: at, endReason: "tl", endedByUserId: actor.userId, endLat: null, endLng: null,
      endNote: cut(`Fechado pelo TL: ${reason}`), countedUntil: null, countedBasis: "pending",
    });
    if (ok) await cancelPendingFor(tx, current.id, at, actor.userId, "O TL fechou o terminal");
    return ok;
  });
  if (!closed) throw new TerminalError("O terminal mudou entretanto. Vê outra vez.");
  await settleCounted(deps, { id: current.id, employeeId: current.employeeId, startedAt: current.startedAt, endedAt: at });
  await safeLog(deps, { userId: actor.userId, action: "terminal_tl_close", entityId: current.id, details: `TL fechou o terminal ${TERMINAL_CITY_OF[o.city]} (${name}) — ${reason}` });
  await safeNotify(deps, {
    city: o.city, targetUserIds: (await deps.userIdsOf(current.employeeId)).filter((u) => u !== actor.userId),
    title: `Saíste do terminal ${TERMINAL_CITY_OF[o.city]}`,
    body: `O TL fechou o terminal às ${lisbonClock(at)}. Motivo: ${reason}`,
    entity: { type: "terminal_session", id: current.id },
  });
  return { message: `Terminal ${TERMINAL_CITY_OF[o.city]} fechado (${name}).` };
}

// ─── Leituras ───────────────────────────────────────────────────────────────

export interface TerminalStatus {
  enabled: boolean;
  /** pode usar o terminal (posto) */
  eligible: boolean;
  clockOpen: boolean;
  session: TerminalSessionView | null;
  /** alguém pede o meu lugar */
  incoming: { requestId: number; requesterName: string; requesterFirstName: string; requestedAt: string } | null;
  /** o meu pedido, à espera */
  outgoing: { requestId: number; cityKey: TerminalCityKey; holderName: string; holderFirstName: string; requestedAt: string } | null;
}

/** Estado do terminal da própria pessoa (barra fina, menu da foto). */
export async function terminalStatus(deps: TerminalDeps, employeeId: number | null): Promise<TerminalStatus> {
  const empty: TerminalStatus = { enabled: false, eligible: false, clockOpen: false, session: null, incoming: null, outgoing: null };
  if (!(await deps.enabled())) return empty;
  if (employeeId == null) return { ...empty, enabled: true };
  const person = await deps.person(employeeId);
  const eligible = !!person && person.isActive && canUseTerminal(person);
  const [clock, mine, pending] = await Promise.all([deps.openClock(employeeId), deps.store.openByEmployee(employeeId), deps.store.pendingHandovers()]);
  const nowMs = deps.now();
  const valid = pending.filter((h) => handoverStillValid(h, nowMs));
  const inc = mine ? valid.filter((h) => h.sessionId === mine.id).sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))[0] ?? null : null;
  const out = valid.filter((h) => h.requesterEmployeeId === employeeId).sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))[0] ?? null;
  const incName = inc ? await nameOf(deps, inc.requesterEmployeeId) : "";
  const outName = out ? await nameOf(deps, out.holderEmployeeId) : "";
  return {
    enabled: true, eligible, clockOpen: !!clock,
    session: mine ? view(mine) : null,
    incoming: inc ? { requestId: inc.id, requesterName: incName, requesterFirstName: firstName(incName), requestedAt: inc.requestedAt } : null,
    outgoing: out ? { requestId: out.id, cityKey: out.cityKey, holderName: outName, holderFirstName: firstName(outName), requestedAt: out.requestedAt } : null,
  };
}

export interface TerminalCityLive {
  cityKey: TerminalCityKey;
  cityLabel: string;
  session: (TerminalSessionView & { name: string; sourceLabel: string; note: string | null; clockOpen: boolean }) | null;
  requests: Array<{ requestId: number; requesterName: string; requestedAt: string }>;
  canManage: boolean;
  candidates: Array<{ employeeId: number; name: string; position: string | null }>;
}

/** "Terminal agora" (Atividade diária → Ao vivo): por cidade, quem está e desde quando, + ações do TL. */
export async function liveByCity(deps: TerminalDeps, o: { cities: readonly TerminalCityKey[]; manage: readonly TerminalCityKey[] }): Promise<{ enabled: boolean; cities: TerminalCityLive[] }> {
  if (!(await deps.enabled())) return { enabled: false, cities: [] };
  const open = await deps.store.openAll();
  const nowMs = deps.now();
  const pending = (await deps.store.pendingHandovers()).filter((h) => handoverStillValid(h, nowMs));
  const out: TerminalCityLive[] = [];
  for (const city of TERMINAL_CITY_KEYS.filter((c) => o.cities.includes(c))) {
    const s = open.find((x) => x.cityKey === city) ?? null;
    const canManage = o.manage.includes(city);
    const requests = s ? await Promise.all(pending.filter((h) => h.sessionId === s.id).map(async (h) => ({ requestId: h.id, requesterName: await nameOf(deps, h.requesterEmployeeId), requestedAt: h.requestedAt }))) : [];
    out.push({
      cityKey: city, cityLabel: TERMINAL_CITY_LABELS[city],
      session: s ? { ...view(s), name: await nameOf(deps, s.employeeId), sourceLabel: TERMINAL_START_SOURCE_LABELS[s.startSource] ?? s.startSource, note: s.note, clockOpen: !!(await deps.openClock(s.employeeId)) } : null,
      requests,
      canManage,
      candidates: canManage ? (await deps.candidates(city)).filter((p) => p.employeeId !== s?.employeeId) : [],
    });
  }
  return { enabled: true, cities: out };
}

/** O GPS desta entrada/saída está no aeroporto (para não marcar "fora do raio")? 1/0/null. */
export async function airportFlagFor(deps: TerminalDeps, employeeId: number, fix: GpsFix | null, city?: TerminalCityKey | null): Promise<0 | 1 | null> {
  try {
    if (!(await deps.enabled())) return null;
    const airports = await deps.airports();
    if (city) { const r = fixInsideCity(fix, airports, city); return r == null ? null : r ? 1 : 0; }
    const m = matchAirport(fix, airports, await deps.personCities(employeeId));
    return m.ok ? 1 : m.reason === "outside" || m.reason === "other_city" ? 0 : null;
  } catch {
    return null;
  }
}

// ═══ Implementação com a BD (produção) ══════════════════════════════════════

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const affected = (res: unknown): number => Number((res as any)?.[0]?.affectedRows ?? (res as any)?.affectedRows ?? 0);

function mysqlOps(db: any, t: { s: any; h: any }, d: { and: any; eq: any; isNull: any; isNotNull: any; desc: any }): TerminalStoreOps {
  const { s, h } = t;
  const { and, eq, isNull, isNotNull, desc } = d;
  const one = async (q: Promise<any[]>) => ((await q)[0] as any) ?? null;
  return {
    openByEmployee: (employeeId) => one(db.select().from(s).where(eq(s.activeEmployeeId, employeeId)).limit(1)),
    openByCity: (city) => one(db.select().from(s).where(eq(s.activeCityKey, city)).limit(1)),
    openAll: () => db.select().from(s).where(isNotNull(s.activeCityKey)),
    byId: (id) => one(db.select().from(s).where(eq(s.id, id)).limit(1)),
    insert: async (row) => {
      const ins = await db.insert(s).values({ ...row, activeCityKey: row.cityKey, activeEmployeeId: row.employeeId });
      return Number((ins as any)?.[0]?.insertId ?? 0);
    },
    close: async (id, c) => affected(await db.update(s).set({ ...c, activeCityKey: null, activeEmployeeId: null }).where(and(eq(s.id, id), isNull(s.endedAt)))) > 0,
    setCounted: async (id, countedUntil, basis) => affected(await db.update(s).set({ countedUntil, countedBasis: basis }).where(and(eq(s.id, id), eq(s.countedBasis, "pending")))) > 0,
    insertHandover: async (row) => {
      const ins = await db.insert(h).values({ ...row, status: "pending" });
      return Number((ins as any)?.[0]?.insertId ?? 0);
    },
    handoverById: (id) => one(db.select().from(h).where(eq(h.id, id)).limit(1)),
    pendingHandovers: () => db.select().from(h).where(eq(h.status, "pending")).orderBy(desc(h.requestedAt)).limit(200),
    answerHandover: async (id, status, f) => affected(await db.update(h).set({
      status, answeredAt: f.answeredAt, answeredByUserId: f.answeredByUserId,
      ...(f.newSessionId != null ? { newSessionId: f.newSessionId } : {}),
      ...(f.note != null ? { note: String(f.note).slice(0, 255) } : {}),
    }).where(and(eq(h.id, id), eq(h.status, "pending")))) > 0,
  };
}

/** Loja na BD (as chaves únicas de `terminal_sessions` fazem a regra 1 por cidade / 1 por pessoa). */
export async function mysqlTerminalStore(): Promise<TerminalStore> {
  const [{ getDb }, schema, orm] = await Promise.all([import("./db"), import("../drizzle/schema"), import("drizzle-orm")]);
  const db = await getDb();
  if (!db) throw new TerminalError("Base de dados indisponível. Tenta outra vez.");
  const t = { s: schema.terminalSessions, h: schema.terminalHandoverRequests };
  const d = { and: orm.and, eq: orm.eq, isNull: orm.isNull, isNotNull: orm.isNotNull, desc: orm.desc };
  return {
    ...mysqlOps(db, t, d),
    transaction: (fn) => db.transaction((tx: any) => fn(mysqlOps(tx, t, d))),
  };
}

/** Cidades com aeroporto onde a ficha trabalha: centro de custos + cidades dadas (`city.extra.*`). */
async function personCitiesFromDb(employeeId: number): Promise<TerminalCityKey[]> {
  const [{ getDb, getUserPermissionOverrides }, { applyCityPermissions, resolveCityAccess }, { airportCityOf }, schema, { eq }] = await Promise.all([
    import("./db"), import("./cityAccess"), import("../shared/pontoTerminal"), import("../drizzle/schema"), import("drizzle-orm"),
  ]);
  const db = await getDb();
  if (!db) return [];
  const [emp] = await db.select({ projectId: schema.employees.projectId, userId: schema.employees.userId }).from(schema.employees).where(eq(schema.employees.id, employeeId)).limit(1);
  if (!emp) return [];
  const nodes = await db.select({ id: schema.projects.id, name: schema.projects.name, level: schema.projects.level, parentId: schema.projects.parentId }).from(schema.projects);
  const overrides = emp.userId ? await getUserPermissionOverrides(emp.userId).catch(() => ({})) : {};
  const base = applyCityPermissions(resolveCityAccess(emp.projectId ?? null, nodes as any), nodes as any, overrides as Record<string, string>);
  if (base.missingCostCenter) return [];
  if (base.all) return [...TERMINAL_CITY_KEYS];
  const keys = new Set<TerminalCityKey>();
  for (const n of base.cityNames ?? (base.cityName ? [base.cityName] : [])) {
    const k = airportCityOf(n);
    if (k) keys.add(k);
  }
  return TERMINAL_CITY_KEYS.filter((k) => keys.has(k));
}

async function openClockFromDb(employeeId: number): Promise<{ timeRecordId: number; since: string } | null> {
  const [{ getDb }, { sql }] = await Promise.all([import("./db"), import("drizzle-orm")]);
  const db = await getDb();
  if (!db) return null;
  const r = rowsOf(await db.execute(sql`SELECT id, type, DATE_FORMAT(recordedAt, '%Y-%m-%d %H:%i:%s') AS at FROM time_records WHERE employeeId = ${employeeId} ORDER BY recordedAt DESC, id DESC LIMIT 1`))[0];
  if (!r || String(r.type) !== "check_in") return null;
  // Entrada esquecida (mais de 16 h) já não conta como ponto aberto (a regra dos alertas de presença).
  const { STALE_CLOCK_HOURS } = await import("../shared/opsPresence");
  if (Date.now() - toMs(String(r.at)) > STALE_CLOCK_HOURS * 3_600_000) return null;
  return { timeRecordId: Number(r.id), since: String(r.at) };
}

async function userIdsFromDb(employeeId: number): Promise<number[]> {
  const [{ getDb }, { sql }] = await Promise.all([import("./db"), import("drizzle-orm")]);
  const db = await getDb();
  if (!db) return [];
  const main = rowsOf(await db.execute(sql`SELECT userId FROM employees WHERE id = ${employeeId}`)).map((r) => Number(r.userId));
  const extra = rowsOf(await db.execute(sql`SELECT userId FROM employee_accounts WHERE employeeId = ${employeeId}`).catch(() => [[]])).map((r) => Number(r.userId));
  return Array.from(new Set([...main, ...extra].filter((x) => Number.isInteger(x) && x > 0)));
}

/** TL de serviço na cidade: o TL da escala do turno atual + os TL com ponto aberto na cidade. */
async function tlOnDutyFromDb(city: TerminalCityKey): Promise<number[]> {
  const [{ getDb }, { sql }, { operationalShift }, { resolveCitiesForEmployeeIds }, { notifyCityOf }] = await Promise.all([
    import("./db"), import("drizzle-orm"), import("../shared/shiftHandover"), import("./employeeCity"), import("../shared/notificationRouting"),
  ]);
  const db = await getDb();
  if (!db) return [];
  const { date, shift } = operationalShift(Date.now());
  const scheduled = rowsOf(await db.execute(sql`
    SELECT DISTINCT employeeId FROM extras_dia_assignments
    WHERE assignmentDate = ${date} AND shift = ${shift} AND city = ${city} AND isTeamLeader = 1 AND employeeId IS NOT NULL`).catch(() => [[]]))
    .map((r) => Number(r.employeeId));
  const clocked = rowsOf(await db.execute(sql`
    SELECT e.id FROM employees e
    WHERE e.isActive = 1 AND e.position = 'team_leader'
      AND (SELECT t.type FROM time_records t WHERE t.employeeId = e.id ORDER BY t.recordedAt DESC, t.id DESC LIMIT 1) = 'check_in'
      AND (SELECT t.recordedAt FROM time_records t WHERE t.employeeId = e.id ORDER BY t.recordedAt DESC, t.id DESC LIMIT 1) >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 16 HOUR)`).catch(() => [[]]))
    .map((r) => Number(r.id));
  const cities = await resolveCitiesForEmployeeIds(clocked).catch(() => new Map());
  const clockedHere = clocked.filter((id) => notifyCityOf((cities.get(id) as any)?.city ?? null) === city);
  const ids = Array.from(new Set([...scheduled, ...clockedHere]));
  const users: number[] = [];
  for (const id of ids) users.push(...(await userIdsFromDb(id)));
  return Array.from(new Set(users));
}

/** Pessoas com ponto aberto (≤ 16 h) que podem ir para o terminal desta cidade. */
async function candidatesFromDb(city: TerminalCityKey): Promise<Array<{ employeeId: number; name: string; position: string | null }>> {
  const [{ getDb }, { sql }] = await Promise.all([import("./db"), import("drizzle-orm")]);
  const db = await getDb();
  if (!db) return [];
  const rows = rowsOf(await db.execute(sql`
    SELECT e.id, e.fullName, e.position, e.contractType FROM employees e
    WHERE e.isActive = 1
      AND (e.position IN ('extra','driver','senior_driver','team_leader') OR e.contractType = 'extra')
      AND (SELECT t.type FROM time_records t WHERE t.employeeId = e.id ORDER BY t.recordedAt DESC, t.id DESC LIMIT 1) = 'check_in'
      AND (SELECT t.recordedAt FROM time_records t WHERE t.employeeId = e.id ORDER BY t.recordedAt DESC, t.id DESC LIMIT 1) >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 16 HOUR)
    ORDER BY e.fullName LIMIT 300`));
  const out: Array<{ employeeId: number; name: string; position: string | null }> = [];
  for (const r of rows) {
    const id = Number(r.id);
    if ((await personCitiesFromDb(id).catch(() => [] as TerminalCityKey[])).includes(city)) {
      out.push({ employeeId: id, name: String(r.fullName ?? `Ficha ${id}`), position: r.position ? String(r.position) : null });
    }
  }
  return out;
}

/** Dependências de produção (BD, Definições, sino, registo de atividade, Multipark só leitura). */
export async function realTerminalDeps(): Promise<TerminalDeps> {
  const store = await mysqlTerminalStore();
  return {
    store,
    now: () => Date.now(),
    enabled: async () => (await import("./pontoTerminal")).pontoTerminalEnabled(),
    airports: async () => (await import("./pontoTerminal")).loadTerminalAirports(),
    person: async (employeeId) => {
      const { getEmployeeById } = await import("./db");
      const e = (await getEmployeeById(employeeId))?.employee as any;
      if (!e) return null;
      return { id: Number(e.id), fullName: String(e.fullName ?? ""), position: e.position ?? null, contractType: e.contractType ?? null, userId: e.userId == null ? null : Number(e.userId), isActive: Number(e.isActive ?? 1) === 1 };
    },
    personCities: personCitiesFromDb,
    openClock: openClockFromDb,
    userIdsOf: userIdsFromDb,
    tlOnDuty: tlOnDutyFromDb,
    candidates: candidatesFromDb,
    notify: async (n) => {
      const { notify } = await import("./notify");
      await notify({ kind: "terminal", city: n.city, targetUserIds: n.targetUserIds, title: n.title, body: n.body, link: "/perfil", entity: n.entity });
    },
    log: async (e) => {
      const { logActivity } = await import("./db");
      await logActivity({ userId: e.userId, action: e.action, entity: "terminal_session", entityId: e.entityId, details: e.details });
    },
    lastService: async (o) => {
      const { resolveTerminalShift } = await import("./pontoTerminal");
      return resolveTerminalShift({ employeeId: o.employeeId, inAt: o.inAt, outAt: o.outAt });
    },
  };
}

/** Cidades (chaves) de um acesso de cidade: todas, ou as dos nomes. */
export function cityKeysOfAccess(access: { all: boolean; cityNames?: string[]; cityName?: string | null } | null | undefined): TerminalCityKey[] {
  if (!access) return [];
  if (access.all) return [...TERMINAL_CITY_KEYS];
  const names = access.cityNames ?? (access.cityName ? [access.cityName] : []);
  const keys = new Set<TerminalCityKey>();
  for (const n of names) {
    const t = String(n ?? "").trim().toLowerCase();
    const k = t === "lisboa" || t === "lisbon" ? "lisbon" : t === "porto" || t === "oporto" ? "porto" : t === "faro" ? "faro" : null;
    if (k && isTerminalCityKey(k)) keys.add(k);
  }
  return TERMINAL_CITY_KEYS.filter((k) => keys.has(k));
}
