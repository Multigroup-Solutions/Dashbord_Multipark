/**
 * "Pressão" do Extras-Dia — agregação pesada FEITA NO POSTGRES da BD da
 * Multipark (só leitura), para o trabalho `extras-pressure`
 * (server/extrasPressure.ts), que guarda o resultado na NOSSA BD
 * (ops_pressure_stats). Regras em shared/extrasPressure.ts.
 *
 * Janela: desde `extras.timesSince` (22d: 3 abr 2026, 6 meses para trás) até
 * ontem — cresce todos os dias e nunca deita fora o que já mediu.
 * Pedaços ("chunks"): um por grupo de parques — cada cidade (todas as marcas
 * nossas), cada marca + cidade nossa, e o Marketplace (os outros todos). Cada
 * pedaço são 2 leituras sobre só os parques do grupo (índices
 * (parkId, checkInDate/checkOutDate)), com GROUP BY e percentile_cont no
 * Postgres. Porquê por grupo e não por fatias de 10 dias: os percentis não se
 * somam entre fatias — por grupo cada percentil sai exato da janela inteira e
 * cada leitura continua pequena (só os parques do grupo). A "History" ainda
 * não tem índice em actionTime/bookingId: é uma leitura sequencial de
 * ~300 mil linhas por pedaço, bem abaixo dos 15 s.
 *
 * Colunas usadas (docs/multipark-db/schema.md):
 *   Booking: id, parkId, status, checkIn, checkOut, checkInDate, checkOutDate,
 *     checkingInAt, pendingCheckoutAt, checkingOutAt, arrivedAtDeliveryAt
 *   History: bookingId, changeType (CHECKING_IN, CHECK_IN, PENDING_CHECKOUT,
 *     CHECKING_OUT, CHECK_OUT), actionTime
 *   Park: id, name, city, firebaseBrand, listingType, status (classificação)
 *
 * Instantes (UTC na BD):
 *   check-in começado = checkingInAt → 1.º CHECKING_IN da History
 *   check-in feito    = 1.º CHECK_IN da History → checkIn (se o estado já passou o check-in)
 *   pedido de entrega = pendingCheckoutAt → 1.º PENDING_CHECKOUT
 *   check-out começado = pedido → checkingOutAt → 1.º CHECKING_OUT
 *   check-out feito   = 1.º CHECK_OUT → checkOut (se CHECKED_OUT)
 *   entregue          = arrivedAtDeliveryAt → 1.º CHECK_OUT → checkOut (se CHECKED_OUT)
 * Tempo de entrega = pedido → entregue (0 < t ≤ 240 min); tempo de recolha =
 * check-in começado → feito (0 < t ≤ 180 min). `customerCheckinEta` é um
 * número de minutos (ETA dado pelo cliente), não um instante — não entra.
 */
import { type SqlParam } from "./client";
import { ParamList } from "./read";
import { lisbonLocal } from "./movements";
import { type DayPark } from "./dayBookings";
import { OUR_PARK_BRANDS, OUR_PARK_BRAND_LABELS, OUR_PARK_CITIES, MARKETPLACE_GROUP_KEY, MARKETPLACE_GROUP_LABEL } from "../../shared/multiparkParks";
import { CITY_LABELS } from "../../shared/city";
import { addDays, lisbonDayRangeUtc } from "../../shared/lisbonDay";
import { PICKUP_PAIR_AFTER_MIN } from "../../shared/extrasSchedule";
import {
  LOAD_BUCKETS, MAX_CYCLE_MINUTES, MAX_DELIVERY_MINUTES, MAX_PICKUP_MINUTES, MAX_TO_PARK_MINUTES, PRESSURE_SINCE_DEFAULT, PRESSURE_WINDOW_DAYS,
  RUSH_HOURS, cityGroupKey, isoWeekday,
  type CrewMeasureBand, type PressureCrewRow, type PressureLoadRow, type PressureSlot,
} from "../../shared/extrasPressure";

// ─── Janela ─────────────────────────────────────────────────────────────────

export interface PressureWindow {
  /** Primeiro dia de Lisboa (inclusive). */
  startDay: string;
  /** Último dia de Lisboa (inclusive) — ontem. */
  endDay: string;
  /** Limites UTC "YYYY-MM-DD HH:MM:SS" [start, end). */
  start: string;
  end: string;
  /** Com 1 dia de folga (colunas …Date e History). */
  wideStart: string;
  wideEnd: string;
  /** Quantas vezes aparece cada dia da semana (1–7) na janela. */
  weekdayDays: Record<number, number>;
}

