/**
 * TERMINAL PELO PERFIL — "Ainda estás no terminal?" (plano 56, entrega B2).
 * Regras puras em shared/terminalWatch.ts; BD e avisos aqui.
 *
 *  - Vigia de 5 em 5 min (cron `terminal-watch`, no padrão do ops-presence):
 *    UMA chamada Zello `location/get` (máx. 100 utilizadores) e a posição do
 *    aparelho que está com cada pessoa no terminal (PDA com check-in; senão o
 *    Zello fixo da ficha, se ninguém o tiver agora). Grava em cada sessão
 *    aberta o último GPS dentro, o "fora" (desde quando e quantas leituras)
 *    e a hora da pergunta.
 *  - Fora (2 leituras) há mais de 20 min → pergunta na barra e por push à
 *    pessoa; o TL de serviço recebe no sino e por push.
 *  - "Sim, estou" → não volta a perguntar durante 60 min (com GPS dentro no
 *    telemóvel também é prova). "Já saí" → fecha com a hora certa (a do GPS).
 *  - Sem resposta em 15 min → o lugar liberta-se ("no_answer"), com
 *    "saiu do aeroporto às HH:MM (GPS)". Até 30 min depois, "Ainda estou"
 *    reabre sem buraco se o lugar estiver livre; ocupado → vai ao TL.
 *
 * Zello em baixo (ou não configurado) → nada se pergunta nem se liberta nessa
 * volta. Interruptor PONTO_TERMINAL desligado → o vigia nem lê o Zello, nada
 * se pergunta e nada se grava. Nada se apaga. Nunca lança para fora do cron.
 */
import { lisbonClock } from "../shared/pontoTerminal";
import { zelloKey } from "../shared/zelloKey";
import {
  TERMINAL_CITY_LABELS, TERMINAL_CITY_OF, canUseTerminal, firstName, fixInsideCity, isDupEntry, terminalLeftMessage, terminalPayUplift, toDbUtc, toMs,
  type GpsFix, type TerminalCityKey,
} from "../shared/terminalSession";
import {
  TERMINAL_NO_ANSWER_MIN, TERMINAL_STILL_HERE_QUIET_MIN, classifyReading, leftAirportNote, nextWatch, outsideConfirmed, reopenWindow, watchDecision,
  type ZelloReading,
} from "../shared/terminalWatch";
import {
  OFF_MESSAGE, TerminalError, alreadyResult, busyResult, cancelPendingFor, coord, cut, nameOf, safeLog, safeNotify, sessionCounting, settleCounted,
  stillThereQuestion, view,
  type TerminalDeps, type TerminalOpenResult, type TerminalSessionRow,
} from "./terminalSessions";

const ms0 = (v: string | null | undefined): number | null => (v ? toMs(v) : null);

// ─── Vigia de 5 em 5 min ────────────────────────────────────────────────────

export interface TerminalWatchResult {
  skipped?: "off";
  /** sessões abertas vistas */
  open: number;
  /** o Zello respondeu */
  zello: boolean;
  /** leituras novas gravadas */
  readings: number;
  /** sem GPS (velho, impreciso ou sem aparelho) */
  noGps: number;
  /** perguntas feitas */
  asked: number;
  /** lugares libertados por falta de resposta */
  released: number;
}

