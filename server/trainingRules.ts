/**
 * Formação — regras PURAS (sem BD), testadas em trainingRules.test.ts.
 *
 *  - elegibilidade para a escala (formação obrigatória em falta);
 *  - validação de tentativas de quiz/exame (todas respondidas, tempo, limite
 *    diário);
 *  - ranking por melhor pontuação;
 *  - seleção de lembretes;
 *  - validade dos certificados;
 *  - progresso de um percurso.
 */

export type TrainingItemType = "video" | "manual" | "exam" | "quiz";
export const TRAINING_ITEM_TYPES: TrainingItemType[] = ["video", "manual", "exam", "quiz"];
export type AssignmentStatus = "assigned" | "in_progress" | "completed" | "overdue";

// ─── 1. Progresso de um percurso ───────────────────────────────────────────

export interface PathItemRef { itemType: string; itemId: number; required: boolean | number }
export interface ProgressRef { itemType: string; itemId: number; completedAt: string | null; viewedAt?: string | null }

export const progressKey = (itemType: string, itemId: number) => `${itemType}:${itemId}`;

export interface PathProgress {
  requiredTotal: number;
  requiredDone: number;
  optionalDone: number;
  started: boolean;
  complete: boolean;
  pct: number;
  doneKeys: string[];
}

export function computePathProgress(items: PathItemRef[], progress: ProgressRef[]): PathProgress {
  const done = new Set(progress.filter(p => p.completedAt).map(p => progressKey(p.itemType, p.itemId)));
  const touched = new Set(progress.filter(p => p.completedAt || p.viewedAt).map(p => progressKey(p.itemType, p.itemId)));
  let requiredTotal = 0, requiredDone = 0, optionalDone = 0, started = false;
  const doneKeys: string[] = [];
  for (const it of items) {
    const k = progressKey(it.itemType, it.itemId);
    const isDone = done.has(k);
    if (isDone) doneKeys.push(k);
    if (touched.has(k)) started = true;
    if (it.required) { requiredTotal++; if (isDone) requiredDone++; }
    else if (isDone) optionalDone++;
  }
  // Percurso sem obrigatórios conta como concluído (nada a exigir).
  const complete = requiredDone >= requiredTotal;
  const pct = requiredTotal === 0 ? 100 : Math.round(requiredDone * 100 / requiredTotal);
  return { requiredTotal, requiredDone, optionalDone, started, complete, pct, doneKeys };
}

/** Estado de uma atribuição a partir do progresso e do prazo. */
export function assignmentStatusFor(p: Pick<PathProgress, "complete" | "started">, dueAt: string | null, now: Date): AssignmentStatus {
  if (p.complete) return "completed";
  if (dueAt && parseDbDate(dueAt).getTime() < now.getTime()) return "overdue";
  return p.started ? "in_progress" : "assigned";
}

// ─── 2. Elegibilidade para a escala ─────────────────────────────────────────

export interface EligibilityAssignment {
  pathName: string;
  status: string;
  pathActive: boolean | number;
  blocksEscala: boolean | number;
}

export interface EligibilityResult { ok: boolean; missing: string[]; overridden: boolean; message: string | null }

export function trainingBlocksEscalaEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.TRAINING_BLOCKS_ESCALA ?? "").trim().toLowerCase() !== "off";
}

/**
 * Pode ser escalado? Bloqueia quando há uma atribuição ATIVA de um percurso
 * que bloqueia a escala e ainda não está concluída. Um admin pode forçar
 * (`override`), o que o chamador regista no log de atividade.
 */
export function escalaEligibility(input: {
  assignments: EligibilityAssignment[];
  enabled: boolean;
  override?: boolean;
  canOverride?: boolean;
}): EligibilityResult {
  if (!input.enabled) return { ok: true, missing: [], overridden: false, message: null };
  const missing = input.assignments
    .filter(a => !!a.pathActive && !!a.blocksEscala && a.status !== "completed")
    .map(a => a.pathName);
  if (!missing.length) return { ok: true, missing, overridden: false, message: null };
  if (input.override && input.canOverride) return { ok: true, missing, overridden: true, message: null };
  const list = missing.join(", ");
  return {
    ok: false, missing, overridden: false,
    message: `Formação obrigatória por concluir (${list}). Só pode ser escalado depois de a concluir${input.canOverride ? " — ou força a atribuição." : "."}`,
  };
}

