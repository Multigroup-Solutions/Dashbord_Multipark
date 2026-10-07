/**
 * "Pressão" do Extras-Dia — o script que corre (trabalho `extras-pressure` do
 * agendador, diário a partir das 04:45 de Lisboa; à mão em
 * /api/cron/extras-pressure). A janela vai desde `extras.timesSince` (22d:
 * 3 abr 2026; cresce e nunca encolhe) — e, nas cidades, os tempos por
 * condutor (passos "driver", no fim) — um pedaço (grupo de parques) de cada
 * vez, e o resultado vai para a NOSSA BD (ops_pressure_stats, migração 0235).
 *
 * 47c (decisão do Jorge, 7 out 2026): a BD da Multipark lê-se UM DIA × GRUPO
 * de cada vez e só os dias que ainda não estão guardados (ops_pressure_days,
 * migração 0570; normalmente só ontem). Cada pedaço: 1) lê os dias em falta,
 * guardando cada um; 2) junta todos os dias da janela (server/pressureDays.ts)
 * e escreve as células como antes. Antes lia a janela inteira de cada vez e
 * em Lisboa passou dos 40 s (4 noites a falhar).
 * Retomável: o cursor diz a janela (dia final) e o pedaço; um pedaço a meio
 * continua no tick seguinte (os dias já guardados não se voltam a ler).
 *
 * Os "Parques que a operação não faz" (Definições → operations.excludedParks,
 * passados pelo cron) ficam fora de todos os grupos.
 *
 * A página lê sempre a última janela COMPLETA (a que tem a linha-marca
 * `_done`), por isso uma corrida a meio nunca mostra dados misturados.
 */
import { sql } from "drizzle-orm";
import { multiparkDbQuery, redactSecrets, type SqlParam } from "./multiparkDb/client";
import { describeReadFailure } from "./multiparkDb/read";
import { buildParksSql, mapParks } from "./multiparkDb/dayBookings";
import { excludeParks } from "../shared/reservasDoDia";
import {
  buildPressureChunks, buildPressureDaySql, buildPressureDriverDaySql,
  mapPressureCrewRow, mapPressureDriverRow, mapPressureLoadRow, mapPressureSlotRow, pressureWindow, pressureWindowSince,
  type PressureChunk, type PressureWindow,
} from "./multiparkDb/pressure";
import {
  combineDriverDays, combineGroupDays, dayEvents, driverDayPayloads, groupDayPayloads, missingPressureDays, parseDayPayload, pressureDaySig, windowDayList,
  type DriverDayPayload, type GroupDayPayload, type PressureDayPart, type PressureReprocess, type StoredDayMeta,
} from "./pressureDays";
import { addDays, lisbonDayOf } from "../shared/lisbonDay";
import {
  PRESSURE_SINCE_DEFAULT, PRESSURE_WINDOW_DAYS, crewMeasureBands,
  type CrewMeasureBand, type CyclePercentile, type PressureCrewRow, type PressureLoadRow, type PressureSlot,
} from "../shared/extrasPressure";
import { DEFAULT_CREW_RULES, DEFAULT_TIMES_PERCENTILE, type CrewRulesMap, type TimesPercentileMap } from "../shared/appSettings";

type DriverRow = NonNullable<ReturnType<typeof mapPressureDriverRow>>;
/** Cidade do grupo (lisboa/porto/faro) → cidade do Extras-dia. */
const extraCityOf = (city: string | undefined): "lisbon" | "porto" | "faro" => (city === "porto" ? "porto" : city === "faro" ? "faro" : "lisbon");
/** Dias da janela. */
const windowDaysOf = (w: PressureWindow) => Object.values(w.weekdayDays).reduce((a, b) => a + b, 0);

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

/**
 * Uma leitura (um dia × grupo; normalmente < 2 s) só arranca com pelo menos
 * isto até ao prazo. 47c: já não há pedaços "pesados" — a leitura de um dia
 * não cresce com a janela (antes, a cidade inteira desde abril precisava de
 * 25 s e mesmo assim passou dos 40 s em Lisboa).
 */
export const PRESSURE_CHUNK_MIN_MS = 12_000;
/** Juntar os dias guardados (só a nossa BD) e escrever as células: arranca com pelo menos isto. */
export const PRESSURE_COMBINE_MIN_MS = 6_000;
/**
 * 47c: uma corrida só começa leituras novas nos primeiros 20 s. O agendador
 * põe primeiro as tarefas "a retomar" e o preenchimento inicial (desde abril,
 * dia a dia) dura horas: sem este teto ficava com o tick inteiro e o Gmail,
 * os PDAs/Zello e a caixa paravam. Assim sobram ~25 s por tick para os outros.
 */
export const PRESSURE_RUN_READS_MS = 20_000;

/** Leitura com o tempo que falta até ao prazo (folga de 2 s), entre 15 s e o teto. PURA quanto ao relógio dado. */
export function pressureQueryTimeout(deadlineAt: number, now: number): number {
  return Math.max(15_000, Math.min(40_000, deadlineAt - now - 2_000));
}
/** Janelas guardadas para trás (as mais antigas apagam-se). */
export const PRESSURE_KEEP_DAYS = 14;
/** Grupo-marca: a janela está completa. */
export const PRESSURE_DONE_GROUP = "_done";

// ─── Cursor ─────────────────────────────────────────────────────────────────

export interface PressureCursor { w: string; i: number; rp?: PressureReprocess }

