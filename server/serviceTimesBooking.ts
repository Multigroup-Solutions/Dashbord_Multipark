/**
 * Ficha da reserva → bloco "Tempos" (15 out 2026): cada tempo da entrega e
 * da recolha desta reserva, com a FONTE (chamada / pendente; GPS / botão /
 * app) e o MOTIVO quando não há medição. Da tabela dos tempos; sem linhas
 * (trabalho desligado ou ciclo por calcular), calculado agora a partir da
 * History desta reserva com as mesmas regras, sem GPS e sem chamadas (os
 * tempos com GPS ficam "GPS por recolher"). Só leitura; nada se grava.
 * O PORTÃO dos tempos com GPS aplica-se aqui (como nos outros ecrãs).
 */
import {
  DEFAULT_GPS_GATE, buildDeliveryCycles, buildPickupCycles, deliveryTimes, gpsTimesVisible, pickupTimes, resolveArrival,
  type GarageRoleEntry, type GpsGate, type ServiceEvent,
} from "../shared/serviceTimes";
import { DAY_TOTAL_MAX_MIN, TIME_METRICS, metricValue, visibleCities, type ServiceRow, type TimeMetric } from "./serviceTimesAgg";
import { ParamList } from "./multiparkDb/read";
import { bookingScopeSql } from "./multiparkDb/bookingFile";
import type { SqlParam } from "./multiparkDb/client";

/** Um tempo na ficha: o valor (só medido e com o portão aberto), o estado e a fonte. */
export interface BookingTime {
  key: TimeMetric | "t2";
  label: string;
  short: string;
  gps: boolean;
  ms: number | null;
  /** "medido" ou o motivo (estado do tempo). */
  status: string | null;
  /** De onde veio (chamada, pendente, gps_zona, botao, gps, app_inicio_movimento…). */
  source: string | null;
  /** Portão fechado: o texto no lugar do número. */
  hidden: string | null;
}
export interface BookingTimesEntry {
  kind: "entrega" | "recolha";
  outcome: string;
  opDay: string;
  terminalClass: string | null;
  /** Instantes (ms UTC) da linha do tempo do ciclo — os do GPS só com o portão aberto. */
  at: { call: number | null; request: number | null; start: number | null; arrived: number | null; delivered: number | null; checkIn: number | null; terminalExit: number | null };
  times: BookingTime[];
  firstGarage: string | null;
  parkedGarage: string | null;
  flags: string[];
}

const ms = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : v);
/**
 * Notas que vêm do GPS (a chegada, a paragem, a precisão, a saída do P2):
 * com o portão fechado também não vão para quem não é super admin.
 */
export const GPS_FLAGS: ReadonlySet<string> = new Set([
  "chegada_a_pe", "chegada_ajustada", "posicao_duvidosa", "precisao_fraca", "inicio_no_terminal", "nosso_aproximado", "saida_do_p2_pelo_gps",
]);
const DELIVERY_KEYS: TimeMetric[] = ["fila", "transito", "cliente", "nosso", "total"];
const PICKUP_KEYS: TimeMetric[] = ["cliente_recolha", "terminal", "ate_garagem", "p2", "ate_arrumado"];

function statusOf(r: ServiceRow, m: TimeMetric): string | null {
  switch (m) {
    case "fila": return r.queueStatus ?? null;
    case "transito": return r.transitStatus ?? null;
    case "nosso": return r.ourStatus ?? null;
    case "cliente": case "cliente_recolha": return r.customerStatus ?? null;
    case "total": return r.totalMs != null ? "medido" : r.queueStatus ?? null;
    case "terminal": case "ate_garagem": return r.terminalStatus ?? null;
    case "p2": return r.p2Status ?? null;
    case "ate_arrumado": return r.parkedStatus ?? null;
  }
}
function sourceOf(r: ServiceRow, m: TimeMetric): string | null {
  if (m === "fila" || m === "total" || m === "nosso" || m === "cliente_recolha") return r.startSource ?? null;
  if (m === "transito" || m === "cliente") return r.arrivedSource ?? null;
  if (m === "terminal" || m === "ate_garagem") return r.terminalExitSource ?? null;
  return null;
}

/**
 * As linhas da reserva → o que a ficha mostra, com o portão: com ele fechado,
 * quem não é super admin não vê os tempos com GPS (nem os instantes da
 * chegada / saída do terminal). `open` = as cidades em que o portão está
 * aberto para cada tempo (cobertura da cidade nesse dia). PURA.
 */
