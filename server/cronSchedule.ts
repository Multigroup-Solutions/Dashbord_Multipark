/**
 * Agendador único (/api/cron/tick) — a parte PURA: o registo dos trabalhos
 * (cadência, prioridade, tempo mínimo) e as regras de "está na altura?",
 * de períodos (dia/mês de Lisboa), de retoma e de lease. Sem BD nem rede: o
 * executor está em server/cronScheduler.ts e os trabalhos em server/cronJobs.ts.
 *
 * Cadências (hora de Lisboa, Europe/Lisbon — muda sozinha com a hora de verão):
 *  - interval: a cada N min, alinhado ao relógio (uma vez por "fatia" de N
 *    min, contada em UTC — as horas certas coincidem com Lisboa); com janela
 *    opcional de horas de Lisboa (ex.: 08h–23h);
 *  - daily: uma vez por dia de Lisboa, a partir de HH:MM (opcionalmente só
 *    até HH:MM — fora da janela salta o dia); opcionalmente só depois de
 *    outro trabalho diário acabar (com hora de recurso);
 *  - weekly: uma vez por semana ISO, a partir do dia da semana D às HH:MM
 *    (se falhar, apanha nos dias seguintes da mesma semana);
 *  - monthly: uma vez por mês, a partir do dia D às HH:MM (se falhar o dia D,
 *    apanha nos MONTHLY_CATCHUP_DAYS dias seguintes — não mais, para um
 *    deploy a meio do mês não voltar a pedir o mês anterior à API).
 *
 * Retoma: um trabalho que devolve "não acabei" (done:false / partial) fica
 * `partial` com o cursor e volta a correr no tick seguinte, antes dos outros.
 * Um diário/mensal só fica "feito no período" quando acaba (ou depois de
 * MAX_ATTEMPTS falhas seguidas, para não martelar uma API em baixo).
 */

export type JobCadence =
  | { kind: "interval"; minutes: number; window?: { fromHour: number; toHour: number } }
  | { kind: "daily"; from: string; until?: string; after?: { job: string; fallbackFrom: string } }
  | { kind: "weekly"; dow: number; from: string }
  | { kind: "monthly"; day: number; from: string };

export interface TickJobSpec {
  /** Chave única (linha em cron_job_state). */
  key: string;
  /** Nome no registo de corridas (cron_runs / Estado do sistema). */
  runName: string;
  label: string;
  cadence: JobCadence;
  /** Menor = mais cedo no tick. */
  priority: number;
  /** Tempo mínimo útil (ms): com menos do que isto no orçamento, fica para o tick seguinte. */
  minMs: number;
  /** Teto (ms) desta corrida dentro do tick (os outros também precisam de tempo). */
  maxMs: number;
  /**
   * Só entra no plano com esta fonte das reservas (interruptor
   * MULTIPARK_SOURCE): "api" = sync pela API (hoje); "db" = BD Multipark.
   * Omissão: corre sempre.
   */
  source?: "api" | "db";
}

const S = 1000;

/**
 * Passagem provisória do GPS do Zello (dia de HOJE): o Zello deixa de dar o
 * dia à meia-noite (assumida de Lisboa) e só o volta a dar ~2 dias depois.
 * Janela única, configurável aqui; se falhar, a passagem final (D-2, no
 * daily-ops) cobre o dia.
 */
export const ZELLO_SAMEDAY_WINDOW = { from: "23:15", until: "23:55" } as const;

/**
 * Tabela dos trabalhos (decisões do Jorge, 26 set 2026). Fora da agenda
 * (ficam só manuais): knowledge-sync (botão "Sincronizar agora" e
 * processamento imediato de cada carregamento) e google-business (em pausa
 * até a Google aprovar o acesso à API).
 */