/** Uma volta do vigia. Nunca lança por causa de uma sessão (as outras continuam). */
export async function runTerminalWatch(deps: TerminalDeps): Promise<TerminalWatchResult> {
  const out: TerminalWatchResult = { open: 0, zello: false, readings: 0, noGps: 0, asked: 0, released: 0 };
  if (!(await deps.enabled())) return { ...out, skipped: "off" };
  const open = await deps.store.openAll();
  out.open = open.length;
  if (!open.length) return out;
  const airports = await deps.airports();
  let readings: Map<number, ZelloReading | null> | null = null;
  try {
    readings = deps.zelloReadings ? await deps.zelloReadings(open.map((s) => s.employeeId)) : null;
  } catch (err) {
    console.warn("[terminal-watch] Zello indisponível:", String((err as Error)?.message ?? err).slice(0, 160));
    readings = null;
  }
  out.zello = readings != null;
  // Zello em baixo (ou não configurado): não se sabe se a pessoa voltou ao
  // aeroporto (o que responderia por si) — nesta volta nada se grava, nada se
  // pergunta e nada se liberta (um erro do Zello nunca pergunta nem liberta ninguém).
  if (!readings) return out;
  for (const s of open) {
    try {
      const nowMs = deps.now();
      const state0 = {
        startedAtMs: toMs(s.startedAt), lastInsideAtMs: ms0(s.lastInsideAt), outsideSinceMs: ms0(s.outsideSince),
        outsideCount: Number(s.outsideCount ?? 0), lastFixAtMs: ms0(s.lastFixAt),
      };
      const r = classifyReading(readings.get(s.employeeId) ?? null, airports[s.cityKey], nowMs);
      const nx = nextWatch(state0, r, nowMs);
      // fechou ou mudou entretanto ("Sim, estou" no mesmo instante) → fica para a próxima volta
      if (!(await deps.store.updateWatch(s.id, nx.patch, { lastFixAt: s.lastFixAt ?? null, stillHereAt: s.stillHereAt ?? null }))) continue;
      if (r.state === "no_gps") out.noGps++;
      if (nx.newReading) out.readings++;
      const state = nx.state;
      const ask = { outsideSinceMs: state.outsideSinceMs, outsideCount: state.outsideCount, askedAtMs: ms0(s.askedAt), stillHereAtMs: ms0(s.stillHereAt), lastFixAtMs: state.lastFixAtMs };
      const d = watchDecision(ask, nowMs);
      const cur = { ...s, lastInsideAt: state.lastInsideAtMs != null ? toDbUtc(state.lastInsideAtMs) : null, outsideSince: state.outsideSinceMs != null ? toDbUtc(state.outsideSinceMs) : null, outsideCount: state.outsideCount };
      if (d === "ask" && (await askStillThere(deps, cur, nowMs))) out.asked++;
      else if (d === "release" && (await releaseNoAnswer(deps, cur, nowMs))) out.released++;
    } catch (err) {
      console.warn(`[terminal-watch] sessão ${s.id}:`, String((err as Error)?.message ?? err).slice(0, 160));
    }
  }
  return out;
}

/** "Ainda estás no terminal?" — barra + push à pessoa, sino + push ao TL de serviço. */
async function askStillThere(deps: TerminalDeps, s: TerminalSessionRow, nowMs: number): Promise<boolean> {
  const at = toDbUtc(nowMs);
  if (!(await deps.store.markAsked(s.id, at, s.askedAt ?? null))) return false;
  const name = await nameOf(deps, s.employeeId);
  const left = s.outsideSince ? lisbonClock(s.outsideSince) : "";
  const until = lisbonClock(toDbUtc(nowMs + TERMINAL_NO_ANSWER_MIN * 60_000));
  await safeLog(deps, { userId: 0, action: "terminal_ask", entityId: s.id, details: `"Ainda estás no terminal?" a ${name} (terminal ${TERMINAL_CITY_OF[s.cityKey]}; ${leftAirportNote(s.outsideSince)})` });
  const own = await deps.userIdsOf(s.employeeId);
  await safeNotify(deps, {
    city: s.cityKey, targetUserIds: own,
    title: `Ainda estás no terminal ${TERMINAL_CITY_OF[s.cityKey]}?`,
    body: `${left ? `O GPS diz que saíste às ${left}. ` : ""}Responde na app: "Sim, estou" ou "Já saí". Sem resposta até às ${until}, o lugar fica livre.`,
    entity: { type: "terminal_ask", id: s.id },
    push: { title: "Ainda estás no terminal?", body: `Responde na app: "Sim, estou" ou "Já saí". Sem resposta até às ${until}, o lugar fica livre.`, url: "/perfil", tag: `terminal-ask-${s.id}` },
  });
  const tl = (await deps.tlOnDuty(s.cityKey)).filter((u) => !own.includes(u));
  await safeNotify(deps, {
    city: s.cityKey, targetUserIds: tl, link: "/operacional?tab=live",
    title: `Terminal ${TERMINAL_CITY_OF[s.cityKey]}: ${name} saiu?`,
    body: `${left ? `O GPS diz que ${firstName(name)} saiu do aeroporto às ${left}. ` : ""}Perguntámos se ainda está lá. Sem resposta até às ${until}, o lugar fica livre (Atividade diária → Ao vivo → Terminal agora).`,
    entity: { type: "terminal_ask", id: s.id },
    push: { title: `Terminal ${TERMINAL_CITY_LABELS[s.cityKey]}`, body: "O GPS diz que quem está no terminal saiu. Perguntámos se ainda está lá. Abre a app.", url: "/operacional?tab=live", tag: `terminal-ask-tl-${s.id}` },
  });
  return true;
}

