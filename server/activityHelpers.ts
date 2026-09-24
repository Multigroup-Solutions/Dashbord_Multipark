/**
 * Regras PURAS da Atividade do Dia (sem BD) — testadas em activityHelpers.test.ts.
 *
 *  - identidade: agente Multipark → pessoa (id do agente, agentes extra da
 *    ficha, nome do agente na ficha, parceiro, ignorado) — UMA regra para a
 *    tabela do dia, para o intervalo (custos/horário) e para o detalhe;
 *  - "resto" do GPS de um PDA partilhado (km sem ninguém com login);
 *  - turno de cada ação (no horário / fora do horário, dia do turno);
 *  - histórico de velocidade por pessoa (agregação por dia).
 */

// ─── Identidade ──────────────────────────────────────────────────────────────

export interface IdentityEmployee { id: number; fullName: string; multiparkAgentUserId: string | null; multiparkAgentName: string | null }
export interface IdentityAlias { agentUserId: string; employeeId: number; agentName: string | null }
export interface IdentityPartner { agentName: string; partnerName: string | null }

export type ResolvedAgent =
  | { kind: "colaborador"; key: string; employeeId: number; name: string }
  | { kind: "parceiro"; key: string; employeeId: null; name: string; partnerName: string | null }
  | { kind: "por_ligar"; key: string; employeeId: null; name: string }
  | { kind: "ignorado" };

const norm = (s: string | null | undefined) => String(s ?? "").trim().toLowerCase();

/**
 * Resolve (agentUserId, agentName) → pessoa. Prioridade: id do agente (ficha
 * ou agente extra) > nome do agente (ficha ou agente extra) > ignorado >
 * parceiro > "por ligar". Os agentes extra ganham ao principal de OUTRA ficha
 * (foram ligados depois, à mão). Mapas construídos uma vez: O(1) por ação.
 */
export function buildIdentityResolver(
  emps: IdentityEmployee[],
  aliases: IdentityAlias[],
  partners: IdentityPartner[],
  ignoredAgentNames: string[],
): (agentUserId: string | null | undefined, agentName: string | null | undefined) => ResolvedAgent {
  const byId = new Map<number, IdentityEmployee>(emps.map((e) => [e.id, e]));
  const byAgentId = new Map<string, IdentityEmployee>();
  const byAgentName = new Map<string, IdentityEmployee>();
  for (const e of emps) {
    if (e.multiparkAgentUserId && String(e.multiparkAgentUserId).trim()) byAgentId.set(String(e.multiparkAgentUserId).trim(), e);
    if (e.multiparkAgentName && norm(e.multiparkAgentName)) byAgentName.set(norm(e.multiparkAgentName), e);
  }
  for (const a of aliases) {
    const e = byId.get(a.employeeId);
    if (!e) continue; // ficha fora do âmbito (outra cidade) ou inativa
    byAgentId.set(String(a.agentUserId).trim(), e);
    if (a.agentName && norm(a.agentName)) byAgentName.set(norm(a.agentName), e);
  }
  const ignored = new Set(ignoredAgentNames.map(norm));
  const partnerBy = new Map(partners.map((p) => [norm(p.agentName), p]));
  return (agentUserId, agentName) => {
    const id = agentUserId != null ? String(agentUserId).trim() : "";
    const nk = norm(agentName);
    const emp = (id ? byAgentId.get(id) : undefined) ?? (nk ? byAgentName.get(nk) : undefined);
    if (emp) return { kind: "colaborador", key: `emp:${emp.id}`, employeeId: emp.id, name: emp.fullName };
    if (nk && ignored.has(nk)) return { kind: "ignorado" };
    const par = partnerBy.get(nk);
    if (par) return { kind: "parceiro", key: `agent:${nk}`, employeeId: null, name: par.partnerName ?? String(agentName), partnerName: par.partnerName };
    return { kind: "por_ligar", key: `agent:${nk}`, employeeId: null, name: String(agentName ?? "?") };
  }
}

// ─── Resto do GPS de um PDA partilhado ───────────────────────────────────────

export interface DayGpsRow { km: number; hoursMoving: number; hoursOnline: number; maxSpeed: number; violations: number }
export interface ShareGps { km: number; minutes: number; movingMinutes: number | null; maxSpeed: number; violations: number }