export const TICK_JOBS: readonly TickJobSpec[] = [
  { key: "mail-sync", runName: "mail-sync", label: "Comunicação: sincronização do Gmail", cadence: { kind: "interval", minutes: 5 }, priority: 10, minMs: 10 * S, maxMs: 25 * S },
  // Só com MULTIPARK_SOURCE = BD (substitui multipark-sync + multipark-future + reconciliação).
  { key: "multipark-db-sync", runName: "multipark-db-sync", label: "Reservas, movimentos e condutores da BD Multipark", cadence: { kind: "interval", minutes: 5 }, priority: 15, minMs: 15 * S, maxMs: 40 * S, source: "db" },
  { key: "multipark-deliveries", runName: "multipark-deliveries", label: "Fila do webhook Multipark", cadence: { kind: "interval", minutes: 15 }, priority: 20, minMs: 15 * S, maxMs: 30 * S },
  { key: "ai-comms", runName: "ai-comms", label: "IA na comunicação com clientes", cadence: { kind: "interval", minutes: 15 }, priority: 30, minMs: 20 * S, maxMs: 30 * S },
  // Google por eventos (26 set 2026): o que muda vai/vem logo (push da Google,
  // fila "sincronizar já", heartbeat do dashboard); aqui só a repetição do que
  // falhou (15 min), a rede de segurança completa (4 h) e a renovação diária
  // dos canais de notificação (expiram em ≤ 7 dias).
  { key: "google-pending", runName: "google-pending", label: "Google: alterações por enviar/receber (repetição)", cadence: { kind: "interval", minutes: 15 }, priority: 38, minMs: 10 * S, maxMs: 25 * S },
  { key: "google-sync", runName: "google-sync", label: "Google Tarefas, Calendário, Contactos e Drive (rede de segurança)", cadence: { kind: "interval", minutes: 240 }, priority: 40, minMs: 12 * S, maxMs: 25 * S },
  { key: "extras-schedule", runName: "extras-schedule", label: "Escala automática dos extras (propor/confirmar/avisar)", cadence: { kind: "interval", minutes: 60, window: { fromHour: 8, toHour: 23 } }, priority: 45, minMs: 15 * S, maxMs: 45 * S },
  { key: "multipark-sync", runName: "multipark-sync", label: "Sincronização de reservas (recente)", cadence: { kind: "interval", minutes: 60 }, priority: 50, minMs: 25 * S, maxMs: 45 * S, source: "api" },
  { key: "extras-auto", runName: "extras-auto", label: "Automação dos extras", cadence: { kind: "interval", minutes: 60 }, priority: 70, minMs: 12 * S, maxMs: 40 * S },
  { key: "identity-sweep", runName: "identity-sweep", label: "Ligações funcionário ↔ utilizador", cadence: { kind: "interval", minutes: 60 }, priority: 80, minMs: 10 * S, maxMs: 30 * S },
  { key: "multipark-future", runName: "multipark-future", label: "Sincronização de reservas (futuras)", cadence: { kind: "interval", minutes: 120 }, priority: 90, minMs: 25 * S, maxMs: 45 * S, source: "api" },
  { key: "zello-sameday", runName: "zello-sameday", label: "GPS do Zello — recolha provisória do dia", cadence: { kind: "daily", from: ZELLO_SAMEDAY_WINDOW.from, until: ZELLO_SAMEDAY_WINDOW.until }, priority: 95, minMs: 15 * S, maxMs: 45 * S },
  { key: "google-watch-renew", runName: "google-watch-renew", label: "Google: renovar canais de notificação (Calendário/Drive)", cadence: { kind: "daily", from: "03:40" }, priority: 98, minMs: 15 * S, maxMs: 40 * S },
  { key: "daily-ops", runName: "daily-ops", label: "Manutenção diária + recolha GPS final (D-2)", cadence: { kind: "daily", from: "04:30" }, priority: 100, minMs: 20 * S, maxMs: 45 * S },
  { key: "rh-docs-weekly", runName: "rh-docs-weekly", label: "RH: regra documental dos extras (semanal)", cadence: { kind: "weekly", dow: 1, from: "04:45" }, priority: 102, minMs: 15 * S, maxMs: 45 * S },
  { key: "ops-briefing", runName: "ops-briefing", label: "Briefing diário, anomalias e relatórios semanais", cadence: { kind: "daily", from: "07:30" }, priority: 105, minMs: 20 * S, maxMs: 45 * S },
  { key: "evaluation-recompute", runName: "evaluation-recompute", label: "Avaliação (recálculo das 4 semanas)", cadence: { kind: "daily", from: "04:30", after: { job: "daily-ops", fallbackFrom: "06:00" } }, priority: 110, minMs: 15 * S, maxMs: 45 * S },
  { key: "google-ads", runName: "google-ads", label: "Google Ads (última semana)", cadence: { kind: "daily", from: "05:45" }, priority: 120, minMs: 15 * S, maxMs: 45 * S },
  { key: "google-ads-monthly", runName: "google-ads", label: "Google Ads (mês anterior)", cadence: { kind: "monthly", day: 2, from: "05:45" }, priority: 121, minMs: 15 * S, maxMs: 45 * S },
  { key: "meta-ads", runName: "meta-ads", label: "Meta Ads (última semana)", cadence: { kind: "daily", from: "05:45" }, priority: 122, minMs: 15 * S, maxMs: 45 * S },
  { key: "meta-ads-monthly", runName: "meta-ads", label: "Meta Ads (mês anterior)", cadence: { kind: "monthly", day: 2, from: "05:45" }, priority: 123, minMs: 15 * S, maxMs: 45 * S },
  { key: "web-analytics", runName: "web-analytics", label: "Web & SEO (GA4, Search Console, PageSpeed)", cadence: { kind: "daily", from: "09:00" }, priority: 130, minMs: 20 * S, maxMs: 45 * S },
];

