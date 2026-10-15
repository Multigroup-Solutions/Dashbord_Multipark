/**
 * "Os tempos estão péssimos — é verdade?" (plano MPV §7, F8) — o relatório de
 * verificação dos tempos, a pedido do super admin (Extras Dia → Pressão, ao
 * lado do Diagnóstico dos tempos). SÓ LÊ:
 *  - a NOSSA BD: a tabela dos tempos (service_times) para a cobertura, a
 *    amostra e as medianas; o Histórico Diário (daily_driver_history) e os
 *    ficheiros GeoJSON do Zello pelo mesmo caminho do trabalho dos tempos
 *    (serviceTimesDeps → loadGps); os nomes das fichas;
 *  - a BD da Multipark (só leitura, assertReadOnlySql): a History das ~30
 *    reservas da amostra numa só leitura, recalculada com as mesmas regras
 *    da ficha da reserva (bookingRowsLive).
 * Usa o cartão "De onde vêm os tempos" (coverageCardFrom) e o portão dos
 * tempos com GPS (serviceTimes.gpsGate). Nada se grava nem se avisa. Nunca
 * lança: o que falhar fica escrito no relatório. As contas e a exportação
 * estão em shared/timesVerification.ts (PURO).
 */
import { sql } from "drizzle-orm";
import { addDays, lisbonDayOf } from "../shared/lisbonDay";
import { DEFAULT_GARAGE_ROLES, DRIVER_STATS_MIN_N, type GarageRoleEntry, type GpsGate, type ServiceEvent } from "../shared/serviceTimes";
import {
  VERIFY_COVERAGE_WEEKS, VERIFY_DRIVER_DAYS, VERIFY_SAMPLE_DAYS, VERIFY_SAMPLE_END_OFFSET_DAYS, VERIFY_SAMPLE_SIZE,
  compareWithBooking, compareWithZello, driverMedians, pickVerificationSample,
  type TimesVerificationReport, type TvBookingStatus, type TvCoverageRow, type TvSampleItem, type TvSampleSource, type TvZelloStatus,
} from "../shared/timesVerification";
import type { CoverageWeekRow } from "./serviceTimesViews";
import type { GpsFile } from "./serviceTimesJob";

/** Prazo do relatório (a função da Vercel corta aos 60 s): no total fica abaixo de 50 s. */
export const VERIFY_DEADLINE_MS = 42_000;
/**
 * Prazo próprio das leituras da nossa tabela (cobertura e amostra, ao mesmo
 * tempo). O MySQL CANCELA a consulta que passe dele (dica MAX_EXECUTION_TIME
 * no SELECT — a mesma da pesquisa global; não se usa KILL QUERY porque a
 * ligação vem de uma pool partilhada e o id podia já ser de outra consulta).
 * O relatório espera ainda VERIFY_TABLE_GRACE_MS pela resposta do cancelamento.
 */
export const VERIFY_TABLE_TIMEOUT_MS = 12_000;
export const VERIFY_TABLE_GRACE_MS = 1_500;

