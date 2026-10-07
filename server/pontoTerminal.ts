/**
 * Terminal no ponto (aeroporto) — a parte com BD. As regras puras vivem em
 * shared/pontoTerminal.ts; aqui só se lê o interruptor, os aeroportos
 * (Definições) e a cidade da ficha, e se classifica a entrada/saída.
 *
 * Saída fora do aeroporto (Jorge, 7 out 2026): o troço "pending" passa a
 * "partial" — terminal até à ÚLTIMA recolha/entrega do extra na Multipark
 * dentro do troço (BD da Multipark, SÓ LEITURA: server/multiparkDb/movements.ts
 * getAgentServiceInstants; agentes pela ligação explícita da ficha, por ID).
 * Tenta-se logo na saída (com teto de tempo curto) e repete-se no trabalho
 * diário (daily-ops) para os "pending" dos últimos TERMINAL_RETRY_DAYS dias.
 * Sem ações ou sem leitura → fica "pending" (o RH decide).
 *
 * Interruptor PONTO_TERMINAL desligado → nada é avaliado nem gravado (o ponto,
 * o ordenado e os ecrãs ficam como antes). Nunca parte o ponto: qualquer erro
 * aqui devolve "sem terminal" (ou deixa o troço "pending").
 */
import {
  DEFAULT_TERMINAL_AIRPORTS,
  TERMINAL_RETRY_DAYS,
  airportCityOf,
  classifyCheckIn,
  classifyCheckOut,
  isAtAirport,
  resolveTerminalByLastService,
  type AirportFence,
  type AirportsMap,
  type PrevRecordLike,
  type TerminalResolution,
} from "../shared/pontoTerminal";
import type { MultiparkRead } from "./multiparkDb/read";
import type { AgentServiceInstant } from "./multiparkDb/movements";

export const PONTO_TERMINAL_FLAG = "PONTO_TERMINAL" as const;

/** Interruptor "Terminal no ponto (aeroporto)" (desligado por omissão). */
export async function pontoTerminalEnabled(): Promise<boolean> {
  try {
    const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([
      import("./_core/featureFlags"),
      import("../shared/appSettings"),
    ]);
    await ensureFeatureFlagOverrides();
    return isFeatureEnabled(PONTO_TERMINAL_FLAG, { defaultEnabled: automationFlagDefault(PONTO_TERMINAL_FLAG) });
  } catch {
    return false;
  }
}

/** Aeroportos das Definições (ou os valores por omissão). */
export async function loadTerminalAirports(): Promise<AirportsMap> {
  try {
    const { getSetting } = await import("./appSettings");
    const v = await getSetting("ponto.terminalAirports");
    return (v as AirportsMap | null) ?? DEFAULT_TERMINAL_AIRPORTS;
  } catch {
    return DEFAULT_TERMINAL_AIRPORTS;
  }
}

/** É extra (posto ou tipo de contrato)? Só os extras têm terminal. */
export function isExtraEmployee(e: { position?: string | null; contractType?: string | null } | null | undefined): boolean {
  return !!e && (e.position === "extra" || e.contractType === "extra");
}

/** Aeroporto da cidade da ficha (centro de custos → candidatura → morada), ou null. */
export async function airportForEmployee(employeeId: number): Promise<AirportFence | null> {
  const { resolveCitiesForEmployeeIds } = await import("./employeeCity");
  const city = (await resolveCitiesForEmployeeIds([employeeId])).get(employeeId)?.city ?? null;
  const key = airportCityOf(city);
  if (!key) return null;
  const airports = await loadTerminalAirports();
  return airports[key] ?? null;
}

export interface PontoTerminalEval {
  /** gravar em time_records.atAirport (null = não avaliado) */
  atAirport: 0 | 1 | null;
  /** gravar em time_records.terminalStatus */
  terminalStatus: "start" | "auto" | "pending" | null;
  /** para a resposta ao ecrã */
  terminal: "start" | "return" | "auto" | "pending" | null;
}

const none = (): PontoTerminalEval => ({ atAirport: null, terminalStatus: null, terminal: null });

/**
 * ENTRADA de um extra: GPS no aeroporto da cidade dele → abre um troço de
 * terminal ("start"), exceto o regresso (saída de terminal há < 30 min).
 * `prev` = o último registo antes desta entrada (uma saída).
 */