// ─── Cadência do mail-sync com o push do Gmail ──────────────────────────────

/** Um push do Gmail nestas últimas horas = push saudável. */
export const MAIL_PUSH_HEALTHY_HOURS = 6;
/** mail-sync sem push saudável (é ele que traz o email). */
export const MAIL_SYNC_MINUTES = 5;
/** mail-sync com push saudável: só rede de segurança (e renovação do watch, que expira aos 7 dias). */
export const MAIL_SYNC_SAFETY_NET_MINUTES = 60;

/**
 * O push do Gmail está saudável? Interruptor MAIL_PUSH ligado, tópico
 * Pub/Sub configurado, todas as contas ativas com o watch em dia
 * (`allWatched`; omissão true) e uma notificação recebida nas últimas
 * MAIL_PUSH_HEALTHY_HOURS horas. PURA.
 */
export function mailPushHealthy(o: { flagOn: boolean; topicConfigured: boolean; lastPushAt: number | null; now: number; hours?: number; allWatched?: boolean }): boolean {
  if (!o.flagOn || !o.topicConfigured || o.lastPushAt == null || o.allWatched === false) return false;
  const age = o.now - o.lastPushAt;
  return age >= -5 * 60_000 && age <= (o.hours ?? MAIL_PUSH_HEALTHY_HOURS) * 3_600_000;
}

export interface DynamicCadence { mailPushHealthy: boolean }

/**
 * Tabela efetiva do tick: com push saudável o mail-sync passa de 5 em 5 min
 * a de hora a hora (rede de segurança); sem push volta logo aos 5 min. PURA.
 */
export function effectiveTickJobs(specs: readonly TickJobSpec[], d: DynamicCadence): TickJobSpec[] {
  return specs.map((s) => (s.key === "mail-sync"
    ? { ...s, cadence: { kind: "interval", minutes: d.mailPushHealthy ? MAIL_SYNC_SAFETY_NET_MINUTES : MAIL_SYNC_MINUTES } as JobCadence,
        label: d.mailPushHealthy ? "Comunicação: sincronização do Gmail (rede de segurança — push ativo)" : s.label }
    : s));
}