/** Corre `p` com prazo: passado `ms`, devolve `fallback` e escreve a nota (a leitura não fica à espera). */
export async function withDeadline<T>(p: Promise<T>, ms: number, fallback: T, onLate: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((resolve) => { timer = setTimeout(() => { onLate(); resolve(fallback); }, ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export const VERIFY_HISTORY_TIMEOUT_MS = 22_000;
/** Teto das linhas lidas da tabela para a amostra. */
export const VERIFY_SAMPLE_ROWS_LIMIT = 20_000;

const rowsOf = (r: unknown): any[] => { const x = Array.isArray(r) ? r[0] : (r as any)?.rows ?? r; return Array.isArray(x) ? x : []; };
const numOrNull = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const strOrNull = (v: unknown): string | null => (v == null || v === "" ? null : String(v));

/** Uma semana do cartão da cobertura → a linha do relatório, com o portão. PURA. */
export function coverageRowOf(w: CoverageWeekRow, gate: GpsGate): TvCoverageRow {
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  const measured = w.gps + w.button;
  const measuredPct = pct(measured, w.deliveries);
  return {
    city: w.city, week: w.week, deliveries: w.deliveries, gps: w.gps, button: w.button, unmeasured: w.transitUnmeasured,
    gpsPct: pct(w.gps, w.deliveries), measuredPct,
    gateWouldOpen: measuredPct != null && measuredPct >= gate.minCoveragePct && measured >= gate.minN,
    pickups: w.pickups, terminalGpsPct: pct(w.terminalGps, w.pickups),
    noZello: w.noZello, missingZones: w.missingZones, gpsPending: w.gpsPending,
    topReasons: Object.entries(w.reasons).map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n || a.reason.localeCompare(b.reason)).slice(0, 4),
  };
}

/** Uma linha lida da tabela (a amostra) → TvSampleSource. PURA. */
export function sampleSourceFromDb(r: Record<string, unknown>, utcTextMs: (v: unknown) => number | null): TvSampleSource {
  return {
    bookingId: String(r.bookingId ?? ""), bookingCode: strOrNull(r.bookingCode), cityKey: strOrNull(r.cityKey), opDay: String(r.opDay ?? "").slice(0, 10),
    terminalClass: strOrNull(r.terminalClass), startSource: strOrNull(r.startSource),
    requestAt: utcTextMs(r.requestAt), startedAt: utcTextMs(r.startedAt), arrivedAt: utcTextMs(r.arrivedAt), arrivedSource: strOrNull(r.arrivedSource), deliveredAt: utcTextMs(r.deliveredAt),
    queueMs: numOrNull(r.queueMs), queueStatus: strOrNull(r.queueStatus), transitMs: numOrNull(r.transitMs), transitStatus: strOrNull(r.transitStatus),
    customerMs: numOrNull(r.customerMs), customerStatus: strOrNull(r.customerStatus), totalMs: numOrNull(r.totalMs),
    startEmployeeId: numOrNull(r.startEmployeeId), zelloUsername: strOrNull(r.zelloUsername), gpsPoints: numOrNull(r.gpsPoints), gpsMaxGapS: numOrNull(r.gpsMaxGapS),
    gpsPass: strOrNull(r.gpsPass), anchorKey: `${r.bookingId ?? ""}|${r.anchorHistoryId ?? ""}`,
  };
}

export interface VerifyDeps {
  now: () => number;
  /** Linhas da tabela dos tempos (a mesma leitura dos ecrãs). */
  serviceRows: typeof import("./serviceTimesRead").loadServiceRowsInfo;
  /** O portão e os papéis das garagens. */
  settings: () => Promise<{ gate: GpsGate; roles: GarageRoleEntry[] }>;
  /** As entregas candidatas à amostra (com o Zello e o GPS guardados). */
  /** Lança se a leitura falhar (com `maxExecutionMs`, o MySQL cancela a consulta que passar do prazo). */
  sampleRows: (o: { fromDay: string; toDay: string; cityKeys: readonly string[] | null; maxExecutionMs?: number }) => Promise<TvSampleSource[]>;
  /** A History das reservas (Multipark, só leitura) → eventos; lança se falhar. */
  history: (ids: string[], o: { fromUtc: string; toUtc: string; timeoutMs: number }) => Promise<ServiceEvent[]>;
  /** Os ficheiros do GPS (Zello, dia de Lisboa). */
  gps: (requests: Array<{ zello: string; day: string }>, o: { deadlineAt: number }) => Promise<Map<string, GpsFile>>;
  names: (employeeIds: number[]) => Promise<Map<number, string>>;
}

const utcText = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** As dependências reais (só leitura). */
export async function defaultVerifyDeps(): Promise<VerifyDeps> {
  const [{ getDb }, read, { utcTextMs, buildServiceBookingsHistorySql, mapServiceHistoryRow }, { multiparkDbQuery }, { loadGps }, { describeReadFailure }] = await Promise.all([
    import("./db"), import("./serviceTimesRead"), import("./multiparkDb/serviceRows"), import("./multiparkDb/client"), import("./serviceTimesDeps"), import("./multiparkDb/read"),
  ]);
  return {
    now: () => Date.now(),
    serviceRows: read.loadServiceRowsInfo,
    settings: async () => {
      const st = await read.loadServiceViewSettings();
      let roles: GarageRoleEntry[] = DEFAULT_GARAGE_ROLES.map((g) => ({ ...g }));
      try {
        const { getSetting } = await import("./appSettings");
        roles = ((await getSetting("operations.garageRoles")) as GarageRoleEntry[] | null) ?? roles;
      } catch { /* omissão */ }
      return { gate: st.gate, roles };
    },
    sampleRows: async (o) => {
      const db = await getDb();
      if (!db) return [];
      if (o.cityKeys && !o.cityKeys.length) return [];
      const cities = o.cityKeys ? sql`AND cityKey IN (${sql.join(o.cityKeys.map((c) => sql`${c}`), sql`, `)})` : sql``;
      const ts = (c: string) => sql.raw(`DATE_FORMAT(\`${c}\`, '%Y-%m-%d %H:%i:%s.%f') AS \`${c}\``);
      try {
        const res = await db.execute(sql`SELECT ${read.maxExecutionHint(o.maxExecutionMs)}bookingId, anchorHistoryId, bookingCode, cityKey, DATE_FORMAT(opDay, '%Y-%m-%d') AS opDay, terminalClass, startSource,
            ${ts("requestAt")}, ${ts("startedAt")}, ${ts("arrivedAt")}, arrivedSource, ${ts("deliveredAt")},
            queueMs, queueStatus, transitMs, transitStatus, customerMs, customerStatus, totalMs, startEmployeeId, zelloUsername, gpsPoints, gpsMaxGapS, gpsPass
          FROM service_times
         WHERE kind = 'entrega' AND opDay >= ${o.fromDay} AND opDay <= ${o.toDay} AND voidedAt IS NULL AND outcome <> 'cancelado' AND deliveredAt IS NOT NULL ${cities}
         ORDER BY opDay DESC, id DESC LIMIT ${sql.raw(String(VERIFY_SAMPLE_ROWS_LIMIT))}`);
        return rowsOf(res).map((r) => sampleSourceFromDb(r, utcTextMs));
      } catch (err: any) {
        console.warn("[verificação dos tempos] amostra:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
        throw read.isQueryTimeoutError(err) ? new Error("prazo") : err;
      }
    },
    history: async (ids, o) => {
      const q = buildServiceBookingsHistorySql(ids, { fromUtc: o.fromUtc, toUtc: o.toUtc });
      try {
        const raw = await multiparkDbQuery<Record<string, unknown>>(q.sql, q.params, { timeoutMs: o.timeoutMs });
        return raw.map(mapServiceHistoryRow).filter((e): e is ServiceEvent => !!e);
      } catch (err) {
        throw new Error(describeReadFailure(err).reason);
      }
    },
    gps: loadGps,
    names: async (ids) => {
      const out = new Map<number, string>();
      const db = await getDb();
      if (!db || !ids.length) return out;
      try {
        for (const r of rowsOf(await db.execute(sql`SELECT id, fullName FROM employees WHERE id IN (${sql.join(ids.slice(0, 1000).map((i) => sql`${i}`), sql`, `)})`))) out.set(Number(r.id), String(r.fullName ?? ""));
      } catch { /* sem nomes: ficam os números */ }
      return out;
    },
  };
}

const mondayOf = (day: string) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() || 7) - 1)); return d.toISOString().slice(0, 10); };