const sqlTs = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** Janela de `days` dias de Lisboa que acaba em `endDay` (inclusive). PURA. */
export function pressureWindow(endDay: string, days = PRESSURE_WINDOW_DAYS): PressureWindow {
  const startDay = addDays(endDay, -(days - 1));
  const r = lisbonDayRangeUtc(startDay, endDay);
  const weekdayDays: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  for (let d = startDay; d <= endDay; d = addDays(d, 1)) weekdayDays[isoWeekday(d)]++;
  return { startDay, endDay, start: r.start, end: r.end, wideStart: sqlTs(r.startMs - 86_400_000), wideEnd: sqlTs(r.endMs + 86_400_000), weekdayDays };
}

/**
 * 22d: janela desde `since` (inclusive) até `endDay` — a que acumula. Um
 * `since` depois do fim (ou inválido) cai na janela antiga de 60 dias. PURA.
 */
export function pressureWindowSince(since: string | null | undefined, endDay: string): PressureWindow {
  const s = since && /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : PRESSURE_SINCE_DEFAULT;
  if (s > endDay) return pressureWindow(endDay);
  const days = Math.round((Date.parse(`${endDay}T12:00:00Z`) - Date.parse(`${s}T12:00:00Z`)) / 86_400_000) + 1;
  return pressureWindow(endDay, days);
}

// ─── Pedaços (grupos de parques) ────────────────────────────────────────────

export interface PressureChunk {
  key: string;
  label: string;
  parkIds: string[];
  /** 22d: "driver" = as leituras por condutor da cidade (passo próprio, depois dos grupos). */
  kind?: "group" | "driver";
  /** Cidade do passo "driver" (lisboa/porto/faro). */
  city?: string;
}

/**
 * Pedaços pela ordem em que correm: cidades (Lisboa, Porto, Faro — todas as
 * marcas nossas), marca + cidade, Marketplace. Grupos sem parques ficam de
 * fora. PURA.
 */
export function buildPressureChunks(parks: Array<Pick<DayPark, "id" | "key" | "ours" | "city">>): PressureChunk[] {
  const out: PressureChunk[] = [];
  const ours = parks.filter((p) => p.ours);
  for (const city of OUR_PARK_CITIES) {
    const ids = ours.filter((p) => p.city === city).map((p) => p.id);
    if (ids.length) out.push({ key: cityGroupKey(city), label: `${CITY_LABELS[city]} (todas as marcas)`, parkIds: ids });
  }
  for (const city of OUR_PARK_CITIES) {
    for (const brand of OUR_PARK_BRANDS) {
      const key = `${brand}_${city}`;
      const ids = ours.filter((p) => p.key === key).map((p) => p.id);
      if (ids.length) out.push({ key, label: `${OUR_PARK_BRAND_LABELS[brand]} ${CITY_LABELS[city]}`, parkIds: ids });
    }
  }
  const others = parks.filter((p) => !p.ours).map((p) => p.id);
  if (others.length) out.push({ key: MARKETPLACE_GROUP_KEY, label: MARKETPLACE_GROUP_LABEL, parkIds: others });
  // 22d: por condutor, só nas cidades, no fim (as células da cidade já existem).
  for (const city of OUR_PARK_CITIES) {
    const ids = ours.filter((p) => p.city === city).map((p) => p.id);
    if (ids.length) out.push({ key: cityGroupKey(city), label: `${CITY_LABELS[city]} (condutores)`, parkIds: ids, kind: "driver", city });
  }
  return out;
}

// ─── SQL ────────────────────────────────────────────────────────────────────

/** Estados em que o check-in já foi feito. */
const AFTER_CHECKIN = ["CHECKED_IN", "MOVING", "PENDING_CHECKOUT", "CHECKING_OUT", "CHECKED_OUT"];
const HISTORY_TYPES = ["CHECKING_IN", "CHECK_IN", "PENDING_CHECKOUT", "CHECKING_OUT", "CHECK_OUT"];
const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");

const L = lisbonLocal;
const minutesBetween = (a: string, b: string) => `extract(epoch from (${b} - ${a})) / 60.0`;

/**
 * CTEs comuns (sem o WITH): `bk` reservas do grupo com movimento na janela
 * (±1 dia), `hi` 1.ª ação de cada tipo na History, `ev` os instantes de cada
 * reserva, `dv` entregas e `pk` recolhas válidas. PURA.
 */