/** Sem resposta em 15 min → liberta o lugar ("no_answer"), com a hora a que o GPS o viu sair. */
async function releaseNoAnswer(deps: TerminalDeps, s: TerminalSessionRow, nowMs: number): Promise<boolean> {
  if (!s.askedAt) return false;
  const endedMs = Math.max(nowMs, toMs(s.startedAt));
  const endedAt = toDbUtc(endedMs);
  const counting = sessionCounting(s, endedMs, null);
  const note = `Sem resposta ao "Ainda estás no terminal?" — ${leftAirportNote(s.outsideSince)}`;
  const closed = await deps.store.closeIfUnanswered(s.id, s.askedAt, {
    endedAt, endReason: "no_answer", endedByUserId: null, endLat: null, endLng: null, endNote: cut(note), ...counting,
  });
  if (!closed) return false; // respondeu "Sim" entretanto, ou já fechou
  await deps.store.transaction((tx) => cancelPendingFor(tx, s.id, endedAt, null, "Lugar libertado (sem resposta)"));
  await settleCounted(deps, { ...s, endedAt, ...counting });
  const name = await nameOf(deps, s.employeeId);
  const left = s.outsideSince ? lisbonClock(s.outsideSince) : lisbonClock(endedAt);
  const reopenUntil = lisbonClock(toDbUtc(endedMs + 30 * 60_000));
  await safeLog(deps, { userId: 0, action: "terminal_no_answer", entityId: s.id, details: `Terminal ${TERMINAL_CITY_OF[s.cityKey]} libertado: ${name} não respondeu (${leftAirportNote(s.outsideSince)})` });
  const own = await deps.userIdsOf(s.employeeId);
  await safeNotify(deps, {
    city: s.cityKey, targetUserIds: own,
    title: `Saíste do terminal ${TERMINAL_CITY_OF[s.cityKey]} às ${left} (GPS)`,
    body: `Não respondeste e o lugar ficou livre. Se ainda lá estás, carrega em "Ainda estou" até às ${reopenUntil}.`,
    entity: { type: "terminal_release", id: s.id },
    push: { title: "Saíste do terminal", body: `O lugar ficou livre. Se ainda lá estás, carrega em "Ainda estou" até às ${reopenUntil}.`, url: "/perfil", tag: `terminal-release-${s.id}` },
  });
  await safeNotify(deps, {
    city: s.cityKey, targetUserIds: (await deps.tlOnDuty(s.cityKey)).filter((u) => !own.includes(u)), link: "/operacional?tab=live",
    title: `Terminal ${TERMINAL_CITY_OF[s.cityKey]} livre`,
    body: `${name} não respondeu ao "Ainda estás no terminal?" (${leftAirportNote(s.outsideSince)}). Podes pôr alguém em Atividade diária → Ao vivo → Terminal agora.`,
    entity: { type: "terminal_release", id: s.id },
  });
  return true;
}

// ─── Resposta da pessoa ─────────────────────────────────────────────────────

export type StillHereResult =
  | { status: "ok"; message: string }
  | { status: "closed"; message: string; endedAt: string }
  | TerminalOpenResult;

/**
 * "Sim, estou" / "Já saí". Sem sessão aberta e "Sim, estou" → tenta reabrir
 * (o lugar pode ter sido libertado no mesmo minuto).
 */