export async function evaluateCheckInTerminal(o: {
  employee: { id: number; position?: string | null; contractType?: string | null };
  latitude?: string | null; longitude?: string | null;
  prev: PrevRecordLike | null;
  at?: Date;
}): Promise<PontoTerminalEval> {
  try {
    if (!isExtraEmployee(o.employee)) return none();
    if (!(await pontoTerminalEnabled())) return none();
    const airport = await airportForEmployee(o.employee.id);
    if (!airport) return none();
    const at = isAtAirport(o.latitude, o.longitude, airport);
    const c = classifyCheckIn({ atAirport: at, prev: o.prev, at: o.at ?? new Date() });
    return {
      atAirport: at == null ? null : at ? 1 : 0,
      terminalStatus: c.status,
      terminal: c.status === "start" ? "start" : c.reason === "return" ? "return" : null,
    };
  } catch (err) {
    console.warn("[ponto/terminal] entrada não avaliada:", String((err as Error)?.message ?? err).slice(0, 160));
    return none();
  }
}

/**
 * SAÍDA de um extra: se a entrada aberta abriu um troço de terminal, a saída no
 * aeroporto fecha-o como "auto" (paga terminal); fora ou sem GPS → "pending".
 */
export async function evaluateCheckOutTerminal(o: {
  employee: { id: number; position?: string | null; contractType?: string | null };
  latitude?: string | null; longitude?: string | null;
  openCheckInStatus: string | null | undefined;
}): Promise<PontoTerminalEval> {
  try {
    if (!isExtraEmployee(o.employee)) return none();
    if (!(await pontoTerminalEnabled())) return none();
    const airport = await airportForEmployee(o.employee.id);
    const at = airport ? isAtAirport(o.latitude, o.longitude, airport) : null;
    const status = classifyCheckOut({ checkInStatus: o.openCheckInStatus, atAirport: at });
    return { atAirport: at == null ? null : at ? 1 : 0, terminalStatus: status, terminal: status };
  } catch (err) {
    console.warn("[ponto/terminal] saída não avaliada:", String((err as Error)?.message ?? err).slice(0, 160));
    return none();
  }
}

// ─── Saída fora do aeroporto: terminal até à última recolha/entrega ─────────

/** Teto da leitura da Multipark na SAÍDA (o ponto não fica à espera; falha → "pending" e repete-se de madrugada). */
export const TERMINAL_CHECKOUT_READ_TIMEOUT_MS = 6_000;
/** Teto de troços "pending" tratados por corrida do trabalho diário. */
export const TERMINAL_RETRY_MAX_SHIFTS = 200;

/** Leitura das recolhas/entregas (injetável nos testes). */
export type TerminalServiceReader = (f: { userIds: string[]; from: string; to: string }) =>
  Promise<MultiparkRead<{ rows: AgentServiceInstant[]; truncated: boolean }>>;

/** Leitura por omissão: BD da Multipark (só leitura), com o teto de tempo pedido. */
export function multiparkServiceReader(timeoutMs?: number): TerminalServiceReader {
  return async (f) => {
    const [{ getAgentServiceInstants }, { multiparkDbQuery }] = await Promise.all([
      import("./multiparkDb/movements"),
      import("./multiparkDb/client"),
    ]);
    return getAgentServiceInstants(f, (sql, params) => multiparkDbQuery(sql, params, timeoutMs ? { timeoutMs } : undefined));
  };
}

/** Agentes da Multipark da ficha: ligação explícita por ID (principal + extra), nunca pelo nome; sem agentes de sistema. */
export async function terminalAgentIdsOf(employeeId: number): Promise<string[]> {
  const [{ agentIdsOfEmployee }, { isSystemAgentId }] = await Promise.all([
    import("./personIdentity"),
    import("../shared/agentIdentity"),
  ]);
  return (await agentIdsOfEmployee(employeeId)).agentUserIds.filter((id) => !isSystemAgentId(id));
}

/**
 * Um troço de terminal fechado fora do aeroporto: lê as recolhas/entregas do
 * extra entre a entrada e a saída e aplica a regra pura. Nunca lança: sem
 * agentes ligados, leitura falhada ou erro → "pending".
 */
export async function resolveTerminalShift(o: {
  employeeId: number;
  inAt: string;
  outAt: string;
  read?: TerminalServiceReader;
  agentIds?: string[];
}): Promise<TerminalResolution> {
  try {
    const ids = o.agentIds ?? (await terminalAgentIdsOf(o.employeeId));
    if (!ids.length) return { status: "pending", reason: "no_agent" };
    const read = o.read ?? multiparkServiceReader(TERMINAL_CHECKOUT_READ_TIMEOUT_MS);
    const r = await read({ userIds: ids, from: o.inAt, to: o.outAt });
    if (!r.available) return { status: "pending", reason: "read_failed" };
    // as mais recentes primeiro: o teto só corta as mais antigas — a última está lá
    return resolveTerminalByLastService({ inAt: o.inAt, outAt: o.outAt, actions: r.data.rows });
  } catch (err) {
    console.warn("[ponto/terminal] última recolha/entrega não lida:", String((err as Error)?.message ?? err).slice(0, 160));
    return { status: "pending", reason: "read_failed" };
  }
}