/** Cursor → próximo pedaço (só vale para a mesma janela; outra janela = do início). PURA. */
export function parsePressureCursor(raw: string | null | undefined, windowEnd: string): number {
  if (!raw) return 0;
  try {
    const v = JSON.parse(raw);
    if (v && v.w === windowEnd && Number.isInteger(v.i) && v.i >= 0 && v.i < 1000) return v.i;
  } catch { /* cursor antigo/estragado → do início */ }
  return 0;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** 47c: o pedido de reprocessar à mão que vem no cursor (só para a mesma janela). PURA. */
export function parsePressureReprocess(raw: string | null | undefined, windowEnd: string): PressureReprocess | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    const rp = v?.rp;
    if (v?.w === windowEnd && rp && DAY_RE.test(rp.from) && DAY_RE.test(rp.to) && TS_RE.test(rp.before) && rp.from <= rp.to) return { from: rp.from, to: rp.to, before: rp.before };
  } catch { /* sem pedido */ }
  return null;
}

/**
 * 47c: "?reprocessar=AAAA-MM-DD" ou "AAAA-MM-DD..AAAA-MM-DD" (dias de Lisboa)
 * → os dias guardados desse intervalo antes de agora voltam a ler-se. PURA.
 */
export function parseReprocessParam(raw: unknown, nowUtc: string): PressureReprocess | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:\.\.(\d{4}-\d{2}-\d{2}))?$/.exec(String(raw ?? "").trim());
  if (!m || !TS_RE.test(nowUtc)) return null;
  const from = m[1];
  const to = m[2] ?? m[1];
  if (Number.isNaN(Date.parse(`${from}T12:00:00Z`)) || Number.isNaN(Date.parse(`${to}T12:00:00Z`)) || from > to) return null;
  return { from, to, before: nowUtc };
}

export function formatPressureCursor(windowEnd: string, nextIndex: number, reprocess?: PressureReprocess | null): string {
  return JSON.stringify({ w: windowEnd, i: nextIndex, ...(reprocess ? { rp: reprocess } : {}) } satisfies PressureCursor);
}

/** Janela por omissão: acaba ontem (Lisboa). PURA. */
export function defaultWindowEnd(now: number): string {
  return addDays(lisbonDayOf(now), -1);
}

// ─── Gravação ───────────────────────────────────────────────────────────────

export interface PressureStore {
  /** Substitui as linhas de um grupo numa janela. */
  replaceGroup(windowEnd: string, chunk: Pick<PressureChunk, "key" | "label">, slots: PressureSlot[], loads: PressureLoadRow[], computedAt: string, windowDays?: number): Promise<void>;
  /** 22d: junta os tempos por condutor às células da cidade e substitui os escalões de pessoas. */
  upsertDriver(windowEnd: string, chunk: Pick<PressureChunk, "key" | "label">, w: PressureWindow, drivers: DriverRow[], crew: PressureCrewRow[], computedAt: string): Promise<void>;
  /** Marca a janela como completa e apaga as antigas. */
  finish(windowEnd: string, computedAt: string, windowDays?: number): Promise<void>;
}

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const utcNow = () => new Date().toISOString().slice(0, 19).replace("T", " ");

async function dashboardDb() {
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) throw new Error("BD do dashboard indisponível.");
  return db;
}