/**
 * O que sobra da linha do dia depois das partes por pessoa: pontos sem
 * ninguém com login no PDA, segmentos numa troca de pessoa, etc. Sem isto os
 * km desapareciam dos totais. Devolve null quando não sobra nada relevante
 * (< 50 m e < 1 min). A velocidade máxima só fica no resto quando nenhuma
 * parte a explica (é a do dia).
 */
export function leftoverFromShares(day: DayGpsRow, shares: ShareGps[]): DayGpsRow | null {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const sumKm = shares.reduce((s, x) => s + x.km, 0);
  const sumOnline = shares.reduce((s, x) => s + x.minutes, 0) / 60;
  const sumMoving = shares.reduce((s, x) => s + (x.movingMinutes ?? 0), 0) / 60;
  const maxShare = shares.reduce((m, x) => Math.max(m, x.maxSpeed), 0);
  const km = Math.max(0, r2(day.km - sumKm));
  const hoursOnline = Math.max(0, r2(day.hoursOnline - sumOnline));
  const hoursMoving = Math.max(0, r2(day.hoursMoving - sumMoving));
  const violations = Math.max(0, day.violations - shares.reduce((s, x) => s + x.violations, 0));
  if (km < 0.05 && hoursOnline < 1 / 60 && violations === 0) return null;
  return { km, hoursOnline, hoursMoving, maxSpeed: day.maxSpeed > maxShare + 0.01 ? day.maxSpeed : 0, violations };
}

// ─── Turno de cada ação ──────────────────────────────────────────────────────

export interface ShiftWindow { date: string; startHour: number; endHour: number }

/**
 * Dia e turno de uma ação. `hoursSince(date)` = horas desde a meia-noite de
 * Lisboa desse dia até à ação. Um turno da noite que passa a meia-noite
 * (endHour > 24) apanha as ações da madrugada seguinte — contam para o DIA DO
 * TURNO. Sem turno a abrigar, conta "fora do horário" no dia de calendário.
 */
export function classifyActionShift(
  calendarDay: string,
  shifts: ShiftWindow[],
  hoursSince: (date: string) => number,
): { day: string; inShift: boolean } {
  for (const s of shifts) {
    const h = hoursSince(s.date);
    if (h >= s.startHour && h <= s.endHour) return { day: s.date, inShift: true };
  }
  return { day: calendarDay, inShift: false };
}

// ─── Histórico de velocidade por pessoa ──────────────────────────────────────

export interface SpeedEntry {
  date: string; km: number; maxSpeed: number; avgSpeed: number; points: number;
  violations: number; movingMinutes: number | null; geoJsonUrl?: string | null;
}
export interface SpeedDay {
  date: string; km: number; maxSpeed: number; avgSpeed: number; violations: number;
  hoursMoving: number | null; tracks: string[];
}

/**
 * Junta por dia as partes (PDA partilhado) e as linhas inteiras de uma pessoa:
 * km e excessos somam, a máxima é a maior, a média ponderada pelos pontos.
 */
export function aggregateSpeedHistory(entries: SpeedEntry[]): SpeedDay[] {
  const by = new Map<string, { km: number; max: number; wsum: number; w: number; viol: number; moving: number | null; tracks: Set<string> }>();
  for (const e of entries) {
    let a = by.get(e.date);
    if (!a) { a = { km: 0, max: 0, wsum: 0, w: 0, viol: 0, moving: null, tracks: new Set() }; by.set(e.date, a); }
    a.km += e.km;
    a.max = Math.max(a.max, e.maxSpeed);
    if (e.avgSpeed > 0) { const w = Math.max(1, e.points); a.wsum += e.avgSpeed * w; a.w += w; }
    a.viol += e.violations;
    if (e.movingMinutes != null) a.moving = (a.moving ?? 0) + e.movingMinutes;
    if (e.geoJsonUrl) a.tracks.add(e.geoJsonUrl);
  }
  const r = (n: number, k = 100) => Math.round(n * k) / k;
  return [...by.entries()]
    .map(([date, a]) => ({
      date, km: r(a.km), maxSpeed: r(a.max, 10), avgSpeed: a.w ? r(a.wsum / a.w, 10) : 0,
      violations: a.viol, hoursMoving: a.moving == null ? null : r(a.moving / 60), tracks: [...a.tracks],
    }))
    .sort((x, y) => y.date.localeCompare(x.date));
}