/**
 * Grava "partial" + `terminalUntil` numa SAÍDA que ainda está "pending" (nunca
 * por cima do RH: "confirmed"/"rejected" ficam). Só UPDATE; nada se apaga.
 * Devolve true se mudou.
 */
export async function applyTerminalPartial(recordId: number, terminalUntil: string): Promise<boolean> {
  const [{ getDb }, { timeRecords }, { and, eq }] = await Promise.all([
    import("./db"),
    import("../drizzle/schema"),
    import("drizzle-orm"),
  ]);
  const db = await getDb();
  if (!db) return false;
  const res = await db.update(timeRecords)
    .set({ terminalStatus: "partial", terminalUntil })
    .where(and(eq(timeRecords.id, recordId), eq(timeRecords.type, "check_out"), eq(timeRecords.terminalStatus, "pending")));
  return Number((res as any)?.[0]?.affectedRows ?? (res as any)?.affectedRows ?? 0) > 0;
}

/**
 * Na SAÍDA (troço acabado de gravar como "pending"): tenta já ler a Multipark
 * (teto TERMINAL_CHECKOUT_READ_TIMEOUT_MS) e, havendo recolha/entrega no
 * troço, passa-o a "partial". Interruptor desligado → nada. Nunca lança.
 */
export async function resolvePendingAtCheckout(o: {
  recordId: number;
  employeeId: number;
  inAt: string;
  outAt: string;
  read?: TerminalServiceReader;
}): Promise<TerminalResolution> {
  try {
    if (!(await pontoTerminalEnabled())) return { status: "pending", reason: "read_failed" };
    const res = await resolveTerminalShift(o);
    if (res.status === "partial" && !(await applyTerminalPartial(o.recordId, res.terminalUntil))) {
      return { status: "pending", reason: "read_failed" };
    }
    return res;
  } catch (err) {
    console.warn("[ponto/terminal] saída: terminal parcial não gravado:", String((err as Error)?.message ?? err).slice(0, 160));
    return { status: "pending", reason: "read_failed" };
  }
}

export interface PendingTerminalShift {
  /** id da SAÍDA */
  id: number;
  employeeId: number;
  /** entrada do troço (UTC "YYYY-MM-DD HH:MM:SS") */
  inAt: string | null;
  /** saída (UTC) */
  outAt: string;
}

export interface TerminalRetryReport {
  skipped?: "off";
  /** troços "pending" vistos */
  pending: number;
  /** passaram a "partial" */
  resolved: number;
  /** sem recolha/entrega no troço (ficam para o RH) */
  noActions: number;
  /** ficha sem agente da Multipark ligado (ficam para o RH) */
  noAgent: number;
  /** a Multipark não respondeu (repete-se amanhã) */
  readFailed: boolean;
  /** ficaram por ver (prazo / teto) */
  deferred: number;
}

/** Troços "pending" (saída) dos últimos `days` dias, com a entrada que os abriu. */
async function loadPendingTerminalShifts(sinceUtc: string, limit: number): Promise<PendingTerminalShift[]> {
  const [{ getDb }, { sql }] = await Promise.all([import("./db"), import("drizzle-orm")]);
  const db = await getDb();
  if (!db) return [];
  const [rows] = await db.execute(sql`
    SELECT o.id, o.employeeId, DATE_FORMAT(o.recordedAt, '%Y-%m-%d %H:%i:%s') AS outAt,
      (SELECT DATE_FORMAT(MAX(i.recordedAt), '%Y-%m-%d %H:%i:%s') FROM time_records i
        WHERE i.employeeId = o.employeeId AND i.type = 'check_in' AND i.recordedAt < o.recordedAt) AS inAt
    FROM time_records o
    WHERE o.type = 'check_out' AND o.terminalStatus = 'pending' AND o.recordedAt >= ${sinceUtc}
    ORDER BY o.recordedAt DESC
    LIMIT ${limit}
  `) as any;
  return ((rows as any[]) ?? []).map((r) => ({ id: Number(r.id), employeeId: Number(r.employeeId), inAt: r.inAt ? String(r.inAt) : null, outAt: String(r.outAt) }));
}