/**
 * Trabalhos ativos para a fonte das reservas em vigor (mesma ordem). Com
 * "api" é a lista de sempre (sem o multipark-db-sync). PURA.
 */
export function activeTickJobs(specs: readonly TickJobSpec[], source: "api" | "db"): TickJobSpec[] {
  return specs.filter((s) => !s.source || s.source === source);
}

/** Dias depois do dia D em que um mensal falhado ainda é apanhado. */
export const MONTHLY_CATCHUP_DAYS = 6;
/** Falhas seguidas no mesmo período antes de um diário/mensal desistir até ao seguinte. */
export const MAX_ATTEMPTS = 3;
/** Espera entre tentativas falhadas de um diário/mensal. */
export const RETRY_AFTER_MS = 30 * 60_000;
/** Folga do lease para lá do prazo da corrida (a função pode morrer sem limpar). */
export const LEASE_GRACE_MS = 15_000;
/** Orçamento de um tick (a função tem maxDuration de 60 s no Vercel). */
export const TICK_BUDGET_MS = 50_000;
/** Margem antes do fim da função (gravar o estado e o registo de cada corrida). */
export const TICK_END_MARGIN_MS = 8_000;

export type JobStatus = "ok" | "error" | "partial";

export interface JobState {
  jobKey: string;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastOkAt: number | null;
  lastStatus: JobStatus | null;
  lastError: string | null;
  lastDurationMs: number | null;
  /** Cursor guardado (JSON `{ p: período, c: cursor do trabalho }`). */
  resumeCursor: string | null;
  /** Período (dia "AAAA-MM-DD" / mês "AAAA-MM") dado como feito. */
  periodKey: string | null;
  /** Falhas seguidas no período atual. */
  attempts: number;
  leaseUntil: number | null;
}

export function emptyState(jobKey: string): JobState {
  return { jobKey, lastStartedAt: null, lastFinishedAt: null, lastOkAt: null, lastStatus: null, lastError: null, lastDurationMs: null, resumeCursor: null, periodKey: null, attempts: 0, leaseUntil: null };
}

// ─── Relógio de Lisboa ──────────────────────────────────────────────────────

export interface LisbonParts { date: string; month: string; day: number; hour: number; minutes: number; /** 1 = segunda … 7 = domingo */ dow: number }

const FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});

export function lisbonParts(ms: number): LisbonParts {
  const p: Record<string, string> = {};
  for (const x of FMT.formatToParts(new Date(ms))) p[x.type] = x.value;
  const hour = Number(p.hour === "24" ? "0" : p.hour);
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, month: `${p.year}-${p.month}`, day: Number(p.day), hour, minutes: hour * 60 + Number(p.minute), dow: new Date(`${date}T12:00:00Z`).getUTCDay() || 7 };
}

