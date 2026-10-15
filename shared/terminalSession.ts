/**
 * TERMINAL PELO PERFIL (plano 56, parte B; decisões do Jorge a 12 out 2026) —
 * regras puras, partilhadas pelo servidor (server/terminalSessions.ts) e pelo
 * ecrã (barra do terminal, cartão "Terminal agora").
 *
 *  - Extras, condutores e team leaders carregam em "Estou no terminal" (na
 *    fotografia lá em cima, ou na entrada do ponto). O GPS tem de tocar a zona
 *    do aeroporto (distância − imprecisão ≤ raio) de uma cidade onde a pessoa
 *    trabalha (ficha + cidades dadas, `city.extra.*`).
 *  - Uma pessoa por cidade e cada pessoa só num terminal — quem garante é a
 *    BD (chaves únicas `activeCityKey` / `activeEmployeeId` em
 *    `terminal_sessions`). Ocupado → "Pedir ao João para passar".
 *  - O nível +1 no pagamento é só para extras (`payUplift`); condutores e TL
 *    ficam no terminal sem mudar o valor.
 * Nada aqui toca na BD.
 */
import { distanceMeters, lisbonClock, type AirportCityId, type AirportFence, type AirportsMap } from "./pontoTerminal";

export type TerminalCityKey = AirportCityId;
export const TERMINAL_CITY_KEYS: readonly TerminalCityKey[] = ["lisbon", "porto", "faro"];

/** Como abriu a sessão. */
export const TERMINAL_START_SOURCES = ["button", "checkin", "handover", "tl", "takeover", "reopen"] as const;
export type TerminalStartSource = (typeof TERMINAL_START_SOURCES)[number];
/** Como fechou (o lugar libertou-se). */
export const TERMINAL_END_REASONS = ["button", "handover", "tl", "checkout", "no_answer", "stale_checkout"] as const;
export type TerminalEndReason = (typeof TERMINAL_END_REASONS)[number];
/** Até onde contam as horas e porquê (regras em shared/terminalWatch.ts `countedAtClose`; o RH confirma ou desmarca). */
export const TERMINAL_COUNTED_BASES = ["gps_close", "last_gps", "last_service", "confirmed", "pending", "rejected"] as const;
export type TerminalCountedBasis = (typeof TERMINAL_COUNTED_BASES)[number];
/** Estado de um pedido para passar o terminal. */
export const TERMINAL_HANDOVER_STATUSES = ["pending", "passed", "declined", "expired", "cancelled"] as const;
export type TerminalHandoverStatus = (typeof TERMINAL_HANDOVER_STATUSES)[number];

/** Postos que podem ficar no terminal (Jorge: extras e condutores; o TL também, sem mudar o valor). */
export const TERMINAL_POSITIONS = ["extra", "driver", "senior_driver", "team_leader"] as const;

/** Imprecisão máxima do GPS aceite para entrar no terminal (acima disto o GPS não prova nada). */
export const TERMINAL_MAX_ACCURACY_M = 1000;
/** Um pedido para passar caduca ao fim de X minutos (o Pedro volta a pedir). */
export const TERMINAL_HANDOVER_TTL_MIN = 30;
/** Motivo do TL/supervisor: mínimo de letras. */
export const TERMINAL_REASON_MIN = 3;

export interface TerminalPersonLike {
  position?: string | null;
  contractType?: string | null;
}

/** Pode ficar no terminal? Posto extra / condutor / condutor sénior / TL, ou contrato de extra. PURA. */
export function canUseTerminal(e: TerminalPersonLike | null | undefined): boolean {
  if (!e) return false;
  return (TERMINAL_POSITIONS as readonly string[]).includes(String(e.position ?? "")) || e.contractType === "extra";
}

/** É extra (posto ou contrato)? A mesma regra de server/pontoTerminal.ts `isExtraEmployee`. PURA. */
export function isTerminalExtra(e: TerminalPersonLike | null | undefined): boolean {
  return !!e && (e.position === "extra" || e.contractType === "extra");
}