export function pressureBaseCtes(p: ParamList, w: PressureWindow, parkIds: string[]): string {
  if (!parkIds.length) throw new Error("Sem parques.");
  const parks = parkIds.map((id) => p.add(id)).join(", ");
  const ws = p.add(w.wideStart);
  const we = p.add(w.wideEnd);
  const s = p.add(w.start);
  const e = p.add(w.end);
  return [
    `bk AS (`,
    `  SELECT b."id" AS id, b."status"::text AS st, b."checkIn" AS ci_plan, b."checkOut" AS co_plan,`,
    `    b."checkingInAt" AS checking_in_at, b."pendingCheckoutAt" AS pending_at, b."checkingOutAt" AS checking_out_at, b."arrivedAtDeliveryAt" AS arrived_at`,
    `  FROM "Booking" b`,
    `  WHERE b."parkId" IN (${parks}) AND b."status"::text <> 'CANCELLED'`,
    `    AND ((b."checkInDate" >= ${ws}::timestamp AND b."checkInDate" < ${we}::timestamp) OR (b."checkOutDate" >= ${ws}::timestamp AND b."checkOutDate" < ${we}::timestamp))`,
    `),`,
    `hi AS (`,
    `  SELECT h."bookingId" AS bid,`,
    `    min(h."actionTime") FILTER (WHERE h."changeType"::text = 'CHECKING_IN') AS h_checking_in,`,
    `    min(h."actionTime") FILTER (WHERE h."changeType"::text = 'CHECK_IN') AS h_check_in,`,
    `    min(h."actionTime") FILTER (WHERE h."changeType"::text = 'PENDING_CHECKOUT') AS h_pending,`,
    `    min(h."actionTime") FILTER (WHERE h."changeType"::text = 'CHECKING_OUT') AS h_checking_out,`,
    `    min(h."actionTime") FILTER (WHERE h."changeType"::text = 'CHECK_OUT') AS h_check_out`,
    `  FROM "History" h`,
    `  WHERE h."actionTime" >= ${ws}::timestamp AND h."actionTime" < ${we}::timestamp`,
    `    AND h."changeType"::text IN (${inList(HISTORY_TYPES)})`,
    `    AND h."bookingId" IN (SELECT bk.id FROM bk)`,
    `  GROUP BY h."bookingId"`,
    `),`,
    `ev AS (`,
    `  SELECT bk.id,`,
    `    COALESCE(bk.checking_in_at, hi.h_checking_in) AS ci_started,`,
    `    COALESCE(hi.h_check_in, CASE WHEN bk.st IN (${inList(AFTER_CHECKIN)}) THEN bk.ci_plan END) AS ci_done,`,
    `    COALESCE(bk.pending_at, hi.h_pending) AS co_requested,`,
    `    COALESCE(bk.pending_at, hi.h_pending, bk.checking_out_at, hi.h_checking_out) AS co_started,`,
    `    COALESCE(hi.h_check_out, CASE WHEN bk.st = 'CHECKED_OUT' THEN bk.co_plan END) AS co_done,`,
    `    COALESCE(bk.arrived_at, hi.h_check_out, CASE WHEN bk.st = 'CHECKED_OUT' THEN bk.co_plan END) AS delivered`,
    `  FROM bk LEFT JOIN hi ON hi.bid = bk.id`,
    `),`,
    `dv AS (`,
    `  SELECT ev.co_requested AS req_at, ${minutesBetween("ev.co_requested", "ev.delivered")} AS mins`,
    `  FROM ev`,
    `  WHERE ev.co_requested >= ${s}::timestamp AND ev.co_requested < ${e}::timestamp`,
    `    AND ev.delivered > ev.co_requested AND ev.delivered - ev.co_requested <= interval '${MAX_DELIVERY_MINUTES} minutes'`,
    `),`,
    `pk AS (`,
    `  SELECT ev.ci_started AS begun_at, ${minutesBetween("ev.ci_started", "ev.ci_done")} AS mins`,
    `  FROM ev`,
    `  WHERE ev.ci_started >= ${s}::timestamp AND ev.ci_started < ${e}::timestamp`,
    `    AND ev.ci_done > ev.ci_started AND ev.ci_done - ev.ci_started <= interval '${MAX_PICKUP_MINUTES} minutes'`,
    `),`,
    // Eventos concluídos/começados dentro da janela (hora de Lisboa).
    `xe AS (`,
    `  SELECT 'ci_done' AS kind, ev.ci_done AS at FROM ev WHERE ev.ci_done >= ${s}::timestamp AND ev.ci_done < ${e}::timestamp`,
    `  UNION ALL SELECT 'co_done', ev.co_done FROM ev WHERE ev.co_done >= ${s}::timestamp AND ev.co_done < ${e}::timestamp`,
    `  UNION ALL SELECT 'ci_started', ev.ci_started FROM ev WHERE ev.ci_started >= ${s}::timestamp AND ev.ci_started < ${e}::timestamp`,
    `  UNION ALL SELECT 'co_started', ev.co_started FROM ev WHERE ev.co_started >= ${s}::timestamp AND ev.co_started < ${e}::timestamp`,
    `)`,
  ].join("\n");
}

const wdSql = (col: string) => `extract(isodow from ${col})::int`;
const hrSql = (col: string) => `extract(hour from ${col})::int`;