// ─── 3. Tentativas de quiz/exame ────────────────────────────────────────────

export const TIME_GRACE_SECONDS = 30;
export const QUIZ_MAX_PER_DAY = 5;
export const QUIZ_QUESTIONS_PER_GAME = 10;

export class AttemptError extends Error {
  constructor(public code: "BAD_REQUEST" | "FORBIDDEN" | "TOO_MANY_REQUESTS", message: string) { super(message); }
}

/** "YYYY-MM-DD HH:MM:SS" (UTC da BD) ou ISO → Date. */
export function parseDbDate(s: string | Date): Date {
  if (s instanceof Date) return s;
  const t = s.includes("T") ? s : s.replace(" ", "T");
  return new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(t) ? t : `${t}Z`);
}
export function toDbDate(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export function lisbonDay(d: Date): string {
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

/** Quantas tentativas ainda pode começar hoje (dia de Lisboa). */
export function attemptsLeftToday(startedAt: Array<string | Date>, now: Date, maxPerDay: number): number {
  if (!maxPerDay || maxPerDay <= 0) return Infinity;
  const today = lisbonDay(now);
  const used = startedAt.filter(s => lisbonDay(parseDbDate(s)) === today).length;
  return Math.max(0, maxPerDay - used);
}

export function assertCanStartAttempt(startedToday: Array<string | Date>, now: Date, maxPerDay: number): void {
  if (attemptsLeftToday(startedToday, now, maxPerDay) <= 0) {
    throw new AttemptError("TOO_MANY_REQUESTS", `Já fizeste ${maxPerDay} tentativa(s) hoje. Volta a tentar amanhã.`);
  }
}

export interface SubmissionCheck {
  servedIds: number[];
  answers: { questionId: number; answer: string }[];
  startedAt: string | Date;
  deadlineAt: string | Date | null;
  submittedAt: string | Date | null;
  now: Date;
}

export type SubmissionMode = "ok" | "timed_out" | "expired";

/**
 * Valida a submissão de uma tentativa servida pelo servidor:
 *  - só uma submissão por tentativa;
 *  - respostas só para as perguntas servidas, sem repetições;
 *  - ANTES do prazo, tem de responder a TODAS (impede sondar a resposta certa
 *    com submissões parciais);
 *  - depois do prazo (até +30s de tolerância) aceita o que houver → "timed_out"
 *    (as que faltam contam como erradas);
 *  - para lá da tolerância → "expired" (nota 0).
 */
export function validateSubmission(c: SubmissionCheck): SubmissionMode {
  if (c.submittedAt) throw new AttemptError("BAD_REQUEST", "Esta tentativa já foi submetida.");
  const served = new Set(c.servedIds);
  const seen = new Set<number>();
  for (const a of c.answers) {
    if (!served.has(a.questionId)) throw new AttemptError("BAD_REQUEST", "Há respostas a perguntas que não fazem parte desta tentativa.");
    if (seen.has(a.questionId)) throw new AttemptError("BAD_REQUEST", "Cada pergunta só pode ter uma resposta.");
    seen.add(a.questionId);
  }
  const deadline = c.deadlineAt ? parseDbDate(c.deadlineAt).getTime() : null;
  const nowMs = c.now.getTime();
  if (deadline != null && nowMs > deadline + TIME_GRACE_SECONDS * 1000) return "expired";
  const allAnswered = seen.size === served.size;
  if (allAnswered) return "ok";
  if (deadline != null && nowMs >= deadline) return "timed_out";
  throw new AttemptError("BAD_REQUEST", "Responde a todas as perguntas antes de submeter.");
}

// ─── 4. Ranking (melhor pontuação por pessoa) ───────────────────────────────

export interface RankRow { employeeId: number; bestScore: number; attempts: number; firstBestAt?: string | null }

export function rankBestScores(rows: RankRow[], limit = 50): Array<RankRow & { position: number }> {
  const sorted = [...rows].sort((a, b) =>
    b.bestScore - a.bestScore
    || a.attempts - b.attempts
    || String(a.firstBestAt ?? "").localeCompare(String(b.firstBestAt ?? ""))
    || a.employeeId - b.employeeId);
  return sorted.slice(0, limit).map((r, i) => ({ ...r, position: i + 1 }));
}

// ─── 5. Lembretes ──────────────────────────────────────────────────────────

export interface ReminderCandidate {
  id: number;
  status: string;
  dueAt: string | null;
  lastReminderAt: string | null;
  escalatedAt: string | null;
}

export const REMINDER_WINDOW_DAYS = 2;
export const ESCALATE_AFTER_DAYS = 3;

export function trainingRemindersEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.TRAINING_REMINDERS ?? "").trim().toLowerCase() !== "off";
}

