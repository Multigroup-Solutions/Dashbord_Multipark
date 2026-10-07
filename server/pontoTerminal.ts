/**
 * Terminal no ponto (aeroporto) — a parte com BD. As regras puras vivem em
 * shared/pontoTerminal.ts; aqui só se lê o interruptor, os aeroportos
 * (Definições) e a cidade da ficha, e se classifica a entrada/saída.
 *
 * Interruptor PONTO_TERMINAL desligado → nada é avaliado nem gravado (o ponto,
 * o ordenado e os ecrãs ficam como antes). Nunca parte o ponto: qualquer erro
 * aqui devolve "sem terminal".
 */
import {
  DEFAULT_TERMINAL_AIRPORTS,
  airportCityOf,
  classifyCheckIn,
  classifyCheckOut,
  isAtAirport,
  type AirportFence,
  type AirportsMap,
  type PrevRecordLike,
} from "../shared/pontoTerminal";

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