export function bookingTimesView(rows: readonly ServiceRow[], o: { gate: GpsGate | null | undefined; isSuperAdmin: boolean; open?: (r: ServiceRow, m: TimeMetric) => boolean }): { entries: BookingTimesEntry[]; gpsNote: string | null } {
  const gate = o.gate ?? DEFAULT_GPS_GATE;
  const closedLabel = gpsTimesVisible({ coveragePct: 0, n: 0, gate, isSuperAdmin: o.isSuperAdmin });
  const canSee = (r: ServiceRow, m: TimeMetric | "t2") => {
    if (m !== "t2" && !TIME_METRICS[m].gps) return { ok: true, hidden: null as string | null };
    if (o.isSuperAdmin) return { ok: true, hidden: null };
    if (!gate.visible) return { ok: false, hidden: closedLabel.label ?? "Em calibração" };
    const ok = o.open ? o.open(r, m === "t2" ? "terminal" : m) : false;
    return { ok, hidden: ok ? null : "Sem dados suficientes nesta cidade e dia" };
  };
  const entries = rows.filter((r) => !r.voidedAt).map((r): BookingTimesEntry => {
    const kind = r.kind === "recolha" ? "recolha" : "entrega";
    const keys = kind === "entrega" ? DELIVERY_KEYS : PICKUP_KEYS;
    const times: BookingTime[] = keys.map((m) => {
      const v = canSee(r, m);
      const def = TIME_METRICS[m];
      return {
        key: m, label: def.label, short: def.short, gps: def.gps,
        ms: v.ok ? metricValue(r, m, { totalMaxMin: DAY_TOTAL_MAX_MIN }) : null,
        status: v.ok ? statusOf(r, m) : null, source: v.ok ? sourceOf(r, m) : null, hidden: v.hidden,
      };
    });
    if (kind === "recolha" && r.terminalClass === "t2") {
      const v = canSee(r, "t2");
      times.push({ key: "t2", label: "Atraso no T2", short: "o condutor chegou ao T2 depois do alvo", gps: true, ms: v.ok && r.t2Status === "medido" ? ms(r.t2LateMs) : null, status: v.ok ? r.t2Status ?? null : null, source: null, hidden: v.hidden });
    }
    const transitOk = canSee(r, "transito").ok, terminalOk = canSee(r, "terminal").ok;
    return {
      kind, outcome: r.outcome, opDay: r.opDay, terminalClass: r.terminalClass ?? null,
      at: {
        call: ms(r.callAt), request: ms(r.requestAt), start: ms(r.startedAt), arrived: transitOk ? ms(r.arrivedAt) : null, delivered: ms(r.deliveredAt),
        checkIn: ms(r.checkInAt), terminalExit: terminalOk ? ms(r.terminalExitAt) : null,
      },
      times, firstGarage: r.firstGarage ?? null, parkedGarage: r.parkedGarage ?? null,
      flags: (r.flags ?? "").split(",").map((f) => f.trim()).filter(Boolean).filter((f) => !GPS_FLAGS.has(f) || (kind === "entrega" ? transitOk : terminalOk)),
    };
  });
  return { entries, gpsNote: o.isSuperAdmin && !gate.visible ? "em calibração" : null };
}

/**
 * Ao vivo (sem linhas na tabela): os ciclos desta reserva com as mesmas regras,
 * sem GPS e sem chamadas (Fila desde o pendente). PURA.
 */
export function bookingRowsLive(events: readonly ServiceEvent[], o: { roles: readonly GarageRoleEntry[]; now: number; cityKey: string | null; terminalClass: string | null }): ServiceRow[] {
  const out: ServiceRow[] = [];
  const noGps = resolveArrival(null, null, "gps_por_recolher");
  for (const d of buildDeliveryCycles(events).cycles) {
    const t = deliveryTimes({ cycle: d, call: null, arrival: noGps });
    out.push({
      kind: "entrega", bookingId: d.bookingId, opDay: t.opDay, refHour: t.refHour, cityKey: o.cityKey, terminalClass: o.terminalClass, outcome: t.outcome,
      startSource: t.startSource, callAt: null, requestAt: t.requestAt, startedAt: t.startedAt, arrivedAt: t.arrivedAt, arrivedSource: t.arrivedSource, deliveredAt: t.deliveredAt,
      queueMs: t.queueMs, queueStatus: t.queueStatus, transitMs: t.transitMs, transitStatus: t.transitStatus, ourMs: t.ourMs, ourStatus: t.ourStatus,
      customerMs: t.customerMs, customerStatus: t.customerStatus, totalMs: t.totalMs, flags: t.flags.join(","),
    });
  }
  for (const p of buildPickupCycles(events)) {
    const t = pickupTimes({ cycle: p, call: null, terminalExit: { kind: "sem_medicao", status: "gps_por_recolher", flags: [] }, roles: o.roles, spotType: "unknown", now: o.now });
    out.push({
      kind: "recolha", bookingId: p.bookingId, opDay: t.opDay, refHour: t.refHour, cityKey: o.cityKey, terminalClass: o.terminalClass, outcome: t.outcome,
      startSource: t.startSource, callAt: null, requestAt: t.requestAt, checkInAt: t.checkInAt, customerMs: t.customerMs, customerStatus: t.customerStatus,
      terminalMs: t.terminalMs, terminalStatus: t.terminalStatus, terminalExitAt: t.terminalExitAt, terminalExitSource: t.terminalExitSource,
      firstGarage: t.firstGarage, firstGarageRole: t.firstGarageRole, toFirstGarageMs: t.toFirstGarageMs, p2Ms: t.p2Ms, p2Status: t.p2Status,
      parkedGarage: t.parkedGarage, toParkedMs: t.toParkedMs, parkedStatus: t.parkedStatus,
      // sem GPS, o T2 fica "GPS por recolher" (nunca "a tempo")
      t2LateMs: null, t2Status: o.terminalClass === "t2" ? "gps_por_recolher" : "nao_aplicavel", flags: t.flags.join(","),
    });
  }
  return out.sort((a, b) => (b.deliveredAt ?? b.checkInAt ?? 0) - (a.deliveredAt ?? a.checkInAt ?? 0));
}