/** O relatório. Nunca lança (o que falhar fica escrito). */
export async function runTimesVerification(
  o: { today: string; cityKeys: readonly string[] | null; sampleSize?: number; sampleDays?: number; tableTimeoutMs?: number },
  deps: VerifyDeps,
): Promise<TimesVerificationReport> {
  const started = deps.now();
  const deadline = started + VERIFY_DEADLINE_MS;
  const [{ coverageCardFrom }, { bookingRowsLive }] = await Promise.all([import("./serviceTimesViews"), import("./serviceTimesBooking")]);
  const { gate, roles } = await deps.settings().catch(() => ({ gate: { visible: false, minCoveragePct: 60, minN: 20 } as GpsGate, roles: [] as GarageRoleEntry[] }));

  const notes: string[] = [];
  const tableMs = o.tableTimeoutMs ?? VERIFY_TABLE_TIMEOUT_MS;
  const secs = (ms: number) => `${Math.round(ms / 1000)} s`;
  // 1. Cobertura (as 8 semanas do cartão "De onde vêm os tempos") e 2. as candidatas à amostra (D-14 a D-3):
  // as duas leituras da tabela ao mesmo tempo, cada uma com o seu prazo.
  const covFrom = addDays(mondayOf(o.today), -7 * (VERIFY_COVERAGE_WEEKS - 1));
  const sampleDays = Math.max(1, Math.min(31, o.sampleDays ?? VERIFY_SAMPLE_DAYS));
  const size = Math.max(1, Math.min(60, o.sampleSize ?? VERIFY_SAMPLE_SIZE));
  const sTo = addDays(o.today, -VERIFY_SAMPLE_END_OFFSET_DAYS);
  const sFrom = addDays(sTo, -(sampleDays - 1));
  // Um aviso por leitura (o prazo do MySQL e o do relatório podem chegar os dois).
  const noted = new Set<string>();
  const note = (k: string, text: string) => { if (!noted.has(k)) { noted.add(k); notes.push(text); } };
  const lateCov = () => note("cov", `A leitura da tabela dos tempos (8 semanas) passou de ${secs(tableMs)} e foi cancelada: a cobertura e as medianas ficam vazias. Tenta outra vez daqui a pouco.`);
  const lateSample = () => note("sample", `A leitura das entregas da amostra passou de ${secs(tableMs)} e foi cancelada: a amostra fica vazia. Tenta outra vez daqui a pouco.`);
  const [cov, candidates] = await Promise.all([
    withDeadline(
      deps.serviceRows({ fromDay: covFrom, toDay: o.today, cityKeys: o.cityKeys, maxExecutionMs: tableMs })
        .then((r) => {
          if (r.error) {
            if (r.error === "prazo") lateCov();
            else note("cov", "Não deu para ler a tabela dos tempos (cobertura e medianas).");
          }
          return r;
        })
        .catch(() => { note("cov", "Não deu para ler a tabela dos tempos (cobertura e medianas)."); return { rows: [], truncated: false }; }),
      tableMs + VERIFY_TABLE_GRACE_MS, { rows: [], truncated: false }, lateCov),
    withDeadline(
      deps.sampleRows({ fromDay: sFrom, toDay: sTo, cityKeys: o.cityKeys, maxExecutionMs: tableMs })
        .catch((err: any) => {
          if (String(err?.message) === "prazo") lateSample();
          else note("sample", "Não deu para ler as entregas da amostra.");
          return [] as TvSampleSource[];
        }),
      tableMs + VERIFY_TABLE_GRACE_MS, [] as TvSampleSource[], lateSample),
  ]);
  const card = coverageCardFrom(cov.rows, { roles, today: o.today, truncated: cov.truncated });

  // 3. Medianas por condutor (28 dias até ontem), da mesma leitura se couber, senão à parte.
  const drvTo = addDays(o.today, -1);
  const drvFrom = addDays(drvTo, -(VERIFY_DRIVER_DAYS - 1));
  const drvRows = cov.rows.filter((r) => r.kind === "entrega" && r.opDay >= drvFrom && r.opDay <= drvTo);

  const picked = pickVerificationSample(candidates, size, `${sFrom}|${sTo}`);

  // A ficha (History, uma leitura) e o Zello ao mesmo tempo — cabem os dois no prazo.
  const times = picked.flatMap((p) => [p.requestAt, p.startedAt, p.deliveredAt].filter((x): x is number => x != null));
  const hFrom = times.length ? Math.min(...times) - 6 * 3_600_000 : started;
  const hTo = times.length ? Math.max(...times) + 6 * 3_600_000 : started;
  const gpsReq: Array<{ zello: string; day: string }> = [];
  for (const p of picked) {
    if (!p.zelloUsername || p.startedAt == null || p.deliveredAt == null) continue;
    const a = lisbonDayOf(p.startedAt - 5 * 60_000), b = lisbonDayOf(p.deliveredAt + 5 * 60_000);
    for (const d of a === b ? [a] : [a, b]) gpsReq.push({ zello: p.zelloUsername, day: d });
  }
  const [hist, files] = await Promise.all([
    picked.length
      ? deps.history([...new Set(picked.map((p) => p.bookingId))], { fromUtc: utcText(hFrom), toUtc: utcText(hTo), timeoutMs: Math.min(VERIFY_HISTORY_TIMEOUT_MS, Math.max(2_000, deadline - deps.now() - 4_000)) })
        .then((events) => ({ ok: true as const, events }))
        .catch((err: any) => ({ ok: false as const, reason: String(err?.message ?? err).slice(0, 160) }))
      : Promise.resolve({ ok: true as const, events: [] as ServiceEvent[] }),
    gpsReq.length ? deps.gps(gpsReq, { deadlineAt: deadline - 3_000 }).catch(() => new Map<string, GpsFile>()) : Promise.resolve(new Map<string, GpsFile>()),
  ]);
  const byBooking = new Map<string, ServiceEvent[]>();
  if (hist.ok) for (const e of hist.events) { if (!byBooking.has(e.bookingId)) byBooking.set(e.bookingId, []); byBooking.get(e.bookingId)!.push(e); }

  const ids = [...new Set([...picked.map((p) => p.startEmployeeId), ...drvRows.flatMap((r) => [r.startEmployeeId, r.deliverEmployeeId])].filter((x): x is number => x != null))];
  const names = await deps.names(ids).catch(() => new Map<number, string>());

  const key = (z: string, d: string) => `${z.trim().toLowerCase()}|${d}`;
  const items: TvSampleItem[] = picked.map((p) => {
    const live = hist.ok ? bookingRowsLive(byBooking.get(p.bookingId) ?? [], { roles, now: deps.now(), cityKey: p.cityKey, terminalClass: p.terminalClass }) : null;
    let file: Parameters<typeof compareWithZello>[1] = null;
    if (p.zelloUsername && p.startedAt != null && p.deliveredAt != null) {
      const days = [...new Set([lisbonDayOf(p.startedAt - 5 * 60_000), lisbonDayOf(p.deliveredAt + 5 * 60_000)])];
      const got = days.map((d) => files.get(key(p.zelloUsername!, d)));
      const oks = got.filter((f): f is Extract<GpsFile, { status: "ok" }> => f?.status === "ok");
      if (oks.length) file = { status: "ok", points: oks.flatMap((f) => f.points.map((x) => ({ ts: x.ts, lat: x.lat, lon: x.lon, accurate: x.accurate }))) };
      else if (got.some((f) => f?.status === "failed")) file = { status: "failed", reason: (got.find((f) => f?.status === "failed") as any)?.reason };
      else if (got.some((f) => f?.status === "missing")) file = { status: "missing" };
      else file = null;
    }
    return {
      ...p,
      driverName: p.startEmployeeId != null ? names.get(p.startEmployeeId) ?? null : null,
      booking: compareWithBooking(p, live),
      zello: compareWithZello(p, file),
    };
  });
  const bookingCounts = { bate: 0, difere: 0, sem_ciclo: 0, falhou: 0 } as Record<TvBookingStatus, number>;
  const zelloCounts = { bate: 0, gps_fraco: 0, sem_ficheiro: 0, sem_zello: 0, falhou: 0, nao_lido: 0 } as Record<TvZelloStatus, number>;
  for (const x of items) { bookingCounts[x.booking.status]++; zelloCounts[x.zello.status]++; }

  const med = driverMedians(drvRows, names, { minN: DRIVER_STATS_MIN_N });
  return {
    generatedAt: new Date(deps.now()).toISOString().slice(0, 16).replace("T", " ") + " UTC",
    notes,
    today: o.today,
    gate: { visible: !!gate.visible, minCoveragePct: gate.minCoveragePct, minN: gate.minN },
    coverage: { fromDay: covFrom, toDay: o.today, rows: card.weeks.map((w) => coverageRowOf(w, gate)), truncated: cov.truncated },
    sample: { fromDay: sFrom, toDay: sTo, size, available: candidates.length, items, bookingCounts, zelloCounts, bookingReadFailed: hist.ok ? null : hist.reason },
    drivers: { fromDay: drvFrom, toDay: drvTo, minN: DRIVER_STATS_MIN_N, rows: med.rows, cities: med.cities, truncated: cov.truncated },
  };
}