export const mysqlPressureStore: PressureStore = {
  async replaceGroup(windowEnd, chunk, slots, loads, computedAt, windowDays = PRESSURE_WINDOW_DAYS) {
    const db = await dashboardDb();
    await db.execute(sql`DELETE FROM ops_pressure_stats WHERE windowEnd = ${windowEnd} AND parkGroup = ${chunk.key}`);
    const label = chunk.label.slice(0, 80);
    const values = [
      ...slots.map((s) => sql`(${windowEnd}, ${windowDays}, ${chunk.key}, ${label}, 'slot', ${s.weekday}, ${s.hour}, 0, 0, ${s.days},
        ${s.checkinsDone}, ${s.checkoutsDone}, ${s.checkinsStarted}, ${s.checkoutsStarted}, ${s.concurrencyAvg}, ${s.concurrencyMax},
        ${s.deliveryN}, ${s.deliveryP50}, ${s.deliveryP75}, ${s.deliveryP90}, ${s.pickupN}, ${s.pickupP50}, ${s.pickupP75}, ${computedAt})`),
      ...loads.map((l) => sql`(${windowEnd}, ${windowDays}, ${chunk.key}, ${label}, 'load', 0, 0, ${l.loadBucket}, ${l.rush ? 1 : 0}, 0,
        0, 0, 0, 0, NULL, NULL,
        ${l.deliveryN}, ${l.deliveryP50}, ${l.deliveryP75}, ${l.deliveryP90}, 0, NULL, NULL, ${computedAt})`),
    ];
    for (let i = 0; i < values.length; i += 200) {
      await db.execute(sql`INSERT INTO ops_pressure_stats (windowEnd, windowDays, parkGroup, groupLabel, kind, weekday, hour, loadBucket, rush, days,
        checkinsDone, checkoutsDone, checkinsStarted, checkoutsStarted, concurrencyAvg, concurrencyMax,
        deliveryN, deliveryP50, deliveryP75, deliveryP90, pickupN, pickupP50, pickupP75, computedAt)
        VALUES ${sql.join(values.slice(i, i + 200), sql`, `)}`);
    }
  },
  async upsertDriver(windowEnd, chunk, w, drivers, crew, computedAt) {
    const db = await dashboardDb();
    const label = chunk.label.replace(/ \(condutores\)$/, " (todas as marcas)").slice(0, 80);
    const days = windowDaysOf(w);
    for (const d of drivers) {
      // A célula da cidade já existe (passo do grupo, antes): só os campos por condutor. Sem ela, cria-se.
      await db.execute(sql`INSERT INTO ops_pressure_stats (windowEnd, windowDays, parkGroup, groupLabel, kind, weekday, hour, loadBucket, rush, days,
          cycleN, cycleP50, cycleP60, cycleP75, cycleP85, cycleP90, driveN, driveP50, driveP75, driveP90, toParkN, toParkP50, toParkP75, crewAvg, computedAt)
        VALUES (${windowEnd}, ${days}, ${chunk.key}, ${label}, 'slot', ${d.weekday}, ${d.hour}, 0, 0, ${w.weekdayDays[d.weekday] ?? 0},
          ${d.cycleN}, ${d.cycleP50}, ${d.cycleP60}, ${d.cycleP75}, ${d.cycleP85}, ${d.cycleP90}, ${d.driveN}, ${d.driveP50}, ${d.driveP75}, ${d.driveP90},
          ${d.toParkN}, ${d.toParkP50}, ${d.toParkP75}, ${d.crewAvg}, ${computedAt})
        ON DUPLICATE KEY UPDATE cycleN = VALUES(cycleN), cycleP50 = VALUES(cycleP50), cycleP60 = VALUES(cycleP60), cycleP75 = VALUES(cycleP75),
          cycleP85 = VALUES(cycleP85), cycleP90 = VALUES(cycleP90), driveN = VALUES(driveN), driveP50 = VALUES(driveP50), driveP75 = VALUES(driveP75),
          driveP90 = VALUES(driveP90), toParkN = VALUES(toParkN), toParkP50 = VALUES(toParkP50), toParkP75 = VALUES(toParkP75), crewAvg = VALUES(crewAvg)`);
    }
    // Escalões: estatística derivada, refeita inteira em cada corrida.
    await db.execute(sql`DELETE FROM ops_pressure_stats WHERE windowEnd = ${windowEnd} AND parkGroup = ${chunk.key} AND kind = 'crew'`);
    for (const c of crew) {
      await db.execute(sql`INSERT INTO ops_pressure_stats (windowEnd, windowDays, parkGroup, groupLabel, kind, weekday, hour, loadBucket, rush, days,
          bandLabel, cycleN, cycleP50, cycleP60, cycleP75, cycleP85, cycleP90, computedAt)
        VALUES (${windowEnd}, ${days}, ${chunk.key}, ${label}, 'crew', 0, 0, ${c.band}, ${c.busy ? 1 : 0}, 0,
          ${c.bandLabel}, ${c.n}, ${c.p50}, ${c.p60}, ${c.p75}, ${c.p85}, ${c.p90}, ${computedAt})`);
    }
  },
  async finish(windowEnd, computedAt, windowDays = PRESSURE_WINDOW_DAYS) {
    const db = await dashboardDb();
    await db.execute(sql`DELETE FROM ops_pressure_stats WHERE windowEnd = ${windowEnd} AND parkGroup = ${PRESSURE_DONE_GROUP}`);
    await db.execute(sql`INSERT INTO ops_pressure_stats (windowEnd, windowDays, parkGroup, groupLabel, kind, computedAt)
      VALUES (${windowEnd}, ${windowDays}, ${PRESSURE_DONE_GROUP}, 'janela completa', 'done', ${computedAt})`);
    await db.execute(sql`DELETE FROM ops_pressure_stats WHERE windowEnd < ${addDays(windowEnd, -PRESSURE_KEEP_DAYS)}`);
  },
};

// ─── 47c: dias guardados (ops_pressure_days) ────────────────────────────────

export interface PressureDaysStore {
  /** Assinatura e hora de cálculo dos dias guardados de um grupo/parte, entre dois dias (inclusive). */
  meta(group: string, part: PressureDayPart, from: string, to: string): Promise<Map<string, StoredDayMeta>>;
  /** Guarda (substitui) um dia. */
  save(group: string, part: PressureDayPart, day: string, payload: GroupDayPayload | DriverDayPayload, sig: string, readEnd: string, computedAt: string): Promise<void>;
  /** Os dias guardados com esta assinatura, entre dois dias (inclusive), por ordem. */
  load(group: string, part: PressureDayPart, from: string, to: string, sig: string): Promise<Array<{ day: string; payload: unknown }>>;
}