/** Semana ISO de um dia "AAAA-MM-DD" → "AAAA-Www". PURA. */
export function isoWeekKey(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow); // quinta-feira da mesma semana
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1, 12)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** "HH:MM" → minutos do dia. */
export function hhmm(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`hora inválida: ${s}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Instante (epoch ms) de um dia + minutos de Lisboa (hora de verão incluída). */
export function lisbonToUtc(date: string, minutes: number): number {
  const [y, mo, d] = date.split("-").map(Number);
  const naive = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  let guess = naive;
  for (let i = 0; i < 3; i++) {
    const p = lisbonParts(guess);
    const [py, pm, pd] = p.date.split("-").map(Number);
    const shown = Date.UTC(py, pm - 1, pd, Math.floor(p.minutes / 60), p.minutes % 60);
    const diff = shown - naive;
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

function addDaysIso(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ─── Períodos e cursores ────────────────────────────────────────────────────

/** Período de um diário (dia de Lisboa) ou mensal (mês de Lisboa); intervalos → null. */
export function periodKeyFor(c: JobCadence, now: number): string | null {
  if (c.kind === "interval") return null;
  const p = lisbonParts(now);
  return c.kind === "daily" ? p.date : c.kind === "weekly" ? isoWeekKey(p.date) : p.month;
}

/** Cursor do trabalho guardado junto com o período em que foi criado. */
export function wrapCursor(period: string | null, cursor: string | null): string | null {
  return cursor == null ? null : JSON.stringify({ p: period, c: cursor });
}

/** Cursor para retomar agora (só se for do período atual; um cursor de ontem é descartado). */
export function cursorForRun(state: JobState | null | undefined, period: string | null): string | null {
  if (!state?.resumeCursor || state.lastStatus !== "partial") return null;
  try {
    const v = JSON.parse(state.resumeCursor);
    if (!v || typeof v.c !== "string") return null;
    return (v.p ?? null) === period ? v.c : null;
  } catch { return null; }
}

// ─── Está na altura? ────────────────────────────────────────────────────────

export interface DueResult { due: boolean; resume: boolean; reason: string }

function inWindow(c: Extract<JobCadence, { kind: "interval" }>, now: number): boolean {
  if (!c.window) return true;
  const h = lisbonParts(now).hour;
  return h >= c.window.fromHour && h <= c.window.toHour;
}

/**
 * O trabalho está na altura de correr agora? `states` dá o estado dos outros
 * (para "só depois de X"); `fromOverride` substitui a hora "a partir de" de um
 * diário (ex.: hora configurada nas Definições, se for mais tarde). PURA.
 */
export function isDue(spec: TickJobSpec, state: JobState | null | undefined, now: number, states: ReadonlyMap<string, JobState> = new Map(), fromOverride?: number | null): DueResult {
  const c = spec.cadence;
  const st = state ?? emptyState(spec.key);
  if (c.kind === "interval") {
    if (st.lastStatus === "partial") return { due: true, resume: true, reason: "retomar" };
    if (!inWindow(c, now)) return { due: false, resume: false, reason: "fora da janela" };
    const slot = c.minutes * 60_000;
    if (st.lastStartedAt == null) return { due: true, resume: false, reason: "nunca correu" };
    return Math.floor(st.lastStartedAt / slot) < Math.floor(now / slot)
      ? { due: true, resume: false, reason: "intervalo" }
      : { due: false, resume: false, reason: "já correu nesta fatia" };
  }
  const p = lisbonParts(now);
  const period = periodKeyFor(c, now);
  if (st.periodKey === period) return { due: false, resume: false, reason: "feito neste período" };
  if (c.kind === "daily" && c.until && p.minutes >= hhmm(c.until)) return { due: false, resume: false, reason: `fora da janela (até às ${c.until})` };
  if (c.kind === "weekly" && (p.dow < c.dow || (p.dow === c.dow && p.minutes < hhmm(c.from)))) return { due: false, resume: false, reason: `só a partir de ${WEEKDAYS[c.dow]} às ${c.from}` };
  if (c.kind === "monthly" && p.day < c.day) return { due: false, resume: false, reason: `só a partir do dia ${c.day}` };
  if (c.kind === "monthly" && p.day > c.day + MONTHLY_CATCHUP_DAYS) return { due: false, resume: false, reason: `só no dia ${c.day} do mês seguinte` };
  const from = Math.max(hhmm(c.from), fromOverride ?? 0);
  if ((c.kind === "daily" || (c.kind === "monthly" && p.day === c.day)) && p.minutes < from) return { due: false, resume: false, reason: `só a partir das ${fmtMinutes(from)}` };
  if (c.kind === "daily" && c.after) {
    const dep = states.get(c.after.job);
    const depDone = dep?.periodKey === period;
    if (!depDone && p.minutes < hhmm(c.after.fallbackFrom)) return { due: false, resume: false, reason: `à espera de ${c.after.job}` };
  }
  const resume = st.lastStatus === "partial" && cursorForRun(st, period) != null;
  if (st.lastStatus === "error" && st.attempts > 0 && st.lastFinishedAt != null && now - st.lastFinishedAt < RETRY_AFTER_MS) {
    return { due: false, resume: false, reason: "a aguardar nova tentativa" };
  }
  return { due: true, resume, reason: resume ? "retomar" : "por fazer neste período" };
}

const WEEKDAYS = ["", "segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"];

export function fmtMinutes(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * Próxima vez que fica devido (epoch ms, aproximado ao minuto) — para o
 * cartão das Definições. `null` = só depende de outro trabalho. PURA.
 */
export function nextDueAt(spec: TickJobSpec, state: JobState | null | undefined, now: number, states: ReadonlyMap<string, JobState> = new Map(), fromOverride?: number | null): number | null {
  if (isDue(spec, state, now, states, fromOverride).due) return now;
  const st = state ?? emptyState(spec.key);
  const c = spec.cadence;
  if (c.kind === "interval") {
    const slot = c.minutes * 60_000;
    let t = (Math.floor((st.lastStartedAt ?? now) / slot) + 1) * slot;
    if (!inWindow(c, Math.max(t, now))) t = Math.max(t, (Math.floor(now / slot) + 1) * slot);
    for (let i = 0; i < 400 && !inWindow(c, t); i++) t += slot;
    return t;
  }
  const p = lisbonParts(now);
  const from = Math.max(hhmm(c.from), fromOverride ?? 0);
  const waitingRetry = st.lastStatus === "error" && st.attempts > 0 && st.lastFinishedAt != null && now - st.lastFinishedAt < RETRY_AFTER_MS;
  if (c.kind === "daily") {
    if (st.periodKey === p.date || (c.until && p.minutes >= hhmm(c.until))) return lisbonToUtc(addDaysIso(p.date, 1), from);
    if (waitingRetry) return st.lastFinishedAt! + RETRY_AFTER_MS;
    const depPending = !!c.after && states.get(c.after.job)?.periodKey !== p.date;
    return lisbonToUtc(p.date, depPending ? Math.max(from, hhmm(c.after!.fallbackFrom)) : from);
  }
  if (c.kind === "weekly") {
    const monday = addDaysIso(p.date, 1 - p.dow);
    const thisWeek = addDaysIso(monday, c.dow - 1);
    if (st.periodKey !== isoWeekKey(p.date)) {
      if (waitingRetry) return st.lastFinishedAt! + RETRY_AFTER_MS;
      return lisbonToUtc(thisWeek, from);
    }
    return lisbonToUtc(addDaysIso(thisWeek, 7), from);
  }
  const day = String(c.day).padStart(2, "0");
  if (st.periodKey !== p.month && p.day <= c.day + MONTHLY_CATCHUP_DAYS) {
    if (waitingRetry) return st.lastFinishedAt! + RETRY_AFTER_MS;
    return lisbonToUtc(`${p.month}-${day}`, from);
  }
  const [y, m] = p.month.split("-").map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return lisbonToUtc(`${ny}-${String(nm).padStart(2, "0")}-${day}`, from);
}

// ─── Plano do tick ──────────────────────────────────────────────────────────

export interface PlannedJob { key: string; resume: boolean; reason: string }

/** Devidos, por ordem: primeiro os que retomam, depois por prioridade. PURA. */
export function planTick(specs: readonly TickJobSpec[], states: ReadonlyMap<string, JobState>, now: number, fromOverrides: ReadonlyMap<string, number | null> = new Map()): PlannedJob[] {
  const out: Array<PlannedJob & { priority: number }> = [];
  for (const s of specs) {
    const d = isDue(s, states.get(s.key), now, states, fromOverrides.get(s.key));
    if (d.due) out.push({ key: s.key, resume: d.resume, reason: d.reason, priority: s.priority });
  }
  out.sort((a, b) => (a.resume === b.resume ? a.priority - b.priority : a.resume ? -1 : 1));
  return out.map(({ key, resume, reason }) => ({ key, resume, reason }));
}

/** Fim do orçamento do tick: 50 s depois do início, e sempre antes do prazo da função. PURA. */
export function tickBudgetEnd(startedAt: number, functionDeadline?: number | null, budgetMs = TICK_BUDGET_MS): number {
  const end = startedAt + budgetMs;
  return functionDeadline ? Math.min(end, functionDeadline - TICK_END_MARGIN_MS) : end;
}

/** Prazo de uma corrida dentro do tick; `null` = não há tempo mínimo útil (fica para o próximo). PURA. */
export function jobDeadline(spec: Pick<TickJobSpec, "minMs" | "maxMs">, now: number, budgetEndAt: number): number | null {
  if (budgetEndAt - now < spec.minMs) return null;
  return Math.min(budgetEndAt, now + spec.maxMs);
}

/** O lease está livre (sem dono ou já expirado)? PURA. */
export function leaseFree(leaseUntil: number | null | undefined, now: number): boolean {
  return leaseUntil == null || leaseUntil <= now;
}

// ─── Resultado → novo estado ────────────────────────────────────────────────

export interface RunOutcome { ok: boolean; done: boolean; cursor: string | null; error: string | null; startedAt: number; finishedAt: number }

/** Campos do estado depois de uma corrida (liberta o lease). PURA. */
export function applyOutcome(spec: TickJobSpec, prev: JobState | null | undefined, o: RunOutcome): JobState {
  const st = { ...(prev ?? emptyState(spec.key)) };
  const period = periodKeyFor(spec.cadence, o.startedAt);
  const periodic = spec.cadence.kind !== "interval";
  // Tentativas contam por período: um período novo recomeça do zero.
  const prevPeriod = st.lastStartedAt == null ? null : periodKeyFor(spec.cadence, st.lastStartedAt);
  const attemptsBefore = prevPeriod === period ? st.attempts : 0;
  st.lastStartedAt = o.startedAt;
  st.lastFinishedAt = o.finishedAt;
  st.lastDurationMs = Math.max(0, o.finishedAt - o.startedAt);
  st.leaseUntil = null;
  if (o.ok) {
    st.lastError = null;
    st.attempts = 0;
    if (o.done) {
      st.lastStatus = "ok";
      st.lastOkAt = o.finishedAt;
      st.resumeCursor = null;
      if (periodic) st.periodKey = period;
    } else {
      st.lastStatus = "partial";
      // Sem cursor próprio, fica um marcador: "retomar" (repete a chamada).
      st.resumeCursor = wrapCursor(period, o.cursor ?? "");
    }
    return st;
  }
  st.lastStatus = "error";
  st.lastError = (o.error ?? "erro").slice(0, 1000);
  if (!periodic) { st.attempts = 0; st.resumeCursor = null; return st; }
  st.attempts = attemptsBefore + 1;
  st.resumeCursor = o.done ? null : wrapCursor(period, o.cursor ?? "");
  if (st.attempts >= MAX_ATTEMPTS) { st.periodKey = period; st.resumeCursor = null; }
  return st;
}

/** "a cada 5 min", "de hora a hora (08h–23h)", "diário a partir das 04:30", … PURA. */
export function describeCadence(c: JobCadence): string {
  if (c.kind === "interval") {
    const base = c.minutes < 60 ? `a cada ${c.minutes} min` : c.minutes === 60 ? "de hora a hora" : `a cada ${c.minutes / 60} h`;
    return c.window ? `${base} (${String(c.window.fromHour).padStart(2, "0")}h–${String(c.window.toHour).padStart(2, "0")}h)` : base;
  }
  if (c.kind === "daily") {
    if (c.until) return `diário das ${c.from} às ${c.until}`;
    return `diário a partir das ${c.from}${c.after ? ` (depois de ${c.after.job}; o mais tardar ${c.after.fallbackFrom})` : ""}`;
  }
  if (c.kind === "weekly") return `semanal, ${WEEKDAYS[c.dow]} a partir das ${c.from}`;
  return `mensal, dia ${c.day} a partir das ${c.from}`;
}
