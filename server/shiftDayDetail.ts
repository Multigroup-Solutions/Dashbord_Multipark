/**
 * Resumo do dia (Passagem de turno), Jorge 12 out 2026 — as leituras de
 * detalhe, cada uma uma só leitura à BD da Multipark (só leitura) por clique:
 *
 *  - `getPeopleShiftGps`: o "Parado" de cada pessoa limitado ao TURNO (as
 *    picagens; sem elas, a escala) a partir dos pontos do Zello — a tabela
 *    "Quem trabalhou" carrega-o à parte (não atrasa o resumo);
 *  - `getDriverShiftDay`: o dia de um condutor (linha da tabela): recolhas,
 *    entregas e movimentos com a reserva, pendente→entregue, a velocidade
 *    máxima em cada entrega e o GPS do turno;
 *  - `getDeliveryContext`: uma entrega lenta e o que se passava na mesma
 *    cidade enquanto esperava.
 *
 * Regras puras em shared/shiftDayReview.ts; GPS em server/shiftGps.ts. Tudo
 * no âmbito de cidade do pedido (o middleware estreita à cidade escolhida).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "./db";
import { extrasDiaAssignments } from "../drizzle/schema";
import { cityNameScope, employeeScope, scopedCityNamesLive } from "./cityScope";
import { addDays, lisbonDayOf, lisbonDayRangeUtc, lisbonHoursSince, utcMs } from "../shared/lisbonDay";
import { operationalDayWindowUtc } from "../shared/shiftHandover";
import { matchKey } from "../shared/textKey";
import {
  TIMING_MAX_MIN, deliveryContext, deliveryPairs, shiftWindowsFor,
  type DeliveryPair, type PontoMark, type RosterSpan, type ShiftWindowSource, type TimeWindow,
} from "../shared/shiftDayReview";
import { daysOfWindows, heldPointsFor, heldStats, scopedEmployeeIds } from "./shiftGps";

const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r) as any[]) ?? [];
const mysqlTs = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const r1 = (n: number) => Math.round(n * 10) / 10;
/** Leitura do GPS: no máximo isto (a função morre aos 60 s). */
const GPS_DEADLINE_MS = 25_000;
const HIST_LIMIT = 5000;

// ─── Turno de cada pessoa (picagens / escala) ───────────────────────────────

interface PersonShift { windows: TimeWindow[]; source: ShiftWindowSource | null; roster: Array<RosterSpan & { shift: string; city: string; isTeamLeader: boolean }> }

/** As janelas do turno de cada pessoa no dia operacional (a mesma regra para a tabela e para o detalhe). */
async function shiftsFor(date: string, employeeIds: number[], nowMs: number): Promise<Map<number, PersonShift>> {
  const out = new Map<number, PersonShift>();
  const db = await getDb();
  if (!db || !employeeIds.length) return out;
  const op = operationalDayWindowUtc(date);
  const ids = sql.join(employeeIds.map((x) => sql`${x}`), sql`, `);
  const ponto = new Map<number, PontoMark[]>();
  for (const r of rowsOf(await db.execute(sql`SELECT employeeId, type, recordedAt, reviewStatus FROM time_records
      WHERE employeeId IN (${ids}) AND recordedAt >= ${mysqlTs(op.startMs - 3_600_000)} AND recordedAt < ${mysqlTs(op.endMs + 16 * 3_600_000)}
        AND ${employeeScope(sql`time_records.employeeId`)} ORDER BY recordedAt`))) {
    const e = Number(r.employeeId);
    const at = r.recordedAt instanceof Date ? r.recordedAt.getTime() : utcMs(String(r.recordedAt));
    ponto.set(e, [...(ponto.get(e) ?? []), { type: r.type === "check_out" ? "check_out" : "check_in", atMs: at, rejected: r.reviewStatus === "rejected" }]);
  }
  const roster = await db.select({
    employeeId: extrasDiaAssignments.employeeId, startHour: extrasDiaAssignments.startHour, endHour: extrasDiaAssignments.endHour,
    sentHomeHour: extrasDiaAssignments.sentHomeHour, shift: extrasDiaAssignments.shift, city: extrasDiaAssignments.city, isTeamLeader: extrasDiaAssignments.isTeamLeader,
  }).from(extrasDiaAssignments).where(and(eq(extrasDiaAssignments.assignmentDate, date), inArray(extrasDiaAssignments.employeeId, employeeIds), cityNameScope(extrasDiaAssignments.city)));
  for (const e of employeeIds) {
    const mine = roster.filter((a) => a.employeeId === e).map((a) => ({ date, startHour: a.startHour, endHour: a.endHour, sentHomeHour: a.sentHomeHour, shift: a.shift, city: a.city, isTeamLeader: a.isTeamLeader === 1 }));
    const w = shiftWindowsFor({ opStartMs: op.startMs, opEndMs: op.endMs, ponto: ponto.get(e) ?? [], roster: mine, nowMs });
    out.set(e, { ...w, roster: mine });
  }
  return out;
}