export async function answerStillHere(deps: TerminalDeps, o: { employeeId: number; actorUserId: number; answer: "yes" | "left"; fix: GpsFix | null }): Promise<StillHereResult> {
  if (!(await deps.enabled())) throw new TerminalError(OFF_MESSAGE);
  const s = await deps.store.openByEmployee(o.employeeId);
  if (!s) {
    if (o.answer === "yes") return reopenTerminal(deps, o);
    throw new TerminalError("Já não estás no terminal.");
  }
  const nowMs = deps.now();
  const at = toDbUtc(nowMs);
  const inside = fixInsideCity(o.fix, await deps.airports(), s.cityKey) === true;
  const name = await nameOf(deps, s.employeeId);
  if (o.answer === "yes") {
    if (!(await deps.store.markStillHere(s.id, at, inside ? at : null))) return reopenTerminal(deps, o);
    await safeLog(deps, { userId: o.actorUserId, action: "terminal_still_here", entityId: s.id, details: `${name}: "Sim, estou" (terminal ${TERMINAL_CITY_OF[s.cityKey]}${inside ? "; GPS do telemóvel no aeroporto" : "; sem GPS no aeroporto"})` });
    if (s.askedAt) {
      await safeNotify(deps, {
        city: s.cityKey, targetUserIds: (await deps.tlOnDuty(s.cityKey)).filter((u) => u !== o.actorUserId), link: "/operacional?tab=live",
        title: `${name} ainda está no terminal ${TERMINAL_CITY_OF[s.cityKey]}`,
        body: `Respondeu "Sim, estou" às ${lisbonClock(at)}.`,
        entity: { type: "terminal_still_here", id: s.id },
      });
    }
    return { status: "ok", message: inside ? "Obrigado. O GPS confirma que estás no aeroporto." : `Obrigado. Não voltamos a perguntar durante ${TERMINAL_STILL_HERE_QUIET_MIN} min.` };
  }
  // "Já saí": fecha à hora a que o GPS o viu sair (se confirmado), senão agora
  const out = { outsideSinceMs: ms0(s.outsideSince), outsideCount: Number(s.outsideCount ?? 0) };
  const startMs = toMs(s.startedAt);
  const endedMs = outsideConfirmed(out) ? Math.min(nowMs, Math.max(startMs, out.outsideSinceMs!)) : Math.max(nowMs, startMs);
  const endedAt = toDbUtc(endedMs);
  const counting = sessionCounting(s, endedMs, false);
  const closed = await deps.store.close(s.id, {
    endedAt, endReason: "button", endedByUserId: o.actorUserId,
    endLat: coord(o.fix?.lat != null ? Number(o.fix.lat) : null), endLng: coord(o.fix?.lng != null ? Number(o.fix.lng) : null),
    endNote: cut(`Respondeu "Já saí"${outsideConfirmed(out) ? ` — ${leftAirportNote(s.outsideSince)}` : ""}`), ...counting,
  });
  if (!closed) throw new TerminalError("Já não estavas no terminal.");
  await deps.store.transaction((tx) => cancelPendingFor(tx, s.id, endedAt, o.actorUserId, "Saiu do terminal"));
  await settleCounted(deps, { ...s, endedAt, ...counting });
  await safeLog(deps, { userId: o.actorUserId, action: "terminal_left", entityId: s.id, details: `${name}: "Já saí" (terminal ${TERMINAL_CITY_OF[s.cityKey]}, fechado às ${lisbonClock(endedAt)})` });
  return { status: "closed", message: terminalLeftMessage(s.startedAt, endedAt), endedAt };
}

// ─── Reabrir ────────────────────────────────────────────────────────────────

/**
 * "Ainda estou" depois de o lugar ter sido libertado (sem resposta): até 30
 * min, reabre SEM BURACO (a nova sessão começa onde a outra acabou — ou onde
 * acabou quem esteve lá entretanto) se o lugar estiver livre; ocupado → vai ao
 * TL. Mais tarde → "Estou no terminal" com GPS. As horas da reabertura só
 * contam com prova (GPS dentro depois disto, ou fecho no aeroporto); senão
 * ficam por confirmar.
 */