export const mysqlPressureDaysStore: PressureDaysStore = {
  async meta(group, part, from, to) {
    const db = await dashboardDb();
    const rows = rowsOf(await db.execute(sql`SELECT DATE_FORMAT(day, '%Y-%m-%d') AS d, sig, DATE_FORMAT(computedAt, '%Y-%m-%d %H:%i:%s') AS c
      FROM ops_pressure_days WHERE parkGroup = ${group} AND part = ${part} AND day BETWEEN ${from} AND ${to} LIMIT 20000`));
    return new Map(rows.map((r) => [String(r.d), { sig: String(r.sig ?? ""), computedAt: String(r.c ?? "") }]));
  },
  async save(group, part, day, payload, sig, readEnd, computedAt) {
    const db = await dashboardDb();
    // Estatística derivada: um dia substitui-se a si próprio (chave única), nunca se apaga.
    await db.execute(sql`INSERT INTO ops_pressure_days (parkGroup, part, day, sig, readEnd, events, payload, computedAt)
      VALUES (${group}, ${part}, ${day}, ${sig}, ${readEnd}, ${dayEvents(payload)}, ${JSON.stringify(payload)}, ${computedAt})
      ON DUPLICATE KEY UPDATE sig = VALUES(sig), readEnd = VALUES(readEnd), events = VALUES(events), payload = VALUES(payload), computedAt = VALUES(computedAt)`);
  },
  async load(group, part, from, to, sig) {
    const db = await dashboardDb();
    const rows = rowsOf(await db.execute(sql`SELECT DATE_FORMAT(day, '%Y-%m-%d') AS d, payload
      FROM ops_pressure_days WHERE parkGroup = ${group} AND part = ${part} AND day BETWEEN ${from} AND ${to} AND sig = ${sig} ORDER BY day LIMIT 20000`));
    return rows.map((r) => ({ day: String(r.d), payload: r.payload }));
  },
};

// ─── Corrida ────────────────────────────────────────────────────────────────

export interface PressureRunResult {
  ok: boolean;
  done: boolean;
  skipped?: string;
  error?: string;
  windowEnd: string;
  windowStart: string;
  chunks: number;
  processed: string[];
  failed: Array<{ group: string; error: string }>;
  nextIndex: number;
  cursor: string | null;
  slots: number;
  loadRows: number;
  /** 47c: dias × grupo lidos da Multipark nesta corrida (normalmente 1 por pedaço). */
  daysRead: number;
  ms: number;
}

/**
 * Corre os pedaços a partir do cursor até acabarem ou faltar tempo. Em cada
 * pedaço: lê da Multipark os dias em falta (um de cada vez, guardando cada
 * um) e depois junta os dias da janela e escreve as células. Um pedaço que
 * falha (ex.: tempo esgotado na BD da Multipark) fica registado e segue-se
 * para o seguinte — a janela fica completa na mesma, com esse grupo em falta
 * (a página mostra-o com a janela anterior), e a corrida sai vermelha. Os
 * dias já lidos ficam guardados (a tentativa seguinte só lê o que falta).
 * Nunca lança por causa da BD da Multipark.
 */
