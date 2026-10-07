/**
 * Lote 41a — "suspender" (não é desativar): quem tem a ficha ativa mas não
 * trabalha nem entra na app há mais de N dias (por omissão 180 ≈ 6 meses).
 * Suspender = bloqueio manual do acesso (reversível no RH → Desbloquear);
 * a ficha, a conta e o agente da Multipark ficam todos ligados. Regras PURAS.
 */

export const SUSPEND_REASON_MANUAL = "Suspenso pelo RH";

/** O motivo que fica na ficha: "Suspenso: sem atividade há mais de 6 meses" (180 dias). PURA. */
export function inactivityReason(days: number): string {
  const d = Math.max(1, Math.round(days));
  const span = d % 30 === 0 ? (d === 30 ? "1 mês" : `${d / 30} meses`) : `${d} dias`;
  return `Suspenso: sem atividade há mais de ${span}`;
}

export interface SuspendRow {
  employeeId: number;
  fullName: string;
  position: string | null;
  projectName: string | null;
  createdAt: string | null;
  /** maior último login das contas da ficha (principal + extra) */
  lastLogin: string | null;
  /** papel da conta principal (admin+ não se bloqueiam) */
  topRole: string | null;
  /** para o âmbito de cidade */
  projectId?: number | null;
}

export interface SuspendCandidate extends SuspendRow {
  lastWorked: string | null;
  lastActivity: string | null;
  daysIdle: number | null;
}

const day = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};
const maxDay = (...xs: Array<string | null>) => xs.filter((x): x is string => !!x).sort().at(-1) ?? null;
const daysBetween = (from: string, to: string) => Math.floor((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

/**
 * Quem sugerir: sem trabalho (agente, ponto, extras) nem login há mais de
 * `days` dias; quem nunca fez nada conta desde a criação da ficha. Os mais
 * parados primeiro. `days` ≤ 0 → ninguém (sugestão desligada). PURA.
 */
export function pickSuspendCandidates(rows: SuspendRow[], lastWorked: Record<number, string>, today: string, days: number): SuspendCandidate[] {
  if (!(days > 0)) return [];
  const out: SuspendCandidate[] = [];
  for (const r of rows) {
    if (r.topRole === "admin" || r.topRole === "super_admin") continue;
    const worked = day(lastWorked[r.employeeId]);
    const last = maxDay(worked, day(r.lastLogin));
    const since = last ?? day(r.createdAt);
    if (!since) continue;
    const idle = daysBetween(since, today);
    if (idle <= days) continue;
    out.push({ ...r, lastWorked: worked, lastActivity: last, daysIdle: last ? idle : null });
  }
  return out.sort((a, b) => (a.lastActivity ?? "").localeCompare(b.lastActivity ?? "") || a.fullName.localeCompare(b.fullName, "pt"));
}

/**
 * O motivo do bloqueio manual dentro do texto guardado (que junta todos os
 * motivos e acaba em "Contacta o supervisor."). Sem isto, cada recálculo
 * voltava a acrescentar o sufixo. PURA.
 */
export function manualBlockReason(stored: string | null | undefined): string {
  const auto = new Set(["faltas em extras-dia sem aviso", "documentos obrigatórios em falta", "bloqueio manual"]);
  const parts = String(stored ?? "")
    .replace(/(\.?\s*Contacta o supervisor\.?)+\s*$/i, "")
    .split(" · ")
    .map((p) => p.trim())
    .filter((p) => p && !auto.has(p));
  return parts.join(" · ") || "bloqueio manual";
}