export async function reopenTerminal(deps: TerminalDeps, o: { employeeId: number; actorUserId: number; fix: GpsFix | null }): Promise<TerminalOpenResult> {
  if (!(await deps.enabled())) return { status: "off", message: OFF_MESSAGE };
  const person = await deps.person(o.employeeId);
  if (!person || !person.isActive) return { status: "refused", reason: "no_employee", message: "A tua conta não está ligada a uma ficha ativa." };
  if (!canUseTerminal(person)) return { status: "refused", reason: "position", message: "O terminal é para extras, condutores e team leaders." };
  const mine = await deps.store.openByEmployee(person.id);
  if (mine) return alreadyResult(mine, mine.cityKey);
  const nowMs = deps.now();
  const last = await deps.store.latestByEmployee(person.id);
  const w = reopenWindow(last, nowMs);
  if (!last || !w.ok) {
    return { status: "refused", reason: "late", message: `Já passaram mais de 30 min. Carrega na tua fotografia → "Estou no terminal" (com GPS).` };
  }
  const city = last.cityKey;
  const clock = await deps.openClock(person.id);
  if (!clock) return { status: "need_checkin", message: "Dá entrada no ponto primeiro (com \"Estou no terminal\" marcado)." };
  if (!(await deps.personCities(person.id)).includes(city)) {
    return { status: "refused", reason: "other_city", message: `O terminal ${TERMINAL_CITY_OF[city]} não é de uma cidade onde trabalhas. Fala com o teu TL.` };
  }
  const holder = await deps.store.openByCity(city);
  if (holder) return busyToTl(deps, person.fullName, holder, o.actorUserId);
  // sem buraco: a partir de onde acabou a dele, ou de quem esteve lá entretanto
  let startMs = toMs(last.endedAt!);
  const between = await deps.store.sessionsBetween({ cityKey: city, fromUtc: last.endedAt!, toUtc: toDbUtc(nowMs) });
  for (const b of between) if (b.id !== last.id && b.endedAt) startMs = Math.max(startMs, toMs(b.endedAt));
  startMs = Math.min(startMs, nowMs);
  const startedAt = toDbUtc(startMs);
  const at = toDbUtc(nowMs);
  const inside = fixInsideCity(o.fix, await deps.airports(), city) === true;
  let id: number;
  try {
    id = await deps.store.insert({
      employeeId: person.id, userId: person.userId, cityKey: city, startedAt,
      startLat: coord(o.fix?.lat != null ? Number(o.fix.lat) : null), startLng: coord(o.fix?.lng != null ? Number(o.fix.lng) : null),
      startAccuracy: o.fix?.accuracy != null && Number.isFinite(Number(o.fix.accuracy)) ? Math.max(0, Math.round(Number(o.fix.accuracy))) : null,
      startSource: "reopen", startedByUserId: o.actorUserId,
      // prova só a partir de agora (GPS do telemóvel no aeroporto); o que conta começa agora
      lastInsideAt: inside ? at : null, countedFrom: at, stillHereAt: at, prevSessionId: last.id,
      payUplift: terminalPayUplift(person), timeRecordId: clock.timeRecordId,
      note: cut(`"Ainda estou" depois de libertado às ${lisbonClock(last.endedAt)}`),
    });
  } catch (err) {
    if (!isDupEntry(err)) throw err;
    const again = await deps.store.openByEmployee(person.id);
    if (again) return alreadyResult(again, city);
    const h = await deps.store.openByCity(city);
    if (h) return busyToTl(deps, person.fullName, h, o.actorUserId);
    throw err;
  }
  await safeLog(deps, { userId: o.actorUserId, action: "terminal_reopen", entityId: id, details: `${person.fullName}: "Ainda estou" — terminal ${TERMINAL_CITY_OF[city]} reaberto desde ${lisbonClock(startedAt)} (sessão ${last.id} → ${id}${inside ? "; GPS no aeroporto" : "; sem GPS no aeroporto: horas por confirmar sem prova"})` });
  await safeNotify(deps, {
    city, targetUserIds: (await deps.tlOnDuty(city)).filter((u) => u !== o.actorUserId), link: "/operacional?tab=live",
    title: `${person.fullName} voltou ao terminal ${TERMINAL_CITY_OF[city]}`,
    body: `Disse "Ainda estou" às ${lisbonClock(at)} depois de o lugar ter sido libertado.`,
    entity: { type: "terminal_session", id },
  });
  const session = await deps.store.byId(id);
  return {
    status: "started",
    session: session ? view(session) : { id, employeeId: person.id, cityKey: city, cityLabel: TERMINAL_CITY_LABELS[city], startedAt, startSource: "reopen", payUplift: terminalPayUplift(person) === 1 },
    // Para o extra: está de volta e conta a partir de agora; o tempo em que o GPS o viu fora não conta sozinho (o RH decide).
    message: `Voltaste ao terminal ${TERMINAL_CITY_OF[city]}. Conta a partir de agora (${lisbonClock(at)}); o tempo em que o GPS te viu fora fica para o RH decidir.`,
    takeoverFrom: null,
  };
}