/**
 * Leitura 1 — por (dia da semana, hora de Lisboa): volume, concorrência,
 * tempos de entrega (pela hora do pedido) e de recolha (pela hora do início).
 * Concorrência: cada operação (recolha: começo → check-in; entrega: pedido →
 * check-out) conta em cada hora de relógio que toca; por hora de calendário
 * soma-se e depois agrega-se por (dia da semana, hora): soma e máximo. PURA.
 */
export function buildPressureSlotsSql(w: PressureWindow, parkIds: string[]): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const base = pressureBaseCtes(p, w, parkIds);
  const s = p.add(w.start);
  const e = p.add(w.end);
  const pct = (q: number, from: string) => `percentile_cont(${q}) WITHIN GROUP (ORDER BY ${from}.mins)`;
  const sql = [
    `WITH ${base},`,
    `ops AS (`,
    `  SELECT ${L("COALESCE(ev.ci_started, ev.ci_done)")} AS op_from, ${L("ev.ci_done")} AS op_to FROM ev`,
    `   WHERE ev.ci_done >= ${s}::timestamp AND ev.ci_done < ${e}::timestamp AND ev.ci_done - COALESCE(ev.ci_started, ev.ci_done) <= interval '${MAX_PICKUP_MINUTES} minutes' AND ev.ci_done >= COALESCE(ev.ci_started, ev.ci_done)`,
    `  UNION ALL`,
    `  SELECT ${L("COALESCE(ev.co_started, ev.delivered)")}, ${L("COALESCE(ev.co_done, ev.delivered)")} FROM ev`,
    `   WHERE ev.delivered >= ${s}::timestamp AND ev.delivered < ${e}::timestamp AND COALESCE(ev.co_done, ev.delivered) - COALESCE(ev.co_started, ev.delivered) <= interval '${MAX_DELIVERY_MINUTES} minutes' AND COALESCE(ev.co_done, ev.delivered) >= COALESCE(ev.co_started, ev.delivered)`,
    `),`,
    `oh AS (SELECT gs AS hr_at, count(*) AS n FROM ops, generate_series(date_trunc('hour', ops.op_from), date_trunc('hour', ops.op_to), interval '1 hour') AS gs GROUP BY gs),`,
    `conc AS (SELECT ${wdSql("oh.hr_at")} AS wd, ${hrSql("oh.hr_at")} AS hr, sum(oh.n) AS conc_sum, max(oh.n) AS conc_max FROM oh GROUP BY 1, 2),`,
    `vol AS (`,
    `  SELECT ${wdSql(L("xe.at"))} AS wd, ${hrSql(L("xe.at"))} AS hr,`,
    `    count(*) FILTER (WHERE xe.kind = 'ci_done') AS ci_done, count(*) FILTER (WHERE xe.kind = 'co_done') AS co_done,`,
    `    count(*) FILTER (WHERE xe.kind = 'ci_started') AS ci_started, count(*) FILTER (WHERE xe.kind = 'co_started') AS co_started`,
    `  FROM xe GROUP BY 1, 2`,
    `),`,
    `del AS (SELECT ${wdSql(L("dv.req_at"))} AS wd, ${hrSql(L("dv.req_at"))} AS hr, count(*) AS n, ${pct(0.5, "dv")} AS p50, ${pct(0.75, "dv")} AS p75, ${pct(0.9, "dv")} AS p90 FROM dv GROUP BY 1, 2),`,
    `pik AS (SELECT ${wdSql(L("pk.begun_at"))} AS wd, ${hrSql(L("pk.begun_at"))} AS hr, count(*) AS n, ${pct(0.5, "pk")} AS p50, ${pct(0.75, "pk")} AS p75 FROM pk GROUP BY 1, 2),`,
    `keys AS (SELECT wd, hr FROM vol UNION SELECT wd, hr FROM conc UNION SELECT wd, hr FROM del UNION SELECT wd, hr FROM pik)`,
    `SELECT k.wd, k.hr,`,
    `  COALESCE(vol.ci_done, 0) AS ci_done, COALESCE(vol.co_done, 0) AS co_done, COALESCE(vol.ci_started, 0) AS ci_started, COALESCE(vol.co_started, 0) AS co_started,`,
    `  COALESCE(conc.conc_sum, 0) AS conc_sum, conc.conc_max AS conc_max,`,
    `  COALESCE(del.n, 0) AS del_n, del.p50 AS del_p50, del.p75 AS del_p75, del.p90 AS del_p90,`,
    `  COALESCE(pik.n, 0) AS pik_n, pik.p50 AS pik_p50, pik.p75 AS pik_p75`,
    `FROM keys k`,
    `LEFT JOIN vol ON vol.wd = k.wd AND vol.hr = k.hr`,
    `LEFT JOIN conc ON conc.wd = k.wd AND conc.hr = k.hr`,
    `LEFT JOIN del ON del.wd = k.wd AND del.hr = k.hr`,
    `LEFT JOIN pik ON pik.wd = k.wd AND pik.hr = k.hr`,
    `ORDER BY k.wd, k.hr`,
    `LIMIT 200`,
  ].join("\n");
  return { sql, params: p.values };
}