/** A reserva no âmbito de quem pede (Park.city) com o tipo de entrega e a cidade. PURA. */
export function buildBookingScopeSql(bookingId: string, cities: string[] | undefined): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const id = p.add(bookingId);
  const scope = bookingScopeSql(p, id, cities);
  return {
    sql: [
      `SELECT b."id" AS id, NULLIF(b."deliveryType", '') AS delivery_type, pk."city" AS city`,
      `  FROM "Booking" b LEFT JOIN "Park" pk ON pk."id" = b."parkId"`,
      ` WHERE b."id" = ${id} AND ${scope}`,
      ` LIMIT 1`,
    ].join("\n"),
    params: p.values,
  };
}

/**
 * O procedimento: confirma que a reserva está no âmbito de quem pede (cidade
 * do parque); depois a tabela, senão ao vivo (uma leitura da History desta
 * reserva). Só leitura. Nunca lança.
 */
export async function getBookingTimes(o: { bookingId: string; cities: string[] | undefined; isSuperAdmin: boolean }): Promise<{ available: true; source: "tabela" | "ao_vivo"; entries: BookingTimesEntry[]; gpsNote: string | null; targetMinutes: number } | { available: false; reason: string }> {
  const [{ loadBookingServiceRows, loadServiceViewSettings, loadServiceRows }, { multiparkDbQuery }, { describeReadFailure }, { matchCityKey }] = await Promise.all([
    import("./serviceTimesRead"), import("./multiparkDb/client"), import("./multiparkDb/read"), import("../shared/city"),
  ]);
  let booking: { delivery_type?: unknown; city?: unknown } | undefined;
  try {
    const q = buildBookingScopeSql(o.bookingId, o.cities);
    booking = (await multiparkDbQuery<Record<string, unknown>>(q.sql, q.params, { timeoutMs: 10_000 }))[0];
  } catch (err) {
    return { available: false, reason: describeReadFailure(err).reason };
  }
  if (!booking) return { available: false, reason: "Reserva não encontrada nas tuas cidades." };
  const cityKey = matchCityKey(booking.city == null ? null : String(booking.city));
  const st = await loadServiceViewSettings();
  let rows = await loadBookingServiceRows(o.bookingId);
  let source: "tabela" | "ao_vivo" = "tabela";
  if (!rows.length) {
    try {
      const [{ buildServiceBookingHistorySql, mapServiceHistoryRow }, { getSetting }, { terminalClassOf }] = await Promise.all([
        import("./multiparkDb/serviceRows"), import("./appSettings"), import("./serviceTimesJob"),
      ]);
      const q = buildServiceBookingHistorySql(o.bookingId);
      const raw = await multiparkDbQuery<Record<string, unknown>>(q.sql, q.params, { timeoutMs: 20_000 });
      const events = raw.map(mapServiceHistoryRow).filter((e): e is ServiceEvent => !!e);
      const roles = ((await getSetting("operations.garageRoles").catch(() => null)) as GarageRoleEntry[] | null) ?? [];
      const zoneCity = cityKey === "lisboa" ? "lisbon" : cityKey === "porto" ? "porto" : cityKey === "faro" ? "faro" : null;
      rows = bookingRowsLive(events, { roles, now: Date.now(), cityKey, terminalClass: terminalClassOf(booking.delivery_type == null ? null : String(booking.delivery_type), zoneCity) });
      source = "ao_vivo";
    } catch (err) {
      return { available: false, reason: describeReadFailure(err).reason };
    }
  }
  // portão aberto (e quem pede não é super admin): a cobertura da cidade nesse dia decide
  let open: ((r: ServiceRow, m: TimeMetric) => boolean) | undefined;
  if (st.gate.visible && !o.isSuperAdmin && source === "tabela") {
    const cache = new Map<string, ServiceRow[]>();
    for (const k of [...new Set(rows.map((r) => `${r.opDay}|${r.cityKey ?? ""}|${r.kind}`))]) {
      const [day, city, kind] = k.split("|");
      cache.set(k, city ? await loadServiceRows({ fromDay: day, toDay: day, cityKeys: [city], kind: kind as "entrega" | "recolha" }) : []);
    }
    open = (r, m) => visibleCities(cache.get(`${r.opDay}|${r.cityKey ?? ""}|${r.kind}`) ?? [], m, { gate: st.gate, isSuperAdmin: false }).cities.has(r.cityKey ?? "");
  }
  const v = bookingTimesView(rows, { gate: st.gate, isSuperAdmin: o.isSuperAdmin, open });
  return { available: true, source, entries: v.entries, gpsNote: v.gpsNote, targetMinutes: st.targetMinutes };
}