/** Nível +1 no pagamento: só extras (1); condutores e TL ficam no terminal sem mudar o valor (0). PURA. */
export function terminalPayUplift(e: TerminalPersonLike | null | undefined): 0 | 1 {
  return isTerminalExtra(e) ? 1 : 0;
}

// ─── Nomes ──────────────────────────────────────────────────────────────────

export const TERMINAL_CITY_LABELS: Record<TerminalCityKey, string> = { lisbon: "Lisboa", porto: "Porto", faro: "Faro" };
/** "de Lisboa" / "do Porto" / "de Faro". */
export const TERMINAL_CITY_OF: Record<TerminalCityKey, string> = { lisbon: "de Lisboa", porto: "do Porto", faro: "de Faro" };

export function isTerminalCityKey(v: unknown): v is TerminalCityKey {
  return typeof v === "string" && (TERMINAL_CITY_KEYS as readonly string[]).includes(v);
}

/** Primeiro nome ("João Silva" → "João"). PURA. */
export function firstName(name: string | null | undefined): string {
  const t = String(name ?? "").trim();
  return t ? t.split(/\s+/)[0] : "colega";
}

/** "a 800 m" / "a 3,2 km". PURA. */
export function distanceLabel(m: number): string {
  if (!Number.isFinite(m) || m < 0) return "";
  if (m < 1000) return `a ${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `a ${(Math.round(m / 100) / 10).toFixed(1).replace(".", ",")} km`;
}

/** "±1,2 km" / "±300 m". PURA. */
function accuracyLabel(m: number): string {
  return m < 1000 ? `±${Math.round(m)} m` : `±${(Math.round(m / 100) / 10).toFixed(1).replace(".", ",")} km`;
}

/** Duração "3 h 15" / "45 min" / "2 h". PURA. */
export function durationLabel(fromMs: number, toMs: number): string {
  const min = Math.max(0, Math.round((toMs - fromMs) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
}

/** "O terminal de Lisboa está com o João Silva desde 14:05." PURA. */
export function terminalBusyMessage(city: TerminalCityKey, holderName: string, since: string | Date | null | undefined): string {
  const hm = lisbonClock(since ?? null);
  return `O terminal ${TERMINAL_CITY_OF[city]} está com ${holderName || "outra pessoa"}${hm ? ` desde ${hm}` : ""}.`;
}

/** "Estás no terminal de Lisboa desde 14:05." PURA. */
export function terminalStartedMessage(city: TerminalCityKey, since: string | Date | null | undefined): string {
  const hm = lisbonClock(since ?? null);
  return `Estás no terminal ${TERMINAL_CITY_OF[city]}${hm ? ` desde ${hm}` : ""}.`;
}

/** "Saíste do terminal às 17:20 (3 h 15)." PURA. */
export function terminalLeftMessage(startedAt: string | Date, endedAt: string | Date): string {
  const a = toMs(startedAt), b = toMs(endedAt);
  const hm = lisbonClock(endedAt);
  const dur = Number.isFinite(a) && Number.isFinite(b) ? ` (${durationLabel(a, b)})` : "";
  return `Saíste do terminal${hm ? ` às ${hm}` : ""}${dur}.`;
}

// ─── Instantes (UTC, como na BD) ────────────────────────────────────────────

/** "YYYY-MM-DD HH:MM:SS" (UTC, BD), ISO ou Date → ms; inválido → NaN. PURA. */
export function toMs(v: string | Date | null | undefined): number {
  if (v == null || v === "") return NaN;
  if (v instanceof Date) return v.getTime();
  const s = String(v).trim();
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) || s.includes("T") ? s : s.replace(" ", "T") + "Z").getTime();
}

/** ms → "YYYY-MM-DD HH:MM:SS" (UTC, como se grava na BD). PURA. */
export function toDbUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

// ─── Zonas e GPS ────────────────────────────────────────────────────────────

export interface ZoneCircle { label: string | null; lat: number; lng: number; radiusM: number }

/** Zonas que contam num aeroporto: as zonas por terminal, se houver; senão o círculo do aeroporto. PURA. */
export function zonesOf(fence: AirportFence | null | undefined): ZoneCircle[] {
  if (!fence) return [];
  const zones = (fence.zones ?? []).filter((z) => Number.isFinite(z?.lat) && Number.isFinite(z?.lng) && Number.isFinite(z?.radiusM) && z.radiusM > 0);
  if (zones.length) return zones.map((z) => ({ label: z.label?.trim() || null, lat: z.lat, lng: z.lng, radiusM: z.radiusM }));
  return [{ label: null, lat: fence.lat, lng: fence.lng, radiusM: fence.radiusM }];
}

export interface GpsFix { lat: number | null | undefined; lng: number | null | undefined; accuracy?: number | null }

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** GPS válido? ("0,0" = GPS que não respondeu). PURA. */
export function validFix(fix: GpsFix | null | undefined): { lat: number; lng: number; accuracy: number } | null {
  const lat = num(fix?.lat), lng = num(fix?.lng);
  if (lat == null || lng == null || (lat === 0 && lng === 0) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const acc = num(fix?.accuracy);
  return { lat, lng, accuracy: acc != null && acc > 0 ? acc : 0 };
}

/**
 * O GPS toca alguma zona do aeroporto? REGRA: distância ao centro − imprecisão
 * ≤ raio (a imprecisão do GPS a tocar a zona). Devolve também a distância ao
 * centro mais perto (para "a 3,2 km"). PURA.
 */
export function gpsInAirport(fix: { lat: number; lng: number; accuracy: number }, fence: AirportFence | null | undefined): { inside: boolean; distanceM: number; zone: string | null } {
  let best = { inside: false, distanceM: Infinity, zone: null as string | null };
  for (const z of zonesOf(fence)) {
    const d = distanceMeters(fix.lat, fix.lng, z.lat, z.lng);
    const inside = d - fix.accuracy <= z.radiusM;
    if (inside && (!best.inside || d < best.distanceM)) best = { inside: true, distanceM: d, zone: z.label };
    else if (!best.inside && d < best.distanceM) best = { inside: false, distanceM: d, zone: z.label };
  }
  return best;
}

export type AirportMatch =
  | { ok: true; city: TerminalCityKey; zone: string | null; distanceM: number }
  | { ok: false; reason: "no_gps" | "imprecise" | "no_city" | "outside" | "other_city"; city: TerminalCityKey | null; distanceM: number | null; message: string };

/**
 * Em que aeroporto está o GPS, e se é de uma cidade onde a pessoa trabalha.
 *  - sem GPS → "Sem GPS…";
 *  - imprecisão acima de TERMINAL_MAX_ACCURACY_M → "O GPS está pouco preciso…";
 *  - nenhuma cidade com aeroporto no acesso → "A tua ficha não tem cidade…";
 *  - dentro de um aeroporto fora do acesso → "O aeroporto do Porto não é de uma cidade onde trabalhas…";
 *  - fora → "Não estás no aeroporto de Lisboa (a 3,2 km)." (o aeroporto das tuas cidades mais perto).
 * PURA.
 */
export function matchAirport(fix: GpsFix | null | undefined, airports: Partial<AirportsMap>, allowed: readonly TerminalCityKey[]): AirportMatch {
  const v = validFix(fix);
  if (!v) return { ok: false, reason: "no_gps", city: null, distanceM: null, message: "Sem GPS. Liga a localização exata e tenta outra vez." };
  if (v.accuracy > TERMINAL_MAX_ACCURACY_M) {
    return { ok: false, reason: "imprecise", city: null, distanceM: null, message: `O GPS está pouco preciso (${accuracyLabel(v.accuracy)}). Liga a localização exata e tenta outra vez.` };
  }
  const mine = TERMINAL_CITY_KEYS.filter((c) => allowed.includes(c) && airports[c]);
  if (!mine.length) return { ok: false, reason: "no_city", city: null, distanceM: null, message: "A tua ficha não tem cidade com aeroporto. Fala com o RH." };
  let nearest: { city: TerminalCityKey; distanceM: number } | null = null;
  for (const c of mine) {
    const r = gpsInAirport(v, airports[c]);
    if (r.inside) return { ok: true, city: c, zone: r.zone, distanceM: r.distanceM };
    if (!nearest || r.distanceM < nearest.distanceM) nearest = { city: c, distanceM: r.distanceM };
  }
  for (const c of TERMINAL_CITY_KEYS.filter((x) => !mine.includes(x) && airports[x])) {
    if (gpsInAirport(v, airports[c]).inside) {
      return { ok: false, reason: "other_city", city: c, distanceM: null, message: `O aeroporto ${TERMINAL_CITY_OF[c]} não é de uma cidade onde trabalhas. Fala com o teu TL.` };
    }
  }
  const n = nearest!;
  return { ok: false, reason: "outside", city: n.city, distanceM: n.distanceM, message: `Não estás no aeroporto ${TERMINAL_CITY_OF[n.city]} (${distanceLabel(n.distanceM)}).` };
}

/** O GPS (do fecho) está dentro do aeroporto desta cidade? `null` sem GPS. PURA. */
export function fixInsideCity(fix: GpsFix | null | undefined, airports: Partial<AirportsMap>, city: TerminalCityKey): boolean | null {
  const v = validFix(fix);
  if (!v || v.accuracy > TERMINAL_MAX_ACCURACY_M) return null;
  return gpsInAirport(v, airports[city]).inside;
}

// ─── Fecho: até onde contam as horas (B1) ───────────────────────────────────

/**
 * Fecho de uma sessão — a regra do B1 (regra de 7 out: nunca se paga sem
 * prova, não se corta a quem tem prova): fechou com GPS dentro → até ao
 * fecho ("gps_close"); senão "pending". Uma saída esquecida nunca prova nada.
 * O B2 completa-a (último GPS dentro, última recolha/entrega até ao "fora"):
 * shared/terminalWatch.ts `countedAtClose`, que é o que o servidor usa. PURA.
 */
export function closeCounting(o: { endedAtMs: number; insideAtClose: boolean | null; forgotten?: boolean }): { countedUntil: string | null; countedBasis: TerminalCountedBasis } {
  if (o.insideAtClose === true && !o.forgotten) return { countedUntil: toDbUtc(o.endedAtMs), countedBasis: "gps_close" };
  return { countedUntil: null, countedBasis: "pending" };
}

/** O pedido para passar ainda vale? (pendente e dentro do prazo). PURA. */
export function handoverStillValid(r: { status: string; requestedAt: string | Date }, nowMs: number): boolean {
  if (r.status !== "pending") return false;
  const t = toMs(r.requestedAt);
  return Number.isFinite(t) && nowMs - t <= TERMINAL_HANDOVER_TTL_MIN * 60_000;
}

/** Erro "chave duplicada" do MySQL (a BD recusou: lugar ocupado ou pessoa já num terminal). PURA. */
export function isDupEntry(err: unknown): boolean {
  const e = err as any;
  return (e?.code ?? e?.cause?.code) === "ER_DUP_ENTRY" || Number(e?.errno ?? e?.cause?.errno) === 1062;
}

export const TERMINAL_START_SOURCE_LABELS: Record<TerminalStartSource, string> = {
  button: "pelo GPS",
  checkin: "na entrada do ponto",
  handover: "passado pelo colega",
  tl: "posto pelo TL",
  takeover: "colega já sem ponto",
  reopen: "reaberto",
};

export const TERMINAL_END_REASON_LABELS: Record<TerminalEndReason, string> = {
  button: "saiu",
  handover: "passou ao colega",
  tl: "fechado pelo TL",
  checkout: "saída do ponto",
  no_answer: "sem resposta",
  stale_checkout: "ponto fechado sozinho",
};