/** O lugar já está com outra pessoa: avisa o TL de serviço e responde "ocupado". */
async function busyToTl(deps: TerminalDeps, name: string, holder: TerminalSessionRow, actorUserId: number): Promise<TerminalOpenResult> {
  const b = await busyResult(deps, holder);
  await safeNotify(deps, {
    city: holder.cityKey, targetUserIds: (await deps.tlOnDuty(holder.cityKey)).filter((u) => u !== actorUserId), link: "/operacional?tab=live",
    title: `${name} diz que ainda está no terminal ${TERMINAL_CITY_OF[holder.cityKey]}`,
    body: `O lugar já está com ${b.holderName} desde ${lisbonClock(holder.startedAt)}. Decide em Atividade diária → Ao vivo → Terminal agora.`,
    entity: { type: "terminal_reopen_busy", id: holder.id },
  });
  return { ...b, message: `${b.message} Pedimos ao TL de serviço para decidir.` };
}

// ─── Zello do aparelho com a pessoa ─────────────────────────────────────────

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};

/**
 * Zello do aparelho que está com cada pessoa: o PDA com check-in (o mais
 * recente); se não tem PDA, ou o PDA não tem Zello, o Zello fixo da ficha —
 * se ninguém o tiver agora num check-in de PDA (como o opsPresence). Sem
 * isto, quem tinha check-in num PDA sem Zello ficava "sem GPS" mesmo com o
 * Zello na ficha (o telemóvel do TL registado como PDA). PURA.
 *
 * `checkins`: os check-ins abertos, do mais recente para o mais antigo.
 */
export function pickZelloDevices(
  ids: readonly number[],
  checkins: ReadonlyArray<{ employeeId: number; zello: string | null }>,
  fixedOf: ReadonlyMap<number, string | null>,
): Map<number, string | null> {
  const out = new Map<number, string | null>();
  const pdaOf = new Map<number, string | null>();
  const holderOf = new Map<string, number>();
  for (const r of checkins) {
    const z = String(r.zello ?? "").trim() || null;
    if (!pdaOf.has(r.employeeId)) pdaOf.set(r.employeeId, z);
    const k = zelloKey(z);
    if (k && !holderOf.has(k)) holderOf.set(k, r.employeeId);
  }
  for (const id of ids) {
    const viaPda = pdaOf.get(id) ?? null;
    if (viaPda) { out.set(id, viaPda); continue; }
    const f = String(fixedOf.get(id) ?? "").trim() || null;
    const holder = f ? holderOf.get(zelloKey(f)) : undefined;
    out.set(id, f && (holder == null || holder === id) ? f : null);
  }
  return out;
}

export async function zelloDevicesOf(employeeIds: readonly number[]): Promise<Map<number, string | null>> {
  const ids = Array.from(new Set(employeeIds.filter((x) => Number.isInteger(x) && x > 0)));
  if (!ids.length) return new Map();
  const [{ getDb }, { sql }] = await Promise.all([import("./db"), import("drizzle-orm")]);
  const db = await getDb();
  if (!db) return new Map();
  const checkins = rowsOf(await db.execute(sql`
    SELECT c.employeeId, COALESCE(NULLIF(p.zelloUsername, ''), NULLIF(c.zelloUsername, '')) AS zello
    FROM pda_checkins c JOIN pdas p ON p.id = c.pdaId
    WHERE c.checkin_status = 'checked_in' AND c.employeeId IS NOT NULL
    ORDER BY c.checkinAt DESC`).catch(() => [[]]))
    .map((r) => ({ employeeId: Number(r.employeeId), zello: r.zello ? String(r.zello) : null }));
  const fixed = rowsOf(await db.execute(sql`SELECT id, zelloUsername FROM employees WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`));
  const fixedOf = new Map(fixed.map((r) => [Number(r.id), r.zelloUsername ? String(r.zelloUsername) : null]));
  return pickZelloDevices(ids, checkins, fixedOf);
}

/** O que o vigia precisa de uma posição do Zello (o formato de server/zello.ts). */
export interface ZelloLocationLike { username: string; latitude: number; longitude: number; accuracy: number; lastReport?: number; lastReportDelay: number }