/**
 * O limite dos excessos (Definições → Limite de velocidade; 120 km/h + 10 % por omissão) e os pontos seguidos
 * que fazem um excesso. Para CONTAR: se a definição não se lê, sem limite (não conta excessos), como na
 * Avaliação e no Desempenho — a omissão só vale quando a leitura correu bem (server/speedRule.ts).
 */
async function speedRule(): Promise<{ threshold: number | null; minPoints: number | undefined }> {
  const { speedRuleRead } = await import("./speedRule");
  const r = await speedRuleRead();
  return r ? { threshold: r.threshold, minPoints: r.rule.minPoints } : { threshold: null, minPoints: undefined };
}

const isoWindows = (ws: readonly TimeWindow[]) => ws.map((w) => ({ start: new Date(w.startMs).toISOString(), end: new Date(w.endMs).toISOString() }));

// ─── 1. Parado no turno (tabela "Quem trabalhou") ──────────────────────────

export interface PersonShiftGps {
  /** de onde veio o turno: picagens, escala ou nenhum (fica o dia inteiro) */
  source: ShiftWindowSource | null;
  windows: Array<{ start: string; end: string }>;
  /** horas paradas DENTRO do turno (null: sem GPS do turno) */
  stoppedHours: number | null;
  movingHours: number | null;
  /** algum ficheiro do GPS não se leu, ou o dia seguinte ainda não foi recolhido */
  partial: boolean;
}

/**
 * O GPS dentro do turno de cada pessoa pedida (só as do âmbito de cidade).
 * Sem turno (nem picagens nem escala) não se calcula: o ecrã fica com o
 * parado do dia inteiro, marcado "~".
 */
export async function getPeopleShiftGps(date: string, employeeIds: readonly number[], nowMs: number = Date.now()): Promise<{ people: Record<number, PersonShiftGps> }> {
  const ids = await scopedEmployeeIds(employeeIds);
  const shifts = await shiftsFor(date, ids, nowMs);
  const daysByEmp = new Map<number, string[]>();
  for (const [e, s] of shifts) if (s.windows.length) daysByEmp.set(e, daysOfWindows(s.windows));
  const { threshold, minPoints } = await speedRule();
  const held = await heldPointsFor(daysByEmp, { deadlineAt: Date.now() + GPS_DEADLINE_MS });
  const people: Record<number, PersonShiftGps> = {};
  for (const [e, s] of shifts) {
    if (!s.windows.length) { people[e] = { source: null, windows: [], stoppedHours: null, movingHours: null, partial: false }; continue; }
    const files = held.byEmp.get(e);
    const missingDay = (daysByEmp.get(e) ?? []).some((d) => d <= lisbonDayOf(nowMs) && !held.collectedDays.has(d));
    const failed = held.failed.get(e) ?? 0;
    if (!files?.length) {
      people[e] = { source: s.source, windows: isoWindows(s.windows), stoppedHours: null, movingHours: null, partial: failed > 0 };
      continue;
    }
    const st = heldStats(files, s.windows, threshold, minPoints);
    people[e] = { source: s.source, windows: isoWindows(s.windows), stoppedHours: r1(st.stoppedMinutes / 60), movingHours: r1(st.movingMinutes / 60), partial: failed > 0 || missingDay };
  }
  return { people };
}