/** CASE do escalão de carga (constantes nossas). PURA. */
export function loadBucketCase(col: string): string {
  const whens = [...LOAD_BUCKETS].reverse().map((b) => `WHEN ${col} >= ${Number(b.min)} THEN ${Number(b.id)}`).join(" ");
  return `CASE ${whens} ELSE 0 END`;
}

/** Condição "hora de ponta" (constantes nossas). PURA. */
export function rushCase(hourCol: string): string {
  return `(${RUSH_HOURS.map(([a, b]) => `(${hourCol} >= ${Number(a)} AND ${hourCol} < ${Number(b)})`).join(" OR ")})`;
}

/**
 * Leitura 2 — carga × tempo de entrega: cada entrega recebe a carga da sua
 * hora de calendário (check-ins + check-outs concluídos nessa hora, no grupo)
 * e agrupa-se por escalão de carga × ponta/resto. PURA.
 */
export function buildPressureLoadSql(w: PressureWindow, parkIds: string[]): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const base = pressureBaseCtes(p, w, parkIds);
  const pct = (q: number) => `percentile_cont(${q}) WITHIN GROUP (ORDER BY dh.mins)`;
  const sql = [
    `WITH ${base},`,
    `ph AS (SELECT date_trunc('hour', ${L("xe.at")}) AS hr_at, count(*) AS n FROM xe WHERE xe.kind IN ('ci_done', 'co_done') GROUP BY 1),`,
    `dh AS (SELECT date_trunc('hour', ${L("dv.req_at")}) AS hr_at, dv.mins FROM dv)`,
    `SELECT ${loadBucketCase("COALESCE(ph.n, 0)")} AS lb,`,
    `  ${rushCase(hrSql("dh.hr_at"))} AS rush,`,
    `  count(*) AS n, ${pct(0.5)} AS p50, ${pct(0.75)} AS p75, ${pct(0.9)} AS p90`,
    `FROM dh LEFT JOIN ph ON ph.hr_at = dh.hr_at`,
    `GROUP BY 1, 2`,
    `ORDER BY 1, 2`,
    `LIMIT 50`,
  ].join("\n");
  return { sql, params: p.values };
}

// ─── 22d: por condutor (só nas cidades) ─────────────────────────────────────

const JOB_START_TYPES = ["CHECKING_OUT", "CHECKING_IN"];
const DRIVER_TYPES = ["CHECKING_IN", "CHECK_IN", "MOVEMENT", "CHECKING_OUT", "CHECK_OUT"];

/**
 * CTEs dos serviços por condutor (sem o WITH):
 *   ha   ações da History nas reservas do grupo (janela ±1 dia);
 *   crew pessoas diferentes com ações em cada hora de Lisboa;
 *   js   início de cada serviço (1.º início da entrega / da recolha de cada
 *        reserva) e quem o começou;
 *   ph/mv entregue, recolhido e 1.º movimento depois de recolhido;
 *   jo/jp vizinhos de cada serviço do mesmo condutor e o par "entrega +
 *        recolha pelo meio" (26d: recolha até 30 min depois de entregar);
 *   jb   por serviço: intervalo até ao serviço seguinte do mesmo condutor
 *        (no par: da entrega ao serviço a seguir à recolha; a recolha do par
 *        não tem intervalo próprio), na estrada (entregas) e até ao parque
 *        (recolhas);
 *   jw   os da janela, com as durações dentro dos limites (fora → NULL);
 *   hj   serviços começados em cada hora. PURA.
 */