/** No máximo X pedidos à parte (location/getuser) por volta — há no máximo 1 sessão por cidade. */
export const ZELLO_SINGLE_LOOKUPS_MAX = 5;
/** Cada pedido à parte espera no máximo isto (ms) e todos juntos no máximo o dobro: o vigia cabe nos 25 s do tick. */
export const ZELLO_SINGLE_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * Leituras do Zello por ficha a partir da lista de location/get. Essa lista
 * traz no máximo `listMax` (100) utilizadores: com a lista cheia, quem lá não
 * vem é pedido à parte (`fetchOne`, location/getuser; no máximo 5). Um erro
 * num pedido à parte = sem GPS dessa pessoa (nunca "fora"); nunca lança.
 * Contas excluídas do GPS (Definições) → sem GPS.
 */
export async function zelloReadingsFor(o: {
  employeeIds: readonly number[];
  devices: ReadonlyMap<number, string | null>;
  list: ReadonlyArray<ZelloLocationLike>;
  excluded: (username: string) => boolean;
  fetchOne?: (username: string) => Promise<ZelloLocationLike | null>;
  listMax?: number;
  /** prazo de cada pedido à parte (ms) */
  timeoutMs?: number;
}): Promise<Map<number, ZelloReading | null>> {
  const key = zelloKey;
  const byUser = new Map(o.list.map((l) => [key(l.username), l]));
  if (o.fetchOne && o.list.length >= (o.listMax ?? 100)) {
    const missing = Array.from(new Set(o.employeeIds.map((id) => o.devices.get(id) ?? null)
      .filter((u): u is string => !!u && !o.excluded(u) && !byUser.has(key(u)))));
    const each = o.timeoutMs ?? ZELLO_SINGLE_LOOKUP_TIMEOUT_MS;
    const until = Date.now() + 2 * each;
    for (const u of missing.slice(0, ZELLO_SINGLE_LOOKUPS_MAX)) {
      if (Date.now() > until) break; // o resto fica "sem GPS" nesta volta
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), each); (timer as any)?.unref?.(); });
        const l = await Promise.race([o.fetchOne(u), late]).finally(() => clearTimeout(timer));
        if (l) byUser.set(key(u), l);
      } catch (err) {
        console.warn("[terminal-watch] Zello location/getuser falhou:", String((err as Error)?.message ?? err).slice(0, 160));
      }
    }
  }
  const out = new Map<number, ZelloReading | null>();
  for (const id of o.employeeIds) {
    const u = o.devices.get(id) ?? null;
    const l = u && !o.excluded(u) ? byUser.get(key(u)) : undefined;
    // o zello.ts põe 0 quando a API não dá o valor: atraso 0 SEM instante do relatório = idade desconhecida (sem GPS)
    const known = (l?.lastReport ?? 0) > 0 || (l?.lastReportDelay ?? 0) > 0;
    out.set(id, l && known ? {
      lat: l.latitude, lng: l.longitude, accuracy: l.accuracy || null,
      lastReportDelay: (l.lastReport ?? 0) > 0 || l.lastReportDelay > 0 ? l.lastReportDelay : null, lastReportSec: l.lastReport || null,
    } : null);
  }
  return out;
}

/**
 * Posição do Zello de cada pessoa: UMA chamada location/get (máx. 100
 * utilizadores; quem não couber pede-se à parte). null = Zello não
 * configurado ou em baixo (o vigia não muda nada). Contas excluídas do GPS
 * (Definições) → sem GPS.
 */
export async function zelloReadingsFromDb(employeeIds: number[]): Promise<Map<number, ZelloReading | null> | null> {
  const { getZelloLocations, getZelloUserLocationOf, isZelloConfigured, loadZelloGpsExclusions, ZELLO_LOCATIONS_MAX } = await import("./zello");
  if (!isZelloConfigured()) return null;
  const [devices, { isZelloGpsExcluded }] = await Promise.all([zelloDevicesOf(employeeIds), import("../shared/appSettings")]);
  const list = await getZelloLocations();
  const excluded = await loadZelloGpsExclusions();
  return zelloReadingsFor({ employeeIds, devices, list, excluded: (u) => isZelloGpsExcluded(u, excluded), fetchOne: getZelloUserLocationOf, listMax: ZELLO_LOCATIONS_MAX });
}

/** Cidade das chaves (para os textos). */
export function cityLabel(c: TerminalCityKey): string {
  return TERMINAL_CITY_LABELS[c] ?? c;
}