// ─── 2. O dia de um condutor ────────────────────────────────────────────────

export interface DriverAction {
  at: string;
  changeType: string;
  booking: string;
  bookingCode: string | null;
  plate: string | null;
  parkName: string | null;
  /** entregas: pendente → entregue */
  pendingAt: string | null;
  takenAt: string | null;
  mins: number | null;
  /** recolhas: entrada prevista e desvio (min) */
  plannedIn: string | null;
  delayMins: number | null;
  /** entregas: velocidade máxima (km/h) e excessos no GPS do condutor entre o pedido e a entrega (null sem GPS) */
  maxSpeed: number | null;
  violations: number | null;
}

/**
 * O dia de uma pessoa da tabela (chave da Atividade do Dia: emp:<id> ou
 * agent:<nome>): as recolhas, entregas e movimentos que contam nesse dia — a
 * MESMA regra da Atividade do Dia (o dia do turno: a noite que passa a
 * meia-noite fica no dia em que começou) — com a reserva, o tempo
 * pendente→entregue e a velocidade máxima em cada entrega; e o GPS do turno.
 */
export async function getDriverShiftDay(date: string, key: string, nowMs: number = Date.now()) {
  const [kind, ...rest] = key.split(":");
  const ref = rest.join(":");
  if (!["emp", "agent"].includes(kind) || !ref) throw new TRPCError({ code: "BAD_REQUEST", message: "Sem ações para mostrar desta linha (PDA sem login)." });
  const empId = kind === "emp" ? Number(ref) : null;
  if (kind === "emp" && !(Number.isSafeInteger(empId) && empId! > 0)) throw new TRPCError({ code: "BAD_REQUEST", message: "Pessoa inválida." });

  const { loadIdentityResolver } = await import("./dayActivity");
  const { classifyActionShift } = await import("./activityHelpers");
  const { resolve, emps } = await loadIdentityResolver();
  const emp = empId != null ? emps.find((e) => e.id === empId) : undefined;

  // escala da véspera e do dia (para o dia do turno de cada ação, como na Atividade do Dia)
  const db = await getDb();
  const roster = db && emp ? (await db.select().from(extrasDiaAssignments)
    .where(and(inArray(extrasDiaAssignments.assignmentDate, [addDays(date, -1), date]), cityNameScope(extrasDiaAssignments.city))))
    .filter((a) => a.employeeId === emp.id || (a.employeeId == null && matchKey(a.personName) === matchKey(emp.fullName))) : [];
  const windowsOf = (d: string) => roster.filter((a) => a.assignmentDate === d).map((a) => ({ date: d, startHour: a.startHour, endHour: a.sentHomeHour ?? a.endHour }));
  const lastHour = Math.max(24, ...roster.filter((a) => a.assignmentDate === date).map((a) => (a.sentHomeHour ?? a.endHour) + 1));

  // UMA leitura: a cidade, da véspera (pedidos de entrega até 10 h antes) ao fim do turno da noite
  const from = mysqlTs(lisbonDayRangeUtc(date).startMs - TIMING_MAX_MIN * 60_000);
  const to = mysqlTs(Math.max(lisbonDayRangeUtc(date).endMs, lisbonDayRangeUtc(date).startMs + lastHour * 3_600_000));
  const { readLiveHistory } = await import("./multiparkDb/historyLive");
  let rows: Awaited<ReturnType<typeof readLiveHistory>>;
  try {
    rows = await readLiveHistory({ changeTypes: ["CHECK_IN", "CHECK_OUT", "MOVEMENT", "PENDING_CHECKOUT", "CHECKING_OUT"], from, to, cities: scopedCityNamesLive(), limit: HIST_LIMIT, order: "asc" });
  } catch (err) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `BD da Multipark sem resposta: ${String((err as Error)?.message ?? err).slice(0, 120)}` });
  }
  const pairs = deliveryPairs(rows);
  const pairByDelivery = new Map<string, DeliveryPair>();
  for (const p of pairs) if (p.deliveredAt) pairByDelivery.set(`${p.booking}|${p.deliveredAt}`, p);

  const dayOf = (at: string) => {
    const cal = lisbonDayOf(at);
    if (!roster.length) return cal;
    return classifyActionShift(cal, [...windowsOf(addDays(cal, -1)), ...windowsOf(cal)], (d) => lisbonHoursSince(d, at)).day;
  };
  // 14 out 2026: cada MOVEMENT pelo modifiedFields (a regra da Avaliação e de Condutores e agentes —
  // shared/multiparkMovements.ts → classifyMovement; o tipo vem do SQL sobre o texto completo): o
  // início de um movimento não é uma ação (fica de fora) e a mudança de lugar aparece como tal.
  const { classifyMovement, displayChangeType, MOVEMENT_KIND_CHANGE_TYPES } = await import("../shared/multiparkMovements");
  const typeOf = (r: (typeof rows)[number]): string => {
    const ct = (r.changeType ?? "").toUpperCase();
    return ct === "MOVEMENT" ? displayChangeType(ct, r.moveKind ?? classifyMovement(r.modifiedFields)) : ct;
  };
  const mine = rows.filter((r): r is (typeof rows)[number] & { actionTime: string } => {
    const ct = (r.changeType ?? "").toUpperCase();
    if (!r.actionTime || !["CHECK_IN", "CHECK_OUT", "MOVEMENT"].includes(ct)) return false;
    if (typeOf(r) === MOVEMENT_KIND_CHANGE_TYPES.inicio) return false;
    const who = resolve(r.agentUserId, r.agentName);
    return who.kind !== "ignorado" && who.key === key && dayOf(r.actionTime) === date;
  });
  const actions: DriverAction[] = [];
  for (const r of mine) {
    const ct = (r.changeType ?? "").toUpperCase();
    const pair = ct === "CHECK_OUT" ? pairByDelivery.get(`${r.bookingExternalId}|${r.actionTime}`) : undefined;
    let delay: number | null = null;
    if (ct === "CHECK_IN" && r.checkIn) {
      const m = Math.trunc((utcMs(r.actionTime) - utcMs(r.checkIn)) / 60_000);
      if (Number.isFinite(m) && Math.abs(m) < TIMING_MAX_MIN) delay = m;
    }
    actions.push({
      at: r.actionTime, changeType: typeOf(r), booking: r.bookingExternalId, bookingCode: r.bookingCode, plate: r.licensePlate, parkName: r.parkName,
      pendingAt: pair?.pendingAt ?? null, takenAt: pair?.takenAt ?? null, mins: pair?.mins != null && pair.mins < TIMING_MAX_MIN ? pair.mins : null,
      plannedIn: ct === "CHECK_IN" ? r.checkIn : null, delayMins: delay, maxSpeed: null, violations: null,
    });
  }

  // GPS (só com ficha): o turno e cada entrega
  let gps: { source: ShiftWindowSource | null; windows: Array<{ start: string; end: string }>; stoppedHours: number | null; movingHours: number | null; maxSpeed: number | null; violations: number | null; partial: boolean; threshold: number | null; available: boolean } | null = null;
  let shiftInfo: Array<{ shift: string; city: string; startHour: number; endHour: number; isTeamLeader: boolean }> = [];
  if (empId != null) {
    const [scoped] = await scopedEmployeeIds([empId]);
    if (scoped != null) {
      const s = (await shiftsFor(date, [empId], nowMs)).get(empId)!;
      shiftInfo = s.roster.map((a) => ({ shift: a.shift, city: a.city, startHour: a.startHour, endHour: a.sentHomeHour ?? a.endHour, isTeamLeader: a.isTeamLeader }));
      // a entrega: do pedido (ou, sem pedido registado, de quando pegou no carro) até entregar
      const deliveryWindow = (a: DriverAction): TimeWindow | null => {
        const from = a.pendingAt ?? a.takenAt;
        return a.changeType === "CHECK_OUT" && from ? { startMs: utcMs(from), endMs: utcMs(a.at) + 1000 } : null;
      };
      const deliveryWindows = actions.map(deliveryWindow).filter((x): x is TimeWindow => !!x);
      const days = daysOfWindows([...s.windows, ...deliveryWindows]);
      const { threshold, minPoints } = await speedRule();
      const held = await heldPointsFor(new Map([[empId, days]]), { deadlineAt: Date.now() + GPS_DEADLINE_MS });
      const files = held.byEmp.get(empId);
      const failed = held.failed.get(empId) ?? 0;
      if (files?.length) {
        for (const a of actions) {
          const win = deliveryWindow(a);
          if (!win) continue;
          const st = heldStats(files, [win], threshold, minPoints);
          a.maxSpeed = st.points > 0 ? Math.round(st.maxSpeed) : null;
          a.violations = st.points > 0 ? st.violations : null;
        }
      }
      const st = files?.length && s.windows.length ? heldStats(files, s.windows, threshold, minPoints) : null;
      const missingDay = days.some((d) => d <= lisbonDayOf(nowMs) && !held.collectedDays.has(d));
      gps = {
        source: s.source, windows: isoWindows(s.windows),
        stoppedHours: st ? r1(st.stoppedMinutes / 60) : null, movingHours: st ? r1(st.movingMinutes / 60) : null,
        maxSpeed: st && st.points > 0 ? Math.round(st.maxSpeed) : null, violations: st && st.points > 0 ? st.violations : null,
        partial: failed > 0 || missingDay, threshold, available: !!files?.length,
      };
    }
  }
  return {
    date, key, name: emp?.fullName ?? (kind === "agent" ? ref : `#${ref}`), employeeId: empId,
    actions, shifts: shiftInfo, gps,
    truncated: rows.length >= HIST_LIMIT,
  };
}