export function pressureDriverCtes(p: ParamList, w: PressureWindow, parkIds: string[]): string {
  if (!parkIds.length) throw new Error("Sem parques.");
  const parks = parkIds.map((id) => p.add(id)).join(", ");
  const ws = p.add(w.wideStart);
  const we = p.add(w.wideEnd);
  const s = p.add(w.start);
  const e = p.add(w.end);
  const mins = (a: string, b: string) => `extract(epoch from (${b} - ${a})) / 60.0`;
  const pairAfter = `interval '${Number(PICKUP_PAIR_AFTER_MIN)} minutes'`;
  return [
    `bk AS (`,
    `  SELECT b."id" AS id FROM "Booking" b`,
    `  WHERE b."parkId" IN (${parks}) AND b."status"::text <> 'CANCELLED'`,
    `    AND ((b."checkInDate" >= ${ws}::timestamp AND b."checkInDate" < ${we}::timestamp) OR (b."checkOutDate" >= ${ws}::timestamp AND b."checkOutDate" < ${we}::timestamp))`,
    `),`,
    `ha AS (`,
    `  SELECT h."bookingId" AS bid, h."changeType"::text AS ct, h."actionTime" AS at, h."userId" AS uid`,
    `  FROM "History" h`,
    `  WHERE h."actionTime" >= ${ws}::timestamp AND h."actionTime" < ${we}::timestamp`,
    `    AND h."changeType"::text IN (${inList(DRIVER_TYPES)})`,
    `    AND h."bookingId" IN (SELECT bk.id FROM bk)`,
    `),`,
    `crew AS (SELECT date_trunc('hour', ${L("ha.at")}) AS hr_at, count(DISTINCT ha.uid) AS n FROM ha WHERE ha.uid IS NOT NULL AND ha.uid <> '' GROUP BY 1),`,
    `js AS (`,
    `  SELECT DISTINCT ON (ha.bid, ha.ct) ha.bid, ha.ct, ha.at, ha.uid FROM ha`,
    `  WHERE ha.ct IN (${inList(JOB_START_TYPES)}) AND ha.uid IS NOT NULL AND ha.uid <> ''`,
    `  ORDER BY ha.bid, ha.ct, ha.at`,
    `),`,
    `ph AS (`,
    `  SELECT ha.bid, min(ha.at) FILTER (WHERE ha.ct = 'CHECK_OUT') AS co_done, min(ha.at) FILTER (WHERE ha.ct = 'CHECK_IN') AS ci_done`,
    `  FROM ha GROUP BY ha.bid`,
    `),`,
    `mv AS (`,
    `  SELECT ha.bid, min(ha.at) AS mv_at FROM ha JOIN ph ON ph.bid = ha.bid`,
    `  WHERE ha.ct = 'MOVEMENT' AND ph.ci_done IS NOT NULL AND ha.at > ph.ci_done GROUP BY ha.bid`,
    `),`,
    // 26d (regra do Jorge): uma entrega seguida de uma recolha do MESMO condutor
    // até PICKUP_PAIR_AFTER_MIN (30) min depois de entregar é UM serviço (volta ao
    // parque com o carro da recolha): o intervalo da entrega vai até ao início
    // do serviço a seguir à recolha e a recolha não conta à parte.
    `jo AS (`,
    `  SELECT js.bid, js.ct, js.at, js.uid, ph.co_done,`,
    `    lead(js.at) OVER wu AS n1_at, lead(js.ct) OVER wu AS n1_ct, lead(js.at, 2) OVER wu AS n2_at,`,
    `    lag(js.at) OVER wu AS p1_at, lag(js.ct) OVER wu AS p1_ct, lag(ph.co_done) OVER wu AS p1_co_done`,
    `  FROM js LEFT JOIN ph ON ph.bid = js.bid`,
    `  WINDOW wu AS (PARTITION BY js.uid ORDER BY js.at, js.bid)`,
    `),`,
    `jp AS (`,
    `  SELECT jo.*,`,
    `    COALESCE(jo.ct = 'CHECKING_OUT' AND jo.n1_ct = 'CHECKING_IN' AND jo.n1_at >= jo.at AND jo.n1_at <= jo.co_done + ${pairAfter}, false) AS pair_next,`,
    `    COALESCE(jo.ct = 'CHECKING_IN' AND jo.p1_ct = 'CHECKING_OUT' AND jo.at >= jo.p1_at AND jo.at <= jo.p1_co_done + ${pairAfter}, false) AS pair_prev`,
    `  FROM jo`,
    `),`,
    `jb AS (`,
    `  SELECT jp.at, date_trunc('hour', ${L("jp.at")}) AS hr_at,`,
    `    CASE WHEN jp.pair_prev THEN NULL WHEN jp.pair_next THEN ${mins("jp.at", "jp.n2_at")} ELSE ${mins("jp.at", "jp.n1_at")} END AS gap,`,
    `    CASE WHEN jp.ct = 'CHECKING_OUT' AND jp.co_done >= jp.at THEN ${mins("jp.at", "jp.co_done")} END AS drive,`,
    `    CASE WHEN jp.ct = 'CHECKING_IN' THEN ${mins("ph.ci_done", "mv.mv_at")} END AS to_park`,
    `  FROM jp LEFT JOIN ph ON ph.bid = jp.bid LEFT JOIN mv ON mv.bid = jp.bid`,
    `),`,
    `jw AS (`,
    `  SELECT jb.hr_at,`,
    `    CASE WHEN jb.gap > 0 AND jb.gap <= ${MAX_CYCLE_MINUTES} THEN jb.gap END AS cycle,`,
    `    CASE WHEN jb.drive > 0 AND jb.drive <= ${MAX_DELIVERY_MINUTES} THEN jb.drive END AS drive,`,
    `    CASE WHEN jb.to_park > 0 AND jb.to_park <= ${MAX_TO_PARK_MINUTES} THEN jb.to_park END AS to_park`,
    `  FROM jb WHERE jb.at >= ${s}::timestamp AND jb.at < ${e}::timestamp`,
    `),`,
    `hj AS (SELECT jw.hr_at, count(*) AS jobs FROM jw GROUP BY 1)`,
  ].join("\n");
}