export async function runExtrasPressure(o: {
  deadlineAt: number;
  cursor?: string | null;
  now?: number;
  windowEnd?: string;
  query?: Query;
  store?: PressureStore;
  /** 47c: onde ficam os dias (omissão: ops_pressure_days). */
  days?: PressureDaysStore;
  /** 47c: reprocessar à mão (vem também no cursor, para as chamadas seguintes). */
  reprocess?: PressureReprocess | null;
  isConfigured?: () => boolean;
  /** "Parques que a operação não faz" (Definições): ficam fora de todos os grupos. */
  excludedParkIds?: readonly string[];
  /** 22d: início da medição (Definições → extras.timesSince). */
  since?: string | null;
  /** 22d: tabela máxima por cidade (D12) — dá os escalões de pessoas. */
  crewRules?: CrewRulesMap | null;
  /** 27b: agentes da Multipark dos TL (omissão: lidos da nossa BD). */
  teamLeaderAgentIds?: readonly string[] | null;
  /** 47c: só começa leituras novas até este tempo depois do início (omissão PRESSURE_RUN_READS_MS). */
  readBudgetMs?: number;
}): Promise<PressureRunResult> {
  const t0 = Date.now();
  const readsUntil = t0 + (o.readBudgetMs ?? PRESSURE_RUN_READS_MS);
  const now = o.now ?? t0;
  const windowEnd = o.windowEnd ?? defaultWindowEnd(now);
  const w: PressureWindow = pressureWindowSince(o.since ?? PRESSURE_SINCE_DEFAULT, windowEnd);
  const windowDays = windowDaysOf(w);
  const allDays = windowDayList(w);
  const crewRules = o.crewRules ?? DEFAULT_CREW_RULES;
  // 44a: sem leitura injetada (testes), cada leitura leva o tempo que falta até ao prazo;
  // 47c: e é "analítica" (sem nested loops nem JIT no Postgres — multiparkDb/client.ts).
  const query: Query = o.query ?? (<T,>(sqlText: string, params?: SqlParam[]) => multiparkDbQuery<T>(sqlText, params ?? [], { timeoutMs: pressureQueryTimeout(o.deadlineAt, Date.now()), analytics: true }));
  const store = o.store ?? mysqlPressureStore;
  const days = o.days ?? mysqlPressureDaysStore;
  const reprocess = o.reprocess ?? parsePressureReprocess(o.cursor, windowEnd);
  const base: PressureRunResult = { ok: true, done: true, windowEnd, windowStart: w.startDay, chunks: 0, processed: [], failed: [], nextIndex: 0, cursor: null, slots: 0, loadRows: 0, daysRead: 0, ms: 0 };
  const configured = o.isConfigured ?? (() => !!String(process.env.DATABASE_URL_MULTIPARK ?? "").trim());
  if (!configured()) return { ...base, skipped: "DATABASE_URL_MULTIPARK não está definida neste ambiente.", ms: Date.now() - t0 };

  let chunks: PressureChunk[];
  try {
    const ps = buildParksSql();
    chunks = buildPressureChunks(excludeParks(mapParks(await query(ps.sql, ps.params)), o.excludedParkIds));
  } catch (err) {
    const f = describeReadFailure(err);
    console.warn("[extras-pressure] parques:", redactSecrets(err).slice(0, 200));
    return { ...base, ok: false, done: false, error: f.reason, cursor: formatPressureCursor(windowEnd, parsePressureCursor(o.cursor, windowEnd), reprocess), ms: Date.now() - t0 };
  }
  let i = parsePressureCursor(o.cursor, windowEnd);
  const out: PressureRunResult = { ...base, chunks: chunks.length, nextIndex: i };
  // 27b: o TL conta sempre nas pessoas do turno (junta-se 1 se nenhum TL agiu nessa hora).
  const tlIds = o.teamLeaderAgentIds !== undefined ? [...(o.teamLeaderAgentIds ?? [])] : await loadTeamLeaderAgentIds();
  const computedAt = utcNow();
  while (i < chunks.length) {
    const chunk = chunks[i];
    const part: PressureDayPart = chunk.kind === "driver" ? "driver" : "group";
    const sig = pressureDaySig(chunk.parkIds);
    const label = chunk.kind === "driver" ? `${chunk.key}:condutores` : chunk.key;
    // Sem tempo nem para juntar os dias: fica para o tick seguinte.
    if (o.deadlineAt - Date.now() < PRESSURE_COMBINE_MIN_MS) break;
    let paused = false;
    try {
      // 1) Os dias em falta: um dia × grupo por leitura, cada um guardado logo.
      const missing = missingPressureDays(allDays, await days.meta(chunk.key, part, w.startDay, w.endDay), sig, reprocess);
      for (const day of missing) {
        if (o.deadlineAt - Date.now() < PRESSURE_CHUNK_MIN_MS || Date.now() > readsUntil) { paused = true; break; }
        const r = pressureWindow(day, 1);
        const q = part === "driver" ? buildPressureDriverDaySql(w, r, chunk.parkIds) : buildPressureDaySql(w, r, chunk.parkIds);
        const rows = await query(q.sql, q.params);
        const payload = part === "driver" ? driverDayPayloads(rows, [day]).get(day)! : groupDayPayloads(rows, [day]).get(day)!;
        await days.save(chunk.key, part, day, payload, sig, windowEnd, utcNow());
        out.daysRead++;
      }
      // 2) Juntar todos os dias da janela e escrever as células (como antes).
      if (!paused && o.deadlineAt - Date.now() < PRESSURE_COMBINE_MIN_MS) paused = true;
      if (!paused) {
        const stored = await days.load(chunk.key, part, w.startDay, w.endDay, sig);
        if (stored.length < allDays.length) throw new Error(`faltam ${allDays.length - stored.length} dia(s) guardados.`);
        if (part === "driver") {
          const bands: CrewMeasureBand[] = crewMeasureBands(crewRules[extraCityOf(chunk.city)] ?? DEFAULT_CREW_RULES[extraCityOf(chunk.city)]);
          const c = combineDriverDays(stored.map((d) => ({ day: d.day, payload: parseDayPayload<DriverDayPayload>(d.payload) })), tlIds, bands);
          const drivers = c.driverRows.map(mapPressureDriverRow).filter((x): x is DriverRow => !!x);
          const crew = c.crewRows.map((r) => mapPressureCrewRow(chunk.key, bands, r)).filter((x): x is PressureCrewRow => !!x);
          await store.upsertDriver(windowEnd, chunk, w, drivers, crew, computedAt);
        } else {
          const c = combineGroupDays(stored.map((d) => ({ day: d.day, payload: parseDayPayload<GroupDayPayload>(d.payload) })));
          const slots = c.slotRows.map((r) => mapPressureSlotRow(chunk.key, w, r)).filter((x): x is PressureSlot => !!x);
          const loads = c.loadRows.map((r) => mapPressureLoadRow(chunk.key, r)).filter((x): x is PressureLoadRow => !!x);
          await store.replaceGroup(windowEnd, chunk, slots, loads, computedAt, windowDays);
          out.slots += slots.length;
          out.loadRows += loads.length;
        }
        out.processed.push(label);
      }
    } catch (err) {
      const msg = err && (err as any).name === "MultiparkDbError" ? describeReadFailure(err).reason : redactSecrets(err).slice(0, 200);
      console.warn(`[extras-pressure] ${label}:`, redactSecrets(err).slice(0, 200));
      out.failed.push({ group: chunk.key, error: msg });
    }
    // Sem tempo a meio do pedaço: fica para o tick seguinte (os dias lidos já estão guardados).
    if (paused) break;
    i++;
  }
  out.nextIndex = i;
  out.done = i >= chunks.length;
  if (out.done) {
    await store.finish(windowEnd, computedAt, windowDays);
    out.cursor = null;
  } else {
    out.cursor = formatPressureCursor(windowEnd, i, reprocess);
  }
  if (out.failed.length) {
    out.ok = false;
    out.error = `Grupos com falha: ${out.failed.map((f) => `${f.group} (${f.error})`).join("; ").slice(0, 400)}`;
  }
  out.ms = Date.now() - t0;
  return out;
}

// ─── Leitura para a página ──────────────────────────────────────────────────