// ─── 3. Uma entrega lenta e o que havia no mesmo horário ────────────────────

const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * A entrega (reserva, pedido, quem pegou, entregue, minutos) e os outros
 * pedidos da mesma cidade à espera ao mesmo tempo. UMA leitura ao histórico:
 * só a cidade (o âmbito do pedido), da hora do pedido − 10 h à entrega + 10 h.
 */
export async function getDeliveryContext(o: { booking: string; pendingAt: string; deliveredAt: string }, nowMs: number = Date.now()) {
  if (!TS_RE.test(o.pendingAt) || !TS_RE.test(o.deliveredAt)) throw new TRPCError({ code: "BAD_REQUEST", message: "Horas inválidas." });
  const p = utcMs(o.pendingAt), d = utcMs(o.deliveredAt);
  if (!(d >= p) || d - p > TIMING_MAX_MIN * 60_000) throw new TRPCError({ code: "BAD_REQUEST", message: "Entrega fora do intervalo do resumo (mais de 10 h)." });
  const from = mysqlTs(p - TIMING_MAX_MIN * 60_000);
  const to = mysqlTs(Math.min(d + TIMING_MAX_MIN * 60_000, nowMs + 60_000));
  const { readLiveHistory } = await import("./multiparkDb/historyLive");
  let rows: Awaited<ReturnType<typeof readLiveHistory>>;
  try {
    rows = await readLiveHistory({ changeTypes: ["PENDING_CHECKOUT", "CHECKING_OUT", "CHECK_OUT"], from, to, cities: scopedCityNamesLive(), limit: HIST_LIMIT, order: "asc" });
  } catch (err) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `BD da Multipark sem resposta: ${String((err as Error)?.message ?? err).slice(0, 120)}` });
  }
  const ctx = deliveryContext(deliveryPairs(rows), o);
  return { ...ctx, found: ctx.target != null, truncated: rows.length >= HIST_LIMIT, window: { from, to } };
}