/**
 * Leitura 3 (cidades) — por (dia da semana, hora de Lisboa do início do
 * serviço): condutor por carro (p50/60/75/85/90), na estrada, até ao parque e
 * pessoas por hora (média das horas com movimento). PURA.
 */
export function buildPressureDriverSlotsSql(w: PressureWindow, parkIds: string[]): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const base = pressureDriverCtes(p, w, parkIds);
  const s = p.add(w.start);
  const e = p.add(w.end);
  const pct = (q: number, col: string) => `percentile_cont(${q}) WITHIN GROUP (ORDER BY ${col})`;
  const sql = [
    `WITH ${base},`,
    `dj AS (`,
    `  SELECT ${wdSql("jw.hr_at")} AS wd, ${hrSql("jw.hr_at")} AS hr,`,
    `    count(jw.cycle) AS cy_n, ${pct(0.5, "jw.cycle")} AS cy_p50, ${pct(0.6, "jw.cycle")} AS cy_p60, ${pct(0.75, "jw.cycle")} AS cy_p75, ${pct(0.85, "jw.cycle")} AS cy_p85, ${pct(0.9, "jw.cycle")} AS cy_p90,`,
    `    count(jw.drive) AS dr_n, ${pct(0.5, "jw.drive")} AS dr_p50, ${pct(0.75, "jw.drive")} AS dr_p75, ${pct(0.9, "jw.drive")} AS dr_p90,`,
    `    count(jw.to_park) AS tp_n, ${pct(0.5, "jw.to_park")} AS tp_p50, ${pct(0.75, "jw.to_park")} AS tp_p75`,
    `  FROM jw GROUP BY 1, 2`,
    `),`,
    `cr AS (`,
    `  SELECT ${wdSql("crew.hr_at")} AS wd, ${hrSql("crew.hr_at")} AS hr, avg(crew.n) AS crew_avg FROM crew`,
    `  WHERE crew.hr_at >= date_trunc('hour', ${L(`${s}::timestamp`)}) AND crew.hr_at < ${L(`${e}::timestamp`)}`,
    `  GROUP BY 1, 2`,
    `)`,
    `SELECT COALESCE(dj.wd, cr.wd) AS wd, COALESCE(dj.hr, cr.hr) AS hr,`,
    `  COALESCE(dj.cy_n, 0) AS cy_n, dj.cy_p50, dj.cy_p60, dj.cy_p75, dj.cy_p85, dj.cy_p90,`,
    `  COALESCE(dj.dr_n, 0) AS dr_n, dj.dr_p50, dj.dr_p75, dj.dr_p90,`,
    `  COALESCE(dj.tp_n, 0) AS tp_n, dj.tp_p50, dj.tp_p75, cr.crew_avg`,
    `FROM dj FULL OUTER JOIN cr ON cr.wd = dj.wd AND cr.hr = dj.hr`,
    `ORDER BY 1, 2`,
    `LIMIT 200`,
  ].join("\n");
  return { sql, params: p.values };
}

/** CASE do escalão de pessoas (os da regra da cidade; constantes nossas). PURA. */
export function crewBandCase(col: string, bands: CrewMeasureBand[]): string {
  const whens = bands
    .filter((b) => b.index > 0)
    .map((b) => `WHEN ${col} >= ${Number(b.min)}${b.max === null ? "" : ` AND ${col} <= ${Number(b.max)}`} THEN ${Number(b.index)}`)
    .join(" ");
  return `CASE ${whens} ELSE 0 END`;
}

/**
 * Leitura 4 (cidades) — condutor por carro por escalão de pessoas × hora cheia
 * (serviços começados nessa hora ≥ pessoas nessa hora). PURA.
 */