/**
 * Repetição automática (trabalho diário daily-ops, depois de fechar os pontos
 * esquecidos): os troços "pending" dos últimos TERMINAL_RETRY_DAYS dias voltam
 * a ler a Multipark — UMA leitura para todos (os agentes de todas as fichas,
 * da entrada mais antiga à saída mais recente) — e passam a "partial" quando
 * há recolha/entrega dentro do troço. Interruptor desligado → nada. Respeita o
 * prazo (`deadlineAt`). Nunca apaga; nunca mexe no que o RH decidiu.
 */
export async function retryPendingTerminalShifts(o: {
  deadlineAt: number;
  days?: number;
  now?: number;
  read?: TerminalServiceReader;
  load?: (sinceUtc: string, limit: number) => Promise<PendingTerminalShift[]>;
  agentIdsOf?: (employeeId: number) => Promise<string[]>;
  apply?: (recordId: number, terminalUntil: string) => Promise<boolean>;
}): Promise<TerminalRetryReport> {
  const report: TerminalRetryReport = { pending: 0, resolved: 0, noActions: 0, noAgent: 0, readFailed: false, deferred: 0 };
  if (!(await pontoTerminalEnabled())) return { ...report, skipped: "off" };
  const now = o.now ?? Date.now();
  const since = new Date(now - (o.days ?? TERMINAL_RETRY_DAYS) * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  const shifts = await (o.load ?? loadPendingTerminalShifts)(since, TERMINAL_RETRY_MAX_SHIFTS);
  report.pending = shifts.length;
  if (!shifts.length) return report;

  // Agentes de cada ficha (por ID). Sem agentes → fica para o RH.
  const agentsOf = o.agentIdsOf ?? terminalAgentIdsOf;
  const idsByEmployee = new Map<number, string[]>();
  for (const emp of new Set(shifts.map((s) => s.employeeId))) {
    if (Date.now() > o.deadlineAt) break;
    try { idsByEmployee.set(emp, await agentsOf(emp)); } catch { idsByEmployee.set(emp, []); }
  }
  const todo = shifts.filter((s) => {
    const ids = idsByEmployee.get(s.employeeId);
    if (ids === undefined) { report.deferred++; return false; }
    if (!ids.length) { report.noAgent++; return false; }
    if (!s.inAt) { report.noActions++; return false; } // saída sem entrada: nada a medir
    return true;
  });
  if (!todo.length) return report;
  if (Date.now() > o.deadlineAt) { report.deferred += todo.length; return report; }

  const allIds = Array.from(new Set(todo.flatMap((s) => idsByEmployee.get(s.employeeId) ?? [])));
  const from = todo.reduce((m, s) => (s.inAt! < m ? s.inAt! : m), todo[0].inAt!);
  const to = todo.reduce((m, s) => (s.outAt > m ? s.outAt : m), todo[0].outAt);
  // teto da leitura = o tempo que ainda resta ao passo (nunca mais do que o normal de 15 s)
  const read = o.read ?? multiparkServiceReader(Math.min(15_000, Math.max(2_000, o.deadlineAt - Date.now() - 1_000)));
  let r: Awaited<ReturnType<TerminalServiceReader>>;
  try { r = await read({ userIds: allIds, from, to }); } catch { r = { available: false, code: "QUERY_FAILED", reason: "erro" }; }
  if (!r.available) { report.readFailed = true; return report; }
  const rows = r.data.rows;
  // Teto atingido: só as ações mais antigas do que a última linha lida faltam.
  const oldest = r.data.truncated && rows.length ? rows[rows.length - 1].at : null;

  const { serviceInstantBelongsTo } = await import("./multiparkDb/movements");
  const apply = o.apply ?? applyTerminalPartial;
  for (const s of todo) {
    if (Date.now() > o.deadlineAt) { report.deferred++; continue; }
    const mine = new Set(idsByEmployee.get(s.employeeId) ?? []);
    const res = resolveTerminalByLastService({ inAt: s.inAt!, outAt: s.outAt, actions: rows.filter((a) => serviceInstantBelongsTo(a, mine)) });
    if (res.status === "partial") {
      try { if (await apply(s.id, res.terminalUntil)) report.resolved++; } catch { report.deferred++; }
    } else if (oldest && s.inAt! < oldest) {
      report.deferred++; // a leitura não chegou ao início deste troço: tenta-se amanhã
    } else report.noActions++;
  }
  return report;
}