/** Horas de Lisboa em que se enviam lembretes (dia). */
export function isReminderHour(hour: number): boolean { return hour >= 9 && hour <= 20; }

export function selectReminders(rows: ReminderCandidate[], now: Date): { remind: number[]; escalate: number[] } {
  const remind: number[] = [], escalate: number[] = [];
  const today = lisbonDay(now);
  const nowMs = now.getTime();
  for (const r of rows) {
    if (r.status === "completed" || !r.dueAt) continue;
    const due = parseDbDate(r.dueAt).getTime();
    if (due - nowMs > REMINDER_WINDOW_DAYS * 86400_000) continue;
    if (!r.lastReminderAt || lisbonDay(parseDbDate(r.lastReminderAt)) !== today) remind.push(r.id);
    if (!r.escalatedAt && nowMs - due >= ESCALATE_AFTER_DAYS * 86400_000) escalate.push(r.id);
  }
  return { remind, escalate };
}

export function daysLate(dueAt: string | null, now: Date): number {
  if (!dueAt) return 0;
  const diff = now.getTime() - parseDbDate(dueAt).getTime();
  return diff > 0 ? Math.floor(diff / 86400_000) : 0;
}

// ─── 6. Certificados ───────────────────────────────────────────────────────

export type CertificateStatus = "valid" | "expiring" | "expired" | "permanent";
export const EXPIRING_SOON_DAYS = 30;

/** Data (YYYY-MM-DD) de fim de validade; null = sem validade (0 meses). */
export function certificateValidUntil(issuedAt: Date, months: number | null | undefined): string | null {
  if (!months || months <= 0) return null;
  const d = new Date(Date.UTC(issuedAt.getUTCFullYear(), issuedAt.getUTCMonth(), issuedAt.getUTCDate()));
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

export function certificateStatus(validUntil: string | null | undefined, now: Date): CertificateStatus {
  if (!validUntil) return "permanent";
  const today = lisbonDay(now);
  if (validUntil < today) return "expired";
  const soon = lisbonDay(new Date(now.getTime() + EXPIRING_SOON_DAYS * 86400_000));
  return validUntil <= soon ? "expiring" : "valid";
}

// ─── 7. Nível de carreira → campos da ficha ─────────────────────────────────

/**
 * O que muda na ficha ao aprovar uma promoção:
 *  - `careerLevel` fica sempre com o nível do exame;
 *  - condutor_N → `extraLevel` = N (só sobe, nunca desce);
 *  - team_leader/supervisor → `position` (só sobe).
 */
export function promotionPatch(level: string, current: { extraLevel: number | null; position: string | null }): Record<string, unknown> {
  const patch: Record<string, unknown> = { careerLevel: level };
  const m = level.match(/^condutor_(\d)$/);
  if (m) {
    const n = Number(m[1]);
    if (current.extraLevel == null || current.extraLevel < n) patch.extraLevel = n;
  }
  const POS_RANK: Record<string, number> = { extra: 0, driver: 1, senior_driver: 2, frontoffice: 2, backoffice: 3, team_leader: 4, supervisor: 5, director: 6 };
  if (level === "team_leader" || level === "supervisor") {
    if ((POS_RANK[current.position ?? ""] ?? 0) < POS_RANK[level]) patch.position = level;
  }
  return patch;
}

/** Baralha (Fisher–Yates) e corta. `rand` injetável para testes. */
export function pickQuestions<T>(list: T[], n: number, rand: () => number = Math.random): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}