export function buildPressureCrewSql(w: PressureWindow, parkIds: string[], bands: CrewMeasureBand[]): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const base = pressureDriverCtes(p, w, parkIds);
  const pct = (q: number) => `percentile_cont(${q}) WITHIN GROUP (ORDER BY jw.cycle)`;
  const sql = [
    `WITH ${base}`,
    `SELECT ${crewBandCase("COALESCE(crew.n, 0)", bands)} AS band,`,
    `  (COALESCE(hj.jobs, 0) >= GREATEST(COALESCE(crew.n, 1), 1)) AS busy,`,
    `  count(*) AS n, ${pct(0.5)} AS p50, ${pct(0.6)} AS p60, ${pct(0.75)} AS p75, ${pct(0.85)} AS p85, ${pct(0.9)} AS p90`,
    `FROM jw LEFT JOIN crew ON crew.hr_at = jw.hr_at LEFT JOIN hj ON hj.hr_at = jw.hr_at`,
    `WHERE jw.cycle IS NOT NULL`,
    `GROUP BY 1, 2`,
    `ORDER BY 1, 2`,
    `LIMIT 50`,
  ].join("\n");
  return { sql, params: p.values };
}

// ─── Mapeadores ─────────────────────────────────────────────────────────────

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const int = (v: unknown) => Math.round(num(v) ?? 0);
const r1 = (v: unknown) => {
  const n = num(v);
  return n == null ? null : Math.round(n * 10) / 10;
};

/** Linha da leitura 1 → célula (dia da semana × hora). PURA. */
export function mapPressureSlotRow(group: string, w: PressureWindow, r: Record<string, unknown>): PressureSlot | null {
  const weekday = int(r.wd);
  const hour = int(r.hr);
  if (weekday < 1 || weekday > 7 || hour < 0 || hour > 23) return null;
  const days = w.weekdayDays[weekday] ?? 0;
  const concSum = num(r.conc_sum) ?? 0;
  return {
    group, weekday, hour, days,
    checkinsDone: int(r.ci_done),
    checkoutsDone: int(r.co_done),
    checkinsStarted: int(r.ci_started),
    checkoutsStarted: int(r.co_started),
    concurrencyAvg: days > 0 ? Math.round((concSum / days) * 100) / 100 : null,
    concurrencyMax: r.conc_max == null ? null : int(r.conc_max),
    deliveryN: int(r.del_n),
    deliveryP50: r1(r.del_p50),
    deliveryP75: r1(r.del_p75),
    deliveryP90: r1(r.del_p90),
    pickupN: int(r.pik_n),
    pickupP50: r1(r.pik_p50),
    pickupP75: r1(r.pik_p75),
  };
}

/** Linha da leitura 2 → escalão de carga × ponta/resto (sem carga = fora). PURA. */
export function mapPressureLoadRow(group: string, r: Record<string, unknown>): PressureLoadRow | null {
  const loadBucket = int(r.lb);
  if (!LOAD_BUCKETS.some((b) => b.id === loadBucket)) return null;
  return {
    group,
    loadBucket,
    rush: r.rush === true || r.rush === "t" || r.rush === 1 || r.rush === "true",
    deliveryN: int(r.n),
    deliveryP50: r1(r.p50),
    deliveryP75: r1(r.p75),
    deliveryP90: r1(r.p90),
  };
}

/** Linha da leitura 3 → campos por condutor de uma célula. PURA. */
export function mapPressureDriverRow(r: Record<string, unknown>): ({ weekday: number; hour: number } & Required<Pick<PressureSlot,
  "cycleN" | "cycleP50" | "cycleP60" | "cycleP75" | "cycleP85" | "cycleP90" | "driveN" | "driveP50" | "driveP75" | "driveP90" | "toParkN" | "toParkP50" | "toParkP75" | "crewAvg">>) | null {
  const weekday = int(r.wd);
  const hour = int(r.hr);
  if (weekday < 1 || weekday > 7 || hour < 0 || hour > 23) return null;
  const crew = num(r.crew_avg);
  return {
    weekday, hour,
    cycleN: int(r.cy_n), cycleP50: r1(r.cy_p50), cycleP60: r1(r.cy_p60), cycleP75: r1(r.cy_p75), cycleP85: r1(r.cy_p85), cycleP90: r1(r.cy_p90),
    driveN: int(r.dr_n), driveP50: r1(r.dr_p50), driveP75: r1(r.dr_p75), driveP90: r1(r.dr_p90),
    toParkN: int(r.tp_n), toParkP50: r1(r.tp_p50), toParkP75: r1(r.tp_p75),
    crewAvg: crew == null ? null : Math.round(crew * 10) / 10,
  };
}

/** Linha da leitura 4 → escalão de pessoas × hora cheia. PURA. */
export function mapPressureCrewRow(group: string, bands: CrewMeasureBand[], r: Record<string, unknown>): PressureCrewRow | null {
  const band = int(r.band);
  const def = bands.find((b) => b.index === band);
  if (!def) return null;
  return {
    group, band, bandLabel: def.label,
    busy: r.busy === true || r.busy === "t" || r.busy === 1 || r.busy === "true",
    n: int(r.n), p50: r1(r.p50), p60: r1(r.p60), p75: r1(r.p75), p85: r1(r.p85), p90: r1(r.p90),
  };
}