export interface PressureView {
  available: boolean;
  windowEnd: string | null;
  windowStart: string | null;
  windowDays: number;
  computedAt: string | null;
  groups: Array<{ key: string; label: string }>;
  slots: PressureSlot[];
  loads: PressureLoadRow[];
  /** 22d: condutor por carro por escalão de pessoas × hora cheia (cidades). */
  crew: PressureCrewRow[];
  /** 22d: por grupo-cidade — percentil usado e escalões com o máximo da tabela (D12). */
  cities: Record<string, { city: "lisbon" | "porto" | "faro"; percentile: CyclePercentile; bands: CrewMeasureBand[]; useMeasured?: boolean }>;
  /**
   * 44a: grupos cujo cálculo falhou na última janela e que se mostram com a
   * janela anterior que os tem (`w`) — "all" o grupo inteiro, "drivers" só os
   * tempos por condutor. Sem isto as células ficavam vazias.
   */
  stale?: Record<string, { w: string; part: "all" | "drivers" }>;
}

/**
 * 44a: o que ir buscar a janelas anteriores. `older` = a janela mais recente
 * (antes da atual) com células (`slot`) e com escalões de pessoas (`crew`) de
 * cada grupo. Um grupo que falta inteiro → "all"; uma cidade sem os tempos
 * por condutor → "drivers". PURA.
 */
export function pressureFallbacks(
  current: { groups: ReadonlySet<string>; withDrivers: ReadonlySet<string> },
  older: { slot: ReadonlyMap<string, string>; crew: ReadonlyMap<string, string> },
  cityKeys: readonly string[],
): Array<{ group: string; w: string; part: "all" | "drivers" }> {
  const out: Array<{ group: string; w: string; part: "all" | "drivers" }> = [];
  for (const [group, w] of Array.from(older.slot)) {
    if (group === PRESSURE_DONE_GROUP || current.groups.has(group)) continue;
    out.push({ group, w, part: "all" });
  }
  for (const group of cityKeys) {
    if (!current.groups.has(group) || current.withDrivers.has(group)) continue;
    const w = older.crew.get(group);
    if (w) out.push({ group, w, part: "drivers" });
  }
  return out;
}

const DRIVER_FIELDS = ["cycleN", "cycleP50", "cycleP60", "cycleP75", "cycleP85", "cycleP90", "driveN", "driveP50", "driveP75", "driveP90", "toParkN", "toParkP50", "toParkP75", "crewAvg"] as const;

const numOrNull = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Linha de ops_pressure_stats → célula ou escalão. PURA. */
export function mapStoredRow(r: Record<string, unknown>): { slot?: PressureSlot; load?: PressureLoadRow; crew?: PressureCrewRow } {
  const group = String(r.parkGroup ?? "");
  if (r.kind === "crew") {
    return {
      crew: {
        group, band: Number(r.loadBucket ?? 0), bandLabel: String(r.bandLabel ?? ""), busy: Number(r.rush) === 1,
        n: Number(r.cycleN ?? 0), p50: numOrNull(r.cycleP50), p60: numOrNull(r.cycleP60), p75: numOrNull(r.cycleP75), p85: numOrNull(r.cycleP85), p90: numOrNull(r.cycleP90),
      },
    };
  }
  if (r.kind === "slot") {
    return {
      slot: {
        group, weekday: Number(r.weekday), hour: Number(r.hour), days: Number(r.days ?? 0),
        checkinsDone: Number(r.checkinsDone ?? 0), checkoutsDone: Number(r.checkoutsDone ?? 0),
        checkinsStarted: Number(r.checkinsStarted ?? 0), checkoutsStarted: Number(r.checkoutsStarted ?? 0),
        concurrencyAvg: numOrNull(r.concurrencyAvg), concurrencyMax: numOrNull(r.concurrencyMax),
        deliveryN: Number(r.deliveryN ?? 0), deliveryP50: numOrNull(r.deliveryP50), deliveryP75: numOrNull(r.deliveryP75), deliveryP90: numOrNull(r.deliveryP90),
        pickupN: Number(r.pickupN ?? 0), pickupP50: numOrNull(r.pickupP50), pickupP75: numOrNull(r.pickupP75),
        cycleN: Number(r.cycleN ?? 0), cycleP50: numOrNull(r.cycleP50), cycleP60: numOrNull(r.cycleP60), cycleP75: numOrNull(r.cycleP75),
        cycleP85: numOrNull(r.cycleP85), cycleP90: numOrNull(r.cycleP90),
        driveN: Number(r.driveN ?? 0), driveP50: numOrNull(r.driveP50), driveP75: numOrNull(r.driveP75), driveP90: numOrNull(r.driveP90),
        toParkN: Number(r.toParkN ?? 0), toParkP50: numOrNull(r.toParkP50), toParkP75: numOrNull(r.toParkP75), crewAvg: numOrNull(r.crewAvg),
      },
    };
  }
  if (r.kind === "load") {
    return {
      load: {
        group, loadBucket: Number(r.loadBucket), rush: Number(r.rush) === 1,
        deliveryN: Number(r.deliveryN ?? 0), deliveryP50: numOrNull(r.deliveryP50), deliveryP75: numOrNull(r.deliveryP75), deliveryP90: numOrNull(r.deliveryP90),
      },
    };
  }
  return {};
}

/** Última janela completa (ou, sem nenhuma completa, a mais recente). `groups` limita (âmbito de cidade). */
export async function getPressureView(allowedGroups?: (key: string) => boolean, o: { crewRules?: CrewRulesMap | null; percentiles?: TimesPercentileMap | null; useMeasured?: Partial<Record<"lisbon" | "porto" | "faro", boolean>> | null } = {}): Promise<PressureView> {
  const crewRules = o.crewRules ?? DEFAULT_CREW_RULES;
  const percentiles = o.percentiles ?? DEFAULT_TIMES_PERCENTILE;
  const cities: PressureView["cities"] = {};
  for (const [key, city] of [["cidade_lisboa", "lisbon"], ["cidade_porto", "porto"], ["cidade_faro", "faro"]] as const) {
    if (allowedGroups && !allowedGroups(key)) continue;
    cities[key] = { city, percentile: percentiles[city] as CyclePercentile, bands: crewMeasureBands(crewRules[city] ?? DEFAULT_CREW_RULES[city]), useMeasured: o.useMeasured?.[city] === true };
  }
  const empty: PressureView = { available: false, windowEnd: null, windowStart: null, windowDays: PRESSURE_WINDOW_DAYS, computedAt: null, groups: [], slots: [], loads: [], crew: [], cities };
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) return empty;
  let latest: any;
  try {
    latest = rowsOf(await db.execute(sql`SELECT DATE_FORMAT(windowEnd, '%Y-%m-%d') AS w, windowDays AS d, DATE_FORMAT(computedAt, '%Y-%m-%d %H:%i:%s') AS c
      FROM ops_pressure_stats WHERE parkGroup = ${PRESSURE_DONE_GROUP} ORDER BY windowEnd DESC LIMIT 1`))[0]
      ?? rowsOf(await db.execute(sql`SELECT DATE_FORMAT(windowEnd, '%Y-%m-%d') AS w, windowDays AS d, DATE_FORMAT(MAX(computedAt), '%Y-%m-%d %H:%i:%s') AS c
      FROM ops_pressure_stats GROUP BY windowEnd, windowDays ORDER BY windowEnd DESC LIMIT 1`))[0];
  } catch (err: any) {
    // Tabela ainda não criada (arranque sem a migração 0235).
    console.warn("[extras-pressure] leitura:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
    return empty;
  }
  if (!latest?.w) return empty;
  const windowEnd = String(latest.w);
  const windowDays = Number(latest.d ?? PRESSURE_WINDOW_DAYS) || PRESSURE_WINDOW_DAYS;
  let rows: any[];
  try {
    rows = rowsOf(await db.execute(sql`SELECT parkGroup, groupLabel, kind, weekday, hour, loadBucket, rush, days,
        checkinsDone, checkoutsDone, checkinsStarted, checkoutsStarted, concurrencyAvg, concurrencyMax,
        deliveryN, deliveryP50, deliveryP75, deliveryP90, pickupN, pickupP50, pickupP75,
        cycleN, cycleP50, cycleP60, cycleP75, cycleP85, cycleP90, driveN, driveP50, driveP75, driveP90, toParkN, toParkP50, toParkP75, crewAvg, bandLabel
      FROM ops_pressure_stats WHERE windowEnd = ${windowEnd} AND kind IN ('slot', 'load', 'crew') ORDER BY id LIMIT 20000`));
  } catch {
    // Sem as colunas da migração 0430 (arranque a meio): como antes.
    rows = rowsOf(await db.execute(sql`SELECT parkGroup, groupLabel, kind, weekday, hour, loadBucket, rush, days,
        checkinsDone, checkoutsDone, checkinsStarted, checkoutsStarted, concurrencyAvg, concurrencyMax,
        deliveryN, deliveryP50, deliveryP75, deliveryP90, pickupN, pickupP50, pickupP75
      FROM ops_pressure_stats WHERE windowEnd = ${windowEnd} AND kind IN ('slot', 'load') ORDER BY id LIMIT 20000`));
  }
  const groups = new Map<string, string>();
  const slots: PressureSlot[] = [];
  const loads: PressureLoadRow[] = [];
  const crew: PressureCrewRow[] = [];
  for (const r of rows) {
    const key = String(r.parkGroup ?? "");
    if (allowedGroups && !allowedGroups(key)) continue;
    if (!groups.has(key)) groups.set(key, String(r.groupLabel ?? key));
    const m = mapStoredRow(r);
    if (m.slot) slots.push(m.slot);
    if (m.load) loads.push(m.load);
    if (m.crew) crew.push(m.crew);
  }
  // 44a: um grupo que falhou na última corrida mostra-se com a janela anterior (marcado).
  const stale: NonNullable<PressureView["stale"]> = {};
  try {
    const older = { slot: new Map<string, string>(), crew: new Map<string, string>() };
    for (const r of rowsOf(await db.execute(sql`SELECT parkGroup AS g, kind AS k, DATE_FORMAT(MAX(windowEnd), '%Y-%m-%d') AS w
        FROM ops_pressure_stats WHERE windowEnd < ${windowEnd} AND kind IN ('slot', 'crew') GROUP BY parkGroup, kind`))) {
      const g = String(r.g ?? "");
      if (!g || (allowedGroups && !allowedGroups(g))) continue;
      (r.k === "crew" ? older.crew : older.slot).set(g, String(r.w));
    }
    // Um grupo "está" se tem o próprio cálculo (carga ou movimento); só os tempos por condutor não chegam.
    const present = new Set<string>([...loads.map((l) => l.group), ...slots.filter((x) => x.checkinsDone + x.checkoutsDone + x.deliveryN > 0).map((x) => x.group)]);
    const withDrivers = new Set<string>([...slots.filter((x) => (x.cycleN ?? 0) > 0).map((x) => x.group), ...crew.map((c) => c.group)]);
    for (const f of pressureFallbacks({ groups: present, withDrivers }, older, Object.keys(cities))) {
      const old = rowsOf(await db.execute(sql`SELECT parkGroup, groupLabel, kind, weekday, hour, loadBucket, rush, days,
          checkinsDone, checkoutsDone, checkinsStarted, checkoutsStarted, concurrencyAvg, concurrencyMax,
          deliveryN, deliveryP50, deliveryP75, deliveryP90, pickupN, pickupP50, pickupP75,
          cycleN, cycleP50, cycleP60, cycleP75, cycleP85, cycleP90, driveN, driveP50, driveP75, driveP90, toParkN, toParkP50, toParkP75, crewAvg, bandLabel
        FROM ops_pressure_stats WHERE windowEnd = ${f.w} AND parkGroup = ${f.group} AND kind IN ('slot', 'load', 'crew') ORDER BY id LIMIT 5000`));
      const here = new Map(slots.filter((x) => x.group === f.group).map((x) => [`${x.weekday}:${x.hour}`, x]));
      const hasCrew = crew.some((c) => c.group === f.group);
      if (!groups.has(f.group) && old[0]) groups.set(f.group, String(old[0].groupLabel ?? f.group));
      for (const r of old) {
        const m = mapStoredRow(r);
        if (m.crew) { if (f.part === "drivers" || !hasCrew) crew.push(m.crew); continue; }
        if (m.load) { if (f.part === "all") loads.push(m.load); continue; }
        if (!m.slot) continue;
        const target = here.get(`${m.slot.weekday}:${m.slot.hour}`);
        if (f.part === "drivers") {
          if (target) for (const k of DRIVER_FIELDS) (target as any)[k] = (m.slot as any)[k];
        } else if (target) {
          // Só os tempos por condutor vieram na corrida de hoje: o resto vem da janela anterior.
          for (const [k, v] of Object.entries(m.slot)) if (!(DRIVER_FIELDS as readonly string[]).includes(k)) (target as any)[k] = v;
        } else {
          slots.push(m.slot);
        }
      }
      stale[f.group] = { w: f.w, part: f.part };
    }
  } catch (err: any) {
    console.warn("[extras-pressure] janela anterior:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
  }
  return {
    available: true,
    windowEnd,
    windowStart: addDays(windowEnd, -(windowDays - 1)),
    windowDays,
    computedAt: latest.c ? String(latest.c) : null,
    groups: Array.from(groups, ([key, label]) => ({ key, label })),
    slots,
    loads,
    crew,
    cities,
    ...(Object.keys(stale).length ? { stale } : {}),
  };
}

// ─── 27b: quem são os TL na Multipark ────────────────────────────────────────

/**
 * Agentes da Multipark dos colaboradores com posto Team Leader: o da ficha
 * (`multiparkAgentUserId`) e os ligados (`employee_agents`). Duas leituras
 * simples (sem UNION entre collations). Só leitura; falha → [] (cada hora
 * leva +1). Nunca lança.
 */
export async function loadTeamLeaderAgentIds(): Promise<string[]> {
  try {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) return [];
    const linked = rowsOf(await db.execute(sql`SELECT ea.agentUserId AS id FROM employee_agents ea
      JOIN employees e ON e.id = ea.employeeId WHERE e.position = 'team_leader'`));
    const own = rowsOf(await db.execute(sql`SELECT multiparkAgentUserId AS id FROM employees
      WHERE position = 'team_leader' AND multiparkAgentUserId IS NOT NULL AND multiparkAgentUserId <> ''`));
    return [...new Set([...linked, ...own].map((r) => String(r.id ?? "").trim()).filter(Boolean))];
  } catch (err: any) {
    console.warn("[extras-pressure] TL:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
    return [];
  }
}

// ─── 26c: escalões medidos para a escala ─────────────────────────────────────

const CREW_ROWS_CACHE_MS = 5 * 60_000;
let crewRowsCache: { at: number; rows: PressureCrewRow[] } | null = null;

/**
 * Escalões medidos (kind 'crew', todas as cidades) da última janela completa,
 * para a escala usar os tempos medidos (26c). Cache de 5 min no processo (a
 * previsão corre muitas vezes). Falha a ler / sem tabela / sem janela → []
 * (a escala usa a tabela). Nunca lança.
 */
export async function loadLatestCrewRows(): Promise<PressureCrewRow[]> {
  if (crewRowsCache && Date.now() - crewRowsCache.at < CREW_ROWS_CACHE_MS) return crewRowsCache.rows;
  let rows: PressureCrewRow[] = [];
  try {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (db) {
      const latest = rowsOf(await db.execute(sql`SELECT DATE_FORMAT(windowEnd, '%Y-%m-%d') AS w
        FROM ops_pressure_stats WHERE parkGroup = ${PRESSURE_DONE_GROUP} ORDER BY windowEnd DESC LIMIT 1`))[0];
      if (latest?.w) {
        const raw = rowsOf(await db.execute(sql`SELECT parkGroup, kind, loadBucket, rush, bandLabel, cycleN, cycleP50, cycleP60, cycleP75, cycleP85, cycleP90
          FROM ops_pressure_stats WHERE windowEnd = ${String(latest.w)} AND kind = 'crew' ORDER BY id LIMIT 500`));
        rows = raw.map((r) => mapStoredRow(r).crew).filter((c): c is PressureCrewRow => !!c);
      }
    }
  } catch (err: any) {
    console.warn("[extras-pressure] escalões medidos:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
    rows = [];
  }
  crewRowsCache = { at: Date.now(), rows };
  return rows;
}
